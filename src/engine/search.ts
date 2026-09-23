import type { Candidate, SearchConfig } from '../campaign-types.ts';
import type { Feedback } from './feedback.ts';
import { contentHash } from '../identity.ts';
import { assert, rng, shuffle } from '../util.ts';

export interface SearchSnapshot {
  version: 'batch-v2'; batch: number; stagnation: number; remaining: string[];
  evaluated: string[]; features: [string, Feedback][]; signatures: [string, { observations: number; candidateId: string; bytes: number }][];
}
/** Batch selection is independent of worker completion order; commit() sorts IDs. */
export class BatchScheduler {
  readonly #config: SearchConfig;
  readonly #candidates: Map<string, Candidate>;
  readonly #features = new Map<string, Feedback>();
  readonly #signatures = new Map<string, { observations: number; candidateId: string; bytes: number }>();
  #remaining: string[];
  #evaluated: string[] = [];
  #batch = 0;
  #stagnation = 0;
  constructor(candidates: Candidate[], config: SearchConfig, restored?: SearchSnapshot) {
    this.#config = config; this.#candidates = new Map(candidates.map(c => [c.id, c]));
    assert(this.#candidates.size === candidates.length, 'candidate IDs must be unique');
    assert(candidates.length <= config.maxCandidates, 'candidate limit exceeded');
    assert(candidates.reduce((n, c) => n + Buffer.byteLength(JSON.stringify(c)), 0) <= config.maxQueueBytes, 'queue byte limit exceeded');
    this.#remaining = candidates.map(c => c.id);
    if (restored) {
      assert(restored.version === 'batch-v2', 'scheduler version mismatch');
      const partition = [...restored.remaining, ...restored.evaluated];
      assert(partition.length === candidates.length && partition.every(id => this.#candidates.has(id)) && new Set(partition).size === candidates.length, 'scheduler candidate set mismatch');
      assert(Number.isSafeInteger(restored.batch) && restored.batch >= 0 && Number.isSafeInteger(restored.stagnation) && restored.stagnation >= 0, 'invalid scheduler counters');
      assert(restored.features.every(([id]) => restored.evaluated.includes(id)) && new Set(restored.features.map(([id]) => id)).size === restored.features.length, 'invalid scheduler features');
      this.#remaining = [...restored.remaining]; this.#evaluated = [...restored.evaluated]; this.#batch = restored.batch; this.#stagnation = restored.stagnation;
      for (const [id, feature] of restored.features) this.#features.set(id, feature);
      for (const [signature, value] of restored.signatures) this.#signatures.set(signature, value);
    }
  }
  get exhausted(): boolean { return this.#remaining.length === 0; }
  get stagnant(): boolean { return this.#config.stagnationBatches > 0 && this.#stagnation >= this.#config.stagnationBatches; }
  get observedSignatures(): number { return this.#signatures.size; }
  get stableCorpus(): { signature: string; candidateId: string }[] { return [...this.#signatures].filter(([, value]) => value.observations >= 2).map(([signature, value]) => ({ signature, candidateId: value.candidateId })); }
  nextBatch(limit = this.#config.batchSize): Candidate[] {
    const random = rng((this.#config.seed + Math.imul(this.#batch, 0x9e3779b9)) >>> 0);
    // Evaluate single operators first; all strategies use the same bounded space.
    const minDepth = Math.min(...this.#remaining.map(id => this.#candidates.get(id)!.recipe.length));
    const queue = this.#remaining.filter(id => this.#candidates.get(id)!.recipe.length === minDepth).map(id => this.#candidates.get(id)!);
    const uniform = shuffle([...queue].sort((a, b) => a.id.localeCompare(b.id)), random);
    const familyCounts = new Map<string, number>(), selected: Candidate[] = [];
    const append = (candidate: Candidate) => {
      const family = candidate.recipe.map(step => step.operator).join('+');
      if (selected.length < limit && !selected.some(c => c.id === candidate.id) && (familyCounts.get(family) ?? 0) < this.#config.familyQuota) { selected.push(candidate); familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1); }
    };
    const strategy = this.#config.strategy;
    if (strategy === 'uniform') uniform.forEach(append);
    else if (strategy === 'enumerator') queue.forEach(append);
    else {
      const quota = Math.min(limit, Math.ceil(limit * this.#config.uniformFraction));
      uniform.slice(0, quota).forEach(append);
      const scores = queue.map(candidate => ({ candidate, ...this.prior(candidate) }));
      const ranks = Object.fromEntries((['novelty', 'boundary', 'divergence'] as const).map(field => {
        const values = [...new Set(scores.map(item => item[field]))].sort((a, b) => b - a);
        const denominator = values.length - 1;
        return [field, new Map(scores.map(item => [item.candidate.id, denominator === 0 ? 0 : 1 - (values.indexOf(item[field]) / denominator)]))];
      })) as Record<'novelty' | 'boundary' | 'divergence', Map<string, number>>;
      const rank = (field: 'novelty' | 'boundary' | 'divergence', id: string) => ranks[field].get(id)!;
      const score = (candidate: Candidate) => strategy === 'novelty' ? rank('novelty', candidate.id) : strategy === 'boundary' ? rank('boundary', candidate.id) : 3 * rank('novelty', candidate.id) + 2 * rank('boundary', candidate.id) + rank('divergence', candidate.id);
      queue.sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id)).forEach(append);
    }
    // Quotas constrain one batch, never silently remove candidates.
    return selected;
  }
  commit(results: { candidateId: string; feedback: Feedback; repeated?: boolean; confirmed?: boolean }[]): void {
    let novel = false;
    for (const result of [...results].sort((a, b) => a.candidateId.localeCompare(b.candidateId))) {
      assert(this.#remaining.includes(result.candidateId), 'feedback already committed or unknown candidate');
      this.#features.set(result.candidateId, structuredClone(result.feedback));
      this.#remaining = this.#remaining.filter(id => id !== result.candidateId); this.#evaluated.push(result.candidateId);
      for (const signature of result.feedback.signatures) {
        const before = this.#signatures.get(signature);
        if (!before || result.feedback.pairBytes < before.bytes) novel = true;
        // A different input with the same signature is not repeat evidence of this candidate.
        const observations = result.repeated || result.confirmed ? 2 : before?.candidateId === result.candidateId ? before.observations : 1;
        if (!before || result.feedback.pairBytes < before.bytes || observations > before.observations) this.#signatures.set(signature, { observations, candidateId: result.candidateId, bytes: result.feedback.pairBytes });
      }
    }
    this.#batch++; this.#stagnation = novel ? 0 : this.#stagnation + 1;
  }
  snapshot(): SearchSnapshot { return structuredClone({ version: 'batch-v2', batch: this.#batch, stagnation: this.#stagnation, remaining: this.#remaining, evaluated: this.#evaluated, features: [...this.#features], signatures: [...this.#signatures] }); }
  private prior(candidate: Candidate): { novelty: number; boundary: number; divergence: number } {
    const prefix = contentHash(candidate.recipe.slice(0, -1));
    const parent = [...this.#features].find(([id]) => { const c = this.#candidates.get(id)!; return c.seedId === candidate.seedId && contentHash(c.recipe) === prefix; })?.[1];
    const families = new Set(candidate.recipe.map(s => s.operator));
    const interactionSeen = [...this.#features.values()].some(f => families.size === f.families.length && f.families.every(family => families.has(family as Candidate['recipe'][number]['operator'])));
    return { novelty: interactionSeen ? 0 : 1, boundary: parent ? 1 - parent.margin : 0, divergence: parent?.divergence ?? 0 };
  }
}
