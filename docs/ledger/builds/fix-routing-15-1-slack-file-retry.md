| PR | Date | Story | Kind | Tier | Summary | DEPs |
|---|---|---|---|---|---|---|
| pending | 2026-10-26 | 15.1 | fix | T1 | Live-check fix: when Slack refuses a freshly uploaded map file in the window ("invalid slack file"), the bot tries again after 1, 2, 3 and 4 seconds and logs which attempt worked; if Slack never takes it, the window says the map couldn't be shown (with Back), the file is deleted at once and one clear log line names the attempts and Slack's messages. Other errors are not retried. The fake Slack can now refuse a file that is not ready yet, the way the real API did. | — |
