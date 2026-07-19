#!/usr/bin/env bash
# L7 bring-up: build + start the production cluster + tunnel on the deploy VM.
# Run from the repo root; requires a filled-in .env (see .env.example, DEPLOY.md).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "Missing .env — copy .env.example to .env and fill in AUTH_TOKEN/ALLOWED_ORIGINS/TUNNEL_TOKEN." >&2
  exit 1
fi

docker compose -f docker-compose.prod.yml --profile tunnel up -d --build
docker compose -f docker-compose.prod.yml ps
