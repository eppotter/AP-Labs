# kit/plugin

The Claude Code plugin that ships to clients. Empty in the scaffold; components land one PR each (see `docs/PLAN-v1.md`).

- `hooks/`: write gate, stop-verify, session banner.
- `agents/`: generic specialists.
- `skills/`: the generic rule body.

Nothing here may name a client path. Client specifics come from the profile at runtime.
