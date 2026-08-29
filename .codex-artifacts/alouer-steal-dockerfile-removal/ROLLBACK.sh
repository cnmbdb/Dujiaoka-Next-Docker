#!/bin/sh
set -eu
TARGET_DIR=${TARGET_DIR:-/Users/a2333/IDE/部署到服务器的文件/Dujiao-Next/plugins/alouer-steal}
ART_DIR=/Users/a2333/IDE/部署到服务器的文件/Dujiao-Next/.codex-artifacts/alouer-steal-dockerfile-removal
cp -p "$ART_DIR/original/Dockerfile" "$TARGET_DIR/Dockerfile"
cp -p "$ART_DIR/original/install.sh" "$TARGET_DIR/hooks/install.sh"
printf 'ROLLBACK_RESTORED=%s\n' "$TARGET_DIR/Dockerfile"
printf 'ROLLBACK_RESTORED=%s\n' "$TARGET_DIR/hooks/install.sh"
