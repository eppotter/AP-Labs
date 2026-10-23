# Dust (dust.tt) as a Governed Enterprise AI Agent Platform

**Research date: 2026-10-22.** Dust ships continuously and publishes a dated changelog, so every product claim below is dated where the source dates it. The company changed its pricing model in mid-2026, which has left a large volume of stale third-party pricing pages in circulation — treat any aggregator citing a flat "$29/user/month" as pre-June-2026 and wrong.

**Company basics:** Paris-based, founded 2023 (one secondary source says 2022 — conflict noted) by Gabriel Hubert and Stanislas Polu (Polu ex-OpenAI; both previously founded Totems, acquired by Stripe 2014). $40M Series B announced 2026-05-18, led by Abstract and Sequoia Capital, with Snowflake and Datadog participating; >$60M raised total — [Dust Series B funding round raises $40m, research-live](https://www.research-live.com/article/news/dust-series-b-funding-round-raises-40m/id/5149747); [Dust: $40 Million Raised, Pulse2](https://pulse2.com/dust-40-million-raised-for-multiplayer-enterprise-ai-platform). Codebase is open source (MIT) at `dust-tt/dust`, but the founders say there is no open-source go-to-market — [Latent.Space: Agents @ Work: Dust.tt](https://www.latent.space/p/dust). Current positioning is "multiplayer AI."

---

## Q1: Product architecture — how are agents defined, stored, executed, and what is the role of "Dust apps" vs. assistant configuration?

### Takeaway
Dust agents are **declarative configuration objects**, not workflow graphs: a name/handle, natural-language instructions, a model, a set of knowledge (data source views), and a set of tools/skills. The original graph-based "Dust Apps" workflow layer is **deprecated** (no new apps creatable since October 2025), and the orchestration story has moved to LLM-driven tool selection plus **Skills** (reusable instruction+tool+knowledge bundles), **Triggers** (schedules/webhooks), and **MCP**. Agent configs are exportable/importable as **YAML** via UI and API, which is the closest thing to configuration-as-code.

### Cited Findings
- Agents are "mostly natural-language instructions plus a few tools, such as semantic search, structured-database queries, and web search. Explicit workflow graphs are not required." Dust deliberately uses the word "instructions" rather than "system prompt" to be less intimidating to non-developers — [Latent.Space](https://www.latent.space/p/dust)
- Backend internal services are written in **Rust**, front end in **Next.js**; **Temporal Cloud** handles workflow orchestration and near-real-time ingestion from Slack/Notion/GitHub, which can in turn trigger agent runs. Dust built its own unified model gateway across providers (LiteLLM named as the OSS equivalent). Dust does not train models or run GPUs — [Latent.Space](https://www.latent.space/p/dust)
- **Dust Apps are deprecated**: "Dust Apps are deprecated. Only apps created before October 2025 remain accessible, and the creation of new Dust Apps is deactivated." A Dust App was "a chain of one or more prompted calls to models or external services," built from sequential **Blocks** (input block, data block, LLM block, code block) exposing a structured API — [What is a Dust App? (docs, Legacy section)](https://docs.dust.tt/docs/developer-platform/legacy-dust-apps/what-is-a-dust-app.md)
- The docs now file Dust Apps under "Legacy Dust Apps" and also under a "Deprecated" tree (e.g., "Allowing an agent to send an email," "Creating Google Calendar events from a Dust agent" are both deprecated Dust-App recipes) — [docs index, llms.txt](https://docs.dust.tt/llms.txt)
- Agent config is a first-class API object: `export agent configuration as YAML`, `import agent configuration`, `get agent configuration`, `update agent configuration`, `archive agent configuration`, `list agents`, `search agents by name` — [Dust API reference index](https://docs.dust.tt/llms.txt)
- **Skills** are "reusable bundles of instructions, knowledge, and tools that can be shared across multiple agents." A skill has a name, description, *usage indications* (when the agent should enable it), and *guidelines* (the actual instructions). Guidelines can inline-reference MCP tools (typed with `/`), other skills, and knowledge sources. Agents load only the skills they judge relevant mid-conversation, to keep context focused. Updating a skill propagates to every agent using it — [Skills Overview (docs)](https://docs.dust.tt/docs/user-documentation/agents/skills/skills-overview.md)
- Skills are **versioned**: the Skill Builder has a history view listing past versions with dates and authors and showing diffs between them — [Skills Overview (docs)](https://docs.dust.tt/docs/user-documentation/agents/skills/skills-overview.md)
- Knowledge is exposed to agents through four distinct retrieval primitives, not one: **Search data sources** (RAG), **Table queries** (structured/SQL-style), **Extract data**, and **Include data** (full inclusion rather than retrieval) — [docs index](https://docs.dust.tt/llms.txt)
- Agents can call other agents via a shipped **`run agent`** tool, and `Wake-ups` and `Computer` (sandboxed computer use) are shipped tools. The older **File Generation** tool was deprecated in favor of `Computer` on 2026-10-14 — [docs tools index](https://docs.dust.tt/llms.txt); [Changelog](https://docs.dust.tt/docs/changelog.md)
- **Pods** (shipped, documented, with an Analytics tab added 2026-10-14) are shared human+agent workspaces holding Conversations, Tasks, and Files. Design principle stated as "everything a human can do, an agent can do" — agents can look up Pods, post, manage tasks, search Pod knowledge, and with Editor permission create Pods and manage members. Pod editors can apply an **`AGENTS.md`** file to every conversation in a Pod (shipped 2026-06-24) — [Pods Overview (docs)](https://docs.dust.tt/docs/user-documentation/pods/overview.md); [Changelog](https://docs.dust.tt/docs/changelog.md)
- **Frames** are Dust's agent-generated embeddable/shareable artifact surface; shipped features include domain-scoped sharing with per-viewer analytics (2026-09-16) and white-labeled Frames (Enterprise) — [docs](https://docs.dust.tt/docs/user-documentation/agents/frames/overview.md); [Changelog](https://docs.dust.tt/docs/changelog.md)
- Conversation-level runtime features shipped in 2026: **Steering** (mid-run redirection), **Branch a Conversation**, **Context Compaction**, **Go Deep** — [docs agents index](https://docs.dust.tt/llms.txt)

### Inferences
- Dust's architectural bet is explicitly **against** declarative workflow graphs for the mainstream path: they shipped a graph layer (Dust Apps), learned it did not scale to non-technical builders, and killed it in favor of instructions + model-driven tool choice. Skills are the replacement unit of reuse — the same role a subroutine played in Dust Apps, but expressed in prose rather than a DAG.
- Because tool selection is LLM-decided rather than graph-pinned, Dust's blast-radius control has to live at the *tool-permission* and *approval-prompt* layer, not at the workflow-definition layer. That is consistent with how heavily the 2026 changelog leans on per-tool approval gates.
- YAML export/import plus a full agent-config API means Dust *can* support GitOps-style agent governance, but nothing in the docs indicates Dust itself provides review-on-merge semantics — that would be customer-built on top.

### Gaps
- No public documentation of the storage model for agent configurations (table schema, immutability, whether agent instruction versions are retained the way skill versions are). Skills are documented as versioned; **agents are not documented as versioned** — I could not confirm whether agent instruction history is retained or diffable.
- No public execution-trace/step-debugger documentation. The API exposes conversation and message *events*, but I found no documented span/trace viewer.

---

## Q2: Who builds agents, and where does the no-code path actually end?

### Takeaway
Dust genuinely targets non-technical builders and has shipped a conversational builder ("Sidekick") that drafts instructions, proposes tools and data sources, and can create or modify agents and skills from inside a chat. The no-code ceiling in practice is hit at: multi-step deterministic logic, bulk/programmatic agent management, connector-level data onboarding beyond the supported list, and anything needing custom code — which now routes to **MCP servers** (write your own server) rather than to an in-product workflow builder, since Dust Apps are gone.

### Cited Findings
- Dust's own docs describe the platform as "builder-centric," with a gallery, Sidekick-guided creation, and support for "technical and non-technical builders" — [Welcome to Dust (docs)](https://docs.dust.tt/docs/welcome-to-dust)
- Four entry paths to an agent: **from a conversation, from scratch, from a template, or from a YAML file**. From-scratch and from-template open the Agent Builder with Sidekick drafting instructions and a working configuration; Sidekick proposes tools and data sources based on the stated goal — [Create your first agent (docs)](https://docs.dust.tt/docs/user-documentation/agents/create-your-first-agent.md)
- Configuring the search tool is a four-step point-and-click flow: choose a space → choose a connected source → pick specific data sources (e.g., a Notion folder) → write a short description of each source so the agent knows when to use it — [Create your first agent (docs)](https://docs.dust.tt/docs/user-documentation/agents/create-your-first-agent.md)
- Builder-side limits named in the docs: **API import requires a developer**; YAML import fails if the avatar URL is not a Dust-hosted or uploaded image, or if a tag in the file does not already exist in the workspace; a tool that cannot be set up in the workspace is **silently skipped and the agent is still created**; Slack-channel and Zapier wiring happens outside the builder on separate integration pages — [Create your first agent (docs)](https://docs.dust.tt/docs/user-documentation/agents/create-your-first-agent.md)
- Dust's founders describe their builders as "non-technical operational staff," needing to be "thinkers" who are curious rather than developers. They also state the real failure boundary: "Tool selection works well when instructions are precise and scripted. Broad, auto-GPT-style agents with many tools make mistakes" — [Latent.Space](https://www.latent.space/p/dust)
- Named connector gaps from the founders: Salesforce is not natively supported in the sense a user would expect — users supply SOQL queries or push data themselves; Notion databases must be manually distinguished as tabular vs. text-heavy so chunking is correct — [Latent.Space](https://www.latent.space/p/dust). (Note: Dust has since shipped a Salesforce *tool* and a beta Salesforce *import*, so this specific gap has narrowed — [docs tools index](https://docs.dust.tt/llms.txt).)
- A G2 reviewer names the programmatic ceiling directly: "Some limitations for technical users: like being able to use api to build and update the agents automatically" — [Dust reviews, G2](https://www.g2.com/products/dust-dust/reviews?qs=pros-and-cons)
- Dust's rollout guide formalizes a **builder community** play: identify builders by surveying who already uses LLMs regularly; create a builder hub (dedicated Slack channel, regular builder meetups, shared template/knowledge library); train-the-trainer; recognize achievements. Builder responsibilities listed: create team-specific agents, document use cases and templates, train team members, share success stories, relay feedback — [Build your builder community (docs)](https://docs.dust.tt/docs/user-documentation/getting-started/dust-rollout-guide/build-your-builder-community.md)
- Notably, that same page's "Tips for great builders" section is **empty**, and it contains **no** governance structure for builders — no oversight, approval process, or reporting lines — [Build your builder community (docs)](https://docs.dust.tt/docs/user-documentation/getting-started/dust-rollout-guide/build-your-builder-community.md)
- The **"Builder" role has been deprecated** in Dust's role model in favor of **Manager**; current roles are Admin / Manager / Member — [Workspace Governance: Roles, Groups & Permissions (docs)](https://docs.dust.tt/docs/user-documentation/admins/admin-governance/workspace-governance-roles-groups-and-permissions.md)

### Inferences
- Dust's answer to "what if no-code isn't enough" is **MCP, not a workflow builder**. Since Dust Apps are deprecated and `Client Side MCP Server` is in preview with `Adding an MCP Server` as an admin doc, the escape hatch is now "write and host a server," which is a strictly higher developer bar than a block-based app was.
- "A tool that cannot be set up in your workspace is skipped, and the agent is still created" is a **silent-degradation failure mode** on YAML/API import: the agent exists and will run with a reduced toolset, with no documented loud failure. This is directly relevant to any fail-loud governance requirement.
- The docs still carry role-vocabulary drift (Access Controls page says Members/Builders/Admins; Governance page says Admin/Manager/Member and calls Builder deprecated; the Skills page still says "Builders and Admins"). This is a documentation-consistency problem, and it means practitioner-facing statements about "who can build" should be verified in-product, not from docs.

### Gaps
- No published builder-to-user ratio as a platform-wide figure (only per-customer anecdotes — see Q8).
- I could not verify whether Sidekick can configure *all* builder surfaces (triggers, tool-approval settings, space scoping) or only instructions/tools/knowledge.

---

## Q3: Data sources, connectors, and permissions — inherited, Dust-managed, or both? What happens on failure?

### Takeaway
Dust is explicitly and deliberately **not** a source-ACL-mirroring system for its core "Connections" knowledge layer. Dust re-homes synced data into **Spaces** (open or restricted) with its own membership model, and admits this is "extra overhead" it chose on purpose, by analogy to a data warehouse. The critical governance consequence: **an agent inherits the data access of the space(s) it was built from, and that access persists regardless of who uses the agent**, with admin override available to widen the human audience. Permissions are **additive across groups** — there is no documented deny rule. Live *tool* calls (MCP/OAuth) are the exception: those run as the authenticated user and are therefore source-permission-bound.

### Cited Findings
- "Spaces are containers in Dust that let admins organize and control access to data." Open spaces are accessible to all workspace members; restricted spaces are limited to designated users. Admins define space membership, select data scope at folder or document level, and manage space lifecycle — [Access Controls and Permissions (docs)](https://docs.dust.tt/docs/user-documentation/admins/admin-governance/access-controls-and-permissions.md)
- **Agent-to-data:** "An agent built from data in a space its creator can access gets access to that data, and only that data. This access stays in place no matter who uses the agent." **Human-to-agent:** by default people can use an agent only if they can access every space its source data comes from; **admins can approve overrides that open an agent to specific groups.** Worked example: an HR policy agent reads restricted HR documents but is available to all employees — [Permissions in the age of AI-driven companies (Dust blog)](https://dust.tt/blog/permissions-in-the-age-of-ai-driven-companies-2)
- Dust openly names the tradeoff: it "adds a permission layer on top of source systems" and calls this "extra overhead," justifying it by comparison to data warehouses, which maintain separate access policies even though source systems already have permissions — [Permissions in the age of AI-driven companies (Dust blog)](https://dust.tt/blog/permissions-in-the-age-of-ai-driven-companies-2)
- Dust advocates a posture shift from "private by default — public when necessary" to **"public by default — private when necessary,"** restricting only truly sensitive data — [Permissions in the age of AI-driven companies (Dust blog)](https://dust.tt/blog/permissions-in-the-age-of-ai-driven-companies-2)
- **Permissions attach to groups, not individuals, and are additive**: "a person in several groups gets the combined access." Permission modes for a governed capability are **Everyone / Groups (selected) / Admin only**. Group types: **provisioned** (SCIM from IdP) and **manual** (created in Dust) — [Workspace Governance (docs)](https://docs.dust.tt/docs/user-documentation/admins/admin-governance/workspace-governance-roles-groups-and-permissions.md)
- Spaces and Pods can grant access to **individual members and groups simultaneously** (shipped 2026-09-05) — [Changelog](https://docs.dust.tt/docs/changelog.md)
- **Skill-to-space binding:** "A skill is scoped to the spaces its resources require. An agent can use it only if it has access to every one of those spaces. Changes to a skill's space requirements take effect immediately for agents using it." — [Skills Overview (docs)](https://docs.dust.tt/docs/user-documentation/agents/skills/skills-overview.md)
- **Tool credentials are a second, different model:** some tools authenticate with **Personal** credentials (Slack, HubSpot, Salesforce, Gmail, Google Calendar, Outlook), others with **Workspace/shared** credentials (Notion, GitHub, Zendesk); Confluence accepts either. The docs warn explicitly that shared credentials "will be used by all users who have access to the tool" — [Personal vs Shared Credentials (docs)](https://docs.dust.tt/docs/user-documentation/admins/tools-management/personal-vs-shared-credentials.md) via [Tools (docs)](https://docs.dust.tt/docs/user-documentation/agents/tools/index.md)
- Tools are **workspace-wide by default**. To restrict one, remove it from Company Space and add it only to specific spaces, or use the tool's Sharing tab → "Restricted Access" → select spaces: "Only members of those spaces will be able to use the tool." Tools in Company Space do not appear in individual spaces' "Add Tools" dropdown but **all users can still access them** — [Tools (docs)](https://docs.dust.tt/docs/user-documentation/agents/tools/index.md)
- Admins can restrict a tool so it is **only usable through a skill** (shipped 2026-07-29), and per-tool availability can be limited to selected Spaces (shipped 2026-09-24) — [Changelog](https://docs.dust.tt/docs/changelog.md)
- Live-tool paths *do* respect source permissions: the Figma MCP (2026-10-15) is documented so "agents only reach files the user can already access in Figma," and MCP connections act as the authenticated user, so they reach only Spaces and data that user can access — [Changelog](https://docs.dust.tt/docs/changelog.md); [Dust MCP Server (docs)](https://docs.dust.tt/docs/user-documentation/agents/integrations/dust-mcp-server)
- Workspace supports **static egress IP addresses** for tool traffic, and Pod-level **egress domain allowlists, environment variables, and secrets** for Computer sandboxes (shipped 2026-10-01; admins edit, members can view and request changes) — [docs](https://docs.dust.tt/docs/user-documentation/admins/tools-management/static-egress-ips.md); [Changelog](https://docs.dust.tt/docs/changelog.md)
- A single API key can be scoped to multiple spaces — [Access controls docs / search summary](https://docs.dust.tt/docs/access-controls-and-permissions)
- Freshness failure is a documented and acknowledged behavior, not a hypothetical: the FAQ has a dedicated page "Why isn't my recently updated document showing in agent responses?" and another on Slack thread links not always resolving to the right thread — [docs FAQ index](https://docs.dust.tt/llms.txt)
- Remote MCP servers with failed syncs now surface a warning with a Refresh action to re-run sign-in (shipped 2026-10-02) — [Changelog](https://docs.dust.tt/docs/changelog.md)
- A G2 reviewer reports "Occasional instances where the AI agent missed information present in heavily loaded Google Drive storage spaces," and separately "Some issues with the connections, like gg drive" — [Dust reviews, G2](https://www.g2.com/products/dust-dust/reviews?qs=pros-and-cons)
- Connector count is **plan-gated**: Business is capped at up to 3 connectors and 5 remote MCP servers and 5 Spaces; Enterprise gets "20+ data sources, unlimited connectors and MCP servers" — [Dust pricing page](https://dust.tt/home/pricing)

### Inferences
- The "agent inherits the builder's data access, permanently, regardless of who asks" design is Dust's single most consequential governance decision. It makes the useful HR-policy-agent case easy, and it makes **privilege escalation by agent** the structural risk: a builder with broad space access who publishes an agent has effectively created a read proxy to that data for everyone who can reach the agent. Dust's mitigation is the *default* that users must hold all source spaces — but the documented admin override exists precisely to defeat that default, and it is a per-agent, human-judgment decision with no documented review ceremony attached.
- **There is no deny-wins resolution in Dust.** Permissions are stated as additive across groups. I found no documented deny rule, no precedence model, and no documented distinction between "denied" and "could not determine." This is a direct, verifiable gap versus a deny-wins model.
- **Failure semantics are undocumented and appear to be fail-quiet.** The Access Controls page covers no behavior for denied access or errors; the FAQ treats stale/missing content as a user-education issue; YAML import silently skips unavailable tools. I found no evidence of a "config fault fails loud" posture anywhere in Dust's documentation.
- The two-model split (Dust-managed Spaces for synced knowledge; source-ACL-bound personal credentials for live tools) means an enterprise has to reason about *two different* permission systems with different failure modes for the same agent. The shared-credential warning ("used by all users who have access to the tool") is the sharpest instance.

### Gaps
- **Unverified:** whether Dust mirrors source-system ACLs for any connector at document granularity (e.g., Google Drive per-file sharing, Notion per-page permissions) during sync. The Access Controls page explicitly does not say, and I did not find a page that does. Dust's own framing (permission layer *on top of* source systems) suggests it does not, but I cannot confirm per-connector behavior.
- **Unverified:** caching behavior for retrieval or tool results — I found no documentation of a result cache, so I cannot assess whether Dust caches failures.
- **Unverified:** whether grant revocation in Dust is a delete or an append-only record. Audit logs capture `space.permissions_updated` as an *event*, which is an audit trail of the change, but that is not the same as an immutable additive grant model in the permission store itself.

---

## Q4: Governance before an agent reaches employees — review, approval, staged rollout, risk classification, admin controls

### Takeaway
Dust shipped a substantial set of **admin governance controls during 2026** — group-scoped permissions for who may create and publish agents, Admin-only/Groups/Everyone permission modes, model-tier caps, credit checkpoints, circuit breakers, per-tool approval prompts, and Enterprise audit logs. But Dust has **no agent review-and-approval gate, no risk classification, and no staged rollout** before an agent reaches employees. Publishing is a binary flag an authorized builder flips. The only review artifact Dust has shipped is an accept/decline **review card** for agents and skills created or changed *from a conversation* — a change-acknowledgment UI, not an independent reviewer gate.

### Cited Findings
- **Who may publish:** "Admins can always create and publish agents. Managers and Members can do so only 'When granted' through a group permission." Critically: "In a new workspace, **Create agents** and **Publish agents** are set to Everyone." Skill permissions (create skills, manage availability, make skills discoverable) are **Admin only by default** until changed — [Workspace Governance (docs)](https://docs.dust.tt/docs/user-documentation/admins/admin-governance/workspace-governance-roles-groups-and-permissions.md)
- Admin governance controls for groups, permissions, and who can create or publish agents shipped **2026-07-27** — i.e., this capability is roughly 15 months old as of this writing — [Changelog](https://docs.dust.tt/docs/changelog.md)
- **No approval workflow for publishing:** the Workspace Governance page "doesn't describe an approval or review process for publishing agents or skills. The only review workflow it mentions is for credit upgrades." — [Workspace Governance (docs)](https://docs.dust.tt/docs/user-documentation/admins/admin-governance/workspace-governance-roles-groups-and-permissions.md)
- **No review/approval in agent management either:** the Agents management page describes publish/unpublish, archive/restore, editors, tags, and usage filters, but "doesn't describe a review or approval process," and "doesn't describe company-wide publishing permissions or staged rollout" — [Agents management (docs)](https://docs.dust.tt/docs/user-documentation/admins/agents-management.md)
- Publication is a two-state flag: Published = "visible and usable by all workspace members, as long as they have access to the agent's data sources"; Unpublished = "visible only to you and the editors." Admins can bulk-**Unpublish** from an action bar and can see others' unpublished agents via a **Hidden agents** filter on the Workspace tab — [Create your first agent (docs)](https://docs.dust.tt/docs/user-documentation/agents/create-your-first-agent.md); [Agents management (docs)](https://docs.dust.tt/docs/user-documentation/admins/agents-management.md)
- **Closest thing to a review gate (shipped 2026-09-30):** "Agents and skills created or changed from conversations appear as **review cards** that can be accepted or declined" — [Changelog](https://docs.dust.tt/docs/changelog.md)
- Admins can open any agent in view-only mode and click **"Become an editor"** (same for skills in Skill Builder); only administrators can create tags — [Agents management (docs)](https://docs.dust.tt/docs/user-documentation/admins/agents-management.md)
- **Archive/restore:** archived agents live on an Archived tab; restoring requires being an editor or a workspace admin — [Agents management (docs)](https://docs.dust.tt/docs/user-documentation/admins/agents-management.md)
- **Destructive-action warning in the docs:** "Removing a member, or a SCIM deprovisioning, **permanently deletes the triggers they created. Deleted triggers can't be restored.**" On audit-log plans, each deletion appears as a `trigger.deleted` event, "without schedule or instructions" — [Agents management (docs)](https://docs.dust.tt/docs/user-documentation/admins/agents-management.md)
- **Runtime blast-radius controls shipped in 2026** (these are Dust's substitute for pre-release risk tiering):
  - Per-tool human approval on mutating actions. Dropbox MCP (2026-10-21): reads run freely, but "moving, deleting, or restoring files and creating shared or download links ask for your approval first." Grafana (2026-10-20): data-changing actions including raw SQL require approval. Contentful: publish/unpublish/delete require approval. Bright Data scraper runs require approval before executing. Swarmia is read-only — [Changelog](https://docs.dust.tt/docs/changelog.md)
  - An API endpoint exists for this loop: `Validate an action in a conversation message` — [API reference](https://docs.dust.tt/llms.txt)
  - Optional **sound alert** when an agent is waiting for tool approval (2026-07-08) — [Changelog](https://docs.dust.tt/docs/changelog.md)
  - **Circuit breaker:** agent messages pause after 600 LLM credits and ask whether to continue (2026-09-17 / 2026-09-21); **credit checkpoints** pause an agent for confirmation, configurable per agent or workspace-wide (2026-09-24) — [Changelog](https://docs.dust.tt/docs/changelog.md)
  - **Model access tiers:** Basic / Standard / Premium / Ultra; admins can cap members at a model tier (2026-08-04, extended 2026-09-24); audit event `user.advanced_model_access_updated` — [Changelog](https://docs.dust.tt/docs/changelog.md); [Audit Logs Events Reference (docs)](https://docs.dust.tt/docs/user-documentation/admins/audit-logs/audit-logs-events-reference.md)
  - Admins can restrict Pod creation to **Restricted Pods only** — [Pods Overview (docs)](https://docs.dust.tt/docs/user-documentation/pods/overview.md)
- **Delegated administration:** Manager role can invite/remove members, change non-admin roles, view Analytics and Credits, manage group limits and budgets, appoint **group managers**, review credit upgrade requests, and "configure governance permissions for agents, skills, Frames, and automations." Managers do **not** get billing or security access by default and cannot manage workspace model providers. Admin/Manager roles can be assigned to any workspace group (2026-09-08) — [Workspace Governance (docs)](https://docs.dust.tt/docs/user-documentation/admins/admin-governance/workspace-governance-roles-groups-and-permissions.md); [Changelog](https://docs.dust.tt/docs/changelog.md)
- Groups can be managed programmatically by Admins/Managers via MCP tools: `list_groups`, `get_group_members`, `create_group`, `update_group_members` — [Workspace Governance (docs)](https://docs.dust.tt/docs/user-documentation/admins/admin-governance/workspace-governance-roles-groups-and-permissions.md)
- **Audit logs are Enterprise-only.** Documented event categories: Agents and Skills (`agent.created`, `agent.scope_changed`, `skill.availability_updated`), Tools and Triggers (`tool.executed`, `trigger.fired`, `trigger.email_received`), Wake-ups, Spaces and Data Sources (`space.permissions_updated`, `datasource.deleted_admin`), Members/Memberships/Invitations (`membership.role_updated`, `member.bulk_revoked`), Users (`user.login_failed`, `user.identity_merged`), API Keys/OAuth/MCP (`api_key.revoked`, `oauth.authorized`, `mcp_connection.created`), Credentials BYOK (`credentials.invalidated`), Domains, SSO/Directory Sync (`sso.connection_deleted`, `scim.user_deprovisioned`), Conversations (`conversation.accessed`), Audit Logs meta (`audit_log.viewed`, `audit_log.export_configured`), Frames (`frame.share_scope_updated`), Model Access Tiers, Workspace (`workspace.deleted`) — [Audit Logs Events Reference (docs)](https://docs.dust.tt/docs/user-documentation/admins/audit-logs/audit-logs-events-reference.md)
- Security/compliance posture: SOC 2 Type II, SSO (Okta, Entra ID, Jumpcloud) + SAML, SCIM (Enterprise), US/EU data residency, **EU-hosted models** option, custom data retention (Enterprise), optional zero data retention for enterprise buyers, single-tenant deployment (Enterprise) — [Dust pricing page](https://dust.tt/home/pricing); [docs admin governance index](https://docs.dust.tt/llms.txt)
- Dust's own category-marketing page acknowledges the governance gaps as open questions rather than features: it raises the CISO question "Who maintains which agent?" **without answering it**, lists "evaluation frameworks" as a platform component with no detail, and treats permissions for autonomous agents as an unresolved question with no Dust mechanism described — [Why you need an Agent Management Platform (Dust blog)](https://dust.tt/blog/agent-management-platform)

### Inferences
- Dust's governance model is **runtime-gated, not release-gated**. It controls *who may build*, *which model tier they may burn*, *which tools exist in which space*, and *which individual tool calls need a human click* — but it does not control *whether a specific agent is fit to ship*. There is no risk tier, no reviewer, no reproduction requirement, no merge credential, no dark-deploy/flag-flip separation.
- The "Everyone can create and publish agents" default in new workspaces means the secure configuration is opt-in. Any enterprise evaluating Dust should treat day-one permission tightening as a required onboarding step, not an option.
- "Become an editor" is a useful break-glass for admins but is also an un-gated unilateral takeover of someone else's agent, recorded (on Enterprise) only as an audit event after the fact.
- `trigger.deleted` losing schedule and instructions, plus "deleted triggers can't be restored," is a documented **hard-delete with lossy audit** — the opposite of an append-only, reconstructible trail.

### Gaps
- Audit log **retention period is not stated** in the events reference, and export/streaming is only implied by the existence of `audit_log.export_configured`. I could not find documented retention or export format.
- I found no documented risk classification scheme of any kind in Dust (no tiers, no sensitivity labels on agents, no blast-radius computation).
- Unverified whether the Sep-2026 "review cards" apply to builder-initiated edits in the Agent Builder, or only to conversation-initiated changes. The changelog wording says "created or changed from conversations," which implies the narrower scope.

---

## Q5: Evaluation, testing, regression, observability — how does a builder know an agent still works after a change?

### Takeaway
**This is Dust's weakest area, and Dust has effectively said so.** There is no eval framework, no test suite, no regression harness, and no golden-set tooling documented. Testing is manual iteration in a preview pane. Observability is **usage and cost analytics plus thumbs-up/down feedback** — operational telemetry, not correctness telemetry. The founders have stated on the record that evals are deliberately deprioritized.

### Cited Findings
- The official "Troubleshooting your agent" page "doesn't describe any eval framework, test suite, regression testing, versioning, or observability tooling." Its only described testing method is manual: "builders make changes in the preview area and keep iterating until outputs look consistent," and the page "doesn't say how to confirm that an agent still works after a later change beyond repeating that preview check." Debugging advice is: ask Sidekick for suggestions, narrow the agent's sources, change model or reasoning effort, start a new conversation — [Troubleshooting your agent (docs)](https://docs.dust.tt/docs/user-documentation/agents/troubleshooting-your-agent.md)
- **The 342,000-character Dust changelog contains no entries on evaluation or testing features** (verified across the first 100,000 characters, which covers 2026 and part of late 2025) — [Changelog](https://docs.dust.tt/docs/changelog.md)
- Founders, on the record: evals are deprioritized because there are "bigger" product problems, and "small model-version gains matter less than product work." Possible future approaches named: LLM-as-judge over conversations, and product feedback loops from end users so builders can iterate — [Latent.Space](https://www.latent.space/p/dust)
- Founders' stated reason it is hard: "Without a simulation environment, agents can't be improved from synthetic runs," and "Human interaction traces are hard to judge: it's unclear whether a session ended productively" — [Latent.Space](https://www.latent.space/p/dust)
- What *does* exist — **analytics and feedback**:
  - Per-agent **Usage** = active users in last 30 days (a dash means data unavailable); Usage filter with a slider; Models filter showing which model each agent uses — [Agents management (docs)](https://docs.dust.tt/docs/user-documentation/admins/agents-management.md)
  - An **Insights** tab with **Feedback**, visible to the agent's editors, workspace admins, and managers — [Agents management (docs)](https://docs.dust.tt/docs/user-documentation/admins/agents-management.md)
  - Feedback API: `submit feedback for a specific message`, `get feedbacks for a conversation`, `delete feedback` — [API reference](https://docs.dust.tt/llms.txt)
  - Analytics API: `export consumption analytics`, `export workspace analytics`; `get conversation consumption` — [API reference](https://docs.dust.tt/llms.txt)
  - Redesigned Usage page for credit consumption, spend limits, and member usage (2026-09-11); Analytics breakdowns by Pod, agent, user, model, and tool; Pods tab ranking Pods by credit use (2026-10-14), where each viewer sees only Pods they can access — [Changelog](https://docs.dust.tt/docs/changelog.md)
  - `tool.executed` and `trigger.fired` audit events give an Enterprise-only execution record — [Audit Logs Events Reference (docs)](https://docs.dust.tt/docs/user-documentation/admins/audit-logs/audit-logs-events-reference.md)
- **Skills are versioned with diffs and authorship** (Skill Builder history view), which is the one change-tracking primitive Dust documents — [Skills Overview (docs)](https://docs.dust.tt/docs/user-documentation/agents/skills/skills-overview.md)
- Skill change propagation is **immediate and global**: "Updating a skill applies to every agent that uses it," and space-requirement changes "take effect immediately for agents using it" — [Skills Overview (docs)](https://docs.dust.tt/docs/user-documentation/agents/skills/skills-overview.md)
- A fleet-wide change tool shipped 2026-09-30: builders and admins can make workspace-wide changes such as "extracting shared skills or updating agents that use older models" — [Changelog](https://docs.dust.tt/docs/changelog.md)
- Dust ships a `Self Improving Skills` documentation page, which is the closest thing to automated quality improvement. Its mechanics are not described on the Skills Overview page — [docs agents index](https://docs.dust.tt/llms.txt)
- Correctness failures are handled as documentation, not tooling. The FAQ carries pages titled "Does the Dust agent give accurate and safe responses?" and "The agent is producing links that don't work and falsely claiming something untrue, what's going on?" and "Why doesn't the agent remember what I said earlier in a conversation?" — [docs FAQ index](https://docs.dust.tt/llms.txt)
- Known failure modes from the founders: models "get lost" in agentic, open-ended tasks; "incorrect function-call parameters derail the whole interaction"; maintaining connectors is "evergreen" work — [Latent.Space](https://www.latent.space/p/dust)

### Inferences
- **Skills are a correctness liability as well as a reuse win.** A versioned skill whose edit propagates immediately to every consuming agent, with no regression suite and no staged rollout, means one prose edit can silently change the behavior of an unknown number of production agents. Versioning lets you see *what* changed and roll back; it does not tell you *what broke*.
- Dust's quality signal is **human thumbs and usage decay**. That detects abandonment, not wrongness — an agent that confidently returns a wrong revenue number to a non-expert will keep its usage numbers up.
- "Verification is deterministic / LLM self-review is forbidden" has no Dust analogue. Dust's own debugging path routes *through* an LLM (Sidekick), and the founders' named future direction is LLM-as-judge — the opposite posture.

### Gaps
- I could not determine whether `Self Improving Skills` is a shipped automated mechanism or a documented practice. **Flagged as unverified.**
- No published information on whether Dust runs internal evals of its own default agents, or any accuracy benchmark.
- No documented per-result provenance guarantees. Dust surfaces citations in answers (and the FAQ admits links are sometimes wrong — e.g., Slack thread links), but I found no documented provenance contract.

---

## Q6: Deployment surfaces

### Takeaway
Dust has the broadest surface coverage of any platform in this comparison set: web app, Slack (with auto-reply and auto-join beta), Microsoft Teams, Zendesk agent-side, email ingestion, browser extension (Chrome/Firefox/Chromium), Raycast, Google Sheets add-on, embeddable/shareable **Frames**, a full REST API + JS SDK + CLI, an **MCP server** (Dust-as-a-tool for other clients), and triggers from schedules/webhooks/Zapier/Make/n8n/Power Automate.

### Cited Findings
All of the following are documented integration pages in Dust's live docs index — [docs index, llms.txt](https://docs.dust.tt/llms.txt):
- **Web:** primary Dust app; Pods as shared human+agent workspaces; unified search across conversations, members and admin settings (2026-10-09); conversation timeline navigation (2026-10-19) — [Changelog](https://docs.dust.tt/docs/changelog.md)
- **Slack:** `Dust in Slack`, plus `Slack Auto-Reply without @mention`, `[Beta] Slack Auto-Join`, `Slack workflows`, and a separate `Slack tools` MCP tool set, plus `Slack Troubleshooting`
- **Microsoft Teams:** `Dust in Teams`
- **Email:** `Send and Forward Email to Agents`; audit event `trigger.email_received`
- **Browser extension:** `Browser Extension (Chrome, Firefox & Chromium-based browsers)`
- **Raycast:** `Raycast Extension`
- **Zendesk:** `Dust in Zendesk` (agent-assist surface), distinct from the Zendesk data connector and Zendesk tool
- **Spreadsheets:** `Google Sheets Add-on`
- **Embedded / shareable:** `Frames` — overview + `White-labeled Frames` (Enterprise); domain-scoped sharing with per-viewer analytics (2026-09-16)
- **API/SDK/CLI:** `Developer platform`, `JavaScript SDK`, `Dust CLI`, `OpenAPI & Postman`, published swagger at `https://raw.githubusercontent.com/dust-tt/dust/refs/heads/main/front-api/public/swagger.json`, documented `Rate Limits`
- **Dust as an MCP server** (so Claude/other MCP clients can call Dust agents): `Dust MCP Server`; plus `Client Side MCP Server (Preview)` for the reverse
- **Triggers:** `Schedules`, `Webhooks` (with payload filtering and rate limiting), `Zapier`, `Make.com`, `n8n`, `Power Automate`, `Meeting transcripts`
- **Localization:** French UI (2026-10-16) and German UI with workspace-level default (2026-10-21) — [Changelog](https://docs.dust.tt/docs/changelog.md)
- UI personalization: pronouns and job title in personal settings, which agents use when referring to the user (2026-10-12) — [Changelog](https://docs.dust.tt/docs/changelog.md)
- Plan-gated: Frames are "Standard" on Business and white-labelled on Enterprise; MCP servers capped at 5 remote on Business, unlimited on Enterprise — [Dust pricing page](https://dust.tt/home/pricing)

### Inferences
- The surface strategy is **chat-everywhere**: every surface is a conversational entry point to the same agent object. There is no documented structured-form or menu-driven consumer surface — Frames are agent-*generated* artifacts (and can be dashboards or small apps), not builder-authored input forms with validated fields.
- `Slack Auto-Reply without @mention` and `Slack Auto-Join` (beta) are the most governance-relevant surfaces: they put an agent into channels without an explicit human invocation, which widens the audience for any mis-scoped agent considerably.

### Gaps
- I did not verify whether Frames can accept structured user input (forms) or are output-only. The overview page framing suggests artifacts/dashboards.
- Unverified: whether conversation results are private-by-default on every surface. In Slack a channel reply is inherently public to the channel; I found no documented private-delivery default.

---

## Q7: Pricing and packaging

### Takeaway
Dust moved from flat per-seat to **credit-metered seats** in mid-2026. Published Business numbers (ex-VAT, annual billing): Free = 500 lifetime credits; **Pro = €24/seat/mo annual (€30 monthly), 8,000 credits/seat/mo**; **Max = €120/seat/mo annual (€150 monthly), 40,000 credits/seat/mo**. Business is capped at 100 people. Enterprise is sales-quoted. Credits do not roll over. Programmatic/API usage is **$0.01/credit** on Business, custom on Enterprise. Governance features are materially plan-gated: **audit logs, SCIM, custom retention, single-tenant, unlimited connectors/MCP servers are Enterprise-only.**

### Cited Findings
- Business seat tiers, ex-VAT, from Dust's own pricing page: Free €0 / 500 credits lifetime; Pro €24 seat/mo annual or €30 monthly, 8,000 credits/seat/mo; Max €120 seat/mo annual or €150 monthly, 40,000 credits/seat/mo. Business plan is "for teams up to 100 people." Enterprise is "contact sales," described as "For AI at scale" — [Dust pricing page](https://dust.tt/home/pricing)
- Credit mechanics: "Credits are charged per message, based on the model and the tools used." **Unused credits do not roll over**; allocations reset each billing period. Pro and Max users can continue through workspace overage if an admin enables it, up to a capped amount; Free users are prompted to request an upgrade. Mid-cycle additions are prorated; monthly seats cancellable anytime; annual seats remain reassignable until the commitment ends — [Dust pricing page](https://dust.tt/home/pricing)
- Programmatic usage: **$0.01 per credit** on Business; Custom on Enterprise — [Dust pricing page](https://dust.tt/home/pricing)
- Business feature list: 20+ models (GPT, Claude, Gemini, Mistral, DeepSeek); custom agents with skills/knowledge/tools; multi-agent workflows on schedules and triggers; connectors to Slack/Notion/GitHub/Drive and 20+ more or any tool via MCP; team collaboration workspaces; SSO (Okta, Entra ID, Jumpcloud); US and EU data residency — [Dust pricing page](https://dust.tt/home/pricing)
- Business **limits**: up to 3 connectors; 5 remote MCP servers; 5 Spaces; Standard Frames; SSO available at 5+ seats on demand; email support — [Dust pricing page](https://dust.tt/home/pricing)
- Enterprise adds: unlimited connectors and MCP servers; workspace-pooled credits and volume pricing; **SCIM, audit logs, custom data retention**; single-tenant deployment; dedicated CSM, priority support, SLA; custom MSA/DPA — [Dust pricing page](https://dust.tt/home/pricing)
- Admin credit governance is a full documented subsystem: `Seat management`, `Credits`, `Credit management`, `Optimize credit consumption`, `Model access tiers`, `Train your team on credit optimization` — [docs index](https://docs.dust.tt/llms.txt). Temporary personal credit limits that auto-revert at cycle end shipped 2026-09-30; group credit limits and budgets and group managers who handle credit requests are shipped — [Changelog](https://docs.dust.tt/docs/changelog.md); [Workspace Governance (docs)](https://docs.dust.tt/docs/user-documentation/admins/admin-governance/workspace-governance-roles-groups-and-permissions.md)
- **Source conflict:** third-party trackers list Pro as $30/seat/mo and Max as $150/seat/mo (USD), while Dust's own page lists €24/€120 annual and €30/€150 monthly in euros. Treat Dust's page as authoritative and note currency ambiguity — [Dust pricing page](https://dust.tt/home/pricing) vs. [costbench Dust.tt pricing](https://costbench.com/software/ai-search-enterprise/dust-tt/)
- **Stale sources to discount:** aggregator pages still showing a single flat "$29/user/month Pro + Enterprise custom" predate the June-2026 change and several appear auto-generated — [usagepricing.com Dust blueprint](https://www.usagepricing.com/blueprint/dust)
- Customers are confused by the transition. G2, recent: "It's getting confusing at the moment are they are switching to a 'usage price' and will let you chosse between two different option (per seat or credit pool)." Another: "I wish I could connect to multiple accounts and emails without having to pay per seat for it." — [Dust reviews, G2](https://www.g2.com/products/dust-dust/reviews?qs=pros-and-cons)

### Inferences
- **Governance is an Enterprise upsell.** An organization on Business cannot get audit logs at all, is capped at 5 Spaces (the entire data-segmentation primitive), and capped at 3 connectors. Any serious "govern what agents know and do" posture on Dust requires Enterprise, i.e., sales-quoted pricing with no published floor.
- Credit metering plus the 600-credit circuit breaker and credit checkpoints means Dust's strongest *automatic* runtime guardrail is economic, not semantic: it stops runaway spend, not runaway wrongness.
- The 100-seat Business ceiling implies Enterprise is where any BI-team-scale-to-company-scale rollout lands.

### Gaps
- No published Enterprise price floor, per-seat range, or minimum commitment. One third-party source claims Enterprise starts at 100 seats; I could not confirm this on Dust's own page.
- Credit-to-token conversion is not published per model, so cost modeling requires a trial.

---

## Q8: Dust's published claims about who builds, adoption rates, and failure modes

### Takeaway
Dust publishes adoption numbers aggressively and they are **self-reported**, but the builder-share figures are the genuinely useful signal: in Dust's best-documented deployments, roughly **20–30% of employees have built an agent**, and Mirakl's stated *goal* is to reach 50%. Platform-wide, Dust claims >3,000 organizations, 41,000 MAU (April 2026), 300,000+ agents deployed, >90% monthly active and >70% weekly active, and zero churn in 2025. Treat every one of those as a vendor claim; I found no independent measurement.

### Cited Findings
- Series B announcement figures: "more than 3,000 organizations," "41,000 monthly active users in April 2026," "over 300,000 agents" deployed — [research-live](https://www.research-live.com/article/news/dust-series-b-funding-round-raises-40m/id/5149747); [Pulse2](https://pulse2.com/dust-40-million-raised-for-multiplayer-enterprise-ai-platform)
- Dust-reported platform engagement: monthly active adoption "consistently above 90%," weekly active "above 70%"; a separate claim of 51,000 MAU, **zero churn in 2025**, and 300,000 agents deployed. Third-party write-ups repeat the 70% figure but draw on Dust's own claims — [Dust blog / aggregated](https://dust.tt/blog/ai-agent-success-stories); [beri.net Dust overview](https://www.beri.net/tools/dust)
- **Builder share, per customer (the key numbers):**
  - **Mirakl:** 80% weekly active users, "70% of which are leveraging custom agents"; **"30% of Mirakl employees have already built active agents," with a goal of increasing builders to 50%** — [Mirakl customer story (Dust)](https://dust.tt/customers/why-mirakl-chose-dust-as-its-go-to-agentic-solution)
  - **Spendesk:** 93–94% monthly active across the whole company, 83%+ weekly retention, 40%+ of messages going to custom agents — [Dust customer stories](https://dust.tt/blog/ai-agent-success-stories)
  - **Watershed:** went from 20% to 90% of employees actively using the platform "within months"; builder share not disclosed — [Watershed customer story (Dust)](https://dust.tt/customers/how-watershed-got-90-of-its-team-to-leverage-dust-agents)
  - **Unnamed enterprise:** 30% daily usage across 3,000 employees, 70% weekly, **20% of employees built their own agents** — [Dust blog](https://dust.tt/blog/ai-agent-success-stories)
- **Internal conflict in Dust's own numbers:** the Latent.Space interview cites 60–70% weekly active across entire companies and 88% daily active in the single best deployment; a Dust blog cites >90% monthly / >70% weekly; the Series B cites 41,000 MAU while another Dust source says 51,000. These are not reconcilable from public material and should be presented as a range, not a figure — [Latent.Space](https://www.latent.space/p/dust); [Dust blog](https://dust.tt/blog/ai-agent-success-stories); [research-live](https://www.research-live.com/article/news/dust-series-b-funding-round-raises-40m/id/5149747)
- **Failure modes Dust itself names** (founders, on the record): models "get lost" in agentic, open-ended tasks; incorrect function-call parameters derail the whole interaction; broad auto-GPT-style agents with many tools make mistakes while precise scripted instructions work; no simulation environment so synthetic improvement is impossible; human interaction traces are hard to judge for productive outcome; connector maintenance is "evergreen" — [Latent.Space](https://www.latent.space/p/dust)
- Dust's own rollout guide is a staged adoption program — `Launch strategy`, `Team onboarding material`, `Build your builder community`, `Admin guide`, `Designing use cases`, `Educate & activate`, `Measure & expand` — i.e., Dust treats adoption as the hard problem and sells the playbook as part of the product — [docs index](https://docs.dust.tt/llms.txt)
- Dust's adoption maturity model runs: secure LLM access → knowledge assistants → personal agents → autonomous agents, and Dust describes Stage 4 (autonomous) governance and the agent permission model as **unresolved** — [Why you need an Agent Management Platform (Dust blog)](https://dust.tt/blog/agent-management-platform)

### Inferences
- "Zero churn in 2025" is the kind of claim that is true and uninformative simultaneously — at that stage of a Series-A-to-B company with mostly annual contracts and a land-and-expand motion, it tells you little about multi-year retention. **No credible churn-reason data exists publicly.**
- The 20–30% builder share, sustained across multiple named customers, is the single most transferable datapoint in this research: it is the empirical answer to "how large does a builder cohort get in a well-run no-code agent deployment." It also implies Dust's bet is a *wide, shallow* builder cohort rather than a small, credentialed one.
- Dust's self-named failure modes map almost exactly onto arguments for narrowing agent scope and pinning tool sets — their own evidence supports constrained agents over open ones, yet their governance stack does not enforce that constraint.

### Gaps
- No independent third-party audit of any adoption figure. All customer numbers come from Dust-authored case studies.
- **No usable churn-reason data.** I found no published churn analysis, win/loss data, or post-mortem of a failed Dust deployment.
- No published head-to-head Dust vs. Glean comparison from a neutral source. Everything I found in that shape was competitor-authored (e.g., a GoSearch "best Dust alternative" post), which I am not treating as evidence — [GoSearch blog](https://www.gosearch.ai/blog/best-dust-alternative-gosearch/). **Flagged as a real gap.**

---

## Q9: Documented limitations and customer complaints

### Takeaway
Dust's own docs are unusually candid about limitations (a whole FAQ branch titled "Troubleshooting and Limitations"), and the complaint clusters in reviews are consistent: latency/reliability, connector gaps and missed content, weak programmatic/API control for technical users, thin implementation support, and confusion about the 2026 pricing change.

### Cited Findings
- Dust ships a documented limitations section covering: Slack thread links not always resolving correctly; Table Query tool failing to work; "the agent is producing links that don't work and falsely claiming something untrue"; agents not remembering earlier conversation turns; recently updated documents not appearing in responses; Dust being slow or agents taking too long; plus `File size limits` — [docs FAQ index](https://docs.dust.tt/llms.txt)
- G2 complaints (verbatim where quoted): interface lag and slow agent responses ("Sometimes the interface is lagging. The agents can take some time to answer"); one 3/5 reviewer calls the product buggy and unreliable; API limits for technical users; Google Drive connection issues; AI missing content in heavily loaded Drive storage; weak implementation support; pricing-model confusion; per-seat cost for connecting multiple accounts — [Dust Pros and Cons, G2](https://www.g2.com/products/dust-dust/reviews?qs=pros-and-cons)
- **Review-volume conflict:** one roundup cites "G2 4.9/5 (19 reviews)" while G2's own page lists 86 reviews, and another source claims only two G2 reviews. These aggregators are unreliable; rely on the review text, not the counts — [G2 Dust reviews](https://www.g2.com/products/dust-dust/reviews)
- Deprecations that break existing builds: Dust Apps (no new creation since Oct 2025), Google Sheets tool marked `[Deprecated]`, File Generation tool deprecated in favor of Computer (2026-10-14), the Builder role deprecated in favor of Manager, plus a `Deprecated` docs tree of former Dust-App recipes — [docs index](https://docs.dust.tt/llms.txt); [Changelog](https://docs.dust.tt/docs/changelog.md)
- Beta/preview status to discount from "shipped": `[Beta] Slack Auto-Join`; `Client Side MCP Server (Preview)`; and all of the beta importers — Jira issues, Salesforce data, HubSpot data, Guru cards, Linear issues, Dropbox files, Front conversations — [docs index](https://docs.dust.tt/llms.txt)
- Unrecoverable deletion documented: member removal or SCIM deprovisioning permanently deletes that member's triggers, with no restore and an audit event stripped of schedule and instructions — [Agents management (docs)](https://docs.dust.tt/docs/user-documentation/admins/agents-management.md)

### Inferences
- The cluster "API limits for technical users" + "Dust Apps deprecated" + "MCP is the escape hatch" describes a platform that has optimized hard for the non-technical builder and left the technical builder with either a REST API or a hosted MCP server, with nothing in between.
- The repeated Drive/Notion content-miss complaints, combined with Dust's own "why isn't my recently updated document showing" FAQ, suggest retrieval recall over large connected corpora is a live, acknowledged weakness rather than a one-off.

### Gaps
- No published SLA numbers, uptime history detail, or incident post-mortems found (there is an "Is Dust down?" FAQ page implying a status page).
- No security incident or pen-test report found publicly beyond the SOC 2 Type II claim.

---

## WHAT DUST DOES THAT THE BENCHMARK DOES NOT

Concrete, evidenced capabilities Dust has that the benchmark architecture does not describe:

1. **Breadth of deployment surfaces, by a wide margin.** Slack (including auto-reply without @mention and auto-join beta), Microsoft Teams, Zendesk agent-assist, email forwarding, Chrome/Firefox browser extension, Raycast, Google Sheets add-on, embeddable white-labeled Frames, REST API + JS SDK + CLI, and Dust-as-an-MCP-server so external clients can call Dust agents. The benchmark describes one consumer surface (structured menus/forms). — [docs index](https://docs.dust.tt/llms.txt)

2. **A large, maintained first-party connector and tool catalog.** ~50 documented tool integrations (Snowflake, Databricks, BigQuery, Power BI, Salesforce, HubSpot, Gong, ServiceNow, Jira, NetSuite, UKG Ready, Vanta, Figma, Grafana, Contentful, Dropbox, and more), plus 12+ admin-managed data connectors, plus arbitrary MCP. Dust maintains most of these itself and calls it "evergreen" work. — [docs tools index](https://docs.dust.tt/llms.txt); [Latent.Space](https://www.latent.space/p/dust)

3. **Reusable, versioned, cross-agent Skills with authored diffs.** A Skill is a named bundle of instructions + knowledge + tools, referenceable by other skills, loaded lazily at runtime by agent judgment, with a history view showing versions, dates, authors and diffs. The benchmark has no described unit of composable, versioned agent capability shared across agents. — [Skills Overview (docs)](https://docs.dust.tt/docs/user-documentation/agents/skills/skills-overview.md)

4. **Economic blast-radius controls that the benchmark does not mention at all.** Credit metering per message by model and tool; a circuit breaker pausing an agent at 600 LLM credits with a continue prompt; configurable credit checkpoints per agent or workspace-wide; model access tiers (Basic/Standard/Premium/Ultra) with per-member caps; group budgets; temporary personal credit limits that auto-revert; group managers who adjudicate credit requests. — [Changelog](https://docs.dust.tt/docs/changelog.md); [Dust pricing page](https://dust.tt/home/pricing)

5. **Per-tool-call human approval at runtime, graded by mutation risk.** Reads flow; writes, deletes, share-link creation, raw SQL, publishing, and scraper execution prompt for approval. There is an API endpoint for it (`Validate an action in a conversation message`) and even an optional sound alert when an agent is waiting. The benchmark governs at build/review/release time; Dust also governs the individual action. — [Changelog](https://docs.dust.tt/docs/changelog.md); [API reference](https://docs.dust.tt/llms.txt)

6. **Conversational agent authoring (Sidekick) and four authoring entry paths.** From conversation, from scratch, from template, from YAML — with Sidekick drafting instructions and proposing tools and data sources. Dust also lets a builder create or modify an agent or skill from inside a running conversation, with an accept/decline review card. The benchmark's build path is an orchestrated multi-agent protocol, which is more rigorous and much less accessible. — [Create your first agent (docs)](https://docs.dust.tt/docs/user-documentation/agents/create-your-first-agent.md); [Changelog](https://docs.dust.tt/docs/changelog.md)

7. **Shared human+agent collaboration space (Pods) with agent parity.** Conversations, Tasks and Files in one container, where "everything a human can do, an agent can do" — agents create tasks, post, manage files, and with Editor rights manage membership. Pods carry an `AGENTS.md` applied to every conversation, and Pod-scoped egress domains, env vars and secrets for Computer sandboxes. — [Pods Overview (docs)](https://docs.dust.tt/docs/user-documentation/pods/overview.md); [Changelog](https://docs.dust.tt/docs/changelog.md)

8. **Enterprise compliance and tenancy surface.** SOC 2 Type II, SAML SSO, SCIM provisioning, US/EU data residency, **EU-hosted models**, custom data retention, single-tenant deployment, static egress IPs, custom MSA/DPA, zero data retention option. — [Dust pricing page](https://dust.tt/home/pricing); [docs admin governance index](https://docs.dust.tt/llms.txt)

9. **Scheduled and event-driven agent execution as a product primitive.** Schedules, webhooks with payload filtering and rate limiting, Zapier/Make/n8n/Power Automate, meeting-transcript triggers, and `Wake-ups`. — [docs triggers index](https://docs.dust.tt/llms.txt)

10. **Published adoption economics.** Dust publishes dated customer adoption and builder-share figures (Mirakl 30% of employees have built an active agent, targeting 50%; Spendesk 93–94% MAU; Watershed 20%→90%) and a formal 7-part rollout playbook. Self-reported, but it is a public, checkable baseline the benchmark does not have. — [Mirakl story](https://dust.tt/customers/why-mirakl-chose-dust-as-its-go-to-agentic-solution); [docs rollout guide](https://docs.dust.tt/llms.txt)

11. **Open-source codebase.** The full platform is open source (MIT, `dust-tt/dust`), with a published swagger spec, which allows source-level verification of permission logic — something no closed benchmark competitor offers. — [Latent.Space](https://www.latent.space/p/dust); [swagger](https://raw.githubusercontent.com/dust-tt/dust/refs/heads/main/front-api/public/swagger.json)

---

## WHAT THE BENCHMARK DOES THAT DUST DOES NOT

Each item below is a capability the benchmark describes for which I found **no evidence** in Dust's documentation, changelog, blog, or review corpus. Where Dust has a partial analogue, I say so rather than claiming a clean gap.

### Context control layer

1. **Deny-wins permission resolution.** Dust's permission model is explicitly **additive**: "Permissions are additive, so a person in several groups gets the combined access." There is no documented deny rule, no precedence, no conflict resolution. The Access Controls page covers no conflict case at all. — [Workspace Governance (docs)](https://docs.dust.tt/docs/user-documentation/admins/admin-governance/workspace-governance-roles-groups-and-permissions.md); [Access Controls (docs)](https://docs.dust.tt/docs/user-documentation/admins/admin-governance/access-controls-and-permissions.md)

2. **An explicit "denied" vs. "could not determine" distinction, and fail-loud config faults.** Dust's docs describe **no** behavior for permission denial or error. The evidence points the other way: YAML/API agent import "skips" a tool that cannot be set up in the workspace **and still creates the agent** — silent degradation by design. Remote MCP sync failures now at least raise a warning (2026-10-02), which is the only fail-loud signal I found. — [Create your first agent (docs)](https://docs.dust.tt/docs/user-documentation/agents/create-your-first-agent.md); [Changelog](https://docs.dust.tt/docs/changelog.md)

3. **Query-time declarative output guardrails enforced by a tokenizer.** Nothing of this kind exists in Dust. Dust has `Structured output format` (shape control, not content redaction) and prose instructions. Output safety is handled as *documentation* — the FAQ page "Does the Dust agent give accurate and safe responses?" — not as an enforcement layer. **No regex-based equivalent either**; there is no documented output filter at all. — [docs agents index](https://docs.dust.tt/llms.txt)

4. **Immutable, append-only grant audit where revocation is an additive FALSE row and never a delete.** Dust has Enterprise audit *events* (`space.permissions_updated`, `agent.scope_changed`, `api_key.revoked`) which record that a change happened, but that is an event log, not an append-only permission store. The documented counter-evidence is strong: member removal or SCIM deprovisioning **permanently deletes** that member's triggers, cannot be restored, and the `trigger.deleted` audit event is emitted **without the schedule or instructions** — a hard delete with a lossy trail. Audit logs are also Enterprise-only, so Business customers have no trail whatsoever. — [Agents management (docs)](https://docs.dust.tt/docs/user-documentation/admins/agents-management.md); [Audit Logs Events Reference (docs)](https://docs.dust.tt/docs/user-documentation/admins/audit-logs/audit-logs-events-reference.md)

5. **A star-schema permission model.** Dust's model is Spaces × Groups × Roles with additive union. There is no documented dimensional permission model. (Caveat: the codebase is open source, so the actual schema is inspectable; I am reporting on what is *documented*.)

6. **Success-only caching.** No caching layer of any kind is documented in Dust, so I can neither confirm nor deny failure caching. **Explicitly unverified.**

### Builder cohort / review layer

7. **Any pre-release review or approval gate on an agent.** Both the Workspace Governance page and the Agents management page state no approval or review process exists. Publishing is a flag flipped by whoever holds the "Publish agents" permission — which defaults to **Everyone** in a new workspace. The nearest analogue, accept/decline review cards for agents and skills changed from a conversation (2026-09-30), is self-acknowledgment by the same person making the change, not independent review. — [Workspace Governance (docs)](https://docs.dust.tt/docs/user-documentation/admins/admin-governance/workspace-governance-roles-groups-and-permissions.md); [Agents management (docs)](https://docs.dust.tt/docs/user-documentation/admins/agents-management.md); [Changelog](https://docs.dust.tt/docs/changelog.md)

8. **Risk tiering of a change, mechanically computed and unable to be self-downgraded.** Dust has **no risk classification of any kind** for agents or changes. Its only tiering is *model cost* tiers (Basic/Standard/Premium/Ultra) and credit thresholds. Review ceremony is not proportional to anything, because there is no review ceremony. — [Changelog](https://docs.dust.tt/docs/changelog.md)

9. **Specialist reviewer roles and an adversarial refutation step.** No architect/builder/connector/scribe/domain-authority/refuter/verifier decomposition exists. Dust's single build-assist role is Sidekick, an LLM helper that *writes* the instructions — the opposite of an adversary that tries to disprove a finding. Dust's own stated future direction is LLM-as-judge, which the benchmark forbids. — [Create your first agent (docs)](https://docs.dust.tt/docs/user-documentation/agents/create-your-first-agent.md); [Latent.Space](https://www.latent.space/p/dust)

10. **A reproduction requirement for blocking findings.** No concept of a blocking finding exists in Dust, so no reproduction requirement does either.

11. **Deterministic verification, with LLM self-review forbidden and unrunnable checks reporting SKIPPED rather than passed.** Dust has **no test, eval, or regression tooling at all** — confirmed by the troubleshooting page ("doesn't describe any eval framework, test suite, regression testing, versioning, or observability tooling"), by the absence of any eval/testing entry in a 342k-character changelog, and by the founders stating evals are deliberately deprioritized. Dust's documented method is "iterate in the preview area until outputs look consistent." Its pass/fail signal is human thumbs and 30-day usage. — [Troubleshooting your agent (docs)](https://docs.dust.tt/docs/user-documentation/agents/troubleshooting-your-agent.md); [Changelog](https://docs.dust.tt/docs/changelog.md); [Latent.Space](https://www.latent.space/p/dust)

12. **Review records bound to a head commit SHA, acting as the merge credential.** No equivalent. Dust has YAML export/import and a full agent-config API, so a customer *could* build this externally, but Dust provides no binding between a review artifact and a specific agent revision. Skills are versioned with diffs; **agents are not documented as versioned at all**, which means there is no revision identity for a review to bind to.

13. **Dark deploy separated from release by a human-attested flag flip.** Dust has one flag (Published / Unpublished) and it *is* the release. There is no staged rollout, no cohort targeting, no canary — the Agents management page explicitly does not describe staged rollout. Worse for blast radius: a **skill** edit propagates immediately to every agent using it, and space-requirement changes "take effect immediately." There is no dark state for a skill change. — [Agents management (docs)](https://docs.dust.tt/docs/user-documentation/admins/agents-management.md); [Skills Overview (docs)](https://docs.dust.tt/docs/user-documentation/agents/skills/skills-overview.md)

14. **A main session that never writes production code.** Not applicable as a concept in Dust — but note the structural inverse: Dust's conversational builder lets a builder create and modify a live, publishable agent **from inside a chat session**, which is the explicit anti-pattern the benchmark's Orchestrator protocol exists to prevent.

### Consumer layer

15. **Structured menus and forms as the consumer surface, with free-form chat deliberately retired.** Dust is chat-first on every one of its ~10 surfaces. `Structured output format` controls the shape of the *answer*, not the *input*. Frames are agent-generated artifacts/dashboards, not builder-authored validated input forms. Dust's product direction runs the other way — toward richer free-form interaction (Steering, Branch a Conversation, Go Deep, Context Compaction, Slack auto-reply without @mention). Dust has published no measurement motivating a retreat from free-form chat. — [docs agents index](https://docs.dust.tt/llms.txt); [Changelog](https://docs.dust.tt/docs/changelog.md)

16. **Private-by-default result delivery.** No documented private-by-default posture. Slack auto-reply without @mention and Slack auto-join (beta) push results into shared channels; Frames can be shared to an entire company domain; conversations are shareable. The one access-aware delivery behavior I found is narrower than privacy-by-default: the Pods analytics tab shows each viewer only the Pods they can access, and filtered agent-list links show recipients only the agents they can access. — [Changelog](https://docs.dust.tt/docs/changelog.md); [Agents management (docs)](https://docs.dust.tt/docs/user-documentation/admins/agents-management.md)

17. **Per-result provenance as a guarantee.** Dust surfaces citations, but the docs themselves admit the provenance is unreliable: dedicated FAQ pages cover "the link to the thread isn't always the right one" (Slack) and "the agent is producing links that don't work and falsely claiming something untrue." That is cited-but-not-guaranteed provenance. — [docs FAQ index](https://docs.dust.tt/llms.txt)

### The structural difference, stated plainly

Dust's governance is **runtime and economic**: who may build, which model tier they may spend on, which tools exist in which space, which individual mutating tool call needs a human click, and how many credits an agent may burn before it stops and asks. The benchmark's governance is **release-gated and evidential**: a mechanically computed risk tier, proportional adversarial review, deterministic verification, a review record bound to a revision, and a separate human-attested release. Neither is a superset. Dust is far ahead on surface reach, connector breadth, cost control and per-action approval; the benchmark is far ahead on everything that answers "how do we know this agent is correct, and who signed off on this revision" — a question Dust's own founders have said they have deliberately deferred.

---

## Source reliability notes

- **Primary and strong:** `docs.dust.tt` (including `llms.txt` index, the dated changelog, and the admin governance pages) and `dust.tt/home/pricing`. These are Dust's own live product documentation and are the basis for nearly every product claim above.
- **Primary but promotional:** Dust blog posts and customer stories. Useful for stated philosophy (the permissions post is genuinely informative about design intent) and for adoption figures, but every number is self-reported.
- **Primary-adjacent and valuable:** the Latent.Space founder interview — the only source where Dust states its architecture and its eval posture candidly. Note it is older than the 2026 changelog, so some gaps it names (Salesforce) have since narrowed.
- **Weak:** aggregator and SEO pricing sites (costbench, usagepricing, aiagentrank, beri.net, tooliverse, myclaw, sistava, maqtoob). Several appear auto-generated, several carry pre-June-2026 pricing, and their review counts conflict with G2's own page. Used only for G2 review *text* and to flag staleness.
- **Discounted entirely:** competitor-authored comparison posts (GoSearch, Metaflow). Not treated as evidence.
- **Not found:** no Hacker News or Reddit practitioner thread of substance on Dust surfaced in searches; no neutral Dust-vs-Glean comparison; no churn-reason data; no independent adoption measurement; no audit-log retention period; no Enterprise price floor.
