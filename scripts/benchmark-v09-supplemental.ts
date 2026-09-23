/**
 * Supplemental fixed-stat and shrink protocol checks.  This module deliberately
 * uses the public candidate, confirmation, and shrink APIs: it is not a second
 * implementation of their decision rules.
 */
import { createHash } from 'node:crypto';
import { BudgetLedger } from '../src/engine/budget.ts';
import { EvaluationBroker } from '../src/engine/broker.ts';
import { buildCandidate } from '../src/mutators/index.ts';
import { HypothesisSlots, confirmCandidate, createFinding } from '../src/oracles/index.ts';
import { FakeProvider } from '../src/provider.ts';
import { shrinkFinding } from '../src/shrink/index.ts';
import type { CampaignSeed, Contract, Finding, MutationStep, OracleConfig, ReducerConfig } from '../src/campaign-types.ts';
import type { JevRequest, JevResponse } from '../src/types.ts';

export interface NullSuiteOptions { campaigns: number; pairs: number; alpha: number }
export interface NullTrial { campaign: number; source: 'injected-diagnostic-seed'; original: unknown[]; shrink: unknown[]; falseFail: boolean; adaptiveFinalConfirmations: number; slots: unknown }
export interface NullSuiteResult { trials: NullTrial[]; falseFails: number; originalSlots: 5; shrinkSlots: 5; adaptiveFinalConfirmations: number; adaptiveFinalCoverage: number; campaigns: number; pairs: number; alpha: number }
export interface KnownMinimumTrial { fixture: string; status: string; passed: boolean; initial: number[]; final: number[]; accepted: number; history: unknown[]; expected: unknown; actual: unknown }
export interface KnownMinimumResult { trials: KnownMinimumTrial[]; passed: boolean }

const reducers: ReducerConfig = { independentQuestions: true, optionalStatePaths: ['$.state.optional'], unorderedArrayPaths: ['$.state.optional.tags'], prosePaths: ['$.state.optional.note'] };
const contract: Contract = { id: 'route-invariant', question: 'route', relation: 'invariant', projection: 'choice', mutations: ['question_id_rename', 'irrelevant_field_injection'], admissibility: 'declared', assumptions: ['Injected diagnostic benchmark source only.'], required: true };
const diagnosticSignature = JSON.stringify(['relation-v1', contract.id, contract.question, contract.relation, contract.projection, 'label', 'billing', 'general']);
const step = (field: string, value: string): MutationStep => ({ operator: 'irrelevant_field_injection', version: '1', admissibility: 'declared', path: '$.state', field, value, reads: ['$.state'], writes: ['$.state'], requires: ['declared_irrelevant_field'], invalidates: [] });

function profile(pairs: number, alpha: number): OracleConfig {
  return { profile: 'fixed-stat-v1', pairs, minimumSupport: .75, maxControlViolationRate: .125, minimumEffect: 0, alpha, originalSlots: 5, shrinkSlots: 5 };
}
function seed(id: string): CampaignSeed {
  const fixture = Number(id.match(/(\d+)$/)?.[1] ?? 0), independentCount = fixture % 3 + 1;
  const questions: JevRequest['questions'] = { route: { type: 'choice', instructions: 'Route.', criteria: { billing: 'Billing', general: 'General' } } };
  for (let index = 0; index < independentCount; index++) questions[`independent_${index}`] = { type: 'choice', instructions: `Independent ${index}.`, criteria: { billing: 'Billing', general: 'General' } };
  return { id, source: 'injected-diagnostic-seed', request: { model: 'benchmark', state: { optional: { note: ` optional diagnostic text ${'x'.repeat(fixture + 1)} `, tags: Array.from({ length: fixture % 4 + 2 }, (_, index) => String(index)) } }, questions }, mutations: { builtin: false, unorderedArrays: [], irrelevantFields: [], prosePaths: [] } };
}
function answer(request: JevRequest, route: string): JevResponse {
  return { model: 'benchmark-null-v1', answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id, { type: 'choice', choice: id === 'route' ? route : Object.keys(q.type === 'choice' ? q.criteria : {})[0]!, confidence: 1, probabilities: { billing: route === 'billing' ? 1 : 0, general: route === 'general' ? 1 : 0 } }])), usage: { input_tokens: 0, output_tokens: 0 } };
}
/** A deterministic PRNG stream is fresh on every provider call and never reads the input. */
function independentNullProvider(salt: number): FakeProvider {
  let state = (salt >>> 0) || 1;
  // The benchmark's frozen Mulberry32 stream: additive increment per draw.
  const draw = () => { state = (state + 0x6d2b79f5) >>> 0; let value = state; value = Math.imul(value ^ value >>> 15, value | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) & 1; };
  return new FakeProvider((request) => answer(request, draw() ? 'billing' : 'general'));
}
const digest = (value: readonly string[]) => createHash('sha256').update(value.join('\n')).digest('hex');
function confirmationSummary(value: any) { const ids = value.blocks.flatMap((block: any) => [block.a.id, block.control.id, block.b.id]); return { verdict: value.verdict, reason: value.reason, pValue: value.pValue, support: value.support, controlViolations: value.controlViolations, familySize: value.familySize, slotId: value.slotId, observations: ids.length, uniqueObservationIds: new Set(ids).size, observationIdsHash: digest(ids) }; }
function lexicographicallySmaller(next: number[], previous: number[]): boolean { for (let index = 0; index < next.length; index++) { if (next[index]! < previous[index]!) return true; if (next[index]! > previous[index]!) return false; } return false; }
function diagnosticProvider(_candidateMutantPayload: string): FakeProvider {
  return new FakeProvider((request) => answer(request, Object.keys(request.state as Record<string, unknown>).some(key => key.startsWith('diagnostic_')) ? 'general' : 'billing'));
}
function ledger(pairs: number, shrink = 0, final = 0): BudgetLedger {
  const confirmation = 3 * pairs * 5;
  return new BudgetLedger({ logicalRequests: confirmation + shrink + final + 32, httpAttempts: 0, wallTimeSeconds: 60, discoveryRequests: 0, confirmationRequests: confirmation, shrinkRequests: shrink, finalConfirmationRequests: final });
}
async function diagnosticFinding(pairs: number, alpha: number, fixture = 'diagnostic'): Promise<Finding> {
  const candidate = buildCandidate(seed(fixture), [step('diagnostic_a', 'a'), step('diagnostic_b', 'b'), step('diagnostic_c', 'c')], [contract], undefined, 'custom');
  const oracle = profile(pairs, alpha), slots = new HypothesisSlots(oracle), budget = ledger(pairs);
  const confirmation = await confirmCandidate(candidate, contract, new EvaluationBroker(diagnosticProvider(candidate.mutantPayload), budget, { strict: true, providerName: 'injected-diagnostic' }), oracle, { signature: diagnosticSignature, seed: 19, ledger: budget, slots });
  if (confirmation.verdict !== 'FAIL') throw new Error(`diagnostic seed did not confirm: ${confirmation.reason}`);
  return createFinding(candidate, contract, oracle, confirmation, { provider: 'custom', reducers });
}

export async function runNullSuite({ campaigns, pairs, alpha }: NullSuiteOptions): Promise<NullSuiteResult> {
  if (!Number.isInteger(campaigns) || campaigns < 1) throw new Error('campaigns must be a positive integer');
  if (!Number.isInteger(pairs) || pairs < 1) throw new Error('pairs must be a positive integer');
  const original = await diagnosticFinding(pairs, alpha);
  const trials: NullTrial[] = [];
  for (let campaign = 0; campaign < campaigns; campaign++) {
    const slots = new HypothesisSlots(profile(pairs, alpha));
    const budget = ledger(pairs, 192, 3 * pairs * 5);
    const broker = new EvaluationBroker(independentNullProvider(campaign + 1), budget, { strict: true, providerName: 'input-independent-fresh-stochastic-null' });
    const originals = [] as any[];
    // All five original family members are actually frozen and confirmed.
    for (let slot = 0; slot < 5; slot++) originals.push(await confirmCandidate(original.candidate, original.contract, broker, original.oracle, { signature: original.confirmation.signature, seed: campaign * 100 + slot, ledger: budget, slots }));
    const shrinks = [] as any[];
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = budget.snapshot().phases['final-confirmation'];
      const result = await shrinkFinding(original, broker, budget, { seed: campaign * 1000 + attempt, slots });
      const after = budget.snapshot().phases['final-confirmation'];
      shrinks.push({ result, finalLogicalConsumed: after.consumedKnown + after.consumedUnknown - before.consumedKnown - before.consumedUnknown });
    }
    // A shrink that falls back to the injected source is not a null failure.
    // Count only an original null confirmation or a distinct shrunk child.
    const falseFail = originals.some((value: any) => value.verdict === 'FAIL')
      || shrinks.some((value: any) => value.result.finding.id !== original.id && value.result.finding.confirmation.verdict === 'FAIL');
    // A statistically non-significant final confirmation returns the source with
    // unconfirmedCandidate, so it still proves that the adaptive screen froze and
    // reached the final phase.
    const slotSnapshot = slots.snapshot();
    const adaptiveFinalConfirmations = slotSnapshot.slots.filter(slot => slot.kind === 'shrink').length;
    if (slotSnapshot.slots.filter(slot => slot.kind === 'original').length !== 5) throw new Error('null protocol did not consume five original slots');
    if (shrinks.reduce((total: number, value: any) => total + value.finalLogicalConsumed, 0) !== adaptiveFinalConfirmations * 3 * pairs) throw new Error('final confirmation budget did not match consumed shrink slots');
    trials.push({ campaign, source: 'injected-diagnostic-seed', original: originals.map(confirmationSummary), shrink: shrinks.map((entry: any) => ({ status: entry.result.status, attempted: entry.result.attempted, accepted: entry.result.accepted, history: entry.result.history, retainedFindingConfirmation: confirmationSummary(entry.result.finding.confirmation), retainedFindingPhase: entry.result.finding.confirmation.blocks[0]?.a.phase, newChild: entry.result.finding.id !== original.id, unconfirmedCandidateId: entry.result.unconfirmedCandidate?.id, consumedShrinkSlots: entry.finalLogicalConsumed / (3 * pairs), finalLogicalConsumed: entry.finalLogicalConsumed })), falseFail, adaptiveFinalConfirmations, slots: slotSnapshot });
  }
  const falseFails = trials.filter(row => row.falseFail).length, adaptiveFinalConfirmations = trials.reduce((n, row) => n + row.adaptiveFinalConfirmations, 0);
  // Coverage is campaign-level: a final slot proves this campaign traversed the
  // adaptive screen/freeze/final path.  The count retains the exact spent slots.
  return { trials, falseFails, originalSlots: 5, shrinkSlots: 5, adaptiveFinalConfirmations, adaptiveFinalCoverage: trials.filter(row => row.adaptiveFinalConfirmations > 0).length / campaigns, campaigns, pairs, alpha };
}

export async function runKnownMinimumSuite(count: number): Promise<KnownMinimumResult> {
  if (!Number.isInteger(count) || count < 1) throw new Error('count must be a positive integer');
  const trials: KnownMinimumTrial[] = [];
  for (let index = 0; index < count; index++) {
    const original = await diagnosticFinding(8, .05, `known-minimum-${index}`);
    const budget = ledger(8, 192, 24);
    const result = await shrinkFinding(original, new EvaluationBroker(diagnosticProvider(original.candidate.mutantPayload), budget, { strict: true, providerName: 'known-minimum-diagnostic' }), budget, { seed: index, slots: new HypothesisSlots(original.oracle) });
    // These deterministic fixtures exercise operator removal plus the declared
    // independent-question and optional-state reducers through the real shrinker.
    const reasons = new Set(result.history.map(entry => entry.reason));
    const expectedStructure = [...reasons].some(reason => reason.startsWith('remove-operator:'))
      && [...reasons].some(reason => reason.startsWith('remove-question:'))
      && [...reasons].some(reason => reason.startsWith('remove-optional:'));
    const finalBase = JSON.parse(result.finding.candidate.basePayload) as JevRequest, finalMutant = JSON.parse(result.finding.candidate.mutantPayload) as JevRequest;
    const finalIds = result.finding.confirmation.blocks.flatMap(block => [block.a.id, block.control.id, block.b.id]);
    const expected = { recipe: ['diagnostic_c'], questions: ['route'], baseState: {}, mutantState: { diagnostic_c: 'c' }, finalObservations: 24 };
    const accepted = result.history.filter(entry => entry.accepted);
    const actual = { recipe: result.finding.candidate.recipe.map(item => item.field), questions: Object.keys(finalBase.questions), baseState: finalBase.state, mutantState: finalMutant.state, finalObservations: finalIds.length, uniqueFinalObservationIds: new Set(finalIds).size, allFinalFresh: result.finding.confirmation.blocks.every(block => block.a.phase === 'final-confirmation' && block.control.phase === 'final-confirmation' && block.b.phase === 'final-confirmation' && block.a.cache === 'fresh' && block.control.cache === 'fresh' && block.b.cache === 'fresh'), acceptedComplexitiesMonotonic: accepted.every((entry, position) => position === 0 || lexicographicallySmaller(entry.complexity, accepted[position - 1]!.complexity)) };
    const shapeMatches = JSON.stringify(actual.recipe) === JSON.stringify(expected.recipe) && JSON.stringify(actual.questions) === JSON.stringify(expected.questions) && JSON.stringify(actual.baseState) === JSON.stringify(expected.baseState) && JSON.stringify(actual.mutantState) === JSON.stringify(expected.mutantState) && actual.finalObservations === expected.finalObservations && actual.uniqueFinalObservationIds === expected.finalObservations && actual.allFinalFresh && actual.acceptedComplexitiesMonotonic;
    const passed = result.status === 'reduced' && result.accepted > 0 && result.finalComplexity[0]! < result.originalComplexity[0]! && expectedStructure && shapeMatches;
    trials.push({ fixture: `known-minimum-${index}`, status: result.status, passed, initial: result.originalComplexity, final: result.finalComplexity, accepted: result.accepted, history: result.history, expected, actual });
  }
  return { trials, passed: trials.every(row => row.passed) };
}
