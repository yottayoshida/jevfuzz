# Provider conformance

## Setup

Both adapters are implemented. Configure the credentials for the provider you
select; Cloudflare does not require a TypeSafe API key. Use environment
variables or Node's `--env-file` option to load a private env file.

```sh
# TypeSafe direct: for users who have a TypeSafe key.
export TYPESAFE_API_KEY=...
jevfuzz doctor --provider typesafe
jevfuzz fuzz fixtures/v2/routing.campaign.json --provider typesafe

# Cloudflare-hosted Jev: only Cloudflare credentials are required.
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_API_TOKEN=...
jevfuzz doctor --provider cloudflare
jevfuzz fuzz fixtures/v2/routing.campaign.json --provider cloudflare
```

`doctor` validates local configuration without making network calls. A new v2
campaign selects the adapter through its `provider` field or `--provider`.
Saved findings retain their provider identity for replay and regression checks.

TypeSafe is verified against mocked HTTP responses and the installed CLI with
a test key. The project owner has no direct TypeSafe key, so direct live
validation is deferred rather than blocking implementation. Cloudflare is the
available live validation path. Missing credentials for the selected provider
still produce an explicit configuration error; another adapter is never
silently substituted. Mocked execution is not labeled as a live TypeSafe run.

## Evidence scope

| Adapter | HTTP accounting and cancellation | Cache metadata | Evidence profile |
| --- | --- | --- | --- |
| `TypeSafeProvider` | Counts dispatched HTTP attempts and retries; forwards abort signals and bounds response reads. | `unknown` | `paired-v1` empirical confirmation; `fixed-stat-v1` is refused. |
| `CloudflareProvider` | Uses the same HTTP accounting and cancellation path; validates its fixed response envelope and observed model. | `cached` for a recognized gateway HIT; otherwise `unknown` | `paired-v1` empirical confirmation; `fixed-stat-v1` is refused. |
| `FakeProvider` | No HTTP attempts; observes cancellation before handling the request. | `fresh` | Offline test adapter only. |

HTTP adapters declare typed validation, byte replay, cancellation, and retry
accounting. Origin freshness metadata remains unavailable, so a `paired-v1`
result is empirical: repeated new calls are evidence of the declared relation,
not a guarantee of cache freshness or independence. `fixed-stat-v1` requires
explicit cache metadata and is rejected for these live adapters.

The package verification uses an offline Node `--import` preload that replaces
`globalThis.fetch`. It exercises both adapters through the installed CLI with
synthetic credentials and installed fixtures, checking each endpoint,
authorization, cache-control headers, and request/response envelope without
contacting an external API. Wrong-provider-only credentials must fail before
dispatch. This is adapter-path evidence, not live-provider conformance evidence.

## v0.2.0 Cloudflare live verification — 2026-09-23

The built CLI contacted Cloudflare-hosted `jev-1.13.0` using an existing local
environment file. Credentials and raw HTTP material remain local. The normalized
public-synthetic shrink result is now bundled as [README evidence](readme-demo.md);
other run artifacts remain local.
The v2 seed reused only the request from a previously confirmed public synthetic
example; all responses and confirmations below were newly collected.

| Operation | Logical / HTTP calls | Observed result |
| --- | ---: | --- |
| Legacy smoke | 6 / 6 | Six question/mutation comparisons passed. |
| v2 fuzz | 52 / 52 | Two object-key-order violations confirmed; no pending confirmation. |
| Replay of the first finding | 24 / 24 | Same violation confirmed with new observations. |
| Shrink of the second finding | 30 / 30 | Moved key positions reduced from 3 to 2; six screening calls and 24 fresh final-confirmation calls. |
| Accepted-corpus check of the first finding | 26 / 26 | One required regression checked and the violation reproduced. |
| **Total** | **138 / 138** | No retries or observed model drift. |

The initial shrink diagnostics made zero API calls and exposed an omitted
object-order reducer. The release fixes that omission; the new regression fails
on the earlier implementation and the corrected CLI produced the smaller
witness above. Input byte size stayed unchanged: the simplification removes an
unnecessary moved key position, preserving the declared contract and target.

The live commands were `run`, `fuzz`, `replay`, `shrink --shrink-requests 24`,
`corpus add`, explicit `corpus triage`, and `check`. Detection commands exited
1 for confirmed violations; this is their successful detection result. The
campaign used `paired-v1` with eight A/A′/B blocks, at most 52 logical calls,
and a 260-attempt HTTP ceiling. Journals verify the shrink and replay counts.
The v2 workflow stayed below its 150-logical-call ceiling.

This is bounded empirical release evidence. It does not establish cache
freshness, statistical independence, factual correctness, an external-user
pilot, or the full v0.9 field-acceptance criteria. TypeSafe-direct live behavior
remains unverified; fixed-stat confirmation is still refused by both HTTP adapters.

## Cache evidence boundary

Cloudflare requests include `cf-aig-skip-cache: true` and
`cf-aig-max-attempts: 1` on every client HTTP attempt. The latter requests that
AI Gateway make only one upstream attempt, so gateway retries should not be
hidden inside a JevFuzz attempt, per [Cloudflare's request-handling documentation](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/).
It may expose upstream 5xx responses that a
gateway retry would previously have masked. Origin-side retries, deduplication,
or a timed-out request remain unverified; the header was checked offline in the
current package but has not been rechecked against live Cloudflare.
Only a trimmed, case-insensitive `cf-aig-cache-status: HIT` response records
`cached`; `MISS`, missing, and unrecognized values record `unknown`. This is
observation metadata, not freshness or origin-independence evidence:
`cacheMetadata` remains false for both HTTP adapters and `fixed-stat-v1` remains
refused.

The header is documented for the existing endpoint in Cloudflare's
[REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/) and
[caching](https://developers.cloudflare.com/ai-gateway/features/caching/)
specifications. It concerns the gateway, not origin inference independence.

A bounded probe on 2026-09-23 made six repeated public-synthetic requests with
the skip-cache header: six logical requests, six client HTTP attempts, no
retries, all observing `jev-1.13.0`. None returned a recognized gateway `HIT` or
`MISS` classification, so all six observations retained `cache: unknown`.
Provider source SHA-256 was
`099ae70f532a460dac875b1f1f40ebf58bff302120ef39b199d606e6e88d56e5`.
This verifies successful calls with the header, not a fresh-execution or
independence guarantee. The normalized probe record is local; no credentials,
request payloads, or raw headers were published. The remaining prerequisites
are specified in [provider statistical evidence](provider-statistics-evidence.md).

## Dual-provider readiness verification — 2026-09-23

The owner confirmed that no TypeSafe-direct key is available. TypeSafe remains
supported and is verified through mocked HTTP and the installed CLI; direct
live verification is deferred. Cloudflare was also checked again with the
existing private env file:

- Built-CLI `doctor --provider cloudflare --json`: exit 0, zero network calls.
- `JEVFUZZ_LIVE_PROVIDER=cloudflare node --env-file=<private-env> scripts/live-smoke.ts`:
  exit 0, six logical requests, six HTTP attempts, zero retries, six passing
  question/mutation comparisons, observed model `jev-1.13.0`.

The first smoke attempt in the restricted environment ended with
`PROVIDER_NETWORK`, one incomplete logical request, five attempted HTTP calls,
and zero responses. A separate hostname check confirmed DNS resolution was
unavailable there. The successful run used network access; both run records
were retained privately. This environment failure was not classified as an
authentication failure or a passing live test.
