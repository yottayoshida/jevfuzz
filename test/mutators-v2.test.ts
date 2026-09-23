import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCandidate, generateCandidateSet, generateCandidates, generateSteps } from '../src/mutators/index.ts';
import type { CampaignConfig, CampaignSeed, Contract, MutationStep } from '../src/campaign-types.ts';

const seed: CampaignSeed = { id: 's', mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [], prosePaths: [] }, request: { state: {}, model: 'jev-latest', questions: { q: { type: 'score', instructions: 'x', criteria: ['low', 'high'] } } } };
const contract: Contract = { id: 'c', question: 'q', relation: 'invariant', projection: 'score', mutations: ['question_id_rename'], admissibility: 'structural', assumptions: [], required: true };
const fullContract = (question: string): Contract => ({ ...contract, id: `all-${question}`, question, mutations: ['question_id_rename', 'question_order', 'choice_criteria_order', 'object_key_order', 'unordered_array_shuffle', 'irrelevant_field_injection', 'text_normalization', 'choice_label_rename'], projection: 'choice' });
const config = (seeds: CampaignSeed[], contracts: Contract[], maxCandidates = 50): CampaignConfig => ({ version: 2, name: 'x', seeds, provider: 'typesafe', contracts, search: { strategy: 'enumerator', seed: 7, maxDepth: 3, batchSize: 1, concurrency: 1, uniformFraction: 0, stagnationBatches: 0, maxCandidates, maxQueueBytes: 1, familyQuota: 1 }, oracle: { profile: 'paired-v1', pairs: 1, minimumSupport: 1, maxControlViolationRate: 0, minimumEffect: 0, alpha: .05, originalSlots: 0, shrinkSlots: 0 }, budget: { logicalRequests: 1, httpAttempts: 1, wallTimeSeconds: 1, discoveryRequests: 0, confirmationRequests: 0, shrinkRequests: 0, finalConfirmationRequests: 0 }, storage: { mode: 'hash-only', directory: '.x', maxRunBytes: 1, maxCorpusBytes: 1, redactPaths: [] }, reducers: { independentQuestions: false, optionalStatePaths: [], unorderedArrayPaths: [], prosePaths: [] }, duplicateSeeds: 0 });

test('witness replay preserves concrete bytes, complete question mapping, and rejects no-ops', () => {
  const steps = generateSteps(seed, 7); const candidate = buildCandidate(seed, steps, [contract]);
  assert.notEqual(candidate.basePayload, candidate.mutantPayload); assert.deepEqual(candidate.questionMap, { q_7_0: 'q' });
  assert.throws(() => buildCandidate(seed, [{ ...steps[0]!, renames: { q: 'q' } }], [contract]), /no-op/);
});

test('candidate generation is breadth-first, includes noncontiguous depth two witnesses, and bounds output', () => {
  const rich: CampaignSeed = { id: 'order', mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [{ path: '$.state', field: 'note', values: ['v'] }], prosePaths: [] }, request: { state: { z: 1, a: 2 }, model: 'jev-latest', questions: { q: { type: 'choice', instructions: 'x', criteria: { yes: 'y', no: 'n' } }, other: { type: 'noul', instructions: 'n' } } } };
  const result = generateCandidateSet(config([rich], [fullContract('q')], 200));
  assert.equal(result.candidates[0]!.recipe.length, 1);
  assert.ok(result.candidates.some(c => c.recipe.length === 2 && c.recipe.some(s => s.operator === 'question_order') && c.recipe.some(s => s.operator === 'irrelevant_field_injection')));
  const limited = generateCandidateSet(config([rich], [fullContract('q')], 1));
  assert.equal(limited.candidates.length, 1); assert.ok(limited.limited > 0); assert.equal(generateCandidates(config([rich], [fullContract('q')], 1)).length, 1);
});

test('original paths and order resolve after composed partial ID renames', () => {
  const two: CampaignSeed = { ...seed, request: { ...seed.request, questions: { 'a.b': { type: 'noul', instructions: 'a' }, second: { type: 'noul', instructions: 'b' } } } };
  const rename1: MutationStep = { operator: 'question_id_rename', version: '1', admissibility: 'structural', renames: { 'a.b': 'first' }, reads: [], writes: [], requires: [], invalidates: [] };
  const rename2: MutationStep = { ...rename1, renames: { first: 'last' } };
  const order: MutationStep = { operator: 'question_order', version: '1', admissibility: 'structural', order: ['second', 'a.b'], reads: ['$.questions'], writes: ['$.questions'], requires: [], invalidates: [] };
  const candidate = buildCandidate(two, [rename1, rename2, order], [{ ...contract, question: 'a.b', projection: 'noul', mutations: ['question_id_rename', 'question_order'] }]);
  assert.deepEqual(candidate.questionMap, { last: 'a.b', second: 'second' });
  assert.deepEqual(Object.keys((JSON.parse(candidate.mutantPayload) as typeof two.request).questions), ['second', 'last']);
});

test('explicit label mapping is the only source of Choice label rename and label witness is replayed', () => {
  const choice: CampaignSeed = { ...seed, request: { ...seed.request, questions: { q: { type: 'choice', instructions: 'pick', criteria: { yes: 'yes', no: 'no' } } } } };
  assert.equal(generateSteps(choice, 4).some(s => s.operator === 'choice_label_rename'), false);
  const mapped: Contract = { ...fullContract('q'), relation: 'equivariant', labelMapping: { Y: 'yes', N: 'no' } };
  const witness = generateSteps(choice, 4, [mapped]).find(s => s.operator === 'choice_label_rename')!;
  const candidate = buildCandidate(choice, [witness], [mapped]);
  assert.deepEqual(candidate.labelMaps.q, { Y: 'yes', N: 'no' });
});

test('nested object permutations are concrete while Score levels and injection paths are protected', () => {
  const richer: CampaignSeed = { id: 'r', mutations: { builtin: true, unorderedArrays: ['$.state.tags'], irrelevantFields: [{ path: '$.state', field: 'trace', values: ['x'] }], prosePaths: ['$.questions.choice.instructions'] }, request: { state: { b: { y: 2, x: 1 }, a: 1, tags: ['a', 'b'] }, model: 'jev-latest', questions: { choice: { type: 'choice', instructions: '  route  ', criteria: { yes: { b: 2, a: 1 }, no: 'n' } }, score: { type: 'score', instructions: 'rate', criteria: ['low', 'high'] } } } };
  const steps = generateSteps(richer, 9), rename = steps.find(s => s.operator === 'question_id_rename')!, metadata = steps.find(s => s.operator === 'irrelevant_field_injection')!, array = steps.find(s => s.operator === 'unordered_array_shuffle')!;
  const result = buildCandidate(richer, [rename, metadata, array], [{ ...fullContract('choice'), mutations: ['question_id_rename', 'irrelevant_field_injection', 'unordered_array_shuffle'] }]);
  const payload = JSON.parse(result.mutantPayload) as typeof richer.request; const state = payload.state as Record<string, unknown>;
  assert.equal(state.trace, 'x'); assert.deepEqual(state.tags, ['b', 'a']); assert.deepEqual(payload.questions.q_9_1!.criteria, ['low', 'high']);
  assert.ok(steps.some(s => s.operator === 'object_key_order' && s.orders![0]!.path.includes('state')));
  const badScore: MutationStep = { operator: 'unordered_array_shuffle', version: '1', admissibility: 'declared', path: '$.questions.score.criteria', order: [1, 0], reads: [], writes: [], requires: [], invalidates: [] };
  const badInjection: MutationStep = { operator: 'irrelevant_field_injection', version: '1', admissibility: 'declared', path: '$.questions.choice["criteria"]', field: 'evil', value: 'x', reads: [], writes: [], requires: [], invalidates: [] };
  assert.throws(() => buildCandidate(richer, [badScore], [contract]), /Score/);
  assert.throws(() => buildCandidate(richer, [badInjection], [contract]), /unsafe/);
});

test('hypothesis is contagious and provenance differentiates same payload under distinct contracts', () => {
  const rename = generateSteps(seed, 3)[0]!;
  const hypothesis = buildCandidate(seed, [{ ...rename, admissibility: 'hypothesis' }], [contract]); assert.equal(hypothesis.admissibility, 'hypothesis');
  const a = buildCandidate(seed, [rename], [{ ...contract, id: 'a' }]); const b = buildCandidate(seed, [rename], [{ ...contract, id: 'b' }]);
  assert.equal(a.mutantPayload, b.mutantPayload); assert.notEqual(a.id, b.id);
});
