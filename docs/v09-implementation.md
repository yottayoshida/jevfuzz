# v0.9 implementation and evidence ledger

Status: local v0.9 development candidate (`0.9.0-dev.0`). Mandatory field
acceptance and current live conformance remain outstanding. This is not a
release announcement or evidence of external adoption.

Design authority: the five documents in
`/Users/i.yoshida/Documents/ChatGPT/jev/docs/jevfuzz-v1/`, dated 2026-09-22.
Baseline: released v0.1.0, commit `c027851a25f8000a6368e9f11cae5209d3ddd2b9`.
The released compatibility snapshot is retained in `fixtures/compat-v01`.
Current local tests: 171 passed, zero failed/skipped on Node 22.18.0, 24.0.0,
and 26.7.0 (2026-09-23). See the verification record below.

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
and local independent reviews. No GitHub review or current-head CI result is
claimed. Source schemas and the standalone generated validators are one
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

Local implementation and tests are authorized. v0.9 push, release, registry
publication, deployment and messages to pilot participants are not included in
this implementation request. Prior Cloudflare live-validation authorization
is retained, with bounded experiments and no credential persistence.

## Local verification record

All evidence below is local, including the offline HTTP-adapter package test.
No mandatory test is skipped. The current suite includes actual child-process
SIGKILL recovery, corpus quota exhaustion with zero further dispatch, strict
artifact imports, provider identity, fixed-stat integer reference cases, and
independent fresh final shrink confirmation.

| Command | Observed result |
| --- | --- |
| `npm test` | Node 26.7.0: 171/171, exit 0 |
| `npm exec --offline --package=node@22.18.0 -- node --test test/*.test.ts` | 171/171, exit 0 |
| `npm exec --offline --package=node@24.0.0 -- node --test test/*.test.ts` | 171/171, exit 0 |
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
- M09-02 live conformance: no v0.9 live provider result is claimed. The current
  environment has no supplied credential configuration. TypeSafe and Cloudflare
  adapter tests are deterministic offline tests; live cache freshness remains
  unknown and fixed-stat is refused for those adapters.
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
## Publication

No v0.9 push, merge, release, npm publication, deployment, or contact with
  external users has been performed. These external operations need explicit
  operation-and-target authorization.

## Verification tooling limitation

The local risk classifier returned high-risk for sensitive data, recovery, and
change size. The diff-receipt helper
`python3 ~/.codex/hooks/quality_guard.py receipt --repo . ...` returned
`QUALITY_INTERNAL_ERROR` (exit 2). No successful receipt or unobservable
per-agent sandbox attestation is claimed; the executed commands above and their
local test output remain the verification evidence.
