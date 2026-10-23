# ADR 0001: V1 is a kit-only prototype on Node 20 and bash

- Status: accepted
- Date: 2026-10-23
- Decided by: Ely Potter

## Decision

V1 is a prototype of the kit only: the Claude Code plugin, its libraries and the verify harness. It runs on Node 20 and bash.

No Slack runtime, DuckDB or mock CRM until a client asks for one.

## Organising rule

ENGINE / PROFILE / INSTANCE. Generic mechanism ships in `kit/`. Client inputs are declared in `profiles/<client>/`. The two resolve at runtime in an install such as `examples/brightside-install/`. Acceptance test: two installs differ only by profile.

## Consequences

- Tests read client specifics from the profile or fixtures, never from a client's paths. The previous repo's tests kept pinning client specifics, which made the kit hard to generalise.
- No runtime dependencies until a component needs one. Tests use `node:test`.
