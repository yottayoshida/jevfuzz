import { dirname, join, resolve } from 'node:path';
import type { CampaignConfig, Candidate, Finding, Observation, Phase } from '../campaign-types.ts';
import { COMPONENT_VERSIONS } from '../campaign-types.ts';
import { parseCampaign } from '../campaign-config.ts';
import { validateFinding } from '../artifacts-v2.ts';
import { validateRequest } from '../config.ts';
import { validateResponse } from '../provider.ts';
import { contentHash } from '../identity.ts';
import { assert, record } from '../util.ts';
import { readJson, readBoundedText, parseBoundedJson, storagePath } from '../storage.ts';
import { BudgetLedger, type BudgetSnapshot, type Reservation, type Balance } from './budget.ts';
import { decodeJournal, type JournalRecord } from './journal.ts';
import { BatchScheduler, type SearchSnapshot } from './search.ts';
import { extractFeedback } from './feedback.ts';
import { evaluateRelation } from '../contracts/index.ts';
import { HypothesisSlots, type SlotSnapshot, type TestSlot } from '../oracles/index.ts';
import { generateCandidateSet } from '../mutators/index.ts';
import type { CandidateResult } from './campaign.ts';

export interface RecoveryState {
  config: CampaignConfig; budget: BudgetSnapshot; slots: SlotSnapshot; scheduler: SearchSnapshot;
  results: CandidateResult[]; findings: Finding[]; observedModels: string[];
  usage: { inputTokens: number; outputTokens: number }; unresolved: number;
  parentRunId: string; parentJournal: string; parentHead: string;
}
const phases = { discovery: 'discoveryRequests', confirmation: 'confirmationRequests', shrink: 'shrinkRequests', 'final-confirmation': 'finalConfirmationRequests' } as const;
function balance(limit: number): Balance { return { limit, activeReserved: 0, consumedKnown: 0, consumedUnknown: 0, remaining: limit }; }
function reconstructed(config: CampaignConfig, lineageBudgetId: string, reservations: Map<string, Reservation>, elapsedMs: number): BudgetSnapshot {
  const snapshot: BudgetSnapshot = { version: 1, lineageBudgetId, config: config.budget, elapsedMs, logical: balance(config.budget.logicalRequests), http: balance(config.budget.httpAttempts), phases: Object.fromEntries(Object.entries(phases).map(([p, key]) => [p, balance(config.budget[key])])) as BudgetSnapshot['phases'], reservations: [...reservations.values()] };
  for (const r of reservations.values()) for (const b of r.state === 'released' ? [] : r.kind === 'http' ? [snapshot.http] : [snapshot.logical, snapshot.phases[r.phase]]) {
    b.remaining--; if (r.state === 'known') b.consumedKnown++; else if (r.state === 'unknown') b.consumedUnknown++; else b.activeReserved++;
  }
  // The ledger validates every limit and conservatively closes unresolved reservations.
  return new BudgetLedger(config.budget, snapshot).snapshot();
}
function data(row: JournalRecord): Record<string, unknown> { assert(record(row.data), 'invalid recovery journal data'); return row.data; }

/** The checkpoint supplies an anchor; durable journal events supply all state and balances. */
export async function recoverCampaign(checkpointPath: string): Promise<RecoveryState> {
  const cached = await readJson(checkpointPath);
  assert(record(cached) && cached.version === 2 && cached.kind === 'checkpoint' && typeof cached.runId === 'string' && typeof cached.journalHead === 'string', 'invalid campaign checkpoint');
  const directory = dirname(storagePath(checkpointPath)), journalFile = join(directory, 'events.jsonl');
  assert(cached.journalFile === journalFile, 'checkpoint cannot redirect its journal');
  const decoded = decodeJournal(await readBoundedText(journalFile, 256 * 1024 * 1024));
  assert(decoded.records.length > 0 && decoded.records[0]!.type === 'campaign-start', 'campaign journal has no start');
  assert(decoded.records.some(r => r.hash === cached.journalHead), 'checkpoint journal anchor is absent');
  assert(!decoded.records.some(r => r.type === 'resume-child'), 'this run was already resumed; use its child checkpoint');
  const start = data(decoded.records[0]!);
  assert(record(start.config), 'missing recoverable full configuration');
  const { duplicateSeeds: duplicates, ...source } = start.config;
  const config = parseCampaign(source); config.duplicateSeeds += Number(duplicates ?? 0);
  assert(config.storage.mode === 'full' && contentHash(config) === start.configHash && cached.configHash === start.configHash && contentHash(cached.config) === start.configHash, 'checkpoint configuration changed');
  assert(contentHash(start.components) === contentHash(COMPONENT_VERSIONS) && contentHash(cached.componentVersions) === contentHash(COMPONENT_VERSIONS), 'checkpoint component versions changed');
  const terminal = decoded.records.findLast(r => r.type === 'campaign-finished');
  if (terminal && record(terminal.data) && record(terminal.data.report) && terminal.data.report.status === 'complete' && terminal.data.report.stopReason !== 'model_changed') {
    let published: unknown;
    try { published = await readJson(join(directory, 'report.json')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // A durable terminal without the final report is an interrupted publication,
    // not a completed run. Its committed observations and costs remain reusable.
    assert(published === undefined, 'completed campaigns cannot be resumed; start a new campaign');
  }
  assert(start.id === cached.runId && typeof start.lineageBudgetId === 'string', 'checkpoint lineage changed');
  const candidates = generateCandidateSet(config).candidates, byId = new Map(candidates.map(c => [c.id, c]));
  let scheduler = new BatchScheduler(candidates, config.search), results: CandidateResult[] = [], findings: Finding[] = [];
  const reservations = new Map<string, Reservation>(), slots: TestSlot[] = [], operations = new Map<string, { candidateId?: string; side?: string }>(), observations = new Map<string, Observation>();
  const models = new Set<string>(), usage = { inputTokens: 0, outputTokens: 0 };
  let elapsedMs = 0;
  if (start.inherited !== undefined) {
    assert(record(start.inherited), 'invalid inherited recovery state');
    const prior = start.inherited as unknown as RecoveryState;
    assert(contentHash(prior.config) === contentHash(config) && prior.budget.lineageBudgetId === start.lineageBudgetId, 'inherited configuration/lineage changed');
    assert(/^[a-f0-9-]{36}$/.test(prior.parentRunId) && prior.parentJournal === storagePath(join(config.storage.directory, 'runs', prior.parentRunId, 'events.jsonl')), 'inherited journal path changed');
    const parent = decodeJournal(await readBoundedText(prior.parentJournal, 256 * 1024 * 1024));
    assert(parent.records.some(row => row.type === 'resume-child' && row.previousHash === prior.parentHead && record(row.data) && row.data.runId === start.id && row.data.lineageBudgetId === start.lineageBudgetId), 'orphan recovery child has no exclusive parent claim');
    const budget = new BudgetLedger(config.budget, prior.budget).snapshot();
    for (const r of budget.reservations) reservations.set(r.id, r);
    slots.push(...new HypothesisSlots(config.oracle, prior.slots).snapshot().slots);
    scheduler = new BatchScheduler(candidates, config.search, prior.scheduler); results = structuredClone(prior.results); findings = prior.findings.map(validateFinding);
    prior.observedModels.forEach(m => models.add(m)); usage.inputTokens = prior.usage.inputTokens; usage.outputTokens = prior.usage.outputTokens; elapsedMs = budget.elapsedMs;
  }
  for (const row of decoded.records.slice(1)) {
    const value = data(row);
    if (typeof value.elapsedMs === 'number') { assert(Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0, 'invalid elapsed time'); elapsedMs = Math.max(elapsedMs, value.elapsedMs); }
    if (row.type === 'reservation') {
      assert(typeof value.attemptId === 'string' && typeof value.operationId === 'string' && ['logical', 'http'].includes(String(value.kind)) && Object.hasOwn(phases, String(value.phase)) && !reservations.has(value.attemptId), 'invalid durable reservation');
      reservations.set(value.attemptId, { id: value.attemptId, kind: value.kind as 'logical' | 'http', phase: value.phase as Phase, state: 'reserved' });
      if (value.kind === 'logical') {
        assert(!operations.has(value.operationId), 'duplicate durable operation');
        const suffix = value.operationId.startsWith(String(start.id) + ':') ? value.operationId.slice(String(start.id).length + 1) : '';
        const cut = suffix.lastIndexOf(':'), candidateId = suffix.slice(0, cut), side = suffix.slice(cut + 1);
        operations.set(value.operationId, byId.has(candidateId) && ['base', 'mutant'].includes(side) ? { candidateId, side } : {});
      }
    } else if (row.type === 'dispatched' || row.type === 'settled') {
      const r = reservations.get(String(value.attemptId)); assert(r && r.kind === value.kind && r.phase === value.phase, 'dispatch without reservation');
      if (row.type === 'dispatched') { assert(r.state === 'reserved', 'duplicate dispatch'); r.state = 'dispatched'; }
      else { assert(['reserved', 'dispatched'].includes(r.state) && ['known', 'unknown'].includes(String(value.outcome)), 'invalid settlement'); r.state = value.outcome as 'known' | 'unknown'; }
    } else if (row.type === 'observation') {
      assert(record(value.observation), 'invalid persisted observation'); const o = value.observation as unknown as Observation;
      assert(o.operationId === value.operationId && operations.has(o.operationId) && !observations.has(o.operationId), 'observation operation mismatch');
      const identity = operations.get(o.operationId)!, c = identity.candidateId ? byId.get(identity.candidateId) : undefined;
      if (c) { const payload = identity.side === 'base' ? c.basePayload : c.mutantPayload; assert(o.wireHash === (identity.side === 'base' ? c.baseWireHash : c.mutantWireHash), 'recovered wire identity changed'); validateResponse(o.response, validateRequest(parseBoundedJson(payload))); }
      assert(o.response.model === o.observedModel && typeof o.observedModel === 'string', 'invalid recovered model');
      observations.set(o.operationId, o); models.add(o.observedModel); usage.inputTokens += o.response.usage.input_tokens; usage.outputTokens += o.response.usage.output_tokens;
    } else if (row.type === 'slot-frozen') {
      const s = value as unknown as TestSlot; assert(!slots.some(old => old.id === s.id) && s.state === 'frozen', 'slot reused'); slots.push(structuredClone(s));
    } else if (row.type === 'slot-closed') {
      const s = slots.find(s => s.id === value.id); assert(s?.state === 'frozen' && typeof value.complete === 'boolean', 'invalid slot close'); s.state = value.complete ? 'complete' : 'inconclusive';
    } else if (row.type === 'batch-committed') {
      assert(record(value.budget) && Array.isArray(value.results) && Array.isArray(value.findings), 'invalid batch commit');
      const saved = value.budget as unknown as BudgetSnapshot;
      const rebuilt = reconstructed(config, start.lineageBudgetId, reservations, saved.elapsedMs);
      const savedLedger = new BudgetLedger(config.budget, saved).snapshot();
      assert(contentHash(rebuilt.reservations) === contentHash(savedLedger.reservations) && rebuilt.lineageBudgetId === savedLedger.lineageBudgetId, 'journal budget disagrees with committed batch');
      elapsedMs = Math.max(elapsedMs, saved.elapsedMs); scheduler = new BatchScheduler(candidates, config.search, value.scheduler as unknown as SearchSnapshot);
      const batchResults = value.results as unknown as CandidateResult[];
      assert(batchResults.every(r => byId.has(r.candidateId) && !results.some(old => old.candidateId === r.candidateId)), 'invalid committed candidate result');
      results.push(...structuredClone(batchResults)); findings = (value.findings as unknown[]).map(validateFinding);
    } else if (row.type === 'campaign-finished') {
      if (record(value.report) && record(value.report.budget) && typeof value.report.budget.elapsedMs === 'number') elapsedMs = Math.max(elapsedMs, value.report.budget.elapsedMs);
    } else assert(['batch-planned', 'confirmation-frozen', 'confirmation-block'].includes(row.type), 'unknown campaign recovery event');
  }
  // Never redispatch a started, uncommitted candidate implicitly. Retain known pairs
  // as discovery evidence and mark interrupted confirmations pending.
  let unresolved = 0; const commits = [];
  for (const c of candidates) {
    if (results.some(r => r.candidateId === c.id)) continue;
    const ops = [...operations].filter(([, op]) => op.candidateId === c.id); if (!ops.length) continue;
    unresolved++;
    const a = observations.get(ops.find(([, op]) => op.side === 'base')?.[0] ?? ''), b = observations.get(ops.find(([, op]) => op.side === 'mutant')?.[0] ?? '');
    const contracts = config.contracts.filter(contract => c.contractIds.includes(contract.id));
    const relations = contracts.map(contract => ({ contractId: contract.id, discovery: a && b ? evaluateRelation(c, contract, a.response, b.response, config.policy) : { status: 'unknown' as const, reasons: ['INTERRUPTED_DISPATCH'] }, pending: true }));
    const feedback = a && b ? extractFeedback(c, contracts, a.response, b.response, relations.map(r => r.discovery), config.policy) : { version: 'typed-v1' as const, signatures: [], margin: 1, divergence: 0, violation: false, families: [], pairBytes: Buffer.byteLength(c.basePayload) + Buffer.byteLength(c.mutantPayload) };
    results.push({ candidateId: c.id, seedId: c.seedId, depth: c.recipe.length, observationIds: [a?.id, b?.id].filter((v): v is string => !!v), relations, feedback });
    commits.push({ candidateId: c.id, feedback });
  }
  if (commits.length) scheduler.commit(commits);
  assert(typeof start.timestamp === 'string' && Number.isFinite(Date.parse(start.timestamp)), 'invalid campaign timestamp');
  elapsedMs = Math.max(elapsedMs, Date.now() - Date.parse(start.timestamp) + (record(start.inherited) && record(start.inherited.budget) ? Number(start.inherited.budget.elapsedMs) : 0));
  const budget = reconstructed(config, start.lineageBudgetId, reservations, elapsedMs), slotSnapshot = new HypothesisSlots(config.oracle, { original: config.oracle.originalSlots, shrink: config.oracle.shrinkSlots, slots }).snapshot();
  return { config, budget, slots: slotSnapshot, scheduler: scheduler.snapshot(), results, findings, observedModels: [...models], usage, unresolved, parentRunId: String(start.id), parentJournal: journalFile, parentHead: decoded.headHash };
}
