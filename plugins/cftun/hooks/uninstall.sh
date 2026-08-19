#!/bin/sh
set -eu

PLUGIN_DIR=${PLUGIN_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
docker compose --env-file "$PLUGIN_DIR/.env" -f "$PLUGIN_DIR/docker-compose.yml" down --remove-orphans

if [ "${PLUGIN_REMOVE_DATA:-0}" = "1" ]; then
  rm -rf -- "$PLUGIN_DIR/data"
fi
