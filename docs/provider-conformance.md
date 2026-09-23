# Provider conformance

| Adapter | HTTP accounting and cancellation | Cache metadata | Evidence profile |
| --- | --- | --- | --- |
| `TypeSafeProvider` | Counts dispatched HTTP attempts and retries; forwards abort signals and bounds response reads. | `unknown` | `paired-v1` empirical confirmation; `fixed-stat-v1` is refused. |
| `CloudflareProvider` | Uses the same HTTP accounting and cancellation path; validates its fixed response envelope and observed model. | `unknown` | `paired-v1` empirical confirmation; `fixed-stat-v1` is refused. |
| `FakeProvider` | No HTTP attempts; observes cancellation before handling the request. | `fresh` | Offline test adapter only. |

HTTP adapters declare typed validation, byte replay, cancellation, and retry
accounting. Their cache metadata is explicitly unavailable, so a `paired-v1`
result is empirical: repeated new calls are evidence of the declared relation,
not a guarantee of cache freshness or independence. `fixed-stat-v1` requires
explicit cache metadata and is rejected for these live adapters.

The package verification uses an offline Node `--import` preload that replaces
`globalThis.fetch`; it asserts the endpoint, authorization, cache-control header,
and raw payload without contacting an external API. It is adapter-path evidence,
not live-provider conformance evidence.

## v0.2.0 Cloudflare live verification — 2026-09-23

The built CLI contacted Cloudflare-hosted `jev-1.13.0` using an existing local
environment file. Credentials and request/response artifacts remain local.
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
