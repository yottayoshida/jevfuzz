import assert from 'node:assert/strict';
import test from 'node:test';

import { compare, jsDivergence, summarize } from '../src/compare.ts';
import { FuzzError } from '../src/util.ts';
import type { JevAnswer } from '../src/types.ts';

const choice = (selected: string, probabilities: Record<string, number> = { yes: 0.8, no: 0.2 }, confidence = 0.8): JevAnswer =>
  ({ type: 'choice', choice: selected, probabilities, confidence });
const noul = (value: number): JevAnswer => ({ type: 'noul', noul: value });
const score = (value: number, probabilities: Record<string, number> = { '0': 0.2, '1': 0.8 }, confidence = 0.8): JevAnswer =>
  ({ type: 'score', score: value, probabilities, confidence, legend: { '0': 'bad', '1': 'good' } });

test('summarize preserves raw choice probability statistics and applies exact stability boundaries', () => {
  const stats = summarize([
    choice('yes', { yes: 0.9, no: 0.1 }, 0.9),
    choice('yes', { yes: 0.5, no: 0.5 }, 0.7),
  ]);
  assert.equal(stats.stable, true);
  assert.equal(stats.modalChoice, 'yes');
  assert.equal(stats.agreementRatio, 1);
  assert.deepEqual(stats.meanProbabilities, { yes: 0.7, no: 0.3 });
  assert.deepEqual(stats.minProbabilities, { yes: 0.5, no: 0.1 });
  assert.deepEqual(stats.maxProbabilities, { yes: 0.9, no: 0.5 });
  assert.equal(stats.meanConfidence, 0.8);
  assert.equal(summarize([noul(0.4), noul(0.5)]).stable, true);
  assert.equal(summarize([noul(0.4), noul(0.5000001)]).stable, false);
  assert.equal(summarize([score(1), score(1.35)]).stable, true);
  assert.equal(summarize([score(1), score(1.3500001)]).stable, false);
});

test('compare rejects baseline collections with fewer than two valid answers', () => {
  assert.throws(() => compare([noul(0.4)], [noul(0.8)]), (error: unknown) => error instanceof FuzzError && error.code === 'CONFIG');
});

test('candidate hard failures are returned before confirmation and become FAIL after reproducible confirmation', () => {
  const baseline = [choice('yes'), choice('yes')];
  const candidate = compare(baseline, [choice('no')]);
  assert.equal(candidate.verdict, 'FAIL');
  assert.equal(candidate.reason, 'FAIL_CHOICE_CHANGED');
  assert.equal(candidate.reproduced, 1);
  assert.equal(candidate.observations, 1);
  const confirmed = compare(baseline, [choice('no'), choice('no'), choice('yes')], undefined, true);
  assert.equal(confirmed.verdict, 'FAIL');
  assert.equal(confirmed.reproduced, 2);
  assert.equal(confirmed.observations, 3);
});

test('confirmation accepts two thirds of the same failing choice and rejects one third', () => {
  const baseline = [choice('yes'), choice('yes'), choice('yes')];
  assert.equal(compare(baseline, [choice('no'), choice('no'), choice('yes')], undefined, true).verdict, 'FAIL');
  const oneThird = compare(baseline, [choice('no'), choice('yes'), choice('yes')], undefined, true);
  assert.equal(oneThird.verdict, 'WARN');
  assert.equal(oneThird.reason, 'WARN_FLAKY_MUTATION');
  const different = compare(baseline, [choice('no'), choice('maybe'), choice('no')], undefined, true);
  assert.equal(different.verdict, 'FAIL');
  assert.equal(different.reproduced, 2);
  const split = compare(baseline, [choice('no'), choice('maybe'), choice('yes')], undefined, true);
  assert.equal(split.verdict, 'WARN');
  assert.equal(split.reason, 'WARN_FLAKY_MUTATION');
  assert.equal(compare(baseline, [choice('no'), choice('no')], undefined, true).verdict, 'WARN');
});

test('unstable baselines are inconclusive and never hard fail', () => {
  const result = compare([choice('yes'), choice('no')], [choice('maybe'), choice('maybe'), choice('maybe')], undefined, true);
  assert.equal(result.verdict, 'INCONCLUSIVE');
  assert.equal(result.reason, 'INCONCLUSIVE_BASELINE_UNSTABLE');
});

test('noul detects threshold flips and soft shifts at exact thresholds', () => {
  const baseline = [noul(0.6), noul(0.6)];
  const candidate = compare(baseline, [noul(0.45)]);
  assert.equal(candidate.verdict, 'FAIL');
  assert.ok(Math.abs(candidate.delta! + 0.15) < 1e-12);
  const confirmed = compare(baseline, [noul(0.45), noul(0.45), noul(0.45)], undefined, true);
  assert.equal(confirmed.verdict, 'FAIL');
  const directionMismatch = compare(baseline, [noul(0.45), noul(0.45), noul(0.8)], undefined, true);
  assert.equal(directionMismatch.verdict, 'FAIL');
  assert.equal(directionMismatch.reproduced, 2);
  const soft = compare([noul(0.1), noul(0.1)], [noul(0.3)]);
  assert.equal(soft.verdict, 'WARN');
  assert.equal(soft.reason, 'WARN_NOUL_PROBABILITY_SHIFT');
});

test('score detects hard deltas and confirms a consistent direction without an aggregate veto', () => {
  const baseline = [score(1), score(1)];
  assert.equal(compare(baseline, [score(1.5)]).verdict, 'FAIL');
  assert.equal(compare(baseline, [score(1.5), score(1.5), score(1.5)], undefined, true).verdict, 'FAIL');
  const mixed = compare(baseline, [score(1.5), score(1.5), score(0.5)], undefined, true);
  assert.equal(mixed.verdict, 'FAIL');
  assert.equal(mixed.reproduced, 2);
});

test('confirmed comparisons recognize a later consistent failure signature and keep an unconfirmed first failure flaky', () => {
  const baseline = [choice('yes'), choice('yes'), choice('yes')];
  const laterFailure = compare(baseline, [choice('yes'), choice('no'), choice('no')], undefined, true);
  assert.equal(laterFailure.verdict, 'FAIL');
  assert.equal(laterFailure.reason, 'FAIL_CHOICE_CHANGED');
  assert.equal(laterFailure.reproduced, 2);

  const flakyFirst = compare(baseline, [choice('no'), choice('yes'), choice('maybe')], undefined, true);
  assert.equal(flakyFirst.verdict, 'WARN');
  assert.equal(flakyFirst.reason, 'WARN_FLAKY_MUTATION');
  assert.equal(flakyFirst.reproduced, 1);
});

test('choice and score distribution/confidence soft invariants use base-two JS divergence', () => {
  assert.equal(jsDivergence({ yes: 1, no: 0 }, { yes: 0, no: 1 }), 1);
  const shifted = compare([choice('yes', { yes: 1, no: 0 }, 0.9), choice('yes', { yes: 1, no: 0 }, 0.9)], [choice('yes', { yes: 0, no: 1 }, 0.5)]);
  assert.equal(shifted.verdict, 'WARN');
  assert.equal(shifted.reason, 'WARN_PROBABILITY_DISTRIBUTION_SHIFT');
  assert.equal(shifted.jsDivergence, 1);
  assert.equal(shifted.confidenceDrop, 0.4);
  const scoreConfidence = compare([score(1, { '0': 0.1, '1': 0.9 }, 0.8), score(1, { '0': 0.1, '1': 0.9 }, 0.8)], [score(1, { '0': 0.1, '1': 0.9 }, 0.5)]);
  assert.equal(scoreConfidence.verdict, 'WARN');
  assert.equal(scoreConfidence.reason, 'WARN_CONFIDENCE_DROP');
});
