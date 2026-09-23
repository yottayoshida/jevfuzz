import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadCampaign } from '../src/campaign-config.ts';
import { campaign, planCampaign } from '../src/engine/campaign.ts';
import { FakeProvider } from '../src/provider.ts';
import { renderReportText } from '../src/reports-v2.ts';
import type { JevRequest, JevResponse } from '../src/types.ts';

const fixture = new URL('../fixtures/v2/routing.campaign.json', import.meta.url).pathname;
function simulator(request: JevRequest, bug = true): JevResponse {
  const order = Object.keys(request.questions);
  const changed = bug && typeof request.state === 'object' && request.state !== null && Object.hasOwn(request.state, 'trace_id') && request.questions[order[0]!]!.type === 'noul';
  return { model: 'simulator-routing-v1', usage: { input_tokens: 0, output_tokens: 0 }, answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id, q.type === 'choice' ? { type: 'choice', choice: changed ? 'general' : 'billing', confidence: .9, probabilities: { general: changed ? .9 : .1, billing: changed ? .1 : .9 } } : { type: 'noul', noul: .2 }])) };
}
test('campaign detects a noncontiguous order-plus-metadata interaction using only fresh confirmations', async () => {
  const config = await loadCampaign(fixture); config.search.strategy = 'enumerator'; config.search.maxCandidates = 200;
  config.budget = { ...config.budget, logicalRequests: 1500, discoveryRequests: 900, confirmationRequests: 480, shrinkRequests: 96, finalConfirmationRequests: 24 };
  const plan = planCampaign(config); assert.equal(plan.networkCalls, 0); assert.equal(plan.confirmationCallsPerCandidate, 24);
  const result = await campaign(config, new FakeProvider(r => simulator(r)), { persist: false });
  assert.equal(result.status, 'complete'); assert.equal(result.exitCode, 1); assert.ok(result.findings.length > 0);
  for (const finding of result.findings) {
    assert.equal(finding.candidate.recipe.length, 2);
    assert.ok(finding.candidate.recipe.some(step => step.operator === 'question_order'));
    assert.ok(finding.candidate.recipe.some(step => step.operator === 'irrelevant_field_injection'));
    assert.equal(finding.confirmation.confirmationSamples, 24);
    assert.ok(finding.confirmation.blocks.every(block => [block.a, block.control, block.b].every(o => o.phase === 'confirmation')));
  }
  assert.equal(result.budget.logical.activeReserved, 0);
  assert.equal(result.budget.http.consumedKnown, 0);
});
test('batch selection and stable corpus do not depend on configured concurrency', async () => {
  const config = await loadCampaign(fixture); config.search.strategy = 'feedback';
  const runs = [];
  for (const concurrency of [1, 4, 8]) { config.search.concurrency = concurrency; runs.push(await campaign(config, new FakeProvider(r => simulator(r, false)), { persist: false })); }
  for (const run of runs) {
    assert.deepEqual(run.results.map(r => r.candidateId), runs[0]!.results.map(r => r.candidateId));
    assert.deepEqual(run.coverageProxy, runs[0]!.coverageProxy); assert.equal(run.findings.length, 0);
  }
});
test('campaign persists a private complete checkpoint and withholds replay evidence in hash-only mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jevfuzz-campaign-'));
  try {
    const config = await loadCampaign(fixture); config.storage.directory = directory; config.search.maxCandidates = 3;
    const result = await campaign(config, new FakeProvider(r => simulator(r, false)));
    assert.equal(result.status, 'complete'); assert.ok(result.directory);
    const checkpoint = JSON.parse(await readFile(join(result.directory!, 'checkpoint.json'), 'utf8'));
    assert.equal(checkpoint.configHash, result.configHash); assert.equal(checkpoint.budget.lineageBudgetId, result.budget.lineageBudgetId);
    config.storage.mode = 'hash-only';
    const privateResult = await campaign(config, new FakeProvider(r => simulator(r, false)));
    const persisted = await readFile(join(privateResult.directory!, 'report.json'), 'utf8');
    const journal = await readFile(join(privateResult.directory!, 'events.jsonl'), 'utf8');
    assert.equal(persisted.includes('I need an invoice'), false); assert.equal(journal.includes('I need an invoice'), false);
    assert.equal(JSON.parse(persisted).replayable, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('confirmed findings persist as a complete campaign with text and replayable evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jevfuzz-confirmed-storage-'));
  try {
    const config = await loadCampaign(fixture); config.storage.directory = directory;
    config.search.maxCandidates = 2; config.oracle.pairs = 1;
    const report = await campaign(config, new FakeProvider(request => {
      const response = simulator(request, false);
      for (const [id, answer] of Object.entries(response.answers)) if (answer.type === 'choice' && id !== 'department') {
        answer.choice = 'general'; answer.probabilities = { general: .9, billing: .1 };
      }
      return response;
    }));
    assert.ok(report.findings.length > 0);
    assert.match(renderReportText(report), /JevFuzz v2 campaign/);
    assert.equal(report.status, 'complete'); assert.equal(report.exitCode, 1);
    const stored = JSON.parse(await readFile(join(report.directory!, 'findings', report.findings[0]!.id + '.json'), 'utf8'));
    assert.equal(stored.id, report.findings[0]!.id);
    assert.match(await readFile(join(report.directory!, 'report.txt'), 'utf8'), /JevFuzz v2 campaign/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
