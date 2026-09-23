/** Rebuild v0.1.0's public v1 artifact from its immutable git tag. */
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const fixture = join(root, 'fixtures', 'compat-v01', 'position-sensitive.jevfuzz.json');
const destination = join(root, 'fixtures', 'compat-v01');
const tag = 'v0.1.0';
const source = `
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from './src/config.ts';
import { FakeProvider } from './src/provider.ts';
import { run } from './src/runner.ts';
import { saveArtifacts } from './src/artifacts.ts';
const input = process.argv[2]; const out = process.argv[3];
const config = await loadConfig(input);
const provider = new FakeProvider((request) => {
  const changed = Object.keys(request.questions)[0] !== 'route';
  return { model: 'v01-position-sensitive', answers: Object.fromEntries(Object.entries(request.questions).map(([id]) => [id, { type: 'noul', noul: changed ? 0.9 : 0.1 }])), usage: { input_tokens: 1, output_tokens: 1 } };
});
const report = await run(config, provider, { seed: 7, baselineRuns: 2, confirmRuns: 2, concurrency: 1, maxRequests: 100 });
const artifacts = await saveArtifacts(report, out);
await writeFile(join(out, 'capture.json'), JSON.stringify({ report, artifacts }, null, 2) + '\\n');
`;

async function main(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'jevfuzz-v01-'));
  try {
    const archive = join(temp, 'archive.tar');
    await exec('git', ['archive', `--output=${archive}`, tag], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    await exec('tar', ['-xf', archive], { cwd: temp });
    await cp(fixture, join(temp, basename(fixture)));
    await writeFile(join(temp, 'capture.mjs'), source);
    await exec(process.execPath, ['capture.mjs', basename(fixture), 'artifacts'], { cwd: temp, maxBuffer: 16 * 1024 * 1024 });
    const capture = JSON.parse(await readFile(join(temp, 'artifacts', 'capture.json'), 'utf8')) as { report: unknown; artifacts: string };
    const failure = await readFile(join(temp, 'artifacts', 'runs', (capture.report as { run: { id: string } }).run.id, 'failures', 'F001.json'), 'utf8');
    const commit = (await exec('git', ['rev-parse', `${tag}^{commit}`], { cwd: root })).stdout.trim();
    await writeFile(join(destination, 'tag.json'), `${JSON.stringify({ tag, commit, config: basename(fixture), provider: 'FakeProvider position-sensitive-v1', seed: 7 }, null, 2)}\n`);
    await writeFile(join(destination, 'report.json'), `${JSON.stringify(capture.report, null, 2)}\n`);
    await writeFile(join(destination, 'failure.json'), failure);
  } finally { await rm(temp, { recursive: true, force: true }); }
}
await main();
