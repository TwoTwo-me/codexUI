#!/usr/bin/env sh
set -eu

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

HOST="${CODEXUI_BIND_HOST:-0.0.0.0}"
PORT="${CODEXUI_PORT:-4300}"
USERNAME="${CODEXUI_ADMIN_USERNAME:-admin}"
PASSWORD_HASH_FILE="${CODEXUI_ADMIN_PASSWORD_HASH_FILE:-}"
PASSWORD_HASH_ENV="${CODEXUI_ADMIN_PASSWORD_HASH:-}"
PASSWORD_FILE="${CODEXUI_ADMIN_PASSWORD_FILE:-}"
PASSWORD_ENV="${CODEXUI_ADMIN_PASSWORD:-}"

read_secret_file() {
  secret_file="$1"
  if [ ! -f "$secret_file" ]; then
    echo "[codexui-entrypoint] Secret file does not exist: $secret_file" >&2
    exit 1
  fi
  tr -d '\r\n' < "$secret_file"
}

hash_sources=0
plaintext_sources=0
[ -n "$PASSWORD_HASH_FILE" ] && hash_sources=$((hash_sources + 1))
[ -n "$PASSWORD_HASH_ENV" ] && hash_sources=$((hash_sources + 1))
[ -n "$PASSWORD_FILE" ] && plaintext_sources=$((plaintext_sources + 1))
[ -n "$PASSWORD_ENV" ] && plaintext_sources=$((plaintext_sources + 1))

if [ "$hash_sources" -gt 1 ]; then
  echo "[codexui-entrypoint] Configure only one of CODEXUI_ADMIN_PASSWORD_HASH or CODEXUI_ADMIN_PASSWORD_HASH_FILE." >&2
  exit 1
fi

if [ "$plaintext_sources" -gt 1 ]; then
  echo "[codexui-entrypoint] Configure only one of CODEXUI_ADMIN_PASSWORD or CODEXUI_ADMIN_PASSWORD_FILE." >&2
  exit 1
fi

if [ "$plaintext_sources" -gt 0 ]; then
  echo "[codexui-entrypoint] Plaintext bootstrap admin password settings are no longer supported. Use CODEXUI_ADMIN_PASSWORD_HASH(_FILE)." >&2
  exit 1
fi

PASSWORD_HASH=""
if [ -n "$PASSWORD_HASH_FILE" ]; then
  PASSWORD_HASH="$(read_secret_file "$PASSWORD_HASH_FILE")"
elif [ -n "$PASSWORD_HASH_ENV" ]; then
  PASSWORD_HASH="$PASSWORD_HASH_ENV"
fi

mkdir -p "${CODEX_HOME:-/data/codex-home}" /workspace

if [ ! -s "${CODEX_HOME:-/data/codex-home}/auth.json" ]; then
  echo "[codexui-entrypoint] No Codex auth.json found at ${CODEX_HOME:-/data/codex-home}/auth.json." >&2
  echo "[codexui-entrypoint] Remote Connectors will still work; local Hub-hosted Codex runtimes require copied auth data." >&2
fi

set -- node dist-cli/index.js \
  --host "$HOST" \
  --port "$PORT" \
  --username "$USERNAME"

if [ -n "$PASSWORD_HASH" ]; then
  set -- "$@" --password-hash "$PASSWORD_HASH"
fi

exec "$@"
