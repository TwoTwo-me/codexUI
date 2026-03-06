#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_AUTH_FILE="${CODEX_AUTH_FILE:-$HOME/.codex/auth.json}"

if [[ -f "$ROOT_DIR/.env" ]]; then
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" =~ ^# ]] && continue
    if [[ -z "${!key+x}" ]]; then
      export "$key=$value"
    fi
  done < "$ROOT_DIR/.env"
fi

TARGET_DIR_RAW="${CODEXUI_CODEX_HOME_DIR:-./docker/local-codex}"
if [[ "$TARGET_DIR_RAW" = /* ]]; then
  TARGET_DIR="$TARGET_DIR_RAW"
else
  TARGET_DIR="$ROOT_DIR/$TARGET_DIR_RAW"
fi
TARGET_AUTH_FILE="$TARGET_DIR/auth.json"

if [[ ! -s "$SOURCE_AUTH_FILE" ]]; then
  echo "[hub-prepare-codex-auth] Missing or empty auth file: $SOURCE_AUTH_FILE" >&2
  echo "Set CODEX_AUTH_FILE to override the source path." >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
cp "$SOURCE_AUTH_FILE" "$TARGET_AUTH_FILE"
chmod 600 "$TARGET_AUTH_FILE"

echo "[hub-prepare-codex-auth] Copied auth file to $TARGET_AUTH_FILE"
