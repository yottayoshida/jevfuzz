import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetLedger } from '../src/engine/budget.ts';
import { ExecutionJournal, decodeJournal } from '../src/engine/journal.ts';
import type { BudgetConfig } from '../src/campaign-types.ts';

const limits: BudgetConfig = { logicalRequests: 8, httpAttempts: 5, wallTimeSeconds: 100, discoveryRequests: 2, confirmationRequests: 3, shrinkRequests: 0, finalConfirmationRequests: 3 };
test('phase reservations remain exclusive and final confirmation cannot be borrowed', async () => {
  const ledger = new BudgetLedger(limits);
  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, async (_, i) => ledger.reserve('discovery', 'logical', `op-${i}`)));
  assert.equal(outcomes.filter(v => v.status === 'fulfilled').length, 2);
  assert.equal(ledger.snapshot().logical.activeReserved, 2);
  assert.equal(ledger.remaining('final-confirmation'), 3);
  ledger.dispatch('op-0'); ledger.settle('op-0', 'unknown'); ledger.settle('op-1', 'known');
  const state = ledger.snapshot();
  assert.deepEqual(state.phases.discovery, { limit: 2, activeReserved: 0, consumedKnown: 1, consumedUnknown: 1, remaining: 0 });
  assert.throws(() => ledger.release('op-0'), /cannot be refunded/);
  assert.throws(() => ledger.settle('op-0', 'known'), /already settled/);
});
test('recovery consumes unresolved reservations and never replenishes lineage budget', () => {
  const ledger = new BudgetLedger(limits);
  ledger.reserve('discovery', 'logical', 'logical'); ledger.dispatch('logical');
  ledger.reserve('discovery', 'http', 'http');
  const before = ledger.snapshot(), restored = new BudgetLedger(limits, before), after = restored.snapshot();
  assert.equal(after.lineageBudgetId, before.lineageBudgetId);
  assert.equal(after.logical.consumedUnknown, 1); assert.equal(after.http.consumedUnknown, 1);
  assert.equal(after.logical.remaining, before.logical.remaining);
  assert.equal(after.logical.activeReserved, 0);
  const corrupt = structuredClone(before); corrupt.reservations = [];
  assert.throws(() => new BudgetLedger(limits, corrupt), /accounting mismatch/);
});
test('journal serializes writers and refuses interior corruption and secret persistence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jevfuzz-journal-'));
  try {
    const file = join(root, 'events.jsonl'); const journal = await ExecutionJournal.create(file, { secrets: ['private-sentinel'] });
    await Promise.all(Array.from({ length: 12 }, (_, i) => journal.append('reserved', { id: i })));
    await journal.close();
    const text = await readFile(file, 'utf8'), decoded = decodeJournal(text);
    assert.equal(decoded.records.length, 12); assert.equal(decoded.truncatedBytes, 0);
    assert.throws(() => decodeJournal(text.replace('"id":0', '"id":9')), /checksum/);
    await appendFile(file, '{"sequence":12');
    const recovered = await ExecutionJournal.resume(file); await recovered.append('settled', { id: 11 }); await recovered.close();
    assert.equal(decodeJournal(await readFile(file, 'utf8')).records.length, 13);
    const privateFile = join(root, 'private.jsonl'); const privateJournal = await ExecutionJournal.create(privateFile, { secrets: ['private-sentinel'] });
    await assert.rejects(privateJournal.append('observed', { text: 'private-sentinel' }), /credential detected/);
    await assert.rejects(privateJournal.close(), /credential detected/);
    assert.equal((await readFile(privateFile, 'utf8')).includes('private-sentinel'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
