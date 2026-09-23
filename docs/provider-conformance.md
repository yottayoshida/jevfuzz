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
