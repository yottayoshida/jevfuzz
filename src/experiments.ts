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
import { assert, atPath, FuzzError, integer, pathTokens, record } from './util.ts';
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
  /** Source base-question ID to this target's base-question ID. */
  sourceQuestionMapping?: Record<string, string>;
  /** Source base Choice label to this target's base Choice label. */
  sourceLabelMappings?: Record<string, Record<string, string>>;
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
const targetFields = ['id', 'provider', 'model', 'questions', 'policy', 'questionMapping', 'labelMappings', 'sourceQuestionMapping', 'sourceLabelMappings'];
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
  if (raw.sourceQuestionMapping !== undefined) result.sourceQuestionMapping = map(raw.sourceQuestionMapping, 'sourceQuestionMapping');
  if (raw.sourceLabelMappings !== undefined) {
    assert(record(raw.sourceLabelMappings), 'sourceLabelMappings must be object');
    result.sourceLabelMappings = Object.fromEntries(Object.entries(raw.sourceLabelMappings).map(([id, labels]) => [id, map(labels, 'source label mapping')]));
  }
  if (raw.policy !== undefined) result.policy = structuredClone(raw.policy) as Policy;
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
  // Parsing is also a library-grade preflight: target mappings and authored
  // policy must be valid for every effective target before any provider exists.
  for (const experimentCase of spec.cases) {
    embeddedContract(experimentCase);
    targetCandidate(experimentCase.candidate, experimentCase.contract, spec.old);
    targetCandidate(experimentCase.candidate, experimentCase.contract, spec.new);
  }
  preflight(spec); return spec;
}
export async function loadExperiment(filename: string): Promise<ExperimentSpec> { return parseExperiment(await readJson(filename, 1_000_000)); }

function preflight(spec: ExperimentSpec): void {
  assert(spec.old.id !== spec.new.id, 'experiment targets must have distinct ids');
  assert(spec.cases.length > 0 && new Set(spec.cases.map(item => item.id)).size === spec.cases.length, 'duplicate experiment case id');
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
const unsafe = (value: string) => ['__proto__', 'prototype', 'constructor'].includes(value);
function serial(tokens: readonly string[]): string { return `$${tokens.map(token => /^\d+$/.test(token) ? `[${token}]` : /^[A-Za-z_][A-Za-z0-9_-]*$/.test(token) ? `.${token}` : `[${JSON.stringify(token)}]`).join('')}`; }
function completeMap(source: readonly string[], target: readonly string[], supplied: Record<string, string> | undefined, where: string): Record<string, string> {
  const out = supplied ? structuredClone(supplied) : Object.fromEntries(source.map(id => [id, id]));
  assert(Object.keys(out).every(key => typeof key === 'string' && !unsafe(key)) && Object.values(out).every(value => typeof value === 'string' && !unsafe(value)) && target.every(value => typeof value === 'string' && !unsafe(value)), `${where} must be a safe string map`);
  assert(source.length === target.length && Object.keys(out).length === source.length && source.every(id => Object.hasOwn(out, id)), `${where} is incomplete`);
  assert(Object.values(out).every(id => target.includes(id) && !unsafe(id)) && new Set(Object.values(out)).size === source.length, `${where} must be a complete bijection`);
  return out;
}
function mappedPath(path: string, questions: Record<string, string>, labels: Record<string, Record<string, string>>): string {
  const tokens = pathTokens(path);
  if (tokens[0] === 'questions' && tokens[1]) {
    const source = tokens[1]!; assert(questions[source] !== undefined, 'recipe path question alias is incompatible'); tokens[1] = questions[source]!;
    if (tokens[2] === 'criteria' && tokens[3] && labels[source]) { const labelsForQuestion = labels[source]; assert(labelsForQuestion[tokens[3]!] !== undefined, 'recipe criteria label alias is incompatible'); tokens[3] = labelsForQuestion[tokens[3]!]!; }
  }
  return serial(tokens);
}
function currentQuestionPath(path: string, questionMap: Candidate['questionMap']): string {
  const tokens = pathTokens(path);
  if (tokens[0] === 'questions' && tokens[1]) {
    const current = Object.entries(questionMap).find(([, original]) => original === tokens[1])?.[0];
    assert(current !== undefined, 'recipe path question is missing from replay prefix');
    tokens[1] = current;
  }
  return serial(tokens);
}
function textTransform(source: string, witness: string, target: string): string {
  if (source === target) return witness;
  const transforms = [
    (value: string) => value.replace(/\r\n/g, '\n'),
    (value: string) => value.replace(/\r?\n/g, '\r\n'),
    (value: string) => `${value.replace(/(?:\r?\n)+$/, '')}\n`,
    (value: string) => value.trim(),
    (value: string) => value.replace(/ {2,}/g, ' '),
  ].filter(transform => transform(source) === witness).map(transform => transform(target));
  assert(transforms.length > 0 && new Set(transforms).size === 1 && transforms[0] !== target, 'text normalization target translation is ambiguous or a no-op');
  return transforms[0]!;
}
interface PreparedTarget { definition: ExperimentTarget; candidate: Candidate; contract: Contract; policy?: Policy }
function targetCandidate(candidate: Candidate, sourceContract: Contract, target: ExperimentTarget): PreparedTarget {
  const sourceBase = validateRequest(parseBoundedJson(candidate.basePayload));
  const validatedQuestions = target.questions === undefined ? undefined : validateRequest({ state: {}, model: target.model ?? sourceBase.model, questions: target.questions }).questions;
  const sourceIds = Object.keys(sourceBase.questions), targetIds = validatedQuestions ? Object.keys(validatedQuestions) : target.sourceQuestionMapping ? Object.values(target.sourceQuestionMapping) : sourceIds;
  const sourceQuestions = completeMap(sourceIds, targetIds, target.sourceQuestionMapping, 'source question mapping');
  const base = structuredClone(sourceBase);
  base.questions = validatedQuestions ? structuredClone(validatedQuestions) : Object.fromEntries(sourceIds.map(id => [sourceQuestions[id]!, structuredClone(sourceBase.questions[id]!)]));
  for (const source of sourceIds) assert(base.questions[sourceQuestions[source]!]!.type === sourceBase.questions[source]!.type, 'target question type is incompatible');
  const sourceLabels: Record<string, Record<string, string>> = Object.create(null);
  for (const source of sourceIds) {
    const before = sourceBase.questions[source]!;
    if (before.type === 'choice' && !target.questions && target.sourceLabelMappings?.[source]) {
      const labels = completeMap(Object.keys(before.criteria), Object.values(target.sourceLabelMappings[source]!), target.sourceLabelMappings[source], 'source label mapping');
      base.questions[sourceQuestions[source]!] = { ...before, criteria: Object.fromEntries(Object.keys(before.criteria).map(label => [labels[label]!, before.criteria[label]!])) };
    }
    const after = base.questions[sourceQuestions[source]!]!;
    if (before.type !== 'choice') { assert(target.sourceLabelMappings?.[source] === undefined, 'source label mapping requires Choice question'); continue; }
    assert(after.type === 'choice', 'target question type is incompatible');
    sourceLabels[source] = completeMap(Object.keys(before.criteria), Object.keys(after.criteria), target.sourceLabelMappings?.[source], 'source label mapping');
  }
  if (target.sourceLabelMappings) assert(Object.keys(target.sourceLabelMappings).every(id => sourceIds.includes(id)), 'source label mapping question is incompatible');
  if (target.model !== undefined) base.model = target.model;
  const parsedPolicy = parsePolicy(target.policy, [{ id: candidate.seedId, request: base, mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [], prosePaths: [] } }]);
  const contract: Contract = structuredClone(sourceContract);
  contract.question = sourceQuestions[sourceContract.question]!; assert(contract.question !== undefined, 'contract question is incompatible');
  if (contract.labelMapping) contract.labelMapping = Object.fromEntries(Object.entries(contract.labelMapping).map(([mutant, original]) => [mutant, sourceLabels[sourceContract.question]?.[original] ?? original]));
  const aliases = { ...sourceQuestions };
  const labelAliases: Record<string, Record<string, string>> = Object.fromEntries(Object.entries(sourceLabels).map(([question, labels]) => [question, { ...labels }]));
  const recipe: Candidate['recipe'] = [];
  for (const [index, original] of candidate.recipe.entries()) {
    const step = structuredClone(original);
    const current = (id: string) => { const value = aliases[id]; assert(value !== undefined && !unsafe(value), 'recipe question alias is incompatible'); return value; };
    const baseQuestion = (id: string) => sourceQuestions[id] ?? current(id);
    if (step.question) step.question = baseQuestion(step.question);
    if (step.path) step.path = mappedPath(step.path, sourceQuestions, labelAliases);
    if (step.reads) step.reads = step.reads.map(path => mappedPath(path, sourceQuestions, labelAliases));
    if (step.writes) step.writes = step.writes.map(path => mappedPath(path, sourceQuestions, labelAliases));
    if (step.orders) step.orders = step.orders.map(order => ({ ...order, path: mappedPath(order.path, sourceQuestions, labelAliases) }));
    if (step.operator === 'question_id_rename') {
      assert(step.renames, 'question rename missing'); const snapshot = { ...aliases }, next: Record<string, string> = Object.create(null);
      for (const [from, to] of Object.entries(step.renames)) { const mapped = snapshot[from]; assert(mapped !== undefined && !unsafe(to) && !Object.hasOwn(next, mapped), 'question rename is incompatible'); next[mapped] = to; }
      for (const from of Object.keys(step.renames)) delete aliases[from];
      for (const to of Object.values(step.renames)) aliases[to] = to;
      step.renames = next;
    } else if (step.operator === 'question_order') {
      assert(step.order?.every(item => typeof item === 'string'), 'question order missing'); step.order = (step.order as string[]).map(id => sourceQuestions[id] ?? current(id));
    } else if (step.operator === 'choice_criteria_order') {
      assert(original.question && step.order?.every(item => typeof item === 'string'), 'choice order missing'); step.order = (step.order as string[]).map(label => labelAliases[original.question!]?.[label] ?? label);
    } else if (step.operator === 'choice_label_rename') {
      assert(original.question && step.renames, 'choice label rename missing'); const labels = labelAliases[original.question!] ?? Object.create(null), snapshot = { ...labels };
      step.renames = Object.fromEntries(Object.entries(step.renames).map(([from, to]) => { const mapped = snapshot[from]; assert(mapped !== undefined, 'choice label alias is incompatible'); return [mapped, to]; }));
      for (const from of Object.keys(original.renames!)) delete labels[from];
      for (const to of Object.values(original.renames!)) labels[to] = to;
    } else if (step.operator === 'text_normalization') {
      assert(original.path && typeof original.text === 'string' && step.path, 'text witness missing');
      const sourcePrefixCandidate = index === 0 ? undefined : buildCandidate({ id: candidate.seedId, request: sourceBase, mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [], prosePaths: [] } }, candidate.recipe.slice(0, index), [sourceContract]);
      const targetPrefixCandidate = index === 0 ? undefined : buildCandidate({ id: candidate.seedId, request: base, mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [], prosePaths: [] } }, recipe, [contract], parsedPolicy, target.provider);
      const sourcePrefix = sourcePrefixCandidate ? validateRequest(parseBoundedJson(sourcePrefixCandidate.mutantPayload)) : sourceBase;
      const targetPrefix = targetPrefixCandidate ? validateRequest(parseBoundedJson(targetPrefixCandidate.mutantPayload)) : base;
      const sourceText = atPath(sourcePrefix, sourcePrefixCandidate ? currentQuestionPath(original.path, sourcePrefixCandidate.questionMap) : original.path);
      const targetText = atPath(targetPrefix, targetPrefixCandidate ? currentQuestionPath(step.path, targetPrefixCandidate.questionMap) : step.path);
      assert(typeof sourceText === 'string' && typeof targetText === 'string', 'text witness needs text');
      step.text = textTransform(sourceText, original.text, targetText);
    }
    recipe.push(step);
  }
  // Target policy is authored in target coordinates.  It is deliberately never
  // translated through the source mapping.
  const effectivePolicy = parsedPolicy;
  const rebuilt = buildCandidate({ id: candidate.seedId, request: base, mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [], prosePaths: [] } }, recipe, [contract], effectivePolicy, target.provider);
  if (target.questionMapping) assert(sameMap(rebuilt.questionMap, target.questionMapping), 'target question mapping does not match replayed witness');
  if (target.labelMappings) assert(sameLabelMaps(rebuilt.labelMaps, target.labelMappings), 'target label mappings do not match replayed witness');
  return { definition: target, candidate: rebuilt, contract, policy: effectivePolicy };
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
  const prepared = new Map<string, { old: PreparedTarget; newer: PreparedTarget }>();
  for (const experimentCase of spec.cases) {
    embeddedContract(experimentCase);
    replayCandidate(experimentCase.candidate, experimentCase.source);
    prepared.set(experimentCase.id, { old: targetCandidate(experimentCase.candidate, experimentCase.contract, spec.old), newer: targetCandidate(experimentCase.candidate, experimentCase.contract, spec.new) });
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
      const runTarget = async (definition: ExperimentTarget, adjusted: PreparedTarget): Promise<TargetResult> => {
      const broker = brokers.get(definition.id)!;
      const a = await broker.evaluate(adjusted.candidate.basePayload, 'discovery', `${experimentCase.id}:${definition.id}:A`);
      const b = await broker.evaluate(adjusted.candidate.mutantPayload, 'discovery', `${experimentCase.id}:${definition.id}:B`);
      const discovery = evaluateRelation(adjusted.candidate, adjusted.contract, a.response, b.response, adjusted.policy);
      if (discovery.status === 'unknown' || broker.modelChanged) return { target: definition.id, provider: definition.provider, targetHash: adjusted.candidate.targetHash, status: 'unknown', discovery, observations: broker.observations.length, observedModels: broker.observedModels };
      const confirmation = await confirmCandidate(adjusted.candidate, adjusted.contract, broker, spec.oracle, { signature: discovery.signature ?? 'holds', seed: (options.seed ?? 42) + results.length, policy: adjusted.policy, ledger, slots, discoverySamples: 2, journal: options.journal });
      if (confirmation.reason.startsWith('INCOMPLETE_')) throw new FuzzError(confirmation.reason.slice('INCOMPLETE_'.length), 'experiment confirmation did not complete');
      return { target: definition.id, provider: definition.provider, targetHash: adjusted.candidate.targetHash, status: status(discovery, confirmation, broker.modelChanged), discovery, confirmation, observations: broker.observations.length, observedModels: broker.observedModels };
      };
      const tuple = prepared.get(experimentCase.id)!;
      const old = await runTarget(spec.old, tuple.old), newer = await runTarget(spec.new, tuple.newer);
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
