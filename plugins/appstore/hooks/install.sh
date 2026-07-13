#!/bin/sh
set -eu

PLUGIN_DIR=${PLUGIN_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}

test -f "$PLUGIN_DIR/plugin.json"
test -f "$PLUGIN_DIR/docker-compose.yml"
if [ ! -f "$PLUGIN_DIR/.env" ]; then
  cp "$PLUGIN_DIR/.env.example" "$PLUGIN_DIR/.env"
fi

docker compose --env-file "$PLUGIN_DIR/.env" -f "$PLUGIN_DIR/docker-compose.yml" config --quiet
