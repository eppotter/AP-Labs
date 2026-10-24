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
| `archetype` | yes | `handler` (your code replies). `scoped-pull` and `approval-write` are valid in a manifest but refused at startup until their engine lands. |
| `environments` | yes | Where it shows, by `APLABS_ENV` (`["dev"]`, then `["dev", "prod"]` when it is ready). Off the menu, and refused if opened, everywhere else. |
| `handler` | for `handler` | The handler file in the module's folder (`handler.js`). It exports one async function. |
| `parameters` | later archetypes | The inputs a person gives: `name`, `type` (`string`, `integer`, `number`, `boolean`, `date`), optional `enum`, `min`, `max`, `default`, `required`, `description`. The query runner refuses a parameter the manifest does not declare. |
| `query` | later archetypes | A `.sql` file in the module's folder. |
| `scoring` | later archetypes | `inputs` and `weights` for a scored list. |
| `write` | `approval-write` | `connector`, `operation`, `destination` and the `fields` copied into the approval entry. |

## The handler

The handler gets one argument, `ctx`:

- `ctx.person`: `{ id, name }`, the Slack user who pressed Open.
- `ctx.client`: `{ id, name }`, from the profile.
- `ctx.module`: `{ id, label }`, from the manifest.
- `ctx.data.run(sql, params)`: the read-only, guarded query runner. `ctx.data.describe()` says which data it reads.
- `ctx.reply(text)`: a reply only the person sees.

App code imports engine helpers only from `#sdk` (`kit/runtime/sdk`), never another `kit/` path; a test fails if it does. The module's test uses `testContext()` from `#sdk` to run the handler without Slack or a data file.

## Why the resource is gated

The template's resource is declared without `open_access` on purpose. In a real fork, even things that look harmless (row counts, a list of names, an as-of date) are the client's business data. A module starts visible only to the people the profile grants it to, and opening it to everyone is a deliberate, reviewed change to the profile.

## Handler code is trusted, not sandboxed

Handler code is trusted, reviewed code: it goes through the same build loop and review as engine code. It is **not sandboxed**. It runs in the app's process and can reach `process.env`, including secrets. The protection against a person or an LLM reaching a secret is not isolation of handler code: it is that the LLM has no tools, and that every output passes through the redacting logger. So review a handler as you would engine code, and never echo environment values in a reply.
