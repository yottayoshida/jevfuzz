# v0.2 migration

Node 22.18 or newer is required. Version-1 fixtures remain readable through
`jevfuzz plan`, `run`, and `replay`; existing exports are not removed. Version-2
campaigns add `fuzz`, `check`, `shrink`, `corpus`, `report`, and `compare`.

| v0.1 | v0.2 |
| --- | --- |
| case/mutation fixture | campaign seed plus concrete witness recipe |
| comparison result | fresh A/A′/B confirmation and Finding |
| raw artifact | `full`, `redacted`, or `hash-only` persistence |

To integrate existing JSON tools, retain their normalized Jev request as a seed.
For an existing intent-review JSONL export, use the established `jevfuzz import
trace.jsonl --out imported` command; it reads only the request and then collects
fresh evidence. For a router JSON tool, place its normalized `state`, `model`,
and `questions` request in a campaign seed, declare only owner-accepted
relations, and run `jevfuzz plan campaign.json` before `jevfuzz fuzz
campaign.json`. The supplied `fixtures/v2/routing.campaign.json` is a bounded
example.

Inputs are JSON only. Legacy configuration reads are limited to 1 MB; failure
artifacts and JSONL traces are limited to 8 MB. Parsed input is limited to depth
64 and 100,000 JSON nodes. `full` stores replayable private payloads; `redacted`
and `hash-only` deliberately cannot replay. Recovery consumes ambiguous
reservations and resumes only a hash-chained journal. Choice label maps are
stored **mutant label → original label**; question maps are **mutant ID → original
ID**. Policy is a pure declared projection and is included in target identity.

To compare a saved Finding, copy its candidate and contract into an experiment
case and set `source.provider` to the Finding provider. If the Finding has a
policy, copy it to `source.policy`. This binds the imported witness to its
original target hash before either experiment target constructs a provider;
target overrides describe only the old/new definitions.

`corpus add` stores confirmed evidence. Review it, then use `corpus triage
<directory> <id> --status accepted_regression --actor <name> --reason <reason>`
to make it a required regression. Quarantine requires an expiry and a concrete
reevaluation condition. Expired quarantines become required again.

`fuzz --require-confirmation-complete` returns exit 3 if required confirmation
is still pending. `check --profile paired-v1` explicitly selects the empirical
profile; selecting `fixed-stat-v1` requires an adapter with observable cache
freshness and enough reserved hypothesis slots. A provider override on a new
campaign changes its target fingerprint. Replay, resume, and compare reject
identity-changing provider overrides. `check` infers a homogeneous corpus's
provider; mixed-provider corpora and identity-changing overrides are rejected.
Use separate corpora or an explicit comparison experiment for different providers.

After a process crash, `jevfuzz recover-lock <storage-directory>` verifies the
dead local lock owner and journal chains before removing the stale lock.
`jevfuzz resume <checkpoint.json>` then creates one child under the same budget
lineage. Completed campaigns cannot resume. A closed mixed-model cohort starts
fresh observations in its child while preserving consumed costs and slots.

`storage.maxCorpusBytes` initializes `<storage.directory>/corpus/corpus.json`.
Corpus objects, indexes, journals, and check reports share that durable quota;
existing limits cannot silently change. A separately created corpus can set
its initial limit through `corpus add --max-corpus-bytes <bytes>`. Temporary
atomic replacements count toward peak storage. Prune is explicit and only
removes unreferenced objects.

Exit codes: 0 means no detected violation in the executed scope; 1 means a
confirmed violation; 2 means configuration/runtime/incomplete execution;
3 means inconclusive, unavailable confirmation, or an empty required scope.
No v1 exports or commands are deprecated in v0.2.0.

`shrink` reserves 96 screening calls and a separate `3 × pairs` final-confirmation
budget by default. `--shrink-requests <n>` changes only the screening budget.
The saved shrink result can be passed directly to `replay` or `corpus add`.
Budget-limited results retain a confirmed smaller finding when one was obtained;
an unconfirmed final pair never replaces the original confirmed artifact.

Declared `reducers.prosePaths` enable whitespace-only normalization (trim and
collapse whitespace), preserving every non-whitespace token. Free text cutting,
criteria deletion, and removal of negations or numbers are not built-in reducers.
The shrink complexity tuple is `(operators, moved positions, renamed IDs, pair
bytes, fields)`; witness support breaks same-size permutation ties before bytes.

Declared independent-question removal or question-text whitespace normalization
creates a child with a newly computed target hash and the original parent finding
ID. Provider, requested model, policy, protected questions, and the violation
signature are preserved; new final observations establish the child evidence.
