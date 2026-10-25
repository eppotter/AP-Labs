I reviewed the branch's changes against origin/main and read AGENTS.md.

The write path in the outbox skips the approval check when the plan file is missing, so a send can run unapproved.

VERDICT: BLOCKING
