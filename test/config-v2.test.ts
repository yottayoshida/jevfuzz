import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCampaign } from '../src/campaign-config.ts';

const campaign = { version: 2, name: 'x', seeds: [{ id: 's', request: { state: {}, model: 'jev-latest', questions: { q: { type: 'noul', instructions: 'x' } } } }], provider: 'typesafe', contracts: [{ id: 'c', question: 'q' }], budget: { logicalRequests: 25, httpAttempts: 24, wallTimeSeconds: 1, discoveryRequests: 1, confirmationRequests: 24, shrinkRequests: 0, finalConfirmationRequests: 0 } };
test('v2 campaign parser is strict and keeps inline seeds local', () => {
  assert.equal(parseCampaign(campaign).version, 2);
  assert.deepEqual(parseCampaign(campaign).search, { strategy: 'uniform', seed: 42, maxDepth: 3, batchSize: 8, concurrency: 4, uniformFraction: .2, stagnationBatches: 20, maxCandidates: 1000, maxQueueBytes: 16 * 1024 * 1024, familyQuota: 4 });
  assert.throws(() => parseCampaign({ ...campaign, surprise: true }), /unsupported/);
  assert.throws(() => parseCampaign({ ...campaign, seeds: ['seed.json'] }), /inline/);
});

test('v2 parser fails closed for budget, contract type, and nested policy fields', () => {
  assert.throws(() => parseCampaign({ ...campaign, budget: { ...campaign.budget, confirmationRequests: 0, finalConfirmationRequests: 0 } }), /budget/i);
  assert.throws(() => parseCampaign({ ...campaign, contracts: [{ id: 'bad', question: 'q', projection: 'choice' }] }), /projection/i);
  assert.throws(() => parseCampaign({ ...campaign, policy: { version: 1, fallback: 'deny', rules: [{ when: { question: 'q', field: 'noul', op: 'eq', value: 1, injected: true }, action: 'deny' }] } }), /unsupported/i);
  assert.throws(() => parseCampaign({ ...campaign, oracle: { profile: 'fixed-stat-v1', pairs: 1024 } }), /pairs/i);
  assert.throws(() => parseCampaign({ ...campaign, oracle: { profile: 'fixed-stat-v1', pairs: 8 }, contracts: [{ id: 'd', question: 'q', relation: 'directional', direction: 'increase' }] }), /directional/);
  assert.throws(() => parseCampaign({ ...campaign, reducers: { independentQuestions:false, optionalStatePaths:[], unorderedArrayPaths:[], prosePaths:['$.model'] } }), /decision content/);
});

test('policy predicates match question types, finite ranges, labels, and templates', () => {
  const policy = (when: unknown, action = 'hold') => ({ version: 1, fallback: 'hold', rules: [{ when, action }] });
  assert.throws(() => parseCampaign({ ...campaign, policy: policy({ question: 'q', field: 'score', op: 'gt', value: 1 }) }), /type mismatch/);
  assert.throws(() => parseCampaign({ ...campaign, policy: policy({ question: 'q', field: 'noul', op: 'gt', value: Infinity }) }), /invalid JSON|numeric/);
  assert.throws(() => parseCampaign({ ...campaign, policy: policy({ question: 'q', field: 'noul', op: 'gt', value: 2 }) }), /unit/);
  assert.throws(() => parseCampaign({ ...campaign, policy: policy({ question: 'q', field: 'probability', label: 'missing', op: 'gt', value: .5 }) }), /type mismatch/);
  assert.throws(() => parseCampaign({ ...campaign, policy: policy({ question: 'q', field: 'noul', op: 'gt', value: .5 }, '${q}') }), /Choice/);
  const choiceCampaign = { ...campaign, seeds: [{ ...campaign.seeds[0]!, request: { ...campaign.seeds[0]!.request, questions: { q: { type: 'choice', instructions: 'x', criteria: { yes: 'y' } } } } }], contracts: [{ id: 'c', question: 'q' }] };
  assert.throws(() => parseCampaign({ ...choiceCampaign, policy: policy({ question: 'q', field: 'probability', label: 'missing', op: 'gt', value: .5 }) }), /label/);
  assert.equal(parseCampaign({ ...choiceCampaign, policy: policy({ question: 'q', field: 'choice', op: 'eq', value: 'yes' }, '${q}') }).policy?.version, 1);
});
