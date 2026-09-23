import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { shrinkFinding } from '../src/shrink/index.ts';
import { buildCandidate } from '../src/mutators/index.ts';
import { BudgetLedger } from '../src/engine/budget.ts';
import type { Candidate, Finding, MutationStep, Observation, Phase } from '../src/campaign-types.ts';
import type { JevResponse } from '../src/types.ts';

const oracle = { profile: 'paired-v1' as const, pairs: 1, minimumSupport: 1, maxControlViolationRate: 0, minimumEffect: 0, alpha: .05, originalSlots: 0, shrinkSlots: 0 };
const contract: Finding['contract'] = { id: 'route', question: 'route', relation: 'invariant' as const, projection: 'choice' as const, mutations: ['question_id_rename', 'irrelevant_field_injection', 'question_order'], admissibility: 'structural' as const, assumptions: [], required: true };
const rename: MutationStep = { operator: 'question_id_rename', version: '1', admissibility: 'structural', renames: { route: 'r' }, reads: ['$.questions'], writes: ['$.questions'], requires: [], invalidates: [] };
const inject: MutationStep = { operator: 'irrelevant_field_injection', version: '1', admissibility: 'structural', path: '$.state', field: 'noise', value: 'x', reads: ['$.state'], writes: ['$.state'], requires: [], invalidates: [] };
function candidate(recipe: MutationStep[] = [rename, inject]): Candidate { return buildCandidate({ id: 'seed', mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [], prosePaths: [] }, request: { model: 'jev-latest', state: { keep: 1, optional: 2, list: ['a', 'b'] }, questions: { route: { type: 'choice', instructions: 'route', criteria: { billing: 'bill', general: 'other' } }, noise: { type: 'noul', instructions: 'unused' } } } }, recipe, [contract]); }
function finding(recipe?: MutationStep[], reducers: Finding['reducers'] = { independentQuestions: false, optionalStatePaths: ['$.state.optional'], unorderedArrayPaths: ['$.state.list'], prosePaths: [] }): Finding {
  const c = candidate(recipe); return { version: 2, kind: 'finding', id: 'original', candidate: c, contract, oracle, confirmation: { verdict: 'FAIL', reason: 'PAIRED_CONFIRMED', signature: '["relation-v1","route","route","invariant","choice","label","billing","general"]', evidenceLevel: 'empirical', profileVersion: 'paired-v1', discoverySamples: 0, confirmationSamples: 3, controls: 1, support: 1, controlViolations: 0, effect: 1, familySize: 0, adjustment: 'none', assumptions: [], blocks: [], observedModels: ['sim'] }, provider: 'custom', reducers, fingerprint: 'f', replayability: 'full' }; }
function executor(mode: 'violate' | 'hold' = 'violate') { let calls = 0; return { modelChanged: false, calls: () => calls, async evaluate(payload: string, phase: Phase): Promise<Observation> { const request = JSON.parse(payload); const id = Object.keys(request.questions)[0]!; const choice = mode === 'hold' ? 'billing' : (id === 'route' ? 'billing' : 'general'); const response: JevResponse = { model: 'sim', answers: { [id]: { type: 'choice', choice, probabilities: { billing: choice === 'billing' ? 1 : 0, general: choice === 'general' ? 1 : 0 }, confidence: 1 } }, usage: { input_tokens: 0, output_tokens: 0 } }; calls++; return { id: `o${calls}`, operationId: `op${calls}`, phase, wireHash: createHash('sha256').update(payload).digest('hex'), response, provider: 'sim', observedModel: 'sim', cache: 'fresh' }; } }; }
const ledger = (shrink = 100, final = 3) => new BudgetLedger({ logicalRequests: 200, httpAttempts: 0, wallTimeSeconds: 20, discoveryRequests: 0, confirmationRequests: 0, shrinkRequests: shrink, finalConfirmationRequests: final });

test('shrinks an input pair by replaying the remaining recipe and records a fresh child finding', async () => { const e = executor(); const result = await shrinkFinding(finding(), e, ledger()); assert.equal(result.status, 'reduced', JSON.stringify(result)); assert.equal(result.finding.parentFindingId, 'original'); assert.equal(result.finding.confirmation.blocks[0]!.a.phase, 'final-confirmation'); assert.ok(result.finalComplexity[0]! < result.originalComplexity[0]!); });
test('removing the required rename does not accept a false shrink', async () => { const e = executor(); const result = await shrinkFinding(finding(), e, ledger()); assert.equal(result.history[0]!.accepted, false); assert.match(result.history[0]!.reason, /screen-rejected/); });
test('protects final-confirmation capacity before any shrink request', async () => { const e = executor(); const result = await shrinkFinding(finding(), e, ledger(100, 2)); assert.equal(result.status, 'budget_limited'); assert.equal(e.calls(), 0); });
test('shrink screens use only the shrink phase and final evidence uses final-confirmation', async () => { const phases: Phase[] = []; const e = executor(); const original = e.evaluate; e.evaluate = async (p, phase) => { phases.push(phase); return original(p, phase); }; await shrinkFinding(finding(), e, ledger()); assert.ok(phases.slice(0, 6).every(p => p === 'shrink')); assert.ok(phases.slice(-3).every(p => p === 'final-confirmation')); });
test('returns original immutable finding when final confirmation rejects', async () => { const e = executor(); const evaluate = e.evaluate; e.evaluate = async (payload, phase) => { if (phase === 'final-confirmation') e.modelChanged = true; return evaluate(payload, phase); }; const original = finding(); const result = await shrinkFinding(original, e, ledger()); assert.equal(result.status, 'unconfirmed'); assert.equal(result.finding, original); assert.deepEqual(result.finalComplexity, result.originalComplexity); assert.ok(result.unconfirmedCandidate); });
test('reports locally minimal when no valid one-step reduction remains', async () => { const only = finding([rename], { independentQuestions: false, optionalStatePaths: [], unorderedArrayPaths: [], prosePaths: [] }); const result = await shrinkFinding(only, executor(), ledger()); assert.equal(result.status, 'locally_minimal'); assert.equal(result.attempted, 0); });
test('explicit prose reduction removes only redundant whitespace and uses fresh final evidence', async () => {
  const original=finding([rename],{independentQuestions:false,optionalStatePaths:[],unorderedArrayPaths:[],prosePaths:['$.state.note']});
  const request=JSON.parse(original.candidate.basePayload); request.state.note='  keep  not  42  ';
  original.candidate=buildCandidate({id:'seed',request,mutations:{builtin:true,unorderedArrays:[],irrelevantFields:[],prosePaths:['$.state.note']}},[rename],[contract]);
  const result=await shrinkFinding(original,executor(),ledger());
  assert.equal(result.status,'reduced'); assert.equal(result.accepted,1);
  assert.equal(JSON.parse(result.finding.candidate.basePayload).state.note,'keep not 42');
  assert.equal(JSON.parse(result.finding.candidate.mutantPayload).state.note,'keep not 42');
  assert.ok(result.finding.confirmation.blocks.every(block=>block.a.phase==='final-confirmation' && block.b.phase==='final-confirmation'));
  const limited=await shrinkFinding(original,executor(),ledger(0)); assert.equal(limited.status,'budget_limited');
});
test('declared question reducers bind a fresh child target while preserving protected questions',async()=>{
  const original=finding([rename],{independentQuestions:true,optionalStatePaths:[],unorderedArrayPaths:[],prosePaths:['$.questions.route.instructions']});
  const request=JSON.parse(original.candidate.basePayload);request.questions.route.instructions='  keep  not  42  ';
  original.candidate=buildCandidate({id:'seed',request,mutations:{builtin:true,unorderedArrays:[],irrelevantFields:[],prosePaths:[]}},[rename],[contract]);
  const result=await shrinkFinding(original,executor(),ledger());
  assert.equal(result.status,'reduced');assert.equal(result.accepted,2);
  const base=JSON.parse(result.finding.candidate.basePayload);assert.deepEqual(Object.keys(base.questions),['route']);
  assert.equal(base.questions.route.instructions,'keep not 42');
  assert.notEqual(result.finding.candidate.targetHash,original.candidate.targetHash);
  assert.equal(result.finding.parentFindingId,original.id);assert.equal(result.finding.provider,original.provider);
  assert.ok(result.finding.confirmation.blocks.every(block=>block.a.phase==='final-confirmation'));
});
test('prose declarations cannot alter requested model or other routing metadata',async()=>{
  const original=finding([rename],{independentQuestions:false,optionalStatePaths:[],unorderedArrayPaths:[],prosePaths:['$.model']});
  const e=executor();await assert.rejects(shrinkFinding(original,e,ledger()),/decision content/);assert.equal(e.calls(),0);
});
test('does not remove contract or policy-referenced questions', async () => { const policyFinding = finding([rename], { independentQuestions: true, optionalStatePaths: [], unorderedArrayPaths: [], prosePaths: [] }); policyFinding.policy = { version: 1, fallback: 'hold', rules: [{ when: { question: 'noise', field: 'noul', op: 'gt', value: 0 }, action: 'go' }] }; policyFinding.candidate = buildCandidate({ id: 'seed', mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [], prosePaths: [] }, request: JSON.parse(policyFinding.candidate.basePayload) }, policyFinding.candidate.recipe, [contract], policyFinding.policy, policyFinding.provider); const result = await shrinkFinding(policyFinding, executor(), ledger()); assert.equal(result.status, 'locally_minimal'); });
test('invalid mappings are rejected before any network screen', async () => { const bad = finding(); bad.candidate.recipe[0] = { ...bad.candidate.recipe[0]!, renames: { missing: 'r' } }; const e = executor(); const result = await shrinkFinding(bad, e, ledger()); assert.equal(result.status, 'unconfirmed'); assert.equal(result.attempted, 0); assert.equal(e.calls(), 0); });
test('reports budget_limited when enabled reductions remain but shrink capacity is absent', async () => { const result = await shrinkFinding(finding(), executor(), ledger(0)); assert.equal(result.status, 'budget_limited'); });
test('strict complexity rejects a same-size order-only candidate', async () => { const order: MutationStep = { operator: 'question_order', version: '1', admissibility: 'structural', order: ['noise', 'route'], reads: [], writes: [], requires: [], invalidates: [] }; const f = finding([rename, order], { independentQuestions: false, optionalStatePaths: [], unorderedArrayPaths: [], prosePaths: [] }); const result = await shrinkFinding(f, executor(), ledger()); assert.ok(result.history.every(h => h.accepted === false || h.complexity[0]! < result.originalComplexity[0]!)); });
test('iterates from each accepted pair until multi-field local minimum', async () => { const result = await shrinkFinding(finding([rename, inject], { independentQuestions: false, optionalStatePaths: ['$.state.optional'], unorderedArrayPaths: ['$.state.list'], prosePaths: [] }), executor(), ledger()); assert.ok(result.accepted >= 2); assert.ok(result.finalComplexity.some((value, index) => value < result.originalComplexity[index]!)); });
test('reduces an individual rename mapping while retaining the failing rename witness', async () => { const twoRenames = { ...rename, renames: { noise: 'n', route: 'r' } }; const result = await shrinkFinding(finding([twoRenames]), executor(), ledger()); assert.ok(result.history.some(step => step.accepted && step.reason.startsWith('remove-rename:')), JSON.stringify(result.history)); });
test('uses the finding provider when rebuilding Cloudflare and TypeSafe candidates', async () => { for (const provider of ['cloudflare', 'typesafe'] as const) { const source = finding(); source.provider = provider; source.candidate = buildCandidate({ id: 'seed', mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [], prosePaths: [] }, request: JSON.parse(source.candidate.basePayload) }, source.candidate.recipe, [contract], undefined, provider); const result = await shrinkFinding(source, executor(), ledger()); assert.equal(result.status, 'reduced'); assert.equal(result.finding.provider, provider); assert.equal(result.finding.candidate.targetHash, source.candidate.targetHash); } });
test('returns budget_limited after accepting a reduction when no complete neighbourhood remains', async () => { const budget = ledger(3), e = executor(), evaluate = e.evaluate; let shrinkCalls = 0; e.evaluate = async (payload, phase) => { const observation = await evaluate(payload, phase); if (phase === 'shrink' && ++shrinkCalls === 3) { const reservation = budget.reserve('shrink', 'logical', 'test-shrink-exhaustion'); budget.dispatch(reservation.id); budget.settle(reservation.id, 'known'); } return observation; }; const result = await shrinkFinding(finding([inject, rename]), e, budget); assert.equal(result.accepted, 1); assert.equal(result.status, 'budget_limited'); assert.equal(result.finding.parentFindingId, 'original'); });
test('runtime screen failures cannot certify local minimality', async () => { const e = executor(); e.evaluate = async () => { throw new Error('transport failed'); }; const result = await shrinkFinding(finding(), e, ledger()); assert.equal(result.status, 'unconfirmed'); assert.equal(result.history[0]!.reason, 'screen-incomplete'); });

test('shrinks object-key permutations and removes unnecessary object-order witnesses with fresh confirmation', async () => {
  const original = finding(undefined, { independentQuestions: false, optionalStatePaths: [], unorderedArrayPaths: [], prosePaths: [] });
  original.contract = { ...contract, mutations: ['object_key_order'], admissibility: 'declared', assumptions: ['Object member order preserves meaning.'] };
  const request = { model: 'jev-latest', state: { relevant: { a: 1, b: 2, c: 3 }, irrelevant: { x: 1, y: 2 } }, questions: { route: { type: 'choice' as const, instructions: 'route', criteria: { billing: 'bill', general: 'other' } } } };
  const order: MutationStep = { operator: 'object_key_order', version: '1', admissibility: 'structural', orders: [{ path: '$.state.relevant', order: ['c', 'a', 'b'] }, { path: '$.state.irrelevant', order: ['y', 'x'] }], reads: ['$.state'], writes: ['$.state'], requires: [], invalidates: [] };
  original.candidate = buildCandidate({ id: 'seed', request, mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [], prosePaths: [] } }, [order], [original.contract]);
  const phases: Phase[] = [];
  const e = { modelChanged: false, async evaluate(payload: string, phase: Phase): Promise<Observation> {
    const input = JSON.parse(payload), choice = Object.keys(input.state.relevant)[0] === 'a' ? 'billing' : 'general';
    phases.push(phase);
    const response: JevResponse = { model: 'sim', answers: { route: { type: 'choice', choice, probabilities: { billing: choice === 'billing' ? 1 : 0, general: choice === 'general' ? 1 : 0 }, confidence: 1 } }, usage: { input_tokens: 0, output_tokens: 0 } };
    return { id: `object-o${phases.length}`, operationId: `object-p${phases.length}`, phase, wireHash: createHash('sha256').update(payload).digest('hex'), response, provider: 'sim', observedModel: 'sim', cache: 'fresh' };
  } };
  const limited = await shrinkFinding(original, e, ledger(0));
  assert.equal(limited.status, 'budget_limited');
  assert.equal(phases.length, 0);
  const result = await shrinkFinding(original, e, ledger());
  assert.equal(result.status, 'reduced');
  assert.equal(result.originalComplexity[1], 5);
  assert.equal(result.finalComplexity[1], 2);
  assert.deepEqual(result.finding.candidate.recipe[0]!.orders, [{ path: '$.state.relevant', order: ['c', 'b', 'a'] }]);
  assert.equal(result.finding.candidate.targetHash, original.candidate.targetHash);
  assert.deepEqual(result.finding.contract, original.contract);
  assert.deepEqual(JSON.parse(result.finding.candidate.basePayload), JSON.parse(result.finding.candidate.mutantPayload));
  assert.equal(result.finding.confirmation.verdict, 'FAIL');
  assert.equal(result.finding.parentFindingId, original.id);
  assert.deepEqual(phases.slice(-3), ['final-confirmation', 'final-confirmation', 'final-confirmation']);
  assert.ok(result.history.some(step => step.accepted && step.reason.startsWith('remove-object-order:')));
  assert.ok(result.history.some(step => step.accepted && step.reason.startsWith('restore-object-order:')));
});
