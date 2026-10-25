# Running the app in a container

The runtime ships as a container image built from the repo's `Dockerfile` (Story 11.2). This page says what the image holds, what the host must provide, and the rules a deploy must follow. Which host to use is the fork's choice.

The template proves the image in CI only: the `container` job builds it and runs `scripts/container-smoke.js` inside it on every PR, with no network, a read-only filesystem and a fake Slack client. No one has deployed it to a real host yet; the first fork that does will confirm the host-specific parts below.

## What the image is

- **Base:** `node:24-bookworm-slim`, the linux/amd64 image, pinned by digest in the `Dockerfile` (with where the digest came from). Debian, not Alpine: DuckDB's prebuilt binaries need glibc.
- **amd64 only.** The image is built for linux/amd64. An arm64 host (for example AWS Graviton, or an Apple Silicon machine without emulation) is not supported.
- **Runs as `node`** (uid 1000, from the base image), never root. The command is `node kit/runtime/app` in exec form, so SIGTERM reaches the app's own shutdown.
- **Dependencies** are installed inside the image with `npm ci` for its platform. `node_modules` is never copied from a laptop.
- **The MotherDuck extension** is installed at build by `scripts/install-duckdb-extensions.js` for the pinned DuckDB version (DEP-016). The bot itself never installs anything.
- **Env only.** The image sets `APLABS_NO_KEYCHAIN=1`: it never looks for the macOS Keychain.
- **Not in the image** (`.dockerignore`): `node_modules`, `.git`, `var/`, `.env*` files, `*.duckdb` data files, the agent folders (`.claude/`, `.codex/`, `.agents/`, `_bmad/`), `docs/`, `test/` and the profile's context folder (`.aplabs/context/`). No secret is baked into the image.

## Rules for every deploy

- **Exactly one replica.** The app keeps its short-lived state in memory (AD-8). Two copies would split Slack's events between them and each hold its own state.
- **Stop-then-start, never rolling.** An old and a new copy must never run side by side, even briefly. Set the host's deploy strategy to stop the old one first: for example `Recreate` rather than `RollingUpdate` on Kubernetes, or "stop before start" / a maximum of one running task on other hosts. Accept the short gap while it restarts.
- **Secrets come from the host's env**, never the image or the repo. Set them in the host's secret store; it passes them to the container as env vars.
- **Read-only filesystem.** The app's files are owned by root and not writable by the app. The only writable paths are `APLABS_VAR_DIR` (set in the image to `/var/lib/aplabs`) and `/tmp`. Run the container read-only (`--read-only`, or the host's "read-only root filesystem" setting) with a small writable volume or tmpfs at each of those two paths.

## What the host must provide

### Settings (env)

| Variable | What | Needed |
| --- | --- | --- |
| `APLABS_PROFILE` | Absolute path to the mounted `profile.yml` | Always |
| `APLABS_APP_DIR` | Absolute path to the fork's app dir inside the image, normally `/app/app` | Always |
| `APLABS_HEALTH_PORT` | Port for the health check (1 to 65535). Unset means no health check | For the host's health check |
| `APLABS_ENV` | `prod`, `dev`, ... (default `dev`) | Usually |
| `APLABS_DATA_PATH` | Absolute path to a mounted DuckDB data file, for `data.source: local` | Local data only |

`APLABS_PROFILE` and `APLABS_APP_DIR` are never baked into the image: whoever runs it sets them.

### Secrets (env, from the host's secret store)

Each of these is a **human step**: a person with access creates the credential and puts it in the host's secret store. An agent never handles it.

| Variable | What | Needed |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | The bot token (`xoxb-…`) | Always (human step) |
| `SLACK_APP_TOKEN` | The app-level token (`xapp-…`), Socket Mode | Always (human step) |
| `MOTHERDUCK_READ_TOKEN` | The bot's own MotherDuck read key | `data.source: motherduck` only (human step) |
| `ANTHROPIC_API_KEY` | The AI key; without it the AI stays off and the app still runs | Optional (human step) |

See `docs/runtime/slack-app-setup.md` for the Slack tokens and `docs/runtime/ai-setup.md` for the AI key.

### Mounts

- **The profile and its context folder**, read-only. The runtime reads `org.md` and `data.md` from the `context/` folder next to the profile (AD-11), so mount the folder that holds both, for example the fork's `.aplabs/` at `/config` with `APLABS_PROFILE=/config/profile.yml` (then `/config/context/` holds the context files). The context is never baked into the image.
- **The data**, never baked in: either MotherDuck (`data.source: motherduck` and `MOTHERDUCK_READ_TOKEN`; nothing to mount), or a DuckDB file mounted read-only with `APLABS_DATA_PATH` pointing at it.
- **Writable space** at `APLABS_VAR_DIR` (`/var/lib/aplabs`) and `/tmp`: a tmpfs or a small volume.

## The health check

With `APLABS_HEALTH_PORT` set, the app serves `GET /healthz` on that port on all interfaces (AD-13). Point the host's liveness check at it.

- The body is one word: `ok` (HTTP 200) or `down` (HTTP 503). Any other path or method gets 404.
- The first 90 seconds after start are a grace period: always 200, so the Slack connect has time to finish.
- After that, 200 needs Slack to have connected at least once and no current outage over 60 seconds. An app that never connected, or one disconnected for more than 60 seconds, gets 503. A normal reconnect stays 200.
- A malformed port, or one already in use, stops the app at startup naming `APLABS_HEALTH_PORT`.

## Host caveats

- **The extension lives in the runtime user's home.** DuckDB looks for extensions under `$HOME/.duckdb`; the image installs the MotherDuck extension in `/home/node/.duckdb` and sets `HOME=/home/node`. A host that runs the image as a different, arbitrary UID (OpenShift does by default) or changes `HOME` won't find it, and a MotherDuck fork reports the data unavailable. Run it as the image's user (uid 1000), or keep `HOME=/home/node`.
- **A DuckDB bump needs a rebuilt image.** The extension must match the pinned DuckDB version. The CI smoke test loads it with the network off, so a mismatch fails the PR, not the deploy.
- **amd64 only** (above).

## Running it by hand

A sketch, for a host with docker. Every secret comes from the shell's env, filled from the host's secret store by a person (human step); never type a token into a command line.

```bash
docker build --tag aplabs-runtime .

docker run --rm \
  --read-only \
  --tmpfs /tmp:rw,mode=1777 \
  --tmpfs /var/lib/aplabs:rw,mode=1777 \
  --volume "$PWD/.aplabs:/config:ro" \
  --env APLABS_PROFILE=/config/profile.yml \
  --env APLABS_APP_DIR=/app/app \
  --env APLABS_ENV=prod \
  --env APLABS_HEALTH_PORT=8080 --publish 8080:8080 \
  --env SLACK_BOT_TOKEN --env SLACK_APP_TOKEN \
  --env MOTHERDUCK_READ_TOKEN --env ANTHROPIC_API_KEY \
  aplabs-runtime
```

`--env NAME` with no value passes the variable through from the shell, so the value never appears in the command.
