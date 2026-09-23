import type { JevRequest, JevResponse, Json, MutationConfig, MutationRecipe } from './types.ts';

export type Admissibility = 'structural' | 'declared' | 'hypothesis';
export type Phase = 'discovery' | 'confirmation' | 'shrink' | 'final-confirmation';
export type OperatorId = MutationRecipe['type'] | 'choice_label_rename' | 'proposal';
export type Relation = 'invariant' | 'equivariant' | 'bounded_shift' | 'directional';
export type Projection = 'choice' | 'noul' | 'score' | 'policy';

export interface Contract {
  id: string;
  question: string;
  relation: Relation;
  projection: Projection;
  mutations: OperatorId[];
  admissibility: Admissibility;
  assumptions: string[];
  required: boolean;
  tolerance?: number;
  minimumEffect?: number;
  units?: string;
  direction?: 'increase' | 'decrease';
  labelMapping?: Record<string, string>;
}

export type PolicyField = 'choice' | 'noul' | 'score' | 'confidence' | 'probability';
export type PolicyExpression =
  | { question: string; field: PolicyField; label?: string; op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'; value: string | number }
  | { all: PolicyExpression[] }
  | { any: PolicyExpression[] };
export interface Policy {
  version: 1;
  rules: { when: PolicyExpression; action: string }[];
  fallback: string;
}
export interface PolicyResult { action: string; margin?: number; rule?: number }

/** Concrete witness. Paths and question names refer to original seed IDs. */
export interface MutationStep {
  operator: OperatorId;
  version: '1';
  admissibility: Admissibility;
  question?: string;
  path?: string;
  order?: (string | number)[];
  renames?: Record<string, string>;
  field?: string;
  value?: Json;
  text?: string;
  // object-key mutations may address several content objects, never Score levels.
  orders?: { path: string; order: string[] }[];
  reads: string[];
  writes: string[];
  requires: string[];
  invalidates: string[];
}
export interface CampaignSeed { id: string; request: JevRequest; mutations: MutationConfig; source?: string }
export interface ReducerConfig {
  independentQuestions: boolean;
  optionalStatePaths: string[];
  unorderedArrayPaths: string[];
  prosePaths: string[];
}
export interface SearchConfig {
  strategy: 'enumerator' | 'uniform' | 'novelty' | 'boundary' | 'feedback';
  seed: number;
  maxDepth: number;
  batchSize: number;
  concurrency: number;
  uniformFraction: number;
  stagnationBatches: number;
  maxCandidates: number;
  maxQueueBytes: number;
  familyQuota: number;
}
export interface OracleConfig {
  profile: 'paired-v1' | 'fixed-stat-v1';
  pairs: number;
  minimumSupport: number;
  maxControlViolationRate: number;
  minimumEffect: number;
  alpha: number;
  originalSlots: number;
  shrinkSlots: number;
}
export interface BudgetConfig {
  logicalRequests: number;
  httpAttempts: number;
  wallTimeSeconds: number;
  discoveryRequests: number;
  confirmationRequests: number;
  shrinkRequests: number;
  finalConfirmationRequests: number;
}
export interface StorageConfig {
  mode: 'full' | 'redacted' | 'hash-only';
  directory: string;
  maxRunBytes: number;
  maxCorpusBytes: number;
  redactPaths: string[];
}
/** Compiled configuration; CLI additionally accepts relative seed file/glob strings. */
export interface CampaignConfig {
  version: 2;
  name: string;
  seeds: CampaignSeed[];
  provider: 'typesafe' | 'cloudflare' | 'custom';
  contracts: Contract[];
  search: SearchConfig;
  oracle: OracleConfig;
  budget: BudgetConfig;
  storage: StorageConfig;
  reducers: ReducerConfig;
  policy?: Policy;
  duplicateSeeds: number;
}
export interface Candidate {
  id: string;
  seedId: string;
  parentId?: string;
  basePayload: string;
  mutantPayload: string;
  baseWireHash: string;
  mutantWireHash: string;
  contentHash: string;
  contractHash: string;
  targetHash: string;
  recipe: MutationStep[];
  contractIds: string[];
  contracts: Contract[];
  /** Mutant question ID -> original question ID, a full bijection. */
  questionMap: Record<string, string>;
  /** Original question ID -> (mutant Choice label -> original label). */
  labelMaps: Record<string, Record<string, string>>;
  admissibility: Admissibility;
  provenanceHash: string;
  assumptions: string[];
}
export interface Observation {
  id: string;
  operationId: string;
  phase: Phase;
  wireHash: string;
  transportWireHash?: string;
  response: JevResponse;
  provider: string;
  observedModel: string;
  cache: 'unknown' | 'fresh' | 'cached';
  transportUncertain?: boolean;
}
export interface RelationObservation {
  status: 'holds' | 'violates' | 'unknown';
  signature?: string;
  effect?: number;
  units?: string;
  before?: string | number;
  after?: string | number;
  reasons: string[];
}
export interface ConfirmationBlock { a: Observation; control: Observation; b: Observation; violation: RelationObservation; sham: RelationObservation }
export interface Confirmation {
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'NO_CONFIRMED_VIOLATION';
  reason: string;
  signature: string;
  evidenceLevel: 'empirical' | 'statistical';
  profileVersion: OracleConfig['profile'];
  discoverySamples: number;
  confirmationSamples: number;
  controls: number;
  support: number;
  controlViolations: number;
  effect: number;
  familySize: number;
  adjustment: 'none' | 'bonferroni';
  slotId?: string;
  pValue?: number;
  alpha?: number;
  assumptions: string[];
  blocks: ConfirmationBlock[];
  observedModels: string[];
}
export interface Finding {
  version: 2;
  kind: 'finding';
  id: string;
  candidate: Candidate;
  contract: Contract;
  oracle: OracleConfig;
  confirmation: Confirmation;
  provider: CampaignConfig['provider'];
  policy?: Policy;
  reducers: ReducerConfig;
  fingerprint: string;
  replayability: 'full';
  parentFindingId?: string;
}
export interface ShrinkResult {
  version: 2;
  kind: 'shrink';
  original: Finding;
  finding: Finding;
  status: 'reduced' | 'locally_minimal' | 'budget_limited' | 'unconfirmed';
  attempted: number;
  accepted: number;
  originalComplexity: number[];
  finalComplexity: number[];
  history: { candidateId: string; accepted: boolean; reason: string; complexity: number[] }[];
  unconfirmedCandidate?: Candidate;
}
export const COMPONENT_VERSIONS = Object.freeze({
  schema: '2', scheduler: 'batch-v1', prng: 'mulberry32-v1',
  operators: 'witness-v1', serialization: 'json-wire-v1', feedback: 'typed-v1',
});
