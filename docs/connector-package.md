# codexui-connector package

`codexui-connector` is the outbound relay client installed on a remote Codex host.

It connects to a central CodexUI hub, pulls relay RPC requests, forwards them into the local `codex app-server`, and pushes responses / notifications back to the hub.

## Commands

### 1. Provision a connector from hub credentials

This command logs into the hub, registers a connector for the current user, and prints a secure `--token-file` install command.

```bash
read -sr CODEXUI_HUB_PASSWORD && printf '%s' "$CODEXUI_HUB_PASSWORD" | \
  npx codexui-connector provision \
  --hub https://hub.example.com \
  --username alice \
  --password-stdin \
  --connector edge-laptop \
  --name 'Alice Edge Laptop'
```

Optional flags:
- `--json` — emit structured JSON for automation (includes the one-time token)
- `--run` — immediately start the connector after provisioning
- `--key-id <id>` — attach relay E2EE policy metadata
- `--passphrase <secret>` — required together with `--run` when E2EE is enabled
- `--allow-insecure-http` — allow plaintext HTTP for non-loopback lab environments only

### 2. Connect with a one-time token file

Save the one-time token to a file first:

```bash
install -d -m 700 ~/.codexui-connector
printf '%s' '<one-time-token>' > ~/.codexui-connector/edge-laptop.token
chmod 600 ~/.codexui-connector/edge-laptop.token
```

```bash
npx codexui-connector connect \
  --hub https://hub.example.com \
  --connector edge-laptop \
  --token-file ~/.codexui-connector/edge-laptop.token
```

Optional relay E2EE arguments:

```bash
npx codexui-connector connect \
  --hub https://hub.example.com \
  --connector edge-laptop \
  --token-file ~/.codexui-connector/edge-laptop.token \
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
3. Reveal the token once and save it to a secure file on the remote host
4. Run the generated `--token-file` install command

### From a terminal only
1. Provision with hub credentials
2. Save the returned token to a secure file (or use `--json` for automation)
3. Start the connector with `--token-file`

## Systemd example

```ini
[Unit]
Description=CodexUI Connector
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/codexui-connector
ExecStart=/usr/bin/env npx codexui-connector connect --hub https://hub.example.com --connector edge-laptop --token-file /etc/codexui/edge-laptop.token
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
  -v /path/to/edge-laptop.token:/run/secrets/edge-laptop.token:ro \
  my-codex-connector-image \
  npx codexui-connector connect --hub https://hub.example.com --connector edge-laptop --token-file /run/secrets/edge-laptop.token
```

## Security notes

- Relay tokens are one-time install secrets and should be treated like passwords.
- Non-local hubs must use **HTTPS** unless you explicitly opt into `--allow-insecure-http` for lab use.
- Rotate tokens from the Settings page when reinstalling or revoking a host.
- Relay E2EE passphrases are not persisted by the web UI and must be supplied again on the connector host when needed.

## Verification

- `node dist-cli/connector.js --help`
- `node --test tests/multi-server/relay-connector-package.test.mjs`
- `node --test tests/multi-server/connector-provisioning-package.test.mjs`
