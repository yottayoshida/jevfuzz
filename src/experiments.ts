import { readJson, boundedJson, parseBoundedJson } from './storage.ts';
import { validateRequest } from './config.ts';
import { parseContract, parsePolicy } from './campaign-config.ts';
import { evaluateRelation } from './contracts/index.ts';
import { BudgetLedger, validateBudget } from './engine/budget.ts';
import { EvaluationBroker } from './engine/broker.ts';
import type { ExecutionJournal } from './engine/journal.ts';
import { confirmCandidate, confirmationCost, HypothesisSlots, validateOracle } from './oracles/index.ts';
import { contentHash, contractHash, wireHash } from './identity.ts';
import { buildCandidate } from './mutators/index.ts';
import { assert, FuzzError, integer, record } from './util.ts';
import type { DecisionProvider, JevRequest } from './types.ts';
import type { BudgetConfig, Candidate, CampaignSeed, Contract, OracleConfig, Policy } from './campaign-types.ts';

export type ExperimentProvider = 'typesafe' | 'cloudflare' | 'custom';
export interface ExperimentTarget {
  id: string;
  provider: ExperimentProvider;
  model?: string;
  questions?: JevRequest['questions'];
  policy?: Policy;
  /** Mutant question ID to the original question ID. */
  questionMapping?: Record<string, string>;
  /** Original question ID to mutant-label/original-label map. */
  labelMappings?: Record<string, Record<string, string>>;
}
export interface ExperimentSource { provider: ExperimentProvider; policy?: Policy }
export interface ExperimentCase { id: string; candidate: Candidate; contract: Contract; source?: ExperimentSource }
export interface ExperimentSpec {
  version: 2;
  kind: 'experiment';
  name: string;
  cases: ExperimentCase[];
  old: ExperimentTarget;
  new: ExperimentTarget;
  oracle: OracleConfig;
  budget: BudgetConfig;
}
export type TargetStatus = 'holds' | 'violates' | 'unknown';
export type ExperimentStatus = 'introduced' | 'resolved' | 'persists' | 'no_detected_regression' | 'inconclusive';
export interface TargetResult {
  target: string;
  provider: ExperimentProvider;
  targetHash: string;
  status: TargetStatus;
  discovery?: ReturnType<typeof evaluateRelation>;
  confirmation?: Awaited<ReturnType<typeof confirmCandidate>>;
  observations: number;
  observedModels: string[];
}
export interface ExperimentCaseResult { id: string; status: ExperimentStatus; old: TargetResult; new: TargetResult }
export interface ExperimentReport {
  version: 2;
  kind: 'experiment-report';
  name: string;
  cases: ExperimentCaseResult[];
  counts: Record<ExperimentStatus, number>;
  status: 'complete' | 'incomplete';
  exitCode: 0 | 1 | 2 | 3;
  budget: ReturnType<BudgetLedger['snapshot']>;
  errorCode?: string;
}
export type ProviderFactory = (target: ExperimentTarget) => DecisionProvider;
export interface CompareExperimentOptions { signal?: AbortSignal; seed?: number; journal?: ExecutionJournal; secrets?: string[] }

const topFields = ['version', 'kind', 'name', 'cases', 'old', 'new', 'oracle', 'budget'];
const targetFields = ['id', 'provider', 'model', 'questions', 'policy', 'questionMapping', 'labelMappings'];
const candidateFields = ['id', 'seedId', 'parentId', 'basePayload', 'mutantPayload', 'baseWireHash', 'mutantWireHash', 'contentHash', 'contractHash', 'targetHash', 'recipe', 'contractIds', 'contracts', 'questionMap', 'labelMaps', 'admissibility', 'provenanceHash', 'assumptions'];
const oracleFields = ['profile', 'pairs', 'minimumSupport', 'maxControlViolationRate', 'minimumEffect', 'alpha', 'originalSlots', 'shrinkSlots'];
const budgetFields = ['logicalRequests', 'httpAttempts', 'wallTimeSeconds', 'discoveryRequests', 'confirmationRequests', 'shrinkRequests', 'finalConfirmationRequests'];

function fields(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  assert(Object.keys(value).every(key => allowed.includes(key)), `unsupported field in ${where}`);
}
function text(value: unknown, where: string): string {
  assert(typeof value === 'string' && value.length > 0 && value.length <= 512, `${where} must be non-empty text`);
  return value;
}
function map(value: unknown, where: string): Record<string, string> {
  assert(record(value) && Object.entries(value).every(([key, item]) => key.length > 0 && typeof item === 'string' && item.length > 0), `${where} must be string map`);
  return structuredClone(value) as Record<string, string>;
}
function target(raw: unknown, seeds: readonly CampaignSeed[]): ExperimentTarget {
  assert(record(raw), 'experiment target must be object'); fields(raw, targetFields, 'experiment target');
  assert(['typesafe', 'cloudflare', 'custom'].includes(String(raw.provider)), 'experiment target provider invalid');
  const provider = raw.provider as ExperimentProvider;
  const result: ExperimentTarget = { id: text(raw.id, 'target id'), provider };
  if (raw.model !== undefined) result.model = text(raw.model, 'target model');
  // Cloudflare's adapter has a fixed model and cannot provide an old pinned target.
  assert(!(provider === 'cloudflare' && result.model !== undefined), 'cloudflare experiment target cannot pin a model');
  if (raw.questions !== undefined) {
    assert(record(raw.questions), 'target questions must be object');
    const request = validateRequest({ state: {}, model: result.model ?? seeds[0]?.request.model ?? 'target', questions: raw.questions });
    result.questions = request.questions;
  }
  if (raw.questionMapping !== undefined) result.questionMapping = map(raw.questionMapping, 'questionMapping');
  if (raw.labelMappings !== undefined) {
    assert(record(raw.labelMappings), 'labelMappings must be object');
    result.labelMappings = Object.fromEntries(Object.entries(raw.labelMappings).map(([id, labels]) => [id, map(labels, 'label mapping')]));
  }
  result.policy = parsePolicy(raw.policy, seeds);
  return result;
}
function oracle(raw: unknown): OracleConfig {
  assert(record(raw), 'experiment oracle must be object'); fields(raw, oracleFields, 'experiment oracle');
  const value: OracleConfig = {
    profile: raw.profile === 'fixed-stat-v1' ? 'fixed-stat-v1' : 'paired-v1',
    pairs: integer(raw.pairs, 'oracle pairs', 1, 1023),
    minimumSupport: Number(raw.minimumSupport), maxControlViolationRate: Number(raw.maxControlViolationRate),
    minimumEffect: Number(raw.minimumEffect), alpha: Number(raw.alpha),
    originalSlots: integer(raw.originalSlots, 'originalSlots', 0), shrinkSlots: integer(raw.shrinkSlots, 'shrinkSlots', 0),
  };
  assert(['paired-v1', 'fixed-stat-v1'].includes(String(raw.profile)) && [value.minimumSupport, value.maxControlViolationRate, value.minimumEffect, value.alpha].every(Number.isFinite) && value.minimumSupport > 0 && value.minimumSupport <= 1 && value.maxControlViolationRate >= 0 && value.maxControlViolationRate <= 1 && value.minimumEffect >= 0 && value.minimumEffect <= 1 && value.alpha > 0 && value.alpha <= 1, 'experiment oracle invalid');
  return value;
}
function budget(raw: unknown): BudgetConfig {
  assert(record(raw), 'experiment budget must be object'); fields(raw, budgetFields, 'experiment budget');
  const value: BudgetConfig = {
    logicalRequests: integer(raw.logicalRequests, 'logicalRequests'), httpAttempts: integer(raw.httpAttempts, 'httpAttempts', 0), wallTimeSeconds: integer(raw.wallTimeSeconds, 'wallTimeSeconds'),
    discoveryRequests: integer(raw.discoveryRequests, 'discoveryRequests', 0), confirmationRequests: integer(raw.confirmationRequests, 'confirmationRequests', 0), shrinkRequests: integer(raw.shrinkRequests, 'shrinkRequests', 0), finalConfirmationRequests: integer(raw.finalConfirmationRequests, 'finalConfirmationRequests', 0),
  };
  validateBudget(value); return value;
}
function candidate(raw: unknown, id: string): Candidate {
  assert(record(raw), 'experiment candidate must be object'); fields(raw, candidateFields, 'experiment candidate');
  assert(typeof raw.basePayload === 'string' && typeof raw.mutantPayload === 'string', 'candidate payloads missing');
  const base = validateRequest(parseBoundedJson(raw.basePayload)); const mutant = validateRequest(parseBoundedJson(raw.mutantPayload));
  boundedJson(base); boundedJson(mutant);
  assert(raw.baseWireHash === wireHash(raw.basePayload) && raw.mutantWireHash === wireHash(raw.mutantPayload), 'candidate wire hash mismatch');
  assert(record(raw.questionMap) && record(raw.labelMaps) && Array.isArray(raw.contracts) && Array.isArray(raw.recipe) && Array.isArray(raw.contractIds) && Array.isArray(raw.assumptions), 'candidate metadata invalid');
  const value = structuredClone(raw) as unknown as Candidate;
  return value;
}
function source(raw: unknown, seed: CampaignSeed): ExperimentSource {
  if (raw === undefined) return { provider: 'custom' };
  assert(record(raw), 'experiment source must be object'); fields(raw, ['provider', 'policy'], 'experiment source');
  assert(['typesafe', 'cloudflare', 'custom'].includes(String(raw.provider)), 'experiment source provider invalid');
  return { provider: raw.provider as ExperimentProvider, ...(parsePolicy(raw.policy, [seed]) ? { policy: parsePolicy(raw.policy, [seed]) } : {}) };
}

/** Parse a self-contained v2 experiment. It deliberately does not accept saved responses. */
export function parseExperiment(raw: unknown): ExperimentSpec {
  boundedJson(raw); assert(record(raw), 'experiment must be object'); fields(raw, topFields, 'experiment');
  assert(raw.version === 2 && raw.kind === 'experiment' && Array.isArray(raw.cases) && raw.cases.length > 0, 'experiment header invalid');
  const preliminary = raw.cases.map((item, index) => {
    assert(record(item), 'experiment case must be object'); fields(item, ['id', 'candidate', 'contract', 'source'], 'experiment case');
    const c = candidate(item.candidate, `case-${index}`);
    return { id: text(item.id, 'experiment case id'), candidate: c, base: validateRequest(parseBoundedJson(c.basePayload)) };
  });
  assert(new Set(preliminary.map(item => item.id)).size === preliminary.length, 'duplicate experiment case id');
  const seeds = preliminary.map(item => ({ id: item.id, request: item.base, mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [], prosePaths: [] } }));
  const rawCases = raw.cases as unknown[];
  const cases = preliminary.map((item, index) => {
    const rawCase = rawCases[index] as Record<string, unknown>, input = source(rawCase.source, seeds[index]!);
    replayCandidate(item.candidate, input);
    return { id: item.id, candidate: item.candidate, contract: parseContract(rawCase.contract, [seeds[index]!] ), source: input };
  });
  const old = target(raw.old, seeds), newer = target(raw.new, seeds);
  assert(old.id !== newer.id, 'experiment targets must have distinct ids');
  const spec: ExperimentSpec = { version: 2, kind: 'experiment', name: text(raw.name, 'experiment name'), cases, old, new: newer, oracle: oracle(raw.oracle), budget: budget(raw.budget) };
  preflight(spec); return spec;
}
export async function loadExperiment(filename: string): Promise<ExperimentSpec> { return parseExperiment(await readJson(filename, 1_000_000)); }

function preflight(spec: ExperimentSpec): void {
  validateOracle(spec.oracle);
  const discovery = spec.cases.length * 4;
  const confirmation = spec.cases.length * 2 * confirmationCost(spec.oracle);
  assert(spec.budget.discoveryRequests >= discovery, 'experiment budget cannot fund both target discovery cohorts');
  assert(spec.budget.confirmationRequests >= confirmation, 'experiment budget cannot fund both target confirmations');
  assert(spec.budget.logicalRequests >= discovery + confirmation, 'experiment logical budget cannot fund confirmations');
  if (spec.oracle.profile === 'fixed-stat-v1') {
    assert(spec.oracle.originalSlots >= spec.cases.length * 2, 'experiment fixed-stat slots cannot cover both targets');
    assert(spec.cases.every(experimentCase => experimentCase.contract.relation !== 'directional'), 'fixed-stat-v1 excludes directional relations');
  }
}
function sameMap(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left), rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every(key => left[key] === right[key]);
}
function sameLabelMaps(left: Candidate['labelMaps'], right: Candidate['labelMaps']): boolean {
  return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => right[key] !== undefined && sameMap(left[key]!, right[key]!));
}
/** Recreate the saved witness before a target can be constructed or evaluated. */
function replayCandidate(candidate: Candidate, source: ExperimentSource = { provider: 'custom' }): Candidate {
  assert(candidate.recipe.length > 0, 'v2 experiment candidate requires a concrete witness');
  const base = validateRequest(parseBoundedJson(candidate.basePayload));
  validateRequest(parseBoundedJson(candidate.mutantPayload));
  const rebuilt = buildCandidate({ id: candidate.seedId, request: base, mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [], prosePaths: [] } }, candidate.recipe, candidate.contracts, source.policy, source.provider);
  assert(rebuilt.basePayload === candidate.basePayload && rebuilt.mutantPayload === candidate.mutantPayload, 'candidate payload does not match replayed witness');
  assert(rebuilt.baseWireHash === candidate.baseWireHash && rebuilt.mutantWireHash === candidate.mutantWireHash && rebuilt.contentHash === candidate.contentHash, 'candidate hashes do not match replayed witness');
  assert(rebuilt.contractHash === candidate.contractHash && contractHash(candidate.contracts) === candidate.contractHash && rebuilt.contractIds.every((id, index) => id === candidate.contractIds[index]) && rebuilt.contractIds.length === candidate.contractIds.length, 'candidate contracts do not match replayed witness');
  assert(sameMap(rebuilt.questionMap, candidate.questionMap) && sameLabelMaps(rebuilt.labelMaps, candidate.labelMaps), 'candidate mappings do not match replayed witness');
  assert(rebuilt.targetHash === candidate.targetHash && rebuilt.provenanceHash === candidate.provenanceHash && rebuilt.id === candidate.id && rebuilt.admissibility === candidate.admissibility && JSON.stringify(rebuilt.assumptions) === JSON.stringify(candidate.assumptions), 'candidate source identity does not match replayed witness');
  return rebuilt;
}
function targetCandidate(candidate: Candidate, target: ExperimentTarget): Candidate {
  const base = validateRequest(parseBoundedJson(candidate.basePayload));
  const mutant = validateRequest(parseBoundedJson(candidate.mutantPayload));
  if (target.model !== undefined) { base.model = target.model; mutant.model = target.model; }
  if (target.questions !== undefined) {
    const baseIds = Object.keys(base.questions);
    assert(baseIds.length === Object.keys(target.questions).length && baseIds.every(id => Object.hasOwn(target.questions!, id)), 'target question override is incompatible with base dataset');
    base.questions = structuredClone(target.questions);
    // Mutant structure is rebuilt by replay below; replacing it here would erase
    // concrete criteria/order witnesses.
  }
  const questionMap = target.questionMapping ?? candidate.questionMap;
  const labelMaps = target.labelMappings ?? candidate.labelMaps;
  const mutantIds = Object.keys(mutant.questions), baseIds = Object.keys(base.questions);
  assert(mutantIds.length === Object.keys(questionMap).length && mutantIds.every(id => Object.hasOwn(questionMap, id)) && Object.values(questionMap).every(id => baseIds.includes(id)), 'target question mapping is incomplete or incompatible');
  assert(new Set(Object.values(questionMap)).size === baseIds.length, 'target question mapping must be bijective');
  for (const [question, labels] of Object.entries(labelMaps)) {
    assert(baseIds.includes(question), 'target label mapping is incompatible');
    const questionDefinition = base.questions[question];
    assert(questionDefinition?.type === 'choice', 'target label mapping requires Choice question');
    const expected = Object.keys(questionDefinition.criteria);
    assert(Object.keys(labels).length === expected.length && new Set(Object.values(labels)).size === expected.length && Object.values(labels).every(label => expected.includes(label)), 'target label mapping is incomplete');
  }
  const rebuilt = buildCandidate({ id: candidate.seedId, request: base, mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [], prosePaths: [] } }, candidate.recipe, candidate.contracts, target.policy, target.provider);
  assert(sameMap(rebuilt.questionMap, questionMap) && sameLabelMaps(rebuilt.labelMaps, labelMaps), 'target mappings do not match replayed witness');
  return rebuilt;
}
function embeddedContract(experimentCase: ExperimentCase): void {
  assert(experimentCase.candidate.contracts.length === 1 && contractHash(experimentCase.candidate.contracts) === contractHash([experimentCase.contract]), 'experiment case contract must equal the candidate-bound contract');
}
function safeErrorCode(error: unknown): string {
  const safe = new Set(['BUDGET', 'DEADLINE', 'PROVIDER_ABORTED', 'PROVIDER_RESPONSE', 'PROVIDER_HTTP', 'PROVIDER_TIMEOUT', 'PROVIDER_NETWORK', 'STORAGE_LIMIT']);
  if (error instanceof FuzzError && safe.has(error.code)) return `INCOMPLETE_${error.code}`;
  return 'INCOMPLETE_RUNTIME';
}
function status(discovery: ReturnType<typeof evaluateRelation>, confirmation: Awaited<ReturnType<typeof confirmCandidate>>, drift: boolean): TargetStatus {
  if (drift || discovery.status === 'unknown' || confirmation.verdict === 'INCONCLUSIVE') return 'unknown';
  return confirmation.verdict === 'FAIL' ? 'violates' : 'holds';
}
function classify(old: TargetStatus, newer: TargetStatus): ExperimentStatus {
  if (old === 'unknown' || newer === 'unknown') return 'inconclusive';
  if (old === 'holds' && newer === 'violates') return 'introduced';
  if (old === 'violates' && newer === 'holds') return 'resolved';
  if (old === 'violates' && newer === 'violates') return 'persists';
  return 'no_detected_regression';
}

export async function compareExperiment(spec: ExperimentSpec, providerFactory: ProviderFactory, options: CompareExperimentOptions = {}): Promise<ExperimentReport> {
  preflight(spec);
  // Mapping and request compatibility are configuration errors. Validate every target before
  // constructing a provider so an invalid new target cannot spend calls on an old one.
  for (const experimentCase of spec.cases) {
    embeddedContract(experimentCase);
    replayCandidate(experimentCase.candidate, experimentCase.source);
    targetCandidate(experimentCase.candidate, spec.old);
    targetCandidate(experimentCase.candidate, spec.new);
  }
  const ledger = new BudgetLedger(spec.budget); const slots = new HypothesisSlots(spec.oracle);
  const results: ExperimentCaseResult[] = [];
  let incomplete: string | undefined;
  try {
    const targets = [spec.old, spec.new] as const;
    const brokers = new Map<string, EvaluationBroker>();
    for (const definition of targets) {
      const provider = providerFactory(definition);
      if (spec.oracle.profile === 'fixed-stat-v1') assert(provider.capabilities?.cacheMetadata, 'fixed-stat-v1 requires an adapter with explicit cache metadata');
      brokers.set(definition.id, new EvaluationBroker(provider, ledger, { strict: true, providerName: definition.id, signal: options.signal, journal: options.journal, secrets: options.secrets }));
    }
    for (const experimentCase of spec.cases) {
      const runTarget = async (definition: ExperimentTarget): Promise<TargetResult> => {
      const adjusted = targetCandidate(experimentCase.candidate, definition);
      const broker = brokers.get(definition.id)!;
      const a = await broker.evaluate(adjusted.basePayload, 'discovery', `${experimentCase.id}:${definition.id}:A`);
      const b = await broker.evaluate(adjusted.mutantPayload, 'discovery', `${experimentCase.id}:${definition.id}:B`);
      const discovery = evaluateRelation(adjusted, experimentCase.contract, a.response, b.response, definition.policy);
      if (discovery.status === 'unknown' || broker.modelChanged) return { target: definition.id, provider: definition.provider, targetHash: adjusted.targetHash, status: 'unknown', discovery, observations: broker.observations.length, observedModels: broker.observedModels };
      const confirmation = await confirmCandidate(adjusted, experimentCase.contract, broker, spec.oracle, { signature: discovery.signature ?? 'holds', seed: (options.seed ?? 42) + results.length, policy: definition.policy, ledger, slots, discoverySamples: 2, journal: options.journal });
      if (confirmation.reason.startsWith('INCOMPLETE_')) throw new FuzzError(confirmation.reason.slice('INCOMPLETE_'.length), 'experiment confirmation did not complete');
      return { target: definition.id, provider: definition.provider, targetHash: adjusted.targetHash, status: status(discovery, confirmation, broker.modelChanged), discovery, confirmation, observations: broker.observations.length, observedModels: broker.observedModels };
      };
      const old = await runTarget(spec.old), newer = await runTarget(spec.new);
      results.push({ id: experimentCase.id, old, new: newer, status: classify(old.status, newer.status) });
    }
    // A late provider cohort change invalidates every earlier comparison for that target.
    for (const result of results) for (const definition of targets) {
      const broker = brokers.get(definition.id)!;
      const targetResult = definition.id === spec.old.id ? result.old : result.new;
      targetResult.observations = broker.observations.length;
      targetResult.observedModels = broker.observedModels;
      if (broker.modelChanged) targetResult.status = 'unknown';
      result.status = classify(result.old.status, result.new.status);
    }
  } catch (error) {
    incomplete = safeErrorCode(error);
  }
  const counts: Record<ExperimentStatus, number> = { introduced: 0, resolved: 0, persists: 0, no_detected_regression: 0, inconclusive: 0 };
  for (const result of results) counts[result.status]++;
  const completionStatus = incomplete ? 'incomplete' : 'complete';
  const exitCode: 0 | 1 | 2 | 3 = incomplete ? 2 : counts.introduced || counts.persists ? 1 : counts.inconclusive ? 3 : 0;
  return { version: 2, kind: 'experiment-report', name: spec.name, cases: results, counts, status: completionStatus, exitCode, budget: ledger.snapshot(), ...(incomplete ? { errorCode: incomplete } : {}) };
}
