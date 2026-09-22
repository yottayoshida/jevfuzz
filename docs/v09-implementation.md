# v0.9 implementation and evidence ledger

Status: in progress. Implementation is local on `codex/v0.9`; this document is
not a release announcement or evidence of external adoption.

Design authority: the five documents in
`/Users/i.yoshida/Documents/ChatGPT/jev/docs/jevfuzz-v1/`, dated 2026-09-22.
Baseline: released v0.1.0, commit `c027851a25f8000a6368e9f11cae5209d3ddd2b9`.
Fresh baseline: `npm test` exits 0, 61 passed, zero failed/skipped.

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
7. Experimental scope (M06): start with proposal import/review, isolated from
   structural contracts; no optimizer, compiler, or arbitrary code loading.
8. Stabilization (M09): schemas/migration/provider matrix, packed entrypoint
   verification, adversarial storage tests, fixed simulator benchmark records,
   and an honest field-validation ledger.

Each boundary will have focused tests and fresh independent local review.
Large cross-boundary changes will be reviewed in these slices rather than
represented as one unreviewable release diff.

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

## Evidence still required

- M03 external usability observation, M09-05 three workload families, two
  external users, two real fix/regression loops. Simulators cannot satisfy it.
- Fixed complete benchmark trials and promotion decision for feedback.
- Current packed CLI transcript and provider conformance evidence.
- Current independent review, verification and residual-risk record.
