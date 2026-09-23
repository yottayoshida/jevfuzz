# Package verification

`scripts/capture-v01.ts` reconstructs the public v1 compatibility fixture from
the immutable `v0.1.0` tag. Its recorded target is
`c027851a25f8000a6368e9f11cae5209d3ddd2b9`. The fixture uses a deterministic,
position-sensitive `FakeProvider`: moving the first question changes the Noul
answer. `test/compat-v01.test.ts` verifies current `loadConfig`, `run`,
`loadFailure`, and `replay` against the tagged report's recipe/verdict oracle.

Run the complete local package check with:

```sh
node scripts/verify-package.ts
```

It requires v2 `fuzz` to exit `1`, report `status: "complete"`, and persist its
finding before replay and shrinking use that persisted file. It then adds the
finding to a temporary corpus, explicitly triages it as `accepted_regression`,
and proves `check` makes fresh provider observations. It runs `npm pack --json`, then creates a clean temporary installation with
`npm install --offline --ignore-scripts --omit=dev <tarball>`. The installed
`.bin/jevfuzz` is invoked through `node --import <http-stub>` for `doctor`, v1
`plan`, `run`, and `replay`, then v2 `plan`, `fuzz`, `replay`, `shrink`, `corpus
add`, `check`, and `report`. The preload replaces `globalThis.fetch`, so no
external API call is possible. It records and asserts the TypeSafe endpoint,
raw JSON payload, bearer authorization, and `Cache-Control: no-cache, no-store`.

Local v0.2.0 verification on 2026-09-23 passed on Node **22.18.0**, **24.0.0**,
and **26.7.0**. Each clean installation had zero production dependencies and
made 44 intercepted HTTP calls. No request reached a live provider. The command
also replays the nested shrink result and explicitly triages the corpus entry;
these are separate installed-bin invocations.

The complete source suite passed 172 tests on each runtime with zero skips.
Node 24.0 prints its experimental TypeScript-stripping warning for source tests;
the distributed CLI is compiled JavaScript. Package SHA-256 is emitted by each
verification run and identifies that exact tarball, including its documentation.
No npm publish, GitHub release, current-head CI, or live-provider test is implied.
