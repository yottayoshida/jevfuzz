# JevFuzz v0.1 implementation boundaries

The supplied PRD is the scope authority. Its ordered implementation steps are grouped
into six slices: (1) skeleton and providers, (2) config and deterministic Tier A
mutations, (3) baseline/comparison/confirmation, (4) budgeting and runner,
(5) reports/artifacts/replay and declared mutations, (6) CLI environment/planning,
live smoke, intent-review import/export and documentation. No additional providers,
generated paraphrases, or correctness oracle are included.

## Boundary contract

* Entrypoints: `jevfuzz doctor|plan|run|replay|import`; library `run`.
* Invariant: no verdict crosses an unstable baseline or model version boundary;
  every hard failure reproduces in at least two thirds of at least three observations.
* Requests: validate all inputs and compute the entire worst-case logical budget
  before constructing live execution. A request contains every question for its state.
  Baselines are sequential; mutations use a bounded worker pool. Retries are separately
  counted HTTP attempts, at most five per logical request, with a 20-second timeout.
* Errors: invalid configuration/authentication/response/transport ends with exit 2;
  unresolved evidence ends with exit 3. Cancellation stops new work and aborts fetch.
* Network: only the configured HTTPS provider (loopback HTTP for tests); no redirects,
  telemetry, uploads, response error bodies, or secret-bearing endpoint URLs in logs.
* Persistence: local private directories/files, no overwrites or symlink following;
  raw payloads require normal save mode. Hash-only mode has no replay payloads.
  Replay validates the artifact and preflights its request budget again.
* Runtime authority: TypeSafe's official HTTP API, <https://docs.typesafe.ai/api>,
  checked 2026-09-22. Native Node fetch, ESM, Node >=22.18, no runtime dependencies.
* Observable truth: report raw probabilities, baseline statistics, exact mutation
  recipes, confirmations, model changes, logical/HTTP counters and token usage.

## Completion-audit corrections

The second PRD audit separated three bounded changes: confirmation/retry policy;
runner terminalization; and artifact/CLI presentation. The last two share one
invariant and ship together: once execution allocates a run ID, a provider error
or cancellation must expose an explicitly incomplete report after every worker
settles. It retains validated answers and exact counters, never a raw exception
or stack. Preflight configuration and budget failures make no paid calls.
Unfinished confirmations cannot become FAILs or replay artifacts. Complete
confirmed failures preceding a later interruption remain available as evidence.

The CLI applies raw and trimmed credential filtering before both output and
persistence. Hash-only storage also strips partial payloads. Both HTTP providers
support timeout and cooperative cancellation; custom providers must honor the
supplied signal, otherwise waiting for their settlement may delay persistence.
The operator can cancel long Retry-After waits. HTTP retries count actual fetch
attempts after the first attempt, including interrupted runs.

Fresh read-only risk treatment approved this decomposition before edits, with
counterexamples for partial baselines, partial confirmations, concurrent abort,
secret echoes, and the numeric two-of-three rule. The official API reference
allows structured instructions, nullable Choice descriptions, and 2–10 Score
levels; its concrete types take precedence over the PRD's `unknown` pseudotypes.

Verification uses the Node test runner offline, built CLI subprocess tests, injected
fetch at the network boundary, and separately invoked live smoke. Live is never
replaced by fake results. Each completed slice runs typecheck, tests, and build.
