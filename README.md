# CodexUI Hub

Docker-first Codex hub for **multi-user**, **multi-server**, and **outbound Connector** workflows.

This fork is operated as a central **Hub** service with per-user servers, Connector lifecycle management, explicit registration, relay transport, and hardened bootstrap onboarding.

> Upstream origin: [friuns/codexui](https://github.com/friuns/codexui)

## What changed in this fork

- **Hub-first deployment** for a VM, cloud server, or homelab host
- **Explicit server registration** only — nothing appears automatically
- **Multi-user auth** with admin bootstrap + user/session management
- **Settings UI** for Connector creation, rename, reinstall, delete, and status
- **Outbound-only Connector model** for remote Codex hosts
- **Bootstrap hardening**: one-time install token -> durable runtime credential
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
CODEXUI_ADMIN_PASSWORD_HASH=scrypt$...
CODEXUI_PUBLIC_URL=http://localhost:4300
```

If you use the smoke test or the `docker:hub:register-local` helper while the Hub is configured from a hash, provide the plaintext **at runtime only**:

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

### 5. Open the UI

- URL: `http://localhost:4300` or your configured public URL
- Username: `admin` by default
- Password: the plaintext password used to generate `CODEXUI_ADMIN_PASSWORD_HASH`

## Bootstrap admin credential precedence

The Hub resolves bootstrap admin credentials in this order:

1. `CODEXUI_ADMIN_PASSWORD_HASH_FILE`
2. `CODEXUI_ADMIN_PASSWORD_HASH`
3. `CODEXUI_ADMIN_PASSWORD_FILE`
4. `CODEXUI_ADMIN_PASSWORD`

Rules:

- hash inputs and plaintext inputs **cannot be combined**
- hash-file and hash-env cannot both be set
- plaintext-file and plaintext-env cannot both be set
- plaintext is still supported for backwards compatibility, but hash-based bootstrap is recommended

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
install -d -m 700 $HOME/.codexui-connector
printf '%s' '<bootstrap-token>' > $HOME/.codexui-connector/edge-laptop.token
chmod 600 $HOME/.codexui-connector/edge-laptop.token

npx codexui-connector install \
  --hub https://hub.example.com \
  --connector edge-laptop \
  --token-file $HOME/.codexui-connector/edge-laptop.token

npx codexui-connector connect \
  --hub https://hub.example.com \
  --connector edge-laptop \
  --token-file $HOME/.codexui-connector/edge-laptop.token
```

## Optional: Hub-local Codex runtime

If you want the **Hub container itself** to host a local Codex runtime:

1. Copy local Codex auth into the mounted Hub Codex home:

```bash
npm run docker:hub:prepare-auth
```

2. Register a local server from inside the container:

```bash
npm run docker:hub:register-local -- --default local-hub "Hub Local"
```

This is optional. The primary deployment model is still **Hub + remote Connectors**.

## Local non-Docker run

```bash
npm ci
npm run build
node dist-cli/index.js --host 0.0.0.0 --port 4300 --password-hash 'scrypt$...'
```

Useful environment variables:

- `CODEXUI_BIND_HOST`
- `CODEXUI_PORT`
- `CODEXUI_ADMIN_USERNAME`
- `CODEXUI_ADMIN_PASSWORD_HASH`
- `CODEXUI_ADMIN_PASSWORD`
- `CODEXUI_OPEN_BROWSER=false`
- `CODEX_HOME`

## Documentation

- [`docs/hub-docker-deployment.md`](docs/hub-docker-deployment.md) — primary deployment guide
- [`docs/settings-and-connectors.md`](docs/settings-and-connectors.md) — Settings UI and Connector lifecycle
- [`docs/connector-package.md`](docs/connector-package.md) — remote Connector install/runtime guide
- [`docs/connector-service-management.md`](docs/connector-service-management.md) — systemd / PM2 운영 가이드
- [`docs/implementation-report.md`](docs/implementation-report.md) — phase-by-phase implementation summary
- [`docs/connector-bootstrap-hardening-report.md`](docs/connector-bootstrap-hardening-report.md) — bootstrap hardening details
- [`docs/multi-server-test-workflow.md`](docs/multi-server-test-workflow.md) — disposable multi-server Docker lab stack

## Operational notes

- Fresh users start with **no default server**.
- Local folders stay unavailable until a server is explicitly registered.
- Public deployments should use **HTTPS** in front of the Hub.
- Connector bootstrap tokens are single-use and short-lived.
- The durable Connector credential is distinct from the bootstrap token.

## Verification

```bash
npm run build
npm run test:multi-server
npm run docker:hub:smoke
npm audit --json
```

## License

MIT
