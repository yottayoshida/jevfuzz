import test from 'node:test';
import { boundedJson, canonicalJson } from '../src/storage.ts';
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
test('JSON boundary rejects non-JSON objects, sparse arrays, accessors and oversized structure', () => {
  for (const value of [new Date(), new Map(), new Set(), new (class Item { value = 1; })(), new Array(100_000), classedArray()]) {
    assert.throws(() => boundedJson({ nested: value }, 64, 10));
    assert.throws(() => parseConfig({ ...raw, state: { nested: value } }));
  }
  let reads = 0;
  const withGetter = Object.defineProperty({}, 'value', { enumerable: true, get() { reads++; return 'later'; } });
  assert.throws(() => canonicalJson(withGetter));
  assert.equal(reads, 0);
  const sparse = [, 'x'];
  assert.throws(() => boundedJson(sparse));
  assert.doesNotThrow(() => boundedJson([null, 'x'], 1, 3));
  assert.throws(() => boundedJson([null, 'x'], 1, 2), /structural limit/);
  const plain = Object.assign(Object.create(null), { value: [1, true, null] });
  assert.deepEqual(JSON.parse(JSON.stringify(canonicalJson(plain))), { value: [1, true, null] });
  for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor'] as const) {
    const hostile = new Proxy({ value: 'x' }, { [trap]: () => { throw new Error('payload-sentinel'); } });
    assert.throws(() => canonicalJson(hostile), (error: unknown) =>
      error instanceof Error && !error.message.includes('payload-sentinel'));
  }
  assert.throws(() => boundedJson({ nested: { value: true } }, 1), /structural limit/);
  assert.doesNotThrow(() => boundedJson({ nested: { value: true } }, 2));
});
function classedArray(): number[] { return new (class extends Array<number> {})(1, 2); }
test('raw and wrapper configuration infer defaults and reject unknown schemas/types/fields', () => {
  assert.equal(fixture().baselineRuns, 3);
  assert.equal(fixture().id, 'request.json');
  assert.throws(() => parseConfig({ version: 2 }), /version/);
  assert.throws(() => parseConfig({ ...raw, typo: 1 }), /unsupported/);
  assert.throws(() => parseConfig({ ...raw, questions: {} }), /questions/);
  assert.throws(() => parseConfig({ ...raw, questions: { s: { type: 'score', instructions: 'x', criteria: ['a'] } } }), /Score/);
  assert.throws(() => thresholds({ scoreDelta: 0 }), /positive/);
});
test('request validation accepts a single Choice option and more than 64 questions without widening scalar content', () => {
  assert.doesNotThrow(() => parseConfig({
    state: 'state', model: 'jev-latest', questions: {
      only: { type: 'choice', instructions: ['choose'], criteria: { yes: null } },
    },
  }));
  const questions = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [
    `q${index}`, { type: 'noul', instructions: { prompt: 'decide' } },
  ]));
  assert.doesNotThrow(() => parseConfig({ state: {}, model: 'jev-latest', questions }));
  assert.throws(() => parseConfig({
    state: 'state', model: 'jev-latest', questions: {
      invalid: { type: 'choice', instructions: 'choose', criteria: { yes: 1 } },
    },
  }), /Choice/);
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
