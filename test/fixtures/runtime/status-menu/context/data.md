---
owner: Ada Owner
signed_off: 2026-10-20
signed_off_by: Ada Owner
updated: 2026-10-20
---

# Data canon

## Known truths

```truth
id: active-people
statement: There are this many active people.
run: ["node", "-e", "console.log(12)"]
expect: 12
owner: Ada Owner
signed_off: 2026-10-20
```

```truth
id: open-jobs
statement: Open jobs at month end.
run: ["node", "-e", "console.log(3)"]
expect: 3
owner: Bo Owner
signed_off: pending
```
