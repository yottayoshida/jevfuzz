import { randomUUID } from 'node:crypto';
import type { CaseReport, DecisionProvider, FuzzConfig, FuzzReport, JevRequest, JevResponse, Mutation, RunOptions } from './types.ts';
import { generateMutations } from './mutate.ts';
import { compare, summarize } from './compare.ts';
import { validateResponse } from './provider.ts';
import { assert, freshSeed, hash, integer, FuzzError } from './util.ts';

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
  if (report.summary.fail > 0) return 1;
  if (report.run.modelChanged || (report.summary.pass === 0 && report.summary.warn === 0 && report.summary.fail === 0)) return 3;
  return 0;
}
export async function run(config: FuzzConfig, provider: DecisionProvider, input: Partial<RunOptions> = {}, prepared?: Mutation[][]): Promise<FuzzReport> {
  const opts = options(input);
  const mutations = prepared ?? config.cases.map(c => generateMutations(c, opts.seed));
  const budget = plan(config, opts, mutations);
  if (!budget.withinBudget) throw new FuzzError('BUDGET', `request budget exceeded: planned worst case ${budget.worstCaseRequests}, --max-requests ${opts.maxRequests}`);
  const startAttempts = provider.httpAttempts ?? 0;
  const { signal: ignored, ...savedOptions } = opts;
  const report: FuzzReport = {
    version: 1,
    run: { id: randomUUID(), timestamp: new Date().toISOString(), seed: opts.seed, jevfuzzVersion: '0.1.0', nodeVersion: process.version,
      mode: provider.mode ?? 'custom', providerMode: provider.mode ?? 'custom', requestedModels: [...new Set(config.cases.map(c => c.request.model))], observedModels: [], modelChanged: false,
      configHash: hash(config), options: savedOptions },
    summary: { cases: config.cases.length, questions: budget.questions, mutations: budget.mutationRequests, pass: 0, warn: 0, fail: 0, inconclusive: 0,
      logicalRequests: 0, httpAttempts: 0, usage: { inputTokens: 0, outputTokens: 0 } }, cases: [],
  };
  const controller = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
  const evaluate = async (request: JevRequest): Promise<JevResponse> => {
    signal.throwIfAborted();
    if (report.summary.logicalRequests >= opts.maxRequests) throw new FuzzError('BUDGET', 'logical request limit reached');
    report.summary.logicalRequests++;
    // Own a copy so custom provider code cannot change the frozen confirmation payload.
    const response = validateResponse(await provider.evaluate(structuredClone(request), { signal }), request);
    if (report.run.observedModel === undefined) report.run.observedModel = response.model;
    if (!report.run.observedModels.includes(response.model)) report.run.observedModels.push(response.model);
    if (report.run.observedModel !== response.model) report.run.modelChanged = true;
    report.summary.usage.inputTokens += response.usage.input_tokens;
    report.summary.usage.outputTokens += response.usage.output_tokens;
    return response;
  };
  try {
    for (let caseIndex = 0; caseIndex < config.cases.length; caseIndex++) {
      const c = config.cases[caseIndex]!;
      const invariant = (question: string) => Object.hasOwn(c.invariants, question) ? c.invariants[question] : undefined;
      const baselineResponses: JevResponse[] = [];
      for (let i = 0; i < (opts.baselineRuns ?? c.baselineRuns); i++) baselineResponses.push(await evaluate(c.request));
      const caseReport: CaseReport = {
        id: c.id, caseHash: hash(c), baselineRequestHash: hash(c.request), baselineRequest: c.request,
        baselineResponses, baseline: Object.fromEntries(Object.keys(c.request.questions).map(q => [q, summarize(baselineResponses.map(r => r.answers[q]!), invariant(q))])),
        invariants: c.invariants, mutations: [],
      };
      report.cases.push(caseReport);
      let next = 0;
      const list = mutations[caseIndex]!;
      const worker = async () => {
        while (!signal.aborted) {
          const index = next++; if (index >= list.length) return;
          const m = list[index]!;
          const responses = [await evaluate(m.request)];
          const mapped = (response: JevResponse, q: string) => {
            const renamed = Object.entries(m.idMap).find(([, original]) => original === q)?.[0] ?? q;
            return response.answers[renamed]!;
          };
          const comparisons = () => Object.fromEntries(Object.keys(c.request.questions).map(q => [q, compare(baselineResponses.map(r => r.answers[q]!), responses.map(r => mapped(r, q)), invariant(q), responses.length > 1)]));
          let results = comparisons();
          if (!report.run.modelChanged && Object.values(results).some(r => r.verdict === 'FAIL')) {
            for (let i = 0; i < opts.confirmRuns; i++) responses.push(await evaluate(m.request));
            results = comparisons();
          }
          caseReport.mutations[index] = { id: `M${caseIndex + 1}-${index + 1}`, mutation: m.recipe, idMap: m.idMap, requestHash: hash(m.request), request: m.request, responses, comparisons: results };
        }
      };
      const settled = await Promise.allSettled(Array.from({ length: Math.min(opts.concurrency, list.length) }, async () => {
        try { await worker(); } catch (error) { controller.abort(); throw error; }
      }));
      const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) throw failed.reason;
    }
  } catch (error) { controller.abort(); throw error; }
  for (const c of report.cases) for (const m of c.mutations) for (const result of Object.values(m.comparisons)) {
    if (report.run.modelChanged) { result.verdict = 'INCONCLUSIVE'; result.reason = 'INCONCLUSIVE_MODEL_CHANGED'; }
    report.summary[result.verdict.toLowerCase() as 'pass' | 'warn' | 'fail' | 'inconclusive']++;
  }
  report.summary.httpAttempts = (provider.httpAttempts ?? startAttempts) - startAttempts;
  return report;
}
