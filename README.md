# AP Labs

AP Labs's engagement starter template. AP Labs is a consulting practice that helps companies put AI to work in their day-to-day operations. For each engagement we fork this template, build the client's AI platform and starter tools on it, and train their builders to keep going.

The template is a generalised version of Hometown Ticketing's Varsity platform. Hometown is used as a design reference only; no code or history from it is carried here.

Start with `AGENTS.md`, then `docs/PLAN-v1.md`.

## Layout

- `kit/`: the template's engine: the Claude Code plugin (`kit/plugin/`), libraries (`kit/lib/`) and the verify harness (`kit/verify/`).
- `profiles/`: client profiles and their schema. Brightside Home Cleaning (fictional) is the demo client.
- `examples/brightside-install/`: a fake client repo with the kit installed.
- `test/`: smoke and acceptance tests (`npm test`).
- `docs/adr/`: architecture decisions.
- `docs/reference/03-target-build.md`: the target design (principles and architecture). Start here.
- `docs/reference/02-competitive-research.md`: competitive and industry research.
- `docs/reference/05-discovery-process.md`: how client business rules are captured.
- `docs/reference/research_notes/`: raw research behind 02.

The build plan is `docs/PLAN-v1.md`; scope is `docs/adr/0002-engagement-starter-template.md`.

## Checks

Node 20 or later. Run `npm ci` once.

```
npm run check    # syntax: JS, shell, JSON
npm test         # node:test
npm run verify   # verify harness
```
