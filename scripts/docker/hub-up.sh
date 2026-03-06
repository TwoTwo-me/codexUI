#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"

if [[ -f "$ROOT_DIR/.env" ]]; then
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" =~ ^# ]] && continue
    if [[ -z "${!key+x}" ]]; then
      export "$key=$value"
    fi
  done < "$ROOT_DIR/.env"
fi

docker compose --project-directory "$ROOT_DIR" -f "$COMPOSE_FILE" up --build -d hub
docker compose --project-directory "$ROOT_DIR" -f "$COMPOSE_FILE" ps hub

echo "[hub-up] CodexUI Hub should be reachable at ${CODEXUI_PUBLIC_URL:-http://localhost:${CODEXUI_HOST_PORT:-${CODEXUI_PORT:-4300}}}"
