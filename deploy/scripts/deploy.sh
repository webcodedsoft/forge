#!/usr/bin/env bash
# Build and (re)start Forge on this server. Safe to run again for updates.
set -euo pipefail
cd "$(dirname "$0")/../.."          # repo root (forge/)
[ -f deploy/.env ] || { echo "deploy/.env missing: copy deploy/.env.example and fill it in" >&2; exit 1; }
for v in POSTGRES_PASSWORD BETTER_AUTH_SECRET FORGE_SECRETS_KEY ANTHROPIC_API_KEY; do
  grep -Eq "^$v=.+" deploy/.env || { echo "Set $v in deploy/.env first." >&2; exit 1; }
done

echo "== Sandbox image (project containers)"
docker build -t forge-sandbox:dev -f sandbox/Dockerfile .

echo "== Forge services"
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build

echo "== Database schema"
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec -T orchestrator pnpm db:push

echo "== Health"
sleep 3
curl -fsS http://127.0.0.1:8790/api/health && echo
