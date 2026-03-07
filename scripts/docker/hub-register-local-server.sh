#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
SERVICE_NAME="${CODEXUI_HUB_SERVICE:-hub}"

usage() {
  cat <<'EOF'
Usage: hub-register-local-server.sh [--default] <server-id> [server-name]

Registers a local transport server from inside the Hub container.
Use this only when you intentionally want the Hub container itself to host a local Codex runtime.
EOF
}

MAKE_DEFAULT=0
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --default)
      MAKE_DEFAULT=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      POSITIONAL+=("$arg")
      ;;
  esac
done

if [[ "${#POSITIONAL[@]}" -lt 1 || "${#POSITIONAL[@]}" -gt 2 ]]; then
  usage >&2
  exit 1
fi

SERVER_ID="${POSITIONAL[0]}"
SERVER_NAME="${POSITIONAL[1]:-$SERVER_ID}"
ADMIN_LOGIN_PASSWORD="${CODEXUI_ADMIN_LOGIN_PASSWORD:-${CODEXUI_ADMIN_PASSWORD:-}}"

if [[ -z "$ADMIN_LOGIN_PASSWORD" ]]; then
  echo "Set CODEXUI_ADMIN_LOGIN_PASSWORD (or CODEXUI_ADMIN_PASSWORD) before registering a Hub-local server." >&2
  exit 1
fi

docker compose --project-directory "$ROOT_DIR" -f "$COMPOSE_FILE" exec -T \
  -e REGISTER_SERVER_ID="$SERVER_ID" \
  -e REGISTER_SERVER_NAME="$SERVER_NAME" \
  -e REGISTER_MAKE_DEFAULT="$MAKE_DEFAULT" \
  -e ADMIN_LOGIN_PASSWORD="$ADMIN_LOGIN_PASSWORD" \
  "$SERVICE_NAME" \
  node --input-type=module <<'NODE'
const baseUrl = `http://127.0.0.1:${process.env.CODEXUI_PORT || '4300'}`
const username = process.env.CODEXUI_ADMIN_USERNAME || 'admin'
const password = process.env.ADMIN_LOGIN_PASSWORD || ''
const serverId = process.env.REGISTER_SERVER_ID || ''
const serverName = process.env.REGISTER_SERVER_NAME || serverId
const makeDefault = process.env.REGISTER_MAKE_DEFAULT === '1'

if (!password) {
  console.error('A bootstrap admin login password was not provided to the helper.')
  process.exit(1)
}

const loginResponse = await fetch(`${baseUrl}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password }),
})

if (!loginResponse.ok) {
  console.error(`Failed to log into hub as ${username}: ${loginResponse.status}`)
  console.error(await loginResponse.text())
  process.exit(1)
}

const cookieHeader = loginResponse.headers.get('set-cookie')
if (!cookieHeader) {
  console.error('Hub login did not return a session cookie.')
  process.exit(1)
}

const serverResponse = await fetch(`${baseUrl}/codex-api/servers`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Cookie: cookieHeader.split(';', 1)[0],
  },
  body: JSON.stringify({
    id: serverId,
    name: serverName,
    transport: 'local',
    isDefault: makeDefault,
  }),
})

const text = await serverResponse.text()
if (!serverResponse.ok) {
  console.error(`Failed to register local server ${serverId}: ${serverResponse.status}`)
  console.error(text)
  process.exit(1)
}

console.log(text)
NODE
