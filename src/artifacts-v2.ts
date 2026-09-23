import { dirname } from 'node:path';
import type { Candidate, Finding } from './campaign-types.ts';
import type { JevRequest } from './types.ts';
import { assert, FuzzError, record } from './util.ts';
import { readJson, writePrivate, boundedJson, parseBoundedJson, MAX_JSON_BYTES } from './storage.ts';
import { validateRequest, declaredContentPath } from './config.ts';
import { buildCandidate } from './mutators/index.ts';
import { validateResponse } from './provider.ts';
import { wireHash, contentHash, contractHash } from './identity.ts';
import { evaluateRelation } from './contracts/index.ts';
import { parseContract, parsePolicy } from './campaign-config.ts';
import { createFinding, summarizeConfirmation } from './oracles/index.ts';
import { validateFindingShape } from './report-validator.ts';

const allowed = new Set(['version','kind','id','candidate','contract','oracle','confirmation','provider','policy','reducers','fingerprint','replayability','parentFindingId']);
function fields(value: Record<string, unknown>, name: string): void { assert(Object.keys(value).every(key => allowed.has(key)), `unsupported field in ${name}`); }
function same(a: unknown, b: unknown, message: string): void { assert(JSON.stringify(a) === JSON.stringify(b), message); }
function only(value: unknown, keys: readonly string[], name: string): void { assert(record(value) && Object.keys(value).every(key => keys.includes(key)), `unsupported field in ${name}`); }
function seed(candidate: Candidate): { id: string; request: JevRequest; mutations: { builtin: boolean; unorderedArrays: string[]; irrelevantFields: []; prosePaths: string[] } } { return { id: candidate.seedId, request: validateRequest(parseBoundedJson(candidate.basePayload)), mutations: { builtin: true, unorderedArrays: [], irrelevantFields: [], prosePaths: [] } }; }

/** Strictly validates an imported v2 finding without treating historical answers as new evidence. */
export function validateFinding(value: unknown): Finding {
  assert(record(value), 'finding must be object'); fields(value, 'finding');
  assert(value.version === 2 && value.kind === 'finding' && value.replayability === 'full' && typeof value.id === 'string', 'invalid finding header');
  assert(['typesafe', 'cloudflare', 'custom'].includes(String(value.provider)), 'unsupported finding provider');
  const finding = value as unknown as Finding; boundedJson(finding);
  validateFindingShape(finding);
  assert(finding.candidate && Array.isArray(finding.candidate.recipe) && Array.isArray(finding.candidate.contracts), 'invalid candidate');
  only(finding.candidate, ['id','seedId','parentId','basePayload','mutantPayload','baseWireHash','mutantWireHash','contentHash','contractHash','targetHash','recipe','contracts','contractIds','questionMap','labelMaps','admissibility','provenanceHash','assumptions'], 'candidate');
  for (const step of finding.candidate.recipe) only(step, ['operator','version','admissibility','question','path','order','renames','field','value','text','orders','reads','writes','requires','invalidates'], 'step');
  only(finding.oracle, ['profile','pairs','minimumSupport','maxControlViolationRate','minimumEffect','alpha','originalSlots','shrinkSlots'], 'oracle');
  only(finding.confirmation, ['verdict','reason','signature','evidenceLevel','profileVersion','discoverySamples','confirmationSamples','controls','support','controlViolations','effect','familySize','adjustment','slotId','pValue','alpha','assumptions','blocks','observedModels'], 'confirmation');
  only(finding.reducers, ['independentQuestions','optionalStatePaths','unorderedArrayPaths','prosePaths'], 'reducers');
  finding.reducers.prosePaths.forEach(declaredContentPath);
  const parsedSeed = seed(finding.candidate);
  validateRequest(parseBoundedJson(finding.candidate.mutantPayload));
  const parsedContracts = finding.candidate.contracts.map(contract => parseContract(contract, [parsedSeed]));
  same(parsedContracts, finding.candidate.contracts, 'candidate contract is not canonical');
  const parsedContract = parseContract(finding.contract, [parsedSeed]);
  same(parsedContract, finding.contract, 'finding contract is not canonical');
  const parsedPolicy = parsePolicy(finding.policy, [parsedSeed]);
  same(parsedPolicy, finding.policy, 'finding policy is not canonical');
  assert(finding.candidate.admissibility !== 'hypothesis' && finding.contract.admissibility !== 'hypothesis', 'hypothesis finding is not admissible');
  const candidateContract = finding.candidate.contracts.find(contract => contract.id === finding.contract.id);
  assert(candidateContract, 'finding contract missing from candidate');
  same(candidateContract, finding.contract, 'finding contract differs from candidate contract');
  const rebuilt = buildCandidate(parsedSeed, finding.candidate.recipe, parsedContracts, parsedPolicy, finding.provider);
  for (const key of ['basePayload','mutantPayload','baseWireHash','mutantWireHash','contentHash','contractHash','targetHash','questionMap','labelMaps','provenanceHash','id'] as const) same(rebuilt[key], finding.candidate[key], `candidate ${key} mismatch`);
  assert(wireHash(finding.candidate.basePayload) === finding.candidate.baseWireHash && wireHash(finding.candidate.mutantPayload) === finding.candidate.mutantWireHash, 'candidate wire hash mismatch');
  assert(contractHash(finding.candidate.contracts) === finding.candidate.contractHash, 'candidate contract hash mismatch');
  const blocks = finding.confirmation.blocks; assert(finding.confirmation.verdict === 'FAIL' && blocks.length === finding.oracle.pairs, 'finding needs complete confirmation');
  const ids = new Set<string>(), models = new Set<string>();
  for (const block of blocks) {
    only(block, ['a', 'control', 'b', 'violation', 'sham'], 'confirmation block');
    for (const observation of [block.a, block.control, block.b]) { only(observation, ['id','operationId','phase','wireHash','transportWireHash','response','provider','observedModel','cache','transportUncertain'], 'observation'); assert(observation.phase === 'confirmation' || observation.phase === 'final-confirmation', 'discovery observation cannot be a finding'); assert(!ids.has(observation.id) && !ids.has(observation.operationId), 'duplicate observation identity'); ids.add(observation.id); ids.add(observation.operationId); models.add(observation.observedModel); validateResponse(observation.response, JSON.parse(observation.wireHash === finding.candidate.mutantWireHash ? finding.candidate.mutantPayload : finding.candidate.basePayload)); }
    assert(block.a.phase === block.control.phase && block.control.phase === block.b.phase && block.a.wireHash === finding.candidate.baseWireHash && block.control.wireHash === finding.candidate.baseWireHash && block.b.wireHash === finding.candidate.mutantWireHash, 'confirmation payload or phase mismatch');
    const relation = evaluateRelation(finding.candidate, finding.contract, block.a.response, block.b.response, finding.policy); same(relation, block.violation, 'stored violation mismatch');
    const sham = evaluateRelation({}, finding.contract, block.a.response, block.control.response, finding.policy); same(sham, block.sham, 'stored sham mismatch');
  }
  assert(models.size === 1, 'confirmation cohort changed');
  const phase = blocks[0]!.a.phase;
  const expected = summarizeConfirmation(finding.candidate, finding.contract, finding.oracle, finding.confirmation.signature, blocks, { phase, slotId: finding.confirmation.slotId, discoverySamples: finding.confirmation.discoverySamples, policy: parsedPolicy });
  same(expected, finding.confirmation, 'confirmation aggregates or verdict are inconsistent');
  const reconstructed = createFinding(finding.candidate, finding.contract, finding.oracle, expected, { provider: finding.provider, policy: parsedPolicy, reducers: finding.reducers, ...(finding.parentFindingId ? { parentFindingId: finding.parentFindingId } : {}) });
  assert(reconstructed.id === finding.id && reconstructed.fingerprint === finding.fingerprint, 'finding identity is inconsistent');
  return structuredClone(finding);
}
export async function loadFinding(path: string, maxBytes = MAX_JSON_BYTES): Promise<Finding> { return validateFinding(await readJson(path, maxBytes)); }
export async function saveFinding(finding: Finding, path: string, options: { secrets?: readonly string[]; maxBytes?: number } = {}): Promise<void> { const checked = validateFinding(finding), text = JSON.stringify(checked); await writePrivate(path, text, options.secrets, options.maxBytes); }
