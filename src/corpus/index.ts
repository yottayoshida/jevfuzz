import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BudgetConfig, Confirmation, Finding, OracleConfig } from '../campaign-types.ts';
import type { DecisionProvider } from '../types.ts';
import { loadFinding, validateFinding } from '../artifacts-v2.ts';
import { assert, FuzzError, record } from '../util.ts';
import { contentHash, wireHash } from '../identity.ts';
import { assertNoSecrets, privateDir, readBoundedText, writerLock } from '../storage.ts';
import { initializeCorpusStorage, openCorpusStorage } from './storage.ts';
import { ExecutionJournal, decodeJournal } from '../engine/journal.ts';
import { BudgetLedger } from '../engine/budget.ts';
import { EvaluationBroker } from '../engine/broker.ts';
import { evaluateRelation } from '../contracts/index.ts';
import { confirmCandidate, confirmationCost, HypothesisSlots, validateOracle } from '../oracles/index.ts';
import { TypeSafeProvider, CloudflareProvider } from '../provider.ts';

export type TriageStatus = 'confirmed' | 'accepted_regression' | 'invalid_contract' | 'duplicate' | 'quarantined' | 'resolved';
export interface Triage { status: TriageStatus; actor: string; reason: string; timestamp: string; expiresAt?: string; reevaluate?: string }
export interface CorpusEntry { id: string; pairHash: string; evidence: string[]; sourceFindingIds: string[]; triage: Triage }
export interface CorpusIndex { version: 2; kind: 'corpus'; entries: CorpusEntry[] }
const statuses = ['confirmed', 'accepted_regression', 'invalid_contract', 'duplicate', 'quarantined', 'resolved'];
const digest = (value: unknown): string => wireHash(JSON.stringify(value));
function checkedHash(value: string): string { assert(/^[0-9a-f]{64}$/.test(value), 'invalid corpus object hash'); return value; }
function triage(status: TriageStatus, options: { actor?: string; reason?: string; expiresAt?: string; reevaluate?: string }): Triage {
  assert(statuses.includes(status), 'unknown triage status');
  const actor = options.actor ?? 'local-user', reason = options.reason ?? 'Explicit corpus acceptance';
  assert(actor.length > 0 && actor.length <= 256 && reason.length > 0 && reason.length <= 4096, 'triage requires bounded actor and reason');
  if (status === 'quarantined') assert(typeof options.expiresAt === 'string' && Number.isFinite(Date.parse(options.expiresAt)) && typeof options.reevaluate === 'string' && options.reevaluate.length > 0 && options.reevaluate.length <= 4096, 'quarantine needs expiry and bounded re-evaluation condition');
  else assert(options.expiresAt === undefined && options.reevaluate === undefined, 'quarantine fields require quarantined status');
  return { status, actor, reason, timestamp: new Date().toISOString(), ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}), ...(options.reevaluate ? { reevaluate: options.reevaluate } : {}) };
}
function validateTriage(value: unknown): Triage {
  assert(record(value) && statuses.includes(String(value.status)) && typeof value.actor === 'string' && value.actor.length > 0 && value.actor.length <= 256 && typeof value.reason === 'string' && value.reason.length > 0 && value.reason.length <= 4096 && typeof value.timestamp === 'string' && Number.isFinite(Date.parse(value.timestamp)), 'invalid corpus triage');
  const status = value.status as TriageStatus, expected = status === 'quarantined' ? ['status', 'actor', 'reason', 'timestamp', 'expiresAt', 'reevaluate'] : ['status', 'actor', 'reason', 'timestamp'];
  assert(Object.keys(value).every(key => expected.includes(key)) && expected.every(key => Object.hasOwn(value, key)), 'invalid corpus triage fields');
  if (status === 'quarantined') assert(typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt)) && typeof value.reevaluate === 'string' && value.reevaluate.length > 0 && value.reevaluate.length <= 4096, 'invalid corpus quarantine');
  return value as unknown as Triage;
}
async function journalFor(root: string, quota: import('../storage.ts').StorageQuota): Promise<ExecutionJournal> {
  const path = join(root, 'triage.jsonl'), consumeBytes = (bytes: number) => quota.append(path, bytes);
  try { return await ExecutionJournal.create(path, { consumeBytes }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; return ExecutionJournal.resume(path, { consumeBytes }); }
}
/** Creates or validates the durable corpus quota manifest under its writer lock. */
export async function initializeCorpus(directory: string, maxBytes?: number): Promise<void> {
  const root = await privateDir(directory), lock = await writerLock(root);
  try { await initializeCorpusStorage(root, maxBytes); } finally { await lock.release(); }
}
/** Journal events are authoritative; index.json is an atomically replaceable cache. */
export async function inspectCorpus(directory: string): Promise<CorpusIndex> {
  const entries = new Map<string, CorpusEntry>();
  let text: string;
  try { text = await readBoundedText(join(directory, 'triage.jsonl'), 64 * 1024 * 1024); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, kind: 'corpus', entries: [] }; throw error; }
  for (const event of decodeJournal(text).records) {
    assert(record(event.data), 'invalid corpus journal data');
    if (event.type === 'entry-added') {
      const value = event.data as unknown as CorpusEntry;
      assert(Object.keys(value).length === 5 && Object.keys(value).every(key => ['id', 'pairHash', 'evidence', 'sourceFindingIds', 'triage'].includes(key)), 'invalid corpus entry fields');
      checkedHash(value.id); checkedHash(value.pairHash);
      assert(value.id === value.pairHash && Array.isArray(value.evidence) && value.evidence.length > 0 && value.evidence.every(h => /^[a-f0-9]{64}$/.test(h)), 'invalid corpus identity');
      assert(Array.isArray(value.sourceFindingIds) && value.sourceFindingIds.every(id => typeof id === 'string' && id.length > 0) && record(value.triage), 'invalid corpus evidence'); validateTriage(value.triage);
      const prior = entries.get(value.id); if (prior) assert(prior.evidence.every(h => value.evidence.includes(h)), 'corpus evidence cannot be removed');
      entries.set(value.id, structuredClone(value));
    } else if (event.type === 'triaged') {
      assert(Object.keys(event.data).length === 2 && typeof event.data.id === 'string', 'invalid triage event'); const entry = entries.get(String(event.data.id)); assert(entry && record(event.data.triage), 'invalid triage target');
      entry.triage = validateTriage(event.data.triage);
    } else assert(event.type === 'pruned', 'unknown corpus journal event');
  }
  return { version: 2, kind: 'corpus', entries: [...entries.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}
async function objectBytes(root: string): Promise<number> {
  let total = 0, files: string[];
  try { files = await readdir(join(root, 'objects')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  assert(files.length <= 100_000, 'corpus object count exceeded');
  for (const file of files) { assert(/^[a-f0-9]{64}\.json$/.test(file), 'unexpected corpus object'); const stat = await lstat(join(root, 'objects', file)); assert(stat.isFile() && stat.nlink === 1 && !stat.isSymbolicLink(), 'unsafe corpus object'); total += stat.size; }
  return total;
}
export async function addToCorpus(raw: Finding, directory: string, options: { actor?: string; reason?: string; secrets?: string[]; maxBytes?: number } = {}): Promise<string> {
  const finding = validateFinding(raw), text = JSON.stringify(finding), root = await privateDir(directory);
  assertNoSecrets(text, options.secrets); const lock = await writerLock(root);
  try {
    const { quota } = await openCorpusStorage(root, options.maxBytes), index = await inspectCorpus(root), object = digest(finding);
    const pairHash = contentHash([finding.candidate.baseWireHash, finding.candidate.mutantWireHash, finding.contract, finding.candidate.targetHash]), previous = index.entries.find(entry => entry.id === pairHash);
    if (previous?.evidence.includes(object)) return previous.id;
    const path = join(root, 'objects', object + '.json');
    let exists = false;
    try { await lstat(path); exists = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // A crash may leave the immutable object before its entry-added frame.
    // The inventory already charged that object; verify and reuse it once.
    if (exists) assert(wireHash(await readBoundedText(path)) === object, 'existing corpus object was modified');
    else await quota.write(path, text, { secrets: options.secrets });
    const entry: CorpusEntry = previous ? { ...previous, evidence: [...new Set([...previous.evidence, object])], sourceFindingIds: [...new Set([...previous.sourceFindingIds, finding.id])] }
      : { id: pairHash, pairHash, evidence: [object], sourceFindingIds: [finding.id], triage: triage('confirmed', options) };
    const journal = await journalFor(root, quota);
    try { await journal.append('entry-added', entry); } finally { await journal.close(); }
    await quota.write(join(root, 'index.json'), JSON.stringify(await inspectCorpus(root)), { secrets: options.secrets, replace: true });
    return entry.id;
  } finally { await lock.release(); }
}
export async function triageCorpus(directory: string, id: string, status: TriageStatus, options: { actor: string; reason: string; expiresAt?: string; reevaluate?: string; secrets?: string[] }): Promise<void> {
  checkedHash(id); const root = await privateDir(directory), lock = await writerLock(root);
  try {
    const { quota } = await openCorpusStorage(root), index = await inspectCorpus(root); assert(index.entries.some(entry => entry.id === id), 'unknown corpus entry');
    const event = { id, triage: triage(status, options) }; assertNoSecrets(JSON.stringify(event), options.secrets);
    const journal = await journalFor(root, quota); try { await journal.append('triaged', event); } finally { await journal.close(); }
    await quota.write(join(root, 'index.json'), JSON.stringify(await inspectCorpus(root)), { secrets: options.secrets, replace: true });
  } finally { await lock.release(); }
}
export async function corpusFindings(directory: string): Promise<{ entry: CorpusEntry; finding: Finding }[]> {
  const index = await inspectCorpus(directory);
  return Promise.all(index.entries.map(async entry => {
    const object = checkedHash(entry.evidence[entry.evidence.length - 1]!);
    const text = await readBoundedText(join(directory, 'objects', object + '.json')); assert(wireHash(text) === object, 'corpus object hash mismatch');
    const finding = validateFinding(JSON.parse(text)); assert(entry.pairHash === contentHash([finding.candidate.baseWireHash, finding.candidate.mutantWireHash, finding.contract, finding.candidate.targetHash]), 'corpus pair identity mismatch');
    return { entry, finding };
  }));
}
export interface CheckReport { version: 2; kind: 'check'; status: 'complete' | 'incomplete'; exitCode: number; provider: string; oracle: OracleConfig; targetHashes: string[]; requestedModels: string[]; cohort: 'unobserved' | 'single' | 'mixed'; total: number; required: number; excluded: number; quarantined: number; expired: number; results: { entryId: string; verdict: Confirmation['verdict']; reason: string; confirmation?: Confirmation }[]; budget: ReturnType<BudgetLedger['snapshot']>; observedModels: string[] }
type CorpusFinding = Awaited<ReturnType<typeof corpusFindings>>[number];
const oracleFields = ['profile', 'pairs', 'minimumSupport', 'maxControlViolationRate', 'minimumEffect', 'alpha', 'originalSlots', 'shrinkSlots'] as const;
function sameOracle(a: OracleConfig, b: OracleConfig): boolean { return oracleFields.every(key => a[key] === b[key]); }
export function prepareCorpusCheck(all: CorpusFinding[], options: { oracle?: OracleConfig; profile?: OracleConfig['profile']; now?: number; providerName?: string } = {}): { selected: CorpusFinding[]; oracle: OracleConfig; provider: string; preparationHash: string } {
  assert(!(options.oracle && options.profile), 'supply either options.oracle or --profile, not both');
  const now = options.now ?? Date.now();
  assert(Number.isFinite(now), 'invalid evaluation time');
  const selected = all.filter(({ entry }) => ['accepted_regression', 'resolved'].includes(entry.triage.status) || (entry.triage.status === 'quarantined' && Date.parse(entry.triage.expiresAt ?? '') <= now));
  const providers = new Set(selected.map(item => item.finding.provider));
  assert(providers.size <= 1, 'mixed-provider corpus requires separate corpora or a comparison experiment');
  const selectedProvider = selected[0]?.finding.provider;
  assert(!options.providerName || !selectedProvider || options.providerName === selectedProvider, 'corpus provider identity mismatch; use a separate corpus or comparison experiment');
  let oracle: OracleConfig;
  if (options.oracle) oracle = structuredClone(options.oracle);
  else if (options.profile) oracle = { profile: options.profile, pairs: options.profile === 'fixed-stat-v1' ? 64 : 8, minimumSupport: .75, maxControlViolationRate: .125, minimumEffect: 0, alpha: .05, originalSlots: selected.length, shrinkSlots: 0 };
  else if (selected.length) {
    oracle = structuredClone(selected[0]!.finding.oracle);
    assert(selected.every(item => sameOracle(oracle, item.finding.oracle)), 'selected corpus oracle configurations differ; supply options.oracle or --profile');
  } else oracle = { profile: 'paired-v1', pairs: 8, minimumSupport: .75, maxControlViolationRate: .125, minimumEffect: 0, alpha: .05, originalSlots: 0, shrinkSlots: 0 };
  validateOracle(oracle);
  const provider = selectedProvider ?? options.providerName ?? 'typesafe';
  return { selected, oracle, provider, preparationHash: contentHash({ selected: selected.map(item => item.entry.id), oracle, provider }) };
}
export async function checkCorpus(directory: string, provider: DecisionProvider, options: { oracle?: OracleConfig; profile?: OracleConfig['profile']; expectedPreparationHash?: string; budget?: BudgetConfig; signal?: AbortSignal; secrets?: string[]; now?: string; providerName?: string } = {}): Promise<CheckReport> {
  const root = await privateDir(directory), lock = await writerLock(root);
  try {
  const { quota } = await openCorpusStorage(root), all = await corpusFindings(root), now = options.now ? Date.parse(options.now) : Date.now();
  const prepared = prepareCorpusCheck(all, { oracle: options.oracle, profile: options.profile, now, providerName: options.providerName });
  assert(!options.expectedPreparationHash || options.expectedPreparationHash === prepared.preparationHash, 'corpus changed after check preflight; rerun check');
  const { selected, oracle } = prepared;
  const actualProvider = provider instanceof TypeSafeProvider ? 'typesafe' : provider instanceof CloudflareProvider ? 'cloudflare' : options.providerName ?? 'custom';
  assert((!options.providerName || options.providerName === actualProvider) && (!selected.length || prepared.provider === actualProvider), 'corpus provider identity mismatch; use a separate corpus or comparison experiment');
  const count = Math.max(1, selected.length), calls = count * (2 + confirmationCost(oracle));
  const budget = options.budget ?? { logicalRequests: calls, httpAttempts: calls * 5, wallTimeSeconds: 600, discoveryRequests: count * 2, confirmationRequests: count * confirmationCost(oracle), shrinkRequests: 0, finalConfirmationRequests: 0 };
  if (oracle.profile === 'fixed-stat-v1') {
    assert(provider.capabilities?.cacheMetadata, 'fixed-stat-v1 requires an adapter with explicit cache metadata');
    assert(selected.every(item => item.finding.contract.relation !== 'directional'), 'fixed-stat-v1 excludes directional relations');
    assert(oracle.originalSlots >= selected.length, 'fixed-stat-v1 needs a reserved slot for each required regression');
  }
  assert(budget.discoveryRequests >= selected.length * 2 && budget.confirmationRequests >= selected.length * confirmationCost(oracle), 'regression budget cannot cover required fixtures');
  const ledger = new BudgetLedger(budget), slots = new HypothesisSlots(oracle);
  new EvaluationBroker(provider, ledger, { strict: true });
  const runId = randomUUID(), journalPath = join(root, `check-${runId}.jsonl`), journal = await ExecutionJournal.create(journalPath, { secrets: options.secrets, consumeBytes: bytes => quota.append(journalPath, bytes) }), broker = new EvaluationBroker(provider, ledger, { strict: true, signal: options.signal, secrets: options.secrets, journal, providerName: options.providerName });
  const report: CheckReport = { version: 2, kind: 'check', status: 'complete', exitCode: 3, provider: selected.length ? actualProvider : 'unobserved', oracle, targetHashes: [...new Set(selected.map(item => item.finding.candidate.targetHash))], requestedModels: [...new Set(selected.map(item => JSON.parse(item.finding.candidate.basePayload).model as string))], cohort: 'unobserved', total: all.length, required: selected.length, excluded: all.length - selected.length,
    quarantined: all.filter(({ entry }) => entry.triage.status === 'quarantined').length, expired: selected.filter(({ entry }) => entry.triage.status === 'quarantined').length,
    results: [], budget: ledger.snapshot(), observedModels: [] };
  try {
    for (const { entry, finding } of selected) {
      const a = await broker.evaluate(finding.candidate.basePayload, 'discovery'), b = await broker.evaluate(finding.candidate.mutantPayload, 'discovery');
      const observation = evaluateRelation(finding.candidate, finding.contract, a.response, b.response, finding.policy);
      // Freeze any newly observed direction; historical answers are never expectations.
      const confirmation = await confirmCandidate(finding.candidate, finding.contract, broker, oracle, { signature: observation.signature ?? finding.confirmation.signature, seed: 42, ledger, slots, policy: finding.policy, discoverySamples: 2 });
      report.results.push({ entryId: entry.id, verdict: confirmation.verdict, reason: confirmation.reason, confirmation });
      if (confirmation.reason.startsWith('INCOMPLETE_')) throw new FuzzError('CHECK_INTERRUPTED', 'regression check interrupted');
    }
  } catch { report.status = 'incomplete'; }
  finally { await journal.close(); }
  report.budget = ledger.snapshot(); report.observedModels = broker.observedModels;
  report.cohort = broker.observedModels.length === 0 ? 'unobserved' : broker.observedModels.length === 1 ? 'single' : 'mixed';
  if (broker.modelChanged) for (const result of report.results) { result.verdict = 'INCONCLUSIVE'; result.reason = 'COHORT_CHANGED'; }
  report.exitCode = report.status === 'incomplete' ? 2 : report.results.some(r => r.verdict === 'FAIL') ? 1 : !selected.length || report.results.length !== selected.length || report.results.some(r => r.verdict === 'INCONCLUSIVE') ? 3 : 0;
  await quota.write(join(root, `check-${runId}.json`), JSON.stringify(report), { secrets: options.secrets });
  return report;
  } finally { await lock.release(); }
}
export async function pruneCorpus(directory: string, execute = false): Promise<{ candidates: string[]; deleted: number }> {
  const root = await privateDir(directory), lock = await writerLock(root);
  try {
    const { quota } = await openCorpusStorage(root), index = await inspectCorpus(root), referenced = new Set(index.entries.flatMap(entry => entry.evidence));
    await objectBytes(root);
    let files: string[]; try { files = await readdir(join(root, 'objects')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; files = []; }
    const candidates = files.filter(file => !referenced.has(file.slice(0, -5))).sort();
    if (execute) {
      const journal = await journalFor(root, quota);
      try { await journal.append('pruned', { objects: candidates, timestamp: new Date().toISOString() }); for (const file of candidates) await rm(join(root, 'objects', file)); } finally { await journal.close(); }
    }
    return { candidates, deleted: execute ? candidates.length : 0 };
  } finally { await lock.release(); }
}
