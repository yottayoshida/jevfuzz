import type { Candidate, Finding, MutationStep, PolicyExpression, ShrinkResult } from '../campaign-types.ts';
import type { ConfirmationExecutor, HypothesisSlots } from '../oracles/index.ts';
import { confirmationCost, confirmCandidate, createFinding } from '../oracles/index.ts';
import { buildCandidate } from '../mutators/index.ts';
import { evaluateRelation } from '../contracts/index.ts';
import { BudgetLedger } from '../engine/budget.ts';
import type { ExecutionJournal } from '../engine/journal.ts';
import { pathTokens } from '../util.ts';
import type { JevRequest } from '../types.ts';
import { declaredContentPath } from '../config.ts';

export interface ShrinkOptions { seed?: number; slots?: HypothesisSlots; journal?: ExecutionJournal }
type ScreenResult = 'accepted' | 'rejected' | 'incomplete';
const atPath = (root: unknown, path: string): unknown => pathTokens(path).reduce<unknown>((value, token) => value && typeof value === 'object' ? (value as Record<string, unknown>)[token] : undefined, root);
function fieldCount(value: unknown): number { if (Array.isArray(value)) return value.reduce((n, v) => n + fieldCount(v), 0); if (value && typeof value === 'object') return Object.entries(value).reduce((n, [, v]) => n + 1 + fieldCount(v), 0); return 0; }
const moves = (order: readonly (string | number)[], identity: readonly (string | number)[]) => order.reduce<number>((n, item, i) => n + Number(item !== identity[i]), 0);
/** Witness support precedes byte size: [operators, moved positions, renamed IDs, bytes, fields]. */
function complexity(candidate: Candidate): number[] {
  const base = JSON.parse(candidate.basePayload) as JevRequest; let moved = 0, renamed = 0;
  for (const step of candidate.recipe) {
    if (step.renames) renamed += Object.keys(step.renames).length;
    if (!step.order) continue;
    if (step.operator === 'question_order') moved += moves(step.order, Object.keys(base.questions));
    else if (step.operator === 'choice_criteria_order' && step.question) { const q = base.questions[step.question]; moved += moves(step.order, q?.type === 'choice' ? Object.keys(q.criteria) : []); }
    else if (step.operator === 'unordered_array_shuffle') moved += moves(step.order, step.order.map((_, i) => i));
  }
  return [candidate.recipe.length, moved, renamed, Buffer.byteLength(candidate.basePayload) + Buffer.byteLength(candidate.mutantPayload), fieldCount(base) + fieldCount(JSON.parse(candidate.mutantPayload))];
}
function smaller(a: number[], b: number[]): boolean { for (let i = 0; i < a.length; i++) { if (a[i]! < b[i]!) return true; if (a[i]! > b[i]!) return false; } return false; }
function policyQuestions(expression: PolicyExpression): string[] { return 'question' in expression ? [expression.question] : ('all' in expression ? expression.all : expression.any).flatMap(policyQuestions); }
const protectedQuestions = (finding: Finding) => new Set([finding.contract.question, ...(finding.policy?.rules.flatMap(rule => policyQuestions(rule.when)) ?? [])]);
function deletePath(root: unknown, path: string): boolean {
  const tokens = pathTokens(path); if (!tokens.length) return false; let parent: any = root;
  for (const token of tokens.slice(0, -1)) { if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, token)) return false; parent = parent[token]; }
  const last = tokens.at(-1)!; if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, last)) return false;
  if (Array.isArray(parent)) { const i = Number(last); if (!Number.isInteger(i)) return false; parent.splice(i, 1); } else delete parent[last]; return true;
}
function seedFor(request: JevRequest, source: Finding): { id: string; request: JevRequest; mutations: { builtin: boolean; unorderedArrays: string[]; irrelevantFields: []; prosePaths: string[] } } {
  return { id: source.candidate.seedId, request, mutations: { builtin: true, unorderedArrays: source.reducers.unorderedArrayPaths, irrelevantFields: [], prosePaths: source.reducers.prosePaths } };
}
function normalizedRecipe(recipe: readonly MutationStep[], request: JevRequest): MutationStep[] | undefined {
  const ids = new Set(Object.keys(request.questions)); const out: MutationStep[] = [];
  for (const source of recipe) {
    const step = structuredClone(source); if (step.question && !ids.has(step.question)) return undefined;
    if (step.operator === 'question_id_rename' && step.renames) { step.renames = Object.fromEntries(Object.entries(step.renames).filter(([from]) => ids.has(from))); if (!Object.keys(step.renames).length) return undefined; }
    if (step.operator === 'question_order' && step.order) { step.order = step.order.filter(id => typeof id === 'string' && ids.has(id)); if (step.order.length !== ids.size) return undefined; }
    out.push(step);
  }
  return out;
}
function identityOrder(step: MutationStep, base: JevRequest): (string | number)[] | undefined {
  if (step.operator === 'question_order') return Object.keys(base.questions);
  if (step.operator === 'choice_criteria_order' && step.question) { const q = base.questions[step.question]; return q?.type === 'choice' ? Object.keys(q.criteria) : undefined; }
  if (step.operator === 'unordered_array_shuffle' && step.order) return step.order.map((_, i) => i);
  return undefined;
}
function variants(finding: Finding): { candidate: Candidate; reason: string }[] {
  const base = JSON.parse(finding.candidate.basePayload) as JevRequest, output: { candidate: Candidate; reason: string }[] = [], before = complexity(finding.candidate), protectedIds = protectedQuestions(finding);
  const add = (request: JevRequest, recipe: MutationStep[], reason: string, declaredTargetReduction = false) => {
    const normalized = normalizedRecipe(recipe, request); if (!normalized?.length || !normalized.every(step => finding.contract.mutations.includes(step.operator) && (!step.question || step.question === finding.contract.question))) return;
    try { const candidate = buildCandidate(seedFor(request, finding), normalized, [finding.contract], finding.policy, finding.provider); if ((declaredTargetReduction || candidate.targetHash === finding.candidate.targetHash) && smaller(complexity(candidate), before)) output.push({ candidate, reason }); } catch { /* invalid and no-op reductions are excluded */ }
  };
  finding.candidate.recipe.forEach((_, i) => add(structuredClone(base), finding.candidate.recipe.filter((_, j) => i !== j), `remove-operator:${i}`));
  finding.candidate.recipe.forEach((step, i) => {
    if (step.operator !== 'question_id_rename' || !step.renames || Object.keys(step.renames).length < 2) return;
    for (const source of Object.keys(step.renames)) { const recipe = structuredClone(finding.candidate.recipe); recipe[i] = { ...recipe[i]!, renames: Object.fromEntries(Object.entries(step.renames).filter(([from]) => from !== source)) }; add(structuredClone(base), recipe, `remove-rename:${i}:${source}`); }
  });
  if (finding.reducers.independentQuestions) for (const id of Object.keys(base.questions)) if (!protectedIds.has(id)) { const request = structuredClone(base); delete request.questions[id]; add(request, finding.candidate.recipe, `remove-question:${id}`, true); }
  for (const path of finding.reducers.optionalStatePaths) { const request = structuredClone(base); if (deletePath(request, path)) add(request, finding.candidate.recipe, `remove-optional:${path}`); }
  for (const path of finding.reducers.unorderedArrayPaths) { const value = atPath(base, path); if (!Array.isArray(value) || value.length < 2) continue; for (let i = 0; i < value.length; i++) { const request = structuredClone(base); if (deletePath(request, `${path}[${i}]`)) add(request, finding.candidate.recipe, `remove-array:${path}[${i}]`); } }
  // Explicit prose paths permit whitespace normalization only. Preserve every
  // non-whitespace token, including negations and numbers, on both input sides.
  for (const path of finding.reducers.prosePaths) {
    const value = atPath(base, path); if (typeof value !== 'string') continue;
    const normalized = value.trim().replace(/\s+/g, ' '); if (normalized === value) continue;
    const request = structuredClone(base), tokens = pathTokens(path); if (!tokens.length) continue;
    let parent: any = request; for (const token of tokens.slice(0, -1)) parent = parent[token];
    parent[tokens.at(-1)!] = normalized; add(request, finding.candidate.recipe, `normalize-prose-whitespace:${path}`, true);
  }
  finding.candidate.recipe.forEach((step, recipeIndex) => {
    const identity = identityOrder(step, base); if (!step.order || !identity || step.order.length !== identity.length) return;
    for (let index = 0; index < step.order.length; index++) { if (step.order[index] === identity[index]) continue; const other = step.order.indexOf(identity[index]!); if (other < 0) continue; const recipe = structuredClone(finding.candidate.recipe), order = [...step.order]; [order[index], order[other]] = [order[other]!, order[index]!]; recipe[recipeIndex] = { ...recipe[recipeIndex]!, order }; add(structuredClone(base), recipe, `restore-order:${recipeIndex}:${index}`); }
  });
  return output;
}
async function screen(candidate: Candidate, finding: Finding, executor: ConfirmationExecutor, ledger: BudgetLedger, seed: number): Promise<ScreenResult> {
  if (!ledger.canReserve('shrink', 3)) return 'incomplete';
  try {
    const a = await executor.evaluate(candidate.basePayload, 'shrink', `shrink-${seed}-a`), control = await executor.evaluate(candidate.basePayload, 'shrink', `shrink-${seed}-control`), b = await executor.evaluate(candidate.mutantPayload, 'shrink', `shrink-${seed}-b`);
    if (executor.modelChanged || [a, control, b].some(o => o.cache === 'cached' || o.transportUncertain || (finding.oracle.profile === 'fixed-stat-v1' && o.cache !== 'fresh'))) return 'incomplete';
    const relation = evaluateRelation(candidate, finding.contract, a.response, b.response, finding.policy), sham = evaluateRelation({}, finding.contract, a.response, control.response, finding.policy);
    if (relation.status === 'unknown' || sham.status === 'unknown') return 'incomplete';
    return relation.status === 'violates' && relation.signature === finding.confirmation.signature && sham.status === 'holds' ? 'accepted' : 'rejected';
  } catch { return 'incomplete'; }
}
function response(original: Finding, finding: Finding, status: ShrinkResult['status'], attempted: number, accepted: number, initial: number[], final: number[], history: ShrinkResult['history'], unconfirmedCandidate?: Candidate): ShrinkResult {
  return { version: 2, kind: 'shrink', original, finding, status, attempted, accepted, originalComplexity: initial, finalComplexity: final, history, ...(unconfirmedCandidate ? { unconfirmedCandidate } : {}) };
}
/** Complete local screens precede one protected formal confirmation. */
export async function shrinkFinding(original: Finding, executor: ConfirmationExecutor, ledger: BudgetLedger, options: ShrinkOptions = {}): Promise<ShrinkResult> {
  original.reducers.prosePaths.forEach(declaredContentPath);
  const initial = complexity(original.candidate), history: ShrinkResult['history'] = []; let current = original.candidate, accepted = 0, attempted = 0, stopped: 'budget' | 'incomplete' | undefined;
  try { const rebuilt = buildCandidate(seedFor(JSON.parse(original.candidate.basePayload) as JevRequest, original), original.candidate.recipe, [original.contract], original.policy, original.provider); if (rebuilt.targetHash !== original.candidate.targetHash) throw new Error('target changed'); } catch { return response(original, original, 'unconfirmed', attempted, accepted, initial, initial, history, original.candidate); }
  if (!ledger.canReserve('final-confirmation', confirmationCost(original.oracle))) return response(original, original, 'budget_limited', attempted, accepted, initial, initial, history);
  for (;;) {
    const proposals = variants({ ...original, candidate: current }); let advanced = false;
    for (const proposal of proposals) {
      if (!ledger.canReserve('shrink', 3)) { stopped = 'budget'; break; }
      attempted++; const outcome = await screen(proposal.candidate, original, executor, ledger, (options.seed ?? 0) + attempted);
      history.push({ candidateId: proposal.candidate.id, accepted: outcome === 'accepted', reason: outcome === 'accepted' ? proposal.reason : outcome === 'rejected' ? 'screen-rejected' : 'screen-incomplete', complexity: complexity(proposal.candidate) });
      if (outcome === 'incomplete') { stopped = 'incomplete'; break; }
      if (outcome === 'accepted') { current = proposal.candidate; accepted++; advanced = true; break; }
    }
    if (stopped || !advanced) break;
  }
  if (!accepted) return response(original, original, stopped === 'budget' ? 'budget_limited' : stopped === 'incomplete' ? 'unconfirmed' : 'locally_minimal', attempted, accepted, initial, initial, history, stopped === 'incomplete' ? current : undefined);
  const confirmation = await confirmCandidate(current, original.contract, executor, original.oracle, { signature: original.confirmation.signature, seed: options.seed ?? 0, phase: 'final-confirmation', policy: original.policy, ledger, slots: options.slots, journal: options.journal });
  // The result retains original on any non-FAIL confirmation, so its recorded
  // complexity must describe that stored finding rather than the rejected pair.
  if (confirmation.verdict !== 'FAIL') return response(original, original, 'unconfirmed', attempted, accepted, initial, initial, history, current);
  try { const finding = createFinding(current, original.contract, original.oracle, confirmation, { provider: original.provider, policy: original.policy, reducers: original.reducers, parentFindingId: original.id }); return response(original, finding, stopped === 'budget' ? 'budget_limited' : 'reduced', attempted, accepted, initial, complexity(current), history); }
  catch { return response(original, original, 'unconfirmed', attempted, accepted, initial, initial, history, current); }
}
