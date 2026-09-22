export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Content = string | Json[] | { [key: string]: Json };
export type JevQuestion =
  | { type: 'choice'; instructions: Content; criteria: Record<string, Json> }
  | { type: 'noul'; instructions: Content; criteria?: { true?: Content; false?: Content } }
  | { type: 'score'; instructions: Content; criteria: Content[] };
export interface JevRequest { state: Content; model: string; questions: Record<string, JevQuestion> }
export type JevAnswer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'noul'; noul: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number; legend: Record<string, Json> };
export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}
export interface DecisionProvider {
  readonly mode?: 'live' | 'fake';
  readonly httpAttempts?: number;
  evaluate(request: JevRequest, options?: { signal?: AbortSignal }): Promise<JevResponse>;
}
export interface Thresholds {
  noulBaselineRange: number; scoreBaselineRange: number;
  noulThreshold: number; noulMinDelta: number; scoreDelta: number;
  jsDivergence: number; confidenceDrop: number; noulProbabilityShift: number;
}
export interface Invariant extends Partial<Thresholds> { type?: 'choice_stable' | 'noul_stable' | 'score_stable' }
export interface MutationConfig {
  builtin: boolean;
  unorderedArrays: string[];
  irrelevantFields: { path: string; field: string; values: Json[] }[];
  prosePaths: string[];
}
export interface FuzzCase {
  id: string; request: JevRequest; baselineRuns: number;
  mutations: MutationConfig; invariants: Record<string, Invariant>;
}
export interface FuzzConfig { version: 1; name: string; cases: FuzzCase[] }
export interface RunOptions {
  seed: number; baselineRuns?: number; confirmRuns: number;
  concurrency: number; maxRequests: number; signal?: AbortSignal;
}
export interface MutationRecipe {
  type: 'question_id_rename' | 'question_order' | 'choice_criteria_order' | 'object_key_order' | 'unordered_array_shuffle' | 'irrelevant_field_injection' | 'text_normalization';
  strategy: string; seed: number; question?: string; path?: string; field?: string; valueIndex?: number;
}
export interface Mutation { recipe: MutationRecipe; request: JevRequest; idMap: Record<string, string> }
export type Verdict = 'PASS' | 'WARN' | 'FAIL' | 'INCONCLUSIVE';
export interface BaselineStats {
  type: JevAnswer['type']; stable: boolean; runs: number;
  modalChoice?: string; agreementRatio?: number;
  mean?: number; min?: number; max?: number; range?: number;
  meanProbabilities?: Record<string, number>;
  minProbabilities?: Record<string, number>; maxProbabilities?: Record<string, number>;
  meanConfidence?: number;
}
export interface Comparison {
  verdict: Verdict; reason: string; warnings: string[];
  baseline: BaselineStats; mutated: BaselineStats;
  thresholds: Thresholds; reproduced: number; observations: number;
  jsDivergence?: number; confidenceDrop?: number; delta?: number;
}
export interface MutationResult {
  id: string; mutation: MutationRecipe; idMap: Record<string, string>;
  requestHash: string; request?: JevRequest;
  responses: JevResponse[]; comparisons: Record<string, Comparison>;
}
export interface CaseReport {
  id: string; caseHash: string; baselineRequestHash: string; baselineRequest?: JevRequest;
  baselineResponses: JevResponse[]; baseline: Record<string, BaselineStats>;
  invariants: Record<string, Invariant>; mutations: MutationResult[];
}
export interface RunSummary {
  cases: number; questions: number; mutations: number;
  pass: number; warn: number; fail: number; inconclusive: number;
  logicalRequests: number; httpAttempts: number;
  usage: { inputTokens: number; outputTokens: number };
}
export interface FuzzReport {
  version: 1;
  run: {
    id: string; timestamp: string; seed: number; jevfuzzVersion: string; nodeVersion: string;
    mode: 'live' | 'fake' | 'custom' | 'replay'; providerMode: 'live' | 'fake' | 'custom';
    requestedModels: string[]; observedModel?: string; observedModels: string[];
    modelChanged: boolean; configHash: string;
    options: Omit<RunOptions, 'signal'>; replayOf?: string;
  };
  summary: RunSummary; cases: CaseReport[];
}
export interface FailureArtifact {
  version: 1; runId: string; caseId: string; questionId: string;
  mutation: MutationRecipe; idMap: Record<string, string>;
  baselineRequest: JevRequest; mutatedRequest: JevRequest;
  baselineResponses: JevResponse[]; mutatedResponses: JevResponse[];
  comparison: Comparison; model: string; seed: number;
  baselineRuns: number; confirmRuns: number;
  baselineRequestHash?: string; mutatedRequestHash?: string;
}
