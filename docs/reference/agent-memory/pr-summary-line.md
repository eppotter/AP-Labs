---
name: pr-summary-line
description: Every PR description opens with a plain-language "What this does:" summary
metadata:
  type: feedback
---

Every PR description starts with `**What this does:**` followed by 1–2 plain-language sentences saying exactly what the change does, with no jargon or principle IDs. The technical detail goes below it.

**Why:** Ely asked for it on 2026-10-23 after #1–#4 opened with technical bullet lists. The descriptions were hard to scan for what each change actually does.

**How to apply:** Write the summary when creating the PR (`gh pr create --body`), not afterwards. Related: [[ap-labs-handoff]].
