import { randomUUID } from 'node:crypto';
import type { CaseReport, Comparison, DecisionProvider, FuzzConfig, FuzzReport, JevRequest, JevResponse, Mutation, MutationResult, RunOptions } from './types.ts';
import { generateMutations } from './mutate.ts';
import { compare, summarize } from './compare.ts';
import { thresholds } from './config.ts';
import { EvaluationBroker } from './engine/broker.ts';
import { BudgetLedger } from './engine/budget.ts';
import type { Phase } from './campaign-types.ts';
import { assert, freshSeed, hash, integer, FuzzError } from './util.ts';

const SAFE_ERROR_CODES = new Set(['BUDGET', 'CONFIG', 'PROVIDER_ABORTED', 'PROVIDER_CONFIG', 'PROVIDER_HTTP', 'PROVIDER_NETWORK', 'PROVIDER_REQUEST', 'PROVIDER_RESPONSE', 'PROVIDER_TIMEOUT']);

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

export async function run(config: FuzzConfig, provider: DecisionProvider, input: Partial<RunOptions> = {}, prepared?: Mutation[][]): Promise<FuzzReport> {
  const opts = options(input);
  const mutations = prepared ?? config.cases.map(c => generateMutations(c, opts.seed));
  const budget = plan(config, opts, mutations);
  if (!budget.withinBudget) throw new FuzzError('BUDGET', `request budget exceeded: planned worst case ${budget.worstCaseRequests}, --max-requests ${opts.maxRequests}`);
  const startAttempts = provider.httpAttempts ?? 0, startRetries = provider.httpRetries;
  const { signal: ignored, ...savedOptions } = opts;
  const report: FuzzReport = { version: 1,
    run: {
      id: randomUUID(), timestamp: new Date().toISOString(), seed: opts.seed, jevfuzzVersion: '0.1.0', nodeVersion: process.version,
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
  const broker = new EvaluationBroker(provider, ledger, { signal, strict: false });
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
