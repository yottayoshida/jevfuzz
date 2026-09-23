import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeProvider } from '../src/provider.ts';
import { compareExperiment, parseExperiment, type ExperimentSpec } from '../src/experiments.ts';
import { wireHash } from '../src/identity.ts';
import { buildCandidate } from '../src/mutators/index.ts';
import type { Candidate, Contract } from '../src/campaign-types.ts';
import type { JevRequest, JevResponse } from '../src/types.ts';

const request = (mutant = false): JevRequest => ({
  state: { mutant }, model: 'jev-test',
  questions: { decision: { type: 'choice', instructions: 'Choose.', criteria: { yes: 'yes', no: 'no' } } },
});
const payload = (mutant = false) => JSON.stringify(request(mutant));
const candidate = (bound: Contract = contract, provider: 'typesafe' | 'cloudflare' | 'custom' = 'custom'): Candidate => buildCandidate({ id: 'seed', request: request(), mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [], prosePaths: [] } }, [{ operator: 'question_id_rename', version: '1', admissibility: 'structural', renames: { decision: 'mutant_decision' }, reads: [], writes: [], requires: [], invalidates: [] }], [bound], undefined, provider);
const contract: Contract = { id: 'choice', question: 'decision', relation: 'invariant', projection: 'choice', mutations: ['question_id_rename'], admissibility: 'structural', assumptions: [], required: true };
const response = (choice: 'yes' | 'no', confidence = .9, question = 'decision'): JevResponse => ({ model: 'fake-jev-1', answers: { [question]: { type: 'choice', choice, confidence, probabilities: choice === 'yes' ? { yes: .9, no: .1 } : { yes: .1, no: .9 } } }, usage: { input_tokens: 0, output_tokens: 0 } });
const spec = (): ExperimentSpec => ({
  version: 2, kind: 'experiment', name: 'compare', cases: [{ id: 'case', candidate: candidate(), contract }],
  old: { id: 'old', provider: 'custom' }, new: { id: 'new', provider: 'custom' },
  oracle: { profile: 'paired-v1', pairs: 1, minimumSupport: 1, maxControlViolationRate: 0, minimumEffect: 0, alpha: .05, originalSlots: 5, shrinkSlots: 5 },
  budget: { logicalRequests: 20, httpAttempts: 0, wallTimeSeconds: 30, discoveryRequests: 4, confirmationRequests: 6, shrinkRequests: 0, finalConfirmationRequests: 0 },
});
function factory(behavior: Record<string, 'holds' | 'violates'>): (target: { id: string }) => FakeProvider {
  return target => new FakeProvider(r => { const question = Object.keys(r.questions)[0]!; return response(behavior[target.id] === 'violates' && question !== 'decision' ? 'no' : 'yes', .9, question); });
}

test('classifies introduced, resolved, persists, and no detected regression from fresh target cohorts', async () => {
  for (const [old, newer, expected] of [
    ['holds', 'violates', 'introduced'], ['violates', 'holds', 'resolved'], ['violates', 'violates', 'persists'], ['holds', 'holds', 'no_detected_regression'],
  ] as const) {
    const report = await compareExperiment(spec(), factory({ old, new: newer }));
    assert.equal(report.cases[0]?.status, expected);
    assert.equal(report.cases[0]?.old.observations, 5);
    assert.equal(report.cases[0]?.new.observations, 5);
  }
});

test('a mixed model cohort is inconclusive and historical responses are not consulted', async () => {
  let calls = 0;
  const report = await compareExperiment(spec(), target => new FakeProvider((r, index) => {
    calls++;
    const question = Object.keys(r.questions)[0]!;
    return { ...response(question !== 'decision' ? 'no' : 'yes', .9, question), model: target.id === 'new' && index === 1 ? 'fake-jev-2' : 'fake-jev-1' };
  }));
  assert.equal(report.cases[0]?.status, 'inconclusive');
  assert.ok(calls >= 4);
});

test('rejects incompatible target question mapping before constructing a provider', async () => {
  const input = spec();
  input.new.questionMapping = { other: 'decision' };
  let calls = 0;
  await assert.rejects(() => compareExperiment(input, () => { calls++; return new FakeProvider(); }), /mapping/i);
  assert.equal(calls, 0);
});

test('a target policy detects a confidence crossing while the Choice label stays stable', async () => {
  const input = spec();
  input.cases[0]!.contract = { ...contract, projection: 'policy' };
  input.cases[0]!.candidate = candidate(input.cases[0]!.contract);
  input.old.policy = { version: 1, rules: [{ when: { question: 'decision', field: 'confidence', op: 'gte', value: .8 }, action: 'high' }], fallback: 'low' };
  input.new.policy = input.old.policy;
  const report = await compareExperiment(input, target => new FakeProvider(r => { const question = Object.keys(r.questions)[0]!; return response('yes', target.id === 'new' && question !== 'decision' ? .5 : .9, question); }));
  assert.equal(report.cases[0]?.status, 'introduced');
});

test('parser rejects pinned Cloudflare targets and unknown fields', () => {
  const raw = { ...spec(), old: { id: 'old', provider: 'cloudflare', model: 'old-model' } };
  assert.throws(() => parseExperiment(raw), /cloudflare/i);
  assert.throws(() => parseExperiment({ ...spec(), unexpected: true }), /unsupported field/i);
});
test('experiment embedded request JSON rejects excessive depth before provider creation', async () => {
  for (const key of ['basePayload','mutantPayload'] as const) {
    const input=spec(); input.cases[0]!.candidate[key]='{"state":'+ '['.repeat(12000)+'0'+']'.repeat(12000)+',"model":"m","questions":{"q":{"type":"noul","instructions":"x"}}}';
    assert.throws(()=>parseExperiment(input),/JSON structural limit exceeded/);
    let calls=0; await assert.rejects(compareExperiment(input,()=>{calls++;return new FakeProvider();}),/JSON structural limit exceeded/); assert.equal(calls,0);
  }
});

test('target criteria-order overrides are replayed before any provider call', async () => {
  const input = spec();
  input.new.questions = { decision: { type: 'choice', instructions: 'Choose.', criteria: { no: 'no', yes: 'yes' } } };
  const report = await compareExperiment(input, factory({ old: 'holds', new: 'violates' }));
  assert.equal(report.cases[0]?.status, 'introduced');
});

test('a late target cohort drift invalidates every prior case for that target', async () => {
  const input = spec();
  input.cases.push({ id: 'later', candidate: candidate(), contract });
  input.budget = { ...input.budget, logicalRequests: 40, discoveryRequests: 8, confirmationRequests: 12 };
  const report = await compareExperiment(input, target => new FakeProvider((r, index) => {
    const question = Object.keys(r.questions)[0]!;
    return { ...response(target.id === 'new' && question !== 'decision' ? 'no' : 'yes', .9, question), model: target.id === 'new' && index >= 5 ? 'fake-jev-2' : 'fake-jev-1' };
  }));
  assert.equal(report.cases.length, 2);
  assert.deepEqual(report.cases.map(item => item.new.status), ['unknown', 'unknown']);
  assert.deepEqual(report.cases.map(item => item.status), ['inconclusive', 'inconclusive']);
});

test('runtime failures return a redacted incomplete partial report', async () => {
  const input = spec();
  input.cases.push({ id: 'later', candidate: candidate(), contract });
  input.budget = { ...input.budget, logicalRequests: 40, discoveryRequests: 8, confirmationRequests: 12 };
  const report = await compareExperiment(input, target => new FakeProvider((r, index) => {
    if (target.id === 'old' && index >= 5) throw new Error('credential=secret raw failure');
    return response(Object.keys(r.questions)[0] === 'decision' ? 'yes' : 'no', .9, Object.keys(r.questions)[0]!);
  }), { secrets: ['secret'] });
  assert.equal(report.status, 'incomplete');
  assert.equal(report.exitCode, 2);
  assert.equal(report.cases.length, 1);
  assert.equal(report.errorCode, 'INCOMPLETE_RUNTIME');
  assert.doesNotMatch(JSON.stringify(report), /secret|raw failure/);
});

test('invalid replay identity and fixed-stat unsupported inputs construct no providers', async () => {
  const tampered = spec();
  tampered.cases[0]!.candidate.mutantWireHash = wireHash(payload());
  let calls = 0;
  await assert.rejects(() => compareExperiment(tampered, () => { calls++; return new FakeProvider(); }), /hashes|wire hash/i);
  assert.equal(calls, 0);

  const fixed = spec();
  fixed.oracle = { ...fixed.oracle, profile: 'fixed-stat-v1', pairs: 1, originalSlots: 2, shrinkSlots: 0 };
  fixed.cases[0]!.contract = { ...contract, relation: 'directional', direction: 'increase' };
  await assert.rejects(() => compareExperiment(fixed, () => { calls++; return new FakeProvider(); }), /directional/i);
  assert.equal(calls, 0);
});

test('target provider is bound into each reported target hash', async () => {
  const input = spec(); input.old.provider = 'typesafe'; input.new.provider = 'cloudflare';
  const report = await compareExperiment(input, factory({ old: 'holds', new: 'holds' }));
  assert.equal(report.cases[0]?.old.provider, 'typesafe');
  assert.equal(report.cases[0]?.new.provider, 'cloudflare');
  assert.notEqual(report.cases[0]?.old.targetHash, report.cases[0]?.new.targetHash);
});

test('imported source identity is checked before a provider is constructed', async () => {
  const tampered = structuredClone(spec()); tampered.cases[0]!.candidate.targetHash = 'tampered';
  let calls = 0;
  assert.throws(() => parseExperiment(tampered), /source identity|targetHash/i);
  assert.equal(calls, 0, 'parse-time identity failure constructs no provider');

  const cloudflare = structuredClone(spec()); cloudflare.cases[0]!.candidate = candidate(contract, 'cloudflare'); cloudflare.cases[0]!.source = { provider: 'cloudflare' };
  assert.doesNotThrow(() => parseExperiment(cloudflare));
});
