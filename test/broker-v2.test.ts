import assert from 'node:assert/strict';
import test from 'node:test';
import { EvaluationBroker } from '../src/engine/broker.ts';
import { BudgetLedger } from '../src/engine/budget.ts';
import { FakeProvider, TypeSafeProvider } from '../src/provider.ts';
import { run } from '../src/runner.ts';
import { parseConfig } from '../src/config.ts';
import type { DecisionProvider } from '../src/types.ts';
import { FuzzError } from '../src/util.ts';

const payload = JSON.stringify({ state: {}, model: 'jev-latest', questions: { q: { type: 'noul', instructions: 'x' } } });
const response = { model: 'jev-1', answers: { q: { type: 'noul', noul: .5 } }, usage: { input_tokens: 1, output_tokens: 2 } };
const budget = () => new BudgetLedger({ logicalRequests: 4, httpAttempts: 4, wallTimeSeconds: 60, discoveryRequests: 4, confirmationRequests: 0, shrinkRequests: 0, finalConfirmationRequests: 0 });

test('strict broker supports deterministic fake adapters without HTTP accounting', async () => {
  const fake = new FakeProvider(), ledger = budget(); const broker = new EvaluationBroker(fake, ledger, { strict: true });
  const observation = await broker.evaluate(payload, 'discovery');
  assert.equal(observation.cache, 'fresh');
  assert.equal(broker.observations.length, 1);
  assert.equal(ledger.snapshot().http.consumedKnown, 0);
});

test('strict broker rejects custom live adapters that deny HTTP accounting', () => {
  const fake = new FakeProvider();
  const custom: DecisionProvider = { mode: 'live', capabilities: { ...fake.capabilities }, evaluate: async () => { throw new Error('must not dispatch'); } };
  assert.throws(() => new EvaluationBroker(custom, budget(), { strict: true }), /attempt hooks/);
  class OverriddenFake extends FakeProvider { override async evaluate(): Promise<never> { throw new Error('must not dispatch'); } }
  assert.throws(() => new EvaluationBroker(new OverriddenFake(), budget(), { strict: true }), /attempt hooks/);
});

test('legacy production run reserves discovery, confirmation and every retry through the ledger', async () => {
  const reservations: { phase: string; kind: string }[] = [];
  const original = BudgetLedger.prototype.reserve;
  BudgetLedger.prototype.reserve = function (phase, kind, id) { reservations.push({ phase, kind }); return original.call(this, phase, kind, id); };
  try {
    const provider = new TypeSafeProvider({ TYPESAFE_API_KEY: 'synthetic' }, { fetch: async (_url, init) => {
      const req = JSON.parse(String(init?.body));
      const answers = Object.fromEntries(Object.entries(req.questions as Record<string, { criteria: Record<string, string> }>).map(([id, q]) => { const labels = Object.keys(q.criteria); return [id, { type: 'choice', choice: labels[0], confidence: 1, probabilities: Object.fromEntries(labels.map(label => [label, label === labels[0] ? 1 : 0])) }]; }));
      return new Response(JSON.stringify({ model: 'test-v1', answers, usage: { input_tokens: 0, output_tokens: 0 } }));
    } });
    const config = parseConfig({ state: {}, model: 'jev-latest', questions: { q: { type: 'choice', instructions: 'x', criteria: { a: 'a', b: 'b' } } } });
    const report = await run(config, provider, { seed: 42, maxRequests: 100 });
    assert.equal(report.summary.fail > 0, true);
    assert.equal(reservations.filter(r => r.kind === 'logical').length, report.summary.logicalRequests);
    assert.equal(reservations.filter(r => r.kind === 'http').length, provider.httpAttempts);
    assert.equal(reservations.some(r => r.phase === 'confirmation'), true);
  } finally { BudgetLedger.prototype.reserve = original; }
});

test('broker journals durable reservation before dispatch and charges every retry', async () => {
  const events: string[] = []; let calls = 0;
  const provider = new TypeSafeProvider({ TYPESAFE_API_KEY: 'secret' }, { fetch: async () => ++calls === 1 ? new Response('{}', { status: 529 }) : new Response(JSON.stringify(response)), sleep: async () => {} });
  const ledger = budget(); const broker = new EvaluationBroker(provider, ledger, { strict: true, journal: { append: async type => { events.push(type); } } });
  const observed = await broker.evaluate(payload, 'discovery');
  assert.equal(observed.cache, 'unknown');
  assert.equal(observed.wireHash === observed.transportWireHash, true);
  assert.equal(observed.wireHash, 'b75c594adec0fca4ac52656c373ad6afce24c320d81016498c39125fa8496ac1');
  assert.deepEqual(events.slice(0, 4), ['reservation', 'dispatched', 'reservation', 'dispatched']);
  assert.equal(ledger.snapshot().http.consumedKnown, 2);
  assert.equal(broker.usage.outputTokens, 2);
});

test('journal failure denies dispatch without retries and operation IDs are single-use', async () => {
  let calls = 0;
  const provider = new TypeSafeProvider({ TYPESAFE_API_KEY: 'secret' }, { fetch: async () => { calls++; return new Response(JSON.stringify(response)); } });
  const broker = new EvaluationBroker(provider, budget(), { strict: true, journal: { append: async () => { throw new Error('EIO'); } } });
  await assert.rejects(broker.evaluate(payload, 'discovery', 'operation'), /hook failed|EIO/i);
  assert.equal(calls, 0);
  const fake = new EvaluationBroker(new FakeProvider());
  await fake.evaluate(payload, 'discovery', 'once');
  await assert.rejects(fake.evaluate(payload, 'discovery', 'once'), /duplicate/i);
});

test('transport uncertainty remains consumed unknown when a retry succeeds', async () => {
  let calls = 0;
  const provider = new TypeSafeProvider({ TYPESAFE_API_KEY: 'secret' }, { fetch: async () => { calls++; if (calls === 1) throw new Error('socket'); return new Response(JSON.stringify(response)); }, sleep: async () => {} });
  const ledger = budget(); const broker = new EvaluationBroker(provider, ledger, { strict: true });
  await broker.evaluate(payload, 'discovery');
  assert.equal(ledger.snapshot().http.consumedUnknown, 1);
  assert.equal(ledger.snapshot().http.consumedKnown, 1);
});

test('known 529 attempt followed by HTTP budget exhaustion settles logical work known without a second fetch', async () => {
  let calls = 0;
  const provider = new TypeSafeProvider({ TYPESAFE_API_KEY: 'secret' }, { maxAttempts: 2, fetch: async () => { calls++; return new Response('{}', { status: 529 }); }, sleep: async () => {} });
  const ledger = new BudgetLedger({ logicalRequests: 1, httpAttempts: 1, wallTimeSeconds: 60, discoveryRequests: 1, confirmationRequests: 0, shrinkRequests: 0, finalConfirmationRequests: 0 });
  const broker = new EvaluationBroker(provider, ledger, { strict: true });
  await assert.rejects(broker.evaluate(payload, 'discovery'), (error: unknown) => error instanceof FuzzError && error.code === 'BUDGET');
  assert.equal(calls, 1); assert.equal(ledger.snapshot().http.consumedKnown, 1); assert.equal(ledger.snapshot().logical.consumedKnown, 1); assert.equal(ledger.snapshot().logical.consumedUnknown, 0);
});

test('a prior unknown transport keeps logical work unknown when retry reservation hits budget', async () => {
  let calls = 0;
  const provider = new TypeSafeProvider({ TYPESAFE_API_KEY: 'secret' }, { maxAttempts: 2, fetch: async () => { calls++; throw new Error('socket'); }, sleep: async () => {} });
  const ledger = new BudgetLedger({ logicalRequests: 1, httpAttempts: 1, wallTimeSeconds: 60, discoveryRequests: 1, confirmationRequests: 0, shrinkRequests: 0, finalConfirmationRequests: 0 });
  const broker = new EvaluationBroker(provider, ledger, { strict: true });
  await assert.rejects(broker.evaluate(payload, 'discovery'), (error: unknown) => error instanceof FuzzError && error.code === 'BUDGET');
  assert.equal(calls, 1); assert.equal(ledger.snapshot().http.consumedUnknown, 1); assert.equal(ledger.snapshot().logical.consumedKnown, 0); assert.equal(ledger.snapshot().logical.consumedUnknown, 1);
});
