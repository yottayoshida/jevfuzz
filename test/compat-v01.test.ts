import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, loadFailure, replay, run } from '../src/index.ts';
import { FakeProvider } from '../src/provider.ts';

const fixtures = join(import.meta.dirname, '..', 'fixtures', 'compat-v01');
const provider = () => new FakeProvider(request => {
  const changed = Object.keys(request.questions)[0] !== 'route';
  return { model: 'v01-position-sensitive', answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, { type: 'noul', noul: changed ? 0.9 : 0.1 }])), usage: { input_tokens: 1, output_tokens: 1 } };
});

test('v0.1 tag golden remains loadable and reproduces its position-sensitive oracle', async () => {
  const tag = JSON.parse(await readFile(join(fixtures, 'tag.json'), 'utf8')) as { tag: string; commit: string; seed: number };
  assert.deepEqual(tag, { tag: 'v0.1.0', commit: 'c027851a25f8000a6368e9f11cae5209d3ddd2b9', config: 'position-sensitive.jevfuzz.json', provider: 'FakeProvider position-sensitive-v1', seed: 7 });
  const golden = JSON.parse(await readFile(join(fixtures, 'report.json'), 'utf8')) as { cases: Array<{ mutations: Array<{ mutation: { type: string }; comparisons: Record<string, { verdict: string }> }> }>; summary: { fail: number } };
  const config = await loadConfig(join(fixtures, 'position-sensitive.jevfuzz.json'));
  const report = await run(config, provider(), { seed: tag.seed, baselineRuns: 2, confirmRuns: 2, concurrency: 1, maxRequests: 100 });
  const oracle = (value: typeof report) => value.cases.flatMap(c => c.mutations.map(m => [m.mutation.type, Object.values(m.comparisons).map(result => result.verdict)]));
  assert.deepEqual(oracle(report), oracle(golden as typeof report));
  assert.equal(report.summary.fail, golden.summary.fail);
  const failure = await loadFailure(join(fixtures, 'failure.json'));
  const replayed = await replay(failure, provider(), { concurrency: 1, maxRequests: 100 });
  assert.equal(replayed.run.mode, 'replay');
  assert.ok(replayed.summary.fail > 0);
});
