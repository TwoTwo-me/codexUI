#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
PORT="${CODEXUI_PORT:-4300}"

docker compose -f "$COMPOSE_FILE" ps hub >/dev/null
docker compose -f "$COMPOSE_FILE" exec -T hub sh -lc 'test -s /data/codex-home/auth.json'
docker compose -f "$COMPOSE_FILE" exec -T hub codex --version >/dev/null

node -e "
const port = Number(process.argv[1] || '4300')
fetch(\`http://127.0.0.1:\${port}/auth/session\`, { headers: { Accept: 'application/json' } })
  .then((response) => {
    if (!response.ok) process.exit(1)
    process.exit(0)
  })
  .catch(() => process.exit(1))
" "$PORT"

echo "[docker:hub:smoke] Hub container is healthy on http://127.0.0.1:${PORT}"
