# ARTIFACT 02 — COMPETITIVE AND INDUSTRY RESEARCH

<!-- doc-id: pk-02-competitive-research -->
<!-- version: 1.0 -->
<!-- created: 2026-10-22 -->
<!-- research-method: 6 parallel research agents + 2 targeted round-2 gap closures -->
<!-- raw-notes: ./research_notes/Governed internal AI agent platforms/ -->
<!-- companion-artifacts: 01-current-state.md, 03-target-build.md -->

---

## 0. DOCUMENT CONTRACT

```
PURPOSE      Competitive and industry analysis of governed internal AI agent
             platforms, conducted to (a) adjudicate the novelty claims implied
             by artifact 01, (b) identify capability gaps against the field,
             and (c) establish defensible market positioning.

AUDIENCE     AI agents (primary). Loaded as context for artifact 03 and the
             pitch deck. NOT optimized for human reading.

BENCHMARK    "The benchmark" = the Varsity-derived three-layer platform
             inventoried in 01-current-state.md. Cross-references use that
             document's IDs (L1-A-004, L2-A-007, etc.).

ID SCHEME    C-nn    Competitor / entity profile
             CL-nn   Benchmark claim under adjudication
             GAP-nn  Capability the field has that the benchmark lacks
             MKT-nn  Market / demand finding
             BLK-nn  Blacklisted claim — do not use
             IDs are STABLE. Append only.

CRITICAL     This document contains FINDINGS THAT CONTRADICT the benchmark's
             positioning. Those are the most valuable content here. Section 3
             (CLAIM ADJUDICATION) is the operative section — read it before
             writing any external-facing material.

DATE         All findings current as of 2026-10-22. The agent platform market
             is changing monthly; treat anything undated as needing re-check
             before external use.
```

## 0.1 SOURCE RELIABILITY GRADING

```
GRADE  MEANING                                    USE
P1     Primary source, retrieved and read in      Quote freely
       full (vendor docs, vendor engineering
       blog, academic paper full text)
P2     Primary source, retrieved partially or     Quote with attribution
       via snippet
S1     Reputable secondary, consistent across     Use, attribute as secondary
       multiple independent sources
S2     Single secondary source, or competitor-    Flag explicitly or omit
       authored
X      Could not retrieve / contradicted /        DO NOT USE (see §8)
       traced to no credible origin

FETCH FAILURES ENCOUNTERED (all flagged inline where relevant):
  gartner.com              403 to automated fetch
  openai.com               403 to automated fetch
  theregister.com          404
  arc.responsible.ai       client-rendered JS app, title only
  openai.com/index/ramp/   403, and its one syndication also 403
  G2 / Gartner Peer        could not retrieve review text directly
  Insights
```

## 0.2 COVERAGE AND KNOWN HOLES

```
COVERED      Glean, Dust, Microsoft (Copilot Studio / M365), Google
             (Agentspace / Gemini Enterprise), Salesforce (Agentforce),
             OpenAI (AgentKit / Agent Builder), AWS (Bedrock / AgentCore),
             Ramp (+ Glass), Uber, Stripe, Shopify, Block, AI code review
             (CodeRabbit, Greptile, Cursor Bugbot, Graphite Diamond, Qodo),
             eval platforms (Braintrust, Langfuse, LangSmith, Phoenix, Weave,
             Galileo, Humanloop), guardrails (NeMo, Guardrails AI, Bedrock,
             Lakera, Protect AI, Credal), orchestration (Temporal, LangGraph,
             Inngest, CrewAI), platform-engineering/IDP literature, services
             market.

NOT COVERED  ChatGPT Enterprise custom GPTs (REAL HOLE — OpenAI's stated
             migration target for Agent Builder users).
             OpenAI Workspace Agents governance.
             Stack AI, Relevance AI, Snyk/Semgrep AI governance features.
             Slalom's agent practice (nothing found).
             Platform vendors' own professional-services arms.
             Klarna, Duolingo, Zapier, Intercom, Airbnb in-house builds.

SYSTEMIC     No credible public precision/recall figure exists for ANY AI code
HOLE         review product. No independent study of reviewer fatigue exists.
             No authoritative benchmark of classifier vs deterministic
             guardrail bypass rates exists. Multiple sources confirmed these
             absences independently.
```

---

## 1. MARKET STRUCTURE AND DEMAND

### MKT-01 | The statistics most likely to be reached for are liabilities
```
GRADE   S1 (the critiques), X (the headline numbers)
FINDING Three widely-cited statistics do not survive scrutiny:

  (a) MIT NANDA "GenAI Divide" (Aug 2025), popularly "95% of AI pilots fail."
      ACTUALLY MEASURED: "no measurable P&L impact" across ~300
      non-randomly-sampled projects. Documented critique: most pilots had no
      pre-deployment P&L baseline, so the finding may reflect MISSING
      MEASUREMENT rather than failed deployment. Secondary sources conflict on
      sample size (150/350/300 vs 52/153/300+). Primary PDF not retrieved.

  (b) Gartner "40% of agentic AI projects canceled by 2027."
      ACTUALLY: a June 2025 PREDICTION, repeatedly misdated as fresh 2026
      research. Gartner press release 403s to automated fetch so exact wording
      is unverified. Named causes: escalating cost, unclear value, INADEQUATE
      RISK CONTROLS.

  (c) IDP-side equivalents: "80% of internal developer platforms fail"
      (attributed by its own author to an unpublished personal audit) and
      "64% of developers bypass the platform" (traces to an unlinked report).

USE     Do not cite (a) or (b) as evidence of failure rates. (b)'s named
        causes ARE usable, attributed as a 2025 Gartner prediction. (c) is
        blacklisted entirely — see BLK-01, BLK-02.
NOTE    The MIT critique cuts both ways and is worth internalizing: if buyers
        do not baseline, an outcome-based pricing model is unsafe, and so is
        any outcome claim WE make. See MKT-07.
```

### MKT-02 | The wedge statistic
```
GRADE   S1
SOURCE  OutSystems survey, ~850 IT decision-makers
FINDING 83% oversee AI agents using existing IT / security / compliance
        processes. Only 5% have automated controls, audit trails, AND formal
        human review points in place.
WHY     That 5% maps one-to-one onto the benchmark's three differentiator
        clusters: mechanical enforcement (L2-A-003), immutable audit
        (L1-A-006), and gated human review (L2-A-009).
USE     THIS IS THE LEAD STATISTIC. It establishes the gap without claiming
        anyone failed.

SUPPORTING:
  VentureBeat Research (573 respondents, June 2026): two-thirds gate
  production on automated evals that ONLY 5% FULLY TRUST. Direct demand
  signal for deterministic verification (L2-A-014, L2-A-015).

  Okta (n=150, Jan 2026): 49% say audit trails are critical for production
  readiness; 69% say security is slowing adoption.

  Agent credential study: firms sharing agent credentials reported
  incidents/near-misses at 63.5% (47/74) vs 40.9% (9/22) where every agent
  has a scoped identity. SMALL N — directional only. Note this cuts AGAINST
  the benchmark, which has no agent identity model (GAP-01).
```

### MKT-03 | Agent sprawl is named, quantified, and analyst-endorsed as needing proportionality
```
GRADE   S1 (Gartner release itself 403'd; all wording via secondary summaries)
SOURCE  Gartner, 2026-04-28, six-step agent governance guidance. Analyst: Max Goss.
FINDING Fortune 500 orgs averaged FEWER THAN 15 agents in 2025.
        Projected MORE THAN 150,000 by 2028.
        Only 13% of orgs believe they have the right agent governance.
        Gartner EXPLICITLY WARNS AGAINST one-size-fits-all governance because
        agents differ in autonomy and trust boundary.
WHY     The last point is an analyst endorsement of risk-proportionate
        ceremony — i.e. of L2-A-003 and L2-A-022 — from the firm the buyer's
        boss reads.
GAPS    Gartner's step 3 (review schedule) and step 5 (drift detection) are
        the two steps vendors cover LEAST. Those map to L1-D-006 and L2-D-012,
        both of which the benchmark is also missing. Opportunity, not
        advantage.
CAVEAT  Re-verify wording from the Gartner original before external use.
```

### MKT-04 | Vendor response to sprawl is universally a registry
```
GRADE   P1 (vendor docs)
FINDING Every major vendor's answer to agent sprawl is a REGISTRY — asset
        management: how many agents exist, who owns each, can we kill it.
        None of them addresses whether an agent should have been built, or
        whether it still works.
IMPLICATION
        "Inventory is not governance" is a defensible, evidence-backed wedge
        line. The registry answers WHAT EXISTS. The benchmark answers WHETHER
        IT IS CORRECT AND WHO SAID SO.
```

### MKT-05 | The labs entered services directly in 2026, and ceded the mid-market
```
GRADE   S1 (valuations conflict across sources)
FINDING OpenAI Deployment Company (>$4bn, 19 partners, ~150 forward-deployed
        engineers, acquiring Tomoro).
        Anthropic "Ode" with Blackstone / H&F / Goldman (>$1.5bn, $100m
        partner network). Claude Frontier Academy targeting 10,000 FDEs by
        end-2027, drawn mainly from customer and partner staff.
        Microsoft Frontier (~$2.5bn, ~6,000 engineers). AWS ($1bn).
STRUCTURAL
        Principal FDE compensation reportedly >$1.2M, and talent concentrates
        in anchor accounts. The mid-market is ceded for DURABLE UNIT-ECONOMICS
        REASONS, not temporarily.
IMPLICATION
        The boutique's space is structural, not a closing window. Also:
        Anthropic's Academy is a plausible credentialing channel for a
        two-person practice — worth direct inquiry.
```

### MKT-06 | Services pricing
```
GRADE   S1 / S2 (only verifiable day rates are stale UK public rate cards:
        Deloitte GBP 450-2,450/day, G-Cloud 14, 2024)
FINDING Boutique market structure is consistent across sources:
          $5-25K   assessment
          $75-150K build
          $5-12K/mo retainer
MODELLED
        A defensible five-phase ladder lands at $200K-$350K total — roughly
        1-2 months of a comparable Big 4 program.
GUIDANCE
        Fixed-fee phases over day rates. Enablement priced as MANDATORY, not
        optional (see MKT-09). AGAINST outcome-based pricing at entry, because
        buyers do not baseline (MKT-01).
VOID    NO FIRM AT ANY TIER PUBLISHES AN ENGAGEMENT SUCCESS RATE. This makes
        a single production reference disproportionately valuable — there is
        no benchmark against which to look small.
```

### MKT-07 | Consumption pricing taxes thoroughness
```
GRADE   P1 (vendor docs)
FINDING Salesforce meters test runs in credits and caps suites at 1,000 cases
        / 10 concurrent jobs in a 10-hour window.
        Microsoft charges per interaction at 1 to 200+ credits per message
        depending on how the agent is built.
IMPLICATION
        On a metered platform, the more rigorously you test, the more you pay.
        Deterministic local verification (L2-A-014) does not meter itself.
        This is a clean economic argument, grounded in primary docs.
```

### MKT-08 | Platform risk is now demonstrable, not theoretical
```
GRADE   P2 (shutdown date confirmed on OpenAI's own deprecations page; the
        wind-down banner quoted via secondary because openai.com 403s)
FINDING OpenAI Agent Builder: announced 2026-06-03, SHUTDOWN 2026-11-30 —
        approximately 13 months after its October 2025 launch. Evals
        reportedly goes read-only 2026-10-31. Migration target is the Agents
        SDK or Workspace Agents.
        CRITICAL: export produces Agents SDK CODE, NOT A CONVERTIBLE GRAPH.
        It is a rebuild, not a migration.
IMPLICATION
        The single best citable argument for "your agent estate should be your
        own reviewed artifacts in your own repository, not a vendor's
        proprietary definition format." This argument previously required
        hypotheticals. It now has a date.
```

### MKT-09 | The internal-platform adoption lesson
```
GRADE   S1
FINDING Backstage: ~10% typical adoption vs Spotify's claimed ~99%. Same
        software. Succeeded where it had PRODUCT OWNERSHIP, failed where it
        was merely installed.
        Field consensus: "You cannot mandate adoption; you must compete for
        it."
        Best-documented IDP failure mode is "GOLDEN CAGE SYNDROME" — platforms
        built for CONTROL rather than CONSUMPTION get routed around.
IMPLICATION
        (a) Enablement must be priced as mandatory, not optional.
        (b) THIS IS THE BENCHMARK'S MOST DANGEROUS OBJECTION. See §6.
VOID    No quantitative comparison of voluntary vs mandated internal platform
        adoption exists. The field's position is unanimous practitioner
        consensus plus Gartner on agents ("blocking pushes people to riskier
        shadow use") — but it is NOT MEASURED.
```

### MKT-10 | Business-model precedent
```
GRADE   S1
FINDING Closest researched analogue for productizing an internal framework is
        TEAM TOPOLOGIES: small authoring practice, named framework, 12-week
        accelerator sold direct, delivery LICENSED TO ACCREDITED PARTNERS.
WHY     Decouples revenue from two founders' calendars — the structural
        constraint on any two-person practice.
GAP     Their partner licensing terms are not public. Requires direct inquiry.
```

---

## 2. COMPETITOR PROFILES

### C-01 | GLEAN
```
CATEGORY  Horizontal enterprise agent platform (category leader)
ARCH      Knowledge graph + connector fleet + permissions-aware index.
          Glean Assistant, Glean Agents / Agent Builder.

PERMISSIONS
  ALLOW-LIST ONLY: allowed_users, allowed_groups,
  allowed_group_intersections (an OR of ANDs). NO DENY PRIMITIVE EXISTS.
  Enforcement is query-time index filtering after resolving the user's groups
  across sources.
  [P1] Docs explicitly do NOT cover caching, ACL/identity resync cadence, or
  propagation of identity changes to already-indexed documents. Success-only
  caching and query-time-failure behavior are UNANSWERABLE from public sources.

FAILURE SEMANTICS — THE SHARPEST FINDING IN THIS DOCUMENT
  [P1] Agent access policies are EXPLICITLY FAIL-OPEN: "a configuration error,
  such as a typo or unknown field, makes the rule a no-op, and the tool call
  proceeds." Expression timeout ALSO allows the call.
  [P1] Skill scanning is fail-open too — High/Critical findings do not block,
  and a FAILED SCAN does not block.
  [P1] But the retrieval layer fails CLOSED AND SILENT: "An ACL naming a group
  Glean has never heard of matches nobody." Documents referencing an unknown
  group become invisible to everyone, with no signal.
  NET: neither layer has a distinguishable "could not determine."
  This is DOCUMENTED-OPPOSITE to L1-A-004, not merely absent.

GOVERNANCE
  [P1] Approval gate keys off SHARING SCOPE, not risk. Three admin settings:
  Never / company-wide only / any shared agent. NOTHING keys off write tools
  or sensitive connectors.
  [P1] "Approval settings apply only to users without the Agent Creator role"
  — a DOCUMENTED SELF-APPROVAL PATH.
  [P1] Merge = release. Moderator Approve/Publish makes it live. No staged,
  percentage, or cohort rollout documented. A staged version + diff summary
  exists, but a documented path exists where the diff fails ("This version is
  not available for comparison") and publish still proceeds.

EVALUATION
  Internal eval stack is mature (LLM judges calibrated to human SMEs, trace
  capture/replay, versioned experiments, launch gating — per their own job
  postings). Customer-facing built-in agent evals are PRIVATE BETA as of Aug
  2026. A customer on Glean's own community forum reports no way to run prompt
  sets in bulk or compare experiments.
  [P1] Published methodology RECOMMENDS LLM grading — the direct inverse of I8.

STATUS DISCIPLINE
  The Aug 2026 Glean:GO blog labels agent identity = public beta, built-in
  evals = private beta, agent scanning = beta. NOTHING IS LABELED GA. Agent
  access policies page says "in beta and may change." Treat ALL agent-
  governance capability as beta-grade.

COMMERCIAL
  Governance is a PAID UPSELL: agent access policies require Glean Protect+;
  sensitive-content scanning requires Glean Protect; skill scanning is a
  billed advanced feature. Base Glean gets permission mirroring + publish
  approval, NOT runtime policy enforcement.
  PRICING: no primary source reached. Estimates span $10-75/user/mo, mostly
  competitor blogs citing aggregators secondhand. ~100-seat minimum and ~$60k
  entry contract most consistently repeated. DO NOT QUOTE A NUMBER.

GLEAN ADVANTAGES OVER BENCHMARK
  Connector fleet with per-source ACL translation; Slack real-time
  zero-copy query-time retrieval; CEL pre/post-tool-call policies with a
  Filter action returning sanitized partial results; prompt-injection scanning
  of authored artifacts; semantic flagging of over-provisioned write tools;
  agent identity with its own scoped credentials; sensitive-content autohide;
  Microsoft Purview label integration; force-installable browser extension;
  admin "Verify access" tool; NL authoring + templates + Academy; content
  triggers and channel presence; vendor-run platform evals; SIEM export on by
  default; customer-hosted GCP/AWS option; vendor scale.

HONEST LIMITS OF THIS PROFILE
  Could not retrieve G2 or Gartner Peer Insights text. Everything
  review-derived is via aggregators or competing vendors. One competitor claim
  ("Glean does not execute workflows") is CONTRADICTED by Glean's own
  documented write tools. The strongest real limitations found are in Glean's
  OWN docs, not reviews: retrofitting permissions requires re-indexing
  everything; unknown groups hide docs from everyone.
  NO CITATION/PROVENANCE SPECIFICATION FOUND. Assistant visibly shows
  citations, but no doc describes whether citations are verified against
  retrieved passages or whether provenance is retained for audit. Recorded as
  a GAP IN EVIDENCE, not a proven capability gap.
```

### C-02 | DUST
```
CATEGORY  Horizontal agent platform, builder-centric, open source (MIT)
ARCH      Agents are declarative config objects — handle, prose instructions,
          model, knowledge (4 retrieval primitives: search / table-query /
          extract / include), tools, skills. Rust backend, Next.js front end,
          Temporal Cloud for orchestration and connector sync, own model
          gateway.
          [P1] Dust Apps (the graph/block workflow layer) are DEPRECATED — no
          new apps creatable since Oct 2025. The escape hatch is now "write an
          MCP server," a strictly higher developer bar.
          Replacement unit of reuse is SKILLS: versioned prose bundles of
          instructions + knowledge + tools, lazily loaded by agent judgment,
          with diffs and authorship.
          2026 additions: Pods (shared human+agent workspaces with an
          AGENTS.md), Frames (agent-generated embeddable artifacts), triggers.

PERMISSIONS — MOST CONSEQUENTIAL GOVERNANCE FACT
  [P1] An agent inherits the data access of the space(s) it was built from,
  PERMANENTLY, REGARDLESS OF WHO USES IT. Default requires users to hold all
  source spaces, but ADMINS CAN OVERRIDE TO WIDEN THE AUDIENCE — per-agent
  human judgment with no review attached.
  [P1] Permissions are ADDITIVE ACROSS GROUPS. No deny rule, no precedence, no
  conflict resolution documented. (Second platform with no deny primitive.)
  Dust explicitly REJECTS source-ACL mirroring for its synced knowledge layer,
  calls the extra layer "overhead," and justifies it by warehouse analogy.
  They advocate "public by default — private when necessary."
  Live MCP/OAuth tool calls are the exception (they run as the authenticated
  user, so they are source-bound) — so an enterprise reasons about TWO
  DIFFERENT PERMISSION SYSTEMS per agent.

GOVERNANCE
  Runtime-gated, NOT release-gated. No review, no approval, no risk
  classification, no staged rollout, no canary. Publish is a single binary
  flag.
  [P1] "Create agents" and "Publish agents" DEFAULT TO EVERYONE in a new
  workspace.
  Closest thing to review: accept/decline "review cards" for agents/skills
  changed FROM A CONVERSATION (shipped 2026-09-30) — self-acknowledgment, not
  independent review.
  WHAT DUST DOES HAVE, AND IT IS STRONG: per-tool-call human approval graded
  by MUTATION RISK (reads free; writes/deletes/raw-SQL/publish need a click);
  a 600-credit circuit breaker; configurable credit checkpoints; model access
  tiers with per-member caps; group budgets; tool-restricted-to-space and
  tool-only-usable-through-a-skill; Admin/Manager/Member with delegated group
  managers; Enterprise audit logs.

EVALUATION — EFFECTIVELY NONEXISTENT, AND DUST SAYS SO
  [P1] Official troubleshooting page documents no eval framework, test suite,
  regression testing, or observability. A 342,000-character changelog contains
  ZERO eval/testing entries. Founders on record: evals deprioritized, "bigger
  product problems," future direction is LLM-as-judge.
  Documented method is "iterate in the preview area until outputs look
  consistent." Quality signal = thumbs + 30-day usage.
  COMPOUNDING RISK: a SKILL EDIT PROPAGATES IMMEDIATELY to every consuming
  agent, with no regression suite and no dark state. This is precisely the
  benchmark's wiki-is-T2 coupling (L1-A-012 RISK), unmitigated.

TWO FAIL-QUIET BEHAVIORS
  [P1] YAML/API agent import SILENTLY SKIPS a tool it cannot set up and STILL
  CREATES THE AGENT.
  [P1] Member removal or SCIM deprovisioning PERMANENTLY DELETES that member's
  triggers, unrestorable, and the trigger.deleted audit event is emitted
  WITHOUT schedule or instructions — hard delete with a lossy trail. Audit
  logs are Enterprise-only, so Business customers have none.

ADOPTION — THE TRANSFERABLE DATAPOINT
  Across Dust's best-documented customers, 20-30% OF EMPLOYEES HAVE BUILT AN
  AGENT (Mirakl 30%, targeting 50%; an unnamed 3,000-person enterprise 20%).
  Platform-wide self-reported: >3,000 orgs, 41k MAU (Apr 2026), 300k agents,
  >90% monthly / >70% weekly active, zero churn 2025.
  Dust's own numbers conflict internally (41k vs 51k MAU; 60-70% vs >70%
  weekly) — present as a range.
  $40M Series B 2026-05-18 (Abstract + Sequoia, with Snowflake and Datadog),
  >$60M total.
  SIGNIFICANCE FOR BENCHMARK: this is the strongest available evidence that a
  non-technical builder cohort WORKS AT SCALE. It supports L2-D-001 being a
  config problem rather than a second product — while simultaneously raising
  whether the benchmark's ceremony is proportionate for that population.

SURFACES — DUST'S CLEAREST LEAD
  Web, Slack (incl. auto-reply without @mention, auto-join beta), Teams,
  Zendesk agent-assist, email forwarding, Chrome/Firefox extension, Raycast,
  Google Sheets add-on, white-labeled Frames, REST + JS SDK + CLI, and
  Dust-as-an-MCP-server. ~50 tool integrations incl. Snowflake, Databricks,
  BigQuery, Power BI.

PRICING [P1, Dust's own page, ex-VAT]
  Credit-metered seats since mid-2026 — DISCARD any source citing flat
  $29/user/mo.
  Free EUR 0 / 500 lifetime credits.
  Pro EUR 24/seat/mo annual (EUR 30 monthly), 8,000 credits.
  Max EUR 120/seat/mo annual (EUR 150 monthly), 40,000 credits.
  Credits do not roll over. Business capped at 100 people, 3 connectors, 5
  Spaces, 5 remote MCP servers. API usage $0.01/credit. Enterprise
  sales-quoted, no published floor.
  Governance is an ENTERPRISE UPSELL: audit logs, SCIM, custom retention,
  single-tenant, unlimited connectors are all Enterprise-only.

GAPS IN THIS PROFILE
  No neutral Dust-vs-Glean comparison exists publicly — everything in that
  shape was competitor-authored and was discarded. No churn-reason data, no
  independent adoption measurement, no audit-log retention period, no
  Enterprise price floor. UNVERIFIED: whether Dust mirrors source ACLs at
  document granularity for any connector; whether agent INSTRUCTION history is
  versioned (skills are; agents are not documented as such); whether any
  caching layer exists. Docs carry role-vocabulary drift (Builder deprecated
  for Manager, three pages disagree) — verify "who can build" in-product.
  CAVEAT: Dust is open source, so the actual permission schema is
  source-inspectable. Gap claims here are about what is DOCUMENTED.
```

### C-03 | MICROSOFT (Copilot Studio / M365 Copilot)
```
LIFECYCLE   WINS ON BREADTH. 3 environments + managed solutions + pipelines +
            Git integration + AI-admin activation approval + policy templates
            binding Entra/Purview/Defender + 30-day audit-logged soft delete +
            conditions-based lifecycle rules + a 3-zone risk model.
CRITICAL    [P1] Activation approval reviews METADATA — description, owner,
            data, tools. NEVER BEHAVIOR.
            [P1] Testing doc says "CONSIDER including automated testing as
            part of your deployment pipeline." Advisory, not required.
            [P1] Zone 1 is "anyone can make... read-only, stays private."
            Zone 2's answer to the hard middle tier is literally "OVERSIGHT
            FROM A COACH" — a staffing solution, in a vendor document, where a
            mechanism should be.
FAIL-OPAQUE [P1] Admin governance actions FAIL against agents behind Power
            Platform Firewall in ACTIVE ENFORCEMENT mode — and the PERMISSIVE
            (audit-only) setting is the one where they succeed. A perverse
            inversion worth naming.
            [P1] Sharing is NOT solution-aware, so who can see a production
            agent is set BY HAND outside the ALM pipeline.
PRICING     Per-interaction, 1 to 200+ credits per message depending on how
            the agent is built. (All figures third-party; no vendor price page
            retrieved.)
OPEN        Zone 2 lists "IT-managed review processes" and "IT-admin approval
            to publish agents" in a governance column WITHOUT NAMING THE
            ENFORCING FEATURE. Whether that is a product mechanism or process
            guidance the org must implement itself is THE MOST IMPORTANT THING
            TO VERIFY HANDS-ON IN A TENANT before positioning against
            Microsoft.
```

### C-04 | GOOGLE (Agentspace / Gemini Enterprise)
```
STRENGTH    Runtime containment and continuous eval. Agents as first-class
            directory principals with SPIFFE IDs and IAM permissions.
WEAKNESS    [P1] Primary agents docs describe NO APPROVAL and NO ROLLBACK.
            Versioning primitive (agent revisions + traffic splitting) was
            still PUBLIC PREVIEW as of 2026-05-19 with no GA, while
            Registry / Gateway / Observability went GA 2026-06-18.
EVAL        Autoraters and LLM-as-a-judge. Model-graded.
```

### C-05 | SALESFORCE (Agentforce)
```
STRENGTH    WINS ON RELEASE DISCIPLINE. [P1] "Deployment does not make an
            agent live. A system administrator must explicitly 'activate' it."
            THIS IS DARK-MERGE-PLUS-FLAG-FLIP. The benchmark's L2-A-023 has a
            documented peer here. Do not claim novelty.
WEAKNESS    [P1] Architecture guide documents NO FORMAL HUMAN APPROVAL
            WORKFLOW at all.
PRICING     Meters test runs in credits; caps suites at 1,000 cases / 10
            concurrent jobs in a 10-hour window. (See MKT-07.)
```

### C-06 | OPENAI (AgentKit / Agent Builder)
```
STATUS      AGENT BUILDER SHUTS DOWN 2026-11-30. See MKT-08. Export produces
            Agents SDK code, not a convertible graph.
NOT COVERED ChatGPT Enterprise custom GPTs; Workspace Agents governance. REAL
            HOLE in this analysis.
```

### C-07 | AWS (Bedrock / AgentCore)
```
STRENGTH    WINS ON THE SPECIFIC PRIMITIVES, and is the most direct
            competitor to several benchmark claims:
            [P1] AgentCore Registry "provides a governed workflow for
            publishing, reviewing, and approving resources."
            [P1] AgentCore Policy intercepts EVERY TOOL CALL BEFORE EXECUTION
            (Dogwood/Cedar), DEFAULT-DENY, FORBID-WINS.
            [P1] Optimization gives versioned config bundles + A/B traffic
            splitting.
SIGNIFICANCE
            AWS Policy is a DENY-WINS IMPLEMENTATION. It is scoped to the TOOL
            layer only, not knowledge or release — but the benchmark must not
            claim deny-wins is unprecedented. See CL-01.
            Note also: AWS is the only all-engineering platform in the set,
            and the only one with a publish/review/approve workflow. REVIEW
            MACHINERY GETS BUILT WHERE ENGINEERS ARE THE USERS. That is an
            important signal for L2-D-001.
FAIL-OPAQUE [P1] AgentCore metrics/spans/traces are SILENTLY ABSENT until a
            separate one-time CloudWatch Transaction Search setup.
            [P1] Policy log-only mode evaluates without blocking.
OPEN        AWS's primary overview page states no GA/Preview status for any of
            its 13 services. Nothing found on whether older Bedrock Agents is
            deprecated or superseded.
```

### C-08 | RAMP (and GLASS)
```
ENTITY RESOLUTION — DEFINITIVE
  "Ramp Glass" is ONE entity: Ramp's internal AI workspace, built after Ramp
  spent $1.5M ON TOKENS IN ONE WEEK in May 2026, opened to outside businesses
  2026-10-13. Primary source: Eric Glyman, ramp.com/blog/introducing-glass.
  NO OTHER "GLASS" IS RELEVANT. Glass Health = SF clinical AI (its LLM feature
  is confusingly also called "Glass AI"). Glass.AI = London web/market-
  intelligence firm, ~17 people. NO standalone "Glass" AI-security company
  exists. No "Glass" agent-platform startup found.

PUBLISHED INTERNAL STACK [P1, builders.ramp.com]
  Laminar (2026-10-20) — in-house agent harness, consolidation decided ~May
  2026, motto "build agents, not infrastructure." Ramp's own post is thin: no
  architecture, no metrics, no governance, no eval.
  Inspect (2026-01-12) — best primary account. Isolated Modal VMs, repo images
  rebuilt every 30 min, OpenCode runtime, Cloudflare Durable Objects for
  per-session SQLite. Surfaces: Slack, web, Chrome extension, PR comments,
  browser VS Code. Multiplayer, per-prompt attribution. Non-engineers use it.
  OCA (2026-09-09) — incident agent on Temporal, "narrowly scoped write
  access," hands code fixes to Inspect which drafts a PR FOR HUMAN REVIEW.
  Stack Benchmarking (2026-06-03) — see below.

PERMISSION MODEL — BENCHMARK CLAIM NOT FALSIFIED [P1, read in full]
  Pure delegation ("OBOU"): "the agent is always tied to a human sponsor and
  acts on their behalf." Access "stems purely from the sponsor user's existing
  role and capabilities." Scopes "always bounded by the sponsor's existing
  role."
  NO DENY PRIMITIVE. NO CENTRAL DECISION SERVICE DESCRIBED.
  NO IMMUTABLE GRANT RECORD — Ramp logs agent ACTIONS, attributed to agent AND
  sponsor, plus notifications on key creation/expiration/revocation. That is
  ACTIVITY ATTRIBUTION, not a grant trail.
  DENIED VS COULD-NOT-DETERMINE: not addressed at all. No error handling,
  timeouts, or default behavior when a check cannot complete.
  REVOCATION PROPAGATION: not published. Short-lived JWTs ("bad for an hour,
  can be revoked instantly"). NO CACHING OR PROPAGATION BEHAVIOR DESCRIBED —
  which matters, because "revoked instantly" only holds if nothing downstream
  caches a decision.
  THE STRUCTURAL CEILING, IN RAMP'S OWN WORDS: "agents acting on behalf of
  admins can take actions on behalf of the entire business." There is no
  published way to say "no agent may ever touch X, even an admin's." That is
  exactly what a deny primitive buys.
  CONFIDENCE this is absence rather than non-publication: MODERATE-TO-HIGH.
  Two purpose-built documents about agent authority, both detailed on adjacent
  mechanics, neither mentioning deny semantics.
  CAVEAT: both documents describe Ramp's CUSTOMER-FACING agent platform.
  Whether Laminar/Inspect/Glass internally use OBOU is NOT STATED ANYWHERE.

THE ZERO-HUMAN SECURITY PIPELINE [P1, read in full]
  "0 humans" is qualified in Ramp's own body text: work ran "without a human
  in the loop (UNTIL PR REVIEW)," and a human "took over to review the patch
  and land the code."
  TWO BENCHMARK MECHANISMS HAVE PEERS HERE — see CL-02, CL-03:
    Adversarial refuter: manager agents "critiqued findings" adversarially and
    REJECTED 40% OF INITIAL PROPOSALS — and a human later confirmed those
    rejections were false positives. RAMP MEASURED THEIRS. THE BENCHMARK HAS
    NOT MEASURED ITS OWN.
    Three-state output: detector output is labeled "VULNERABLE," "SECURE," or
    "UNCERTAIN."
  VERIFICATION, AND IT IS ARGUABLY STRONGER THAN THE BENCHMARK'S: a validator
  agent writes an integration test that "would pass only if the endpoint was
  secure"; a test that ALREADY PASSES marks the finding a false positive; the
  fixer does TDD against it; THE TEST BECOMES A PERMANENT REGRESSION TEST.
  They made the LLM write the oracle and then be bound by it. Live-deployment
  testing was abandoned as too hard for complex preconditions.
  GUARDRAILS WERE THINNER THAN THE PIPELINE SUGGESTS: no eligible/excluded
  change classes defined. No severity breakdown. NO STAGING, NO FLAGS, NO DARK
  DEPLOY, NO ROLLBACK, NO POST-MERGE MONITORING. Human reviews, human lands,
  landing is shipping.
  EFFORT: a 4-hour hackathon plus under a week by one person, producing ~100
  novel issues missed by pentesting, bug bounty, static analysis and 10+
  vendor trials.

STACK BENCHMARK — THE MOST USEFUL EXTERNAL FINDING IN THIS DOCUMENT
  8 synthetic "worlds," 237 tasks, 3,469 accountant-written criteria, 5 runs
  per task, scored Pass@1 / Pass@5 / Pass^5, plus roll-forward worlds testing
  memory contamination.
  RESULT: ONLY 2 OF RAMP'S OWN SKILLS WERE NET-POSITIVE ON AVERAGE; THE REST
  WERE NEGATIVE. Memory took one task from 0% to 100% while DEGRADING another
  from 75% TO 25%.
  IMPLICATION: a direct, measured argument for approved-knowledge-source
  admission control (L1-D-002), and a warning about any skill library shipped
  without per-skill ablation (L2-D-008).
  CAVEAT: the post never says whether grading is human, rule-based, or
  LLM-judged.

OUTCOMES — CLAIMED VS MEASURED
  Inspect "~30% of merged PRs" (Ramp, Jan 2026) vs Modal's "over half"
  (later) — likely growth; report both with dates.
  OCA: assisted 575 of 1,220 incident PRs over 4 weeks, 37% fewer engineers,
  ~50% less estimated time, 90% helpful — and RAMP ITSELF DISCLAIMS these as
  "internal activity estimates and coarse feedback," not a controlled study.
  Glass: 6,500+ knowledge edits by 323 people; feature-request capture ~300 to
  20,000/mo; 30% bill reduction (Ramp attributes to Ramp Router; press
  attributes to Glass "in certain accounts" — same number, different scope).
  Adoption 99% (Glyman) vs 99.5% (press) — conflicting.
  NO HEADCOUNT-AVOIDED CLAIM EXISTS ANYWHERE IN THE SOURCES.

STRATEGIC IMPLICATION
  Ramp Glass going external means "we built it ourselves" is becoming
  PURCHASABLE. Within ~12 months part of the build-vs-buy case weakens.

CORRECTION CARRIED FROM ROUND 1 — DO NOT LET THIS REACH A DECK
  Agentic Security Review, Vuln Hunter, Anybump and Invariant Sentinel are
  CURSOR'S, NOT RAMP'S. A search summary conflated them.
```

### C-09 | UBER
```
STRUCTURALLY THE CLOSEST ANALOGUE TO THE BENCHMARK — closer than Ramp.
  Context graph (~40M entries, 150 node/edge kinds).
  Skills registry WITH AUTOMATED LINT AND REVIEW (2,500 skills, 20k runs/day).
  MCP gateway (1,000+ tools, 40%+ token cut).
  LLM gateway enforcing ORDERED identity/auth -> PII stripping (20+ kinds) ->
  a five-model "AI guard" under 100ms. Every call tagged to project/user/team.
  100M+ requests/day.
  Minion STOPS AT A DRAFT PR and does not push to CI.
  Maintenance loops run Sundays and CAP DIFFS PER ENGINEER (reviewer-fatigue
  mitigation — a mechanism the benchmark lacks).
CAVEAT  All of this is a Port blog summary of an Uber conference talk —
        SECONDHAND. Needs verification against Uber's own engineering blog
        before external use.
```

### C-10 | STRIPE (Kai)
```
  "The agent is a service, not an application." Agent Studio control plane
  owned by domain teams. deepagents on Kubernetes. 1,000+ skills/tools. One
  session reached 932 turns.
BEST PUBLISHED NEGATIVE FINDING ANYWHERE:
  Their earlier NoCode Agent Builder produced 4,000+ MICRO-AGENTS of varying
  prompt quality that became UNMONITORABLE.
  SIGNIFICANCE: this is L2-D-001 (can a non-engineer builder cohort ship
  safely?) answered badly at one of the most sophisticated engineering
  organizations in the world. It strengthens the case for ceremony profiles
  and weakens any pitch promising frictionless business-user agent creation.
  Note the tension with C-02's Dust adoption data: Dust shows 20-30% of
  employees building agents successfully. The difference is plausibly that
  Dust's agents are retrieval-and-draft while Stripe's were operational — but
  THAT IS AN INFERENCE, NOT ESTABLISHED.
ONE EXPLICIT ISOLATION RULE: unrelated customer contexts cannot share a
  session even when the user is authorized for both.
```

### C-11 | SHOPIFY (Aquifer / River)
```
  Append-only Postgres event log as durable session identity.
  HARNESS RUNS OUTSIDE THE SANDBOX (safety, replaceability, observability).
  Profiles are data, Nix-built — "a new agent costs a new profile, not a new
  platform."
  RIVER WORKS ONLY IN PUBLIC SLACK CHANNELS, NO DMs — public-by-default
  transcripts. DIRECT CONTRAST with the benchmark's DM-only default
  (L3-A-005). Two defensible opposite positions: Shopify optimizes for
  observability and shared learning; the benchmark optimizes for data-exposure
  containment. Worth stating as a deliberate choice, not an oversight.
  59,918 sessions / 5,170 channels / 3,536 merged PRs in 30 days; ~1 in 8
  merged Shopify PRs.
```

### C-12 | BLOCK (goose)
```
  THE ONLY PUBLISHED ADVERSARIAL RED-TEAM of an internal agent platform:
  zero-width Unicode prompt injection via external calendar invites ->
  developer shell tool -> infostealer.
  THEIR PUBLISHED GUIDANCE IS THE BEST EXTERNAL ENDORSEMENT AVAILABLE FOR THE
  BENCHMARK'S PERMISSION LAYER: "do not rely on the AI for access control —
  enforce authorization outside it."
```

### C-13 | AI CODE REVIEW TOOLS
```
PRODUCTS  CodeRabbit, Greptile (TREX), Cursor Bugbot, Graphite Diamond, Qodo.
          Note Cursor acquired Graphite Diamond (Dec 2025) and so owns both
          Diamond and Bugbot.

THE MEASUREMENT VACUUM — IMPORTANT
  Greptile's own benchmark reports a 38-POINT catch-rate gap over CodeRabbit
  (82% vs 44%). Martian's semi-independent leaderboard reports 0.1 POINTS
  (61.9% vs 61.8% F1). BOTH CANNOT BE RIGHT.
  THERE IS NO CREDIBLE PUBLIC PRECISION/RECALL FIGURE FOR ANY PRODUCT.
  CAVEAT: the Martian leaderboard fetch returned only the page title; its
  figures are snippet-level and its methodology is unknown — and it is the
  only semi-independent benchmark that exists.

GREPTILE TREX — THE CLOSEST PEER TO THE BENCHMARK'S REFUTER
  Ships sandboxed code execution: installs dependencies, starts services,
  mocks APIs, drives UI, writes and runs tests. Claims ~20% more bugs found.
  ROTATES CREDENTIALS BEFORE EXECUTION in a disposable sandbox — a
  reachability mitigation shipping today.
  [P1] Reports passing runs "in the summary as proof the change was actually
  tested," and "not every run needs to find a problem to be useful." This is
  the closest product-side analogue to POSITIVE reporting of what was
  exercised. It is still NOT honest skip-reporting (it reports what ran, not
  what could not run) — but artifact 03 must not claim no product does
  anything in this space.
  [P1] Greptile admits "LLMs avoid downgrading severity," which is WHY
  nit-filtering structurally fails.

GREPTILE'S DOCUMENTED FAILURE OF CONTEXT ISOLATION — AND WHY IT DOES NOT
FALSIFY THE BENCHMARK
  Their context-isolated execution agent produced irrelevant tests and missed
  edge cases; they fixed it by SHARING reviewer context.
  CRITICAL DISTINCTION, verified in round 2: it was TEST GENERATION, not
  FINDING REPRODUCTION. "Generating tests wasn't the same activity as finding
  bugs" — the generated tests "didn't match what the user was trying to do."
  The post does NOT describe a reproduction step failing to confirm a
  candidate finding. THE BENCHMARK'S STRIPPED-ENVIRONMENT BET IS NOT
  FALSIFIED BY THIS.
  BUT A SECOND, SEPARATE FAILURE MODE CREATES A REAL TRADEOFF: separate agents
  "had no shared knowledge" and explored "the same parts of the codebase
  twice." Greptile's fix: an orchestrator reads the diff, spins up one TREX
  subagent per issue, and EACH SUBAGENT INHERITS WHAT THE ORCHESTRATOR ALREADY
  FOUND.
  The benchmark matches the per-issue scoping and DELIBERATELY REJECTS the
  inheritance. DEFENSIBLE POSITION TO STATE: independence costs compute
  (re-exploration) and costs the refuter the orchestrator's context, buying
  elimination of confirmation bias. Greptile optimized for cost and relevance;
  the benchmark optimizes for independence. THE BENCHMARK'S IS MORE EXPENSIVE
  — say so rather than claim no cost.
  (A third design, one merged agent, also failed — context overload.)
  CAVEAT: entirely vendor-authored and unquantified on both failure modes, so
  the magnitude of the tradeoff being accepted is UNKNOWN.
```

### C-14 | EVAL AND GUARDRAIL INFRASTRUCTURE
```
EVAL PLATFORMS  Braintrust, Langfuse, LangSmith, Phoenix, Weave, Galileo.
                Humanloop IS DEAD (acqui-hired by Anthropic Aug 2025, platform
                offline 2025-09-08, no IP transferred).

THE 2026 ACADEMIC SHIFT — FROM BIAS TO VALIDITY
  Judges can be highly RELIABLE while being INVALID: kappa deflation of 33-41
  points versus raw agreement; two production judges with test-retest >0.95
  alongside severe position bias; rankings shifting up to 14 positions.
  A STABLE JUDGE SCORE ON A VENDOR DASHBOARD IS NOT EVIDENCE OF MEASUREMENT
  QUALITY. No platform's marketing addresses construct validity.
  USE: this is the strongest available academic support for I8's posture —
  stronger than any practitioner opinion.

DETERMINISTIC-OVER-JUDGE IS MAINSTREAM, NOT CONTRARIAN
  Hamel Husain / Shreya Shankar's FAQ (updated 2026-09-18) explicitly favors
  assertions over judges.
  HONEST TRADEOFF THE BENCHMARK MUST STATE: I8 is STRICTER than that guidance,
  which PERMITS VALIDATED JUDGES for irreducibly subjective failures.
  Forbidding them outright means those failure classes go UNEVALUATED rather
  than imperfectly evaluated. See CL-06.

GUARDRAILS ARE OVERWHELMINGLY CLASSIFIER-BASED
  Bedrock self-describes its PII filter as "probabilistic ML." Datadog uses
  regex on output. NeMo's intent matching is a vector lookup.
  TOKENIZER-LEVEL ENFORCEMENT IS NOT A PRODUCT — the only instance found is
  PCC-SQL (research, per-token logits mask, 0% leakage on its own benchmark).
  THE BENCHMARK IS AHEAD OF THE MARKET HERE. But the stronger 2026 argument is
  ARCHITECTURAL: enforcement belongs at the DB grant / semantic layer / tool
  layer. (Note: this is what the benchmark's own DEP-055 already concluded.)
  EchoGram (short "flip tokens" that invert classifier verdicts) and "redact
  before you log" both still apply if the tokenizer is the LAST line before
  egress.

MARKET CONSOLIDATION
  Lakera -> Check Point (closed 2025-10-22; filing says ~$201.8M, press said
  $300M). Protect AI -> Palo Alto Prisma AIRS (July 2025). Graphite Diamond ->
  Cursor (Dec 2025). Langfuse -> ClickHouse (Jan 2026, UNVERIFIED against
  primary source). CrewAI enterprise renamed AMP; four critical CVEs Mar-Apr
  2026 fixed by REMOVING the Code Interpreter tool.
  AGENT LIFECYCLE GOVERNANCE IS SPLIT ACROSS FOUR LAYERS AND SOLD WHOLE BY
  NOBODY.

NOT RESEARCHED  Stack AI, Relevance AI, Snyk/Semgrep AI governance features.
                Credal column-level policy docs not found. CodeRabbit's
                "Verification agent" (executes vs re-reads) unresolved.
```

---

## 3. CLAIM ADJUDICATION — THE OPERATIVE SECTION

```
Each benchmark claim is graded:
  SURVIVES          No peer found. Claim novelty.
  SURVIVES-NARROWED Peer exists in adjacent form. Claim the specific variant.
  DOWNGRADE         Published peer or prior art. Claim generalization, not
                    invention.
  FALSIFIED         Claim is wrong. Do not use.
Every claim below carries the RESTATEMENT to use in external material.
```

### CL-01 | Deny-wins central resolution — SURVIVES-NARROWED
```
EVIDENCE FOR
  Glean [P1]: allow-list only, NO deny primitive.
  Dust [P1]: additive across groups, no deny rule, no precedence, no conflict
  resolution documented.
  Ramp [P1]: pure delegation. "Agents acting on behalf of admins can take
  actions on behalf of the entire business." No way to express "never."
  Stripe/Uber: log activity, not grants.
EVIDENCE AGAINST
  AWS AgentCore Policy [P1]: Cedar, DEFAULT-DENY, FORBID-WINS, intercepting
  every tool call before execution. THIS IS A DENY-WINS IMPLEMENTATION.
RESTATEMENT
  "Deny-wins exists in the market at the TOOL-INVOCATION layer (AWS Cedar).
  What does not exist anywhere is a single centrally-resolved decision that
  spans knowledge access, tool invocation AND release authority, with explicit
  deny beating any number of allows. Two of the three category leaders have no
  deny primitive at all."
ACTION FOR 03  Specify the benchmark's scope precisely. Consider adopting
               Cedar-style tool-layer enforcement as a GAP to close (GAP-02).
```

### CL-02 | Adversarial refuter — DOWNGRADE
```
EVIDENCE AGAINST
  Ramp [P1]: manager agents "critiqued findings" adversarially and REJECTED
  40% OF INITIAL PROPOSALS, with human confirmation that those rejections were
  false positives. Same mechanism, same motivation.
  Published prior art: reproduce-before-report is documented at
  learn.agentpatterns.ai (CC BY 4.0), INCLUDING a fresh-context verifier that
  never sees the reviewer's reasoning, and a cross-model-family
  recommendation.
  Greptile TREX [P1]: ships sandboxed execution that writes and runs tests.
RESTATEMENT
  "Adversarial verification of candidate findings exists in the field —
  Ramp built one for a security pipeline, and reproduce-before-report is
  published prior art. What is not published anywhere is adversarial
  verification as a PLATFORM-WIDE INVARIANT applied to every blocking finding
  on every change, with a three-valued verdict that GATES the record."
CRITICAL WEAKNESS
  RAMP MEASURED THEIRS (40% rejection, human-confirmed). THE BENCHMARK HAS NOT
  MEASURED ITS OWN. If this comparison arises in front of a skeptical
  audience, THE MEASUREMENT GAP IS THE WEAK POINT, NOT THE DESIGN.
ACTION FOR 03  Measuring the refuter's rejection rate from existing review
               records is a HIGH-PRIORITY, LOW-EFFORT item. The data already
               exists in the record corpus.
```

### CL-03 | "Denied" vs "could not determine" — SURVIVES-NARROWED
```
EVIDENCE FOR — unusually strong
  Glean [P1]: agent access policies are DOCUMENTED FAIL-OPEN (a typo makes the
  rule a no-op, the tool call proceeds); retrieval fails closed and SILENT.
  Neither layer distinguishes "could not determine."
  Ramp [P1]: not addressed at all.
  Big vendors [P1]: NO VENDOR DOCUMENTATION ANYWHERE defines tri-state failure
  semantics.
EVIDENCE AGAINST
  Ramp's security pipeline [P1]: detector output labeled "VULNERABLE,"
  "SECURE," or "UNCERTAIN." The three-state instinct is published.
RESTATEMENT
  "The three-state instinct appears in individual pipelines (Ramp labels
  detector output VULNERABLE / SECURE / UNCERTAIN). What no vendor documents
  is tri-state semantics as a PLATFORM INVARIANT in the access layer — and the
  category leader documents the opposite: a configuration error makes the rule
  a no-op and the call proceeds."
STRENGTH  This is the benchmark's strongest claim. Glean's fail-open behavior
          is documented-opposite, in their own words, not merely absent.
```

### CL-04 | Mechanically computed risk tier — SURVIVES
```
EVIDENCE
  Big vendors [P1]: NOBODY computes risk mechanically. The tier always follows
  which tool the maker opened or which edition the org bought. Microsoft's
  three-zone model is self-selected.
  TrustX ARC [P1, round 2]: scores twelve dimensions on a 1-3 scale BY USER
  SELECTION; "allow[s] the user to select the most appropriate autonomy
  level." Nothing derived from code, diffs, file paths or telemetry.
  AND THE AUTHORS CONCEDE THE POINT: §6.3 acknowledges "scoring subjectivity"
  and that "differences in user interpretation can lead to varying results."
  No max(declared, computed) anywhere. ARC's nearest mechanism is a "critical
  dimension rule" preventing a high score being averaged away — a FLOOR ON A
  SELF-REPORT, not a check against a computed value. Multi-agent systems
  inherit "the highest tier among their agents," showing the max() instinct is
  recognized but never applied against a mechanical derivation.
  ARC's Coding Assistants extension is weaker than its name: it collects 20
  capabilities and 20 coding-specific risk factors plus four deployment
  models, and the paper states THESE DO NOT FEED INTO THE FINAL RISK
  CALCULATION. Its own M1 worked example is internally inconsistent (expected
  Tier 1, lands at Tier 2).
RESTATEMENT
  "Risk tiers exist (ARC, Microsoft, Kovrr). EVERY PUBLISHED TIERING SCHEME
  SCORES A SELF-REPORT — and the most rigorous one names that as its own
  limitation. Computing the tier from the changed paths, and taking
  max(declared, computed), appears nowhere."
OPEN  arc.responsible.ai is a client-rendered JS app that could not be
      retrieved. §3.2.3/§6.3 would contradict a mechanical version, so risk is
      low — BUT OPEN IT IN A BROWSER BEFORE THIS GOES IN A DECK.
```

### CL-05 | SKIPPED never reported as passed — SURVIVES
```
EVIDENCE
  Every instance found is a hand-rolled fix in an individual repository. One
  harness reported "4/4 and 100%" WITH NO RUNNER AT ALL.
  Big vendors [P1]: nothing distinguishes "check failed" from "check could not
  run."
  Closest product analogue: Greptile reports passing runs as proof the change
  was tested — POSITIVE reporting of what ran, not honest reporting of what
  could not run.
RESTATEMENT
  "Honest skip-reporting is not a product feature anywhere in the market. The
  closest analogue reports what DID run; nothing reports what COULD NOT run
  and refuses to call it a pass."
STRENGTH  Strongest demo asset. 30 seconds, universal buyer resonance.
```

### CL-06 | Deterministic verification, LLM self-review forbidden — SURVIVES-NARROWED
```
EVIDENCE FOR
  Big vendors [P1]: verification is predominantly MODEL-GRADED — Microsoft
  grades groundedness/relevance/abstention, Google uses autoraters and
  LLM-as-a-judge, AWS uses AI-generated optimization recommendations. Only AWS
  Policy is explicitly deterministic, and only over tool access.
  Glean [P1]: published methodology RECOMMENDS LLM grading.
  Dust [P1]: founders on record that future direction is LLM-as-judge.
  Academic [S1]: judges can be reliable but INVALID (kappa deflation 33-41
  points; rankings shifting up to 14 positions).
EVIDENCE AGAINST / NUANCE
  Deterministic-over-judge is the MAINSTREAM PRACTITIONER POSITION (Husain /
  Shankar, Sept 2026), not a contrarian one.
  AND THE BENCHMARK IS STRICTER THAN THAT GUIDANCE, which permits VALIDATED
  judges for irreducibly subjective failures.
RESTATEMENT
  "Deterministic verification is the mainstream practitioner position and the
  academic evidence supports it. What is unusual is enforcing it as a platform
  invariant rather than a recommendation — every major vendor's shipped
  verification is model-graded."
HONEST TRADEOFF TO STATE
  "Forbidding judges outright means irreducibly subjective failure classes go
  UNEVALUATED rather than imperfectly evaluated. That is a deliberate choice,
  and a client with a large subjective-quality surface should know it."
ACTION FOR 03  Consider whether I8 should permit VALIDATED judges in a named,
               tightly-scoped category with its own tier. See 03.
```

### CL-07 | Untrusted-input threat model — DOWNGRADE
```
EVIDENCE AGAINST
  GitInject (arXiv 2606.09935) [P1 via HTML rendering]: system model
  EXPLICITLY labels "PR titles, bodies, issue text, code under review" as
  untrusted external content. The untrusted-input half is PUBLISHED.
  CSA's CVE-2025-66032 note independently recommends running agents with no
  repository write credentials and separating the reasoning layer from the
  credential-holding layer.
EVIDENCE FOR
  GitInject does NOT frame it as a design principle, and does NOT state a
  secrets-free-session posture — its recommendations REDUCE EXPOSURE rather
  than eliminate reachability.
  CSA explicitly DECLINES to offer a PR-content-specific threat model.
  No vendor has a per-product threat model.
RESTATEMENT
  "Consistent with, and partially anticipated by, GitInject and CSA's
  CVE-2025-66032 note. What remains unpublished by any VENDOR is a
  per-product threat model; what remains unpublished by ANYONE is the
  no-reachable-secret posture as a DESIGN RULE rather than a mitigation set."

TWO FINDINGS THAT MAKE THE BENCHMARK'S OWN PHRASING TOO NARROW
  (a) PROVIDER CONFIG FILES added in the PR branch (CLAUDE.md, AGENTS.md,
      GEMINI.md) load at OPERATOR TRUST LEVEL and were BY FAR the
      highest-success vector — succeeding against 7 of 9 models including
      sonnet-4-5 and haiku-4-5, where PR-body injection succeeded against ONLY
      gpt-4o-mini. The benchmark's I4 names diff, title, body and comments. IT
      DOES NOT NAME CONFIG FILES.
      VERIFIED AGAINST THE BENCHMARK'S ACTUAL IMPLEMENTATION: review-queue-
      run.sh never cd's into the PR worktree and passes no --add-dir; the
      session launches from the repo toplevel, so Read(./**) scopes to the
      CLEAN checkout and the PR worktree is reached only by absolute path.
      The PR's CLAUDE.md is therefore read as DATA, not loaded as operator
      context. THE BENCHMARK IS PROTECTED — BUT INCIDENTALLY, NOT
      DELIBERATELY. Nothing states it, nothing pins it with a test. Adding a
      cd or an --add-dir later removes the protection silently.
      Note the adjacent defense already exists and has the right rationale:
      R88/R115 refuses PR trees containing symlinks (120000) or gitlinks
      (160000) because "a symlinked file lets the runner's own tools read an
      operator path."
  (b) "NO FILE-BACKED SECRET REACHABLE" IS TOO NARROW — GitInject recovered
      GEMINI_API_KEY FROM THE PARENT PROCESS. Only removing `tr` and `grep`
      from allowed tools was effective. The posture must become
      REACHABILITY-BASED (nothing recoverable by any means, including process
      environment and parent-process memory), with TOOL RESTRICTION as the
      enforcing mechanism.
      BENCHMARK STATUS: already covered. Headless sessions get exactly six
      tools via --tools, and the settings comment documents that removing Bash
      alone left ~24 tools while Monitor ran shell commands. Same bug class,
      already found and fixed by live probe. The PHRASING still needs updating.

ADDITIONAL FINDING
  GitInject tested Anthropic (sonnet-4-5, haiku-4-5, opus-4-7), OpenAI Codex
  (gpt-4o-mini, gpt-5, gpt-5.4), Gemini (2.5-flash, 3-flash, 3.1-pro-preview)
  and Cline. 15 of 22 MITRE-categorized scenarios confirmed. MODEL CAPABILITY
  DID NOT PROTECT AGAINST A TRUST-BOUNDARY ERROR — frontier models mostly
  resisted PR-body injection but nearly all fell to operator-trust-level
  config injection. STRONG ARGUMENT FOR ARCHITECTURAL DEFENSE OVER MODEL
  CHOICE.
  GitInject's stated minimum baseline: persist-credentials: false plus tool
  restriction. It also notes that pull_request_target — required for automated
  review of external contributions using secrets — is PRECISELY the config
  that reintroduces secret reachability.
```

### CL-08 | Merge-dark plus separately-attested flag flip — SURVIVES-NARROWED
```
EVIDENCE FOR
  Glean [P1]: merge = release.
  Dust [P1]: publish is a binary flag.
  Ramp [P1]: its MOST autonomous pipeline published NO release separation at
  all — human reviews, human lands, landing is shipping.
  Uber / Stripe / Shopify: no release separation published.
EVIDENCE AGAINST
  Salesforce [P1]: "Deployment does not make an agent live. A system
  administrator must explicitly 'activate' it." THIS IS DARK-MERGE-PLUS-FLIP.
RESTATEMENT
  "Release separation exists in one enterprise platform (Salesforce
  activation). What does not exist anywhere is release separation GATED ON A
  HUMAN-ATTESTED REVIEW RECORD BOUND TO THE MERGED COMMIT. Among published
  in-house builds — including the most autonomous one — merge IS the ship."
```

### CL-09 | Tokenizer-based output guardrails — SURVIVES
```
EVIDENCE  Market is overwhelmingly classifier-based (Bedrock "probabilistic
          ML", Datadog regex, NeMo vector lookup). Tokenizer-level enforcement
          is NOT A PRODUCT; only PCC-SQL exists, as research.
CAUTION   The stronger 2026 architectural argument is that enforcement belongs
          at the DB grant / semantic / tool layer. The benchmark's own DEP-055
          reaches the same conclusion. Do not oversell the tokenizer as the
          answer; sell it as the correct LAST line before egress, with the
          data-layer fix named as the real target.
          EchoGram (flip tokens inverting classifier verdicts) is a live
          threat to the classifier-based alternatives — useful contrast.
```

### CL-10 | Structured menus instead of free-form chat — SURVIVES
```
EVIDENCE  All four published in-house builds are chat. Glean and Dust are
          chat-first. The benchmark BUILT a conversational path, MEASURED it,
          and DELETED it (flag and tool-loop removed, not disabled).
RESTATEMENT
  "Every platform in the field is a chat box. The benchmark ran one, measured
  it, and retired it in favor of structured entry points. That is an
  evidence-backed product position, not an aesthetic preference."
NOTE      Dust's 20-30% employee-builder adoption is the counter-datapoint: a
          chat-first builder experience demonstrably produces broad adoption.
          The benchmark's position is about the CONSUMER surface, not the
          BUILDER surface. Keep that distinction sharp.
```

### CL-11 | Three-layer architecture — FALSIFIED as a differentiator
```
EVIDENCE  Three of four companies with published in-house builds independently
          arrived at the same three-layer shape (context control / builder
          layer / consumer surface).
RESTATEMENT
  "The three-layer architecture is CONVERGENT EVOLUTION — the shape every
  serious builder reaches. It is table stakes, and the deck should present it
  as validation that the model is right, NOT as a differentiator."
ACTION    Steven's current deck leads with the layer diagram. That slide
          should be reframed from "our approach" to "what everyone who has
          solved this has independently built — here is what they all still
          get wrong."
```

---

## 4. CAPABILITY GAPS — WHAT THE FIELD HAS THAT THE BENCHMARK LACKS

### GAP-01 | Agent identity and credential design — HIGHEST PRIORITY
```
FIELD     Ramp [P1]: non-secret Agent Keys as OAuth2-PKCE key IDs; short-lived
          JWTs; mandatory expiry with 14-day sponsor reminders; instant
          revocation; DUAL ATTRIBUTION to agent AND sponsor; show-once
          secrets; "adding an agent to an approval chain does not grant
          authority."
          Google: SPIFFE IDs with IAM permissions. Microsoft: Entra Agent IDs
          with lifecycle policies. Glean: agent identity with scoped
          credentials (public beta).
BENCHMARK Describes what may be REACHED but nothing about how an agent PROVES
          WHO IT ACTS FOR or how that proof EXPIRES.
EVIDENCE  The credential-sharing incident data (MKT-02) cuts directly against
          the benchmark here.
NOTE      Ramp's post is a usable blueprint. This is the single largest
          architectural gap.
MAPS TO   New item for 03. Not present in 01.
```

### GAP-02 | Tool-invocation chokepoint
```
FIELD     AWS Cedar policy intercepts EVERY tool call before execution,
          default-deny, forbid-wins. Uber's MCP gateway and LLM gateway are
          unbypassable enforcement hops with ordered identity/auth -> PII
          stripping -> AI guard.
BENCHMARK Guardrails are query-time over KNOWLEDGE (sql-guardrails.js). Tool
          access is controlled by per-request-type TOOL_PROFILES, which is
          allow-listing at configuration time, not interception at call time.
WHY       An unbypassable hop is architecturally stronger than a per-call-site
          guard, and it is what makes the fifth-enforcement-point gap
          (DEP-055) structurally unnecessary rather than merely tracked.
MAPS TO   L1-A-009 (the enforcement-point registry exists; the chokepoint does
          not).
```

### GAP-03 | Verification that leaves a durable artifact
```
FIELD     Ramp [P1]: the validator agent writes an integration test that
          "would pass only if the endpoint was secure"; a test that ALREADY
          PASSES marks the finding a false positive; the fixer does TDD
          against it; THE TEST BECOMES A PERMANENT REGRESSION TEST.
BENCHMARK Checks GATE a change. They leave evidence files (.varsity/
          evidence-<sha>.md) but not a permanent executable regression asset.
WHY       Ramp made the LLM write the oracle and then be bound by it. Every
          finding permanently improves the suite. This is elegant and cheap.
MAPS TO   L2-A-014.
```

### GAP-04 | Cost and spend control plane
```
FIELD     Ramp's ENTIRE GLASS PRODUCT exists because of a cost failure ($1.5M
          in tokens in one week). Ramp Router, live per-project cost meters,
          pre-emptive limits. Dust: 600-credit circuit breaker, configurable
          checkpoints, per-member caps, group budgets.
BENCHMARK A $10/hr rolling breaker and per-call cost logging
          (CLAUDE_CALL_LOG). No rollup by builder, project or team. No
          pre-emptive limits. No spend governance.
WHY       A client funding a builder cohort will ask within one month.
MAPS TO   L2-D-006.
```

### GAP-05 | Production drift and anomaly detection
```
FIELD     Microsoft, Google: production anomaly/threat/drift detection.
          Gartner names drift detection as step 5 of six — and as one of the
          two steps vendors cover LEAST.
BENCHMARK None. No detection of governance erosion either (L2-D-012).
```

### GAP-06 | eDiscovery and legal hold over agent interactions
```
FIELD     Microsoft Purview.
BENCHMARK None. For regulated verticals this is a procurement checkbox.
```

### GAP-07 | Inventory of agents the organization did not build
```
FIELD     Shadow/third-party/endpoint agent discovery (Microsoft, Glean).
BENCHMARK None. The benchmark governs what it builds; it cannot see what it
          does not.
```

### GAP-08 | Automated lint and quality control on the authoring layer
```
FIELD     Uber: skills registry WITH automated lint and review (2,500 skills).
          Stripe: learned this the hard way (4,000+ unmonitorable
          micro-agents).
BENCHMARK Review applies to CODE. There is no lint on skill/agent definitions
          as authored artifacts.
MAPS TO   L2-D-008.
```

### GAP-09 | Per-skill ablation measurement
```
FIELD     Ramp Stack Benchmark: ONLY 2 OF THEIR OWN SKILLS WERE NET-POSITIVE.
BENCHMARK 69 skills, none individually measured for contribution.
WHY       This is both a gap and an opportunity: the benchmark's deterministic
          verify harness is a better foundation for ablation than an
          LLM-judged eval, because the oracle is stable.
```

### GAP-10 | Reviewer-fatigue mitigation
```
FIELD     Uber caps diffs per engineer in maintenance loops. Greptile notes
          "LLMs avoid downgrading severity," which is why nit-filtering fails.
BENCHMARK Two-round author budget (R3) bounds the loop but nothing bounds
          aggregate reviewer load.
```

### GAP-11 | Connector fleet and non-technical on-ramp
```
FIELD     Glean and Dust both have large connector catalogs and NL authoring.
BENCHMARK Three connection skills, no template, no registry. Builder on-ramp
          assumes Claude Code fluency.
MAPS TO   L2-B-008, L2-B-012, L2-D-001.
```

### GAP-12 | Surface breadth
```
FIELD     Dust: web, Slack, Teams, Zendesk, email, Chrome/Firefox, Raycast,
          Google Sheets, Frames, REST/SDK/CLI, MCP server.
BENCHMARK Slack only.
MAPS TO   L3-B-001, L3-D-001 through L3-D-004.
```

---

## 5. THE CONVERGENT-ARCHITECTURE FINDING

```
STATEMENT
  Three of four companies with published in-house agent platform builds
  independently arrived at the same three-layer shape. The architecture is
  convergent evolution, not insight.

IMPLICATION FOR POSITIONING
  The layer diagram is VALIDATION, not differentiation. Reframe it:
  "Everyone who has solved this seriously has built the same three layers.
  Here is what every one of them still gets wrong."

WHAT ACTUALLY DIFFERENTIATES (ranked by evidential strength)
  1. CL-03  Tri-state failure semantics as a platform invariant.
            (Glean documents the OPPOSITE in its own docs.)
  2. CL-05  SKIPPED never reported as passed.
            (Not a product feature anywhere.)
  3. CL-04  Risk tier computed from the artifact, max(declared, computed).
            (Every published scheme scores a self-report; the most rigorous
            one concedes that as its limitation.)
  4. CL-01  Deny-wins spanning knowledge + tools + release.
            (Exists at the tool layer only, in one platform.)
  5. CL-08  Release gated on an attested record bound to the merged commit.
            (Release separation exists once; the attestation gate does not.)
  6. CL-10  Structured consumer surface, arrived at by measurement.
  7. CL-02  Adversarial refutation as a platform-wide invariant.
            (WEAKEST OF THE SEVEN — peer exists AND theirs is measured.)
```

---

## 6. THE GOLDEN-CAGE RISK — THE MOST DANGEROUS OBJECTION

```
THE OBJECTION
  The best-documented internal-platform failure mode is "golden cage
  syndrome": platforms built for CONTROL rather than CONSUMPTION get routed
  around. Field consensus: "You cannot mandate adoption; you must compete for
  it." Backstage: ~10% typical adoption vs Spotify's ~99% — same software,
  different ownership posture.

WHY IT LANDS ON THIS BENCHMARK SPECIFICALLY
  Three signature features read as control-first on first inspection:
    - risk tiers authors cannot downgrade
    - blocking reviews with an evidence requirement
    - menu-driven consumption instead of a chat box
  A sophisticated buyer WILL make this objection. Steven's current deck has no
  answer to it.

THE THREE REBUTTALS, ALL EVIDENCE-BACKED
  1. THE REFUTER IS AN ESCAPE HATCH WITH DUE PROCESS.
     The documented IDP failure is an opaque abstraction you cannot argue
     with. A mechanism whose entire job is to try to DISPROVE the gate's
     finding is the structural opposite. Move this to the front of the pitch.
  2. SKIPPED-NOT-PASSED IS AN ANTI-VANITY-METRIC.
     The second documented failure is measuring output while ignoring
     friction. A platform that refuses to report a green check it did not earn
     is making the opposite trade.
  3. EVERY BYPASS IS LOGGED AND THE GATES FAIL OPEN.
     All hooks fail-open; the lite path is loud and logged to
     ~/.claude/varsity-gate-bypass.log. The benchmark already instruments the
     exact thing the literature says platforms fail to measure.

THE RECOMMENDED COUNTER-MOVE
  SHIP BYPASS RATE AS A HEADLINE METRIC. Tracking installs instead of bypasses
  is itself a named failure mode. The benchmark can report what fraction of
  changes went around the gate, which no vendor can.

COMMERCIAL CONSEQUENCE
  Price enablement as MANDATORY. Backstage's 10%-vs-99% split is the argument:
  same software, succeeding only where someone owned adoption as a product.

HONEST VOID
  No quantitative comparison of voluntary vs mandated internal-platform
  adoption exists. The field's position is unanimous practitioner consensus
  plus Gartner on agents, but it is NOT MEASURED. Do not present it as data.
```

---

## 7. POSITIONING IMPLICATIONS

### P-01 | The wedge
```
"Inventory is not governance."
Every vendor's answer to agent sprawl is a registry: what exists, who owns it,
can we kill it. None answers whether it should have been built, whether it
still works, or who attested that it does.
Supported by MKT-04 (universal registry response) and MKT-02 (5% have controls
+ audit + review).
```

### P-02 | The buyer
```
Mid-market, 200-2,000 employees, with:
  - an existing engineering function (review machinery gets built where
    engineers are the users — C-07)
  - a regulated or audit-sensitive posture (L1-A-006 is the door-opener)
  - Slack (EP-3 is near-turnkey on Slack and an L-sized build otherwise)
The labs have ceded this segment for durable unit-economics reasons (MKT-05).
```

### P-03 | The price
```
$200K-$350K for the five-phase engagement; $5-12K/mo retainer thereafter.
Fixed-fee phases. Enablement mandatory. No outcome-based pricing at entry.
```

### P-04 | The three objections, in the order they will arrive
```
1. "Why not just buy Glean/Dust/Copilot?"
   -> Answer with CL-03 (Glean's documented fail-open), MKT-08 (OpenAI's
      13-month shutdown), and MKT-04 (inventory is not governance).
2. "Ramp built this themselves and now sells it."
   -> Answer honestly: yes, and we would rather a client buy Glass than build
      badly. What Glass does not have is deny-wins, tri-state semantics,
      mechanical tiering, or release attestation — verified in their own docs.
      Also: Glass is a workspace product, not a governance framework.
3. "This is a golden cage." (THE DANGEROUS ONE)
   -> Section 6.
```

### P-05 | What to lead the deck with
```
NOT the layer diagram (CL-11 — convergent, table stakes).
LEAD WITH: the 5% statistic (MKT-02), then the two demos that take 30 seconds
each (CL-05 skip-reporting, CL-03 fail-open contrast with Glean's own
documentation).
```

---

## 8. BLACKLISTED CLAIMS AND EVIDENCE GAPS

### BLK-01 through BLK-06 | Do not use
```
BLK-01  "95% of AI pilots fail" (MIT NANDA). Measured no-P&L-impact on a
        non-random sample; methodology contested; sample sizes conflict.
BLK-02  "80% of internal developer platforms fail." Author attributes it to an
        unpublished personal audit.
BLK-03  "64% of developers bypass the platform." Traces to an unlinked report.
BLK-04  "Ramp: 3 hours to 7 minutes for 80% of PRs." Single low-quality blog;
        appears in no summary of the OpenAI text. TREAT AS FABRICATED.
BLK-05  Agentic Security Review / Vuln Hunter / Anybump / Invariant Sentinel
        attributed to Ramp. THESE ARE CURSOR'S. A search summary conflated
        them.
BLK-06  Any specific Glean, Microsoft, Salesforce or Google per-seat price.
        No vendor price page was retrieved; all figures are third-party and
        mutually inconsistent.
```

### Open items requiring verification before external use
```
V-01  arc.responsible.ai — open in a browser (client-rendered JS). Confirms or
      refutes CL-04's strongest form.
V-02  Microsoft Zone 2's "IT-managed review processes" — verify hands-on in a
      tenant whether this is a product mechanism or process guidance.
V-03  Gartner's agent-sprawl release — re-verify wording and figures from the
      original (403'd to automated fetch).
V-04  Uber's own engineering blog — the Uber profile is a secondhand summary
      of a conference talk.
V-05  ChatGPT Enterprise custom GPTs and OpenAI Workspace Agents governance —
      not researched; a real hole given MKT-08.
V-06  Langfuse -> ClickHouse acquisition — unverified against primary source.
V-07  GitInject's 15-of-22 scenario tally was read from a table cell, not
      stated in prose. Verify before quoting.
```

### Systemic voids — no evidence exists, state as such
```
SV-01  No credible public precision/recall figure for ANY AI code review
       product. Two benchmarks disagree by 38 points.
SV-02  No independent study of reviewer fatigue in AI code review.
SV-03  No authoritative benchmark of classifier vs deterministic guardrail
       bypass rates.
SV-04  No firm at any tier publishes an engagement success rate.
SV-05  No quantitative comparison of voluntary vs mandated platform adoption.
SV-06  Across all five published in-house builds, DEFECT RATES, REVERT RATES
       AND INCIDENTS ATTRIBUTABLE TO AGENT-WRITTEN CODE ARE ENTIRELY
       UNDISCLOSED — the one metric that would validate any governance model,
       including this one.
```

---

## DOCUMENT END

```
NEXT ARTIFACT  03-target-build.md — synthesis of 01 + 02 into the ideal build.
               Must resolve: CL-01 scope statement, CL-02 measurement gap,
               CL-06 judge-permission question, CL-07 phrasing update plus the
               two I4 fixes, GAP-01 agent identity, GAP-02 tool chokepoint,
               GAP-03 durable verification artifacts, and the Section 6
               golden-cage counter-positioning.
```
