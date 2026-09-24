import { thresholds } from './config.ts';
import type { BaselineStats, Comparison, Invariant, JevAnswer, Thresholds } from './types.ts';
import { FuzzError } from './util.ts';
import { canonicalJson } from './storage.ts';

const EPSILON = 1e-12;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validAnswer(answer: unknown): answer is JevAnswer {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return false;
  const value = answer as Record<string, unknown>;
  if (value.type === 'noul') return finite(value.noul);
  if (value.type !== 'choice' && value.type !== 'score') return false;
  if (!finite(value.confidence) || value.probabilities === null || typeof value.probabilities !== 'object' || Array.isArray(value.probabilities)
    || Object.keys(value.probabilities).length === 0 || !Object.values(value.probabilities).every(finite)) return false;
  if (value.type === 'choice') return typeof value.choice === 'string';
  return finite(value.score) && value.legend !== null && typeof value.legend === 'object' && !Array.isArray(value.legend);
}

function requireAnswers(answers: JevAnswer[], minimum: number): JevAnswer[] {
  let clean: unknown;
  try { clean = canonicalJson(answers); } catch { throw new FuzzError('CONFIG', 'comparison requires valid answers'); }
  if (!Array.isArray(clean) || clean.length < minimum || !clean.every(validAnswer)) throw new FuzzError('CONFIG', 'comparison requires valid answers');
  const typed = clean as JevAnswer[];
  const type = typed[0]!.type;
  if (!typed.every(answer => answer.type === type)) throw new FuzzError('CONFIG', 'comparison answers must have one type');
  return typed;
}

function probabilityStats(answers: Extract<JevAnswer, { probabilities: Record<string, number> }>[]): Pick<BaselineStats, 'meanProbabilities' | 'minProbabilities' | 'maxProbabilities'> {
  const labels = [...new Set(answers.flatMap(answer => Object.keys(answer.probabilities)))];
  const meanProbabilities: Record<string, number> = Object.create(null);
  const minProbabilities: Record<string, number> = Object.create(null);
  const maxProbabilities: Record<string, number> = Object.create(null);
  for (const label of labels) {
    const values = answers.map(answer => answer.probabilities[label] ?? 0);
    meanProbabilities[label] = values.reduce((total, value) => total + value, 0) / values.length;
    minProbabilities[label] = Math.min(...values);
    maxProbabilities[label] = Math.max(...values);
  }
  return { meanProbabilities: Object.fromEntries(Object.entries(meanProbabilities)), minProbabilities: Object.fromEntries(Object.entries(minProbabilities)), maxProbabilities: Object.fromEntries(Object.entries(maxProbabilities)) };
}

/** Summarize one typed answer population using the configured stability bounds. */
export function summarize(answers: JevAnswer[], invariant: Invariant = {}): BaselineStats {
  answers = requireAnswers(answers, 1);
  const type = answers[0]!.type;
  const limits = thresholds(invariant);
  if (type === 'choice') {
    const choices = answers as Extract<JevAnswer, { type: 'choice' }>[];
    const counts = new Map<string, number>();
    for (const answer of choices) counts.set(answer.choice, (counts.get(answer.choice) ?? 0) + 1);
    const [modalChoice, modalCount] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
    return {
      type, runs: answers.length, stable: counts.size === 1, modalChoice,
      agreementRatio: modalCount / answers.length,
      ...probabilityStats(choices),
      meanConfidence: choices.reduce((total, answer) => total + answer.confidence, 0) / choices.length,
    };
  }
  if (type === 'noul') {
    const values = (answers as Extract<JevAnswer, { type: 'noul' }>[]).map(answer => answer.noul);
    const min = Math.min(...values), max = Math.max(...values), mean = values.reduce((total, value) => total + value, 0) / values.length;
    return { type, runs: answers.length, stable: max - min <= limits.noulBaselineRange + EPSILON, mean, min, max, range: max - min };
  }
  const scores = answers as Extract<JevAnswer, { type: 'score' }>[];
  const values = scores.map(answer => answer.score);
  const min = Math.min(...values), max = Math.max(...values), mean = values.reduce((total, value) => total + value, 0) / values.length;
  return {
    type, runs: answers.length, stable: max - min <= limits.scoreBaselineRange + EPSILON,
    mean, min, max, range: max - min, ...probabilityStats(scores),
    meanConfidence: scores.reduce((total, answer) => total + answer.confidence, 0) / scores.length,
  };
}

/** Jensen-Shannon divergence in bits, after normalizing the supplied distributions. */
export function jsDivergence(p: Record<string, number>, q: Record<string, number>): number {
  const keys = [...new Set([...Object.keys(p), ...Object.keys(q)])];
  const pTotal = keys.reduce((sum, key) => sum + Math.max(0, p[key] ?? 0), 0);
  const qTotal = keys.reduce((sum, key) => sum + Math.max(0, q[key] ?? 0), 0);
  if (pTotal === 0 || qTotal === 0) return 0;
  const term = (value: number, midpoint: number) => value === 0 ? 0 : value * Math.log2(value / midpoint);
  return keys.reduce((sum, key) => {
    const left = Math.max(0, p[key] ?? 0) / pTotal;
    const right = Math.max(0, q[key] ?? 0) / qTotal;
    const midpoint = (left + right) / 2;
    return sum + (term(left, midpoint) + term(right, midpoint)) / 2;
  }, 0);
}

type Failure = { signature: string; reason: string; delta?: number };

function side(value: number, threshold: number): 'above' | 'below' { return value >= threshold ? 'above' : 'below'; }

function failureFor(answer: JevAnswer, baseline: BaselineStats, limits: Thresholds): Failure | undefined {
  if (answer.type === 'choice' && baseline.type === 'choice' && answer.choice !== baseline.modalChoice) {
    return { signature: `choice:${answer.choice}`, reason: 'FAIL_CHOICE_CHANGED' };
  }
  if (answer.type === 'noul' && baseline.type === 'noul') {
    const delta = answer.noul - baseline.mean!;
    if (side(answer.noul, limits.noulThreshold) !== side(baseline.mean!, limits.noulThreshold) && Math.abs(delta) + EPSILON >= limits.noulMinDelta) {
      return { signature: `noul:${side(answer.noul, limits.noulThreshold)}`, reason: 'FAIL_NOUL_THRESHOLD_FLIP', delta };
    }
  }
  if (answer.type === 'score' && baseline.type === 'score') {
    const delta = answer.score - baseline.mean!;
    if (Math.abs(delta) + EPSILON >= limits.scoreDelta) return { signature: `score:${delta >= 0 ? 'up' : 'down'}`, reason: 'FAIL_SCORE_CHANGED', delta };
  }
  return undefined;
}

function softResult(baseline: BaselineStats, mutated: BaselineStats, limits: Thresholds): Pick<Comparison, 'reason' | 'warnings' | 'jsDivergence' | 'confidenceDrop' | 'delta'> {
  const warnings: string[] = [];
  let divergence: number | undefined;
  let confidenceDrop: number | undefined;
  let delta: number | undefined;
  if (baseline.meanProbabilities && mutated.meanProbabilities) {
    divergence = jsDivergence(baseline.meanProbabilities, mutated.meanProbabilities);
    if (divergence + EPSILON >= limits.jsDivergence) warnings.push('WARN_PROBABILITY_DISTRIBUTION_SHIFT');
  }
  if (baseline.meanConfidence !== undefined && mutated.meanConfidence !== undefined) {
    confidenceDrop = baseline.meanConfidence - mutated.meanConfidence;
    if (confidenceDrop + EPSILON >= limits.confidenceDrop) warnings.push('WARN_CONFIDENCE_DROP');
  }
  if (baseline.type === 'noul' && mutated.type === 'noul') {
    delta = mutated.mean! - baseline.mean!;
    if (Math.abs(delta) + EPSILON >= limits.noulProbabilityShift) warnings.push('WARN_NOUL_PROBABILITY_SHIFT');
  }
  return { reason: warnings[0] ?? 'PASS', warnings, jsDivergence: divergence, confidenceDrop, delta };
}

/** Compare a stable baseline with a mutation; confirmed calls contain the original result plus reruns. */
export function compare(baselineAnswers: JevAnswer[], mutatedAnswers: JevAnswer[], invariant: Invariant = {}, confirmed = false): Comparison {
  baselineAnswers = requireAnswers(baselineAnswers, 2);
  mutatedAnswers = requireAnswers(mutatedAnswers, 1);
  const type = baselineAnswers[0]!.type;
  if (!mutatedAnswers.every(answer => answer.type === type)) throw new FuzzError('CONFIG', 'baseline and mutation answer types must match');
  const limits = thresholds(invariant);
  const baseline = summarize(baselineAnswers, invariant);
  const mutated = summarize(mutatedAnswers, invariant);
  const base: Omit<Comparison, 'verdict' | 'reason' | 'warnings'> = {
    baseline, mutated, thresholds: limits, reproduced: 0, observations: mutatedAnswers.length,
  };
  if (!baseline.stable) return { ...base, verdict: 'INCONCLUSIVE', reason: 'INCONCLUSIVE_BASELINE_UNSTABLE', warnings: [] };

  const failures = mutatedAnswers.map(answer => failureFor(answer, baseline, limits));
  const firstFailure = failures[0];
  if (!confirmed && firstFailure) {
    const matches = failures.filter(failure => failure?.signature === firstFailure.signature).length;
    return { ...base, verdict: 'FAIL', reason: firstFailure.reason, warnings: [], reproduced: matches, delta: firstFailure.delta };
  }
  if (confirmed) {
    const counts = new Map<string, { failure: Failure; matches: number }>();
    for (const failure of failures) {
      if (!failure) continue;
      const current = counts.get(failure.signature);
      if (current) current.matches++;
      else counts.set(failure.signature, { failure, matches: 1 });
    }
    const required = Math.ceil(mutatedAnswers.length * 2 / 3);
    const reproduced = [...counts.values()].find(candidate => mutatedAnswers.length >= 3 && candidate.matches >= required);
    if (reproduced) {
      return { ...base, verdict: 'FAIL', reason: reproduced.failure.reason, warnings: [], reproduced: reproduced.matches, delta: reproduced.failure.delta };
    }
    if (firstFailure) {
      const matches = counts.get(firstFailure.signature)!.matches;
      return { ...base, verdict: 'WARN', reason: 'WARN_FLAKY_MUTATION', warnings: ['WARN_FLAKY_MUTATION'], reproduced: matches, delta: firstFailure.delta };
    }
  }
  const soft = softResult(baseline, mutated, limits);
  return { ...base, verdict: soft.warnings.length ? 'WARN' : 'PASS', ...soft };
}
