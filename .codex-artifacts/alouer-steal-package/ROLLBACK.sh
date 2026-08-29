#!/bin/sh
set -eu
TARGET_DIR=${TARGET_DIR:-/Users/a2333/IDE/部署到服务器的文件/Dujiao-Next/plugins/alouer-steal}
python3 - "$TARGET_DIR" <<'PY'
from pathlib import Path
import shutil, sys
target = Path(sys.argv[1])
if target.exists():
    shutil.rmtree(target)
    print(f"ROLLBACK_REMOVED={target}")
else:
    print(f"ROLLBACK_ALREADY_ABSENT={target}")
PY
