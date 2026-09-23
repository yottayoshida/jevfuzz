#!/usr/bin/env node
/** Canonical v4 entrypoint. It delegates to the shared offline runner. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const runner = resolve(root, 'scripts/benchmark-v09.ts');
const manifest = resolve(root, 'fixtures/benchmarks/manifest-v4.json');
const output = resolve(root, 'fixtures/benchmarks/raw-v09-v4');
const forwarded = process.argv.slice(2);
const hasOutput = forwarded.some((argument, index) => argument === '--out' ? index + 1 < forwarded.length : argument.startsWith('--out='));
const result = spawnSync(process.execPath, [runner, ...forwarded, '--manifest', manifest, ...(hasOutput ? [] : ['--out', output])], {
  env: { ...process.env, JEVFUZZ_BENCHMARK_PROTOCOL: 'v4' },
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
