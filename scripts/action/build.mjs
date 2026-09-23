import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = await realpath(process.env.GITHUB_ACTION_PATH);
const cache = await mkdtemp(join(await realpath(process.env.RUNNER_TEMP), 'jevfuzz-npm-'));
const userConfig = join(cache, 'user.npmrc'), globalConfig = join(cache, 'global.npmrc');
await writeFile(userConfig, '', { mode: 0o600 });
await writeFile(globalConfig, '', { mode: 0o600 });
const env = { PATH: process.env.PATH, HOME: cache, npm_config_cache: cache, npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig, npm_config_registry: 'https://registry.npmjs.org/' };
for (const args of [['ci', '--ignore-scripts', '--no-audit', '--no-fund'], ['run', 'build']]) {
  const child = spawnSync('npm', args, { cwd: root, env, stdio: 'inherit', timeout: 180_000 });
  if (child.status !== 0) process.exit(child.status || 2);
}
