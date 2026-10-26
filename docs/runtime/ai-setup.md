# Setting up the AI helper (template dev)

A one-time human step for Ely before the live check after Story 9.4 (DEP-018). Agents never do this: it creates a credential that spends money. CI needs none of it; every test uses a stand-in for the AI.

The bot uses Claude only to fill in the blanks of a form a module already declares. It never writes SQL and never sees data rows. Without a key the AI is off and everything else works: people fill in the form themselves.

## 1. Create the key and its spend cap

1. Go to <https://console.anthropic.com> with the AP Labs email (not a client's) and create an API key named `brightside-bot-dev`.
2. In the console, set a monthly spend cap (suggested: USD 20 for the demo). **This cap is the one that can't be reset by restarting the bot**; the bot's own breaker (below) resets on every restart.

## 2. Store it

| Key | Env var | Keychain item |
| --- | --- | --- |
| Anthropic API key (`sk-ant-…`) | `ANTHROPIC_API_KEY` | `aplabs-anthropic-key` |

Copy the key and tell the agent "copied": it saves it to the Keychain straight from the clipboard and never prints it. Or store it yourself (`-w` last makes `security` prompt, so the key stays out of shell history):

```bash
security add-generic-password -s aplabs-anthropic-key -a aplabs -w
```

Then clear your clipboard. Never paste the key into the repo, the profile, a PR or a chat with an agent. The container reads env only (`APLABS_NO_KEYCHAIN=1`).

## 3. Run it

Start the bot as in `slack-app-setup.md`. The startup line's `ai` field says `on`, or why it is off: `ANTHROPIC_API_KEY not set`, `switched off by APLABS_LLM_OFF`, or `configuration fault` (logged with the reason, for example a context over 40,000 characters).

## What guards the spend

- **The off switch.** `APLABS_LLM_OFF` set to anything but empty or `0` turns the AI off. It is read at startup, so changing it takes a restart.
- **Per person:** 20 AI requests an hour, fixed in the code.
- **The hourly breaker:** `llm.hourly_usd_limit` in the profile (default USD 2). Each call is counted at its worst-case cost when it starts and settled to the real cost when the reply comes. A call that times out or fails, or a reply with no usage figures, stays at worst case. The breaker lives in the bot's memory and **resets on restart**; the console spend cap backs it.
- **Every call** has a token cap (`llm.max_tokens`, default 1024), a 20-second limit and no automatic retries.
- **Prices** are in `kit/runtime/llm/prices.js`. A model the profile names with no price there stops the bot from starting.

## What the AI sees

The client's name, and `org.md` and `data.md` from the profile's context folder with their header block, every `truth` block and every HTML comment removed. Never `guardrails.md` or `connectors.md`, never data rows, and at most 500 characters of what the person typed. Requests and replies are never logged, but they do reach Anthropic.

## How the AI answers

The bot sends one tool, `fill_parameters`, and tells the model to answer only by calling it. The tool is offered, not forced (`tool_choice` is `auto`, one call at most): Claude Sonnet 5.5, Opus 5.5 and Fable 5.1 refuse a forced tool choice with a 400. A reply that does not call the tool counts as a failed read, and the person gets the form with "I couldn't read your request".
