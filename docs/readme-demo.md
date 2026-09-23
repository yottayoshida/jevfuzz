# README demo evidence

The [README animation](assets/readme-demo.svg) replays a recorded Cloudflare
Jev result. It does not run an API, invent decisions, or claim an external-user
pilot. The release record identifies the input as a public synthetic example;
the responses were collected from Cloudflare-hosted `jev-1.13.0` on 2026-09-23.

## What the image shows

Only the order of `$.state` members changes. Their complete values, both
questions, and the rest of the request stay identical. The image elides values
to keep the three key positions legible; the complete payloads are in the
[recorded shrink result](assets/readme-finding.json).

| Recorded stage | `$.state` key order | Relevance answer |
| --- | --- | --- |
| Original input | `requirement, candidate, evidence` | `unrelated` |
| Found mutation | `evidence, requirement, candidate` | `may_violate` |
| Reduced mutation | `evidence, candidate, requirement` | `may_violate` |

The original and reduced counterexamples each reproduced the same violation
in all eight A/A′/B blocks, with zero control violations. Shrinking made six
screening calls and **24 new final-confirmation calls**. Those 24 observation
IDs are distinct from the original confirmation. The result is empirical:
origin cache freshness and statistical independence remain unknown.

**3 → 2 means moved key positions**, not removed fields or shorter payloads.
Each payload remains 2,349 bytes. The shrink result says `reduced`, not globally
minimal. No judgment is made here about which answer is factually correct.

The exact reduced finding was added to a separate local README-demo corpus and
explicitly accepted as a regression. The [corpus index snapshot](assets/readme-corpus.json)
names child finding `9369a216c7da4088f66115a4` as its source. The animation claims
it is saved; it does not claim the application was fixed or a post-fix check passed.
The earlier release corpus used a different finding with an identical input
pair; that earlier save is not used as evidence for this step.

## Reproduce the image

```sh
node scripts/render-readme-demo.mjs
node scripts/render-readme-demo.mjs --check
```

The [generator](../scripts/render-readme-demo.mjs) derives key orders, decisions,
confirmation counts, model, and corpus status from the checked-in evidence.
The [manifest](assets/readme-demo.json) records the source hashes and display
scope. No credentials, HTTP headers, or local endpoint configuration are included.
The SVG uses embedded CSS with a static reduced-motion view and no scripts,
external fonts, or network resources.

The source shrink report is retained byte-for-byte with SHA-256
`08949a719896d3aacc9f397158788166d33037f4ca3f16c424b3c0f2962e14c7`.
Original finding: `316b5d0caa25969ee27c72ec`; reduced finding:
`9369a216c7da4088f66115a4`. The original live verification and its limits are
recorded in [provider conformance](provider-conformance.md#v020-cloudflare-live-verification--2026-09-23).
