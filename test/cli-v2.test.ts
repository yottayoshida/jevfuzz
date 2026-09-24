import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli/main.ts';
import { FakeProvider } from '../src/provider.ts';
import { buildCandidate } from '../src/mutators/index.ts';
import { confirmCandidate, createFinding } from '../src/oracles/index.ts';
import { evaluateRelation } from '../src/contracts/index.ts';
import { saveFinding } from '../src/artifacts-v2.ts';
import { addToCorpus, triageCorpus } from '../src/corpus/index.ts';
import { loadFinding } from '../src/artifacts-v2.ts';
import type { Contract, Observation, Phase } from '../src/campaign-types.ts';
import type { JevResponse } from '../src/types.ts';

async function campaignFile(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'jevfuzz-cli-v2-'));
  const value = {
    version: 2, name: 'cli-v2', provider: 'custom',
    seeds: [{ id: 'seed', request: { state: { value: 1 }, model: 'fake-jev-1', questions: { decision: { type: 'choice', instructions: 'Choose.', criteria: { yes: 'yes', no: 'no' } } } }, mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [], prosePaths: [] } }],
    contracts: [{ id: 'choice', question: 'decision', relation: 'invariant', projection: 'choice', mutations: ['question_id_rename'], admissibility: 'structural', assumptions: [], required: true }],
    search: { strategy: 'enumerator', seed: 42, maxDepth: 1, batchSize: 1, concurrency: 1, uniformFraction: .2, stagnationBatches: 1, maxCandidates: 4, maxQueueBytes: 1048576, familyQuota: 4 },
    oracle: { profile: 'paired-v1', pairs: 1, minimumSupport: 1, maxControlViolationRate: 0, minimumEffect: 0, alpha: .05, originalSlots: 5, shrinkSlots: 5 },
    budget: { logicalRequests: 40, httpAttempts: 0, wallTimeSeconds: 30, discoveryRequests: 10, confirmationRequests: 12, shrinkRequests: 9, finalConfirmationRequests: 9 },
    storage: { mode: 'full', directory: join(root, 'store'), maxRunBytes: 1048576, maxCorpusBytes: 1048576, redactPaths: [] },
    reducers: { independentQuestions: false, optionalStatePaths: [], unorderedArrayPaths: [], prosePaths: [] },
  };
  const file = join(root, 'campaign.json'); await writeFile(file, JSON.stringify(value)); return { root, file };
}

async function findingFile(root: string, model='fake-jev-1', minimumSupport=1): Promise<string> {
  const seed = { id: 'seed', mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [], prosePaths: [] }, request: { state: {}, model, questions: { route: { type: 'choice' as const, instructions: 'x', criteria: { billing: 'bill', general: 'general' } } } } };
  const contract: Contract = { id: 'route', question: 'route', relation: 'invariant', projection: 'choice', mutations: ['question_id_rename'], admissibility: 'structural', assumptions: [], required: true };
  const candidate = buildCandidate(seed, [{ operator: 'question_id_rename', version: '1', admissibility: 'structural', renames: { route: 'renamed' }, reads: [], writes: [], requires: [], invalidates: [] }], [contract], undefined, 'custom');
  let index = 0;
  const executor = { modelChanged: false, async evaluate(payload: string, phase: Phase): Promise<Observation> {
    const id = Object.keys(JSON.parse(payload).questions)[0]!; const choice = id === 'route' ? 'billing' : 'general';
    const response: JevResponse = { model: 'fake-jev-1', answers: { [id]: { type: 'choice', choice, confidence: 1, probabilities: choice === 'billing' ? { billing: 1, general: 0 } : { billing: 0, general: 1 } } }, usage: { input_tokens: 0, output_tokens: 0 } };
    index++; return { id: `id-${index}`, operationId: `operation-${index}`, phase, wireHash: payload === candidate.basePayload ? candidate.baseWireHash : candidate.mutantWireHash, response, provider: 'fake', observedModel: 'fake-jev-1', cache: 'fresh' };
  } };
  const a = await executor.evaluate(candidate.basePayload, 'discovery'), b = await executor.evaluate(candidate.mutantPayload, 'discovery');
  const oracle = { profile: 'paired-v1' as const, pairs: 1, minimumSupport, maxControlViolationRate: 0, minimumEffect: 0, alpha: .05, originalSlots: 0, shrinkSlots: 0 };
  const confirmation = await confirmCandidate(candidate, contract, executor, oracle, { signature: evaluateRelation(candidate, contract, a.response, b.response).signature!, seed: 1 });
  const path = join(root, `finding-${model}.json`); await saveFinding(createFinding(candidate, contract, oracle, confirmation, { provider: 'custom', reducers: { independentQuestions: false, optionalStatePaths: [], unorderedArrayPaths: [], prosePaths: [] } }), path); return path;
}

test('direct v2 plan selects the v2 campaign parser and makes zero provider calls', async () => {
  const { root, file } = await campaignFile();
  try {
    let stdout = '', calls = 0;
    const provider = { async evaluate() { calls++; throw new Error('must not evaluate'); } };
    assert.equal(await main(['plan', file, '--json'], { env: {}, provider, stdout: text => { stdout += text; }, stderr: () => {} }), 0);
    const planned = JSON.parse(stdout); assert.equal(planned.version, 2); assert.equal(planned.networkCalls, 0); assert.equal(planned.candidatesList, undefined); assert.equal(calls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('direct fuzz accepts an injected fake provider and persists no credentials', async () => {
  const { root, file } = await campaignFile();
  try {
    let stdout = '', stderr = '';
    const code = await main(['fuzz', file, '--json'], { env: { TYPESAFE_API_KEY: 'do-not-print' }, provider: new FakeProvider(), stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
    assert.ok([0, 1, 3].includes(code)); assert.equal(JSON.parse(stdout).version, 2); assert.ok(!`${stdout}${stderr}`.includes('do-not-print'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('v2 commands reject missing inputs without constructing a live provider', async () => {
  let calls = 0;
  const provider = { async evaluate() { calls++; throw new Error('unexpected'); } };
  assert.equal(await main(['compare'], { env: {}, provider, stdout: () => {}, stderr: () => {} }), 2);
  assert.equal(await main(['check'], { env: {}, provider, stdout: () => {}, stderr: () => {} }), 2);
  assert.equal(calls, 0);
});
test('check refuses a foreign provider override before any provider call', async () => {
  const root=await mkdtemp(join(tmpdir(),'jevfuzz-cli-provider-'));
  try {
    const finding=await loadFinding(await findingFile(root)), corpus=join(root,'corpus'), id=await addToCorpus(finding,corpus);
    await triageCorpus(corpus,id,'accepted_regression',{actor:'a',reason:'reviewed'});
    let calls=0, error='';
    const code=await main(['check',corpus,'--provider','cloudflare'],{env:{},provider:new FakeProvider(()=>{calls++;throw new Error('must not call');}),stdout:()=>{},stderr:text=>{error+=text;}});
    assert.equal(code,2); assert.match(error,/provider identity/); assert.equal(calls,0);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('direct corpus inspect and check use the v2 command path with an injected provider', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jevfuzz-cli-v2-corpus-'));
  try {
    let stdout = '';
    assert.equal(await main(['corpus', 'inspect', root, '--json'], { env: {}, stdout: text => { stdout += text; }, stderr: () => {} }), 0);
    assert.deepEqual(JSON.parse(stdout).entries, []);
    stdout = '';
    assert.equal(await main(['check', root, '--json'], { env: {}, provider: new FakeProvider(), stdout: text => { stdout += text; }, stderr: () => {} }), 3);
    assert.equal(JSON.parse(stdout).kind, 'check');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('check --profile creates complete fixed-stat defaults with selected slots', async () => {
  const root=await mkdtemp(join(tmpdir(),'jevfuzz-cli-profile-'));
  try {
    const finding=await loadFinding(await findingFile(root)), corpus=join(root,'corpus'), id=await addToCorpus(finding,corpus);
    await triageCorpus(corpus,id,'accepted_regression',{actor:'a',reason:'reviewed'});
    let stdout=''; const code=await main(['check',corpus,'--profile','fixed-stat-v1','--json'],{env:{},provider:new FakeProvider(),stdout:text=>{stdout+=text;},stderr:()=>{}});
    assert.ok([0,1,3].includes(code)); const report=JSON.parse(stdout); assert.deepEqual(report.oracle,{profile:'fixed-stat-v1',pairs:64,minimumSupport:.75,maxControlViolationRate:.125,minimumEffect:0,alpha:.05,originalSlots:1,shrinkSlots:0}); assert.equal(report.results[0].confirmation.confirmationSamples,192); assert.equal(report.results[0].confirmation.controls,64); assert.equal(report.budget.logical.limit,194);
  } finally { await rm(root,{recursive:true,force:true}); }
});
test('check CLI rejects mixed selected defaults before injected provider calls', async () => {
  const root=await mkdtemp(join(tmpdir(),'jevfuzz-cli-mixed-oracle-'));
  try {
    const first=await loadFinding(await findingFile(root)), second=await loadFinding(await findingFile(root,'other-model',.5)), corpus=join(root,'corpus');
    const firstId=await addToCorpus(first,corpus), secondId=await addToCorpus(second,corpus); await triageCorpus(corpus,firstId,'accepted_regression',{actor:'a',reason:'reviewed'}); await triageCorpus(corpus,secondId,'accepted_regression',{actor:'a',reason:'reviewed'});
    let calls=0,error=''; const code=await main(['check',corpus],{env:{},provider:new FakeProvider(()=>{calls++;throw new Error('must not call');}),stdout:()=>{},stderr:text=>{error+=text;}});
    assert.equal(code,2); assert.match(error,/oracle configurations differ/); assert.equal(calls,0);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('replay and shrink require private output, journal before evaluation, and persist output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jevfuzz-cli-v2-finding-'));
  try {
    const finding = await findingFile(root), replayOut = join(root, 'replay.json'), shrinkOut = join(root, 'shrink.json');
    assert.equal(await main(['replay', finding], { env: {}, provider: new FakeProvider(), stdout: () => {}, stderr: () => {} }), 2);
    assert.ok([0, 1, 3].includes(await main(['replay', finding, '--out', replayOut, '--json'], { env: {}, provider: new FakeProvider(), stdout: () => {}, stderr: () => {} })));
    assert.equal((await stat(replayOut)).mode & 0o077, 0); assert.ok((await stat(`${replayOut}.events.jsonl`)).size > 0);
    assert.ok([0, 1, 3].includes(await main(['shrink', finding, '--out', shrinkOut, '--json'], { env: {}, provider: new FakeProvider(), stdout: () => {}, stderr: () => {} })));
    assert.ok((await stat(`${shrinkOut}.events.jsonl`)).size > 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('report writes requested HTML output and corpus add accepts the documented --corpus syntax', async () => {
  const { root } = await campaignFile();
  try {
    const finding = await findingFile(root), html = join(root, 'report.html'), corpus = join(root, 'corpus');
    assert.equal(await main(['report', finding, '--format', 'html', '--out', html], { env: {}, stdout: () => {}, stderr: () => {} }), 0);
    assert.match(await (await import('node:fs/promises')).readFile(html, 'utf8'), /Content-Security-Policy/);
    assert.equal(await main(['corpus', 'add', finding, '--corpus', corpus], { env: {}, stdout: () => {}, stderr: () => {} }), 0);
    assert.equal(await main(['corpus', 'inspect', corpus], { env: {}, stdout: () => {}, stderr: () => {} }), 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('provider overrides bind a fresh campaign and required pending confirmation exits three', async () => {
  const { root, file } = await campaignFile();
  try {
    const config = JSON.parse(await readFile(file, 'utf8')); config.budget.confirmationRequests = 3;
    config.contracts.push({ ...config.contracts[0], id: 'second-contract' });
    await writeFile(file, JSON.stringify(config)); let stdout = '', stderr = '';
    const source = new FakeProvider((request, index) => {
      const id = Object.keys(request.questions)[0]!, changed = index === 1;
      return { model: 'sim', answers: { [id]: { type: 'choice', choice: changed ? 'no' : 'yes', confidence: 1, probabilities: { yes: changed ? 0 : 1, no: changed ? 1 : 0 } } }, usage: { input_tokens: 0, output_tokens: 0 } };
    });
    const exit = await main(['fuzz', file, '--provider', 'cloudflare', '--require-confirmation-complete', '--json'], { env: {}, provider: source, stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
    assert.equal(exit, 3, stderr); const report = JSON.parse(stdout);
    assert.equal(report.provider, 'cloudflare'); assert.equal(report.exitCode, 3); assert.ok(report.summary.pending > 0);
    const checkpoint = JSON.parse(await readFile(join(report.directory, 'checkpoint.json'), 'utf8'));
    assert.equal(checkpoint.config.provider, 'cloudflare');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('malicious provider metadata rejects replay before any injected provider call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jevfuzz-provider-reject-'));
  try {
    const file = await findingFile(root), finding = JSON.parse(await readFile(file, 'utf8')); finding.provider = 'bogus';
    await writeFile(file, JSON.stringify(finding)); let calls = 0, error = '';
    assert.equal(await main(['replay', file, '--out', join(root, 'replay.json')], { env: {}, provider: new FakeProvider(() => { calls++; throw new Error('must not call'); }), stdout: () => {}, stderr: text => { error += text; } }), 2);
    assert.equal(calls, 0); assert.match(error, /provider/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('report readers reject unknown JSON in both plain and JSON output modes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jevfuzz-report-reject-'));
  try {
    const file = join(root, 'report.json'); await writeFile(file, JSON.stringify({ version: 2, kind: 'check', unexpected: true }));
    for (const args of [['report', file], ['report', file, '--json'], ['inspect', file], ['inspect', root]]) {
      let stdout = '';
      assert.equal(await main(args, { env: {}, stdout: text => { stdout += text; }, stderr: () => {} }), 2);
      assert.equal(stdout, '');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('v2 inspect refuses a credential in validated input before printing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jevfuzz-v2-escaped-secret-'));
  try {
    const token = 'secret"value';
    const file = await findingFile(root, token);
    let stdout = '', stderr = '';
    const code = await main(['inspect', file, '--json'], {
      env: { TYPESAFE_API_KEY: token },
      stdout: text => { stdout += text; }, stderr: text => { stderr += text; },
    });
    assert.equal(code, 2);
    assert.equal(stdout, '');
    assert.doesNotMatch(stderr, /secret/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
