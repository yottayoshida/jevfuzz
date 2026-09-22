# JevFuzz

> Change the order. Check the decision.

JevFuzz renames question IDs and reorders questions, Choice options and JSON
keys inside decision content, then checks whether Jev changes its answer. It measures the baseline
first, confirms suspected failures, and saves a case you can replay.

**Judgment stability, not factual correctness.** A FAIL means an invariant was
violated; a PASS does not prove the original answer correct. Built-in mutations
do not intentionally change meaning. Baseline instability is reported separately
from changes caused by a mutation.

One real result, reproduced in an independent replay:

```text
relevance object_key_order / reverse: FAIL
  confirmed: baseline 3/3 unrelated
    mutated 3/3 may_violate
```

[Live results](https://github.com/yottayoshida/jevfuzz/blob/v0.1.0/docs/verification.md): 10 states, 100 mutations, six confirmed
violations. JevFuzz measures robustness; it does not decide which answer is right.

## Quick start

Node.js **22.18+**. No runtime dependencies. Install the release tarball:

```sh
npm install -g https://github.com/yottayoshida/jevfuzz/releases/download/v0.1.0/jevfuzz-0.1.0.tgz
export TYPESAFE_API_KEY=...
cat > case.json <<'JSON'
{"state":"The sky is blue.","model":"jev-latest","questions":{"blue":{"type":"noul","instructions":"Is the sky described as blue?"}}}
JSON
jevfuzz plan case.json --seed 42
jevfuzz run case.json --seed 42
```

`plan` makes no API calls. `run` checks the worst-case request budget before
spending anything; set it with `--max-requests`. Retries count separately and can
incur additional charges. [Build from source and every flag](https://github.com/yottayoshida/jevfuzz/blob/v0.1.0/docs/cli.md).

For Cloudflare Jev, set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, then add
`--provider cloudflare`. TypeSafe is the default; there is no provider fallback.

## Commands

```sh
jevfuzz doctor
jevfuzz plan case.json --seed 42
jevfuzz run case.json --seed 42 --max-requests 100
jevfuzz replay .jevfuzz/runs/<run-id>/failures/F001.json
jevfuzz import /tmp/intent-review-jev.jsonl --out fixtures/imported
```

Choice, Noul and Score are supported. Array shuffling and irrelevant-field
injection require your explicit declaration. Suspected failures are rerun;
unstable baselines and model changes are INCONCLUSIVE.

Exit codes: **0** no FAIL, **1** confirmed FAIL, **2** runtime/configuration error,
**3** no reliable verdict. Reports distinguish PASS, WARN, FAIL and INCONCLUSIVE.

Artifacts stay in `.jevfuzz/` with private file permissions. They can contain
source and prompts: keep that directory ignored. `--no-save-payloads` saves only
hashes and summaries and disables replay. No telemetry or automatic uploads.

## Documentation

- [CLI, providers and library](https://github.com/yottayoshida/jevfuzz/blob/v0.1.0/docs/cli.md)
- [Mutation safety](https://github.com/yottayoshida/jevfuzz/blob/v0.1.0/docs/mutation-safety.md)
- [Design](https://github.com/yottayoshida/jevfuzz/blob/v0.1.0/docs/design.md) · [PRD](https://github.com/yottayoshida/jevfuzz/blob/v0.1.0/docs/PRD.md) · [Verification](https://github.com/yottayoshida/jevfuzz/blob/v0.1.0/docs/verification.md)
- [jev-intent-review trace export](https://github.com/yottayoshida/jev-intent-review/pull/56)

Run `npm test`, `npm run typecheck`, and `npm run build` for offline verification.
`npm run test:live` explicitly opts into paid API calls.

[MIT](LICENSE).
