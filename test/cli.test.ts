import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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

test('installed bin symlink dispatches the actual CLI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jevfuzz-bin-'));
  try {
    const target = join(directory, 'jevfuzz');
    await symlink(join(process.cwd(), 'src/cli/main.ts'), target);
    const result = spawnSync(process.execPath, [target, 'plan', 'fixtures/live-smoke.jevfuzz.json', '--seed', '42', '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).worstCaseRequests, 12);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('doctor enforces the declared Node minor version without network', async () => {
  const original = Object.getOwnPropertyDescriptor(process.versions, 'node')!;
  try {
    const io = { env: {}, provider: new FakeProvider(), stdout: () => {}, stderr: () => {} };
    for (const [version, expected] of [['22.17.0', 2], ['22.18.0', 0], ['24.0.0', 0]] as const) {
      Object.defineProperty(process.versions, 'node', { ...original, value: version });
      assert.equal(await main(['doctor'], io), expected, version);
    }
  } finally { Object.defineProperty(process.versions, 'node', original); }
});

test('runtime failure saves a private incomplete report with completed evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jevfuzz-interrupted-'));
  try {
    let calls = 0, stdout = '', stderr = '';
    const fake = new FakeProvider();
    const provider = { httpAttempts: 0, httpRetries: 0, async evaluate(r: Parameters<typeof fake.evaluate>[0]) {
      this.httpAttempts++; if (++calls === 2) throw new Error('private-server-error'); return fake.evaluate(r);
    } };
    const code = await main(['run', 'fixtures/live-smoke.jevfuzz.json', '--artifacts-dir', directory, '--json'], { env: {}, provider, stdout: s => stdout += s, stderr: s => stderr += s });
    assert.equal(code, 2);
    const report = JSON.parse(stdout);
    assert.equal(report.run.status, 'incomplete');
    assert.equal(report.cases[0].baselineResponses.length, 1);
    assert.equal(report.summary.httpAttempts, 2);
    const manifest = JSON.parse(await readFile(join(directory, 'runs', report.run.id, 'manifest.json'), 'utf8'));
    assert.equal(manifest.complete, false);
    assert.doesNotMatch(stdout + stderr, /private-server-error/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('trimmed credentials in inputs never reach report files or output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jevfuzz-secret-'));
  try {
    const file = join(directory, 'input.json');
    await writeFile(file, JSON.stringify({ state: 'secret-to-filter', model: 'jev-latest', questions: { q: { type: 'noul', instructions: 'x' } } }));
    let output = '';
    const artifacts = join(directory, 'artifacts');
    const code = await main(['run', file, '--artifacts-dir', artifacts, '--json'], { env: { TYPESAFE_API_KEY: '  secret-to-filter  ' }, provider: new FakeProvider(), stdout: s => output += s, stderr: s => output += s });
    assert.equal(code, 2);
    assert.doesNotMatch(output, /secret-to-filter/);
    await assert.rejects(readdir(artifacts));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
