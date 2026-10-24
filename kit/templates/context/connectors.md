---
owner: ""          # the named client person who owns this file
signed_off: pending  # pending, or the ISO date (YYYY-MM-DD) the owner signed off
signed_off_by: ""  # who signed off: the owner, recorded by a facilitator
updated: ""        # ISO date of the last edit
---

# Connectors

Written by the Onboarder for Connector. Record how each system authenticates, never the
credential itself.

## Systems

<!--
One entry per system the client uses:

### System name
- owner: the client person who owns the system
- purpose: what the client uses it for
- auth: the mechanism (OAuth app, service account, API key held in the secret store); never the secret
- read path: the one approved way to read, and its scope
- write path: the one approved way to write, its human gate and kill switch (or "none: read-only")
- bulk path: how large reads or writes are done, if different
- limits: rate limits, batch sizes, row caps, cost per call
- notes: known failure modes and quirks
-->

## Missing connections

<!-- Connections a build needs that do not exist yet, each with the owner who must create it. -->

## Rule cards

<!-- Integration rules in the rule card form (rule, owner, evidence, status), as in guardrails.md. -->
