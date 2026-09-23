import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { v4SimulatorActive } from '../scripts/benchmark-v09-simulator.ts';
import { validateDerivedRows } from '../scripts/benchmark-v09-censored-analysis.ts';
import type { JevRequest } from '../src/types.ts';

function request(questionEntries: Array<[string, unknown]>, state: Record<string, string> = {}): JevRequest {
  return { model: 'benchmark', state, questions: Object.fromEntries(questionEntries) as JevRequest['questions'] };
}

const route = { type: 'choice' as const, instructions: 'Route.', criteria: { billing: 'billing', general: 'general' } };
const other = { type: 'choice' as const, instructions: 'Second.', criteria: { billing: 'billing', general: 'general' } };

test('v4 interaction simulators require the semantic Route question and their exact operator conjunction', () => {
  const renameOnly = request([['q_route', route], ['second', other]]);
  const reorderOnly = request([['second', other], ['route', route]]);
  const metadataOnly = request([['route', route], ['second', other]], { benchmark_metadata: 'present' });
  const renamedAndReordered = request([['second', other], ['q_route', route]]);
  const renamedAndMetadata = request([['q_route', route], ['second', other]], { benchmark_metadata: 'present' });
  const reorderedAndMetadata = request([['second', other], ['route', route]], { benchmark_metadata: 'present' });
  const allThree = request([['second', other], ['q_route', route]], { benchmark_metadata: 'present' });

  assert.equal(v4SimulatorActive('interaction2', renamedAndReordered), true);
  assert.equal(v4SimulatorActive('interaction3', allThree), true);

  // Every proper subset is negative for interaction3; interaction2 needs exactly rename+reorder.
  for (const candidate of [renameOnly, reorderOnly, metadataOnly, renamedAndMetadata, reorderedAndMetadata]) {
    assert.equal(v4SimulatorActive('interaction2', candidate), false);
    assert.equal(v4SimulatorActive('interaction3', candidate), false);
  }
  assert.equal(v4SimulatorActive('interaction2', renamedAndReordered), true);
  assert.equal(v4SimulatorActive('interaction3', renamedAndReordered), false);

  // Unrelated operations cannot stand in for rename, semantic reordering, or metadata ownership.
  assert.equal(v4SimulatorActive('interaction2', request([['second', other], ['q_route', { ...route, criteria: { general: 'general', billing: 'billing' } }]])), true);
  assert.equal(v4SimulatorActive('interaction3', request([['second', other], ['q_route', route]], { note: 'benchmark_metadata' })), false);
  assert.throws(() => v4SimulatorActive('interaction2', request([['second', other]])), /exactly one semantic Route/);
  assert.throws(() => v4SimulatorActive('interaction2', request([['q_route', route], ['second', { ...other, instructions: 'Route.' }]])), /exactly one semantic Route/);
});

test('v4 order and policy families use the shared semantic features while retaining the historical order criterion', () => {
  const unrelatedCriteria = { type: 'choice' as const, instructions: 'Unrelated.', criteria: { general: 'general', billing: 'billing' } };
  const renamedWithUnrelatedCriteria = request([['q_route', route], ['second', unrelatedCriteria]]);
  const renamedAndReordered = request([['second', other], ['q_route', route]]);
  const renamedOnly = request([['q_route', route], ['second', other]]);

  assert.equal(v4SimulatorActive('order', renamedWithUnrelatedCriteria), true);
  assert.equal(v4SimulatorActive('order', renamedAndReordered), false);
  assert.equal(v4SimulatorActive('policy-choice', renamedAndReordered), true);
  assert.equal(v4SimulatorActive('policy-choice', renamedOnly), false);
  assert.equal(v4SimulatorActive('policy-confidence', renamedWithUnrelatedCriteria), true);
});

test('v4 manifests freeze the canonical and diagnostic seed schedules without changing families or strategies', async () => {
  const root = resolve(import.meta.dirname, '..');
  const canonical = JSON.parse(await readFile(resolve(root, 'fixtures/benchmarks/manifest-v4.json'), 'utf8'));
  const development = JSON.parse(await readFile(resolve(root, 'fixtures/benchmarks/manifest-development.json'), 'utf8'));
  assert.deepEqual(canonical.full, { seedStart: 10000, seedCount: 100, logicalRequests: 1000, httpAttempts: 5000 });
  assert.deepEqual(development.full, { seedStart: 0, seedCount: 10, logicalRequests: 1000, httpAttempts: 5000 });
  assert.equal(development.mode, 'diagnostic-only');
  assert.deepEqual(development.families, canonical.families);
  assert.deepEqual(development.strategies, canonical.strategies);
  assert.equal(canonical.families.length * canonical.strategies.length * canonical.full.seedCount, 6000);
});

test('benchmark preflight rejects arbitrary manifests and an unmarked direct canonical invocation', () => {
  const root = resolve(import.meta.dirname, '..');
  const runner = resolve(root, 'scripts/benchmark-v09.ts');
  const canonical = resolve(root, 'fixtures/benchmarks/manifest-v4.json');
  for (const manifest of ['/private/tmp/unregistered-benchmark-manifest.json', canonical]) {
    const result = spawnSync(process.execPath, [runner, '--manifest', manifest], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
  }
});

test('a marked direct canonical invocation still reaches shard validation before creating output', () => {
  const root = resolve(import.meta.dirname, '..');
  const runner = resolve(root, 'scripts/benchmark-v09.ts');
  const canonical = resolve(root, 'fixtures/benchmarks/manifest-v4.json');
  const output = `/private/tmp/jevfuzz-v4-invalid-shard-${process.pid}`;
  const result = spawnSync(process.execPath, [runner, '--manifest', canonical, '--trials-only', '--shard-count', '4', '--shard-index', '4', '--out', output], { encoding: 'utf8', env: { ...process.env, JEVFUZZ_BENCHMARK_PROTOCOL: 'v4' } });
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr.includes('invalid shard index/count'), true);
  assert.equal(existsSync(output), false);
});

test('canonical v4 quick mode rejects before creating an output directory', () => {
  const root = resolve(import.meta.dirname, '..');
  const wrapper = resolve(root, 'scripts/benchmark-v09-v4.ts');
  const output = `/private/tmp/jevfuzz-v4-quick-rejected-${process.pid}`;
  const result = spawnSync(process.execPath, [wrapper, '--quick', '--out', output], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr.includes('canonical v4 does not permit quick mode'), true);
  assert.equal(existsSync(output), false);
});

test('derived analysis recognizes v4 seedStart and row version', () => {
  const ordinals = Array.from({ length: 24 }, (_, index) => index + 1);
  const row = {
    version: 4, sourceHash: 'frozen', seed: 10000, family: 'order', expected: 'detect', strategy: 'uniform',
    logicalCalls: 24, httpAttempts: 0, phaseCosts: { confirmation: 24 }, findings: 1, actionableFindings: 1,
    discoveryEvent: true, firstFindingCensored: false, firstFindingLogicalCall: 24,
    firstConfirmedCandidateOrdinal: 1, confirmationSamples: 24, controls: 8,
    status: 'complete', exitCode: 1, observedModels: ['benchmark-a'], firstConfirmationObservationOrdinals: ordinals,
  };
  assert.doesNotThrow(() => validateDerivedRows([row], {
    families: [{ id: 'order', expect: 'detect' }], strategies: ['uniform'], full: { logicalRequests: 1000, httpAttempts: 5000 },
  }, { version: 4, runtime: { seedStart: 10000, seeds: 1, strategies: 1, trialRows: 1 } }, 'frozen'));
});
