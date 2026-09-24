import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.ts';
import { FakeProvider } from '../src/provider.ts';
import { run, options, plan, exitCode, RunInterruptedError } from '../src/runner.ts';
import { generateMutations } from '../src/mutate.ts';
import { FuzzError } from '../src/util.ts';
import type { DecisionProvider, JevRequest, JevResponse, Mutation } from '../src/types.ts';

const config = () => parseConfig({ state: { b: 'evidence', a: 'other' }, model: 'jev-latest', questions: {
  q: { type: 'choice', instructions: 'choose', criteria: { a: 'A', b: 'B', c: 'C' } },
  n: { type: 'noul', instructions: 'yes?' },
} });
function answer(r: JevRequest, choice: string, model = 'jev-1'): JevResponse {
  return { model, answers: Object.fromEntries(Object.entries(r.questions).map(([id, q]) => [id, q.type === 'choice'
    ? { type: 'choice', choice, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === choice ? 1 : 0])), confidence: 1 }
    : { type: 'noul', noul: 0.9 }])), usage: { input_tokens: 10, output_tokens: 2 } };
}
test('StableProvider passes all mutations; request plan and usage are exact', async () => {
  const c = config(), o = options({ seed: 42 });
  const p = plan(c, o);
  const result = await run(c, new FakeProvider(), o);
  assert.equal(result.summary.fail, 0); assert.ok(result.summary.pass > 0);
  assert.equal(result.summary.logicalRequests, p.baselineRequests + p.mutationRequests);
  assert.equal(p.worstCaseRequests, 3 + 3 * p.mutationRequests);
  assert.equal(p.maximumHttpAttempts, 5 * p.worstCaseRequests);
  assert.equal(exitCode(result), 0); assert.equal(result.run.mode, 'fake');
});
test('direct v1 run rejects a known credential before an incomplete report or provider call', async () => {
  const secret = 'direct"secret';
  const c = config();
  c.cases[0]!.request.state = secret;
  let calls = 0;
  const provider = { async evaluate() { calls++; throw new Error('provider reached'); } };
  await assert.rejects(run(c, provider, { seed: 1 }, undefined, [secret]), (error: unknown) => error instanceof FuzzError && error.code === 'CONFIG' && !(error instanceof RunInterruptedError));
  assert.equal(calls, 0);
});
test('position sensitivity becomes confirmed FAIL with byte-identical confirmations', async () => {
  const bodies: string[] = [];
  const provider = new FakeProvider(r => {
    bodies.push(JSON.stringify(r));
    const q = Object.values(r.questions).find(q => q.type === 'choice')!;
    return answer(r, Object.keys(q.criteria!)[0]!);
  });
  const result = await run(config(), provider, { seed: 42, concurrency: 1 });
  assert.ok(result.summary.fail > 0); assert.equal(exitCode(result), 1);
  for (const m of result.cases[0]!.mutations) if (Object.values(m.comparisons).some(c => c.verdict === 'FAIL')) {
    assert.equal(m.responses.length, 3);
    assert.equal(bodies.filter(b => b === JSON.stringify(m.request)).length, 3);
    assert.equal(m.comparisons.q!.reproduced, 3);
  }
  assert.equal(result.summary.usage.inputTokens, result.summary.logicalRequests * 10);
});
test('late confirmation failure on another question is reported as flaky instead of PASS', async () => {
  const c = config();
  const mutation = criterionOrderMutation(c, ['b', 'a', 'c']);
  let calls = 0;
  const provider = new FakeProvider(request => {
    calls++;
    const response = answer(request, calls <= 3 ? 'a' : 'b');
    response.answers.n = { type: 'noul', noul: calls === 5 ? 0.4 : 0.6 };
    return response;
  });
  const report = await run(c, provider, { seed: 42, concurrency: 1 }, [[mutation]]);
  const comparison = report.cases[0]!.mutations[0]!.comparisons.n!;
  assert.equal(calls, 6);
  assert.equal(comparison.verdict, 'WARN');
  assert.equal(comparison.reason, 'WARN_FLAKY_MUTATION');
  assert.equal(comparison.reproduced, 1);
});
test('unstable baseline cannot fail while independent stable questions can pass', async () => {
  const result = await run(config(), new FakeProvider((r, i) => answer(r, i % 2 ? 'b' : 'a')), { seed: 3 });
  assert.equal(result.summary.fail, 0); assert.ok(result.summary.inconclusive > 0);
  assert.ok(result.cases[0]!.mutations.every(m => m.comparisons.q!.reason === 'INCONCLUSIVE_BASELINE_UNSTABLE'));
  assert.equal(exitCode(result), 0);
});
test('late model drift invalidates earlier failures across the entire run', async () => {
  const result = await run(config(), new FakeProvider((r, i) => {
    const q = Object.values(r.questions).find(q => q.type === 'choice')!;
    return answer(r, Object.keys(q.criteria!)[0]!, i >= 8 ? 'jev-2' : 'jev-1');
  }), { seed: 42, concurrency: 1 });
  assert.equal(result.run.modelChanged, true); assert.equal(result.summary.fail, 0);
  assert.equal(result.summary.pass, 0); assert.equal(exitCode(result), 3);
  assert.deepEqual(result.run.observedModels, ['jev-1', 'jev-2']);
});
test('preflight budget violation and invalid run controls make no provider calls', async () => {
  let calls = 0;
  const provider = new FakeProvider(r => { calls++; return answer(r, 'a'); });
  await assert.rejects(run(config(), provider, { maxRequests: 3 }), /budget/);
  await assert.rejects(run(config(), provider, { baselineRuns: 1 }), /baseline/);
  await assert.rejects(run(config(), provider, { confirmRuns: 1 }), /confirm/);
  assert.equal(calls, 0);
});
test('direct run rejects non-JSON request values before invoking a provider', async () => {
  let calls = 0;
  const provider = new FakeProvider(r => { calls++; return answer(r, 'a'); });
  for (const state of [new Date(), new Map([['x', 1]]), new Set([1]), new (class State { value = 1; })()]) {
    const c = config();
    c.cases[0]!.request.state = state as never;
    await assert.rejects(run(c, provider, { seed: 1 }, [[]]), /JSON|invalid|request/i);
  }
  const c = config();
  const bad = criterionOrderMutation(c, ['b', 'a', 'c']);
  bad.request.state = new Map() as never;
  await assert.rejects(run(c, provider, { seed: 1 }, [[bad]]), /JSON|invalid|request/i);
  await assert.rejects(run(c, provider, { seed: 1 }, [[{ recipe: {} as Mutation['recipe'], idMap: {}, request: c.cases[0]!.request }]]), /mutation recipe/i);
  await assert.rejects(run(c, provider, { seed: 1 }, [[{ ...criterionOrderMutation(c, ['b', 'a', 'c']), idMap: { ghost: 'q' } }]]), /mutation map/i);
  const disguised = structuredClone(c.cases[0]!.request);
  disguised.model = 'other'; disguised.state = { arbitrary: true };
  await assert.rejects(run(c, provider, { seed: 1 }, [[{ recipe: { type: 'question_order', strategy: 'claimed', seed: 1 }, idMap: {}, request: disguised }]]), /declared decision content/i);
  await assert.rejects(run(c, provider, { seed: 1 }, [[{ recipe: { type: 'question_order', strategy: 'claimed', seed: 1 }, idMap: {}, request: c.cases[0]!.request }]]), /declared decision content/i);
  const reordered = structuredClone(c.cases[0]!.request);
  reordered.questions = Object.fromEntries(Object.entries(reordered.questions).reverse());
  await assert.rejects(run(c, provider, { seed: 1 }, [[{ recipe: { type: 'question_id_rename', strategy: 'claimed', seed: 1 }, idMap: { n: 'n', q: 'q' }, request: reordered }]]), /rename must change/i);
  assert.equal(calls, 0);
});
test('prepared preflight accepts each generated, contract-preserving mutation class', async () => {
  const c = parseConfig({ version: 1, name: 'prepared', cases: [{ id: 'one', request: {
    state: { items: ['b', 'a'], note: 'two  spaces', meta: { b: 2, a: 1 } }, model: 'jev-latest',
    questions: { q: { type: 'choice', instructions: 'choose', criteria: { a: 'A', b: 'B' } }, n: { type: 'noul', instructions: 'yes?' } },
  }, mutations: { unorderedArrays: ['$.state.items'], irrelevantFields: [{ path: '$.state.meta', field: 'ignored', values: [null] }], prosePaths: ['$.state.note'] } }] });
  const candidates = generateMutations(c.cases[0]!, 42);
  assert.equal(new Set(candidates.map(candidate => candidate.recipe.type)).size, 7);
  const report = await run(c, new FakeProvider(), { seed: 42, maxRequests: 1_000 }, [candidates]);
  assert.equal(report.summary.mutations, candidates.length);
});
test('baseline stays sequential, workers obey concurrency, cancellation stops queue', async () => {
  let active = 0, peak = 0, count = 0;
  const provider: DecisionProvider = { async evaluate(r) {
    count++; active++; peak = Math.max(peak, active);
    if (count <= 3) assert.equal(active, 1);
    await new Promise(resolve => setTimeout(resolve, 5)); active--; return answer(r, 'a');
  } };
  await run(config(), provider, { seed: 42, concurrency: 2 });
  assert.equal(peak, 2);
  const controller = new AbortController(); controller.abort();
  const before = count;
  await assert.rejects(run(config(), provider, { signal: controller.signal }));
  assert.equal(count, before);
});
test('zero mutations cannot masquerade as a reliable verdict', async () => {
  const c = config(); c.cases[0]!.mutations.builtin = false;
  const report = await run(c, new FakeProvider()); assert.equal(exitCode(report), 3);
});

function criterionOrderMutation(c: ReturnType<typeof config>, criteria: string[]): Mutation {
  const request = structuredClone(c.cases[0]!.request);
  const question = request.questions.q!;
  if (question.type !== 'choice') throw new Error('fixture expected a choice question');
  question.criteria = Object.fromEntries(criteria.map(key => [key, question.criteria[key]!])) as typeof question.criteria;
  return { recipe: { type: 'choice_criteria_order', strategy: 'test', seed: 1, question: 'q' }, request, idMap: {} };
}

test('interrupted second baseline retains its first validated response', async () => {
  let calls = 0;
  const provider: DecisionProvider = { async evaluate(request) {
    calls++;
    if (calls === 2) return Promise.reject(undefined);
    return answer(request, 'a');
  } };
  await assert.rejects(run(config(), provider, { seed: 42 }), (error: unknown) => {
    assert.ok(error instanceof RunInterruptedError);
    assert.equal(error.report.run.status, 'incomplete');
    assert.deepEqual(error.report.run.error, { code: 'RUN_INTERRUPTED', message: 'run interrupted' });
    assert.equal(error.report.cases[0]!.baselineResponses.length, 1);
    assert.equal(error.report.cases[0]!.thresholds.n!.noulThreshold, 0.5);
    assert.equal(error.report.cases[0]!.thresholds.q!.scoreDelta, 0.5);
    assert.ok(error.report.cases[0]!.mutations.every(m => m.responses.length === 0 && Object.keys(m.comparisons).length === 0));
    return true;
  });
  assert.equal(calls, 2);
});

test('an interrupted third baseline retains two responses but remains incomplete', async () => {
  let calls = 0;
  const provider: DecisionProvider = { async evaluate(request) {
    calls++;
    if (calls === 3) return Promise.reject(undefined);
    return answer(request, 'a');
  } };
  await assert.rejects(run(config(), provider, { seed: 42 }), (error: unknown) => {
    assert.ok(error instanceof RunInterruptedError);
    assert.equal(error.report.run.status, 'incomplete');
    assert.equal(error.report.cases[0]!.baselineResponses.length, 2);
    assert.equal(error.report.summary.fail, 0);
    assert.equal(Object.keys(error.report.cases[0]!.mutations[0]!.comparisons).length, 0);
    return true;
  });
});

test('interrupted confirmation retains validated mutation responses without a false FAIL', async () => {
  const c = config();
  const mutation = criterionOrderMutation(c, ['b', 'a', 'c']);
  let calls = 0;
  const provider: DecisionProvider = { async evaluate(request) {
    calls++;
    if (calls === 5) throw new Error('sensitive provider response body');
    const q = request.questions.q!;
    return answer(request, q.type === 'choice' ? Object.keys(q.criteria)[0]! : 'a');
  } };
  await assert.rejects(run(c, provider, { seed: 42, concurrency: 1 }, [[mutation]]), (error: unknown) => {
    assert.ok(error instanceof RunInterruptedError);
    const result = error.report.cases[0]!.mutations[0]!;
    assert.equal(result.responses.length, 1);
    assert.equal(result.comparisons.q!.verdict, 'INCONCLUSIVE');
    assert.notEqual(result.comparisons.q!.verdict, 'FAIL');
    return true;
  });
});

test('workers drain validated in-flight responses after abort and do not dequeue more work', async () => {
  const c = config();
  const mutation = criterionOrderMutation(c, ['b', 'a', 'c']);
  const mutations = [mutation, structuredClone(mutation), structuredClone(mutation)];
  let calls = 0;
  const provider: DecisionProvider = { async evaluate(request) {
    calls++;
    if (calls === 4) throw new Error('first worker failed');
    if (calls === 5) await new Promise(resolve => setTimeout(resolve, 15));
    return answer(request, 'a');
  } };
  await assert.rejects(run(c, provider, { seed: 42, concurrency: 2 }, [mutations]), (error: unknown) => {
    assert.ok(error instanceof RunInterruptedError);
    const results = error.report.cases[0]!.mutations;
    assert.equal(results[1]!.responses.length, 1);
    assert.equal(results[2]!.responses.length, 0);
    return true;
  });
  assert.equal(calls, 5);
});

test('a pre-aborted signal returns an incomplete report without provider calls', async () => {
  const controller = new AbortController(); controller.abort(new Error('do not persist this reason'));
  let calls = 0;
  const provider: DecisionProvider = { async evaluate(request) { calls++; return answer(request, 'a'); } };
  await assert.rejects(run(config(), provider, { signal: controller.signal }), (error: unknown) => {
    assert.ok(error instanceof RunInterruptedError);
    assert.equal(error.report.run.status, 'incomplete');
    assert.equal(error.report.run.error?.code, 'PROVIDER_ABORTED');
    assert.equal(error.report.summary.logicalRequests, 0);
    return true;
  });
  assert.equal(calls, 0);
});

test('exit codes preserve incomplete, warning-only, and inconclusive semantics', async () => {
  const base = await run(config(), new FakeProvider(), { seed: 42 });
  const report = (summary: Partial<typeof base.summary>, status: 'complete' | 'incomplete' = 'complete') => ({ ...base, run: { ...base.run, status }, summary: { ...base.summary, ...summary } });
  assert.equal(exitCode(report({ pass: 0, warn: 2, fail: 0, inconclusive: 0 })), 0);
  assert.equal(exitCode(report({ pass: 0, warn: 1, fail: 0, inconclusive: 1 })), 3);
  assert.equal(exitCode(report({ pass: 1, warn: 0, fail: 0, inconclusive: 1 })), 0);
  assert.equal(exitCode(report({ pass: 1, warn: 0, fail: 0, inconclusive: 0 }, 'incomplete')), 2);
});

test('protocol identifiers named __proto__ remain own data properties', async () => {
  const input = JSON.parse('{"state":"x","model":"jev-latest","questions":{"__proto__":{"type":"choice","instructions":"choose","criteria":{"__proto__":"first","other":"second"}}}}');
  input.questions.constructor = structuredClone(input.questions.__proto__);
  const c = parseConfig(input);
  const result = await run(c, new FakeProvider(), { seed: 42 });
  assert.equal(result.summary.fail, 0);
  assert.ok(Object.hasOwn(result.cases[0]!.baseline, '__proto__'));
  assert.ok(Object.hasOwn(result.cases[0]!.baseline.__proto__!.meanProbabilities!, '__proto__'));
});
