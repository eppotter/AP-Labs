# The demo scripts (Stories 10.4, 18.3 and 19.9)

Three scripts. **Stage 1: v0** (Story 18.3) teaches the blank `/brightside-v0` bot from the demo pack. **Stage 2: v1** (Story 19.9, at the end of this file) shows `/brightside-v1` on the real data: its rules, its route skills and Ask answering by query. **The Win-back demo** (Story 10.4, below) runs on the full `/brightside` hub.

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

Questions 3 to 5 ask for figures, which Ask sorts as data questions. On v0 no data is connected, so Ask first checks the notes: when they hold the answer it answers from them; when they don't, it says "I can't answer data questions yet" as in step 3.

### Resetting v0

Press **Add** on Add context. Under *Added here*, press **Remove** on each of the four notes and confirm. Type `/brightside-v0`: "Knows: nothing yet". The files stay in your own Slack files; delete them there if you want.

`/brightside-v1` shares v0's notes (plan brightside-v1, D6, Story 19.2): a note added on either hub shows on both, and removing it on either removes it from both. Reset once, on either hub.

## Stage 2: v1

The same bot on the real data (plan brightside-v1, Stories 19.1 to 19.8). The point: "Now it knows the company, follows its rules, and plans routes." `/brightside-v1` sees the company context, the data and the signed rules, and shares v0's notes. It has five route skills. Ask sends route questions to a route skill, and answers data questions by running a query built only from signed query rules. The route skills only suggest: nothing is booked or changed.

Run it after Stage 1, so the four demo-pack notes are there. Everything you see is private to you.

### Before the demo

1. **Once, ever: add `/brightside-v1` to the Slack app.** Ely does this, as in `slack-app-setup.md` ("Adding a hub's command to the app you already have"):
   1. Open api.slack.com/apps and pick **Brightside Bot (dev)**.
   2. Click **Slash Commands**, then **Create New Command**.
   3. Command `/brightside-v1`, short description `Open the Brightside v1 menu`, no usage hint, escaping off. **Save**.
   4. If Slack asks you to reinstall the app, click it and allow. Then restart the bot.
2. **The local data is current.** Run `npm run fixture:build` if you haven't since you last updated to the latest `main`. The route skills and Ask's queries read this file.
3. **Run the checks, within 7 days of the demo,** on the computer the bot runs on, in the same folder:

   ```bash
   APLABS_PROFILE="$PWD/profiles/brightside/profile.yml" npm run verify
   ```

   It takes several minutes: it runs the unit tests first, then one line per check. Every `truth:` and `query-rule:` line must say PASS. Ask runs a query only when every signed known truth passed this check in the last 7 days. If not, it answers "The data and rules are set up, but not every known truth has passed its check on this machine in the last 7 days, so I won't run a query. Run `npm run verify`, then ask again."
4. **The bot is running** with the AI on, started as in "Before the live demo" above (the startup line says `ai: on`). Leave `APLABS_ENV` unset: the route skills show only in dev.
5. **You are Ely or Steven.** Both are admins, dispatchers (`ROUTING_ALL_CREWS`) and cleared for Ask's queries (`ASK_DATA`), by name in the profile.
6. **The review queue is empty,** so step 19 shows only today's question:

   ```bash
   APLABS_PROFILE="$PWD/profiles/brightside/profile.yml" npm run query-rules -- --queue
   ```

   It should say "The review queue is empty." If it lists questions from an earlier demo, clear each one with `APLABS_PROFILE="$PWD/profiles/brightside/profile.yml" npm run query-rules -- --done <id>`.

**Crew names.** The pickers show crews by name, not number: crew 2 is **North crew B**, crew 4 is **South crew A** and crew 7 is **East crew A**. The data's "today" is 2026-09-30, so the route days are the next three days.

### The v1 menu

| Line or group | What it shows |
|---|---|
| First line | "Knows: 4 notes · 1 source · 7 truths · 10 rules" (without the Stage 1 notes, "Knows: 1 source · 7 truths · 10 rules") |
| Second line, small grey text | "All 7 tools working" |
| Welcome, first visit only | "Brightside on your real data: it knows the company, follows its rules, and plans routes." |
| **Routing** | Add a stop (**Run**), Customer cancellation (**Run**), Crew out (**Run**), Route map (**View**), Optimize a route (**Run**) |
| **Tools** | Ask (**Ask**), Request a tool (**Request**) |
| **Setup · admins only** | Add context (**Add**, "4 notes"), Data sources (**View**) |
| Bottom | Help |

### The steps

| # | You do | You should see |
|---|---|---|
| 1 | Type `/brightside-v1` in any channel or DM. | The Brightside v1 window, as in "The v1 menu" above. |
| 2 | Press **View** on Data sources. | *Connected data:* "local fixture: brightside.duckdb, available". *Known truths and rules:* data.md and guardrails.md each "signed off 2026-10-31 by Ely Potter", "Rule cards approved: 10", "Query rules signed: 7", then the known truths: seven "Signed off 2026-10-25", each "Last check passed" with the date you ran the checks, and the rest "Awaiting sign-off". *Added context (shared with Brightside v0):* the four notes from Stage 1. Press **Back**. |
| 3 | Press **Ask**. Type `How much notice does a customer need to give to reschedule?` and press **Ask**. | "Thinking…", then: 24 hours' notice, and no fee (from the Policies note). It ends "Not what you needed?". Press **Ask another**. |
| 4 | Ask `What was paid revenue in September 2026?` | A bold label and **$350,186.40**. Under it, "From signed rule QR-003 (reviewed query)." and "Source: brightside.duckdb, as of 2026-09-30. 1 row. Tables: payments." There may also be a line saying the AI's own query agreed (if it disagreed, the figure shown is still the signed rule's). |
| 5 | Press **Show the query**. | "The signed rule's query (QR-003, reviewed):" and its SQL. Press **Back to the answer**: the same answer again. Press **Ask another**. |
| 6 | Ask `What did we bill in September 2026?` | **$364,023.50**, "From signed rule QR-004 (reviewed query)." |
| 7 | Ask `How many plans are active today?` | **815**, "From signed rule QR-001 (reviewed query)." If the AI's own query counted only plans marked active, it says it disagreed and "It gave 814.": the signed figure, 815, stands. |
| 8 | Ask `What do clients owe us right now?` | **$198,753.25**, "From signed rule QR-005 (reviewed query)." |
| 9 | Ask `How many plans are active today, by zone?` | A table of five zones: central 117, east 168, north 184, south 196, west 150 (815 in all). Under it, "From signed rule QR-006 (reviewed query)." or "Composed from QR-001 and QR-006 (AI-written, checked); not itself a signed rule." |
| 10 | Ask `Crew 4's stops on October 1 zig-zag. Can you fix the order?` | "*Optimize a route* can help with that. Press Run to use it.", with a **Run** button. |
| 11 | Press **Run**. Pick **South crew A** and **2026-10-01**, then press **Show stops**. | Seven stops in their booked order, leaving from and back at the Office, the map, and the totals (Drive, Distance, Back at Office, Rule breaks). Note the Drive time. |
| 12 | Press **Optimize**. | The stops reorder, the map redraws, and "Optimized: drive …, back …" shows at the top. The Drive time is shorter than in step 11: the booked day zig-zags between towns. Nothing is saved. Press **Back** until you are at the menu. |
| 13 | Press **Run** on Customer cancellation. Pick **North crew B** and **2026-10-02**, press **Show visits**, then open the list of visits. | The crew's five visits, each "time · client name". The afternoon one ends "(cancelled)". |
| 14 | Pick the "(cancelled)" visit. | "…'s visit at … is cancelled in the data. These could fill its gap.", the gap on the map, and exactly two visits that could fill it, with **Fill with #1** and **Fill with #2**. #1 is the best fill (property 762's client). |
| 15 | Press **Fill with #1**. | The day with that client's visit in the gap, marked "↩️ Moved up from …". Press **Back** until you are at the menu. |
| 16 | Press **Run** on Crew out. Pick **2026-10-03** and **East crew A**, press **Mark out for the day**. | "East crew A is out on … in the data, so this is the plan for it." The zone's map, 5 of its visits placed on the zone's other crews, and one line "Recommended for another zone, not placed: …". No "To rebook" line. Press **Back** to the menu. |
| 17 | Press **Run** on Add a stop. Pick **South crew A** and **2026-10-01**, press **Show stops**, then **Add a stop**. Type two letters of a client's name and pick one. Leave the length at **1 h** (60 minutes, already chosen), pick **Afternoon**, press **Add**. | The search lists up to 20 clients of the crew's zone, each "name · city". After Add, the stop joins the day after 12:00, marked "➕ Added stop: a suggestion only, nothing is booked". The map redraws, and a line names other crews in the zone that could take it (or says "No other crew in the zone has room for it."). Press **Remove added stop**: the day as before. Press **Back** to the menu. |
| 18 | Press **Ask**. Ask `List the clients with the highest unpaid balance and their emails.` | No list and no emails: "The data and rules are ready, but no signed query rule covers that yet, so I won't guess. I've noted the question for the team. Press Request a tool if you need it sooner." |
| 19 | In a terminal on the bot's computer, run `APLABS_PROFILE="$PWD/profiles/brightside/profile.yml" npm run query-rules -- --queue`. | One line: an id, today's date, `brightside-v1`, a reason, and step 18's question. No figures and no client details. SQLsmith turns questions like this into new signed rules. |
| 20 | Back in Slack, press **Request a tool** under step 18's answer. Type why you need it, press **Preview**, then **Post**. | A preview of exactly what will post, with **Post**, **Edit** and **Cancel**. After Post: "Posted. The AP Labs team will pick it up." In `#ai-build-requests`: "*New build request:* …", "From @you on the Brightside v1 hub", and your own words. |

The bold label above a figure is the AI's wording and may differ. The figure, the "From signed rule" or "Composed from" line and the "Source:" line are the bot's own and must match.

### Resetting v1

- **Notes:** v1 shares v0's notes. Reset once, on either hub, as in "Resetting v0".
- **The review queue:** clear step 18's question with `APLABS_PROFILE="$PWD/profiles/brightside/profile.yml" npm run query-rules -- --done <id>`, using the id from step 19.
- **Routes:** nothing to reset. The route skills save nothing, and closing a window deletes its map files.
- **The post in `#ai-build-requests`:** delete it in Slack if you want.

### The v1 live check (Ely or Steven, dev Slack)

**Untested until you run it.** Run it after Epic 19 has merged, from your own account (Steven may repeat any step from his). Each step is one action and what you should see. If a step differs, stop and tell the Orchestrator the step number and what you saw.

Before you start: steps 1 to 6 of "Before the demo" above, and the four demo-pack notes from Stage 1 on `/brightside-v0`.

1. Type `/brightside-v1`. The first line reads "Knows: 4 notes · 1 source · 7 truths · 10 rules". The second reads "All 7 tools working".
2. Look at the rows. Routing: Add a stop, Customer cancellation, Crew out, Route map, Optimize a route. Tools: Ask, Request a tool. Setup · admins only: Add context ("4 notes"), Data sources. Help at the bottom.
3. Press **View** on Data sources. You see the local fixture "available"; data.md and guardrails.md signed off by Ely Potter; "Rule cards approved: 10"; "Query rules signed: 7"; seven known truths signed off, each "Last check passed"; and the four notes under "Added context (shared with Brightside v0)".
4. Press **Back**, then **Ask**. Ask `Crew 4's stops on October 1 zig-zag. Can you fix the order?`. The answer names Optimize a route, with **Run**.
5. Press **Run**. Pick South crew A and 2026-10-01, press **Show stops**. You see seven stops, the map and the Drive time.
6. Press **Optimize**. The order changes, the map redraws, and the Drive time is shorter than in step 5.
7. Go back to the menu and press **View** on Route map. Its four views work as on `/brightside`.
8. Run **Customer cancellation**: North crew B, 2026-10-02, **Show visits**, then pick the "(cancelled)" visit. Exactly two visits could fill the gap, and #1 is property 762's client.
9. Press **Fill with #1**. That visit shows in the gap, marked "↩️ Moved up from …".
10. Run **Crew out**: 2026-10-03, East crew A, **Mark out for the day**. It says the crew is out in the data. 5 visits are placed in the zone and 1 is recommended for another zone.
11. Run **Add a stop**: South crew A, 2026-10-01, **Show stops**, **Add a stop**, a client from the search, 1 h, Afternoon, **Add**. The stop joins after 12:00, marked ➕.
12. Press **Remove added stop**. The day is as before.
13. Ask `What was paid revenue in September 2026?`. You see $350,186.40 and "From signed rule QR-003 (reviewed query)."
14. Press **Show the query**. You see the signed rule's SQL. **Back to the answer** returns to the answer.
15. Ask `What did we bill in September 2026?`. You see $364,023.50 from QR-004.
16. Ask `How many plans are active today?`. You see 815 from QR-001.
17. Ask `What do clients owe us right now?`. You see $198,753.25 from QR-005.
18. Ask `How many plans are active today, by zone?`. You see central 117, east 168, north 184, south 196, west 150.
19. Ask `List the clients with the highest unpaid balance and their emails.`. You see the refusal ("…no signed query rule covers that yet, so I won't guess. I've noted the question for the team.…") with **Request a tool**, and no emails.
20. In a terminal, run `APLABS_PROFILE="$PWD/profiles/brightside/profile.yml" npm run query-rules -- --queue`. Step 19's question is listed with `brightside-v1`, and no figures.
21. Ask `What does Brightside do when a crew is out?`. You get an answer from the company context, ending "Not what you needed?".
22. Press **Request a tool** under that answer, type a line, press **Preview**, then **Post**. It appears in `#ai-build-requests` with your name and "Brightside v1".
23. On `/brightside-v1`, press **Add** on Add context, type a title and a line of text, press **Add**. You see "Added. Ask can use it now."
24. Type `/brightside-v0`. The first line reads "Knows: 5 notes", and Add context lists the new note.
25. Remove that note on `/brightside-v0`, then type `/brightside-v1`. The first line reads "Knows: 4 notes" again.
26. Type `/brightside-v0` and look at it. It is as after Stage 1: "Knows: 4 notes"; Ask and Request a tool; Add context and Data sources under Setup.
27. Type `/brightside`. It has the same groups and tools as before Epic 19 (Lists, Routing, Tools). Its first line ends "1 source · 7 truths · 10 rules": 10, not 8, since GRD-009 and GRD-010 were signed (Stories 19.7 and 20.1). Both hubs read the same rule file.
28. Open the Slack app's settings (api.slack.com/apps, Brightside Bot (dev)). Slash Commands lists `/brightside`, `/brightside-v0` and `/brightside-v1`. OAuth & Permissions lists the same seven bot scopes as `examples/brightside/app/slack-manifest.json`.

Not checked live: a crew lead's and a member's view of v1 (there are no real ones), and Ask's limits (10 query answers an hour each, one at a time). The tests cover them.
