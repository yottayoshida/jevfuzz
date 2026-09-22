import assert from 'node:assert/strict';
import test from 'node:test';
import { EvaluationBroker } from '../src/engine/broker.ts';
import { BudgetLedger } from '../src/engine/budget.ts';
import { FakeProvider, TypeSafeProvider } from '../src/provider.ts';

const payload = JSON.stringify({ state: {}, model: 'jev-latest', questions: { q: { type: 'noul', instructions: 'x' } } });
const response = { model: 'jev-1', answers: { q: { type: 'noul', noul: .5 } }, usage: { input_tokens: 1, output_tokens: 2 } };
const budget = () => new BudgetLedger({ logicalRequests: 4, httpAttempts: 4, wallTimeSeconds: 60, discoveryRequests: 4, confirmationRequests: 0, shrinkRequests: 0, finalConfirmationRequests: 0 });

test('strict broker supports deterministic fake adapters without HTTP accounting', async () => {
  const fake = new FakeProvider(), ledger = budget(); const broker = new EvaluationBroker(fake, ledger, { strict: true });
  const observation = await broker.evaluate(payload, 'discovery');
  assert.equal(observation.cache, 'unknown');
  assert.equal(broker.observations.length, 1);
  assert.equal(ledger.snapshot().http.consumedKnown, 0);
});

test('broker journals durable reservation before dispatch and charges every retry', async () => {
  const events: string[] = []; let calls = 0;
  const provider = new TypeSafeProvider({ TYPESAFE_API_KEY: 'secret' }, { fetch: async () => ++calls === 1 ? new Response('{}', { status: 529 }) : new Response(JSON.stringify(response)), sleep: async () => {} });
  const ledger = budget(); const broker = new EvaluationBroker(provider, ledger, { strict: true, journal: { append: async type => { events.push(type); } } });
  const observed = await broker.evaluate(payload, 'discovery');
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
