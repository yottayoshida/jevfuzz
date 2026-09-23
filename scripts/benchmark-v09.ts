#!/usr/bin/env node
/** Offline reproducible simulator benchmark; no live provider is constructed. */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseCampaign } from '../src/campaign-config.ts';
import { campaign, planCampaign } from '../src/engine/campaign.ts';
import { BatchScheduler } from '../src/engine/search.ts';
import { wireHash } from '../src/identity.ts';
import { FakeProvider } from '../src/provider.ts';
import { exactPairedTail, summarizeConfirmation } from '../src/oracles/index.ts';
import { evaluateRelation } from '../src/contracts/index.ts';
import type { CampaignConfig, ConfirmationBlock, Contract, Observation, OracleConfig } from '../src/campaign-types.ts';
import type { JevRequest, JevResponse } from '../src/types.ts';
import { runKnownMinimumSuite, runNullSuite } from './benchmark-v09-supplemental.ts';
import { correctCensoredAnalysis, validateDerivedRows } from './benchmark-v09-censored-analysis.ts';

type Family = { id: string; expect: 'detect' | 'hold' | 'inconclusive' };
type Manifest = { families: Family[]; strategies: CampaignConfig['search']['strategy'][]; full: { seeds: number; logicalRequests: number; httpAttempts: number }; fixedStatNull: { campaigns: number; familySlots: number; pairs: number; alpha: number } };
type Trial = { version: 3; sourceHash: string; firstConfirmationObservationOrdinals: number[]; seed: number; family: string; expected: Family['expect']; strategy: string; status: string; exitCode: number; findings: number; actionableFindings: number; discoveryEvent: boolean; firstConfirmedCandidateOrdinal: number | null; firstFindingLogicalCall: number; firstFindingCensored: boolean; logicalCalls: number; httpAttempts: number; phaseCosts: Record<string, number>; invalidCandidates: number; controls: number; confirmationSamples: number; signatureCount: number; stableSignatureCount: number; observedModels: string[]; wireSequenceHash: string; elapsedMs: number };
const ROOT = resolve(import.meta.dirname, '..');
const MANIFEST = join(ROOT, 'fixtures/benchmarks/manifest.json');
const DEFAULT_OUT = join(ROOT, 'fixtures/benchmarks/raw-v09-v3');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const rng = (seed: number) => () => { let t = seed += 0x6d2b79f5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 2 ** 32; };
const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) / 2)]! : null; };
const percentile = (xs: number[], p: number) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) * p)]! : null; };

function active(family: string, request: JevRequest) {
  const keys = Object.keys(request.questions), encoded = JSON.stringify(request);
  const renamed = keys.some(k => k.startsWith('q_')), reordered = keys[0] !== 'route';
  const criteria = Object.values(request.questions).some(q => q.type === 'choice' && Object.keys(q.criteria)[0] === 'general');
  const metadata = encoded.includes('"benchmark_metadata"');
  if (family === 'order') return renamed && (criteria || metadata);
  if (family === 'metadata') return renamed && metadata;
  if (family === 'interaction2') return renamed && reordered;
  if (family === 'interaction3') return renamed && (reordered || metadata) && (criteria || metadata);
  if (family === 'rareconfident') return renamed && metadata && Number((request.state as { seed?: number }).seed) % 11 === 0;
  if (family === 'policy-confidence') return renamed && criteria;
  if (family === 'policy-choice') return renamed && reordered;
  return false;
}
function simulated(family: Family, request: JevRequest, index: number): JevResponse {
  const changed = active(family.id, request), model = family.id === 'drift' && index % 5 === 4 ? 'benchmark-drift-b' : 'benchmark-a';
  const answers = Object.fromEntries(Object.entries(request.questions).map(([id, q]) => {
    if (q.type === 'noul') return [id, { type: 'noul', noul: changed && family.expect === 'detect' ? .9 : .2 }];
    if (q.type === 'score') return [id, { type: 'score', score: changed && family.expect === 'detect' ? 1 : 0, confidence: changed ? .55 : .95, probabilities: changed ? { '0': .1, '1': .9 } : { '0': .9, '1': .1 }, legend: { '0': 'low', '1': 'high' } }];
    const choice = (changed && family.expect === 'detect') || (family.id === 'noise' && index % 5 === 0) ? 'general' : 'billing';
    return [id, { type: 'choice', choice, confidence: family.id === 'policy-confidence' && changed ? .4 : .95, probabilities: choice === 'billing' ? { billing: .95, general: .05 } : { billing: .05, general: .95 } }];
  }));
  return { model, answers, usage: { input_tokens: 0, output_tokens: 0 } };
}
function config(family: Family, strategy: CampaignConfig['search']['strategy'], seed: number, logical: number, http: number) {
  const policy = family.id.startsWith('policy-') ? { version: 1, rules: [{ when: { question: 'route', field: family.id === 'policy-confidence' ? 'confidence' : 'choice', op: family.id === 'policy-confidence' ? 'gte' : 'eq', value: family.id === 'policy-confidence' ? .8 : 'billing' }, action: 'allow' }], fallback: 'review' } : undefined;
  const projection = family.id.startsWith('policy-') ? 'policy' : family.id === 'noul-invariant' ? 'noul' : family.id === 'score-invariant' ? 'score' : 'choice';
  const route = projection === 'noul' ? { type: 'noul' as const, instructions: 'Route.' } : projection === 'score' ? { type: 'score' as const, instructions: 'Route.', criteria: ['low', 'high'] } : { type: 'choice' as const, instructions: 'Route.', criteria: { billing: 'billing', general: 'general' } };
  const irrelevant = Array.from({ length: 4 }, (_, i) => ({ path: '$.state', field: `benchmark_tag_${i}`, values: [`v${i}-a`, `v${i}-b`, `v${i}-c`] }));
  const result = parseCampaign({ version: 2, name: `benchmark-${family.id}-${seed}`, provider: 'custom', seeds: [{ id: 'seed', request: { state: { seed, optionalA: { note: 'remove me', tags: ['a', 'b', 'c'] }, optionalB: { note: 'remove me too', tags: ['d', 'e', 'f'] } }, model: 'benchmark', questions: { route, second: { type: 'choice', instructions: 'Second.', criteria: { billing: 'billing', general: 'general' } }, third: { type: 'choice', instructions: 'Third.', criteria: { billing: 'billing', general: 'general' } } } }, mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [{ path: '$.state', field: 'benchmark_metadata', values: ['metadata-a', 'metadata-b', 'metadata-c'] }, ...irrelevant], prosePaths: [] } }], contracts: [{ id: 'route', question: 'route', relation: 'invariant', projection, mutations: ['question_id_rename', 'question_order', 'choice_criteria_order', 'object_key_order', 'irrelevant_field_injection'], admissibility: 'declared', assumptions: ['Benchmark simulator declares representation mutations irrelevant.'], required: true }], search: { strategy, seed, maxDepth: 3, batchSize: 8, concurrency: 4, uniformFraction: .2, stagnationBatches: 20, maxCandidates: 1000, maxQueueBytes: 16 * 1024 * 1024, familyQuota: 100 }, oracle: { profile: 'paired-v1', pairs: 8, minimumSupport: .75, maxControlViolationRate: .125, minimumEffect: 0, alpha: .05, originalSlots: 5, shrinkSlots: 5 }, budget: { logicalRequests: logical, httpAttempts: http, wallTimeSeconds: 60, discoveryRequests: Math.floor(logical * .4), confirmationRequests: Math.floor(logical * .6), shrinkRequests: 0, finalConfirmationRequests: 0 }, storage: { mode: 'hash-only', directory: '.benchmark-v09', maxRunBytes: 64 * 1024 * 1024, maxCorpusBytes: 512 * 1024 * 1024, redactPaths: [] }, reducers: { independentQuestions: false, optionalStatePaths: ['$.state.optionalA', '$.state.optionalB'], unorderedArrayPaths: ['$.state.optionalA.tags', '$.state.optionalB.tags'], prosePaths: ['$.state.optionalA.note', '$.state.optionalB.note'] }, ...(policy ? { policy } : {}) });
  return result;
}
function cdf(k: number, n: number, p: number) { let term = (1 - p) ** n, total = term; for (let i = 1; i <= k; i++) { term *= (n - i + 1) / i * p / (1 - p); total += term; } return total; }
function cpUpper(fails: number, n: number) { let lo = 0, hi = 1; for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (cdf(fails, n, mid) > .05) lo = mid; else hi = mid; } return hi; }
function nullBlock(index: number, contract: Contract, cache: Observation['cache'] = 'fresh', model = 'null', uncertain = false): ConfirmationBlock {
  // Successive draws from one frozen PRNG produce independent A/A′/B samples; no salted linear-index correlation.
  const next = rng(index), choice = () => next() < .5 ? 'billing' : 'general';
  const answer = (value: string): JevResponse => ({ model, answers: { route: { type: 'choice', choice: value, confidence: 1, probabilities: value === 'billing' ? { billing: 1, general: 0 } : { billing: 0, general: 1 } } }, usage: { input_tokens: 0, output_tokens: 0 } });
  const observation = (side: string, value: string): Observation => ({ id: `${index}-${side}`, operationId: `${index}-${side}`, phase: 'confirmation', wireHash: side === 'b' ? 'b'.repeat(64) : 'a'.repeat(64), response: answer(value), provider: 'null', observedModel: model, cache, ...(uncertain ? { transportUncertain: true } : {}) });
  const a = observation('a', choice()), control = observation('c', choice()), b = observation('b', choice());
  return { a, control, b, violation: evaluateRelation({ questionMap: {}, labelMaps: {} } as any, contract, a.response, b.response), sham: evaluateRelation({} as any, contract, a.response, control.response) };
}
function censoredCurve(rows: Trial[], budget: number) { let risk = rows.length, survival = 1; const output: unknown[] = []; for (let call = 1; call <= budget; call++) { const events = rows.filter(r => r.discoveryEvent && r.firstFindingLogicalCall === call).length, censored = rows.filter(r => !r.discoveryEvent && r.logicalCalls === call).length; if (events) survival *= 1 - events / risk; if (call % 25 === 0 || events || censored || call === budget) output.push({ calls: call, discovered: events, censored, survival }); risk -= events + censored; } return output; }
function bootstrap(rows: Trial[], salt: number) { const next = rng(salt), values: { rate: number; median: number | null; actionable: number }[] = []; for (let i = 0; i < 500; i++) { const sample = Array.from({ length: rows.length }, () => rows[Math.floor(next() * rows.length)]!), events = sample.filter(r => r.discoveryEvent).map(r => r.firstFindingLogicalCall); values.push({ rate: events.length / sample.length, median: events.length >= sample.length / 2 ? median(events) : null, actionable: sample.reduce((n, r) => n + r.actionableFindings, 0) * 1000 / sample.reduce((n, r) => n + r.logicalCalls, 0) }); } return { discoveryRate95: [percentile(values.map(v => v.rate), .025), percentile(values.map(v => v.rate), .975)], medianCalls95: [percentile(values.flatMap(v => v.median === null ? [] : [v.median]), .025), percentile(values.flatMap(v => v.median === null ? [] : [v.median]), .975)], actionablePer1000_95: [percentile(values.map(v => v.actionable), .025), percentile(values.map(v => v.actionable), .975)] }; }
function analysis(rows: Trial[], budget: number) {
  const groups: Record<string, any> = {};
  for (const family of new Set(rows.map(r => r.family))) for (const strategy of new Set(rows.map(r => r.strategy))) {
    const set = rows.filter(r => r.family === family && r.strategy === strategy), events = set.filter(r => r.discoveryEvent).map(r => r.firstFindingLogicalCall);
    groups[`${family}/${strategy}`] = { trials: set.length, discoveryRate: events.length / set.length, medianFirstFindingLogicalCall: events.length >= set.length / 2 ? median(events) : null, censoredAtBudget: set.length - events.length, actionablePer1000: set.reduce((n, r) => n + r.actionableFindings, 0) * 1000 / set.reduce((n, r) => n + r.logicalCalls, 0), meanPhaseCosts: Object.fromEntries(['discovery', 'confirmation', 'shrink', 'final-confirmation'].map(p => [p, set.reduce((n, r) => n + (r.phaseCosts[p] ?? 0), 0) / set.length])), meanControls: set.reduce((n, r) => n + r.controls, 0) / set.length, meanSignatureCount: set.reduce((n, r) => n + r.signatureCount, 0) / set.length, censoredCurve: censoredCurve(set, budget), bootstrap: bootstrap(set, sha(`${family}/${strategy}`).charCodeAt(0)) };
  }
  const comparisons = [...new Set(rows.filter(r => r.expected === 'detect').map(r => r.family))].map(family => { const uniform = groups[`${family}/uniform`], feedback = groups[`${family}/feedback`], reduction = uniform?.medianFirstFindingLogicalCall && feedback?.medianFirstFindingLogicalCall ? 1 - feedback.medianFirstFindingLogicalCall / uniform.medianFirstFindingLogicalCall : null; return { family, reduction, uniformRate: uniform?.discoveryRate, feedbackRate: feedback?.discoveryRate, passes25Percent: reduction !== null && reduction >= .25 }; });
  const uniform = rows.filter(r => r.expected === 'detect' && r.strategy === 'uniform'), feedback = rows.filter(r => r.expected === 'detect' && r.strategy === 'feedback'), uniformRate = uniform.filter(r => r.discoveryEvent).length / uniform.length, feedbackRate = feedback.filter(r => r.discoveryEvent).length / feedback.length, qualifying = comparisons.filter(x => x.passes25Percent).length, promoted = qualifying >= 3 && feedbackRate >= uniformRate - .05;
  return { groups, promotion: { defaultStrategy: 'uniform', feedbackPromotion: promoted ? 'promoted' : 'not promoted', criteria: { qualifyingFamiliesAtLeast3: qualifying >= 3, qualifyingFamilies: qualifying, feedbackMedianAtLeast25PercentFaster: comparisons, discoveryRateNoMoreThan5ppLower: feedbackRate >= uniformRate - .05, uniformDiscoveryRate: uniformRate, feedbackDiscoveryRate: feedbackRate, differencePercentagePoints: (feedbackRate - uniformRate) * 100 }, reason: promoted ? 'All pre-registered criteria passed.' : 'Feedback remains experimental because promotion criteria did not all pass.' } };
}
const tuple = (row: Pick<Trial, 'seed' | 'family' | 'strategy'>) => `${row.seed}/${row.family}/${row.strategy}`;
async function sourceFreeze(manifestText: string) {
  const files = ['scripts/benchmark-v09.ts', 'scripts/benchmark-v09-supplemental.ts', 'scripts/benchmark-v09-censored-analysis.ts', 'docs/benchmark-v09.md', 'package-lock.json'];
  const walk = async (path: string): Promise<void> => { for (const entry of await readdir(join(ROOT, path), { withFileTypes: true })) { const relative = `${path}/${entry.name}`; if (entry.isDirectory()) await walk(relative); else if (entry.name.endsWith('.ts')) files.push(relative); } };
  await walk('src'); files.sort();
  const sources = Object.fromEntries(await Promise.all(files.map(async path => [path, sha(await readFile(join(ROOT, path), 'utf8'))])));
  const frozen = { version: 3, manifestHash: sha(manifestText), node: process.version, sources };
  return { ...frozen, sourceHash: sha(JSON.stringify(frozen)) };
}
async function readRows(path: string): Promise<Trial[]> { const raw = (await readFile(path, 'utf8')).trim(); return raw ? raw.split('\n').map(line => JSON.parse(line) as Trial) : []; }
function validateRows(rows: Trial[], expected: Set<string>, sourceHash: string, complete = false) {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = tuple(row);
    if (row.version !== 3 || row.sourceHash !== sourceHash) throw new Error(`unfrozen or incompatible raw trial: ${key}; v2 endpoint data is diagnostic only`);
    if (!expected.has(key) || seen.has(key)) throw new Error(`unexpected or duplicate trial tuple: ${key}`);
    if (row.discoveryEvent && (row.firstConfirmationObservationOrdinals.length !== 24 || Math.max(...row.firstConfirmationObservationOrdinals) !== row.firstFindingLogicalCall || new Set(row.firstConfirmationObservationOrdinals).size !== 24)) throw new Error(`invalid formal endpoint: ${key}`);
    seen.add(key);
  }
  if (complete && seen.size !== expected.size) throw new Error(`incomplete tuple coverage: ${seen.size}/${expected.size}`);
}
async function main() {
  const flags = parseArgs({ options: { quick: { type: 'boolean' }, out: { type: 'string' }, 'supplemental-only': { type: 'boolean' }, 'resume-trials': { type: 'boolean' }, 'trials-only': { type: 'boolean' }, 'shard-index': { type: 'string' }, 'shard-count': { type: 'string' }, 'merge-shards': { type: 'string' } } }).values;
  const manifestText = await readFile(MANIFEST, 'utf8'), manifest = JSON.parse(manifestText) as Manifest;
  const out = resolve(flags.out ?? DEFAULT_OUT), trialPath = join(out, 'trials.jsonl');
  const seeds = flags.quick ? 1 : manifest.full.seeds, strategies = flags.quick ? ['uniform'] as const : manifest.strategies;
  const shardCount = Number(flags['shard-count'] ?? 1), shardIndex = Number(flags['shard-index'] ?? 0);
  if (!Number.isSafeInteger(shardCount) || !Number.isSafeInteger(shardIndex) || shardCount < 1 || shardIndex < 0 || shardIndex >= shardCount) throw new Error('invalid shard index/count');
  if (shardCount > 1 && !flags['trials-only']) throw new Error('shards require --trials-only; combine all shards before acceptance analysis');
  const specs = Array.from({ length: seeds }, (_, seed) => manifest.families.flatMap(family => strategies.map(strategy => ({ seed, family, strategy })))).flat().filter((_, i) => i % shardCount === shardIndex);
  const expected = new Set(specs.map(spec => tuple({ seed: spec.seed, family: spec.family.id, strategy: spec.strategy })));
  const frozen = await sourceFreeze(manifestText);
  await mkdir(out, { recursive: true, mode: 0o700 });
  const frozenPath = join(out, 'sources.frozen.json'), rows: Trial[] = [];
  const continuing = flags['supplemental-only'] || flags['resume-trials'];
  if (continuing) {
    const saved = JSON.parse(await readFile(frozenPath, 'utf8'));
    if (JSON.stringify(saved) !== JSON.stringify(frozen)) throw new Error('source/manifest/runtime changed: start a new evidence directory; existing evidence is preserved');
    rows.push(...await readRows(trialPath)); validateRows(rows, expected, frozen.sourceHash, Boolean(flags['supplemental-only']));
  } else {
    try { await readFile(trialPath); throw new Error('evidence already exists: use --resume-trials or a new output directory'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(frozenPath, JSON.stringify(frozen, null, 2), { mode: 0o600 });
    await writeFile(join(out, 'manifest.frozen.json'), manifestText, { mode: 0o600 });
  }
  if (flags['merge-shards']) {
    if (continuing) throw new Error('--merge-shards cannot be combined with resume/supplemental');
    for (const path of flags['merge-shards'].split(',')) {
      const saved = JSON.parse(await readFile(join(resolve(path), 'sources.frozen.json'), 'utf8'));
      if (JSON.stringify(saved) !== JSON.stringify(frozen)) throw new Error(`incompatible shard source freeze: ${path}`);
      rows.push(...await readRows(join(resolve(path), 'trials.jsonl')));
    }
    validateRows(rows, expected, frozen.sourceHash, true);
    rows.sort((a, b) => a.seed - b.seed || manifest.families.findIndex(f => f.id === a.family) - manifest.families.findIndex(f => f.id === b.family) || manifest.strategies.indexOf(a.strategy as any) - manifest.strategies.indexOf(b.strategy as any));
    await writeFile(trialPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
  } else if (!flags['supplemental-only']) {
    const done = new Set(rows.map(tuple));
    for (const { seed, family, strategy } of specs) {
      if (done.has(tuple({ seed, family: family.id, strategy }))) continue;
      const started = Date.now(), calls: { ordinal: number; hash: string }[] = [];
      const provider = new FakeProvider((request, index) => {
        calls.push({ ordinal: index + 1, hash: wireHash(JSON.stringify(request)) });
        const response = simulated(family, request, index);
        // Harness-only provenance; simulator behavior is computed before tagging.
        response.usage.input_tokens = index + 1;
        return response;
      });
      const report = await campaign(config(family, strategy, seed, manifest.full.logicalRequests, manifest.full.httpAttempts), provider, { persist: false });
      if (report.summary.candidates < 100) throw new Error('benchmark search space too small');
      const confirmations = report.findings.map(finding => {
        const ordinals = finding.confirmation.blocks.flatMap(block => [block.a, block.control, block.b]).map(observation => observation.response.usage.input_tokens);
        if (ordinals.length !== 24 || ordinals.some(ordinal => !Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > calls.length)) throw new Error('formal confirmation ordinal provenance missing');
        return { finding, ordinals, call: Math.max(...ordinals) };
      }).sort((a, b) => a.call - b.call);
      const first = confirmations[0];
      const phaseCosts = Object.fromEntries(Object.entries(report.budget.phases).map(([phase, balance]) => [phase, balance.consumedKnown + balance.consumedUnknown]));
      const allConfirmations = report.results.flatMap(result => result.relations.flatMap(relation => relation.confirmation ? [relation.confirmation] : []));
      const logicalCalls = report.budget.logical.consumedKnown + report.budget.logical.consumedUnknown;
      if (calls.length !== logicalCalls || Object.values(phaseCosts).reduce((sum, n) => sum + n, 0) !== logicalCalls) throw new Error('logical call provenance/accounting mismatch');
      const row: Trial = { version: 3, sourceHash: frozen.sourceHash, seed, family: family.id, expected: family.expect, strategy, status: report.status, exitCode: report.exitCode, findings: report.findings.length, actionableFindings: new Set(report.findings.map(finding => finding.fingerprint)).size, discoveryEvent: Boolean(first), firstConfirmedCandidateOrdinal: first ? report.results.findIndex(result => result.candidateId === first.finding.candidate.id) + 1 : null, firstConfirmationObservationOrdinals: first?.ordinals ?? [], firstFindingLogicalCall: first?.call ?? logicalCalls, firstFindingCensored: !first, logicalCalls, httpAttempts: report.budget.http.consumedKnown + report.budget.http.consumedUnknown, phaseCosts, invalidCandidates: report.summary.invalid, controls: allConfirmations.reduce((total, finding) => total + finding.controls, 0), confirmationSamples: allConfirmations.reduce((total, finding) => total + finding.confirmationSamples, 0), signatureCount: report.coverageProxy.observed, stableSignatureCount: report.coverageProxy.stable, observedModels: report.observedModels, wireSequenceHash: sha(calls.map(call => call.hash).join('\n')), elapsedMs: Date.now() - started };
      rows.push(row); await appendFile(trialPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    }
  }
  validateRows(rows, expected, frozen.sourceHash, true);
  if (JSON.stringify(await sourceFreeze(manifestText)) !== JSON.stringify(frozen)) throw new Error('sources changed during trials; raw evidence preserved without promotion');
  if (flags['trials-only']) { console.log(JSON.stringify({ status: 'trial-shard-complete', trials: rows.length, shardIndex, shardCount, output: out })); return; }
  validateDerivedRows(rows, manifest, { runtime: { seeds, strategies: strategies.length, trialRows: expected.size } }, frozen.sourceHash);
  const shrinkCount = flags.quick ? 1 : 10;
  const shrinkSuite = await runKnownMinimumSuite(shrinkCount);
  await writeFile(join(out, 'shrink.json'), JSON.stringify(shrinkSuite, null, 2));
  const concurrencyRows: any[] = [];
  for (let seed = 0; seed < (flags.quick ? 2 : 50); seed++) {
    const outcomes: Record<string, any> = {};
    for (const concurrency of [1, 4, 8]) {
      const trial = config(manifest.families[0]!, 'uniform', seed, manifest.full.logicalRequests, manifest.full.httpAttempts); trial.search.concurrency = concurrency;
      const candidates = new Map(planCampaign(trial).candidatesList.map(candidate => [candidate.id, candidate]));
      const sequence: string[] = [];
      const report = await campaign(trial, new FakeProvider((request, index) => { sequence[index] = wireHash(JSON.stringify(request)); return simulated(manifest.families[0]!, request, index); }), { persist: false });
      const committedScheduler = new BatchScheduler([...candidates.values()], trial.search);
      for (let offset = 0; offset < report.results.length; offset += trial.search.batchSize) committedScheduler.commit(report.results.slice(offset, offset + trial.search.batchSize).map(result => ({ candidateId: result.candidateId, feedback: result.feedback!, confirmed: result.relations.some(relation => relation.confirmation?.verdict === 'FAIL') })));
      const stableCorpus = committedScheduler.stableCorpus.sort((a, b) => a.signature.localeCompare(b.signature));
      if (stableCorpus.length !== report.coverageProxy.stable) throw new Error('stable corpus replay differs from production report');
      const committedWireHashes = report.results.map(result => { const candidate = candidates.get(result.candidateId); if (!candidate) throw new Error('committed candidate absent from frozen generated set'); return { candidateId: result.candidateId, base: candidate.baseWireHash, mutant: candidate.mutantWireHash }; });
      const confirmationWireHashes = report.results.flatMap(result => result.relations.flatMap(relation => relation.confirmation ? [{ candidateId: result.candidateId, contractId: relation.contractId, blocks: relation.confirmation.blocks.map(block => ({ a: block.a.wireHash, control: block.control.wireHash, b: block.b.wireHash })) }] : []));
      outcomes[String(concurrency)] = { seed: report.seed, inputHashes: report.inputHashes, findings: report.findings.map(finding => finding.fingerprint).sort(), evaluated: report.summary.evaluated, stableCorpus, stableCorpusCount: report.coverageProxy.stable, committedWireHashes, confirmationWireHashes, committedObservationCounts: report.results.map(result => result.observationIds.length), wireSequenceHashDiagnostic: sha(sequence.join('\n')) };
    }
    const comparable = (outcome: any) => { const { wireSequenceHashDiagnostic: _diagnostic, ...stable } = outcome; return stable; };
    concurrencyRows.push({ seed, outcomes, stable: JSON.stringify(comparable(outcomes['1'])) === JSON.stringify(comparable(outcomes['4'])) && JSON.stringify(comparable(outcomes['4'])) === JSON.stringify(comparable(outcomes['8'])) });
  }
  await writeFile(join(out, 'concurrency.json'), JSON.stringify({ seeds: concurrencyRows.length, allStable: concurrencyRows.every(row => row.stable), trials: concurrencyRows }, null, 2));
  const nullSuite = await runNullSuite({ campaigns: flags.quick ? 10 : manifest.fixedStatNull.campaigns, pairs: manifest.fixedStatNull.pairs, alpha: manifest.fixedStatNull.alpha });
  const nullUpper = cpUpper(nullSuite.falseFails, nullSuite.trials.length);
  await writeFile(join(out, 'fixed-stat-null.json'), JSON.stringify({ ...nullSuite, cpUpper95: nullUpper }, null, 2));
  const contract: Contract = { id: 'null', question: 'route', relation: 'invariant', projection: 'choice', mutations: ['question_id_rename'], admissibility: 'structural', assumptions: [], required: true };
  const profile: OracleConfig = { profile: 'fixed-stat-v1', pairs: manifest.fixedStatNull.pairs, minimumSupport: .75, maxControlViolationRate: .125, minimumEffect: 0, alpha: manifest.fixedStatNull.alpha, originalSlots: 5, shrinkSlots: 5 };
  const summarize = (name: string, blocks: ConfirmationBlock[]) => { const signature = blocks.find(block => block.violation.status === 'violates')?.violation.signature ?? 'no-violation'; const result = summarizeConfirmation({ questionMap: {}, labelMaps: {}, admissibility: 'structural', baseWireHash: 'a'.repeat(64), mutantWireHash: 'b'.repeat(64) } as any, contract, profile, signature, blocks, { slotId: 'original-1' }); return { name, verdict: result.verdict, reason: result.reason, falseFail: result.verdict === 'FAIL', pValue: result.pValue, exactTail: exactPairedTail(0, 0) }; };
  const supplemental = [summarize('cache-unknown-null', Array.from({ length: profile.pairs }, (_, n) => nullBlock(n, contract, 'unknown'))), summarize('cached-null', Array.from({ length: profile.pairs }, (_, n) => nullBlock(n, contract, 'cached'))), summarize('rate-limit-uncertain-null', Array.from({ length: profile.pairs }, (_, n) => nullBlock(n, contract, 'fresh', 'null', true))), summarize('drift-null', Array.from({ length: profile.pairs }, (_, n) => nullBlock(n, contract, 'fresh', n % 2 ? 'null-a' : 'null-b')))];
  const reportAnalysis = correctCensoredAnalysis(rows, analysis(rows, manifest.full.logicalRequests), false);
  const expectations = { tupleCoverage: rows.length === expected.size, trialRuntimeErrorsAbsent: rows.every(row => row.status === 'complete'), invariantAndNoiseFalseFindingsAbsent: rows.filter(row => row.expected === 'hold').every(row => !row.discoveryEvent), driftInconclusive: rows.filter(row => row.expected === 'inconclusive').every(row => row.exitCode === 3), knownMinimumShapes: shrinkSuite.passed && shrinkSuite.trials.length === shrinkCount, concurrencyStable: concurrencyRows.every(row => row.stable), nullSlotsCovered: nullSuite.originalSlots === 5 && nullSuite.shrinkSlots === 5 && nullSuite.adaptiveFinalConfirmations > 0 && nullSuite.trials.every(row => row.original.length === 5 && row.shrink.length === 5), nullFwerUpperAtMost007: flags.quick ? null : nullUpper <= .07, guardScenarios: supplemental.every(row => !row.falseFail), sourcesUnchanged: JSON.stringify(await sourceFreeze(manifestText)) === JSON.stringify(frozen) };
  const passed = Object.values(expectations).every(value => value !== false);
  const status = flags.quick ? (passed ? 'quick-smoke-passed' : 'quick-smoke-failed') : (passed ? 'complete-local-protocol' : 'local-protocol-failed');
  if (flags.quick || !passed) { reportAnalysis.promotion.feedbackPromotion = 'not promoted'; reportAnalysis.promotion.reason = flags.quick ? 'Quick smoke cannot establish the registered promotion criteria.' : 'Protocol acceptance failed; performance data cannot promote feedback.'; }
  const summary = { version: 3, kind: 'jevfuzz-v09-benchmark-summary', status, command: process.argv.join(' '), runtime: { mode: 'offline-fake-provider', node: process.version, seeds, families: manifest.families.length, strategies: strategies.length, trialRows: rows.length, logicalBudgetPerTrial: manifest.full.logicalRequests, httpBudgetPerTrial: manifest.full.httpAttempts }, sourceHashes: frozen, raw: { directory: out, trials: 'trials.jsonl', retainedInRepository: out.startsWith(join(ROOT, 'fixtures')) }, acceptance: { passed, expectations }, aggregate: { trialErrors: rows.filter(row => row.status !== 'complete').length, fixedStatNull: { campaigns: nullSuite.trials.length, originalSlots: nullSuite.originalSlots, shrinkSlots: nullSuite.shrinkSlots, pairs: profile.pairs, falseFails: nullSuite.falseFails, adaptiveFinalConfirmations: nullSuite.adaptiveFinalConfirmations, adaptiveCampaignCoverage: nullSuite.adaptiveFinalCoverage, clopperPearsonUpper95: nullUpper }, supplementalNullScenarios: supplemental, shrink: { required: shrinkCount, executed: shrinkSuite.trials.length, knownMinimumShapesPassed: shrinkSuite.passed }, concurrency: { seeds: concurrencyRows.length, allStable: concurrencyRows.every(row => row.stable) } }, analysis: reportAnalysis, decision: reportAnalysis.promotion };
  await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  if (!flags.quick && out === DEFAULT_OUT) await writeFile(join(ROOT, 'fixtures/benchmarks/results-v09.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ status, acceptance: expectations, trials: rows.length, nullCampaigns: nullSuite.trials.length, output: out, promotion: reportAnalysis.promotion.feedbackPromotion }));
  if (!passed) process.exitCode = 1;
}
await main();
