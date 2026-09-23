import { randomUUID } from 'node:crypto';
import type { Candidate, Confirmation, ConfirmationBlock, Contract, Finding, Observation, OracleConfig, Phase, Policy, ReducerConfig } from '../campaign-types.ts';
import { evaluateRelation } from '../contracts/index.ts';
import { contentHash, wireHash } from '../identity.ts';
import { assert, FuzzError, integer, rng, shuffle } from '../util.ts';
import type { BudgetLedger } from '../engine/budget.ts';
import type { ExecutionJournal } from '../engine/journal.ts';

export interface ConfirmationExecutor {
  evaluate(payload: string, phase: Phase, operationId?: string): Promise<Observation>;
  readonly modelChanged: boolean;
}
export interface TestSlot { id: string; kind: 'original' | 'shrink'; frozenHash: string; state: 'frozen' | 'complete' | 'inconclusive' }
export interface SlotSnapshot { original: number; shrink: number; slots: TestSlot[] }

export function validateOracle(profile: OracleConfig): void {
  assert(profile && ['paired-v1', 'fixed-stat-v1'].includes(profile.profile), 'unsupported oracle profile');
  assert(Object.keys(profile).every(key => ['profile','pairs','minimumSupport','maxControlViolationRate','minimumEffect','alpha','originalSlots','shrinkSlots'].includes(key)), 'unsupported oracle field');
  integer(profile.pairs, 'confirmation pairs', 1, 1023); integer(profile.originalSlots, 'original slots', 0, 10_000); integer(profile.shrinkSlots, 'shrink slots', 0, 10_000);
  for (const key of ['minimumSupport','maxControlViolationRate','minimumEffect','alpha'] as const) assert(typeof profile[key] === 'number' && Number.isFinite(profile[key]) && profile[key] >= 0 && profile[key] <= 1, 'invalid oracle threshold');
  assert(profile.minimumSupport > 0 && profile.alpha > 0, 'oracle support/alpha must be positive');
  assert(profile.profile !== 'fixed-stat-v1' || profile.originalSlots + profile.shrinkSlots > 0, 'fixed-stat-v1 requires reserved slots');
}

/** Each immutable slot spends its alpha once, including interruption and non-rejection. */
export class HypothesisSlots {
  readonly #slots: TestSlot[];
  readonly original: number;
  readonly shrink: number;
  constructor(oracle: OracleConfig, saved?: SlotSnapshot) {
    validateOracle(oracle);
    this.original = integer(oracle.originalSlots, 'original slots', 0, 10_000);
    this.shrink = integer(oracle.shrinkSlots, 'shrink slots', 0, 10_000);
    if (saved) assert(saved.original === this.original && saved.shrink === this.shrink, 'hypothesis family cannot change on resume');
    this.#slots = structuredClone(saved?.slots ?? []);
    assert(new Set(this.#slots.map(s => s.id)).size === this.#slots.length, 'duplicate hypothesis slot');
    for (const s of this.#slots) {
      assert(['original', 'shrink'].includes(s.kind) && ['frozen', 'complete', 'inconclusive'].includes(s.state) && /^[a-f0-9]{64}$/.test(s.frozenHash), 'invalid hypothesis slot');
      if (s.state === 'frozen') s.state = 'inconclusive';
    }
    assert(this.used('original') <= this.original && this.used('shrink') <= this.shrink, 'hypothesis slot budget exceeded');
  }
  get familySize(): number { return this.original + this.shrink; }
  remaining(kind: TestSlot['kind']): number { return this[kind] - this.used(kind); }
  freeze(kind: TestSlot['kind'], spec: unknown): TestSlot {
    if (this.remaining(kind) < 1) throw new FuzzError('SLOTS_EXHAUSTED', 'no unused hypothesis slot');
    const slot: TestSlot = { id: `${kind}-${this.used(kind) + 1}`, kind, frozenHash: contentHash(spec), state: 'frozen' };
    this.#slots.push(slot); return structuredClone(slot);
  }
  close(id: string, complete: boolean): void { const slot = this.#slots.find(s => s.id === id); assert(slot?.state === 'frozen', 'hypothesis slot already spent'); slot.state = complete ? 'complete' : 'inconclusive'; }
  snapshot(): SlotSnapshot { return structuredClone({ original: this.original, shrink: this.shrink, slots: this.#slots }); }
  private used(kind: TestSlot['kind']): number { return this.#slots.filter(s => s.kind === kind).length; }
}

/** Exact integer numerator for the one-sided paired binary (McNemar) tail. */
function pairedFraction(b: number, c: number): { numerator: bigint; denominator: bigint } {
  integer(b, 'discordant b', 0, 1023); integer(c, 'discordant c', 0, 1023);
  const n = b + c; assert(n <= 1023, 'exact test supports at most 1023 discordant pairs');
  if (n === 0 || b === 0) return { numerator: 1n, denominator: 1n };
  let choose = 1n, numerator = 0n;
  for (let j = 0; j <= n; j++) {
    if (j >= b) numerator += choose;
    if (j < n) choose = choose * BigInt(n - j) / BigInt(j + 1);
  }
  return { numerator, denominator: 1n << BigInt(n) };
}
/** A rounded display value; rejection uses the integer fraction below. */
export function exactPairedTail(b: number, c: number): number { const { numerator, denominator } = pairedFraction(b, c); return Number(numerator) / Number(denominator); }
/** Compare the exact tail against the user-facing decimal alpha / K without floating rounding. */
export function pairedTailRejects(b: number, c: number, alpha: number, familySize: number): boolean {
  assert(Number.isFinite(alpha) && alpha > 0 && alpha <= 1, 'invalid alpha'); integer(familySize, 'family size', 1, 20_000);
  const [mantissa, exponent = '0'] = alpha.toString().split('e');
  const decimal = mantissa!.split('.'), scale = (decimal[1]?.length ?? 0) - Number(exponent);
  let numerator = BigInt(decimal.join('')), denominator = 1n;
  if (scale >= 0) denominator = 10n ** BigInt(scale); else numerator *= 10n ** BigInt(-scale);
  const p = pairedFraction(b, c);
  return p.numerator * denominator * BigInt(familySize) <= numerator * p.denominator;
}
export function confirmationCost(profile: OracleConfig): number { return 3 * integer(profile.pairs, 'confirmation pairs', 1, 1023); }

export function summarizeConfirmation(candidate: Candidate, contract: Contract, profile: OracleConfig, signature: string, blocks: ConfirmationBlock[], options: { phase?: Phase; slotId?: string; incomplete?: string; discoverySamples?: number; policy?: Policy } = {}): Confirmation {
  validateOracle(profile);
  confirmationCost(profile);
  assert(profile.minimumSupport > 0 && profile.minimumSupport <= 1 && profile.minimumEffect >= 0 && profile.minimumEffect <= 1 && profile.maxControlViolationRate >= 0 && profile.maxControlViolationRate <= 1 && profile.alpha > 0 && profile.alpha <= 1, 'invalid oracle thresholds');
  blocks = blocks.map(block => ({ ...block,
    violation: evaluateRelation(candidate, contract, block.a.response, block.b.response, options.policy),
    sham: evaluateRelation({}, contract, block.a.response, block.control.response, options.policy) }));
  const expectedPhase = options.phase ?? 'confirmation';
  const samples = blocks.flatMap(block => [block.a, block.control, block.b]);
  const models = [...new Set(samples.map(sample => sample.observedModel))];
  const assumptions = ['Valid user-declared input relation', 'A/A′/B blocks are independent and stationary', 'Provider cache metadata is not evidence of factual correctness'];
  if (samples.some(sample => sample.cache === 'unknown')) assumptions.push('Provider-side cache freshness and independence are unverified; this empirical result records repeated new calls only.');
  const support = blocks.filter(block => block.violation.status === 'violates' && block.violation.signature === signature && (contract.minimumEffect === undefined || Math.abs(block.violation.effect ?? 1) >= contract.minimumEffect)).length;
  const controlViolations = blocks.filter(block => block.sham.status === 'violates').length;
  const effect = blocks.length ? (support - controlViolations) / blocks.length : 0;
  const familySize = profile.profile === 'fixed-stat-v1' ? profile.originalSlots + profile.shrinkSlots : 0;
  const result: Confirmation = { verdict: 'INCONCLUSIVE', reason: 'INSUFFICIENT_OBSERVATIONS', signature,
    evidenceLevel: profile.profile === 'fixed-stat-v1' ? 'statistical' : 'empirical', profileVersion: profile.profile,
    discoverySamples: options.discoverySamples ?? 0, confirmationSamples: samples.length, controls: blocks.length,
    support, controlViolations, effect, familySize, adjustment: familySize ? 'bonferroni' : 'none',
    ...(options.slotId ? { slotId: options.slotId } : {}), assumptions, blocks, observedModels: models };
  if (options.incomplete) { result.reason = options.incomplete; return result; }
  if (blocks.length !== profile.pairs) return result;
  if (samples.some(sample => sample.phase !== expectedPhase) || new Set(samples.map(sample => sample.id)).size !== samples.length || new Set(samples.map(sample => sample.operationId)).size !== samples.length) { result.reason = 'NON_FRESH_OBSERVATIONS'; return result; }
  if (blocks.some(block => block.a.wireHash !== candidate.baseWireHash || block.control.wireHash !== candidate.baseWireHash || block.b.wireHash !== candidate.mutantWireHash)) { result.reason = 'PAYLOAD_CHANGED'; return result; }
  if (models.length !== 1 || samples.some(sample => sample.response.model !== sample.observedModel) || new Set(samples.map(sample => sample.provider)).size !== 1) { result.reason = 'COHORT_CHANGED'; return result; }
  if (samples.some(sample => sample.cache === 'cached')) { result.reason = 'CACHED_OBSERVATION'; return result; }
  if (blocks.some(block => block.violation.status === 'unknown' || block.sham.status === 'unknown')) { result.reason = 'RELATION_UNKNOWN'; return result; }
  if (candidate.admissibility === 'hypothesis' || contract.admissibility === 'hypothesis') { result.reason = 'HYPOTHESIS_ONLY'; return result; }
  if (controlViolations / blocks.length > profile.maxControlViolationRate) { result.reason = 'CONTROL_UNSTABLE'; return result; }
  if (profile.profile === 'fixed-stat-v1') {
    if (contract.relation === 'directional') { result.reason = 'UNSUPPORTED_STATISTICAL_RELATION'; return result; }
    if (!options.slotId || familySize <= 0) { result.reason = 'HYPOTHESIS_SLOT_MISSING'; return result; }
    if (samples.some(sample => sample.cache !== 'fresh' || sample.transportUncertain)) { result.reason = 'FRESHNESS_UNVERIFIED'; return result; }
    const b = blocks.filter(block => block.violation.status === 'violates' && block.violation.signature === signature && block.sham.status === 'holds').length;
    const c = blocks.filter(block => !(block.violation.status === 'violates' && block.violation.signature === signature) && block.sham.status === 'violates').length;
    result.pValue = exactPairedTail(b, c); result.alpha = profile.alpha / familySize;
    result.verdict = pairedTailRejects(b, c, profile.alpha, familySize) && effect >= profile.minimumEffect && support > 0 ? 'FAIL' : 'NO_CONFIRMED_VIOLATION';
    result.reason = result.verdict === 'FAIL' ? 'FIXED_STAT_CONFIRMED' : 'NULL_NOT_REJECTED';
  } else {
    result.verdict = support / blocks.length >= profile.minimumSupport && effect >= profile.minimumEffect && support > 0 ? 'FAIL' : 'PASS';
    if (result.verdict === 'PASS' && blocks.some(block => block.violation.status === 'violates')) { result.verdict = 'INCONCLUSIVE'; result.reason = 'VIOLATION_NOT_REPRODUCED'; }
    else result.reason = result.verdict === 'FAIL' ? 'PAIRED_CONFIRMED' : 'NO_VIOLATION_OBSERVED';
  }
  return result;
}

export async function confirmCandidate(candidate: Candidate, contract: Contract, executor: ConfirmationExecutor, profile: OracleConfig, options: {
  signature: string; seed: number; phase?: 'confirmation' | 'final-confirmation'; policy?: Policy;
  ledger?: BudgetLedger; slots?: HypothesisSlots; journal?: ExecutionJournal; discoverySamples?: number;
}): Promise<Confirmation> {
  const phase = options.phase ?? 'confirmation', blocks: ConfirmationBlock[] = [];
  validateOracle(profile);
  assert(profile.profile !== 'fixed-stat-v1' || contract.relation !== 'directional', 'fixed-stat-v1 excludes directional relations');
  assert(candidate.baseWireHash === wireHash(candidate.basePayload) && candidate.mutantWireHash === wireHash(candidate.mutantPayload), 'candidate wire hash mismatch');
  const frozen = structuredClone({ candidate, contract, profile, signature: options.signature });
  const summarize = (incomplete?: string, slotId?: string) => summarizeConfirmation(frozen.candidate, frozen.contract, frozen.profile, frozen.signature, blocks, { phase, slotId, incomplete, discoverySamples: options.discoverySamples, policy: options.policy });
  if (candidate.admissibility === 'hypothesis' || contract.admissibility === 'hypothesis') return summarize('HYPOTHESIS_ONLY');
  if (options.ledger && !options.ledger.canReserve(phase, confirmationCost(profile))) return summarize('CONFIRMATION_BUDGET_UNAVAILABLE');
  let slot: TestSlot | undefined;
  if (profile.profile === 'fixed-stat-v1') {
    assert(options.slots, 'fixed-stat-v1 requires a frozen hypothesis family');
    try { slot = options.slots.freeze(phase === 'final-confirmation' ? 'shrink' : 'original', frozen); }
    catch (error) { if (error instanceof FuzzError && error.code === 'SLOTS_EXHAUSTED') return summarize('SLOTS_EXHAUSTED'); throw error; }
    await options.journal?.append('slot-frozen', slot);
  }
  await options.journal?.append('confirmation-frozen', { candidateId: candidate.id, contractId: contract.id, signature: options.signature, phase, profile, slot, pairHash: contentHash([candidate.baseWireHash, candidate.mutantWireHash]) });
  const random = rng(options.seed), experiment = randomUUID();
  let incomplete: string | undefined;
  try {
    for (let i = 0; i < profile.pairs; i++) {
      const observations: Partial<Record<'a' | 'control' | 'b', Observation>> = {};
      for (const side of shuffle(['a', 'control', 'b'] as const, random)) {
        observations[side] = await executor.evaluate(side === 'b' ? frozen.candidate.mutantPayload : frozen.candidate.basePayload, phase, `${experiment}-${i}-${side}`);
      }
      const { a, control, b } = observations;
      assert(a && control && b, 'incomplete triple');
      const block: ConfirmationBlock = { a, control, b,
        violation: evaluateRelation(frozen.candidate, frozen.contract, a.response, b.response, options.policy),
        sham: evaluateRelation({}, frozen.contract, a.response, control.response, options.policy) };
      blocks.push(block);
      await options.journal?.append('confirmation-block', { experiment, index: i, block });
      if (executor.modelChanged) { incomplete = 'COHORT_CHANGED'; break; }
    }
  } catch (error) {
    const code = error instanceof FuzzError ? error.code : 'RUNTIME';
    const safe = new Set(['BUDGET', 'DEADLINE', 'PROVIDER_ABORTED', 'PROVIDER_RESPONSE', 'PROVIDER_HTTP', 'PROVIDER_TIMEOUT', 'PROVIDER_NETWORK', 'STORAGE_LIMIT']);
    incomplete = `INCOMPLETE_${safe.has(code) ? code : 'RUNTIME'}`;
  }
  const result = summarize(incomplete, slot?.id);
  if (slot) { options.slots!.close(slot.id, blocks.length === profile.pairs && !incomplete); await options.journal?.append('slot-closed', { id: slot.id, complete: blocks.length === profile.pairs && !incomplete }); }
  return result;
}

export function createFinding(candidate: Candidate, contract: Contract, oracle: OracleConfig, confirmation: Confirmation, settings: { provider: Finding['provider']; policy?: Policy; reducers: ReducerConfig; parentFindingId?: string }): Finding {
  const phase = confirmation.blocks[0]?.a.phase;
  assert(phase === 'confirmation' || phase === 'final-confirmation', 'finding requires formal confirmation');
  const verified = summarizeConfirmation(candidate, contract, oracle, confirmation.signature, confirmation.blocks, { phase, slotId: confirmation.slotId, discoverySamples: confirmation.discoverySamples, policy: settings.policy });
  assert(confirmation.verdict === 'FAIL' && verified.verdict === 'FAIL', 'finding requires complete fresh confirmation');
  const fingerprint = contentHash({ target: candidate.targetHash, contract, signature: confirmation.signature, families: [...new Set(candidate.recipe.map(step => step.operator))].sort() });
  // Findings are JSON artifacts even when passed directly between library APIs.
  // Canonicalize optional undefined fields and shared internal evidence here so
  // saveFinding/corpus receive the same shape as a freshly read artifact.
  return JSON.parse(JSON.stringify({ version: 2, kind: 'finding', id: contentHash({ fingerprint, observations: confirmation.blocks.flatMap(b => [b.a.id, b.control.id, b.b.id]) }).slice(0, 24), candidate, contract, oracle, confirmation: verified, ...settings, fingerprint, replayability: 'full' })) as Finding;
}
