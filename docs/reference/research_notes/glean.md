# Glean as a Governed Internal AI Agent Platform

**Research date: 2026-10-22.** All "current" claims are as of this date. Glean ships fast and labels many governance features beta, so status claims below are the most perishable part of these notes. Where a page did not state GA/beta, I say so rather than guessing.

A standing caveat that applies to every section: Glean publishes no pricing, and its security architecture detail (ACL sync cadence, caching, query-time failure behavior) is **not** in public docs. Several of the most decision-relevant questions in this assignment are answerable only from the Trust Portal under NDA. I flag each of those as a gap rather than inferring.

## Product architecture (Assistant, Agents, Agent Builder, Work AI platform, knowledge graph, connectors)

### Takeaway
Glean is a connector-fed index plus a knowledge graph, with three consumption layers on top: Search, Glean Chat/Assistant, and Agents (built in Agent Builder in either an LLM-driven "Auto mode" or a deterministic "Workflow mode"). As of late 2026 the strategic push is "independent agents" that own a workflow, hold their own identity, and act proactively — announced at Glean:GO in Aug 2026 with most pieces labeled beta or unlabeled.

### Cited Findings
- Public docs are organized as: User Guide, Agents, Get Started for Admins, Connectors, Tools, Admin Guide, Security & Architecture, Troubleshooting, Release Notes — [Glean docs home](https://docs.glean.com/)
- Agents are composed of five building blocks: goal and instructions, knowledge and context, tools and actions, execution, and output and memory — [How Agents Work](https://docs.glean.com/agents/how-agents-work)
- **Auto mode** is the default: the builder describes the outcome in natural language, "Builder Assistant" generates a draft, and the agent chooses its own execution path at run time. Positioned for research, analysis, summarization, drafting — [How Agents Work](https://docs.glean.com/agents/how-agents-work)
- **Workflow mode** gives explicit control over each step, branch, and hand-off; positioned for "fixed, repeatable processes." Workflow agents use steps (a single unit of work) and flow (routing, including branches and sub-agent calls) — [How Agents Work](https://docs.glean.com/agents/how-agents-work)
- Auto-mode agents can use a **Task tool** to decompose a request into sub-tasks dispatched to independent sub-agents; this is **enabled by default** for supported agents. Docs say the Task tool "maintains agent permissions and error handling" — [How Agents Work](https://docs.glean.com/agents/how-agents-work)
- Workflow memory model: each step writes output to working memory; the **default context setting passes only the previous step's output**, configurable to all prior outputs or none. `[[ ]]` syntax references specific step outputs or user inputs — [How Agents Work](https://docs.glean.com/agents/how-agents-work)
- Tools both read (documents, tickets, records, calendars) and **write** (to connectors, drafting emails/summaries/reports, updating external systems) — [How Agents Work](https://docs.glean.com/agents/how-agents-work)
- Triggers: manual run from the Agent Library or a direct link, on a schedule, or on external content / system updates. Content triggers are configured in Workflow mode by selecting "Content" as the trigger type in the "zero step"; trigger payload is injected as `[[Trigger input]]`. **Content triggers must be enabled by an admin** under Agents in the Admin console — [Content trigger](https://docs.glean.com/agents/concepts/content-trigger)
- Example first-agent tutorial uses an Input form trigger + Read document tool + Respond tool — [Create your first agent](https://docs.glean.com/agents/create-agents/create-your-first-agent)
- Glean markets Agent Builder explicitly as a **no-code tool** — [Glean AI agent builder product page](https://glean.com/ai-agent-builder)
- Glean ships **MCP servers** as a platform surface — [Glean docs home](https://docs.glean.com/), [MCP about](https://docs.glean.com/administration/platform/mcp/about)
- **Agent2Agent (A2A) interoperability** is described as shipped, letting Glean agents coordinate with agents on other platforms — [Glean Agents GO 2026](https://www.glean.com/blog/glean-agents-go-2026)
- **Git sync**: agents can sync with Glean through Git so builders work in their own repos while admins manage agents in Glean. **Coding-tool authoring**: build, preview, and iterate on agents from Claude Code and Cursor. Neither carries a status label — [Glean Agents GO 2026](https://www.glean.com/blog/glean-agents-go-2026)
- "Version checkpoints" and collaborative editing described as shipped (no status label) — [Glean Agents GO 2026](https://www.glean.com/blog/glean-agents-go-2026)
- **Independent agents** (Aug 2026 positioning): own a workflow, have their own identity and provisioned access, build memory of standard operating procedures, act proactively, and escalate to a human only when a decision is needed. First one is an **engineering on-call assistant** that reads escalations, investigates across Slack/Jira/GitHub, and drafts fixes. Announced-but-undated: on-call management, voice-of-the-customer synthesis, sales — [Glean Agents GO 2026](https://www.glean.com/blog/glean-agents-go-2026)
- **Agent identity** (act under its own scoped credentials across "more than a dozen" connected tools) is explicitly **public beta**. Independent Agents use **admin-managed credentials** — [Glean Agents GO 2026](https://www.glean.com/blog/glean-agents-go-2026); [How Agents Work](https://docs.glean.com/agents/how-agents-work)
- Connector surface includes native connectors for Power BI, BigQuery, Outlook Calendar, Slack, and many others; a competitor review cites "100+ enterprise tools" — [Glean docs home](https://docs.glean.com/); [Workativ Glean review](https://workativ.com/blog/glean-review)
- **Slack Real-Time Search (RTS) connector** is architecturally distinct: it does **not** crawl or index Slack message content. Message bodies are retrieved live from Slack at query time via the RTS API and processed in memory only. Daily digest is not supported on RTS-powered deployments — [Slack RTS connector](https://docs.glean.com/connectors/native/slack/setup/slack-rts-connector)
- Deployment model: Glean offers **SaaS and customer-hosted** deployments; customer-hosted is documented for GCP and AWS — [Security & Architecture](https://docs.glean.com/security)

### Inferences
- The two builder modes map to two different governance problems. Workflow mode is auditable by construction (a fixed graph you can diff), while Auto mode's path is chosen at run time by the model — so "what will this agent do" is not statically answerable for Auto agents. Glean's governance answer to this is runtime policy enforcement (see Permissions section) rather than build-time constraint.
- The Task-tool sub-agent fan-out being **on by default** means blast radius for an Auto agent is larger than a reviewer inspecting the top-level agent definition would assume.
- The knowledge graph is a longstanding Glean marketing pillar but did **not** appear as a documented section in the current public docs navigation. I would treat "knowledge graph" as an internal ranking/personalization component (people, activity, content relationships feeding relevance) rather than a governable, inspectable artifact.

### Gaps
- No public documentation page for the knowledge graph itself: what nodes/edges it holds, whether graph-derived signals are permission-checked, or whether a user can see why a result ranked.
- No public doc enumerating the complete list of trigger types or the complete tool catalog with read/write classification.
- GA vs beta status is unlabeled for Git sync, coding-tool authoring, A2A, version checkpoints, and governance policies. The Aug 2026 blog labels only three features (agent identity = public beta, built-in evals = private beta, agent scanning = beta) and labels **nothing** as GA.

## Permissions and access control

### Takeaway
Glean mirrors source-system ACLs into its own identity/permissions store and enforces at **query time** by filtering the index to documents whose ACLs admit the authenticated user's resolved group set. The semantics are **allow-list only** — there is no documented deny rule and no documented distinction between "denied" and "could not determine." An unknown group silently matches nobody (fails closed on retrieval), while the newer agent-runtime policy layer explicitly **fails open** (a malformed or timed-out rule becomes a no-op and the tool call proceeds). Access decisions are not auditable as a grant ledger; what exists is an admin-action audit log plus a "Findings" log of policy violations.

### Cited Findings

**Mirroring and the ACL data model**
- Glean enforces permissions **at query time**, so results are scoped per user. Connectors supply source ACLs as a `DocumentPermissionsDefinition` on each document — [Indexing SDK: permissions](https://developers.glean.com/libraries/indexing-sdk/permissions)
- ACL fields are `allowed_users` (by email or datasource user ID), `allowed_groups`, and `allowed_group_intersections`. Within one intersection entry a user must belong to **every** listed group; separate entries are alternatives (OR of ANDs) — [Indexing SDK: permissions](https://developers.glean.com/libraries/indexing-sdk/permissions)
- **All three fields are allow-lists.** No deny field is documented — [Indexing SDK: permissions](https://developers.glean.com/libraries/indexing-sdk/permissions)
- Docs explicitly instruct keeping groups as group **references**, not flattening to user lists, because "flattened ACLs go stale when membership changes" — [Indexing SDK: permissions](https://developers.glean.com/libraries/indexing-sdk/permissions)
- Identity sync: `get_identities()` returns users, groups, and memberships; `BaseDatasourceConnector.index_data()` runs it **before** the content crawl. Sync and async **streaming** connectors do **not** call it — identities must be pushed separately before indexing documents, or a non-streaming connector must be used — [Indexing SDK: permissions](https://developers.glean.com/libraries/indexing-sdk/permissions)
- Returning `groups` without `memberships` raises `InconsistentDataError`. Users-only is valid — [Indexing SDK: permissions](https://developers.glean.com/libraries/indexing-sdk/permissions)
- Admin-console statement of the principle: "Glean respects existing access control lists (ACLs) for all signed-in users" — [Secure configuration](https://docs.glean.com/security/secure-configuration)
- "Permission mirroring" is listed as a core security principle on the Security & Architecture hub — [Security & Architecture](https://docs.glean.com/security)

**Query-time resolution mechanics (patent, not necessarily production)**
- Glean's patent describes a query handler that first resolves the user's primary identity, then queries the identity-and-permissions store to acquire **all groups the user belongs to across all data sources**, then filters the index so only ACL-admitting documents return — [US11790104B2, Permissions-aware search with document verification](https://patents.google.com/patent/US11790104); [US11593409](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11593409); [US20220269703](https://patents.justia.com/patent/20220269703)
- *Caveat: patents describe filed designs and may not match the shipped system. The patent title says "with document verification," which implies a post-retrieval check against the source, but I could not corroborate a live source-of-truth re-check in any Glean doc.*

**Failure behavior — the critical asymmetry**
- Unknown-group semantics, quoted from Glean's own developer docs: **"An ACL naming a group Glean has never heard of matches nobody."** Documents referencing an unknown group are effectively hidden from everyone — [Indexing SDK: permissions](https://developers.glean.com/libraries/indexing-sdk/permissions)
- Agent access policy evaluation is **fail-open**: a configuration error such as a typo or unknown field makes the rule a **no-op and the tool call proceeds**. An expression timeout also defaults to a no-op and the call is allowed — [Agent access policies](https://docs.glean.com/administration/protect/ai-security/agent-access-policies)
- **Skill scanning is fail-open**: a skill with findings stays usable even at High or Critical severity, and a *failed scan* also does not block use. Only a moderator manually disabling the skill stops its use — [Skill scanning](https://docs.glean.com/administration/managing-skills/skill-scanning)
- Retrofitting permissions is expensive: allow-all ACLs are called out as a data-leak risk and "retrofitting them means re-indexing everything" — [Indexing SDK: permissions](https://developers.glean.com/libraries/indexing-sdk/permissions)
- The connector test harness phase 2 **rejects** documents with missing `permissions`, `allow_anonymous_access=True`, or `allow_all_datasource_users_access=True`, because these "prevent proving denial" — [Indexing SDK: permissions](https://developers.glean.com/libraries/indexing-sdk/permissions)

**Verification tooling**
- Connector authors verify with `negative_test_identities` in `testing_config.yaml`, or `extract_permission_refs()` + `assert_negative_identities_absent()` in code. Docs state searching **as a restricted user on a real instance is the ground truth** and "the upload response is not" — [Indexing SDK: permissions](https://developers.glean.com/libraries/indexing-sdk/permissions)
- Admins have a **"Verify access"** function in the Admin console to confirm a document's visibility matches expectations — [Secure configuration](https://docs.glean.com/security/secure-configuration)

**Runtime policy layer on top of ACLs (Glean Protect+)**
- **Agent access policies** let security admins set rules on what data agents may read and what actions they may take at run time. Each policy has a scope plus one or more rules; **max 20 rules per policy** — [Agent access policies](https://docs.glean.com/administration/protect/ai-security/agent-access-policies)
- Two enforcement points: **Tool call** rules run before a tool executes (inspecting tool identity and input arguments) and **Tool output** rules run after return (inspecting the structured response payload). Conditions are written in **CEL** supporting `=`, `!=`, `in`, `like` — [Agent access policies](https://docs.glean.com/administration/protect/ai-security/agent-access-policies)
- Three actions: **Block** (pre-execution stops the call and returns an error to the agent; post-execution drops the entire payload — in both cases the agent treats it as a failed tool run and **continues**), **Filter** (post-execution only; removes only matching items, agent gets a partial sanitized result set), **Flag for review** (call proceeds, event logged) — [Agent access policies](https://docs.glean.com/administration/protect/ai-security/agent-access-policies)
- **If multiple policies apply to one run, the most restrictive outcome wins** — the closest thing Glean has to deny-wins, but it resolves conflicts *between policies*, not between allow and deny grants — [Agent access policies](https://docs.glean.com/administration/protect/ai-security/agent-access-policies)
- Policies "sit on top of existing source permissions and RBAC rather than replacing them"; they can only *restrict* agent behavior — [Agent access policies](https://docs.glean.com/administration/protect/ai-security/agent-access-policies)
- Stated latency budget: 10–50 ms added per call. Policy updates apply immediately to new tool calls — [Agent access policies](https://docs.glean.com/administration/protect/ai-security/agent-access-policies)
- Status: the page states **"This feature is in beta and may change,"** and it is gated to the **Glean Protect+** SKU — [Agent access policies](https://docs.glean.com/administration/protect/ai-security/agent-access-policies)
- Separate **AI security policies** (Glean Protect → AI security → Policies) guard prompt injection, data leaks, and harmful output. **High-severity violations stop the run and block the action**; lower-severity are flagged in the Findings tab. Policies can target Glean Assistant, interactive agents, or auto-triggered agents separately — [Configuring policies](https://docs.glean.com/administration/protect/ai-security/configuring-policies)
- Sensitive-content controls (Glean Protect): scan connectors for infotypes (PII, PCI, credentials) plus custom terms/regex; run continuously or weekly; **autohide** flagged content from Search and Assistant while it is remediated at source; run sensitive-content reports **before** making a connector visible to all users — [Secure configuration](https://docs.glean.com/security/secure-configuration)
- Visibility controls: hide documents from all users / all but the owner / all but explicit sharers, bulk-appliable via CSV; per-application **redlists and greenlists** to exclude or include repos, folders, items; for Microsoft environments, **Purview sensitivity labels** can restrict indexing of Office 365 content — [Secure configuration](https://docs.glean.com/security/secure-configuration)

**Audit trail**
- **Admin audit logs** cover administrative actions and are documented as helping with "troubleshooting configuration issues, maintaining security compliance, and tracking changes made by both internal admins and Glean support staff." Documented categories: data source configuration, system configuration, and API. For the API category the docs say the logs capture **all API calls made by users and applications**, with listed endpoints including `/api/v1/search`, `/api/v1/chat`, `/api/v1/chat/refine` — [Admin audit logs](https://docs.glean.com/administration/management/audit-logs/admin-audit-logs)
- "Admin audit logs are on by default" and can be **exported to a SIEM**. "Document-level actions are also auditable" — [Secure configuration](https://docs.glean.com/security/secure-configuration)
- Policy-violation findings (Block / Filter / Flag) land in **Protect → AI security → AI security issues**, each finding carrying the agent, tool, triggered rule and condition, initiating user, input arguments or offending items, and the mitigation taken — [Agent access policies](https://docs.glean.com/administration/protect/ai-security/agent-access-policies)
- The agent access policies page **does not say** whether calls matching no rule, or no-op failures, are logged at all — [Agent access policies](https://docs.glean.com/administration/protect/ai-security/agent-access-policies)
- Third-party security analysis argues zero-copy / permission-mirroring architectures still leave a residual exposure: AI search can **infer and present** information synthesized from sources the user never directly accessed — [Knostic: Glean data security](https://www.knostic.ai/blog/glean-data-security)

### Inferences
- The failure-mode story is **split and inconsistent by layer**, which is the single most important finding in this section. Retrieval-layer misconfiguration fails *closed and silent* (unknown group → invisible to everyone, no signal that anything is wrong). Agent-runtime policy and skill scanning fail *open* (bad rule → allowed). Neither layer raises a loud, distinguishable "could not determine" condition. A Glean customer with a typo'd group reference gets quiet under-retrieval they may never notice; a customer with a typo'd CEL policy gets silent non-enforcement of a control they believe is on.
- Because ACLs are allow-list only with no deny primitive, "deny-wins" is not expressible at the document/grant level in Glean. The nearest analogue is admin-side **autohide / hide-document / redlist** overrides and the "most restrictive policy wins" rule in the agent policy layer — both administrative overlays rather than part of the grant model.
- Access decisions do not appear to be modeled as an append-only grant ledger. Revocation presumably happens by the source system dropping the user from a group, which propagates through identity sync and simply changes what the mirror says — so the *history* of who could see what at a given past moment is likely not reconstructable from Glean. I could not find any doc describing grant history or point-in-time access reconstruction.
- The explicit warning that "the upload response is not" ground truth, and that real-instance search as a restricted user is, suggests Glean itself does not consider its indexing pipeline's acknowledgments trustworthy evidence of correct permissioning. That is an honest and useful disclosure, but it pushes permission verification onto the connector author as a manual test step.

### Gaps
- **ACL/identity resync cadence is not publicly documented.** The Indexing SDK page explicitly notes it does not cover caching, how often identities and ACLs resync, or how identity changes propagate to already-indexed documents.
- **Caching of permission decisions is not documented at all** — neither whether decisions are cached, nor TTL, nor whether failures are cached (the "success-only caching" question cannot be answered from public sources).
- **Query-time behavior when the permissions/identity store is unavailable is not documented.** Does search fail closed, serve stale permissions, or error? Not stated anywhere I found.
- Whether the patent's "document verification" (re-checking against the source system before display) is live in production. A third-party review claims Glean supports "per-document, per-field, and even per-sentence ACL logic"; I found **no Glean source** for per-field or per-sentence ACLs and treat that claim as unverified vendor-adjacent commentary — [Nimbus vs Glean](https://gonimbus.ai/blog/nimbus-vs-glean/)
- Audit log **retention period, export format, and which roles can read them** are not in the pages I retrieved.
- Encryption detail, data residency, LLM data-retention terms, and SOC 2 report contents are all behind the **Trust Portal under NDA** — [Security & Architecture](https://docs.glean.com/security)

## Who builds agents, and what the building experience looks like

### Takeaway
Glean deliberately targets **non-technical business users** as the primary builder cohort (no-code builder, natural-language authoring), with a developer path added in 2026 (Git sync, authoring from Claude Code/Cursor, MCP, SDKs). Permission to *create* is broad by default; permission to *publish* is not.

### Cited Findings
- Glean markets the builder as a no-code tool — [AI agent builder](https://glean.com/ai-agent-builder)
- Default Member permissions: **"Can create agents" is On, "Can publish agents" is Off** — [Secure configuration](https://docs.glean.com/security/secure-configuration)
- Role model for agents: **Admins/Super Admins** govern platform-wide settings; **Agent Moderators** can create, edit, and share any agent; **Agent Creators** build their own agents; **Default Members** follow organization defaults — [Secure configuration](https://docs.glean.com/security/secure-configuration)
- Admin RBAC guidance recommends least privilege: Setup Admin for SSO/connectors, Admin for platform config and user permissions, Super Admin only for security-only workflows, with periodic role review — [Secure configuration](https://docs.glean.com/security/secure-configuration)
- Authoring UX: on creation you choose **"Build with Natural Language"** (describe the agent in plain language, Glean generates the steps) or **"Start from Scratch"** (configure each step in the visual builder). The Workflow-mode UI is a **canvas** for the trigger-and-steps flow with a step configuration panel on the right for inputs and instructions — [Create your first agent](https://docs.glean.com/agents/create-agents/create-your-first-agent)
- A step either performs an action or **chooses among several actions based on conditions you specify** (branching) — [How Agents Work](https://docs.glean.com/agents/how-agents-work)
- **Agent Templates** are a documented starting point — [Agent Templates](https://docs.glean.com/agents/templates)
- Training path for builders: Glean Academy offers a self-paced Agent Builder course — [How Agents Work](https://docs.glean.com/agents/how-agents-work)
- Developer cohort surfaces: Git sync for repo-based agent definitions; build/preview/iterate from Claude Code and Cursor; public API reference and SDKs — [Glean Agents GO 2026](https://www.glean.com/blog/glean-agents-go-2026); [Glean developer docs](https://developers.glean.com)
- **Skills** are a separate authorable artifact that can be uploaded locally or imported from a third-party repository such as GitHub — [Skill scanning](https://docs.glean.com/administration/managing-skills/skill-scanning)

### Inferences
- The three-way split (business builder in Auto mode / process owner in Workflow mode / engineer via Git+CLI) means Glean has no single canonical build process. Governance has to be enforced at the publish boundary and at run time, because the authoring path is heterogeneous by design. That is the opposite architectural bet from a protocol-enforced build pipeline.
- "Can create: On, can publish: Off" by default is a meaningful posture — Glean's default is open experimentation with a gated release — but it is a *permission flag*, not a process. Nothing in the docs requires the builder to produce evidence of correctness.

### Gaps
- No published data on the actual mix of builders in real deployments (how many agents are built by business users vs. IT). Glean publishes adoption marketing but I found no verifiable breakdown.
- Whether Auto-mode agents can be inspected as a reviewable artifact beyond their natural-language instructions and tool/datasource list.

## Pre-publication governance, review, approval gates, and rollout controls

### Takeaway
Glean has a real, documented publish-approval workflow with draft / ready-to-publish / published states, moderator roles, and a diff summary — plus an automated publish-time **agent scanning** pass that assigns severity. But the approval is a human eyeball on a diff with no required evidence, the risk signal is advisory, and scanning is **fail-open**. I found no documented risk *tiering* that changes the ceremony required, and no documented staged/percentage rollout to a subset of employees.

### Cited Findings

**The publish workflow**
- Admin-configurable approval requirement, set in **Admin console → User roles → Default member permission**, with exactly three settings: **Never** (anyone with edit access publishes directly), **When shared with the entire company only**, **When shared with specific people or the entire company** — [Review and publish agents](https://docs.glean.com/administration/managing-agents/review-and-publish-agents)
- Approval settings apply **only to users without the Agent Creator role**; the page states "Admin and moderator permissions are unchanged" — [Review and publish agents](https://docs.glean.com/administration/managing-agents/review-and-publish-agents)
- Three states: **Draft** (in-progress, autosaved while editing), **Ready to publish** (a staged version submitted for review; this state exists only when approval is required), **Published** (what end users currently see). A staged version does not go live until a moderator publishes it — [Review and publish agents](https://docs.glean.com/administration/managing-agents/review-and-publish-agents)
- Flow: builder edits the shared agent → clicks Publish → enters a **message describing the change** → clicks "Request to publish" → Glean **emails the agent moderator** → moderator opens the agent, reviews the staged version, clicks **Approve** → confirms in a "Publish this version?" dialog — [Review and publish agents](https://docs.glean.com/administration/managing-agents/review-and-publish-agents)
- **Diff on review**: for Auto mode agents, including Git-managed agents, the confirmation dialog shows the change message plus a summary comparing the staged version with the published version. First publish shows "This is the first published version, so there is no previous version to compare." If comparison fails it shows **"This version is not available for comparison"** — and the flow continues — [Review and publish agents](https://docs.glean.com/administration/managing-agents/review-and-publish-agents)
- If publishing fails, the dialog stays open for retry; closing without confirming does not publish — [Review and publish agents](https://docs.glean.com/administration/managing-agents/review-and-publish-agents)
- There are two moderator scopes mentioned: **agent moderators** and **department agent moderators** — [Review and publish agents](https://docs.glean.com/administration/managing-agents/review-and-publish-agents)

**Automated pre-publish risk assessment**
- **Agent scanning** (labeled **beta**) reviews agent definitions **at publish time** — specifically the instructions, tools, data sources, and sharing settings. It flags over-provisioned write tools and vague write instructions, assigns a **severity**, and **gates risky items behind moderator approval** — [Glean Agents GO 2026](https://www.glean.com/blog/glean-agents-go-2026)
- **Skill scanning**: scans skills uploaded locally or imported from a third-party repo (GitHub). **Skills from Glean are not scanned.** Scans trigger when instructions or bundled files change, including via repo sync; **metadata-only edits (rename, change sharing) do not trigger a scan.** Checks cover prompt injection, malicious code, harmful content, and bundle structure. Severity is Low / Medium / High / Critical, with the skill's overall severity being the highest among its findings — [Skill scanning](https://docs.glean.com/administration/managing-skills/skill-scanning)
- Skill scanning reviewers: **Skills Moderator, Admin, or Super Admin**, under Admin console → Skills → Manage. Owners see a "Review recommended" warning and a "Fix with Glean" action on their own skills — [Skill scanning](https://docs.glean.com/administration/managing-skills/skill-scanning)
- **Skill scanning does not block.** It is fail-open: a skill with High or Critical findings stays usable, and a failed scan does not block use either. Only a moderator turning the skill off ("Disabled") stops it. "Dismiss findings" clears the warning **per user, for the current scan only**, without changing usability — [Skill scanning](https://docs.glean.com/administration/managing-skills/skill-scanning)
- Skill scanning is **on by default** and is a **billed advanced feature** admins can turn off under Admin console → Advanced features. The page does not state beta or GA — [Skill scanning](https://docs.glean.com/administration/managing-skills/skill-scanning)
- **Skill versioning with one-click rollback** is announced (no status label) — [Glean Agents GO 2026](https://www.glean.com/blog/glean-agents-go-2026)
- **Agent governance policies** combine access, behavior, and usage-limit rules into one policy scoped to specific groups or agents, and "separate policies can be tested before broad rollout." No status label — [Glean Agents GO 2026](https://www.glean.com/blog/glean-agents-go-2026)
- Pre-launch data hygiene gate: Glean recommends running **sensitive-content reports before making a connector's content visible to all users** — [Secure configuration](https://docs.glean.com/security/secure-configuration)
- Third-party governance tooling exists because of gaps: Rencore publishes pre-built Glean governance policies, e.g. flagging enabled agents callable by users, and detecting deleted agents that had recent usage — [Rencore Glean governance guide](https://hub.rencore.com/guides/govern/glean)

### Inferences
- Glean's approval gate is a **sharing-scope trigger**, not a risk trigger. The three settings key off *who the agent is shared with* (private / specific people / company-wide). They do not key off whether the agent has write tools, touches sensitive connectors, or runs unattended on a trigger. Agent scanning partially compensates by flagging over-provisioned write tools at publish time — but it produces an advisory severity for a human, not a tier that mechanically changes the required ceremony.
- The approval credential is **not bound to a specific version in any way the docs describe as an invariant**. The staged version is what the moderator sees and publishes, which is good, but "This version is not available for comparison" is a documented path where a moderator approves without seeing a diff and the publish proceeds. There is no documented reproduction requirement, no documented second reviewer, no documented adversarial check of a finding.
- **Merge and release are the same event.** The moderator's Approve/Publish makes the change live for end users. There is no documented dark-deploy — no concept of merging the definition while withholding exposure behind a separate human-attested release flip.
- Because scanning is explicitly fail-open and dismissals are per-user-per-scan, the control is an advisory signal layered on human judgment rather than a gate. An org wanting a hard gate has to build it externally (which is presumably why Rencore sells Glean governance policies).

### Gaps
- No documentation of **percentage or cohort staged rollout** of a published agent to a subset of employees. "Separate policies can be tested before broad rollout" is the closest statement and it concerns policies, not agents.
- No documentation of **risk tiering** that varies review requirements. Agent scanning assigns severity, but I found nothing saying severity X requires reviewer class Y or N reviewers.
- The review-and-publish page **does not say how moderators are assigned**, or what moderator permissions include beyond approving.
- No documented mechanism preventing a builder from being their own approver, beyond the Agent Creator role bypassing approval entirely (which is the opposite — it is a documented self-approval path).
- Whether agent scanning, unlike skill scanning, is fail-closed. The blog says it "gates risky items behind moderator approval," which reads as blocking, but no doc page I reached states its failure behavior.

## Evaluation and quality verification

### Takeaway
Glean runs its own platform-level evals internally (LLM judges calibrated to human SMEs, used to gate launches and catch regressions), and publishes a methodology blog telling *customers* how to evaluate their own agents — but as of late 2026 the customer-facing eval product is **private beta** ("built-in agent evals") and Glean's own community forum carries an unanswered request for exactly this capability. Citation/provenance is a Glean Assistant feature in practice but I could not find a specification of how it works or whether citations are verified against retrieved content.

### Cited Findings
- **Built-in agent evals** is labeled **private beta**: "generates eval sets across many scenarios to test agent behavior **before publishing**" — [Glean Agents GO 2026](https://www.glean.com/blog/glean-agents-go-2026)
- Glean's published customer methodology: define one north star metric; have SMEs curate **~20 real user examples** with ideal responses including complex multi-step tasks; break the north star into **2–4 sub-metrics scored binary (0/1) rather than on a scale** because binary is more consistent for both humans and LLM judges (cost and latency excepted, where exact numbers matter); iterate on failures in a fixed order — refine instructions, then structure context and data sources, then tune parameters like temperature, then try a different LLM; close the loop with real-world signals (upvotes, downvotes, shares) and automate grading with LLMs as usage grows; refresh the evalset by **sampling real user queries** — [Enterprise agent evaluation guide](https://www.glean.com/blog/enterprise-agent-evaluation-guide)
- What Glean says the **platform** does: platform-level evaluations run "in the background" at scale, tracking accuracy, relevance, and instruction following. Platform quality is split into distinct metrics, most graded by **LLMs calibrated to user feedback**, with human SMEs also involved. Foundational agent behavior (instruction-following, safety, personalization, contextual awareness) is Glean's responsibility so builders can focus on higher-level quality — [Enterprise agent evaluation guide](https://www.glean.com/blog/enterprise-agent-evaluation-guide)
- What the **customer** must do per that same guide: curate the evalset, define good, choose metrics, run evals, interpret results, make changes, retest, and keep the evalset current — [Enterprise agent evaluation guide](https://www.glean.com/blog/enterprise-agent-evaluation-guide)
- Glean's internal eval org (from its own job postings): an **Evals & Observability** team building evaluation pipelines, quality evalsets, **LLM-powered judges**, and agent observability tooling; judges score correctness, completeness, and response quality and are **calibrated against human judgment**; evals are used to **gate launches and catch regressions**. A Tech Lead Manager, AI Evaluations posting describes **graders, trace capture and replay, and versioned reproducible experiments** as core infrastructure — [ML Engineer, LLM Evals & Observability](https://jobs.generalcatalyst.com/companies/glean/jobs/78619010-machine-learning-engineer-llm-evals-observability); [Tech Lead Manager, AI Evaluations](https://jobs.generalcatalyst.com/companies/glean/jobs/96792817-tech-lead-manager-ai-evaluations)
- **Customer-reported gap**, on Glean's own community forum: a user says Agent Builder lacks a systematic way to run prompt sets in bulk, grade outputs, and compare experiments, and asks whether LangSmith can be connected for tracing. This is a user request; I saw no Glean response in the search result — [Glean community: agent observability and evals](https://community.glean.com/discussion/360/agent-observability-and-evals)
- Reviewer-reported quality variance: accuracy described as strong on many queries but **inconsistent on niche internal corpora**, with answer quality suffering when source content is stale or contradictory; reviewers also ask for **deeper admin analytics** — [Slite Glean review](https://slite.com/learn/glean-ai-review) *(competitor-authored; weigh accordingly)*

### Inferences
- Glean's internal eval maturity (graders, trace replay, versioned experiments, launch gating) is clearly well ahead of what it exposes to customers. That asymmetry is the practical issue: a Glean customer governing *their own* agents does not inherit Glean's eval harness, and as of late 2026 the customer-facing equivalent is private beta.
- Glean's published method is explicitly **LLM-judge-centric** — "automate grading with LLMs as usage grows." That is the opposite of forbidding LLM self-review in favor of deterministic checks. It is a defensible choice for grading natural-language output quality, but it means the verification signal is itself probabilistic and must be calibrated.
- No documented notion of a check reporting SKIPPED vs PASSED. The 0/1 binary scoring scheme as described has no third state for "could not evaluate."

### Gaps
- **No documented citation/provenance specification.** Glean Assistant surfaces citations in practice, but I found no doc describing whether a citation is verified against the actually-retrieved passage, whether unsupported claims are detected, or whether provenance is retained per result for audit. This is a notable hole given how central provenance is to governing what an agent tells an employee.
- No documented confidence scoring exposed to end users or admins.
- No documented regression detection for *customer-built* agents (does republishing run the prior evalset? unknown).
- Availability, pricing, and GA timing for built-in agent evals.
- I found no published Glean benchmark numbers (accuracy on a named dataset) that could be independently checked.

## Deployment surfaces

### Takeaway
Glean covers the expected surfaces: web app, browser extension (Chrome/Edge, force-installable), Slack, Microsoft Teams, APIs/SDKs, MCP servers, and A2A. Embedded integrations are admin-configured, not user-enabled.

### Cited Findings
- **Browser extension** (Chrome and Edge): pushable to managed devices via policy pointing at the tenant backend URL, **force-installable silently**, and when installed this way **users cannot turn it off or uninstall it**. Docs note the extension can search pages from a user's browser history, covering "specific workplace apps in which Glean cannot build out a native connector" — [Browser extension about](https://docs.glean.com/administration/management/features/browser/about); [Deploy the browser extension to managed devices](https://docs.glean.com/administration/management/features/browser/deployment)
- **Slack embedded integration**: enabled under Platform → Embedded integrations, and the option **only appears after the Slack connectors are configured**. Admins choose which channels Gleanbot responds in. The Slack sidebar entry point is enabled via Slack data source settings. In Slack, users can search, ask questions, **run agents**, and subscribe to a daily digest — [Slackbot installation guide](https://docs.glean.com/administration/platform/embedded-integrations/slackbot/getting-started/installation-guide); [configuration checklist](https://docs.glean.com/administration/platform/embedded-integrations/slackbot/getting-started/configuration-checklist)
- Daily digest is **not supported** on Slack RTS-powered deployments — [Slack RTS connector](https://docs.glean.com/connectors/native/slack/setup/slack-rts-connector)
- **Microsoft Teams**: docs confirm a "Glean in Microsoft Teams" surface bringing Glean Assistant and agents into Teams channels and chats — [Embedded integrations](https://docs.glean.com/user-guide/embedded-integrations/)
- **MCP servers** are a documented platform surface — [MCP about](https://docs.glean.com/administration/platform/mcp/about)
- **API and SDKs**: client API with documented endpoints including `/api/v1/search`, `/api/v1/chat`, `/api/v1/chat/refine` — [API reference](https://developers.glean.com/api-info/client/getting-started/overview); [Admin audit logs](https://docs.glean.com/administration/management/audit-logs/admin-audit-logs)
- **A2A** interoperability with agents on other platforms, described as shipped — [Glean Agents GO 2026](https://www.glean.com/blog/glean-agents-go-2026)
- Independent Agents can have **"channel presence,"** but the page does not name supported channels — [How Agents Work](https://docs.glean.com/agents/how-agents-work)
- Agents are launchable from the **Agent Library** or a direct link — [How Agents Work](https://docs.glean.com/agents/how-agents-work)
- Glean publishes a **"Deploy apps"** go-live guide — [Deploy apps](https://docs.glean.com/get-started/golive/deploy-apps)

### Inferences
- The primary consumer interaction model is **free-form chat** (Glean Chat / Assistant) plus agent invocation from a library or link. Structured input forms exist as a *trigger type* for Workflow agents, so a form-driven experience is constructible, but chat is the default and the marketed surface.
- "Run agents in Slack" plus content triggers means agent output can land in shared channels. Nothing in the docs I read describes a private-by-default delivery guarantee; channel scoping is an admin configuration of which channels Gleanbot responds in.

### Gaps
- No doc found on whether agent results are private-by-default vs. visible in-channel, or whether there is a per-result provenance footer spec.
- Embeddable-in-your-own-app SDK details (an "embedded search" widget) were not confirmed; "Embedded integrations" in Glean's docs means Slack/Teams, not embedding Glean in a customer app.

## Pricing and packaging

### Takeaway
Glean does not publish pricing. Every number below is third-party, mostly from competitors or pricing-intelligence aggregators, and the estimates disagree by 5x. Treat the *structure* (per-seat + usage/credits + SKU-gated advanced features + seat minimum) as more reliable than any specific figure.

### Cited Findings
- **Billing structure** (vendor-cited): a per-user seat charge plus either pooled credits on an **Enterprise Flex** plan or model usage billed at provider API rates on a **Core Suite** plan. Glean publishes *how* it bills but not the price — [eesel: Glean AI pricing](https://www.eesel.ai/blog/glean-ai-pricing)
- **Seat price estimates, which conflict:** ~$10–$50/user/month (community reports) — [Macha: Glean AI pricing explained](https://www.getmacha.com/blog/glean-ai-pricing-explained); ~$50–$75+/user/month (buyer-reported) — [eesel](https://www.eesel.ai/blog/glean-ai-pricing); ~$45–$48/user/month at ~200–230 users, dropping to ~$30 at 700 users — [GoSearch: Glean TCO](https://gosearch.ai/blog/glean-total-cost-of-ownership/); "typically starts around $50 per user per month" — [Workativ Glean review](https://workativ.com/blog/glean-review)
- **Minimums**: commonly cited as ~**100 seats**, with entry annual contracts around **$60,000** before negotiation — [Workativ: Glean pricing](https://workativ.com/blog/glean-pricing); [eesel](https://www.eesel.ai/blog/glean-ai-pricing)
- **Median contract value $98,890** per one pricing-intelligence dataset — [GoSearch: Glean pricing explained](https://www.gosearch.ai/blog/glean-pricing-explained)
- **Extra line items**: one source reports a **mandatory support fee of 10% of ARR**; another says AI capabilities are a separate add-on at **~$15/user/month** — [GoSearch TCO](https://gosearch.ai/blog/glean-total-cost-of-ownership/); [eesel](https://www.eesel.ai/blog/glean-ai-pricing)
- **Governance features are SKU-gated.** Agent access policies are part of **Glean Protect+**. Sensitive-content scanning and AI security policies are **Glean Protect**. **Skill scanning is a billed advanced feature** (on by default, admin-disableable) — [Agent access policies](https://docs.glean.com/administration/protect/ai-security/agent-access-policies); [Secure configuration](https://docs.glean.com/security/secure-configuration); [Skill scanning](https://docs.glean.com/administration/managing-skills/skill-scanning)
- **Company context**: $150M Series F in June 2025 led by Wellington Management at a **$7.2B valuation** (prior: Series E Sept 2024 at $4.6B); total raised ~$765–768M across six rounds — [Wikipedia: Glean Technologies](https://en.wikipedia.org/wiki/Glean_Technologies); [TipRanks](https://www.tipranks.com/private-companies/glean)
- **ARR**: Sacra estimates **~$300M ARR in May 2026**, up from $208M at end of 2025 and $200M in Dec 2025. This is a third-party estimate, **not a company announcement** — [Sacra: Glean at $200M ARR](https://sacra.com/research/glean-at-200m-arr/); [Sacra: Glean](https://sacra.com/research/glean/)
- Citigroup has invested in Glean — [CDO Magazine](https://www.cdomagazine.tech/aiml/citigroup-invests-in-enterprise-ai-startup-glean)

### Inferences
- The most governance-relevant pricing fact is **not the seat price — it is that the governance layer is a paid upsell.** Agent access policies (the runtime deny/filter layer) require Protect+. An org that buys base Glean gets permission mirroring and the publish-approval workflow, but not runtime agent policy enforcement. Budget modeling should assume governance is a separate line.
- A credits/usage component on top of seats means agent cost is variable and not fully predictable at purchase — relevant to the "what happens at 20 concurrent users" operational question.

### Gaps
- **No primary-source pricing.** I did not reach Vendr or Spendflo data directly; the figures above are mostly competitor blogs citing them. I would not put any specific number in a decision document without a quote.
- No published implementation-services fee, professional-services attach rate, or typical time-to-value.
- Whether the "10% of ARR support fee" is current or universal — single-source, competitor-published.

## Documented complaints, limitations, and implementation challenges

### Takeaway
Public criticism is thin, mixed, and heavily contaminated by competitor-authored comparison content. The recurring themes that appear across more than one independent-ish source are: inconsistent relevance on niche internal corpora, price escalation at scale, indexing/latency friction, dependence on heavy pre-rollout content hygiene, and thin admin analytics/eval tooling. Aggregate ratings are high.

### Cited Findings
- Aggregate ratings: **G2 4.8 / 134 reviews; Gartner Peer Insights 4.4 / 115 reviews** per one aggregator — [rfp.wiki: Glean](https://www.rfp.wiki/vendors/glean)
- Practitioner account (Reddit, read via a mirror rather than reddit.com): a ~200-person company ~8 months in says search accuracy is "okay but not great" and "the pricing is getting pretty steep as we scale," and they were asked to research alternatives ahead of renewal — [Reddit snapshot mirror](https://reddit.sentinel-team.org/posts/1soffbv/snapshots/2026-04-25T05%3A43%3A26.19304Z) *(mirror, provenance not independently verified)*
- Relevance and admin gaps: strong accuracy on many queries but **inconsistent on niche internal corpora**; answer quality degrades when source content is stale or contradictory; reviewers want **deeper admin analytics**; one reviewer reported it could be slow to answer — [Slite Glean review](https://slite.com/learn/glean-ai-review) *(competitor-authored)*
- Implementation friction: a customer-service reviewer reported **pricing and indexing delays** making implementation and ongoing usage harder; reviewers emphasize that "successful integration requires meaningful preparation before rollout" and that benefits arrive after rollout stabilizes — [Slite Glean review](https://slite.com/learn/glean-ai-review) *(competitor-authored)*
- Scope limitation claim: Glean "does not execute workflows, resolve tickets, or automate end-to-end requests"; separate authentication process described as annoying; occasional irrelevant results — [Workativ Glean review](https://workativ.com/blog/glean-review) *(competitor-authored; the workflow-execution claim is also **contradicted** by Glean's own documented write tools and Workflow-mode agents, so I read this as stale or motivated)*
- Positive counterweight: a Team Blind thread (Aug 2024, 65 poll participants) includes "one of the best enterprise search offerings I've ever used," with mixed replies overall — [Team Blind: experience with Glean enterprise search](https://www.teamblind.com/post/experience-with-glean-enterprise-search-dfixujvt)
- Eval tooling gap raised by a customer on Glean's own forum (see Evaluation section) — [Glean community](https://community.glean.com/discussion/360/agent-observability-and-evals)
- Architectural limitation from Glean's own docs, which is the most credible "limitation" I found: retrofitting permissions requires **re-indexing everything**, and unknown groups make documents invisible to all — [Indexing SDK: permissions](https://developers.glean.com/libraries/indexing-sdk/permissions)
- Residual-risk critique: AI search can infer and present information synthesized from sources a user never directly accessed, which permission mirroring alone does not address — [Knostic](https://www.knostic.ai/blog/glean-data-security)
- Governance gaps acknowledged implicitly by a third-party governance market: Rencore sells pre-built Glean governance policies for things like enabled-but-callable agents and deleted agents with recent usage — [Rencore](https://hub.rencore.com/guides/govern/glean)

### Inferences
- The strongest critiques of Glean are not in reviews — they are in Glean's own developer docs (re-index-to-retrofit-permissions, unknown-group-hides-everything, upload response is not ground truth) and in its own beta labels (policies, evals, agent identity all beta). That is a more reliable evidence base than the review corpus.
- The absence of a large, clean body of practitioner criticism is itself ambiguous: it could mean satisfaction, or it could mean enterprise buyers do not discuss a $100k+ internal tool publicly. I would not read 4.8/5 on G2 as strong evidence either way.

### Gaps
- I could **not** retrieve G2 or Gartner Peer Insights review text directly; both are effectively gated to search engines. All review-derived claims above are secondhand through aggregators or competitors.
- No Hacker News thread of substance surfaced.
- No published incident/postmortem, uptime SLA, or scale-failure account.
- No independent audit of permission-mirroring correctness.

## WHAT GLEAN DOES THAT THE BENCHMARK DOES NOT

Concrete, sourced capability deltas. I am listing only things Glean demonstrably has per the sources above.

1. **Breadth of first-party connectors with ACL mirroring already built.** 100+ documented native connectors (Power BI, BigQuery, Outlook Calendar, Slack, Jira, GitHub, etc.), each responsible for mirroring source ACLs into Glean's identity store. The benchmark's "approved knowledge sources" model governs *which* sources are allowed but does not, as described, ship a connector fleet with per-source ACL translation. — [Glean docs](https://docs.glean.com/connectors/about)

2. **A zero-copy retrieval path for at least one source.** Slack RTS retrieves message bodies live at query time via Slack's API and processes them in memory only, never indexing message content. That removes an entire class of staleness and copy-sprawl risk for that source. — [Slack RTS](https://docs.glean.com/connectors/native/slack/setup/slack-rts-connector)

3. **Runtime policy enforcement at two points around every tool call, expressed in a real policy language.** CEL-based rules evaluated pre-execution against tool identity and input arguments, and post-execution against the structured response payload, with Block / Filter / Flag actions and a 10–50 ms latency target. "Filter" in particular — returning a partial, sanitized result set to the agent rather than all-or-nothing — is a capability the benchmark's query-time guardrail layer as described does not clearly have. — [Agent access policies](https://docs.glean.com/administration/protect/ai-security/agent-access-policies)

4. **Prompt-injection and malicious-code scanning of authored artifacts.** Skill scanning checks uploaded and GitHub-imported skills for prompt injection, malicious code, harmful content, and bundle structure, re-scanning on content change. The benchmark's adversarial "refuter" agent attacks *findings*, not *artifacts*; it is not described as scanning agent/skill definitions for injection payloads. — [Skill scanning](https://docs.glean.com/administration/managing-skills/skill-scanning)

5. **Publish-time automated risk flagging of over-provisioned write tools and vague write instructions** (agent scanning, beta). This is a *semantic* read of the agent definition. The benchmark computes risk tier mechanically from changed file paths, which is tamper-resistant but blind to "this agent has a write tool it doesn't need." These are complementary, and Glean has the semantic half. — [Glean Agents GO 2026](https://www.glean.com/blog/glean-agents-go-2026)

6. **Agent identity as a first-class construct** (public beta): an agent acting under its own scoped credentials across a dozen-plus connected tools, with admin-managed credentials for Independent Agents. This separates "what the agent may do" from "what the invoking user may do" — a construct the benchmark's star-schema permission model, as described, does not obviously have.

7. **Sensitive-content discovery and autohide.** Connector scanning for PII/PCI/credentials plus custom terms and regex, running continuously or weekly, with flagged content auto-hidden from Search and Assistant while remediated at source, plus pre-go-live sensitive-content reports. The benchmark enforces output guardrails at query time; Glean additionally finds and quarantines bad *input* content proactively. — [Secure configuration](https://docs.glean.com/security/secure-configuration)

8. **Microsoft Purview sensitivity-label integration** to restrict indexing of Office 365 content — inheriting an existing enterprise classification taxonomy rather than requiring a bespoke one. — [Secure configuration](https://docs.glean.com/security/secure-configuration)

9. **Breadth of consumption surfaces, including force-deployable browser extension.** Web app, Chrome/Edge extension (silently force-installable on managed devices, non-removable by the user), Slack, Teams, API, MCP servers, and A2A agent-to-agent interop with other platforms. The extension's ability to search pages from browser history covers apps with no native connector.

10. **Admin "Verify access" tool** — an interactive check that a given document's visibility matches expectations. A permission-debugging affordance for admins. — [Secure configuration](https://docs.glean.com/security/secure-configuration)

11. **Natural-language agent authoring with automatic step generation**, Agent Templates, and a Glean Academy course — a genuine non-technical builder on-ramp. The benchmark's Orchestrator protocol targets a technical build cohort.

12. **Content/event triggers and scheduled autonomous runs**, with trigger payload injected into the agent, plus "channel presence" for Independent Agents. Proactive agents that act on incoming content without a human invocation.

13. **Platform-level eval infrastructure run by the vendor** — background evals tracking accuracy, relevance, and instruction-following, with LLM judges calibrated to human SMEs and human SMEs in the loop, used internally to gate launches and catch regressions. The benchmark's verification burden sits entirely with the operator.

14. **SIEM export of admin audit logs, on by default**, including all API calls by users and applications.

15. **Customer-hosted deployment** on GCP and AWS for organizations that cannot use SaaS. — [Security & Architecture](https://docs.glean.com/security)

16. **Scale and durability as a vendor**: ~$7.2B valuation (June 2025 Series F), ~$300M estimated ARR as of May 2026. Not a capability, but a real procurement input the benchmark cannot match.

## WHAT THE BENCHMARK DOES THAT GLEAN DOES NOT

Each item below is a delta I could substantiate from Glean's own sources — either Glean documents the opposite behavior, or the capability is absent from public documentation (which I mark explicitly, since absent-from-docs is weaker evidence than documented-opposite).

1. **Fail-loud on configuration faults.** This is the sharpest difference, and it is *documented opposite*, not merely absent. Glean's agent access policy evaluation is explicitly **fail-open**: "a configuration error, such as a typo or unknown field, makes the rule a no-op, and the tool call proceeds," and an expression timeout also allows the call. Skill scanning is also explicitly fail-open, including when the scan itself fails. Meanwhile at the retrieval layer, Glean fails **closed and silent**: "an ACL naming a group Glean has never heard of matches nobody." Neither layer raises a distinguishable "could not determine." The benchmark's explicit separation of "denied" from "could not determine," with config faults failing loud, has no counterpart in Glean's documented behavior. — [Agent access policies](https://docs.glean.com/administration/protect/ai-security/agent-access-policies); [Skill scanning](https://docs.glean.com/administration/managing-skills/skill-scanning); [Indexing SDK: permissions](https://developers.glean.com/libraries/indexing-sdk/permissions)

2. **Deny-wins resolution in the grant model.** Glean's document ACLs are **allow-list only** — `allowed_users`, `allowed_groups`, `allowed_group_intersections`. No deny primitive is documented. Glean's "most restrictive outcome wins" applies to conflicts *between agent access policies* at run time, not between grants. Admin autohide/hide-document/redlists are overlay overrides, not deny rows resolved in the model. — [Indexing SDK: permissions](https://developers.glean.com/libraries/indexing-sdk/permissions); [Agent access policies](https://docs.glean.com/administration/protect/ai-security/agent-access-policies)

3. **Immutable, append-only grant audit trail where revocation is an additive FALSE row and never a delete.** Not found in any Glean documentation. Glean's audit story is (a) admin-action audit logs and (b) policy-violation findings. Neither is a grant ledger. Because the ACL mirror reflects current source-system state, point-in-time reconstruction of "who could see this document on date X" appears impossible from Glean, though I want to be clear this is absence-from-docs plus inference, not a documented negative.

4. **Documented, specified caching semantics — specifically success-only caching.** Glean's own developer docs state the permissions page does **not** cover caching, resync cadence, or how identity changes propagate to already-indexed documents. Whether Glean caches permission decisions, with what TTL, and whether it caches failures, is unanswerable from public sources. The benchmark's "never cache a failure" rule has no verifiable Glean counterpart. — [Indexing SDK: permissions](https://developers.glean.com/libraries/indexing-sdk/permissions)

5. **Guardrails enforced by a tokenizer rather than regex.** Glean's documented matching primitives are CEL conditions with `=`, `!=`, `in`, `like` for policies, and regex/custom-term patterns for sensitive-content scanning. Both are string-pattern approaches. No tokenizer-level enforcement is documented. — [Agent access policies](https://docs.glean.com/administration/protect/ai-security/agent-access-policies); [Secure configuration](https://docs.glean.com/security/secure-configuration)

6. **Risk tier computed mechanically from changed artifacts, un-downgradable by the author.** Glean's approval trigger keys off **sharing scope** (never / company-wide only / any shared agent) — not off blast radius. Agent scanning assigns a severity, but it is advisory and (for skills, explicitly) dismissible per-user without changing usability, and the scan is fail-open. Worse for this comparison: **the Agent Creator role bypasses approval entirely** — "approval settings apply only to users without the Agent Creator role" — which is a documented self-approval path. Nothing in Glean's docs prevents an author from influencing their own review requirement. — [Review and publish agents](https://docs.glean.com/administration/managing-agents/review-and-publish-agents); [Skill scanning](https://docs.glean.com/administration/managing-skills/skill-scanning)

7. **Review ceremony proportional to risk.** Not documented. Glean's workflow is one shape — submit, email a moderator, moderator approves — regardless of whether the agent reads one wiki or has write access to a CRM. No documented second reviewer, reviewer-class requirement, or escalation by severity.

8. **A blocking finding must carry a reproduction.** Not documented anywhere in Glean. The builder enters a free-text "message describing the change"; the moderator reviews a diff summary. There is no evidence artifact, no required repro, and a documented path where the diff is unavailable ("This version is not available for comparison") and the publish still proceeds.

9. **Adversarial disproof of candidate findings in a stripped environment.** Nothing comparable exists in Glean. Glean's nearest analogue is scanner severity, which no process challenges — the only disposition options documented are fix, dismiss (per-user, per-scan), or disable the skill.

10. **Deterministic verification with LLM self-review forbidden, and unrunnable checks reported as SKIPPED rather than passed.** Glean's published position is the opposite on both counts. Its methodology explicitly recommends LLM-graded evaluation ("automate grading with LLMs as usage grows"), its platform evals are "mostly graded by LLMs calibrated to user feedback," and its internal stack is built on LLM judges. Its scoring scheme is binary 0/1 with no documented third state for un-evaluable. — [Enterprise agent evaluation guide](https://www.glean.com/blog/enterprise-agent-evaluation-guide)

11. **A review record bound to the head commit SHA, functioning as the merge credential.** Glean stages a version and shows a diff, and Git-managed agents exist — so Glean is directionally close here — but no Glean doc describes the approval as cryptographically or referentially bound to a specific revision such that a post-approval change invalidates it. Absence-from-docs; Git sync may make this true in practice and I could not confirm.

12. **Dark deploy with a separate human-attested release flip.** Glean's documented model collapses these: the moderator's Approve/Publish "makes the change live for end users." I found **no** documented staged, percentage, or cohort rollout for a published agent. Glean's own phrasing about testing before broad rollout refers to *policies*, not agents. — [Review and publish agents](https://docs.glean.com/administration/managing-agents/review-and-publish-agents); [Glean Agents GO 2026](https://www.glean.com/blog/glean-agents-go-2026)

13. **A main orchestration session structurally barred from writing production code, routing instead to specialist sub-agents with distinct roles.** Glean's Auto mode is the inverse: an LLM writes the agent definition from a natural-language description and then chooses its own execution path at run time, with Task-tool sub-agent fan-out **on by default**. Sub-agents in Glean are a runtime decomposition mechanism, not a build-time separation-of-duties control. — [How Agents Work](https://docs.glean.com/agents/how-agents-work)

14. **A customer-usable eval harness at the publish gate.** Glean's "built-in agent evals," which would test agent behavior before publishing, is **private beta** as of Aug 2026, and a customer on Glean's own forum reports there is no systematic way to run prompt sets in bulk, grade outputs, and compare experiments in Agent Builder. — [Glean Agents GO 2026](https://www.glean.com/blog/glean-agents-go-2026); [Glean community](https://community.glean.com/discussion/360/agent-observability-and-evals)

15. **Structured menus/forms as the deliberate consumer interface, with free-form chat retired on measured evidence.** Glean's flagship consumer surface *is* free-form chat (Glean Chat/Assistant across web, Slack, Teams, extension). Input forms exist as one trigger type among several, not as the governing interaction model. This is a philosophical inversion, not a feature gap — but it is a real difference in what employees can ask for and therefore in how bounded the output space is.

16. **Private-by-default result delivery with per-result provenance.** Not documented. Glean agents can run in Slack channels where an admin configures which channels Gleanbot responds in; I found no private-by-default guarantee. And despite citations being a visible Glean Assistant behavior, I found **no specification** of how provenance is produced, whether citations are verified against retrieved content, or whether provenance is retained for audit. This is the largest single documentation gap I hit, and it is a gap in *evidence*, not necessarily in capability.

### Honest framing of this comparison
The two designs optimize for different failure modes, and the comparison should be read that way rather than as a scorecard. Glean optimizes for **adoption breadth** — get every employee asking questions across every system, with permissions mirrored from sources so the blast radius of a bad answer is bounded by what the asker could already read. Its governance is therefore largely *runtime* (policies evaluated per tool call) and *advisory* (scanners that flag for a human), and it fails open so that a misconfiguration degrades the control rather than the product. The benchmark optimizes for **provable correctness of a smaller surface** — fewer, reviewed agents with deterministic verification, mechanical risk tiering, and fail-loud configuration — accepting narrower reach and a technical build cohort as the cost.

The two places where Glean's own documentation most clearly concedes ground are fail-open policy evaluation and the Agent Creator approval bypass. The two places where the benchmark is most clearly behind are connector breadth with per-source ACL translation already built, and the non-technical builder on-ramp. Everything else in the lists above is a difference in emphasis that a real evaluation should test against actual workloads rather than against documentation.
