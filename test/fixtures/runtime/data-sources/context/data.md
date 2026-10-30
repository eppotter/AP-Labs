---
owner: Ada Owner
signed_off: 2026-10-20
signed_off_by: Ada Owner
updated: 2026-10-20
---

# Data canon

DATA_PROSE_NEVER_SHOWN.

## Known truths

```truth
id: active-people
statement: There are this many active people.
run: ["node", "-e", "console.log('RUN_ARG_NEVER_SHOWN')"]
expect: 987654321
owner: Ada Owner
signed_off: 2026-10-20
```

```truth
id: open-jobs
statement: Open jobs at month end <b>&</b>.
run: ["node", "-e", "console.log(24680)"]
expect: 24680135
tolerance: "1%"
owner: Bo Owner
signed_off: pending
```
