import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCampaign } from '../src/campaign-config.ts';
import type { Candidate } from '../src/campaign-types.ts';
import { BatchScheduler } from '../src/engine/search.ts';
import type { Feedback } from '../src/engine/feedback.ts';
import { contentHash } from '../src/identity.ts';
import { generateCandidateSet } from '../src/mutators/index.ts';

const fixture = new URL('../fixtures/v2/routing.campaign.json', import.meta.url).pathname;
const feedback = (candidate: Candidate, margin: number): Feedback => ({
  version: 'typed-v1', signatures: [], margin, divergence: 0, violation: false,
  families: [...new Set(candidate.recipe.map(step => step.operator))], pairBytes: 1,
});

test('feedback ranking gives tied dimensions no candidate-ID-derived spread', async () => {
  const config = await loadCampaign(fixture);
  config.search = { ...config.search, strategy: 'feedback', batchSize: 1, uniformFraction: 0, familyQuota: 2, maxCandidates: 50 };
  const all = generateCandidateSet(config).candidates;
  const children = [
    all.find(candidate => candidate.recipe.length === 2 && candidate.recipe[0]!.operator === 'question_id_rename')!,
    all.find(candidate => candidate.recipe.length === 2 && candidate.recipe[0]!.operator === 'question_order')!,
  ];
  const parents = children.map(child => all.find(candidate => candidate.seedId === child.seedId && contentHash(candidate.recipe) === contentHash(child.recipe.slice(0, -1)))!);
  const candidates = [
    { ...parents[0]!, id: 'parent-a' }, { ...parents[1]!, id: 'parent-z' },
    { ...children[0]!, id: 'a-low-boundary' }, { ...children[1]!, id: 'z-high-boundary' },
  ];
  const scheduler = new BatchScheduler(candidates, { ...config.search, maxCandidates: 4 });
  scheduler.commit([
    { candidateId: 'parent-a', feedback: feedback(candidates[0]!, .9) },
    { candidateId: 'parent-z', feedback: feedback(candidates[1]!, .1) },
  ]);

  // Novelty and divergence tie here: under batch-v1 their ID-ordinal spreads
  // outweighed the real two-point boundary difference below.
  assert.deepEqual(scheduler.nextBatch().map(candidate => candidate.id), ['z-high-boundary']);
});

test('all-tied feedback dimensions use candidate ID only as the final tie breaker', async () => {
  const config = await loadCampaign(fixture);
  config.search = { ...config.search, strategy: 'feedback', batchSize: 1, uniformFraction: 0, familyQuota: 2, maxCandidates: 50 };
  const candidates = generateCandidateSet(config).candidates.slice(0, 2).reverse();
  const scheduler = new BatchScheduler(candidates, config.search);

  assert.deepEqual(scheduler.nextBatch().map(candidate => candidate.id), [
    [...candidates].map(candidate => candidate.id).sort()[0]!,
  ]);
});
