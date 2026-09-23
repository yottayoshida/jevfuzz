import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { confirmCandidate, createFinding, exactPairedTail, pairedTailRejects, HypothesisSlots, summarizeConfirmation } from '../src/oracles/index.ts';
import { evaluateRelation } from '../src/contracts/index.ts';
import { buildCandidate, generateSteps } from '../src/mutators/index.ts';
import type { CampaignSeed, Contract, Observation, OracleConfig, Phase } from '../src/campaign-types.ts';
import type { JevResponse } from '../src/types.ts';
import { BudgetLedger } from '../src/engine/budget.ts';

const seed: CampaignSeed = { id: 'routing', request: { state: { ticket: 'invoice' }, model: 'jev-latest', questions: { route: { type: 'choice', instructions: 'Route ticket', criteria: { billing: 'invoice', general: 'other' } } } }, mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [], prosePaths: [] } };
const contract: Contract = { id: 'id-invariant', question: 'route', relation: 'invariant', projection: 'choice', mutations: ['question_id_rename'], admissibility: 'structural', assumptions: [], required: true };
const oracle: OracleConfig = { profile: 'paired-v1', pairs: 8, minimumSupport: .75, maxControlViolationRate: .125, minimumEffect: .5, alpha: .05, originalSlots: 5, shrinkSlots: 5 };
const reducers = { independentQuestions: false, optionalStatePaths: [], unorderedArrayPaths: [], prosePaths: [] };
function setup(cache: Observation['cache'] = 'fresh') {
  const candidate = buildCandidate(seed, generateSteps(seed, 42).filter(s => s.operator === 'question_id_rename'), [contract]);
  let calls = 0;
  const executor = { modelChanged: false, async evaluate(payload: string, phase: Phase): Promise<Observation> {
    const request = JSON.parse(payload); const q = Object.keys(request.questions)[0]!;
    const choice = q === 'route' ? 'billing' : 'general';
    const response: JevResponse = { model: 'simulator-1', answers: { [q]: { type: 'choice', choice, probabilities: { billing: choice === 'billing' ? 1 : 0, general: choice === 'general' ? 1 : 0 }, confidence: 1 } }, usage: { input_tokens: 0, output_tokens: 0 } };
    calls++; return { id: `o-${calls}`, operationId: `op-${calls}`, phase, wireHash: createHash('sha256').update(payload).digest('hex'), response, provider: 'simulator', observedModel: response.model, cache };
  } };
  return { candidate, executor, calls: () => calls };
}
test('fresh paired confirmation separates discovery, controls and empirical evidence', async () => {
  const { candidate, executor, calls } = setup();
  const a = await executor.evaluate(candidate.basePayload, 'discovery'), b = await executor.evaluate(candidate.mutantPayload, 'discovery');
  const signature = evaluateRelation(candidate, contract, a.response, b.response).signature!;
  const result = await confirmCandidate(candidate, contract, executor, oracle, { signature, seed: 7, discoverySamples: 2 });
  assert.equal(calls(), 26); assert.equal(result.verdict, 'FAIL'); assert.equal(result.support, 8); assert.equal(result.controlViolations, 0);
  assert.equal(result.evidenceLevel, 'empirical'); assert.equal(result.pValue, undefined);
  assert.equal(new Set(result.blocks.flatMap(block => [block.a.id, block.control.id, block.b.id])).size, 24);
  assert.equal(createFinding(candidate, contract, oracle, result, { provider: 'custom', reducers }).confirmation.confirmationSamples, 24);
  const discoveryBlocks = structuredClone(result.blocks); discoveryBlocks[0]!.a.phase = 'discovery';
  const invalid = summarizeConfirmation(candidate, contract, oracle, signature, discoveryBlocks);
  assert.equal(invalid.verdict, 'INCONCLUSIVE'); assert.equal(invalid.reason, 'NON_FRESH_OBSERVATIONS');
  assert.throws(() => createFinding(candidate, contract, oracle, invalid, { provider: 'custom', reducers }), /formal|fresh/);
});
test('hypotheses, cached data, cohort changes and interrupted triples cannot create findings', async () => {
  const { candidate, executor, calls } = setup('cached');
  const hypothesis = await confirmCandidate({ ...candidate, admissibility: 'hypothesis' }, contract, executor, oracle, { signature: 'frozen', seed: 1 });
  assert.equal(hypothesis.reason, 'HYPOTHESIS_ONLY'); assert.equal(calls(), 0);
  const cached = await confirmCandidate(candidate, contract, executor, oracle, { signature: 'frozen', seed: 1 });
  assert.equal(cached.reason, 'CACHED_OBSERVATION');
  let n = 0; const faulty = { modelChanged: false, evaluate: async (p: string, phase: Phase) => { if (++n === 5) throw new Error('raw private transport exception'); return executor.evaluate(p, phase); } };
  const partial = await confirmCandidate(candidate, contract, faulty, oracle, { signature: 'frozen', seed: 1 });
  assert.equal(partial.verdict, 'INCONCLUSIVE'); assert.equal(partial.confirmationSamples, 3);
  assert.equal(JSON.stringify(partial).includes('private transport'), false);
  assert.throws(() => createFinding(candidate, contract, oracle, partial, { provider: 'custom', reducers }), /fresh/);
});
test('confirmation refuses insufficient reserved phase capacity without provider calls', async () => {
  const { candidate, executor, calls } = setup();
  const ledger = new BudgetLedger({ logicalRequests: 100, httpAttempts: 500, wallTimeSeconds: 10, discoveryRequests: 50, confirmationRequests: 23, shrinkRequests: 0, finalConfirmationRequests: 24 });
  const result = await confirmCandidate(candidate, contract, executor, oracle, { signature: 'x', seed: 1, ledger });
  assert.equal(result.reason, 'CONFIRMATION_BUDGET_UNAVAILABLE'); assert.equal(calls(), 0);
});
test('fixed statistical confirmation has exact one-sided tails and spent frozen slots', async () => {
  assert.equal(exactPairedTail(0, 0), 1); assert.equal(exactPairedTail(8, 0), 1 / 256);
  assert.equal(exactPairedTail(3, 1), 5 / 16); assert.equal(exactPairedTail(64, 0), 2 ** -64);
  const { candidate, executor } = setup(); const profile = { ...oracle, profile: 'fixed-stat-v1' as const, pairs: 64, originalSlots: 1, shrinkSlots: 1 };
  const a = await executor.evaluate(candidate.basePayload, 'discovery'), b = await executor.evaluate(candidate.mutantPayload, 'discovery');
  const signature = evaluateRelation(candidate, contract, a.response, b.response).signature!;
  const slots = new HypothesisSlots(profile);
  const result = await confirmCandidate(candidate, contract, executor, profile, { signature, seed: 1, slots });
  assert.equal(result.verdict, 'FAIL'); assert.equal(result.evidenceLevel, 'statistical'); assert.equal(result.alpha, .025); assert.equal(result.pValue, 2 ** -64);
  const reused = await confirmCandidate(candidate, contract, executor, profile, { signature, seed: 1, slots });
  assert.equal(reused.reason, 'SLOTS_EXHAUSTED');
  const recovered = new HypothesisSlots(profile, slots.snapshot()); assert.equal(recovered.remaining('original'), 0);
  assert.equal(recovered.remaining('shrink'), 1);
  const noCache = setup('unknown');
  const resultUnknown = await confirmCandidate(noCache.candidate, contract, noCache.executor, profile, { signature, seed: 1, slots: new HypothesisSlots(profile) });
  assert.equal(resultUnknown.reason, 'FRESHNESS_UNVERIFIED');
});

test('exact rejection uses integer arithmetic at large n and refuses directional statistical tests before dispatch', async () => {
  assert.equal(pairedTailRejects(1023, 0, 1e-300, 10), true);
  assert.equal(pairedTailRejects(0, 1023, .05, 10), false);
  assert.equal(pairedTailRejects(3, 1, .3125, 1), true);
  assert.equal(pairedTailRejects(3, 1, .31249999999999994, 1), false);
  assert.ok(exactPairedTail(520, 503) > 0 && exactPairedTail(520, 503) < 1);
  const { candidate, executor, calls } = setup();
  await assert.rejects(confirmCandidate(candidate, { ...contract, relation: 'directional' }, executor, { ...oracle, profile: 'fixed-stat-v1' }, { signature: 'x', seed: 1, slots: new HypothesisSlots(oracle) }), /directional/);
  assert.equal(calls(), 0);
});

test('paired cache uncertainty stays explicit in empirical assumptions, never statistical evidence', async () => {
  const { candidate, executor } = setup('unknown');
  const a = await executor.evaluate(candidate.basePayload, 'discovery'), b = await executor.evaluate(candidate.mutantPayload, 'discovery');
  const confirmation = await confirmCandidate(candidate, contract, executor, oracle, { signature: evaluateRelation(candidate, contract, a.response, b.response).signature!, seed: 1 });
  assert.equal(confirmation.verdict, 'FAIL'); assert.equal(confirmation.evidenceLevel, 'empirical');
  assert.equal(confirmation.pValue, undefined); assert.ok(confirmation.assumptions.some(a => a.includes('unverified')));
});
