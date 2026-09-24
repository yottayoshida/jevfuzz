import { basename } from 'node:path';
import type { FuzzCase, FuzzConfig, Invariant, JevRequest, MutationConfig, Thresholds } from './types.ts';
import { assert, atPath, FuzzError, integer, pathTokens, record } from './util.ts';
import { boundedJson, canonicalJson, readJson } from './storage.ts';

export const DEFAULT_THRESHOLDS: Thresholds = {
  noulBaselineRange: 0.10, scoreBaselineRange: 0.35, noulThreshold: 0.5,
  noulMinDelta: 0.15, scoreDelta: 0.5, jsDivergence: 0.15,
  confidenceDrop: 0.30, noulProbabilityShift: 0.20,
};
function keys(value: Record<string, unknown>, allowed: string[], where: string): void {
  assert(Object.keys(value).every(k => allowed.includes(k)), `unsupported field in ${where}`);
}
function content(value: unknown, nullable = false): boolean {
  return (nullable && value === null) || typeof value === 'string' || Array.isArray(value) || record(value);
}
export function validateRequest(value: unknown): JevRequest {
  value = canonicalJson(value);
  assert(record(value), 'request must be an object');
  keys(value, ['state', 'model', 'questions'], 'request');
  assert(content(value.state), 'state must be string, object or array');
  assert(typeof value.model === 'string' && value.model.length > 0, 'model is required');
  assert(record(value.questions) && Object.keys(value.questions).length > 0, 'questions must contain at least one entry');
  for (const question of Object.values(value.questions)) {
    assert(record(question), 'question must be an object');
    keys(question, ['type', 'instructions', 'criteria'], 'question');
    assert(content(question.instructions), 'instructions must be string, object or array');
    if (question.type === 'choice') {
      assert(record(question.criteria), 'Choice criteria must be an object');
      const options = Object.values(question.criteria);
      assert(options.length >= 1 && options.length <= 255 && options.every(v => content(v, true)), 'Choice requires 1–255 content options');
    } else if (question.type === 'score') {
      assert(Array.isArray(question.criteria) && question.criteria.length >= 2 && question.criteria.length <= 10 && question.criteria.every(v => content(v)), 'Score requires 2–10 ordered content levels');
    } else if (question.type === 'noul') {
      if (question.criteria !== undefined) {
        assert(record(question.criteria), 'Noul criteria must be an object');
        keys(question.criteria, ['true', 'false'], 'Noul criteria');
        assert(Object.values(question.criteria).every(v => content(v)), 'invalid Noul criterion');
      }
    } else assert(false, 'unsupported question type');
  }
  return value as unknown as JevRequest;
}
export function thresholds(invariant: Invariant = {}): Thresholds {
  assert(record(invariant), 'invariant must be an object');
  keys(invariant, ['type', ...Object.keys(DEFAULT_THRESHOLDS)], 'invariant');
  const result = { ...DEFAULT_THRESHOLDS };
  for (const key of Object.keys(DEFAULT_THRESHOLDS) as (keyof Thresholds)[]) {
    if (invariant[key] === undefined) continue;
    const value = invariant[key];
    const max = key === 'scoreBaselineRange' || key === 'scoreDelta' ? 9 : 1;
    assert(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max, 'invalid invariant threshold');
    assert(!['scoreDelta', 'noulMinDelta'].includes(key) || value > 0, 'hard delta must be positive');
    result[key] = value;
  }
  return result;
}
export function declaredContentPath(path: string): void {
  const parts = pathTokens(path);
  assert(parts[0] === 'state' || (parts[0] === 'questions' && parts.length >= 3 && ['instructions', 'criteria'].includes(parts[2]!)), 'mutation path must address decision content');
}
function mutations(raw: unknown, request: JevRequest): MutationConfig {
  const value = raw ?? {};
  assert(record(value), 'mutations must be an object');
  keys(value, ['builtin', 'unorderedArrays', 'irrelevantFields', 'prosePaths'], 'mutations');
  assert(value.builtin === undefined || typeof value.builtin === 'boolean', 'builtin must be boolean');
  const arrays = value.unorderedArrays ?? [], fields = value.irrelevantFields ?? [], prose = value.prosePaths ?? [];
  assert(Array.isArray(arrays) && Array.isArray(fields) && Array.isArray(prose), 'mutation declarations must be arrays');
  for (const path of arrays) {
    assert(typeof path === 'string', 'array path must be string'); declaredContentPath(path);
    const parts = pathTokens(path);
    assert(!(parts[0] === 'questions' && parts[2] === 'criteria' && parts.length === 3 && request.questions[parts[1]!]!.type === 'score'), 'Score levels are ordered');
    assert(Array.isArray(atPath(request, path)), 'unordered array path must resolve to an array');
  }
  for (const f of fields) {
    assert(record(f), 'irrelevant field declaration must be an object');
    keys(f, ['path', 'field', 'values'], 'irrelevant field');
    assert(typeof f.path === 'string' && typeof f.field === 'string' && f.field.length > 0, 'invalid irrelevant field');
    declaredContentPath(f.path);
    const parts = pathTokens(f.path);
    assert(!(parts[0] === 'questions' && parts[2] === 'criteria' && parts.length === 3), 'cannot inject a criterion');
    const target = atPath(request, f.path);
    assert(record(target) && !Object.hasOwn(target, f.field), 'irrelevant field must be new on an object');
    assert(!['__proto__', 'prototype', 'constructor'].includes(f.field), 'unsafe irrelevant field');
    assert(Array.isArray(f.values) && f.values.length > 0, 'irrelevant field requires values');
  }
  for (const path of prose) {
    assert(typeof path === 'string', 'prose path must be string'); declaredContentPath(path);
    assert(typeof atPath(request, path) === 'string', 'prose path must resolve to text');
  }
  return { builtin: value.builtin ?? true, unorderedArrays: arrays, irrelevantFields: fields, prosePaths: prose } as MutationConfig;
}
export function parseConfig(value: unknown, filename = 'request.json'): FuzzConfig {
  value = canonicalJson(value, 64, 100_000);
  assert(record(value), 'configuration must be an object');
  if (!Object.hasOwn(value, 'version') && !Object.hasOwn(value, 'cases')) {
    const request = validateRequest(value);
    return { version: 1, name: basename(filename), cases: [{ id: basename(filename), request, baselineRuns: 3, mutations: mutations(undefined, request), invariants: {} }] };
  }
  assert(value.version === 1, 'unsupported schema version');
  keys(value, ['version', 'name', 'model', 'baseline', 'cases'], 'configuration');
  assert(typeof value.name === 'string' && value.name.length > 0, 'configuration name required');
  if (value.baseline !== undefined) { assert(record(value.baseline), 'invalid baseline'); keys(value.baseline, ['runs'], 'baseline'); }
  const runs = integer((value.baseline as Record<string, unknown> | undefined)?.runs ?? 3, 'baseline runs', 2);
  assert(Array.isArray(value.cases) && value.cases.length > 0, 'cases must not be empty');
  const ids = new Set<string>();
  const cases: FuzzCase[] = value.cases.map(c => {
    assert(record(c), 'case must be object'); keys(c, ['id', 'request', 'mutations', 'invariants'], 'case');
    assert(typeof c.id === 'string' && c.id.length > 0 && !ids.has(c.id), 'case ID missing or duplicate'); ids.add(c.id);
    assert(record(c.request), 'case request required');
    const request = validateRequest({ ...c.request, model: c.request.model ?? value.model });
    const invariants = c.invariants ?? {};
    assert(record(invariants), 'invariants must be an object');
    for (const [id, invariant] of Object.entries(invariants)) {
      assert(Object.hasOwn(request.questions, id) && record(invariant), 'invariant must refer to a question');
      thresholds(invariant);
      assert(invariant.type === undefined || invariant.type === `${request.questions[id]!.type}_stable`, 'invariant type must match question');
    }
    return { id: c.id, request, baselineRuns: runs, mutations: mutations(c.mutations, request), invariants: invariants as Record<string, Invariant> };
  });
  return { version: 1, name: value.name, cases };
}
/** Revalidates direct library configs before mutation generation or report serialization. */
export function validateFuzzConfig(value: unknown): FuzzConfig {
  const clean = canonicalJson(value);
  assert(record(clean) && clean.version === 1 && typeof clean.name === 'string' && clean.name.length > 0 && Array.isArray(clean.cases) && clean.cases.length > 0, 'invalid fuzz configuration');
  keys(clean, ['version', 'name', 'cases'], 'configuration');
  const ids = new Set<string>();
  const cases: FuzzCase[] = clean.cases.map(entry => {
    assert(record(entry), 'invalid fuzz case');
    keys(entry, ['id', 'request', 'baselineRuns', 'mutations', 'invariants'], 'case');
    assert(typeof entry.id === 'string' && entry.id.length > 0 && !ids.has(entry.id), 'case ID missing or duplicate');
    ids.add(entry.id);
    const request = validateRequest(entry.request);
    const baselineRuns = integer(entry.baselineRuns, 'baseline runs', 2);
    const mutationConfig = mutations(entry.mutations, request);
    assert(record(entry.invariants), 'invariants must be an object');
    for (const [id, invariant] of Object.entries(entry.invariants)) {
      assert(Object.hasOwn(request.questions, id) && record(invariant), 'invariant must refer to a question');
      thresholds(invariant);
      assert(invariant.type === undefined || invariant.type === `${request.questions[id]!.type}_stable`, 'invariant type must match question');
    }
    return { id: entry.id, request, baselineRuns, mutations: mutationConfig, invariants: entry.invariants as Record<string, Invariant> };
  });
  return { version: 1, name: clean.name, cases };
}
export async function loadConfig(filename: string): Promise<FuzzConfig> {
  let value: unknown;
  try { value = await readJson(filename, 1_000_000); }
  catch { throw new FuzzError('CONFIG', 'cannot read valid JSON configuration'); }
  return parseConfig(value, filename);
}
