import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.ts';
import { FakeProvider } from '../src/provider.ts';
import { run, options, plan, exitCode } from '../src/runner.ts';
import type { DecisionProvider, JevRequest, JevResponse } from '../src/types.ts';

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
