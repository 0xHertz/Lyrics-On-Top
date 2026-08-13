#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
EXTENSIONS_DIR="$DATA_HOME/gnome-shell/extensions"

if ! command -v python3 >/dev/null 2>&1; then
  echo "错误: 未找到 python3" >&2
  exit 1
fi

UUID="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["uuid"])' "$SCRIPT_DIR/metadata.json")"
TARGET_DIR="$EXTENSIONS_DIR/$UUID"

echo "扩展 UUID : $UUID"
echo "安装目录 : $TARGET_DIR"
echo

if ! command -v glib-compile-schemas >/dev/null 2>&1; then
  echo "错误: 未找到 glib-compile-schemas，请先安装 glib 开发工具" >&2
  echo "  Debian/Ubuntu: sudo apt install libglib2.0-dev-bin" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"

cp "$SCRIPT_DIR/extension.js" "$TARGET_DIR/"
cp "$SCRIPT_DIR/prefs.js" "$TARGET_DIR/"
cp "$SCRIPT_DIR/metadata.json" "$TARGET_DIR/"
cp "$SCRIPT_DIR/stylesheet.css" "$TARGET_DIR/"

rm -rf "$TARGET_DIR/schemas"
cp -r "$SCRIPT_DIR/schemas" "$TARGET_DIR/"
glib-compile-schemas "$TARGET_DIR/schemas"

echo "✔ 文件已安装，schema 已编译"

if command -v gnome-extensions >/dev/null 2>&1; then
  if gnome-extensions enable "$UUID" 2>/dev/null; then
    echo "✔ 扩展已启用"
  else
    echo "提示: 无法自动启用，请在「扩展」应用中手动开启"
  fi
fi

echo
echo "如未生效，请重启 GNOME Shell："
echo "  X11     : Alt+F2 → 输入 r → 回车"
echo "  Wayland : 注销后重新登录"
