#!/bin/sh
set -eu

PLUGIN_DIR=${PLUGIN_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
if [ ! -f "$PLUGIN_DIR/.env" ]; then
  cp "$PLUGIN_DIR/.env.example" "$PLUGIN_DIR/.env"
fi
docker network inspect dujiao-network >/dev/null 2>&1 || docker network create dujiao-network >/dev/null
docker compose --env-file "$PLUGIN_DIR/.env" -f "$PLUGIN_DIR/docker-compose.yml" up -d --remove-orphans --wait --wait-timeout 120
