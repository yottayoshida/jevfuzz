import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn as nodeSpawn } from 'node:child_process';

const MAX = { logical: 1000, http: 5000, seconds: 600, concurrency: 8, candidates: 1000, bytes: 32 * 1024 * 1024, pairs: 8 };
class ActionError extends Error {}
const require = (condition, message) => { if (!condition) throw new ActionError(message); };
const privateWrite = (path, value) => writeFile(path, value, { mode: 0o600 });
const within = (root, path) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };

export async function safeTarget(workspace, target, directory = false) {
  require(typeof target === 'string' && target.length > 0 && !/[\0\r\n\\]/.test(target) && !isAbsolute(target) && !target.split('/').includes('..'), 'target must be a relative path without traversal');
  const root = await realpath(workspace), path = resolve(root, target);
  require(within(root, path), 'target escapes workspace');
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    require(!(await lstat(current)).isSymbolicLink(), 'symlinks are not supported');
  }
  const info = await lstat(path);
  require(directory ? info.isDirectory() : info.isFile() && info.nlink === 1, 'target has the wrong file type');
  require(await realpath(path) === path, 'target escapes workspace');
  if (!directory) require(info.size <= 1_000_000, 'campaign exceeds 1 MB');
  return path;
}

function ceiling(value, max, name) {
  require(Number.isSafeInteger(value) && value >= 0 && value <= max, `${name} exceeds the action limit`);
}
export function normalizeCampaign(raw, provider, storage, directory) {
  require(raw && raw.version === 2 && Array.isArray(raw.seeds) && raw.seeds.every(seed => seed && typeof seed === 'object'), 'action campaigns require inline seed objects');
  const next = structuredClone(raw);
  if (provider) next.provider = provider;
  require(['typesafe', 'cloudflare'].includes(next.provider), 'provider must be typesafe or cloudflare');
  for (const [name, max] of [['logicalRequests', MAX.logical], ['httpAttempts', MAX.http], ['wallTimeSeconds', MAX.seconds]]) ceiling(next.budget?.[name], max, name);
  next.search ??= {};
  for (const [name, max] of [['concurrency', MAX.concurrency], ['maxCandidates', MAX.candidates], ['maxQueueBytes', MAX.bytes]]) if (next.search[name] !== undefined) ceiling(next.search[name], max, name);
  ceiling(next.oracle?.pairs ?? 8, MAX.pairs, 'oracle pairs');
  require((next.oracle?.profile ?? 'paired-v1') === 'paired-v1', 'HTTP adapters support empirical paired confirmation only');
  if (next.storage?.maxRunBytes !== undefined) ceiling(next.storage.maxRunBytes, MAX.bytes, 'maxRunBytes');
  next.storage = { ...next.storage, mode: storage, directory, maxRunBytes: next.storage?.maxRunBytes ?? MAX.bytes };
  return next;
}

async function copyCorpus(source, dest) {
  let bytes = 0, count = 0;
  async function copy(from, to, depth) {
    require(depth <= 8 && ++count <= 256, 'corpus contains too many files or directories');
    const info = await lstat(from);
    require(!info.isSymbolicLink(), 'corpus symlinks are not supported');
    if (info.isDirectory()) {
      await mkdir(to, { mode: 0o700 });
      for (const name of await readdir(from)) await copy(join(from, name), join(to, name), depth + 1);
    } else {
      require(info.isFile() && info.nlink === 1, 'corpus must contain regular files');
      bytes += info.size;
      require(bytes <= MAX.bytes && info.size <= 8 * 1024 * 1024, 'corpus exceeds the action size limit');
      await privateWrite(to, await readFile(from));
    }
  }
  await copy(source, dest, 0);
}

function childEnvironment(input, provider, network) {
  const env = {};
  if (!network) return env;
  const names = provider === 'cloudflare' ? ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] : ['TYPESAFE_API_KEY'];
  for (const name of names) {
    require(typeof input[name] === 'string' && input[name].trim().length > 0, `missing required ${name}`);
    env[name] = input[name];
  }
  return env;
}

async function execute(args, env, deps, signalState) {
  return new Promise(resolveResult => {
    const stdout = [], stderr = [];
    let size = 0, failed = false, settled = false, killTimer;
    const child = (deps.spawn ?? nodeSpawn)(process.execPath, args, { env, cwd: deps.workspace, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => {
      failed = true; child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), deps.killGraceMs ?? 1000);
    };
    signalState.stop = stop;
    const timer = setTimeout(stop, deps.timeoutMs);
    if (signalState.cancelled) stop();
    const collect = output => chunk => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) { stop(); return; }
      output.push(Buffer.from(chunk));
    };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    const finish = code => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(killTimer); signalState.stop = undefined;
      resolveResult({ exitCode: !failed && [0, 1, 2, 3].includes(code) ? code : 2, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    };
    child.once('error', () => { failed = true; finish(2); }); child.once('close', finish);
  });
}

export async function runAction(input = process.env, deps = {}) {
  let exitCode = 2, reportPath = '', artifactsPath = '', statusPath = '';
  const signalState = { cancelled: false, stop: undefined };
  const cancel = () => { signalState.cancelled = true; signalState.stop?.(); };
  process.on('SIGTERM', cancel); process.on('SIGINT', cancel);
  try {
    const tempRoot = await realpath(deps.tempRoot ?? input.RUNNER_TEMP);
    require((await lstat(tempRoot)).isDirectory() && !/[\r\n]/.test(tempRoot), 'invalid runner temporary directory');
    const temp = await mkdtemp(join(tempRoot, 'jevfuzz-')); await chmod(temp, 0o700);
    artifactsPath = join(temp, 'artifacts'); await mkdir(artifactsPath, { mode: 0o700 });
    statusPath = join(temp, 'status.json');
    const command = input.INPUT_COMMAND || 'plan', provider = input.INPUT_PROVIDER || undefined, storage = input.INPUT_STORAGE || 'hash-only';
    require(['plan', 'fuzz', 'check'].includes(command) && ['hash-only', 'full'].includes(storage) && (!provider || ['cloudflare', 'typesafe'].includes(provider)), 'invalid action inputs');
    const workspace = await realpath(deps.workspace ?? input.GITHUB_WORKSPACE);
    const actionPath = await realpath(deps.actionPath ?? input.GITHUB_ACTION_PATH);
    const target = await safeTarget(workspace, input.INPUT_TARGET, command === 'check');
    let selected, executionTarget, seconds = MAX.seconds;
    if (command === 'check') {
      executionTarget = join(temp, 'corpus'); await copyCorpus(target, executionTarget);
      const { corpusFindings, prepareCorpusCheck } = await import(pathToFileURL(join(actionPath, 'dist/corpus/index.js')).href);
      const entries = await corpusFindings(executionTarget);
      require(entries.length <= 20, 'corpus exceeds 20 entries');
      const prepared = prepareCorpusCheck(entries, { providerName: provider });
      require(prepared.oracle.profile === 'paired-v1' && prepared.oracle.pairs <= MAX.pairs, 'unsupported corpus confirmation profile');
      require(Math.max(1, prepared.selected.length) * (2 + 3 * prepared.oracle.pairs) <= MAX.logical, 'corpus exceeds request limit');
      selected = prepared.provider;
      require(['typesafe', 'cloudflare'].includes(selected), 'unsupported corpus provider');
      await privateWrite(join(executionTarget, 'corpus.json'), JSON.stringify({ version: 2, kind: 'corpus-storage', maxBytes: MAX.bytes }));
      if (!prepared.selected.length) {
        // The CLI constructs an adapter for an empty corpus; its empty required
        // selection cannot dispatch. This preserves exit 3 without real keys.
        input = { ...input, TYPESAFE_API_KEY: 'unused-empty-corpus', CLOUDFLARE_API_TOKEN: 'unused-empty-corpus', CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32) };
      }
    } else {
      const raw = JSON.parse(await readFile(target, 'utf8'));
      const config = normalizeCampaign(raw, provider, storage, join(artifactsPath, 'run'));
      const { parseCampaign } = await import(pathToFileURL(join(actionPath, 'dist/campaign-config.js')).href);
      parseCampaign(config);
      selected = config.provider; seconds = config.budget.wallTimeSeconds;
      executionTarget = join(temp, 'campaign.json'); await privateWrite(executionTarget, JSON.stringify(config));
    }
    const env = childEnvironment(input, selected, command !== 'plan');
    const args = [join(actionPath, 'dist/cli/main.js'), command, executionTarget, '--json', '--provider', selected, ...(command === 'fuzz' ? ['--require-confirmation-complete'] : [])];
    const result = await execute(args, env, { ...deps, workspace, timeoutMs: deps.timeoutMs ?? Math.min(MAX.seconds * 1000 + 5000, seconds * 1000 + 5000) }, signalState);
    exitCode = result.exitCode;
    await privateWrite(join(artifactsPath, 'stderr.txt'), result.stderr);
    if (result.stdout.trim()) {
      try {
        const report = JSON.parse(result.stdout); require(report.version === 2, 'invalid CLI report');
        reportPath = join(artifactsPath, 'report.json'); await privateWrite(reportPath, result.stdout);
      } catch { exitCode = 2; }
    } else if (exitCode !== 2) exitCode = 2;
    if (signalState.cancelled) exitCode = 2;
  } catch (error) {
    exitCode = 2;
    if (artifactsPath) await privateWrite(join(artifactsPath, 'error.json'), JSON.stringify({ version: 1, error: error instanceof ActionError ? error.message : 'configuration or runtime validation failed' }));
  } finally {
    process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel);
  }
  if (statusPath) await privateWrite(statusPath, JSON.stringify({ exitCode }));
  if (input.GITHUB_OUTPUT) {
    try {
      const info = await lstat(input.GITHUB_OUTPUT); require(info.isFile() && !info.isSymbolicLink(), 'invalid output file');
      await writeFile(input.GITHUB_OUTPUT, `exit-code=${exitCode}\nreport-path=${reportPath}\nartifacts-path=${artifactsPath}\nstatus-path=${statusPath}\n`, { flag: 'a' });
    } catch {
      exitCode = 2; if (statusPath) await privateWrite(statusPath, JSON.stringify({ exitCode }));
    }
  }
  return { exitCode, reportPath, artifactsPath, statusPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runAction();
  console.log(`JevFuzz result: ${result.exitCode} (${['pass', 'confirmed violation', 'configuration/runtime failure', 'inconclusive'][result.exitCode]}).`);
  process.exitCode = process.argv.includes('--stage') ? 0 : result.exitCode;
}
