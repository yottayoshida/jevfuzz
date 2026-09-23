# Run JevFuzz in your repository

Commit your decision inputs and contracts to your own repository. JevFuzz runs
them in GitHub Actions and fails the job when a confirmed violation is found.
No enrollment or service account with JevFuzz is required.

1. Copy [campaign.json](../examples/github-actions/campaign.json) to
   `.jevfuzz/campaign.json`. Replace the example request and assumptions with
   your application's actual decision contract. Use inline seed objects.
2. Copy [jevfuzz.yml](../examples/github-actions/jevfuzz.yml) to
   `.github/workflows/jevfuzz.yml`.
3. Add repository secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.
   The token needs permission to invoke Workers AI in that account.
4. Push to `main` or run the workflow manually. Download the `jevfuzz-…`
   artifact from the workflow run to inspect the result, including failed runs.

For TypeSafe, change `provider` to `typesafe` and replace both Cloudflare
environment entries with `TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}`.
The same action supports both adapters. [Provider setup](provider-conformance.md#setup).

Pull requests run `plan` without provider credentials. API calls run only on
trusted pushes and manual runs; the sample does not give fork pull requests
secrets. Review changes to campaign requests and budgets before merging them.
The action installs its own locked dependencies and builds its own source;
it does not install or execute the consumer repository's package scripts.

## Inputs and results

| Input | Meaning |
| --- | --- |
| `command` | `plan` (default), `fuzz`, or `check` |
| `target` | Required workspace-relative campaign file or corpus directory |
| `provider` | Optional `cloudflare` or `typesafe`; otherwise use the campaign/corpus provider |
| `storage` | `hash-only` (default) or `full` for replayable fuzz evidence |

Targets must stay inside the checkout and contain no symlinks. Action campaigns
use inline seeds; the CLI also supports file globs. `plan` makes no API calls.
The action runs on Linux with Node 24. Pin `uses:` to the full commit shown in
the example; the older `v0.2.0` release predates the action.

| `exit-code` output | Result | Job |
| --- | --- | --- |
| `0` | Completed without confirmed violations | Pass |
| `1` | Confirmed contract violation | Fail |
| `2` | Invalid configuration, runtime error, interruption, or incomplete execution | Fail |
| `3` | Inconclusive, pending confirmation, or no required regression cases | Fail |

`report-path` points to the JSON result when available; `artifacts-path` points
to the temporary output directory. Outputs are recorded before the failure
step so the sample upload still runs. An invalid configuration can fail before
creating a report. Do not add `continue-on-error` to your JevFuzz step: a failed
or incomplete check must remain visible.

The action limits a run to 1,000 logical requests, 5,000 HTTP attempts, 600
seconds, concurrency 8, 1,000 candidates, and 32 MiB of run artifacts. Corpus
checks allow at most 20 entries and eight paired confirmation blocks, within
the aggregate request limit. Larger experiments belong in the CLI. Request
ceilings include accounting for retries; they are not a monetary price cap.

## Keep a finding as a regression test

The example uses hash-only storage. To download replayable input and response
evidence, explicitly change the fuzz step to `storage: full`. These artifacts
contain the submitted data: review repository access and the seven-day upload
retention before enabling it. Upload is performed by the explicit workflow
step; the action itself does not upload artifacts or accept corpus entries.

Download and extract the artifact, then use the CLI to inspect and shrink a
finding. Review the declared relation before accepting it:

```sh
jevfuzz shrink path/to/finding.json --out smaller.json
jevfuzz corpus add smaller.json --corpus .jevfuzz/corpus
jevfuzz corpus triage .jevfuzz/corpus <id> --status accepted_regression --actor me --reason "Reviewed relation"
```

Commit the resulting `.jevfuzz/corpus` to your repository. Add another action
step with `command: check` and `target: .jevfuzz/corpus`, using the same provider
credentials. `check` performs new observations, fails on a reproduced
violation, and passes when every required fixture holds. An empty or wholly
excluded corpus returns 3. The action checks a temporary copy; it never
rewrites your committed corpus, auto-accepts findings, or commits changes.

All reports are created under `RUNNER_TEMP`, outside the checkout. If you use
a persistent self-hosted runner, remove its temporary private artifacts after
the job. Hash-only storage cannot be used to reconstruct a counterexample.

Confirmation is empirical for Cloudflare and TypeSafe. The providers do not
currently establish fresh, independent origin observations, so JevFuzz refuses
the statistical oracle for these HTTP adapters. New client calls do not imply
independent model samples. [Evidence scope](provider-statistics-evidence.md).

## CLI setup

Node **22.18+** is required. JevFuzz has no runtime dependencies.

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

For TypeSafe, set `TYPESAFE_API_KEY` and add `--provider typesafe`.
