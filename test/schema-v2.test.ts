import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { loadCampaign } from '../src/campaign-config.ts';
import { campaign } from '../src/engine/campaign.ts';
import { FakeProvider } from '../src/provider.ts';
import { validateFindingShape, validateReportArtifact } from '../src/report-validator.ts';
import { parseExperiment } from '../src/experiments.ts';
import { buildCandidate } from '../src/mutators/index.ts';
import type { Contract } from '../src/campaign-types.ts';

async function schemas() {
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
  ajv.addFormat('date-time', value => /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)));
  for (const file of await readdir('schemas')) if (file.endsWith('.schema.json')) ajv.addSchema(JSON.parse(await readFile(join('schemas', file), 'utf8')));
  for (const name of ['campaign','finding','experiment','checkpoint','corpus','report']) assert.ok(ajv.getSchema(`https://jevfuzz.dev/schema/${name}-v2.schema.json`));
  return ajv;
}
test('schemas compile with all references and reject malformed nested campaign input', async () => {
  const ajv = await schemas(), validate = ajv.getSchema('https://jevfuzz.dev/schema/campaign-v2.schema.json')!;
  const input = JSON.parse(await readFile('fixtures/v2/routing.campaign.json', 'utf8'));
  assert.equal(validate(input), true, JSON.stringify(validate.errors));
  for (const change of [
    (v: any) => { v.search.surprise = true; },
    (v: any) => { v.budget.httpAttempts = -1; },
    (v: any) => { v.seeds[0].request.questions.department.type = 'unknown'; },
    (v: any) => { v.contracts[0].projection = 'arbitrary-code'; },
    (v: any) => { v.oracle.pairs = 0; },
  ]) { const copy = structuredClone(input); change(copy); assert.equal(validate(copy), false); }
});

test('generated report reader accepts every writer artifact and rejects unknown nested fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jevfuzz-report-schema-'));
  try {
    const config = await loadCampaign('fixtures/v2/routing.campaign.json'); config.storage.directory = root; config.search.maxCandidates = 3;
    const report = await campaign(config, new FakeProvider(request => ({ model: 'schema-simulator', usage: { input_tokens: 0, output_tokens: 0 }, answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id, q.type === 'noul' ? { type: 'noul', noul: .2 } : { type: 'choice', choice: id === 'department' ? 'billing' : 'general', confidence: .9, probabilities: { billing: id === 'department' ? .9 : .1, general: id === 'department' ? .1 : .9 } }])) })));
    const rootSchema = (await schemas()).getSchema('https://jevfuzz.dev/schema/report-v2.schema.json')!;
    assert.equal(rootSchema(report), true, JSON.stringify(rootSchema.errors));
    const finding = report.findings[0]!;
    const hash = 'a'.repeat(64), observations = finding.confirmation.blocks.flatMap(block => [block.a, block.control, block.b]);
    const artifacts: unknown[] = [
      report,
      { version: 2, kind: 'corpus', entries: [{ id: hash, pairHash: hash, evidence: [hash], sourceFindingIds: [finding.id], triage: { status: 'confirmed', actor: 'test', reason: 'schema', timestamp: new Date().toISOString() } }] },
      { version: 2, kind: 'check', status: 'complete', exitCode: 0, total: 1, required: 1, excluded: 0, quarantined: 0, expired: 0, results: [{ entryId: hash, verdict: finding.confirmation.verdict, reason: finding.confirmation.reason, confirmation: finding.confirmation }], budget: report.budget, provider: 'custom', targetHashes: [hash], requestedModels: ['schema-simulator'], observedModels: report.observedModels, cohort: 'single' },
      { version: 2, kind: 'replay', status: 'complete', findingId: finding.id, confirmation: finding.confirmation, observations, provider: finding.provider, targetHashes: [finding.candidate.targetHash], requestedModels: ['schema-simulator'], observedModels: report.observedModels, cohort: 'single', budget: report.budget },
      { version: 2, kind: 'shrink', original: finding, finding, status: 'locally_minimal', attempted: 0, accepted: 0, originalComplexity: [1], finalComplexity: [1], history: [] },
      { version: 2, kind: 'experiment-report', name: 'schema', cases: [{ id: 'case', status: 'no_detected_regression', old: { target: 'old', provider: 'custom', targetHash: hash, status: 'holds', observations: 0, observedModels: [] }, new: { target: 'new', provider: 'custom', targetHash: hash, status: 'holds', observations: 0, observedModels: [] } }], counts: { introduced: 0, resolved: 0, persists: 0, no_detected_regression: 1, inconclusive: 0 }, status: 'complete', exitCode: 0, budget: report.budget },
      finding,
    ];
    const currentCheck = { ...(artifacts[2] as Record<string, unknown>), oracle: finding.oracle };
    artifacts.push(currentCheck);
    for (const [index, artifact] of artifacts.entries()) {
      assert.equal(rootSchema(artifact), true, `Ajv artifact ${index}: ${JSON.stringify(rootSchema.errors)}`);
      assert.doesNotThrow(() => validateReportArtifact(artifact), `standalone artifact ${index}`);
    }
    const v01Report = structuredClone(report) as any; v01Report.componentVersions.scheduler = 'batch-v1';
    assert.equal(rootSchema(v01Report), true, JSON.stringify(rootSchema.errors));
    assert.doesNotThrow(() => validateReportArtifact(v01Report));
    assert.doesNotThrow(() => validateFindingShape(finding));
    assert.throws(() => validateReportArtifact({ version: 2, kind: 'unknown' }));
    const corrupted = structuredClone(report); (corrupted.results[0]!.relations[0]!.discovery as any).surprise = true;
    assert.equal(rootSchema(corrupted), false);
    assert.throws(() => validateReportArtifact(corrupted));
    const corruptedFinding = structuredClone(finding); (corruptedFinding.confirmation.blocks[0]!.a as any).surprise = true;
    assert.throws(() => validateFindingShape(corruptedFinding));
    const unicode = structuredClone(artifacts[1] as any); unicode.entries[0].sourceFindingIds = ['😀'.repeat(4097)];
    assert.equal(rootSchema(unicode), false, 'Ajv counts Unicode code points for maxLength');
    assert.throws(() => validateReportArtifact(unicode), 'standalone validator preserves Ajv Unicode length semantics');
    const invalidCheckOracle = { ...currentCheck, oracle: { ...finding.oracle, pairs: 0 } };
    assert.equal(rootSchema(invalidCheckOracle), false);
    assert.throws(() => validateReportArtifact(invalidCheckOracle));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real campaign checkpoint and confirmed finding satisfy exported schemas', async () => {
  const ajv = await schemas(), root = await mkdtemp(join(tmpdir(), 'jevfuzz-schema-'));
  try {
    const config = await loadCampaign('fixtures/v2/routing.campaign.json'); config.storage.directory = root; config.search.maxCandidates = 3;
    const report = await campaign(config, new FakeProvider(request => ({ model: 'schema-simulator', usage: { input_tokens: 0, output_tokens: 0 }, answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id, q.type === 'noul' ? { type: 'noul', noul: .2 } : { type: 'choice', choice: id === 'department' ? 'billing' : 'general', confidence: .9, probabilities: { billing: id === 'department' ? .9 : .1, general: id === 'department' ? .1 : .9 } }])) })));
    assert.ok(report.findings.length > 0);
    const finding = ajv.getSchema('https://jevfuzz.dev/schema/finding-v2.schema.json')!, checkpoint = ajv.getSchema('https://jevfuzz.dev/schema/checkpoint-v2.schema.json')!;
    assert.equal(finding(report.findings[0]), true, JSON.stringify(finding.errors));
    const saved = JSON.parse(await readFile(join(report.directory!, 'checkpoint.json'), 'utf8'));
    assert.equal(checkpoint(saved), true, JSON.stringify(checkpoint.errors));
    const legacyCheckpoint = structuredClone(saved); legacyCheckpoint.componentVersions.scheduler = 'batch-v1'; legacyCheckpoint.scheduler.version = 'batch-v1';
    assert.equal(checkpoint(legacyCheckpoint), false, 'checkpoint schema rejects batch-v1 resumes');
    const tampered = structuredClone(report.findings[0]!); (tampered.confirmation.blocks[0]!.a as any).hidden = true;
    assert.equal(finding(tampered), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('experiment input schemas preserve explicit source and target mapping fields', async () => {
  const contract: Contract = { id: 'decision', question: 'decision', relation: 'invariant', projection: 'choice', mutations: ['question_id_rename'], admissibility: 'structural', assumptions: [], required: true };
  const candidate = buildCandidate({ id: 'seed', request: { state: {}, model: 'model', questions: { decision: { type: 'choice', instructions: 'Choose.', criteria: { yes: 'yes', no: 'no' } } } }, mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [], prosePaths: [] } }, [{ operator: 'question_id_rename', version: '1', admissibility: 'structural', renames: { decision: 'mutant' }, reads: [], writes: [], requires: [], invalidates: [] }], [contract], undefined, 'cloudflare');
  const input = {
    version: 2, kind: 'experiment', name: 'mapped-target',
    cases: [{ id: 'case', candidate, contract, source: { provider: 'cloudflare' } }],
    old: { id: 'old', provider: 'custom' },
    new: {
      id: 'new', provider: 'custom',
      questions: { decisionV2: { type: 'choice', instructions: 'Choose.', criteria: { allow: 'yes', deny: 'no' } } },
      sourceQuestionMapping: { decision: 'decisionV2' },
      sourceLabelMappings: { decision: { yes: 'allow', no: 'deny' } },
      policy: { version: 1, rules: [{ when: { question: 'decisionV2', field: 'choice', op: 'eq', value: 'allow' }, action: 'allow' }], fallback: 'hold' },
    },
    oracle: { profile: 'paired-v1', pairs: 1, minimumSupport: 1, maxControlViolationRate: 0, minimumEffect: 0, alpha: .05, originalSlots: 2, shrinkSlots: 0 },
    budget: { logicalRequests: 10, httpAttempts: 0, wallTimeSeconds: 30, discoveryRequests: 4, confirmationRequests: 6, shrinkRequests: 0, finalConfirmationRequests: 0 },
  };
  const ajv = await schemas();
  for (const id of ['https://jevfuzz.dev/schema/experiment-v2.schema.json', 'https://jevfuzz.dev/schema/artifacts-v2.schema.json#/$defs/experiment']) {
    const validate = ajv.getSchema(id)!;
    assert.equal(validate(input), true, JSON.stringify(validate.errors));
    const missingMappingShape = structuredClone(input) as any;
    missingMappingShape.new.sourceQuestionMapping.decision = 7;
    assert.equal(validate(missingMappingShape), false);
    const badLabels = structuredClone(input) as any;
    badLabels.new.sourceLabelMappings.decision = ['allow', 'deny'];
    assert.equal(validate(badLabels), false);
    const badSource = structuredClone(input) as any;
    badSource.cases[0].source.unexpected = true;
    assert.equal(validate(badSource), false);
  }
  assert.doesNotThrow(() => parseExperiment(input));
  const legacy = structuredClone(input) as any;
  legacy.new = { id: 'new', provider: 'custom' };
  assert.doesNotThrow(() => parseExperiment(legacy));
});
