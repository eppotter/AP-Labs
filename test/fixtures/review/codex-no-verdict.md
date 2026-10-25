I reviewed the branch's changes against origin/main and read AGENTS.md.

Findings:

- **[P2] Published time is shown as raw UTC** — `examples/app/modules/dataset/handler.js:45` — The ISO timestamp is hard to read in Slack.
- **[P2] Missing test for the local source** — `examples/test/dataset-module.test.js:76` — Only the remote path checks the Published line.
