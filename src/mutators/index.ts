import type { CampaignConfig, CampaignSeed, Candidate, Contract, MutationStep, Policy } from '../campaign-types.ts';
import { contentHash, contractHash, targetHash, wireHash } from '../identity.ts';
import { FuzzError, atPath, pathTokens, setPath } from '../util.ts';
import type { Json, JevRequest } from '../types.ts';
import { validateRequest } from '../config.ts';

const bytes = (value: unknown): string => JSON.stringify(value);
const admissibility = (steps: readonly MutationStep[]) => steps.some(s => s.admissibility === 'hypothesis') ? 'hypothesis' : steps.some(s => s.admissibility === 'declared') ? 'declared' : 'structural';
const step = (operator: MutationStep['operator'], extra: Partial<MutationStep> = {}): MutationStep => ({ operator, version: '1', admissibility: 'structural', reads: [], writes: [], requires: [], invalidates: [], ...extra });
const isSafeKey = (key: string) => !['__proto__', 'prototype', 'constructor'].includes(key);
function pathFor(path: string, map: Record<string, string>): string {
  const tokens = pathTokens(path);
  if (tokens[0] === 'questions' && tokens[1]) tokens[1] = currentId(tokens[1], map);
  return `$${tokens.map(t => /^\d+$/.test(t) ? `[${t}]` : /^[A-Za-z_][A-Za-z0-9_-]*$/.test(t) ? `.${t}` : `[${JSON.stringify(t)}]`).join('')}`;
}
function currentId(original: string, map: Record<string, string>): string {
  const found = Object.entries(map).find(([, source]) => source === original)?.[0];
  if (!found) throw new FuzzError('CONFIG', `witness question mapping is missing for ${original}`);
  return found;
}
function permutation<T>(value: Record<string, T>, order: readonly string[]): Record<string, T> {
  if (order.length !== Object.keys(value).length || new Set(order).size !== order.length || order.some(k => !Object.hasOwn(value, k))) throw new FuzzError('CONFIG', 'order witness must be a complete permutation');
  return Object.fromEntries(order.map(k => [k, value[k]! ]));
}
function reorder(request: JevRequest, path: string, order: readonly string[], map: Record<string, string>): void {
  const actual = pathFor(path, map), value = atPath(request, actual);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FuzzError('CONFIG', 'order witness needs an object');
  setPath(request, actual, permutation(value as Record<string, Json>, order));
}
function isCriteriaContainer(path: string): boolean { const parts = pathTokens(path); return parts.at(-1) === 'criteria'; }
function sourceQuestion(request: JevRequest, path: string): JevRequest['questions'][string] | undefined { const p = pathTokens(path); return p[0] === 'questions' && p[1] ? request.questions[p[1]] : undefined; }

function apply(request: JevRequest, witness: MutationStep, questionMap: Record<string, string>, labelMaps: Record<string, Record<string, string>>): JevRequest {
  const next = structuredClone(request);
  if (witness.operator === 'question_id_rename') {
    if (!witness.renames || Object.keys(witness.renames).length === 0) throw new FuzzError('CONFIG', 'question rename needs a mapping');
    const questions: JevRequest['questions'] = Object.create(null), composed: Record<string, string> = Object.create(null);
    for (const [from, to] of Object.entries(witness.renames)) {
      if (!Object.hasOwn(next.questions, from) || !to || !isSafeKey(to) || Object.hasOwn(questions, to) || (Object.hasOwn(next.questions, to) && !Object.hasOwn(witness.renames, to))) throw new FuzzError('CONFIG', 'question rename is not bijective');
      questions[to] = next.questions[from]!; composed[to] = questionMap[from] ?? from;
    }
    for (const [id, value] of Object.entries(next.questions)) if (!Object.hasOwn(witness.renames, id)) { questions[id] = value; composed[id] = questionMap[id] ?? id; }
    next.questions = questions; Object.keys(questionMap).forEach(k => delete questionMap[k]); Object.assign(questionMap, composed); return next;
  }
  if (witness.operator === 'question_order') {
    if (!witness.order?.every(v => typeof v === 'string')) throw new FuzzError('CONFIG', 'question order missing');
    next.questions = permutation(next.questions, (witness.order as string[]).map(id => currentId(id, questionMap))); return next;
  }
  const original = witness.question, question = original ? currentId(original, questionMap) : undefined;
  if (witness.operator === 'choice_criteria_order') {
    if (!question || !witness.order?.every(v => typeof v === 'string')) throw new FuzzError('CONFIG', 'choice order missing');
    const q = next.questions[question]; if (!q || q.type !== 'choice') throw new FuzzError('CONFIG', 'choice order needs Choice question'); q.criteria = permutation(q.criteria, witness.order as string[]); return next;
  }
  if (witness.operator === 'choice_label_rename') {
    if (!question || !witness.renames) throw new FuzzError('CONFIG', 'choice rename missing');
    const q = next.questions[question]; if (!q || q.type !== 'choice') throw new FuzzError('CONFIG', 'choice rename needs Choice question');
    if (Object.keys(witness.renames).length !== Object.keys(q.criteria).length || new Set(Object.values(witness.renames)).size !== Object.keys(q.criteria).length) throw new FuzzError('CONFIG', 'choice label mapping must be a complete bijection');
    const criteria = Object.fromEntries(Object.entries(witness.renames).map(([from, to]) => { if (!Object.hasOwn(q.criteria, from) || !to || !isSafeKey(to)) throw new FuzzError('CONFIG', 'choice label mapping missing'); return [to, q.criteria[from]!]; }));
    q.criteria = permutation(criteria, Object.values(witness.renames)); labelMaps[original!] = Object.fromEntries(Object.entries(witness.renames).map(([from, to]) => [to, from])); return next;
  }
  if (witness.operator === 'object_key_order') {
    if (!witness.orders?.length) throw new FuzzError('CONFIG', 'object order missing');
    for (const item of witness.orders) { if (isCriteriaContainer(item.path)) throw new FuzzError('CONFIG', 'outer criteria order requires its dedicated operator'); reorder(next, item.path, item.order, questionMap); }
    return next;
  }
  if (witness.operator === 'unordered_array_shuffle') {
    if (!witness.path || !witness.order?.every(v => typeof v === 'number')) throw new FuzzError('CONFIG', 'array witness missing');
    const source = sourceQuestion(request, witness.path); if (isCriteriaContainer(witness.path) && source?.type === 'score') throw new FuzzError('CONFIG', 'Score levels are ordered');
    const actual = pathFor(witness.path, questionMap), value = atPath(next, actual);
    if (!Array.isArray(value) || witness.order.length !== value.length || new Set(witness.order).size !== value.length || witness.order.some(i => !Number.isInteger(i) || i < 0 || i >= value.length)) throw new FuzzError('CONFIG', 'array order invalid');
    setPath(next, actual, witness.order.map(i => value[i as number]!)); return next;
  }
  if (witness.operator === 'irrelevant_field_injection') {
    if (!witness.path || !witness.field || witness.value === undefined || !isSafeKey(witness.field) || isCriteriaContainer(witness.path)) throw new FuzzError('CONFIG', 'field witness missing or unsafe');
    const target = atPath(next, pathFor(witness.path, questionMap));
    if (!target || typeof target !== 'object' || Array.isArray(target) || Object.hasOwn(target, witness.field)) throw new FuzzError('CONFIG', 'metadata field conflicts with existing field');
    Object.defineProperty(target, witness.field, { value: structuredClone(witness.value), enumerable: true, writable: true, configurable: true }); return next;
  }
  if (witness.operator === 'text_normalization') {
    if (!witness.path || witness.text === undefined) throw new FuzzError('CONFIG', 'text witness missing'); const actual = pathFor(witness.path, questionMap);
    if (typeof atPath(next, actual) !== 'string') throw new FuzzError('CONFIG', 'text witness needs text'); setPath(next, actual, witness.text); return next;
  }
  throw new FuzzError('CONFIG', `unsupported v2 mutation witness: ${witness.operator}`);
}

export function buildCandidate(seed: CampaignSeed, recipe: readonly MutationStep[], contracts: readonly Contract[], policy?: Policy, provider: unknown = 'custom'): Candidate {
  if (!recipe.length || recipe.length > 3) throw new FuzzError('CONFIG', 'candidate depth must be in [1, 3]');
  const questionMap: Record<string, string> = Object.fromEntries(Object.keys(seed.request.questions).map(id => [id, id])); const labelMaps: Record<string, Record<string, string>> = Object.create(null); let mutant = structuredClone(seed.request);
  for (const witness of recipe) { if (witness.version !== '1' || !['structural', 'declared', 'hypothesis'].includes(witness.admissibility)) throw new FuzzError('CONFIG', 'invalid mutation witness'); mutant = apply(mutant, witness, questionMap, labelMaps); validateRequest(mutant); }
  const basePayload = bytes(seed.request), mutantPayload = bytes(mutant); if (basePayload === mutantPayload) throw new FuzzError('CONFIG', 'mutation witness is a no-op');
  const provenanceHash = wireHash(bytes({ seed: seed.id, recipe }));
  return { id: wireHash(`${seed.id}:${mutantPayload}:${contractHash(contracts)}:${provenanceHash}`).slice(0, 24), seedId: seed.id, basePayload, mutantPayload, baseWireHash: wireHash(basePayload), mutantWireHash: wireHash(mutantPayload), contentHash: contentHash(mutant), contractHash: contractHash(contracts), targetHash: targetHash(seed.request, policy, provider), recipe: [...recipe], contracts: structuredClone([...contracts]), contractIds: contracts.map(c => c.id), questionMap, labelMaps, admissibility: admissibility(recipe), provenanceHash, assumptions: contracts.flatMap(c => c.assumptions) };
}

function shuffled<T>(items: readonly T[], seed: number): T[] { const out = [...items]; let state = seed >>> 0 || 1; for (let i = out.length - 1; i > 0; i--) { state = (state * 1664525 + 1013904223) >>> 0; const j = state % (i + 1); [out[i], out[j]] = [out[j]!, out[i]!]; } return out; }
function alternatives<T>(items: readonly T[], seed: number): T[][] { const reverse = [...items].reverse(), random = shuffled(items, seed); return [reverse, random].filter((v, i, all) => !v.every((x, n) => x === items[n]) && all.findIndex(other => other.every((x, n) => x === v[n])) === i); }
function objectOrders(value: Json, path: string, out: { path: string; order: string[] }[], seed: number): void {
  if (Array.isArray(value)) { value.forEach((item, i) => objectOrders(item, `${path}[${i}]`, out, seed + i)); return; }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, Json>, keys = Object.keys(record);
  if (keys.length > 1) for (const order of alternatives(keys, seed)) out.push({ path, order });
  for (const [key, item] of Object.entries(record)) objectOrders(item, `${path}[${JSON.stringify(key)}]`, out, seed + key.length);
}

export function generateSteps(seed: CampaignSeed, randomSeed: number, contracts: readonly Contract[] = []): MutationStep[] {
  const steps: MutationStep[] = [], ids = Object.keys(seed.request.questions);
  if (seed.mutations.builtin && ids.length) steps.push(step('question_id_rename', { renames: Object.fromEntries(ids.map((id, i) => [id, `q_${randomSeed.toString(16)}_${i}`])), reads: ['$.questions'], writes: ['$.questions'], requires: ['question_ids_bijective'] }));
  if (seed.mutations.builtin && ids.length > 1) for (const order of alternatives(ids, randomSeed)) steps.push(step('question_order', { order, reads: ['$.questions'], writes: ['$.questions'] }));
  if (seed.mutations.builtin) for (const [id, question] of Object.entries(seed.request.questions)) {
    if (question.type === 'choice' && Object.keys(question.criteria).length > 1) {
      for (const order of alternatives(Object.keys(question.criteria), randomSeed + id.length)) steps.push(step('choice_criteria_order', { question: id, order, reads: [`$.questions[${JSON.stringify(id)}].criteria`], writes: [`$.questions[${JSON.stringify(id)}].criteria`] }));
      for (const contract of contracts.filter(c => c.question === id && c.relation === 'equivariant' && c.labelMapping && c.mutations.includes('choice_label_rename'))) steps.push({ ...step('choice_label_rename', { question: id, renames: Object.fromEntries(Object.entries(contract.labelMapping!).map(([mutant, original]) => [original, mutant])), reads: [`$.questions[${JSON.stringify(id)}].criteria`], writes: [`$.questions[${JSON.stringify(id)}].criteria`] }), admissibility: 'declared' });
    }
    const orders: { path: string; order: string[] }[] = [];
    objectOrders(question.instructions as Json, `$.questions[${JSON.stringify(id)}].instructions`, orders, randomSeed + id.length);
    if (question.type === 'score') question.criteria.forEach((criterion, index) => objectOrders(criterion as Json, `$.questions[${JSON.stringify(id)}].criteria[${index}]`, orders, randomSeed + index));
    else if (question.type === 'choice') Object.entries(question.criteria).forEach(([label, criterion]) => objectOrders(criterion as Json, `$.questions[${JSON.stringify(id)}].criteria[${JSON.stringify(label)}]`, orders, randomSeed + label.length));
    for (const order of orders) steps.push(step('object_key_order', { orders: [order], reads: [order.path], writes: [order.path] }));
  }
  if (seed.mutations.builtin) { const orders: { path: string; order: string[] }[] = []; objectOrders(seed.request.state as Json, '$.state', orders, randomSeed); for (const order of orders) steps.push(step('object_key_order', { orders: [order], reads: [order.path], writes: [order.path] })); }
  for (const path of seed.mutations.unorderedArrays) { const value = atPath(seed.request, path); if (Array.isArray(value) && value.length > 1) for (const order of alternatives(value.map((_, i) => i), randomSeed + path.length)) steps.push({ ...step('unordered_array_shuffle', { path, order, reads: [path], writes: [path], requires: ['declared_unordered_array'] }), admissibility: 'declared' }); }
  for (const field of seed.mutations.irrelevantFields) for (const value of field.values) steps.push({ ...step('irrelevant_field_injection', { path: field.path, field: field.field, value, reads: [field.path], writes: [field.path], requires: ['declared_irrelevant_field'] }), admissibility: 'declared' });
  for (const path of seed.mutations.prosePaths) { const value = atPath(seed.request, path); if (typeof value === 'string') for (const text of [...new Set([value.replace(/\r\n/g, '\n'), value.replace(/\r?\n/g, '\r\n'), `${value.replace(/(?:\r?\n)+$/, '')}\n`, value.trim(), value.replace(/ {2,}/g, ' ')])]) if (text !== value) steps.push({ ...step('text_normalization', { path, text, reads: [path], writes: [path], requires: ['declared_prose_path'] }), admissibility: 'declared' }); }
  return steps;
}

function applies(contract: Contract, recipe: readonly MutationStep[], seed: CampaignSeed): boolean {
  if (!Object.hasOwn(seed.request.questions, contract.question)) return false;
  return recipe.every(witness => {
    if (!contract.mutations.includes(witness.operator)) return false;
    if (witness.question && witness.question !== contract.question) return false;
    return witness.operator !== 'choice_label_rename' || (contract.question === witness.question && contract.relation === 'equivariant' && !!contract.labelMapping);
  });
}
export interface CandidateSet { candidates: Candidate[]; invalid: number; noops: number; limited: number; witnesses: number; }
export function generateCandidateSet(config: CampaignConfig): CandidateSet {
  const candidates: Candidate[] = []; let invalid = 0, noops = 0, limited = 0, witnesses = 0;
  const inputs = config.seeds.map(seed => ({ seed, steps: generateSteps(seed, config.search.seed, config.contracts) }));
  witnesses = inputs.reduce((n, input) => n + input.steps.length, 0);
  const combinations = (n: number, k: number): number => { let result = 1; for (let i = 1; i <= k; i++) result = result * (n - i + 1) / i; return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(result))); };
  for (let depth = 1; depth <= Math.min(3, config.search.maxDepth); depth++) for (const { seed, steps } of inputs) {
    const visit = (start: number, recipe: MutationStep[]) => {
      if (candidates.length >= config.search.maxCandidates) { limited = Math.min(Number.MAX_SAFE_INTEGER, limited + combinations(steps.length - start, depth - recipe.length)); return; }
      if (recipe.length === depth) {
        const matching = config.contracts.filter(c => applies(c, recipe, seed));
        if (!matching.length) { invalid++; } else try { candidates.push(buildCandidate(seed, recipe, matching, config.policy, config.provider)); } catch (error) { if (error instanceof FuzzError && error.message.includes('no-op')) noops++; else invalid++; }
        return;
      }
      for (let i = start; i < steps.length; i++) visit(i + 1, [...recipe, steps[i]!]);
    };
    visit(0, []);
  }
  return { candidates, invalid, noops, limited, witnesses };
}
export function generateCandidates(config: CampaignConfig): Candidate[] { return generateCandidateSet(config).candidates; }
