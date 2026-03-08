#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ -f "$ROOT_DIR/.env" ]]; then
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" =~ ^# ]] && continue
    if [[ -z "${!key+x}" ]]; then
      export "$key=$value"
    fi
  done < "$ROOT_DIR/.env"
fi

LOCAL_SMOKE_HOST="${CODEXUI_SMOKE_HOST:-127.0.0.1}"
LOCAL_SMOKE_PORT="${CODEXUI_HOST_PORT:-${CODEXUI_PORT:-4300}}"
BASE_URL="${BASE_URL:-http://${LOCAL_SMOKE_HOST}:${LOCAL_SMOKE_PORT}}"
ADMIN_USERNAME="${CODEXUI_ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${CODEXUI_ADMIN_LOGIN_PASSWORD:-}"
export BASE_URL ADMIN_USERNAME ADMIN_PASSWORD

if [[ -z "$ADMIN_PASSWORD" ]]; then
  echo "[hub-smoke] Set CODEXUI_ADMIN_LOGIN_PASSWORD before running the smoke test." >&2
  exit 1
fi

docker compose ps hub >/dev/null
docker compose exec -T hub sh -lc 'test -s /data/codex-home/auth.json'
docker compose exec -T hub codex --version >/dev/null

node <<'EOF_NODE'
const baseUrl = process.env.BASE_URL
const username = process.env.ADMIN_USERNAME
const password = process.env.ADMIN_PASSWORD

async function waitForHealthy() {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/auth/session`)
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  throw new Error(`Hub did not become ready in time: ${baseUrl}`)
}

async function main() {
  await waitForHealthy()
  const login = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!login.ok) {
    throw new Error(`Login failed (${login.status}): ${await login.text()}`)
  }
  const loginPayload = await login.json()
  const cookie = login.headers.get('set-cookie') || ''
  if (!cookie.includes('codex_web_local_token=')) {
    throw new Error('Login response did not include a session cookie')
  }
  const session = await fetch(`${baseUrl}/auth/session`, {
    headers: { cookie: cookie.split(';', 1)[0] },
  })
  if (!session.ok) {
    throw new Error(`Session lookup failed (${session.status})`)
  }
  const payload = await session.json()
  if (!payload?.authenticated) {
    throw new Error(`Unexpected session payload: ${JSON.stringify(payload)}`)
  }
  if (loginPayload?.setupRequired === true || payload?.setupRequired === true) {
    console.log(`[hub-smoke] Authenticated as bootstrap admin ${payload.user.username} via ${baseUrl}; complete /setup/bootstrap-admin before using the Hub.`)
    process.exit(0)
  }
  if (payload?.user?.username !== username) {
    throw new Error(`Unexpected session payload: ${JSON.stringify(payload)}`)
  }
  console.log(`[hub-smoke] Authenticated as ${payload.user.username} via ${baseUrl}`)
  process.exit(0)
}

main()
  .then(() => {
    process.exit(0)
  })
  .catch((error) => {
    console.error(`[hub-smoke] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
EOF_NODE

echo "[hub-smoke] Container has codex auth + CLI and authenticated successfully"
