#!/usr/bin/env bash
# Nightly backup: Forge database + imported repo clones + project workspaces.
# Usage: deploy/scripts/backup.sh /path/to/backups   (run from cron)
set -euo pipefail
DEST=${1:?backup folder}; STAMP=$(date +%Y%m%d-%H%M%S); mkdir -p "$DEST/$STAMP"
cd "$(dirname "$0")/../.."
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec -T postgres pg_dump -U forge -Fc forge > "$DEST/$STAMP/forge.pgdump"
for v in $(docker volume ls -q | grep -E '^(forge_repos|forge-ws-)'); do
  docker run --rm -v "$v":/v:ro -v "$DEST/$STAMP":/out alpine tar -czf "/out/$v.tgz" -C /v .
done
find "$DEST" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +   # keep 14 days
echo "backup written to $DEST/$STAMP"
