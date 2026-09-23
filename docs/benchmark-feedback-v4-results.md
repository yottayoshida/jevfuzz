# Feedback benchmark v4 results

The unchanged offline adoption criteria passed on 2026-09-23: four detectable
families reduced the Kaplan–Meier median cost of a confirmed finding by at
least 25%, and pooled detection increased by 4.43 percentage points. Uniform
remains the default. This result supports feedback search on this fixed
simulator benchmark; it does not establish efficiency on a live application.

## Full registered comparison

The [frozen protocol](benchmark-feedback-v4.md) used 12 families, five
strategies, and 100 previously unused seeds (10000–10099): 6,000 trials in
total. Each trial had the same 1,000 logical-call and 5,000 HTTP-attempt ceilings.
The endpoint includes fresh confirmation cost. Unsuccessful trials remain in
the censored analysis; none was dropped or rerun for a favorable result.

| Detectable family | Uniform median calls | Feedback median calls | Reduction | Uniform detection | Feedback detection |
| --- | ---: | ---: | ---: | ---: | ---: |
| order | 150 | 102 | 32.0% | 100% | 100% |
| metadata | 166 | 162 | 2.4% | 98% | 99% |
| interaction2 | 262 | 114 | 56.5% | 90% | 98% |
| interaction3 | Not reached | Not reached | Not estimable | 0% | 0% |
| rareconfident | Not reached | 406 | Not estimable | 9% | 9% |
| policy-confidence | 290 | 114 | 60.7% | 86% | 100% |
| policy-choice | 262 | 114 | 56.5% | 89% | 97% |

Across all seven detectable families, uniform found 472/700 and feedback
503/700: **67.43% → 71.86%**. All families, including zero-detection families,
contribute. The other five families are retained as hold/noise/drift controls.
The summary includes seed-unit bootstrap intervals and complete censoring
curves. The rareconfident feedback median has a right-censored upper interval;
its 9% detection rate must not be interpreted as reliable median performance.
Some families share activation predicates, including interaction2 and
policy-choice, so four qualifying families do not imply four independent bug
mechanisms. No live-provider performance claim follows from these simulators.

## Supplemental acceptance

All ten protocol checks passed, with zero trial runtime errors:

- Ten of ten known-minimum shrink cases passed.
- All 50 seeds were stable across concurrency 1, 4, and 8.
- In 1,000 independent simulated null campaigns, no false FAIL occurred. The
  one-sided 95% Clopper–Pearson upper bound was 0.002992 (about 0.30%).
- Each null campaign reserved five original and five shrink-final slots;
  676 campaigns reached adaptive fresh final confirmation. Reserved slots are
  not represented as executed confirmations.
- Unknown-cache, cached, uncertain-rate-limit, and model-drift controls all
  remained inconclusive. This is simulator verification, not real-API FWER.

## Reproduction and provenance

The repository retains all raw data and the full summary in
`fixtures/benchmarks/raw-v09-v4/`. These large evidence files are intentionally
excluded from the npm package. Their frozen measurement source identity is:

```text
34bc13026727b85afd1803a79d637e6f082302e402fe9736167bf02cbcca5cc2
```

The four measurement commands were the following, once each for `N=0,1,2,3`:

```sh
node scripts/benchmark-v09-v4.ts --trials-only --shard-count 4 --shard-index N --out /private/tmp/jevfuzz-v4-heldout-shard-N
```

All exited 0 with 1,500 trials. The final command exited 0 with
`complete-local-protocol`, all acceptance values true, and `promoted`:

```sh
node scripts/benchmark-v09-v4.ts --merge-shards /private/tmp/jevfuzz-v4-heldout-shard-0,/private/tmp/jevfuzz-v4-heldout-shard-1,/private/tmp/jevfuzz-v4-heldout-shard-2,/private/tmp/jevfuzz-v4-heldout-shard-3 --out fixtures/benchmarks/raw-v09-v4
```

`measurement-sources.frozen.tar.gz` preserves all 44 hashed measurement source
files plus package metadata. Every archived source was checked against
`sources.frozen.json` before any post-measurement edits. Public archive SHA-256:

```text
15899bdc0357fa66c4886f0d205ac0ce6022df0c73e2c2c92db6d3f0726f5842
```

Immediately after measurement, only the campaign feedback warning was updated
to reflect this result. Later local corrections to comparison target mapping,
corpus confirmation configuration, and shrink policy dependencies are outside
the measured source revision. The scheduler, simulator, and analysis were not
retuned. Extract the archived sources into a separate directory when reproducing
the exact measurement. The current checkout has a different source hash and
must not replace the raw data's source identity. Historical v3 evidence and its
unsuccessful promotion decision remain unchanged.

The development run used seeds 0–9 and a prior source revision. Its 600 trials
were diagnostic only and structurally unable to promote feedback. It did not
consume the held-out seed range. The v4 protocol and final source were frozen
before the held-out run began; no tuning followed its results.
`development-evidence.frozen.tar.gz` retains those diagnostic outputs,
including the superseded shard from a different source revision; that shard
was excluded from the development merge rather than relabeled.

The public containers are sanitized derivatives. Archive owner names, IDs,
timestamps and gzip filename metadata were normalized. Only `command` and
`raw.directory` in the main and merged development summaries were replaced
with portable templates; each summary records this transformation explicitly.
The 6,000 trial bytes, frozen source identity, all 44 source hashes, and every
statistical result remain unchanged. No benchmark was rerun or retuned.

The public development archive SHA-256 is
`0f769f37ba403d23bac8c7437798dd81e3d7562b7d860805a3e3163be8374f62`.
The private original container digests were
`bf06c0d6427123264b6d28f5b5914843bc01f2880ef7ed152b82dd9c59394942`
(measurement) and
`563bf583544ae3592195b495fe93b2ee959b37cb2b8b6a6e40cfd83859278890`
(development). The deterministic transformation is implemented in
[`sanitize-benchmark-publication.py`](../scripts/sanitize-benchmark-publication.py).
