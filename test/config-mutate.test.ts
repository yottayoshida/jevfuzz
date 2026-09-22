import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, thresholds } from '../src/config.ts';
import { generateMutations } from '../src/mutate.ts';
import { rng, atPath } from '../src/util.ts';

const raw = { state: { b: [3, 1, 2], a: { z: 0, y: 1 } }, model: 'jev-latest', questions: {
  pick: { type: 'choice', instructions: { b: 'pick', a: 'one' }, criteria: { yes: { b: 'yes', a: 'ok' }, no: 'no', maybe: null } },
  rate: { type: 'score', instructions: 'rate', criteria: ['low', 'high'] },
  bool: { type: 'noul', instructions: 'yes?' },
} };
const fixture = () => parseConfig(raw).cases[0]!;
test('raw and wrapper configuration infer defaults and reject unknown schemas/types/fields', () => {
  assert.equal(fixture().baselineRuns, 3);
  assert.equal(fixture().id, 'request.json');
  assert.throws(() => parseConfig({ version: 2 }), /version/);
  assert.throws(() => parseConfig({ ...raw, typo: 1 }), /unsupported/);
  assert.throws(() => parseConfig({ ...raw, questions: {} }), /questions/);
  assert.throws(() => parseConfig({ ...raw, questions: { s: { type: 'score', instructions: 'x', criteria: ['a'] } } }), /Score/);
  assert.throws(() => thresholds({ scoreDelta: 0 }), /positive/);
});
test('seeded RNG and mutations reproduce bytes without modifying the original', () => {
  const a = rng(42), b = rng(42); assert.deepEqual(Array.from({ length: 20 }, a), Array.from({ length: 20 }, b));
  const input = fixture(), before = JSON.stringify(input);
  const first = generateMutations(input, 42);
  assert.equal(JSON.stringify(first), JSON.stringify(generateMutations(fixture(), 42)));
  assert.notEqual(JSON.stringify(first), JSON.stringify(generateMutations(fixture(), 43)));
  assert.equal(JSON.stringify(input), before);
  assert.equal(new Set(first.map(m => m.recipe.type)).size, 4);
  assert.ok(first.every(m => JSON.stringify(m.request) !== JSON.stringify(input.request)));
});
test('Tier A preserves values and Score levels; question rename is bijective', () => {
  for (const m of generateMutations(fixture(), 7)) {
    assert.deepEqual(m.request.state, raw.state);
    const ids = Object.keys(m.request.questions);
    if (m.recipe.type === 'question_id_rename') {
      assert.equal(new Set(Object.values(m.idMap)).size, 3);
      for (const id of ids) assert.deepEqual(m.request.questions[id], fixture().request.questions[m.idMap[id]!]);
    } else assert.deepEqual(m.request.questions, fixture().request.questions);
  }
});
test('declared arrays, fields, prose and exact paths are validated and isolated', () => {
  const config = parseConfig({ version: 1, name: 'declared', model: 'jev-latest', cases: [{ id: 'x', request: raw, mutations: { builtin: false, unorderedArrays: ['$.state.b'], irrelevantFields: [{ path: '$.state', field: 'trace', values: ['a', 'b'] }], prosePaths: ['$.questions.bool.instructions'] } }] });
  const mutations = generateMutations(config.cases[0]!, 42);
  assert.ok(mutations.some(m => m.recipe.type === 'unordered_array_shuffle'));
  assert.equal(mutations.filter(m => m.recipe.type === 'irrelevant_field_injection').length, 2);
  assert.ok(mutations.every(m => m.recipe.type !== 'question_order'));
  assert.throws(() => atPath(raw, '$.state.__proto__'), /unsafe/);
  for (const declaration of [ { unorderedArrays: ['$.questions.rate.criteria'] }, { irrelevantFields: [{ path: '$.state', field: 'b', values: [1] }] }, { unorderedArrays: ['$.model'] } ]) {
    assert.throws(() => parseConfig({ version: 1, name: 'x', model: 'jev-latest', cases: [{ id: 'x', request: raw, mutations: declaration }] }));
  }
});
test('numeric object key order and singleton permutations are omitted as no-ops', () => {
  const f = parseConfig({ state: { 1: 'one', 2: 'two' }, model: 'jev-latest', questions: { q: { type: 'noul', instructions: 'x' } } }).cases[0]!;
  assert.deepEqual(generateMutations(f, 1).map(m => m.recipe.type), ['question_id_rename']);
});
