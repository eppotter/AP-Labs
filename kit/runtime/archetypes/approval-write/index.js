'use strict';

// The approval-write archetype (Story 10.2, AD-15): a scoped pull plus a
// push. An approval-write module is a scoped-pull module (form, query,
// scoring, results, "How was this made?": kit/runtime/archetypes/scoped-pull
// runs all of it) with a manifest `write` block. This archetype adds only the
// push, through the scoped-pull runner's reuse hook (pushHooks below):
//
//   pushRows   which fields of the rows the person saw go into the run
//              record (the declared write.fields, plus the score when
//              scored), only for a run whose CSV reached them.
//   decorate   the result's "Push to <destination>" button, carrying the
//              run's random id.
//
// The scoped-pull engine never reads a write block: every read of one is in
// this folder (kit/verify/write-path.js keeps connector writes here too).
//
//   Push      re-checks the person may still use the module here (resolve,
//             as dispatch does), reads their run record (./preview), copies
//             its rows, names the list (write.list_name, with the pull's UTC
//             run date), sets aside the held rows (write.hold, Story 20.2:
//             listed with their reason, never given to the connector), runs
//             the write's dry-run plan on the rest so rows the tool would
//             refuse show as skipped (and, when the plan renders it, each
//             item's exact text: GRD-010), keys the push by the rows that
//             will be sent, stores the approval entry under a fresh token
//             (./entry) and shows the preview in the module's view.
//   Approve   the push (Story 10.3, ./push): the token (expired, unknown,
//             cancelled and another person's all get PreviewInvalid; a used
//             one tells only its approver "already running" or "already
//             done"), access re-checked, the kill switches, then consume and
//             send the entry's own rows once, with honest counts; a failure
//             is escalated quietly (./escalate).
//   Retry     "Retry the failed ones", offered only when a PartialFailure
//             says details.retrySafe === true: the same flow on a retry
//             entry holding only the failed rows, under a key derived from
//             the first push's (./entry retryEntry, review R2-1).
//   Cancel    re-checks access and the token, then consumes it and confirms.
//
// Startup (checkModule, called by the registry): the resource must be
// admin_grantable: false; row_id is required and in write.fields; every
// write.fields entry is a column the query returns; write.send names only
// write.fields; write.hold (optional) is a field, not the row id, and never
// sent; write.preview (optional) names only fields; write.list_name uses only
// {run_date} and required inputs with allowed values; the connector loads and
// declares write.operation (./connectors).

const { messageFor } = require('../../messages');
const { PreviewInvalid, PushRefused, ConfigFault } = require('../../errors');
const { codeText, ROW_CAP } = require('../scoped-pull/run');
const entry = require('./entry');
const preview = require('./preview');
const { checkWrite, createConnectors } = require('./connectors');
const { createPush, sendItems } = require('./push');
const { createEscalator } = require('./escalate');

const ARCHETYPE = 'approval-write';

// Whether name appears in code as a whole identifier (field names match
// ^[a-z][a-z0-9_]*$ in the schema, so they are safe in a pattern).
const identifierIn = (code, name) => new RegExp(`(^|[^A-Za-z0-9_$])${name}([^A-Za-z0-9_]|$)`, 'i').test(code);

// Every startup problem with an approval-write module, as sentences naming
// the field (the registry prefixes the module's file). sql: its SQL text.
function checkModule(mod, { appDir, profile, sql }) {
  if (!mod || mod.archetype !== ARCHETYPE) return [];
  const problems = [];
  const block = mod.write;
  const resource = ((profile && profile.resources) || []).find((r) => r.key === mod.resource);
  if (resource && resource.admin_grantable !== false) {
    problems.push(`field "resource" ${mod.resource} must be declared admin_grantable: false in the profile: a push sends client data out, so only people granted it by name may use it (AD-16)`);
  }
  if (!mod.row_id) problems.push('field "row_id" is required: it names the column that tells the pushed rows apart (the idempotency key is built from it)');
  else if (!block.fields.includes(mod.row_id)) problems.push(`field "write.fields" must include the row id "${mod.row_id}"`);
  const code = codeText(sql);
  for (const field of block.fields) {
    if (!identifierIn(code, field)) problems.push(`field "write.fields" names "${field}", which the module's query never returns`);
  }
  for (const [target, source] of Object.entries(block.send)) {
    if (!block.fields.includes(source)) problems.push(`field "write.send.${target}" names "${source}", which is not in write.fields`);
  }
  if (block.hold !== undefined) {
    if (!block.fields.includes(block.hold)) problems.push(`field "write.hold" names "${block.hold}", which is not in write.fields`);
    if (block.hold === mod.row_id) problems.push('field "write.hold" must not be the row id');
    for (const [target, source] of Object.entries(block.send)) {
      if (source === block.hold) problems.push(`field "write.send.${target}" sends "${source}", the write.hold field: a hold reason is shown in the preview, never sent`);
    }
  }
  for (const field of block.preview || []) {
    if (!block.fields.includes(field)) problems.push(`field "write.preview" names "${field}", which is not in write.fields`);
  }
  const listName = block.list_name;
  if (/[{}]/.test(listName.replace(/\{[a-z][a-z0-9_]*\}/g, ''))) {
    problems.push('field "write.list_name" has a "{" or "}" that is not a placeholder ({run_date}, or {<input>})');
  }
  const params = new Map((mod.parameters || []).map((p) => [p.name, p]));
  for (const name of preview.placeholders(listName)) {
    if (name === preview.RUN_DATE) continue;
    const p = params.get(name);
    if (!p) problems.push(`field "write.list_name" uses {${name}}, which is not a declared input or {run_date}`);
    else if (!Array.isArray(p.enum) || p.required !== true) {
      problems.push(`field "write.list_name" uses {${name}}; a list name may use only {run_date} and required inputs with allowed values (enum), so nothing typed freely reaches it`);
    }
  }
  problems.push(...checkWrite(mod, appDir));
  return problems;
}

// The run record's rowIds and rows (AD-15), for the scoped-pull runner: only
// for an approval-write module, and only the rows the person saw (after a
// scored module's cut), in rank order. rows holds the declared write.fields,
// plus the score when scored. A run whose CSV did not reach the person keeps
// neither (delivered false), so nothing they didn't fully receive can be
// pushed; a run with no rows keeps empty lists.
function pushRowsOf(mod, outcome, { delivered = true } = {}) {
  if (!mod || mod.archetype !== ARCHETYPE || !mod.write || !mod.row_id || !delivered) return { rowIds: null, rows: null };
  if (!outcome || !Array.isArray(outcome.rows)) return { rowIds: [], rows: [] };
  const { fields } = mod.write;
  return {
    rowIds: outcome.rows.map((r) => r[mod.row_id]),
    rows: outcome.rows.map((r) => {
      const picked = Object.fromEntries(fields.map((f) => [f, r[f] === undefined ? null : r[f]]));
      if (outcome.scored) picked.score = r.score;
      return picked;
    }),
  };
}

// The result with its Push button, when the run kept rows to push.
function decorate(mod, message, record) {
  if (!mod || mod.archetype !== ARCHETYPE || !record || !Array.isArray(record.rows) || !record.rows.length) return message;
  const blocks = Array.isArray(message.blocks) ? message.blocks.slice() : [];
  blocks.push(preview.pushButtonBlock(mod, record.runId));
  return { ...message, blocks };
}

// The scoped-pull runner's reuse hook (kit/runtime/archetypes/scoped-pull/run).
const pushHooks = Object.freeze({ pushRows: pushRowsOf, decorate });

// The rows the dry-run plan says the tool would refuse: [{ ref, reason }].
function skippedOf(planned, total) {
  const list = planned && planned.wouldWrite && Array.isArray(planned.wouldWrite.skipped) ? planned.wouldWrite.skipped : [];
  return list.slice(0, total);
}

// The row ids of the skipped rows (as strings), or null when a skip can't
// be matched to exactly one row by its row id (entry.rowIdsForRefs): the
// preview then refuses, so nothing it can't account for is ever approved
// (review R1-1).
function skippedIdsOf(mod, rows, skipped) {
  return entry.rowIdsForRefs(mod, rows, skipped.map((s) => (s ? s.ref : null)));
}

// store: the runtime store. connectors: createConnectors()'s registry.
// admin: who the person is told to contact. opsChannel: the profile's
// slack.ops_channel (a failed push is escalated there), or null (logged only).
function createApprovalWrite({
  store, log, connectors = null, admin = 'your admin', opsChannel = null,
}) {
  const { escalate } = createEscalator({ store, log, opsChannel });
  const pusher = createPush({
    store, log, connectors, admin, escalate,
  });
  // Push: show the preview in the view. resolve(moduleId) re-checks access
  // and the environment, as dispatch does: { mod } or { refusal }.
  async function push({ runId, person, resolve, show }) {
    const run = preview.readRun(store, runId, person);
    if (run.refusal) {
      log.info('push refused', { reason: 'run' });
      return show(run.refusal);
    }
    const { record } = run;
    const allowed = resolve(record.module);
    if (!allowed.mod) return show(allowed.refusal);
    const { mod } = allowed;
    if (!Array.isArray(record.rows)) {
      log.info('push refused', { module: mod.id, reason: 'not delivered' });
      return show(messageFor(new PushRefused('not_delivered')));
    }
    if (!record.rows.length) return show(messageFor(new PushRefused('empty')));
    if (record.rows.length > ROW_CAP) {
      // Never reached: the run record keeps only the rows the person saw.
      log.error('push refused: the run is over the row cap', { module: mod.id, rows: record.rows.length, cap: ROW_CAP });
      return show(messageFor(new ConfigFault({ admin })));
    }
    const connector = connectors && connectors.get(mod.write.connector);
    if (!connector) {
      log.error('push connector not loaded', { module: mod.id, connector: mod.write.connector });
      return show(messageFor(new ConfigFault({ admin })));
    }
    const rows = entry.copyRows(record.rows);
    const listName = preview.listNameOf(mod, record);
    // Held rows (write.hold, Story 20.2) never reach the connector, not even
    // its dry run: they are listed in the preview and kept out of the push.
    const held = rows.filter((r) => preview.isHeld(mod, r));
    const candidates = held.length ? rows.filter((r) => !preview.isHeld(mod, r)) : rows;
    let planned = null;
    if (candidates.length) {
      // The dry run's key: the rows offered to the connector. The entry's
      // key is set below from the rows that will actually be sent.
      const planKey = entry.idempotencyKey(listName, candidates.map((r) => r[mod.row_id]));
      try {
        // A dry run: the connector plans and sends nothing (AD-15).
        planned = await connector.write[mod.write.operation]({
          name: listName, contacts: sendItems(mod, candidates), idempotencyKey: planKey, listKey: planKey, dryRun: true,
        });
      } catch (err) {
        const words = messageFor(err, { admin });
        if (!words) throw err;
        log.warn('push preview refused', { module: mod.id, reason: err.code || err.name });
        return show(words);
      }
    }
    const refused = skippedOf(planned, candidates.length);
    const refusedIds = skippedIdsOf(mod, candidates, refused);
    if (!refusedIds) {
      log.error('push preview refused: a skipped item could not be matched to one row by its row id', { module: mod.id, skipped: refused.length });
      return show(messageFor(new ConfigFault({ admin })));
    }
    // A held row counts as skipped ("held") in the entry and the push's
    // reply, so the push leaves it out (entry.skippedIds) like any skip.
    const skipped = [...held.map(() => ({ reason: preview.HELD })), ...refused];
    const skippedIds = [...held.map((r) => String(r[mod.row_id])), ...refusedIds];
    if (skipped.length >= rows.length) {
      log.info('push previewed', {
        module: mod.id, rows: rows.length, skipped: skipped.length, held: held.length, token: false,
      });
      return show(preview.nothingToSendMessage({
        mod, listName, rows, skipped, held,
      }));
    }
    const skippedSet = new Set(skippedIds);
    const sending = rows.filter((r) => !skippedSet.has(String(r[mod.row_id])));
    // The connector's rendered text, when its plan gives one (Story 20.2,
    // GRD-010: the approver sees the exact text). It must name exactly the
    // rows that will be sent, or the preview refuses: nothing is approved
    // that the person couldn't read.
    const texts = preview.renderedOf(mod, planned, sending);
    if (texts && texts.problem) {
      log.error('push preview refused: the rendered text does not match the rows to send', { module: mod.id, problem: texts.problem });
      return show(messageFor(new ConfigFault({ admin })));
    }
    // The key covers only the rows that will be sent (Story 20.2 review): a
    // held or skipped row that can go later the same day is a new push, not
    // a replay of this one.
    const idempotencyKey = entry.idempotencyKey(listName, sending.map((r) => r[mod.row_id]));
    const token = entry.create(store, {
      person, module: mod.id, runId: record.runId, destination: mod.write.destination, listName, rows, skipped, skippedIds, idempotencyKey,
    });
    log.info('push previewed', {
      module: mod.id, rows: rows.length, skipped: skipped.length, held: held.length, token: true,
    });
    return show(preview.previewMessage({
      mod, listName, rows, skipped, token, held, sending, texts: texts ? texts.texts : null,
    }));
  }

  // The entry a token names, for this person, with access re-checked:
  // { found, mod } or { message }. Synchronous.
  function check(token, person, resolve, action) {
    const found = entry.lookup(store, token, person);
    if (found.status !== entry.STATUS.OK) {
      log.info('approval click refused', { action, reason: 'invalid' });
      return { message: messageFor(new PreviewInvalid()) };
    }
    const allowed = resolve(found.entry.module);
    if (!allowed.mod) return { message: allowed.refusal };
    return { found, mod: allowed.mod };
  }

  // Approve and Retry: the push (./push). client: the Slack client the
  // escalation posts with.
  function approve({
    token, person, resolve, show, client, action = 'approve',
  }) {
    return pusher.approve({
      token, person, resolve, show, client, action,
    });
  }

  // Cancel: consumes the token, synchronously after the check.
  function cancel({ token, person, resolve, show }) {
    const c = check(token, person, resolve, 'cancel');
    if (!c.mod) return show(c.message);
    entry.cancel(store, token, person);
    log.info('push cancelled', { module: c.mod.id });
    return show(preview.cancelledMessage(c.mod));
  }

  // A button: verb is push | approve | retry | cancel; value is what it carries.
  async function click({
    verb, value, person, resolve, show, client = null,
  }) {
    if (verb === 'push') return push({ runId: value, person, resolve, show });
    if (verb === 'approve' || verb === 'retry') {
      return approve({
        token: value, person, resolve, show, client, action: verb,
      });
    }
    if (verb === 'cancel') return cancel({ token: value, person, resolve, show });
    return show(messageFor(new PreviewInvalid()));
  }

  return { push, approve, cancel, click };
}

module.exports = {
  createApprovalWrite, createConnectors, checkModule, pushRowsOf, decorate, pushHooks, sendItems,
  ACTIONS: preview.ACTIONS, ACTION_PATTERN: preview.ACTION_PATTERN, verbOf: preview.verbOf, ARCHETYPE,
};
