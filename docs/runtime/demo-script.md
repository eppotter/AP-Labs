# The demo script (Story 10.4)

The Win-back demo in Slack, step by step: what you type, and what you should see. It follows `docs/planning/specs/spec-runtime/demo-flow.md`. The same steps run in CI, offline, in `examples/brightside/test/demo-flow.test.js` (fake Slack, a stand-in AI reply, the local fixture).

You play yourself: Ely Potter is Brightside's owner and admin in the demo profile, and Steven Auslander holds every grant Ely holds, so either of you can run it (until 2026-10-31 the owner was a fictional Dana Reyes, played by Ely). Everything the bot shows you is private: it appears in the hub window (a modal) or as a message only you can see, and the CSV arrives in your DM with the bot. Nothing is posted in a channel.

## Before the live demo

1. **The bot is running**, as in `slack-app-setup.md` §3:

   ```bash
   APLABS_PROFILE="$PWD/profiles/brightside/profile.yml" \
     APLABS_APP_DIR="$PWD/examples/brightside/app" npm start
   ```

   It reads the local fixture (`npm run fixture:build` first if it isn't built). Check the startup line: `ai` should say `on`.
2. **Your grant.** Your `aplabs-demo` member id is your user's `identities.slack` in `profiles/brightside/profile.yml` (`ely` or `steven`), and both hold `WIN_BACK` by name (it is owner-only: the admin role alone doesn't give it). Without both, Win-back list isn't in your menu.
3. **The real AI key for step 2.** It is already in the Keychain as `aplabs-anthropic-key` (`ai-setup.md`), so there is nothing to do unless the startup line says `ai: off (ANTHROPIC_API_KEY not set)`. With the AI off, step 2 says so and you use the form instead (see "With the AI off" below).
4. **No ops channel is set** (`slack.ops_channel` is unset in the profile), so a failed push is logged in the bot's terminal only, not posted anywhere. That is fine for the demo, where the push should succeed. To see escalations in Slack, follow "The ops channel" in `slack-app-setup.md` first.
5. **Start clean**: see "Resetting" below.

## The eight steps

| # | You do | You should see |
|---|---|---|
| 1 | Type `/brightside` in any channel or DM. | The Brightside window, listing only what you may use: Dataset, Say hello, Labour cost, Outbox, Unpaid invoices and Win-back list, then Help. In dev it also lists Route map and Plan a route under the Routing header (`routing-map.md`); production waits for Story 15.6 (GRD-002 was signed by Ely Potter on 2026-10-31). |
| 2 | Press **Open** on Win-back list. In the request box type `clients in the North zone whose plan lapsed in the last 90 days, top 25` and press **Read my request**. | "Reading your request…", then step 3. |
| 3 | Check the values. Press **Change** if you want to see the typed form, then **Check values** to come back. | The values the bot understood: Zone north, Lapsed within (days) 90, How many clients 25, with **Confirm** and **Change**. Change opens the form with those values filled in. |
| 4 | Press **Confirm**. | *Running Win-back list…*, then *Win-back list: the top 25 of 38 rows, by score.* The top 10 rows with a score and a one-line reason each (client 730 first, score 86), a **How was this made?** button, a **Push to email tool** button, and a link to the CSV, which is in your DM with the bot. |
| 5 | Press **How was this made?** | The values you confirmed, the data source and version, when it ran, the scoring line, and the exact SQL, with a **Back to the list** button at the end. |
| 6 | Press **Back to the list**, then **Push to email tool**. | Back shows the same list again, exactly as in step 4, with its buttons; nothing runs again and no second CSV arrives. Then a preview: *List name:* `win-back-north-<today's UTC date>`, *Rows to send:* 25 of 25 rows, *Skipped:* none, a sample of 5, and **Approve** and **Cancel**. Nothing has been sent yet. |
| 7 | Press **Approve**. Then press it again. | *Pushed 25 to email tool*, skipped 0, failed 0, and the list name. The second click says you already approved this push, so it ran once and won't be sent again. |
| 8 | Back to the menu, press **Open** on Outbox. | `win-back-north-<date>` · 25 contacts, with the time it arrived and a sample of three contacts (first name and email only). |

### With the AI off

Start the bot with `APLABS_LLM_OFF=1` (or without the AI key). At step 2, **Read my request** shows "The AI helper is switched off right now, so I can't read your request. Please use the form instead." above the form. Pick Zone north, leave Lapsed within at 90, set How many clients to 25 and press **Check values**: the flow continues from step 3 exactly as above.

## Things to know

- **The list name uses the UTC date** of the pull, not your local date and not the fixture's `as_of` (2026-09-30). In the evening in the US it can already be tomorrow's date.
- **The same rows on the same day are "already sent today".** Pull North, top 25, again later the same day and approve it: the bot says *Already sent today; nothing new sent.*, and the outbox doesn't change. To show a fresh push, reset first.
- **Different rows on the same day make a second list with the same name.** For example North, top 10, pushed after North, top 25: the email tool gets two lists called `win-back-north-<date>`, and the Outbox shows both.

## Resetting

Delete the mock email tool's outbox, which is also where it remembers what it has sent:

```bash
rm -f var/outbox/email.jsonl
```

The next push starts fresh, and the Outbox entry says nothing has been sent yet. Restarting the bot also clears any open previews and sessions (they live in memory).
