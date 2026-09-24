import { randomUUID } from 'node:crypto';
import { TOOL_VERSION } from './version.ts';
import type { CaseReport, Comparison, DecisionProvider, FuzzCase, FuzzConfig, FuzzReport, JevRequest, JevResponse, Mutation, MutationResult, RunOptions } from './types.ts';
import { generateMutations } from './mutate.ts';
import { compare, summarize } from './compare.ts';
import { thresholds, validateFuzzConfig, validateRequest } from './config.ts';
import { canonicalJson, hasSecrets } from './storage.ts';
import { EvaluationBroker } from './engine/broker.ts';
import { BudgetLedger } from './engine/budget.ts';
import type { Phase } from './campaign-types.ts';
import { assert, atPath, freshSeed, hash, integer, setPath, FuzzError } from './util.ts';

const SAFE_ERROR_CODES = new Set(['BUDGET', 'CONFIG', 'PROVIDER_ABORTED', 'PROVIDER_CONFIG', 'PROVIDER_HTTP', 'PROVIDER_NETWORK', 'PROVIDER_REQUEST', 'PROVIDER_RESPONSE', 'PROVIDER_TIMEOUT']);
const MUTATION_TYPES = new Set(['question_id_rename', 'question_order', 'choice_criteria_order', 'object_key_order', 'unordered_array_shuffle', 'irrelevant_field_injection', 'text_normalization']);

/** A runtime failure with the fully sanitized report accumulated before it occurred. */
export class RunInterruptedError extends FuzzError {
  readonly report: FuzzReport;
  constructor(report: FuzzReport) { super(report.run.error?.code ?? 'RUN_INTERRUPTED', report.run.error?.message ?? 'run interrupted'); this.name = 'RunInterruptedError'; this.report = report; }
}

export function options(input: Partial<RunOptions> = {}): RunOptions {
  return {
    seed: integer(input.seed ?? freshSeed(), 'seed', 0, 0xffffffff),
    ...(input.baselineRuns === undefined ? {} : { baselineRuns: integer(input.baselineRuns, 'baseline runs', 2) }),
    confirmRuns: integer(input.confirmRuns ?? 2, 'confirm runs', 2),
    concurrency: integer(input.concurrency ?? 4, 'concurrency', 1, 256),
    maxRequests: integer(input.maxRequests ?? 100, 'max requests'), signal: input.signal,
  };
}
export function plan(config: FuzzConfig, opts: RunOptions, prepared?: Mutation[][]) {
  assert(new Set(config.cases.map(c => c.request.model)).size === 1, 'a run requires exactly one requested model');
  const mutations = prepared ?? config.cases.map(c => generateMutations(c, opts.seed));
  const baselineRequests = config.cases.reduce((n, c) => n + (opts.baselineRuns ?? c.baselineRuns), 0);
  const mutationRequests = mutations.reduce((n, m) => n + m.length, 0);
  const maximumConfirmationRequests = mutationRequests * opts.confirmRuns;
  const worstCaseRequests = baselineRequests + mutationRequests + maximumConfirmationRequests;
  assert(Number.isSafeInteger(worstCaseRequests * 5), 'request plan is too large');
  const mutationClasses: Record<string, number> = {};
  for (const list of mutations) for (const m of list) mutationClasses[m.recipe.type] = (mutationClasses[m.recipe.type] ?? 0) + 1;
  return { seed: opts.seed, cases: config.cases.length, questions: config.cases.reduce((n, c) => n + Object.keys(c.request.questions).length, 0), baselineRequests, mutationRequests, maximumConfirmationRequests, worstCaseRequests, maximumHttpAttempts: worstCaseRequests * 5, configuredLimit: opts.maxRequests, withinBudget: worstCaseRequests <= opts.maxRequests, mutationClasses };
}
export function exitCode(report: FuzzReport): number {
  if (report.run.status === 'incomplete') return 2;
  if (report.summary.fail > 0) return 1;
  if (report.run.modelChanged) return 3;
  if (report.summary.pass > 0) return 0;
  return report.summary.warn > 0 && report.summary.inconclusive === 0 ? 0 : 3;
}
function plannedMutationResult(caseIndex: number, mutationIndex: number, mutation: Mutation): MutationResult {
  return { id: `M${caseIndex + 1}-${mutationIndex + 1}`, mutation: mutation.recipe, idMap: mutation.idMap, requestHash: hash(mutation.request), request: mutation.request, responses: [], comparisons: {} };
}
function safeErrorCode(error: unknown): string { return error instanceof FuzzError && SAFE_ERROR_CODES.has(error.code) ? error.code : 'RUN_INTERRUPTED'; }
function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sortedJson(child)]));
  return value;
}
function validatePreparedMutation(item: unknown, testCase: FuzzCase): Mutation {
  const baseline = testCase.request;
  assert(item !== null && typeof item === 'object' && !Array.isArray(item), 'invalid prepared mutation');
  const mutation = item as Mutation;
  const recipe = mutation.recipe as unknown as Record<string, unknown>;
  assert(recipe !== null && typeof recipe === 'object' && !Array.isArray(recipe)
    && MUTATION_TYPES.has(recipe.type as string) && typeof recipe.strategy === 'string' && recipe.strategy.length > 0
    && Number.isSafeInteger(recipe.seed) && (recipe.seed as number) >= 0 && (recipe.seed as number) <= 0xffffffff, 'invalid mutation recipe');
  const optionalFields = recipe.type === 'choice_criteria_order' ? ['question']
    : recipe.type === 'irrelevant_field_injection' ? ['path', 'field', 'valueIndex']
      : ['unordered_array_shuffle', 'text_normalization'].includes(recipe.type as string) ? ['path'] : [];
  assert(Object.keys(recipe).every(key => ['type', 'strategy', 'seed', ...optionalFields].includes(key))
    && ['question', 'path', 'field'].every(key => recipe[key] === undefined || typeof recipe[key] === 'string')
    && (recipe.valueIndex === undefined || (Number.isSafeInteger(recipe.valueIndex) && (recipe.valueIndex as number) >= 0)), 'invalid mutation recipe');
  assert(mutation.idMap !== null && typeof mutation.idMap === 'object' && !Array.isArray(mutation.idMap), 'invalid mutation map');
  const request = validateRequest(mutation.request);
  const baseIds = Object.keys(baseline.questions), changedIds = Object.keys(request.questions), mapped = Object.entries(mutation.idMap);
  assert(mapped.length === 0 || (mapped.length === baseIds.length && mapped.length === changedIds.length
    && mapped.every(([changed, original]) => typeof original === 'string' && Object.hasOwn(request.questions, changed) && Object.hasOwn(baseline.questions, original))
    && new Set(mapped.map(([, original]) => original)).size === baseIds.length), 'invalid mutation map');
  assert((recipe.type === 'question_id_rename' && mapped.length === baseIds.length)
    || (recipe.type !== 'question_id_rename' && baseIds.length === changedIds.length && baseIds.every(id => Object.hasOwn(request.questions, id))
      && mapped.every(([changed, original]) => changed === original)), 'invalid mutation map');
  if (recipe.type === 'question_id_rename') {
    assert(mapped.some(([changed, original]) => changed !== original), 'rename must change a question ID');
    assert(JSON.stringify(changedIds.map(id => mutation.idMap[id])) === JSON.stringify(baseIds), 'rename must preserve question order');
  }
  assert(changedIds.every(id => request.questions[id]!.type === baseline.questions[mutation.idMap[id] ?? id]?.type), 'mutation question type changed');
  if (recipe.type === 'choice_criteria_order') assert(typeof recipe.question === 'string' && baseline.questions[recipe.question]?.type === 'choice', 'invalid mutation recipe');
  if (['unordered_array_shuffle', 'irrelevant_field_injection', 'text_normalization'].includes(recipe.type as string)) assert(typeof recipe.path === 'string', 'invalid mutation recipe');
  if (recipe.type === 'irrelevant_field_injection') assert(typeof recipe.field === 'string' && Number.isSafeInteger(recipe.valueIndex) && (recipe.valueIndex as number) >= 0, 'invalid mutation recipe');
  assert(request.model === baseline.model && JSON.stringify(request) !== JSON.stringify(baseline), 'mutation must change only declared decision content');
  const expected = structuredClone(baseline);
  if (recipe.type === 'question_id_rename') {
    expected.questions = Object.fromEntries(changedIds.map(id => [id, baseline.questions[mutation.idMap[id]!]!]));
  } else if (recipe.type === 'question_order') {
    expected.questions = Object.fromEntries(changedIds.map(id => [id, baseline.questions[id]!]));
  } else if (recipe.type === 'choice_criteria_order') {
    const id = recipe.question as string, target = request.questions[id];
    assert(target?.type === 'choice', 'invalid mutation recipe');
    const source = expected.questions[id]!;
    assert(source.type === 'choice' && Object.keys(target.criteria).length === Object.keys(source.criteria).length
      && Object.keys(target.criteria).every(key => Object.hasOwn(source.criteria, key)), 'invalid mutation recipe');
    source.criteria = Object.fromEntries(Object.keys(target.criteria).map(key => [key, source.criteria[key]!]));
  } else if (recipe.type === 'object_key_order') {
    assert(JSON.stringify(Object.keys(request.questions)) === JSON.stringify(Object.keys(baseline.questions)), 'invalid object-key mutation');
    for (const id of baseIds) {
      const original = baseline.questions[id]!, changed = request.questions[id]!;
      if (original.type === 'choice' && changed.type === 'choice') assert(JSON.stringify(Object.keys(original.criteria)) === JSON.stringify(Object.keys(changed.criteria)), 'invalid object-key mutation');
    }
    assert(JSON.stringify(sortedJson(expected)) === JSON.stringify(sortedJson(request)), 'invalid object-key mutation');
  } else if (recipe.type === 'unordered_array_shuffle') {
    const path = recipe.path as string;
    assert(testCase.mutations.unorderedArrays.includes(path), 'undeclared array mutation');
    const original = atPath(baseline, path), changed = atPath(request, path);
    assert(Array.isArray(original) && Array.isArray(changed) && original.length === changed.length
      && original.map(value => JSON.stringify(value)).sort().join('\u0000') === changed.map(value => JSON.stringify(value)).sort().join('\u0000'), 'invalid array mutation');
    setPath(expected, path, changed);
  } else if (recipe.type === 'irrelevant_field_injection') {
    const path = recipe.path as string, field = recipe.field as string, index = recipe.valueIndex as number;
    const declaration = testCase.mutations.irrelevantFields.find(entry => entry.path === path && entry.field === field);
    assert(declaration && index < declaration.values.length, 'undeclared field mutation');
    Object.defineProperty(atPath(expected, path), field, { value: declaration.values[index], enumerable: true, configurable: true, writable: true });
  } else if (recipe.type === 'text_normalization') {
    const path = recipe.path as string;
    assert(testCase.mutations.prosePaths.includes(path), 'undeclared prose mutation');
    const original = atPath(baseline, path), changed = atPath(request, path);
    assert(typeof original === 'string' && typeof changed === 'string', 'invalid prose mutation');
    const transforms = [original.replace(/\r\n/g, '\n'), original.replace(/\r?\n/g, '\r\n'), `${original.replace(/(?:\r?\n)+$/, '')}\n`, original.trim(), original.replace(/ {2,}/g, ' ')];
    assert(transforms.includes(changed), 'invalid prose mutation');
    setPath(expected, path, changed);
  }
  if (recipe.type !== 'object_key_order') assert(JSON.stringify(expected) === JSON.stringify(request), 'mutation does not match its declared operator');
  return { recipe: mutation.recipe, idMap: mutation.idMap, request };
}

export async function run(config: FuzzConfig, provider: DecisionProvider, input: Partial<RunOptions> = {}, prepared?: Mutation[][], secrets: readonly string[] = []): Promise<FuzzReport> {
  config = validateFuzzConfig(config);
  assert(!hasSecrets(config, secrets), 'credential detected in request input; refusing provider dispatch');
  if (prepared !== undefined) {
    const clean = canonicalJson(prepared);
    assert(!hasSecrets(clean, secrets), 'credential detected in prepared mutation; refusing provider dispatch');
    assert(Array.isArray(clean) && clean.length === config.cases.length && clean.every(Array.isArray), 'invalid prepared mutations');
    prepared = clean.map((list, index) => (list as unknown[]).map(item => validatePreparedMutation(item, config.cases[index]!)));
  }
  const opts = options(input);
  const mutations = prepared ?? config.cases.map(c => generateMutations(c, opts.seed));
  assert(!hasSecrets(mutations, secrets), 'credential detected in mutation; refusing provider dispatch');
  const budget = plan(config, opts, mutations);
  if (!budget.withinBudget) throw new FuzzError('BUDGET', `request budget exceeded: planned worst case ${budget.worstCaseRequests}, --max-requests ${opts.maxRequests}`);
  const startAttempts = provider.httpAttempts ?? 0, startRetries = provider.httpRetries;
  const { signal: ignored, ...savedOptions } = opts;
  const report: FuzzReport = { version: 1,
    run: {
      id: randomUUID(), timestamp: new Date().toISOString(), seed: opts.seed, jevfuzzVersion: TOOL_VERSION, nodeVersion: process.version,
      mode: provider.mode ?? 'custom', providerMode: provider.mode ?? 'custom', requestedModels: [...new Set(config.cases.map(c => c.request.model))],
      observedModels: [], modelChanged: false, configHash: hash(config), options: savedOptions, status: 'complete',
    },
    summary: { cases: config.cases.length, questions: budget.questions, mutations: budget.mutationRequests, pass: 0, warn: 0, fail: 0, inconclusive: 0, logicalRequests: 0, httpAttempts: 0, usage: { inputTokens: 0, outputTokens: 0 } },
    cases: config.cases.map((c, caseIndex): CaseReport => ({
      id: c.id, caseHash: hash(c), baselineRequestHash: hash(c.request), baselineRequest: c.request,
      baselineResponses: [], baseline: {}, invariants: c.invariants,
      thresholds: Object.fromEntries(Object.keys(c.request.questions).map(question => [question, thresholds(Object.hasOwn(c.invariants, question) ? c.invariants[question] : undefined)])),
      mutations: mutations[caseIndex]!.map((m, mutationIndex) => plannedMutationResult(caseIndex, mutationIndex, m)),
    })),
  };
  const controller = new AbortController(), signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
  const ledger = new BudgetLedger({ logicalRequests: opts.maxRequests, httpAttempts: opts.maxRequests * 5, wallTimeSeconds: 86_400,
    discoveryRequests: budget.baselineRequests + budget.mutationRequests, confirmationRequests: budget.maximumConfirmationRequests,
    shrinkRequests: 0, finalConfirmationRequests: 0 });
  const broker = new EvaluationBroker(provider, ledger, { signal, strict: false, secrets: [...secrets] });
  const evaluate = async (request: JevRequest, phase: Phase = 'discovery'): Promise<JevResponse> => {
    signal.throwIfAborted();
    if (report.summary.logicalRequests >= opts.maxRequests) throw new FuzzError('BUDGET', 'logical request limit reached');
    report.summary.logicalRequests++;
    const response = (await broker.evaluate(JSON.stringify(request), phase)).response;
    if (report.run.observedModel === undefined) report.run.observedModel = response.model;
    if (!report.run.observedModels.includes(response.model)) report.run.observedModels.push(response.model);
    if (report.run.observedModel !== response.model) report.run.modelChanged = true;
    report.summary.usage.inputTokens += response.usage.input_tokens; report.summary.usage.outputTokens += response.usage.output_tokens;
    return response;
  };
  let runtimeError: unknown;
  let interrupted = false;
  try {
    for (let caseIndex = 0; caseIndex < config.cases.length; caseIndex++) {
      const c = config.cases[caseIndex]!, caseReport = report.cases[caseIndex]!, list = mutations[caseIndex]!;
      const invariant = (question: string) => Object.hasOwn(c.invariants, question) ? c.invariants[question] : undefined;
      for (let i = 0; i < (opts.baselineRuns ?? c.baselineRuns); i++) caseReport.baselineResponses.push(await evaluate(c.request));
      let next = 0, firstWorkerError: unknown, firstWorkerErrorCaptured = false;
      const worker = async () => {
        while (!signal.aborted) {
          const index = next++; if (index >= list.length) return;
          const mutation = list[index]!, mutationReport = caseReport.mutations[index]!;
          try {
            mutationReport.responses.push(await evaluate(mutation.request));
            const mapped = (response: JevResponse, question: string) => response.answers[Object.entries(mutation.idMap).find(([, original]) => original === question)?.[0] ?? question]!;
            const initial = Object.fromEntries(Object.keys(c.request.questions).map(question => [question, compare(caseReport.baselineResponses.map(response => response.answers[question]!), mutationReport.responses.map(response => mapped(response, question)), invariant(question), false)])) as Record<string, Comparison>;
            if (!report.run.modelChanged && Object.values(initial).some(result => result.verdict === 'FAIL')) for (let confirmation = 0; confirmation < opts.confirmRuns; confirmation++) mutationReport.responses.push(await evaluate(mutation.request, 'confirmation'));
          } catch (error) {
            if (!firstWorkerErrorCaptured) { firstWorkerError = error; firstWorkerErrorCaptured = true; }
            controller.abort();
            throw error;
          }
        }
      };
      const settled = await Promise.allSettled(Array.from({ length: Math.min(opts.concurrency, list.length) }, worker));
      if (firstWorkerErrorCaptured) throw firstWorkerError;
      const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected'); if (failed) throw failed.reason;
    }
    signal.throwIfAborted();
  } catch (error) { runtimeError = error; interrupted = true; controller.abort(); }
  for (let caseIndex = 0; caseIndex < config.cases.length; caseIndex++) {
    const c = config.cases[caseIndex]!, caseReport = report.cases[caseIndex]!;
    const invariant = (question: string) => Object.hasOwn(c.invariants, question) ? c.invariants[question] : undefined;
    if (caseReport.baselineResponses.length >= 2) caseReport.baseline = Object.fromEntries(Object.keys(c.request.questions).map(question => [question, summarize(caseReport.baselineResponses.map(response => response.answers[question]!), invariant(question))]));
    for (let mutationIndex = 0; mutationIndex < caseReport.mutations.length; mutationIndex++) {
      const mutation = mutations[caseIndex]![mutationIndex]!, mutationReport = caseReport.mutations[mutationIndex]!;
      if (caseReport.baselineResponses.length < 2 || mutationReport.responses.length === 0) continue;
      const mapped = (response: JevResponse, question: string) => response.answers[Object.entries(mutation.idMap).find(([, original]) => original === question)?.[0] ?? question]!;
      mutationReport.comparisons = Object.fromEntries(Object.keys(c.request.questions).map(question => [question, compare(caseReport.baselineResponses.map(response => response.answers[question]!), mutationReport.responses.map(response => mapped(response, question)), invariant(question), mutationReport.responses.length >= opts.confirmRuns + 1)]));
      if (interrupted && mutationReport.responses.length < opts.confirmRuns + 1) for (const comparison of Object.values(mutationReport.comparisons)) if (comparison.verdict === 'FAIL') { comparison.verdict = 'INCONCLUSIVE'; comparison.reason = 'INCONCLUSIVE_CONFIRMATION_INTERRUPTED'; comparison.warnings = []; }
    }
  }
  for (const c of report.cases) for (const mutation of c.mutations) for (const result of Object.values(mutation.comparisons)) {
    if (report.run.modelChanged) { result.verdict = 'INCONCLUSIVE'; result.reason = 'INCONCLUSIVE_MODEL_CHANGED'; result.warnings = []; }
    report.summary[result.verdict.toLowerCase() as 'pass' | 'warn' | 'fail' | 'inconclusive']++;
  }
  report.summary.httpAttempts = (provider.httpAttempts ?? startAttempts) - startAttempts;
  if (startRetries !== undefined && provider.httpRetries !== undefined) report.summary.httpRetries = provider.httpRetries - startRetries;
  if (interrupted) {
    report.run.status = 'incomplete';
    report.run.error = { code: opts.signal?.aborted ? 'PROVIDER_ABORTED' : safeErrorCode(runtimeError), message: 'run interrupted' };
    throw new RunInterruptedError(report);
  }
  return report;
}
