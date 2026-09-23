# v0.9 local simulator demo

Run `npm run build` and then `node scripts/demo-v09.ts`. The demo uses only `FakeProvider`; it creates a private temporary corpus, demonstrates a synthetic position-sensitive failure, shrinks it, records it, checks the same buggy simulator, and checks a fixed simulator. It prints paths, calls, and result codes.

This is a reproducibility demonstration, not a production claim or field validation. The bundled `routing`, `filter`, and `risk-score` fixtures illustrate Choice, Noul/policy, and Score contract families. Recorded v0.1 tests establish compatibility behavior; this demo is local synthetic evidence; no current live provider result is claimed.
