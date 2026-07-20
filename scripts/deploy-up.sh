#!/usr/bin/env bash
# L7 bring-up: pull + start the production cluster + tunnel on the deploy VM.
# Run from the repo root; requires a filled-in .env (see .env.example, DEPLOY.md).
# Images are built + pushed to Artifact Registry locally (2GB VM can't afford `npm ci`+`tsc`
# for 3 services concurrently) — this script only pulls, it never builds on the VM.
# Usage: ./scripts/deploy-up.sh [tunnel|quicktunnel]   (default: tunnel)
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "Missing .env — copy .env.example to .env and fill in AUTH_TOKEN/ALLOWED_ORIGINS (+ TUNNEL_TOKEN if using the named-tunnel profile)." >&2
  exit 1
fi

PROFILE="${1:-tunnel}"

docker compose -f docker-compose.prod.yml --profile "$PROFILE" pull
docker compose -f docker-compose.prod.yml --profile "$PROFILE" up -d
docker compose -f docker-compose.prod.yml ps
