#!/usr/bin/env sh
set -eu

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

HOST="${CODEXUI_BIND_HOST:-0.0.0.0}"
PORT="${CODEXUI_PORT:-4300}"
USERNAME="${CODEXUI_ADMIN_USERNAME:-admin}"
PASSWORD_FILE="${CODEXUI_ADMIN_PASSWORD_FILE:-}"

if [ -n "$PASSWORD_FILE" ]; then
  if [ ! -f "$PASSWORD_FILE" ]; then
    echo "[codexui-entrypoint] CODEXUI_ADMIN_PASSWORD_FILE does not exist: $PASSWORD_FILE" >&2
    exit 1
  fi
  PASSWORD="$(cat "$PASSWORD_FILE")"
else
  PASSWORD="${CODEXUI_ADMIN_PASSWORD:-}"
fi

if [ -z "$PASSWORD" ]; then
  echo "[codexui-entrypoint] Set CODEXUI_ADMIN_PASSWORD (or CODEXUI_ADMIN_PASSWORD_FILE) before starting the hub." >&2
  exit 1
fi

mkdir -p "${CODEX_HOME:-/data/codex-home}" /workspace

if [ ! -s "${CODEX_HOME:-/data/codex-home}/auth.json" ]; then
  echo "[codexui-entrypoint] No Codex auth.json found at ${CODEX_HOME:-/data/codex-home}/auth.json." >&2
  echo "[codexui-entrypoint] Remote Connectors will still work; local Hub-hosted Codex runtimes require copied auth data." >&2
fi

exec node dist-cli/index.js \
  --host "$HOST" \
  --port "$PORT" \
  --username "$USERNAME" \
  --password "$PASSWORD"
