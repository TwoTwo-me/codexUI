# CodexUI Hub

Docker-first Codex hub for **multi-user**, **multi-server**, and **outbound Connector** workflows.

This fork is operated as a central **Hub** service with per-user servers, Connector lifecycle management, explicit registration, relay transport, and hardened bootstrap onboarding.

> Upstream origin: [friuns/codexui](https://github.com/friuns/codexui)

## What changed in this fork

- **Hub-first deployment** for a VM, cloud server, or homelab host
- **Explicit server registration** only — nothing appears automatically
- **Multi-user auth** with admin bootstrap + user/session management
- **Public signup + admin approval** before non-admin accounts can sign in
- **Settings UI** for Connector creation, rename, reinstall, delete, and status
- **SQLite-backed Hub persistence** for users and Hub state
- **Approval-gated signup flow** with admin review and per-user isolation
- **Hook inbox + alert badges** for pending app-server hooks
- **Outbound-only Connector model** for remote Codex hosts
- **Bootstrap hardening**: one-time install token -> durable runtime credential
- **SQLite-backed Hub persistence** for users and Hub state (`$CODEX_HOME/codexui/hub.sqlite`)
- **Docker packaging** for the Hub with `.env`, `Dockerfile`, and `docker-compose.yml`

## Architecture

```text
Browser
  │
  ▼
CodexUI Hub
  ├─ Auth / sessions / admin
  ├─ Server registry
  ├─ Connector registry
  ├─ Relay hub
  └─ Web UI
       │
       ├─ Local servers (explicitly registered)
       └─ Remote Connector-backed servers
            │
            ▼
      codexui-connector
            │
            ▼
      Codex CLI / codex app-server
```

## Quick start (recommended)

### 1. Generate a bootstrap admin password hash

Recommended: keep a **hash** in `.env`, not the plaintext password.

Interactive helper:

```bash
npm run admin:hash-password
```

or directly:

```bash
read -sr -p "Bootstrap admin password: " PW; printf '\n'
printf '%s' "$PW" | node dist-cli/index.js hash-password --password-stdin --env
unset PW
```

That prints:

```dotenv
CODEXUI_ADMIN_PASSWORD_HASH=scrypt$$...
```

`--env` output is already escaped for Docker Compose, so you can paste it into `.env` directly.

### 2. Edit `.env`

At minimum, set:

```dotenv
CODEXUI_ADMIN_PASSWORD_HASH=scrypt$$...
CODEXUI_PUBLIC_URL=http://localhost:4300
```

Plaintext bootstrap secrets are no longer supported.

If you use the smoke test or the `docker:hub:register-local` helper, provide the current admin password **at runtime only**:

```bash
export CODEXUI_ADMIN_LOGIN_PASSWORD='your-bootstrap-password'
```

Useful variables:

```dotenv
CODEXUI_HOST_PORT=4300
CODEXUI_DATA_DIR=./.data/hub
CODEXUI_WORKSPACE_DIR=./workspace
CODEXUI_CODEX_HOME_DIR=./docker/local-codex
CODEXUI_SKIP_CODEX_LOGIN=true
CODEXUI_CODEX_CLI_VERSION=0.110.0
```

### 3. Start the Hub

```bash
npm run docker:hub:up
```

or:

```bash
docker compose up --build -d hub
```

### 4. Smoke test

```bash
npm run docker:hub:smoke
```

### 5. First login: complete the setup wizard

- Open `http://localhost:4300`
- Sign in as the bootstrap admin (`admin` by default) with the plaintext password you used to generate the hash
- You will be forced to `/setup/bootstrap-admin`
- Change the admin username and password before using the rest of the Hub

### 6. Remove the bootstrap hash for steady-state restarts

After the setup wizard succeeds, remove the bootstrap hash from `.env`:

```dotenv
CODEXUI_ADMIN_PASSWORD_HASH=
CODEXUI_ADMIN_PASSWORD_HASH_FILE=
```

The Hub can now restart with the rotated SQLite-backed admin account and no bootstrap secret in `.env`.

### 7. Open the UI normally

- URL: `http://localhost:4300` or your configured public URL
- Username / Password: the rotated admin credentials you set in the setup wizard

## Bootstrap admin credential sources

If a bootstrap credential is present, the Hub resolves it in this order:

1. `CODEXUI_ADMIN_PASSWORD_HASH_FILE`
2. `CODEXUI_ADMIN_PASSWORD_HASH`
3. no bootstrap credential

Rules:

- plaintext bootstrap env/file/CLI inputs are rejected
- hash-file and hash-env cannot both be set
- after first-login setup completes, you should remove the bootstrap hash and restart normally

## Docker layout

- `Dockerfile` — production Hub image
- `docker-compose.yml` — Hub deployment stack
- `.env` — Docker runtime defaults
- `docker/hub/entrypoint.sh` — container startup wrapper
- `scripts/docker/hub-*.sh` — helper commands

Persisted directories:

- `CODEXUI_DATA_DIR` -> Hub data, users, registries, cache
- `CODEXUI_WORKSPACE_DIR` -> optional workspace mount for Hub-local projects
- `CODEXUI_CODEX_HOME_DIR` -> optional local Codex auth/config for Hub-local runtimes
- `CODEXUI_SKIP_CODEX_LOGIN=true` -> lets the Hub start in remote-only mode without forcing local Codex login

Persisted files inside `CODEX_HOME`:

- `codexui/hub.sqlite` -> SQLite database for users + Hub/global state
- legacy `codexui/users.json` / `.codex-global-state.json` are imported on first run and then superseded by SQLite

## Connector onboarding

1. Sign in to the Hub
2. Open **Settings**
3. Create a Connector
4. Reveal the one-time bootstrap token
5. Save it on the remote host
6. Run the generated install command
7. Start `codexui-connector connect`
8. Confirm status, project count, and thread count in Settings

### Remote host example

```bash
npm exec --yes --package=github:TwoTwo-me/codexUI#main -- codexui-connector install \
  --hub https://hub.example.com \
  --connector edge-laptop \
  --token '<bootstrap-token>' \
  --token-file $HOME/.codexui-connector/edge-laptop.token

npm exec --yes --package=github:TwoTwo-me/codexUI#main -- codexui-connector connect \
  --hub https://hub.example.com \
  --connector edge-laptop \
  --token-file $HOME/.codexui-connector/edge-laptop.token
```

The install command now embeds the one-time bootstrap token inline and writes the durable runtime credential to `--token-file`.

## Optional: Hub-local Codex runtime

If you want the **Hub container itself** to host a local Codex runtime:

1. Copy local Codex auth into the mounted Hub Codex home:

```bash
npm run docker:hub:prepare-auth
```

2. Register a local server from inside the container:

```bash
export CODEXUI_ADMIN_LOGIN_PASSWORD='your-current-admin-password'
npm run docker:hub:register-local -- --default local-hub "Hub Local"
```

This is optional. The primary deployment model is still **Hub + remote Connectors**.

## Local non-Docker run

```bash
npm ci
npm run build
node dist-cli/index.js --host 0.0.0.0 --port 4300 --password-hash 'scrypt$...'
```

After first-login setup is complete and the admin account is stored in SQLite, later restarts can omit the bootstrap hash entirely:

```bash
node dist-cli/index.js --host 0.0.0.0 --port 4300
```

Useful environment variables:

- `CODEXUI_BIND_HOST`
- `CODEXUI_PORT`
- `CODEXUI_ADMIN_USERNAME`
- `CODEXUI_ADMIN_PASSWORD_HASH`
- `CODEXUI_ADMIN_PASSWORD_HASH_FILE`
- `CODEXUI_OPEN_BROWSER=false`
- `CODEX_HOME`

## Documentation

- [`docs/hub-docker-deployment.md`](docs/hub-docker-deployment.md) — primary deployment guide
- [`docs/settings-and-connectors.md`](docs/settings-and-connectors.md) — Settings UI and Connector lifecycle
- [`docs/connector-package.md`](docs/connector-package.md) — remote Connector install/runtime guide
- [`docs/connector-service-management.md`](docs/connector-service-management.md) — systemd / PM2 운영 가이드
- [`docs/bootstrap-admin-setup-report.md`](docs/bootstrap-admin-setup-report.md) — hash-only bootstrap and forced first-login rotation report
- [`docs/explorer-hooks-sqlite-approval-report.md`](docs/explorer-hooks-sqlite-approval-report.md) — server-scoped explorer, hook inbox, SQLite auth, and approval flow report
- [`docs/implementation-report.md`](docs/implementation-report.md) — phase-by-phase implementation summary
- [`docs/connector-bootstrap-hardening-report.md`](docs/connector-bootstrap-hardening-report.md) — connector bootstrap hardening details
- [`docs/multi-server-test-workflow.md`](docs/multi-server-test-workflow.md) — disposable multi-server Docker lab stack

## Operational notes

- Fresh users start with **no default server**.
- Local folders stay unavailable until a server is explicitly registered.
- Public deployments should use **HTTPS** in front of the Hub.
- Connector bootstrap tokens are single-use and short-lived.
- The durable Connector credential is distinct from the bootstrap token.
- Bootstrap admin setup is also single-use: once completed, the Hub no longer needs a bootstrap hash to restart.

## Verification

```bash
npm run build
npm run test:multi-server
npm run docker:hub:smoke
npm audit --json
```

## License

MIT
