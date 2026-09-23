import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { exactPairedTail, pairedTailRejects } from '../src/oracles/index.ts';

test('exact tails and decimal Bonferroni decisions match independent Python integer reference cases', async () => {
  const golden = JSON.parse(await readFile(new URL('../fixtures/statistics/exact-tails.json', import.meta.url), 'utf8'));
  assert.ok(golden.cases.length > 4000);
  for (const row of golden.cases) {
    assert.equal(exactPairedTail(row.b, row.c), row.tail, `tail b=${row.b} c=${row.c}`);
    assert.equal(pairedTailRejects(row.b, row.c, row.alpha, row.family), row.reject, `decision b=${row.b} c=${row.c} alpha=${row.alpha} K=${row.family}`);
  }
});
