import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { main } from '../src/cli/main.ts';
import { FakeProvider } from '../src/provider.ts';

test('CLI plan and doctor perform zero fetch calls and never print a key', async () => {
  let calls = 0, stdout = '', stderr = '';
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error('network forbidden'); };
  try {
    const io = { stdout: (s: string) => { stdout += s; }, stderr: (s: string) => { stderr += s; }, env: { TYPESAFE_API_KEY: 'test-credential-do-not-log' } };
    assert.equal(await main(['plan', 'fixtures/live-smoke.jevfuzz.json', '--seed', '42', '--json'], io), 0);
    const p = JSON.parse(stdout); assert.equal(p.worstCaseRequests, 12);
    stdout = '';
    assert.equal(await main(['doctor', '--json'], io), 0);
    assert.equal(JSON.parse(stdout).TYPESAFE_API_KEY, 'present');
    assert.equal(calls, 0); assert.ok(!`${stdout}${stderr}`.includes('test-credential-do-not-log'));
  } finally { globalThis.fetch = original; }
});
test('CLI validates unknown flags, budget, authentication and integer controls', async () => {
  let calls = 0;
  const provider = { async evaluate() { calls++; throw new Error('unexpected'); } };
  const io = { stdout: () => {}, stderr: () => {}, env: {}, provider };
  for (const args of [ ['plan', 'fixtures/live-smoke.jevfuzz.json', '--oops'], ['run', 'fixtures/live-smoke.jevfuzz.json', '--max-requests', '1'], ['run', 'fixtures/live-smoke.jevfuzz.json', '--seed', '1.2'] ]) assert.equal(await main(args, io), 2);
  assert.equal(await main(['doctor'], { ...io, provider: undefined }), 2);
  assert.equal(calls, 0);
});
test('CLI run writes JSON report and private payload-free artifacts using explicit fake injection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jevfuzz-cli-'));
  try {
    let output = '';
    const code = await main(['run', 'fixtures/live-smoke.jevfuzz.json', '--seed', '42', '--artifacts-dir', directory, '--json', '--no-save-payloads'], { provider: new FakeProvider(), env: {}, stdout: s => { output += s; }, stderr: () => {} });
    assert.equal(code, 0);
    const report = JSON.parse(output); assert.equal(report.run.mode, 'fake');
    const persisted = JSON.parse(await readFile(join(directory, 'runs', report.run.id, 'report.json'), 'utf8'));
    assert.equal(persisted.cases[0].baselineRequest, undefined); assert.equal(persisted.replay.available, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('mutation bytes reproduce in separate processes', () => {
  const script = `import {loadConfig} from './src/config.ts'; import {generateMutations} from './src/mutate.ts'; console.log(JSON.stringify(generateMutations((await loadConfig('fixtures/intent-review.jevfuzz.json')).cases[0],42)))`;
  const args = ['--input-type=module', '-e', script];
  assert.equal(execFileSync(process.execPath, args, { encoding: 'utf8' }), execFileSync(process.execPath, args, { encoding: 'utf8' }));
});
test('production CLI dispatch has no network dependency for help/plan', () => {
  const result = spawnSync(process.execPath, ['src/cli/main.ts', 'plan', 'fixtures/live-smoke.jevfuzz.json', '--seed', '42', '--json'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).worstCaseRequests, 12);
});
