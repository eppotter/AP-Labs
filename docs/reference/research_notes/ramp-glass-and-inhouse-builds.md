# Ramp "Glass", entity disambiguation, and real in-house governed agent platform builds

**Research date: 2026-10-22. All "current as of" claims are as of that date.**

---

## ENTITY RESOLUTION: is "Ramp Glass" one entity or two?

### Takeaway
It is **one entity**: "Glass" is a product built by Ramp (ramp.com, the spend-management fintech) and opened to external customers on 13 October 2026. It is not a separate company, and it is not related to any of the independent companies named "Glass" (Glass Health, Glass.AI). The requester's phrase is almost certainly a reference to **Ramp Glass**, Ramp's internal AI workspace turned product.

### Cited Findings
- Ramp opened early access to **Glass, its internal AI workspace**, to outside businesses on **13 October 2026** — [CPA Practice Advisor](https://www.cpapracticeadvisor.com/2026/10/16/ramp-unveils-glass-ai-tool/191846/); [PYMNTS](https://www.pymnts.com/news/artificial-intelligence/2026/ramp-1-million-week-spending-leads-glass-ai-tool/); [Crypto Briefing](https://cryptobriefing.com/ramp-launches-glass-ai-workspace/)
- Ramp's own launch post is by co-CEO **Eric Glyman**, with early access at ramp.com/glass — [Ramp blog, "Introducing Glass"](https://ramp.com/blog/introducing-glass)
- Glyman on X: "99% of Ramp uses ai daily. but we noticed most people were stuck — not because the models weren't good enough, but because the setup was too painful and unintuitive for most. terminal configs, mcp servers, everyone figuring it out alone. so we built Glass." — [@eglyman on X](https://x.com/eglyman/status/2043362828178841860?lang=en)
- **Glass Health** is an unrelated San Francisco clinical-AI company founded 2021, CEO Dereck Paul, doing ambient scribing and clinical decision support; its LLM feature is confusingly also marketed as "Glass AI" — [Y Combinator company page](https://www.ycombinator.com/companies/glass-health); [Crunchbase](https://www.crunchbase.com/organization/glass-health)
- **Glass.AI** is an unrelated London company (founded ~2012, ~17 employees) doing AI-driven web-content monitoring and economic-sector mapping; recent work includes a UK Office for Life Sciences sector-mapping partnership (5 Oct 2026) — [PitchBook profile](https://pitchbook.com/profiles/company/120670-57); [glass.ai](https://www.glass.ai/)
- I found **no standalone company called "Glass" in AI security**. The security-sounding feature list ("SSO, RBAC, audit logs, PII masking, data residency") attributed to "Glass AI" on a software-directory listing is a feature description of a product, not a security vendor — [Slashdot listing](https://slashdot.org/software/p/Glass-AI/)

### Inferences
- The "one entity or two" ambiguity in the request most likely arose because "Glass" reads like an independent vendor name. It is not. Anyone evaluating "Ramp Glass" is evaluating a Ramp product.
- Of all entities named "Glass," **only Ramp Glass is relevant to governed internal AI agent platforms**. Glass Health is clinical AI; Glass.AI is web/market intelligence. Neither is an agent platform in any sense.

### Gaps
- No Crunchbase/PitchBook-grade confirmation that no seed-stage "Glass" agent-platform startup exists; search coverage of unannounced pre-seed companies is inherently weak. Treat "no other relevant Glass" as high-confidence-but-not-exhaustive.

---

## PART A, Q1: Has Ramp published about an internal AI agent platform / internal builder program?

### Takeaway
**Yes — extensively, and from primary sources.** Ramp's engineering blog (builders.ramp.com, formerly engineering.ramp.com) has 52 posts, and the 2026 run is dominated by detailed, first-person accounts of internal agent infrastructure: **Laminar** (the agent harness), **Inspect** (background coding agent), **OCA** (AI on-call assistant), **Ramp Router** (model routing), plus internal benchmarking posts. Ramp is a genuine, well-documented in-house-build case — not a thin one.

### Cited Findings
Ramp's own 2026 posts, with authors and dates, from the blog feed — [builders.ramp.com/feed.xml](https://builders.ramp.com/feed.xml):

| Date | Post | Authors |
|---|---|---|
| 2026-10-22 | Agentic Credit Analysis | Blake Williams, Rohan Goel, Jake Pappo, Avery Geller, Mueed Rehman |
| 2026-10-20 | **Building Laminar: Ramp's Managed Agents Platform** | Sam Kronick |
| 2026-09-09 | **How we built OCA, our AI on-call assistant** | Richard Marmorstein, Austin Ray |
| 2026-08-14 | Integrations That Write Themselves | Shubhayan Srivastava |
| 2026-07-20 | Online Learning for Cost-Efficient LLM Routing | Kedar Thakkar |
| 2026-06-30 | Agentic Risk Operations | Blake Williams, Mueed Rehman, Vishal Sundaram, Brad Hoeweler |
| 2026-06-17 | You're Spending Too Much on AI. You're Also Using Too Little. | Anand Kuchibotla, Kedar Thakkar, Rahul Sengottuvelu |
| 2026-06-03 | **Stack Benchmarking** | Ryan Stevens |
| 2026-05-04 | **Agentic identity: modeling agents to keep users in control** | Steve Venzerul, Rachel Kaplan |
| 2026-04-16 | Building a Unified Pipeline for AI Token Spend | Kedar Thakkar, Richard Wang, Veeral Patel |
| 2026-03-09 | Financial Benchmarks | Kedar Thakkar, Anton Biryukov, Ashwin Kumar, Ryne Carbone |
| 2026-02-20 | **We proactively fixed ~100 security issues in 6 days with 0 humans** | Eli Block |
| 2026-01-12 | **Why We Built Our Own Background Agent** | Zach Bruggeman, Jason Quense, Rahul Sengottuvelu |
| 2025-07-10 | How To Build Agents Users Can Trust | CJ Enright, Will Koh, Felix Zhang |
| 2025-03-25 | Building Ramp's MCP server | Junho Choi |

**Laminar** (the platform layer):
- Laminar is Ramp's **in-house agent harness**, built after evaluating model-provider agent SDKs, managed agent APIs, open-source coding agents, agent frameworks, third-party vendors, and several generations of internal frameworks — [Ramp, "Building Laminar"](https://builders.ramp.com/post/building-laminar)
- Consolidation decision was made **around May 2026**; the design motto was **"build agents, not infrastructure"** — common agent plumbing is abstracted so product builders don't manage it day to day — [Ramp, "Building Laminar"](https://builders.ramp.com/post/building-laminar)
- Products built on Laminar, per Ramp: month-end close automation for accounting firms; token spend tracking/optimization for finance teams; a cardholder SMS assistant; the in-house cloud coding agent; and **"a customized desktop agent for knowledge work"** — [Ramp, "Building Laminar"](https://builders.ramp.com/post/building-laminar)
- Third-party coverage: Ramp reached a first Laminar version in **six weeks**, and LangChain's CEO frames it as part of a broader build-your-own-harness shift — [The New Stack, 22 Oct 2026](https://thenewstack.io/ramp-laminar-agent-harness/)
- Secondary summaries report Laminar separates conversation history and execution state from sandboxes (so sandboxes can start/stop without interrupting a session) on **Postgres + Temporal + S3**, and claim **model routing cut median LLM cost per thread 64% across 973 threads with merged-PR rates roughly flat** — [search summary of ZenML LLMOps DB / daily.dev coverage](https://www.zenml.io/llmops-database/building-a-provider-agnostic-agent-platform-for-fintech-products). **I could not verify these architecture details or the 64%/973-thread figure against Ramp's own post**, which contains no architecture or metrics. Treat as unconfirmed.

**Inspect** (the background coding agent — the most detailed primary account):
- Architecture: each session runs in an **isolated VM on Modal** with a full dev environment (Vite, Postgres, Temporal). Each repo has a **prebuilt image rebuilt every 30 minutes**, so code is at most 30 min stale. A **snapshot** is taken when the agent finishes so follow-ups resume from that state — [Ramp, "Why We Built Our Own Background Agent"](https://engineering.ramp.com/post/why-we-built-our-background-agent)
- Agent runtime is **OpenCode** (open-source, server + clients, typed SDK, plugin system). **Cloudflare Durable Objects** give each session its own SQLite DB so sessions can't affect each other; Cloudflare's Agents SDK handles streaming between sandbox, API and clients — [same source](https://engineering.ramp.com/post/why-we-built-our-background-agent)
- Concurrency: follow-up prompts are **queued, not injected mid-run**; agents can be stopped mid-task; agents can **spawn and check on child sessions** — [same source](https://engineering.ramp.com/post/why-we-built-our-background-agent)
- Surfaces: **Slack, a web client, a Chrome extension, PR comments, and a browser-based VS Code instance**. Sessions are **multiplayer**, and **each prompt is attributed to its author**. The Slack client uses a **GPT 5.2 classifier with no reasoning** to pick the target repo, with an explicit **"unknown" option that asks the user** rather than guessing — [same source](https://engineering.ramp.com/post/why-we-built-our-background-agent)
- The Chrome extension sends **DOM and React internals rather than screenshots** to cut token use, and is distributed via **managed device policy** — [same source](https://engineering.ramp.com/post/why-we-built-our-background-agent)
- **Non-engineers (PMs, designers) contribute through the same tooling** — [same source](https://engineering.ramp.com/post/why-we-built-our-background-agent)

**OCA** (AI on-call assistant):
- Event-triggered: incident.io opens a Slack channel per incident, OCA joins, investigates, and posts interim and final findings, drawing on the same systems human responders use. It is **orchestrated with Temporal and operated with human review and narrowly scoped write access** — [Ramp, "How we built OCA"](https://builders.ramp.com/post/how-we-built-oca-our-ai-on-call-assistant) (via [search summary](https://www.zenml.io/llmops-database/production-ai-assistant-for-incident-investigation-and-remediation))
- **OCA hands code fixes to Inspect, which drafts a PR for a human to review** — it does not merge — [same](https://builders.ramp.com/post/how-we-built-oca-our-ai-on-call-assistant)
- Reliability engineering detail: Ramp adds **"detour" hooks** that fire at specific moments, e.g. forcing a cross-check against production data immediately before a post goes out. They also found agents default to short log-query windows (one-hour lookback), see the earliest result inside it, and wrongly conclude an issue just started; the fix was a prompt instruction telling the agent to ask whether its query could be silently excluding relevant data — [same](https://builders.ramp.com/post/how-we-built-oca-our-ai-on-call-assistant)

### Inferences
- Ramp's internal platform is **three-tier in practice** even though Ramp doesn't label it that way: Laminar (harness/plumbing) → named agents (Inspect, OCA, Ramp Research, integrations agent, risk/credit agents) → surfaces (Slack, web, Chrome extension, PR comments, SMS, VS Code).
- Ramp's published posture is **capability-and-cost-led, not governance-led**. Architecture, latency, cost routing, and benchmarking get deep treatment; permission models, approval workflows, and audit design get only passing mentions. That is the single biggest contrast with the benchmark solution.
- The "one agent builds, another verifies, a human merges" pattern (OCA → Inspect → human reviewer) is a real-world analogue to the benchmark's Orchestrator → specialist sub-agent split, arrived at independently.

### Gaps
- Ramp's own Laminar post is unusually thin (no architecture, no metrics, no governance, no eval). The substantive Laminar technical detail circulating is all secondary.
- I did not fetch "Agentic identity: modeling agents to keep users in control" (May 2026) — the URL slug I guessed was wrong and the blog's HTML shell returns no content to fetchers. **This is the single most likely place Ramp's permission/delegation model is documented and should be read directly.** Correct path is likely under builders.ramp.com from the feed.
- Likewise unfetched: "We proactively fixed ~100 security issues in 6 days with 0 humans" (Eli Block, Feb 2026) — directly relevant to how Ramp handles unsupervised agent-written code.
- An OpenAI case study, "How Ramp engineers accelerate code review with Codex" ([openai.com/index/ramp/](https://openai.com/index/ramp/)), appeared in results but was not fetched. It likely contains Ramp's AI code-review governance.

---

## PART A, Q2: Is there a Ramp product or internal tool named "Glass"? (Definitive)

### Takeaway
**Yes, definitively.** Glass is Ramp's internal AI workspace, built by a small team after a $1.5M-in-one-week token-spend incident in May 2026, and opened to external early-access customers on 13 October 2026. It is the consumer/employee layer of Ramp's AI stack — closest in spirit to the benchmark's layer (3), but free-form chat rather than structured menus.

### Cited Findings
From Ramp's own launch post — [Ramp, "Introducing Glass"](https://ramp.com/blog/introducing-glass):
- Stated purpose: capture what a company learns **so employees don't start from an empty chat**.
- **Origin:** Ramp spent **$1.5 million on tokens in one week in May**; a small team then built Glass as a shared version of its most AI-forward employees' setups.
- **Company knowledge:** connects to Linear, Notion, Google, Slack, and Gong. **Employees can edit what it knows.** Worked example: Finance taught it a rule excluding certain U.S. companies with U.K. offices from U.K. customer counts.
- **Skills:** saved prompts/workflows reusable by others. Example chain: one account manager's prompt pulls feature requests from customer calls; other prompts prioritize them and email customers when features ship.
- **Multiplayer:** sessions can be shared; a teammate joins, sees the context, and finishes the work.
- **Models:** supports open and closed models; requests route through **Ramp Router**, which picks a model per job.
- **Cost controls:** each project has a **live cost meter**, and users can set limits before they're reached.
- **Who builds skills:** PMs, CX agents, salespeople, marketers, analysts; Finance contributed knowledge.
- **Self-reported metrics:** 323 employees made **6,500+ edits** to Glass's knowledge; feature-request capture rose from **~300 to 20,000/month**; **5,000+** customer emails about shipped features sent; Ramp's own bill **fell 30%** after moving work onto Ramp Router.

From secondary coverage (treat as company-reported-via-press):
- Glass is **built on Anthropic's Claude Agent SDK**; the skills marketplace is called **Dojo** and ships **350+ reusable skills**; a feature called **Sensei** recommends skills to each user — [search summary of BuildBetter/aicatchup coverage](https://blog.buildbetter.ai/what-is-ramp-glass/); [aicatchup playbook](https://aicatchup.com/practices/internal-ai-workspaces-playbook)
- **Dojo is Git-backed, so every skill has version history**; one guide describes each skill as "a markdown file describing one task, Git-backed and reviewed like code" — [aicatchup](https://aicatchup.com/practices/internal-ai-workspaces-playbook). **The "reviewed like code" claim is third-party, not Ramp's.**
- Setup is via **SSO (reported as Okta)**, and the workspace auto-connects to internal tools so tools carry company permissions — [Implicator.ai](https://www.implicator.ai/ramp-glass-ai-workspace-token-spending/); [aicatchup](https://aicatchup.com/practices/internal-ai-workspaces-playbook)
- Reported **99.5% internal AI adoption** (other sources say 99%) and a **30% AI cost reduction "in certain accounts"** — [CPA Practice Advisor](https://www.cpapracticeadvisor.com/2026/10/16/ramp-unveils-glass-ai-tool/191846/); [PYMNTS](https://www.pymnts.com/news/artificial-intelligence/2026/ramp-1-million-week-spending-leads-glass-ai-tool/)
- Memory refresh is reported inconsistently: one source says Glass **rebuilds memory every 24 hours from Slack, Notion and Calendar**; another adds Linear. Ramp has not said whether employee edits feed that rebuild — [aicatchup](https://aicatchup.com/practices/internal-ai-workspaces-playbook)
- Skeptical outside view: the launch figures are all Ramp's own, buyers have no independent measure, and established rivals already offer skill-sharing — [Implicator.ai](https://www.implicator.ai/ramp-glass-ai-workspace-token-spending/); [Headways analysis](https://headways.ai/blog/ramp-glass-lessons-enterprise-ai)
- Ramp's engineering blog has **no post on Glass** — [aicatchup](https://aicatchup.com/practices/internal-ai-workspaces-playbook), consistent with my read of the 52-post feed.

### Inferences
- Glass's genesis is a **cost-governance incident, not a safety incident**. The guardrails Ramp publicized (cost meters, per-project limits, model routing) are economic controls. Nothing published describes data-access guardrails, deny-rule semantics, or a grant audit trail.
- Glass's governance model is essentially **"inherit SSO identity + Git-version the skills."** That is real but shallow compared with an explicit permission model. "Tools carry the company's permissions" means Glass delegates authorization to the connected systems rather than resolving it itself.
- Ramp productizing its internal workspace is strategically notable: the internal-build path and the vendor path are converging. Within 12 months, the benchmark's "we built it ourselves" differentiation may be partly purchasable.

### Gaps
- **No official Ramp documentation of Glass approval workflows, who may publish a skill, how skills are retired, or how knowledge edits are reviewed.** This is the clearest governance hole in the public record.
- No public pricing or packaging for Glass. Ramp says it is onboarding the first businesses personally.
- Whether Dojo skills undergo actual code review (vs. merely being stored in Git) is unverified.

---

## PART A, Q3: Ramp's customer-facing AI agent product

### Takeaway
Ramp ships customer-facing agents across finance operations — month-end close for accounting firms, token-spend tracking, an SMS cardholder assistant, agentic credit analysis, and expense-approval agents — all now running on Laminar. Governance is documented mainly as **human-in-the-loop plus agent identity modeled on delegated user authority**, and evaluation is unusually rigorous for customer-facing work.

### Cited Findings
- Agentic products on Laminar, per Ramp: **month-end close automation for accounting firms; token spend tracking and optimization for finance teams; a personal AI assistant for cardholders via SMS; the in-house cloud coding agent; a customized desktop agent for knowledge work** — [Ramp, "Building Laminar"](https://builders.ramp.com/post/building-laminar)
- **Agentic Credit Analysis** (22 Oct 2026): "agent pipeline that makes autonomous credit decisions from financial statements" — [feed](https://builders.ramp.com/feed.xml)
- **Agentic Risk Operations** (30 Jun 2026) and **Integrations That Write Themselves** (14 Aug 2026, agentic system that builds and maintains customer-requested integrations) — [feed](https://builders.ramp.com/feed.xml)
- **Agentic identity** (4 May 2026): Ramp frames **"agents acting for users" as the starting point for adopting agents in finance** — [feed](https://builders.ramp.com/feed.xml). (Post body unfetched — see Gaps.)
- **How To Build Agents Users Can Trust** (10 Jul 2025): lessons from building an expense-approval agent — [feed](https://builders.ramp.com/feed.xml)
- Ramp also published **Building Ramp's MCP server** (25 Mar 2025) — an MCP server letting LLMs access Ramp resources — [feed](https://builders.ramp.com/feed.xml)
- Ramp press release: "Ramp Introduces AI Agents to Automate Finance Operations" — [PR Newswire](https://www.prnewswire.com/news-releases/ramp-introduces-ai-agents-to-automate-finance-operations-302502154.html)
- Earlier agent product documented externally by LangChain as a "tour guide for financial ops" — [LangChain Breakout Agents: Ramp](https://www.langchain.com/breakoutagents/ramp)

### Inferences
- "Agents acting for users" is a **delegation** model: the agent borrows a specific user's authority rather than holding its own standing grants. That is a different design point from the benchmark's star-schema permission model, which resolves authorization centrally. Delegation is simpler and inherits existing ACLs correctly; it cannot express "this agent may never see X regardless of who asks."
- Ramp's customer-facing governance story is thinner in public than its engineering story, which is expected for a regulated fintech.

### Gaps
- I could not read the agentic-identity post body, so Ramp's actual scoping, delegation, revocation and audit mechanics are **unverified**. Do not assert them.
- No public information on how Ramp governs customer data isolation inside agent sessions.

---

## PART A, Q4: How does Ramp govern internal AI usage?

### Takeaway
Ramp's published internal-AI governance is **thin on access control and strong on three specific things**: (a) identity-correct Git operations that structurally prevent self-approval of AI-written code, (b) human review as the merge gate, and (c) cost governance via routing, metering and limits. There is **no published evidence** of a declarative guardrail layer, a deny-wins permission model, or an immutable grant audit trail.

### Cited Findings
- **Self-approval is structurally prevented:** Inspect opens PRs with **the requesting user's GitHub token, not the app's identity**, which Ramp states **"prevents users from approving their own changes."** Git operations during clone use a GitHub App installation token generated per clone, so no particular user is tied to the clone — [Ramp, "Why We Built Our Own Background Agent"](https://engineering.ramp.com/post/why-we-built-our-background-agent)
- Ramp states it does not want to "knowingly create a vector for unreviewed code" to enter the codebase — [same source](https://engineering.ramp.com/post/why-we-built-our-background-agent)
- Sessions are authenticated through GitHub; a GitHub webhook tracks PR updates, merges and closures; commits are attributed by setting git user name/email on push — [same source](https://engineering.ramp.com/post/why-we-built-our-background-agent)
- **Verification is tool-based, not self-assessed:** on backend changes Inspect runs tests, reviews telemetry and queries feature flags; on frontend changes it visually verifies, produces screenshots and provides live previews. Integrations: **Sentry, Datadog, LaunchDarkly, Braintrust, GitHub, Slack, Buildkite** — [same source](https://engineering.ramp.com/post/why-we-built-our-background-agent)
- **No mandated tool migration:** "Ramp says it did not require anyone to switch from their own tools" — [same source](https://engineering.ramp.com/post/why-we-built-our-background-agent)
- **OCA has "narrowly scoped write access" and "human review"** — [Ramp, "How we built OCA"](https://builders.ramp.com/post/how-we-built-oca-our-ai-on-call-assistant)
- **Cost governance:** Ramp Router selects a model per request; Glass projects have live cost meters and user-set pre-emptive limits; Ramp built a real-time AI spend/usage pipeline (16 Apr 2026) and published Thompson-sampling-over-latency LLM routing (20 Jul 2026) — [Ramp, "Introducing Glass"](https://ramp.com/blog/introducing-glass); [feed](https://builders.ramp.com/feed.xml)
- Ramp's internal position on spend: high AI bills reflect **poor purchasing, not overuse** — "You're Spending Too Much on AI. You're Also Using Too Little." (17 Jun 2026) — [feed](https://builders.ramp.com/feed.xml)
- Ramp ran an experiment where agents **fixed ~100 security issues in 6 days with 0 humans** (20 Feb 2026) — [feed](https://builders.ramp.com/feed.xml). Body unfetched; the title alone implies a deliberate zero-human-in-loop mode for a bounded, low-risk class of change.

### Cited Findings — explicitly absent from Ramp's published record
- The Inspect post **"does not describe its specific review workflow, security policies, or audit controls"** beyond identity-correct PR authorship — [Ramp, "Why We Built Our Own Background Agent"](https://engineering.ramp.com/post/why-we-built-our-background-agent)
- No official Ramp description of **who can publish a Glass skill, approval workflow, or skill retirement** — [aicatchup](https://aicatchup.com/practices/internal-ai-workspaces-playbook)

### Inferences
- Ramp's merge gate is **procedural** (a human must review) and its identity design makes that gate hard to bypass. It is **not risk-tiered** — nothing published suggests the review burden varies by what changed. The benchmark's mechanically-computed risk tier from changed file paths has no Ramp analogue in the public record.
- Ramp's verification philosophy — give the agent real tools and real telemetry so it checks work against reality rather than opining on it — is **directionally the same instinct** as the benchmark's "deterministic verification, LLM self-review forbidden," but Ramp has not published a prohibition on LLM self-review, and the Inspect loop is the *agent* verifying itself with tools, not an independent deterministic gate.
- Ramp has published nothing resembling "SKIPPED vs passed" or a distinction between "denied" and "could not determine." Their fail-loud instinct shows up in two narrower places: the Slack repo classifier's explicit "unknown → ask the user" option, and the OCA detour hook that forces a production cross-check before publishing. Both are **ask-rather-than-guess** patterns, which is the same philosophy at much smaller scope.

### Gaps
- Approved-tool lists, data-classification rules for AI access, DLP, and vendor review are **entirely absent** from Ramp's public record. Do not infer them.
- Whether Ramp requires human review on *all* AI PRs or only some is not stated.

---

## PART A, Q5: What outcomes has Ramp disclosed? (claimed vs. measured)

### Takeaway
Ramp has disclosed **unusually specific productivity and cost numbers**, but almost all are **self-reported internal activity metrics, not controlled measurements**, and Ramp's OCA post says so explicitly. **No headcount-avoidance or cost-reduction-by-headcount claim exists in the sources I found** — that framing appears nowhere in Ramp's published material.

### Cited Findings — Ramp's own numbers
- **Inspect:** "~30% of all pull requests merged to our frontend and backend repos are written by Inspect," reached in "a couple months" and "continues to grow." The org-wide stats page tracks sessions producing a merged PR, which Ramp calls "the most important metric to track"; a "humans prompting" counter uses prompts in the last 5 minutes — [Ramp, "Why We Built Our Own Background Agent"](https://engineering.ramp.com/post/why-we-built-our-background-agent)
- **Conflicting Inspect figure:** Modal's case study reports Inspect "now writes over half of all merged pull requests at Ramp," while Ramp's own January post says ~30% — [Modal case study](https://modal.com/blog/how-ramp-built-a-full-context-background-coding-agent-on-modal) vs. [Ramp](https://engineering.ramp.com/post/why-we-built-our-background-agent). **Most likely explanation: growth between January and mid-2026, not a contradiction. Report both with dates.**
- **OCA (four-week window):** assisted with **575 of 1,220** incident-related merged PRs; among incidents with merged fixes, OCA-assisted fixes were associated with **37% fewer engineers** and **~50% less estimated engineer time**; responders rated it helpful **90%** of the time. Ramp states these "are based on internal activity estimates and coarse feedback" — **i.e. Ramp itself disclaims this as not a controlled study** — [Ramp, "How we built OCA"](https://builders.ramp.com/post/how-we-built-oca-our-ai-on-call-assistant)
- **Glass:** 323 employees made 6,500+ knowledge edits; feature-request capture **~300 → 20,000/month**; 5,000+ customer emails sent about shipped features; Ramp's own AI bill **fell 30%** after moving work onto Ramp Router — [Ramp, "Introducing Glass"](https://ramp.com/blog/introducing-glass)
- **Adoption:** Glyman claims **99% of Ramp uses AI daily** — [@eglyman on X](https://x.com/eglyman/status/2043362828178841860?lang=en); press coverage reports **99.5%** — [CPA Practice Advisor](https://www.cpapracticeadvisor.com/2026/10/16/ramp-unveils-glass-ai-tool/191846/). **The two figures conflict; neither is independently verified.**
- **Security:** "~100 security issues in 6 days with 0 humans" — [feed](https://builders.ramp.com/feed.xml) (title only; methodology unverified)
- **Benchmarking (closest thing to a measured result):** see Q6 below.
- **Unverified secondary claim:** model routing cut median LLM cost per thread **64% across 973 threads** with merged-PR rates roughly flat — [ZenML/daily.dev coverage](https://www.zenml.io/llmops-database/building-a-provider-agnostic-agent-platform-for-fintech-products). Not present in Ramp's Laminar post.
- **Outside skepticism:** Glass launch figures are Ramp's own and buyers have no independent measure — [Implicator.ai](https://www.implicator.ai/ramp-glass-ai-workspace-token-spending/)

### Inferences
- The strongest *measured* Ramp result is not a productivity claim at all — it is the **Stack Benchmarking ablation**, which is a real experiment with runs, criteria, and negative findings. Ramp's productivity numbers are activity telemetry; its benchmark numbers are evidence.
- **"X% of PRs written by AI" is not a productivity measurement.** It measures authorship share, not throughput, quality, or rework. Ramp's own most-important-metric choice (sessions producing a merged PR) is an honest attempt to do better, but still counts activity.
- Treat the 30% AI-cost reduction as two different claims that have been conflated in press: Ramp's blog attributes it to **Ramp Router** adoption; press attributes it to **Glass "in certain accounts."** Same number, different scope.

### Gaps
- **No headcount-avoided claim found anywhere.** If the requester believes Ramp claimed one, that belief is not supported by the sources I checked.
- No disclosure of AI-written-code defect rates, revert rates, or incident attribution — the metric that would actually validate the governance model.

---

## PART A, Q6: Ramp's evaluation approach (the most benchmark-relevant finding)

### Takeaway
Ramp's **Stack Benchmarking** post is the most rigorous publicly documented internal agent evaluation I found at any company — synthetic "worlds," accountant-authored criteria, multi-run pass metrics, and **honest negative results showing most of their own skills made things worse**. This is a genuine differentiator for Ramp and a direct, useful contrast to the benchmark's deterministic-verification approach.

### Cited Findings
All from [Ramp, "Stack Benchmarking"](https://builders.ramp.com/post/stack-benchmarking):
- **Design:** synthetic businesses ("worlds") with simulated accounting-software state (e.g. QuickBooks) and supporting files, plus accountant-written tasks. **8 worlds, 237 tasks, 3,469 grading criteria.** Six standard worlds plus **two "roll-forward" worlds** that test whether memory carries into a later period **without contaminating it**. Task categories: reconciliation, data entry, variance analysis, schedules and accruals.
- **Grading:** accountants wrote multiple criteria per task (e.g. "is this specific line item identified as a top variance"); a task score is the **fraction of criteria satisfied**.
- **Metrics:** Pass@1, Pass@5, **Pass^5 (all five runs pass)**, and mean criteria accuracy. Most metrics use **five independent runs per task**. Reasoning effort set to high where configurable. Raw models ran with **no skills and no memory**; Ramp Stack ran with both. Runtime measured from trajectory timestamps.
- **Skills ablation — the key negative result:** they removed all skills, then tested each skill alone. **Only two skills were positive on average, one neutral, and the rest negative. None was best across all worlds.** The retained "slim" bundle averaged **+2.3 points** over the no-skills baseline across six standard worlds. A spreadsheet skill was cut from **14k to 5k characters (64% smaller)**; on one world the original scored +3.7 and the slim version +3.3, while the full slim bundle reached +5.4.
- **Memory findings:** on the roll-forward world, mean score rose **56.0% → 61.5% (+5.5 pts)**. Reusable-workflow memories helped (a workers' comp accrual task went **0% → 100%**). **Period-specific fact-pattern memories hurt** (an Apex billing task fell **75% → 25%**). This drove a shift to **step-oriented memory** favoring stable account mappings and procedures over period-specific amounts.
- **Model comparison:** Ramp Stack scored highest overall (stated as +4% accuracy and +3% Pass@1, baseline not clearly stated). GPT 5.5 and Opus models close; **GPT 5.4 trailed GPT 5.5 by nearly 19 points**; Opus 4.6 and 4.7 nearly identical; Gemini lagged. Schedules and accruals hardest for raw models. Latency: GPT 5.4 fastest at ~4 min/task, Gemini 3.5 Flash slowest at just over 20 min.
- **Internal inconsistency to flag:** the post says Ramp Stack is built on GPT 5.5 but also places it on the accuracy-latency frontier alongside GPT 5.4.
- Ramp also published **Financial Benchmarks** (9 Mar 2026) comparing LLMs on real financial tasks — [feed](https://builders.ramp.com/feed.xml)

### Inferences
- The skills ablation result is the single most transferable finding in this whole research set: **a skills/knowledge marketplace is not self-evidently net-positive.** Ramp measured its own and found most individual skills negative. Any platform shipping 350+ skills (Glass's Dojo) without per-skill ablation is shipping unmeasured regressions.
- Ramp's eval is **probabilistic quality measurement**, where the benchmark's verification layer is **deterministic gating**. These are complementary, not competing: Ramp measures how good an agent is; the benchmark proves a specific change is safe. Neither substitutes for the other, and the benchmark has no analogue to Ramp's Pass^5 consistency metric.
- The memory contamination finding (period-specific memories actively harmful) is a direct argument for the benchmark's approved-knowledge-source discipline.

### Gaps
- **The post does not state whether grading is human, rule-based, or LLM-as-judge.** This matters enormously for interpreting the numbers and is the most important unanswered question about Ramp's eval. Do not assume determinism.
- Run-to-run variance beyond the five-run/Pass^5 design is not discussed.

---

## PART B: Any company or product named "Glass" in the enterprise AI / agent space

### Takeaway
**None of the independent companies named "Glass" is relevant to governed internal AI agent platforms.** Glass Health is clinical AI. Glass.AI is web/market intelligence. No standalone "Glass" AI-security company exists in the sources I checked. The only relevant "Glass" is Ramp Glass, covered in Part A. I therefore redirected the depth budget to **three companies with genuinely detailed published internal agent-platform builds: Uber, Stripe, and Shopify** (plus Block on red-teaming), which follow.

### Cited Findings
- **Glass Health** — San Francisco, founded 2021, CEO Dereck Paul; AI-powered clinical decision support and ambient scribing; its diagnosis/plan-generation LLM feature is marketed as "Glass AI"; pricing reported $0–$200/month — [Y Combinator](https://www.ycombinator.com/companies/glass-health); [CB Insights](https://www.cbinsights.com/company/glass-health); [MedAI Directory review](https://medaidirectory.com/blog/glass-health-review-2026). One review warns its individual terms authorize model training on PHI with an opt-in BAA — relevant only as a cautionary note, not to agent platforms.
- **Glass.AI** — London, founded ~2012, ~17 employees; "web content monitoring platform that uses artificial intelligence technology to provide a live interpretation of web content around real-world entities"; Oct 2026 partnership with the UK Office for Life Sciences and Technopolis to map the UK life-sciences sector; selected for Barclays Eagle Labs Scaleup Programme 2026 cohort — [PitchBook](https://pitchbook.com/profiles/company/120670-57); [glass.ai](https://www.glass.ai/). PitchBook's funding dates look internally inconsistent; treat its financials cautiously.
- **"Glass AI" security listing** — a software directory lists "Glass AI" with "security built in with SSO, RBAC, audit logs, PII masking, and data residency." This is a **product feature list, not a security company** — [Slashdot](https://slashdot.org/software/p/Glass-AI/)
- Searching specifically for a "Glass" enterprise agent-platform startup returned **no match**; nearest hits were unrelated (Rasa, IBM watsonx Orchestrate, Cognigy rankings; Prime Intellect's $130M Series A for enterprise agent-building) — [search results](https://rasa.com/blog/10-best-ai-agent-platforms-for-enterprise-in-2026); [TechCrunch](https://techcrunch.com/2026/07/08/prime-intellect-raises-130m-series-a-to-help-enterprises-build-their-own-ai-agents/)

### Inferences
- The name collision is a real risk in any writeup. "Glass AI" means Glass Health's diagnosis feature to a clinician and Ramp's workspace to a fintech buyer. Always write **"Ramp Glass."**

### Gaps
- Pre-seed/unannounced companies named Glass cannot be ruled out by web search.

---

## PART B-redirected: Three companies with detailed published internal agent-platform builds

### Takeaway
**Uber is the closest structural analogue to the benchmark solution** — it has an explicit layered platform with a governed gateway, a linted/reviewed skills registry, continuous skill evals, and a deliberate draft-PR-before-CI human gate. **Stripe (Kai)** is the closest analogue to the benchmark's consumer layer and has the most honest published account of **agent sprawl** as a failure mode. **Shopify (Aquifer/River)** has the cleanest architectural separation (harness outside the sandbox) and the most radical transparency default (public channels only, no DMs). **Block** contributes the only published adversarial red-team of an internal agent.

### Cited Findings — UBER (strongest analogue)
Source caveat: the detailed account below is a **Port blog summary of a talk by Uber engineers Uday Kiran Medisetty and Adam Huda** — secondhand, not Uber's own blog — [Port newsletter](https://newsletter.port.io/p/how-uber-built-a-software-factory). Uber's own primary posts exist (e.g. [Uber, "Solving the Identity Crisis for AI Agents"](https://www.uber.com/us/en/blog/solving-the-agent-identity-crisis/)) but were not fetched.

**Architecture layers:**
- **Context graph** — organizational knowledge in one linked store, **~40 million entries across 150 node and edge kinds**
- **Skills registry** — reusable agent instructions, **with automated lint and review**
- **MCP gateway** — a governed entry point for internal APIs and SaaS tools
- **LLM gateway** — every model call, internal and external, passes through it
- **Balloon pods** — pre-provisioned environments with repos snapshotted and code search indexed
- **Cortana** — the assistant surface, reachable from Slack, CLI and web
- **Workflows on top** — spec-to-PR, validation loops, self-healing CI, maintenance loops

**LLM gateway (the governance chokepoint):**
- Checks run **in order: identity and auth → PII stripping (more than 20 kinds) → an "AI guard"**
- The **AI guard uses five smaller models** for safety and policy
- **Latency budget under 100 ms**
- **Every call is tagged to a project, user, and team**
- Volume: **100M+ model requests/day across 800+ projects**

**MCP gateway:** an automated crawler turns internal APIs into agent-ready tools with **one config change**; SaaS tools (Google, Slack, Jira) go through the same gateway, which handles login. Token reduction came in stages — one discovery tool instead of many, compact responses, on-the-fly scripts for heavy cases. Result: **1,000+ tools reachable, 40%+ lower token usage.**

**Governance and human gates:**
- **Minion** (Uber's coding agent) **stops at a draft PR and does not push to CI, so a human decides before shared CI runs**
- **Maintenance loops are centrally managed, run Sunday when CI has spare capacity, and cap how many diffs land per engineer**
- **Reviewers see a PR table of passed checks, including screenshots**
- Pre-CI checks: static analysis, visual validation against designs, integration tests in staging
- **Code review is split between a smaller model on the local machine and a larger model in CI**
- Governance of model calls, spend attribution and PII redaction all happen at the LLM gateway

**Evaluation:** skills get **usage traces and continuous evals, with results sent back to skill authors**. Uber compared tasks run with and without the context graph and saw large drops in tokens, turns and latency (no exact figures given). Maintenance results (comments, merges) feed back into skill improvement.

**Who builds:** engineers write skills into the shared registry; teams personalize Cortana with their own skills and prompts. The article **does not describe a formal process for approving new agents**.

**Metrics (all as stated in the Port article, relaying Uber's talk):**
- **70%+ of PRs come from local or cloud agents**; **lines of code per engineer doubled year over year** (article subtitle)
- Skills registry: **2,500 skills, 20,000+ skill runs/day**
- Cortana: **300 team-specific versions in one month, 20,000+ sessions/day**
- **250+ automated migrations**
- Separately: Uber's Developer Platform Team built agents on **LangGraph** that it estimates **saved 21,000 developer hours** — [ShiftMag](https://shiftmag.dev/how-uber-engineers-use-ai-agents-8617/); [TMCnet](https://blog.tmcnet.com/blog/rich-tehrani/ai/how-uber-built-ai-agents-that-saved-21000-developer-hours.html)
- Uber's CTO posted on LinkedIn that **1,800 code changes per week are written entirely by Uber's internal background coding agent** — [per search summary](https://newsletter.port.io/p/how-uber-built-a-software-factory). Not independently verified.
- Uber's internal agent platform was built in **early 2025** and lets teams compose, deploy and operate production agents; agents can be written in **Python with an internal SDK or built through a no-code UI** — [per search summary](https://newsletter.port.io/p/how-uber-built-a-software-factory)

### Cited Findings — STRIPE (Kai)
All from Stripe's own post unless noted — [Stripe, "Meet Stripe's Knowledge AI Platform"](https://stripe.dev/blog/meet-stripes-knowledge-ai-platform):
- **Three layers:** (1) **surface-agnostic APIs** — "the agent is a service, not an application"; web app, Slack, and embedded Chrome-extension experiences inside internal tools are all views into one shared service. (2) **Agent Studio** — a control plane where domain owners build, test and monitor skills, custom agents and tool selections, with usage and quality signals per asset. (3) **Execution environment** — shared primitives (agent harness, sandbox, workflow orchestration, access control) **deliberately shared with Stripe's product-facing agents**.
- **Harness:** built on **LangChain's deepagents**, running on **Kubernetes**. Each session gets a secure sandbox and a multi-tenant virtual filesystem; a separate secure code-execution sandbox handles analytics. The harness holds state across long sessions — **one reached 932 turns**.
- **Scale of tooling:** Kai connects to **more than 1,000 skills and tools**, with the harness selecting the right ones per task (a hybrid RAG/LLM selection approach is promised in a follow-up post).
- **Access control — the one explicit isolation rule published:** **unrelated customer contexts cannot be combined in one session even if the user is authorized for both.** The boundary is based on **what a task should view in its context, not only on the user's token.**
- **Who builds:** domain teams (GTM, Finance, Legal, Data Science) build and govern their own skills and agents in Agent Studio; the platform team maintains shared infrastructure.
- **The sprawl failure mode (most valuable negative finding):** Stripe's earlier **NoCode Agent Builder** let anyone build workflow agents and produced **over 4,000 workflow-specific agents**. Teams wrote conceptually similar prompts of varying quality, and the proliferation of micro-agents became **hard to monitor and maintain**. Kai was built partly in response. Stripe also notes that for non-engineers, **the terminal, data access, and security components were significant barriers** — which is why Stripe gave every employee one shared agent rather than sending non-engineers to developer tools.
- **Evaluation:** little detail. Agent Studio surfaces usage and quality signals per asset. A **planned reflection loop** would let Kai review skill traces, propose improvements, test them, and **submit changes for owner review**.
- **Surfaces:** web app (all employees from Day 0), Slack, embedded in internal tools.
- **Self-reported metrics:** **83% of employees are weekly active users**, including nearly all of GTM; GTM new hires use Kai **2.7x** more than others in their cohort; AEs in Kai-using weeks vs. weeks without reportedly produce **2x sales activity, 17% more opportunities, 26% more revenue opportunities, 39% more closed deals**; **~25,000 hours/year** shifted from administrative to revenue-generating work; **5,000+ daily sessions** focused on data analysis.
- **Audit (compliance context):** in financial compliance workflows Stripe logs each run — "the entire agent log is retrievable for each run historically," with every agent action, decision and rationale documented — [AWS ML blog, "Production-grade AI agents for financial compliance: Lessons from Stripe"](https://aws.amazon.com/blogs/machine-learning/production-grade-ai-agents-for-financial-compliance-lessons-from-stripe/)
- Built on Deep Agents **in one week**, per LangChain — [LangChain](https://www.langchain.com/blog/how-stripe-built-their-knowledge-ai-platform-on-deep-agents)
- **Caution:** a secondary Medium post claims Stripe's coding agents merge ~1,000 PRs weekly and that "the isolation is the permission system." **Unverified secondary source — do not rely on it** — [Medium](https://medium.com/@oracle_43885/how-stripe-built-secure-unattended-ai-agents-merging-1-000-pull-requests-weekly-1ff42f3fe550)

### Cited Findings — SHOPIFY (Aquifer / River)
All from Shopify's own post — [Shopify Engineering, "Under the River"](https://shopify.engineering/under-the-river):
- **Aquifer** is the platform; **River**, the Slack-native agent, is **one profile** built on it.
- **Session** is the durable identity and canonical record: an **append-only event log backed by Postgres**, so conversation state survives process and machine failures.
- **Harness** is the agent loop — reads session history, calls the model, emits tool intents — and is **cheap to recreate and disposable**.
- **Sandbox** is where code runs (filesystem, shell, repo access for bash, edits, builds, tests); disposable, sometimes warm, often fresh.
- **Session cells** are ephemeral processes running the Go runtime and harness together; an idle cell exits and the next interaction starts a new cell, possibly on a different host, **with the same session identity**.
- **Key architectural stance: the harness runs OUTSIDE the sandbox.** Shopify cites three reasons — **safety** (the agent loop is outside the code's blast radius), **replaceability** (models/runtimes can change without touching the sandbox), and **observability** (the decision stream is in one place).
- **Profiles are data, not code:** a profile is a system prompt, skills, extensions, **sandbox policy**, and model defaults. Profiles are **built with Nix and shipped as bundles**. Examples: River, PR review, and "Vanilla" (headless). Stated goal: **"a new agent costs a new profile, not a new platform."**
- **Three consumer modes** share the same session model, sandbox plane and gateway: **Interactive** (River), **Automation** (e.g. PR review, woken by external systems), **Job** (ephemeral CI or batch).
- **Governance — the standout default:** **River works only in public Slack channels, with no DMs.** Conversations become public transcripts, **open by default to Shopify employees.**
- **Evaluation:** not described directly; usage patterns from the transcript corpus are fed back into River's skills, prompts and defaults **without model retraining**.
- **Self-reported metrics (30-day window):** **59,918 River sessions across 5,170 Slack channels**; **7,000+ people involved** (~1,200 more than in early May); **3,536 River-coauthored PRs merged**; **median session 19 minutes and 50 tool calls**; **about one in eight merged Shopify PRs coauthored by River**.
- Shopify's ML infrastructure team is described as small and existing to **remove friction rather than dictate how teams use AI** — [Bessemer, "Inside Shopify's AI-first engineering playbook"](https://www.bvp.com/atlas/inside-shopifys-ai-first-engineering-playbook)

### Cited Findings — BLOCK (goose red-team; governance-by-adversary)
All from Block's own post — [Block Engineering, "How We Red-Teamed Our Own AI Agent"](https://engineering.block.xyz/blog/how-we-red-teamed-our-own-ai-agent-):
- **goose** is Block's open-source AI agent (now under the Agentic AI Foundation), extended via MCP.
- **Operation Pale Fire** tested whether goose could be used to compromise Block employees.
- **Calendar vector:** invites from external domains could land on employees' primary work calendars via the Google Calendar API; a Google Calendar MCP would then ingest the invite text when a user asked about their day.
- **Hidden instructions:** prompt injections encoded in **zero-width Unicode characters**, which goose did not filter at the time, so victims could not see them.
- **Payload:** injected instructions led goose to run its **developer shell tool** to fetch an infostealer modeled on real malware.
- **Results:** the calendar phase was rate-limited and produced no successful runs; a shared-recipe phase (using a Google Meet link for legitimacy) reached the server but failed on a typo; a final phase **posing as a bug report to the goose developers succeeded when an employee ran the recipe.**
- **Detection:** Block's Detection and Response Team identified and contained the simulated threat.
- **Guardrails added:** external invites appear on the primary calendar only if the sender is known or previously interacted with, otherwise requiring acknowledgment; **goose now displays the instructions a recipe loads**; **zero-width characters are stripped** when content loads; an initial **prompt-injection detector** has been merged.
- **Published guidance:** treat AI output like untrusted user input; **do not rely on the AI for access control — enforce authorization outside it**; sanitize every input source including calendar entries and documents; monitor behavior since signature-based detection may miss AI-specific attacks; plan incident response for AI compromise; red-team regularly with AI-specific scenarios.

### Inferences
- Three of four companies converged on the **same three-layer shape** as the benchmark: a platform/harness layer, a profile-or-skill authoring layer owned by domain teams, and employee-facing surfaces. The benchmark's structure is validated by convergent evolution, not novel.
- But all four converged on **free-form chat for employees** (Slack/web). **None of them restricts consumers to structured menus and forms.** This is the benchmark's sharpest divergence from industry practice — and, given Stripe's 4,000-agent sprawl and Ramp's negative-skill ablation, it is arguably the better-evidenced design, not the more conservative one.
- Uber's **gateway-as-chokepoint** is the architecture most capable of expressing the benchmark's declarative guardrails and deny-wins resolution: if every model call must pass identity → PII stripping → policy models, policy can be centrally enforced. The benchmark's permission model would plug in naturally there.
- Block's explicit "do not rely on the AI for access control — enforce authorization outside it" is the **clearest published statement of the principle the benchmark's permission layer implements.** It is the single best external endorsement available for that design choice.
- Shopify's **harness-outside-the-sandbox** split and the benchmark's **Orchestrator-never-writes-production-code** rule are the same principle applied at different layers: keep the deciding component outside the blast radius of the acting component.
- Shopify's **public-channels-only** rule is a cheap, powerful governance primitive the benchmark does not have. It makes every agent interaction auditable by social default rather than by mechanism.

### Gaps
- Uber's figures are all secondhand from a conference talk via a vendor blog. **They need verification against Uber's own engineering blog before being cited as fact.**
- No company published defect rates, revert rates, or incidents attributable to agent-written code. Across all five companies (Ramp, Uber, Stripe, Shopify, Block), **the quality-cost of AI-authored code is entirely undisclosed.**
- LinkedIn: I found **no** LinkedIn engineering post about an internal agent platform. Klarna, Duolingo, Zapier, Intercom, Airbnb were not researched — budget went to the three with confirmed primary sources.
- Stripe and Shopify both omit permission-model detail. Stripe publishes one isolation rule; Shopify publishes one channel rule. Neither describes a general authorization model.

---

## WHAT THESE COMPANIES DO THAT THE BENCHMARK DOES NOT

1. **Cost governance as a first-class control plane.** Ramp Router selects a model per request; Glass projects carry **live cost meters with user-set pre-emptive limits**; Ramp built a real-time AI spend pipeline and published online-learning routing. Uber tags **every model call to a project, user and team** across 100M+ requests/day. The benchmark has **no cost layer at all** — no per-request routing, no budget guardrail, no spend attribution. Ramp's entire Glass product exists because a $1.5M token week was a governance failure the benchmark's guardrails would not have caught. **This is the benchmark's largest unaddressed gap.**

2. **A governed gateway as a single enforcement chokepoint.** Uber routes every internal and external model call through an LLM gateway performing ordered identity/auth → PII stripping (20+ kinds) → a five-model AI guard, inside a sub-100ms budget, plus an MCP gateway exposing 1,000+ tools with 40%+ token reduction. The benchmark's guardrails are declarative config; Uber's are an enforcing network hop that cannot be bypassed. Declarative config is only as strong as the code that reads it.

3. **Rigorous probabilistic evaluation with published negative results.** Ramp's Stack Benchmark: 8 worlds, 237 tasks, 3,469 accountant-written criteria, 5 runs per task, Pass@1/Pass@5/**Pass^5**, roll-forward worlds testing memory contamination — and the finding that **only 2 of their skills were net-positive, the rest negative**, plus memory that improved one task 0%→100% while degrading another 75%→25%. Uber runs **continuous evals on skills with results routed back to skill authors**. The benchmark's verification is deterministic gating, which proves a change is safe but says nothing about whether an agent is any good. **Deterministic gating and probabilistic eval are not substitutes, and the benchmark only has one.**

4. **Automated quality control on the authoring layer.** Uber's skills registry has **automated lint and review**; Stripe's Agent Studio surfaces per-asset usage and quality signals and plans a reflection loop that proposes skill improvements and submits them for owner review; Shopify ships profiles as Nix-built bundles. The benchmark governs *what agents may access* and *how code is verified*, but not *whether a given agent/skill is still earning its place*. Ramp's ablation shows that gap has teeth.

5. **Adversarial security testing of the agent itself.** Block's Operation Pale Fire red-teamed goose end to end — zero-width Unicode prompt injection via calendar invites leading to shell-tool infostealer execution — and shipped concrete mitigations (zero-width stripping, recipe instruction transparency, external-invite gating, a prompt-injection detector). The benchmark's refuter is an adversary against *review findings*, not against *the platform*. **Nobody is attacking the benchmark's context layer.**

6. **Verification against live production reality, not just tests.** Inspect runs tests but also **reviews telemetry, queries feature flags, visually verifies frontend changes with screenshots, and produces live previews**, integrating Sentry, Datadog, LaunchDarkly, Braintrust and Buildkite. Uber's pre-CI checks include **visual validation against designs** and staging integration tests, and reviewers get a PR table of passed checks including screenshots. The benchmark's deterministic checks are stronger epistemically but narrower in surface.

7. **Operating-scale controls the benchmark has not needed yet.** Uber caps **how many agent diffs land per engineer** and runs maintenance loops **on Sundays when CI has spare capacity**. These are throughput and reviewer-fatigue controls — a real failure mode once agents author the majority of PRs, which the benchmark's single-flag release model does not address.

8. **Transparency-by-default as a governance primitive.** River operates **only in public Slack channels, no DMs**, making every transcript employee-readable by default. Stripe retains full retrievable agent logs with action, decision and rationale for compliance runs. The benchmark has per-result provenance and a grant audit trail, but no default-public interaction record.

9. **Honest, documented failure of the obvious design.** Stripe's NoCode Agent Builder produced **4,000+ micro-agents** of varying prompt quality that became unmonitorable — a documented, named failure mode of exactly the "let everyone build agents" approach. Ramp documented its own skills being net-negative. The benchmark has no published failure record of its own, which is a gap in evidence rather than in design.

10. **Productization as validation.** Ramp turned Glass into a product with external early access (13 Oct 2026) and a 350+ skill marketplace (Dojo), Git-backed with version history. Block open-sourced goose into a foundation. The benchmark has not been pressure-tested by anyone outside its own organization.

---

## WHAT THE BENCHMARK DOES THAT THEY DO NOT

1. **An explicit, centrally-resolved permission model.** Nothing in the public record from Ramp, Uber, Stripe, Shopify or Block describes a star-schema permission model with **deny-wins resolution**. Stripe publishes exactly **one** isolation rule (unrelated customer contexts can't be combined in a session even if the user is authorized for both). Shopify publishes exactly **one** channel rule. Ramp's model is **delegation** — "agents acting for users" — which inherits existing ACLs but cannot express "this agent may never see X regardless of who asks." Block's own published guidance says **"do not rely on the AI for access control — enforce authorization outside it,"** which is precisely what the benchmark's layer does and what nobody has published building. **This is the benchmark's strongest differentiator.**

2. **"Denied" vs. "could not determine" as distinct outcomes, so config faults fail loud.** No company publishes anything like this. The closest analogues are far narrower: Inspect's Slack repo classifier has an explicit **"unknown" option that asks the user** instead of guessing, and OCA has a **detour hook** forcing a production cross-check before posting plus a prompt instruction to ask whether a query window is silently excluding data. Both are ask-rather-than-guess instincts at single decision points. **None is a systemic guarantee that an indeterminate authorization result cannot be silently read as a permit.**

3. **An immutable grant audit trail.** Stripe retains full agent run logs for compliance, and Uber tags every model call to project/user/team — but those are **activity** records. Nobody publishes an immutable record of **authorization grants** themselves. The distinction matters: activity logs tell you what happened; grant trails tell you what was ever permitted and by whom.

4. **Mechanically-computed risk tiering from changed file paths.** Every company's human gate is uniform. Uber's Minion always stops at a draft PR. Ramp always requires human review. OCA always hands to Inspect for human review. **No one varies review intensity by what changed.** Uber's closest analogue is capping diffs per engineer — a volume control, not a risk control. The benchmark's mechanical tier derivation means the gate cannot be argued down, which is both unique and, in a regulated environment, defensible.

5. **An adversarial refuter that tries to disprove each blocking review finding.** Uber splits review between a small local model and a large CI model; Stripe plans a reflection loop. **Neither is adversarial.** Nobody publishes a structured attempt to *falsify* a blocking finding before it blocks. This directly attacks reviewer-fatigue and false-positive-driven gate erosion — the failure mode Uber's per-engineer diff cap implies they are already feeling.

6. **An explicit prohibition on LLM self-review.** Ramp's Inspect is the opposite case: the agent verifies **its own** work using real tools and telemetry, which Ramp presents as the core design win. Uber's CI review is a larger model checking a smaller model's work — model-checking-model, not deterministic. **No company publishes a rule that an LLM may not be the verifier of record.** Ramp's own benchmark post does not even state whether its grading is human, rule-based, or LLM-judged, which illustrates how little this boundary is treated as load-bearing elsewhere.

7. **"Unrunnable check reports as SKIPPED, never passed."** Found nowhere. Reviewers at Uber see a table of **passed** checks, with no published treatment of checks that could not run. This is a small rule with outsized blast radius — a check that silently passes when it cannot execute is how a governed pipeline becomes decorative.

8. **Merge-deploys-dark with a separate human-attested flag flip as the release.** Ramp uses LaunchDarkly and Inspect queries feature flags during verification, and Uber's Minion stops before CI — but **nobody publishes a formal separation of merge from release with a distinct human attestation at the flip.** Across all five companies the merge *is* the ship event. This is the benchmark's cleanest structural safety property and it has no published peer.

9. **Structured menus and forms for consumers instead of free-form chat.** Ramp Glass, Stripe Kai, Shopify River, and Uber Cortana are **all** free-form chat (Slack, web, extensions). The benchmark is alone in constraining the consumer surface. The evidence favors the benchmark here rather than merely differentiating it: Stripe's 4,000-agent sprawl came from unconstrained authoring, and Ramp measured most of its own free-text skills as net-negative. A menu is a schema, and a schema is testable.

10. **An approved-knowledge-source discipline as a stated control.** Glass connects to Linear, Notion, Google, Slack and Gong and lets employees freely edit what it knows (6,500+ edits by 323 people) — with **no published review of those edits**. Uber's context graph has ~40M entries. The benchmark's curated-source constraint is the direct remedy for the failure Ramp itself measured: **period-specific memories degraded a task from 75% to 25%**. Ramp found the problem and responded with better memory *heuristics* (step-oriented memory); the benchmark responds with *admission control*. The benchmark's answer is the more auditable one.

11. **A named, protocolized builder cohort.** Everyone has builders — Uber engineers write skills, Stripe domain teams own Agent Studio assets, Ramp PMs and designers use Inspect, Glass skills come from CX and sales. **Nobody publishes a defined protocol governing how the main session behaves** (scopes but never writes production code, computes a tier, routes to specialists). Shopify's "a new agent costs a new profile, not a new platform" is the nearest in spirit, but it is a packaging claim, not a behavioral contract on the orchestrating session.

### Honest tradeoff on this comparison
The benchmark is **stronger on authorization, fail-loud semantics, and release separation**, and **weaker on cost governance, enforcement chokepoints, and measuring whether its agents are actually good**. The three biggest additions suggested by this research, in order: **(1) a cost/spend control plane** — Ramp's entire Glass product originated in a cost failure the benchmark cannot detect; **(2) a probabilistic eval harness with ablation** — Ramp proved most skills are net-negative, and the benchmark currently has no way to discover that about itself; **(3) adversarial red-teaming of the context layer** — Block showed zero-width Unicode injection through a calendar invite reaching a shell tool, and the benchmark's refuter attacks findings, not the platform.

One further caution worth flagging: Ramp Glass's external launch means the "we built it ourselves" position is becoming purchasable. The durable differentiators are the ones in the list above that no vendor is selling — deny-wins resolution, SKIPPED-not-passed, and merge-dark-with-attested-flip — not the three-layer shape, which four companies arrived at independently.

---
---

# ROUND 2 — GAP CLOSURE

**Research date: 2026-10-22 (same session, second pass).**

**Retrieval note, and a correction to Round 1:** the Round 1 fetch failures on builders.ramp.com were **my wrong URL slugs, not fetcher blocking**. builders.ramp.com renders fine for fetchers. Correct slugs are `/post/agent-identity-introduction` and `/post/100-vulnerabilities-patched-with-0-humans`. Posts 1 and 2 were therefore retrieved **in full from Ramp's primary source**. Post 3 (the OpenAI case study) **could not be retrieved** — see item 3.

---

## R2-Q1 (HIGHEST): Does Ramp publish a centrally-resolved permission model with a DENY primitive?

### Takeaway
**No. Plainly: Ramp has not published a deny-wins equivalent, and the benchmark's strongest differentiator is not falsified.** Ramp's published model is **pure delegation** — "On Behalf Of User" (OBOU), where agent authority "stems purely from the sponsor user's existing role and capabilities." There is **no DENY primitive, no central decision service described, no immutable grant ledger, and no treatment of denied-vs-indeterminate or fail-open-vs-fail-closed.** What Ramp does have is a genuinely good *credential* design (OAuth2-PKCE, non-secret Agent Keys, short-lived JWTs, expiry, instant revocation) — which is a different problem from authorization resolution.

### Cited Findings
From Ramp's primary post — [Ramp, "Agentic identity: modeling agents to keep users in control"](https://builders.ramp.com/post/agent-identity-introduction):

**1. Central resolution and DENY — both absent**
- Agent access "stems purely from the sponsor user's existing role and capabilities."
- Scopes are "always bounded by the sponsor's existing role and capabilities."
- "Agent Key re-validation during refresh ensures that the access token stays within its bounds."
- **Not specified anywhere in the post:** a DENY primitive, or whether authorization runs through one central decision service. The post does not detail the scope vocabulary or how scopes are evaluated per request.

**2. It is delegation, explicitly and by design**
- "In OBOU, the agent is always tied to a human sponsor and acts on their behalf."
- Ramp's stated rationale for starting with OBOU rather than standalone agents: it **keeps human accountability in place, simplifies compliance, and reuses existing audit tooling** — [per search summary of the post](https://daily.dev/posts/agentic-identity-modeling-agents-to-keep-users-in-control-aq7csh0p7)
- Standalone agents (SA) are discussed as a **future option**, not the initial version.
- **Important scope warning:** "agents acting on behalf of admins can take actions on behalf of the entire business." Delegation inherits the sponsor's blast radius, including an admin's.

**3. Immutable grant record — not described**
- The post mentions audit logging, with agent actions attributed to **both the agent and the sponsor**, and notifications on key creation, expiration and revocation.
- It **does not say whether grants are stored in an immutable ledger separate from activity logs.** This is activity attribution, not a grant trail.

**4. Denied vs. could not determine; fail-open vs fail-closed — not addressed at all**
- The post does not describe error handling, timeouts, or default behavior when a permission check cannot complete.

**5. Caching, token lifetime, revocation propagation**
- Access tokens are "a simple JWT," described as "short-lived." Illustrative framing: "A leaked access token is bad for an hour (and can be revoked instantly)." **Exact lifetime is not stated.**
- Lifetimes are "defined by parameters set on the Agent Key, plus some Ramp-enforced minimums." **The minimums are not given.**
- Refresh uses the standard OAuth2 refresh flow with key re-validation.
- Revocation is described as **immediate for access tokens**. The post **does not explain caching or how revocation propagates across services.**
- Renewing a key keeps its value unchanged, so stored credentials keep working.

**6. Agent Keys and PKCE (the genuinely strong part)**
- Agent Key = "A unique, named key, tying the agent to a specific user and business on Ramp." It is **not used to call product APIs.**
- "Agent Keys do not need to be controlled like API keys" — they are "OAuth Key IDs for PKCE under the hood," so **a leaked key alone grants no access.**
- Flow: user authorizes a client (CLI, MCP, etc.) and selects or creates an Agent Key → client receives an authorization code tied to that key → exchanges it for access and refresh tokens → calls APIs while the session is active.
- **Every key is created with an expiry date.** Sponsors get a reminder ~14 days before expiry, with more as the date approaches.

From Ramp's customer-facing agent docs — [agents.ramp.com, "Identity"](https://agents.ramp.com/docs/guides/identity):
- **Acting on behalf of a user (available today):** MCP and CLI actions run as the Ramp user who completed OAuth, with that user's visibility and permissions. Admins control which users can access MCP connectors on the Integrations page.
- **Standalone agents (limited early access):** own credentials, permissions "explicitly assigned by an admin," an accountable human owner, separately managed lifecycle.
- Controls for standalone agents: **least privilege** (start minimal, admins grant only what the job requires); **human ownership** (each agent has an accountable Ramp user); **immediate control** (admins can pause access, rotate credentials, or remove the agent); **attribution** (supported activity attributed to the agent, not a person).
- **Approval chains:** adding an agent to an approval workflow **does not grant authority** — the agent also needs the permissions to review or approve. (A small but real separation-of-concerns primitive.)
- Setup: narrowest default role or a custom role (requires a role admin plus `users:read`/`users:write`); then Company → Agents, name it, assign the role, select an active owner (requires `agents:write`); Ramp returns a Client ID and a **show-once** Client secret.
- **Explicitly not covered on the page:** deny rules; detailed permission scoping beyond least privilege and role assignment; an audit trail of grants; behavior when permissions are indeterminate; revocation mechanics beyond pause/remove/rotate; the rotation procedure itself.

Third-party framing (consistent, adds nothing contradictory):
- Okta's case study frames Ramp's principle as **"every autonomous action can be traced back to a person"** — [Okta newsroom](https://www.okta.com/en-nl/newsroom/articles/yahoo-and-ramp-use-identity-to-securely-scale-their-agentic-workforce/)
- LangChain's case study on Ramp's Tour Guide agent notes users can see all agent actions and **interrupt or take control at any point** — [LangChain](https://www.langchain.com/breakoutagents/ramp)

### Inferences
- Ramp and the benchmark are solving **two different problems that are easy to confuse**. Ramp solved *agent credential and attribution* — how an agent proves who it is acting for, with a non-secret key ID, short-lived tokens and traceability. The benchmark solved *authorization resolution* — what may be reached, with deny beating allow and indeterminacy failing loud. Ramp's design is better than the benchmark's on credential hygiene; the benchmark's is better than Ramp's on access decisions. **Neither covers the other.**
- Delegation has a structural ceiling the benchmark does not: because authority "stems purely from the sponsor's existing role," **a sponsored agent can reach anything its sponsor can reach**, and Ramp states plainly that an admin-sponsored agent can act for the entire business. There is no published way to say "no agent may ever touch X, even an admin's." That is exactly the expressiveness a deny primitive buys.
- Ramp's "reuses existing audit tooling" rationale is a real engineering advantage and a real governance limitation at once: inheriting the human audit trail is cheap, but it means grants are only visible as *activity after the fact*, not as *standing permissions*.
- **Confidence that this is not merely unpublished:** moderate-to-high. Ramp published an architecture post specifically about agent authority and a customer-facing identity doc, and neither mentions deny semantics while both go into detail on adjacent mechanics. Absence across two purpose-built documents is meaningful evidence, though not proof that nothing internal exists.

### Gaps
- Exact access-token lifetime and Ramp-enforced minimums are not published.
- Revocation propagation across services and any caching behavior are not published — which matters, because "revoked instantly" is only true if no downstream service caches a decision.
- Whether Ramp's *internal* platform (Laminar/Inspect/Glass) uses this same OBOU model, or something else, is **not stated**. The agent-identity post and the agents.ramp.com docs are both oriented to Ramp's customer-facing agent platform. Do not assume the internal platform shares it.

---

## R2-Q2: Guardrails on Ramp's zero-human-in-the-loop security fixing

### Takeaway
The "0 humans" title is **marketing shorthand that Ramp's own body text immediately qualifies**: the work ran "without a human in the loop (**until PR review**)," and a human "took over to review the patch and land the code." The real finding is far more valuable than the headline — Ramp independently built **two of the benchmark's signature mechanisms**: an **adversarial critic agent** that rejects findings (the refuter), and a **three-state detector output of VULNERABLE / SECURE / UNCERTAIN** (the denied-vs-could-not-determine distinction). Verification was **deterministic**: a validator agent writes an integration test that passes only if the endpoint is secure.

### Cited Findings
All from Ramp's primary post — [Ramp, "We proactively fixed ~100 security issues in 6 days with 0 humans"](https://builders.ramp.com/post/100-vulnerabilities-patched-with-0-humans):

**Pipeline structure**
- **Detectors:** specialized agents, **one per vulnerability class**, run in parallel under a coordinator. Their skills combined a class definition, analyst steps, and codebase examples. **Output was labeled "VULNERABLE," "SECURE," or "UNCERTAIN."**
- **Managers / validators:** **adversarial agents that critiqued findings**, using code-reading skills only. Ramp notes future versions may let them write and run code.
- **Fixer:** an internal coding agent (**an early version of Ramp Inspect**) given codebase context, style guidance, and common pitfalls. It opened PRs using a template with a **finding summary, reproduction steps, before/after test results, and challenges.**

**Guardrails on the autonomous mode**
- The only stated human checkpoint is PR review: the work ran **"without a human in the loop (until PR review)."**
- **Adversarial critique as a filter:** managers **rejected 40% of initial proposals** in a sample test, and **a human later confirmed those rejections were false positives** — i.e. the refuter-equivalent was measured and validated.
- **Test-based filtering:** the validator's test check "captured nearly all of the false positive findings produced earlier in the triage pipeline."
- **Scope instruction to detectors:** do not report "defense in depth" findings that are "mitigated at the top of the stack."

**Eligible vs excluded change classes**
- **Ramp does not define eligible or excluded change classes.** The work is described as patching security issues across the backend, with no allowed-category list.
- The only explicit exclusion is the defense-in-depth detector instruction above, which **filters findings rather than restricting what changes may be made.**
- Some issues were high severity; **no severity breakdown is given.**

**Verification before merge**
- The validator wrote an integration test that **"would pass only if the endpoint was secure."** A failing test confirmed the finding; a test that already passed marked it a **false positive**.
- Ramp notes that **testing against a live deployment proved too hard** for vulnerabilities with complex preconditions, which is why they moved to test-reproduction.
- The fixer used **test-driven development against that validator test** and opened a PR once the test passed. The test then serves as a **regression test**.
- **No other pre-merge checks are described** — no full test suites, no security re-scan, no canary.

**Staging, flags, dark deploys**
- **None mentioned.** No staging, no feature flags, no dark launch. A human "took over to review the patch and land the code," with **no rollout detail at all.**

**Metrics**
- Nearly **100 issues** found, validated and fixed.
- Issues were **novel** — not previously found by pentesting, bug bounty, static analysis, or **10+ vendor trials.**
- All patched **within a week of discovery.**
- Effort: **a four-hour hackathon plus under a week of work by one team member.**
- Managers **rejected 40%** of initial proposals in sample testing.

**Correction to a Round 1 search summary:** a Round 1 search attributed **Agentic Security Review, Vuln Hunter, Anybump and Invariant Sentinel** to Ramp. That is **wrong** — per tl;dr sec, those are **Cursor's** security automations, described in the same newsletter issue alongside Ramp's pipeline — [tl;dr sec #320](https://tldrsec.com/p/tldr-sec-320). **Do not attribute them to Ramp.** (For reference, Cursor's Agentic Security Review blocks PRs with security issues and over two months ran on thousands of PRs, keeping hundreds of issues from reaching production; Anybump patches dependencies using reachability analysis and opens PRs once tests pass; Invariant Sentinel checks daily for drift from security and compliance properties. All Cursor, not Ramp.)

### Inferences
- **This is the single most important finding of Round 2 for positioning.** Two benchmark mechanisms I reported in Round 1 as having "no published peer" **do have one, inside Ramp**, at narrower scope:
  - The **adversarial refuter** — Ramp's manager agents critique findings adversarially and rejected 40%, with human confirmation that the rejections were correct. The benchmark's refuter operates on *blocking review findings*; Ramp's operates on *vulnerability findings*. Same mechanism, same motivation (false-positive suppression before a human is involved), and Ramp has **measured** it where the benchmark has not.
  - **Denied vs could not determine** — Ramp's detectors emit an explicit **UNCERTAIN** third state rather than collapsing to secure/insecure. That is precisely the benchmark's refusal to let indeterminacy read as a permit, applied to detection rather than authorization.
- Restate the Round 1 differentiator claims accordingly: the benchmark's distinction is that these are **platform-wide invariants**, where Ramp's are **features of one pipeline**. That is still a real difference, but it is a difference of scope and generality, not of invention. Claiming invention would be wrong and checkable.
- Ramp's verification here is **genuinely deterministic** and arguably stronger than the benchmark's framing: a test that passes only when the endpoint is secure is a proof obligation, not a check. And it converts each fix into a permanent regression test. The benchmark forbids LLM self-review; Ramp went further in this one pipeline by making the LLM *write the oracle* and then be bound by it.
- **The gap that remains real and large:** Ramp has **no release separation**. No staging, no flags, no dark deploy, no rollback, no post-merge monitoring — a human reviews the PR and lands it, and landing is shipping. The benchmark's merge-deploys-dark plus separate human-attested flag flip has **no peer in this post**, and this was Ramp's most autonomous pipeline. That differentiator survives Round 2 intact.
- **The other gap that survives:** no risk tiering. Ramp applied one uniform gate (human PR review) across ~100 security fixes of varying severity, and explicitly published no severity breakdown. Nothing scaled the gate to the change.

### Gaps
- Severity counts, false-positive rate *after* the manager stage, and how many PRs merged unchanged are all **not stated**.
- Rollout and rollback procedures, and post-merge monitoring: **not stated.**
- Exact tests run before merge beyond the validator test: **not stated.**
- Whether this pipeline was ever promoted from a one-week experiment to standing practice: **not stated.** Treat it as a documented experiment, not a production regime.

---

## R2-Q3: OpenAI case study, "How Ramp engineers accelerate code review with Codex"

### Takeaway
**Could not retrieve.** `openai.com/index/ramp/` returns **HTTP 403 Forbidden** to fetchers, and the one syndicated copy I found (develeap.com) also returns **403**. Per the coordinator's instruction I am not reconstructing it. What I can state with sourcing is limited and comes from search summaries only; **crucially, none of the three things you asked for — precision/recall data, how findings are verified before reaching a human, or reviewer-fatigue mitigation — appeared in any of it.**

### Cited Findings
- The article exists at [openai.com/index/ramp/](https://openai.com/index/ramp/) with that exact title. **Direct fetch: HTTP 403.** Syndicated copy at [develeap.com](https://www.develeap.com/news/how-ramp-engineers-accelerate-code-review-with-codex/): **also HTTP 403.**
- From search summaries only (**not a verified read of the page** — treat as second-hand): Ramp's **AI Developer Experience team** uses Codex with **GPT-5.5** for code review and for building internal agent tooling; reviews "come back in minutes rather than hours"; **Austin Ray**, who leads AI DevEx, calls Codex review an industry-leading standard, says engineers request it by name, and says **it has become a mandatory part of many code review flows**; Ray credits reasoning over the whole codebase for thoroughness human reviewers rarely have time for, and says it catches things he, other engineers, and other AI reviewers miss. Ramp also uses Codex to build internal agent tooling including the On-Call Assistant.
  - Note: Austin Ray is a **co-author of Ramp's OCA post** (9 Sep 2026, with Richard Marmorstein) per [the blog feed](https://builders.ramp.com/feed.xml) — the attribution is internally consistent.
- **Unverified figure, do not use:** a low-quality blog reports a drop "from an average of 3 hours to just 7 minutes for 80% of pull requests" — [Dakik Studio](https://dakik.co.uk/blog/breaking-news-ai-code-review-speeds-up-ramp-s-development-1779309635). **This number does not appear in any summary of the OpenAI text and I could not verify it. Treat as fabricated-until-proven.**
- **Explicitly not found anywhere:** precision/recall figures, false-positive rates, any description of how Codex findings are verified before reaching a human, and any reviewer-fatigue mitigation.

### Inferences
- The one substantive governance signal, if the summaries are accurate, is that **Codex review is "a mandatory part of many code review flows"** — mandatory but, per everything else I found, **uniform**. That is consistent with the pattern across all five companies in Round 1: the gate exists and does not scale to risk.
- A vendor case study is the **weakest possible source** for false-positive data, because publishing it would undercut the vendor. Its absence here is unsurprising and should not be read as evidence Ramp lacks the data.
- **Notable tension worth flagging:** Ramp runs Codex (OpenAI) as a mandatory review layer while Laminar's stated purpose is provider-agnosticism and Ramp Router picks models per job. Either the review layer is a deliberate exception to provider-agnosticism, or the case study predates/sits outside the routing regime. Unresolved.

### Gaps
- **The page itself.** 403 on both the primary URL and the one syndication I found. A browser-based read (the in-app browser renders what WebFetch cannot) would close this; I did not have a path to it within this task.
- No precision/recall, false-positive, or reviewer-fatigue data was found for Ramp's AI code review from any source.

---

## ROUND 2 — REVISIONS TO THE ROUND 1 DIFFERENTIATOR LISTS

**Survives intact, and is now better evidenced:**
- **Centrally-resolved deny-wins permission model.** Ramp's purpose-built agent-identity post and its customer identity docs both describe **pure delegation bounded by the sponsor's role**, with no deny primitive, no central decision service, and the explicit note that admin-sponsored agents can act for the whole business. **This remains the benchmark's strongest differentiator and Round 2 strengthens rather than weakens it.**
- **Immutable grant trail.** Ramp logs agent *actions* attributed to agent and sponsor. No grant ledger. Unchanged.
- **Merge-deploys-dark + separate human-attested flag flip.** Ramp's *most* autonomous pipeline published **no staging, no flags, no dark deploy, no rollback, no post-merge monitoring**. Landing is shipping. **No peer found.**
- **Mechanically-computed risk tier from changed file paths.** ~100 security fixes of varying severity, one uniform human-review gate, no published severity breakdown. Codex review is mandatory but uniform. **No peer found.**
- **SKIPPED-never-passed.** Still found nowhere.

**Must be downgraded from "no published peer" to "benchmark generalizes what Ramp built narrowly":**
- **Adversarial refuter.** Ramp's **manager agents critique findings adversarially and rejected 40% of proposals, human-confirmed as correct rejections.** Benchmark's refuter targets blocking review findings platform-wide; Ramp's targeted vulnerability findings in one pipeline. Same mechanism. **Ramp measured theirs; the benchmark has not measured its own.** Do not claim invention.
- **"Denied" vs "could not determine."** Ramp's detectors emit **VULNERABLE / SECURE / UNCERTAIN**. The three-state instinct is published. The benchmark's version is an authorization-layer invariant rather than a detector output — broader and load-bearing, but not novel in kind.

**New item for "what they do that the benchmark does not":**
- **Agent credential design.** Ramp's **non-secret Agent Keys as OAuth2-PKCE key IDs**, short-lived JWTs, mandatory expiry with 14-day sponsor reminders, instant token revocation, dual attribution to agent *and* sponsor, show-once client secrets, and "adding an agent to an approval chain does not grant authority." The benchmark's notes describe *what may be reached* but nothing about *how an agent proves who it acts for, or how that proof expires.* **This is a real, cheap, well-designed gap to close, and Ramp's post is a usable blueprint.**
- **Verification that produces a durable artifact.** Ramp's validator writes a test that passes only when the endpoint is secure, the fixer is bound by it, and **the test becomes a permanent regression test**. The benchmark's deterministic checks gate a change; Ramp's leave the codebase measurably better protected afterward.
