# The hub status menu: plan for Ely

Status: **approved.** Ely wrote `approve plan hub-status-menu` on 2026-10-31, after the design roundtable (5 votes to 2). Tier **T3** (computed per story below with `APLABS_PROFILE=$PWD/profiles/brightside/profile.yml node kit/lib/tier <paths>`, 2026-10-31): Story 17.1 edits `kit/runtime/knowledge/**`, an engine T3 floor. Epic 17, Stories 17.1 to 17.5. Run mode after the gate: you let it run.

**In short:**
1. Today the hub menu is a welcome paragraph, then one section per tool, each with an identical **Open** button (`kit/runtime/registry/menu.js`, `buildMenu`). Nothing says what is set up, what works, or what to do next.
2. The new menu is still one modal of plain Block Kit blocks. From the top: a **readiness strip** (what the bot knows, and setup progress or how many tools are ready), one **next step** line with the only green button, then the **tools under topic headers**. Each tool row says its status in a glyph plus a word, and has a verb button (Ask, Run, View, Add, Request…). The word "Open" is gone from the menu.
3. A tool that can't work yet shows **Why?** instead of its verb. Why? says what is missing, offers Request, and has Back.
4. Admins see a **Setup · admins** group (Add context, Data sources). Regular users never see it.
5. Both hubs get it: `/brightside-v0` and `/brightside` are built by the same code.
6. Five stories. One is T3 (the counts, in `kit/runtime/knowledge/`). Nothing from you before the build. One live check at the end, which also finishes the open Epic 16 live check.

## Decisions Ely made (approved 2026-10-31, not reopened)

- [x] The chosen design: one modal, plain blocks only (`section`, `context`, `header`, `divider`, `button`). No `card` or `alert` blocks.
- [x] Build requests keep posting straight to `#ai-build-requests` with the requester's name. They are not routed to an admin first.
- [x] The Home tab dashboard is deferred, as a DEP row. It was the minority's view, and VP Sales and Marketing want it before the first paid pilot.
- [x] `card` and `alert` blocks are deferred until they have been tested on a phone.
- [x] No separate phone spike. The phone check is part of your final live check: iOS, plus Android if you have one. Glyphs must render and buttons must stay beside their rows. If a glyph fails, the fix is a one-line swap, so the whole vocabulary lives in one module (D2).
- [x] The menu answers within Slack's 3-second window. Readiness and counts are a local read with no AI call. If they are slow, the menu opens first and the strip follows by `views.update` (D8).

## What the code has today

Read on `main` at `f520d25`. The plan builds on these and adds no new store, scope or outbound call.

| What | Where | What it gives the menu |
|---|---|---|
| The menu | `kit/runtime/registry/menu.js` `buildMenu(hub, entries, { notice, welcome })` | Header, optional welcome section (`block_id: welcome`), optional notice, one section per entry (`block_id: entry:<id>`, button text "Open", `action_id: <id>:open`), divider, Help |
| The slash command | `kit/runtime/slack/hubs.js`, the `app.command` loop | Builds the menu from `visibleEntries(hub, person)` (environment plus access), opens it with `views.open` and `modalView({ keepTail: 2 })`, else falls back to an ephemeral reply |
| First visit | `hubs.js` `firstVisit`, store namespace `welcome` (7 days, `kit/runtime/store`) | Whether to show the welcome |
| Each hub's view | `kit/runtime/slack/hub-view.js` | `{ id, sees, data, llm, rules, knowledge }` |
| Readiness | `kit/runtime/knowledge/readiness.js` `readiness(view, { rules })` | `data` (connected), `rules` (set up) and `detail`: the runner's `describe()`, the two rule files' sign-off, each truth's `valid` and `signedOff`. Synchronous file reads, no AI call |
| Notes | `kit/runtime/knowledge/store.js` `forHub(hub).list()`, wrapped by `archetypes/data-sources` `entriesOf` | The hub's added-context entries (at most 20 small JSON files) |
| The data runner | `kit/runtime/data` `describe()` | `{ source, label, available, problem }`. No as-of date |
| The D10 readiness words | `kit/runtime/messages.js` `ASK_WORDS` (`noDataNoRules`, `dataNoRules`, `rulesNoData`), `BUILD_REQUEST_WORDS` (`notSetUp`, `notOnThisHub`) | What Why? says |
| Build request availability | `hubs.js` `requests.open(...)`, and Ask's "Build request offered" check | Whether a channel is set and the hub may post |
| Map readiness | `hubs.js` `mapFiles.ready()`, `routingMapOf(hub).unready(mod)` | Whether a routing-map module can open |
| Roles | the profile's `users[].role` (`admin` or `member`), reached through `access.personFor` | Who is an admin |

What the code **cannot** answer today:
- **A data date.** `describe()` has no as-of date. The fixture's `fixture_meta` has one, but reading it is a SQL query, not a cheap local read.
- **Rules as a count.** Rule cards (`### GRD-001: name` … `- status: approved`) sit in `guardrails.md`, but nothing parses them. `readiness` knows only whether `data.md` and `guardrails.md` are signed off. D3 proposes a small parser.
- **Requested tools.** A build request is posted to Slack and nothing is kept, so "Requested · in build" has no source.
- **New tools.** Nothing records which tools a person has already seen. D6 proposes a small record in the existing `welcome` namespace.

The two hubs today: `/brightside-v0` (`sees: []`) has the four v0 tools, all admin-only by resource key. `/brightside` (`sees: ["context", "data", "rules"]`) has eight modules (two dev-only). The design is tested against a fixture hub of 12 or more modules too.

## Design decisions

### D1. The menu, top to bottom

| Block | Type | Shown to | Text |
|---|---|---|---|
| Hub name | `header` | everyone | as today |
| Not set up | `context` | a person not in the profile | as today (`notSetUp`) |
| Knows | `section`, `block_id: strip:knows` | everyone | `Knows: 2 notes · 0 sources · 0 truths · 0 rules` (D3) |
| Progress | `context`, `block_id: strip:progress` | see D4 | `▰▱▱▱ Setup 1 of 4 · 1 of 2 tools ready`, or `✓ 2 of 2 tools ready`, or `Your admin is setting this up. You can still ask questions.` |
| Welcome | `section`, `block_id: welcome` | first visit only, as today | the hub file's welcome, now one sentence (D9) |
| Next step | `section`, `block_id: next` | when the rule finds one (D6) | `*Next:* teach it the business` with a **primary** button |
| Group header | `header`, `block_id: group:<n>` | each group with a row this person sees | the group's name (D5) |
| Tool row | `section`, `block_id: entry:<id>` (kept) | each tool this person may open (access unchanged) | `*<label>*` then the status line on the next line; the verb button as the accessory (D2) |
| Divider, Help | as today | everyone | as today (`keepTail: 2` keeps them at the end) |

- **The row's description moves to Help.** A row is the label and the status only, so rows stay short on a phone and the button stays beside them. Help already lists every tool with its description (`buildHelp`). Reversible: the description can come back as a third line.
- **Action ids do not change.** The verb is only the button's text. The button still sends `<module-id>:open`, so the dispatcher, its access re-check, Ask's suggestion button and every test keyed on action ids keep working. Why? adds one new action, `<module-id>:why` (D7).
- **One primary button.** Only the next-step button has `style: primary`. A test checks that the menu has at most one, in every stage.
- **The plain-text fallback** (`text`, the ephemeral reply when the modal can't open) gains the Knows line and the progress line.
- **Block budget.** Header, two strip blocks, welcome, next step, divider and Help are 7. Each group adds one header and each tool one row. `/brightside` for an admin is about 18 blocks; a 12-module hub in four groups is about 23; the 100-block cut (`modalView` `keepTail`) stays as a backstop. A test pins `/brightside`'s count under 30, and a 40-module fixture still ends with Help.

### D2. One vocabulary module: statuses, verbs, the bar

New `kit/runtime/registry/vocabulary.js` holds every glyph and every status word. Nothing else in the engine writes a glyph. If a glyph fails on the phone check, the fix is one line here.

| Status key | Shown | Computable now? | Used for |
|---|---|---|---|
| `ready` | ✓ Ready | yes | a tool that works fully |
| `done` | ✓ Done | yes | a setup step or setup tool that is complete |
| `partly` | ◐ Partly ready | yes | works with limits (Ask before data and rules) |
| `waiting` | ◌ Waiting · needs X | yes | can't work yet; the button becomes **Why?** |
| `not-started` | ○ Not started | yes | a setup tool with nothing in it yet |
| `admin` | 🔒 Admin only | yes | the Setup group's header, "🔒 Setup · admins" |
| `requested` | ⏳ Requested · in build | **no**: nothing records a request | deferred, DEP row |
| `late` | ⚠ Data late · as of date | **no**: no cheap data date | deferred, DEP row |

- **Every status carries a word.** The glyph never stands alone. A status may add a short detail after a middle dot: `✓ Done · 3 notes`, `◌ Waiting · needs data`.
- **The deferred two are not in the module** until a source exists, so no screen can show a status the code can't back.
- **The bar** is four cells, `▰` done and `▱` not done, followed by words (`Setup 2 of 4`). It is in the same module.
- **The verbs**: Ask, Run, View, Add, Review, Request, and Why?. "Open" is not one of them.

### D3. What the Knows line counts

| Count | Source | Counted when | Cheap? |
|---|---|---|---|
| notes | the hub's knowledge store, `list()` (via `entriesOf`) | each entry on this hub | yes: at most 20 small local files |
| sources | `readiness(...).detail.data.connected` | 1 when the hub sees data and its runner says available, else 0. One runner per hub today, so 0 or 1 | yes: `describe()` reads no data |
| truths | `readiness(...).detail.rules.truths` | each truth that is valid and signed off (`signedOff` a date, not `pending`). 0 when the hub does not see rules | yes: the rules reader reads `data.md` |
| rules | **new**: approved rule cards in `guardrails.md` | each `### <ID>: <name>` card, outside HTML comments, whose `- status:` line is exactly `approved`, counted **only when `guardrails.md` itself is signed off**. 0 when the hub does not see rules | yes: one more local file read in the same reader |

- **Why a parser for rules (the minimal source).** Today nothing counts rules: readiness knows only whether the two files are signed off. Rule cards already have a fixed shape (the template in `kit/templates/context/guardrails.md`), so counting the approved ones is about 20 lines in the rules reader (`createRulesReader`). The count is a number only: `detail.rules.approvedRules`. No rule text reaches `detail`, as today.
- **Only signed-off truths and rules count.** A card marked `draft (approved …)` is not `approved`. A file awaiting sign-off counts 0 rules.
- **What it means for `/brightside` today:** `guardrails.md` is `signed_off: pending` (DEP-032 is open), so its strip will say **0 rules**, and setup step 4 is not done (see open item 1).

### D4. Setup progress, and who sees it

**The four setup steps** (new `kit/runtime/knowledge/summary.js`, a pure function of readiness, the notes and the hub's `sees`):

| Step | Done when |
|---|---|
| 1. Taught the business | at least one note, or the hub sees `context` (the profile's files reach its prompt) |
| 2. Data connected | `readiness.data` |
| 3. Known truths | at least one valid, signed-off truth |
| 4. Rules signed off | `data.md` and `guardrails.md` signed off |

Steps 3 and 4 together are today's `readiness.rules` (D10 of plan brightside-v0), so Ask and the menu agree on what "rules set up" means.

**Line 2, by who is looking:**

| Person | Hub | Line 2 |
|---|---|---|
| Admin | steps not all done | `▰▰▱▱ Setup 2 of 4 · N of M tools ready` |
| Admin | all four done | `✓ N of M tools ready` (no date: D3, deferred) |
| Member | blank: step 1 and step 2 both not done | `Your admin is setting this up.`, plus ` You can still ask questions.` only when an Ask row is in their menu |
| Member | otherwise | `✓ N of M tools ready` |
| Not in the profile | any | the existing not-set-up notice instead |

- **Setup progress is an admin's business.** A member on `/brightside` is not told "your admin is setting this up" just because `guardrails.md` awaits sign-off. Reversible.
- **"Tools ready"** counts the rows this person sees outside the Setup group whose status is `ready`. M is that number of rows. `◐ Partly ready` is not counted.

### D5. Groups

- **Field:** a new optional `group` on the **module manifest**, not the hub file (architect's call). Reason: a module stays one folder (AD-3). A hub-file list would repeat every module id and break when a folder is added or renamed. Schema: a string of 1 to 40 characters, one line (`module.schema.json`, `additionalProperties: false` stays).
- **Order:** groups in the order their first module appears (menu order is folder order, as today), then the ungrouped tools under **Tools**, then **🔒 Setup · admins**. A manifest that names `Tools` joins the ungrouped ones.
- **Setup · admins** holds the `add-context` and `data-sources` archetypes. The engine places them. The schema refuses a `group` on those two archetypes, and the registry refuses any group whose name starts with "Setup" (any case), naming the file.
- **Who sees it:** a person whose profile role is `admin`, and only the setup tools their access allows. A member never sees the group, even with a setup key granted by name (fail closed; the fork guide says so). Access to the tools themselves is unchanged: the dispatcher's re-check still decides every click.
- **Known truths and Rules stay inside Data sources.** No rows of their own: they have no tool, the strip counts them, and Data sources already lists them. Minimal, and no row points to a screen that isn't there.
- **The example's groups** (`examples/brightside/app/modules/`): Unpaid invoices, Win-back list and Labour cost under **Lists**; Routing and Plan a route under **Routing**; Say hello, Dataset and Outbox ungrouped (**Tools**). Ask and Request a tool on `/brightside-v0` ungrouped.

### D6. The next-step line

A small pure rule, new `kit/runtime/registry/next-step.js`. Inputs: the setup summary (D4), whether the person is an admin, the rows they see with their statuses, and the tools new to them. It returns one `{ text, label, actionId }` or nothing. First match wins:

| # | When | Line | Button |
|---|---|---|---|
| 1 | Admin, step 1 not done, and an Add context row in their menu | `*Next:* teach it the business` | **Add context** (`<add-context id>:open`) |
| 2 | Anyone, a tool new to them whose status is `ready` or `partly` | `*New:* <label>` | its verb (`<id>:open`) |
| 3 | Admin, step 1 done, no tools on the hub but the template tools (data-sources, add-context, ask, build-request), and a Request a tool row that is `ready` | `*Next:* request your first tool` | **Request** (`<build-request id>:open`) |
| — | anything else | no line | — |

- **New to them** (minimal source): each menu open records the module ids shown to the person, in the existing `welcome` store namespace under a separate key, `seen:<slack id>:<hub id>` (7 days, in memory). A tool is new when it is in this menu and was not in the last one. No record (a first visit, after a restart, after 7 days): nothing is new. No new namespace and no change to `kit/runtime/store`; AD-7's table row for `welcome` says what it now holds.
- A `waiting` tool never gets a next-step line. The button reuses `<id>:open`, so access is re-checked at the click as for any row.
- The button is the menu's only `style: primary`.

### D7. Why?

- **When:** a row whose status is `waiting` shows **Why?** (`<module-id>:why`, new `WHY_ACTION` in `menu.js`) instead of its verb. Slack has no disabled button.
- **The screen** (new `kit/runtime/registry/why.js`, pushed like any tool view, title the tool's label): what is missing, in the existing words where they exist:

| Waiting for | Words |
|---|---|
| data, and rules (a scoped pull, approval write or routing map on a hub whose data is not connected) | `ASK_WORDS.noDataNoRules`, `dataNoRules` or `rulesNoData`, by readiness (the D10 table) |
| a build-request channel | `BUILD_REQUEST_WORDS.notSetUp(admin)` |
| a hub that may post | `BUILD_REQUEST_WORDS.notOnThisHub` |
| the map setup (`mapFiles` not ready, or the adapter has no `route()` or no Office) | new words in `messages.js`: "The map isn't set up on this bot yet. Ask <admin>." |
| the AI service (`view.llm` is null) | new words: "The AI helper isn't set up on this bot yet. Ask <admin>." |
| the knowledge store | `addContext.NO_STORE(admin)` |

- **Request:** when a Request a tool row is in this person's menu on the same hub and is `ready`, the screen offers **Request** (`<build-request id>:open`, pushed as the third view; Slack allows three). Otherwise it ends "Ask <admin> about it." No prefilled text: the form opens empty, so no new path carries text into a post.
- **Back** returns to the menu (Slack's back arrow on a pushed view).
- **Recomputed at the click.** If the tool became ready since the menu was built: "This is ready now. Press Back, then <verb> it from the menu."

### D8. The 3-second window

- The slash command's `trigger_id` lasts 3 seconds. The menu's facts are local reads: the rules reader (synchronous reads of three small files), `describe()` (no I/O) and the knowledge store's `list()` (at most 20 small files). No AI call, no SQL, no Slack call.
- **Guard:** the summary is raced against a 1,000 ms budget. In time (the normal case), the menu opens whole. Late: the menu opens with `Knows: checking…`, no progress line and no next step, and every row shows its verb with the status `Checking`. When the summary arrives, the whole menu is rebuilt and sent by `views.update` with the opened view's id and hash. A `hash_conflict` (the person already moved on) is dropped and logged at info with the hub only. A summary that fails is logged and the menu stays as opened, with `Knows: couldn't check just now`.
- A test with a slow fake knowledge store proves the menu opens before the summary, and a test with the frozen clock proves the update follows.

### D9. The welcome paragraph

- **Shortened, kept for first visits.** The strip now says most of what the welcome said. The welcome stays the first-visit section (Story 6.4 behaviour, tests and the `welcome` field unchanged, so forks' hub files still validate), now one sentence, shown below the strip.
- `/brightside`'s welcome today says "Press Open to start one", which is wrong once Open is gone. Both example hub files get one sentence each, for example `/brightside-v0`: "A blank Brightside bot: it knows nothing about the business until an admin teaches it." The default in `messages.js` `welcomeText` loses "opens one tool".
- The schema's 600-character limit stays (forks). The fork guide recommends one sentence.

### D10. Verbs and labels: where they come from

- **Verb:** an archetype default, with an optional manifest override. New optional `verb` in `module.schema.json`, an enum of `Ask`, `Run`, `View`, `Add`, `Review`, `Request`. `Why?` is never a manifest value: it comes from the status.

| Archetype | Default verb |
|---|---|
| `ask` | Ask |
| `add-context` | Add |
| `data-sources` | View |
| `build-request` | Request |
| `scoped-pull`, `approval-write`, `handler` | Run |
| `routing-map` | View |

  The example overrides Dataset and Outbox to `View`, and Win-back list to `Review`.
- **Status** is never in a manifest: a manifest can't claim a tool is ready. It is computed per archetype (D11).
- **"Build request" becomes "Request a tool"**: the `v0-build-request` manifest's label, and every place the bot names the tool (`BUILD_REQUEST_WORDS` "open Build request to start again", Ask's "Build request" button). The archetype and its resource key keep their names.
- **Ask's suggestion button** (`archetypes/ask`, today "Open") uses the suggested tool's verb, and `ASK_WORDS.tool` says "Press <verb> to use it." The two "press Open" lines in `hubs.js` (`FORM_NEEDS_WINDOW`, `MAP_NEEDS_WINDOW`) say "press its button there".
- `kit/templates/module.md` and the fork guide document `verb` and `group` in the stories that add them.

### D11. Each tool's status

New `kit/runtime/registry/status.js`, a pure function `toolStatus(mod, facts)`. The facts are gathered in `hubs.js` from what it already has.

| Archetype | Status |
|---|---|
| `ask` | `ready` when `readiness.data` and `readiness.rules`; `waiting · needs the AI` when the hub has no AI service; else `partly · no data yet` (or `· nothing taught yet` with no notes and no context). Never waiting for data: Ask works without it |
| `add-context` | `done · N notes`, or `not-started · no notes yet`; `waiting · needs storage` with no knowledge store |
| `data-sources` | `done` when steps 2 to 4 are done; `not-started · no data, no rules` when none is; else `partly · needs <data, truths or rules>` |
| `build-request` | `ready` when a channel is set and the hub may post; else `waiting · needs a channel` or `waiting · not on this hub` |
| `scoped-pull`, `approval-write` | `ready` when the hub's data is connected; else `waiting · needs data` |
| `routing-map` | `ready` when data is connected, `mapFiles.ready()` and the module is not `unready`; else `waiting · needs data` or `waiting · needs map setup` |
| `handler` | `ready` (a handler declares nothing the menu can check) |

## The stories

Epic 17. Stories are PRs. Estimates: **S** about half a day, **M** about a day, **L** up to two days.

| Story | Size | Tier | Extends | You will see |
|---|---|---|---|---|
| 17.1 Vocabulary, counts and manifest fields | M | **T3** | `knowledge/readiness.js` (the rules reader), `module.schema.json`, `registry/index.js` | Nothing new in Slack. Tests show the counts, the setup steps and each status from fixture hubs |
| 17.2 The new menu | L | T2 (computes T1; raised) | `registry/menu.js`, `slack/hubs.js`, `archetypes/ask`, `messages.js`, the hub files | Both hubs: the strip, groups, statuses and verbs; the Setup group for admins; "Request a tool"; no "Open" |
| 17.3 Why? | M | T1 | the dispatcher's push and re-check, the D10 words | A waiting tool shows Why?; it says what is missing, offers Request, Back returns |
| 17.4 The next step | M | T1 | the `welcome` store namespace | "Next: teach it the business" on a blank hub; "New: <tool>" after a tool appears |
| 17.5 Fork guide and live check | S | T0 | `docs/fork-guide.md`, `kit/templates/module.md` | The fork guide explains the menu; the live check list for you |

**Tiers** (computed 2026-10-31; the Orchestrator recomputes each story on its full file list before it starts, and a tier only goes up):

- 17.1: `kit/runtime/knowledge/readiness.js` and the new `kit/runtime/knowledge/summary.js` (the `knowledge/**` engine floor). Everything else in it computes T1.
- 17.2: computes T1 (`kit/runtime/registry/**`, `kit/runtime/slack/hubs.js`, `kit/runtime/archetypes/ask/**`, `kit/runtime/messages.js`, `examples/**`, `test/**`). Raised to T2: it decides who sees the Setup group and shows counts from the client's rule files to every person on a hub. If it has to edit `kit/runtime/knowledge/**`, it computes T3.
- 17.3: computes T1 (`registry/why.js`, `registry/menu.js`, `slack/hubs.js`, `messages.js`).
- 17.4: computes T1 (`registry/next-step.js`, `registry/menu.js`, `slack/hubs.js`). It writes a new key into the existing `welcome` namespace and does not edit `kit/runtime/store` (T3).
- 17.5: docs only, T0.

17.1 and 17.2 get an architect design review. 17.3 and 17.4 follow T1 ceremony (decide and report) inside this approved plan, and still go through the full build loop and review.

## Acceptance criteria

Every story, in addition to what is listed:
- `npm run check && npm test` pass. A story that touches a path listed in `AGENTS.md` for `npm run test:slow` runs it too.
- Tests read client specifics from fixtures (`test/fixtures/`), never from `profiles/brightside/` or `examples/brightside/app/`. Fixture hubs cover the four stages: blank (`sees: []`, no notes), onboarded (notes, or a hub that sees context), first tool (a fixture scoped pull on a hub with data), and full (12 or more modules in several groups).
- A test that fixes the time freezes every clock (`mock.timers`, or `now` passed to every path, including the store's TTLs and D8's budget).
- The Slack fake rejects what Slack rejects, for every field the story's code sets. Each story names the fields it added to the fake. At least: a `header` text over 150 characters (exists), a button text over 75 (exists), a button `style` other than `primary` or `danger` (exists), two blocks with one `block_id` (exists), a `context` block with no elements or more than 10, and a `context` element's text over 3,000.
- Each new or changed Slack screen lists every way out: Back, the X, an error, an expired trigger, and a click from an old message menu. Each has a test.
- Every ack on a changed screen returns within the 3-second window. A test with a slow fake proves the ack, or the menu, comes first.
- No glyph is written outside `kit/runtime/registry/vocabulary.js`. A test greps `kit/runtime/**` for the glyphs (✓ ◐ ◌ ○ 🔒 ▰ ▱ ⏳ ⚠) and finds them only there.
- The word "Open" appears on no menu button. A test walks every fixture stage.
- Nothing is reworded to quiet a check. If a check flags safe code, the code moves or the check is fixed in its own change.
- Steps only the live app can run (how the glyphs look on a phone, the real modal) are named as untested in the builder's report and the PR body.
- Each story updates the docs that describe what it changed, in the same PR: the file's header comment and the `architecture-runtime.md` sections named below.
- No reference-client name, path, Slack id or data outside `docs/reference/` (`docs/reference/dist-deny.txt`).

### Story 17.1: vocabulary, counts and manifest fields

- New `kit/runtime/registry/vocabulary.js` (D2): the status table, the verbs, `verbOf(mod)` (D10), `statusText({ key, detail })` and `setupBar(done, of)`.
  - Tests: every status has a non-empty word; `statusText` never returns a glyph without its word; the bar is four cells of `▰` and `▱` followed by "Setup N of 4"; `requested` and `late` are not in the table.
- New `kit/runtime/registry/status.js` (D11): `toolStatus(mod, facts)`, pure. One test per row of D11's table, and a test that an unknown archetype is `ready` only for `handler` and refused otherwise.
- `kit/runtime/knowledge/readiness.js`: the rules reader adds `approvedRules` (a count) to `detail.rules` (D3). Its header lists it among what `detail` may hold.
  - Tests, on fixture `guardrails.md` files: the template's commented card is not counted; `- status: approved` counts; `- status: draft (approved 2026-10-25 …)` does not; a card with no status line does not; an unreadable file is 0 with `problem` set, as today; no rule text appears in `detail`.
- New `kit/runtime/knowledge/summary.js` (D3, D4): `summarize({ ready, entries, sees })` returns `{ counts: { notes, sources, truths, rules }, steps: [4 booleans], done }`. Rules count 0 while `guardrails.md` is not signed off. Tests: one per stage fixture, and a hub that sees nothing reads 0 for sources, truths and rules without reading a file (the existing readiness guarantee, re-asserted).
- `kit/runtime/schema/module.schema.json`: optional `verb` (the enum in D10) and `group` (1 to 40 characters, one line, `\S`). `group` is refused on `add-context` and `data-sources` (an `allOf` rule like `write`'s).
- `kit/runtime/registry/index.js`: refuses a `group` starting with "setup" in any case, naming the module file and the field. Tests: a bad verb, `Why?` as a verb, a group on each setup archetype, a "Setup" group, a group over 40 characters, one with a line break; each names the file.
- The example manifests gain `verb` and `group` as D5 and D10 say. Nothing in Slack changes yet: the menu still renders "Open" until 17.2.
- `kit/templates/module.md`: the two new fields in its field table.
- `architecture-runtime.md`: AD-4 (the manifest's fields gain `verb` and `group`); the AD-3 "Data sources and readiness" bullet (the approved-rule count).

### Story 17.2: the new menu

- `kit/runtime/registry/menu.js` `buildMenu` builds the blocks in D1, from rows the hub hands it (`{ entry, status, verb }`), the summary, and whether the person is an admin. `buildHelp` is unchanged and keeps each tool's description.
- `kit/runtime/slack/hubs.js`, the slash command: gathers the summary (D8's budget), each row's status (D11) and verb, places the setup archetypes in the Setup group for admins only (D5), and opens the menu. A late summary updates the view (D8).
- The four stages, one test each, on fixture hubs:
  - **blank**, admin: `Knows: 0 notes · 0 sources · 0 truths · 0 rules`, `▱▱▱▱ Setup 0 of 4 · 1 of 2 tools ready`, Tools (Ask `◐ Partly ready · nothing taught yet`, Request a tool `✓ Ready`), then 🔒 Setup · admins (Add context `○ Not started · no notes yet`, Data sources `○ Not started · no data, no rules`);
  - **blank**, member with Ask: `Your admin is setting this up. You can still ask questions.` and no Setup group; a member without Ask: the first sentence only;
  - **onboarded** (two notes): `2 notes`, `▰▱▱▱ Setup 1 of 4`, Add context `✓ Done · 2 notes`;
  - **first tool** (a fixture scoped pull, data connected): `1 source`, the tool `✓ Ready` with **Run**;
  - **full**: every group in order, `✓ N of M tools ready` once all four steps are done, block count under 30 for the `/brightside`-shaped fixture, and a 40-module fixture that still ends with Help.
- **Ways out of the menu, each tested:** the X; each verb button (pushes the tool's view, Back returns to the menu, as today); Help, then Back; an expired trigger (the existing ephemeral fallback, now with the strip's two lines in `text`); a person not in the profile (the existing notice, no Setup group, no progress line); a click on an old message menu (unchanged dispatch); the late summary (D8: menu first, then `views.update`; a `hash_conflict` dropped and logged; a failed summary leaves "couldn't check just now").
- A row whose status is `waiting` keeps its verb in this story (the dispatcher's existing messages answer the click). 17.3 swaps it for Why?.
- The label rename and the verbs in D10: the `v0-build-request` manifest, `BUILD_REQUEST_WORDS`, Ask's buttons and `ASK_WORDS.tool`, `FORM_NEEDS_WINDOW` and `MAP_NEEDS_WINDOW`. Tests: Ask's suggestion button carries the tool's verb, and no bot text says "Build request" or "press Open".
- The hub files' welcomes become one sentence each (D9); `welcomeText`'s default loses "opens one tool". The Story 6.4 welcome tests still pass with the welcome below the strip.
- **Existing tests are updated, not deleted:** `test/unit/runtime-hubs.test.js` (the `buildMenu` test and the over-100-blocks test), `test/unit/runtime-welcome.test.js`, `test/unit/runtime-hub-v0.test.js`, `examples/brightside/test/hello-world.test.js`, and any Ask test that reads the "Open" text.
- The Slack fake gains the `context` block checks above, and `views.open` returns the view's `id` and `hash` as Slack does (the late update needs them).
- `architecture-runtime.md`: a new AD-3 bullet, "The hub menu (plan hub-status-menu, D1 to D11)"; the AD-3 "Build request" and Ask bullets (the label and the verb button); AD-6 (the menu's facts are read inside the trigger window, else D8); the CAP-2 row (`registry/vocabulary.js`, `status.js`).
- Untested until the live check: how the glyphs and the bar look in the Slack apps, and whether the buttons stay beside their rows on a phone.

### Story 17.3: Why?

- New `WHY_ACTION` (`^([a-z][a-z0-9-]*):why$`) in `menu.js`; a `waiting` row's button is **Why?** with `<id>:why`. The listener test in `runtime-hubs.test.js` that counts listeners and their patterns is extended, and `:why` matches no existing pattern.
- New `kit/runtime/registry/why.js` builds the screen (D7). New words in `messages.js` (the map and the AI lines, "This is ready now…", "Ask <admin> about it.").
- The listener in `hubs.js` re-checks the module (unknown, hidden in this environment) and the person's access (`refusalFor`) before anything else, then recomputes the tool's status.
- **Ways out, each tested:**
  - Back (to the menu) and the X;
  - **Request**: pushes the build-request form as the third view; Back from it returns to Why?;
  - Request hidden: no build-request row on this hub, the person lacks it, no channel, or a hub that may not post; the screen ends "Ask <admin> about it.";
  - the tool became ready since the menu was built ("This is ready now…");
  - the person lost access since the menu (the existing refusal, in the view);
  - an unknown or hidden module (the existing "isn't available here any more");
  - an expired trigger or a failed push (the existing in-place fallback, logged);
  - a click from an old message menu (the words as a private reply, with no buttons).
- One test per "waiting for" row of D7's table, checking the exact existing words are used.
- `architecture-runtime.md`: the AD-3 menu bullet gains Why?.

### Story 17.4: the next step

- New `kit/runtime/registry/next-step.js`: the rule in D6, pure. One test per row of its table, a test that the first match wins, and a test that a `waiting` tool is never chosen.
- `menu.js` renders it as `block_id: next`, with the menu's only `style: primary` button. A test asserts at most one primary button in every stage.
- `hubs.js` records the ids shown, at each menu open, under `seen:<slack id>:<hub id>` in the `welcome` namespace, synchronously (AD-7: no await between the read and the write), and passes the new ids to the rule. Tests:
  - a first visit has no "New" line;
  - a tool added between two opens is "New" on the second, and not on the third;
  - after 7 days (frozen clock), nothing is new;
  - the first-visit welcome still shows once per person per hub, and its own 7-day expiry is unchanged (the existing Story 6.4 tests pass).
- **Ways out:** the next-step button is a `<id>:open` click: access is re-checked, and a tool hidden or refused since the menu was built gets the existing messages. Tested once each. The late menu (D8) has no next step until its update.
- `architecture-runtime.md`: AD-7's `welcome` row ("first-visit flag, and the tool ids last shown"); the AD-3 menu bullet gains the next step.

### Story 17.5: fork guide and live check

- `docs/fork-guide.md`: what the menu shows; `verb` and `group` in a manifest; the Setup group (admins only, even for a member granted a setup key by name); "Request a tool"; the starter tools' table updated; the welcome as one sentence.
- `kit/templates/module.md`: the starter tools' table names each one's verb and the statuses a fork's people will see; the line "presses **Open** on the entry" says the verb instead.
- The structural test of the fork guide passes.
- The live check list (below) is in the PR body, and the result is recorded as "live-checked" or not in the epic report.

## Build order and shared files

The stories edit the same engine files, so they run **one at a time**, in this order:

1. **17.1.** The pure parts and the fields. Everything else reads them.
2. **17.2.** The menu. It needs the vocabulary, the statuses and the summary.
3. **17.3.** Why?, after 17.2: it swaps a button `buildMenu` now draws and adds a listener to `hubs.js`.
4. **17.4.** The next step, after 17.3: it edits `menu.js` and `hubs.js` again.
5. **17.5.** Docs, last. It can start while 17.4 is in review, since it edits no engine file.

| File | Stories |
|---|---|
| `kit/runtime/registry/menu.js` | 17.2, 17.3, 17.4 |
| `kit/runtime/slack/hubs.js` | 17.2, 17.3, 17.4 |
| `kit/runtime/messages.js` | 17.2, 17.3 |
| `kit/runtime/registry/vocabulary.js`, `status.js` | 17.1 (17.2 and 17.3 only read them; a needed change is made there and named in the PR) |
| `kit/runtime/knowledge/readiness.js`, `summary.js` | 17.1 |
| `kit/runtime/schema/module.schema.json`, `kit/runtime/registry/index.js` | 17.1 |
| `examples/brightside/app/modules/*/manifest.json` | 17.1 (verb, group), 17.2 (the Request a tool label) |
| `examples/brightside/app/hubs/*.json` | 17.2 |
| `test/unit/runtime-hubs.test.js` | 17.2, 17.3 |
| `test/fixtures/fake-slack.js` | 17.2 |
| `docs/planning/planning-artifacts/architecture-runtime.md` | 17.1, 17.2, 17.3, 17.4 |
| `kit/templates/module.md` | 17.1, 17.5 |

If a later builder finds `main` has moved, it merges `main` and resolves the conflicts before it reports.

## Steps only you can do

1. **Nothing before the build.** The plan is approved; no install, scope, channel or reinstall is needed. The bot scopes do not change.
2. **The live check, after 17.5 merges.** It finishes the open Epic 16 live check and adds Epic 17's. Drive it as Dana (an admin) in `/brightside-v0` unless a step says otherwise. Restart the bot once first, from `main`.

   **Epic 16, carried over** (step 1 passed: the four tools show):
   1. Data sources says no data and no rules.
   2. Ask a data question: the answer is "no data and no rules yet".
   3. Add a typed note, then ask about it: Ask answers from it.
   4. Upload a PDF, then a photo: each shows what the bot took from it.
   5. Remove an entry: it is gone from Data sources.
   6. Post a build request (now **Request a tool**): it appears in `#ai-build-requests` with your name.
   7. `/brightside` still works: open two of its tools.
   8. The Slack app's settings match `examples/brightside/app/slack-manifest.json` (the commands and the seven scopes).
   9. Restart the bot: the added context is still there (local `var/`).

   **Epic 17:**
   10. Before any note (or after removing them all), the strip says `0 notes` and Setup 0 of 4, and the next step says "teach it the business". Add a note: reopen the menu and it says `1 note`, Setup 1 of 4, and Add context is `✓ Done · 1 note`.
   11. **Why?**: on a hub where a tool is waiting, press Why?, read what is missing, press Request if it shows, then Back to the menu. (If no tool is waiting on either hub, the Orchestrator tells you how to make one wait, for example by unsetting the channel locally. Your call whether to run that.)
   12. **The phone check**, on iOS, plus Android if you have one: open both menus. Every glyph (✓ ◐ ◌ ○ 🔒 ▰ ▱) renders, no row shows a bare glyph, and each button sits beside its row. A glyph that fails is a one-line swap in `vocabulary.js`; tell the Orchestrator which.
   13. `/brightside` as Dana: the groups (Lists, Routing, Tools), the verbs (Run, Review, View), no "Open" anywhere.

   Untested live by design: the member's view (the example's only member, Marcus, is fictional). Tests cover it.

## New ledger items (proposed)

The Orchestrator assigns the next free DEP ids when the stories open them (DEP-037 is the last today).

| Row | Owner | What |
|---|---|---|
| DEP-(next) | **Ely** | The Home tab dashboard (the roundtable's minority view). VP Sales and Marketing want it before the first paid pilot. Needs its own plan: `app_home_opened`, the `home` view, and what a dashboard shows per role. |
| DEP-(next+1) | Orchestrator | `card` and `alert` blocks in the menu, once they have been tested on a phone. |
| DEP-(next+2) | Orchestrator | A data date for the strip ("data as of <date>") and the `⚠ Data late · as of date` status. Needs a cheap as-of date: for example, `describe()` returning one read once at connect, never a query per menu. Until then the date is left off. |
| DEP-(next+3) | Orchestrator | The `⏳ Requested · in build` status. Needs a record of requests and their state (posting keeps nothing today), and a way to mark one built. |
| DEP-(next+4) | Orchestrator | "New" tools are remembered in memory for 7 days (`welcome` namespace), so a restart forgets them. Revisit with the durable store (architecture "Deferred"). |

## Open items, each with a recommended default

1. **`/brightside` reads 0 rules and Setup 3 of 4 for admins** until `guardrails.md` is signed off (it is `pending`; DEP-032 covers part of it). Default: **keep it strict.** Only signed-off rules count, which is the point of the strip, and members are not shown setup progress (D4). Your alternatives: sign off `guardrails.md` as Dana once DEP-032's additions are settled, or count approved rule cards even in an unsigned file.
2. **A member granted a setup key by name** (no one in the example profile) does not see the Setup group. Default: keep (fail closed). The alternative is "admin role or a setup key".
3. **Row descriptions move to Help** (D1). Default: yes. The alternative is a third line on each row.

None of these blocks the build: each default is reversible, and each is in the epic report.

## Risks

- **Glyphs on phones.** Untested until the live check. Contained: one module holds them, and every status has its word, so a missing glyph never hides a status.
- **The 3-second window.** A slow disk or a large knowledge folder could delay the menu. Contained by D8's budget and the late update.
- **A count that looks wrong.** The strip counts only signed-off items, so it can be lower than what someone expects (open item 1). The words say "truths" and "rules", and Data sources shows each one.
- **Status drift.** A status is computed when the menu opens. A click on a stale menu still goes through the dispatcher's re-check, and Why? recomputes at the click.

## Not in this plan

- The Home tab, `card` and `alert` blocks, a data date, "Requested · in build" (DEP rows above).
- Routing build requests to an admin first (your decision: they keep posting straight to the channel).
- Rows of their own for Known truths and Rules (they stay inside Data sources, D5).
- Putting the four v0 tools on `/brightside` (an open plan brightside-v0 DEP).
- Any change to who may open a tool. Access, the dispatcher's re-check and the resource keys are unchanged.

## Approval

Approved by Ely on 2026-10-31 (`approve plan hub-status-menu`), with the decisions above.
