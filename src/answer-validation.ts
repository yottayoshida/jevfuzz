import { record } from './util.ts';

export function finiteUnit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Keep standalone comparisons and provider responses on the same distribution contract. */
export function probabilities(value: unknown, expectedKeys?: readonly string[]): Record<string, number> | null {
  if (!record(value)) return null;
  const keys = Object.keys(value);
  if (expectedKeys && (keys.length !== expectedKeys.length || expectedKeys.some(key => !Object.hasOwn(value, key)))) return null;
  let total = 0;
  for (const entry of Object.values(value)) {
    if (!finiteUnit(entry)) return null;
    total += entry;
  }
  // Live Jev 1.13.0 rounds to two decimal places, so the sum may be 0.99 or 1.01.
  const rounded = Object.values(value).every(entry => Math.abs((entry as number) * 100 - Math.round((entry as number) * 100)) < 1e-9);
  const tolerance = rounded ? keys.length * 0.005 + 1e-9 : 0.000_001;
  return total > 0 && Math.abs(total - 1) <= tolerance ? value as Record<string, number> : null;
}
