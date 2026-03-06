#!/usr/bin/env bash
set -euo pipefail

HOST="${CODEXUI_BIND_HOST:-0.0.0.0}"
PORT="${CODEXUI_PORT:-4300}"
PASSWORD_MODE="${CODEXUI_PASSWORD_MODE:-required}"
PASSWORD_VALUE="${CODEXUI_PASSWORD:-}"

mkdir -p "${CODEX_HOME:-/data/codex-home}"

args=("node" "dist-cli/index.js" "--host" "$HOST" "--port" "$PORT")

case "$PASSWORD_MODE" in
  none|disabled)
    args+=("--no-password")
    ;;
  required|explicit)
    if [[ -z "$PASSWORD_VALUE" ]]; then
      echo "[start-codexui-hub] CODEXUI_PASSWORD must be set when CODEXUI_PASSWORD_MODE=$PASSWORD_MODE" >&2
      exit 1
    fi
    args+=("--password" "$PASSWORD_VALUE")
    ;;
  auto)
    ;;
  *)
    echo "[start-codexui-hub] Unsupported CODEXUI_PASSWORD_MODE: $PASSWORD_MODE" >&2
    exit 1
    ;;
esac

exec "${args[@]}"
