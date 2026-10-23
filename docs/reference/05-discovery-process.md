# ARTIFACT 05 — DISCOVERY PROCESS

**Status:** Draft for Ely + Steven review — 2026-10-22
**Serves:** Phase 2 of the engagement (governance blueprint), feeding TA-02, TA-08, TA-16
and the Orchestrator's build backlog (artifact 03).

## 0. Why this exists

Varsity's most valuable logic is its business rules — what counts as revenue, what the
expected fee is, when a dispute is worth fighting. At Hometown those rules were discovered
one build at a time and live in code comments, plan docs and people's heads. That does not
transfer. The Hometown rules themselves are **not** kept (Wave 1B removes them); what is
kept is a repeatable way to find, write down and validate a client's rules **before**
anything is built.

The Orchestrator governs *how* we build. Discovery governs *what* we build and *which rules
it must obey*.

## 1. Who does what

| Role | Who | Owns |
|---|---|---|
| **Facilitators** | Ely, Steven | The client relationship, running sessions, judgment calls, sign-off with the client |
| **Discovery Guide** | Claude | Preparing each session, tracking coverage, drafting rule cards, flagging gaps and conflicts, enforcing the gates |
| **Rule owner** | A named client person per rule | Confirming the rule is right; the card is not final without them |

**Hard line:** Claude drafts and challenges; it never signs off a rule. A card becomes
`approved` only on a recorded human sign-off from the rule owner, captured by a
facilitator. This mirrors the Orchestrator's split — the scribe proposes, it does not
decide (TA-08).

## 2. Stages

Same shape as the Orchestrator: numbered stages, each with a gate the Guide checks before
moving on. Gates report PASS / FAIL / SKIPPED — never a silent pass (PR-04).

| Stage | What happens | Guide does | Gate |
|---|---|---|---|
| **D0 Intake** | Client, goals, the 3–5 workflows they want agents for | Drafts the session plan and stakeholder map | Workflows named, each has a sponsor |
| **D1 Landscape** | Systems, data sources, CRM, who owns what | Builds the draft knowledge-source registry (TA-02) | Every workflow has at least one named source and owner |
| **D2 Rule capture** | Interviews per workflow | Supplies a question bank per rule type (§4); turns notes/transcripts into draft cards; tracks which card fields are still empty | Every workflow has its rules carded; no `required` field empty |
| **D3 Challenge** | Facilitators review drafts | Runs the conflict pass: same term defined twice, a metric with no audience rule, a write action with no human gate, a rule with no test case | Zero open conflicts, or each one logged with an owner |
| **D4 Validate** | Rule owners confirm | Generates worked examples and test cases from each card for the owner to check | Each card `approved` with owner + date |
| **D5 Map** | Choose what to build | Matches cards to agent templates (TA-16); proposes the domain-authority slot (TA-08) | Each workflow mapped to a template or flagged as custom |
| **D6 Hand-off** | Feed the build | Emits profile entries + an Orchestrator build backlog, each item citing its cards | Backlog items reference only `approved` cards |

A rule found **during a build** goes back through D2–D4 as a single card rather than being
coded straight in. That is the gap the Hometown history shows most clearly.

## 3. The rule card

One card per rule. Stored in the client profile under `rules/`, versioned with the repo.
Draft schema:

```yaml
id:            REV-001
name:          Platform revenue
type:          metric_definition        # see §4
status:        draft | challenged | approved | retired
owner:         { name: , role: }        # client person who confirms it
definition:    plain-language statement a non-technical person agrees with
formula:       precise version — columns, filters, arithmetic
sources:       [registry ids from D1]
audience:      who may see it / who must never see it
time:          timezone, window, as-of rules, late-arriving data
edge_cases:    [ ... ]
exclusions:    what it explicitly is NOT (often the most valuable field)
failure_modes: how it can go wrong silently, and how that is detected
actions:       any write to an external system, and the human gate on it
tests:         worked examples with expected outputs (min 2)
provenance:    who said it, when, in which session
approval:      { by: , date: , note: }
history:       sanctioned changes, newest first
```

Required for `approved`: `definition`, `formula` or `steps`, `sources`, `owner`, `tests`,
`approval`. `failure_modes` and `actions` are required for the types that need them (§4).

## 4. Rule types

Taken from the shape of the Hometown rules, not their content.

| Type | What it is | Extra required fields |
|---|---|---|
| `metric_definition` | A number and what it means | `audience`, `exclusions` |
| `derived_metric` | A number computed from other rules or config, usually compared against an expectation | `failure_modes`, `time` |
| `classification` | Putting records into buckets | `edge_cases` (the ambiguous records) |
| `exception_workflow` | Detect a case → gather → decide → act | `actions` with a human gate, `failure_modes` |
| `access_rule` | Who can see or do what | Feeds the decision service (TA-01) |
| `data_quality_guard` | A check that data is fit to use before a rule runs | `failure_modes` |

Each type carries a **question bank** the Guide works through in D2 — e.g. for
`metric_definition`: "What does this *not* include?", "Who would be embarrassed if the
wrong person saw this number?", "Name two records where people would disagree."

## 5. Relationship to BMAD

BMAD (kept for V1) already has facilitated planning workflows — `bmad-domain-research`,
`bmad-product-brief`, `bmad-prd`. Before building anything, check whether Discovery can be a
configured BMAD flow with the rule card as its output artifact. Building our own is the
fallback, not the default.

## 6. Trial

The original trial used three cards drawn from the reference implementation's real business rules. They are not carried into this repo. Rerun the trial on the demo client's rules.

## 7. Open questions

| | Owner | Question |
|---|---|---|
| ⚪ | **Ely** | V1 or later? Suggest V1 ships the card schema, the six types and this doc; the Guide skill follows after Wave 1B |
| ⚪ | **Ely / Steven** | Do clients see the rule cards directly, or a generated "rulebook" document? |
| ⚪ | Claude | BMAD fit check (§5) |
| ⚪ | **Ely / Steven** | Where session transcripts come from (Zoom/Gong/Meet) and whether the client consents to Claude processing them |
