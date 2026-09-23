import { parseArgs } from 'node:util';
import { dirname, join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { readJson, privateDir, writePrivate, recoverWriterLock } from '../storage.ts';
import { loadCampaign } from '../campaign-config.ts';
import { campaign, campaignExitCode, campaignSummary, planCampaign } from '../engine/campaign.ts';
import * as campaignModule from '../engine/campaign.ts';
import { recoverCampaign } from '../engine/recovery.ts';
import { EvaluationBroker } from '../engine/broker.ts';
import { BudgetLedger } from '../engine/budget.ts';
import { confirmCandidate, HypothesisSlots } from '../oracles/index.ts';
import { loadFinding, validateFinding } from '../artifacts-v2.ts';
import { shrinkFinding } from '../shrink/index.ts';
import { addToCorpus, checkCorpus, corpusFindings, inspectCorpus, prepareCorpusCheck, pruneCorpus, triageCorpus, type TriageStatus } from '../corpus/index.ts';
import { compareExperiment, loadExperiment } from '../experiments.ts';
import { renderReportHtml, renderReportText } from '../reports-v2.ts';
import { ExecutionJournal } from '../engine/journal.ts';
import { CloudflareProvider, TypeSafeProvider } from '../provider.ts';
import type { DecisionProvider } from '../types.ts';
import type { BudgetConfig, Finding, OracleConfig } from '../campaign-types.ts';
import { assert, FuzzError, record } from '../util.ts';
import { validateReportArtifact } from '../report-validator.ts';

const HELP = `JevFuzz v2
Usage: jevfuzz plan|fuzz <campaign.json>
       jevfuzz inspect <report-or-corpus>
       jevfuzz replay|shrink <finding.json>
       jevfuzz corpus add|inspect|triage|prune <path> [...]
       jevfuzz check <corpus-directory>
       jevfuzz compare <experiment.json>
       jevfuzz report <report.json> [--format text|html]
       jevfuzz resume <checkpoint.json>
       jevfuzz recover-lock <storage-directory>
`;

export interface V2CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  provider?: DecisionProvider;
  signal?: AbortSignal;
}
const budgetForReplay = (oracle: OracleConfig, source: DecisionProvider): BudgetConfig => {
  const confirmation = 3 * oracle.pairs;
  return { logicalRequests: confirmation, httpAttempts: source.capabilities?.httpAccounting ? confirmation * 5 : 0, wallTimeSeconds: 300, discoveryRequests: 0, confirmationRequests: confirmation, shrinkRequests: 0, finalConfirmationRequests: 0 };
};
const budgetForShrink = (oracle: OracleConfig, source: DecisionProvider, shrinkRequests = 96): BudgetConfig => {
  const confirmation = 3 * oracle.pairs, logical = shrinkRequests + confirmation;
  return { logicalRequests: logical, httpAttempts: source.capabilities?.httpAccounting ? logical * 5 : 0, wallTimeSeconds: 300, discoveryRequests: 0, confirmationRequests: 0, shrinkRequests, finalConfirmationRequests: confirmation };
};
function provider(io: V2CliIO, name: 'typesafe' | 'cloudflare' | 'custom'): DecisionProvider {
  assert(['typesafe', 'cloudflare', 'custom'].includes(name), 'unsupported provider');
  if (name === 'custom') { assert(io.provider, 'custom provider requires an injected provider'); return io.provider; }
  return io.provider ?? (name === 'cloudflare' ? new CloudflareProvider(io.env) : new TypeSafeProvider(io.env));
}
function value(flags: Record<string, string | boolean | undefined>, name: string): string | undefined {
  const result = flags[name]; return typeof result === 'string' ? result : undefined;
}
async function findingArtifact(path: string): Promise<Finding> {
  const raw = await readJson(path, 8 * 1024 * 1024);
  if (record(raw) && raw.kind === 'shrink' && record(raw.finding)) { validateReportArtifact(raw); return validateFinding(raw.finding); }
  return validateFinding(raw);
}
function replayExit(confirmation: { verdict: string; reason?: string }): 0 | 1 | 2 | 3 {
  if (confirmation.reason?.startsWith('INCOMPLETE_')) return 2;
  return confirmation.verdict === 'FAIL' ? 1 : confirmation.verdict === 'INCONCLUSIVE' ? 3 : 0;
}

/** Handles v2 commands after main.ts has selected the v2 document/command path. */
export async function mainV2(argv: string[], io: V2CliIO): Promise<number> {
  const secrets = [...new Set([io.env.TYPESAFE_API_KEY, io.env.CLOUDFLARE_API_TOKEN].flatMap(v => v ? [v, v.trim()] : []).filter(Boolean))];
  const clean = (text: string) => secrets.reduce((result, secret) => result.split(secret).join('[REDACTED]'), text);
  const out = (data: unknown, flags: Record<string, string | boolean | undefined>) => {
    let text: string;
    if (flags.json === true) text = `${JSON.stringify(data, null, 2)}\n`;
    else if (value(flags, 'format') === 'html') text = renderReportHtml(data);
    else if (value(flags, 'format') === 'text') text = `${renderReportText(data)}\n`;
    else {
      try { text = `${renderReportText(data)}\n`; }
      catch { text = `${JSON.stringify(data, null, 2)}\n`; }
    }
    io.stdout(clean(text));
  };
  const persist = async (data: unknown, flags: Record<string, string | boolean | undefined>) => {
    const path = value(flags, 'out'); if (!path) return;
    const text = value(flags, 'format') === 'html' ? renderReportHtml(data) : value(flags, 'format') === 'text' ? renderReportText(data) : JSON.stringify(data, null, 2);
    await writePrivate(path, text, secrets);
  };
  try {
    const parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      provider: { type: 'string' }, out: { type: 'string' }, json: { type: 'boolean' }, format: { type: 'string' }, corpus: { type: 'string' }, actor: { type: 'string' }, reason: { type: 'string' }, status: { type: 'string' }, expires: { type: 'string' }, reevaluate: { type: 'string' }, execute: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      'require-confirmation-complete': { type: 'boolean' }, profile: { type: 'string' }, 'max-corpus-bytes': { type: 'string' }, 'shrink-requests': { type: 'string' },
    } });
    const flags = parsed.values as Record<string, string | boolean | undefined>;
    if (flags.help || !parsed.positionals.length) { io.stdout(HELP); return 0; }
    const [command, ...args] = parsed.positionals;
    const requestedProvider = value(flags, 'provider');
    assert(requestedProvider === undefined || requestedProvider === 'typesafe' || requestedProvider === 'cloudflare', 'provider must be typesafe or cloudflare');
    if (value(flags, 'format') !== undefined) assert(['text', 'html'].includes(value(flags, 'format')!), 'format must be text or html');
    if (command === 'plan' || command === 'fuzz') {
      assert(args.length === 1, `${command} requires one campaign file`);
      const config = await loadCampaign(args[0]!);
      if (requestedProvider) config.provider = requestedProvider as 'typesafe' | 'cloudflare';
      const planned = planCampaign(config);
      const { candidatesList: _candidates, ...safePlan } = planned;
      if (command === 'plan') { out(safePlan, flags); return 0; }
      const selected = (requestedProvider ?? config.provider) as 'typesafe' | 'cloudflare' | 'custom';
      const requireConfirmationComplete = flags['require-confirmation-complete'] === true;
      const result = await campaign(config, provider(io, selected), { signal: io.signal, secrets, persist: true, requireConfirmationComplete });
      out(config.storage.mode === 'full' ? result : campaignSummary(result), flags); return result.exitCode;
    }
    if (command === 'resume') {
      assert(args.length === 1, 'resume requires one checkpoint file');
      const resume = (campaignModule as { resumeCampaign?: (path: string, source: DecisionProvider, options: { signal?: AbortSignal; secrets?: string[] }) => ReturnType<typeof campaign> }).resumeCampaign;
      assert(resume, 'resume is unavailable in this build');
      const recovered = await recoverCampaign(args[0]!);
      assert(!requestedProvider || requestedProvider === recovered.config.provider, 'resume cannot change the provider; start a new campaign');
      const result = await resume(args[0]!, provider(io, recovered.config.provider), { signal: io.signal, secrets: secrets });
      out(result, flags); return result.exitCode;
    }
    if (command === 'inspect') {
      assert(args.length === 1, 'inspect requires one report or corpus path');
      const info = await lstat(args[0]!);
      let artifact: unknown;
      if (info.isDirectory()) {
        try { artifact = await readJson(join(args[0]!, 'report.json')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; artifact = await inspectCorpus(args[0]!); }
      } else artifact = await readJson(args[0]!);
      validateReportArtifact(artifact); out(artifact, flags);
      return 0;
    }
    if (command === 'report') {
      assert(args.length === 1, 'report requires one report file'); const report = await readJson(args[0]!, 8 * 1024 * 1024); validateReportArtifact(report); await persist(report, flags); out(report, flags); return 0;
    }
    if (command === 'compare') {
      assert(args.length === 1, 'compare requires one experiment file');
      const experiment = await loadExperiment(args[0]!);
      assert(!requestedProvider || [experiment.old, experiment.new].every(target => target.provider === requestedProvider), 'provider override changes experiment targets');
      const outputPath = value(flags, 'out'); assert(outputPath, 'compare requires --out for a durable journal and result');
      await privateDir(dirname(outputPath)); const journal = await ExecutionJournal.create(`${outputPath}.events.jsonl`, { secrets });
      try {
        const result = await compareExperiment(experiment, target => provider(io, target.provider), { signal: io.signal, journal, secrets });
        await persist(result, flags); out(result, flags); return result.exitCode;
      } finally { await journal.close(); }
    }
    if (command === 'recover-lock') {
      assert(args.length === 1, 'recover-lock requires one storage directory');
      await recoverWriterLock(args[0]!); out({ version: 2, status: 'lock-recovered' }, flags); return 0;
    }
    if (command === 'replay' || command === 'shrink') {
      assert(args.length === 1, `${command} requires one finding file`);
      const finding = await findingArtifact(args[0]!);
      assert(requestedProvider === undefined || requestedProvider === finding.provider, 'provider override changes finding target identity; create a new experiment instead');
      const source = provider(io, finding.provider);
      assert(finding.oracle.profile !== 'fixed-stat-v1' || source.capabilities?.cacheMetadata, 'fixed-stat-v1 requires an adapter with explicit cache metadata');
      const outputPath = value(flags, 'out');
      assert(outputPath, `${command} requires --out for a durable journal and result`);
      const shrinkRequests = value(flags, 'shrink-requests') === undefined ? 96 : Number(value(flags, 'shrink-requests'));
      assert(Number.isSafeInteger(shrinkRequests) && shrinkRequests >= 0 && shrinkRequests <= 1_000_000, 'invalid shrink request budget');
      const ledger = new BudgetLedger(command === 'replay' ? budgetForReplay(finding.oracle, source) : budgetForShrink(finding.oracle, source, shrinkRequests));
      new EvaluationBroker(source, ledger, { strict: true });
      await privateDir(dirname(outputPath));
      const journal = await ExecutionJournal.create(`${outputPath}.events.jsonl`, { secrets });
      const broker = new EvaluationBroker(source, ledger, { signal: io.signal, strict: true, secrets, providerName: requestedProvider ?? finding.provider, journal });
      try {
        if (command === 'replay') {
          await journal.append('replay-start', { findingId: finding.id, candidateId: finding.candidate.id });
          const confirmation = await confirmCandidate(finding.candidate, finding.contract, broker, finding.oracle, { signature: finding.confirmation.signature, seed: 42, policy: finding.policy, ledger, slots: new HypothesisSlots(finding.oracle), journal, discoverySamples: 0 });
          const base = JSON.parse(finding.candidate.basePayload) as { model?: unknown };
          const observedModels = broker.observedModels;
          const result = { version: 2, kind: 'replay', status: confirmation.reason?.startsWith('INCOMPLETE_') ? 'incomplete' : 'complete', findingId: finding.id, confirmation, observations: broker.observations,
            provider: finding.provider, targetHashes: [finding.candidate.targetHash], requestedModels: typeof base.model === 'string' ? [base.model] : [], observedModels,
            cohort: observedModels.length === 0 ? 'unobserved' as const : observedModels.length === 1 ? 'single' as const : 'mixed' as const, budget: ledger.snapshot() };
          await journal.append('replay-finished', { findingId: finding.id, verdict: confirmation.verdict }); await persist(result, flags); out(result, flags); return replayExit(confirmation);
        }
        await journal.append('shrink-start', { findingId: finding.id, candidateId: finding.candidate.id });
        const result = await shrinkFinding(finding, broker, ledger, { seed: 42, slots: new HypothesisSlots(finding.oracle), journal });
        await journal.append('shrink-finished', { findingId: finding.id, status: result.status }); await persist(result, flags); out(result, flags);
        return result.status === 'unconfirmed' ? 3 : result.accepted > 0 ? 1 : result.status === 'budget_limited' ? 3 : 0;
      } finally { await journal.close(); }
    }
    if (command === 'check') {
      assert(args.length === 1, 'check requires one corpus directory');
      const entries = await corpusFindings(args[0]!);
      const profile = value(flags, 'profile');
      assert(profile === undefined || profile === 'paired-v1' || profile === 'fixed-stat-v1', 'unsupported oracle profile');
      const prepared = prepareCorpusCheck(entries, { profile: profile as OracleConfig['profile'] | undefined, providerName: requestedProvider });
      const selected = prepared.provider as 'typesafe' | 'cloudflare' | 'custom';
      const result = await checkCorpus(args[0]!, provider(io, selected), { signal: io.signal, secrets, providerName: selected, profile: profile as OracleConfig['profile'] | undefined, expectedPreparationHash: prepared.preparationHash }); out(result, flags); return result.exitCode;
    }
    if (command === 'corpus') {
      const [operation, directory, ...rest] = args;
      assert(operation && directory, 'corpus requires an operation and directory');
      if (operation === 'inspect') { assert(rest.length === 0, 'corpus inspect takes no extra arguments'); out(await inspectCorpus(directory), flags); return 0; }
      if (operation === 'add') {
        const corpus = value(flags, 'corpus') ?? directory, findingPath = value(flags, 'corpus') ? directory : rest[0];
        assert(findingPath && (value(flags, 'corpus') !== undefined || rest.length === 1), 'corpus add requires a finding file and corpus directory');
        const maxBytes = value(flags, 'max-corpus-bytes') === undefined ? undefined : Number(value(flags, 'max-corpus-bytes'));
        assert(maxBytes === undefined || (Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 2 * 1024 ** 3), 'invalid corpus byte limit');
        out({ id: await addToCorpus(await findingArtifact(findingPath), corpus, { actor: value(flags, 'actor'), reason: value(flags, 'reason'), secrets, maxBytes }) }, flags); return 0;
      }
      if (operation === 'triage') { assert(rest.length === 1 && value(flags, 'status') && value(flags, 'actor') && value(flags, 'reason'), 'corpus triage requires id, --status, --actor, and --reason'); await triageCorpus(directory, rest[0]!, value(flags, 'status') as TriageStatus, { actor: value(flags, 'actor')!, reason: value(flags, 'reason')!, expiresAt: value(flags, 'expires'), reevaluate: value(flags, 'reevaluate'), secrets }); out({ status: 'updated', id: rest[0] }, flags); return 0; }
      if (operation === 'prune') { assert(rest.length === 0, 'corpus prune takes no extra arguments'); const result = await pruneCorpus(directory, flags.execute === true); out(result, flags); return 0; }
      throw new FuzzError('CONFIG', 'unknown corpus operation');
    }
    throw new FuzzError('CONFIG', 'unknown v2 command');
  } catch (error) {
    io.stderr(clean(`ERROR ${error instanceof FuzzError ? `${error.code}: ${error.message}` : 'configuration or runtime error'}\n`)); return 2;
  }
}
