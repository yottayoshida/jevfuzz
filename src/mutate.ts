import type { FuzzCase, JevRequest, Json, Mutation, MutationRecipe } from './types.ts';
import { atPath, rng, setPath, shuffle } from './util.ts';

export function generateMutations(testCase: FuzzCase, seed: number): Mutation[] {
  const source = testCase.request;
  const random = rng(seed);
  const output: Mutation[] = [];
  const seen = new Set<string>();
  const original = JSON.stringify(source);
  const add = (recipe: Omit<MutationRecipe, 'seed'>, request: JevRequest, idMap: Record<string, string> = {}) => {
    const bytes = JSON.stringify(request);
    const key = `${recipe.type}:${bytes}`;
    if (bytes === original || seen.has(key)) return;
    seen.add(key); output.push({ recipe: { ...recipe, seed }, request, idMap });
  };
  const ordered = <T>(value: Record<string, T>, strategy: number): Record<string, T> => {
    const entries = Object.entries(value);
    return Object.fromEntries(strategy === 0 ? entries.reverse() : shuffle(entries, random));
  };
  const recurse = (value: Json, strategy: number): Json => {
    if (Array.isArray(value)) return value.map(v => recurse(v, strategy));
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(ordered(value, strategy)).map(([k, v]) => [k, recurse(v, strategy)]));
    return value;
  };
  if (testCase.mutations.builtin) {
    const request = structuredClone(source);
    const idMap: Record<string, string> = Object.create(null);
    request.questions = Object.fromEntries(Object.entries(source.questions).map(([id, q], i) => {
      // Prefix + index makes collisions impossible, including adversarial original IDs.
      const renamed = `q_${seed.toString(16)}_${i}_${Math.floor(random() * 0x100000000).toString(16)}`;
      idMap[renamed] = id; return [renamed, structuredClone(q)];
    }));
    add({ type: 'question_id_rename', strategy: 'seeded' }, request, idMap);
    if (Object.keys(source.questions).length > 1) for (let strategy = 0; strategy < 3; strategy++) {
      const r = structuredClone(source); r.questions = ordered(r.questions, strategy);
      add({ type: 'question_order', strategy: strategy === 0 ? 'reverse' : `shuffle_${strategy}` }, r);
    }
    for (const [id, q] of Object.entries(source.questions)) if (q.type === 'choice') {
      for (let strategy = 0; strategy < 3; strategy++) {
        const r = structuredClone(source);
        const question = r.questions[id]!;
        if (question.type !== 'choice') continue;
        question.criteria = ordered(question.criteria, strategy);
        add({ type: 'choice_criteria_order', question: id, strategy: strategy === 0 ? 'reverse' : `shuffle_${strategy}` }, r);
      }
    }
    for (let strategy = 0; strategy < 2; strategy++) {
      const r = structuredClone(source);
      r.state = recurse(r.state, strategy) as JevRequest['state'];
      for (const q of Object.values(r.questions)) {
        q.instructions = recurse(q.instructions, strategy) as typeof q.instructions;
        // Preserve the outer criterion/level order, only reorder structured values.
        if (q.type === 'score') q.criteria = q.criteria.map(v => recurse(v, strategy) as typeof v);
        else if (q.criteria) q.criteria = Object.fromEntries(Object.entries(q.criteria).map(([k, v]) => [k, recurse(v!, strategy)]));
      }
      add({ type: 'object_key_order', strategy: strategy === 0 ? 'reverse' : 'shuffle' }, r);
    }
  }
  for (const path of testCase.mutations.unorderedArrays) for (let strategy = 0; strategy < 3; strategy++) {
    const r = structuredClone(source);
    const values = atPath(r, path) as Json[];
    setPath(r, path, strategy === 0 ? [...values].reverse() : shuffle(values, random));
    add({ type: 'unordered_array_shuffle', path, strategy: strategy === 0 ? 'reverse' : `shuffle_${strategy}` }, r);
  }
  for (const declaration of testCase.mutations.irrelevantFields) declaration.values.forEach((value, valueIndex) => {
    const r = structuredClone(source);
    Object.defineProperty(atPath(r, declaration.path), declaration.field, { value: structuredClone(value), enumerable: true, configurable: true, writable: true });
    add({ type: 'irrelevant_field_injection', path: declaration.path, field: declaration.field, valueIndex, strategy: 'declared_value' }, r);
  });
  for (const path of testCase.mutations.prosePaths) {
    const text = atPath(source, path) as string;
    const transforms = { lf: text.replace(/\r\n/g, '\n'), crlf: text.replace(/\r?\n/g, '\r\n'), trailing_newline: `${text.replace(/(?:\r?\n)+$/, '')}\n`, trim: text.trim(), ascii_spaces: text.replace(/ {2,}/g, ' ') };
    for (const [strategy, value] of Object.entries(transforms)) {
      const r = structuredClone(source); setPath(r, path, value);
      add({ type: 'text_normalization', path, strategy }, r);
    }
  }
  return output;
}
