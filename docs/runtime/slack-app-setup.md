# Setting up the runtime Slack app (template dev)

A one-time human step for Ely before the live check of Epic 6. Agents never do this: it creates credentials. CI needs none of it; every test uses a fake Slack client.

In a client fork, start from `docs/fork-guide.md` (step 5): the fork writes its own app manifest and hub, then creates the app the same way.

The runtime is its **own** Slack app (architecture AD-5). It is not the "AP Labs Orchestrator" app that `npm run notify` posts through: that one is an incoming webhook and keeps its own credential. Don't add bot scopes to it.

## 1. Create the app from the manifest

1. Go to <https://api.slack.com/apps>, choose **Create New App → From a manifest**, and pick the `aplabs-demo` workspace.
2. Paste `examples/brightside/app/slack-manifest.json`. It creates **Brightside Bot (dev)** with Socket Mode on, the seven bot scopes the runtime is allowed (`commands`, `chat:write`, `im:write`, `im:history`, `files:read`, `files:write`, `users:read`), one slash command per hub (`/brightside` and `/brightside-v0`) and the `message.im` event. Don't add scopes by hand: a new scope needs an Architect review.
3. **Install to Workspace** and approve.

## 2. Store the two tokens

| Token | Where in the app settings | Env var | Keychain item |
| --- | --- | --- | --- |
| Bot token (`xoxb-…`) | OAuth & Permissions → Bot User OAuth Token | `SLACK_BOT_TOKEN` | `aplabs-slack-bot-token` |
| App-level token (`xapp-…`) | Basic Information → App-Level Tokens → Generate, scope `connections:write` | `SLACK_APP_TOKEN` | `aplabs-slack-app-token` |

Socket Mode needs **no signing secret**; leave it unused.

On your Mac, store each in the Keychain (`-w` last makes `security` prompt, so the token stays out of shell history):

```bash
security add-generic-password -s aplabs-slack-bot-token -a aplabs -w
security add-generic-password -s aplabs-slack-app-token -a aplabs -w
```

Env vars win over the Keychain when both are set. Never paste a token into the repo, the profile, a PR or a chat with an agent.

## 3. Run it

```bash
APLABS_PROFILE="$PWD/profiles/brightside/profile.yml" \
  APLABS_APP_DIR="$PWD/examples/brightside/app" npm start
```

It logs one startup line naming the client, the profile path and "single instance". Run exactly one copy: two processes would split Slack's events between them. Then send the bot a direct message in `aplabs-demo`; it replies with a short greeting.

If a token or the profile is missing or wrong, it exits non-zero listing each problem by variable name, never by value.

## Later (Story 6.3)

To see menus your profile grants, add your `aplabs-demo` member id (Profile → ⋯ → Copy member ID) to a Brightside user's `identities.slack` in `profiles/brightside/profile.yml`. It's an id, not a secret.

## The ops channel (Story 10.3)

A failed push (some contacts refused, an outage, a rejected sign-in, a list key reused with other rows, or a kill switch flipped partway) posts one quiet note to an ops channel: the module, a fixed reason and counts only, never client data. It is the runtime's only channel post. Without an ops channel the note goes to the bot's log only, and the person's reply is the same either way.

1. In `aplabs-demo`, create `#brightside-ops` (private is fine).
2. Invite the bot: in the channel, type `/invite @Brightside Bot (dev)`. **No new scope is needed**: `chat:write` covers a channel the bot has been invited to. If it isn't invited, Slack refuses the post (`not_in_channel`), which is logged and never shown to the person.
3. Copy the channel id: open the channel's details (click its name); the id is at the bottom and starts with `C` (or `G` for an old private channel). It's an id, not a secret.
4. Put it in `profiles/brightside/profile.yml` (a reviewed profile change; update `examples/brightside/test/profile.test.js` with it):

   ```yaml
   slack:
     ops_channel: C0123456789
   ```

   The schema accepts only a channel id (`^[CG][A-Z0-9]{8,}$`): a channel name like `#brightside-ops`, a DM id (`D…`) or a person (`U…`) is refused at boot. The same module and reason are posted at most once every 15 minutes.
