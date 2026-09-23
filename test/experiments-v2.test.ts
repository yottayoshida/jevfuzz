import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeProvider } from '../src/provider.ts';
import { compareExperiment, parseExperiment, type ExperimentSpec } from '../src/experiments.ts';
import { main } from '../src/cli/main.ts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  assert.equal(report.status, 'complete', JSON.stringify(report));
  assert.equal(report.cases[0]?.status, 'introduced');
});

test('parser rejects pinned Cloudflare targets and unknown fields', () => {
  const raw = { ...spec(), old: { id: 'old', provider: 'cloudflare', model: 'old-model' } };
  assert.throws(() => parseExperiment(raw), /cloudflare/i);
  assert.throws(() => parseExperiment({ ...spec(), unexpected: true }), /unsupported field/i);
});

test('accepts an explicitly renamed target question and Choice labels with target-coordinate policy', () => {
  const input = structuredClone(spec()) as any;
  input.new.questions = { decisionV2: { type: 'choice', instructions: 'Choose.', criteria: { allow: 'yes', deny: 'no' } } };
  input.new.sourceQuestionMapping = { decision: 'decisionV2' };
  input.new.sourceLabelMappings = { decision: { yes: 'allow', no: 'deny' } };
  input.new.policy = { version: 1, rules: [{ when: { question: 'decisionV2', field: 'choice', op: 'eq', value: 'allow' }, action: 'allow' }], fallback: 'hold' };
  assert.doesNotThrow(() => parseExperiment(input));
});

test('mapped targets use translated contracts and target-coordinate policies for fresh observations', async () => {
  const input = structuredClone(spec()) as any;
  input.cases[0].contract = { ...contract, projection: 'policy' };
  input.cases[0].candidate = candidate(input.cases[0].contract);
  input.old.policy = { version: 1, rules: [{ when: { question: 'decision', field: 'choice', op: 'eq', value: 'yes' }, action: 'allow' }], fallback: 'hold' };
  input.new.questions = { decisionV2: { type: 'choice', instructions: 'Choose.', criteria: { allow: 'yes', deny: 'no' } } };
  input.new.sourceQuestionMapping = { decision: 'decisionV2' };
  input.new.sourceLabelMappings = { decision: { yes: 'allow', no: 'deny' } };
  input.new.policy = { version: 1, rules: [{ when: { question: 'decisionV2', field: 'choice', op: 'eq', value: 'allow' }, action: 'allow' }], fallback: 'hold' };
  const before = JSON.stringify(input);
  let calls = 0;
  const report = await compareExperiment(input, target => new FakeProvider(r => {
    calls++;
    const question = Object.keys(r.questions)[0]!;
    const changed = target.id === 'new' && question !== 'decisionV2';
    if (target.id === 'new') return { model: 'fake-jev-1', answers: { [question]: { type: 'choice', choice: changed ? 'deny' : 'allow', confidence: .9, probabilities: changed ? { allow: .1, deny: .9 } : { allow: .9, deny: .1 } } }, usage: { input_tokens: 0, output_tokens: 0 } };
    return response('yes', .9, question);
  }));
  assert.equal(report.status, 'complete', JSON.stringify(report));
  assert.equal(report.cases[0]?.status, 'introduced');
  assert.equal(calls, 10);
  assert.equal(JSON.stringify(input), before, 'compare does not mutate persisted source artifacts');
});

test('invalid source mappings reject the entire comparison before provider construction', async () => {
  for (const patch of [
    {},
    { sourceQuestionMapping: { decision: 'missing' } },
    { sourceQuestionMapping: { decision: 'decisionV2', extra: 'decisionV2' } },
    { sourceQuestionMapping: { decision: 'decisionV2' }, sourceLabelMappings: { decision: { yes: 'allow' } } },
    { sourceQuestionMapping: { decision: 'decisionV2' }, sourceLabelMappings: { decision: { yes: 'allow', no: 'allow' } } },
  ]) {
    const input = structuredClone(spec()) as any;
    input.new.questions = { decisionV2: { type: 'choice', instructions: 'Choose.', criteria: { allow: 'yes', deny: 'no' } } };
    Object.assign(input.new, patch);
    let factories = 0;
    await assert.rejects(() => compareExperiment(input, () => { factories++; return new FakeProvider(); }),
      'sourceLabelMappings' in patch ? /source label mapping.*(?:incomplete|bijection)/i : /source question mapping/i);
    assert.equal(factories, 0);
  }
});

test('source mappings can rename cloned target questions and Choice criteria without an override', async () => {
  const input = structuredClone(spec()) as any;
  input.new.sourceQuestionMapping = { decision: 'decisionV2' };
  input.new.sourceLabelMappings = { decision: { yes: 'allow', no: 'deny' } };
  input.new.policy = { version: 1, rules: [{ when: { question: 'decisionV2', field: 'probability', label: 'allow', op: 'gte', value: .8 }, action: '${decisionV2}' }], fallback: 'hold' };
  const parsed = parseExperiment(input);
  assert.deepEqual(Object.keys(parsed.new.questions ?? {}), [], 'the public target keeps no synthesized question override');
  assert.doesNotThrow(() => parseExperiment(JSON.parse(JSON.stringify(parsed))));
  const report = await compareExperiment(parsed, target => new FakeProvider(r => {
    const question = Object.keys(r.questions)[0]!;
    if (target.id === 'new') return { model: 'fake-jev-1', answers: { [question]: { type: 'choice', choice: 'allow', confidence: .9, probabilities: { allow: .9, deny: .1 } } }, usage: { input_tokens: 0, output_tokens: 0 } };
    return response('yes', .9, question);
  }));
  assert.equal(report.status, 'complete');
});

test('target-coordinate policy is rejected before a factory is constructed', async () => {
  const input = structuredClone(spec()) as any;
  input.new.questions = { decisionV2: { type: 'choice', instructions: 'Choose.', criteria: { allow: 'yes', deny: 'no' } } };
  input.new.sourceQuestionMapping = { decision: 'decisionV2' };
  input.new.sourceLabelMappings = { decision: { yes: 'allow', no: 'deny' } };
  input.new.policy = { version: 1, rules: [{ when: { question: 'decision', field: 'choice', op: 'eq', value: 'yes' }, action: 'bad' }], fallback: 'hold' };
  let factories = 0;
  await assert.rejects(() => compareExperiment(input, () => { factories++; return new FakeProvider(); }), /policy question missing/i);
  assert.equal(factories, 0);
});

test('rename followed by text normalization replays target prose from the current prefix', async () => {
  const bound: Contract = { ...contract, mutations: ['question_id_rename', 'text_normalization'], admissibility: 'declared', assumptions: ['prose is declared'] };
  const witness = buildCandidate({ id: 'text', request: request(), mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [], prosePaths: [] } }, [
    { operator: 'question_id_rename', version: '1', admissibility: 'structural', renames: { decision: 'renamed' }, reads: [], writes: [], requires: [], invalidates: [] },
    { operator: 'text_normalization', version: '1', admissibility: 'declared', path: '$.questions.decision.instructions', text: 'Choose.\n', reads: ['$.questions.decision.instructions'], writes: ['$.questions.decision.instructions'], requires: ['declared_prose_path'], invalidates: [] },
  ], [bound]);
  const input = spec(); input.cases[0] = { id: 'case', candidate: witness, contract: bound };
  input.new.questions = { decision: { type: 'choice', instructions: 'Different.', criteria: { yes: 'yes', no: 'no' } } };
  const seen: Record<string, Set<string>> = { old: new Set(), new: new Set() };
  const report = await compareExperiment(input, target => new FakeProvider(r => {
    const question = Object.keys(r.questions)[0]!;
    seen[target.id]!.add(String(r.questions[question]!.instructions));
    return response('yes', .9, question);
  }));
  assert.equal(report.status, 'complete');
  assert.deepEqual([...seen.old!].sort(), ['Choose.', 'Choose.\n']);
  assert.deepEqual([...seen.new!].sort(), ['Different.', 'Different.\n']);
});

test('simultaneous source question rename swaps are translated from an atomic alias snapshot', async () => {
  const two: JevRequest = { state: {}, model: 'jev-test', questions: { q1: { type: 'choice', instructions: 'one', criteria: { yes: 'yes', no: 'no' } }, q2: { type: 'choice', instructions: 'two', criteria: { yes: 'yes', no: 'no' } } } };
  const bound: Contract = { ...contract, question: 'q1' };
  const witness = buildCandidate({ id: 'two', request: two, mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [], prosePaths: [] } }, [{ operator: 'question_id_rename', version: '1', admissibility: 'structural', renames: { q1: 'q2', q2: 'q1' }, reads: [], writes: [], requires: [], invalidates: [] }], [bound]);
  const input = spec(); input.cases[0] = { id: 'case', candidate: witness, contract: bound };
  input.new.questions = { target1: two.questions.q1!, target2: two.questions.q2! };
  input.new.sourceQuestionMapping = { q1: 'target1', q2: 'target2' };
  const report = await compareExperiment(input, () => new FakeProvider(r => ({ model: 'fake-jev-1', answers: Object.fromEntries(Object.keys(r.questions).map(id => [id, { type: 'choice', choice: 'yes', confidence: .9, probabilities: { yes: .9, no: .1 } }])), usage: { input_tokens: 0, output_tokens: 0 } })));
  assert.equal(report.status, 'complete');
});

test('existing within-target question and Choice-label maps assert the rebuilt mapped witness', async () => {
  const bound: Contract = { ...contract, relation: 'equivariant', mutations: ['question_id_rename', 'choice_label_rename'], admissibility: 'declared', assumptions: ['labels correspond'], labelMapping: { allow: 'yes', deny: 'no' } };
  const witness = buildCandidate({ id: 'labels', request: request(), mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [], prosePaths: [] } }, [
    { operator: 'question_id_rename', version: '1', admissibility: 'structural', renames: { decision: 'mutant_decision' }, reads: [], writes: [], requires: [], invalidates: [] },
    { operator: 'choice_label_rename', version: '1', admissibility: 'declared', question: 'decision', renames: { yes: 'allow', no: 'deny' }, reads: [], writes: [], requires: [], invalidates: [] },
  ], [bound]);
  const input = spec(); input.cases[0] = { id: 'case', candidate: witness, contract: bound };
  input.new.questions = { decisionV2: { type: 'choice', instructions: 'Choose.', criteria: { accept: 'yes', reject: 'no' } } };
  input.new.sourceQuestionMapping = { decision: 'decisionV2' }; input.new.sourceLabelMappings = { decision: { yes: 'accept', no: 'reject' } };
  input.new.questionMapping = { mutant_decision: 'decisionV2' }; input.new.labelMappings = { decisionV2: { allow: 'accept', deny: 'reject' } };
  const report = await compareExperiment(input, () => new FakeProvider(r => { const id = Object.keys(r.questions)[0]!, q = r.questions[id] as any, choice = Object.keys(q.criteria)[0]!; return { model: 'fake-jev-1', answers: { [id]: { type: 'choice', choice, confidence: .9, probabilities: Object.fromEntries(Object.keys(q.criteria).map((label: string) => [label, label === choice ? .9 : .1])) } }, usage: { input_tokens: 0, output_tokens: 0 } }; }));
  assert.equal(report.status, 'complete');
  input.new.labelMappings = { decisionV2: { allow: 'reject', deny: 'accept' } };
  let factories = 0; await assert.rejects(() => compareExperiment(input, () => { factories++; return new FakeProvider(); }), /label mappings/i); assert.equal(factories, 0);
});

test('Choice label aliases survive into later structural criteria paths', async () => {
  const rich: JevRequest = { state: {}, model: 'jev-test', questions: { decision: { type: 'choice', instructions: 'Choose.', criteria: { yes: { a: 'a', b: 'b' }, no: { a: 'n', b: 'n' } } } } };
  const bound: Contract = { ...contract, relation: 'equivariant', mutations: ['choice_label_rename', 'object_key_order'], admissibility: 'declared', assumptions: ['labels correspond'], labelMapping: { Y: 'yes', N: 'no' } };
  const witness = buildCandidate({ id: 'aliases', request: rich, mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [], prosePaths: [] } }, [
    { operator: 'choice_label_rename', version: '1', admissibility: 'declared', question: 'decision', renames: { yes: 'Y', no: 'N' }, reads: [], writes: [], requires: [], invalidates: [] },
    { operator: 'object_key_order', version: '1', admissibility: 'structural', orders: [{ path: '$.questions.decision.criteria.Y', order: ['b', 'a'] }], reads: ['$.questions.decision.criteria.Y'], writes: ['$.questions.decision.criteria.Y'], requires: [], invalidates: [] },
  ], [bound]);
  const input = spec(); input.cases[0] = { id: 'case', candidate: witness, contract: bound };
  input.new.questions = { decisionV2: { type: 'choice', instructions: 'Choose.', criteria: { allow: { a: 'a', b: 'b' }, reject: { a: 'n', b: 'n' } } } };
  input.new.sourceQuestionMapping = { decision: 'decisionV2' }; input.new.sourceLabelMappings = { decision: { yes: 'allow', no: 'reject' } };
  const report = await compareExperiment(input, () => new FakeProvider(r => { const id = Object.keys(r.questions)[0]!, q = r.questions[id] as any, choice = Object.keys(q.criteria)[0]!; return { model: 'fake-jev-1', answers: { [id]: { type: 'choice', choice, confidence: .9, probabilities: Object.fromEntries(Object.keys(q.criteria).map((label: string) => [label, label === choice ? .9 : .1])) } }, usage: { input_tokens: 0, output_tokens: 0 } }; }));
  assert.equal(report.status, 'complete');
});

test('changed target prose rejects ambiguous and no-op text normalization translations before factories', async () => {
  for (const [source, text, target] of [['  hello  ', 'hello', 'x  y'], ['hello\n', 'hello', 'target'], ['x\r\n', 'x\n', 'Different\r\nMiddle\r\n']] as const) {
    const bound: Contract = { ...contract, mutations: ['text_normalization'], admissibility: 'declared', assumptions: ['prose is declared'] };
    const seed = request(); seed.questions.decision!.instructions = source;
    const witness = buildCandidate({ id: 'text', request: seed, mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [], prosePaths: [] } }, [{ operator: 'text_normalization', version: '1', admissibility: 'declared', path: '$.questions.decision.instructions', text, reads: [], writes: [], requires: [], invalidates: [] }], [bound]);
    const input = spec(); input.cases[0] = { id: 'case', candidate: witness, contract: bound }; input.new.questions = { decision: { type: 'choice', instructions: target, criteria: { yes: 'yes', no: 'no' } } };
    let factories = 0; await assert.rejects(() => compareExperiment(input, () => { factories++; return new FakeProvider(); }), /ambiguous|no-op/i); assert.equal(factories, 0);
  }
});

for (const type of ['noul', 'score'] as const) test(`mapped ${type} criteria paths preserve typed observations and the structural witness`, async () => {
  const seed: JevRequest = { state: {}, model: 'jev-test', questions: { decision: type === 'noul'
    ? { type, instructions: 'Judge.', criteria: { true: { a: 'first', b: 'second' }, false: 'no' } }
    : { type, instructions: 'Judge.', criteria: [{ a: 'first', b: 'second' }, 'high'] } } };
  const path = `$.questions.decision.criteria${type === 'noul' ? '.true' : '[0]'}`;
  const bound: Contract = { ...contract, projection: type, mutations: ['object_key_order'], tolerance: 0 };
  const witness = buildCandidate({ id: type, request: seed, mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [], prosePaths: [] } }, [
    { operator: 'object_key_order', version: '1', admissibility: 'structural', orders: [{ path, order: ['b', 'a'] }], reads: [path], writes: [path], requires: [], invalidates: [] },
  ], [bound]);
  const input = spec(); input.cases[0] = { id: 'case', candidate: witness, contract: bound };
  input.new.sourceQuestionMapping = { decision: 'decisionV2' };
  const seen: Record<string, Set<string>> = { old: new Set(), new: new Set() };
  let calls = 0;
  const report = await compareExperiment(input, target => new FakeProvider(r => {
    calls++;
    const question = target.id === 'old' ? 'decision' : 'decisionV2';
    assert.deepEqual(Object.keys(r.questions), [question]);
    const q = r.questions[question]!;
    assert.equal(q.type, type);
    assert.ok(q.type === 'noul' || q.type === 'score');
    const ordered = q.type === 'noul' ? q.criteria!.true : q.criteria[0];
    seen[target.id]!.add(Object.keys(ordered!).join(','));
    return { model: 'fake-jev-1', answers: { [question]: type === 'noul'
      ? { type: 'noul', noul: .2 }
      : { type: 'score', score: 0, probabilities: { '0': 1, '1': 0 }, confidence: 1, legend: { '0': 'low', '1': 'high' } } }, usage: { input_tokens: 0, output_tokens: 0 } };
  }));
  assert.equal(report.status, 'complete', JSON.stringify(report));
  assert.equal(report.cases[0]?.status, 'no_detected_regression');
  assert.equal(calls, 10);
  for (const target of ['old', 'new']) assert.deepEqual([...seen[target]!].sort(), ['a,b', 'b,a']);
});

test('direct compare rejects unsafe runtime mapping values before factories', async () => {
  const input = spec() as any;
  input.new.sourceQuestionMapping = { decision: 7 };
  let factories = 0;
  await assert.rejects(() => compareExperiment(input, () => { factories++; return new FakeProvider(); }), /safe string map/i);
  assert.equal(factories, 0);
});

test('real CLI compare prepares mapped targets before its injected provider is used', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jevfuzz-compare-'));
  try {
    const input = structuredClone(spec()) as any;
    input.new.questions = { decisionV2: { type: 'choice', instructions: 'Choose.', criteria: { allow: 'yes', deny: 'no' } } };
    input.new.sourceQuestionMapping = { decision: 'decisionV2' };
    input.new.sourceLabelMappings = { decision: { yes: 'allow', no: 'deny' } };
    const file = join(root, 'experiment.json'), out = join(root, 'report.json');
    await writeFile(file, JSON.stringify(input));
    let calls = 0;
    const provider = new FakeProvider(r => { calls++; const question = Object.keys(r.questions)[0]!, mapped = r.questions[question]?.type === 'choice' && Object.hasOwn(r.questions[question].criteria, 'allow'); return mapped ? { model: 'fake-jev-1', answers: { [question]: { type: 'choice', choice: 'allow', confidence: .9, probabilities: { allow: .9, deny: .1 } } }, usage: { input_tokens: 0, output_tokens: 0 } } : response('yes', .9, question); });
    assert.equal(await main(['compare', file, '--out', out], { env: {}, provider, stdout: () => {}, stderr: () => {} }), 0);
    assert.equal(calls, 10);
    input.new.sourceQuestionMapping = { decision: 7 };
    await writeFile(file, JSON.stringify(input)); calls = 0;
    assert.equal(await main(['compare', file, '--out', out], { env: {}, provider, stdout: () => {}, stderr: () => {} }), 2);
    assert.equal(calls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
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
