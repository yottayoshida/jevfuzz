/** Exercise the packed executable through its public .bin with a no-network HTTP adapter. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const run = async (file: string, args: string[], env: NodeJS.ProcessEnv) => {
  try { return { ...(await exec(process.execPath, ['--import', file, ...args], { cwd: root, env, maxBuffer: 32 * 1024 * 1024 })), exit: 0 }; }
  catch (error: unknown) { const value = error as { stdout?: string; stderr?: string; code?: number }; return { stdout: value.stdout ?? '', stderr: value.stderr ?? '', exit: value.code ?? 2 }; }
};
const preload = `
import { appendFile } from 'node:fs/promises';
const trace = process.env.JEVFUZZ_HTTP_TRACE;
globalThis.fetch = async (url, init = {}) => {
  const body = String(init.body ?? ''); const payload = JSON.parse(body);
  const request = payload.input ? { ...payload.input, model: payload.model } : payload;
  const changed = Object.keys(request.questions)[0] !== 'route' && Object.keys(request.questions)[0] !== 'department';
  const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    if (question.type !== 'choice') return [id, { type: 'noul', noul: changed ? 0.9 : 0.1 }];
    const keys = Object.keys(question.criteria), choice = keys[changed ? 1 : 0];
    return [id, { type: 'choice', choice, probabilities: Object.fromEntries(keys.map((key, index) => [key, index === (changed ? 1 : 0) ? 0.9 : 0.1])), confidence: 0.9 }];
  }));
  await appendFile(trace, JSON.stringify({ url: String(url), authorization: init.headers?.Authorization, cache: init.headers?.['Cache-Control'], body }) + '\\n');
  const response = { model: 'stub-1.0', answers, usage: { input_tokens: 1, output_tokens: 1 } };
  return new Response(JSON.stringify(payload.input ? { result: response } : response), { status: 200, headers: { 'content-type': 'application/json' } });
};
`;

async function main(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'jevfuzz-pack-'));
  try {
    const packed = await exec('npm', ['pack', '--json'], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
    const tarball = join(root, (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0]!.filename);
    const sha256 = createHash('sha256').update(await readFile(tarball)).digest('hex');
    const install = temp;
    await exec('npm', ['install', '--offline', '--ignore-scripts', '--omit=dev', tarball], { cwd: install, maxBuffer: 32 * 1024 * 1024 });
    const bin = join(install, 'node_modules', '.bin', 'jevfuzz');
    const trace = join(temp, 'http.jsonl'), stub = join(temp, 'http-stub.mjs'); await writeFile(stub, preload);
    const env = { ...process.env, TYPESAFE_API_KEY: 'pack-test-key', JEV_API_HOST: 'http://127.0.0.1:9999', JEVFUZZ_HTTP_TRACE: trace };
    const command = async (args: string[], expected: readonly number[]) => { const result = await run(stub, [bin, ...args], env); assert.ok(expected.includes(result.exit), `${args.join(' ')}: ${result.stderr} ${result.stdout}`); return result; };
    await command(['doctor', '--json'], [0]);
    await command(['plan', join(root, 'fixtures/compat-v01/position-sensitive.jevfuzz.json'), '--seed', '7', '--json'], [0]);
    const artifacts = join(temp, 'v1-artifacts');
    await command(['run', join(root, 'fixtures/compat-v01/position-sensitive.jevfuzz.json'), '--seed', '7', '--baseline-runs', '2', '--confirm-runs', '2', '--concurrency', '1', '--artifacts-dir', artifacts, '--json'], [1]);
    const v1runs = await readdir(join(artifacts, 'runs')); await command(['replay', join(artifacts, 'runs', v1runs[0]!, 'failures', 'F001.json'), '--concurrency', '1', '--max-requests', '100', '--json'], [1]);
    const campaign = JSON.parse(await readFile(join(root, 'fixtures/v2/routing.campaign.json'), 'utf8')) as Record<string, unknown>;
    const v2dir = join(temp, 'v2-artifacts'); campaign.provider = 'typesafe'; campaign.storage = { ...(campaign.storage as object), directory: v2dir, maxRunBytes: 8_000_000, maxCorpusBytes: 8_000_000 }; campaign.search = { ...(campaign.search as object), maxCandidates: 2, concurrency: 1 }; campaign.oracle = { ...(campaign.oracle as object), pairs: 1 }; campaign.budget = { logicalRequests: 80, httpAttempts: 400, wallTimeSeconds: 120, discoveryRequests: 20, confirmationRequests: 30, shrinkRequests: 12, finalConfirmationRequests: 12 };
    const campaignPath = join(temp, 'campaign.json'); await writeFile(campaignPath, JSON.stringify(campaign));
    await command(['plan', campaignPath, '--json'], [0]); const fuzz = await command(['fuzz', campaignPath, '--json'], [1]);
    const report = JSON.parse(fuzz.stdout) as { status: string; directory?: string; findings: Array<{ id: string }> }; assert.equal(report.status, 'complete'); assert.ok(report.directory); assert.ok(report.findings.length > 0, 'stub should create a v2 finding');
    const finding = join(report.directory!, 'findings', `${report.findings[0]!.id}.json`), replayOut = join(temp, 'replay.json'), shrinkOut = join(temp, 'shrink.json'); await readFile(finding, 'utf8');
    await command(['replay', finding, '--out', replayOut, '--json'], [1]);
    const shrunk = await command(['shrink', finding, '--out', shrinkOut, '--json'], [1]);
    assert.ok(JSON.parse(shrunk.stdout).accepted >= 2, 'packed shrink must iterate across optional fields');
    await command(['replay', shrinkOut, '--out', join(temp, 'minimal-replay.json'), '--json'], [1]);
    const corpus = join(temp, 'corpus'); const added = await command(['corpus', 'add', shrinkOut, '--corpus', corpus, '--json'], [0]); const corpusId = (JSON.parse(added.stdout) as { id: string }).id;
    await command(['corpus', 'triage', corpus, corpusId, '--status', 'accepted_regression', '--actor', 'package-verifier', '--reason', 'offline HTTP adapter regression', '--json'], [0]);
    const beforeCheck = (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).length; const checked = await command(['check', corpus, '--json'], [0, 1, 3]); const checkReport = JSON.parse(checked.stdout) as { results?: unknown[] }; assert.ok((checkReport.results?.length ?? 0) > 0, 'accepted regression must be checked'); const afterCheck = (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).length; assert.ok(afterCheck > beforeCheck, 'check must issue fresh provider observations'); await command(['report', replayOut, '--format', 'html', '--out', join(temp, 'report.html')], [0]);
    const calls = (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { url: string; authorization: string; cache: string; body: string });
    assert.ok(calls.length > 0); assert.ok(calls.every(call => call.url === 'http://127.0.0.1:9999/v1/systemone' && call.authorization === 'Bearer pack-test-key' && call.cache === 'no-cache, no-store')); assert.ok(calls.every(call => JSON.parse(call.body).model === 'jev-latest'));
    console.log(JSON.stringify({ node: process.version, tarball: tarball.split('/').at(-1), sha256, installedDependencies: 0, commands: ['doctor','v1-plan','v1-run','v1-replay','v2-plan','v2-fuzz','v2-replay','v2-shrink','v2-shrunk-replay','corpus-add','corpus-triage','check','report'], httpCalls: calls.length }, null, 2));
  } finally { await rm(temp, { recursive: true, force: true }); }
}
await main();
