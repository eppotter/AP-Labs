# The demo scripts (Stories 10.4, 18.3, 19.9 and 20.4)

Four scripts. **Stage 1: v0** (Story 18.3) teaches the blank `/brightside-v0` bot from the demo pack. **Stage 2: v1** (Story 19.9) shows `/brightside-v1` on the real data: its rules, its route skills and Ask answering by query. **Stage 3: live** (Story 20.4, at the end of this file) shows the full `/brightside` hub acting: it emails customers, after a person approves the exact text. **The Win-back demo** (Story 10.4, below) also runs on the full `/brightside` hub.

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

The blank bot, taught in front of the audience (plan brightside-v1, D4, Story 18.3; the demo pack rebuilt around three business questions). The point: "It knows nothing, until you teach it, and then it answers questions worth money." `/brightside-v0` sees no data, no rules and no company context, so everything it answers comes from the five demo-pack files you upload. Each of the three questions needs a PDF and a CSV together: the policy or plan in the PDF, the numbers in the CSV.

### The demo pack

Five files in `examples/brightside/demo-pack/`, built from the fixture (as of 2026-09-30) by `npm run demo-pack`, so every figure agrees with the data. Copy them to the computer you run Slack on before the demo. The CSVs are totals only: no client names, emails, phones or addresses. The memo's author is invented.

| File | What it holds | Size |
|---|---|---|
| `2026-mid-year-pricing-and-operations-memo.pdf` | 3 pages: the operations manager's memo of June 12, 2026. It announces the July 1 price increase (about 8% on average) and why, expects no more than 20 extra cancellations, says how the increase will be judged in September, sets the schedule standard (a crew stays within 8% of its scheduled staff time in a month), and lists the package and add-on prices | 8.2 KB, 3,238 characters |
| `customer-service-agreement-2026.pdf` | 2 pages: the customer terms. What each package includes, plan price changes, arrival windows, 24 hours' notice to reschedule (no fee), cancelling a plan, net 14 payment by card or bank transfer (ACH), the late-payment table (a late fee of 1.5% a month past 30 days), and what happens when a crew is out | 6.7 KB, 2,879 characters |
| `plan-changes-2026.csv` | 9 rows, 8 columns: per month, January to September 2026, the price increases and their average %, plans cancelled and their yearly value, active plans at month end, and of each month's increases, the plans still active on 2026-09-30 and the yearly value they add | 0.6 KB, 591 characters |
| `receivables-aging-2026-09-30.csv` | 6 rows, 11 columns: per zone and for all zones, open invoices and the open balance by days past due (not yet due, 1-30, 31-60, 61-90, over 90), total open, past due, over 30 days past due and how many invoices that is. The total open is the signed truth, $198,753.25 | 0.7 KB, 709 characters |
| `crew-time-vs-schedule-2026-09.csv` | 15 rows, 7 columns: per crew, its zone, completed September visits, scheduled and actual staff-minutes, % over schedule, and the wages for the time over schedule | 0.8 KB, 808 characters |

All five together are about 8,200 characters as notes, well under the hub's 15,000 (the build allows at most 13,000). Each CSV is inside Add context's limits (200 rows, 30 columns, 6,000 characters), and each PDF's text is under the 6,000-character file limit. The hub keeps the AI's reading of a PDF, not the file, so a PDF note may be a little shorter or longer than the count above.

`npm run demo-pack` rebuilds the files and prints the three questions and the follow-ups with their expected answers; `npm run demo-pack -- --check` only checks that the committed files are current. The build fails if a ranking an answer uses has a tie, if the receivables or the active plans stop matching the signed truths, if the memo's churn expectation stops being clearly missed, or if a crew sits within 0.3 points of the 8% standard. `examples/brightside/test/demo-pack.test.js` works the three answers out again from the fixture and checks that the tables below match the build.

How the answers are worked out (also in the memo, section 3, and at the top of `build.js`):

- **Question 1.** Extra cancellations: plans cancelled in July to September, less three times the January to June monthly average. Their cost: the same for the cancelled plans' yearly value (price per visit times visits a year: weekly 52, every two weeks 26, monthly 12). The gain: the yearly value the July increases add on the plans still active on 2026-09-30. It paid off if the gain is more than the cost.
- **Question 2.** An invoice's open balance is its total less payments made by 2026-09-30. Days past due count from the due date (net 14). The late fee is 1.5% of the balance more than 30 days past due, for one month.
- **Question 3.** September's completed visits, one timesheet row per person per visit. Scheduled staff-minutes are the visit's scheduled minutes for each person on it. Wages for time over schedule are each person's minutes over (or under) schedule at their hourly rate on the day, so an early finish counts against an overrun.

### Before the demo

1. **The bot is running** with the AI on (the startup line says `ai: on`). Reading a PDF and answering a question both use the AI.
2. **You are an admin** in the demo profile (Ely or Steven), so you see Add context and Data sources.
3. **No notes from the last demo.** Type `/brightside-v0`. The first line must read "Knows: nothing yet". If it lists notes, see "Resetting v0" below.

### The steps

| # | You do | You should see |
|---|---|---|
| 1 | Type `/brightside-v0` in any channel or DM. | The Brightside v0 window. The first line reads "Knows: nothing yet"; the second starts "Setup". Rows: Ask, Request a tool, and under Setup, Add context and Data sources. |
| 2 | Press **Help**, then **Back**. | The four tools, each with one line on what it does. Back returns to the menu. |
| 3 | Press **Ask** on the Ask row. Type `Did our July price increase cost us customers? Was it worth it?` and press **Ask**. | "Thinking…", then: "I can't answer data questions yet. No data is connected, and there are no rules yet for using it safely." This is the "it can't answer" moment: the bot knows nothing about the business yet. Press **Back**. |
| 4 | Press **Add** on the Add context row. Leave **Title** empty. Under **Or upload files**, pick all five files at once: `2026-mid-year-pricing-and-operations-memo.pdf`, `customer-service-agreement-2026.pdf`, `plan-changes-2026.csv`, `receivables-aging-2026-09-30.csv` and `crew-time-vs-schedule-2026-09.csv`. Press **Add**. | "Reading 1 of 5: 2026-mid-year-pricing-and-operations-memo.pdf…", then "Reading 2 of 5", and so on: the files are read one after another, the two PDFs by the AI (each takes a little while), the CSVs at once. Then "Added all 5 files. Ask can use them now." and one line for each file, each with **Remove**, named after the file without its extension: *2026-mid-year-pricing-and-operations-memo* and *customer-service-agreement-2026*, each with the start of what was taken (the July increase; the packages and terms), then *plan-changes-2026*: 9 rows, 8 columns, *receivables-aging-2026-09-30*: 6 rows, 11 columns, and *crew-time-vs-schedule-2026-09*: 15 rows, 7 columns. A file that wasn't added says why on its own line ("Not added: …"), and the others are still added. Press **Back**. |
| 5 | Close the window and type `/brightside-v0` again. | The first line reads "Knows: 5 notes". |
| 6 | Press **Ask** and ask the three questions below, one at a time, starting with step 3's question again. Press **Ask another** between them. | Each answer says what the table below says (in the AI's own words, and it may round), ending with "Not what you needed?". |
| 7 | Take a follow-up or two from the audience (the second table below). | Each answer as in that table. |

### The three questions and their expected answers

| # | Ask | Expected answer | From |
|---|---|---|---|
| 1 | Did our July price increase cost us customers? Was it worth it? | Yes, it cost customers, and no, it did not pay off. July to September had 190 plan cancellations, 87 more than three times the January to June average of 34.3 a month; the memo expected no more than 20 extra. Those extra cancellations were worth $449,182.00 a year. The increase added $113,778.00 a year on the 304 increased plans still active on 2026-09-30. Net: $335,404.00 a year less. | `2026-mid-year-pricing-and-operations-memo.pdf` (the expectation and the method) and `plan-changes-2026.csv` (the counts and values) |
| 2 | How much are customers past due, and how much could we collect in late fees under our terms? | Past due: $103,280.65 of the $198,753.25 open on 1,136 invoices. More than 30 days past due: $63,103.15 on 347 invoices. At the agreement's 1.5% a month, that is $946.55 in late fees a month. | `customer-service-agreement-2026.pdf` (net 14 and the late fee) and `receivables-aging-2026-09-30.csv` (the balances) |
| 3 | Which crews ran furthest over schedule in September, and what did it cost us in wages? | Central crew C ran furthest over: 9.7% over its scheduled staff time (24,592 minutes against 22,410 on 99 visits), $793.02 in wages. West crew A was next at 9.1%, $1,003.24, the largest wage cost. Only Central crew C and West crew A break the memo's 8% standard. North crew C kept closest to schedule, 0.5% over. All crews together: $8,077.31 in wages for time over schedule. | `2026-mid-year-pricing-and-operations-memo.pdf` (the 8% standard) and `crew-time-vs-schedule-2026-09.csv` (the minutes and wages) |

The AI does the arithmetic in questions 1 and 2 from the notes, so check its figures against the table: the counts and the dollar amounts should match to the cent, or be rounded. If it works question 1 a different way (for example, comparing only July and August), ask it to "use the memo's method"; section 3 of the memo pins it.

All three ask for figures, which Ask sorts as data questions. On v0 no data is connected, so Ask first checks the notes: when they hold the answer it answers from them; when they don't, it says "I can't answer data questions yet" as in step 3.

### Follow-ups an audience might ask

| Ask | Expected answer | From |
|---|---|---|
| What did the memo expect the increase to add if every plan stayed? | About $156,000 a year. | `2026-mid-year-pricing-and-operations-memo.pdf` |
| Which zone owes the most that is more than 90 days past due? | North: $14,622.15. | `receivables-aging-2026-09-30.csv` |
| What happens when a customer is more than 60 days past due? | Their visits pause until the balance is paid. After 90 days we may pass the balance to a collection agency. | `customer-service-agreement-2026.pdf` |
| How much notice does a customer need to give to reschedule? | 24 hours' notice, and there is no fee. | `customer-service-agreement-2026.pdf` |
| How much is a deep clean, and what does the inside oven add-on cost? | Deep clean $260.00 per visit (base price); Inside oven $35.00. | `2026-mid-year-pricing-and-operations-memo.pdf` |

### Resetting v0

Press **Add** on Add context. Under *Added here*, press **Remove** on each of the five notes and confirm. Type `/brightside-v0`: "Knows: nothing yet". The files stay in your own Slack files; delete them there if you want.

`/brightside-v1` shares v0's notes (plan brightside-v1, D6, Story 19.2): a note added on either hub shows on both, and removing it on either removes it from both. Reset once, on either hub.

## Stage 2: v1

The same bot on the real data (plan brightside-v1, Stories 19.1 to 19.8). The point: "Now it knows the company, follows its rules, and plans routes." `/brightside-v1` sees the company context, the data and the signed rules, and shares v0's notes. It has five route skills. Ask sends route questions to a route skill, and answers data questions by running a query built only from signed query rules. The route skills only suggest: nothing is booked or changed.

Run it after Stage 1, so the five demo-pack notes are there. Everything you see is private to you.

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
| First line | "Knows: 5 notes · 1 source · 7 truths · 10 rules" (without the Stage 1 notes, "Knows: 1 source · 7 truths · 10 rules") |
| Second line, small grey text | "All 7 tools working" |
| Welcome, first visit only | "Brightside on your real data: it knows the company, follows its rules, and plans routes." |
| **Routing** | Add a stop (**Run**), Customer cancellation (**Run**), Crew out (**Run**), Route map (**View**), Optimize a route (**Run**) |
| **Tools** | Ask (**Ask**), Request a tool (**Request**) |
| **Setup · admins only** | Add context (**Add**, "5 notes"), Data sources (**View**) |
| Bottom | Help |

### The steps

| # | You do | You should see |
|---|---|---|
| 1 | Type `/brightside-v1` in any channel or DM. | The Brightside v1 window, as in "The v1 menu" above. |
| 2 | Press **View** on Data sources. | *Connected data:* "local fixture: brightside.duckdb, available". *Known truths and rules:* data.md and guardrails.md each "signed off 2026-10-31 by Ely Potter", "Rule cards approved: 10", "Query rules signed: 7", then the known truths: seven "Signed off 2026-10-25", each "Last check passed" with the date you ran the checks, and the rest "Awaiting sign-off". *Added context (shared with Brightside v0):* the five notes from Stage 1. Press **Back**. |
| 3 | Press **Ask**. Type `How much notice does a customer need to give to reschedule?` and press **Ask**. | "Thinking…", then: 24 hours' notice, and no fee (from the Customer service agreement note). It ends "Not what you needed?". Press **Ask another**. |
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

Before you start: steps 1 to 6 of "Before the demo" above, and the five demo-pack notes from Stage 1 on `/brightside-v0`.

1. Type `/brightside-v1`. The first line reads "Knows: 5 notes · 1 source · 7 truths · 10 rules". The second reads "All 7 tools working".
2. Look at the rows. Routing: Add a stop, Customer cancellation, Crew out, Route map, Optimize a route. Tools: Ask, Request a tool. Setup · admins only: Add context ("5 notes"), Data sources. Help at the bottom.
3. Press **View** on Data sources. You see the local fixture "available"; data.md and guardrails.md signed off by Ely Potter; "Rule cards approved: 10"; "Query rules signed: 7"; seven known truths signed off, each "Last check passed"; and the five notes under "Added context (shared with Brightside v0)".
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
24. Type `/brightside-v0`. The first line reads "Knows: 6 notes", and Add context lists the new note.
25. Remove that note on `/brightside-v0`, then type `/brightside-v1`. The first line reads "Knows: 5 notes" again.
26. Type `/brightside-v0` and look at it. It is as after Stage 1: "Knows: 5 notes"; Ask and Request a tool; Add context and Data sources under Setup.
27. Type `/brightside`. It has the same groups and tools as before Epic 19 (Lists, Routing, Tools). Its first line ends "1 source · 7 truths · 10 rules": 10, not 8, since GRD-009 and GRD-010 were signed (Stories 19.7 and 20.1). Both hubs read the same rule file.
28. Open the Slack app's settings (api.slack.com/apps, Brightside Bot (dev)). Slash Commands lists `/brightside`, `/brightside-v0` and `/brightside-v1`. OAuth & Permissions lists the same seven bot scopes as `examples/brightside/app/slack-manifest.json`.

Not checked live: a crew lead's and a member's view of v1 (there are no real ones), and Ask's limits (10 query answers an hour each, one at a time). The tests cover them.

## Stage 3: live

The full `/brightside` hub (plan brightside-v1, Stories 20.1 to 20.3). The point: "Now it acts, and a person approves every word." v1 reads and suggests; the live hub also emails customers: an appointment reminder for a day's visits, and a change notice when a route skill moves a booked visit. Both come from fixed templates (no AI writes them), so the preview is exactly what is sent. Nothing is sent until you press **Approve**, and every email goes to the mock email tool's outbox, each to a `.invalid` address. Nothing leaves the building.

The figures below come from the local fixture, checked by driving the hub through the test helpers; `examples/brightside/test/appointment-reminders.test.js` and `change-notices.test.js` assert the same counts. The customer names are the fixture's, all synthetic.

### Before the demo

1. **The bot is running,** started as in "Before the live demo" above, with `APLABS_ENV` unset: Appointment reminders, Change notices and the route skills show only in dev. Run `npm run fixture:build` first if you haven't since you last updated to the latest `main`.
2. **You are Ely or Steven.** Both hold `APPOINTMENT_EMAILS` and `ROUTING_ALL_CREWS` by name in the profile (the admin role alone gives neither).
3. **The outbox is empty:** see "Resetting the outbox" below. Otherwise emails sent earlier the same day are not sent again, and step 8 sends nothing.

**Crew names.** The pickers show crews by name: crew 2 is **North crew B**, crew 4 is **South crew A** and crew 7 is **East crew A**. The data's "today" is 2026-09-30, so visits are booked from 2026-10-01.

### The live menu

| Line or group | What it shows |
|---|---|
| First line | "Knows: 1 source · 7 truths · 10 rules" |
| Second line, small grey text | "All 13 tools working" |
| **Customers** | Appointment reminders (**Review**), Change notices (**Review**) |
| **Lists** | Labour cost (**Run**), Unpaid invoices (**Run**), Win-back list (**Review**) |
| **Routing** | Add a stop, Customer cancellation, Crew out (each **Run**); Plan a route, Route map (each **View**) |
| **Tools** | Dataset (**View**), Say hello (**Run**), Outbox (**View**) |
| Bottom | Help |

### The steps

| # | You do | Say to the client | You should see |
|---|---|---|---|
| 1 | Type `/brightside` in any channel or DM. | "This is the live hub: the same company, the same rules, and now it can act." | The Brightside window, as in "The live menu" above. |
| 2 | Press **View** on Outbox. | "This is the email tool's outbox. Nothing has gone out yet." | "*Email outbox*" and "Nothing has been sent to the email tool yet." Press **Back**. |
| 3 | Press **Review** on Appointment reminders. Pick Day **2026-10-03** and Zone or crew **east**, press **Check values**. | "Reminders for one day's visits in the East zone. You pick a day and a zone, or one crew." | "Check these values. Nothing runs until you press *Confirm*.", Day 2026-10-03, Zone or crew east, with **Confirm** and **Change**. |
| 4 | Press **Confirm**. | "It pulls every booked visit that day from the schedule." | "*Appointment reminders: 13 rows.*", the first 10 visits in a table, "The full list (13 rows) is a CSV in your DM with me.", and **Push to email tool**. |
| 5 | Press **Push to email tool**. | "This is a dry run: the email tool has written every email and sent none of them." | "*Push Appointment reminders to email tool?* Check it before you approve.", then "*List name:* appointment-reminders-<today's UTC date>", "*Rows to send:* 7 of 13 rows", "*Skipped:* 6: held (6)". |
| 6 | Scroll down the preview. | "Six visits are held: a member of East crew A is off that day. It won't remind a customer of a visit that may not happen." | "*Held, not sent: 6.*" and "• Held: a member of East crew A is absent that day. Check Crew out first. (6)" over a table of the six (Glen, Ash, Alder, Sky, Cedar, Yarrow, all East crew A). Then "*What will be sent (7):*": Rain, Ash and Lark on East crew B; Meadow, Ridge, Juniper and Coral on East crew C. |
| 7 | Keep scrolling. | "Here is every email, word for word. No AI writes these: it's a fixed template, so what you see is what they get." | "*Email 1 of 7, exactly as it will be sent:*" to "*Email 7 of 7, …*", each in full (Email 1 is in "The two emails" below). No email address shows. At the bottom: "Nothing is sent until you press Approve. Skipped and held rows are never sent. This preview expires in 30 minutes.", with **Approve** and **Cancel**. |
| 8 | Press **Approve**. | "A person has signed off, so now it sends." | "*Pushed 7 to email tool*, skipped 6, failed 0. List: appointment-reminders-<date>." and "Skipped rows were never sent: held (6)." |
| 9 | Press **Back** until you are at the menu, then **View** on Outbox. | "Seven reminders, each to the customer's address. These are test addresses: nothing left the building." | "*Appointment emails sent*, newest first (latest 7 of 7):" and seven lines, each "<time> UTC · reminder · <name>…@….invalid · Reminder: your Deep clean on Saturday, October 3, 2026" (or Standard clean). Press **Back**. |
| 10 | Run steps 3 to 5 again (2026-10-03, east) and press **Approve**. | "Someone presses it twice, or a colleague runs the same list. Nobody gets two reminders." | The preview again shows 7 to send. After Approve: "*Already sent today; nothing new sent.* email tool already has this list with these rows, so I didn't send it again (skipped 6). List: appointment-reminders-<date>." The Outbox still lists 7. |
| 11 | Back at the menu, press **Run** on Crew out. Pick **2026-10-03** and **East crew A**, press **Mark out for the day**. | "That's the crew with someone off. Plan the day without them." | "*East crew A is out on Saturday 2026-10-03 in the data,* so this is the plan for it.", with **Notify affected customers (5)** and **Change crew or day**, the zone's map, and "6 stops to place; 5 placed in their zone, 1 recommended for another zone, 0 to rebook; 1 existing stop to confirm a new time." |
| 12 | Press **Notify affected customers (5)**. | "Five customers' visits changed crew or time. It drafts a notice for each: a different email from the reminder." | The Change notices preview, on top of the route (its **Back** returns to the route): "These routes are suggestions: nothing is saved in the schedule. Sending tells customers their visit changed, so change the booking too.", "*Rows to send:* 5 of 6 rows", "*Skipped:* 1: held (1)". |
| 13 | Scroll down the preview. | "The visit going to another zone isn't emailed: someone decides that first. Coral's visit moves later but stays in the afternoon, so that's not a change and she gets no notice." | "*Held, not sent: 1.*" and "• Recommended for another zone, not placed. Decide first; no email is sent. (1)" (Glen). "*What will be sent (5):*": Ash, Cedar, Sky and Yarrow to East crew C; Alder to East crew B. Then five emails, each with "- Crew: East crew C (before: East crew A)" (Alder's: East crew B) and "Why: our team for that day is unavailable."; Ash's and Alder's also have "- Arrival window: afternoon (before: morning)". |
| 14 | Press **Approve**. | "Same rule: nothing went until now." | "*Pushed 5 to email tool*, skipped 1, failed 0. List: change-notices-<date>." and "Skipped rows were never sent: held (1)." |
| 15 | Press **Back** until you are at the menu, then **Run** on Customer cancellation. Pick **North crew B** and **2026-10-02**, press **Show visits**, pick the "(cancelled)" visit, then press **Fill with #1**. | "A cancellation opens a gap. It pulls a later visit forward to fill it." | Finch Swifthall's visit at 12:30, marked "↩️ Moved up from 2026-10-05 to fill the gap; call to confirm", and **Notify affected customers (1)** beside **Optimize** and **Reset to booked**. |
| 16 | Press **Notify affected customers (1)**, read the email, press **Approve**. | "Same template, a different reason: the reason line always matches what happened." | "*Rows to send:* 1 of 1 row", "*Skipped:* none", and one email to Finch with "- Day: Friday, October 2, 2026 (before: Monday, October 5, 2026)", "- Arrival window: afternoon (before: morning)" and "Why: an earlier slot opened up." After Approve: "*Pushed 1 to email tool*, skipped 0, failed 0." |
| 17 | Press **Back** until you are at the menu, then **View** on Outbox. | "Every email, reminders and notices, each to a test address. Nothing left the building." | "*Appointment emails sent*, newest first (latest 10 of 13):": Finch's change notice, the five crew-out notices ("change notice · … · Your Standard clean has changed: now Saturday, October 3, 2026"), then four of the seven reminders. |

**Optional, a third reason line.** **View** on Plan a route: South crew A, 2026-10-01, **Show stops**, then **Optimize** ("Optimized: drive 4 h 10 → 2 h 37 (−93 min), back 18:46 → 17:01"). **Notify affected customers (3)**: Moss, Meadow and Rain each change arrival window, each "Why: we've improved the day's route." Press **Cancel** to show a way out: "*Change notices cancelled.* Nothing was sent to email tool. Press *Back* to return to the route."

### The two emails

The reminder only confirms the booking ("East crew B will arrive in the morning."), while the change notice lists what changed with the old value beside the new ("- Crew: East crew C (before: East crew A)"), gives the reason and apologises.

Step 7's Email 1, exactly:

```
Subject: Reminder: your Deep clean on Saturday, October 3, 2026

Hi Rain,

This is a reminder of your Deep clean on Saturday, October 3, 2026. East crew B will arrive in the morning.

Need to change it? Reply to this email, or call us on 555-0100, and we'll find a time that suits you.

The Brightside Home Cleaning team
```

Step 13's Email 1, exactly:

```
Subject: Your Standard clean has changed: now Saturday, October 3, 2026

Hi Ash,

We've changed your Standard clean. It is now on Saturday, October 3, 2026, in the afternoon, with East crew C.

What changed:
- Arrival window: afternoon (before: morning)
- Crew: East crew C (before: East crew A)

Why: our team for that day is unavailable.

Sorry for the change.

Reply to this email, or call us on 555-0100, and we'll find a time that suits you.

The Brightside Home Cleaning team
```

An email holds only the first name, the day, morning or afternoon, the crew's name, the package and, for a change, what it was before (GRD-010). Never an address, a price, another customer or a staff name.

### The off switch

`BRIGHTSIDE_EMAIL_OFF` stops every appointment email (`APLABS_WRITES_OFF` stops every write the bot makes). The bot checks it when you press **Approve**, so set it when you start the bot: stop the bot, start it again with `BRIGHTSIDE_EMAIL_OFF=1` in front of the start command, run steps 3 to 5 and press **Approve**. You see "Sending to Brightside email tool (mock) is switched off right now, so nothing was sent. Please tell your admin." The outbox does not change and the preview is not used up. Stop the bot and start it without the switch to send again; a restart clears open previews, so run the list again.

### Things to know

- **A preview lasts 30 minutes.** Approve after that and the bot says the preview is no longer valid; run it again.
- **The list name uses the UTC date** of the run, as for Win-back.
- **The same emails on the same day are sent once.** Step 10 shows it for a whole list, and a double-click on **Approve** also sends once. A different change to the same visit is a new email.
- **The Outbox shows the latest 10 emails:** the time, the kind, the address and the subject, never the body. The full text is in the preview, before you approve.
- **Limits:** at most 50 emails a push and 200 a day, counted in the outbox. One run of this script sends 13.
- **Held reminders:** pick **East crew A** alone in step 3 and there is nothing to approve: "*Nothing to push to email tool.* All 6 rows would be skipped: held (6)."
- **A day on or before 2026-09-30** has no booked visits: no rows, nothing to push.
- **Review on Change notices** in the menu only explains: "Change notices start from a route: open a Routing tool, and when its suggestion changes a booked visit's day, arrival window or crew, press *Notify affected customers* on the result. Nothing was sent."

### Resetting the outbox

There is no reset command. Stop the bot, then delete the mock email tool's outbox, which is also where it remembers what it has sent:

```bash
rm -f var/outbox/email.jsonl
```

Run it in the folder you start the bot from (with `APLABS_VAR_DIR` set, the file is under that folder instead). It also clears any Win-back lists pushed earlier. Start the bot again: the Outbox says "Nothing has been sent to the email tool yet." Routes need no reset: the route skills save nothing.

### The live check (Ely or Steven, dev Slack)

**Untested until you run it.** Run it after Epic 20 has merged, from your own account (Steven may repeat any step from his). Each step is one action and what you should see. If a step differs, stop and tell the Orchestrator the step number and what you saw.

Before you start: update the bot to the latest `main`, run `npm run fixture:build`, stop the bot, run `rm -f var/outbox/email.jsonl`, and start the bot as in "Before the live demo" (dev: `APLABS_ENV` unset).

1. Type `/brightside`. The first line reads "Knows: 1 source · 7 truths · 10 rules", the second "All 13 tools working". Customers lists Appointment reminders and Change notices; Routing lists Add a stop, Customer cancellation, Crew out, Plan a route and Route map.
2. Press **View** on Outbox. "Nothing has been sent to the email tool yet."
3. **Review** Appointment reminders: 2026-10-03, east, **Check values**, **Confirm**, **Push to email tool**. "*Rows to send:* 7 of 13 rows" and "*Skipped:* 6: held (6)"; the six East crew A visits listed as held; seven emails in full, the first "Hi Rain,"; no email address.
4. Press **Approve**. "*Pushed 7 to email tool*, skipped 6, failed 0."
5. **View** Outbox. Seven lines, each "reminder", a `.invalid` address and "Reminder: your … on Saturday, October 3, 2026".
6. Repeat step 3 and press **Approve**. "*Already sent today; nothing new sent.*" The Outbox still lists 7.
7. **Run** Crew out: 2026-10-03, East crew A, **Mark out for the day**. The button reads **Notify affected customers (5)**.
8. Press it. "*Rows to send:* 5 of 6 rows"; Glen held as "Recommended for another zone, not placed"; five emails, each "Why: our team for that day is unavailable." with a "- Crew: … (before: East crew A)" line. Press **Approve**: "*Pushed 5 to email tool*, skipped 1, failed 0."
9. **Run** Customer cancellation: North crew B, 2026-10-02, **Show visits**, the "(cancelled)" visit, **Fill with #1**, **Notify affected customers (1)**. One email to Finch with "- Day: Friday, October 2, 2026 (before: Monday, October 5, 2026)" and "Why: an earlier slot opened up."
10. Double-click **Approve**. "*Pushed 1 to email tool*" (a second click may say "You already approved this push…"). **View** Outbox: "latest 10 of 13", Finch's notice once, at the top.
11. **View** Plan a route: South crew A, 2026-10-01, **Show stops**, **Optimize**, **Notify affected customers (3)**. Three emails, each "Why: we've improved the day's route." Press **Cancel**: "*Change notices cancelled.* Nothing was sent to email tool." The Outbox still says 13.
12. Stop the bot and start it with `BRIGHTSIDE_EMAIL_OFF=1` in front of the start command. Run step 3 again and press **Approve**. "Sending to Brightside email tool (mock) is switched off right now, so nothing was sent. Please tell your admin." The Outbox still says 13. Restart the bot without the switch.

Not checked live: a crew lead's and a member's view (there are no real ones; neither gets Notify or the reminders), the 50-a-push and 200-a-day limits, an expired preview, and a partial failure with **Retry the failed ones**. The tests cover them.
