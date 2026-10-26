# ADR 0002: V1 is our engagement starter template

- Status: accepted
- Date: 2026-10-23
- Decided by: Ely Potter
- Supersedes: the scope of [ADR 0001](0001-prototype-scope.md)

## Context

ADR 0001 scoped V1 to the build-governance kit and excluded the runtime ("no Slack runtime"). That framed the repo as a product. It isn't one.

AP Labs is a consulting practice. Each engagement does a deep dive on the client, picks starter problems, builds the client's AI platform and tools, and trains the client's builders to carry on. Every org is different, so the deliverable is built per client. What saves time is a starting point that already has the building blocks the reference platform took months to grow.

## Decision

V1 is **our engagement starter template**: a generalised version of a reference client's platform that we fork on day one of each engagement. It has three parts:

1. **Runtime blocks:** what the client's people use. A Slack app shell, a hub registry, a module contract, access wiring, an LLM service, a connector pattern, SQL guardrails, two module archetypes (scoped pull, approval-gated write) and Slack UX basics.
2. **Build governance:** what our builders and the client's builders use. The profile, permissions, tier, write gate, verify harness and the Orchestrator protocol.
3. **A dev fixture:** Brightside Home Cleaning, a fictional client. Synthetic data, sized to exercise the blocks, with a mock connector. Built offline from versioned seed data, with a published copy online for collaborators.

Client modules are built in the client's fork, never in the template. The test for any component is whether we'd want it on day one of a new engagement.

Runtime stays Node and bash (Node 24 LTS since ADR 0004; was Node 20). The fixture's toolchain is an open item in PLAN-v1 §5.

## Consequences

- PLAN-v1 is re-cut around building blocks (§4). The runtime blocks move from "not doing" to the front of the order.
- ENGINE / PROFILE / INSTANCE from ADR 0001 still holds, now per fork: two forks differ only in their profile and their own modules.
- One fictional company (Brightside) serves as both the demo client and the fixture.
- No production warehouse, production data or live client integration in the template. Real connectors are written in the fork against the client's systems, from the connector template.
