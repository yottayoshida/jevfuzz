# v0.2.0 implementation and evidence ledger

Package version: `0.2.0`. The v0.9 labels below refer to design milestones,
not the package release number. Bounded Cloudflare live release verification
passed; mandatory field acceptance and the full provider matrix remain
outstanding. This does not establish external adoption or complete v0.9 acceptance.

Design authority: the JevFuzz v1 product policy, detailed design, roadmap,
benchmark plan, and evidence notes, dated 2026-09-22.
Baseline: released v0.1.0, commit `c027851a25f8000a6368e9f11cae5209d3ddd2b9`.
The released compatibility snapshot is retained in `fixtures/compat-v01`.
Released v0.2.0 verification: 172 passed, zero failed/skipped on Node 22.18.0,
24.0.0, and 26.7.0 (2026-09-23). See the historical record below. Subsequent
local scheduler/provider work passed 185 source tests on Node 22.18.0 and
26.7.0. The subsequent comparison, corpus-oracle, and policy-template fixes
passed 208 source tests on both runtimes, with zero failures or skips. These
changes are local and unreleased; the package version remains `0.2.0`.
The [provider record](provider-conformance.md#dual-provider-readiness-verification--2026-09-23)
documents the installed CLI verification of both provider paths and the
additional Cloudflare live smoke.

## Earlier unmerged local verification — 2026-09-24

The `codex/json-validation-v09` branch closes three further boundary gaps:
v1 `run`/`replay` now reject known credentials before provider dispatch, v1
`import` rejects them before writing files, and public `compare`/`summarize`
reject provider-invalid answer values. Cloudflare requests now set
`cf-aig-max-attempts: 1` as well as `cf-aig-skip-cache: true` on every client
attempt. This requests one gateway attempt per client attempt, but neither
proves origin independence nor changes the disabled live `fixed-stat-v1` mode.

`npm test` passed **235/235**, with zero skips, on Node 26.7.0. The complete
source suite also passed **235/235**, with zero skips, on Node 22.18.0 and
24.0.0. `npm run typecheck`, a clean TypeScript build, `git diff --check`,
and `node scripts/demo-v09.ts` passed. The local synthetic demo used 27 logical
calls and zero HTTP attempts. A fresh temporary source copy passed
`scripts/verify-package.ts` with the installed bin for both adapters: 13 CLI
commands and 44 intercepted fake HTTP calls per provider, with zero runtime
dependencies. The package version remains `0.2.0`; these 235-test results
predate later PR #9 changes and are not a live API run, published package, or
v0.9 release.

The focused regression tests failed before each correction and passed after it.
The reviewer route was requested as `gpt-5.6-terra/high`, but actual runtime
model and effort could not be attested, so no independent-review pass is claimed.
The optional quality receipt returned `QUALITY_INTERNAL_ERROR` (exit 2).
Mandatory field acceptance and live origin-independence evidence remain open.

## PR #9 follow-up evidence — 2026-09-24

At commit `288b992fbf52beec03eb88d9253ce53fdfd5b2fc`, GitHub Actions
[run 35950588488](https://github.com/yottayoshida/jevfuzz/actions/runs/35950588488)
passed `windows-artifacts`, `test (22.18.0)`, `test (24)`, and `action`.
The relevant Linux steps were `Run npm test` and
`Run node scripts/verify-package.ts`; the Action assertion was
`Assert composite outcomes and preserved reports`. This CI predates the
subsequent package-version change and does not validate that later diff.

Legacy `plan`/`run` now reject mixed requested models before provider calls.
Windows path-component checks cover both legacy and v2 artifact storage;
legacy run directories use exclusive creation and publish `manifest.json`
last. Package version metadata is sourced from `package.json`, with source
and installed-package assertions for CLI help and v1 report metadata.
On POSIX, the legacy artifact writer checks directory ownership and unsafe
ancestor writes.
On Windows, caller-supplied storage still requires an ACL-private parent;
the process does not inspect ACLs. Same-user concurrent path replacement
is outside the storage threat model. These constraints do not change the
unmet TypeSafe-direct, origin-independent statistical, or field-acceptance
criteria.

## Slices and acceptance properties

1. Contracts and identity (M02-01/02/03/04): preserve v1 readers/exports;
   validate v2 strictly; replay concrete witnesses byte-for-byte, compose
   mappings and retain distinct contracts for identical wire payloads.
2. Execution boundary (M02-05): legacy and campaign share validated execution;
   reserve logical and HTTP attempts before dispatch, never exceed phase or
   lineage budgets, preserve unknown consumption and observed model identity.
3. Confirmation (M02-07): discovery cannot create a finding; freeze signature
   and pair before fresh randomized A/A'/B blocks, keep controls and IDs.
4. Counterexample workflow (M02-06, M03): immutable evidence and explicit
   regression acceptance; strict pair reduction, protected final confirmation,
   fresh corpus check, safe offline HTML and visible quarantine denominators.
5. Adaptive exploration (M04): versioned feedback, stable batch barriers,
   uniform quota, bounded queue, statistical slots and append-only recovery.
6. Production policy (M05): pure declarative projection, explicit compatible
   old/new targets, independent fresh within-target relation evaluation.
7. Experimental scope (M06): optional research was not adopted. No DAG runtime,
   generated proposal pipeline, predicate pack, optimizer, or compiler is
   included; ROADMAP §7 does not require these experiments for v0.9.
8. Stabilization (M09): schemas/migration/provider matrix, packed entrypoint
   verification, adversarial storage tests, fixed simulator benchmark records,
   and an honest field-validation ledger.

The implementation is divided into the boundaries above, with focused tests
and local independent reviews. No GitHub independent review is claimed;
current-head CI must be read from the PR checks rather than the historical
results above. Source schemas and the standalone generated validators are one
contract-parity unit; broker, journal, and recovery preserve one budget lineage.

## Boundary contract

- Invariant: only a validated, admissible relation with fresh complete evidence
  in one model cohort may become a finding. Legacy v1 behavior remains readable
  and executable; new profiles never silently fall back to legacy.
- Entrypoints: existing `run`/`replay`, new `fuzz`, `shrink`, `check`, `compare`,
  `resume`, and their library APIs. `doctor`, `plan`, `inspect`, corpus writes
  and HTML rendering perform no provider calls.
- Failure: malformed schemas, unsupported capabilities, invalid mappings,
  unsafe paths, insufficient confirmation budgets and incompatible checkpoints
  fail before dispatch. Hypotheses cannot produce hard FAIL.
- Interruption: durable reservations precede dispatch; ambiguous dispatch stays
  consumed-unknown. Cancellation drains in-flight work and saves incomplete
  evidence; it never turns partial confirmation into a finding or restores a
  statistical slot. Model drift invalidates mixed-cohort conclusions.
- Reachable exit: bounded budgets/deadline/candidate count/stagnation, explicit
  cancellation and checkpoint resume; corrupt state fails closed.
- Resource envelope: strict depth/byte/queue/concurrency limits, separate phase
  logical and transport-attempt budgets, protected final-confirmation budget,
  private bounded storage and a single-writer corpus lock.
- Observable truth: report pending/unknown/invalid/no-op/excluded counts,
  evidence level, assumptions, actual model and provider, phase usage, stop
  reason, replayability and minimality limits. Simulator and live evidence are
  separate; no fabricated pilot, correctness or performance claims.
- Authority: versioned TypeScript contracts and JSON schemas, executable
  validators, fixed profile/component versions and package metadata. Existing
  public facade remains supported; no new GitHub protection gates.

## Routing and authorization

Classifier: high-risk (security, state-recovery, resource-limits, large-change).
Planner/risk roles requested: Sol/high/read-only; implementer: Terra/medium;
reviewer: Terra/high/read-only. Tool-selected roles and available runtime
observations will be recorded; unavailable runtime metadata is unknown.
Planner's initial attempt hit capacity and was retried on the same route.

The v0.2.0 release verification covers the source suite, clean package installs,
and bounded Cloudflare experiments when credentials are available. Credentials
are never persisted. Offline adapter checks and live observations are recorded
separately.

## Historical v0.2.0 release verification

The [published v0.2.0 release](https://github.com/yottayoshida/jevfuzz/releases/tag/v0.2.0)
was rechecked through the GitHub API on 2026-09-23: target commit
`a92a4e41b1cc2cf0c3fae7d12f622f0a91f6b21a`, published at
`2026-09-23T06:26:58Z`. Its `jevfuzz-0.2.0.tgz` asset has SHA-256
`bce4aba04c5a8a40c523355d6847d88a8768dcc399a7ec0f160abbded0bb7aaf`.
The table below describes that historical verification, not the subsequent
unreleased worktree or its newly packed artifacts.

The source and package checks below are local, including the offline HTTP-adapter package test.
Fresh Cloudflare release observations are recorded separately in
[provider conformance](provider-conformance.md#v020-cloudflare-live-verification--2026-09-23).
No mandatory test was skipped. That suite includes actual child-process
SIGKILL recovery, corpus quota exhaustion with zero further dispatch, strict
artifact imports, provider identity, fixed-stat integer reference cases, and
independent fresh final shrink confirmation.

| Command | Observed result |
| --- | --- |
| `npm test` | Node 26.7.0: 172/172, exit 0 |
| `npm exec --offline --package=node@22.18.0 -- node --test test/*.test.ts` | 172/172, exit 0 |
| `npm exec --offline --package=node@24.0.0 -- node --test test/*.test.ts` | 172/172, exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `git diff --check` | exit 0 |
| `node scripts/demo-v09.ts` | 27 logical calls, 0 HTTP attempts; buggy check 1, fixed check 0, healthy case preserved |

The exact-binomial test covers 4,728 independently generated Python integer
reference cases. A disposable mutation returning zero for every tail made
that assertion fail; restoring the implementation returned it to green.
The new invalid-triage test also failed before the write-side correction and
passed afterward, including proof that rejected events do not alter the journal.
A disposable reversal of report/terminal publication also failed the real child-
process crash assertion; restoring the production order passed both crash tests.

Package verification runs the installed tarball's executable with no production
dependencies. Its deterministic HTTP stub exercises doctor, legacy plan/run/
replay, campaign plan/fuzz, persisted finding replay, iterative shrink, nested
shrink replay, explicit corpus acceptance, fresh check, and offline HTML. The
runtime matrix and limitations are in `package-verification.md`.

## Review corrections

Local reviewer route requested/configured: reviewer / gpt-5.6-terra / high.
Local risk route requested/configured: risk-specialist / gpt-5.6-sol / high.
The role dispatch selects these models; independently queryable per-agent
runtime routing and sandbox attestation are unavailable and are not invented.

Corrected findings include deep JSON inside payload strings, cross-provider
corpus replay, double-charged orphaned corpus evidence, report identity fields,
false completion after quota failure, retry budget errors mislabeled as storage
errors, and omitted declared prose whitespace reductions. The independent
reviews are local evidence, not GitHub reviews.

## Field acceptance still outstanding

- M03 usability observation and M09-05: three real workload families, two
  external users, two real counterexample → fix → regression loops. Bundled
  synthetic routing/filter/risk examples and the demo do not satisfy this.
- M09-02 full provider conformance: bounded Cloudflare v0.2.0 live verification
  passed (138 logical / HTTP calls), including fresh replay, an actual permutation
  reduction, and a corpus regression check. TypeSafe-direct live behavior and
  cache freshness remain unverified; fixed-stat is refused for both HTTP adapters.
  Direct TypeSafe live validation is deferred by the owner; a direct key is not
  a prerequisite for implementation. The owner also chose to continue without
  a provider inquiry. Neither decision changes the unresolved statistical or
  field-acceptance evidence.
## Local benchmark evidence

M04-07/M09-06 local simulator acceptance passed: 6,000 trials (12 families ×
5 strategies × 100 seeds), 1,000 fixed-stat null campaigns with zero false FAILs
(one-sided 95% upper bound 0.002992), ten known-minimum shrink cases, and 50
seeds with concurrency 1/4/8. Of the adaptive null attempts, 676 campaigns
reached a fresh final confirmation; unused reserved slots are not counted as
executed tests. Power/stress adds 2,200 trials across 22 conditions with explicit
noise/correlation and simulation limits. No live accuracy or FWER claim follows.

The aggregate median estimator was corrected after measurement to include
censoring. Original measurement code and summaries are retained, and corrected
analysis binds their hashes. This historical run cannot promote feedback;
no family met the 25% threshold in the corrected comparison anyway. Uniform
remains the default. `benchmark-v09.md` records commands and limitations.

A fresh v4 measurement now passes the unchanged feedback promotion criteria:
four families exceed 25% median confirmed-call improvement, and pooled
detection increases from 67.43% to 71.86%. All 6,000 trials and supplemental
acceptance checks passed. See [the v4 results](benchmark-feedback-v4-results.md)
for every detectable family, source provenance, and remaining limits. This
does not close live statistical evidence or external field acceptance.
## Distribution

Release artifacts and publication status are recorded in
[GitHub Releases](https://github.com/yottayoshida/jevfuzz/releases).
This package's release number does not claim completion of the outstanding
field acceptance criteria above.

## Verification tooling limitation

The local risk classifier returned high-risk for sensitive data, recovery, and
change size. The diff-receipt helper
`python3 ~/.codex/hooks/quality_guard.py receipt --repo . ...` returned
`QUALITY_INTERNAL_ERROR` (exit 2). No successful receipt or unobservable
per-agent sandbox attestation is claimed; the executed commands above and their
local test output remain the verification evidence.
