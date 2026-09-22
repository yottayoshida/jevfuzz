# v0.1 delivery evidence — 2026-09-22

The six implementation slices and PRD Definition of Done are implemented.
The user explicitly selected **Cloudflare-hosted Jev** for live verification;
the default TypeSafe provider remains implemented and tested with injected fetch.
TypeSafe-direct live authentication was not exercised because no TypeSafe key was
available. This is the sole approved provider-scope exception.

## Acceptance evidence

| PRD requirement | Evidence |
| --- | --- |
| Standalone OSS CLI/library, Node 22+, ESM | Public repository, MIT license, zero runtime dependencies, built CLI and library declarations. |
| Offline tests/typecheck/build | `npm test`: 43 passed, 0 failed/skipped; `npm run typecheck` and `npm run build`: exit 0. |
| Runnable installed CLI | `npm pack`, local offline tarball installation, installed `.bin/jevfuzz plan`: exit 0 and expected JSON. |
| Doctor without secret output | Built CLI with Cloudflare environment: exit 0, key reported only as present; offline zero-fetch regression. |
| Zero-network plan and correct request ceiling | CLI fetch-spy tests; smoke plan 12, constructed case 21, ten-case plan 318 worst-case logical requests. |
| Choice, Noul, Score | Typed response validation, baseline and comparator tests; live Choice/Noul smoke. |
| Baseline instability and model isolation | Runner tests prove unstable questions never FAIL and late model drift invalidates earlier verdicts. |
| Seeded Tier A and declared mutations | Structural isolation tests, immutable source data, repeat payload bytes in separate Node processes. |
| Confirmation | Position-sensitive provider integration; exact request bytes repeated; 2/3 same failure required. |
| 429/529 retry, timeout, auth failure | Injected-fetch tests, bounded attempts, no retry for auth/config HTTP errors. |
| Cost limit and concurrency | Zero-call preflight rejection, sequential baselines and bounded worker-pool tests. |
| Human/JSON reports and replay | Private artifact and hash-only tests; real counterexample replay below. |
| Credential safety | Provider echo, trace padded-token, and artifact tests; actual configured credential scanned against tracked files with zero matches. |
| Live smoke | Explicit `npm run test:live`: exit 0, 6 logical/HTTP requests, Jev 1.13.0. |
| Intent-review dogfood | Constructed PRD fixture plus 10 distinct captured states, 19 questions, 96 mutations. |
| Optional trace/export | Separate `jev-intent-review` branch `codex/jevfuzz-trace`; final 244 offline tests passed, 0 skipped. |
| Honest limitations | README, mutation-safety document, provider exception and residual risks below. |

`npm test` covers six test files. Six deliberate faults were introduced into
disposable copies (config validation, baseline guard, 529 retry, request budget,
payload-free storage, CLI exit); all six caused the intended tests to fail.
The later rounding, installed-bin, and identifier regressions were observed RED
before their fixes and GREEN afterward. Production sources were never mutated
for the disposable fault tests.

## Live results

All completed runs below observed `jev-1.13.0`; credentials and payload artifacts
remain local in the ignored `.jevfuzz/` directory.

| Experiment | Cases / questions | Mutated requests | PASS / WARN / FAIL / INCONCLUSIVE | Logical / HTTP requests |
| --- | --- | --- | --- | --- |
| Small smoke | 1 / 2 | 3 | 6 / 0 / 0 / 0 | 6 / 6 |
| PRD manually constructed propagation decision | 1 / 1 | 6 | 6 / 0 / 0 / 0 | 9 / 9 |
| Captured intent-review dogfood | 10 / 19 | 96 | 177 / 2 / 7 / 0 | 142 / 142 |
| Independent replay of F002 | 1 / 2 | 1 | 1 / 0 / 1 / 0 | 6 / 6 |

Verdict totals count **question × mutation** comparisons. Mutation totals count
whole-state requests, each containing every question. The 19 dogfood baselines
were all stable (instability rate 0/19). Two confirmed failures came from Choice
criterion order and five from object-key order. Warnings were one confidence
drop and one flaky question-order mutation; no JS threshold warnings occurred.
Dogfood usage: **159,961 input tokens and 17,923 output tokens**, zero HTTP
retries in the completed run.

The optional exporter captured 14 logical evaluations from real
`jev-intent-review` runs on its public synthetic `missed-path` and
`unknown-plugin` fixtures (8 + 6 calls). The first fixture produced eight
distinct states, so the second supplied enough to select ten. Its ordinary
review verdicts were not used as truth. JevFuzz imported requests and collected
its own baselines.

The live API exposed an important compatibility detail: two-decimal
probabilities may sum to 0.99. An earlier dogfood attempt stopped on that strict
validation failure (one diagnostic attempt reached 95 HTTP requests). These
aborted attempts are excluded from completed-run counts above. The provider now
accepts only the implied rounding interval and preserves raw values; an exact
captured response regression covers the correction.

Completed dogfood run: `b895cd7e-e6eb-4a0a-8d42-b0e9c8a89c69`.
Independent replay run: `41642c48-0314-4686-a732-01fdfd909f90`.

```text
FAIL choice_changed — actual live counterexample, F002
case: intent-review-0001
question: relevance
mutation: object_key_order / reverse
baseline: supporting 3/3
mutated:  unrelated 3/3
replay: baseline supporting 3/3, mutated unrelated 3/3
```

The CLI's exit 1 in dogfood/replay is the expected successful detection of a
confirmed metamorphic violation, not an implementation/test-suite failure.

Reproduction commands after configuring Cloudflare credentials:

```sh
jevfuzz import .jevfuzz/dogfood/first-ten.jsonl --out .jevfuzz/dogfood/imported
jevfuzz plan '.jevfuzz/dogfood/imported/*.jevfuzz.json' --seed 42 --max-requests 318 --json
jevfuzz run '.jevfuzz/dogfood/imported/*.jevfuzz.json' --provider cloudflare --seed 42 --max-requests 318 --concurrency 4
jevfuzz replay .jevfuzz/runs/b895cd7e-e6eb-4a0a-8d42-b0e9c8a89c69/failures/F002.json --provider cloudflare --max-requests 6
```

Live smoke was invoked through `npm run test:live` with private environment
values inherited by the subprocess. The completed ten-state run invoked the
same exported CLI `main` with `CloudflareProvider` and a diagnostic fetch wrapper
that reported invalid response shapes; it used the arguments above. Import,
plan, constructed run, and replay were executed through the built CLI.

## Review and limits

Read-only risk treatment used the configured Sol/high risk-specialist role.
Implementation slices used configured Terra/medium; independent local review
used configured Terra/high/read-only. Serving model IDs are not independently
exposed by the runtime. Review found a trace-token normalization defect, fixed
and re-reviewed with the padded-token regression. Core corrections were also
reviewed. These are **local review evidence**, not GitHub review approvals.

The review-package helper falsely classified ordinary TypeScript Authorization
assignments and dummy test credentials as secrets; the reviewer instead received
explicit bounded commit ranges, file allowlists, entrypoints, verification, and
same-class search terms. Actual configured credentials were not in the package.

Small local timing check: 102 mutations generated in 1.07 ms; 100 comparisons
in 1.31 ms; process RSS 87.6 MiB. This is a spot measurement on Node 26.7.0, not
a general performance guarantee. Correctness tests do not assert wall-clock time.

No npm publication or release was performed. The separate trace-export branch
has not been pushed or merged into `jev-intent-review`. TypeSafe-direct live
behavior remains unverified; its HTTP contract is covered offline. Timeout
retries can be billed twice, declared irrelevance remains the user's assertion,
and full local artifacts may contain source content. A FAIL proves instability
under the declared transformation, not which answer is factually correct.
