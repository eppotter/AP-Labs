# ARTIFACT 03 — TARGET BUILD

<!-- doc-id: pk-03-target-build -->
<!-- version: 1.0 -->
<!-- created: 2026-10-22 -->
<!-- synthesizes: 01-current-state.md (inventory) + 02-competitive-research.md (field) -->
<!-- status: proposed target. Not built. Open decisions in §7 gate several items. -->

---

## 0. DOCUMENT CONTRACT

```
PURPOSE   The ideal build: what the generalized platform should BE, having
          inventoried what exists (01) and adjudicated it against the field
          (02). This is the specification artifacts 01 and 02 were gathered
          to produce.

AUDIENCE  AI agents (primary). This document is the authoritative input for
          implementation planning and for the pitch deck.

VENTURE   Personal venture, Ely Potter + Steven Auslander. Hometown
          Ticketing's Varsity platform is the reference implementation.
          Delivered as a five-phase services engagement.

ID SCHEME PR-nn   Design principle (the invariant set)
          TA-nn   Target architecture component
          PD-nn   Product deliverable
          BS-nn   Build sequence step
          OD-nn   Open decision
          MS-nn   Measurement commitment
          RK-nn   Risk register entry
          Cross-references to 01 use L{n}-{A-D}-{nnn}; to 02 use CL-nn,
          GAP-nn, MKT-nn, BLK-nn.

RULE      Every component states PROVENANCE: CARRY (from 01, works as-is),
          REWORK (from 01, needs change), ADOPT (from 02, learned from the
          field), or NEW (neither — invented to close a gap).

HONESTY   This document states tradeoffs and costs, not just capabilities.
          Any component whose claim was downgraded in 02 carries the
          downgraded statement, not the original.
```

---

## 1. DESIGN PRINCIPLES — THE INVARIANT SET

```
These replace Varsity's I1-I8. Eight become eleven. Changes from the original
are marked. These are the rules the kit ships; the client authors the layer
below them (PD-03).
```

### PR-01 | Blast radius is computed, never declared
```
PROVENANCE  CARRY (L2-A-003) + strengthened by CL-04
STATEMENT   The risk tier of any change is computed mechanically from the
            artifact itself — the changed paths, the diff. A declared tier is
            a proposal. max(declared, computed) wins. A declared tier below
            the computed floor is itself a finding. Tiers may be raised by
            judgment, never lowered.
EVIDENCE    Every published tiering scheme scores a self-report. TrustX ARC
            §6.3 concedes "scoring subjectivity… differences in user
            interpretation can lead to varying results."
```

### PR-02 | Three-valued decisions everywhere
```
PROVENANCE  CARRY (L1-A-004) + generalized per CL-03
STATEMENT   Every gate returns allowed / denied / INDETERMINATE. "I could not
            determine" is never collapsed into "no." An indeterminate result
            fails loud and is never cached. This applies to the access layer,
            the verification layer, and the review layer alike.
CHANGE      Varsity applied this in permissions and (separately) in verify.
            It becomes one principle across all three layers.
EVIDENCE    Glean's agent access policies are documented FAIL-OPEN — "a
            configuration error, such as a typo or unknown field, makes the
            rule a no-op, and the tool call proceeds." Ramp does not address
            it. No vendor documentation defines tri-state semantics.
```

### PR-03 | Deny beats allow, centrally, across all three authorities
```
PROVENANCE  CARRY (L1-A-003) + scoped per CL-01
STATEMENT   One decision service resolves knowledge access, tool invocation,
            AND release authority. An unexpired explicit deny beats any
            number of allows. Absence of a grant is denial. Revocation is
            additive — a deny row or an expiry, never a delete.
SCOPE NOTE  Deny-wins exists in the market at the TOOL layer (AWS Cedar,
            default-deny, forbid-wins). The claim is the SPAN, not the
            primitive. State it that way.
```

### PR-04 | An unrunnable check is reported as skipped, never as passed
```
PROVENANCE  CARRY (L2-A-015)
STATEMENT   A check that could not execute reports SKIPPED with a reason. No
            aggregate result counts a skip as a pass. A run in which the
            required checks could not execute is not a passing run.
EVIDENCE    Not a product feature anywhere in the market. The closest
            analogue (Greptile) reports what DID run, not what could not.
```

### PR-05 | Verification is deterministic; judges are permitted only under declaration
```
PROVENANCE  REWORK of I8, per CL-06
ORIGINAL    "Deterministic check loops are REQUIRED; LLM self-review loops are
            FORBIDDEN."
REVISED     Deterministic checks are required and are the only thing that may
            GATE. A model-graded judge may be used ONLY when: (a) the failure
            class is declared in config as irreducibly subjective, (b) the
            judge is validated against a human-labelled set with the
            validation recorded, (c) its output is ADVISORY and cannot block,
            and (d) its score is reported alongside its validation date.
WHY CHANGED The original is stricter than mainstream practitioner guidance
            (Husain/Shankar, Sept 2026), which permits validated judges for
            irreducibly subjective failures. Forbidding them outright means
            those classes go UNEVALUATED rather than imperfectly evaluated.
            The revision keeps the gate deterministic while refusing to
            pretend the subjective surface does not exist.
EVIDENCE    2026 academic work shifted from bias to VALIDITY: judges can be
            highly reliable while invalid (kappa deflation 33-41 points;
            rankings shifting up to 14 positions). Hence the mandatory
            validation record and the advisory-only constraint.
```

### PR-06 | Every blocking finding is reproduced, and adversarially challenged
```
PROVENANCE  CARRY (L2-A-006, L2-A-007) + downgraded per CL-02
STATEMENT   A blocking finding must cite a reproduction. Before it reaches the
            record, it goes to an adversarial agent whose only job is to
            disprove it, returning CONFIRMED / NOT REPRODUCED / UNVERIFIABLE.
POSITION    Adversarial verification exists in the field (Ramp built one for a
            security pipeline; reproduce-before-report is published prior art
            at learn.agentpatterns.ai). What is unpublished is this as a
            PLATFORM-WIDE INVARIANT on every blocking finding on every change,
            with a three-valued verdict that gates the record.
OBLIGATION  See MS-01. Ramp measured theirs (40% rejection, human-confirmed).
            This principle is not defensible until ours is measured too.
TRADEOFF    The refuter runs in a stripped environment against a worktree copy
            and does not inherit the reviewer's context. This buys
            independence from confirmation bias and costs compute
            (re-exploration) and relevance. Greptile made the opposite trade
            deliberately. State the cost; do not claim there is none.
```

### PR-07 | All inbound artifact content is untrusted, including configuration
```
PROVENANCE  REWORK of I4, per CL-07
ORIGINAL    "PR title, body, diff, comments and records are untrusted data."
REVISED     Everything that arrives with the change under review is untrusted:
            title, body, diff, comments, records, AND PROVIDER CONFIGURATION
            FILES (CLAUDE.md, AGENTS.md, GEMINI.md and equivalents). The
            reviewing session's operator context comes only from a trusted
            checkout, never from the artifact under review. This is pinned by
            a test, not by convention.
WHY CHANGED GitInject found config-file injection was BY FAR the highest-
            success vector — 7 of 9 models including sonnet-4-5 and haiku-4-5,
            where PR-body injection beat only gpt-4o-mini. Model capability
            did not protect against a trust-boundary error.
REFERENCE   Varsity is currently protected INCIDENTALLY (the runner never cd's
            into the PR worktree, so Read(./**) scopes to the clean checkout).
            Nothing states or pins this. See BS-02.
```

### PR-08 | Secrets are unreachable by any means, enforced by tool restriction
```
PROVENANCE  REWORK of I4's second half, per CL-07(b)
ORIGINAL    "No file-backed secret reachable, in env or on disk."
REVISED     Nothing recoverable by ANY means — file, environment, process
            environment, or parent-process memory. The enforcing mechanism is
            tool restriction (an explicit allow-list of tools), not
            path-based denial.
WHY CHANGED GitInject recovered GEMINI_API_KEY FROM THE PARENT PROCESS; only
            removing `tr` and `grep` was effective. Path denial is
            insufficient.
REFERENCE   Varsity already satisfies this in practice (six tools via --tools;
            the team documented that removing Bash alone left ~24 tools while
            Monitor ran shell). The PHRASING needed updating, not the build.
```

### PR-09 | Merge is not release
```
PROVENANCE  CARRY (L2-A-023) + narrowed per CL-08
STATEMENT   Merging deploys dark behind a default-off flag. The flag flip is
            the release and requires a human-attested review record bound to
            the merged commit.
POSITION    Release separation exists once in the market (Salesforce:
            "Deployment does not make an agent live"). What does not exist is
            the flip GATED ON AN ATTESTED RECORD BOUND TO THE MERGED COMMIT.
            Among published in-house builds — including the most autonomous
            one — merge IS the ship.
```

### PR-10 | Every bypass is possible, logged, and measured
```
PROVENANCE  NEW (principle), carrying existing mechanism (L2-A-016)
STATEMENT   Every gate fails open. Every bypass is logged with actor, target
            and reason. BYPASS RATE IS A HEADLINE PLATFORM METRIC, reported
            alongside adoption.
WHY NEW     The best-documented internal-platform failure mode is "golden cage
            syndrome" — platforms built for control get routed around — and
            tracking installs rather than bypasses is itself a named failure
            mode. Varsity already logs every bypass
            (~/.claude/varsity-gate-bypass.log) and every hook already fails
            open. This principle makes the existing behavior a stated
            commitment and a reported number.
STRATEGIC   This is the primary structural answer to the golden-cage
            objection. See §6 of artifact 02.
```

### PR-11 | Every agent proves who it acts for, and that proof expires
```
PROVENANCE  ADOPT (GAP-01, from Ramp's agentic-identity model)
STATEMENT   Every agent has its own identity, distinct from its sponsor's.
            Credentials are short-lived and carry a mandatory expiry.
            Every action is dual-attributed to the agent AND its sponsor.
            Being added to an approval chain does not confer authority.
            Revocation propagates — nothing downstream caches a stale allow.
WHY NEW     The largest architectural gap in the inventory. The benchmark
            describes what may be REACHED but nothing about how an agent
            proves who it acts for or how that proof expires. Credential-
            sharing correlates with incidents (63.5% vs 40.9%, small n).
NOTE        Ramp's published model is a usable blueprint. Their ceiling is
            that delegation alone cannot express "never, regardless of who
            asks" — PR-03 supplies that.
```

---

## 2. TARGET ARCHITECTURE

### LAYER 1 — CONTEXT CONTROL

#### TA-01 | Decision service (replaces the Snowflake-bound resolver)
```
PROVENANCE  REWORK (L1-B-001) + ADOPT (GAP-02)
SHAPE       One seam — resolve(principal, resource, action) ->
            allowed | denied | indeterminate — with three enforcement points:
              (a) KNOWLEDGE  at query time
              (b) TOOL       at invocation time, as an unbypassable hop
              (c) RELEASE    at flag flip
            Backed by a pluggable store. The reference data model is the
            six-table star (PRINCIPAL / GROUPS / PRINCIPAL_GROUP / RESOURCE /
            RESOURCE_PLACEMENT / GRANT_FCT); adapters implement it against
            Postgres, a warehouse, or read-through to an existing IdP.
SEMANTICS   PR-02 (tri-state), PR-03 (deny-wins), success-only caching,
            no-DELETE grant history, schema identifiers validated at load.
KEY CHANGE  The TOOL chokepoint is new. Varsity allow-lists tools per request
            type at configuration time; the target intercepts at call time.
            This makes the per-call-site guardrail gap (Varsity's DEP-055)
            structurally unnecessary rather than merely tracked.
PRECEDENT   AWS Cedar does exactly this at the tool layer. Adopt the pattern;
            the span across all three authorities is what differentiates.
SHIP ORDER  Reference spec FIRST, implementation SECOND. Let the first two
            clients drive which adapters get built. Do not speculatively build
            five adapters.
```

#### TA-02 | Knowledge-source registry
```
PROVENANCE  NEW (L1-D-002), the largest pitch-vs-reality gap
SHAPE       A declared, versioned manifest: every source the agents may draw
            on — documents, warehouse objects, SaaS connectors, URLs — each
            with an OWNER, an APPROVAL RECORD, a REVIEW DATE, and a
            CONTRIBUTION MEASUREMENT (TA-04).
WHY         Steven's Layer-1 promise is literally "approved knowledge
            sources." The reference implementation has sources but no
            registry, no owner per source, and no approval record.
NOTE        This IS the Phase-2 "governance blueprint" in machine-readable
            form. It is the highest-leverage product move available: it turns
            a consultant-authored document into a generated, executable,
            testable artifact.
```

#### TA-03 | Declarative guardrail policy
```
PROVENANCE  REWORK (L1-B-004, L1-D-004)
SHAPE       Sensitive columns/fields, audience rules and per-surface policy
            declared in validated config. The client owns their policy and can
            change it without a code release.
CRITICAL    CONFIG THE VOCABULARY, KEEP THE GRAMMAR IN CODE. The tokenizer
            stays in code. Three regex versions were each defeated by
            context-blind matching; a config DSL would reintroduce exactly
            that class of error.
POSITIONING Tokenizer enforcement is ahead of the market (which is
            overwhelmingly classifier-based — Bedrock self-describes its PII
            filter as "probabilistic ML"). But sell it as the correct LAST
            line before egress, with the data-layer fix named as the real
            target. EchoGram ("flip tokens" that invert classifier verdicts)
            is the live threat to the classifier alternatives.
```

#### TA-04 | Context contribution measurement
```
PROVENANCE  ADOPT (GAP-09, from Ramp's Stack Benchmark)
SHAPE       Per-source and per-skill ablation against a deterministic task
            suite. Each knowledge source carries a measured contribution.
WHY         Ramp measured 237 tasks against 3,469 human-written criteria and
            found ONLY 2 OF THEIR OWN SKILLS WERE NET-POSITIVE. Memory took
            one task 0% -> 100% while degrading another 75% -> 25%.
            Unmeasured context is as likely to hurt as help.
ADVANTAGE   A deterministic verify harness is a BETTER foundation for ablation
            than an LLM-judged eval, because the oracle is stable. This turns
            PR-05 from a constraint into a capability.
```

#### TA-05 | Context lifecycle
```
PROVENANCE  NEW (L1-D-006)
SHAPE       Owner per source, review interval, staleness detection, and a
            change-review path. A source past its review date is flagged;
            a source whose contribution measurement goes negative is flagged.
WHY         Context rot is the #1 predictable failure mode of this
            architecture at six to twelve months. Gartner names "review
            schedule" as step 3 of six and one of the two steps vendors cover
            LEAST.
COUPLING    Context files load per request with no flag and no dark period —
            a one-line edit changes behavior for every user on the next
            request. The kit must ship that coupling as a NAMED INVARIANT
            (context edits are high-tier by construction) or clients will
            treat prompt files as inert docs. Dust demonstrates the failure:
            a skill edit propagates immediately to every consuming agent with
            no regression suite and no dark state.
```

#### TA-06 | Compliance export
```
PROVENANCE  NEW (L1-D-007) — best value-to-effort ratio in the inventory
SHAPE       A generated report: who has access to what, as of when, granted by
            whom, with immutable grant history and every indeterminate result.
WHY         The data model already supports it perfectly. Nobody built the
            report. For the regulated verticals in Steven's doc (pharma, K-12)
            this is a procurement checkbox and a door-opener.
```

### LAYER 2 — BUILDER COHORT

#### TA-07 | Orchestrator protocol
```
PROVENANCE  CARRY (L2-A-001)
SHAPE       Unchanged. Main session scopes, sets tier, routes to specialists,
            brings ONE plan to the gate, never writes production code except
            on the fast lane.
```

#### TA-08 | Specialist roster with a configurable domain-authority slot
```
PROVENANCE  REWORK (L2-A-002)
SHAPE       Six fixed roles — architect, builder, connector, scribe, refuter,
            verifier — plus ONE DOMAIN-CORRECTNESS AUTHORITY declared per
            engagement. At the reference implementation that slot is warehouse
            SQL; at a client it may be contract language, clinical protocol,
            or financial reconciliation.
PRESERVE    The capability/authority matching is the design insight and must
            survive generalization: the domain authority has READ-ONLY tools
            (it cannot run anything), the refuter HAS execution (it must
            reproduce), the scribe PROPOSES ONLY. Capability matches mandate.
NEW         A selection rubric for identifying the domain-authority slot is a
            Phase-2 deliverable (OD-05).
```

#### TA-09 | Ceremony profiles
```
PROVENANCE  REWORK (L2-A-022, L2-D-001) — HIGHEST-PRIORITY LAYER-2 ITEM
SHAPE       A declared profile setting which stages convene, the fast-lane
            thresholds, whether the plan gate is mandatory, the reviewer set
            per tier, and how much the orchestrator explains versus assumes.
WHY         The process is calibrated to engineers fluent in Claude Code, git,
            PRs and CI. Phase 4 promises self-sufficiency for the CLIENT's
            cohort, which may be an ops analyst who has never opened a
            terminal.
EVIDENCE BOTH WAYS
            FOR a lighter profile: Dust reports 20-30% of employees building
            agents (Mirakl 30%, targeting 50%). The non-technical builder path
            works at scale.
            AGAINST: Stripe's no-code Agent Builder produced 4,000+
            unmonitorable micro-agents. AWS is the only all-engineering
            platform and the only one with a publish/review/approve workflow
            — REVIEW MACHINERY GETS BUILT WHERE ENGINEERS ARE THE USERS.
            PLAUSIBLE RECONCILIATION: Dust's agents are retrieval-and-draft;
            Stripe's were operational. This is an INFERENCE, not established.
DESIGN RULE Profile by BLAST RADIUS, not by builder seniority. A non-engineer
            building a read-only draft agent gets the light profile; anyone
            building a write path gets the full one, regardless of title.
            This is PR-01 applied to the builder, and it dissolves the
            apparent contradiction in the evidence.
OPEN        Must be tested with one non-engineer before architecture is
            committed. See OD-04.
```

#### TA-10 | Authoring-layer lint
```
PROVENANCE  ADOPT (GAP-08, from Uber and Stripe)
SHAPE       Automated lint and structural review on skill/agent DEFINITIONS as
            authored artifacts — not just on code. Checks: does it declare a
            registry entry, an access key, a delivery target, plain-language
            errors, logging, and a provenance affordance.
WHY         Uber lints 2,500 skills. Stripe learned the cost of not doing so
            (4,000+ unmonitorable micro-agents). The reference implementation
            reviews CODE; agent definitions get reviewed only as a side effect
            of being code.
```

#### TA-11 | Verification harness with a check registry
```
PROVENANCE  REWORK (L2-B-004) + ADOPT (GAP-03)
SHAPE       The harness contract is preserved — ordered checks, last-line JSON
            summary, PR-04 skip semantics, exit codes, evidence file. Each
            check becomes a module declaring name, trigger, JSON contract and
            skip semantics. Adapters for Node, Python, generic-command.
NEW CAPABILITY — DURABLE VERIFICATION ARTIFACTS
            Adopt Ramp's oracle pattern: where a finding is reproducible, the
            verification step WRITES A TEST that passes only if the defect is
            absent; a test that already passes marks the finding a false
            positive; the fix is developed against it; THE TEST IS RETAINED AS
            A PERMANENT REGRESSION TEST.
WHY         Varsity's checks GATE a change and leave an evidence file. Ramp's
            leave a permanent executable asset — every finding improves the
            suite forever. This is elegant, cheap, and makes the LLM write the
            oracle and then be bound by it.
```

#### TA-12 | Review pipeline
```
PROVENANCE  CARRY (L2-A-005 through L2-A-012)
SHAPE       Unchanged in mechanism: BLOCK = blast radius including the
            silent-failure class; evidence rule; refuter; two-round author
            budget; record bound to head SHA as merge credential, enforced
            three ways; carry-forward on byte-identical diff; hunk-level
            collision detection with recorded ordering.
ADD         Reviewer-load bounding (GAP-10). Uber caps diffs per engineer.
            Varsity bounds the loop per PR but nothing bounds aggregate load.
```

#### TA-13 | Config contract and validator
```
PROVENANCE  NEW (L2-D-002) — the portability instrument
SHAPE       One declared file holding: tier map, live dirs, contract paths,
            sensitive vocabulary, approver set and VCS identities, flag
            convention, ledger path, rule-body path, agent roster, ceremony
            profile, repo identity, verify check set, knowledge-source
            registry pointer, domain-authority declaration.
            A validator refuses to start on a malformed config, mirroring
            TA-01's schema-identifier posture.
TEST        Portability is real when this file is the ONLY diff between two
            installs. That is a measurable acceptance criterion.
BOUNDARY    Config the vocabulary; keep the grammar in code. A client with
            genuinely different intent-shapes needs a plugin release, not a
            config edit. Document that boundary explicitly rather than
            discovering it.
```

#### TA-14 | Distribution
```
PROVENANCE  NEW (L2-D-004), forced by L2-B-006
SHAPE       One published plugin + config in the client repository. A HARD
            VERSION CHECK that REFUSES rather than degrading silently.
WHY         The reference implementation already suffers a cache split-brain
            at ONE organization with three engineers: the settings-registered
            copy runs new code while the marketplace cache runs old, and a
            stale cache has lock keys the dedupe lock cannot reconcile. This
            multiplies by client count, and a client's builder cohort will not
            reliably run plugin updates.
REQUIRED    Cross-platform runner. The current review-queue runner is bash and
            exits 2 on Git Bash/MSYS. Rewrite in Node — already a dependency.
            Windows is the default enterprise desktop in the stated verticals.
```

#### TA-15 | Process-health detection
```
PROVENANCE  NEW (L2-D-012) + ADOPT (GAP-05)
SHAPE       Automated detection of governance erosion: modules whose flag has
            been permanently on (dark period gone), rules never cited in any
            review, DEP rows aged past threshold, tiers consistently raised by
            judgment (the floor is wrong), bypass-log frequency and trend,
            knowledge sources past review date, skills with negative measured
            contribution.
WHY         Every one of these is already visible in the reference
            implementation's own data and none is monitored. Gartner names
            drift detection as one of the two steps vendors cover LEAST.
COMMERCIAL  This is the retainer product. A project delivers a platform; this
            keeps it from decaying, and it is the thing a client cannot do for
            themselves.
```

#### TA-16 | Agent archetype templates
```
PROVENANCE  NEW (L2-D-008)
SHAPE       Six parameterized templates covering the common shapes: scoped
            data pull, record lookup/profile, scheduled report, approval-gated
            write, document generation, intake/triage.
CRITICAL    The scaffolder emits a PARAMETERIZED engine, not a copyable one.
            The reference implementation produced three near-identical
            interview engines by cloning. A kit that teaches cloning will
            reproduce that at every client. Fix the template, not the
            instances.
MEASURED    Each template carries its own ablation result (TA-04). Ramp's
            finding that most of their skills were net-negative applies
            directly to any shipped template library.
```

### LAYER 3 — CONSUMERS

#### TA-17 | Surface-agnostic skill contract
```
PROVENANCE  NEW (L3-D-001) — KEYSTONE OF LAYER 3
SHAPE       An abstraction expressing a skill's interaction needs — menu
            entry, typed form, confirmation gate, file delivery, ephemeral
            reply, private delivery, long-output chunking, provenance
            affordance — independent of delivery surface.
WHY         Without it, every new surface is a rewrite of every skill. Design
            this BEFORE building any second surface.
SURFACES    Slack (adapter 1, exists). Then, in priority order: CRM-embedded
            (smallest real gap — the capability exists, only the surface is
            missing), Teams (largest addressable in the stated verticals),
            web/internal-app (fewest platform constraints).
```

#### TA-18 | Consumer surface
```
PROVENANCE  CARRY (L3-A-001 through L3-A-014)
SHAPE       Structured menus and typed forms. Registry-driven with visibility
            gates. Private delivery by default with test-pinned, individually
            justified exceptions. Hub-level first-run onboarding. Help and
            feedback on every surface. Per-result provenance. Reaction
            feedback with inferred reason. Deprecation via logged moved-stubs.
POSITION    Every platform in the field is a chat box. The reference
            implementation BUILT a conversational path, MEASURED it, and
            DELETED it — flag and tool-loop removed, not disabled. That is an
            evidence-backed product position.
KEEP SHARP  This is about the CONSUMER surface. Dust's 20-30% builder adoption
            shows a chat-first BUILDER experience works. Do not conflate them.
DECIDE      Private-by-default (reference) versus public-by-default (Shopify's
            River works only in public channels, no DMs). Both are defensible:
            Shopify optimizes for observability and shared learning; the
            reference optimizes for data-exposure containment. State it as a
            deliberate, configurable choice (TA-13), not an oversight.
```

#### TA-19 | Durable session store
```
PROVENANCE  REWORK (L3-B-006)
SHAPE       Pluggable store. Memory for dev, Redis/Postgres for production.
            Preserve the semantics that came from watching real usage: active
            TTL, post-delivery revision window, tombstone with an explicit
            "session closed" notice.
```

#### TA-20 | Baseline and outcomes instrumentation
```
PROVENANCE  NEW (L3-D-005, L3-D-006)
SHAPE       (a) A baseline instrument capturing pre-deployment cost and cycle
                time for a target workflow.
            (b) An outcomes dashboard: adoption, usage, outcomes against
                baseline, per-agent value, AND BYPASS RATE (PR-10).
WHY         Promised in Phase 1 and Phase 5. Nothing in the reference
            implementation measures it.
CAUTION     Steven's stated figures (60%+ cost reduction, 300%+ efficiency)
            are carried as HIS CLAIM, attributed, per Ely's decision
            2026-10-22. They are not derived from platform instrumentation.
            Once TA-20 exists, replace them with measured numbers.
            MKT-01's critique cuts both ways: buyers who do not baseline
            cannot validate a claim — and neither can we.
```

#### TA-21 | Cost control plane
```
PROVENANCE  ADOPT (GAP-04, from Ramp and Dust)
SHAPE       Per-builder, per-project, per-team cost attribution. Pre-emptive
            limits. Circuit breakers at multiple scopes. Live meters.
WHY         Ramp's ENTIRE GLASS PRODUCT exists because of a cost failure —
            $1.5M of tokens in one week. The reference implementation has a
            $10/hr rolling breaker and per-call logging but no rollup and no
            pre-emptive limits. A client funding a builder cohort asks within
            one month.
```

#### TA-22 | Agent discovery
```
PROVENANCE  NEW (L3-D-007)
SHAPE       Search and recommendation across the agent library.
WHY         A menu works at 51 entries across 8 hubs. It does not at 150.
            Gartner projects Fortune 500 agent counts going from <15 to
            >150,000 by 2028. Every client that succeeds hits this.
```

---

## 3. PRODUCT SHAPE

### PD-01 | The plugin
```
One published plugin — hooks, statusline, scripts, headless settings template,
telemetry. Every org-specific constant read from config. Cross-platform.
Hard version check that refuses on mismatch.
```

### PD-02 | The config contract
```
TA-13. The portability instrument and the measurable acceptance criterion.
```

### PD-03 | The rule body, split
```
INVARIANT LAYER (~200 lines, ships with the kit): PR-01 through PR-11, the
review rules, the stage map, the ceremony table, BLOCK semantics.
ORG LAYER (authored per client at onboarding): the paved road, the domain
canon, the worked examples, the corrections.
AUTHORING GUIDE: how to write a correction, when a rule earns a mechanism, how
to retire a rule, how to tell an invariant from a convention.
WHY THE SPLIT  The reference rule body is valuable BECAUSE it accumulated
corrections ("the prior wording cited campaign previews — that was factually
wrong"). A client cannot inherit those, and a kit that ships only the shape
without the authoring discipline degrades to a style guide.
```

### PD-04 | The scaffolder
```
/platform-init. Lays down the rule-body skill from template, the contract stub
with its import, the ledger skeleton, the verify harness with a stack adapter,
CI workflows, CODEOWNERS, the branch-protection script, and the knowledge-
source registry skeleton.
```

### PD-05 | The reference implementation
```
Hometown's Varsity: a year of accumulated corrections, 303 ledgered
dependencies, a production deployment. This is the credential competitors
cannot fabricate, and MKT-06 makes it disproportionately valuable — no firm at
any tier publishes an engagement success rate, so there is no benchmark
against which a single reference looks small.
```

### PD-06 | The demo
```
Four moments, each under a minute, each showing the mechanism CATCHING
something:
  1. A declared Tier: T0 raised to T2 by the computed floor.
  2. The fast lane REFUSING a prompt because it names a sensitive word.
  3. A planted silent-failure bug (an empty export reported as "42 removed")
     raised by a reviewer and CONFIRMED by the refuter.
  4. A verify run where a leg could not execute, reporting SKIPPED.
Moment 4 is the strongest. Every buyer has been burned by a green check that
meant nothing, and no competitor can show the equivalent.
```

---

## 4. CLAIM POSITIONS — APPROVED EXTERNAL STATEMENTS

```
Use these verbatim. They are the adjudicated forms from 02 §3. Do not restore
the stronger originals.
```

```
ON FAILURE SEMANTICS (strongest claim)
"No vendor documentation defines what happens when a permission check cannot
complete. The category leader documents the opposite: a configuration error
makes the rule a no-op and the call proceeds. We treat 'I could not determine'
as its own answer, and it never silently becomes 'yes' or 'no'."

ON VERIFICATION
"An unrunnable check reports as skipped, never as passed. That is not a
product feature anywhere in this market."

ON RISK TIERING
"Risk tiers exist. Every published scheme scores a self-report — and the most
rigorous one names that as its own limitation. We compute the tier from the
change itself and take the higher of declared and computed."

ON PERMISSIONS
"Deny-wins exists in the market at the tool-invocation layer. What does not
exist is one centrally-resolved decision spanning knowledge, tools and release
authority, where an explicit deny beats any number of allows."

ON REVIEW
"Adversarial verification of findings exists in the field — Ramp built one for
a security pipeline. What is unpublished is applying it as a platform
invariant to every blocking finding on every change, with a three-valued
verdict that gates the record."

ON RELEASE
"Release separation exists in one enterprise platform. What does not exist is
a release gated on a human-attested review record bound to the merged commit.
Among published in-house builds, including the most autonomous one, merge is
the ship."

ON ARCHITECTURE (reframe, do not claim)
"Everyone who has solved this seriously has built the same three layers. That
is validation, not differentiation. Here is what every one of them still gets
wrong."

ON THE GOLDEN CAGE (the dangerous objection)
"Every gate fails open, every bypass is logged, and we report bypass rate as a
headline metric. A platform that cannot be routed around is a platform people
route around. We measure whether ours is."

ON OUR OWN LIMITS (say this unprompted)
"We have not yet measured our refuter's rejection rate. Ramp measured theirs
at 40%, human-confirmed. We will have that number before we ask anyone to rely
on it."
```

---

## 5. BUILD SEQUENCE

```
Ordering rationale: de-risk before packaging; close falsifiable gaps before
selling; build surfaces only when a deal requires them.
```

### BS-01 | Extract configuration in place
```
EFFORT   S-M   BLOCKS  everything in PD
WHAT     Pull hardcoded constants out of the tier-floor script, the fast-lane
         classifier, the shared hook library, the CODEOWNERS checker and the
         author-record checker into one config file. Behavior byte-identical,
         proven with existing tests.
WHY FIRST
         It is the de-risk. If these read config cleanly, generalization is
         real. It also pays for itself independently: the tier table currently
         exists twice (as prose in the rule body and as arrays in the script),
         which is why the rule body already has to say "run the script; never
         infer the floor from this table."
```

### BS-02 | Close the two threat-model gaps
```
EFFORT   S    BLOCKS  any external security claim
WHAT     (a) Name provider config files in the untrusted-input principle
             (PR-07) and PIN THE SESSION CWD WITH A TEST.
         (b) Restate the secret posture as reachability-based (PR-08).
WHY NOW  Cheap, and the protection currently exists by accident. Also: these
         must be true before the threat model appears in any deck.
```

### BS-03 | Measure the refuter
```
EFFORT   S    BLOCKS  the PR-06 claim
WHAT     Compute rejection rate, confirmation rate and false-positive-kill
         rate from the existing review-record corpus. The data already exists.
WHY NOW  CL-02 is the weakest of the seven differentiators precisely because
         Ramp measured theirs and we did not. This is a day's work against
         data already on disk, and it converts the weakest claim into a
         defensible one.
```

### BS-04 | Split the rule body and write the authoring guide
```
EFFORT   M    BLOCKS  PD-03, EP-2 delivery
```

### BS-05 | Config contract, validator, scaffolder
```
EFFORT   M    DEPENDS BS-01, BS-04
```

### BS-06 | Ceremony profiles, tested with a non-engineer
```
EFFORT   M    DEPENDS BS-05    GATES  OD-04
WHAT     Expose the existing dials (depth, fast lane, ceremony-by-tier) as a
         declared profile. Profile by blast radius, not builder seniority.
         TEST WITH ONE ACTUAL NON-ENGINEER before committing architecture.
```

### BS-07 | Verify check registry + durable verification artifacts
```
EFFORT   M    WHAT  TA-11, including Ramp's test-as-oracle pattern
```

### BS-08 | Knowledge-source registry + compliance export
```
EFFORT   M+S  WHY   TA-02 is the biggest pitch-vs-reality gap; TA-06 is the
                    best value-to-effort ratio in the inventory
```

### BS-09 | Agent identity model
```
EFFORT   L    WHAT  PR-11 / TA-01 integration. Ramp's published model is a
                    usable blueprint.
```

### BS-10 | Tool-invocation chokepoint
```
EFFORT   L    WHAT  TA-01(b). Cedar-style interception.
```

### BS-11 | Cost control plane
```
EFFORT   M    WHY   Asked for within one month of any builder cohort
```

### BS-12 | Surface-agnostic contract, then one surface
```
EFFORT   L+M  RULE  Design TA-17 before building any second surface. Build the
                    second surface only when a deal requires it. CRM-embedded
                    is the smallest real gap and the best early win.
```

### BS-13 | Process-health detection
```
EFFORT   M    WHY   The retainer product
```

```
PARALLEL TRACK (non-engineering, gates commercial delivery)
  Resolve the BMAD licensing question (OD-02). 55 of 69 skills are third-party
  and sit inside the value proposition. This is a commercial blocker, not a
  technical one, and it blocks every client install.
```

---

## 6. MEASUREMENT COMMITMENTS

```
Claims we make that we must be able to evidence. Each is a product
requirement, not a marketing task.
```

```
MS-01  Refuter rejection rate, confirmation rate, false-positive-kill rate.
       (BS-03. Ramp's comparable: 40% rejection, human-confirmed.)
MS-02  Bypass rate — fraction of changes that went around a gate, by gate and
       by actor. (PR-10. No competitor can report this.)
MS-03  Per-source and per-skill contribution. (TA-04. Ramp found only 2 of
       their skills net-positive.)
MS-04  Tier-floor corrections — how often declared is below computed. (Direct
       evidence that self-reporting fails; PR-01's justification.)
MS-05  Indeterminate rate — how often a gate returns "could not determine."
       (PR-02's justification, and an operational health signal.)
MS-06  Skip rate by check. (PR-04. Also exposes which checks never actually
       run.)
MS-07  Cycle time from intake to release, by tier. (The efficiency claim.)
MS-08  Baseline-to-outcome delta per deployed agent. (TA-20. Replaces the
       carried 60%/300% figures once real.)
```

```
NOTE ON SV-06: across all five published in-house builds, defect rates, revert
rates and incidents attributable to agent-written code are ENTIRELY
UNDISCLOSED. That is the metric that would validate any governance model,
including this one. Publishing it would be a genuine first — and a strong
credential. Consider committing to it.
```

---

## 7. OPEN DECISIONS

```
OD-01  HOSTING MODEL. Client-hosted only, or a hosted option?
       RECOMMEND client-hosted-only for v1: matches the pitch ("inside your
       environment"), avoids multi-tenancy entirely, and is a security selling
       point. BLOCKS: multi-tenant isolation work, parts of TA-14.

OD-02  BMAD LICENSING. 55 of 69 skills are third-party BMAD-METHOD. Terms for
       commercial redistribution UNVERIFIED. BLOCKS every client install.
       OPTIONS: verify redistribution is permitted; replace the critical-path
       subset with first-party equivalents; make BMAD optional with
       first-party fallbacks.

OD-03  FIRST-CLIENT SURFACE. Slack or not? A Slack client makes the pilot
       phase near-turnkey; a Teams client makes it an L-sized build before
       anything ships. STRONGLY PREFER SLACK FOR ENGAGEMENT #1.

OD-04  BUILDER PROFILE. Who is the cohort, concretely? Determines whether
       TA-09 is config or a second product. TEST WITH ONE NON-ENGINEER BEFORE
       COMMITTING. The evidence genuinely cuts both ways (Dust 20-30% vs
       Stripe's 4,000 unmonitorable agents); TA-09's blast-radius-not-
       seniority rule is the proposed reconciliation and needs validating.

OD-05  DOMAIN-AUTHORITY SELECTION RUBRIC. For a client with no warehouse, what
       is the domain-correctness authority? Needs a selection method, as a
       Phase-2 deliverable.

OD-06  COMMERCIAL MODEL. Direct delivery only, or the Team Topologies shape
       (named framework, accelerator sold direct, delivery licensed to
       accredited partners)? The latter decouples revenue from two calendars.
       Their partner terms are not public and need direct inquiry.

OD-07  THE CARRIED METRICS. Steven's 60%+ / 300%+ figures are carried as his
       claim, attributed. Once TA-20 exists they should be replaced with
       measured numbers. Decide the timeline for that, and the basis for the
       current figures, before a prospect asks.
```

---

## 8. RISK REGISTER

```
RK-01  GOLDEN CAGE. The best-documented internal-platform failure mode, and
       three signature features read as control-first. MITIGATION: PR-10
       (bypass rate as a headline metric), lead with the refuter-as-due-
       process and skip-reporting-as-anti-vanity-metric framings, price
       enablement as mandatory. SEVERITY: HIGH. This is the objection most
       likely to lose a deal.

RK-02  BUILD-VS-BUY WINDOW. Ramp Glass went external 2026-10-13. Within ~12
       months "we built it ourselves" weakens as a story. MITIGATION: the
       differentiators in §4 are governance mechanics, not workspace
       features — Glass is a workspace product, not a governance framework.
       SEVERITY: MEDIUM, rising.

RK-03  BMAD DEPENDENCY. See OD-02. SEVERITY: HIGH until resolved. Blocks
       commercial delivery entirely.

RK-04  UNMEASURED CLAIMS. Several differentiators are design assertions with
       no measurement. Ramp measured their refuter; we have not.
       MITIGATION: §6. SEVERITY: MEDIUM, cheap to fix.

RK-05  TWO-PERSON CAPACITY. Delivery is bounded by two calendars.
       MITIGATION: OD-06. SEVERITY: MEDIUM, structural.

RK-06  SURFACE LOCK-IN. Slack-only closes Teams-first verticals, which the
       stated target industries skew toward. MITIGATION: OD-03 plus TA-17
       before any second surface. SEVERITY: MEDIUM.

RK-07  CEREMONY MISMATCH. If TA-09 proves insufficient and the cohort cannot
       use the process, Layer 2 needs a second product (XL). MITIGATION:
       OD-04, tested early. SEVERITY: HIGH if unaddressed, LOW if tested
       before committing.

RK-08  CONTEXT ROT. Context loads per request with no flag and no dark period.
       At six to twelve months this is the predictable failure.
       MITIGATION: TA-05. SEVERITY: MEDIUM, and it is a known killer.

RK-09  CLAIM EROSION. Vendors ship monthly; several claims in §4 are
       absence-based. MITIGATION: re-verify before each external use; artifact
       02 §8 lists the specific items needing re-check. SEVERITY: LOW per
       instance, HIGH cumulatively if never refreshed.
```

---

## DOCUMENT END

```
DERIVED FROM  01-current-state.md (125 inventoried items)
              02-competitive-research.md (14 competitor profiles, 11 claims
              adjudicated, 12 capability gaps)

NEXT          Pitch deck for Ely Potter + Steven Auslander (internal).
              Must include: the solution, the three layers, pros and cons,
              competitor analysis, proposed improvements, the final pitch.
              Lead per 02 §P-05: the 5% statistic, then the two 30-second
              demos. NOT the layer diagram.
```
