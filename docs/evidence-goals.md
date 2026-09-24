# Post-v0.2 evidence goals

Status: the first goal meets its registered offline benchmark criteria; the
second and third goals remain unmet. Work starts from released commit
`a92a4e41b1cc2cf0c3fae7d12f622f0a91f6b21a` on local branch
`codex/evidence-goals`. This is not a new release record.

## 1. Feedback search superiority

The original 3-family / 25% median improvement / at-most-5-percentage-point
detection-rate loss criteria remain unchanged. Uniform remains the default.

Two implementation defects were corrected before new measurement:

- Equal feature values previously received different ranks by candidate ID.
  Tied novelty/divergence dimensions could outweigh informative boundary
  feedback. Ranking now gives equal values equal normalized rank and makes an
  all-equal feature contribute zero.
- Confirmation previously sorted a selected batch by ID, losing scheduler
  priority when only part of the batch could be confirmed. Confirmation now
  follows the selected batch order; feedback commits remain ID-sorted.

The scheduler is versioned `batch-v2`. Historical `batch-v1` reports remain
readable, while old checkpoints cannot silently resume with new scheduling
semantics. They must be resumed with the matching released implementation or
started as a new campaign with a new budget lineage.

The historical simulator also confused renamed question IDs with semantic
question reordering. Corrected interaction predicates and a fresh held-out
schedule are described in [the v4 protocol](benchmark-feedback-v4.md). Existing
v3 measurements remain historical and are not rebound to the new source.

The [completed v4 measurement](benchmark-feedback-v4-results.md) contains all
6,000 held-out trials and passes all ten protocol checks. Four families exceed
the 25% median improvement threshold (32.0%, 56.5%, 60.7%, 56.5%); pooled
detection rises from 472/700 to 503/700, or 67.43% to 71.86%. Raw data,
supplemental suites, development diagnostics, and the exact measurement
sources are retained under `fixtures/benchmarks/raw-v09-v4/`. An independent
local reviewer reproduced the tuple/source checks and raw-data medians.

The product warning now states this scoped evidence instead of saying the
benchmark criterion is unmet. Uniform remains the default. At initial
completion, the only production change after measurement was that warning
text. Later comparison, corpus, and shrinking corrections are separate from
the archived measurement revision; no benchmark results were relabeled or
retuned. The result does not establish live application efficiency, and
interaction3 remained undetected by both strategies.

A bounded live comparison on 2026-09-24 used the already published synthetic
request in `docs/assets/readme-finding.json` (`finding.candidate.basePayload`).
Two independent Cloudflare campaigns differed in campaign name,
`search.strategy`, and private output directory; offline planning confirmed
identical 32-candidate ID sets. Both used seed 42, depth 2, 32 candidate
slots, batches of eight, concurrency one, `paired-v1` with eight blocks, and
identical ceilings of 52 logical requests, 52 HTTP attempts, 28 discovery
requests, and 24 confirmation requests. The two declared invariant Choice
contracts covered `relevance` and `satisfaction` under object-key order,
question order, Choice-criteria order, and question-ID rename. Both observed
`jev-1.13.0`, used 52 logical/HTTP calls with no client retries, and confirmed
the same object-key-order violation fingerprint
`f9b7f42d73242c3f8607c95675c3ef0db01d8ba4ba25435716248816fb5d556e`
at call 40 (eight supporting paired blocks, zero control violations).
Each run ended at its budget with one additional relation pending; exit 1
reports the confirmed finding, not complete coverage. Uniform and feedback
therefore **tied on this one known synthetic target**. The result neither
weakens the frozen offline benchmark nor establishes general live efficiency.

The raw configs, reports, and journals remain private under
`/private/tmp/jevfuzz-live-compare-20260924/`; they contain no credentials but
retain full request and response payloads. Raw config SHA-256 digests were
`751c100b4158890f020c32e0a5e04cebca75f8364b0ca6c900cd283cd105ba0e`
(uniform) and
`2f3f8296578ce6ded3591e6e277dd66ab13f5b58795c0d9cc54b5ac5c932b9aa`
(feedback). The corresponding report digests were
`a5ef80e48d1368879c5f503f2c8cbd36fc734ffd9359110652c26023220bd512`
and `eaf391b1b54394eef6ac977bc7743871ea3a368fa61a3239518d9316382e3283`.
Both campaigns used branch head `8d77eb5`; this is local-only live evidence.

## 2. Live provider statistical evidence

Cloudflare-specific requests now carry the documented gateway skip-cache
header. A recognized gateway HIT is recorded as cached; a MISS or unavailable
classification remains origin-cache unknown. Both HTTP adapters still refuse
`fixed-stat-v1`.

An additional six-call public-synthetic Cloudflare probe completed on
2026-09-23: six logical requests, six client HTTP attempts, zero retries, model
`jev-1.13.0`, and six unknown cache classifications. This is successful bounded
adapter execution, not an independence guarantee. See
[provider conformance](provider-conformance.md#cache-evidence-boundary).

The owner clarified that no TypeSafe-direct key exists and requested support
assuming users supply `TYPESAFE_API_KEY`, with Cloudflare also available.
Both CLI adapter paths are implemented. TypeSafe is verified with mocked HTTP
and an installed-CLI test key; direct live validation is deferred and is no
longer an implementation blocker or a pending credential request. Cloudflare
uses its own credentials and remains the live verification path.
After this clarification, the built Cloudflare `doctor` succeeded without
network calls. A fresh public-synthetic live smoke then passed six comparisons
using six logical/HTTP calls with no retries and observed `jev-1.13.0`. The
initial restricted-environment DNS failure is retained separately in the
[provider record](provider-conformance.md#dual-provider-readiness-verification--2026-09-23).
The public provider specifications inspected do not establish the remaining
origin execution assumptions. A reviewable list of necessary provider answers
and verification steps is in [statistical evidence](provider-statistics-evidence.md).
No provider inquiry has been sent.
The owner subsequently chose to continue implementation and verification
without an inquiry. That draft is inactive; no provider contact is planned.
Ordinary empirical workflows remain available. This decision does not convert
unknown freshness or sampling assumptions into statistical evidence.

## 3. Real-workload usefulness

Candidate integration points were identified in jev-intent-review and
jev-sscope. Neither prior synthetic dogfood nor the Cloudflare probe counts as
a real external-user pilot. A third real workload and two users other than the
author remain unverified. The owner is not required to choose participants;
JevFuzz has a self-service GitHub Action, and actual independent use must be
observed before it can count.

The [field protocol](field-validation.md) records the required owner-approved
relations, participant observation, real application changes, fresh regression
results, healthy controls, and private artifact provenance. Current accepted
counts are zero external participants, zero completed workload pilots, and
zero completed real fix loops. Blank templates do not increase those counts.

## Verification before owner clarification

- Baseline `npm test`: 172 passed, zero failed/skipped.
- Scheduler focused suite: 16 passed, zero failed/skipped. The original
  implementation failed the rank-neutrality assertion in a disposable copy;
  the corrected implementation passes it.
- Provider suite: 19 passed, zero failed/skipped. Broker and corpus suites:
  18 passed, zero failed/skipped. New provider assertions failed before the
  header/metadata correction and passed after it.
- `npm run typecheck`: exit 0.
- `npm test` on Node 26.7.0: exit 0; 185 passed, zero failed/skipped.
- `npm exec --offline --package=node@22.18.0 -- node --test test/*.test.ts`:
  exit 0; 185 passed, zero failed/skipped.
- The four held-out shard commands and final merge command in the v4 results:
  all exit 0; 6,000 measurement trials, 1,000 null campaigns, ten shrink cases,
  50 concurrency seeds. All acceptance checks pass.
- `node scripts/verify-package.ts`: exit 0; build, pack, offline installation,
  13 installed CLI operations, 44 stub HTTP calls, zero runtime dependencies.
  This is a local unreleased package with the existing version number, not the
  published v0.2.0 release asset.
- `git diff --check`: exit 0. Package content and new local document links are
  checked separately. No new GitHub CI run or release is claimed.

Planner/risk roles were requested and configured as Sol/high/read-only,
implementation as Terra/medium, and review as Terra/high/read-only. Reviews are
local evidence. Independent runtime routing attestation is unavailable; no
GitHub review, CI run, or quality receipt is claimed for this local work.

The pre-clarification classifier returned high-risk for state recovery, resource limits,
verification integrity, and change size (38 files including raw evidence).
The existing A1 scheduler, A2 benchmark, B provider, and C field-preparation
boundaries were reviewed separately. That receipt attempt was:

```sh
python3 ~/.codex/hooks/quality_guard.py receipt --repo . --evidence '{"command":"npm test","exit_code":0,"executed":185,"skipped":0,"scope":"local"}' --evidence '{"command":"npm exec --offline --package=node@22.18.0 -- node --test test/*.test.ts","exit_code":0,"executed":185,"skipped":0,"scope":"local"}' --residual-risk 'Live TypeSafe credentials and provider origin sampling guarantees remain unavailable; no completed external-user pilots. Independent per-agent runtime routing attestation is unavailable. All reviews are local only.'
```

It returned `QUALITY_INTERNAL_ERROR`, exit 2. No receipt was produced; the
executed test, benchmark, package, and review evidence above remains valid
within its stated scope. That local package verification output is
`/private/tmp/jevfuzz-evidence-package-final.json`, with tarball SHA-256
`e49ea864c9d679b8e9cce659dd242d113bdb6073947396297b7921934352faea`.

## Provider readiness after owner clarification

This follow-up changes setup/evidence documentation and
`scripts/verify-package.ts`; no production source changes were needed. The
verifier now exercises TypeSafe and Cloudflare using only the selected
provider's synthetic credentials, installed fixtures and the installed `.bin`.
It also rejects wrong-provider-only credentials before dispatch. Live TypeSafe
access is not a requirement for this local readiness check.

- `node --test test/provider.test.ts test/cli.test.ts test/cli-v2.test.ts test/broker-v2.test.ts test/shrink-v2.test.ts test/corpus-v2.test.ts test/experiments-v2.test.ts`:
  exit 0, 87 passed, zero failed/skipped.
- `npm run typecheck`: exit 0.
- `node scripts/verify-package.ts`: exit 0, 13 normal CLI operations per
  provider plus two negative configuration checks; TypeSafe 44 and Cloudflare
  44 intercepted calls. All HTTP is stubbed.
- `npm exec --offline --package=node@22.18.0 -- node scripts/verify-package.ts`:
  exit 0 with the same operation and call counts on the minimum supported Node.
- The selected-provider negative check was deliberately falsified in a
  disposable copy by forcing TypeSafe selection. The verifier exited 1 at the
  Cloudflare doctor assertion; the real implementation passed.
- Built `doctor --provider cloudflare --json`: exit 0, zero network calls.
- `JEVFUZZ_LIVE_PROVIDER=cloudflare node --env-file=<private-env> scripts/live-smoke.ts`:
  exit 0, six comparisons passed, six logical/HTTP calls, no retries,
  `jev-1.13.0`. The earlier DNS failure is recorded in provider conformance.

The latest dual-provider outputs are
`/private/tmp/jevfuzz-dual-provider-matrix.json` and
`/private/tmp/jevfuzz-dual-provider-matrix-node22.json`. Each identifies its exact
temporary tarball; the verifier removes its temp install and tarball after
execution and does not overwrite the pre-existing root package artifact.

The local review caught a legacy replay output escaping the temporary tree
because CLI children used the source checkout as their working directory.
Children now run inside each provider's work directory, and the credential
scan covers that complete tree, including default replay artifacts and corpus
files. Corrected verification passed on Node 26.7.0 and 22.18.0; the source
checkout's existing 298 artifact paths were unchanged. A bounded correction
review reported no remaining findings. This is local review evidence, not a
GitHub review or current-head CI result.

The follow-up receipt attempt used `quality_guard.py receipt --repo .` with
both package-verification commands above as local evidence (28 invocations
each, zero skips), and explicitly recorded the deferred direct-live and
unresolved sampling/field evidence. It again returned `QUALITY_INTERNAL_ERROR`
(exit 2); no quality receipt or independent runtime-role attestation is claimed.

The remaining evidence is a documented provider execution/sampling contract
supporting the requested statistical assumptions, and identified real
workloads and participants. Existing Cloudflare access has already been used
successfully. TypeSafe-direct live access is deferred by the owner and no
longer requested as a prerequisite. No external contact, push, merge, or
release is performed by this work.

## Local regression corrections after the no-inquiry decision

The owner explicitly excluded provider correspondence and asked to continue
implementation and verification. A bounded audit found local defects in the
existing PRD workflow; these corrections do not count as external-user trials
or as live statistical evidence.

- Comparison target policies were validated against the saved source questions.
  Target preparation now validates them against the effective target questions.
  Explicit source-to-target question and Choice-label mappings are separate
  from the existing within-pair maps, and the original source evidence remains
  unchanged. Target relation checks use the translated contract.
- A corpus check could inherit its confirmation configuration from an excluded
  entry. Required fixtures now determine provider and default oracle; mixed
  full configurations require an explicit override. The documented `--profile`
  option selects a complete preset. A locked preparation check rejects a
  changed selection/configuration before dispatch, and new reports retain the
  effective oracle while historical reports remain readable.
- The shrinker protected policy predicates but omitted dependencies in action
  and fallback templates. It now preserves all referenced questions while
  still removing unrelated declared-independent questions.
- The public experiment input schema omitted `source`, although the parser and
  shared artifact schema already accepted it. The public schema and mapping
  fields now agree with the parser.

These changes are separate from the frozen v4 measurement. At this verification
point both archives retained their original SHA-256 values. The publication
sanitation described below subsequently changed container metadata; the
benchmark was not rerun, relabeled, or tuned in response to these fixes.

The read-only statistics audit found no justified change to HTTP statistical
eligibility. `node --test test/statistics-v2.test.ts test/oracles-v2.test.ts test/provider.test.ts`
on Node 26.7.0 passed 26/26 (exit 0, zero failures or skips), and the existing
independent-null, correlation, cache, drift, and scheduling simulations already
cover the PRD's local statistical evaluation. None establishes the missing live
provider assumptions. Field acceptance remains 0/2 non-author participants,
0/3 completed real-workload pilots, and 0/2 real application fix loops.

### Final local verification for these corrections — 2026-09-23

All results below apply to the uncommitted `codex/evidence-goals` worktree on
base `a92a4e41b1cc2cf0c3fae7d12f622f0a91f6b21a`. They do not describe a new
GitHub CI run, published package, release, or live API experiment.

| Exact command | Observed result |
| --- | --- |
| `node --test test/experiments-v2.test.ts test/schema-v2.test.ts` | 30 passed, zero failed/skipped, exit 0 |
| `node --test test/corpus-v2.test.ts test/cli-v2.test.ts` | 27 passed, zero failed/skipped, exit 0 |
| `node --test test/shrink-v2.test.ts` | 20 passed, zero failed/skipped, exit 0 |
| `npm run typecheck` | exit 0 |
| `npm test` | Node 26.7.0: 208 passed, zero failed/skipped, exit 0 |
| `npm exec --offline --package=node@22.18.0 -- node --test test/*.test.ts` | 208 passed, zero failed/skipped, exit 0 |
| `npm run build` | exit 0 |
| `node scripts/verify-package.ts` | 28 installed CLI invocations, 88 intercepted HTTP calls, zero production dependencies; exit 0 |
| `npm exec --offline --package=node@22.18.0 -- node scripts/verify-package.ts` | same invocation/call counts; exit 0 |
| `node scripts/generate-report-validator.ts` | generated file SHA-256 unchanged; exit 0 |
| `git diff --check` | exit 0 |

Each package run executes 13 ordinary commands and one wrong-provider
credential rejection per provider. All HTTP is intercepted; both TypeSafe and
Cloudflare make 44 calls each. Current outputs are retained locally at
`/private/tmp/jevfuzz-no-inquiry-package-current.json` and
`/private/tmp/jevfuzz-no-inquiry-package-node22.json`. Their temporary tarballs
have SHA-256 `804043c2ff2aafe3fb07aa1fe685d381855735311d6caa1adc75ac6b4467cc2e`
and `fd2778c9c117bda25431c9e515eb74f450976981209aba491ac4285b9fb06292`,
respectively. Both temporary installations were removed after verification.
Full source output is in `/private/tmp/jevfuzz-no-inquiry-test-current.log`
and `/private/tmp/jevfuzz-no-inquiry-test-node22.log`.

Meaningful falsification also passed: disposable copies failed the new
Noul/Score criteria-path assertions when treated as Choice labels (two
failures), the target-prose assertion when source text was copied (one), the
ambiguity assertion with its guard removed (one), and invalid-label-map
rejection with source-label validation bypassed (one). Restored code passed.
The policy-template reduction reproduced the original missing-dependency
failure before its fix. Corpus mixed-oracle rejection failed when its full
configuration equality guard was removed, then passed after restoration.

The compare, corpus, and shrink boundaries received separate local independent
reviews with no remaining findings after corrections. Compare review fixed a
negative test that had failed too early on the question map to test label-map
validation. Corpus review fixed a test callback typing error. A documentation
review prompted an exact focused-test command and an explicit historical
release reference. The suggestion that v0.2.0 was not published was rejected
after read-only `gh release view v0.2.0 --repo yottayoshida/jevfuzz --json tagName,publishedAt,targetCommitish,url,assets`
confirmed its published asset; that release is distinct from this worktree.

Reviewer role selection/configuration is Terra/high/read-only/never; risk-role
selection/configuration is Sol/high/read-only/never. Independent runtime-model
attestation is unavailable. These are local reviews, not GitHub review
permalinks. The strict review-package helper requires committed revisions and
observed routing metadata that this uncommitted worktree does not provide;
reviewers instead received bounded changed-path, dependency, search, invariant,
and execution-evidence envelopes. No strict machine review receipt is claimed.

No provider inquiry or new live call was made in this correction pass. Direct
TypeSafe live validation remains deferred, both HTTP adapters still refuse
unsupported fixed-stat claims, and real field acceptance remains unfulfilled.

The final integrated classifier again returned high-risk for state recovery,
verification integrity, and change size. Its boundaries were reviewed
separately. A final `quality_guard.py receipt --repo .` attempt supplied the two
208-test commands and both 28-invocation package commands above, all with exit
0 and zero skips, plus the unresolved live/field/routing limitations. The tool
returned `QUALITY_INTERNAL_ERROR` (exit 2), so no quality receipt was produced.
This tooling failure is separate from the successful executed verification.

### Real-input preliminary check after the completion-report correction

The goal remains unmet. Current public repository issues, pull requests, and
comments contained no non-author pilot record: six issues and one pull request,
all author-created, with no issue comments. This is a bounded repository check,
not a claim that nobody has used JevFuzz elsewhere. Participants and workload
owners were requested from the owner; no contact was made.

An unmodified `jev-intent-review` production request builder was invoked with
a verbatim clause from public issue #6 and the actual released `src/version.ts`
diff. Request-only capture made zero network calls and fabricated no response.
The full app CLI was not used: its issue parser does not recognize the issue's
`Expected behavior` heading. The direct review API and selected requirement
provenance are explicit in the private record.

The compiled `jevfuzz plan` exited 0 with zero API calls. The compiled `fuzz
campaign.json --require-confirmation-complete --json`, using the existing
Cloudflare env file, exited 0 with eight evaluated candidates, 16 logical/HTTP
calls, no retries, no pending candidates, and observed model `jev-1.13.0`.
Both the label and the actual application's 0.7 reporting policy remained
unchanged in this bounded exploration. No counterexample was found; no fresh
confirmation or fix loop is claimed. Thirteen retained artifact files passed
the credential scan, and the report passed the production report validator.

Private record directory:
`~/.local/share/jevfuzz/evidence/issue6-20260923-e69f5e34/`.
Request SHA-256: `dfe0893e9fb6220290093a5b0d95e58b5c3fdc0c79250d7acb226819a8bc753c`.
Report SHA-256: `db59276abdae35665cbce2475cd86a73e5b19191aaec109ad05eb0302b991183`.
It remains one preliminary real input, not an external-user pilot.

A separate read-only check of the official TypeSafe API, model docs, SDK request
IDs, and Cloudflare cache/retry/logging docs found no published origin-inference
identity, response-reuse/coalescing contract, or supported independence and
stationarity guarantee. Gateway skip-cache and retry controls do not establish
those properties. The live-statistical gate remains closed.

### README evidence and a second workload preparation

The README now shows the retained Cloudflare object-key-order finding, with
source data, corpus lineage, and a deterministic SVG generator linked from
[the demo record](readme-demo.md). It displays the observed
`unrelated → may_violate` result, 3 → 2 moved key positions, and 24 new final
confirmation calls. This public synthetic example is not a new field pilot.

Local verification of this slice on 2026-09-23:

- `node --check scripts/render-readme-demo.mjs` and
  `node scripts/render-readme-demo.mjs --check`: exit 0; current SVG 6,438 bytes.
- `xmllint --noout docs/assets/readme-demo.svg`, `npm run typecheck`, and
  `git diff --check`: exit 0. All 14 local links in the README and demo record
  resolve. Browser inspection confirmed the base, original mutation, and static
  reduced views; the two changed orders both show `may_violate`.
- `python3 /private/tmp/jevfuzz-readme-falsify.py`: exit 0, eight checks, no
  skips. Six disposable corruptions are rejected: stale SVG, source hash,
  original control label, reduced model, fewer blocks than the prose claims,
  and wrong corpus child. Unmodified and restored evidence pass.
- `python3 /private/tmp/jevfuzz-verify-readme-package.py`: exit 0. An offline
  installed package contains 103 files, including all six README source/demo
  files, and runs the generator from an unrelated working directory on Node
  26.7.0 and 22.18.0. The temporary tarball SHA-256 is
  `019ed82d43fa8fcc60509c1ca5fb32834d452e6e60f801b225823073b4e8816c`.
  It is an unreleased local package with the existing version number.

The initial installed TypeScript generator failed because Node rejects type
stripping inside `node_modules`; the distributed generator is now plain ESM.
Local risk and independent reviewer passes found no remaining bounded finding
after correcting that failure, a staged animation label, documentation about
published demo data, and evidence/prose consistency guards. These are local
reviews, not GitHub review permalinks or CI claims.

The subsequent goal work prepared 20 real legacy `jev-sscope` session states,
ten from each of two existing private recordings. Their question definitions
come from application commit `ec0164724c3e003ae55ffecd03854af783799e47`.
The generated requests reconstruct the historical four-question input; they
are neither byte-identical historical HTTP messages nor requests from the
current two-question application. No application code or source recording was
changed. The private preparation script and provenance are retained under
`~/.local/share/jevfuzz/evidence/sscope-legacy-preparation-69irqyr6/`.

The built `jevfuzz plan <private-campaign> --json` exited 0: 20 cases, four
proposed contracts, 82 candidates, 40 invalid candidates filtered, no no-ops,
and zero network calls. The campaign has a zero HTTP-attempt ceiling until its
owner reviews the private data and proposed relations. No API result, pilot,
participant assessment, or fix loop is claimed from this preparation. The
campaign SHA-256 is
`a9807cc1dda0a7cdd3b00a07e9a939b22047a7dc31ae6166a6969aebb9d7d389`.

The owner authorized PR delivery and merge after completion. The remaining
PRD field condition is actual external-user/workload/fix-loop evidence. Direct
TypeSafe live verification is explicitly deferred; it is not a prerequisite.
Without independent live sampling evidence, `fixed-stat-v1` stays disabled for
HTTP adapters, and no live statistical guarantee is claimed. Passing code
checks or finishing the README does not satisfy field acceptance. No provider
inquiry or participant contact is authorized or planned.

The integrated diff classifier still reports state recovery, verification
integrity, and change size as high-risk; the existing source/benchmark,
comparison, corpus, shrink, and README boundaries were reviewed separately.
A fresh README verification receipt attempt again returned
`QUALITY_INTERNAL_ERROR` (exit 2), so no machine quality receipt is claimed.
The 57 changed/new files and both frozen source archives were scanned against
the active local provider credential values with zero matches.

### Product delivery and publication scope — 2026-09-23

The owner clarified that product completion takes priority over external
participant/workload validation. No recruitment, provider inquiry, or new
private workload submission is required for this delivery. Those research
observations remain unverified; they are not installation prerequisites.
The product delivery adds a reusable GitHub Action, a complete consumer
workflow and campaign, bounded private execution, and preserved failure
reports. Each consumer configures these in their own repository.

Publication removes workstation paths from the main and merged development
summary metadata and normalizes tar/gzip headers. All 6,000 trial records and
44 frozen source payload hashes remain unchanged. The sanitizer verifies the
exact allowlist and explicitly marks summaries as derivatives, not new runs.
Public archive SHA-256 values are
`15899bdc0357fa66c4886f0d205ac0ce6022df0c73e2c2c92db6d3f0726f5842`
(measurement) and
`0f769f37ba403d23bac8c7437798dd81e3d7562b7d860805a3e3163be8374f62`
(development). Original container digests and reproduction scope are recorded
in [the benchmark report](benchmark-feedback-v4-results.md#reproduction-and-provenance).

Local product verification: `npm run typecheck`, `npm run build`, and
`npm test` passed; all 222 tests ran with zero failures or skips. The 14 Action
tests invoke the built CLI, test both provider adapters with intercepted HTTP,
preserve exits 0/1/2/3 and failure outputs, and confirm the committed regression
corpus is unchanged. An intentional exit-1-to-0 mutation failed the integration
test in a disposable copy. A frozen-descriptor mutation failed the publication
verifier; optimized Python is explicitly refused.

The actual Action dependency-install/build entrypoint also passed with an
isolated npm environment. `node scripts/verify-package.ts` passed through the
installed executable for both adapters (88 intercepted HTTP requests in total,
zero runtime package dependencies). These are local/offline checks; GitHub CI
execution and merge are recorded on the delivered PR rather than implied by
this workflow definition. The read-only local Action and sanitation reviews
reported no remaining findings after corrections.
