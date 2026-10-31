# Adding a module

A module is one entry on a hub's menu: a person types the hub's slash command, presses **Open** on the entry, and the module's handler replies to them privately. Adding one is a folder of files in the app dir. No engine file (`kit/**`, `profiles/_schema/**`) changes.

A module never writes to an external system itself: a push is a manifest `write` block, run by the approval-write archetype (AD-15). `npm run check` fails a module that passes `dryRun` (other than `dryRun: true`), touches a connector's `.write`, or creates its own connector instance (DEP-012; see `kit/templates/connector.md`).

## Steps

1. Copy the template into the app dir, naming the folder after the module's id:

   ```bash
   cp -r kit/templates/module app/modules/weekly-report
   ```

   The template is three files: `manifest.json`, `handler.js` and `handler.test.js`.
2. Fill in the manifest (fields below). At minimum: `id`, `hub`, `label`, `description`, `resource` and `archetype`.
3. Declare the resource in the profile, under `resources`, **without** `open_access`, and grant it to the people who need it (see "Why the resource is gated" below).
4. Write the handler and its test, then run `npm test`.
5. Restart the app. The entry shows on its hub's menu for the people the profile allows.

If the manifest is wrong, `npm test` and app startup both fail with the module's file and the field, for example `modules/weekly-report/manifest.json: field "hub" names no hub`.

## Manifest fields

The manifest is JSON, checked against `kit/runtime/schema/module.schema.json`. Unknown fields are errors.

| Field | Required | What it is |
|---|---|---|
| `id` | yes | Lower-case slug (`weekly-report`). Must equal the folder name, so two modules can never share an id. |
| `hub` | yes | The id of the hub whose menu lists it: a file `app/hubs/<hub>.json` must exist. What the module can reach is what that hub's `sees` lists: on a hub without `"data"`, `ctx.data.run` refuses ("no data source"), a `scoped-pull`, `approval-write` or `routing-map` module stops startup, and `npm run check` fails a module file there that imports `kit/runtime/data`. On a hub without `"context"`, it fails one that imports `kit/runtime/llm` or `kit/runtime/knowledge`, or names the profile's context files (`.aplabs/context`, or `org.md`, `data.md`, `guardrails.md` or `connectors.md` under a `context/` folder). |
| `label` | yes | The menu button's text, up to 60 characters. |
| `description` | yes | One line under the button, up to 200 characters. Say what it does for the person. |
| `resource` | yes | The profile resource key that grants it (`WEEKLY_REPORT`). It must be declared in the profile, or startup fails: a missing key is a setup fault, never shown to a person as a denial. |
| `archetype` | yes | `handler` (your code replies), `scoped-pull` (a list with a typed form, no code: see below), `approval-write` (a scoped pull whose list can be pushed to another system after the person previews and approves it: see below), `routing-map` (the routing map), or one of the four starter tools the engine shows itself: `data-sources`, `add-context`, `ask` and `build-request` (see "The four starter tools" below). |
| `environments` | yes | Where it shows, by `APLABS_ENV` (`["dev"]`, then `["dev", "prod"]` when it is ready). Off the menu, and refused if opened, everywhere else. |
| `handler` | for `handler` | The handler file in the module's folder (`handler.js`). It exports one async function. |
| `parameters` | for `scoped-pull` and `approval-write` | The inputs a person gives (see "Declaring inputs" below). The query runner refuses a parameter the manifest does not declare. |
| `query` | for `scoped-pull` and `approval-write` | A `.sql` file in the module's folder. Startup fails if it is missing or empty. |
| `row_id` | with `scoring`, and for `approval-write` | The column the query returns that tells rows apart (`client_id`). Equal scores are ordered by it, and a push's idempotency key is built from it. |
| `scoring` | no | A score from 0 to 100 and a one-line reason per row, worked out by the engine (see "A scored list" below). |
| `write` | for `approval-write` | Where and what it pushes (see "Pushing a list" below). |

## What a hub sees

Every hub file (`app/hubs/<id>.json`) has a required `sees`: what the hub, and every module on it, may reach. Boot stops on a hub file without it, or with a value not in the list.

| Value | What it gives the hub |
|---|---|
| `"context"` | The profile's context files (`org.md`, `data.md`) in the AI's prompt. |
| `"data"` | The read-only query runner. Without it, `ctx.data.run` refuses ("no data source"). |
| `"rules"` | The known truths, guardrails and forbidden columns, as Data sources and Ask report them. |

`[]` sees none of them: a blank hub. A hub's added context (from Add context) belongs to that hub whatever `sees` says, and is always in its AI's prompt. The checks that follow from `sees` are in the `hub` row above. The full list is `kit/runtime/schema/hub.schema.json`.

## The four starter tools

Four archetypes are tools the engine shows itself. Their manifest is the required fields only: no `handler`, `query`, `parameters`, `scoring` or `row_id` (startup stops on any of them). The template's example client has one of each to copy, and the fork guide (`docs/fork-guide.md`, step 8) says how. Each opens in the module's own view, whose Back returns to the hub's menu.

| Archetype | What a person sees |
|---|---|
| `data-sources` | What the hub has: its connected data (available or not, never a table or row count), whether `data.md` and `guardrails.md` are signed off and each known truth with its owner and last check, and the titles of its added context. On a hub that sees neither data nor rules: "No data connected yet. No known truths or rules yet." |
| `add-context` | A title and a text box (at most 3,000 characters), or one uploaded file (PDF, image, `.txt` or `.md`), for Ask to use on this hub, and the hub's entries, each with Remove. An entry is live at once. A PDF or image is read once through the AI; only the text is kept, and the file stays in the uploader's Slack files. |
| `ask` | A question in the person's own words (at most 500 characters). Ask points to a tool on this hub the person can open, says what is missing when a data question comes before the hub's data and rules are set up, or answers from the hub's prompt. It never writes or runs SQL. |
| `build-request` | What the person needs (at most 500 characters), summarised by the AI, previewed exactly as it will post, then posted to the profile's `slack.build_requests_channel` with a mention of the person. Only a hub that sees neither `"context"` nor `"data"` may post. |

Their resources:

- **Never `open_access` for `add-context` or `ask`:** startup stops on it. Everyone who can use Ask on a hub can read the context added there, so grant Ask only to people who may see all of it.
- **Keep `data-sources` and `build-request` gated too.** On a hub that sees rules, Data sources lists the known truths and who signed them off; Build request posts in the person's name.
- The admin role confers each key unless the profile declares it `admin_grantable: false`.

## A scoped pull: a list with a typed form

A `scoped-pull` module has no handler. Its manifest declares its inputs and names a fixed SQL file; the engine does the rest:

1. **Open** shows the form in the module's window: one input per parameter, defaults filled in. Its submit button is **Check values** (Slack requires a submit on any window with inputs).
2. **Check values** reads what was typed and checks it against the declarations. A problem shows beside its input, worded from the input's label. Good values replace the form with the values as plain text and **Confirm** and **Change** buttons.
3. **Change** returns to the form with the values filled in. **Confirm** runs the request once: a double click or a replay is told it is running or done.
4. **The results** replace the window: the row count, the values, the first 10 rows, and a link to the CSV of every row, which goes only to the person's DM with the bot (never a channel). The engine stops at 5,000 rows and says "the first 5,000 of N". Zero rows, a refused query, a failed one or the data being unavailable each get a plain message instead. A run that didn't finish still uses up that Confirm: open the module again from the menu to retry.

Each open form is a session bound to the person who opened it. A click by anyone else is refused, and after 30 minutes without use the form expires. Every step updates the same window in place.

The SQL is a static template with named placeholders (`$zone`, `$limit`), bound as parameters. Never build SQL from text, and never use `${`. Startup checks it without connecting to the data and stops, naming the module, unless:

- it passes the SQL checker, including the profile's forbidden columns (so a module can't select a barred column, or `*` while any is barred);
- every `$name` in it is a declared input, and every declared input appears in it. An optional input left empty is bound as `NULL`, so write `($code IS NULL OR code = $code)`.

Select only the columns the person needs: the CSV holds every column the query returns.

### A scored list

A scoped pull can rank its rows. The engine gives each row a whole-number score from 0 to 100 and a reason naming the two inputs that lifted it most, then orders the rows best first. No AI is involved: the same data and weights always give the same scores and order. The score and reason show in the module's window and as the CSV's first and last columns, and "How was this made?" lists the weights.

```json
"row_id": "client_id",
"scoring": {
  "inputs": [
    { "name": "months_as_client", "label": "Months as a client", "weight": 2, "min": 0, "max": 24 },
    { "name": "days_since_visit", "label": "Days since last completed visit", "weight": -1, "min": 0, "max": 120 }
  ],
  "limit_parameter": "limit"
}
```

Each input:

| Field | What it is |
|---|---|
| `name` | A column the query returns. |
| `label` | The input in plain words, used in each row's reason ("Months as a client: 31"). |
| `weight` | How much it counts. Negative means lower is better. At least one weight must not be 0. |
| `min`, `max` | A fixed range (`min` < `max`). A value is clipped to it and scaled to 0 to 1, so a row's score never depends on which other rows came back. |

The score is `round-half-up(100 × (S − Σneg) / (Σpos − Σneg))`, where S adds up weight × scaled value over the inputs, Σpos is the sum of the positive weights and Σneg the sum of the negative ones.

`limit_parameter` names the integer input that says how many rows to keep. The engine scores every row first and keeps the top that many, so the SQL must never use it (startup stops if it does). Instead, a scored list's SQL:

- returns every input column and the `row_id`;
- ends with `ORDER BY …, <row_id>` and then exactly `LIMIT 5001` (the 5,000-row cap plus one). The engine ranks the first 5,000 rows; if 5,001 come back, the person is told the ranking covers only the first 5,000 and to narrow the values;
- `COALESCE`s every input that can be null, to a number that means "worst" or "none" (`COALESCE(SUM(p.amount_cents), 0)`). A null, a missing column or a value that is not a number stops the run with a plain message naming the module and the input; it is never scored as 0. Numbers, numeric text (BIGINT, HUGEINT and DECIMAL columns arrive as text) and true/false (1/0) are accepted.

Two rows with the same `row_id` also stop the run, so the SQL must return one row per `row_id`. Startup also stops on a range with `min` at or above `max`, on every weight 0, and on a `limit_parameter` that is not a declared integer input.

### Pushing a list (approval-write)

An `approval-write` module is a scoped pull (the same form, SQL, scoring, results and "How was this made?") plus a push. Its result carries a **Push to <destination>** button for the person who ran it. Push shows a preview in the same window: the list name, how many rows go, the rows the system would refuse and why, a sample of 5 rows, and **Approve** and **Cancel**. Nothing is sent before that person approves, and only the rows they saw, from the preview's own copy. A run whose CSV didn't reach the person can't be pushed.

```json
"row_id": "client_id",
"write": {
  "connector": "email",
  "operation": "pushList",
  "destination": "email tool",
  "fields": ["client_id", "email", "first_name"],
  "send": { "external_ref": "client_id", "email": "email", "first_name": "first_name" },
  "list_name": "win-back-{zone}-{run_date}"
}
```

| Field | What it is |
|---|---|
| `connector` | The connector's folder in `app/connectors/` (`kit/templates/connector.md`). |
| `operation` | One of its write operations: one write per push. |
| `destination` | Where the list goes, in plain words: the button says "Push to email tool". |
| `fields` | The columns the query returns that the preview keeps (a scored list's score is kept too). Must include `row_id`. |
| `send` | What each pushed item holds: the connector's field name, then the `fields` entry it comes from. |
| `list_name` | The destination list's name. `{run_date}` is the pull's date in UTC; `{<input>}` is a required input with allowed values (`enum`). |

Startup stops, naming the module and the field, unless the module's `resource` is declared `admin_grantable: false` in the profile (a push sends client data out, so only people granted it by name may use it: the admin role alone doesn't), `row_id` is set and in `fields`, every `fields` entry is a column the query returns, `send` names only `fields`, `list_name` uses only those placeholders, and the connector exists, loads and declares `operation`. Every Push, Approve and Cancel click re-checks the person may still use the module here.

### Declaring inputs

Each entry in `parameters`:

| Field | What it is |
|---|---|
| `name` | Lower-case with underscores (`lapsed_days`). The SQL's `$name`. |
| `label` | The form's label, up to 60 characters. Defaults to the name. |
| `type` | `string`, `integer`, `number`, `boolean` or `date` (`YYYY-MM-DD`). |
| `description` | A hint under the input, up to 150 characters. |
| `enum` | The allowed values (at most 100), shown as a dropdown. |
| `min`, `max` | The range of an `integer` or `number`. |
| `pattern`, `max_length` | A `string`'s format (a regular expression the whole value must match) and its length (1 to 500). |
| `default` | Filled in when the form opens, and used when the input is left empty. It must pass its own declaration. |
| `required` | `true` when the input must have a value. |

Every input is bounded, or startup stops naming the module and the input:

- A `string` declares `enum`, or both `pattern` and `max_length`. So nothing a person types can reach Slack or the query as unexpected text.
- An `integer` or `number` declares `max` (and usually `min`), or `enum`.
- A range must be possible (`min` at most `max`), and bounds must fit the type (no `pattern` on a number).

For example (Brightside's Win-back list):

```json
"parameters": [
  { "name": "zone", "label": "Zone", "type": "string", "enum": ["north", "south", "east", "west", "central"], "required": true },
  { "name": "lapsed_days", "label": "Lapsed within (days)", "type": "integer", "min": 1, "max": 365, "default": 90, "required": true },
  { "name": "limit", "label": "How many clients", "type": "integer", "min": 1, "max": 500, "default": 50, "required": true }
],
"query": "win-back.sql"
```

## The handler

The handler gets one argument, `ctx`:

- `ctx.person`: `{ id, name }`, the Slack user who pressed Open.
- `ctx.client`: `{ id, name }`, from the profile.
- `ctx.module`: `{ id, label }`, from the manifest.
- `ctx.data.run(sql, params)`: the read-only, guarded query runner. `ctx.data.describe()` says which data it reads.
- `ctx.reply(text)`: a reply only the person sees. Opened from the hub modal, it renders in the module's own view (pushed onto the menu, "Loading…" until the first reply; each later reply is appended below the earlier ones, up to Slack's 100 blocks). Opened from an old menu message, it is a private (ephemeral) message as before. `ctx.reply({ text, blocks })` works in both.

App code imports engine helpers only from `#sdk` (`kit/runtime/sdk`), never another `kit/` path; a test fails if it does. The module's test uses `testContext()` from `#sdk` to run the handler without Slack or a data file.

## Why the resource is gated

The template's resource is declared without `open_access` on purpose. In a real fork, even things that look harmless (row counts, a list of names, an as-of date) are the client's business data. A module starts visible only to the people the profile grants it to, and opening it to everyone is a deliberate, reviewed change to the profile.

## Handler code is trusted, not sandboxed

Handler code is trusted, reviewed code: it goes through the same build loop and review as engine code. It is **not sandboxed**. It runs in the app's process and can reach `process.env`, including secrets. The protection against a person or an LLM reaching a secret is not isolation of handler code: it is that the LLM has no tools, and that every output passes through the redacting logger. So review a handler as you would engine code, and never echo environment values in a reply.
