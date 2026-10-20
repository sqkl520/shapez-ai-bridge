#!/usr/bin/env bash
#
# shapez-ai-bridge installer for macOS / Linux.
#
# Copies src/mod/shapez-ai-bridge.js from this repository into the game's
# mods folder. The game's main process (index-main.js) reads mods from:
#   macOS:  $HOME/Library/Preferences/shapez.io/mods
#   Linux:  ${XDG_DATA_HOME:-$HOME/.local/share}/shapez.io/mods
#
# Idempotent: re-running just reinstalls the current version. An existing
# shapez-ai-bridge.js is backed up as shapez-ai-bridge.js.bak-<timestamp>
# before being overwritten (disable with --no-backup).
#
# Usage:
#   bash install.sh                      # install
#   bash install.sh --uninstall          # remove the mod
#   bash install.sh --mods-dir <path>    # custom mods directory
#   bash install.sh --no-backup          # overwrite without a backup
#
# No admin rights needed. Does NOT modify any game files.

set -euo pipefail

# --- Locate paths -------------------------------------------------------------

# Directory of this script (the repo root). Never rely on cwd.
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
SOURCE_FILE="$SCRIPT_DIR/src/mod/shapez-ai-bridge.js"
MOD_FILE_NAME="shapez-ai-bridge.js"

MODS_DIR=""
UNINSTALL=0
DO_BACKUP=1

usage() {
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

# --- Parse arguments ----------------------------------------------------------

while [ $# -gt 0 ]; do
    case "$1" in
        --uninstall)
            UNINSTALL=1
            shift
            ;;
        --mods-dir)
            if [ $# -lt 2 ]; then
                echo "[FAIL] --mods-dir requires a path argument." >&2
                echo "[失败] --mods-dir 需要一个路径参数。" >&2
                exit 1
            fi
            MODS_DIR="$2"
            shift 2
            ;;
        --mods-dir=*)
            MODS_DIR="${1#--mods-dir=}"
            shift
            ;;
        --no-backup)
            DO_BACKUP=0
            shift
            ;;
        -h|--help)
            usage 0
            ;;
        *)
            echo "[FAIL] Unknown argument: $1 (see --help)" >&2
            echo "[失败] 未知参数: $1（见 --help）" >&2
            exit 1
            ;;
    esac
done

# --- Default mods directory per platform --------------------------------------

if [ -z "$MODS_DIR" ]; then
    case "$(uname -s)" in
        Darwin)
            MODS_DIR="${HOME}/Library/Preferences/shapez.io/mods"
            ;;
        Linux)
            XDG_BASE="${XDG_DATA_HOME:-$HOME/.local/share}"
            MODS_DIR="${XDG_BASE}/shapez.io/mods"
            # The game binary itself builds this path from $HOME/.local/share and
            # ignores XDG_DATA_HOME. If the two disagree, the game will not see
            # the mod; warn the user so they can pass --mods-dir explicitly.
            if [ -n "${XDG_DATA_HOME:-}" ] && [ "$XDG_DATA_HOME" != "$HOME/.local/share" ]; then
                echo "[WARN] XDG_DATA_HOME is set to: $XDG_DATA_HOME" >&2
                echo "       The shapez.io binary reads mods from \$HOME/.local/share/shapez.io/mods" >&2
                echo "       regardless of XDG_DATA_HOME. If the mod does not load, re-run with:" >&2
                echo "         bash install.sh --mods-dir \"\$HOME/.local/share/shapez.io/mods\"" >&2
                echo "[警告] 检测到自定义 XDG_DATA_HOME。游戏本体忽略该变量，固定读取 \$HOME/.local/share。" >&2
                echo "       若 mod 未生效，请改用: bash install.sh --mods-dir \"\$HOME/.local/share/shapez.io/mods\"" >&2
            fi
            ;;
        *)
            echo "[FAIL] Unsupported OS: $(uname -s). Add --mods-dir to specify the mods folder manually." >&2
            echo "[失败] 不支持的系统: $(uname -s)。请用 --mods-dir 手动指定 mods 目录。" >&2
            exit 1
            ;;
    esac
fi

# --- Uninstall mode -----------------------------------------------------------

if [ "$UNINSTALL" -eq 1 ]; then
    TARGET="$MODS_DIR/$MOD_FILE_NAME"
    echo "Uninstalling shapez-ai-bridge..."
    echo "正在卸载 shapez-ai-bridge..."
    if [ -f "$TARGET" ]; then
        rm -f -- "$TARGET"
        echo "[OK] Removed: $TARGET"
        echo "[成功] 已删除: $TARGET"
        echo "Restart the game for the change to take effect."
        echo "重启游戏后生效。"
    else
        echo "[SKIP] Nothing to uninstall: $TARGET does not exist."
        echo "[跳过] 无需卸载: $TARGET 不存在。"
    fi
    exit 0
fi

# --- Install mode -------------------------------------------------------------

echo "shapez-ai-bridge installer (macOS/Linux)"
echo "shapez-ai-bridge 安装程序（macOS/Linux）"
echo ""

# 1. Verify the source mod file exists in the repo.
if [ ! -f "$SOURCE_FILE" ]; then
    echo "[FAIL] Source mod file not found: $SOURCE_FILE" >&2
    echo "[失败] 未找到源 mod 文件: $SOURCE_FILE" >&2
    echo "Run this script from a full checkout of the repository (src/mod must exist next to it)." >&2
    echo "请确认仓库完整检出（脚本旁边应有 src/mod 目录）。" >&2
    exit 1
fi

# 2. Ensure the mods directory exists (same behavior as the game itself).
if [ ! -d "$MODS_DIR" ]; then
    echo "[INFO] Mods directory does not exist, creating: $MODS_DIR"
    echo "[提示] mods 目录不存在，正在创建: $MODS_DIR"
    mkdir -p -- "$MODS_DIR"
else
    echo "[INFO] Mods directory: $MODS_DIR"
    echo "[提示] mods 目录: $MODS_DIR"
fi

TARGET="$MODS_DIR/$MOD_FILE_NAME"

# 3. Back up an existing mod before overwriting (idempotent reinstall).
if [ -f "$TARGET" ]; then
    if [ "$DO_BACKUP" -eq 1 ]; then
        STAMP="$(date +%Y%m%d-%H%M%S)"
        BACKUP="$TARGET.bak-$STAMP"
        cp -p -- "$TARGET" "$BACKUP"
        echo "[OK] Backed up existing mod to: $BACKUP"
        echo "[成功] 已备份现有 mod 到: $BACKUP"
    else
        echo "[INFO] Existing mod found; --no-backup so it will be overwritten in place."
        echo "[提示] 已有同名 mod；--no-backup，将直接覆盖。"
    fi
else
    echo "[INFO] Fresh install (no existing mod)."
    echo "[提示] 全新安装（无同名 mod）。"
fi

# 4. Copy the mod and verify the copy byte-for-byte.
cp -p -- "$SOURCE_FILE" "$TARGET"
if command -v cmp >/dev/null 2>&1; then
    if ! cmp -s -- "$SOURCE_FILE" "$TARGET"; then
        echo "[FAIL] Copy verification failed (files differ)." >&2
        echo "[失败] 复制校验失败（文件不一致）。" >&2
        exit 1
    fi
else
    SRC_HASH="$(shasum -a 256 -- "$SOURCE_FILE" 2>/dev/null | awk '{print $1}')"
    DST_HASH="$(shasum -a 256 -- "$TARGET" 2>/dev/null | awk '{print $1}')"
    if [ -n "$SRC_HASH" ] && [ "$SRC_HASH" != "$DST_HASH" ]; then
        echo "[FAIL] Copy verification failed (hash mismatch)." >&2
        echo "[失败] 复制校验失败（哈希不一致）。" >&2
        exit 1
    fi
fi
echo "[OK] Installed mod: $TARGET"
echo "[成功] 已安装 mod: $TARGET"

# 5. Friendly reminder about achievements (official game behavior).
echo ""
echo "[NOTE] Installing ANY mod disables Steam achievements and the puzzle DLC."
echo "       This is official shapez.io behavior, not a bug of this project."
echo "[注意] 安装任何 mod 都会禁用 Steam 成就与拼图 DLC，这是官方行为，不是本项目的 bug。"

# 6. Next steps.
echo ""
echo "Next steps / 下一步:"
echo "  1. Start shapez.io (the mod loads automatically at boot)."
echo "     启动 shapez.io（mod 会在游戏启动时自动加载）。"
echo "  2. In a terminal, start the bridge:"
echo "     在终端启动桥接服务器:"
echo "       node src/bridge/bridge.mjs"
echo "  3. Load a savegame in-game, then run the smoke test:"
echo "     进入一个有存档的世界，然后跑冒烟测试:"
echo "       node scripts/smoke_test.mjs"
echo ""
echo "Uninstall later with / 以后可用以下命令卸载:"
echo "  bash install.sh --uninstall"

# 7. Executable-bit hint (harmless when run via 'bash install.sh').
if [ ! -x "$0" ]; then
    echo ""
    echo "[TIP] To run this script directly (./install.sh), make it executable first:"
    echo "      chmod +x install.sh"
    echo "[提示] 想直接执行本脚本（./install.sh），请先加可执行权限: chmod +x install.sh"
fi
