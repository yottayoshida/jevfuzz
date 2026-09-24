# Real-workload acceptance protocol

Status: preparation only. No external participant or completed real-workload
fix loop is claimed by this document. Synthetic fixtures and the offline demo
do not count toward field acceptance.

A developer-driven preliminary check on 2026-09-23 used the actual public
[JevFuzz issue #6](https://github.com/yottayoshida/jevfuzz/issues/6) requirement
and the released `src/version.ts` change from `c027851a` to `6195a638`.
The unmodified `jev-intent-review` application request builder produced one
request; JevFuzz evaluated eight structural candidates with 16 Cloudflare
calls to `jev-1.13.0`. No label or report-policy violation was observed, so no
confirmation, shrink, or application fix followed. This single-input direct-API
exercise is not a participant pilot or the planned 20–50-seed evaluation.
The actual app CLI was not claimed to have accepted the issue's heading format.
All acceptance counts remain zero.

On 2026-09-24, a read-only public GitHub code search for `jevfuzz@` returned
no indexed workflow examples. Search coverage is incomplete, so this is not
proof that no one uses the Action; it supplies no participant or usability
observation to count.

A second local preparation selected 20 existing private `jev-sscope` session
states and reconstructed the historical four-question request definition from
application commit `ec0164724c3e003ae55ffecd03854af783799e47`. The built planner
accepted 20 cases and four proposed contracts, yielding 82 candidates and
filtering 40 invalid candidates with zero network calls. These are legacy
normalized input reconstructions, not the current application's two-question
requests or original byte-identical HTTP messages. Data and relation review
remain pending; the campaign's HTTP-attempt ceiling is zero. No participant,
live result, or completed pilot is counted from this preparation.

## Required evidence

The existing v1 design requires three real workload families, two users other
than the author, and two workload families with an actual counterexample →
application fix → regression check. A family means a distinct application
decision, not another question, seed, model, or mutation in the same application.

Record each participant under an agreed pseudonym. Record the application,
decision owner, allowed data, declared relations, setup time, time to understand
the first report, invalid-contract count, replay outcome, and the participant's
assessment. A report with no finding is still a useful pilot observation, but
does not count as a completed fix loop. Count only trials actually performed.

## Candidate applications, not completed pilots

| Candidate | Existing integration boundary | Still needed |
| --- | --- | --- |
| jev-intent-review | Opt-in `JEV_TRACE_FILE` records a normalized Jev request; `jevfuzz import` reads its supported trace format. | A real development task, its owner's relation review, and a usable application fix. Prior public synthetic dogfood does not count. |
| jev-sscope | `buildState` and `askJev` construct the session-evaluation request. The history endpoint contains summaries, not a complete replayable request. | Owner-selected real session data and an explicit request export. No exporter or production change is implied by this protocol. |
| [Neuronpedia explanation scoring](https://github.com/hijohnnylin/neuronpedia/blob/5a880652d1c5dfaaeeded718287aaca6976b4770/apps/webapp/app/api/explanation/score/route.tsx) | Its HTTP route reaches a [TypeSafe-direct Jev scorer](https://github.com/hijohnnylin/neuronpedia/blob/5a880652d1c5dfaaeeded718287aaca6976b4770/apps/webapp/lib/external/autointerp-scorer-jev.ts) with Noul and Score questions, thresholded detection, and persisted application scores. | Whether the route is deployed with a configured key, an owner-approved real request and relation, and any JevFuzz trial or user assessment remain unverified. No TypeSafe-direct live run is assumed. |
| [Omi conversation relevance](https://github.com/BasedHardware/omi/blob/ba1f71d03cb4e3d1c333149bf2c7561f167e3909/backend/utils/conversations/relevance_jev.py) | The application defines a Noul `worth_keeping` question and a threshold-based keep/discard decision. Its [client](https://github.com/BasedHardware/omi/blob/ba1f71d03cb4e3d1c333149bf2c7561f167e3909/backend/utils/llm/jev_client.py) uses an OpenRouter-backed gateway. | The [deployment flag defaults off](https://github.com/BasedHardware/omi/blob/ba1f71d03cb4e3d1c333149bf2c7561f167e3909/backend/config/jev_decisions.py); deployed use, the exact request, owner-reviewed relations, and provider/model comparability are unverified. |
| [Omi memory ownership](https://github.com/BasedHardware/omi/blob/ba1f71d03cb4e3d1c333149bf2c7561f167e3909/backend/utils/conversations/owner_jev.py) | A distinct application decision asks a Choice question and changes third-party attribution only when `P(user) >= 0.9`. | Its flag also defaults off. A real owner-controlled request and deployment evidence are needed; the public question definition or benchmark labels alone are not a completed pilot. |

A read-only search also found [Dub's malicious-link decision](https://github.com/dubinc/dub/blob/279ff7312f4369c2ef3f84a51a41eb1adaac4be8/apps/web/lib/api/links/malicious-link-check.ts), which asks a Boolean question through the AI SDK and applies `0.5` and `0.8` probability thresholds. The v0.9 JevFuzz contract is Choice/Noul/Score, so this is discovery evidence, not a runnable pilot or a reason to silently change its request semantics. Omi's two decisions are candidate families, not confirmed deployments or JevFuzz users.

The two participants and a third completed workload must be evidenced before their
acceptance rows can be completed. JevFuzz is already available as a self-service
GitHub Action; its owner is not required to nominate participants or select their
repositories. Public uses can be discovered and assessed, but a workflow file
alone does not prove that another developer understood a result. Recruiting or
contacting people is a separate action requiring authorization. Provider keys
and business payloads are never part of a public pilot record.

## Per-workload procedure

1. Have the owner choose a real request already appropriate for the selected Jev
   provider. Keep the exact normalized request privately and record its hash.
   Do not import historical responses as new confirmation evidence.
2. Have the owner approve each relation and reducer. Write a version-2 campaign
   using the existing campaign schema and migration guide. Preserve provider,
   model, questions, policy, and the intended meaning of the application.
3. Set explicit logical, HTTP-attempt, time, confirmation and shrink budgets.
   Run `jevfuzz plan campaign.json --json` and retain the plan. Select the
   empirical profile unless the provider meets the statistical assumptions.
4. Run `jevfuzz fuzz campaign.json --require-confirmation-complete --json`.
   Keep the report and record its exit code, evaluated and pending scope, model,
   actual costs, and evidence profile. A confirmed violation exits 1; an
   inconclusive or incomplete run must not be recorded as a healthy target.
5. For a confirmed finding, run `jevfuzz replay finding.json --out replay.json`
   and `jevfuzz shrink finding.json --out smaller.json`. Retain the original,
   reduced result, lineage, fresh observations, and minimality status. A budget
   limit or failed final confirmation is part of the result.
6. Ask the participant to explain the declared relation, the trigger, the
   observed effect, and the evidence limits in their own words. Record whether
   this was possible within the original 30-minute usability target. Do not
   replace their observation with an agent-written assessment.
7. Explicitly accept the reviewed case using `corpus add` and `corpus triage`,
   following the migration guide. Preserve the pre-fix corpus check.
8. Apply a real application change selected by its owner. Record its exact
   diff and commit. Do not weaken the contract, remove the failing fixture,
   loosen the acceptance threshold, or label the historical answer as truth.
9. Re-evaluate with new observations. When target identity is unchanged, use
   `jevfuzz check`; when questions, policy, or model change, use an explicit
   compatible `jevfuzz compare experiment.json` as documented. Retain the
   target mapping and both source identities. Include at least one healthy
   case to check for collateral regressions.
10. Count a fix loop only when the original violation is confirmed, the owner
    accepts the application change, fresh post-fix evaluation supports the
    same relation, and healthy cases remain acceptable. Record unresolved and
    inconclusive outcomes without counting them as successes.

## Private record template

Create one record per real trial in a private location. Empty fields mean
pending, not passed. Link artifacts by local path and SHA-256; publish only an
owner-approved redacted account. Payloads and participant contact details stay
outside the repository.

```text
trial_id:
date:
participant_pseudonym:
participant_is_not_author:
workload_family:
application_revision:
decision_owner:
real_task_description:
approved_input_scope:
request_hash:
campaign_hash:
provider_and_observed_model:
relations_and_owner_review:
plan_and_budget:
setup_minutes:
first_report_understanding_minutes:
participant_explanation_and_assessment:
invalid_contracts_and_triage:
pre_fix_report_and_replay:
shrink_result_and_limit:
accepted_corpus_entry:
application_fix_diff_and_revision:
target_mapping_if_changed:
fresh_post_fix_result:
healthy_case_result:
actual_logical_and_http_attempts:
artifact_paths_and_hashes:
outcome: pending | no-finding | inconclusive | reproduced | fixed-and-rechecked
counts_toward_workload_acceptance:
counts_toward_fix_loop_acceptance:
```

Do not infer participant independence, real deployment, or successful fixes
from the existence of this template. The final acceptance ledger must link the
actual records for all required participants, families, and fix loops.
