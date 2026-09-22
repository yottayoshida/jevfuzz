# CLI and library reference

Metamorphic stability testing for Jev decision functions. Standalone CLI and
TypeScript library, Node.js **22.18+**, ESM, no runtime dependencies.

JevFuzz tests **judgment stability, not factual correctness**. A FAIL means a
declared invariant was violated. A PASS does not establish that the original
judgment is correct. Built-in Tier A mutations do not intentionally change
semantic content. Repeated baselines separate ordinary probabilistic instability
from changes caused by a mutation.

```sh
git clone https://github.com/yottayoshida/jevfuzz.git
cd jevfuzz
npm install
export TYPESAFE_API_KEY=... # your TypeSafe key; never commit it
npm run build
node dist/cli/main.js doctor
node dist/cli/main.js plan fixtures/live-smoke.jevfuzz.json --seed 42
node dist/cli/main.js run fixtures/live-smoke.jevfuzz.json --seed 42
# Optional local CLI installation:
npm link
```

The npm registry package is not published. Build from source as above, or install
the tarball attached to the [v0.1.0 release](https://github.com/yottayoshida/jevfuzz/releases/tag/v0.1.0).

## Commands

```sh
jevfuzz doctor
jevfuzz plan request.json --seed 42
jevfuzz run cases/*.json --seed 42 --max-requests 100
jevfuzz replay .jevfuzz/runs/<run-id>/failures/F001.json
jevfuzz import /tmp/intent-review-jev.jsonl --out fixtures/imported
```

`plan` and `doctor` make **zero API calls**. Plan shows the complete worst case
before execution. `run` rejects a plan exceeding `--max-requests` before sending
anything. Limits are logical evaluations; each can use up to five HTTP attempts.
The plan also shows that upper bound. A timed-out POST might already have been
billed; JevFuzz cannot infer that from the transport failure. There is no monetary
spend guarantee without provider pricing and billing information.

Flags: `--seed`, `--baseline-runs` (default 3, minimum 2), `--confirm-runs`
(default 2, minimum 2 extra calls), `--concurrency` (default 4), `--max-requests`
(default 100), `--artifacts-dir` (default `.jevfuzz`), `--json`, `--quiet`,
`--no-save-payloads`. A generated seed is printed and saved once per run.

Exit codes: **0** completed with PASS/WARN and no FAIL; **1** confirmed failure;
**2** configuration, authentication or runtime error; **3** no reliable verdict
(including model change). A warning does not produce exit 1.

## Providers

TypeSafe is the default: `POST https://api.typesafe.ai/v1/systemone`, authenticated
with `TYPESAFE_API_KEY`. `JEV_API_HOST` and `JEV_API_PATH` can explicitly override
the origin/path. HTTPS is required except exact loopback hosts for offline tests.
Redirects are refused. Credentials, URLs with credentials, and raw error bodies
are never logged. The provider implements bounded 429/529 and timeout/network
retries with exponential jitter and `Retry-After`.

Cloudflare-hosted Jev is available through an explicit adapter:

```sh
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
jevfuzz run fixtures/live-smoke.jevfuzz.json --provider cloudflare --seed 42
JEVFUZZ_LIVE_PROVIDER=cloudflare npm run test:live
```

This explicit selection maps `jev-latest` or `typesafe/jev` to Workers AI's
`typesafe/jev`. It never falls back from TypeSafe or uses a TypeSafe key. It
requires the **actual returned model version** and token usage from Cloudflare's
response. Every response in a run must report the same model. Any model change
makes the whole run `INCONCLUSIVE_MODEL_CHANGED`, including earlier failures.
Missing version metadata is a runtime error rather than an invented version.

`FakeProvider` is for offline library tests only; the CLI has no fake fallback.

## Inputs and mutations

A raw TypeSafe request works without a wrapper:

```json
{"state":"The sky is blue.","model":"jev-latest","questions":{"blue":{"type":"noul","instructions":"Is the sky described as blue?"}}}
```

Use a version-1 `.jevfuzz.json` wrapper for several cases, declared mutations or
thresholds. See [the intent-review fixture](../fixtures/intent-review.jevfuzz.json)
and [the supplied PRD](PRD.md). Unsupported versions/fields and invalid
requests are rejected; JSON is the only configuration format.

Tier A: question-ID renaming (answers remapped), independent question order,
Choice criterion order, and recursive object-key order in content. Each request
changes one mutation class. Duplicate/no-op permutations are omitted. JavaScript
integer-like keys retain their mandated enumeration order; a permutation that
cannot change serialized bytes is not counted as a test. Score levels and array
element order are preserved.

Optional declarations under each case's `mutations`:

```json
{
  "builtin": true,
  "unorderedArrays": ["$.state.available_tools"],
  "irrelevantFields": [{"path":"$.state","field":"trace_id","values":["123","999"]}],
  "prosePaths": ["$.state.description"]
}
```

Paths support dot properties, array indices, and double-quoted bracket keys.
Wildcards are not supported. Declaration targets must exist; field injection
must add a new field. Do not declare source code as prose. User declarations are
assertions of semantic irrelevance, not facts JevFuzz can independently prove.
See [mutation safety](mutation-safety.md).

## Verdicts

Choice baselines must unanimously agree. Noul baseline range must be at most
0.10; Score range at most 0.35. Unstable questions are always inconclusive,
independent of other questions in the same request.

Choice flips, Noul threshold crossings with a mean shift of at least 0.15, and
Score shifts of at least 0.5 are candidates. The exact mutated payload is rerun
twice by default. At least two thirds of observations must reproduce the same
failing verdict. An outlying third observation does not veto two matching
failures. Otherwise the candidate is `WARN_FLAKY_MUTATION`.

Choice/Score JS divergence (base 2) at least 0.15, confidence drop at least 0.30,
and nonflipping Noul shift at least 0.20 produce warnings. Confidence is not
correctness. All raw probabilities remain available in full reports.

Live Jev responses can round probabilities to two decimals so their sum is 0.99
or 1.01. Validation accepts the implied rounding interval and preserves raw
values; only the JS-divergence calculation normalizes distributions.

Per-question `invariants` supports `type` (`choice_stable`, `noul_stable`,
`score_stable`) and these threshold fields: `noulBaselineRange`,
`scoreBaselineRange`, `noulThreshold`, `noulMinDelta`, `scoreDelta`, `jsDivergence`,
`confidenceDrop`, `noulProbabilityShift`. See exported TypeScript types.

## Artifacts and replay

`.jevfuzz/runs/<run-id>/` contains `manifest.json`, `report.json`, `report.txt`,
and independently replayable `failures/F001.json` files. JSON report version 1 is
the public contract. It records versions, seed, hashes, requested/observed models,
thresholds, baseline/mutation/confirmation answers, usage, and request counts.

Artifacts stay local. New directories use 0700, files 0600 where supported, and
symlinks/overwrites are refused. **Full artifacts may contain private source and
prompts.** File permissions do not prevent the same user from committing them;
keep `.jevfuzz/` ignored. `--no-save-payloads` persists hashes and summaries only,
and disables replay. A runtime error or cancellation saves a partial report with
`run.status: "incomplete"` and `manifest.complete: false`, then exits 2. Validated
answers and exact HTTP retry counts survive the interruption; unfinished
confirmations never become failure artifacts. Library callers can catch
`RunInterruptedError` and read its `report`. Custom providers must honor the
supplied abort signal so in-flight work can settle before persistence.
Replay uses your current provider configuration and rechecks its request budget;
historical answers are never treated as truth.

## Library and tests

```ts
import { loadConfig, run, TypeSafeProvider } from 'jevfuzz';
const report = await run(await loadConfig('request.json'), new TypeSafeProvider(), { seed: 42 });
```

```sh
npm run typecheck
npm test                  # offline, Node's built-in test runner
npm run build
npm run test:live         # explicit paid-network test, requires credentials
```

The live test exits nonzero when credentials are missing; it does not silently
skip or substitute a fake provider. A stable result or confirmed counterexample
is a successful smoke test; an inconclusive/error result is not.

The optional `JEV_TRACE_FILE` exporter is implemented separately in
`jev-intent-review`. Import takes only the normalized request from each line,
then JevFuzz collects a fresh baseline. This repository has no dependency on that
tool. [Verification evidence](verification.md) records live/offline scope
and any remaining limitations. No GUI, LLM mutations, prompt optimization,
correctness oracle, telemetry, or automatic report upload is included.
