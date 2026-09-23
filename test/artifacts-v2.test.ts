import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { loadFinding, saveFinding, validateFinding } from '../src/artifacts-v2.ts';
import { buildCandidate } from '../src/mutators/index.ts';
import { confirmCandidate, createFinding } from '../src/oracles/index.ts';
import { evaluateRelation } from '../src/contracts/index.ts';
import type { Contract, Finding, Observation, Phase } from '../src/campaign-types.ts';
import type { JevResponse } from '../src/types.ts';

const directory = await mkdtemp(join(tmpdir(), 'jevfuzz-artifact-'));
after(() => rm(directory, { recursive: true, force: true }));
const seed = { id: 's', mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [], prosePaths: [] }, request: { model: 'jev-latest', state: { token: 'SENTINEL' }, questions: { route: { type: 'choice' as const, instructions: 'x', criteria: { billing: 'bill', general: 'other' } } } } };
const contract: Contract = { id: 'c', question: 'route', relation: 'invariant', projection: 'choice', mutations: ['question_id_rename'], admissibility: 'structural', assumptions: [], required: true };
const oracle = { profile: 'paired-v1' as const, pairs: 1, minimumSupport: 1, maxControlViolationRate: 0, minimumEffect: 0, alpha: .05, originalSlots: 0, shrinkSlots: 0 };
async function valid(): Promise<Finding> {
  const candidate = buildCandidate(seed, [{ operator: 'question_id_rename', version: '1', admissibility: 'structural', renames: { route: 'r' }, reads: [], writes: [], requires: [], invalidates: [] }], [contract], undefined, 'custom'); let count = 0;
  const executor = { modelChanged: false, async evaluate(payload: string, phase: Phase): Promise<Observation> { const id = Object.keys(JSON.parse(payload).questions)[0]!, choice = id === 'route' ? 'billing' : 'general'; const response: JevResponse = { model: 'sim', answers: { [id]: { type: 'choice', choice, probabilities: { billing: choice === 'billing' ? 1 : 0, general: choice === 'general' ? 1 : 0 }, confidence: 1 } }, usage: { input_tokens: 0, output_tokens: 0 } }; count++; return { id: `o${count}`, operationId: `p${count}`, phase, wireHash: createHash('sha256').update(payload).digest('hex'), response, provider: 'fake', observedModel: 'sim', cache: 'fresh' }; } };
  const base = await executor.evaluate(candidate.basePayload, 'discovery'), mutant = await executor.evaluate(candidate.mutantPayload, 'discovery');
  const signature = evaluateRelation(candidate, contract, base.response, mutant.response).signature!;
  const confirmation = await confirmCandidate(candidate, contract, executor, oracle, { signature, seed: 1 });
  return createFinding(candidate, contract, oracle, confirmation, { provider: 'custom', reducers: { independentQuestions: false, optionalStatePaths: [], unorderedArrayPaths: [], prosePaths: [] } });
}
test('private round-trip validates real fresh evidence', async () => { await mkdir(directory, { recursive: true, mode: 0o700 }); const value = await valid(), path = join(directory, 'finding.json'); await saveFinding(value, path); assert.deepEqual(await loadFinding(path), value); assert.equal((await stat(path)).mode & 0o077, 0); });
test('embedded request JSON is bounded before recursive request validation', async () => {
  for (const key of ['basePayload','mutantPayload'] as const) {
    const value=await valid(); value.candidate[key]='{"state":'+ '['.repeat(12000)+'0'+']'.repeat(12000)+',"model":"m","questions":{"q":{"type":"noul","instructions":"x"}}}';
    assert.throws(()=>validateFinding(value),/JSON structural limit exceeded/);
  }
  const modelReduction=await valid(); modelReduction.reducers.prosePaths=['$.model']; assert.throws(()=>validateFinding(modelReduction),/decision content/);
});
test('rejects payload, mapping, hash, phase, ID and relation tampering', async () => { const changes = [(v: Finding) => { v.candidate.mutantPayload += ' '; }, (v: Finding) => { v.candidate.questionMap = { r: 'bad' }; }, (v: Finding) => { v.candidate.baseWireHash = '0'.repeat(64); }, (v: Finding) => { v.confirmation.blocks[0]!.a.phase = 'discovery'; }, (v: Finding) => { v.confirmation.blocks[0]!.b.id = v.confirmation.blocks[0]!.a.id; }, (v: Finding) => { v.confirmation.blocks[0]!.violation.status = 'holds'; }]; for (const change of changes) { const value = structuredClone(await valid()); change(value); assert.throws(() => validateFinding(value)); } });
test('rejects hypotheses, malformed responses, unknown nesting, and known secrets', async () => { const changes = [(v: any) => { v.candidate.admissibility = 'hypothesis'; }, (v: any) => { v.confirmation.blocks[0].b.response.answers = {}; }, (v: any) => { v.candidate.evil = true; }, (v: any) => { v.candidate.recipe[0].evil = true; }, (v: any) => { v.oracle.evil = true; }, (v: any) => { v.confirmation.evil = true; }, (v: any) => { v.confirmation.blocks[0].a.evil = true; }]; for (const change of changes) { const value = structuredClone(await valid()); change(value); assert.throws(() => validateFinding(value)); } await assert.rejects(saveFinding(await valid(), join(directory, 'secret.json'), { secrets: ['SENTINEL'] })); });
test('rejects self-consistent non-fail blocks and altered confirmation aggregates or contract semantics', async () => {
  const changes = [
    (v: Finding) => { const block = v.confirmation.blocks[0]!; block.b.response.answers = { r: structuredClone(block.a.response.answers.route!) }; block.violation = evaluateRelation(v.candidate, v.contract, block.a.response, block.b.response); },
    (v: Finding) => { v.confirmation.support = 0; },
    (v: Finding) => { v.confirmation.signature = 'forged'; },
    (v: Finding) => { v.confirmation.pValue = .5; },
    (v: Finding) => { v.contract = { ...v.contract, tolerance: .1 }; },
    (v: Finding) => { v.confirmation.blocks[0]!.sham.status = 'violates'; },
    (v: any) => { v.oracle.profile = 'unsupported'; v.confirmation.profileVersion = 'unsupported'; },
  ];
  for (const change of changes) { const value = structuredClone(await valid()); change(value); assert.throws(() => validateFinding(value)); }
});
