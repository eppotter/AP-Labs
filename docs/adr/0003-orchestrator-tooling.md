# ADR 0003: Orchestrator tooling and review

- Status: accepted
- Date: 2026-10-23
- Decided by: Ely Potter

## Decision

1. **The Orchestrator is built first.** It is the scaffolding every other block is built through. This changes PLAN-v1 §4's order, which put it last.
2. **Use proven tools off the shelf rather than writing our own.** Install BMAD for planning and vendor p3-stack for build → ship, both at pinned versions (BMAD 6.12.4, p3-stack `09909eb`) and unmodified apart from p3 path fixes. A thin AP Labs rules layer decides which skill runs at which stage ([design §4](../orchestrator/DESIGN.md#4-tooling-bmad-plans-p3-builds-decided)).
3. **Review is cross-model by default:** Claude ↔ Codex, with a P1/P2 rubric, a script-enforced 3-round budget, the Refuter on every P1, and a same-model fallback when a client has no Codex ([design §5](../orchestrator/DESIGN.md#5-review-cross-model-by-default-decided)).
4. **The roster:** Varsity's specialists plus a new **Onboarder** that trains SQLsmith, Architect and Connector per client. The Leadership Panel is removed.

## Why

- Ely prefers skills that others have built, tested and use widely over home-grown ones.
- BMAD covers *what* to build, and its documents double as engagement deliverables. p3 covers *how* an agent builds, proves and ships. Each is weak where the other is strong.
- Cross-model review caught real bugs on this repo's own PRs (#3, #5). CanonCRM's budgets came from measured runaway review loops (17 and 16 rounds) that the budget now prevents.

## Consequences

- About 100 installed skills, of which about 15 are routed to. The rest are inert clutter we accept.
- Each client needs Codex alongside Claude for the default review. Budget for the review's token cost.
- The review script and budgets are ours to maintain. They come from Ryan's CanonCRM adapter, not from p3 upstream.
