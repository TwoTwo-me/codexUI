#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"

docker compose --project-directory "$ROOT_DIR" -f "$COMPOSE_FILE" down --remove-orphans

echo "[hub-down] CodexUI Hub containers stopped"
