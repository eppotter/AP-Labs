# Epic 9, ask for data in plain English: plan for Ely

Status: **approved** by Ely (`approve plan epic-9`, 2026-10-25), with the recommended decisions. Architect design review and plan review done 2026-10-25, all findings folded in.

The stories and their acceptance criteria are the ones you approved in the runtime phase plan (#52, `epics-runtime.md` Epic 9). This plan adds what has changed since then: the bot reads MotherDuck (#110), hubs open as Slack modals (#113), the labour data (#117), the tier floors (#115), and the architect's review.

**In short:**
1. A person picks a list from the `/brightside` menu, types what they want in their own words (or fills in a short form), checks what the bot understood, and gets a private result with a CSV in their DM.
2. The AI (Claude) only fills in the blanks of a form the module already declares. It never writes SQL and never sees the data rows. It has a spend limit, a per-person limit and an off switch. When it is off, the form still works.
3. Seven stories: the six you approved, plus a new 9.7, "Labour cost". Four are T3 (five if you accept decision 4), so each gets the full review. You have four decisions to make (below).

## What you're approving

- [ ] **The six stories as approved in #52, plus 9.7**, in the build order below.
- [ ] **The new tiers.** The epics said 9.1 was T2 and the rest T1. Computed today: **9.1, 9.3, 9.5 and 9.7 are T3**, 9.4 is T2 (T3 if you accept decision 4), and 9.2 and 9.6 are T1 (table below).
- [ ] **A new key for the bot:** an Anthropic API key, `ANTHROPIC_API_KEY` (Keychain: `aplabs-anthropic-key`), with a spend cap you set in the Anthropic console. The bot's own breaker (default USD 2 an hour) sits in front of it.
- [ ] **The model: `claude-sonnet-5-5`** (Claude Sonnet 5.5) for both settings (`llm.model` and `llm.extraction_model`). The bot makes one short "fill in these blanks" call per request. Sonnet does that well at a fraction of Opus's price. You can switch to `claude-opus-5-5` later with one profile line (T3).
- [ ] **New profile settings** under `llm` (all optional): `model`, `extraction_model`, `hourly_usd_limit` (default 2), `max_tokens` (default 1024). Reviewed like any profile change.
- [ ] **New menu entries need new profile rows:** "Win-back list" (9.3), "Unpaid invoices" (9.5) and "Labour cost" (9.7) each need a resource key in Brightside's profile (`WIN_BACK`, `UNPAID_INVOICES`, `LABOUR_COST`). That is why those stories are T3.
- [ ] **Results show in the hub modal** (the window `/brightside` opens), with private (ephemeral) replies as the fallback, as #113 set up. The CSV always goes to the person's DM.
- [ ] **The AI stays inside the engine.** Modules can't call it directly in V1, so no module can hand it data rows.
- [ ] **Your four decisions** below.

## The stories

| Story | Who runs it | Size | Tier | You will see |
|---|---|---|---|---|
| 9.1 The AI service, with a spend breaker and off switch | Builder | M | **T3** | Nothing in Slack yet. Tests prove it refuses when it is off, over budget or over the per-person limit |
| 9.2 Slack formatting and chunking | Builder | S | T1 | Long answers arrive whole and readable, never cut off |
| 9.3 A typed form, no AI | Builder | M | **T3** | "Win-back list" on `/brightside`: a short form, then your values with Confirm and Change |
| 9.4 Plain English fills the form | Builder | M | T2 (**T3** with decision 4) | Type "North zone, lapsed in the last 90 days, top 25" and see those three values to confirm |
| 9.5 The query runs, results arrive privately | Builder | M | **T3** | A count and the first rows in the modal, a CSV in your DM, and a second entry, "Unpaid invoices" |
| 9.6 "How was this made?" | Builder | S | T1 | A button that shows your confirmed values, the exact SQL, the data source and when it ran |
| 9.7 Labour cost | Builder | S | **T3** | "Labour cost" for admins only: ask "what did labour cost in September?" and get the total |

**Tiers.** Computed by the Orchestrator with `node kit/lib/tier`, using the Brightside profile, on each story's file list below. What raises each one:

- **9.1 T3:** the profile schema (`profiles/**` is T3 in Brightside's profile) and the profile reader (`kit/lib/profile/**`, an engine floor since #115). The AI code itself (`kit/runtime/llm/**`) is T2 today. Decision 4 would make it T3.
- **9.3 T3**, **9.5 T3** and **9.7 T3:** each adds a resource row to `profiles/brightside/profile.yml`. Everything else they touch is T1.
- **9.4 T2:** the structured call lives in `kit/runtime/llm/**`. It becomes T3 if you accept decision 4.
- **9.2 T1** and **9.6 T1:** Slack helpers and the scoped-pull engine only.
- No story edits `kit/runtime/data/**`, `kit/runtime/sql/**` or `kit/lib/secrets/**`. If a builder finds it must, that story becomes T3 and comes back to you.

What T3 means here: a plan review (`bmad-review`), an architect design review, and a full code review. 9.4 gets the architect review either way.

## Build order

1. 9.2 and 9.1 in parallel.
2. 9.3, after 9.2 merges.
3. 9.5. It can be checked live without the key.
4. 9.6.
5. 9.4, then the live check with the real key.
6. 9.7.

Everything from 9.3 on runs one story at a time. Those stories share the scoped-pull engine and `kit/runtime/slack/hubs.js`.

### Story 9.1: the AI service, with a spend breaker and off switch

**Acceptance criteria:**

- **The key.** It is read once at startup through `kit/lib/secrets` (env `ANTHROPIC_API_KEY`, else Keychain `aplabs-anthropic-key`) and registered with the log redactor. If it is missing, the AI is off and the app still boots.
- **Settings.** The profile gains the optional `llm` settings above. A configured model with no entry in the price table fails a test. The builder records the model's prices in `prices.js`, with the date they were checked on Anthropic's pricing page.
- **What the AI is told.** The client's name and two context files, `org.md` and `data.md`, from the profile's context folder. Before sending, each file loses its header block and every fenced `truth` block. A test proves no truth SQL or expected figure reaches the AI. `guardrails.md` and `connectors.md` are never sent. Context over 40,000 characters is refused as a configuration fault. The person's request is capped at 500 characters.
- **The AI stays inside the engine.** It is not exposed on `kit/runtime/sdk` in V1, and a grep test enforces this. So no module can pass it data rows.
- **Refusals**, checked before anything is sent, in this order:
  1. The off switch. Any non-empty `APLABS_LLM_OFF` other than `0` turns the AI off. Changing it takes a restart.
  2. The per-person limit: 20 calls an hour, a fixed number in the code, counted in the store's `ratelimit` area with a check and a count in one step (so two clicks at once can't both slip through).
  3. The hourly spend limit.

  The module gets a typed error that turns into a plain message and the form. The AI is called only after the access check has said the person may use the module.
- **The breaker fails closed.**
  - When a call starts, the breaker counts its worst-case cost. When the reply arrives, it settles to the real cost. So two calls at once can't overshoot. A test fires two calls that each fit alone and expects the second refused.
  - Input is estimated high: characters ÷ 3 tokens.
  - A call that times out, or a reply with no usage figures, is counted at its worst-case cost, never at 0.
  - The SDK never retries on its own (`maxRetries: 0`) and has an explicit 20-second time limit. Every call has a token cap.
  - The breaker resets on restart. The setup note says the console spend cap backs it.
- **No AI tool can touch data.** A tool must declare `effects: "none"` or it is refused (tested).
- The Anthropic SDK is pinned exactly, with its reason.
- Tests use a stand-in for the AI. No test calls a real model.

**Changed since the epics:** T2 became T3 (above). The architect's fail-closed and engine-only rules are added. Brightside has no `org.md` yet, only `data.md` (see Risks).

**Files:** new `kit/runtime/llm/` (`index.js`, `prices.js`, `context.js`); `kit/runtime/errors.js` and `kit/runtime/messages.js` (`LlmUnavailable`); `kit/runtime/app/index.js` (reads the key at startup); `profiles/_schema/profile.schema.json`; `kit/lib/profile/index.js` (defaults); `package.json`, `package-lock.json`; a setup note under `docs/runtime/`; `architecture-runtime.md` (computed tiers and stack rows brought up to date); `docs/ledger.md`; tests under `test/unit/` and `test/fixtures/`. With decision 4, also `kit/lib/tier/index.js` and its test.

### Story 9.2: Slack formatting and chunking

**Acceptance criteria:**

- Markdown (headings, bold, links, lists, code) turns into Slack's formatting. Long text is split on line breaks into sections under 2,900 characters.
- Thread history is not fed to the AI in V1 (a thread can hold result rows, and rows never reach the AI).
- Tests cover each conversion, a long body, a body with no line break, and a code block split across sections.

**Changed since the epics:** the hub modal (#113) already splits text at Slack's 3,000-character section limit (`splitText` in `kit/runtime/slack/modal.js`). This story makes one splitter that both use, not a second one.

**Files:** new `kit/runtime/slack/format.js`; `kit/runtime/slack/modal.js`; `kit/runtime/sdk/index.js`; `test/unit/` tests.

### Story 9.3: a typed form, no AI

**Acceptance criteria:**

- A list module (a "scoped pull") declares its inputs in its manifest: name, type, allowed values or min and max, default, required. A bad declaration (an unknown type, an impossible range) stops startup, naming the module and the input.
- A text input must declare its allowed values, or a pattern and a maximum length. Otherwise startup stops. (So nothing a person types can turn into unexpected text in Slack or the query.)
- A person opens the module and fills in a form. Values are checked against the declarations, then shown back privately with Confirm and Change.
- **How the form works in Slack.** The form has no Submit button. "Check values" and "Read my request" are ordinary buttons. The bot reads what was typed from the open view (`body.view.state`). Each click in a module view updates that same view (`views.update` on `body.view.id`, with `body.view.hash`) through a new update-only helper in `modal.js`, and never opens a new one. If Slack says the view changed meanwhile (`hash_conflict`), the out-of-date result is dropped and logged.
- Each open form is a session bound to that person, carried in the buttons. After 30 minutes idle it closes, and a later click is told it expired.
- Confirm uses up the session before the query runs, so a double click or a replay runs the query once. The second click is told it is running or done. A click by someone else is refused.
- The first user is the Brightside example "Win-back list" (`examples/brightside/app/modules/win-back/`).
- Tests cover a full form, a bad value, Change, Confirm, double Confirm, another person's click, two open sessions for one person, and expiry.

**Changed since the epics:** the form lives inside the module's view in the hub modal (#113). Today every click acknowledges with an empty reply, which would close a view on Submit, and every click opens a new view. Hence buttons and in-place updates. The manifest schema already has the input fields, so this story adds the range and text-input checks and turns on the scoped-pull engine (startup refuses it today). The new menu entry needs a `WIN_BACK` resource row in the profile, hence T3.

**Files:** new `kit/runtime/archetypes/scoped-pull/` (`index.js`, `params.js`, `session.js`, `form.js`); `kit/runtime/registry/index.js`; `kit/runtime/slack/hubs.js`, `kit/runtime/slack/modal.js`, `kit/runtime/slack/handle.js`; `kit/runtime/errors.js`, `kit/runtime/messages.js`; `kit/templates/module.md`; new `examples/brightside/app/modules/win-back/` (manifest, SQL, test); `profiles/brightside/profile.yml` (`WIN_BACK`); `docs/ledger.md`; tests.

### Story 9.4: plain English fills the form

**Acceptance criteria:**

- One AI call (no back-and-forth tool use) returns values for the module's declared inputs only. Each is checked against its declaration before it is shown with Confirm and Change. Anything the AI returns that wasn't declared is dropped.
- The request goes to the AI as clearly marked data, through one tool, `fill_parameters`, declared `effects: "none"`. It is the only tool sent and the model is told to answer only by calling it; it is not forced (`tool_choice` is `auto`), because the models we use refuse a forced choice (plan `ai-tool-choice`). The AI can only fill that in.
- On "Read my request", the view first changes to "Reading your request…", then the AI call runs, then the view is updated with the result.
- A missing required value, or one out of range: the bot asks one plain question instead of guessing. A second miss opens the form. The question is written by the bot from the input's label, never by the AI. Values are shown as plain text, so nothing in them can format or link in Slack.
- The AI is off, over budget, or the person is over their limit: they are told plainly and given the form.
- The Win-back example extracts zone = North, lapsed within 90 days, limit 25 from a stand-in reply.
- Tests cover a full request, an undeclared value, a missing value, an out-of-range value and each fallback.

**Changed since the epics:** the follow-up question is a text box in the same view. Slack lets the bot open a new view only within 3 seconds of a click, and an AI call can take longer, so the bot always updates the view it already has.

**Files:** new `kit/runtime/archetypes/scoped-pull/extract.js`; `kit/runtime/llm/index.js` (the structured call); `kit/runtime/slack/hubs.js`; `kit/runtime/messages.js`; the Win-back test; tests.

### Story 9.5: the query runs, results arrive privately

**Acceptance criteria:**

- The confirmed values are bound into the module's fixed SQL file as named parameters (never pasted into the text) and run through the query runner and the SQL checker. The person sees the row count and the first rows.
- The engine stops at 5,000 rows and says "first 5,000 of N". Every number input declares a maximum.
- The CSV of all rows returned goes only to the person's DM; the reply links to it. A test checks the upload goes to the DM.
- Query rows never reach the AI (a test watches the AI service).
- At startup every module's SQL is checked without connecting to the data: the SQL checker, plus a scan that matches each `$name` in the SQL to a declared input. One that fails stops startup, naming the module. A test checks no SQL file contains `${`.
- A blocked query, a query error, "data unavailable" or zero rows: the person gets a plain message saying which, and nothing partial is passed off as complete.
- A second example, "Unpaid invoices" (using the `outstanding-at-as-of` definition), uses the same engine with only a manifest and a SQL file.
- Tests on a temporary copy of the data check the exact rows for a scripted request on both modules.

**Changed since the epics:** the runner already binds named parameters and refuses undeclared ones (#70, #110), so this story uses it as is. With MotherDuck, "data unavailable" is a real case to test. Results show in the module view. The CSV still goes to the DM, since a modal can't hold a file. The new entry needs an `UNPAID_INVOICES` resource row, hence T3. This story needs no AI key, so you can check it live straight away.

**Files:** new `kit/runtime/archetypes/scoped-pull/` (`run.js`, `deliver.js`, `csv.js`); `kit/runtime/app/index.js` (the startup SQL check); `kit/runtime/registry/index.js`; `kit/runtime/slack/hubs.js`; `kit/runtime/messages.js`; new `examples/brightside/app/modules/unpaid-invoices/`; `profiles/brightside/profile.yml` (`UNPAID_INVOICES`); `docs/ledger.md`; tests.

### Story 9.6: "How was this made?"

**Acceptance criteria:**

- Every list result has a "How was this made?" button. The run record is kept for 24 hours, keyed by run id, in exactly the shape the architecture sets: `{ runId, person, module, parameters, sql, source, fixtureVersion, ranAt, rowIds, rows }`. `rows` is filled only for a module that pushes somewhere (Epic 10).
- The person who ran it sees privately their confirmed values, the exact SQL that ran, the data source and data version, and the time.
- After 24 hours the button says the details are gone, rather than failing.
- The record serves this button and the Epic 10 preview only. A push never reads it.
- Tests cover the shown SQL matching the SQL run, the record's shape, another person clicking, and expiry.

**Changed since the epics:** "source" now names MotherDuck and the database when the bot reads it. The data version comes from a query on `fixture_meta` through the runner, so the data code is not edited (that would make this story T3). The details show by updating the module view, like every other click.

**Files:** new `kit/runtime/slack/provenance.js`; `kit/runtime/archetypes/scoped-pull/index.js`; `kit/runtime/slack/hubs.js`; `kit/runtime/messages.js`; tests.

### Story 9.7: Labour cost (new)

Not in the epics you approved in #52. Added on the architect's recommendation so the bot can answer "what did labour cost in September?" from the new labour data (#117).

**Acceptance criteria:**

- A third Brightside example, "Labour cost", uses the same engine with only a manifest and a SQL file. Its one input is the month. It uses the labour-cost definition in `fixture-tables.md`: minutes worked × the pay rate on the visit date.
- It shows totals only, never one person's pay rate or name.
- "September" means the latest September up to the data's as-of date. It is shown on the Confirm screen so the person can change it.
- Its resource, `LABOUR_COST`, is granted only to the owner or admin role, never open to everyone.
- Tests on a temporary copy of the data check the exact total for a scripted month, and that a person without the grant is refused.
- Only if pay rates stay open (decision 1).

**Files:** new `examples/brightside/app/modules/labour-cost/` (manifest, SQL, test); `profiles/brightside/profile.yml` (`LABOUR_COST`); `docs/ledger.md`.

## Decisions for you

1. **Should the bot be barred from pay rates?** Today `staff.hourly_rate_cents` and `pay_rates.hourly_rate_cents` are open. Adding them to the profile's forbidden columns is a T3 profile change.
   - The SQL checker matches a forbidden column by its name alone. Barring either one bars both, because both are called `hourly_rate_cents`.
   - If barred, **no module can answer "what did labour cost in September?"**. Any SQL that names the rate is refused at startup. The fixture check `integrity-pay-rates.sql` would also need the synthetic-data-only marker.
   - If open, a labour-cost module shows totals only. Someone who can see its SQL could still work out roughly what a crew costs.
   - **Recommendation:** leave them open for the Brightside demo (synthetic data), but grant `LABOUR_COST` only to the owner or admin role, never open access. Add to the fork guide (11.4) that a real client decides this on day one.
2. **Add "Labour cost"?** **Recommendation:** yes, as its own story 9.7 (T3), built after 9.6, not inside 9.5. It shows the engine works with the new data and costs one manifest and one SQL file.
3. **Where the new resource rows go.** As written, 9.3, 9.5 and 9.7 each edit the profile, so each is T3. The other way: put all the rows into 9.1's profile change, which is T3 anyway. **Recommendation:** keep each row with its story. A menu entry and the row that grants it are easier to review together.
4. **Lock the AI code at T3 for every fork?** Add `kit/runtime/llm/**` to the engine's T3 floors in 9.1, beside the data and SQL code. It holds a key that spends money and the off switch. That makes 9.4 T3 too. **Recommendation:** yes.

## Risks

- **No `org.md` for Brightside.** The AI gets only `data.md` and the client name. Extraction works without it, but answers know less about the company. An onboarding build (Scribe drafts, Dana signs off) can add it later. Proposed DEP below.
- **The AI is the bot's second outside service** after MotherDuck, and the key can spend money. The guards are the breaker (which fails closed), the per-person limit, the off switch and your console cap. The breaker resets on restart, so the console cap is the one that can't be reset.
- **Slack modal limits.** A new view can only be opened within 3 seconds of a click, and at most 3 views can stack. Menu and module make 2, and the form renders in the module view, so Confirm, results and "How was this made?" must update the current view, not stack a new one. If a view fails, private replies take over, as #113 does.
- **What the AI sees.** The person's typed request (at most 500 characters) and the two context files, never rows. A person could type client details into the request. Requests and replies are never logged, but they do reach Anthropic.
- **Wrong values.** The AI can misread a request. The Confirm screen is the guard: nothing runs until the person confirms.
- **Stale docs.** The architecture still says Epic 9 is T2 and lists Node 20. 9.1 fixes those rows. The SPEC still lists "the bot reading MotherDuck" as a non-goal, and the architecture's list of what modules may import still names the AI. Both are Scribe follow-ups (below).
- **"Done" is tests only until you check it live.** Per our rule, you run Win-back in Slack after 9.5 (no key needed), and again with the real key after 9.4 (`--kind decision` when each is ready).

## New ledger items (proposed)

| Row | Owner | What |
|---|---|---|
| DEP-018 | **Ely** | The Anthropic API key (`ANTHROPIC_API_KEY`, Keychain `aplabs-anthropic-key`) and its console spend cap. Blocks the live check after 9.4, not the builds. |
| DEP-019 | Orchestrator | Brightside has no `org.md`, so the AI gets `data.md` and the client name only. Needs an onboarding slice (Scribe drafts, client owner signs off). |
| DEP-020 | Scribe | `SPEC.md` still lists "the bot reading MotherDuck" as a non-goal. Update it with the next runtime docs PR. |
| DEP-021 | Scribe | `architecture-runtime.md` line 65 lists `llm` among what module code may import. Change it to "(reply, runner, store, connectors; llm is engine-internal in V1)". |

## Steps only you can do

1. Go to console.anthropic.com with the venture email (not Hometown). Create an API key named `brightside-bot-dev`.
2. In the console, set a monthly spend cap on it (suggested: USD 20 for the demo).
3. Copy the key to your clipboard and tell the agent "copied". The agent saves it to the Keychain as `aplabs-anthropic-key` straight from your clipboard and never prints it. Then clear your clipboard.
4. After 9.5 merges, run the Win-back list in Slack (no key needed) and paste what you saw into the session.
5. After 9.4 merges, run it again by typing a request in plain English, and paste what you saw.

Never paste the key into the repo, the profile, a PR or a chat with an agent.

## To approve

Type `approve plan epic-9`, with your four decisions in the same message, for example: `approve plan epic-9, rates stay open with LABOUR_COST for admins only, add 9.7, resource rows with their stories, lock llm at T3`.
