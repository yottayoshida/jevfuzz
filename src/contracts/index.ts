import type { Contract, Policy, PolicyExpression, PolicyResult, RelationObservation } from '../campaign-types.ts';
import type { JevAnswer, JevResponse } from '../types.ts';
import { FuzzError } from '../util.ts';

const unknown = (reason: string): RelationObservation => ({ status: 'unknown', reasons: [reason] });
const holds = (before?: string | number, after?: string | number): RelationObservation => ({ status: 'holds', reasons: [], ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) });
type Mapping = { questionMap?: Record<string, string>; labelMaps?: Record<string, Record<string, string>> };

export function mappedResponse(response: JevResponse, mapping: Mapping): JevResponse {
  const answers: Record<string, JevAnswer> = Object.create(null);
  for (const [id, raw] of Object.entries(response.answers)) {
    const original = Object.hasOwn(mapping.questionMap ?? {}, id) ? mapping.questionMap![id]! : id;
    if (Object.hasOwn(answers, original)) throw new FuzzError('CONFIG', 'answer mapping is not bijective');
    const labels = mapping.labelMaps?.[original];
    if (raw.type === 'choice' && labels) {
      const choice = labels[raw.choice];
      if (choice === undefined || Object.keys(labels).length !== Object.keys(raw.probabilities).length || new Set(Object.values(labels)).size !== Object.keys(labels).length) throw new FuzzError('CONFIG', 'incomplete Choice label mapping');
      const probabilities: Record<string, number> = Object.create(null);
      for (const [label, p] of Object.entries(raw.probabilities)) {
        const mapped = labels[label]; if (mapped === undefined) throw new FuzzError('CONFIG', 'unmapped probability label');
        probabilities[mapped] = p;
      }
      answers[original] = { ...raw, choice, probabilities };
    } else answers[original] = raw;
  }
  return { ...response, answers };
}
function numeric(answer: JevAnswer, projection: Contract['projection']): number | undefined {
  return projection === 'noul' && answer.type === 'noul' ? answer.noul : projection === 'score' && answer.type === 'score' ? answer.score : undefined;
}
export function evaluateRelation(candidate: Mapping, contract: Contract, base: JevResponse, changed: JevResponse, policy?: Policy): RelationObservation {
  if (base.model !== changed.model) return unknown('COHORT_CHANGED');
  let normalized: JevResponse;
  try { normalized = mappedResponse(changed, candidate); } catch { return unknown('MAPPING_INVALID'); }
  const a = base.answers[contract.question], b = normalized.answers[contract.question];
  if (!a || !b || a.type !== b.type) return unknown('MAPPING_ANSWER_MISSING');
  const violation = (before: string | number, after: string | number, direction: string, effect = 1): RelationObservation => ({
    status: 'violates', signature: JSON.stringify(['relation-v1', contract.id, contract.question, contract.relation, contract.projection, direction, ...(typeof before === 'string' ? [before, after] : [])]),
    before, after, effect, ...(contract.units ? { units: contract.units } : {}), reasons: ['RELATION_VIOLATED'],
  });
  if (contract.projection === 'policy') {
    if (!policy) return unknown('POLICY_MISSING');
    try {
      const before = evaluatePolicy(base, policy).action, after = evaluatePolicy(normalized, policy).action;
      return before === after ? holds(before, after) : violation(before, after, 'action');
    } catch { return unknown('POLICY_PROJECTION_UNKNOWN'); }
  }
  if (contract.projection === 'choice') {
    if (a.type !== 'choice' || b.type !== 'choice') return unknown('PROJECTION_TYPE_MISMATCH');
    return a.choice === b.choice ? holds(a.choice, b.choice) : violation(a.choice, b.choice, 'label');
  }
  const before = numeric(a, contract.projection), after = numeric(b, contract.projection);
  if (before === undefined || after === undefined) return unknown('PROJECTION_TYPE_MISMATCH');
  const delta = after - before, tolerance = contract.tolerance ?? 0;
  const breached = contract.relation === 'directional'
    ? contract.direction === 'increase' ? delta < -tolerance : contract.direction === 'decrease' ? delta > tolerance : false
    : Math.abs(delta) > tolerance;
  if (contract.relation === 'directional' && !contract.direction) return unknown('DIRECTION_MISSING');
  return breached && Math.abs(delta) >= (contract.minimumEffect ?? 0) ? violation(before, after, delta < 0 ? 'down' : 'up', delta) : holds(before, after);
}

function expression(response: JevResponse, expr: PolicyExpression): { matches: boolean; margin?: number } {
  if ('all' in expr || 'any' in expr) {
    const children = ('all' in expr ? expr.all : expr.any).map(item => expression(response, item));
    const margins = children.flatMap(child => child.margin === undefined ? [] : [child.margin]);
    return { matches: 'all' in expr ? children.every(child => child.matches) : children.some(child => child.matches), ...(margins.length ? { margin: Math.min(...margins) } : {}) };
  }
  const answer = response.answers[expr.question];
  if (!answer) throw new FuzzError('CONFIG', 'policy answer is missing');
  const value = expr.field === 'choice' && answer.type === 'choice' ? answer.choice
    : expr.field === 'noul' && answer.type === 'noul' ? answer.noul
    : expr.field === 'score' && answer.type === 'score' ? answer.score
    : expr.field === 'confidence' && answer.type !== 'noul' ? answer.confidence
    : expr.field === 'probability' && answer.type !== 'noul' && expr.label !== undefined && Object.hasOwn(answer.probabilities, expr.label) ? answer.probabilities[expr.label]
    : undefined;
  if (value === undefined || typeof value !== typeof expr.value) throw new FuzzError('CONFIG', 'policy field type mismatch');
  const matches = expr.op === 'eq' ? value === expr.value : expr.op === 'ne' ? value !== expr.value
    : expr.op === 'lt' ? value < expr.value : expr.op === 'lte' ? value <= expr.value : expr.op === 'gt' ? value > expr.value : expr.op === 'gte' ? value >= expr.value : undefined;
  if (matches === undefined) throw new FuzzError('CONFIG', 'unknown policy comparator');
  return { matches, ...(typeof value === 'number' && typeof expr.value === 'number' ? { margin: Math.abs(value - expr.value) } : {}) };
}
function action(template: string, response: JevResponse): string {
  return template.replace(/\$\{([^}]+)\}/g, (_, id: string) => {
    const answer = response.answers[id];
    if (answer?.type !== 'choice') throw new FuzzError('CONFIG', 'policy action template requires a Choice answer');
    return answer.choice;
  });
}
export function evaluatePolicy(response: JevResponse, policy: Policy): PolicyResult {
  let margin: number | undefined;
  for (const [index, rule] of policy.rules.entries()) {
    const result = expression(response, rule.when);
    if (result.margin !== undefined) margin = Math.min(margin ?? Infinity, result.margin);
    if (result.matches) return { action: action(rule.action, response), rule: index, ...(margin === undefined ? {} : { margin }) };
  }
  return { action: action(policy.fallback, response), ...(margin === undefined ? {} : { margin }) };
}
