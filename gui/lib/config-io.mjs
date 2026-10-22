/**
 * config-io.mjs — bridge.config.json 读/校验/写 + gui/.gui-state.json（DESIGN-PLAN §2.3 / §4 T1）
 *
 * 冻结导出：
 *   readConfig() -> config（缺文件/坏文件返回默认；不抛）
 *   validateConfig(cfg) -> {ok, clean, errors, warnings}
 *   writeConfig(cfg) -> {ok:true, path}（原子写 .tmp + rename）
 *   resetConfig() -> config（写回默认值）
 *   readGuiState() / writeGuiState(patch)
 *
 * 零依赖：只用 node: 内置模块。
 */
import fs from "node:fs";
import path from "node:path";
import { BRIDGE_CONFIG, GUI_STATE } from "./paths.mjs";

// ─────────────────────────── 默认值 ───────────────────────────

/** 与 bridge.config.example.json / bridge.mjs loadConfig 默认完全一致 */
export const DEFAULT_CONFIG = Object.freeze({
    port: 7777,
    token: null,
    read_only: false,
    snapshot_dir: "./snapshots",
    log_level: "info",
    rpc_timeout_ms: 30000,
    long_timeout_ms: 180000,
});

function freshDefaults() {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

export const LOG_LEVELS = Object.freeze(["debug", "info", "warn"]);

// token：可打印 ASCII（\x21-\x7e）8–128 位。
// 允许 8–15 位（如测试机上的短 token）但会进 warnings（弱 token 警告，§2.3）。
const TOKEN_RE = /^[\x21-\x7e]{8,128}$/;
const TOKEN_WEAK_LEN = 16; // < 16 → warning；>= 16 无告警

// ─────────────────────────── 校验（DESIGN-PLAN §2.3） ───────────────────────────

/**
 * 校验一份完整 config 对象。
 * @param {object} cfg
 * @returns {{ok:boolean, clean:object|null, errors:Object<string,string>, warnings:string[]}}
 *   errors: {field: 中文消息}；clean: 规范化后的配置（仅 ok:true 时非 null）
 */
export function validateConfig(cfg) {
    const errors = {};
    const warnings = [];

    if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) {
        return { ok: false, clean: null, errors: { _: "配置必须是一个 JSON 对象" }, warnings };
    }

    const clean = {};

    // ── port：int 1024–65535 ──
    // 注：默认值 7777 落在该区间内，是合法值（无需特殊处理）。
    {
        const v = cfg.port;
        if (!Number.isInteger(v) || v < 1024 || v > 65535) {
            errors.port = "port 必须为 1024–65535 的整数";
        } else {
            clean.port = v;
        }
    }

    // ── token：null 或可打印 ASCII 8–128 位 ──
    {
        const v = cfg.token;
        if (v === null || v === undefined) {
            clean.token = null;
        } else if (typeof v !== "string") {
            errors.token = "token 必须为 null 或字符串（可打印 ASCII，8–128 位）";
        } else if (!TOKEN_RE.test(v)) {
            errors.token = "token 只能包含可打印 ASCII 字符（不可含空格），长度 8–128";
        } else {
            clean.token = v;
            if (v.length < TOKEN_WEAK_LEN) warnings.push("token 长度不足 16 位，安全性较弱，建议使用更长的随机 token");
        }
    }

    // ── read_only：bool ──
    {
        const v = cfg.read_only;
        if (typeof v !== "boolean") {
            errors.read_only = "read_only 必须为布尔值（true/false）";
        } else {
            clean.read_only = v;
        }
    }

    // ── snapshot_dir：非空 string，不含 \0 ──
    {
        const v = cfg.snapshot_dir;
        if (typeof v !== "string" || v.length === 0) {
            errors.snapshot_dir = "snapshot_dir 必须为非空字符串（快照目录路径）";
        } else if (v.includes("\0")) {
            errors.snapshot_dir = "snapshot_dir 不能包含空字符 \\0";
        } else {
            clean.snapshot_dir = v;
        }
    }

    // ── log_level：debug|info|warn ──
    {
        const v = cfg.log_level;
        if (typeof v !== "string" || !LOG_LEVELS.includes(v)) {
            errors.log_level = "log_level 必须为 debug、info 或 warn 之一";
        } else {
            clean.log_level = v;
        }
    }

    // ── timeouts：int 1000–600000 ──
    for (const field of ["rpc_timeout_ms", "long_timeout_ms"]) {
        const v = cfg[field];
        if (!Number.isInteger(v) || v < 1000 || v > 600000) {
            errors[field] = `${field} 必须为 1000–600000 的整数（毫秒）`;
        } else {
            clean[field] = v;
        }
    }

    // long_timeout 应不小于 rpc_timeout（不致命，进 warnings）
    if (Number.isInteger(clean.rpc_timeout_ms) && Number.isInteger(clean.long_timeout_ms)
        && clean.long_timeout_ms < clean.rpc_timeout_ms) {
        warnings.push("long_timeout_ms 小于 rpc_timeout_ms，长操作可能提前超时");
    }

    const ok = Object.keys(errors).length === 0;
    return { ok, clean: ok ? clean : null, errors, warnings };
}

// ─────────────────────────── 读 ───────────────────────────

/**
 * 读取 bridge.config.json。
 * - 文件不存在 → 返回默认配置（不报错，验收 C6）
 * - 文件坏 JSON → 返回默认配置，并把错误附在返回值上（cfg.__error，供调用方提示）
 *   （冻结签名只承诺返回 config；__error 为附加诊断字段，不破坏结构）
 * @returns {object} 默认字段全集（缺字段用默认值补齐）
 */
export function readConfig() {
    /** @type {any} */
    const out = freshDefaults();
    let raw = null;
    try {
        raw = fs.readFileSync(BRIDGE_CONFIG, "utf8");
    } catch (e) {
        if (e.code !== "ENOENT") {
            out.__error = `读取 bridge.config.json 失败：${e.message}`;
        }
        return out; // 缺文件 → 默认，不抛（C6）
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        out.__error = `bridge.config.json 不是合法 JSON：${e.message}（已回退默认值）`;
        return out;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        out.__error = "bridge.config.json 顶层必须是 JSON 对象（已回退默认值）";
        return out;
    }
    // 用默认值全字段打底，只接受文件中出现过的键；未知键忽略
    // （与 bridge.mjs 的 Object.assign(cfg, ...) 行为一致：逐键覆盖默认）
    for (const key of Object.keys(DEFAULT_CONFIG)) {
        if (Object.prototype.hasOwnProperty.call(parsed, key)) out[key] = parsed[key];
    }
    return out;
}

// ─────────────────────────── 写（原子：.tmp + rename） ───────────────────────────

/**
 * 原子写 bridge.config.json：先写同目录 .tmp 再 rename 覆盖。
 * @param {object} cfg 完整 config 对象（调用前应已通过 validateConfig，本函数只做序列化）
 * @returns {{ok:true, path:string}}
 */
export function writeConfig(cfg) {
    const ordered = {};
    for (const key of Object.keys(DEFAULT_CONFIG)) ordered[key] = cfg[key];
    const json = JSON.stringify(ordered, null, 2) + "\n";
    const tmp = BRIDGE_CONFIG + ".tmp";
    fs.mkdirSync(path.dirname(BRIDGE_CONFIG), { recursive: true });
    fs.writeFileSync(tmp, json, "utf8");
    fs.renameSync(tmp, BRIDGE_CONFIG); // Windows 上 rename 覆盖已存在文件：Node 内部走 MoveFileEx(REPLACE_EXISTING)
    return { ok: true, path: BRIDGE_CONFIG };
}

/**
 * 写回默认配置。
 * @returns {object} 已写入的默认配置
 */
export function resetConfig() {
    const cfg = freshDefaults();
    writeConfig(cfg);
    return cfg;
}

// ─────────────────────────── gui/.gui-state.json ───────────────────────────

const DEFAULT_GUI_STATE = Object.freeze({
    wizard_completed: false,   // 首启向导是否走完（§3.5：完成后不再出现）
    game_dir_override: null,   // 用户手动指定的游戏目录（POST /api/env 持久化，§2.1）
});

function freshStateDefaults() {
    return JSON.parse(JSON.stringify(DEFAULT_GUI_STATE));
}

/**
 * 读 GUI 状态；缺文件/坏文件 → 默认值补全（不抛）。
 * @returns {{wizard_completed:boolean, game_dir_override:string|null}}
 */
export function readGuiState() {
    const out = freshStateDefaults();
    let raw;
    try {
        raw = fs.readFileSync(GUI_STATE, "utf8");
    } catch {
        return out;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return out;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return out;
    if (typeof parsed.wizard_completed === "boolean") out.wizard_completed = parsed.wizard_completed;
    if (typeof parsed.game_dir_override === "string" && parsed.game_dir_override.length > 0) {
        out.game_dir_override = parsed.game_dir_override;
    }
    return out;
}

/**
 * 合并写 GUI 状态（patch 逐键覆盖）。
 * @param {object} patch 例如 {wizard_completed:true} 或 {game_dir_override:"D:/..."} 或 {game_dir_override:null}
 * @returns {{wizard_completed:boolean, game_dir_override:string|null}} 写入后的完整状态
 */
export function writeGuiState(patch) {
    const cur = readGuiState();
    if (patch && typeof patch === "object") {
        for (const key of Object.keys(DEFAULT_GUI_STATE)) {
            if (Object.prototype.hasOwnProperty.call(patch, key)) cur[key] = patch[key];
        }
        // 归一化：game_dir_override 只允许 string|null
        if (cur.game_dir_override !== null && typeof cur.game_dir_override !== "string") {
            cur.game_dir_override = null;
        }
        if (typeof cur.wizard_completed !== "boolean") cur.wizard_completed = !!cur.wizard_completed;
    }
    const tmp = GUI_STATE + ".tmp";
    fs.mkdirSync(path.dirname(GUI_STATE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cur, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, GUI_STATE);
    return cur;
}
