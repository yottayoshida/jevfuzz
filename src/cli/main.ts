#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { globSync, realpathSync } from 'node:fs';
import { loadConfig } from '../config.ts';
import { TypeSafeProvider, CloudflareProvider } from '../provider.ts';
import { exitCode, options, plan, run, RunInterruptedError } from '../runner.ts';
import { importTrace, loadFailure, renderText, replay, saveArtifacts } from '../artifacts.ts';
import type { DecisionProvider, FuzzConfig, FuzzReport, RunOptions } from '../types.ts';
import { assert, FuzzError } from '../util.ts';
import { readJson } from '../storage.ts';
import { mainV2 } from './v2.ts';
import { TOOL_VERSION } from '../version.ts';

const HELP = `JevFuzz ${TOOL_VERSION} — judgment stability, not factual correctness
Usage:
  jevfuzz doctor
  jevfuzz plan <case.json> [...cases.json]
  jevfuzz run <case.json> [...cases.json]
  jevfuzz replay <failure.json>
  jevfuzz import <trace.jsonl> --out <directory>
  jevfuzz plan|fuzz <campaign-v2.json>
  jevfuzz replay|shrink <finding-v2.json> --out <result.json>
  jevfuzz corpus add <finding.json> --corpus <directory>
  jevfuzz check <corpus-directory>
  jevfuzz compare <experiment.json> --out <report.json>
  jevfuzz resume <checkpoint.json>
  jevfuzz inspect <artifact-or-corpus>
  jevfuzz report <artifact.json> --format html --out <report.html>
Options:
  --seed <integer>          deterministic mutation seed
  --baseline-runs <n>       sequential baseline runs (default 3, minimum 2)
  --confirm-runs <n>        extra confirmation runs (default 2, minimum 2)
  --concurrency <n>         concurrent mutation requests (default 4)
  --max-requests <n>        worst-case logical request ceiling (default 100)
  --artifacts-dir <path>    private local artifacts (default .jevfuzz)
  --provider <name>         typesafe (default) or cloudflare (explicit adapter)
  --no-save-payloads        save only hashes and summaries; disables replay
  --json                   machine-readable stdout
  --quiet                  suppress human stdout
  --help                   show this help
Retries use at most five HTTP attempts per logical request. Plan makes zero API calls.
`;

export interface CliIO {
  stdout: (text: string) => void; stderr: (text: string) => void;
  env: NodeJS.ProcessEnv; provider?: DecisionProvider; signal?: AbortSignal;
}
export async function main(argv: string[], supplied: Partial<CliIO> = {}): Promise<number> {
  const io: CliIO = { stdout: s => { process.stdout.write(s); }, stderr: s => { process.stderr.write(s); }, env: process.env, ...supplied };
  // New v2-only verbs are unambiguous. `plan` and `replay` retain their v1
  // behavior unless their bounded input declares the v2 document kind.
  const directV2 = new Set(['fuzz', 'shrink', 'check', 'compare', 'resume', 'recover-lock', 'inspect', 'corpus', 'report']);
  if (argv[0] === 'v2') return mainV2(argv.slice(1), io);
  if (directV2.has(argv[0] ?? '')) return mainV2(argv, io);
  if ((argv[0] === 'plan' || argv[0] === 'replay') && argv[1] && !argv[1].startsWith('-')) {
    try {
      const document = await readJson(argv[1], 1_000_000);
      if (document !== null && typeof document === 'object' && !Array.isArray(document) && (document as Record<string, unknown>).version === 2) return mainV2(argv, io);
    } catch { /* v1 retains its existing loader and error messages. */ }
  }
  const secrets = [...new Set([io.env.TYPESAFE_API_KEY, io.env.CLOUDFLARE_API_TOKEN].flatMap(s => s ? [s, s.trim()] : []).filter(Boolean))];
  const clean = (text: string) => secrets.reduce((s, secret) => s.split(secret).join('[REDACTED]'), text);
  const stdout = (s: string) => io.stdout(clean(s));
  const stderr = (s: string) => io.stderr(clean(s));
  try {
    const parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      seed: { type: 'string' }, 'baseline-runs': { type: 'string' }, 'confirm-runs': { type: 'string' }, concurrency: { type: 'string' },
      'max-requests': { type: 'string' }, 'artifacts-dir': { type: 'string' }, provider: { type: 'string' }, out: { type: 'string' },
      json: { type: 'boolean' }, quiet: { type: 'boolean' }, 'no-save-payloads': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    } });
    const flags = parsed.values;
    if (flags.help || parsed.positionals.length === 0) { stdout(HELP); return 0; }
    const [command, ...inputs] = parsed.positionals;
    assert(['doctor', 'plan', 'run', 'replay', 'import'].includes(command!), 'unknown command');
    const providerName = (flags.provider ?? 'typesafe') as 'typesafe' | 'cloudflare';
    assert(['typesafe', 'cloudflare'].includes(providerName), 'provider must be typesafe or cloudflare');
    const number = (key: 'seed' | 'baseline-runs' | 'confirm-runs' | 'concurrency' | 'max-requests') => {
      const raw = flags[key]; if (raw === undefined) return undefined;
      assert(/^\d+$/.test(raw), `--${key} must be an integer`); return Number(raw);
    };
    const opts: Partial<RunOptions> = { seed: number('seed'), baselineRuns: number('baseline-runs'), confirmRuns: number('confirm-runs'), concurrency: number('concurrency'), maxRequests: number('max-requests'), signal: io.signal };
    const createProvider = () => io.provider ?? (providerName === 'cloudflare' ? new CloudflareProvider(io.env) : new TypeSafeProvider(io.env));
    const output = (data: unknown, human: string) => { if (flags.json) stdout(`${JSON.stringify(data, null, 2)}\n`); else if (!flags.quiet) stdout(`${human}\n`); };
    if (command === 'doctor') {
      assert(inputs.length === 0, 'doctor does not accept files');
      const [major, minor] = process.versions.node.split('.').map(Number);
      assert(major! > 22 || (major === 22 && minor! >= 18), 'Node 22.18 or newer required');
      const keyName = providerName === 'typesafe' ? 'TYPESAFE_API_KEY' : 'CLOUDFLARE_API_TOKEN';
      createProvider(); // Construction validates configuration, never sends a request.
      output({ node: process.version, provider: providerName, [keyName]: 'present', networkCalls: 0 }, `Node: ${process.version}\nprovider: ${providerName}\n${keyName}: present\nconfiguration valid; no network calls`);
      return 0;
    }
    if (command === 'import') {
      assert(inputs.length === 1 && flags.out, 'import requires one JSONL file and --out');
      const files = await importTrace(inputs[0]!, flags.out);
      output({ files }, `Imported ${files.length} request(s). Historical responses are not an oracle.`); return 0;
    }
    assert(inputs.length > 0, 'input file required');
    const completedOrInterrupted = async (execution: Promise<FuzzReport>): Promise<FuzzReport> => {
      try { return await execution; } catch (error) {
        if (error instanceof RunInterruptedError) return error.report;
        throw error;
      }
    };
    let result: FuzzReport;
    if (command === 'replay') {
      assert(inputs.length === 1, 'replay requires one failure file');
      const artifact = await loadFailure(inputs[0]!);
      result = await completedOrInterrupted(replay(artifact, createProvider(), opts));
    } else {
      const paths = inputs.flatMap(path => /[*?\[]/.test(path) ? globSync(path).sort() : [path]);
      assert(paths.length > 0, 'no files matched');
      const loaded = await Promise.all(paths.map(loadConfig));
      const config: FuzzConfig = { version: 1, name: loaded.map(c => c.name).join(', '), cases: loaded.flatMap(c => c.cases) };
      assert(new Set(config.cases.map(c => c.id)).size === config.cases.length, 'duplicate case IDs across input files');
      const resolved = options(opts);
      const budget = plan(config, resolved);
      if (command === 'plan') {
        output(budget, `JevFuzz plan\nseed ${budget.seed}\ncases ${budget.cases}\nquestions ${budget.questions}\nbaseline requests ${budget.baselineRequests}\ngenerated mutations ${budget.mutationRequests}\nmax confirmation ${budget.maximumConfirmationRequests}\nworst-case requests ${budget.worstCaseRequests}\nmaximum HTTP attempts (including retries) ${budget.maximumHttpAttempts}\nconfigured limit ${budget.configuredLimit}\n${Object.entries(budget.mutationClasses).map(([k, v]) => `  ${k} ${v}`).join('\n')}`);
        return budget.withinBudget ? 0 : 2;
      }
      if (!budget.withinBudget) throw new FuzzError('BUDGET', `request budget exceeded: planned worst case ${budget.worstCaseRequests}, --max-requests ${budget.configuredLimit}`);
      if (!flags.json && !flags.quiet) stderr(`seed: ${resolved.seed}; planned at most ${budget.worstCaseRequests} logical requests\n`);
      result = await completedOrInterrupted(run(config, createProvider(), resolved));
    }
    const serialized = JSON.stringify(result);
    assert(!secrets.some(s => serialized.includes(s)), 'credential detected in result; refusing persistence');
    const dir = await saveArtifacts(result, flags['artifacts-dir'] ?? '.jevfuzz', !flags['no-save-payloads'], providerName);
    output(result, `${renderText(result, { directory: dir, savePayloads: !flags['no-save-payloads'], replayProvider: providerName })}\nartifacts: ${dir}${flags['no-save-payloads'] ? ' (hashes/summary only; replay unavailable)' : ''}`);
    if (result.run.status === 'incomplete') stderr(`ERROR ${result.run.error?.code ?? 'RUN_INTERRUPTED'}: run incomplete; partial artifacts: ${dir}\n`);
    return exitCode(result);
  } catch (error) {
    // Never echo raw transport, parseArgs (may contain secrets), or filesystem errors.
    stderr(`ERROR ${error instanceof FuzzError ? `${error.code}: ${error.message}` : 'configuration or runtime error'}\n`);
    return 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  process.exitCode = await main(process.argv.slice(2), { signal: controller.signal });
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
}
