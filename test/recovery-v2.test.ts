import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadCampaign } from '../src/campaign-config.ts';
import { campaign, resumeCampaign } from '../src/engine/campaign.ts';
import { recoverCampaign } from '../src/engine/recovery.ts';
import { ExecutionJournal } from '../src/engine/journal.ts';
import { FakeProvider } from '../src/provider.ts';

const fixture = new URL('../fixtures/v2/routing.campaign.json', import.meta.url).pathname;
test('resume after a committed batch preserves candidate sequence, budget lineage and no duplicated calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jevfuzz-resume-'));
  try {
    const config = await loadCampaign(fixture); config.storage.directory = root; config.search.maxCandidates = 20; config.search.strategy = 'feedback';
    const baseline = await campaign(config, new FakeProvider(), { persist: false });
    const abort = new AbortController(); let count = 0;
    const interrupted = await campaign(config, new FakeProvider(), { signal: abort.signal, onCheckpoint: () => { if (++count === 1) abort.abort(); } });
    assert.equal(interrupted.status, 'incomplete');
    const checkpoint = join(interrupted.directory!, 'checkpoint.json');
    const resumed = await resumeCampaign(checkpoint, new FakeProvider());
    assert.equal(resumed.status, 'complete'); assert.equal(resumed.budget.lineageBudgetId, interrupted.budget.lineageBudgetId);
    assert.equal(resumed.budget.logical.consumedKnown, baseline.budget.logical.consumedKnown);
    assert.deepEqual(resumed.results.map(r => r.candidateId), baseline.results.map(r => r.candidateId));
    assert.deepEqual(resumed.coverageProxy, baseline.coverageProxy);
    await assert.rejects(resumeCampaign(checkpoint, new FakeProvider()), /already resumed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('durable unresolved dispatch is consumed unknown and skipped, while stale cached balances cannot resurrect it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jevfuzz-crash-'));
  try {
    const config = await loadCampaign(fixture); config.storage.directory = root; config.search.maxCandidates = 20;
    const abort = new AbortController();
    const run = await campaign(config, new FakeProvider(), { signal: abort.signal, onCheckpoint: () => abort.abort() });
    const path = join(run.directory!, 'checkpoint.json'), saved = JSON.parse(await readFile(path, 'utf8'));
    const candidateId = saved.scheduler.remaining[0], operationId = saved.runId + ':' + candidateId + ':base';
    const journal = await ExecutionJournal.resume(saved.journalFile);
    await journal.append('reservation', { operationId, attemptId: 'crashed-logical', phase: 'discovery', kind: 'logical' });
    await journal.append('dispatched', { operationId, attemptId: 'crashed-logical', phase: 'discovery', kind: 'logical' });
    await journal.close();
    saved.budget.logical.remaining = config.budget.logicalRequests;
    await writeFile(path, JSON.stringify(saved));
    const recovery = await recoverCampaign(path);
    assert.equal(recovery.budget.logical.consumedUnknown, 1);
    assert.equal(recovery.budget.logical.remaining, config.budget.logicalRequests - run.budget.logical.consumedKnown - 1);
    assert.equal(recovery.unresolved, 1); assert.ok(!recovery.scheduler.remaining.includes(candidateId));
    const resumed = await resumeCampaign(path, new FakeProvider());
    assert.equal(resumed.exitCode, 3); assert.equal(resumed.budget.logical.consumedUnknown, 1);
    assert.equal(resumed.results.filter(r => r.candidateId === candidateId).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('checkpoint config/component tampering is rejected before provider calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jevfuzz-recovery-invalid-'));
  try {
    const config = await loadCampaign(fixture); config.storage.directory = root; config.search.maxCandidates = 3;
    const run = await campaign(config, new FakeProvider());
    const path = join(run.directory!, 'checkpoint.json'), saved = JSON.parse(await readFile(path, 'utf8'));
    saved.config.budget.logicalRequests += 1000; await writeFile(path, JSON.stringify(saved));
    let calls = 0;
    await assert.rejects(resumeCampaign(path, new FakeProvider(() => { calls++; throw new Error('must not dispatch'); })), /configuration changed/);
    assert.equal(calls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('completed campaigns reject resume without creating a child or spending requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jevfuzz-complete-resume-'));
  try {
    const config = await loadCampaign(fixture); config.storage.directory = root; config.search.maxCandidates = 2;
    const run = await campaign(config, new FakeProvider()); const before = await readdir(join(root, 'runs'));
    let calls = 0;
    await assert.rejects(resumeCampaign(join(run.directory!, 'checkpoint.json'), new FakeProvider(() => { calls++; throw new Error('must not call'); })), /completed campaigns/);
    assert.equal(calls, 0); assert.deepEqual(await readdir(join(root, 'runs')), before);
    assert.doesNotMatch(await readFile(join(run.directory!, 'events.jsonl'), 'utf8'), /resume-child/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('resume closes a mixed cohort and pays for fresh observations within the inherited budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jevfuzz-cohort-resume-'));
  try {
    const config = await loadCampaign(fixture); config.storage.directory = root; config.search.maxCandidates = 10;
    const answers = (request: any) => Object.fromEntries(Object.entries(request.questions).map(([id, q]: any) => [id, q.type === 'choice' ? { type: 'choice', choice: 'billing', confidence: 1, probabilities: { billing: 1, general: 0 } } : { type: 'noul', noul: .2 }]));
    const first = await campaign(config, new FakeProvider((request, index) => ({ model: index === 0 ? 'old' : 'new', answers: answers(request), usage: { input_tokens: 0, output_tokens: 0 } })));
    assert.equal(first.stopReason, 'model_changed'); assert.equal(first.observedModels.length, 2);
    const child = await resumeCampaign(join(first.directory!, 'checkpoint.json'), new FakeProvider(request => ({ model: 'new', answers: answers(request), usage: { input_tokens: 0, output_tokens: 0 } })));
    assert.equal(child.status, 'complete'); assert.deepEqual(child.observedModels, ['new']);
    assert.equal(child.budget.lineageBudgetId, first.budget.lineageBudgetId);
    assert.ok(child.budget.logical.consumedKnown > first.budget.logical.consumedKnown); assert.ok(child.results.length > 0);
    assert.match(child.warnings.join(' '), /fresh baselines/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
