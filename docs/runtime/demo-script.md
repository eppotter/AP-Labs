# The demo scripts (Stories 10.4 and 18.3)

Two scripts. **Stage 1: v0** (Story 18.3, at the end of this file) teaches the blank `/brightside-v0` bot from the demo pack. **The Win-back demo** (Story 10.4, below) runs on the full `/brightside` hub.

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

## Stage 1: v0

The blank bot, taught in front of the audience (plan brightside-v1, D4, Story 18.3). The point: "It knows nothing, until you teach it." `/brightside-v0` sees no data, no rules and no company context, so everything it answers comes from the four demo-pack files you upload.

### The demo pack

Four files in `examples/brightside/demo-pack/`, built from the fixture by `npm run demo-pack`, so every figure agrees with the data. Copy them to the computer you run Slack on before the demo.

| File | What it holds | Size |
|---|---|---|
| `price-list-2026.pdf` | 1 page: the three packages and five add-ons with their prices | 1.8 KB |
| `service-policies.pdf` | 2 pages: arrival windows, 24 hours' notice to reschedule (no fee), what each package includes, paying, and what happens when a crew is out for the day | 3.6 KB |
| `zone-billing-2026-09.csv` | 5 rows, 4 columns: per zone, invoices issued, billed and cash received in September. The zone is the client's zone. The totals are the signed truths: billed $364,023.50, cash received $350,186.40 | 0.2 KB |
| `complaints-2026-09.csv` | 40 rows, 5 columns: date, zone, crew, category, resolved. Synthetic: no client names, emails, phones or addresses | 1.9 KB |

All four together are about 4,200 characters as notes, well under the hub's 15,000. Each CSV is inside Add context's limits (200 rows, 30 columns, 6,000 characters).

`npm run demo-pack` rebuilds the files and prints the five questions with their expected answers; `npm run demo-pack -- --check` only checks that the committed files are current. The build fails if question 3 or 4 has a tie at the top, or if the billing totals stop matching the signed truths. `examples/brightside/test/demo-pack.test.js` checks that the table of answers below matches the build.

### Before the demo

1. **The bot is running** with the AI on (the startup line says `ai: on`). Reading a PDF and answering a question both use the AI.
2. **You are an admin** in the demo profile (Ely or Steven), so you see Add context and Data sources.
3. **No notes from the last demo.** Type `/brightside-v0`. The first line must read "Knows: nothing yet". If it lists notes, see "Resetting v0" below.

### The steps

| # | You do | You should see |
|---|---|---|
| 1 | Type `/brightside-v0` in any channel or DM. | The Brightside v0 window. The first line reads "Knows: nothing yet"; the second starts "Setup". Rows: Ask, Request a tool, and under Setup, Add context and Data sources. |
| 2 | Press **Help**, then **Back**. | The four tools, each with one line on what it does. Back returns to the menu. |
| 3 | Press **Ask** on the Ask row. Type `Which zone billed the most in September, and how much cash did we receive from that zone in September?` and press **Ask**. | "Thinking…", then: "I can't answer data questions yet. No data is connected, and there are no rules yet for using it safely." This is the "it can't answer" moment. Press **Back**. |
| 4 | Press **Add** on the Add context row. Title `Price list`. Under **Or upload a file**, pick `price-list-2026.pdf`. Press **Add**. | "Reading…", then "Here's what I took from *Price list*:" with the packages and add-ons and their prices. Press **Back**. |
| 5 | **Add** again: title `Policies`, file `service-policies.pdf`, **Add**. | "Here's what I took from *Policies*:" with the arrival windows and the 24 hours' notice. **Back**. |
| 6 | **Add** again: title `Billing by zone, September`, file `zone-billing-2026-09.csv`, **Add**. | "Here's what I took from *Billing by zone, September*: 5 rows, 4 columns", then the table as text. **Back**. |
| 7 | **Add** again: title `Complaints, September`, file `complaints-2026-09.csv`, **Add**. | "Here's what I took from *Complaints, September*: 40 rows, 5 columns". **Back**. |
| 8 | Close the window and type `/brightside-v0` again. | The first line reads "Knows: 4 notes". |
| 9 | Press **Ask** and ask the five questions below, one at a time. Press **Ask another** between them. | Each answer says what the table below says (in the AI's own words), ending with "Not what you needed?". |

### The five questions and their expected answers

| # | Ask | Expected answer | From |
|---|---|---|---|
| 1 | How much is a deep clean, and what does the inside oven add-on cost? | Deep clean $260.00 (base price); Inside oven $35.00. | `price-list-2026.pdf` |
| 2 | How much notice does a customer need to give to reschedule? | 24 hours' notice, and there is no fee. | `service-policies.pdf` |
| 3 | Which zone billed the most in September, and how much cash did we receive from that zone in September? | South: billed $91,558.00 on 470 invoices; cash received in September $91,232.40. | `zone-billing-2026-09.csv` |
| 4 | Which crew had the most late-arrival complaints in September? | West crew B, with 5 late-arrival complaints. | `complaints-2026-09.csv` |
| 5 | How many complaints in September are still unresolved? | 11 of 40. | `complaints-2026-09.csv` |

The runners-up, if someone asks: North billed $86,608.00 (second); West crew A and North crew B had 4 late-arrival complaints each.

**Not live-checked yet.** Ask sorts each question before answering it, and a question about figures ("which zone billed the most") may be sorted as a data question, which on v0 gets the "I can't answer data questions yet" reply even after the CSVs are uploaded. If questions 3 to 5 get that reply at step 9, stop and tell the Orchestrator: it is a known open point from Story 18.3, not a step you did wrong.

### Resetting v0

Press **Add** on Add context. Under *Added here*, press **Remove** on each of the four notes and confirm. Type `/brightside-v0`: "Knows: nothing yet". The files stay in your own Slack files; delete them there if you want.
