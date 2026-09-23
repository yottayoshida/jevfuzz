/** Derived analysis only: never changes or regenerates frozen measurement rows. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Row = { seed: number; family: string; strategy: string; expected: string; discoveryEvent: boolean; firstFindingLogicalCall: number; logicalCalls: number; actionableFindings: number; sourceHash: string };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const rng = (seed: number) => () => { let value = seed += 0x6d2b79f5; value = Math.imul(value ^ value >>> 15, value | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) / 2 ** 32; };
/** Events are evaluated before censoring at tied times. Null means not reached. */
export function kaplanMeierMedian(rows: Pick<Row, 'discoveryEvent' | 'firstFindingLogicalCall' | 'logicalCalls'>[]): number | null {
  const times = new Map<number, { events: number; censored: number }>();
  for (const row of rows) { const time = row.discoveryEvent ? row.firstFindingLogicalCall : row.logicalCalls, counts = times.get(time) ?? { events: 0, censored: 0 }; if (row.discoveryEvent) counts.events++; else counts.censored++; times.set(time, counts); }
  let risk = rows.length, survival = 1;
  for (const [time, counts] of [...times].sort((a, b) => a[0] - b[0])) { if (counts.events) survival *= 1 - counts.events / risk; if (survival <= .5 + Number.EPSILON) return time; risk -= counts.events + counts.censored; }
  return null;
}
function bootstrapMedian(rows: Row[], seed: number) {
  const random = rng(seed), medians: number[] = [];
  for (let draw = 0; draw < 500; draw++) { const sample = Array.from({ length: rows.length }, () => rows[Math.floor(random() * rows.length)]!); medians.push(kaplanMeierMedian(sample) ?? Infinity); }
  medians.sort((a, b) => a - b);
  const interval = [.025, .975].map(p => medians[Math.floor((medians.length - 1) * p)]!);
  return { medianCalls95: interval.map(value => Number.isFinite(value) ? value : null), medianCalls95RightCensored: interval.map(value => !Number.isFinite(value)), medianBootstrapNotReached: medians.filter(value => !Number.isFinite(value)).length, replicates: medians.length };
}
export function correctCensoredAnalysis(rows: Row[], previous: any, postHoc = true): any {
  const result = structuredClone(previous);
  for (const [key, group] of Object.entries(result.groups) as [string, any][]) {
    const set = rows.filter(row => `${row.family}/${row.strategy}` === key);
    if (!set.length) throw new Error(`analysis group has no rows: ${key}`);
    group.medianFirstFindingLogicalCall = kaplanMeierMedian(set);
    group.medianEstimator = 'kaplan-meier';
    group.bootstrap = { ...group.bootstrap, ...bootstrapMedian(set, createHash('sha256').update(key).digest().readUInt32LE(0)) };
  }
  const comparisons = [...new Set(rows.filter(row => row.expected === 'detect').map(row => row.family))].map(family => {
    const uniform = result.groups[`${family}/uniform`], feedback = result.groups[`${family}/feedback`];
    const reduction = uniform?.medianFirstFindingLogicalCall != null && feedback?.medianFirstFindingLogicalCall != null ? 1 - feedback.medianFirstFindingLogicalCall / uniform.medianFirstFindingLogicalCall : null;
    return { family, reduction, uniformRate: uniform?.discoveryRate, feedbackRate: feedback?.discoveryRate, passes25Percent: reduction !== null && reduction >= .25 };
  });
  const qualifying = comparisons.filter(row => row.passes25Percent).length;
  const criteria = { ...result.promotion.criteria, qualifyingFamiliesAtLeast3: qualifying >= 3, qualifyingFamilies: qualifying, feedbackMedianAtLeast25PercentFaster: comparisons };
  const satisfies = qualifying >= 3 && criteria.discoveryRateNoMoreThan5ppLower;
  result.promotion = { ...result.promotion, criteria, feedbackPromotion: !postHoc && satisfies ? 'promoted' : 'not promoted', reason: postHoc ? 'Kaplan–Meier aggregate correction is versioned post-hoc; this measurement run cannot promote feedback.' : satisfies ? 'All pre-registered criteria passed.' : 'Feedback remains experimental because promotion criteria did not all pass.', medianEstimator: 'kaplan-meier', postHocAnalysis: postHoc };
  return result;
}
export function validateDerivedRows(rows: any[], manifest: any, summary: any, sourceHash: string): void {
  const strategies: string[] = summary.runtime.strategies === 1 ? ['uniform'] : manifest.strategies;
  const expected = new Map<string, string>();
  const seedStart = summary.runtime.seedStart ?? 0;
  const protocolVersion = summary.version ?? 3;
  for (let offset = 0; offset < summary.runtime.seeds; offset++) for (const family of manifest.families) for (const strategy of strategies) expected.set(`${seedStart + offset}/${family.id}/${strategy}`, family.expect);
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.seed}/${row.family}/${row.strategy}`, fail = (reason: string): never => { throw new Error(`invalid derived measurement row ${key}: ${reason}`); };
    if (!expected.has(key) || seen.has(key) || expected.get(key) !== row.expected || row.version !== protocolVersion || row.sourceHash !== sourceHash) fail('tuple, expectation, or source identity');
    seen.add(key);
    const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
    if (!integer(row.logicalCalls) || row.logicalCalls > manifest.full.logicalRequests || !integer(row.httpAttempts) || row.httpAttempts > manifest.full.httpAttempts) fail('budget bounds');
    if (Object.values(row.phaseCosts).some(value => !integer(value)) || Object.values(row.phaseCosts).reduce((a: any, b: any) => a + b, 0) !== row.logicalCalls) fail('phase conservation');
    if (!integer(row.findings) || !integer(row.actionableFindings) || row.actionableFindings > row.findings || row.discoveryEvent !== (row.findings > 0) || row.firstFindingCensored !== !row.discoveryEvent) fail('finding/censor coherence');
    if (row.status !== 'complete' || ![0, 1, 3].includes(row.exitCode) || (row.exitCode === 1) !== row.discoveryEvent || (row.observedModels.length > 1 && row.exitCode !== 3)) fail('status/exit coherence');
    if (!integer(row.confirmationSamples) || !integer(row.controls) || row.confirmationSamples !== row.controls * 3 || row.confirmationSamples !== row.phaseCosts.confirmation) fail('formal phase accounting');
    const ordinals = row.firstConfirmationObservationOrdinals;
    if (!Array.isArray(ordinals)) fail('ordinal provenance');
    if (row.discoveryEvent) {
      if (ordinals.length !== 24 || new Set(ordinals).size !== 24 || ordinals.some((n: number) => !integer(n) || n < 1 || n > row.logicalCalls) || Math.max(...ordinals) !== row.firstFindingLogicalCall || !integer(row.firstConfirmedCandidateOrdinal) || row.firstConfirmedCandidateOrdinal < 1) fail('formal endpoint provenance');
    } else if (ordinals.length || row.firstConfirmedCandidateOrdinal !== null || row.firstFindingLogicalCall !== row.logicalCalls) fail('censor endpoint provenance');
  }
  if (seen.size !== expected.size || rows.length !== summary.runtime.trialRows) throw new Error(`derived tuple coverage mismatch ${seen.size}/${expected.size}`);
}
async function main() {
  const raw = resolve(process.argv[2] ?? 'fixtures/benchmarks/raw-v09-v3');
  const priorText = await readFile(join(raw, 'summary.json'), 'utf8'), summary = JSON.parse(priorText);
  const freeze = JSON.parse(await readFile(join(raw, 'sources.frozen.json'), 'utf8'));
  const rows = (await readFile(join(raw, 'trials.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Row);
  if (!summary.acceptance?.passed) throw new Error('derived analysis requires accepted frozen measurement rows');
  const manifest = JSON.parse(await readFile(join(raw, 'manifest.frozen.json'), 'utf8'));
  validateDerivedRows(rows, manifest, summary, freeze.sourceHash);
  const before = join(raw, 'summary.pre-km.json');
  try { await writeFile(before, priorText, { flag: 'wx', mode: 0o600 }); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
  const script = await readFile(fileURLToPath(import.meta.url), 'utf8');
  summary.analysis = correctCensoredAnalysis(rows, summary.analysis);
  summary.decision = summary.analysis.promotion;
  summary.analysisCorrection = { version: 'km-v1', scriptSHA256: sha(script), priorSummarySHA256: sha(await readFile(before, 'utf8')), measurementSourceHash: freeze.sourceHash, semanticRowValidation: 'passed-km-v1', rawRowsSHA256: sha(await readFile(join(raw, 'trials.jsonl'), 'utf8')), command: process.argv.join(' '), reason: 'Replace conditional-on-discovery medians with Kaplan–Meier estimates; preserve non-reached bootstrap medians as right-censored.' };
  await writeFile(join(raw, 'summary.json'), JSON.stringify(summary, null, 2));
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  if (raw === join(root, 'fixtures/benchmarks/raw-v09-v3')) await writeFile(join(root, 'fixtures/benchmarks/results-v09.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ status: 'derived-km-analysis-complete', rows: rows.length, correction: summary.analysisCorrection.version, promotion: summary.decision.feedbackPromotion, output: raw }));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
