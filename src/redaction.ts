import type { Candidate } from './campaign-types.ts';
import { parseBoundedJson } from './storage.ts';
import { contentHash, wireHash } from './identity.ts';
import { pathTokens, record } from './util.ts';

/** A redacted payload is a new value; its hash must never replace the original wire hash. */
export function redactCandidate(candidate: Candidate, paths: readonly string[]) {
  const redact = (payload: string, mutant: boolean) => {
    const value = parseBoundedJson(payload);
    for (const path of paths) {
      const tokens = pathTokens(path);
      if (mutant && tokens[0] === 'questions' && typeof tokens[1] === 'string') tokens[1] = Object.entries(candidate.questionMap).find(([, original]) => original === tokens[1])?.[0] ?? tokens[1];
      let node = value;
      for (const token of tokens.slice(0, -1)) { if (!node || typeof node !== 'object' || !Object.hasOwn(node, token)) { node = undefined; break; } node = (node as Record<string | number, unknown>)[token]; }
      const key = tokens[tokens.length - 1];
      if (node && typeof node === 'object' && key !== undefined && Object.hasOwn(node, key)) (node as Record<string | number, unknown>)[key] = '[REDACTED]';
    }
    return JSON.stringify(value);
  };
  const basePayload = redact(candidate.basePayload, false), mutantPayload = redact(candidate.mutantPayload, true);
  return { id: candidate.id, replayable: false, originalBaseWireHash: candidate.baseWireHash, originalMutantWireHash: candidate.mutantWireHash, redactedBaseHash: wireHash(basePayload), redactedMutantHash: wireHash(mutantPayload), basePayload, mutantPayload };
}
