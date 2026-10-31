---
owner: Ada Owner
signed_off: 2026-10-21
signed_off_by: Ada Owner
updated: 2026-10-21
---

# Guardrails

## Rule cards

<!--
One card per rule.

### RULE-ID: name
- rule: plain-language statement of the rule
- status: approved
-->

### GRD-001: Read only
- rule: RULE_TEXT_NEVER_SHOWN
- owner: Ada Owner
- status: approved

### GRD-002: Draft that mentions approval
- rule: Not yet.
- status: draft (approved 2026-10-25; a line was added since, awaiting sign-off)

### GRD-003: No status line
- rule: Missing its status.

```markdown
### GRD-004: An example inside a code block
- status: approved
```

### GRD-005: Writes only through approval
- owner: Ada Owner
- status: approved

### GRD-006: Approved in prose only
- rule: The words status: approved appear here, but not as its status line.
- status: challenged
