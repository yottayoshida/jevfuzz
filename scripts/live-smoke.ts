import { main } from '../src/cli/main.ts';

const provider = process.env.JEVFUZZ_LIVE_PROVIDER ?? 'typesafe';
const required = provider === 'cloudflare' ? ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'] : ['TYPESAFE_API_KEY'];
if (required.some(k => !process.env[k])) {
  console.error(`Live smoke NOT EXECUTED: configure ${required.join(' and ')}. No fake fallback.`);
  process.exitCode = 2;
} else {
  console.log(`LIVE smoke (${provider})`);
  const code = await main(['run', 'fixtures/live-smoke.jevfuzz.json', '--provider', provider, '--seed', '42', '--max-requests', '20', '--concurrency', '1']);
  // A confirmed counterexample is a successful test of the framework.
  process.exitCode = code === 0 || code === 1 ? 0 : code;
}
