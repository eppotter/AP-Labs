# docs/reference

Design reference material from the reference client, Hometown Ticketing, and its Varsity platform. This folder is the only place in the repo where reference-client specifics may appear. It never ships to a client: the distribution tree leaves it out (`EXCLUDED` in `kit/lib/dist`).

## Reference repos (read-only)

- `~/Projects/bi-platform`: the live Varsity platform.
- `~/Projects/AI-Governance-Layer`: the archived earlier port.

Read them with `git -C <repo> show main:<path>`. Never check out branches, install or run anything in them.

## The deny list

`dist-deny.txt` lists the reference-client names that must never appear outside this folder: one case-insensitive regex per line. `test/unit/dist-scan.test.js` scans the tracked tree (minus the excluded paths) against it on every `npm test`, and the agent and fork-guide tests load it too. A hit names the file, the line and the pattern's number, never the matched text. Ely reviews changes to this file.
