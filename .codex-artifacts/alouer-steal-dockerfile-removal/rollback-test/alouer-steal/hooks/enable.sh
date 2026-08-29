#!/bin/sh
set -eu
PLUGIN_DIR=${PLUGIN_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
if [ ! -f "$PLUGIN_DIR/.env" ]; then cp "$PLUGIN_DIR/.env.example" "$PLUGIN_DIR/.env"; fi
docker network inspect dujiao-network >/dev/null 2>&1 || docker network create dujiao-network >/dev/null
docker exec -i dujiao-postgres sh -c \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < "$PLUGIN_DIR/migrations/001-alouer.sql"
# Use the remote image when it is missing, but do not force a registry login on
# every enable when the image is already cached on the host.
docker compose --env-file "$PLUGIN_DIR/.env" -f "$PLUGIN_DIR/docker-compose.yml" up -d --pull missing --wait --wait-timeout 120
