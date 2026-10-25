---
name: ap-labs-business-model
description: What AP Labs actually sells — AI consulting engagements delivered on a generalized Varsity/Orchestrator template; the kit is the means, not the product
metadata:
  type: project
---

Ely explained this on 2026-10-23 after I described the product as a list of governance rules, which missed the point.

**The business:** consulting services for companies that want AI in their day-to-day but don't know how. The common failure, Hometown included: hand out Claude licences and let people figure it out. An engagement:
1. Deep dive on the org.
2. Pick one or more starter problems the org wants AI to handle.
3. Use the generalized Orchestrator/Varsity template to stand up the client's AI platform and build tooling that solves those problems.
4. Train a set of builders inside the org to keep building on the framework, then leave.

**Reference example (Hometown sales):** reps had Salesforce, Apollo, Instantly and Gong, none of which talked to each other. Varsity gave reps Slack modules (their native surface) with tools: pull SFDC contacts in natural language → score leads → build a Gong-format list and push it to Gong, or push to Instantly for email or Apollo for flows.

**Why it matters:** the template = the runtime (surface + modules + connectors to the client's tools) plus the builder governance (the kit in this repo). ADR 0001's "kit only, no Slack runtime" cut builds only the governance half; a demo also needs the end-user half. The Brightside dataset stands in for the client's systems, and starter problems decide which tables it needs. Related: [[ap-labs-handoff]], [[ap-labs-venture]].

**Refined the same day:** AP Labs does the scoping and vibe-codes each client's solution; every org is different, so there is no one-size product. This repo is OUR starter template: the scaffolding and basic building blocks (runtime + builder governance) we fork at the start of each engagement, so we don't rebuild Varsity from scratch every time. Ely built Varsity alone with Claude. Judge every component by whether it's a block we'd want on day one of a new engagement. The synthetic dataset is a dev and demo fixture for exercising the blocks, not a product, so keep it small.
