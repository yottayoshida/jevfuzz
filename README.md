# JevFuzz

> Find the input that changes the decision. Shrink it. Keep it.

JevFuzz tests Jev decision functions with reproducible input transformations.
It confirms suspected contract violations with new observations, shrinks the
input pair, and keeps it as a regression test.

**Judgment stability, not factual correctness.** A confirmed FAIL breaks a
declared relation. PASS describes the observations made; it does not prove the
answer correct.

Current package: **v0.2.0**. External field validation remains pending.

## Start

From source. Node **22.18+**. No runtime dependencies.

```sh
git clone https://github.com/yottayoshida/jevfuzz.git
cd jevfuzz
npm ci
npm run build
alias jevfuzz='node dist/cli/main.js'
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
jevfuzz plan fixtures/v2/routing.campaign.json
jevfuzz fuzz fixtures/v2/routing.campaign.json
```

The example uses Cloudflare Jev. TypeSafe is also supported.
`plan` makes zero API calls and shows separate request, retry, confirmation,
and shrink budgets.

## Keep a counterexample

```sh
jevfuzz shrink finding.json --out smaller.json
jevfuzz corpus add smaller.json --corpus .jevfuzz/corpus
jevfuzz corpus triage .jevfuzz/corpus <id> --status accepted_regression --actor me --reason "Reviewed relation"
jevfuzz check .jevfuzz/corpus
jevfuzz report smaller.json --format html --out smaller.html
```

Choice, Noul, Score, and declarative production policies are supported.
Uniform search is the default; feedback search remains experimental.
Version 1 `run`, configs, reports, and failure replay remain supported.

Artifacts stay local with private permissions. Full artifacts contain prompts
and source data; redacted and hash-only modes are not replayable.
No telemetry or automatic uploads.

[CLI and migration](docs/v09-migration.md) ·
[Provider evidence](docs/provider-conformance.md) ·
[Benchmark protocol](docs/benchmark-v09.md) ·
[Offline demo](docs/demo-v09.md) ·
[Implementation status](docs/v09-implementation.md) · [MIT](LICENSE)
