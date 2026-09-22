# Mutation safety

All transformations are pure seeded structural operations. One recipe represents
one mutation class. Confirmation reuses the identical JSON payload. The seeded
Mulberry32 PRNG and Fisher–Yates shuffle use no platform-dependent collation.

| Class | Safety contract |
| --- | --- |
| question_id_rename | Only map keys change; all returned IDs map back bijectively. |
| question_order | Only question entry order changes; contents stay identical. |
| choice_criteria_order | One Choice map changes order; labels/descriptions stay identical. |
| object_key_order | Content object keys change recursively; arrays and primitive values do not. |
| unordered_array_shuffle | Exactly one explicitly declared array changes order. Score levels cannot be declared unordered. |
| irrelevant_field_injection | One explicitly declared new field/value is added; existing fields cannot be overwritten. |
| text_normalization | Explicit prose paths only: line endings, one trailing newline, outside whitespace, or ASCII space collapse. |

Nothing guesses semantic equivalence. Data that encodes order-sensitive prose
inside a map may violate the user's intended interpretation even though only map
order changes; inspect each counterexample. A stable result samples these
transformations and does not prove universal robustness.

Numeric-looking JSON object keys follow JavaScript enumeration order; no-op and
duplicate serialized requests are omitted instead of pretending they exercised a
different order. Request byte reproducibility is tested across fresh processes.
