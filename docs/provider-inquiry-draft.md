# TypeSafe sampling-contract inquiry — inactive, unsent draft

On 2026-09-23 the owner instructed implementation and verification to continue
without a provider inquiry. This draft is retained only for reference; sending
it is not part of the current task.

Recipient: `support@typesafe.ai`

The address is published in section 3 of TypeSafe's official
[Master Customer Agreement](https://typesafe.ai/legal/mca) and section 13(e) of
its [Terms of Use](https://typesafe.ai/legal/terms), checked on 2026-09-23.
This document is a draft. No message has been sent.

Subject: Jev sampling and cache contract for statistical regression testing

Hello TypeSafe support,

We are evaluating Jev with JevFuzz, a metamorphic tester for decision functions.
We want to distinguish empirical repeatability from statistical evidence of a
contract violation, without making unsupported assumptions about the API.

Our bounded Cloudflare-hosted Jev probe observed model `jev-1.13.0`. All six
requests used `cf-aig-skip-cache: true`, but none returned a recognized gateway
HIT/MISS classification. We understand that a gateway cache bypass alone does
not establish fresh origin inference. We also support TypeSafe's direct
`/v1/systemone` endpoint, verified with mocked HTTP responses; direct live
validation is deferred because no TypeSafe key is currently available.

For these two access paths, could you point us to a versioned specification or
clarify the following for a pinned Jev model revision?

1. Which documented settings cause repeated identical payloads to execute a
   new inference, including origin caching, request coalescing, and retries?
2. Which response fields identify fresh versus reused execution, and how
   should clients interpret missing or ambiguous execution metadata?
3. What sampling assumptions are supported across repeated calls? In
   particular, can a fixed-sample paired test reasonably assume independent
   observations and a stationary decision distribution for a frozen input and
   model revision? Please identify relevant exceptions or limitations.
4. Which response identifier pins the executed model revision and exposes
   changes during a rollout?
5. Can a single client HTTP attempt trigger multiple origin inferences or
   return a previously computed inference through internal retries, and is
   that visible to the client?

Until these assumptions are supported, JevFuzz keeps HTTP-provider confirmation
empirical and refuses its statistical confirmation profile. A documented
unsupported condition is also useful; we will record the limitation explicitly.

No customer payloads, API keys, account identifiers, or raw headers are included
in this inquiry. We can provide a public synthetic reproduction if helpful.

Thank you.
