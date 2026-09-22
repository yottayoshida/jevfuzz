# JevFuzz v0.1 PRD

Status: Ready for implementation
Target: standalone OSS CLI / library
Primary dogfood: `jev-intent-review`
Language: TypeScript / Node.js 22+ / ESM
CLI: `jevfuzz`

## 0. Product statement

JevFuzz is a metamorphic testing framework for Jev decision functions.

It does not test whether application code satisfies a requirement. It tests whether a Jev judgment remains stable under transformations that should not change the meaning of the judgment.

Core loop:

```text
Jev request
(state + typed questions)
        │
        ├── baseline × N
        │
        ├── meaning-preserving mutation
        │
        ├── Jev evaluation
        │
        └── compare
              │
              ├── PASS
              ├── WARN
              ├── INCONCLUSIVE
              └── FAIL → reproducible counterexample
```

Example failure:

```text
FAIL choice_changed

case: propagate_failure
question: requirement_relation
mutation: choice_criteria_order

baseline:
  worth_checking  p=0.91

mutated:
  not_required    p=0.84

confirmation:
  baseline 3/3 = worth_checking
  mutated  3/3 = not_required

This transformation changes ordering only.
No semantic content was changed.
```

The product promise is:

> Give JevFuzz a real Jev decision request. It will systematically perturb semantically irrelevant structure, rerun Jev, and show concrete cases where the decision is not invariant.

JevFuzz does **not** claim that the baseline answer is correct. It only tests stability under declared invariants.

---

# 1. Problem

Typed output solves schema validity, not semantic robustness.

A Jev call may return a valid Choice, Score, or Noul with high confidence while still being sensitive to irrelevant representation changes such as:

```text
- question ID
- ordering of independent questions
- ordering of Choice criteria
- ordering of JSON object keys
- ordering of user-declared unordered collections
- user-declared irrelevant metadata
```

Existing tests normally test:

```text
input A → expected answer X
```

JevFuzz additionally tests:

```text
input A ≡ transformed input A'

therefore

decision(A) ≈ decision(A')
```

The second property is especially useful for probabilistic decision systems because it can discover unstable decision boundaries without requiring a human-labelled answer for every case.

---

# 2. Goals

v0.1 must:

1. Accept a real TypeSafe/Jev request as a test case.
2. Execute repeated baseline calls.
3. Detect baseline instability before blaming a mutation.
4. Generate deterministic meaning-preserving mutations.
5. Support Choice, Noul and Score.
6. Compare original and mutated probability distributions.
7. Confirm suspected failures through reruns.
8. Produce a machine-readable JSON report.
9. Produce a human-readable CLI report.
10. Persist enough information to reproduce every failure.
11. Enforce request/cost limits.
12. Work against the real Jev API using `TYPESAFE_API_KEY`.
13. Be usable without `jev-intent-review`.
14. Be dogfoodable using requests exported from `jev-intent-review`.

---

# 3. Non-goals for v0.1

Do NOT implement:

```text
LLM-generated paraphrases
automatic semantic-equivalence judgment
automatic bug fixing
automatic Jev prompt optimisation
GUI/dashboard
GitHub App
PR comments
multi-provider support beyond the provider interface
distributed fuzzing
coverage-guided mutation
genetic search
arbitrary source-code mutation
automatic claim that a Jev answer is factually correct
```

Most importantly:

**No LLM is allowed to generate mutations in v0.1.**

All built-in mutations must either be structurally semantics-preserving or require the user to explicitly declare the affected structure semantically irrelevant/unordered.

This is necessary so a FAIL means something.

---

# 4. Current Jev API assumptions

As of 2026-09-22, implementation should target the official TypeSafe System One API.

Default host:

```text
api.typesafe.ai
```

Endpoint path:

```text
/v1/systemone
```

Authentication:

```text
Authorization: Bearer $TYPESAFE_API_KEY
```

Request:

```ts
type JevRequest = {
  state: string | unknown[] | Record<string, unknown>;
  model: string;
  questions: Record<string, JevQuestion>;
};
```

Supported questions:

```ts
type NoulQuestion = {
  type: "noul";
  instructions: unknown;
  criteria?: {
    true?: unknown;
    false?: unknown;
  };
};

type ChoiceQuestion = {
  type: "choice";
  instructions: unknown;
  criteria: Record<string, unknown>;
};

type ScoreQuestion = {
  type: "score";
  instructions: unknown;
  criteria: unknown[];
};
```

Choice may contain at most 255 options. Score supports up to 10 ordered levels. Questions sharing the same state should remain in one API call because Jev evaluates them independently and in parallel.

The provider must record the actual `model` returned by the API, not only the requested alias.

If the observed model changes during a fuzz run, the run becomes `INCONCLUSIVE_MODEL_CHANGED` and must not report metamorphic FAILs across the version boundary.

HTTP 429 and 529 must use exponential backoff with jitter.

---

# 5. Product interface

The minimum useful CLI:

```bash
jevfuzz doctor
jevfuzz plan case.json
jevfuzz run case.json
jevfuzz run cases/*.json
jevfuzz replay .jevfuzz/runs/<run-id>/failures/<id>.json
```

Optional flags:

```bash
--seed <integer>
--baseline-runs <integer>
--confirm-runs <integer>
--concurrency <integer>
--max-requests <integer>
--artifacts-dir <path>
--json
--quiet
--no-save-payloads
```

Defaults:

```text
baseline-runs = 3
confirm-runs = 2
concurrency = 4
max-requests = 100
artifacts-dir = .jevfuzz
seed = generated once and printed/persisted
```

`plan` MUST make zero API calls.

Example:

```bash
jevfuzz plan fixtures/intent-review.json
```

Output:

```text
JevFuzz plan

cases                  4
questions              11
baseline requests      12
generated mutations    27
max confirmation       54
worst-case requests    93
configured limit       100

mutation classes:
  question_id_rename       4
  question_order           4
  choice_criteria_order    7
  object_key_order         8
  unordered_array          4
```

This is a mandatory cost-safety feature.

---

# 6. Exit codes

```text
0  run completed, no FAIL
1  one or more confirmed metamorphic FAILs
2  configuration / CLI / authentication / unrecoverable runtime error
3  run completed but no reliable verdict could be produced
```

WARN does not produce exit 1.

`INCONCLUSIVE` alone produces exit 3 if no test produced a reliable PASS or FAIL.

---

# 7. Test case format

Canonical file extension:

```text
.jevfuzz.json
```

Schema version:

```json
{
  "version": 1
}
```

Example:

```json
{
  "version": 1,
  "name": "intent-review-propagation",
  "model": "jev-latest",

  "baseline": {
    "runs": 3
  },

  "cases": [
    {
      "id": "unchanged-caller-001",

      "request": {
        "state": {
          "requirement": "If loading an existing configuration fails, return an error to the caller.",
          "call": {
            "caller": "open_config",
            "callee": "load_config",
            "behavior": "the returned error is converted into success"
          }
        },

        "questions": {
          "requirement_relation": {
            "type": "choice",
            "instructions": "How does this call relate to the requirement?",
            "criteria": {
              "worth_checking": "The call may violate the requirement.",
              "not_required": "The requirement does not apply to this call.",
              "settled": "The evidence already establishes compliance."
            }
          }
        }
      },

      "mutations": {
        "builtin": true,

        "unorderedArrays": [],

        "irrelevantFields": [
          {
            "path": "$.state",
            "field": "_test_metadata",
            "values": [
              {"trace": "a"},
              {"trace": "b"}
            ]
          }
        ]
      },

      "invariants": {
        "requirement_relation": {
          "type": "choice_stable"
        }
      }
    }
  ]
}
```

The config parser must reject unknown schema versions.

Use JSON for v0.1. YAML support is not necessary.

---

# 8. Input convenience format

JevFuzz must also accept one canonical raw-request fixture:

```json
{
  "state": {},
  "model": "jev-latest",
  "questions": {}
}
```

When no JevFuzz wrapper is present:

```text
- case ID = filename
- builtin mutations = enabled
- default invariants inferred from question type
```

This makes the first experience:

```bash
jevfuzz run request.json
```

instead of requiring configuration work.

---

# 9. Mutation model

Mutations are divided into safety tiers.

## Tier A: protocol/representation invariants

Enabled by default.

These must require no user declaration.

### A1. question_id_rename

Rename question IDs while leaving question contents unchanged.

Example:

```text
requirement_relation
→
q_4f82a1
```

Answer IDs are mapped back before comparison.

This is a particularly strong invariant because question map keys are identifiers, not decision content.

### A2. question_order

Reorder entries in the `questions` object.

No question contents change.

Generate up to 3 deterministic permutations when there are multiple questions.

### A3. choice_criteria_order

Reorder Choice criteria map entries.

Labels and descriptions remain byte-identical.

Generate:

```text
reverse
seeded shuffle #1
seeded shuffle #2
```

Do not apply to Noul or Score criteria.

### A4. object_key_order

Recursively reorder object keys in:

```text
state
structured instructions
structured criteria values
```

Array order must never change under this mutation.

Generate at least:

```text
reverse keys recursively
seeded shuffle recursively
```

Primitive values remain byte-identical.

---

# 10. User-declared mutations

Disabled unless explicitly configured.

## B1. unordered_array_shuffle

The user declares JSON paths whose array order carries no semantic meaning.

Example:

```json
{
  "unorderedArrays": [
    "$.state.available_tools"
  ]
}
```

Generate deterministic permutations.

Never guess that an array is unordered.

## B2. irrelevant_field_injection

The user explicitly declares a field/value as irrelevant.

Example:

```json
{
  "irrelevantFields": [
    {
      "path": "$.state",
      "field": "trace_id",
      "values": ["123", "999"]
    }
  ]
}
```

JevFuzz injects the field one value at a time.

Never invent arbitrary irrelevant content.

## B3. text_normalization

Optional and only for explicitly declared prose paths.

Allowed transformations:

```text
CRLF ↔ LF
one trailing newline
leading/trailing whitespace outside content
multiple ASCII spaces between prose words → single space
```

Do not enable for source code paths.

---

# 11. Mutation isolation

v0.1 must run **one mutation class at a time**.

Do not initially combine:

```text
question rename + key reorder + noise injection
```

A counterexample should identify one cause.

The run artifact must describe the exact transformation.

Example:

```json
{
  "mutation": {
    "type": "choice_criteria_order",
    "question": "requirement_relation",
    "strategy": "reverse",
    "seed": 42
  }
}
```

Combination fuzzing belongs in v0.2.

---

# 12. Baseline stability

This is mandatory.

Never compare a mutation against one baseline API call.

For every case:

```text
baseline request × baselineRuns
```

Default:

```text
3
```

The system must compute baseline stability independently per question.

### Choice baseline

Stable when all baseline runs choose the same Choice by default.

Store:

```text
modal choice
agreement ratio
mean probability distribution
min/max probability for each option
mean confidence
```

If choices differ across baseline runs:

```text
INCONCLUSIVE_BASELINE_UNSTABLE
```

for that question.

### Noul baseline

Store:

```text
mean
min
max
range
```

Default stability condition:

```text
range <= 0.10
```

Configurable.

### Score baseline

Store:

```text
mean score
min
max
range
mean probability distribution
```

Default stability condition:

```text
range <= 0.35
```

Configurable.

A mutation may still be executed for telemetry after unstable baseline detection, but it must not produce a hard FAIL for that question.

---

# 13. Default invariants

When the user does not specify an invariant, infer one from question type.

## Choice

```text
choice_stable
```

Hard FAIL when:

```text
confirmed mutated modal choice != stable baseline choice
```

## Noul

Default decision threshold:

```text
0.5
```

Hard FAIL when mutation reliably crosses the threshold and:

```text
abs(mutatedMean - baselineMean) >= 0.15
```

The `0.15` guard avoids classifying tiny threshold jitter as a strong failure.

## Score

Hard FAIL when:

```text
abs(mutatedMean - baselineMean) >= 0.5
```

Configurable per question.

---

# 14. Soft invariants

The following produce WARN by default.

### probability_distribution_shift

Calculate Jensen-Shannon divergence between mean baseline distribution and mutation distribution.

Default warning:

```text
JS divergence >= 0.15
```

Applicable to Choice and Score.

### confidence_drop

Warn when:

```text
baseline confidence - mutated confidence >= 0.30
```

### noul_probability_shift

Warn when:

```text
absolute mean shift >= 0.20
```

without a hard decision flip.

Thresholds must be configurable.

---

# 15. Confirmation protocol

A suspected hard FAIL must be confirmed.

Algorithm:

```text
1. baseline is already stable
2. mutation produces candidate failure
3. rerun exact mutated request confirmRuns times
4. combine original mutation call + confirmation calls
5. require the mutated verdict to reproduce in >= 2/3 observations
```

With default `confirmRuns=2`:

```text
initial mutation + 2 confirmations = 3 observations
```

Required:

```text
at least 2 produce the same failing verdict
```

Otherwise:

```text
WARN_FLAKY_MUTATION
```

not FAIL.

All confirmation requests must use the exact same payload bytes after JSON serialization strategy is fixed.

---

# 16. Model-version isolation

After the first successful response:

```text
observedModel = response.model
```

All subsequent responses in the run must match it.

If response model changes:

```text
INCONCLUSIVE_MODEL_CHANGED
```

The report must show:

```text
requested: jev-latest
observed before: jev-x
observed after: jev-y
```

Do not compare across model versions.

---

# 17. API provider architecture

Define an interface from day one:

```ts
export interface DecisionProvider {
  evaluate(
    request: JevRequest,
    options?: {
      signal?: AbortSignal;
    }
  ): Promise<JevResponse>;
}
```

v0.1 implementations:

```text
TypeSafeProvider
FakeProvider
```

Only TypeSafeProvider is required for real network execution.

FakeProvider is mandatory for deterministic tests.

Do not couple mutation logic to HTTP.

---

# 18. TypeSafeProvider requirements

Use Node built-in `fetch`.

No SDK is required.

Responsibilities:

```text
authorization
timeout
response validation
retry
429 handling
529 handling
usage extraction
actual model extraction
safe errors
```

Environment:

```text
TYPESAFE_API_KEY
JEV_API_HOST        optional override
JEV_API_PATH        optional override
```

Never print or persist the API key.

Retry defaults:

```text
max attempts: 5
base delay: 250 ms
exponential factor: 2
jitter: ±20%
retry: 429, 529, network reset/timeout
do not retry: 400/401/403/422
```

Respect `Retry-After` if available.

Default request timeout:

```text
20 seconds
```

---

# 19. Request budgeting

Before network execution calculate:

```text
baselineRequests
mutationRequests
maximumConfirmationRequests
worstCaseRequests
```

If:

```text
worstCaseRequests > maxRequests
```

abort before making any paid request.

Example:

```text
ERROR request budget exceeded

planned worst case: 143
--max-requests:     100

Increase --max-requests or reduce mutations.
```

During execution maintain an atomic request counter.

Retries do not count as logical fuzz cases but must be separately reported as HTTP attempts.

---

# 20. Concurrency

Default concurrent mutated-state requests:

```text
4
```

Baseline runs for a single case should be sequential by default so accidental provider batching/correlation is reduced.

Different cases may execute concurrently only after their own baselines are complete.

All questions belonging to one mutated state stay in one Jev API request.

Do not create one API request per question.

---

# 21. Reproducibility

Every run stores:

```text
run ID
UTC timestamp
seed
JevFuzz version
Node version
requested model
observed model
config hash
case hashes
mutation recipes
thresholds
baseline answers
mutation answers
confirmation answers
usage
HTTP retry counts
```

Randomness must come from a seeded PRNG owned by JevFuzz.

Do not use `Math.random()` directly after initialization.

Running:

```bash
jevfuzz run case.json --seed 42
```

must generate identical mutated request payloads across machines.

Model outputs may differ; mutations may not.

---

# 22. Artifacts

Directory:

```text
.jevfuzz/
  runs/
    <run-id>/
      manifest.json
      report.json
      report.txt
      failures/
        <failure-id>.json
```

Failure artifact contains:

```json
{
  "version": 1,
  "runId": "...",
  "caseId": "...",
  "questionId": "...",
  "mutation": {},
  "baselineRequest": {},
  "mutatedRequest": {},
  "baselineResponses": [],
  "mutatedResponses": [],
  "comparison": {},
  "model": "...",
  "seed": 42
}
```

Failure artifact must be independently replayable:

```bash
jevfuzz replay <failure-file>
```

`replay` sends:

```text
baseline request
mutated request
```

the configured number of times and prints the comparison.

Artifacts must be local only.

Create directories/files with restrictive permissions where supported:

```text
directory 0700
files     0600
```

`--no-save-payloads` stores hashes and summary only, but then `replay` is unavailable.

Recommend `.jevfuzz/` in `.gitignore`.

---

# 23. Human CLI report

Example success:

```text
JevFuzz 0.1.0
model: jev-1.13.0
seed: 42

✓ unchanged-caller-001
  ✓ requirement_relation
    baseline stable       3/3 worth_checking
    question_id_rename    pass
    question_order        pass
    choice_criteria_order pass
    object_key_order      pass

4 mutations
0 failures
1 warning
12 requests
input tokens: 9,482
```

Example failure:

```text
JevFuzz 0.1.0

✗ unchanged-caller-001
  ✗ requirement_relation

    mutation:
      choice_criteria_order / reverse

    baseline:
      worth_checking  0.91
      not_required    0.06
      settled         0.03

    mutated:
      not_required    0.84
      worth_checking  0.13
      settled         0.03

    confirmed:
      baseline 3/3 worth_checking
      mutated  3/3 not_required

    artifact:
      .jevfuzz/runs/.../failures/F001.json

FAIL: 1 reproducible metamorphic violation
```

No prose generated by another LLM.

---

# 24. JSON report contract

`report.json` should be considered public API from v0.1.

Top-level:

```ts
type FuzzReport = {
  version: 1;
  run: RunMetadata;
  summary: RunSummary;
  cases: CaseReport[];
};
```

Summary:

```ts
type RunSummary = {
  cases: number;
  questions: number;
  mutations: number;

  pass: number;
  warn: number;
  fail: number;
  inconclusive: number;

  logicalRequests: number;
  httpAttempts: number;

  usage: {
    inputTokens: number;
    outputTokens: number;
  };
};
```

Do not expose internal class names in the contract where avoidable.

---

# 25. `jev-intent-review` dogfood integration

JevFuzz remains a separate repository.

Do not make `jev-intent-review` depend on it.

Add a tiny optional trace/export facility to `jev-intent-review` in a separate commit/PR after JevFuzz core works.

Desired behavior:

```bash
JEV_TRACE_FILE=/tmp/intent-review-jev.jsonl \
jev-intent-review ...
```

Each logical Jev evaluation appends a normalized line:

```json
{
  "version": 1,
  "source": "jev-intent-review",
  "timestamp": "...",
  "request": {
    "state": {},
    "model": "jev-latest",
    "questions": {}
  },
  "response": {}
}
```

Requirements:

```text
opt-in only
no API key
normalized provider-independent request
append-only
one logical Jev call per line
existing behavior unchanged when env variable absent
```

Then JevFuzz should support:

```bash
jevfuzz import /tmp/intent-review-jev.jsonl \
  --out fixtures/intent-review/
```

`import` extracts requests into `.jevfuzz.json` cases.

The stored original response is historical metadata only. It must not be used as truth.

JevFuzz reruns its own baseline.

---

# 26. First dogfood experiment

Use one real `jev-intent-review` run.

Capture at least:

```text
10 distinct Jev request states
```

Then run built-in Tier A mutations.

Report:

```text
number of questions
number of mutation executions
baseline instability rate
hard metamorphic failures
soft distribution shifts
mutation classes responsible
total request count
token usage
```

Do not require finding a real failure for v0.1 acceptance.

A clean result is valid:

```text
0 / 74 protocol-invariant mutations changed a decision
```

The value is the test framework, not manufacturing a bug.

---

# 27. Test strategy

Use the Node built-in test runner to match the surrounding toolchain.

Required test layers:

### Unit

Test:

```text
seeded RNG
question ID remapping
question ordering
Choice criteria ordering
recursive key ordering
unordered array mutation
irrelevant field injection
config parsing
request budgeting
Choice comparison
Noul comparison
Score comparison
JS divergence
model-version guard
artifact serialization
exit-code selection
```

### Fake-provider integration

Create deterministic providers:

```text
StableProvider
PositionSensitiveProvider
RandomBaselineProvider
VersionChangingProvider
RateLimitedProvider
```

Tests must prove:

```text
StableProvider → PASS
PositionSensitiveProvider → confirmed FAIL
RandomBaselineProvider → INCONCLUSIVE, never false FAIL
VersionChangingProvider → INCONCLUSIVE_MODEL_CHANGED
RateLimitedProvider → retries then succeeds
```

### Live smoke

Only when `TYPESAFE_API_KEY` exists.

Command:

```bash
npm run test:live
```

Use a tiny fixture:

```text
1 case
1–2 questions
minimal mutations
strict max request budget
```

Normal `npm test` must never require network access.

---

# 28. Repository structure

Recommended:

```text
jevfuzz/
  src/
    cli/
      main.ts
      commands/
        doctor.ts
        plan.ts
        run.ts
        replay.ts
        import.ts

    config/
      schema.ts
      load.ts

    jev/
      types.ts
      provider.ts
      typesafe-provider.ts
      fake-provider.ts

    fuzz/
      runner.ts
      baseline.ts
      mutate.ts
      compare.ts
      confirm.ts
      budget.ts

    mutations/
      question-id.ts
      question-order.ts
      choice-order.ts
      object-key-order.ts
      unordered-array.ts
      irrelevant-field.ts
      text-normalization.ts

    report/
      types.ts
      json.ts
      text.ts
      artifacts.ts

    util/
      hash.ts
      rng.ts
      json-path.ts
      retry.ts

  test/
  fixtures/
  docs/
    design.md
    mutation-safety.md

  package.json
  tsconfig.json
  tsconfig.build.json
  README.md
  LICENSE
```

Avoid a framework-heavy architecture.

---

# 29. Dependencies

Keep runtime dependencies minimal.

Preferred:

```text
0 dependencies if practical
```

If JSONPath implementation becomes disproportionately complex, use one small, mature JSONPath dependency.

Do not add:

```text
React
database
Express
LLM SDK
OpenAI SDK
Anthropic SDK
large validation frameworks
```

TypeScript validation may be handwritten because the schema is small.

---

# 30. Security requirements

Mandatory:

```text
never log API keys
never write API keys to artifacts
never send state anywhere except configured Jev provider
no telemetry
no analytics
no mutation-generating third-party model
no automatic upload of reports
```

`doctor` may print:

```text
TYPESAFE_API_KEY: present
```

Never print the key or a prefix/suffix.

---

# 31. README minimum

README must explain these concepts near the top:

```text
JevFuzz tests judgment stability, not factual correctness.
A FAIL means an invariant was violated.
A PASS does not prove the original judgment is correct.
Built-in Tier A mutations do not intentionally change semantic content.
Probabilistic baseline instability is separated from mutation-induced instability.
```

Quick start must fit in approximately ten lines:

```bash
npm install
export TYPESAFE_API_KEY=...
cat > example.json <<'JSON'
...
JSON
npm run build
node dist/cli/main.js plan example.json
node dist/cli/main.js run example.json
```

Include one real counterexample-format screenshot/text block eventually, but not required to merge core functionality.

---

# 32. Performance target

JevFuzz itself should add negligible CPU overhead relative to API latency.

Targets excluding network:

```text
100 mutations generated < 100 ms
100 comparisons < 50 ms
artifact/report generation < 100 ms
```

Memory:

```text
< 100 MB for a normal 100-mutation run
```

No performance work should delay correctness.

---

# 33. Acceptance criteria / Definition of Done

v0.1 is complete only when ALL of these are true:

* `npm test` passes offline.
* `npm run typecheck` passes.
* `npm run build` produces runnable CLI.
* `jevfuzz doctor` validates environment without exposing secrets.
* `jevfuzz plan` performs zero network calls and correctly calculates worst-case request count.
* `jevfuzz run` executes a real TypeSafe/Jev case when a valid key exists.
* Choice, Noul and Score are supported.
* Baseline instability cannot become a hard metamorphic FAIL.
* Tier A built-in mutations work deterministically from a seed.
* User-declared unordered-array and irrelevant-field mutations work.
* Candidate failures are rerun before becoming FAIL.
* Model change during a run produces INCONCLUSIVE rather than FAIL.
* 429/529 retries are implemented and tested with FakeProvider or mocked fetch.
* `--max-requests` prevents runaway paid calls before execution.
* Human-readable output clearly distinguishes PASS/WARN/FAIL/INCONCLUSIVE.
* JSON report is emitted.
* Failure artifact can be replayed.
* Same seed generates byte-equivalent mutated logical request objects.
* API key never appears in logs/artifacts/tests.
* At least one live smoke test has been manually executed successfully.
* At least one captured or manually constructed `jev-intent-review` decision has been run through JevFuzz.
* README documents limitations honestly.

---

# 34. Implementation order for Codex

Implement in this order and keep the repository green after every step:

1. Project skeleton, TypeScript config, CLI dispatch, types.
2. Jev request/response type definitions.
3. FakeProvider + TypeSafeProvider.
4. Config parser and raw-request convenience format.
5. Seeded RNG.
6. Tier A mutation engine.
7. Baseline evaluator.
8. Choice/Noul/Score comparators.
9. Confirmation logic.
10. Request budget.
11. Runner/concurrency.
12. Text + JSON reports.
13. Failure artifact + replay.
14. User-declared mutations.
15. `doctor`.
16. `plan`.
17. live smoke fixture.
18. `jev-intent-review` trace import.
19. README/docs cleanup.

After each step:

```bash
npm run typecheck
npm test
npm run build
```

Do not postpone tests until the end.

---

# 35. Codex execution rules

When implementing this PRD:

* Make reasonable implementation decisions without asking for stylistic confirmation.
* Do not expand v0.1 scope.
* Prefer explicit small modules over generic plugin systems.
* Keep mutation generation pure and deterministic.
* Keep HTTP outside fuzz logic.
* Never treat confidence as correctness.
* Never hide baseline instability.
* Never silently downgrade a FAIL to PASS.
* Never silently substitute a fake provider for a failed live provider.
* Clearly mark live, fake and replay results.
* Preserve raw probabilities in reports.
* If the live API response differs from this PRD, follow the official API response and update local types/tests rather than coercing it.
* If a mutation cannot be proven structurally safe, require explicit user declaration or leave it for v0.2.

---

# 36. v0.1 success demo

The final demo should require no explanation beyond:

```bash
$ jevfuzz run intent-review-case.json

JevFuzz 0.1.0
model: jev-1.13.0

✗ requirement_relation
  choice changed under criteria reordering

  normal order:
    worth_checking  0.91

  reversed order:
    not_required    0.84

  reproduced 3/3
  semantic content unchanged

  replay:
    jevfuzz replay .jevfuzz/runs/.../F001.json
```

or, if Jev is stable:

```bash
$ jevfuzz run intent-review-case.json

✓ 38/38 mutations preserved the decision
⚠ 2 produced material probability shifts
✓ baseline stable
model: jev-1.13.0
```

Both outcomes constitute a successful JevFuzz run.

The core product is not “find a Jev bug.”

The core product is:

> **make the robustness of a Jev decision measurable, reproducible, and testable in CI.**
