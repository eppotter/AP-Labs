'use strict';

// Wires the registry to Slack (Story 6.2). Each hub's slash command opens its
// menu as a modal (kit/runtime/slack/modal); one action listener dispatches
// every Open click to the module's handler. Both go through handle(), so the
// ack comes first and any failure becomes a plain private message.
//
// Modals: an Open or Help click inside the hub modal pushes a view onto it
// (Slack's back arrow returns to the menu). A module's view shows "Loading…"
// until its first ctx.reply, and each later reply is appended below. Refusals,
// "not available", data-unavailable and the plain error render in the pushed
// view too. Fallback to the earlier private (ephemeral) replies, exactly as
// before: when views.open fails (an expired trigger, an API error) or there is
// no views client, and when a click comes from a message rather than a modal
// (an old menu still in a channel), or the first push fails and Slack gave a
// response_url. Each fallback is logged once at info, with the hub and Slack's
// error code only, never person data.
//
// Access (Story 6.3): the Slack id is mapped to a profile user
// (kit/runtime/access) and each entry's resource key is decided by
// kit/lib/permissions. The menu shows only what the person may use; an unknown
// person sees only open-access entries and is told who to ask. A click is
// re-checked at dispatch: an unknown module or one hidden in this environment
// gets the generic "not available"; a module the person may not use is refused
// by kit/runtime/messages (not set up, or no access to <label>); a resource
// key the profile does not declare is logged and reported as a configuration
// fault, never as a denial. A replayed or stale payload never runs a handler
// the menu would not show.
//
// Welcome and help (Story 6.4): the first time a person opens a hub (per
// person per hub, in the store's `welcome` namespace, so again after a restart
// or the 7-day TTL) the hub's welcome sits above the entries. Every menu ends
// with Help; a Help click re-reads the same access decision as the menu, so it
// never lists a module the person cannot open. A person joining the workspace
// (team_join) gets a private DM naming the hubs with at least one entry they
// can use.
//
// Seam: canUse(person, module) returns 'allowed' | 'denied' | 'error' (true
// and false are read as allowed and denied); person is { id, user } with user
// the profile user or null. Tests may inject their own.
//
// Data (Story 7.5): a handler gets ctx.data.run(sql, params), the query runner
// (kit/runtime/data) with the manifest's declared parameter names, so a
// parameter the manifest does not declare is refused. When the data is
// unavailable (a DataUnavailable error) the person is told so plainly, worded
// by kit/runtime/messages, and the app keeps running.
//
// Scoped pulls (Story 9.3): Open on a scoped-pull module pushes its typed form
// as the module's view (kit/runtime/archetypes/scoped-pull), so menu and
// module stay the only two views. The form has input blocks, so its view has
// a submit, "Check values" (Slack rejects an input view without one). Its
// view_submission is handled with handleView, which answers in the ack:
// { response_action: 'errors' } beside the inputs, or { response_action:
// 'update' } to the Confirm screen (or a refusal) in the same view. Confirm
// and Change are buttons on that screen; one listener re-checks access and
// updates the view the click came from in place (modal.updatedView:
// views.update with that view's id and hash), never pushing a third view. A
// hash_conflict means the view changed since the click: the out-of-date
// result is dropped and logged. A form needs the hub modal; opened from an
// old message menu, the person is told to open it from the hub window.
//
// Running (Story 9.5): Confirm shows "Running…" in the view, then runs the
// module's fixed SQL with only its declared inputs bound, through the query
// runner (archetypes/scoped-pull/run). The result replaces the view: the row
// count (capped at 5,000: "the first 5,000 of N"), the values, the first rows
// (escaped) and a link to the CSV, which goes only to the person's DM
// (conversations.open, then files.uploadV2 to that DM). Results are never
// posted in a channel. Zero rows, a refused query, a failed one, data
// unavailable or an undelivered CSV each get a plain message in the view.
//
// Plain English (Story 9.4): given the AI service (llm), the form also offers
// a request box and "Read my request". The service goes only to the reader
// (archetypes/scoped-pull/extract), never to the runner, so rows can't reach
// it. The click is a form button like Confirm; a follow-up question's submit
// (ANSWER_CALLBACK) is answered in the ack like "Check values".
//
// Approval write (Stories 10.2, 10.3): an approval-write module runs the same form,
// query and results as a scoped pull (its runner gets the archetype's reuse
// hook, so its result carries "Push to <destination>"). Push, Approve,
// Cancel and Retry the failed ones are buttons in the module's view; one listener updates that view in
// place, never a new one. Every click re-checks the person's grant and the
// environment the same way dispatch does (resolveModule), before the
// archetype (kit/runtime/archetypes/approval-write) looks at anything else.
// connectors: the instances the app made at boot (approval-write/connectors.js).
//
// Map images (Story 15.1, AD-R12, AD-R15): a reply may carry image: { png,
// alt } only from a module allowed to show one (kit/runtime/slack/image
// uploadsMapImages: the routing-map archetype or the dev-only map-check
// module); from any other module the image is refused, nothing is uploaded,
// the refusal is logged and the person gets the plain error. mapFiles is the
// lifecycle the app made (image.createMapFiles); when it is missing or not
// ready (no store, no Slack client, the sweep not running), a map module's
// Open shows "not available" and no map view opens (fail closed). A map
// module's view is pushed with notify_on_close and callback hub:map. The hub
// uploads the PNG (shared nowhere), records the file, then shows the image
// block in that view, replacing what was there, and deletes the view's
// earlier map files; a failed show deletes the new file at once. When Slack
// says the fresh file is not usable yet (invalid slack file), the show is
// tried again with backoff (mapFiles.showing); "map image shown" logs the
// attempt that worked. If every try fails the file is deleted at once, "map
// image not accepted by slack" is logged (attempts, Slack's code and
// messages) and the view shows the plain upload-failure message. An upload
// failure shows a plain message in the view, with Back. With no pushed view
// (the trigger expired and the reply went in place, or a click from a
// message) nothing is uploaded and the person is told to open it again.
// view_closed on a map view (Back, or the X) deletes all of that view's
// files; if it never arrives, the sweep deletes them within 20 minutes. The
// PNG is never logged: refusals and failures log a reason only.
// Fail closed (PR #222 review): an image is honoured only on that path, a
// module's reply from Open. Every other way a message reaches the person (a
// form, "How was this made?" or approval click, a form or answer submit, a
// form's open, Help, a reply's ephemeral or in-place fallback) passes through
// screened(), which refuses a message carrying an image: the refusal is
// logged (where, and a reason; never the PNG), the person gets the plain
// error, and nothing is uploaded or sent. The renderers (modal.messageBlocks,
// format.messageParts) throw on an image as a backstop.
//
// The routing map (Story 15.4, AD-R16, AD-R17): a routing-map module
// (kit/runtime/archetypes/routing-map) opens like map-check (a pushed view
// asking for view_closed, "Loading…" inside the trigger's life), then the
// archetype draws. Its view switches are select and date clicks
// (routing-map:view|day|crew|zone), each acked first and then drawn into the
// view the click came from (views.update with that view's hash). Every map,
// on Open or on a click, goes through the one lifecycle, showMap: upload,
// record, show, then delete the files recorded before this upload (a view
// switch); a map not shown is deleted at once. It also takes current(), the
// archetype's request-order check, asked before the upload and before each
// show, so a superseded click uploads nothing, or deletes what it uploaded;
// a show Slack drops on hash_conflict deletes its file too. Each update also
// asks current() again when its turn in the view's queue comes, so a click
// overtaken while waiting is skipped: its map is deleted, never shown. A
// plain result (an error, a refusal, "Drawing the map…") deletes the view's
// earlier files once it shows; so does the handler's plain error on an
// unexpected failure. A "map not shown" message dropped on hash_conflict
// (a newer update won) is logged and dropped quietly. Who may open it is the profile's routing audience
// (archetypes/routing-map/audience canOpen), not the manifest's resource.
//
// Plan a route (Story 15.14, AD-R26, AD-R27): a routing-map module with
// screen "route-editor" opens the same way, on the same listener and the
// same lifecycle. When the profile has no routing.depot or its adapter has
// no route(), Open shows "not available" and no modal opens (fail closed).
// Its reorders change the list at once under the picture already shown
// (showList): the same slack_file id (mapFiles.reuse: only while its record
// is live and it is under 10 minutes old), else the list with no image, and
// if Slack refuses the reused file (deleted, expired) the list is shown again
// with no image. The map follows through showMap, which then deletes the
// earlier file. An editor's map that fails (upload, ratelimited, not
// accepted) shows its fallback, the list with "Map not updated; the list is
// current.", instead of the plain "map not shown". The hub remembers which
// file each map view shows (shownFiles), forgotten when a plain message
// replaces the map and on view_closed.

const access = require('../access');
const {
  NotSetUp, AccessDenied, ConfigFault, DataUnavailable,
} = require('../errors');
const { messageFor, welcomeText, feedbackText, joinWelcomeText } = require('../messages');
const { handle, handleView, PLAIN_ERROR } = require('./handle');
const {
  buildMenu, buildHelp, moduleIdFromAction, hubIdFromHelpAction, OPEN_ACTION, HELP_ACTION,
} = require('../registry/menu');
const { isVisible } = require('../registry');
const {
  modalView, moduleView, messageBlocks, pushedView, fromModal, hasViews, failureReason, updatedView, HASH_CONFLICT,
} = require('./modal');
const { messageParts } = require('./format');
const {
  createScopedPull, createRunner, verbOf, parseMetadata, ACTION_PATTERN: FORM_ACTION, FORM_CALLBACK, ANSWER_CALLBACK,
} = require('../archetypes/scoped-pull');
const { createReader } = require('../archetypes/scoped-pull/extract');
const {
  PROVENANCE_ACTION, PROVENANCE_BACK_ACTION, PROVENANCE_PATTERN, keepingResult,
} = require('../archetypes/scoped-pull');
const {
  createApprovalWrite, pushHooks, verbOf: writeVerbOf, ACTION_PATTERN: WRITE_ACTION,
} = require('../archetypes/approval-write');
const { QUERY_ARCHETYPES } = require('../registry');
const {
  uploadsMapImages, ImageError, NotAccepted, fileNotReady,
} = require('./image');
const { textBlocks } = require('./format');
const routingAudience = require('../archetypes/routing-map/audience');
const { createRoutingMap, ACTION_PATTERN: ROUTING_MAP_ACTION } = require('../archetypes/routing-map');

const NOT_AVAILABLE = "That option isn't available here any more. Type the hub's command to see the current menu.";
const FORM_NEEDS_WINDOW = "This option's form opens in the hub's window. Type the hub's command and press Open on it there.";
const MAP_NOT_SHOWN = "The map couldn't be shown this time. Press Back to return to the menu, then try again in a minute.";
const MAP_NEEDS_WINDOW = "The map opens in its own window, which Slack didn't open this time. Type the hub's command and press Open again.";
// A map view: Slack sends view_closed for it (Back or the X).
const MAP_VIEW_CALLBACK = 'hub:map';
const MAP_VIEW = Object.freeze({ callbackId: MAP_VIEW_CALLBACK, notifyOnClose: true });
const MAX_MAP_VIEWS = 1000;
const hasImage = (message) => Boolean(message && typeof message === 'object' && Object.hasOwn(message, 'image'));
// An image anywhere a reply could be sent from: the message, or the text it
// falls back to when there is no view.
const carriesImage = (message) => hasImage(message)
  || Boolean(message && typeof message === 'object' && hasImage(message.ephemeralFallback));

// A routing-map module is decided by the profile's routing audience (AD-R17);
// every other module by its resource key.
function defaultCanUse(profile) {
  return (person, mod) => (mod.archetype === 'routing-map'
    ? routingAudience.canOpen(profile, person.user)
    : access.decide(profile, person.user, mod.resource));
}

// A map whose show was overtaken: a newer click (Superseded), or Slack
// dropped the update on hash_conflict (Dropped). Never shown to anyone.
class Superseded extends Error {}
class Dropped extends Error {}

function asDecision(v) {
  if (v === true || v === 'allowed') return 'allowed';
  if (v === false || v === 'denied') return 'denied';
  return 'error';
}

// The person's display name from users.info (users:read), else the name Slack
// sent with the payload, else a mention Slack renders as their name.
async function personName(client, user, log) {
  try {
    const res = client && client.users && await client.users.info({ user: user.id });
    const u = res && res.user;
    const name = u && ((u.profile && (u.profile.display_name || u.profile.real_name)) || u.real_name);
    if (name) return name;
  } catch (err) {
    log.warn('users.info failed; using the payload name', { err });
  }
  return user.name || `<@${user.id}>`;
}

function ephemeral(message) {
  const m = typeof message === 'string' ? { text: message } : message;
  return { response_type: 'ephemeral', replace_original: false, ...m };
}

// True the first time this person opens this hub; records the visit.
// Synchronous: no await between the check and the set (AD-7).
function firstVisit(store, slackId, hubId) {
  if (!store || typeof slackId !== 'string' || !slackId) return false;
  const key = `${slackId}:${hubId}`;
  if (store.get('welcome', key) !== undefined) return false;
  store.set('welcome', key, true);
  return true;
}

// team_join sends the user object; tolerate a bare id.
function joinedUser(event) {
  const u = event && event.user;
  if (typeof u === 'string') return { id: u };
  return u && typeof u === 'object' ? u : null;
}

// The data a module's handler sees: run() with the manifest's parameters as
// the declared names. Without a data source, every run is unavailable.
function moduleData(data, mod) {
  const declared = (mod.parameters || []).map((p) => p.name);
  return Object.freeze({
    run: (sql, params) => {
      if (!data) return Promise.reject(new DataUnavailable('no data source'));
      return data.run(sql, params, { declared });
    },
    describe: () => (data ? data.describe() : { source: null, label: null, available: false, problem: 'no data source' }),
  });
}

function registerHubs(app, {
  registry, profile, env, log, store, data = null, llm = null, connectors = null, canUse = defaultCanUse(profile),
  mapFiles = null, routingMap: routingMapOptions = {},
}) {
  const admin = access.adminContact(profile);
  const personOf = (slackId) => ({ id: slackId, user: access.personFor(profile, slackId) });
  const decide = (person, mod) => {
    const d = asDecision(canUse(person, mod));
    if (d === 'error') log.error('access configuration fault', { module: mod.id, resource: mod.resource });
    return d;
  };
  const visibleEntries = (hubId, person) => registry.entries(hubId)
    .filter((m) => isVisible(m, env) && decide(person, m) === 'allowed');
  const notSetUp = (person) => (person.user ? undefined : messageFor(new NotSetUp({ client: profile.client.name, admin })));
  const fellBack = (where, reason, hub, via) => log.info('hub modal fallback', { where, reason, hub: hub || null, ...(via ? { via } : {}) });
  // A message on any path but the map lifecycle: one carrying an image is
  // refused and replaced by the plain error (fail closed).
  const screened = (where, message) => {
    if (!carriesImage(message)) return message;
    log.warn('image refused', { where, reason: 'not on the map view path' });
    return PLAIN_ERROR;
  };
  // The runner keeps each result as shown, so "Back to the list" can put it
  // back; Back rebuilds the Push button with the same hook.
  const hooks = keepingResult(pushHooks, store, log);
  const scopedPull = createScopedPull({
    store, log, run: createRunner({ data, log, admin, store, hooks }), read: llm ? createReader({ llm, log }) : null,
    decorate: pushHooks.decorate,
  });
  // A failed push is escalated to the profile's slack.ops_channel (Story
  // 10.3); with none set, it is logged only.
  const opsChannel = (profile.slack && profile.slack.ops_channel) || null;
  const approvalWrite = createApprovalWrite({
    store, log, connectors, admin, opsChannel,
  });
  // The routing map (Story 15.4). Its views ask Slack for view_closed and
  // carry only the session id. routingMapOptions: test seams (mapPoints,
  // render, now); never the AI service.
  const mapViews = new Map(); // routing map view id -> { hash, queue }
  // owner -> { id, alt, caption }: the map file a view shows now (Story 15.14).
  const shownFiles = new Map();
  const routingMap = createRoutingMap({
    ...routingMapOptions, profile, data, log, admin, viewModal: (sessionId) => ({ ...MAP_VIEW, privateMetadata: sessionId }),
  });

  // Why this person may not open mod (a message), or null when they may.
  // The refusal is logged with the click's action id.
  const refusalFor = (person, mod, actionId) => {
    const decision = decide(person, mod);
    if (decision === 'allowed') return null;
    let refusal;
    if (decision === 'error') refusal = new ConfigFault({ admin });
    else if (!person.user) refusal = new NotSetUp({ client: profile.client.name, admin });
    else refusal = new AccessDenied({ label: mod.label, admin });
    log.warn('hub action refused', { action_id: actionId, reason: refusal.name, user: person.user ? person.user.id : null, env });
    return messageFor(refusal);
  };

  // The module a click names, if this person may still open it here: { mod }
  // or { refusal }. Synchronous, so Confirm can consume with no await after
  // the check. archetypes: the ones this click may act on. A form step
  // (resolveForm) takes a scoped pull or an approval write; Push, Approve and
  // Cancel take only an approval write.
  const resolveModule = (person, actionId, archetypes) => (moduleId) => {
    const mod = registry.module(moduleId);
    if (!mod || !archetypes.has(mod.archetype) || !isVisible(mod, env)) {
      log.warn('hub action refused', {
        action_id: actionId, reason: !mod ? 'unknown module' : 'not available', user: person.user ? person.user.id : null, env,
      });
      return { refusal: NOT_AVAILABLE };
    }
    const refused = refusalFor(person, mod, actionId);
    return refused ? { refusal: refused } : { mod };
  };
  const resolveForm = (person, actionId) => resolveModule(person, actionId, QUERY_ARCHETYPES);
  const WRITES = new Set(['approval-write']);

  // Where a click's replies go. From a hub modal: a view pushed onto it
  // (reply() pushes, then appends; loading() pushes "Loading…" first). From a
  // message: the ephemeral reply, as before. If the first push fails and Slack
  // gave a response_url, this click falls back to ephemeral replies. A click
  // inside a modal has no response_url (#114), so there the reply instead
  // replaces the view the click came from (views.update on body.view.id),
  // later replies appended below it, and the fallback is logged.
  const replyTarget = ({ body, respond, client }, {
    where, title, hubId, viewOptions,
  }) => {
    // A long text reply goes as section blocks, in more than one message if
    // it needs over 50 blocks (kit/runtime/slack/format).
    // A message that works only in a view (a form) names what to send instead.
    const viaEphemeral = async (message) => {
      const m = message && typeof message === 'object' && message.ephemeralFallback !== undefined ? message.ephemeralFallback : message;
      for (const part of messageParts(m)) await respond(ephemeral(part));
    };
    if (!fromModal(body) || !hasViews(client)) {
      fellBack(where, fromModal(body) ? 'no views client' : 'not from a modal', hubId);
      return {
        modal: false, loading: async () => {}, reply: (m) => viaEphemeral(screened(where, m)), viewId: () => null,
      };
    }
    const view = pushedView({
      client, triggerId: body.trigger_id, title, hubId, viewOptions,
    });
    const fromId = typeof body.view.id === 'string' && body.view.id ? body.view.id : null;
    // In place: the replies so far, all shown in the view the click came from.
    // force: a hash conflict (the view changed since the click) must not drop
    // the only thing this person will see.
    const inPlace = fromId ? updatedView({ client, view: body.view, title, hubId }) : null;
    const shownInPlace = [];
    const viaUpdate = async (message) => {
      if (message === undefined) return undefined; // loading(): nothing to show
      shownInPlace.push(message);
      const last = shownInPlace.at(-1);
      const modal = last && typeof last === 'object' ? last.modal : undefined;
      try {
        await inPlace.show({ blocks: shownInPlace.flatMap(messageBlocks), ...(modal ? { modal } : {}) }, { force: true });
      } catch (err) {
        // Once in place is the only way left to reach the person, a failed
        // update is logged (Slack's code, never the payload) and the handler
        // goes on, so its later replies still get their chance (#166).
        shownInPlace.pop();
        log.error('in-place reply failed', { where, reason: failureReason(err), hub: hubId || null });
      }
      return undefined;
    };
    let fallback = null; // null, or the function every later reply goes to
    const guarded = (fn) => async (message, opts) => {
      if (fallback) return message === undefined ? undefined : fallback(message);
      try {
        return await fn(message, opts);
      } catch (err) {
        if (view.pushed) throw err;
        if (typeof respond === 'function') {
          fallback = viaEphemeral;
          fellBack(where, failureReason(err), hubId);
        } else if (inPlace) {
          fallback = viaUpdate;
          fellBack(where, failureReason(err), hubId, 'views.update');
        } else {
          throw err;
        }
        return message === undefined ? undefined : fallback(message);
      }
    };
    const show = guarded((m, opts) => view.show(m, opts));
    return {
      modal: true,
      loading: guarded(() => view.loading()),
      reply: (m, opts) => show(screened(where, m), opts),
      // The pushed view's id, or null when the replies go anywhere else.
      viewId: () => (fallback || !view.pushed ? null : view.id),
    };
  };

  // The one map lifecycle (Stories 15.1 and 15.4, AD-R15, AD-R16). message:
  // { image: { png, alt }, head?, text?, blocks?, modal? }, shown as head,
  // text, the image block, blocks. show(message) renders into the map view
  // (it throws Dropped when Slack dropped the update). owner ties the files
  // to this person and this view, for view_closed. current(): false once a
  // newer request has come in; asked before the upload and before each show,
  // and passed to show(message, { current }) so a show that waits its turn
  // (a click's update queue) asks again just before it goes to Slack and
  // throws Superseded instead (PR #226 review).
  // Resolves 'shown', 'superseded', 'dropped', 'failed' or 'refused'.
  const showMap = async ({
    mod, owner, message, show, current = () => true,
  }) => {
    const {
      image, head = [], text: words, blocks: tail = [], modal, caption = [], fallback,
    } = message;
    // The plain "map not shown" message, or the message's own fallback (Plan
    // a route: the list stays). A newer request (Superseded) or a newer
    // update to the view (Dropped, hash_conflict) won: nothing to tell, and
    // the view's files are that newer show's to replace.
    const notShown = async (earlier) => {
      if (!current()) return;
      if (typeof fallback === 'function') {
        await fallback();
        return;
      }
      try {
        await show({ blocks: [...head, ...textBlocks(MAP_NOT_SHOWN)], ...(modal ? { modal } : {}) }, { current });
      } catch (err) {
        if (err instanceof Superseded) {
          log.info('map superseded', { module: mod.id, step: 'not shown' });
          return;
        }
        if (err instanceof Dropped) {
          log.info('stale view result dropped', { action: 'map not shown', reason: 'hash_conflict' });
          return;
        }
        throw err;
      }
      await mapFiles.release(owner, { among: earlier, why: 'replaced' });
    };
    if (!uploadsMapImages(mod)) {
      log.warn('image refused', { module: mod.id, reason: 'this module may not show images' });
      await show(PLAIN_ERROR);
      return 'refused';
    }
    if (!current()) {
      log.info('map superseded', { module: mod.id, step: 'upload' });
      return 'superseded';
    }
    const earlier = mapFiles.filesOf(owner);
    let block;
    try {
      block = await mapFiles.upload({ owner, png: image && image.png, alt: image && image.alt });
    } catch (err) {
      log.warn('map not shown', { module: mod.id, reason: err instanceof ImageError ? err.reason : failureReason(err) });
      await notShown(earlier);
      return 'failed';
    }
    const fileId = block.slack_file.id;
    const text = typeof words === 'string' && words ? textBlocks(words) : [];
    const shown = { blocks: [...head, ...text, block, ...caption, ...tail], ...(modal ? { modal } : {}) };
    let attempt;
    try {
      attempt = await mapFiles.showing(async () => {
        if (!current()) throw new Superseded();
        await show(shown, { current });
      });
    } catch (err) {
      await mapFiles.release(owner, { only: fileId, why: 'not shown' });
      if (err instanceof Superseded) {
        log.info('map superseded', { module: mod.id, step: 'show' });
        return 'superseded';
      }
      if (err instanceof Dropped) {
        log.info('stale view result dropped', { action: 'map', reason: 'hash_conflict' });
        return 'dropped';
      }
      if (!(err instanceof NotAccepted)) throw err;
      log.error('map image not accepted by slack', {
        module: mod.id, attempts: err.attempts, reason: err.reason, messages: err.messages,
      });
      await notShown(earlier);
      return 'failed';
    }
    log.info('map image shown', { module: mod.id, attempt });
    shownFiles.set(owner, { id: fileId, alt: block.alt_text, caption });
    // A view switch: the maps recorded before this upload go now; a newer
    // click's file, recorded after it, is never touched.
    await mapFiles.release(owner, { among: earlier, why: 'replaced' });
    return 'shown';
  };

  // Plan a route's list, shown at once under the picture the view already
  // shows (Story 15.14, AD-R27). message: { head, blocks, modal }, shown as
  // head, the reused image and its caption, blocks. The image is reused only
  // when mapFiles.reuse allows it; when Slack refuses the reused file, the
  // list is shown again with no image. A file no longer shown is deleted.
  const showList = async (owner, show, message, { current } = {}) => {
    const { head = [], blocks: tail = [], modal } = message;
    const opts = modal ? { modal } : {};
    const prev = shownFiles.get(owner) || null;
    let reused = null;
    if (prev) {
      const got = mapFiles.reuse(owner, prev.id, prev.alt);
      if (got.block) reused = got.block;
      else log.info('map image not reused', { reason: got.reason });
    }
    const bare = { blocks: [...head, ...tail], ...opts };
    if (reused) {
      try {
        await show({ blocks: [...head, reused, ...prev.caption, ...tail], ...opts }, { current });
        return;
      } catch (err) {
        if (!fileNotReady(err)) throw err;
        log.info('map image not reused', { reason: 'refused by slack' });
      }
    }
    await show(bare, { current });
    if (prev) {
      if (shownFiles.get(owner) === prev) shownFiles.delete(owner);
      await mapFiles.release(owner, { only: prev.id, why: 'replaced' });
    }
  };

  // A plain message into a map view; once it shows, the view's earlier map
  // files go (it no longer shows them).
  const showPlain = async (owner, show, message) => {
    const earlier = mapFiles ? mapFiles.filesOf(owner) : [];
    const prev = shownFiles.get(owner);
    await show(message);
    if (prev && shownFiles.get(owner) === prev) shownFiles.delete(owner);
    if (earlier.length) await mapFiles.release(owner, { among: earlier, why: 'replaced' });
  };

  // A map module's reply with an image (Story 15.1), on Open.
  const showImage = async (mod, target, userId, message) => {
    if (!uploadsMapImages(mod)) {
      log.warn('image refused', { module: mod.id, reason: 'this module may not show images' });
      await target.reply(PLAIN_ERROR);
      return;
    }
    const viewId = target.viewId();
    if (!viewId || !mapFiles) {
      log.warn('image refused', { module: mod.id, reason: 'no map view' });
      await target.reply(MAP_NEEDS_WINDOW);
      return;
    }
    await showMap({
      mod, owner: `${userId}:${viewId}`, message, show: (m) => target.reply(m, { replace: true }),
    });
  };

  // Open on a routing-map module (Story 15.4): "Loading…" is pushed first,
  // inside the trigger's life; the archetype draws after.
  const openRoutingMap = async (mod, target, person) => {
    await target.loading();
    const viewId = target.viewId();
    if (!viewId || !mapFiles) {
      log.warn('image refused', { module: mod.id, reason: 'no map view' });
      await target.reply(MAP_NEEDS_WINDOW);
      return;
    }
    log.info('module dispatched', { module: mod.id, hub: mod.hub });
    const owner = `${person.id}:${viewId}`;
    const render = (m) => target.reply(m, { replace: true });
    await routingMap.open({
      mod,
      person,
      viewId,
      resolve: resolveModule(person, `${mod.id}:open`, ROUTING_MAPS),
      show: (m) => showPlain(owner, render, m),
      showMap: (message, { current, mod: drawn = mod } = {}) => showMap({
        mod: drawn, owner, message, show: render, current,
      }),
    });
  };

  // In a modal there is no response_url for handle() to answer through, so a
  // failure is logged and the plain error is shown in the pushed view.
  const failInView = async (name, target, err) => {
    log.error('handler failed', { handler: name, err });
    try {
      await target.reply(PLAIN_ERROR);
    } catch (replyErr) {
      log.error('could not tell the person about a failure', { handler: name, err: replyErr });
    }
  };

  for (const hub of registry.hubs) {
    app.command(hub.command, handle(`hub:${hub.id}`, async ({ command, respond, client }) => {
      const person = personOf(command.user_id);
      const welcome = firstVisit(store, command.user_id, hub.id) ? welcomeText(hub) : undefined;
      const menu = buildMenu(hub, visibleEntries(hub.id, person), { notice: notSetUp(person), welcome });
      if (!hasViews(client) || typeof command.trigger_id !== 'string' || !command.trigger_id) {
        fellBack('command', hasViews(client) ? 'no trigger_id' : 'no views client', hub.id);
      } else {
        try {
          // The divider and Help stay at the end of a menu cut to Slack's limit.
          const view = modalView({ title: hub.name, blocks: menu.blocks, hubId: hub.id, keepTail: 2, callbackId: 'hub:menu' });
          await client.views.open({ trigger_id: command.trigger_id, view });
          return;
        } catch (err) {
          fellBack('command', failureReason(err), hub.id);
        }
      }
      await respond(ephemeral(menu));
    }, { log, store }));
  }

  app.action(HELP_ACTION, handle('hub:help', async (args) => {
    const { action, body } = args;
    const actionId = action && action.action_id;
    const hubId = hubIdFromHelpAction(actionId);
    const hub = registry.hubs.find((h) => h.id === hubId);
    const target = replyTarget(args, { where: 'help', title: hub ? `Help: ${hub.name}` : 'Help', hubId: hub ? hub.id : null });
    try {
      if (!hub) {
        log.warn('hub action refused', { action_id: actionId, reason: 'unknown hub', env });
        await target.reply(NOT_AVAILABLE);
        return;
      }
      const person = personOf((body.user || {}).id);
      await target.reply(buildHelp(hub, visibleEntries(hub.id, person), {
        notice: notSetUp(person),
        feedback: feedbackText(hub, admin),
      }));
    } catch (err) {
      if (!target.modal) throw err;
      await failInView('hub:help', target, err);
    }
  }, { log, store }));

  app.event('team_join', handle('team-join', async ({ event, client }) => {
    const user = joinedUser(event);
    if (!user || typeof user.id !== 'string' || !user.id || user.is_bot || user.deleted) return;
    const person = personOf(user.id);
    const hubs = registry.hubs.filter((h) => visibleEntries(h.id, person).length > 0);
    const text = joinWelcomeText({ client: profile.client.name, hubs, notice: notSetUp(person), admin });
    await client.chat.postMessage({ channel: user.id, text });
    log.info('join welcome sent', { hubs: hubs.map((h) => h.command), set_up: Boolean(person.user) });
  }, { log, store }));

  app.action(OPEN_ACTION, handle('hub:dispatch', async (args) => {
    const { action, body, client } = args;
    const user = body.user || {};
    const actionId = action && action.action_id;
    const mod = registry.module(moduleIdFromAction(actionId));
    const shown = mod && isVisible(mod, env);
    // A map module opens only when its files can be cleaned up, and Plan a
    // route only with an Office and an adapter route() (fail closed).
    const mapModule = Boolean(shown && uploadsMapImages(mod));
    const mapBlocked = mapModule && !(mapFiles && mapFiles.ready());
    const editorBlocked = mapModule && !mapBlocked && mod.archetype === 'routing-map' && routingMap.unready(mod);
    const opens = shown && !mapBlocked && !editorBlocked;
    const target = replyTarget(args, {
      where: 'open', title: opens ? mod.label : 'Not available', hubId: opens ? mod.hub : null, viewOptions: opens && mapModule ? MAP_VIEW : undefined,
    });
    try {
      if (!shown) {
        log.warn('hub action refused', { action_id: actionId, reason: !mod ? 'unknown module' : 'hidden in this environment', env });
        await target.reply(NOT_AVAILABLE);
        return;
      }
      if (mapBlocked) {
        log.warn('hub action refused', { action_id: actionId, reason: 'map files cannot be cleaned up', env });
        await target.reply(NOT_AVAILABLE);
        return;
      }
      if (editorBlocked) {
        log.warn('hub action refused', { action_id: actionId, reason: editorBlocked, env });
        await target.reply(NOT_AVAILABLE);
        return;
      }
      const person = personOf(user.id);
      const refused = refusalFor(person, mod, actionId);
      if (refused) {
        await target.reply(refused);
        return;
      }
      if (QUERY_ARCHETYPES.has(mod.archetype)) {
        log.info('module dispatched', { module: mod.id, hub: mod.hub });
        await target.reply(target.modal ? { ...scopedPull.open(mod, user.id), ephemeralFallback: FORM_NEEDS_WINDOW } : FORM_NEEDS_WINDOW);
        return;
      }
      if (mod.archetype === 'routing-map') {
        await openRoutingMap(mod, target, person);
        return;
      }
      // Push "Loading…" before anything slow: the trigger_id lasts 3 seconds.
      await target.loading();
      const name = await personName(client, user, log);
      log.info('module dispatched', { module: mod.id, hub: mod.hub });
      try {
        await mod.run({
          person: { id: user.id, name },
          client: { id: profile.client.id, name: profile.client.name },
          module: { id: mod.id, label: mod.label },
          data: moduleData(data, mod),
          reply: (message) => (hasImage(message) ? showImage(mod, target, user.id, message) : target.reply(message)),
        });
      } catch (err) {
        if (!(err instanceof DataUnavailable)) throw err;
        log.warn('data unavailable', { module: mod.id, reason: err.reason });
        await target.reply(messageFor(err));
      }
    } catch (err) {
      if (!target.modal) throw err;
      await failInView('hub:dispatch', target, err);
    }
  }, { log, store }));

  // A map view closed (Back, or the X): its files go now (Story 15.1). Only
  // the files this person's view recorded; a payload naming another view or
  // person matches nothing.
  app.view({ callback_id: MAP_VIEW_CALLBACK, type: 'view_closed' }, handle('hub:map-closed', async ({ body }) => {
    const viewId = body && body.view && body.view.id;
    const userId = body && body.user && body.user.id;
    if (typeof viewId !== 'string' || !viewId || typeof userId !== 'string' || !userId) return;
    routingMap.closed({ userId, viewId });
    mapViews.delete(viewId);
    shownFiles.delete(`${userId}:${viewId}`);
    if (!mapFiles) return;
    const res = await mapFiles.release(`${userId}:${viewId}`, { why: 'view_closed' });
    log.info('map view closed', { deleted: res.deleted, kept: res.kept, cleared: Boolean(body.is_cleared) });
  }, { log, store }));

  // A routing map's select or date click (Story 15.4). Acked first (handle),
  // then drawn into the view the click came from, in place. Every click
  // re-checks the person's access and environment (resolveModule), and the
  // archetype re-decides their scope from the audience. A map only ever
  // lives in a view, so a click from anywhere else is told to open it there.
  const ROUTING_MAPS = new Set(['routing-map']);
  // Every update to one map view goes through one queue, with the latest
  // hash this app saw for it, so two quick clicks never trip over each
  // other's updates: hash_conflict then means the view changed elsewhere,
  // and that result is dropped. Forgotten on view_closed; at most 1000 kept.
  const mapViewOf = (from) => {
    let v = mapViews.get(from.id);
    if (!v) {
      if (mapViews.size >= MAX_MAP_VIEWS) mapViews.delete(mapViews.keys().next().value);
      v = { hash: typeof from.hash === 'string' && from.hash ? from.hash : null, queue: Promise.resolve() };
      mapViews.set(from.id, v);
    }
    return v;
  };
  const mapUpdater = (client, from) => {
    const v = mapViewOf(from);
    const title = from.title && from.title.text;
    // current: when given, asked again when this update's turn comes; false
    // means a newer click came in while it waited, so it is skipped
    // ('superseded') and never shown.
    return (message, { current } = {}) => {
      const next = v.queue.then(async () => {
        if (typeof current === 'function' && !current()) return 'superseded';
        try {
          const res = await client.views.update({
            view_id: from.id, ...(v.hash ? { hash: v.hash } : {}), view: moduleView({ title, hubId: null, blocks: messageBlocks(message), message }),
          });
          if (res && res.view && typeof res.view.hash === 'string') v.hash = res.view.hash;
          return 'updated';
        } catch (err) {
          if (failureReason(err) === HASH_CONFLICT) return 'dropped';
          throw err;
        }
      });
      v.queue = next.catch(() => {});
      return next;
    };
  };
  app.action(ROUTING_MAP_ACTION, handle('hub:routing-map', async ({
    action, body, client, respond,
  }) => {
    const from = body.view;
    if (!from || typeof from.id !== 'string' || !from.id || !hasViews(client) || !mapFiles) {
      fellBack('routing-map', from ? 'no views client' : 'not from a modal', null);
      if (typeof respond === 'function') await respond(ephemeral(MAP_NEEDS_WINDOW));
      return;
    }
    const userId = (body.user || {}).id;
    const person = personOf(userId);
    const owner = `${userId}:${from.id}`;
    // Every render keeps the map view's callback (view_closed) and metadata.
    const keep = { ...MAP_VIEW, privateMetadata: typeof from.private_metadata === 'string' ? from.private_metadata : '' };
    const update = mapUpdater(client, from);
    const render = async (message, { current } = {}) => {
      const m = screened('routing-map', message);
      const full = typeof m === 'string' ? { text: m } : m;
      const status = await update(full.modal ? full : { ...full, modal: keep }, { current });
      if (status === 'dropped') throw new Dropped();
      if (status === 'superseded') throw new Superseded();
    };
    const show = async (message, { current } = {}) => {
      try {
        await showPlain(owner, (m) => render(m, { current }), message);
      } catch (err) {
        if (err instanceof Superseded) {
          log.info('map superseded', { module: 'routing-map', step: 'plain' });
          return;
        }
        if (!(err instanceof Dropped)) throw err;
        log.info('stale view result dropped', { action: 'routing-map', reason: 'hash_conflict' });
      }
    };
    try {
      await routingMap.click({
        actionId: action && action.action_id,
        action,
        from,
        person,
        resolve: resolveModule(person, action && action.action_id, ROUTING_MAPS),
        show,
        showMap: (message, { current, mod }) => showMap({
          mod, owner, message, show: render, current,
        }),
        showList: async (message, { current } = {}) => {
          try {
            await showList(owner, render, message, { current });
          } catch (err) {
            if (err instanceof Superseded) {
              log.info('map superseded', { module: 'routing-map', step: 'list' });
              return;
            }
            if (!(err instanceof Dropped)) throw err;
            log.info('stale view result dropped', { action: 'routing-map', reason: 'hash_conflict' });
          }
        },
      });
    } catch (err) {
      // The plain error replaces whatever the view showed, so the view's
      // map files go too (not at the sweep, PR #226 review): the ones
      // recorded by now, whether or not the plain error shows. A failed
      // delete keeps its record for the sweep (mapFiles.release).
      log.error('handler failed', { handler: 'hub:routing-map', err });
      const earlier = mapFiles.filesOf(owner);
      shownFiles.delete(owner);
      try {
        await update({ text: PLAIN_ERROR, modal: keep });
      } catch (showErr) {
        log.error('could not tell the person about a failure', { handler: 'hub:routing-map', err: showErr });
      }
      if (earlier.length) {
        try {
          await mapFiles.release(owner, { among: earlier, why: 'error' });
        } catch (releaseErr) {
          log.warn('map files not released after a failure; kept for the next sweep', { reason: failureReason(releaseErr) });
        }
      }
    }
  }, { log, store }));

  // A scoped-pull form's submit ("Check values"). The answer goes in the ack:
  // errors beside the inputs, or the Confirm screen (or a refusal) in place.
  const submittedView = (view, message, where) => {
    const shown = screened(where, message);
    return moduleView({
      title: view && view.title && view.title.text,
      hubId: parseMetadata(view && view.private_metadata).hubId,
      blocks: messageBlocks(shown),
      message: shown,
    });
  };
  // The follow-up question's submit (Story 9.4) is answered the same way.
  for (const [callback, name, step] of [[FORM_CALLBACK, 'hub:form-submit', 'submit'], [ANSWER_CALLBACK, 'hub:form-answer', 'answer']]) {
    app.view(callback, handleView(name, ({ body }) => {
      const view = body.view || {};
      const person = personOf((body.user || {}).id);
      const { sessionId } = parseMetadata(view.private_metadata);
      const res = scopedPull[step]({ sessionId, person: person.id, state: view.state, resolve: resolveForm(person, callback) });
      if (res.errors) return { response_action: 'errors', errors: res.errors };
      return { response_action: 'update', view: submittedView(view, res.message, `form-${step}`) };
    }, { log, onError: ({ body }) => ({ response_action: 'update', view: submittedView(body && body.view, PLAIN_ERROR, `form-${step}`) }) }));
  }

  // The Confirm screen's buttons. Each click updates the view it came from.
  app.action(FORM_ACTION, handle('hub:form', async ({ action, body, client, respond }) => {
    const verb = verbOf(action && action.action_id);
    const from = body.view;
    if (!from || typeof from.id !== 'string' || !from.id || !hasViews(client)) {
      fellBack('form', from ? 'no views client' : 'not from a modal', null);
      if (typeof respond === 'function') await respond(ephemeral(FORM_NEEDS_WINDOW));
      return;
    }
    const { hubId } = parseMetadata(from.private_metadata);
    const view = updatedView({ client, view: from, title: from.title && from.title.text, hubId });
    const show = async (message, opts) => {
      const status = await view.show(screened('form', message), opts);
      if (status === 'dropped') log.info('stale view result dropped', { action: verb, reason: 'hash_conflict' });
      if (status === 'forced') log.info('stale view replaced by a confirmed result', { action: verb, reason: 'hash_conflict' });
      return status;
    };
    const person = personOf((body.user || {}).id);
    try {
      await scopedPull.click({
        verb, sessionId: action.value, person: person.id, resolve: resolveForm(person, action.action_id), show, client, state: from.state,
      });
    } catch (err) {
      log.error('handler failed', { handler: 'hub:form', err });
      try {
        await view.show(PLAIN_ERROR);
      } catch (showErr) {
        log.error('could not tell the person about a failure', { handler: 'hub:form', err: showErr });
      }
    }
  }, { log, store }));

  // "How was this made?" (Story 9.6) on a result, and "Back to the list" on
  // its details. Updates the view the button is in with the run's details,
  // or the result again, for the person who ran it only, re-checking they
  // may still open the module. A result is only ever shown in a view, so a
  // click from anywhere else is told to use the hub window.
  app.action(PROVENANCE_PATTERN, handle('hub:provenance', async ({ action, body, client, respond }) => {
    const from = body.view;
    if (!from || typeof from.id !== 'string' || !from.id || !hasViews(client)) {
      fellBack('provenance', from ? 'no views client' : 'not from a modal', null);
      if (typeof respond === 'function') await respond(ephemeral(FORM_NEEDS_WINDOW));
      return;
    }
    const { hubId } = parseMetadata(from.private_metadata);
    const view = updatedView({ client, view: from, title: from.title && from.title.text, hubId });
    const show = async (message) => {
      const status = await view.show(screened('provenance', message));
      if (status === 'dropped') log.info('stale view result dropped', { action: 'provenance', reason: 'hash_conflict' });
      return status;
    };
    const person = personOf((body.user || {}).id);
    const actionId = action && action.action_id === PROVENANCE_BACK_ACTION ? PROVENANCE_BACK_ACTION : PROVENANCE_ACTION;
    const step = actionId === PROVENANCE_BACK_ACTION ? 'back' : 'details';
    try {
      await scopedPull[step]({
        runId: action && action.value, person: person.id, resolve: resolveForm(person, actionId), show,
      });
    } catch (err) {
      log.error('handler failed', { handler: 'hub:provenance', err });
      try {
        await view.show(PLAIN_ERROR);
      } catch (showErr) {
        log.error('could not tell the person about a failure', { handler: 'hub:provenance', err: showErr });
      }
    }
  }, { log, store }));

  // Push, Approve and Cancel (Story 10.2), and Retry the failed ones (Story
  // 10.3), on an approval-write result. Each updates the view the button is
  // in, re-checking the person's grant and the environment first
  // (resolveModule), as dispatch does (N12). A result is
  // only ever shown in a view, so a click from anywhere else is told to use
  // the hub window.
  app.action(WRITE_ACTION, handle('hub:approval', async ({ action, body, client, respond }) => {
    const verb = writeVerbOf(action && action.action_id);
    const from = body.view;
    if (!from || typeof from.id !== 'string' || !from.id || !hasViews(client)) {
      fellBack('approval', from ? 'no views client' : 'not from a modal', null);
      if (typeof respond === 'function') await respond(ephemeral(FORM_NEEDS_WINDOW));
      return;
    }
    const { hubId } = parseMetadata(from.private_metadata);
    const view = updatedView({ client, view: from, title: from.title && from.title.text, hubId });
    const show = async (message) => {
      const status = await view.show(screened('approval', message));
      if (status === 'dropped') log.info('stale view result dropped', { action: verb, reason: 'hash_conflict' });
      return status;
    };
    const person = personOf((body.user || {}).id);
    try {
      await approvalWrite.click({
        verb, value: action.value, person: person.id, resolve: resolveModule(person, action.action_id, WRITES), show, client,
      });
    } catch (err) {
      log.error('handler failed', { handler: 'hub:approval', err });
      try {
        await view.show(PLAIN_ERROR);
      } catch (showErr) {
        log.error('could not tell the person about a failure', { handler: 'hub:approval', err: showErr });
      }
    }
  }, { log, store }));
}

module.exports = {
  registerHubs, personName, firstVisit, NOT_AVAILABLE, FORM_NEEDS_WINDOW, MAP_NOT_SHOWN, MAP_NEEDS_WINDOW, MAP_VIEW_CALLBACK,
};
