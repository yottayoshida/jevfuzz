/** Offline synthetic walkthrough. Never constructs a network provider. */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeProvider } from '../src/provider.ts';
import { parseCampaign } from '../src/campaign-config.ts';
import { campaign } from '../src/engine/campaign.ts';
import { shrinkFinding } from '../src/shrink/index.ts';
import { saveFinding } from '../src/artifacts-v2.ts';
import { addToCorpus, checkCorpus, triageCorpus } from '../src/corpus/index.ts';
import { BudgetLedger } from '../src/engine/budget.ts';
import { EvaluationBroker } from '../src/engine/broker.ts';
import { ExecutionJournal } from '../src/engine/journal.ts';

const started = Date.now(), directory = await mkdtemp(join(tmpdir(), 'jevfuzz-v09-demo-'));
const config = parseCampaign({ version: 2, name: 'synthetic-position-bug', provider: 'custom',
  seeds: ['bug', 'healthy'].map(kind => ({ id: kind, request: { model: 'fake', state: { kind, note: 'Optional tracing context.' }, questions: { route: { type: 'choice', instructions: 'Route.', criteria: { billing: 'Bill', general: 'Other' } } } }, mutations: { builtin: true } })),
  contracts: [{ id: 'route-id', question: 'route', projection: 'choice', mutations: ['question_id_rename'] }],
  search: { strategy: 'enumerator', maxDepth: 1, maxCandidates: 2 }, oracle: { profile: 'paired-v1', pairs: 1, minimumSupport: 1 },
  reducers: { independentQuestions: false, optionalStatePaths: ['$.state.note'], unorderedArrayPaths: [], prosePaths: [] },
  budget: { logicalRequests: 10, httpAttempts: 0, wallTimeSeconds: 20, discoveryRequests: 4, confirmationRequests: 6, shrinkRequests: 0, finalConfirmationRequests: 0 },
  storage: { mode: 'full', directory, maxRunBytes: 1_000_000, maxCorpusBytes: 1_000_000 } });
let calls = 0;
const simulator = (buggy: boolean) => new FakeProvider(request => {
  calls++; const id = Object.keys(request.questions)[0]!;
  const changed = buggy && (request.state as { kind: string }).kind === 'bug' && id !== 'route';
  return { model: buggy ? 'demo-buggy' : 'demo-fixed', answers: { [id]: { type: 'choice', choice: changed ? 'general' : 'billing', probabilities: { billing: changed ? 0 : 1, general: changed ? 1 : 0 }, confidence: 1 } }, usage: { input_tokens: 0, output_tokens: 0 } };
});
const buggy = simulator(true), report = await campaign(config, buggy);
assert.equal(report.status, 'complete'); assert.equal(report.exitCode, 1); assert.equal(report.findings.length, 1);
assert.ok(report.results.some(result => result.seedId === 'healthy' && result.relations.every(r => r.discovery.status === 'holds')));
const ledger = new BudgetLedger({ logicalRequests: 27, httpAttempts: 0, wallTimeSeconds: 20, discoveryRequests: 0, confirmationRequests: 0, shrinkRequests: 24, finalConfirmationRequests: 3 });
const journal = await ExecutionJournal.create(join(directory, 'shrink.events.jsonl'));
let shrunk;
try { shrunk = await shrinkFinding(report.findings[0]!, new EvaluationBroker(buggy, ledger, { strict: true, journal }), ledger, { seed: 7, journal }); }
finally { await journal.close(); }
assert.equal(shrunk.status, 'reduced'); assert.equal(shrunk.accepted, 1);
assert.equal(JSON.parse(shrunk.finding.candidate.basePayload).state.note, undefined);
const findingPath = join(directory, 'minimal.finding.json'); await saveFinding(shrunk.finding, findingPath);
const corpus = join(directory, 'corpus'), id = await addToCorpus(shrunk.finding, corpus, { reason: 'Synthetic demo evidence.' });
await triageCorpus(corpus, id, 'accepted_regression', { actor: 'offline-demo', reason: 'Reviewed synthetic rename relation.' });
const buggyCheck = await checkCorpus(corpus, simulator(true)), fixedCheck = await checkCorpus(corpus, simulator(false));
assert.equal(buggyCheck.exitCode, 1); assert.equal(fixedCheck.exitCode, 0);
const fixedCampaign = await campaign(config, simulator(false));
assert.equal(fixedCampaign.exitCode, 0); assert.equal(fixedCampaign.summary.evaluated, 2); assert.equal(fixedCampaign.findings.length, 0);
assert.ok(fixedCampaign.results.every(result => result.relations.every(r => r.discovery.status === 'holds')));
assert.ok(Date.now() - started < 5 * 60_000);
console.log(JSON.stringify({ evidence: 'local-synthetic', actions: ['campaign', 'shrink', 'corpus-add', 'explicit-triage', 'fresh-buggy-check', 'fresh-fixed-check', 'healthy-case-recheck'],
  checks: { campaign: report.exitCode, shrink: shrunk.status, acceptedReductions: shrunk.accepted, buggyCheck: buggyCheck.exitCode, fixedCheck: fixedCheck.exitCode, healthyCaseRetained: true },
  logicalCalls: calls, httpAttempts: 0, elapsedMs: Date.now() - started, directory, findingPath, corpus }, null, 2));
