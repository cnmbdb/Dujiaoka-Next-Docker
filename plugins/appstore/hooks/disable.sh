#!/bin/sh
set -eu

PLUGIN_DIR=${PLUGIN_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
docker compose --env-file "$PLUGIN_DIR/.env" -f "$PLUGIN_DIR/docker-compose.yml" stop
