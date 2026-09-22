import { createHash, randomBytes } from 'node:crypto';

export class FuzzError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'FuzzError'; this.code = code; }
}
export const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const freshSeed = (): number => randomBytes(4).readUInt32LE();
export function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle<T>(values: readonly T[], random: () => number): T[] {
  const a = [...values];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new FuzzError('CONFIG', message);
}
export function integer(value: unknown, name: string, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  assert(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max, `${name} must be an integer in [${min}, ${max}]`);
  return value;
}
// A deliberately small JSONPath subset: own dot properties, bracket-quoted keys and indices.
export function pathTokens(path: string): string[] {
  assert(typeof path === 'string' && path.startsWith('$'), 'invalid JSON path');
  const tokens: string[] = [];
  let rest = path.slice(1);
  while (rest) {
    const match = /^(?:\.([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\])/.exec(rest);
    assert(match, 'unsupported JSON path; use own properties and array indices');
    const token = match[1] ?? match[2] ?? JSON.parse(match[3]!);
    assert(!['__proto__', 'prototype', 'constructor'].includes(token), 'unsafe JSON path');
    tokens.push(token); rest = rest.slice(match[0].length);
  }
  return tokens;
}
export function atPath(root: unknown, path: string): unknown {
  let value = root;
  for (const key of pathTokens(path)) {
    assert(value !== null && typeof value === 'object' && Object.hasOwn(value, key), 'JSON path does not exist');
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
export function setPath(root: unknown, path: string, value: unknown): void {
  const keys = pathTokens(path); const key = keys.pop();
  assert(key !== undefined, 'cannot replace root');
  let parent = root;
  for (const part of keys) parent = (parent as Record<string, unknown>)[part];
  Object.defineProperty(parent, key, { value, enumerable: true, writable: true, configurable: true });
}
