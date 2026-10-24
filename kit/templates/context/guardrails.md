---
owner: ""          # the named client person who owns this file
signed_off: pending  # pending, or the ISO date (YYYY-MM-DD) the owner signed off
signed_off_by: ""  # who signed off: the owner, recorded by a facilitator
updated: ""        # ISO date of the last edit
---

# Guardrails

Written by the Onboarder for Architect. Most of this mirrors `.aplabs/profile.yml`: cite the
profile rather than copy it, and propose profile changes to the Orchestrator instead of editing it.

## Guardrails

<!-- The client's standing rules for any build. One rule card each (below). -->

## Protected systems

<!-- Systems and data no build may change without a named approver, and why. -->

## Write paths

<!-- Every action that writes to a system outside the repo: what it writes, the human gate on it, the kill switch. -->

## Approvers

<!-- Who approves what: name, role, and the scope of their approval. Cite the profile's permissions. -->

## Cost limits

<!-- Spending limits per system or service (API calls, compute, licences) and who is told when one is near. -->

## Rule cards

<!--
One card per rule (docs/reference/05-discovery-process.md §3); typical types here are access_rule,
exception_workflow and data_quality_guard.

### RULE-ID: name
- rule: plain-language statement of the rule, and what it is NOT
- owner: the client person who confirms it
- evidence: where it came from (session, document, system) and how a build can test it
- status: draft | challenged | approved | retired (approved only with the owner's sign-off and date)
-->
