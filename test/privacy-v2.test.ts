import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { loadCampaign } from '../src/campaign-config.ts';
import { campaign } from '../src/engine/campaign.ts';
import { generateCandidates } from '../src/mutators/index.ts';
import { redactCandidate } from '../src/redaction.ts';
import { FakeProvider } from '../src/provider.ts';
import { StorageQuota, recoverWriterLock } from '../src/storage.ts';
import { ExecutionJournal, decodeJournal } from '../src/engine/journal.ts';

test('redacted requests preserve original hashes separately and redact renamed paths', async () => {
  const config = await loadCampaign('fixtures/v2/routing.campaign.json');
  const candidate = generateCandidates(config).find(c => c.recipe.some(s => s.operator === 'question_id_rename'))!;
  const redacted = redactCandidate(candidate, ['$.state.message', '$.questions.department.instructions']);
  assert.equal(redacted.basePayload.includes('I need an invoice'), false); assert.equal(redacted.mutantPayload.includes('I need an invoice'), false);
  assert.equal(redacted.originalBaseWireHash, candidate.baseWireHash); assert.notEqual(redacted.redactedBaseHash, candidate.baseWireHash); assert.equal(redacted.replayable, false);
  assert.equal(JSON.parse(redacted.mutantPayload).questions[Object.entries(candidate.questionMap).find(([, q]) => q === 'department')![0]].instructions, '[REDACTED]');
});
test('run storage quota is aggregate and prevents dispatch when journal and checkpoint cannot fit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jevfuzz-quota-'));
  try {
    const quota = new StorageQuota(10); await quota.write(join(root, 'a'), '123456'); await assert.rejects(quota.write(join(root, 'b'), '12345'), /total run byte/);
    const config = await loadCampaign('fixtures/v2/routing.campaign.json'); config.storage.directory = root; config.storage.maxRunBytes = 100;
    let calls = 0; const report = await campaign(config, new FakeProvider(() => { calls++; throw new Error('must not call'); }));
    assert.equal(report.exitCode, 2); assert.equal(calls, 0); assert.ok((await stat(join(report.directory!, 'events.jsonl'))).size <= 100);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('stale lock recovery verifies journal integrity before removing a dead owner lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jevfuzz-stale-lock-'));
  try {
    const path = join(root, '.writer.lock'); await writeFile(path, JSON.stringify({ pid: 2147483647, host: hostname(), token: 'fixture-owner' }), { mode: 0o600 });
    await writeFile(join(root, 'events.jsonl'), '{bad}\n', { mode: 0o600 });
    await assert.rejects(recoverWriterLock(root)); assert.ok(await readFile(path));
    await rm(join(root, 'events.jsonl')); const journal = await ExecutionJournal.create(join(root, 'events.jsonl')); await journal.append('start', { version: 2 }); await journal.close();
    await recoverWriterLock(root); await assert.rejects(readFile(path), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('quota exhaustion never publishes completed reports before their finding files exist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jevfuzz-publication-quota-'));
  try {
    for (const maxRunBytes of [20_000, 22_000, 24_000, 26_000, 40_000, 60_000, 85_000, 120_000]) {
      const config = await loadCampaign('fixtures/v2/routing.campaign.json'); config.storage.directory = join(root, String(maxRunBytes));
      config.search.maxCandidates = maxRunBytes < 40_000 ? 1 : 2; config.oracle.pairs = 1; config.storage.maxRunBytes = maxRunBytes;
      const result = await campaign(config, new FakeProvider(request => ({ model: 'quota-sim', usage: { input_tokens: 0, output_tokens: 0 }, answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id, q.type === 'choice' ? { type: 'choice', choice: id === 'department' ? 'billing' : 'general', confidence: 1, probabilities: { billing: id === 'department' ? 1 : 0, general: id === 'department' ? 0 : 1 } } : { type: 'noul', noul: .2 }])) })));
      const reports: any[] = [];
      try { reports.push(JSON.parse(await readFile(join(result.directory!, 'report.json'), 'utf8'))); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const records = decodeJournal(await readFile(join(result.directory!, 'events.jsonl'), 'utf8')).records;
      if (reports.some(report => report.status === 'complete')) {
        assert.equal(result.status, 'complete');
        assert.ok(records.some(row => row.type === 'campaign-finished'), 'complete report requires a durable terminal event');
      }
      reports.push(...records.filter(row => row.type === 'campaign-finished').map(row => (row.data as any).report));
      for (const report of reports.filter(r => r.status === 'complete')) for (const finding of report.findings) {
        const saved = JSON.parse(await readFile(join(result.directory!, 'findings', finding.id + '.json'), 'utf8'));
        assert.equal(saved.id, finding.id);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
