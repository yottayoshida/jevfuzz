/** Exercise the packed executable through its public .bin for both live adapters, with no-network HTTP stubs. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const providers = ['typesafe', 'cloudflare'] as const;
type ProviderName = typeof providers[number];
type CommandResult = { stdout: string; stderr: string; exit: number };
type ProviderResult = { provider: ProviderName; httpCalls: number; commands: string[] };
const run = async (file: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<CommandResult> => {
  try { return { ...(await exec(process.execPath, ['--import', file, ...args], { cwd, env, maxBuffer: 32 * 1024 * 1024 })), exit: 0 }; }
  catch (error: unknown) { const value = error as { stdout?: string; stderr?: string; code?: number }; return { stdout: value.stdout ?? '', stderr: value.stderr ?? '', exit: value.code ?? 2 }; }
};
// This rejects before returning a response so an adapter regression cannot silently
// pass by merely receiving a plausible canned response.
const preload = `
import { appendFile } from 'node:fs/promises';
const trace = process.env.JEVFUZZ_HTTP_TRACE;
const provider = process.env.JEVFUZZ_STUB_PROVIDER;
const fail = message => { throw new Error('unexpected intercepted request: ' + message); };
globalThis.fetch = async (url, init = {}) => {
  if (init.method !== 'POST') fail('method ' + init.method);
  const headers = new Headers(init.headers);
  const body = String(init.body ?? ''); let payload; try { payload = JSON.parse(body); } catch { fail('invalid JSON body'); }
  const expected = provider === 'typesafe'
    ? { url: 'http://127.0.0.1:9999/v1/systemone', token: 'typesafe-offline-key' }
    : { url: 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run', token: 'cloudflare-offline-token' };
  if (String(url) !== expected.url) fail('URL ' + String(url));
  if (headers.get('authorization') !== 'Bearer ' + expected.token) fail('authorization');
  if (headers.get('content-type') !== 'application/json') fail('content type');
  if (headers.get('cache-control') !== 'no-cache, no-store') fail('cache control');
  if ((provider === 'cloudflare') !== headers.has('cf-aig-skip-cache')) fail('cf-aig-skip-cache presence');
  if (provider === 'cloudflare' && headers.get('cf-aig-skip-cache') !== 'true') fail('cf-aig-skip-cache value');
  if ((provider === 'cloudflare') !== headers.has('cf-aig-max-attempts')) fail('cf-aig-max-attempts presence');
  if (provider === 'cloudflare' && headers.get('cf-aig-max-attempts') !== '1') fail('cf-aig-max-attempts value');
  const request = provider === 'cloudflare' ? payload.input : payload;
  if (!request || typeof request !== 'object' || !request.state || !request.questions) fail('request shape');
  if (provider === 'typesafe') {
    if (payload.model !== 'jev-latest' || Object.hasOwn(payload, 'input')) fail('TypeSafe payload');
  } else {
    if (payload.model !== 'typesafe/jev' || !payload.input || Object.hasOwn(payload.input, 'model')) fail('Cloudflare payload');
    if (Object.keys(payload).sort().join(',') !== 'input,model') fail('Cloudflare top-level shape');
    if (Object.keys(payload.input).sort().join(',') !== 'questions,state') fail('Cloudflare input shape');
  }
  const changed = Object.keys(request.questions)[0] !== 'route' && Object.keys(request.questions)[0] !== 'department';
  const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    if (question.type !== 'choice') return [id, { type: 'noul', noul: changed ? 0.9 : 0.1 }];
    const keys = Object.keys(question.criteria), choice = keys[changed ? 1 : 0];
    return [id, { type: 'choice', choice, probabilities: Object.fromEntries(keys.map((key, index) => [key, index === (changed ? 1 : 0) ? 0.9 : 0.1])), confidence: 0.9 }];
  }));
  await appendFile(trace, JSON.stringify({ url: String(url), method: init.method, headers: Object.fromEntries(headers), body }) + '\\n');
  const response = { model: 'stub-1.0', answers, usage: { input_tokens: 1, output_tokens: 1 } };
  return new Response(JSON.stringify(provider === 'cloudflare' ? { result: response } : response), { status: 200, headers: { 'content-type': 'application/json' } });
};
`;

function providerEnv(provider: ProviderName, trace: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['TYPESAFE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'JEV_API_HOST', 'JEV_API_PATH']) delete env[key];
  Object.assign(env, { JEVFUZZ_HTTP_TRACE: trace, JEVFUZZ_STUB_PROVIDER: provider });
  if (provider === 'typesafe') Object.assign(env, { TYPESAFE_API_KEY: 'typesafe-offline-key', JEV_API_HOST: 'http://127.0.0.1:9999', JEV_API_PATH: '/v1/systemone' });
  else Object.assign(env, { CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef', CLOUDFLARE_API_TOKEN: 'cloudflare-offline-token' });
  return env;
}

async function assertNoSecrets(paths: string[], secrets: string[]): Promise<void> {
  for (const path of paths) {
    const text = await readFile(path, 'utf8');
    assert.ok(secrets.every(secret => !text.includes(secret)), `credential persisted in ${path}`);
  }
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? filesUnder(join(directory, entry.name)) : [join(directory, entry.name)]));
  return nested.flat();
}

async function verifyProvider(provider: ProviderName, install: string, stub: string): Promise<ProviderResult> {
  const work = join(install, provider), trace = join(work, 'http.jsonl');
  await mkdir(work, { recursive: true, mode: 0o700 });
  const env = providerEnv(provider, trace), bin = join(install, 'node_modules', '.bin', 'jevfuzz');
  const fixtureRoot = join(install, 'node_modules', 'jevfuzz', 'fixtures'), commands: string[] = [];
  const countCalls = async () => {
    try { return (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).length; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  };
  const command = async (args: string[], expected: readonly number[], requiresDispatch = false): Promise<CommandResult> => {
    const before = await countCalls();
    const result = await run(stub, [bin, ...args], env, work);
    assert.ok(expected.includes(result.exit), `${provider} ${args.join(' ')}: ${result.stderr} ${result.stdout}`);
    assert.ok(['typesafe-offline-key', 'cloudflare-offline-token'].every(secret => !`${result.stdout}${result.stderr}`.includes(secret)), `${provider} command output leaked a credential`);
    if (requiresDispatch) assert.ok(await countCalls() > before, `${provider} ${args[0]} must issue fresh provider observations`);
    commands.push(args[0]!); return result;
  };
  const providerArgs = ['--provider', provider];
  const other = provider === 'typesafe' ? 'cloudflare' : 'typesafe';
  const invalidDoctor = await run(stub, [bin, 'doctor', ...providerArgs, '--json'], providerEnv(other, join(work, 'negative.jsonl')), work);
  assert.equal(invalidDoctor.exit, 2, `${provider} doctor must reject only-other credentials`);
  assert.match(invalidDoctor.stderr, provider === 'typesafe' ? /missing TYPESAFE_API_KEY/ : /missing CLOUDFLARE_(?:ACCOUNT_ID|API_TOKEN)/);
  assert.ok(['typesafe-offline-key', 'cloudflare-offline-token'].every(secret => !`${invalidDoctor.stdout}${invalidDoctor.stderr}`.includes(secret)), `${provider} negative doctor output leaked a credential`);
  await assert.rejects(readFile(join(work, 'negative.jsonl'), 'utf8'), /ENOENT/, 'misconfigured doctor must not dispatch');
  await command(['doctor', ...providerArgs, '--json'], [0]);
  const v1fixture = join(fixtureRoot, 'compat-v01', 'position-sensitive.jevfuzz.json');
  await command(['plan', v1fixture, '--seed', '7', ...providerArgs, '--json'], [0]);
  const artifacts = join(work, 'v1-artifacts');
  await command(['run', v1fixture, '--seed', '7', '--baseline-runs', '2', '--confirm-runs', '2', '--concurrency', '1', '--artifacts-dir', artifacts, ...providerArgs, '--json'], [1], true);
  const v1runs = await readdir(join(artifacts, 'runs'));
  await command(['replay', join(artifacts, 'runs', v1runs[0]!, 'failures', 'F001.json'), '--concurrency', '1', '--max-requests', '100', ...providerArgs, '--json'], [1], true);
  const campaign = JSON.parse(await readFile(join(fixtureRoot, 'v2', 'routing.campaign.json'), 'utf8')) as Record<string, unknown>;
  const v2dir = join(work, 'v2-artifacts');
  campaign.provider = provider; campaign.storage = { ...(campaign.storage as object), directory: v2dir, maxRunBytes: 8_000_000, maxCorpusBytes: 8_000_000 };
  campaign.search = { ...(campaign.search as object), maxCandidates: 2, concurrency: 1 }; campaign.oracle = { ...(campaign.oracle as object), pairs: 1 };
  campaign.budget = { logicalRequests: 80, httpAttempts: 400, wallTimeSeconds: 120, discoveryRequests: 20, confirmationRequests: 30, shrinkRequests: 12, finalConfirmationRequests: 12 };
  const campaignPath = join(work, 'campaign.json'); await writeFile(campaignPath, JSON.stringify(campaign));
  await command(['plan', campaignPath, ...providerArgs, '--json'], [0]);
  const fuzz = await command(['fuzz', campaignPath, ...providerArgs, '--json'], [1], true);
  const report = JSON.parse(fuzz.stdout) as { status: string; directory?: string; findings: Array<{ id: string }> };
  assert.equal(report.status, 'complete'); assert.ok(report.directory); assert.ok(report.findings.length > 0, 'stub should create a v2 finding');
  const finding = join(report.directory!, 'findings', `${report.findings[0]!.id}.json`), replayOut = join(work, 'replay.json'), shrinkOut = join(work, 'shrink.json'); await readFile(finding, 'utf8');
  await command(['replay', finding, '--out', replayOut, ...providerArgs, '--json'], [1], true);
  const shrunk = await command(['shrink', finding, '--out', shrinkOut, ...providerArgs, '--json'], [1], true); assert.ok(JSON.parse(shrunk.stdout).accepted >= 2, 'packed shrink must iterate across optional fields');
  await command(['replay', shrinkOut, '--out', join(work, 'minimal-replay.json'), ...providerArgs, '--json'], [1], true);
  const corpus = join(work, 'corpus'), added = await command(['corpus', 'add', shrinkOut, '--corpus', corpus, ...providerArgs, '--json'], [0]);
  const corpusId = (JSON.parse(added.stdout) as { id: string }).id;
  await command(['corpus', 'triage', corpus, corpusId, '--status', 'accepted_regression', '--actor', 'package-verifier', '--reason', 'offline HTTP adapter regression', ...providerArgs, '--json'], [0]);
  const checked = await command(['check', corpus, ...providerArgs, '--json'], [0, 1, 3], true); assert.ok((JSON.parse(checked.stdout) as { results?: unknown[] }).results?.length, 'accepted regression must be checked');
  const calls = (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { url: string });
  await command(['report', replayOut, '--format', 'html', '--out', join(work, 'report.html'), ...providerArgs], [0]);
  await assertNoSecrets((await filesUnder(work)).filter(path => path !== trace && path !== join(work, 'negative.jsonl')), ['typesafe-offline-key', 'cloudflare-offline-token']);
  return { provider, httpCalls: calls.length, commands };
}

async function main(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'jevfuzz-pack-')), packDestination = await mkdtemp(join(tmpdir(), 'jevfuzz-pack-tarball-'));
  try {
    const packed = await exec('npm', ['pack', '--json', '--pack-destination', packDestination], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
    const parsed = JSON.parse(packed.stdout) as Array<{ filename?: unknown }>;
    assert.equal(parsed.length, 1, 'npm pack must return one tarball'); assert.equal(typeof parsed[0]?.filename, 'string', 'npm pack must return a filename');
    const filename = parsed[0]!.filename as string; assert.equal(filename, filename.split('/').at(-1), 'npm pack returned an unsafe tarball filename'); assert.match(filename, /^jevfuzz-[0-9A-Za-z._-]+\.tgz$/, 'unexpected tarball filename');
    const tarball = join(packDestination, filename), sha256 = createHash('sha256').update(await readFile(tarball)).digest('hex');
    await exec('npm', ['install', '--offline', '--ignore-scripts', '--omit=dev', tarball], { cwd: temp, maxBuffer: 32 * 1024 * 1024 });
    const stub = join(temp, 'http-stub.mjs'); await writeFile(stub, preload);
    const results: ProviderResult[] = []; for (const provider of providers) results.push(await verifyProvider(provider, temp, stub));
    assert.ok(results.every(result => result.httpCalls > 0), 'each provider must receive intercepted observations');
    console.log(JSON.stringify({ node: process.version, tarball: filename, sha256, installedDependencies: 0, providers: results, httpCalls: results.reduce((total, result) => total + result.httpCalls, 0) }, null, 2));
  } finally { await rm(temp, { recursive: true, force: true }); await rm(packDestination, { recursive: true, force: true }); }
}
await main();
