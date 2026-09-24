import { open, lstat, mkdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DecisionProvider, FailureArtifact, FuzzConfig, FuzzReport, Mutation, RunOptions } from './types.ts';
import { parseConfig, thresholds, validateRequest } from './config.ts';
import { run, RunInterruptedError } from './runner.ts';
import { assert, FuzzError, hash, integer, record } from './util.ts';
import { hasSecrets, parseBoundedJson, pathComponents, readBoundedText, readJson } from './storage.ts';

async function status(path: string) {
  try { return await lstat(path); } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Create each directory after refusing to traverse a symbolic link. */
async function privateDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  for (const current of pathComponents(absolute)) {
    const existing = await status(current);
    // macOS exposes its system temporary directory through /var -> /private/var.
    // Permit that fixed OS alias while refusing every caller-controlled link.
    if (existing?.isSymbolicLink() && current !== '/var') throw new FuzzError('CONFIG', `refusing symbolic-link directory: ${current}`);
    if (existing && !existing.isDirectory() && !(current === '/var' && existing.isSymbolicLink())) throw new FuzzError('CONFIG', `artifact directory is not a directory: ${current}`);
    if (!existing) await mkdir(current, { mode: 0o700 });
    await (await open(current, 'r')).close(); // Verify that the directory remains accessible.
  }
  return absolute;
}

async function writePrivate(path: string, value: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(value, 'utf8'); await handle.chmod(0o600); } finally { await handle.close(); }
}

function hashOnly(report: FuzzReport): unknown {
  const copy = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
  for (const c of copy.cases as Record<string, unknown>[]) {
    delete c.baselineRequest; delete c.baselineResponses; delete c.invariants;
    for (const m of c.mutations as Record<string, unknown>[]) {
      delete m.request; delete m.responses; delete m.mutation; delete m.idMap;
    }
  }
  copy.replay = { available: false, reason: 'REPLAY_UNAVAILABLE_NO_PAYLOADS' };
  return copy;
}

function failure(report: FuzzReport, c: FuzzReport['cases'][number], m: FuzzReport['cases'][number]['mutations'][number], questionId: string): FailureArtifact {
  const comparison = m.comparisons[questionId]!;
  assert(c.baselineRequest !== undefined && m.request !== undefined, 'payloads required for replay artifact');
  return {
    version: 1, runId: report.run.id, caseId: c.id, questionId, mutation: m.mutation, idMap: m.idMap,
    baselineRequest: c.baselineRequest, mutatedRequest: m.request, baselineResponses: c.baselineResponses,
    mutatedResponses: m.responses, comparison, model: report.run.observedModel ?? '', seed: report.run.seed,
    baselineRuns: c.baselineResponses.length, confirmRuns: Math.max(2, m.responses.length - 1),
    baselineRequestHash: hash(c.baselineRequest), mutatedRequestHash: hash(m.request),
  };
}

/** Persist a settled run atomically under <directory>/runs/<run-id>. */
export async function saveArtifacts(report: FuzzReport, directory: string, savePayloads = true, replayProvider?: 'typesafe' | 'cloudflare'): Promise<string> {
  assert(report.version === 1 && /^[A-Za-z0-9-]+$/.test(report.run.id), 'invalid report for artifact storage');
  const root = await privateDirectory(directory);
  const runs = await privateDirectory(join(root, 'runs'));
  const destination = join(runs, report.run.id);
  const existing = await status(destination);
  if (existing) throw new FuzzError('CONFIG', `artifact run already exists: ${destination}`);
  const stage = await privateDirectory(join(runs, `.stage-${report.run.id}-${process.pid}-${Date.now()}`));
  try {
    const persisted = savePayloads ? report : hashOnly(report);
    await writePrivate(join(stage, 'report.json'), `${JSON.stringify(persisted, null, 2)}\n`);
    await writePrivate(join(stage, 'report.txt'), `${renderText(report, { directory: destination, savePayloads, replayProvider })}\n`);
    const manifest = { version: 1, complete: report.run.status !== 'incomplete', replay: { available: savePayloads, reason: savePayloads ? undefined : 'REPLAY_UNAVAILABLE_NO_PAYLOADS' }, run: report.run, summary: report.summary };
    await writePrivate(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    if (savePayloads) {
      let sequence = 0;
      for (const c of report.cases) for (const m of c.mutations) for (const [questionId, comparison] of Object.entries(m.comparisons)) {
        if (comparison.verdict !== 'FAIL') continue;
        if (sequence === 0) await privateDirectory(join(stage, 'failures'));
        sequence++;
        await writePrivate(join(stage, 'failures', `F${String(sequence).padStart(3, '0')}.json`), `${JSON.stringify(failure(report, c, m, questionId), null, 2)}\n`);
      }
    }
    if (await status(destination)) throw new FuzzError('CONFIG', `artifact run already exists: ${destination}`);
    await rename(stage, destination);
    await (await open(destination, 'r')).close();
    return destination;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

function probabilities(label: string, values?: Record<string, number>): string {
  return values ? `${label} ${Object.entries(values).map(([key, value]) => `${key} ${value.toFixed(2)}`).join(' ')}` : '';
}

/** Render the public report fields without generating interpretation prose. */
export function renderText(report: FuzzReport, artifacts: { directory?: string; savePayloads?: boolean; replayProvider?: 'typesafe' | 'cloudflare' } = {}): string {
  const lines = [`JevFuzz ${report.run.jevfuzzVersion}`, `model: ${report.run.observedModel ?? 'unobserved'}`, `seed: ${report.run.seed}`];
  if (report.run.mode === 'replay') lines.push('mode: replay');
  else lines.push(`mode: ${report.run.mode}`);
  if (report.run.status === 'incomplete') lines.push(`run incomplete: ${report.run.error?.code ?? 'RUNTIME'}; results below are partial`);
  if (report.run.modelChanged) lines.push(`model drift: requested ${report.run.requestedModels.join(', ')}; observed ${report.run.observedModels.join(' -> ')}`);
  let failureSequence = 0;
  for (const c of report.cases) {
    lines.push('', `${c.id}`);
    for (const [question, baseline] of Object.entries(c.baseline)) {
      const stability = baseline.stable ? 'baseline stable' : 'baseline unstable';
      const choice = baseline.modalChoice ? ` ${Math.round((baseline.agreementRatio ?? 0) * baseline.runs)}/${baseline.runs} ${baseline.modalChoice}` : baseline.mean !== undefined ? ` mean ${baseline.mean.toFixed(3)} range ${baseline.range?.toFixed(3)}` : '';
      lines.push(`  ${question}: ${stability}${choice}`);
      const p = probabilities('baseline probabilities:', baseline.meanProbabilities); if (p) lines.push(`    ${p}`);
    }
    for (const m of c.mutations) {
      if (Object.keys(m.comparisons).length === 0) {
        lines.push(`  ${m.mutation.type} / ${m.mutation.strategy}: INCONCLUSIVE (unfinished; ${m.responses.length} responses)`);
      }
      for (const [question, result] of Object.entries(m.comparisons)) {
      lines.push(`  ${question} ${m.mutation.type} / ${m.mutation.strategy}: ${result.verdict} (${result.reason})`);
      if (result.mutated.modalChoice !== undefined) lines.push(`    mutated decision: ${result.mutated.modalChoice}`);
      if (result.mutated.mean !== undefined) lines.push(`    mutated mean: ${result.mutated.mean.toFixed(3)}; delta: ${(result.mutated.mean - result.baseline.mean!).toFixed(3)}`);
      if (result.verdict === 'FAIL' || result.reason === 'WARN_FLAKY_MUTATION') {
        const base = result.baseline;
        const support = base.modalChoice !== undefined ? `${Math.round((base.agreementRatio ?? 0) * base.runs)}/${base.runs} ${base.modalChoice}` : `${base.runs} runs; mean ${base.mean!.toFixed(3)}, range ${base.range!.toFixed(3)}`;
        lines.push(`    ${result.verdict === 'FAIL' ? 'confirmed' : 'confirmation incomplete or flaky'}: baseline ${support}`);
        lines.push(`      mutated ${result.reproduced}/${result.observations}${result.mutated.modalChoice === undefined ? ` ${result.reason}` : ` ${result.mutated.modalChoice}`}`);
      }
      const p = probabilities('mutated probabilities:', result.mutated.meanProbabilities); if (p) lines.push(`    ${p}`);
      if (result.verdict === 'FAIL') {
        failureSequence++;
        if (artifacts.savePayloads === false) lines.push('    replay unavailable: REPLAY_UNAVAILABLE_NO_PAYLOADS');
        else if (artifacts.directory) {
          const file = join(artifacts.directory, 'failures', `F${String(failureSequence).padStart(3, '0')}.json`);
          lines.push(`    artifact: ${file}`, `    replay: jevfuzz replay '${file.replaceAll("'", "'\\''")}'${artifacts.replayProvider === 'cloudflare' ? ' --provider cloudflare' : ''}`);
        }
      }
      }
    }
  }
  lines.push('', `${report.summary.mutations} mutations${report.run.status === 'incomplete' ? ' planned; run incomplete' : ''}`, `PASS: ${report.summary.pass}`, `WARN: ${report.summary.warn}`, `FAIL: ${report.summary.fail}`, `INCONCLUSIVE: ${report.summary.inconclusive}`, `${report.summary.logicalRequests} requests`, `HTTP attempts: ${report.summary.httpAttempts} (retries: ${report.summary.httpRetries ?? 'unavailable'})`, `input tokens: ${report.summary.usage.inputTokens}`, `output tokens: ${report.summary.usage.outputTokens}`);
  return lines.join('\n');
}

function validateArtifact(value: unknown): FailureArtifact {
  assert(record(value) && value.version === 1, 'invalid failure artifact version');
  const artifact = value as unknown as FailureArtifact;
  assert(typeof artifact.runId === 'string' && typeof artifact.caseId === 'string' && typeof artifact.questionId === 'string', 'invalid failure artifact identity');
  validateRequest(artifact.baselineRequest); validateRequest(artifact.mutatedRequest);
  assert(artifact.baselineRequest.model === artifact.mutatedRequest.model, 'artifact requests must use the same model');
  integer(artifact.baselineRuns, 'artifact baseline runs', 2); integer(artifact.confirmRuns, 'artifact confirm runs', 2);
  assert(record(artifact.idMap) && Object.entries(artifact.idMap).every(([mutated, original]) => typeof mutated === 'string' && typeof original === 'string'), 'invalid artifact question map');
  assert(Object.keys(artifact.idMap).every(question => Object.hasOwn(artifact.mutatedRequest.questions, question)), 'artifact question map has unknown mutated question');
  const effectiveMap = Object.fromEntries(Object.keys(artifact.mutatedRequest.questions).map(question => [question, Object.hasOwn(artifact.idMap, question) ? artifact.idMap[question]! : question]));
  const originals = Object.values(effectiveMap);
  assert(Object.keys(artifact.mutatedRequest.questions).length === Object.keys(artifact.baselineRequest.questions).length && new Set(originals).size === originals.length && originals.every(question => Object.hasOwn(artifact.baselineRequest.questions, question)), 'artifact question map must be a full bijection');
  assert(Object.hasOwn(artifact.baselineRequest.questions, artifact.questionId), 'artifact question is absent from baseline request');
  const mapped = Object.entries(artifact.idMap).find(([, original]) => original === artifact.questionId)?.[0] ?? artifact.questionId;
  assert(Object.hasOwn(artifact.mutatedRequest.questions, mapped), 'artifact question map does not match mutated request');
  const recipe = artifact.mutation as unknown as Record<string, unknown>;
  const recipeTypes = new Set(['question_id_rename', 'question_order', 'choice_criteria_order', 'object_key_order', 'unordered_array_shuffle', 'irrelevant_field_injection', 'text_normalization']);
  assert(record(recipe) && typeof recipe.type === 'string' && recipeTypes.has(recipe.type) && typeof recipe.strategy === 'string' && recipe.strategy.length > 0, 'invalid artifact mutation recipe');
  integer(recipe.seed, 'artifact mutation seed', 0, 0xffffffff);
  if (recipe.question !== undefined) assert(typeof recipe.question === 'string', 'invalid artifact mutation question');
  if (recipe.path !== undefined) assert(typeof recipe.path === 'string', 'invalid artifact mutation path');
  if (recipe.field !== undefined) assert(typeof recipe.field === 'string', 'invalid artifact mutation field');
  if (recipe.valueIndex !== undefined) integer(recipe.valueIndex, 'artifact mutation value index', 0);
  thresholds(artifact.comparison.thresholds);
  if (artifact.baselineRequestHash !== undefined) assert(artifact.baselineRequestHash === hash(artifact.baselineRequest), 'artifact baseline request hash mismatch');
  if (artifact.mutatedRequestHash !== undefined) assert(artifact.mutatedRequestHash === hash(artifact.mutatedRequest), 'artifact mutated request hash mismatch');
  return structuredClone(artifact);
}

export async function loadFailure(file: string): Promise<FailureArtifact> {
  let parsed: unknown;
  try { parsed = await readJson(file, 8 * 1024 * 1024); } catch { throw new FuzzError('CONFIG', 'cannot read valid failure artifact'); }
  return validateArtifact(parsed);
}

/** Replay a failure against the current provider; historical responses are never used. */
export async function replay(rawArtifact: FailureArtifact, provider: DecisionProvider, input: Partial<RunOptions> = {}, secrets: readonly string[] = []): Promise<FuzzReport> {
  const artifact = validateArtifact(rawArtifact);
  assert(!hasSecrets(artifact, secrets), 'credential detected in replay input; refusing provider dispatch');
  const invariants = Object.fromEntries(Object.keys(artifact.baselineRequest.questions).map(question => [question, question === artifact.questionId ? artifact.comparison.thresholds : {}]));
  const baselineRuns = input.baselineRuns ?? artifact.baselineRuns;
  const confirmRuns = input.confirmRuns ?? artifact.confirmRuns;
  const seed = input.seed ?? artifact.seed;
  const config: FuzzConfig = { version: 1, name: `replay-${artifact.runId}`, cases: [{ id: artifact.caseId, request: artifact.baselineRequest, baselineRuns, mutations: { builtin: false, unorderedArrays: [], irrelevantFields: [], prosePaths: [] }, invariants }] };
  const prepared: Mutation[][] = [[{ recipe: artifact.mutation, request: artifact.mutatedRequest, idMap: artifact.idMap }]];
  try {
    const report = await run(config, provider, { ...input, seed, baselineRuns, confirmRuns }, prepared, secrets);
    report.run.mode = 'replay'; report.run.replayOf = artifact.runId;
    return report;
  } catch (error) {
    if (error instanceof RunInterruptedError) { error.report.run.mode = 'replay'; error.report.run.replayOf = artifact.runId; }
    throw error;
  }
}

/** Import Jev Intent Review JSONL requests, discarding all historical responses. */
export async function importTrace(file: string, outDir: string, secrets: readonly string[] = []): Promise<string[]> {
  let lines: string[];
  try { lines = (await readBoundedText(file, 8 * 1024 * 1024)).split(/\r?\n/).filter(Boolean); } catch { throw new FuzzError('CONFIG', 'cannot read trace file'); }
  const configs: { id: string; config: FuzzConfig }[] = lines.map((line, index) => {
    let trace: unknown;
    try { trace = parseBoundedJson(line, 8 * 1024 * 1024); } catch { throw new FuzzError('CONFIG', `invalid trace JSONL line ${index + 1}`); }
    assert(record(trace) && trace.version === 1 && trace.source === 'jev-intent-review' && Object.hasOwn(trace, 'request') && typeof trace.timestamp === 'string' && Number.isFinite(Date.parse(trace.timestamp)) && record(trace.response), `invalid trace line ${index + 1}`);
    const id = `intent-review-${String(index + 1).padStart(4, '0')}`;
    return { id, config: parseConfig({ version: 1, name: id, cases: [{ id, request: trace.request }] }, `${id}.jevfuzz.json`) };
  });
  assert(!hasSecrets(configs, secrets), 'credential detected in trace input; refusing import');
  const requestedOutput = resolve(outDir);
  const existingOutput = await status(requestedOutput);
  if (existingOutput?.isSymbolicLink()) throw new FuzzError('CONFIG', `refusing symbolic-link output directory: ${requestedOutput}`);
  if (existingOutput) throw new FuzzError('CONFIG', `import output directory already exists: ${requestedOutput}`);
  const output = await privateDirectory(requestedOutput);
  const written: string[] = [];
  for (const { id, config } of configs) {
    const path = join(output, `${id}.jevfuzz.json`);
    if (await status(path)) throw new FuzzError('CONFIG', `import output already exists: ${path}`);
    const c = config.cases[0]!;
    const canonical = { version: 1, name: config.name, baseline: { runs: c.baselineRuns }, cases: [{ id: c.id, request: c.request, mutations: c.mutations, invariants: c.invariants }] };
    await writePrivate(path, `${JSON.stringify(canonical, null, 2)}\n`); written.push(path);
  }
  return written;
}
