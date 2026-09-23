import { createHash } from 'node:crypto';
import type { Contract, Policy } from './campaign-types.ts';

const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Hashes the exact JSON bytes sent to a provider; it deliberately does not parse or reorder them. */
export function wireHash(wire: string): string {
  return digest(wire);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}

/** Structural comparison aid only. Arrays remain ordered; use wireHash to prove replay bytes. */
export function contentHash(value: unknown): string {
  return digest(canonical(value));
}

export function contractHash(contracts: readonly Contract[]): string {
  return contentHash(contracts);
}

/** Deliberately receives only declared target configuration, never a provider credential. */
export function targetHash(request: unknown, policy?: Policy, adapter?: unknown): string {
  const target = request && typeof request === 'object' && !Array.isArray(request) && Object.hasOwn(request, 'questions')
    ? { model: (request as { model?: unknown }).model, questions: (request as { questions?: unknown }).questions }
    : request;
  return contentHash({ target, ...(policy === undefined ? {} : { policy }), ...(adapter === undefined ? {} : { adapter }) });
}
