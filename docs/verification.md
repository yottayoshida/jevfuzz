# v0.1 PRD completion evidence — 2026-09-22

The six implementation phases and mandatory functionality were audited against
the unchanged [PRD](PRD.md). The second audit corrected confirmation, retry,
interrupted-run retention, CLI reporting and validation gaps. Earlier green
tests alone did not establish PRD completion.

The user explicitly selected **Cloudflare-hosted Jev** for live verification.
TypeSafe remains the default provider with its HTTP contract tested offline.
TypeSafe-direct live authentication was not exercised because no TypeSafe key
was available. This is the approved provider exception, not a fake fallback.

## PRD coverage

| Sections | Implementation and evidence |
| --- | --- |
| 0–3, 29, 31, 35 | Standalone MIT CLI/library, zero runtime dependencies, stability limitations, no generated mutations or prohibited features; README quick start. |
| 4, 17–18 | Choice/Noul/Score, TypeSafe/Fake providers, explicit Cloudflare adapter, observed model, timeout, 429/529 retries, full Retry-After and cancellation. Mocked fetch tests preserve bytes and reject invalid auth/responses. |
| 5–8 | All five commands and flags, Node 22.18 doctor check, zero-network plan, version-1 config and raw request format, exit codes; built and installed CLI executed. |
| 9–11, 14 | Seeded Tier A and declared array/field/prose mutations; tests cover isolation, remapping, Score order, cross-process byte identity and soft invariants. |
| 12–13, 15–16 | Per-question baselines, hard invariants, same-signature two-thirds confirmation without aggregate veto; unstable baselines and model drift cannot FAIL. |
| 19–20 | Whole-run worst-case preflight, atomic logical counter, sequential baselines and bounded mutation workers; actual HTTP attempts/retries separately counted. |
| 21–24 | Versioned JSON, private atomic artifacts, hashes, effective thresholds, responses, replay, actionable human failures; interrupted runs retain settled evidence, mark incomplete and exit 2. |
| 25 | Separate optional normalized trace export in jev-intent-review, private append-only paths, credential filtering, symlink rejection and environment propagation; import validates metadata and reruns baselines. |
| 26 | One real review run captured 24 distinct states; ten imported states received 100 Tier A mutations. Exact results below. |
| 27, 33 | Offline Node tests, typecheck/build, manual paid smoke, real run and independent replay cover the DoD through unit, injected-provider, CLI and live evidence. |
| 28, 34 | Small explicit modules in six phases, with verification throughout; initial work was grouped into phases rather than nineteen separately recorded commits. |
| 30 | No telemetry/uploads/third-party mutation model; destination guards, credential echo denial, raw/trimmed secret filtering and payload-free artifacts tested. |
| 32 | Representative 100-mutation measurement meets CPU, artifact and memory targets below. |
| 36 | Built CLI reports a real confirmed failure, exact artifact path and replay command, retaining the selected Cloudflare flag. |

The current-main trace integration is submitted separately as
[jev-intent-review PR #56](https://github.com/yottayoshida/jev-intent-review/pull/56)
at 4c01722. Its seven focused tests, typecheck and build passed. After a
Darwin-only path normalization correction, both Node 22 and 24 CI jobs passed
all 340 tests with zero skips, and the audit job passed:
[current trace CI](https://github.com/yottayoshida/jev-intent-review/actions/runs/35717625924).
The PR is not merged.

Concrete request types follow the current [official API](https://docs.typesafe.ai/api)
as §35 requires: structured instructions, nullable Choice descriptions, and
2–10 Score levels. The undocumented 64-question cap and two-option Choice
minimum were removed.

## Fresh local verification

```sh
npm run typecheck
npm test
npm run build
node dist/cli/main.js plan fixtures/live-smoke.jevfuzz.json --seed 42 --json
git diff --check
```

All exited 0. **61 tests passed, 0 failed, 0 skipped.** CI runs the suite,
build, built CLI plan and package dry run on Node 22.18.0 and 24; current-head
results are in GitHub Actions. An installed-bin subprocess regression exercises
symlink dispatch; a packed tarball was also installed and executed separately.

New defects were reproduced before fixes: numeric confirmation, long retry
delay, interrupted execution, Node minor version, trimmed credentials and trace
metadata. Two disposable mutants removed replay-map ownership and the Cloudflare
replay flag; each caused the intended test failure, followed by green tests.
Earlier six disposable faults covered config, baseline guard, retry, budget,
payload-free storage and CLI exits. Production sources were restored/left intact.

## Single-run live dogfood

A throwaway repository combined the public synthetic missed-path and
unknown-plugin fixtures and their two requirements. **One** real review CLI
invocation produced 24 distinct request states within a 40-request capture
budget. JevFuzz imported the first ten and collected its own baselines; stored
answers were never truth. Capture used the separately committed exporter before
its port onto the newer upstream main.

```sh
jevfuzz import .jevfuzz/dogfood-single/first-ten.jsonl --out .jevfuzz/dogfood-single/imported
jevfuzz plan '.jevfuzz/dogfood-single/imported/*.jevfuzz.json' --seed 42 --max-requests 330 --json
jevfuzz run '.jevfuzz/dogfood-single/imported/*.jevfuzz.json' --provider cloudflare --seed 42 --max-requests 330 --concurrency 4
jevfuzz replay .jevfuzz/runs/74c77d65-2a40-44ee-95f9-1adae698234a/failures/F001.json --provider cloudflare --max-requests 6
```

Run and replay used the built dist/cli/main.js entrypoint. Every response reported
jev-1.13.0; no retries or model drift occurred.

| Measurement | Dogfood | Independent replay |
| --- | ---: | ---: |
| Cases / questions | 10 / 20 | 1 / 2 |
| Mutations | 100 | 1 |
| PASS / WARN / FAIL / INCONCLUSIVE | 189 / 5 / 6 / 0 | 1 / 0 / 1 / 0 |
| Unstable baseline questions | 0 / 20 | 0 / 2 |
| Logical / HTTP requests | 148 / 148 | 6 / 6 |
| Input / output tokens | 168,331 / 19,350 | 5,670 / 774 |

Verdicts count question × mutation comparisons. One confirmed failure came from
Choice order, five from object-key order. Warnings were two confidence drops and
three flaky mutations; no JS-divergence or Noul-shift warnings occurred. Executed
mutations by class: question ID 10, question order 10, Choice order 60, object
keys 20. Dogfood run: 74c77d65-2a40-44ee-95f9-1adae698234a. Replay run:
295da09d-3bbf-4765-b2d4-9e119395463a. Both exited 1 for successful detection.

```text
relevance object_key_order / reverse: FAIL (FAIL_CHOICE_CHANGED)
  baseline: unrelated 3/3
  mutated: may_violate 3/3
  independent replay: unrelated 3/3 -> may_violate 3/3
```

Earlier acceptance included a tiny live smoke (six requests, two questions) and
a constructed intent-review decision (nine requests, six mutations, all PASS).
The original ten-state experiment combined two review runs; the single-run
experiment above replaces it as §26 evidence. Aborted diagnostic calls are not
included in completed-run totals. One exposed rounded probability sums of 0.99;
a regression now preserves those raw probabilities within their rounding bound.

## Performance and review scope

Local Node 26.7.0, same ten imported cases with FakeProvider and no network:
100 mutations in **4.06 ms**, 100 comparisons in **1.32 ms**, private artifact
and report generation in **24.06 ms**, maximum RSS **66.06 MiB**. The actual live
100-mutation CLI process peaked at **98,123,776 bytes** RSS (93.58 MiB), measured
with /usr/bin/time -l. These are local measurements, not guarantees for arbitrary
input sizes.

Risk treatment used the configured Sol/high role, implementation Terra/medium,
and independent local review Terra/high. The secondary trace's intermediate
symlink defect was reproduced, fixed and re-reviewed. This is local review
evidence, not a GitHub approval. Serving model IDs cannot be queried independently.
The optional local quality-receipt helper returned QUALITY_SESSION_MISSING for
this sibling repository; no hook ledger was fabricated. Executed test and live
evidence above, plus current-head CI, remain the verification record.

No npm publication or release is required or performed. Credentials, captured
states and report payloads stay local in ignored .jevfuzz/. TypeSafe-direct live
behavior remains unverified under the approved Cloudflare choice. Custom
providers that ignore cancellation can delay partial-report persistence;
timeout retries can be billed twice. FAIL proves instability under the declared
transformation, not which answer is factually correct.
