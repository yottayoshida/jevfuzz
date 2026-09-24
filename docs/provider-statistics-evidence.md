# Evidence needed for live statistical confirmation

Status: unresolved for Cloudflare-hosted Jev and TypeSafe direct. The existing
`fixed-stat-v1` profile requires assumptions that an HTTP success or a cache
bypass request does not establish. Do not replace the empirical profile with a
statistical claim until the missing provider evidence is available.

Provider support is a separate requirement: both TypeSafe direct and
Cloudflare-hosted Jev are implemented. At the owner's direction, TypeSafe
readiness is verified with a test key and mocked HTTP; obtaining a direct key
is not a prerequisite for implementation. Direct live validation is deferred,
while Cloudflare provides the available live path. This does not supply the
sampling guarantees required by `fixed-stat-v1`.

The owner explicitly chose to continue implementation and verification without
a provider inquiry on 2026-09-23. No contact is planned. Provider correspondence
is one possible source of evidence, not a requirement for installing or using
JevFuzz. Public specifications or other verifiable execution evidence may also
support the assumptions; an unsupported assumption cannot be treated as
verified simply because correspondence is out of scope. Empirical Cloudflare
fuzzing, replay, shrinking, and regression checks remain available.

## What the public specifications establish

- Cloudflare's [`/ai/run` REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)
  routes third-party models through the account's default AI Gateway. It accepts
  `cf-aig-skip-cache: true` as a per-request gateway cache control.
- [AI Gateway caching](https://developers.cloudflare.com/ai-gateway/features/caching/)
  describes the `cf-aig-cache-status` response header. A gateway cache hit is
  evidence of reuse. A miss concerns that gateway layer only.
- [AI Gateway request handling](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/)
  documents gateway-level retries and the per-request `cf-aig-max-attempts`
  override. JevFuzz now requests one gateway attempt per client HTTP attempt;
  this does not prove the provider executed one independent inference. A timed-out
  client request, origin-side retry or deduplication, or a gateway that ignores
  the header still leaves origin execution unverified.
- The [TypeSafe API](https://docs.typesafe.ai/api) documents the typed request
  and response, and the [model documentation](https://docs.typesafe.ai/models)
  describes model versions and aliases. The inspected public specifications do
  not establish origin cache bypass, independent inference draws, or metadata
  that verifies those properties per observation.

Sources inspected on 2026-09-23 and 2026-09-24. Absence from these inspected specifications is
an evidence gap, not a claim that the provider cannot support these features.

## Evidence required before enabling fixed-stat

The exact endpoint and model revision need verifiable evidence addressing the
following questions. A versioned public specification may supply that evidence;
obtaining it does not necessarily involve contacting the provider:

1. Under which documented request settings does an identical payload trigger a
   new inference instead of a reused response? Does this apply at both gateway
   and origin, including internal batching, deduplication, and retries?
2. Which response metadata confirms that execution condition for each call?
   What does missing metadata mean, and can a cache hit be distinguished from
   a fresh execution without guessing from latency or answer equality?
3. How are randomness, request coalescing, and shared execution state handled
   across calls? What independence and stationarity assumptions can a client
   reasonably make for a fixed model revision and frozen input pair?
4. Which identifier pins the executed model revision? How are rollout changes
   exposed so a mixed cohort can be rejected?
5. Which retries can occur behind a single client HTTP attempt, and what
   metadata identifies ambiguous or reused execution? Client HTTP counts must
   not be presented as an exact count of origin inferences.

The answer determines whether the existing fixed-sample paired test is valid.
Document remaining assumptions explicitly; independence cannot be proven by
a finite sample of changing outputs. If the provider supplies a different
sampling contract, changing the null hypothesis or test is a separate design
decision, not a silent relaxation of `fixed-stat-v1`.

## Bounded verification after the specification is available

- Pin the documented endpoint/model/settings and freeze the test protocol.
- Use only owner-approved requests, with separate discovery and confirmation
  observations and the existing logical/HTTP/time/slot ceilings.
- Verify metadata parsing against missing, malformed, cached, fresh, retried,
  interrupted, and model-change responses. Unsupported evidence fails closed.
- Retain source hashes, normalized evidence, model identity, and all outcomes.
  Keep credentials and request bodies private. Do not persist arbitrary header
  dumps or use a new request ID, gateway MISS, nonce, or latency as a freshness
  or independence certificate.
- When a TypeSafe key becomes available, run directly with `TYPESAFE_API_KEY`.
  This optional live validation remains deferred for the current owner. A
  Cloudflare token does not supply TypeSafe-direct authentication. Successful
  direct smoke closes live adapter-path coverage, not the statistical
  assumptions above.

No provider inquiry has been sent, and the owner has excluded that action from
the current work. The retained inquiry draft is inactive. These evidence gaps
remain unresolved; they do not block ordinary empirical workflows.
