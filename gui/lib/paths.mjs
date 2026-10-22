/**
 * paths.mjs — 全仓库路径常量（DESIGN-PLAN §4 T1 冻结导出）
 *
 * 零依赖：只用 node: 内置模块。所有导出均为绝对路径字符串。
 * 本文件是 GUI 各模块（server / env-probe / config-io / proc-mgr 调用方）
 * 取路径的唯一来源，不要在别处再手工拼路径。
 */
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

/** 仓库根。本文件位于 <root>/gui/lib/paths.mjs → 上溯两级。 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** <root>/gui */
export const GUI_DIR = path.join(ROOT, "gui");

/** <root>/gui/ui （前端静态文件根，T2 静态服务用） */
export const UI_DIR = path.join(GUI_DIR, "ui");

/** <root>/bridge.config.json （桥接与 GUI 共用配置文件，§2.3） */
export const BRIDGE_CONFIG = path.join(ROOT, "bridge.config.json");

/** <root>/gui/.gui-state.json （GUI 自己的状态：向导完成标记、手动 game_dir 覆盖） */
export const GUI_STATE = path.join(GUI_DIR, ".gui-state.json");

/** <root>/src/mod/shapez-ai-bridge.js （mod 源文件，安装源） */
export const MOD_SOURCE = path.join(ROOT, "src", "mod", "shapez-ai-bridge.js");

/** <root>/src/mcp/server.mjs （MCP server 入口，/api/mcp-config 生成用） */
export const MCP_SERVER = path.join(ROOT, "src", "mcp", "server.mjs");

/** <root>/snapshots （快照默认目录，与 bridge.config.json 默认值一致） */
export const SNAPSHOT_DIR_DEFAULT = path.join(ROOT, "snapshots");

/**
 * Roaming AppData。APPDATA 理论上恒存在，但防御性回落到 homedir
 * （若 APPDATA 缺失还硬拼会得到 "undefined\shapez.io"）。
 */
const ROAMING_APPDATA = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");

/** %APPDATA%\shapez.io\mods （mod 安装目标目录，WINDOWS-PROBES §2 实测存在） */
export const MODS_DIR = path.join(ROAMING_APPDATA, "shapez.io", "mods");

/** %APPDATA%\shapez.io\saves （存档与 modsettings 所在目录） */
export const SAVES_DIR = path.join(ROAMING_APPDATA, "shapez.io", "saves");
