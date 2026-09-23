import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatePolicy, evaluateRelation } from '../src/contracts/index.ts';
import type { Contract } from '../src/campaign-types.ts';
import type { JevResponse } from '../src/types.ts';

const response = (choice: string): JevResponse => ({ model: 'jev-1', usage: { input_tokens: 1, output_tokens: 1 }, answers: { department: { type: 'choice', choice, confidence: .9, probabilities: { sales: choice === 'sales' ? .9 : .1, support: choice === 'support' ? .9 : .1 } } } });
const contract: Contract = { id: 'c', question: 'department', relation: 'equivariant', projection: 'choice', mutations: ['question_id_rename'], admissibility: 'structural', assumptions: [], required: true };

test('equivariant relation maps renamed question and label outputs into an input-independent signature', () => {
  const candidate = { questionMap: { renamed: 'department' }, labelMaps: { department: { sales_v2: 'sales', support_v2: 'support' } } };
  const renamed = (choice: string): JevResponse => ({ ...response(choice), answers: { renamed: { type: 'choice', choice: choice + '_v2', confidence: .9, probabilities: { sales_v2: choice === 'sales' ? .9 : .1, support_v2: choice === 'support' ? .9 : .1 } } } });
  assert.equal(evaluateRelation(candidate, contract, response('sales'), renamed('sales')).status, 'holds');
  const result = evaluateRelation(candidate, contract, response('sales'), renamed('support'));
  assert.equal(result.status, 'violates');
  assert.equal(result.signature, evaluateRelation({}, contract, response('sales'), response('support')).signature);
  assert.equal(evaluateRelation({ ...candidate, labelMaps: { department: { sales_v2: 'sales' } } }, contract, response('sales'), renamed('support')).status, 'unknown');
});

test('declarative policy has an explicit fallback and does not execute values as code', () => {
  const policy = { version: 1 as const, rules: [{ when: { question: 'department', field: 'choice' as const, op: 'eq' as const, value: 'sales' }, action: 'route:sales' }], fallback: 'hold' };
  assert.equal(evaluatePolicy(response('sales'), policy).action, 'route:sales');
  assert.equal(evaluatePolicy(response('support'), policy).action, 'hold');
});
