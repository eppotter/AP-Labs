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
| `hub` | yes | The id of the hub whose menu lists it: a file `app/hubs/<hub>.json` must exist. |
| `label` | yes | The menu button's text, up to 60 characters. |
| `description` | yes | One line under the button, up to 200 characters. Say what it does for the person. |
| `resource` | yes | The profile resource key that grants it (`WEEKLY_REPORT`). It must be declared in the profile, or startup fails: a missing key is a setup fault, never shown to a person as a denial. |
| `archetype` | yes | `handler` (your code replies) or `scoped-pull` (a list with a typed form, no code: see below). `approval-write` is valid in a manifest but refused at startup until its engine lands. |
| `environments` | yes | Where it shows, by `APLABS_ENV` (`["dev"]`, then `["dev", "prod"]` when it is ready). Off the menu, and refused if opened, everywhere else. |
| `handler` | for `handler` | The handler file in the module's folder (`handler.js`). It exports one async function. |
| `parameters` | for `scoped-pull` | The inputs a person gives (see "Declaring inputs" below). The query runner refuses a parameter the manifest does not declare. |
| `query` | for `scoped-pull` | A `.sql` file in the module's folder. Startup fails if it is missing or empty. |
| `row_id` | with `scoring` | The column the query returns that tells rows apart (`client_id`). Equal scores are ordered by it. |
| `scoring` | no | A score from 0 to 100 and a one-line reason per row, worked out by the engine (see "A scored list" below). |
| `write` | `approval-write` | `connector`, `operation`, `destination` and the `fields` copied into the approval entry. |

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

Startup also stops on a range with `min` at or above `max`, on every weight 0, and on a `limit_parameter` that is not a declared integer input.

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
