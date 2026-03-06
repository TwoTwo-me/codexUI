#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"

docker compose --project-directory "$ROOT_DIR" -f "$COMPOSE_FILE" logs -f --tail=200 hub
