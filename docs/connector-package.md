# codexui-connector package

`codexui-connector` is the outbound relay client installed on a remote Codex host.

It connects to a central CodexUI hub, pulls relay RPC requests, forwards them into the local `codex app-server`, and pushes responses / notifications back to the hub.

## Commands

### 1. Provision a connector from hub credentials

This command logs into the hub, registers a connector for the current user, and prints the one-time install token.

```bash
npx codexui-connector provision \
  --hub https://hub.example.com \
  --username alice \
  --password 'your-password' \
  --connector edge-laptop \
  --name 'Alice Edge Laptop'
```

Optional flags:
- `--json` — emit structured JSON for automation
- `--run` — immediately start the connector after provisioning
- `--key-id <id>` — attach relay E2EE policy metadata
- `--passphrase <secret>` — required together with `--run` when E2EE is enabled

### 2. Connect with a one-time token

```bash
npx codexui-connector connect \
  --hub https://hub.example.com \
  --token '<one-time-token>' \
  --connector edge-laptop
```

Optional relay E2EE arguments:

```bash
npx codexui-connector connect \
  --hub https://hub.example.com \
  --token '<one-time-token>' \
  --connector edge-laptop \
  --key-id relay-key-1 \
  --passphrase '<relay-passphrase>'
```

## Requirements on the remote host

- Node.js 18+
- Codex CLI installed and available as `codex`
- Local Codex authentication (`~/.codex/auth.json`)

If `auth.json` is missing, the connector refuses to start and instructs the operator to run:

```bash
codex login
```

## What the connector does

1. Authenticates to the hub using the relay token
2. Opens a relay session
3. Pulls queued relay RPC requests
4. Calls the local `codex app-server`
5. Pushes relay responses back to the hub
6. Forwards local notifications as relay events

## Suggested install flow

### From the hub UI
1. Open **Settings**
2. Create a connector
3. Copy the generated install command
4. Run it on the remote host

### From a terminal only
1. Provision with hub credentials
2. Copy the returned token / install command
3. Start the connector

## Systemd example

```ini
[Unit]
Description=CodexUI Connector
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/codexui-connector
ExecStart=/usr/bin/env npx codexui-connector connect --hub https://hub.example.com --token <token> --connector edge-laptop
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

## Docker example

If you prefer containers, build an image that already contains:
- Node.js
- Codex CLI
- `~/.codex/auth.json`

Then run:

```bash
docker run --rm \
  -e CODEX_HOME=/root/.codex \
  -v /path/to/auth.json:/root/.codex/auth.json:ro \
  my-codex-connector-image \
  npx codexui-connector connect --hub https://hub.example.com --token '<token>' --connector edge-laptop
```

## Security notes

- Relay tokens are one-time install secrets and should be treated like passwords.
- Rotate tokens from the Settings page when reinstalling or revoking a host.
- Relay E2EE passphrases are not persisted by the web UI and must be supplied again on the connector host when needed.

## Verification

- `node dist-cli/connector.js --help`
- `node --test tests/multi-server/relay-connector-package.test.mjs`
- `node --test tests/multi-server/connector-provisioning-package.test.mjs`
