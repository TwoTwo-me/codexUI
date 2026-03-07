#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f dist-cli/index.js ]]; then
  npm run build:cli >/dev/null
fi

read -sr -p "Bootstrap admin password: " PASSWORD
printf '\n'
read -sr -p "Confirm password: " PASSWORD_CONFIRM
printf '\n'

if [[ -z "$PASSWORD" ]]; then
  echo "[hash-password] Password cannot be empty." >&2
  exit 1
fi

if [[ "$PASSWORD" != "$PASSWORD_CONFIRM" ]]; then
  echo "[hash-password] Passwords do not match." >&2
  exit 1
fi

printf '%s' "$PASSWORD" | node dist-cli/index.js hash-password --password-stdin --env
unset PASSWORD PASSWORD_CONFIRM
