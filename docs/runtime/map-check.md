# The map check: live check for Story 15.1

A human step for Ely in the `aplabs-demo` dev workspace. It answers seven questions about how Slack treats a privately uploaded image in a modal (AD-R15). The tests can't answer them: they use a fake Slack, so each item below is **untested until you run it**. Story 15.4 waits on the result (the 15.1 DEP in `docs/planning/planning-artifacts/epics-routing.md`).

The map check is a dev-only option on the `/brightside` menu, **Map check (dev)**. It shows a fixed test picture (colour bars over a checkerboard, no client data), uploaded the way a route map will be. Story 15.5 removes it.

## Before you start

1. **The bot is running in dev**, as in `slack-app-setup.md` §3 (`APLABS_ENV` unset means dev):

   ```bash
   APLABS_PROFILE="$PWD/profiles/brightside/profile.yml" \
     APLABS_APP_DIR="$PWD/examples/brightside/app" npm start
   ```

   In the startup line, check `engine_jobs` says `["sweep-map-files"]`. That is the sweep that deletes old map files; it runs even though `jobs` says `off (profile)`. If `engine_jobs` is `[]`, you are not in dev: the map check is hidden.
2. **No new scope or app setting is needed.** The upload and the delete use `files:write`, which the app already has. Don't add `files:read`.
3. **A second person.** Item 6 needs someone else in `aplabs-demo` who never opens the map check (a second account, or Steven).
4. Keep the bot's terminal visible: some answers are in its log lines (`map view closed`, `map files swept`, `map file delete failed`).

## The steps

Do them in order. Write down what you see for each numbered item; the answers go under Story 15.1 in `epics-routing.md` (see "Recording the outcome").

| # | You do | Look for |
|---|---|---|
| 1 | Type `/brightside`, then press **Open** on **Map check (dev)**. | "Loading…", then a window titled *Map check (dev)* with one line of text and the test picture (colour bars on top, a checkerboard below). **Item 1:** does the picture show? If you see a broken-image box or nothing, item 1 fails: stop and report it. |
| 2 | With the window still open, look through Slack: your DM with the bot, any channel, the bot's Activity. | **Item 2:** the file `route-map.png` appears in no channel and no conversation. |
| 3 | **Item 7:** note whether the picture appeared at once when "Loading…" went away, or only after a moment, or not until you reopened it. | If the picture was missing at first and appeared on its own, or never appeared until you pressed Open again, write that down: it tells us whether `views.update` straight after the upload needs a retry. |
| 4 | **Item 5:** click the picture. Try to open it full size, share it, download it, and copy a link to it. | For each of open, share, download and copy link: is it offered, and does it work? Write down each one. |
| 5 | **Item 6:** ask the second person to search Slack's **Files** for `route-map.png` (and for `Route map`). | They should find nothing. Write down what they see. |
| 6 | Press **Back** (bottom left of the window). | You are back on the Brightside menu. In the bot's terminal, within a few seconds: a `map view closed` line with `deleted: 1`. **Item 3 (Back):** did that line appear? If not, write that down: the sweep is then Back's delete path, at most 20 minutes after the upload, and nothing else changes. |
| 7 | **Item 4:** search your own **Files** for `route-map.png`, and if you saved a link at step 4, open it. | The file is gone (Slack says it was deleted, or the link no longer opens). |
| 8 | Open **Map check (dev)** again, then close the whole window with the **X** (top right). | **Item 3 (Close):** a `map view closed` line with `deleted: 1` and `cleared: true`. Then repeat step 7 for this file. |
| 9 | Optional, the sweep: open the map check once more and press Back while the bot is stopped (or if step 6 printed no `map view closed`), then start the bot again and wait. | Within 20 minutes of the upload, a `map files swept` line with `deleted: 1` (the bot sweeps at start-up and every 5 minutes). |

### The seven items, as the story names them

1. The image shows in the modal.
2. The file appears in no channel.
3. `view_closed` arrives on Back and on Close.
4. After `files.delete` the file is gone.
5. Clicking the image and trying to open, share or download it, and what each allows.
6. A user outside the audience searches Files for `route-map.png` and finds nothing.
7. `views.update` immediately after the upload shows the image, and if not, whether one retry does.

## If something fails

- **Item 1 fails** (no picture): AD-R15's fallback applies (upload to your own DM with the bot and link to it from the window). That changes Story 15.4's acceptance criteria and needs Dana Reyes's answer first, because a DM image shows in push notification previews and in her Files list. Tell the Orchestrator; nothing is built on it until then.
- **Item 3 fails on Back** (no `map view closed` line): no change is needed. The sweep deletes the file within 20 minutes of upload.
- **Anything else unexpected**: note exactly what you saw and tell the Orchestrator.

## Recording the outcome

Add a short `**Live check outcome (date):**` paragraph under Story 15.1 in `docs/planning/planning-artifacts/epics-routing.md`, one line per item (pass, fail, or what each action allowed for item 5). The Orchestrator can write it from your notes.
