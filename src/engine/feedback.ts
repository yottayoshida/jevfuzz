import type { Candidate, Contract, Policy, RelationObservation } from '../campaign-types.ts';
import type { JevAnswer, JevResponse } from '../types.ts';
import { jsDivergence } from '../compare.ts';
import { contentHash } from '../identity.ts';
import { evaluatePolicy, mappedResponse } from '../contracts/index.ts';

export interface Feedback { version: 'typed-v1'; signatures: string[]; margin: number; divergence: number; violation: boolean; families: string[]; pairBytes: number }
export const MARGIN_BUCKETS = Object.freeze([0, .05, .15, .3, 1]);
function topMargin(answer: JevAnswer): number {
  if (answer.type === 'noul') return Math.abs(answer.noul - .5);
  const p = Object.values(answer.probabilities).sort((a, b) => b - a);
  return Math.max(0, (p[0] ?? 1) - (p[1] ?? 0));
}
export function extractFeedback(candidate: Candidate, contracts: Contract[], base: JevResponse, mutant: JevResponse, relations: RelationObservation[], policy?: Policy): Feedback {
  const families = [...new Set(candidate.recipe.map(s => s.operator))].sort();
  const signatures: string[] = [];
  let margin = 1, divergence = 0;
  contracts.forEach((contract, index) => {
    const id = Object.entries(candidate.questionMap).find(([, original]) => original === contract.question)?.[0] ?? contract.question;
    const a = base.answers[contract.question], b = mutant.answers[id]; if (!a || !b) return;
    let m = topMargin(b), outcome: string | number = b.type === 'choice' ? b.choice : b.type === 'noul' ? b.noul >= .5 ? 'above' : 'below' : b.score;
    if (contract.projection === 'policy' && policy) { const projection = evaluatePolicy(mappedResponse(mutant, candidate), policy); m = projection.margin ?? m; outcome = projection.action; }
    margin = Math.min(margin, m);
    if (a.type !== 'noul' && b.type !== 'noul') {
      const labels = candidate.labelMaps[contract.question] ?? {};
      const mapped = Object.fromEntries(Object.entries(b.probabilities).map(([k, v]) => [labels[k] ?? k, v]));
      if (Object.keys(a.probabilities).every(k => Object.hasOwn(mapped, k))) divergence = Math.max(divergence, jsDivergence(a.probabilities, mapped));
    } else if (a.type === 'noul' && b.type === 'noul') divergence = Math.max(divergence, Math.abs(a.noul - b.noul));
    const bucket = Math.max(0, MARGIN_BUCKETS.findLastIndex(v => m >= v));
    signatures.push(contentHash({ version: 'typed-v1', target: candidate.targetHash, seed: candidate.seedId, question: contract.question, relation: contract.relation, outcome, marginBucket: bucket, families, depth: candidate.recipe.length, relationStatus: relations[index]?.status }));
  });
  return { version: 'typed-v1', signatures, margin, divergence, violation: relations.some(r => r.status === 'violates'), families, pairBytes: Buffer.byteLength(candidate.basePayload) + Buffer.byteLength(candidate.mutantPayload) };
}
