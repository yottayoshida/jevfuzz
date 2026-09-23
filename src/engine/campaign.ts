import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CampaignConfig, Candidate, Confirmation, Finding, Observation, RelationObservation } from '../campaign-types.ts';
import { COMPONENT_VERSIONS } from '../campaign-types.ts';
import type { DecisionProvider } from '../types.ts';
import { parseCampaign } from '../campaign-config.ts';
import { generateCandidateSet } from '../mutators/index.ts';
import { contentHash, contractHash, targetHash, wireHash } from '../identity.ts';
import { evaluateRelation } from '../contracts/index.ts';
import { confirmationCost, confirmCandidate, createFinding, HypothesisSlots, type SlotSnapshot } from '../oracles/index.ts';
import { BudgetLedger, type BudgetSnapshot } from './budget.ts';
import { EvaluationBroker } from './broker.ts';
import { ExecutionJournal } from './journal.ts';
import { BatchScheduler, type SearchSnapshot } from './search.ts';
import { extractFeedback, type Feedback } from './feedback.ts';
import { assert, FuzzError } from '../util.ts';
import { assertNoSecrets, privateDir, writerLock, StorageQuota } from '../storage.ts';
import { recoverCampaign, type RecoveryState } from './recovery.ts';
import { renderReportText } from '../reports-v2.ts';
import { redactCandidate } from '../redaction.ts';
import { TOOL_VERSION } from '../version.ts';
import { initializeCorpus } from '../corpus/index.ts';

export interface CandidateResult {
  candidateId: string; seedId: string; depth: number; feedback?: Feedback;
  relations: { contractId: string; discovery: RelationObservation; confirmation?: Confirmation; pending: boolean }[];
  observationIds: string[];
}
export interface CampaignReport {
  version: 2; kind: 'campaign'; id: string; timestamp: string; toolVersion: string;
  configHash: string; componentVersions: typeof COMPONENT_VERSIONS;
  provider: string; mode: 'live' | 'fake' | 'custom'; requestedModels: string[]; observedModels: string[];
  seed: number; inputHashes: string[]; contractHashes: string[]; targetHashes: string[]; cohort: 'unobserved' | 'single-model' | 'mixed-model'; estimatedCost: null;
  status: 'complete' | 'incomplete'; stopReason: string; exitCode: number;
  budget: BudgetSnapshot; slots: SlotSnapshot;
  summary: { cases: number; questions: number; contracts: number; candidates: number; evaluated: number; pending: number; invalid: number; noops: number; limited: number; duplicateSeeds: number; fail: number; inconclusive: number; requiredUnevaluated: number };
  results: CandidateResult[]; findings: Finding[];
  coverageProxy: { name: 'typed decisions'; version: 'typed-v1'; observed: number; stable: number };
  usage: { inputTokens: number; outputTokens: number };
  persistenceMode: CampaignConfig['storage']['mode'] | 'memory'; replayable: boolean;
  warnings: string[]; errorCode?: string; directory?: string;
}
export interface CampaignCheckpoint {
  version: 2; kind: 'checkpoint'; runId: string; config: CampaignConfig;
  configHash: string; componentVersions: typeof COMPONENT_VERSIONS;
  budget: BudgetSnapshot; slots: SlotSnapshot; scheduler: SearchSnapshot;
  results: CandidateResult[]; findings: Finding[]; observedModels: string[];
  journalHead: string; journalFile: string; timestamp: string;
}
export interface CampaignOptions { signal?: AbortSignal; secrets?: string[]; persist?: boolean; requireConfirmationComplete?: boolean; onCheckpoint?: (checkpoint: CampaignCheckpoint) => void | Promise<void> }

function validated(config: CampaignConfig): CampaignConfig { const { duplicateSeeds: _ignored, ...source } = config; const compiled = parseCampaign(source); compiled.duplicateSeeds += config.duplicateSeeds; return compiled; }
export function planCampaign(input: CampaignConfig) {
  const config = validated(input), set = generateCandidateSet(config), cost = confirmationCost(config.oracle);
  assert(set.candidates.reduce((n, candidate) => n + Buffer.byteLength(JSON.stringify(candidate)), 0) <= config.search.maxQueueBytes, 'candidate queue exceeds configured bytes');
  const hypothesisCount = set.candidates.reduce((n, candidate) => n + candidate.contractIds.length, 0);
  return { version: 2, networkCalls: 0, cases: config.seeds.length, questions: config.seeds.reduce((n, seed) => n + Object.keys(seed.request.questions).length, 0), contracts: config.contracts.length, candidates: set.candidates.length, invalid: set.invalid, noops: set.noops, limited: set.limited,
    adaptive: config.search.strategy !== 'enumerator', strategy: config.search.strategy, confirmationCallsPerCandidate: cost,
    maximumLogicalCalls: config.budget.logicalRequests, maximumHttpAttempts: config.budget.httpAttempts,
    providerRetryWorstCase: config.budget.logicalRequests * 5, attemptsMayExhaustFirst: config.budget.httpAttempts < config.budget.logicalRequests * 5,
    phaseBudgets: config.budget, potentialHypotheses: hypothesisCount, fixedFamilySize: config.oracle.profile === 'fixed-stat-v1' ? config.oracle.originalSlots + config.oracle.shrinkSlots : null,
    duplicateSeeds: config.duplicateSeeds, replayable: config.storage.mode === 'full', candidatesList: set.candidates };
}
export function campaignExitCode(report: CampaignReport, requireConfirmationComplete = false): number {
  if (report.status === 'incomplete') return 2;
  if (report.findings.length > 0) return 1;
  if (report.observedModels.length > 1 || report.summary.requiredUnevaluated > 0 || report.summary.evaluated === 0 || (requireConfirmationComplete && report.summary.pending > 0)) return 3;
  return 0;
}

/** Raw-free persistent form used by hash-only and redacted reports/journals. */
export function campaignSummary(report: CampaignReport): unknown {
  return { ...report, replayable: false, results: report.results.map(result => ({ candidateId: result.candidateId, depth: result.depth, observations: result.observationIds.length,
    relations: result.relations.map(relation => ({ contractHash: contentHash(relation.contractId), status: relation.confirmation?.verdict ?? relation.discovery.status, reason: relation.confirmation?.reason, pending: relation.pending })) })),
    findings: report.findings.map(finding => ({ id: finding.id, fingerprint: finding.fingerprint, evidenceLevel: finding.confirmation.evidenceLevel, profile: finding.confirmation.profileVersion, observations: finding.confirmation.confirmationSamples, replayable: false })) };
}

export async function campaign(input: CampaignConfig, provider: DecisionProvider, options: CampaignOptions = {}): Promise<CampaignReport> {
  return executeCampaign(input, provider, options);
}

export async function resumeCampaign(checkpointPath: string, provider: DecisionProvider, options: CampaignOptions = {}): Promise<CampaignReport> {
  const preliminary = await recoverCampaign(checkpointPath);
  const lock = await writerLock(preliminary.config.storage.directory);
  try {
    const recovered = await recoverCampaign(checkpointPath);
    return await executeCampaign(recovered.config, provider, { requireConfirmationComplete: true, ...options, persist: true }, recovered);
  } finally { await lock.release(); }
}

async function executeCampaign(input: CampaignConfig, provider: DecisionProvider, options: CampaignOptions, recovered?: RecoveryState): Promise<CampaignReport> {
  const config = validated(input), planned = planCampaign(config), candidates = planned.candidatesList;
  const newCohort = recovered !== undefined && recovered.observedModels.length > 1;
  if (newCohort) recovered = { ...recovered!, observedModels: [], results: [], findings: [], unresolved: 0, scheduler: new BatchScheduler(candidates, config.search).snapshot() };
  assertNoSecrets(JSON.stringify(config), options.secrets);
  // A claimed fixed-sample result is not available when transport/cache freshness is unknown.
  if (config.oracle.profile === 'fixed-stat-v1') assert(provider.capabilities?.cacheMetadata, 'fixed-stat-v1 requires an adapter with explicit cache metadata');
  const id = randomUUID(), ledger = new BudgetLedger(config.budget, recovered?.budget), slots = new HypothesisSlots(config.oracle, recovered?.slots);
  const scheduler = new BatchScheduler(candidates, config.search, recovered?.scheduler), results: CandidateResult[] = structuredClone(recovered?.results ?? []), findings: Finding[] = structuredClone(recovered?.findings ?? []);
  const configHash = contentHash(config), persist = options.persist !== false;
  const quota = new StorageQuota(config.storage.maxRunBytes);
  let directory: string | undefined, journal: ExecutionJournal | undefined;
  let release: (() => Promise<void>) | undefined;
  // Capability errors must precede creating a writer lock or any artifacts.
  new EvaluationBroker(provider, ledger, { strict: true });
  if (persist) {
    await privateDir(config.storage.directory); if (!recovered) { const lock = await writerLock(config.storage.directory); release = () => lock.release(); }
    try { await initializeCorpus(join(config.storage.directory, 'corpus'), config.storage.maxCorpusBytes); directory = await privateDir(join(config.storage.directory, 'runs', id)); journal = await ExecutionJournal.create(join(directory, 'events.jsonl'), { maxBytes: config.storage.maxRunBytes, secrets: options.secrets, consumeBytes: bytes => quota.consume(bytes) }); }
    catch (error) { await release?.(); throw error; }
  }
  const journalSink = journal && { append: (type: string, data: unknown) => journal!.append(type, config.storage.mode === 'full' ? data : { hash: contentHash(data), persistenceMode: config.storage.mode }) };
  const controller = new AbortController(), signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const broker = new EvaluationBroker(provider, ledger, { signal, strict: true, providerName: config.provider, secrets: options.secrets, journal: journalSink, priorModels: recovered?.observedModels, priorUsage: recovered?.usage });
  const report: CampaignReport = { version: 2, kind: 'campaign', id, timestamp: new Date().toISOString(), toolVersion: TOOL_VERSION, configHash, componentVersions: COMPONENT_VERSIONS,
    provider: config.provider, mode: provider.mode ?? 'custom', requestedModels: [...new Set(config.seeds.map(seed => seed.request.model))], observedModels: [], status: 'complete', stopReason: 'exhausted', exitCode: 3,
    seed: config.search.seed, inputHashes: config.seeds.map(seed => wireHash(JSON.stringify(seed.request))), contractHashes: config.contracts.map(contract => contractHash([contract])), targetHashes: config.seeds.map(seed => targetHash(seed.request, config.policy, config.provider)), cohort: 'unobserved', estimatedCost: null,
    budget: ledger.snapshot(), slots: slots.snapshot(), summary: { cases: planned.cases, questions: planned.questions, contracts: planned.contracts, candidates: candidates.length, evaluated: 0, pending: 0, invalid: planned.invalid, noops: planned.noops, limited: planned.limited, duplicateSeeds: config.duplicateSeeds, fail: 0, inconclusive: 0, requiredUnevaluated: 0 },
    results, findings, coverageProxy: { name: 'typed decisions', version: 'typed-v1', observed: 0, stable: 0 }, usage: broker.usage, persistenceMode: persist ? config.storage.mode : 'memory', replayable: config.storage.mode === 'full',
    warnings: ['Coverage is an external behavioral proxy, not model-internal coverage.', 'PASS means no detected violation in executed observations, not factual correctness.', ...(config.search.strategy === 'feedback' ? ['Feedback search passed the v4 offline benchmark criteria; efficiency on this target is unverified.'] : []), ...(config.storage.mode !== 'full' ? ['Payloads and fresh confirmation evidence are unavailable for replay/resume in this persistence mode.'] : [])], ...(directory ? { directory } : {}) };
  try {
    await journalSink?.append('campaign-start', { id, timestamp: report.timestamp, config, configHash, components: COMPONENT_VERSIONS, lineageBudgetId: ledger.lineageBudgetId, ...(recovered ? { inherited: recovered } : {}) });
    const checkpoint = (): CampaignCheckpoint => ({ version: 2, kind: 'checkpoint', runId: id, config, configHash, componentVersions: COMPONENT_VERSIONS, budget: ledger.snapshot(), slots: slots.snapshot(), scheduler: scheduler.snapshot(), results, findings, observedModels: broker.observedModels, journalHead: journal!.headHash, journalFile: join(directory!, 'events.jsonl'), timestamp: new Date().toISOString() });
    if (journal && directory && config.storage.mode === 'full') await quota.write(join(directory, 'checkpoint.json'), JSON.stringify(checkpoint()), { secrets: options.secrets, replace: true });
    if (recovered) {
      const parent = await ExecutionJournal.resume(recovered.parentJournal, { maxBytes: config.storage.maxRunBytes, secrets: options.secrets });
      try {
        assert(parent.headHash === recovered.parentHead, 'parent journal changed during recovery');
        await parent.append('resume-child', { runId: id, checkpoint: join(directory!, 'checkpoint.json'), lineageBudgetId: ledger.lineageBudgetId });
      } finally { await parent.close(); }
      report.warnings.push(`Resumed from ${recovered.parentRunId}; ${recovered.unresolved} interrupted candidates retained as pending without automatic redispatch.`);
      if (newCohort) report.warnings.push('The mixed model cohort was closed. This child takes fresh baselines and confirmations; prior costs and statistical slots remain consumed.');
    }
    while (!scheduler.exhausted && !scheduler.stagnant) {
      signal.throwIfAborted();
      if (!ledger.canReserve('discovery', 2)) { report.stopReason = ledger.deadlineReached ? 'deadline' : 'budget_exhausted'; break; }
      const batch = scheduler.nextBatch(Math.min(config.search.batchSize, Math.floor(ledger.remaining('discovery') / 2)));
      if (!batch.length) { report.stopReason = 'exhausted'; break; }
      await journalSink?.append('batch-planned', { batch: scheduler.snapshot().batch, candidateIds: batch.map(candidate => candidate.id) });
      const observations = new Map<string, { a: Observation; b: Observation }>();
      let next = 0, firstError: unknown;
      const workers = Array.from({ length: Math.min(config.search.concurrency, batch.length) }, async () => {
        while (!signal.aborted) {
          const candidate = batch[next++]; if (!candidate) return;
          try {
            const a = await broker.evaluate(candidate.basePayload, 'discovery', id + ':' + candidate.id + ':base');
            const b = await broker.evaluate(candidate.mutantPayload, 'discovery', id + ':' + candidate.id + ':mutant');
            observations.set(candidate.id, { a, b });
          } catch (error) { if (!firstError) firstError = error; controller.abort(); return; }
        }
      });
      await Promise.allSettled(workers);
      const commits: { candidateId: string; feedback: Feedback; confirmed: boolean }[] = [];
      for (const candidate of batch) {
        const pair = observations.get(candidate.id); if (!pair) continue;
        const contracts = config.contracts.filter(contract => candidate.contractIds.includes(contract.id));
        const relations = contracts.map(contract => ({ contractId: contract.id, discovery: evaluateRelation(candidate, contract, pair.a.response, pair.b.response, config.policy), pending: false } as CandidateResult['relations'][number]));
        const result: CandidateResult = { candidateId: candidate.id, seedId: candidate.seedId, depth: candidate.recipe.length, relations, observationIds: [pair.a.id, pair.b.id] };
        for (const [index, relation] of relations.entries()) {
          if (relation.discovery.status !== 'violates' || !relation.discovery.signature) continue;
          if (firstError || broker.modelChanged || signal.aborted) { relation.pending = true; continue; }
          const contract = contracts[index]!;
          const confirmation = await confirmCandidate(candidate, contract, broker, config.oracle, { signature: relation.discovery.signature, seed: config.search.seed + index, ledger, slots, policy: config.policy, discoverySamples: 2, journal: config.storage.mode === 'full' ? journal : undefined });
          relation.confirmation = confirmation;
          relation.pending = ['CONFIRMATION_BUDGET_UNAVAILABLE', 'SLOTS_EXHAUSTED'].includes(confirmation.reason);
          if (confirmation.reason.startsWith('INCOMPLETE_')) { firstError = new FuzzError('CAMPAIGN_INTERRUPTED', confirmation.reason); controller.abort(); }
          if (confirmation.verdict === 'FAIL') findings.push(createFinding(candidate, contract, config.oracle, confirmation, { provider: config.provider, policy: config.policy, reducers: config.reducers }));
        }
        const feedback = extractFeedback(candidate, contracts, pair.a.response, pair.b.response, relations.map(r => r.discovery), config.policy); result.feedback = feedback;
        results.push(result); commits.push({ candidateId: candidate.id, feedback, confirmed: relations.some(r => r.confirmation?.verdict === 'FAIL') });
      }
      if (commits.length) scheduler.commit(commits);
      await journalSink?.append('batch-committed', { results: commits.length ? results.slice(-commits.length) : [], scheduler: scheduler.snapshot(), findings, budget: ledger.snapshot(), slots: slots.snapshot(), observedModels: broker.observedModels });
      if (journal && directory && config.storage.mode === 'full') {
        const saved = checkpoint();
        await quota.write(join(directory, 'checkpoint.json'), JSON.stringify(saved), { secrets: options.secrets, replace: true });
        await options.onCheckpoint?.(structuredClone(saved));
      }
      if (firstError) throw firstError;
      if (broker.modelChanged) { report.stopReason = 'model_changed'; break; }
    }
    if (scheduler.stagnant) report.stopReason = 'stagnation';
  } catch (error) {
    report.status = 'incomplete'; report.stopReason = options.signal?.aborted ? 'cancelled' : 'runtime_error';
    const allowed = new Set(['BUDGET', 'DEADLINE', 'PROVIDER_ABORTED', 'PROVIDER_TIMEOUT', 'PROVIDER_HTTP', 'PROVIDER_RESPONSE', 'STORAGE_LIMIT', 'CAMPAIGN_INTERRUPTED']);
    report.errorCode = error instanceof FuzzError && allowed.has(error.code) ? error.code : 'CAMPAIGN_INTERRUPTED';
  } finally {
    controller.abort(); report.budget = ledger.snapshot(); report.slots = slots.snapshot(); report.observedModels = [...broker.observedModels];
    report.cohort = report.observedModels.length > 1 ? 'mixed-model' : report.observedModels.length === 1 ? 'single-model' : 'unobserved';
    if (broker.modelChanged) { findings.length = 0; for (const result of results) for (const relation of result.relations) if (relation.confirmation) { relation.confirmation.verdict = 'INCONCLUSIVE'; relation.confirmation.reason = 'COHORT_CHANGED'; } }
    report.summary.evaluated = results.length; report.summary.fail = findings.length;
    report.summary.pending = results.reduce((n, result) => n + result.relations.filter(r => r.pending).length, 0);
    report.summary.inconclusive = results.reduce((n, result) => n + result.relations.filter(r => r.discovery.status === 'unknown' || r.confirmation?.verdict === 'INCONCLUSIVE').length, 0);
    report.summary.requiredUnevaluated = config.contracts.filter(contract => contract.required && !results.some(result => result.relations.some(relation => relation.contractId === contract.id && relation.discovery.status !== 'unknown' && (!relation.confirmation || relation.confirmation.verdict !== 'INCONCLUSIVE')))).length;
    report.coverageProxy.observed = scheduler.observedSignatures; report.coverageProxy.stable = scheduler.stableCorpus.length;
    report.exitCode = campaignExitCode(report, options.requireConfirmationComplete);
    try {
      if (directory) {
        const persisted = config.storage.mode === 'full' ? report : config.storage.mode === 'redacted' ? { ...(campaignSummary(report) as Record<string, unknown>), redactedCandidates: candidates.filter(c => results.some(r => r.candidateId === c.id)).map(c => redactCandidate(c, config.storage.redactPaths)) } : campaignSummary(report);
        // A complete report/terminal event may only refer to already durable
        // evidence. A quota or renderer failure leaves a resumable journal,
        // never a completed report pointing at missing finding files.
        const rendered = renderReportText(persisted);
        const json = JSON.stringify(persisted, null, 2);
        const findingTexts = config.storage.mode === 'full' ? findings.map(finding => ({ id: finding.id, text: JSON.stringify(finding, null, 2) })) : [];
        const terminal = { report: config.storage.mode === 'full' ? report : campaignSummary(report) };
        const terminalData = config.storage.mode === 'full' ? terminal : { hash: contentHash(terminal), persistenceMode: config.storage.mode };
        const terminalBytes = journal ? await journal.nextAppendBytes('campaign-finished', terminalData) : 0;
        // Reserve the entire publication envelope before any complete artifact
        // becomes visible; the final terminal frame must fit as well.
        quota.assertAvailable(Buffer.byteLength(rendered) + Buffer.byteLength(json) + findingTexts.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0) + terminalBytes);
        for (const item of findingTexts) await quota.write(join(directory, 'findings', item.id + '.json'), item.text, { secrets: options.secrets });
        // The durable terminal frame precedes every visible complete report.
        // If interrupted here, recovery may finish publication in a child.
        if (journal) await journalSink!.append('campaign-finished', terminal);
        await quota.write(join(directory, 'report.txt'), rendered, { secrets: options.secrets, replace: true });
        await quota.write(join(directory, 'report.json'), json, { secrets: options.secrets, replace: true });
      }
    } catch (error) {
      report.status = 'incomplete'; report.stopReason = 'persistence_error'; report.errorCode = error instanceof FuzzError && error.code === 'STORAGE_LIMIT' ? 'STORAGE_LIMIT' : 'PERSISTENCE_ERROR'; report.exitCode = 2;
      if (directory) for (const file of ['report.json', 'report.txt']) await rm(join(directory, file), { force: true });
    }
    try { await journal?.close(); } catch { report.status = 'incomplete'; report.exitCode = 2; }
    await release?.();
  }
  return report;
}
