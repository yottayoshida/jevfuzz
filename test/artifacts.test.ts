import assert from 'node:assert/strict';
import { mkdtemp, lstat, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { importTrace, loadFailure, renderText, replay, saveArtifacts } from '../src/artifacts.ts';
import { loadConfig } from '../src/config.ts';
import { FakeProvider } from '../src/provider.ts';
import { run } from '../src/runner.ts';
import type { FailureArtifact, FuzzConfig, JevRequest } from '../src/types.ts';

const request: JevRequest = { state: { trace: 'private' }, model: 'jev-test', questions: { decision: { type: 'choice', instructions: 'private instructions', criteria: { yes: 'yes', no: 'no' } } } };
const config: FuzzConfig = { version: 1, name: 'artifact-case', cases: [{ id: 'artifact-case', request, baselineRuns: 2, mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [], prosePaths: [] }, invariants: {} }] };

async function directory(): Promise<string> { return mkdtemp(join(tmpdir(), 'jevfuzz-artifacts-')); }

test('saveArtifacts creates private complete reports and human text', async () => {
  const root = await directory();
  try {
    const report = await run(config, new FakeProvider(), { seed: 1, confirmRuns: 2, concurrency: 1, maxRequests: 100 });
    const saved = await saveArtifacts(report, root);
    assert.equal((await lstat(saved)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(saved, 'report.json'))).mode & 0o777, 0o600);
    assert.match(await readFile(join(saved, 'report.txt'), 'utf8'), /JevFuzz 0\.1\.0/);
    assert.match(renderText(report), /baseline stable/);
    const display = structuredClone(report);
    display.run.modelChanged = true; display.run.requestedModels = ['jev-requested']; display.run.observedModels = ['jev-a', 'jev-b'];
    display.summary = { ...display.summary, pass: 2, warn: 3, fail: 4, inconclusive: 5, logicalRequests: 6, httpAttempts: 9, httpRetries: 3, usage: { inputTokens: 7, outputTokens: 8 } };
    const baseline = display.cases[0]!.baseline.decision!;
    baseline.stable = false; baseline.agreementRatio = 0.5; baseline.runs = 2;
    const text = renderText(display);
    assert.match(text, /baseline unstable 1\/2/);
    assert.match(text, /PASS: 2/); assert.match(text, /WARN: 3/); assert.match(text, /FAIL: 4/); assert.match(text, /INCONCLUSIVE: 5/);
    assert.match(text, /HTTP attempts: 9 \(retries: 3\)/); assert.match(text, /output tokens: 8/);
    assert.match(text, /model drift: requested jev-requested; observed jev-a -> jev-b/);
    assert.ok(JSON.parse(await readFile(join(saved, 'manifest.json'), 'utf8')).complete);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('hash-only artifacts omit payloads and never create replay files', async () => {
  const root = await directory();
  try {
    const report = await run(config, new FakeProvider(), { seed: 1, confirmRuns: 2, concurrency: 1, maxRequests: 100 });
    const saved = await saveArtifacts(report, root, false);
    const json = await readFile(join(saved, 'report.json'), 'utf8');
    assert.equal(json.includes('private instructions'), false);
    assert.equal(json.includes('private'), false);
    assert.equal(JSON.parse(json).replay.available, false);
    await assert.rejects(lstat(join(saved, 'failures')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('artifact directories reject symlink components', async () => {
  const root = await directory();
  const target = await directory();
  try {
    await symlink(target, join(root, 'linked'));
    const report = await run(config, new FakeProvider(), { seed: 1, confirmRuns: 2, concurrency: 1, maxRequests: 100 });
    await assert.rejects(saveArtifacts(report, join(root, 'linked')), /symbolic-link|symlink/i);
  } finally { await rm(root, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); }
});

test('importTrace extracts only validated Jev requests', async () => {
  const root = await directory();
  try {
    const trace = join(root, 'trace.jsonl');
    await writeFile(trace, `${JSON.stringify({ version: 1, source: 'jev-intent-review', timestamp: '2026-09-22T00:00:00.000Z', request, response: { secret: 'historical' } })}\n`);
    const files = await importTrace(trace, join(root, 'imports'));
    assert.equal(files.length, 1);
    const imported = await readFile(files[0]!, 'utf8');
    assert.equal(imported.includes('historical'), false);
    assert.equal(imported.includes('private instructions'), true);
    const parsed = await loadConfig(files[0]!);
    const rerun = await run(parsed, new FakeProvider(), { seed: 3, confirmRuns: 2, concurrency: 1, maxRequests: 100 });
    assert.equal(rerun.summary.pass > 0, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('trace import rejects missing timestamp or response before writing', async () => {
  const root = await directory();
  try {
    for (const extra of [{ response: {} }, { timestamp: 'bad', response: {} }, { timestamp: '2026-09-22T00:00:00.000Z' }]) {
      const trace = join(root, 'invalid.jsonl');
      await writeFile(trace, JSON.stringify({ version: 1, source: 'jev-intent-review', request, ...extra }));
      await assert.rejects(importTrace(trace, join(root, 'imports')), /trace line/);
      await assert.rejects(lstat(join(root, 'imports')));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('human confirmed failure identifies decisions, strategy and the actual replay file', async () => {
  const root = await directory();
  try {
    const provider = new FakeProvider(r => {
      const answers = Object.fromEntries(Object.entries(r.questions).map(([id, q]) => {
        const choices = Object.keys(q.criteria!);
        return [id, { type: 'choice', choice: choices[0], confidence: 1, probabilities: Object.fromEntries(choices.map((v, i) => [v, i === 0 ? 1 : 0])) }];
      }));
      return { model: 'jev-test', answers, usage: { input_tokens: 1, output_tokens: 1 } } as any;
    });
    const report = await run(config, provider, { seed: 42, concurrency: 1 });
    assert.ok(report.summary.fail > 0);
    const saved = await saveArtifacts(report, root);
    const text = await readFile(join(saved, 'report.txt'), 'utf8');
    assert.match(text, /choice_criteria_order \/ reverse/);
    assert.match(text, /baseline 2\/2 yes/);
    assert.match(text, /mutated 3\/3 no/);
    assert.ok(text.includes(join(saved, 'failures', 'F001.json')));
    assert.match(text, /jevfuzz replay/);
    assert.doesNotMatch(text, /--provider cloudflare/);
    assert.match(renderText(report, { directory: saved, replayProvider: 'cloudflare' }), /jevfuzz replay '[^\n]+' --provider cloudflare/);
    assert.equal((await loadFailure(join(saved, 'failures', 'F001.json'))).comparison.verdict, 'FAIL');
    const withoutPayloads = await saveArtifacts({ ...report, run: { ...report.run, id: `${report.run.id}-hash` } }, root, false);
    const privateText = await readFile(join(withoutPayloads, 'report.txt'), 'utf8');
    assert.match(privateText, /replay unavailable/);
    assert.doesNotMatch(privateText, /jevfuzz replay|failures\/F001/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('replay uses exact artifact requests, confirms position-sensitive failure, and preflights budget', async () => {
  const mutated = structuredClone(request);
  mutated.state = { trace: 'private', reordered: true };
  const artifact: FailureArtifact = {
    version: 1, runId: 'r1', caseId: 'c1', questionId: 'decision', mutation: { type: 'object_key_order', strategy: 'reverse', seed: 2 }, idMap: { decision: 'decision' },
    baselineRequest: request, mutatedRequest: mutated,
    baselineResponses: [], mutatedResponses: [], comparison: { verdict: 'FAIL', reason: 'FAIL_CHOICE_CHANGED', warnings: [], baseline: { type: 'choice', stable: true, runs: 2, modalChoice: 'yes', agreementRatio: 1 }, mutated: { type: 'choice', stable: true, runs: 3, modalChoice: 'no', agreementRatio: 1 }, thresholds: { noulBaselineRange: .1, scoreBaselineRange: .35, noulThreshold: .5, noulMinDelta: .15, scoreDelta: .5, jsDivergence: .15, confidenceDrop: .3, noulProbabilityShift: .2 }, reproduced: 3, observations: 3 }, model: 'jev-test', seed: 2, baselineRuns: 2, confirmRuns: 2,
  };
  const provider = new FakeProvider(input => ({ model: 'jev-test', answers: { decision: input.state && typeof input.state === 'object' && 'reordered' in input.state ? { type: 'choice', choice: 'no', probabilities: { yes: .1, no: .9 }, confidence: .9 } : { type: 'choice', choice: 'yes', probabilities: { yes: .9, no: .1 }, confidence: .9 } }, usage: { input_tokens: 1, output_tokens: 1 } }));
  const report = await replay(artifact, provider, { maxRequests: 20, concurrency: 1, seed: 9, baselineRuns: 3, confirmRuns: 3 });
  assert.equal(report.run.mode, 'replay');
  assert.equal(report.summary.fail, 1);
  assert.equal(report.run.seed, 9);
  assert.equal(report.summary.logicalRequests, 7);
  let calls = 0;
  await assert.rejects(replay(artifact, new FakeProvider(() => { calls++; throw new Error('must not call'); }), { maxRequests: 1 }), /budget/i);
  assert.equal(calls, 0);
  const root = await directory();
  try {
    const file = join(root, 'failure.json'); await writeFile(file, JSON.stringify(artifact));
    assert.equal((await loadFailure(file)).caseId, 'c1');
    const wrongModel = structuredClone(artifact); wrongModel.mutatedRequest.model = 'other-model';
    await writeFile(join(root, 'wrong-model.json'), JSON.stringify(wrongModel));
    await assert.rejects(loadFailure(join(root, 'wrong-model.json')), /same model/i);
    const wrongMap = structuredClone(artifact); wrongMap.idMap = { unknown: 'decision' };
    await writeFile(join(root, 'wrong-map.json'), JSON.stringify(wrongMap));
    await assert.rejects(loadFailure(join(root, 'wrong-map.json')), /question map/i);
    for (const id of ['__proto__', 'constructor']) {
      const reserved = structuredClone(artifact);
      reserved.questionId = id; reserved.idMap = {};
      reserved.baselineRequest.questions = Object.fromEntries([[id, request.questions.decision!]]);
      reserved.mutatedRequest.questions = structuredClone(reserved.baselineRequest.questions);
      await writeFile(file, JSON.stringify(reserved));
      assert.equal((await loadFailure(file)).questionId, id);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
