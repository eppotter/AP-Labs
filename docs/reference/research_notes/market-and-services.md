# Market structure, demand signals, and services landscape for enterprise internal AI agent deployment (late 2026)

> Scope note: this file covers market/failure data, the services landscape and pricing, the internal developer platform (IDP) analogue, and commercial packaging. A standing caveat applies throughout: **a large share of the available statistics on this topic are vendor-commissioned or vendor-adjacent surveys with self-selected samples.** Where a figure's provenance is weak I say so inline rather than laundering it.

---

## Q1. Documented failure rate of enterprise AI/GenAI pilots reaching production — what each study actually measured

### Takeaway
The two most-cited numbers (MIT's "95%" and Gartner's "40%") measure completely different things, and neither says "95% of AI projects fail." MIT measured *absence of measurable P&L impact* across a non-random sample of 300 projects; Gartner's 40% is a *June 2025 forward prediction* about agentic project cancellation, not research into outcomes. Both are routinely misquoted.

### Cited Findings

**MIT NANDA — "The GenAI Divide: State of AI in Business 2025" (Project NANDA, MIT Media Lab, August 2025)**
- Three data layers: 150 executive interviews (qualitative, self-reported outcomes), 350 employee surveys on personal/official GenAI tool use, and an analysis of 300 AI projects — the 300-project layer is the source of the 95% figure — [agentmodeai analysis of the GenAI Divide claim](https://agentmodeai.com/the-mit-genai-pilot-failure-claim/)
- The measured claim is **"no measurable P&L impact"** in ~95% of cases, with ~5% of integrated systems "creating significant value" — *not* "the pilot failed." These are documented as different findings — [agentmodeai](https://agentmodeai.com/the-mit-genai-pilot-failure-claim/)
- The 300 projects were **not a random sample**; they were projects NANDA could access directly or via published case material. The report does not claim representativeness, but the citation chain often does — [agentmodeai](https://agentmodeai.com/the-mit-genai-pilot-failure-claim/)
- Documented methodological criticism: most pilots lacked a documented pre-deployment P&L baseline, so "no measurable impact" may reflect **missing measurement rather than failed deployment** — [agentmodeai](https://agentmodeai.com/the-mit-genai-pilot-failure-claim/)
- Documented criticism: a project-level 95% is not an enterprise-level failure rate. An enterprise with 1 success in 20 projects looks like a 5% project-weighted result while still having a working capability — [agentmodeai](https://agentmodeai.com/the-mit-genai-pilot-failure-claim/)
- Fortune (21 Aug 2025 follow-up) noted NANDA has an institutional incentive to frame current methods as underperforming given its focus on newer tooling; Fortune's author found no evidence of deliberate skewing — [agentmodeai](https://agentmodeai.com/the-mit-genai-pilot-failure-claim/)
- **Sample sizes themselves conflict across secondary coverage.** Some sources describe 150 interviews / 350 employee surveys / 300 deployments; others give 52 structured executive interviews / 153 survey responses / 300+ deployments. I could not resolve which the report itself uses — [search synthesis of MIT coverage incl. Yahoo Finance](https://finance.yahoo.com/news/mit-report-95-generative-ai-105412686.html)
- Associated context figure from coverage: US$30–40bn invested; ~5% of custom enterprise AI tools reach production — [Yahoo Finance / MIT report coverage](https://finance.yahoo.com/news/mit-report-95-generative-ai-105412686.html)

**Gartner — agentic AI cancellation prediction (press release dated 25 June 2025)**
- Gartner predicts **over 40% of agentic AI projects will be canceled by end of 2027**, citing escalating costs, unclear business value, or inadequate risk controls — [Gartner press release, 2025-06-25](https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027) (note: the Gartner page returns HTTP 403 to automated fetch; content here is from search-result summaries and secondary coverage, so treat exact wording as unverified)
- Gartner attributes much of the noise to **"agent washing"** — relabeling assistants, RPA and chatbots as agentic — and estimates only **~130 of thousands of agentic AI vendors are real** — [Gartner, via coverage](https://www.forbes.com/sites/robertszczerba/2026/07/07/why-40-of-agentic-ai-projects-may-be-canceled-by-2027/)
- Gartner's analyst position: many use cases positioned as agentic **do not require agentic implementations** — [Gartner, via coverage](https://xmpro.com/gartners-40-agentic-ai-failure-prediction-exposes-a-core-architecture-problem/)
- **Misdating flag:** the 40% figure is a June 2025 prediction. Forbes revisited it 7 July 2026; commentary notes that any 2026 coverage presenting it as fresh research is misdating the source — [Forbes, 2026-07-07](https://www.forbes.com/sites/robertszczerba/2026/07/07/why-40-of-agentic-ai-projects-may-be-canceled-by-2027/)

**Other failure-rate figures (different stages measured — do not blend)**
- **IDC/Lenovo: 88% of AI proofs-of-concept never reach production.** This measures a different stage than MIT's P&L metric and is not the same statistic — [agentmodeai](https://agentmodeai.com/the-mit-genai-pilot-failure-claim/)
- **Gartner (cited secondhand): organizations will abandon 60% of AI projects unsupported by AI-ready data through 2026** — [Digital Applied summary](https://www.digitalapplied.com/blog/ai-agent-scaling-gap-march-2026-pilot-to-production)
- **Zapier survey: 84% of companies have stalled AI pilots**, from a survey of 800+ senior leaders — [Zapier AI pilot survey](https://zapier.com/blog/ai-pilot-survey/)
- VentureBeat Research (June 2026): **half of respondents shipped an agent that passed internal evaluations but then caused a customer-facing failure in the past year** — [VB Pulse coverage](https://pro.edgex.exchange/en-US/news/article/enterprise-ai-agents-governance-gaps-survey)

### Inferences
- The honest, defensible framing for a sales deck is **not** "95% fail." It is: *"the most-cited study found no measurable P&L impact in 95% of a non-random sample of 300 projects — and the most common reason was that nobody set up the measurement in the first place."* That reframing is itself a wedge, because it points at instrumentation and governance rather than model choice.
- Using the headline "95% fail" in positioning material is a credibility risk with any technically literate buyer in late 2026, since the critique of that number is now widely circulated.
- The Gartner "inadequate risk controls" cancellation driver is the single most directly monetizable finding for a governance-framework offering, because it is a named cancellation cause from the analyst firm buyers quote in business cases.

### Gaps
- I could not fetch Gartner's own press release (403) or the original MIT PDF, so exact wording and the authoritative sample sizes for both remain unverified from primary source. A report writer should flag this.
- No single study I found measures "percentage of *agent* deployments reaching production" with transparent methodology. The 67% and 88% figures circulating come from blogs and vendor summaries.

---

## Q2. Named, documented reasons enterprise AI deployments fail — ranked by frequency in the evidence

### Takeaway
No authoritative single ranking exists. Across the available surveys the recurring top causes are (1) integration/infrastructure and data readiness, (2) output quality at production volume, (3) missing monitoring/evaluation, (4) unclear ownership and governance, and (5) underinvested change management. Governance and ownership appear in essentially every list but are rarely ranked first.

### Cited Findings
- **Digital Applied survey of stalled scale-ups** (respondents asked to identify primary blocking factors from a list of 22 potential causes and rank by severity): integration complexity **63%**, output quality at volume **58%**, missing monitoring **54%**, unclear ownership **49%**, thin domain training data **41%**. The source notes all five appear in combination in a majority of stalled organizations, so the categories overlap — [Digital Applied](https://www.digitalapplied.com/blog/ai-agent-scaling-gap-march-2026-pilot-to-production)
- **Zapier (800+ senior leaders):** IT infrastructure, data quality and system integration issues blocked **41%** of stalled pilots; legal and privacy concerns next at **29%** — [Zapier](https://zapier.com/blog/ai-pilot-survey/)
- **Change management underinvestment:** only **37%** of organizations invest significantly in change management alongside AI deployments — [AI Assembly Lines](https://aiassemblylines.com/post/why-ai-pilots-fail-to-scale)
- **Context/data grounding as a live failure cause:** **57%** traced a confident-but-incorrect agent answer in the past six months to missing or inconsistent business context; a majority saw it happen more than once — [VentureBeat Research, June 2026](https://pro.edgex.exchange/en-US/news/article/enterprise-ai-agents-governance-gaps-survey)
- **Evaluation trust collapse:** ~two-thirds either already allow agents to push production changes based only on automated evaluations, or plan to within 12 months — but **only 5% are fully confident in those evaluations** — [VentureBeat Research](https://pro.edgex.exchange/en-US/news/article/enterprise-ai-agents-governance-gaps-survey)
- **Identity/credential hygiene correlates with incidents:** **69%** let at least some agents share credentials. Among firms allowing credential sharing, **63.5% (47/74)** reported a security incident or near-miss; among firms where every agent has a scoped identity, **40.9% (9/22)** — [VentureBeat Research](https://pro.edgex.exchange/en-US/news/article/enterprise-ai-agents-governance-gaps-survey)
- **Cost blindness:** only **44%** rigorously monitor what their AI compute costs and returns; over **80%** of firms running their own GPUs report ≤50% utilization — [VentureBeat Research](https://pro.edgex.exchange/en-US/news/article/enterprise-ai-agents-governance-gaps-survey)
- Weakly-sourced counter-claim to note and *not* rely on: a 2026 blog asserts **83% of pilots stall from underestimated change management** but cites no study — [QueryNow](https://www.querynow.com/blog/ai-pilot-failures-change-management-production-success-434339)

### Inferences
- The scoped-identity-vs-shared-credential incident differential (63.5% vs 40.9%) is the single strongest piece of **quantified evidence that governance mechanics reduce harm**, not just satisfy auditors. The sub-samples are very small (n=74 and n=22), so it is directional, but it is the kind of number a governance-first offering can build a slide around with appropriate caveats.
- The "only 5% fully confident in evaluations" figure sitting next to "two-thirds let evals gate production" is a described, measured gap between the control a buyer relies on and the control they trust. That is the demand signal for deterministic verification.

### Gaps
- I found no peer-reviewed or analyst-house ranked causal study of agent deployment failure. Everything available is survey self-report from vendor-adjacent sources.
- No data on failure rates segmented by company size, which matters for a boutique targeting mid-market.

---

## Q3. Is "agent sprawl" / "shadow AI" a named, measured problem?

### Takeaway
Yes — "agent sprawl" and "shadow AI agents" are now named categories with analyst coverage and board-level framing as of mid-2026, and the inventory/visibility gap is measured repeatedly. But the headline growth numbers are Gartner *projections*, not counts, and much of the surrounding statistics are vendor-sourced.

### Cited Findings
- **Named and board-level:** SAP published "AI Agent Sprawl: Why AI Governance Is Now a Board-Level Issue" (August 2026) — the term is in mainstream enterprise-vendor discourse — [SAP News, Aug 2026](https://news.sap.com/2026/08/agent-sprawl-why-ai-governance-is-now-board-level-issue/)
- **Definition that matters for discovery:** shadow AI agents are autonomous tools/workflows that read files, update records or call APIs without IT approval, and are **built inside already-sanctioned tools**, which makes them invisible to traditional shadow-IT discovery — [BetterCloud](https://www.bettercloud.com/monitor/ai-agents-are-the-new-shadow-it-and-theyre-harder-to-see/)
- **Gartner projection:** 40% of enterprise applications integrated with task-specific AI agents by end of 2026, up from <5% in 2025 — [via Cloud Security Alliance research note](https://labs.cloudsecurityalliance.org/research/csa-research-note-shadow-ai-apps-enterprise-20260530-csa-sty/)
- **Gartner projection (the dramatic one):** average Fortune 500 firm at **>150,000 AI agents in use by 2028, up from fewer than 15 in 2025** — cited by CSA. This is a forecast, not a measurement; treat accordingly — [CSA research note](https://labs.cloudsecurityalliance.org/research/csa-research-note-shadow-ai-apps-enterprise-20260530-csa-sty/)
- **Governance-velocity gap:** **82% of CIOs say employees are creating AI agents and apps faster than IT can govern them** — [CSA research note](https://labs.cloudsecurityalliance.org/research/csa-research-note-shadow-ai-apps-enterprise-20260530-csa-sty/)
- **Inventory gap:** fewer than half of surveyed organizations have visibility into an inventory of AI agents (LeanIX survey, reported by SAP) — [SAP News](https://news.sap.com/2026/08/agent-sprawl-why-ai-governance-is-now-board-level-issue/); corroborated qualitatively by a small GuidePoint study (13 leaders) finding enterprises cannot count their agents — [GovInfoSecurity](https://www.govinfosecurity.com/enterprises-cant-count-their-ai-agents-survey-finds-a-32849)
- **Blocking backfires:** Gartner's Max Goss warned that blocking agents tends to push employees toward riskier shadow use, alongside misinformation, oversharing and data loss risks — [SAP News](https://news.sap.com/2026/08/agent-sprawl-why-ai-governance-is-now-board-level-issue/)
- **Named threat vectors:** MCP servers exposing internal APIs, browser extensions with agent capabilities, OAuth-connected agents with persistent data access, API token sprawl — [Vectra AI](https://www.vectra.ai/topics/shadow-ai)
- **Detection limitation:** identity systems can see service principals but miss an agent borrowing a user's session — [OpenLeash](https://openleash.com/blog/shadow-ai-agent-sprawl)
- **Governance over-buying as a counter-signal:** one 2026 analysis argues enterprises are "buying four layers of control before proving one layer of value" — i.e. a possible governance-spend bubble — [Forkast](https://forkast.news/the-agent-governance-tax-enterprises-are-buying-four-layers-of-control-before-proving-one-layer-of-value/)

### Inferences
- "Agent sprawl" has crossed from vendor coinage into analyst and board vocabulary during 2026. A practice entering now does not need to educate the market on the problem name — which is a meaningful go-to-market saving.
- Gartner's "blocking pushes people to riskier shadow use" position is direct analyst support for **paved-road / golden-path over mandate** as the correct governance posture — the same conclusion the platform-engineering field reached independently (see Q8/Q9).
- The Forkast "governance tax" argument is the shape of the most likely buyer objection: *we have already bought four governance tools, why do we need a framework?* Worth pre-empting.

### Gaps
- No credible *measured census* of agents per enterprise. Everything is projection or self-report.
- The widely circulated claims that "shadow AI incidents will triple" (attributed to Gartner by Airia) and the IBM/Forrester figures in Patech Labs are cited **without links** and I could not verify them — [Airia](https://airia.com/blog/shadow-ai-statistics-key-data-points-every-ciso-needs-in-2026/), [Patech Labs](https://www.patechlabs.com/news/enterprise-ai-agent-sprawl-is-the-new-shadow-it-and-cisos). Do not use.

---

## Q4. What do buyers say they need that vendors are not providing?

### Takeaway
Three consistent, separately-sourced demands: (1) **evidentiary audit trails and provable controls** rather than claimed ones; (2) **portability** — no lock-in to one model/platform; and (3) **transferred internal capability** rather than embedded vendor engineers. The third is the most strategically interesting and is articulated most sharply by a sitting CIO.

### Cited Findings

**Governance as a purchasing criterion (Okta/AlphaSights, n=150 IT and security decision-makers, fielded January 2026, geography not specified, Okta-commissioned)** — [Okta newsroom](https://www.okta.com/newsroom/articles/enterprise-buyer-survey-ai-agent-security/)
- **86%** call AI agent workflows "very important" or "mission-critical" to their strategy
- **69%** say security concerns are slowing AI agent adoption
- **27%** agree their current identity systems are fully equipped to govern non-human identities at scale
- **98%** will factor AI agent controls into renewals to some degree; **59%** say such controls would have a strong positive influence on committing to a platform
- **49% say audit trails are critical for production readiness**
- Top concerns: data leakage/exfiltration **83%**, over-privileged access **80%**

**Operational control gap (OutSystems, ~850 IT decision-makers)** — [IT Brief Asia](https://itbrief.asia/story/outsystems-warns-of-ai-agent-governance-readiness-gap), [TechEdge AI](https://techedgeai.com/outsystems-report-exposes-enterprise-ai-governance-gap/)
- **83%** rely on *existing* IT/security/compliance processes, specialized reviews, centralized policies or monitoring to oversee AI agents
- **only 5%** report having automated controls, audit trails **and** formal human review points in place
- **82%** of executives believe their organizations can keep pace with AI governance, but **only 26%** say they are well prepared to resolve conflicts across agents, applications and automated workflows
- **62%** said it was important to retain the option to switch models, vendors and platforms over time
- (I could not fetch the OutSystems primary release — 404 — so these are from two independent trade-press reports of it.)

**Contract-level demands buyers now put in writing**
- Buyer checklists routinely demand **kill switches, evidentiary audit trails, human-in-the-loop boundaries, model change control, outcome-based SLAs**; standard vendor liability caps (~12 months of fees) are widely criticized as mismatched to agentic loss potential — [Zylos research](https://zylos.ai/research/2026-07-02-buyer-side-governance-enterprise-ai-agent-deployments/)
- IDC's five-pillar agentic governance model includes explainability and auditability, and identity and access covering non-human identities — [IDC blog](https://www.idc.com/resource-center/blog/the-enterprise-ai-deal-has-changed-heres-what-vendors-need-to-prove/)

**Churn intent — nobody has won these buyers yet**
- Across five control layers (orchestration, reliability/evals, security/identity, infrastructure, context), **57%–68% plan to switch or add vendors within 12 months**; roughly a third plan changes within the current quarter. Orchestration highest at 68% / 34%. **"No layer has an entrenched incumbent."** (VentureBeat Research, June 2026, 573 qualified respondents across five self-selected surveys, orgs with 100+ employees; 81% of respondents recommend or directly decide AI purchases) — [VB Pulse coverage](https://pro.edgex.exchange/en-US/news/article/enterprise-ai-agents-governance-gaps-survey)

**The capability-transfer demand (the sharpest buyer-voice evidence found)** — [CIO.com opinion, Praveen Jonnala, CIO, Vistance Networks](https://www.cio.com/article/4233864/stop-sending-me-engineers-what-openai-anthropic-and-microsoft-misread-about-enterprise-ai.html)
- "Enterprises need fewer forward-deployed engineers and more domain experts who understand their business" — and "I need **backward-deployed domain experts**"
- Proposed engagement test: **"when it ends, are we better at finding the next problem ourselves?"**
- Buyers want business outcomes, not model metrics; accuracy gains that don't change an operational decision don't move cash
- Concern that forward-deployed engineers are a **crutch for product immaturity and part of a vendor dependency strategy** (attributed to Constellation Research, 2026)
- Concern that deep vendor reliance gives labs insight into the buyer's industry (proprietary-knowledge leakage)
- **Mid-market access problem:** scarce engineering talent is concentrated in large anchor accounts, "leaving most companies waiting"
- Also cites: FDE job postings grew ~800% in nine months; principal-level FDE compensation reportedly exceeds $1.2M

### Inferences
- The OutSystems "**5%** have automated controls + audit trails + formal human review points" figure is, if anything, the single best market-sizing statistic for a governance-framework offering: 95% of a ~850-respondent sample lack the exact artifact set such an engagement delivers.
- The gap between "82% believe they can keep pace" and "26% are prepared to resolve cross-agent conflicts" is a classic **confidence-before-competence** pattern. It predicts long sales cycles with executives and faster traction with the platform/security owners who already know the number.
- The CIO.com piece is near-verbatim demand for a *capability-transfer* engagement over a *build-and-leave* one, and explicitly names the mid-market as underserved by the labs' FDE land grab. That is the clearest available evidence that the market gap a two-person practice can occupy is real and articulated by buyers, not just by sellers.
- "No layer has an entrenched incumbent" plus 57–68% switching intent means a boutique is not displacing a dominant incumbent; it is entering an unsettled market. Low displacement cost, but also low buyer certainty about what they are buying.

### Gaps
- Nearly all of this is vendor-commissioned (Okta, OutSystems) or self-selected (VB Pulse). The CIO.com material is a single informed opinion, not a survey.
- No data on what buyers will *pay* specifically for governance artifacts versus working agents.

---

## Q5. Who sells "deploy AI agents inside your company" as a SERVICE?

### Takeaway
Four tiers now compete: the global SIs/strategy houses (Accenture, Deloitte, BCG X, McKinsey QuantumBlack, Slalom), the **model labs' own newly-created services arms** (which is the big 2026 structural change), AI-native boutiques, and platform vendors' professional-services organizations. The labs entering services directly is the most important competitive fact for a new boutique — and it also creates the partner/certification channel.

### Cited Findings

**Global SIs / strategy houses (scale, where disclosed)**
- Accenture: cumulative advanced AI bookings ~**$11.5bn across ~11,000 projects**, cumulative revenue **$4.8bn**, through Q1 FY2026; Q1 FY2026 advanced AI bookings **$2.2bn (+76% YoY)** — [Luminix aggregation of Accenture reporting](https://www.useluminix.com/reports/company-overviews/what-will-ai-do-to-accenture-s-business/source/0)
- Accenture FY25 **agentic**-specific revenue reported at ~**$2.7bn**; Accenture booked **$22.2bn** in new work and guided FY2027 growth of 3–6% (single secondary source — verify against the filing) — [Money Morning, Oct 2026](https://moneymorning.com/2026/10/02/accenture-q4-2026-earnings-ai-bookings-october-2026)
- BCG: ~**25% of its $14.4bn 2025 revenue (~$3.6bn)** from AI-related consulting, per an early-2026 summary — **but another source gives $2.7bn, so the figures conflict** — [Agent.Nexus comparison](https://agent.nexus/blog/accenture-vs-mckinsey-ai)
- McKinsey: ~**40% of projects now AI-related** (secondary summary); **no QuantumBlack-specific 2026 bookings figure found** — [Agent.Nexus](https://agent.nexus/blog/accenture-vs-mckinsey-ai)
- Capgemini: **>11% of Q1 bookings** agentic — the only firm where a 2026 agentic bookings *share* was found — [Agent.Nexus](https://agent.nexus/blog/accenture-vs-mckinsey-ai)
- McKinsey (via QuantumBlack) and BCG (via BCG X) were named implementation partners for OpenAI's Frontier platform, February 2026 — [Agent.Nexus](https://agent.nexus/blog/accenture-vs-mckinsey-ai)
- Firm-branded platform assets exist and anchor engagements: Accenture **AI Refinery**, Deloitte **Zora** — [actupon on Accenture AI Consulting](https://actupon.com/accenture-ai-consulting/), [NextBestAction pricing audit](https://nextbestaction.ai/insights/big-four-pricing-audit/)

**The labs' services arms (the 2026 structural shift)** — primarily documented via secondary coverage; valuations conflict across sources
- **OpenAI Deployment Company:** launched May 2026, **>$4bn initial funding from 19 partners**, majority-owned by OpenAI, explicitly uses the Forward Deployed Engineer model, starting with **150 FDEs**. OpenAI also agreed to acquire consulting firm **Tomoro** (~150 deployment specialists). Valuation reported as **$14bn** (Axios) in one source and **~$10bn** in another — [MindStudio analysis](https://www.mindstudio.ai/blog/anthropic-openai-copying-palantir-forward-deployed-engineer-model), [CIO.com](https://www.cio.com/article/4233864/stop-sending-me-engineers-what-openai-anthropic-and-microsoft-misread-about-enterprise-ai.html)
- **Anthropic:** enterprise AI services firm — reported name **Ode** — with Blackstone, Hellman & Friedman and Goldman Sachs, reportedly **valued above $1.5bn**, backed by a partner network with **$100m for 2026**. Its **Claude Frontier Academy** aims to **train 10,000 FDEs by end of 2027**, drawing mainly on engineers already employed by customers and partners. First cohorts include people from Accenture, Bain, Capgemini, Commonwealth Bank of Australia, Deloitte, McKinsey, Morgan Stanley and Novo Nordisk — [MindStudio](https://www.mindstudio.ai/blog/anthropic-openai-copying-palantir-forward-deployed-engineer-model), [CNBC, Oct 2026](https://www.cnbc.com/2026/10/15/aws-anthropic-racing-to-deploy-army-of-specialized-ai-engineers.html)
- **Microsoft Frontier Company:** ~**$2.5bn** and ~**6,000 embedded engineers** and industry experts — [CIO.com](https://www.cio.com/article/4233864/stop-sending-me-engineers-what-openai-anthropic-and-microsoft-misread-about-enterprise-ai.html)
- **AWS:** **$1bn** committed to a forward-deployed engineering initiative — [CNBC](https://www.cnbc.com/2026/10/15/aws-anthropic-racing-to-deploy-army-of-specialized-ai-engineers.html)
- Model lineage is explicitly Palantir's FDE playbook; one analysis notes the obvious constraint: "you can't just hire unlimited forward deployed engineers" — [MindStudio](https://www.mindstudio.ai/blog/anthropic-openai-copying-palantir-forward-deployed-engineer-model)

**AI-native boutiques** — see Q6 for their published pricing. Named examples with public offers: Enso Labs, Agentiqus, Startrise AI Labs — [Enso Labs](https://ensolabs.ai/locations/new-york), [Agentiqus pricing](https://agentiqus.com/pricing), [Startrise](https://www.startrise.io/blog/ai-enablement-consultant/)

### Inferences
- Anthropic's Frontier Academy training **customer- and partner-employed** engineers rather than only its own staff is the clearest signal that **the capability-transfer model is the one the ecosystem is institutionalizing**. A two-person practice whose product *is* capability transfer is aligned with, not opposed to, that direction — and the Academy is a plausible credentialing channel.
- The labs' FDE economics (principal FDE comp reportedly >$1.2M, talent concentrated in anchor accounts) structurally **cedes the mid-market**. That is the boutique's addressable space, and it is ceded for a durable reason (unit economics), not a temporary one.
- The SIs compete on firm-branded platform assets (AI Refinery, Zora) bundled into multi-million-dollar SI contracts. A boutique cannot win on asset breadth; it can win on the asset being *handed over* rather than retained.

### Gaps
- Slalom's AI agent practice: I found no specific offering description or disclosed figures.
- No primary-source confirmation for any of the lab-services valuations or headcounts — all are secondary coverage, and the valuations conflict.
- Platform vendors' own PS arms (Salesforce Agentforce PS, ServiceNow, Microsoft Industry Solutions Delivery) were not covered in depth; this is a real gap for competitive mapping.

---

## Q6. What do these engagements cost? What's realistic for a 2–3 person boutique?

### Takeaway
The only *verifiable* day rates are UK public-sector rate cards (Deloitte £450–£2,450/day, 2024 G-Cloud 14). Everything else is self-reported. The consistent market structure across boutique sources is a three-step ladder: **$5K–$25K fixed-fee assessment → $75K–$150K fixed-scope build → $5K–$12K/month enablement retainer.** That ladder is the realistic shape for a 2–3 person practice.

### Cited Findings

**Verifiable public rate cards (best anchor available)**
- **Deloitte LLP: £450/day at level 1 to £2,450/day at level 7** for strategy and architecture (G-Cloud 14, dated 2024) — [NextBestAction pricing audit](https://nextbestaction.ai/insights/big-four-pricing-audit/)
- Modelled six-week engagement: **£173,700 on Deloitte's card; £194,880 on KPMG's**, before VAT — [NextBestAction](https://nextbestaction.ai/insights/big-four-pricing-audit/)

**Hourly estimates — these conflict badly and should be reported as a range, not a figure**
- Mid-tier (Accenture, IBM Consulting, Capgemini): **$400–$700/hr** — [Alice Labs](https://alicelabs.ai/en/insights/ai-consulting-pricing-2026)
- Big 4 (Deloitte, PwC, EY, KPMG): **$400–$800/hr** — [Alice Labs](https://alicelabs.ai/en/insights/ai-consulting-pricing-2026)
- Contradicting figure: mid-market implementers (Accenture, Deloitte, Cognizant) bill **$150–$300/hr blended** — [Data Consulting Firms](https://dataconsultingfirms.com/insights/ai-consulting-pricing)
- Overall tier spread cited: **$150–$1,000/hr by firm tier** — [Aidols Group](https://aidolsgroup.com/en/blog/category/research-report/ai-consulting-cost-guide/)
- One source's useful structural point: **total cost comes from team size and duration far more than from day rate** — [actupon](https://actupon.com/accenture-ai-consulting/)

**Platform-anchored SI engagements**
- Accenture engagements including AI Refinery are "typically multi-million-dollar systems integration contracts spanning **12–24 months**"; no public pricing exists — [actupon](https://actupon.com/accenture-ai-consulting/)
- Deloitte Zora reported to start at **~$500,000** inside a systems integration — source is a competitor's published-price audit, so treat with caution — [NextBestAction](https://nextbestaction.ai/insights/big-four-pricing-audit/)

**Boutique published pricing (self-reported vendor marketing, but it's what the market shows buyers)**
- **Enso Labs:** 2-week AI Audit **$15K–$25K**; 12-week Pilot-to-Production **$75K–$150K** (includes governance and team enablement) — [Enso Labs](https://ensolabs.ai/locations/new-york)
- **Agentiqus:** fixed-fee leverage/ROI assessment **€3,000–€7,000**; outcome-based delivery **€15,000–€120,000+** with a fee of **5–20% of value unlocked**; ongoing enablement/coaching retainer **€5,000–€12,000/month** — [Agentiqus](https://agentiqus.com/pricing)
- **Startrise AI Labs:** fixed-price enablement setup **from $5,000**, delivered in 2–4 weeks, including configured dev environment, playbooks and team training — [Startrise](https://www.startrise.io/blog/ai-enablement-consultant/)
- One AI-native firm offers a fixed fee **refunded if ROI does not exceed it within 90 days** (single example) — [AY Automate roundup](https://www.ayautomate.com/blog/best-ai-automation-consultants-2026)
- **Most boutiques in a 2026 roundup published no rates at all** — [AY Automate](https://www.ayautomate.com/blog/best-ai-automation-consultants-2026)

**Pilot and phase pricing from independent-ish pricing guides**
- Focused pilot **$15,000–$40,000**; governed enterprise deployment **$100,000–$300,000+** — [Launch Day Advisors](https://launchdayadvisors.com/guides/ai-implementation-cost)
- Pilot norms: **8–16 weeks, 10–50 participants, roughly 20–30% of full implementation cost** — [Pertama Partners pilot pricing](https://www.pertamapartners.com/insights/ai-pilot-program-pricing)
- Consulting-firm single-use-case pilot **SGD $75,000–$180,000** — [Pertama Partners](https://www.pertamapartners.com/insights/ai-consulting-pricing-guide)
- Small phased consulting engagement (discovery + pilot + implementation) **$30K–$80K all-in**; pilots usually a **fixed-fee discovery phase with a capped budget and a success metric** — [Launch Day Advisors](https://launchdayadvisors.com/guides/ai-implementation-cost)
- Discovery priced separately: **$7,000–$35,000** for fully custom work — [Launch Day Advisors](https://launchdayadvisors.com/guides/ai-implementation-cost)
- **Run costs commonly 20–40% of build cost per year** — [Launch Day Advisors](https://launchdayadvisors.com/guides/ai-implementation-cost)
- Each integration requires **2–4 weeks of engineering**, and scaling is where the first significant cost increases appear — [Zelu AI](https://www.zeluai.com/blog/scaling-ai-agents)

### Inferences
- A two-person practice sits credibly at roughly **$400–$700/hr equivalent** on the strength of a production reference implementation — i.e. SI mid-tier rates, not Big 4 partner rates. But it should almost certainly **sell fixed-fee phases, not rates**, because every source agrees total cost is driven by team size and duration, and a two-person team's only pricing advantage is that it has no bench to feed.
- Concrete defensible ladder, triangulated across sources: assessment/discovery **$20K–$35K (2–4 weeks)**; foundation design **$40K–$75K**; governed pilot **$75K–$150K (8–12 weeks)**; builder-enablement cohort **$40K–$80K**; scale/optimize retainer **$8K–$20K/month**. A full five-phase engagement lands around **$200K–$350K** — roughly 1–2 months of a comparable Big 4 engagement, which is the price story.
- The "20–40% of build cost per year" run-cost norm is the natural justification for the retainer, and it is sourced rather than invented.

### Gaps
- No verifiable pricing for any *governance-framework-specific* engagement. The closest proxies are Enso's governance-inclusive pilot band and the Big 4 rate cards.
- The 2024 date on the G-Cloud rate cards means they are two years stale as of late 2026.
- No data on win rates or discounting at any tier.

---

## Q7. Engagement structure, phasing, duration, documented success rate

### Takeaway
A phased shape close to discover/design/pilot/enable/scale is the de facto industry pattern, but **"enable" is the phase most often missing or unpriced**, and there is **no documented success rate for any engagement structure** — that is a genuine evidentiary void, not a gap in my search.

### Cited Findings
- Typical phasing in published offers: **discovery → pilot → implementation**, with discovery often priced separately and pilots run as a fixed-fee phase with a capped budget and a success metric — [Launch Day Advisors](https://launchdayadvisors.com/guides/ai-implementation-cost)
- An onboarding-focused guide includes **enablement and training as a discrete phase** but gives **no separate cost figure for it** — [AnyReach](https://blog.anyreach.ai/the-enterprise-guide-to-agentic-ai-training-and-onboarding/)
- Discovery and planning: ~**3–4 weeks** for strategic alignment and capability assessment; enterprise onboarding overall **8–24 weeks** — [AnyReach](https://blog.anyreach.ai/the-enterprise-guide-to-agentic-ai-training-and-onboarding/)
- Aggressive timeline view: pilot in **2–6 weeks**, production in **6–12 weeks**, multi-workflow program in **3–6 months**, dependent on data readiness, integration complexity and governance requirements — [Pedowitz Group](https://www.pedowitzgroup.com/how-long-does-it-take-to-implement-ai-agents)
- Conservative timeline view: full scale-up **12–18 months**, pilot months 1–3, enterprise-wide rollout months 12–18 — [Zelu AI](https://www.zeluai.com/blog/scaling-ai-agents)
- SI reality: Accenture AI Refinery engagements **12–24 months** — [actupon](https://actupon.com/accenture-ai-consulting/)
- Salesforce publishes a "10 Steps To Launch an Agentic AI Pilot Program" as a canonical vendor-side pilot structure — [Salesforce](https://www.salesforce.com/blog/launch-an-agentic-ai-pilot/)
- Pricing-model shift observed in 2026 consulting trends coverage: **outcome-based pricing** alongside AI agents reaching production — [F1GMAT Q1 2026 consulting trends](https://premium.f1gmat.com/consulting/trends/2026/Q1)

### Inferences
- The five-phase shape in the benchmark offering is **market-standard, not differentiating**. The differentiation has to live in the artifacts each phase produces (computed risk tiers, audit trail, verification semantics) and in the fact that phase 4 (enable builders) is explicitly scoped and priced when competitors leave it implicit.
- Because no firm publishes an engagement success rate, **a single named production reference implementation is disproportionately valuable evidence** in this market. There is no benchmark to be measured against, so "one that is actually running" outperforms "we have a methodology."
- The 2–6 week vs 12–18 month timeline spread is not noise: it tracks whether governance is in scope. Fast timelines come from sources selling a workflow; slow ones from sources selling a program. A governance-first offering should quote the slower range and say why.

### Gaps
- **No documented success rate for any consulting engagement structure for AI agents.** No firm publishes one; no analyst study I found measures one. This should be stated plainly in the report.
- No data on how often "enable/train internal builders" is actually included versus sold as a follow-on.

---

## Q8. Is there a market for governance-framework-plus-builder-enablement versus build-and-leave?

### Takeaway
The demand evidence is real but mostly indirect: buyers articulate it (CIO.com), the artifact gap is measured (OutSystems 5%), audit trails are a stated production-readiness gate (Okta 49%), and the ecosystem is institutionalizing capability transfer (Anthropic Frontier Academy training customer-employed engineers). What I could **not** find is a named competitor selling exactly this, which is simultaneously the opportunity and the risk.

### Cited Findings
- Buyer-stated engagement test: **"when it ends, are we better at finding the next problem ourselves?"**; "I need backward-deployed domain experts" — [CIO.com, Praveen Jonnala](https://www.cio.com/article/4233864/stop-sending-me-engineers-what-openai-anthropic-and-microsoft-misread-about-enterprise-ai.html)
- Explicit buyer suspicion of the build-and-stay model: FDEs as "a crutch for product immaturity and part of a vendor dependency strategy" (Constellation Research, 2026, paraphrased) — [CIO.com](https://www.cio.com/article/4233864/stop-sending-me-engineers-what-openai-anthropic-and-microsoft-misread-about-enterprise-ai.html)
- The deliverable gap is measured: **only 5%** of ~850 IT decision-makers have automated controls + audit trails + formal human review points — [IT Brief Asia on OutSystems](https://itbrief.asia/story/outsystems-warns-of-ai-agent-governance-readiness-gap)
- Audit trails are a stated gate: **49% say audit trails are critical for production readiness** — [Okta](https://www.okta.com/newsroom/articles/enterprise-buyer-survey-ai-agent-security/)
- Portability as a buying requirement: **62%** want to retain the option to switch models, vendors and platforms — [IT Brief Asia](https://itbrief.asia/story/outsystems-warns-of-ai-agent-governance-readiness-gap)
- Capability transfer being institutionalized: Anthropic's **Claude Frontier Academy targets 10,000 trained FDEs by end of 2027, drawn mainly from engineers already employed by customers and partners** — [MindStudio](https://www.mindstudio.ai/blog/anthropic-openai-copying-palantir-forward-deployed-engineer-model)
- Boutiques already bundle enablement into pilots (Enso's 12-week Pilot-to-Production "includes governance and team enablement") and sell standalone enablement retainers (Agentiqus €5K–€12K/month; Startrise fixed-price enablement from $5,000) — [Enso Labs](https://ensolabs.ai/locations/new-york), [Agentiqus](https://agentiqus.com/pricing), [Startrise](https://www.startrise.io/blog/ai-enablement-consultant/)

### Inferences
- Governance-plus-enablement is currently sold as a **feature inside a build engagement**, not as the headline product. Leading with it is genuinely differentiated positioning — and the differentiation is in the packaging and pricing, not in nobody having thought of it.
- The counter-risk: governance is being bought as **tooling** (the "four layers of control" critique) rather than as a framework engagement. The practice must be able to say precisely what it delivers that a purchased control plane does not — which is where mechanically computed risk tiers and skipped-vs-passed verification semantics actually matter commercially.
- The Frontier Academy channel suggests a partnership motion: a certified independent practice serving mid-market accounts the labs' own FDEs will not economically reach.

### Gaps
- **I found no named consultancy whose headline offering is "governance framework + internal builder cohort for AI agents."** That is either whitespace or a signal the category does not sell on its own; the available evidence cannot distinguish these.
- No pricing data for governance-framework-only engagements.

---

## Q9. The internal developer platform (IDP) analogue — what transfers

### Takeaway
The IDP field has already run this experiment and the transferable findings are strong: platforms must be **compelling rather than mandatory**, built as a **product with an owner**, kept to the **thinnest viable scope**, and measured on **friction and bypass rate rather than installs**. DORA 2025 provides the strongest quantified link: internal platform quality is what determines whether an organization converts AI adoption into value.

### Cited Findings

**DORA 2025 — "State of AI-assisted Software Development"** (the strongest primary-ish evidence for the entire analogue) — [Google Cloud announcement](https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report), [dora.dev platform engineering capability](https://dora.dev/capabilities/platform-engineering/), [Thoughtworks summary](https://www.thoughtworks.com/insights/reports/the-2025-dora-report)
- **90% of organizations have adopted at least one platform; 76% have established dedicated platform teams** — [Google Cloud](https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report)
- **"There is a direct correlation between a high quality internal platform and an organization's ability to unlock the value of AI."** Platform quality is named the **seventh capability** in DORA's AI capabilities model, amplifying AI's effect on organizational performance — [Google Cloud](https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report)
- Users treat the platform as **one entity**: overall effectiveness matters more than the quality of any individual feature — [dora.dev](https://dora.dev/capabilities/platform-engineering/)
- **"AI doesn't fix a team; it amplifies what's already there."** Strong teams gain; struggling teams find existing problems intensified — [Google Cloud](https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report)
- AI adoption correlates positively with **delivery throughput** but also with **higher instability** — more change failures, increased rework, longer cycle times to resolve — [Google Cloud](https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report)
- Trust gap: **>80% believe AI increased their productivity, yet 30% report little or no trust in AI-generated code** — [Scrum.org summary](https://www.scrum.org/resources/blog/dora-report-2025-summary-state-ai-assisted-software-development)
- Caveat: the Faros AI productivity figures (21%, 98%) circulating alongside DORA coverage come from **Faros's own telemetry, not DORA** — cite separately — [Faros](https://www.faros.ai/blog/key-takeaways-from-the-dora-report-2025)

**Golden path / paved road concept**
- Golden paths are **opinionated, supported defaults rather than mandates**: "a golden path earns adoption; it does not compel it." Terms originate from Spotify ("golden path") and Netflix ("paved road") — [Logiciel on golden paths](https://logiciel.io/blog/golden-paths), [Red Hat](https://www.redhat.com/en/topics/platform-engineering/golden-paths)

**Team Topologies / platform-as-product**
- **Thinnest Viable Platform (TVP):** scope limited to what developers need for a core workflow start to finish; explicitly analogous to MVP — [Team Topologies](https://teamtopologies.com/platform-engineering)
- Scope restraint: "start with a wiki listing shared services; grow only in response to demonstrated need" — [Software architecture wiki summary of Team Topologies](https://synchronium.github.io/software-architecture-wiki/concepts/team-topologies-model.html)
- Voluntary-adoption lineage: **Evan Bottcher (2018) argued platforms should be compelling rather than mandatory**; Skelton and Pais later codified these ideas in Team Topologies — [Jellyfish, Platform as a Product](https://jellyfish.co/library/platform-engineering/platform-as-a-product/)
- Platform teams treat other development teams as **customers**; some organizations use **NPS** to rank platform developer experience — i.e. adoption is measured by satisfaction, not enforced — [Team Topologies, Platform as a Product](https://platformengineering.org/talks-library/platform-as-a-product)
- Case study: Trade Me's TVP journey — streamlined platform capabilities, reduced cognitive load, improved product/platform collaboration — [Team Topologies](https://teamtopologies.com/industry-examples/trade-me-journey-towards-a-thinnest-viable-platform)

**Backstage adoption patterns**
- **~10% developer adoption is the commonly reported outcome** for companies that have deployed Backstage — "typically equivalent to a proof of concept." This is the most consistently repeated figure across sources — [Earthly](https://earthly.dev/blog/backstage-is-at-peak-hype/), [Port](https://www.port.io/blog/what-are-the-technical-disadvantages-of-backstage)
- Spotify's own internal adoption is the outlier, described as **claimed 99% voluntary adoption** — [Earthly](https://earthly.dev/blog/backstage-is-at-peak-hype/)
- **Portal-first instead of path-first** is the named root cause: if a scaffolded service still needs manual tickets before production, engineers keep raising the tickets and skip the scaffolder — [Logiciel](https://logiciel.io/blog/backstage-io-production)
- **Stale catalog** failure: the catalog is half-populated and stale, engineers keep their old bookmarks. Requiring developers to add YAML without giving them value in return makes adoption harder — [Logiciel](https://logiciel.io/blog/backstage-io-production), [Port](https://www.port.io/blog/what-are-the-technical-disadvantages-of-backstage)
- **Maintenance burden:** a 2026 analysis reports **56% of adopters name upgrades as their biggest problem**; teams spend **30–40% of platform engineering time on plugin upkeep** instead of building golden paths — [Port](https://www.port.io/blog/what-are-the-technical-disadvantages-of-backstage)
- Backstage gives you **a developer portal framework, not a finished product** — [DevOps.com](https://devops.com/is-backstage-the-right-internal-developer-portal-for-you/)
- Organizations reporting solid results "almost always have a platform engineering team that treats Backstage as an internal product, with a roadmap and ongoing maintenance" — [Logiciel](https://logiciel.io/blog/backstage-io-production)
- **Vendor-bias caveat:** most of these sources (Port, Roadie, Cortex, Bunnyshell) sell managed alternatives to self-hosted Backstage.

**Platform engineering applied explicitly to AI agents (the direct precedent)**
- "The IDP stops being only a portal for humans and becomes a **control plane that agents consume programmatically**"; exposing platform actions as **MCP tools** is one common way to do it — [Platform Engineering: Your Newest Platform User is an AI Agent](https://platformengineering.com/features/your-newest-platform-user-is-an-ai-agent-build-it-a-golden-path/)
- Agents should get a **curated, explicitly scoped set of tools that encode the golden paths**, not broad access — [Bex.co, Sept 2026](https://bex.co/blog/2026/09/24/agentic-enterprise-golden-paths-deploy-agents)
- "When a platform team ships a template without its **agent-callable twin**, it has paved half a road" — [Bex.co](https://bex.co/blog/2026/09/24/agentic-enterprise-golden-paths-deploy-agents)
- Humans and agents need different things: agents need **deterministic inputs, outputs and validation**; humans need low-friction self-service — [Arinco](https://arinco.com.au/blog/are-ai-agents-the-new-platform-engineering-customers/)
- Prerequisite warning: fix platform quality first — "if templates are inconsistent, documentation is missing, and deployments are error-prone and require human oversight, agents will fail" — [Spacelift](https://spacelift.io/blog/ai-in-platform-engineering)
- Agents as platform testers: they "surface every undocumented dependency, inconsistent naming convention and vague instruction" — [Arinco](https://arinco.com.au/blog/are-ai-agents-the-new-platform-engineering-customers/)
- Also found: an argument that the golden path needs an **intent interface** — [vinny.dev, Aug 2026](https://vinny.dev/blog/2026-08-20-the-golden-path-needs-an-intent-interface/)

### Inferences
- DORA 2025 is the **single most citable asset for this offering's thesis**, and it is a credible annual research program rather than a vendor survey. "Internal platform quality determines whether AI adoption converts to value" plus "AI amplifies existing weakness" plus "AI correlates with higher instability" is, in three sentenced findings, the entire business case for a governed internal agent platform. Lead with DORA, not MIT.
- The agent-specific platform-engineering literature exists but is **early, thin, and almost entirely vendor blogs and practitioner posts as of late 2026** — no primary standards document, no case studies with measured outcomes. This means the benchmark offering is early to a forming category rather than late to a crowded one, but it also means there is no body of evidence to point to; the practice must *be* the evidence.
- The "agents need deterministic inputs, outputs and validation" finding is independent third-party support for deterministic verification as a design requirement rather than a preference.
- Backstage's ~10% adoption versus Spotify's ~99% is the cautionary analogue: **the same software succeeds where it was built with product ownership and fails where it was installed.** A handed-over framework inherits exactly this risk, which argues strongly for pricing the enablement phase as mandatory rather than optional.

### Gaps
- I did not retrieve the primary DORA PDF; figures are from Google Cloud's own announcement and Thoughtworks/Scrum.org summaries. Verify exact wording at dora.dev.
- No DX (getdx.com) primary research retrieved beyond one commentary post.
- The CNCF Platforms White Paper and CNCF platform maturity data were only seen secondhand.
- I found **no case study measuring outcomes of platform-engineering discipline applied to AI agents.** The literature is prescriptive, not evaluative.

---

## Q10. Documented failure modes of internal platforms, and voluntary versus mandated adoption

### Takeaway
The named failure modes are consistent and well-articulated: built for control not consumption, "field of dreams" assumption that building drives adoption, vanity metrics, abstraction without escape hatches, and mandate without migration. On voluntary versus mandated: the field's position is unanimous and the evidence is **qualitative only** — no source I found quantifies voluntary versus mandated adoption rates.

### Cited Findings

**Named failure modes** — [platformengineering.org, "Golden cage syndrome"](https://platformengineering.org/blog/golden-cage-syndrome-why-internal-developer-platforms-fail) (fetched in full)
1. **Golden cage syndrome** — the platform is built primarily for control rather than consumption, with mandatory, opaque, restrictive abstractions
2. **"Field of dreams" fallacy** — assuming building a platform drives adoption; treating developers as captive users under company policy
3. **Measuring output, ignoring friction** — tracking vanity metrics (deploy frequency, time to "Hello World") while cognitive load rises
4. **Abstraction without escape hatches (leaky abstraction)** — complex infrastructure hidden behind a simple UI, so developers cannot see or reach the underlying layer when something breaks
5. **Workaround behavior** — developers use raw cloud credentials and bypass the paved road

**Additional failure modes from other sources**
- **Governance bolted on late:** in regulated banks, governance is added rather than built in, and good platforms stall waiting on it; releases still routing through a manual change-approval board is a named warning sign — [Tensure](https://www.tensure.io/blogs/why-platform-engineering-stalls-in-banks)
- **Team operates as a help desk:** platforms get funded as a project and staffed as a help desk, so the team reacts to requests instead of building a product — [Tensure](https://www.tensure.io/blogs/why-platform-engineering-stalls-in-banks)
- **Mandate without migration:** leadership declares the platform the only sanctioned path while teams with working pipelines and deadlines keep their own scripts and CI jobs — [DevX](https://www.devx.com/architecture-zone/when-internal-platforms-become-friction-factories/)
- **Wrong metrics:** teams track installs or cluster uptime rather than time-to-first-deploy or **how often developers bypass the platform** — [HackerNoon](https://hackernoon.com/internal-developer-platforms-are-booming-but-adoption-is-failing)
- **Maintenance overload:** self-hosted Backstage absorbs platform-team capacity; teams burn out on upkeep before shipping the features developers want — [Port](https://www.port.io/blog/what-are-the-technical-disadvantages-of-backstage)

**Voluntary versus mandated adoption — what the evidence actually supports**
- The field's stated position: **"You cannot mandate adoption; you must compete for it."** Mandates are described as a *cause* of failure: teams assuming adoption is required by policy tend to see developers ignore or route around the platform (compared to SharePoint — "everyone had it, nobody used it") — [platformengineering.org](https://platformengineering.org/blog/golden-cage-syndrome-why-internal-developer-platforms-fail)
- Proposed diagnostic, with **no reported results**: ask developers whether they would keep using the platform if it became optional — [platformengineering.org](https://platformengineering.org/blog/golden-cage-syndrome-why-internal-developer-platforms-fail)
- Golden paths are defaults, not mandates: "a golden path earns adoption; it does not compel it" — [Logiciel](https://logiciel.io/blog/golden-paths)
- Independent corroboration from the AI-governance side: Gartner's Max Goss warned that **blocking agents pushes employees toward riskier shadow use** — [SAP News](https://news.sap.com/2026/08/agent-sprawl-why-ai-governance-is-now-board-level-issue/)

**Statistics to treat as unreliable or unusable**
- **"80% of IDPs fail":** the platformengineering.org article's own headline figure. On fetching the article, it attributes this to the author's audit of "dozens of enterprise platform initiatives," with **no dataset, methodology, or named study**. Do not cite as research — [platformengineering.org](https://platformengineering.org/blog/golden-cage-syndrome-why-internal-developer-platforms-fail)
- **"64% of engineers bypass the platform":** appears across several articles, all tracing to a single April 2026 Medium post and a "2026 State of Platform Engineering Report" that none of them link to. **Unverified** — [Practical Logix](https://www.practicallogix.com/platform-engineering-paradox-why-80-of-enterprises-build-idps-and-64-of-their-developers-bypass-them/)
- **"CNCF: only 9% of organizations meet platform maturity standards":** more traceable than the above but still secondhand via a vendor blog — [Tensure](https://www.tensure.io/blogs/why-platform-engineering-stalls-in-banks)
- The 18-months-build-time and 5-minutes-vs-4-hours figures in the golden-cage article are **illustrative examples, not measured data** — [platformengineering.org](https://platformengineering.org/blog/golden-cage-syndrome-why-internal-developer-platforms-fail)

### Inferences
- **"Golden cage syndrome" is the precise failure mode the benchmark offering is most exposed to.** Mechanically computed risk tiers that authors cannot downgrade, blocking reviews, and structured menu-driven consumption instead of a chat box are all, viewed uncharitably, *control-first design*. The field's strongest documented finding is that control-first platforms get bypassed. Two features cut the other way and should be positioned explicitly as the answer: the adversarial agent that tries to disprove blocking findings is functionally an **escape hatch with due process** (it addresses failure mode 4 and makes the cage arguable rather than opaque), and "skipped rather than passed" is an **anti-vanity-metric** (failure mode 3). These are not incidental features — they are the direct rebuttals to the two best-documented reasons internal platforms fail.
- The field has no quantitative evidence for voluntary over mandated adoption; it has unanimous practitioner consensus plus one analyst (Gartner, on agents specifically) saying blocking backfires. That consensus is strong enough to design against but should not be presented as measured.
- Because engagements end, **the handover inherits the "staffed as a help desk" and "maintenance overload" failure modes with no platform team to absorb them.** The retainer is not upsell; on this evidence it is the mitigation for the most-documented cause of platform death.
- The correct adoption metric to build into the framework, per the evidence, is **bypass rate** — not agents built, not platform uptime.

### Gaps
- **No quantitative comparison of voluntary versus mandated internal platform adoption exists in anything I found.** This is a real void worth stating.
- Spotify's claimed 99% voluntary adoption is a company claim with no published methodology.

---

## Q11. Plausible commercial models, and precedents for productizing an internal framework

### Takeaway
Four models are in live use in this market: fixed-fee phased engagement (dominant for boutiques), monthly enablement retainer, outcome-based/value-share (emerging, with real published examples), and license-plus-services (the SI pattern, via firm-branded platform assets). The clearest *structural* precedent for productizing a framework and selling it onward is Team Topologies' accredited-partner accelerator model — though I could not confirm its licensing terms.

### Cited Findings
- **Fixed-fee phased** is the boutique default: short assessment ($5K–$25K), fixed-scope build ($75K–$150K), monthly enablement retainer — [Enso Labs](https://ensolabs.ai/locations/new-york), [Startrise](https://www.startrise.io/blog/ai-enablement-consultant/)
- **Retainer:** Agentiqus €5,000–€12,000/month for ongoing enablement and coaching — [Agentiqus](https://agentiqus.com/pricing)
- **Outcome-based / value share:** Agentiqus prices outcome-based delivery at €15,000–€120,000+ **with a fee of 5–20% of value unlocked** — [Agentiqus](https://agentiqus.com/pricing); one AI-native firm offers a **fixed fee refunded if ROI does not exceed it within 90 days** — [AY Automate](https://www.ayautomate.com/blog/best-ai-automation-consultants-2026)
- **Outcome-based pricing is a named 2026 consulting trend** alongside agents reaching production — [F1GMAT Q1 2026](https://premium.f1gmat.com/consulting/trends/2026/Q1)
- **License-plus-services (SI pattern):** Accenture AI Refinery and Deloitte Zora are firm-branded platform assets bundled into large SI engagements; Zora reportedly starts ~$500K inside a systems integration — [actupon](https://actupon.com/accenture-ai-consulting/), [NextBestAction](https://nextbestaction.ai/insights/big-four-pricing-audit/)
- **Productized-services definition in use:** a standardized offering with fixed scope, fixed price and a defined deliverable; agencies use fixed-fee/fixed-scope while consultancies typically use open-ended retainers or project contracts — [Faithline AI](https://www.faithlineai.com/blog/ai-productized-services-consultant-agency)
- **Run-cost anchor for retainer pricing:** run costs commonly **20–40% of build cost per year** — [Launch Day Advisors](https://launchdayadvisors.com/guides/ai-implementation-cost)

**Precedents for productizing an internal framework and selling it onward**
- **Team Topologies Product Operating Model accelerator:** a three-part program across people, process and organizational architecture, where "**one or more accredited Team Topologies partners help to scale the rollout across the organization**" — the closest structural match to a framework productized and delivered through partners — [Team Topologies](https://teamtopologies.com/product-operating-model-accelerator)
- **Team Topologies Accelerator (12-week programme):** run by the framework's authors, weekly sessions plus monthly sense-check sessions with one of the authors — the closest match to a two-person expert practice selling a time-boxed framework engagement at scale — [Team Topologies](https://teamtopologies.com/all-ongoing-expertise/team-topologies-accelerator-12-week-programme-p812)
- **Thoughtworks** integrates Team Topologies with its own **Simplified Operating Model** tooling — a consultancy layering proprietary tooling on a public framework — [Thoughtworks webinar](https://www.thoughtworks.com/en-us/about-us/events/webinars/accelerating-value-with-transparent-flow-based-organizations)
- **Anthropic's partner/certification channel** is the AI-specific analogue: Claude Frontier Academy training 10,000 FDEs largely employed by customers and partners, with a **$100m partner network for 2026** — [MindStudio](https://www.mindstudio.ai/blog/anthropic-openai-copying-palantir-forward-deployed-engineer-model)

### Inferences
- The Team Topologies pattern is the most instructive business-model template available: a **small authoring practice** publishes a named framework, sells a **12-week accelerator** directly at premium rates, and licenses delivery to **accredited partners** for scale. That decouples revenue from the two founders' calendars — the binding constraint on any two-person practice — and it is a proven shape in an adjacent discipline.
- Outcome-based pricing is attractive positioning but a poor fit for *this* offering: the deliverable is a governance framework whose value shows up as **avoided incidents and faster safe shipping**, which the available evidence says buyers mostly fail to baseline (see MIT's missing-baseline critique). Pricing on value you cannot measure invites the dispute. Better: fixed-fee phases, with the framework's own instrumentation sold as the thing that makes later outcome-based work *possible*.
- License-plus-services is viable but weakens the central differentiator. If the framework is licensed rather than handed over, the practice becomes the dependency it positions against — and 62% of buyers say portability matters.

### Gaps
- **I could not confirm whether Team Topologies' accredited-partner arrangement permits partners to pass the framework on to third parties, or on what commercial terms.** Their site describes the program; licensing terms are not public. This needs direct inquiry.
- No disclosed economics for any framework-licensing arrangement in this space (fee splits, certification pricing, royalty rates).
- No examples found of a *two-person* practice successfully productizing an AI governance framework — the precedents are either larger or in adjacent disciplines.

---

## MARKET POSITIONING IMPLICATIONS

### Which buyer persona to target

**Primary: the platform or engineering leader at a 500–5,000-employee company who already owns an internal developer platform and has been handed AI agents as a new problem.** The evidence points here specifically:

- DORA 2025 found **76% of organizations have dedicated platform teams** and **90% have at least one platform** — this persona exists in volume and already has budget and a mandate — [Google Cloud](https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report)
- DORA's finding that **internal platform quality correlates directly with converting AI adoption into value** gives this persona an analyst-grade argument for the spend that does not require them to defend an AI narrative — [Google Cloud](https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report)
- **This persona already understands golden paths, bypass rate and platform-as-product.** The entire conceptual frame of the offering is their native vocabulary, which collapses the education cost that would dominate a CIO or CISO sale.
- The mid-market is **structurally underserved**: a sitting CIO documents that scarce FDE talent is concentrated in large anchor accounts, "leaving most companies waiting" — [CIO.com](https://www.cio.com/article/4233864/stop-sending-me-engineers-what-openai-anthropic-and-microsoft-misread-about-enterprise-ai.html). With principal FDE comp reportedly >$1.2M, the labs cannot economically serve this segment, so the gap is durable rather than a timing window.

**Secondary / co-sponsor: the CISO or head of security engineering.** Okta found **69% say security concerns are slowing agent adoption** and **49% say audit trails are critical for production readiness**, with only **27%** believing their identity systems can govern non-human identities at scale — [Okta](https://www.okta.com/newsroom/articles/enterprise-buyer-survey-ai-agent-security/). This persona unblocks budget but does not own delivery; the immutable permission audit trail is the artifact that converts them.

**Explicitly avoid leading with the CIO/CEO.** OutSystems found **82% of executives believe their organizations can keep pace with AI governance** while only **26%** are prepared to resolve cross-agent conflicts — [IT Brief Asia](https://itbrief.asia/story/outsystems-warns-of-ai-agent-governance-readiness-gap). Selling into measured overconfidence is a long cycle. The platform owner already knows the real number.

### What to charge

Triangulating the verifiable rate cards, published boutique pricing, and phase-cost guides:

| Phase | Price | Duration | Evidence anchor |
|---|---|---|---|
| Discover | $20K–$35K | 2–4 wks | Enso audit $15–25K; discovery $7–35K; AnyReach discovery 3–4 wks |
| Design foundation | $40K–$75K | 3–5 wks | Gap between assessment and build tiers |
| Governed pilot | $75K–$150K | 8–12 wks | Enso Pilot-to-Production $75–150K; Pertama pilot 8–16 wks |
| Enable builders | $40K–$80K | 4–6 wks | Startrise enablement from $5K (thin); Agentiqus retainer rates |
| Scale & optimize | $8K–$20K/mo | ongoing | Agentiqus €5–12K/mo; run costs 20–40% of build/yr |
| **Full engagement** | **$200K–$350K** | **5–7 months** | — |

Rationale and the honest tradeoff: a two-person practice with a production reference can credibly price at **mid-tier SI equivalent (~$400–$700/hr)**, below Big 4 levels (Deloitte's public card runs £450–£2,450/day, with a modelled six-week engagement at £173,700) — [Alice Labs](https://alicelabs.ai/en/insights/ai-consulting-pricing-2026), [NextBestAction](https://nextbestaction.ai/insights/big-four-pricing-audit/). **Sell fixed-fee phases, not rates.** Every source agrees total cost is driven by team size and duration; a two-person team's only cost advantage is having no bench, and rate-card selling surrenders it. The full-engagement price lands at roughly what one to two months of a comparable Big 4 program costs — that comparison, not the absolute number, is the price story.

Price the enablement phase as **mandatory, not optional**. This is the one pricing decision the evidence actively compels: Backstage's ~10% typical adoption versus Spotify's claimed ~99% is the same software succeeding where it had product ownership and failing where it was installed — [Earthly](https://earthly.dev/blog/backstage-is-at-peak-hype/), [Logiciel](https://logiciel.io/blog/backstage-io-production). An optional enablement phase is how a handed-over framework becomes a stale catalog.

Avoid outcome-based pricing at entry, despite its 2026 fashionability — [F1GMAT](https://premium.f1gmat.com/consulting/trends/2026/Q1). The MIT critique establishes that most organizations never set a pre-deployment baseline — [agentmodeai](https://agentmodeai.com/the-mit-genai-pilot-failure-claim/). Pricing on unmeasurable value invites the dispute. Position the framework's instrumentation as **what makes outcome-based engagement possible later**, and offer value-share only on phase 5.

### The strongest wedge claim

**"Only 5% of enterprises have automated controls, audit trails and formal human review points in place. We install all three, prove each one runs, and hand you the keys."**

This is the strongest available wedge because:
- It is anchored in a **measured artifact gap** (OutSystems, ~850 IT decision-makers), not a forecast or a contested failure rate — [IT Brief Asia](https://itbrief.asia/story/outsystems-warns-of-ai-agent-governance-readiness-gap)
- The three named artifacts map one-to-one onto the offering's differentiators: automated controls → mechanically computed risk tiers; audit trails → immutable permission trail; formal human review → blocking review with adversarial challenge
- It implies no contested statistic, so it survives a technically literate buyer

**Supporting wedge, for the security co-sponsor:** the only quantified evidence I found that governance mechanics reduce harm rather than just satisfying auditors — **63.5% (47/74)** of firms allowing agent credential sharing reported a security incident or near-miss, versus **40.9% (9/22)** where every agent has a scoped identity — [VentureBeat Research](https://pro.edgex.exchange/en-US/news/article/enterprise-ai-agents-governance-gaps-survey). Small sub-samples; present as directional with the n values visible, which is itself a credibility signal in a market full of laundered statistics.

**Supporting wedge for the platform persona:** DORA 2025 — platform quality determines whether AI adoption converts to value; AI amplifies existing weakness rather than fixing it; AI adoption correlates with higher instability, more change failures and more rework — [Google Cloud](https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report). **Lead with DORA, not MIT.** DORA is an annual research program this persona already trusts; MIT's 95% is contested, widely misquoted, and using it signals you have not read the critique.

**Do not lead with:** "95% of AI pilots fail" (contested, measures absence of measurement), "80% of IDPs fail" (the source's own author attributes it to an unpublished personal audit), or "64% of developers bypass platforms" (traceable only to an unlinked report). Each is a credibility liability with exactly the buyer being targeted.

### The most likely objection

**"We've already bought the governance tooling. Why do we need a framework?"**

This is the best-evidenced objection. A 2026 analysis argues enterprises are "buying four layers of control before proving one layer of value" — [Forkast](https://forkast.news/the-agent-governance-tax-enterprises-are-buying-four-layers-of-control-before-proving-one-layer-of-value/), and VentureBeat Research found **57%–68% plan to switch or add vendors across all five control layers within 12 months**, with no entrenched incumbent in any layer — [VB Pulse](https://pro.edgex.exchange/en-US/news/article/enterprise-ai-agents-governance-gaps-survey). So the buyer has probably bought something, and probably isn't happy with it.

The evidence-grounded answer: OutSystems found **83% rely on existing IT/security/compliance processes, specialized reviews, centralized policies or monitoring** to oversee agents — yet only **5%** have the three operational artifacts in place — [IT Brief Asia](https://itbrief.asia/story/outsystems-warns-of-ai-agent-governance-readiness-gap). The gap is not tooling; it is that the tooling is not wired into a path anyone follows. Reinforce with the IDP precedent: governance **bolted on late** stalls platforms, and manual change-approval boards are a named warning sign — [Tensure](https://www.tensure.io/blogs/why-platform-engineering-stalls-in-banks). And with the trust data: two-thirds already gate production on automated evals that **only 5% fully trust** — [VB Pulse](https://pro.edgex.exchange/en-US/news/article/enterprise-ai-agents-governance-gaps-survey). Deterministic verification where an unrunnable check reports **skipped rather than passed** is a direct, specific answer to exactly that distrust — and that specificity is more persuasive than any market statistic.

**Second-most-likely objection: "two people cannot de-risk this for us."** Partly answerable by the one production reference implementation — which is worth more here than anywhere else, because **no firm at any tier publishes an engagement success rate** (see Q7), so there is no benchmark against which a small practice looks small. Partly answerable by credentialing: Anthropic's Claude Frontier Academy is training 10,000 FDEs largely drawn from customer and partner staff, backed by a **$100m partner network for 2026** — [MindStudio](https://www.mindstudio.ai/blog/anthropic-openai-copying-palantir-forward-deployed-engineer-model). An accredited independent practice is a recognizable shape in that ecosystem rather than an anomaly.

**Third objection, and the one with the sharpest teeth: "this is a golden cage."** The best-documented IDP failure mode is platforms built for control rather than consumption, where mandatory opaque abstractions get routed around, and the field's position is unanimous: **"You cannot mandate adoption; you must compete for it"** — [platformengineering.org](https://platformengineering.org/blog/golden-cage-syndrome-why-internal-developer-platforms-fail). Gartner independently warns that blocking agents pushes people toward riskier shadow use — [SAP News](https://news.sap.com/2026/08/agent-sprawl-why-ai-governance-is-now-board-level-issue/). Risk tiers an author cannot downgrade, blocking reviews and menu-driven consumption instead of a chat box all read as control-first on first inspection. Two features are the rebuttal and should be moved to the front of the pitch rather than listed as details: the **adversarial agent that tries to disprove every blocking finding** is an escape hatch with due process (the cage is arguable, not opaque — addressing the leaky-abstraction failure mode), and **skipped-not-passed** is an explicit anti-vanity-metric (addressing the measuring-output-ignoring-friction failure mode). Equally, the framework should ship **bypass rate** as a headline metric, since the IDP literature identifies tracking installs instead of bypass as a named failure mode — [HackerNoon](https://hackernoon.com/internal-developer-platforms-are-booming-but-adoption-is-failing).

### Honest tradeoffs the evidence surfaces, unprompted

- **The category has no proof yet.** I found no case study measuring outcomes of platform-engineering discipline applied to AI agents, and no consultancy publishing an engagement success rate. The practice is early to a forming category, not late to a crowded one — but that means it must *become* the evidence, and the sales motion carries the full burden of a first mover.
- **No named competitor sells exactly this.** That is either whitespace or a signal the category does not sell standalone. The available evidence cannot distinguish the two, and the boutique data showing governance and enablement bundled *inside* build engagements rather than led with is mildly concerning.
- **The two-person constraint binds revenue to two calendars.** The Team Topologies accredited-partner pattern is the only researched precedent for breaking that, and its licensing terms are not public.
- **Most of the demand-side evidence is vendor-commissioned** (Okta, OutSystems) or self-selected (VB Pulse). The sturdiest independent-ish asset in this entire file is DORA 2025. Build the thesis on it.
