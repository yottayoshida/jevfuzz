# v4 fresh benchmark protocol

The canonical v4 run is `node scripts/benchmark-v09-v4.ts`. It is offline-only and writes fresh evidence under `fixtures/benchmarks/raw-v09-v4/`; do not write into any historical `raw-v09-v3` directory. The frozen manifest is `fixtures/benchmarks/manifest-v4.json`: kind `jevfuzz-v09-benchmark-manifest-v4`, version 4, seeds 10000–10099, 12 families, five strategies, and per-trial budgets of 1,000 logical calls and 5,000 HTTP attempts.

The v4 simulator identifies the sole semantic route question as the one whose `instructions` is exactly `Route.`. A request with zero or multiple such questions is rejected as invalid. Rename means that question's actual id is not `route`; reordering means its semantic ordinal is not zero; metadata means that `benchmark_metadata` is an own property of `state`.

| Family | Activation rule |
| --- | --- |
| `order` | rename and (any Choice question has `general` first in its criteria, or metadata) |
| `metadata` | rename and metadata |
| `interaction2` | rename and semantic reorder |
| `interaction3` | rename and semantic reorder and metadata |
| `rareconfident` | rename and metadata and seed divisible by 11 |
| `policy-confidence` | rename and any Choice question has `general` first in its criteria |
| `policy-choice` | rename and semantic reorder |
| `noise`, `drift`, `choice-invariant`, `noul-invariant`, `score-invariant` | no simulator activation |

The historical `order` predicate intentionally accepts criteria ordering in an unrelated Choice question. “Unrelated criteria” is a negative control only for `interaction2` and `interaction3`; those families require their stated factors and ignore criteria ordering. Proper subsets are negative controls for `interaction3`.

The feedback decision remains pre-registered: it can change from experimental only if feedback is at least 25% faster in the median confirmed-call endpoint for at least three detectable families and its pooled detection rate is no more than five percentage points lower than uniform. Kaplan–Meier censoring and the existing bootstrap intervals remain part of the analysis. A full run must contain all 6,000 seed/family/strategy tuples; failures and censored trials remain in the rows and are not rerun. A complete non-diagnostic full run or merge is eligible to evaluate promotion. Quick runs and `--trials-only` shards are structurally forced to `not promoted`.

`fixtures/benchmarks/manifest-development.json` is diagnostic-only, fixed to seeds 0–9 and all five strategies. Its runner result is structurally forced to `not promoted`, so it cannot become canonical evidence. The wrapper is the recommended canonical entrypoint because it supplies the `JEVFUZZ_BENCHMARK_PROTOCOL=v4` marker; that marker is a routing convention, not an attestation boundary. A marked direct invocation uses the identical manifest, full-tuple, and source-freeze checks. The shared runner accepts only the historical v3 manifest, the canonical v4 manifest, or this diagnostic manifest, and rejects arbitrary manifests. Resume requires exact source-freeze equality. V4 freezes the shared runner, v4 entrypoint, v4 simulator helper, both v4 manifests, this protocol, analysis and supplemental helpers, all production TypeScript sources, and `package-lock.json`.

Each summary records the executed runner invocation in `command`; this records the process arguments and does not attest which parent process launched it.

Do not alter frozen sources after a canonical run begins. Once all source mutations are frozen, retain the full output and assess it once; do not retune after seeing held-out results.
