#!/bin/zsh
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STAMP_FILE="$ROOT_DIR/dev-reload.txt"

echo "正在监听扩展文件变化。保持此窗口运行，按 Ctrl+C 停止。"

python3 - "$ROOT_DIR" "$STAMP_FILE" <<'PY'
import os
import sys
import time

root, stamp_file = sys.argv[1:3]
extensions = {".js", ".css", ".html", ".json", ".svg", ".png"}
ignored_dirs = {".git", "node_modules", "dist", "build"}

def snapshot():
    result = {}
    for base, dirs, files in os.walk(root):
        dirs[:] = [name for name in dirs if name not in ignored_dirs]
        for name in files:
            path = os.path.join(base, name)
            if path == stamp_file or os.path.splitext(name)[1].lower() not in extensions:
                continue
            try:
                result[path] = os.stat(path).st_mtime_ns
            except FileNotFoundError:
                pass
    return result

previous = snapshot()
while True:
    time.sleep(0.6)
    current = snapshot()
    if current == previous:
        continue
    previous = current
    stamp = str(time.time_ns())
    with open(stamp_file, "w", encoding="utf-8") as file:
        file.write(stamp + "\n")
    print("检测到修改，扩展即将自动重载。", flush=True)
PY
