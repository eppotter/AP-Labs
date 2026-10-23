# AP Labs

A governance kit for building AI agent solutions inside client organisations.

Built from scratch, using Hometown Ticketing's Varsity platform as a design reference only. No code or history from that platform is carried here.

## Layout

- `kit/`: the engine that ships to clients: the Claude Code plugin (`kit/plugin/`), libraries (`kit/lib/`) and the verify harness (`kit/verify/`).
- `profiles/`: client profiles and their schema. Brightside Home Cleaning (fictional) is the demo client.
- `examples/brightside-install/`: a fake client repo with the kit installed.
- `test/`: smoke and acceptance tests (`npm test`).
- `docs/adr/`: architecture decisions.
- `docs/reference/03-target-build.md`: the target design (principles and architecture). Start here.
- `docs/reference/02-competitive-research.md`: competitive and industry research.
- `docs/reference/05-discovery-process.md`: how client business rules are captured.
- `docs/reference/research_notes/`: raw research behind 02.

The build plan is still to come (`docs/PLAN-v1.md`).

## Checks

Node 20 or later. No dependencies to install.

```
npm run check    # syntax: JS, shell, JSON
npm test         # node:test
npm run verify   # verify harness
```
