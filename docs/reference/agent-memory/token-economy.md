---
name: token-economy
description: Ely is on a Pro plan with limited tokens — working rules to keep usage low in this repo
metadata:
  node_type: memory
  type: feedback
  originSessionId: daf9a3b0-3f1d-4817-b6a4-12a3e8e81dd1
  modified: 2026-10-23T17:37:44.664Z
---

Ely is on a Pro account and flagged (2026-10-23) that sessions were burning tokens fast. Cost ≈ tool calls × context size; this repo's always-loaded context was ~49k tokens.

**Why:** limited budget; one long session across four PRs, cold-start subagents (two lost to rate limits) and noisy logs wasted most of it.

**How to apply:**
- Superseded 2026-10-23: Ely wants every stage of a build in ONE session (see [[ap-labs-orchestrator-design]]). Don't suggest fresh sessions between stages. Keep context lean by delegating bulky work to subagents with summaries, and keep the handoff memory current.
- Subagents: use them for heavy stages per the Orchestrator design (one session, delegate bulk). Don't spawn them gratuitously. Use the logged lite path to clear the Orchestrator gate for kit-building work.
- Batch each logical step into one script; avoid grep → sed → edit round-trips.
- Send test output to a file and read only the summary lines; never dump full logs or long file ranges.
- Run the ~10-minute plugin suite once per PR, not repeatedly.
- Model: Ely decided on 2026-10-23 to use Opus for all AP-Labs work. Don't suggest switching models or ask for `/model` changes.
