---
name: done-means-checkable
description: "Never call a runtime piece \"done\" or \"ready\" when it only passes tests on fakes; report built vs running separately"
metadata:
  node_type: memory
  type: feedback
  originSessionId: a0c59a4d-96ec-4eaf-95c3-a2de82261a5a
  modified: 2026-10-24T20:09:07.583Z
---

When reporting progress, keep "code merged, tests pass on fakes" apart from "running and something Ely can check". Example: Epic 6 (the Slack app) and Epic 7 (the demo data) were reported as done, but no Slack bot existed and no DuckDB had been built on his machine.

**Why:** Ely pushed back on 2026-10-24 with "there's nothing to check yet". A story count overstates progress when nothing has been seen working.

**How to apply:**
- In status tables, use separate labels: "built (tests only)" and "live-checked".
- At each runtime epic boundary, get the piece running for Ely to see before starting the next epic. Agents can build the local DuckDB (`npm run fixture:build`). Slack and MotherDuck need Ely's credentials.
- See [[ap-labs-handoff]].
