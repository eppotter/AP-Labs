# ADR 0001: V1 is a kit and shared synthetic-data prototype on Node 20 and bash

- Status: superseded in part by [ADR 0002](0002-engagement-starter-template.md) (scope) and by [ADR 0004](0004-node-24.md) (Node: V1 runs on Node 24 LTS, not Node 20). The organising rule and test conventions below still apply.
- Date: 2026-10-23
- Decided by: Ely Potter

## Decision

V1 is a prototype of the kit and its shared synthetic-data test environment: the Claude Code plugin, its libraries, the verify harness, an online DuckDB dataset, and a mock CRM adapter. It runs on Node 20 and bash.

The shared DuckDB dataset must be accessible to Ely and at least one teammate across locations. MotherDuck Lite is the leading hosting candidate, subject to validation of its current plan, access controls, and collaboration workflow. Use synthetic, fictional records only.

No Slack runtime, production warehouse or data, or live CRM integration until a client asks for one and the integration is scoped separately. The CRM vendor remains undecided. Automated tests use isolated local DuckDB databases seeded from versioned synthetic data, so CI does not depend on the online service or its credentials.

## Organising rule

ENGINE / PROFILE / INSTANCE. Generic mechanism ships in `kit/`. Client inputs are declared in `profiles/<client>/`. The two resolve at runtime in an install such as `examples/brightside-install/`. Acceptance test: two installs differ only by profile.

## Consequences

- Tests read client specifics from the profile or fixtures, never from a client's paths. The previous repo's tests kept pinning client specifics, which made the kit hard to generalise.
- No runtime dependencies until a component needs one. Tests use `node:test`; add and pin DuckDB dependencies when implementing the shared dataset and local test fixture.
- Shared-service credentials stay outside the repository, profiles, agent-visible data, and logs. Each collaborator uses an approved user-scoped authentication method. CI remains offline-capable and does not require shared-service credentials.
- Data and CRM acceptance scenarios use synthetic records and run without client credentials, production data, or a live CRM service.
