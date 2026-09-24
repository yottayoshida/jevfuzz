import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn as nodeSpawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { addToCorpus, triageCorpus } from '../src/corpus/index.ts';

const repo = resolve(import.meta.dirname, '..');
const { runAction } = await import(pathToFileURL(join(repo, 'scripts/action/run.mjs')).href);
const { finalizeStatus } = await import(pathToFileURL(join(repo, 'scripts/action/finalize.mjs')).href);
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'jevfuzz-action-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workspace = join(dir, 'consumer'), tempRoot = join(dir, 'temp');
  await mkdir(workspace); await mkdir(tempRoot);
  const output = join(dir, 'output'); await writeFile(output, '');
  // The full cross-version suite can contend for CPU; timeout behavior has its
  // own 150 ms test below, so functional cases get a non-contentious deadline.
  return { dir, workspace, tempRoot, output, deps: { workspace, tempRoot, actionPath: repo, timeoutMs: 15000, killGraceMs: 50 } };
}
async function campaign(dir: string, provider = 'cloudflare', pending = false) {
  const config = JSON.parse(await readFile(join(repo, 'examples/github-actions/campaign.json'), 'utf8'));
  config.provider = provider;
  config.contracts[0].mutations = ['question_id_rename'];
  config.search = { strategy: 'uniform', seed: 42, maxDepth: 1, maxCandidates: 1, batchSize: 1, concurrency: 1 };
  config.budget = { logicalRequests: 26, httpAttempts: 130, wallTimeSeconds: 10, discoveryRequests: 2, confirmationRequests: 24, shrinkRequests: 0, finalConfirmationRequests: 0 };
  if (pending) config.contracts.push({ ...config.contracts[0], id: 'second-contract' });
  await writeFile(join(dir, 'campaign.json'), JSON.stringify(config));
  return config;
}
function env(output: string, extra: Record<string, string> = {}) {
  return { INPUT_COMMAND: 'plan', INPUT_TARGET: 'campaign.json', INPUT_STORAGE: 'hash-only', GITHUB_OUTPUT: output, ...extra };
}
const credentials = (provider: string): Record<string, string> => provider === 'cloudflare'
  ? { CLOUDFLARE_API_TOKEN: 'offline-token', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) }
  : { TYPESAFE_API_KEY: 'offline-key' };
async function snapshot(dir: string): Promise<string> {
  const contents: string[] = [];
  async function walk(path: string) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name);
      contents.push(child);
      if (entry.isDirectory()) await walk(child);
      else contents.push(createHash('sha256').update(await readFile(child)).digest('hex'));
    }
  }
  await walk(dir); return JSON.stringify(contents);
}
async function stubSpawn(dir: string, provider: string, mode: string) {
  const trace = join(dir, `trace-${provider}-${mode}.jsonl`), stub = join(dir, `stub-${provider}-${mode}.mjs`);
  await writeFile(stub, `
import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
const provider = ${JSON.stringify(provider)}, mode = ${JSON.stringify(mode)};
let index = 0;
globalThis.fetch = async (url, init) => {
  const expected = provider === 'typesafe' ? 'https://api.typesafe.ai/v1/systemone' : 'https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/ai/run';
  assert.equal(String(url), expected); assert.equal(init.method, 'POST');
  const headers = new Headers(init.headers);
  assert.equal(headers.get('authorization'), 'Bearer ' + (provider === 'typesafe' ? 'offline-key' : 'offline-token'));
  assert.equal(headers.get('cache-control'), 'no-cache, no-store');
  const body = JSON.parse(init.body), request = provider === 'cloudflare' ? body.input : body;
  assert.equal(body.model, provider === 'cloudflare' ? 'typesafe/jev' : 'jev-latest');
  const flip = mode === 'pending' ? index === 1 : mode === 'flip' && (Object.hasOwn(request.questions, 'relevance') ? Object.keys(request.state)[0] === 'evidence' : Object.keys(request.questions)[0] !== 'department');
  index++;
  const answers = Object.fromEntries(Object.entries(request.questions).map(([id,q]) => {
    const labels = Object.keys(q.criteria);
    const chosen = id === 'relevance' ? (flip ? 'may_violate' : 'unrelated') : labels[flip ? 1 : 0];
    return [id, {type:'choice', choice:chosen, confidence:0.9, probabilities:Object.fromEntries(labels.map(k=>[k,k===chosen?0.9:0.1/(labels.length-1)]))}];
  }));
  await appendFile(${JSON.stringify(trace)}, JSON.stringify({url:String(url)})+'\\n');
  const response = {model:'action-offline-1',answers,usage:{input_tokens:1,output_tokens:1}};
  return new Response(JSON.stringify(provider==='cloudflare'?{result:response}:response), {status:200,headers:{'content-type':'application/json'}});
};
`);
  let invocations = 0;
  const spawn = (command: string, args: string[], options: Parameters<typeof nodeSpawn>[2]) => {
    invocations++;
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'JEV_API_HOST', 'JEV_API_PATH', 'HTTPS_PROXY', 'GITHUB_TOKEN']) assert.equal(options?.env?.[name], undefined);
    return nodeSpawn(command, ['--import', stub, ...args], options!);
  };
  const calls = async () => { try { return (await readFile(trace, 'utf8')).trim().split('\n').length; } catch { return 0; } };
  return { spawn, calls, invocations: () => invocations };
}

test('action plan executes built CLI, preserves checkout and exposes report without credentials', async t => {
  const f = await fixture(t); await campaign(f.workspace); const before = await snapshot(f.workspace);
  const stub = await stubSpawn(f.dir, 'cloudflare', 'stable');
  const result = await runAction(env(f.output), { ...f.deps, spawn: stub.spawn });
  assert.equal(result.exitCode, 0); assert.equal(await stub.calls(), 0); assert.equal(stub.invocations(), 1);
  assert.equal(JSON.parse(await readFile(result.reportPath, 'utf8')).networkCalls, 0);
  assert.equal(await snapshot(f.workspace), before); assert.equal(await finalizeStatus(result.statusPath, f.tempRoot), 0);
  assert.match(await readFile(f.output, 'utf8'), /exit-code=0\nreport-path=.+\nartifacts-path=.+\nstatus-path=.+\n/);
});

for (const provider of ['cloudflare', 'typesafe']) for (const [mode, expected] of [['stable', 0], ['flip', 1], ['pending', 3], ['missing-key', 2]] as const) {
  test(`action ${provider} ${mode} preserves CLI exit ${expected} and failure artifacts`, async t => {
    const f = await fixture(t); await campaign(f.workspace, provider, mode === 'pending');
    const before = await snapshot(f.workspace), stub = await stubSpawn(f.dir, provider, mode);
    const result = await runAction(env(f.output, { INPUT_COMMAND: 'fuzz', INPUT_PROVIDER: provider, INPUT_STORAGE: 'full', NODE_OPTIONS: '--import=evil', JEV_API_HOST: 'https://evil.invalid', GITHUB_TOKEN: 'never-forward', ...(mode === 'missing-key' ? {} : credentials(provider)) }), { ...f.deps, spawn: stub.spawn });
    assert.equal(result.exitCode, expected, JSON.stringify(result));
    assert.equal(await finalizeStatus(result.statusPath, f.tempRoot), expected);
    assert.match(await readFile(f.output, 'utf8'), new RegExp(`exit-code=${expected}\\n`));
    assert.equal(await snapshot(f.workspace), before);
    if (mode === 'missing-key') { assert.equal(await stub.calls(), 0); assert.equal(stub.invocations(), 0); }
    else {
      assert.ok(await stub.calls() >= 2); const report = JSON.parse(await readFile(result.reportPath, 'utf8'));
      assert.equal(report.exitCode, expected);
      if (mode === 'flip') assert.equal(report.findings.length, 1);
    }
  });
}

test('action preflight rejects unsafe paths and excessive budgets before spawning', async t => {
  const f = await fixture(t); const raw = await campaign(f.workspace);
  await symlink(f.workspace, join(f.workspace, 'parent-link'));
  await symlink(join(f.workspace, 'campaign.json'), join(f.workspace, 'leaf.json'));
  let spawned = 0; const deps = { ...f.deps, spawn: () => { spawned++; throw new Error('must not spawn'); } };
  for (const target of ['../campaign.json', '/tmp/campaign.json', 'parent-link/campaign.json', 'leaf.json', 'campaign.json\nexit-code=0']) {
    assert.equal((await runAction(env(f.output, { INPUT_TARGET: target }), deps)).exitCode, 2);
  }
  raw.budget.logicalRequests = 1001; await writeFile(join(f.workspace, 'campaign.json'), JSON.stringify(raw));
  assert.equal((await runAction(env(f.output), deps)).exitCode, 2); assert.equal(spawned, 0);
});

test('action check performs fresh regression observations against an immutable consumer corpus', async t => {
  const f = await fixture(t), corpus = join(f.workspace, 'corpus');
  const finding = JSON.parse(await readFile(join(repo, 'docs/assets/readme-finding.json'), 'utf8')).finding;
  const id = await addToCorpus(finding, corpus);
  await triageCorpus(corpus, id, 'accepted_regression', { actor: 'test', reason: 'Public synthetic fixture' });
  const before = await snapshot(f.workspace);
  for (const [mode, expected] of [['stable', 0], ['flip', 1]] as const) {
    const stub = await stubSpawn(f.dir, 'cloudflare', mode);
    const result = await runAction(env(f.output, { INPUT_COMMAND: 'check', INPUT_TARGET: 'corpus', ...credentials('cloudflare') }), { ...f.deps, spawn: stub.spawn });
    assert.equal(result.exitCode, expected); assert.equal(await stub.calls(), 26);
    assert.equal(JSON.parse(await readFile(result.reportPath, 'utf8')).required, 1);
    assert.equal(await snapshot(f.workspace), before);
    assert.deepEqual((await readdir(result.artifactsPath)).sort(), ['report.json', 'stderr.txt']);
  }
});

test('action empty corpus is inconclusive without keys or API dispatch', async t => {
  const f = await fixture(t); await mkdir(join(f.workspace, 'corpus'));
  const stub = await stubSpawn(f.dir, 'typesafe', 'stable');
  const result = await runAction(env(f.output, { INPUT_COMMAND: 'check', INPUT_TARGET: 'corpus' }), { ...f.deps, spawn: stub.spawn });
  assert.equal(result.exitCode, 3); assert.equal(await stub.calls(), 0);
});

test('action timeout and oversized child output fail closed', async t => {
  const f = await fixture(t); await campaign(f.workspace);
  for (const source of ['setInterval(()=>{},1000)', 'process.stdout.write("x".repeat(9*1024*1024))']) {
    const spawn = (_command: string, _args: string[], options: Parameters<typeof nodeSpawn>[2]) => nodeSpawn(process.execPath, ['-e', source], options!);
    const result = await runAction(env(f.output), { ...f.deps, spawn, timeoutMs: 150 });
    assert.equal(result.exitCode, 2); assert.equal(await finalizeStatus(result.statusPath, f.tempRoot), 2);
  }
});

test('action finalizer rejects absent, malformed, and out-of-root state and faithfully exits 0..3', async t => {
  const f = await fixture(t), status = join(f.tempRoot, 'status.json');
  assert.equal(await finalizeStatus('', f.tempRoot), 2);
  for (const text of ['{}', '{"exitCode":0,"extra":1}', '{"exitCode":"0"}', 'invalid']) {
    await writeFile(status, text); assert.equal(await finalizeStatus(status, f.tempRoot), 2);
  }
  const outside = join(f.dir, 'outside.json'); await writeFile(outside, '{"exitCode":0}');
  assert.equal(await finalizeStatus(outside, f.tempRoot), 2);
  for (const code of [0, 1, 2, 3]) {
    await writeFile(status, JSON.stringify({ exitCode: code }));
    let observed = 0;
    try { execFileSync(process.execPath, [join(repo, 'scripts/action/finalize.mjs')], { env: { RUNNER_TEMP: f.tempRoot, JEVFUZZ_STATUS_PATH: status } }); }
    catch (error) { observed = (error as { status: number }).status; }
    assert.equal(observed, code);
  }
});
