/**
 * SZBP1 蓝图格式的 tools 端实现（协议 §6）。
 *
 * 与 mod 端（src/mod/shapez-ai-bridge.js 的 opExportBlueprint/opPasteBlueprint）对称：
 * - 两端用同一压缩算法（LZString URI-safe；已由 test/lzstring_interop.mjs 验证逐字节互通）
 * - 两端用同一 JSON 布局 {v, gv, w, e:[code,dx,dy,rot,...]}
 *
 * 用途：
 * - bridge / agent / 离线工具解析、生成、检视蓝图字符串（不需要游戏运行）
 * - MCP tools 返回人类可读的蓝图摘要
 *
 * 注意：code（建筑码）的语义由游戏版本决定；本模块只做容器层编解码，
 * 不做 code ↔ 建筑名 的翻译（那需要游戏内注册表；mod 端负责）。
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const LZString = require("./lz-string.cjs");

export const BLUEPRINT_PREFIX = "SZBP1.";
export const BLUEPRINT_FORMAT_VERSION = 1;

/**
 * 解析蓝图字符串。
 * @param {string} text
 * @returns {{v:number, gv:string, w:[number,number], entities:Array<{code:number|string,dx:number,dy:number,rot:number}>}}
 * @throws {Error} 带 .code = "2001" | "2006" 的错误（与协议 §7 对齐）
 */
export function decodeBlueprint(text) {
    if (typeof text !== "string" || !text.startsWith(BLUEPRINT_PREFIX)) {
        const e = new Error("blueprint text must start with " + BLUEPRINT_PREFIX);
        e.code = "2001";
        throw e;
    }
    let payload;
    try {
        const json = LZString.decompressFromEncodedURIComponent(text.slice(BLUEPRINT_PREFIX.length));
        payload = JSON.parse(json);
    } catch (err) {
        const e = new Error("blueprint text is corrupted: " + err.message);
        e.code = "2001";
        throw e;
    }
    if (!payload || payload.v !== BLUEPRINT_FORMAT_VERSION || !Array.isArray(payload.e) || payload.e.length % 4 !== 0) {
        const e = new Error("blueprint payload malformed (expect v1, e[code,dx,dy,rot,...])");
        e.code = "2001";
        throw e;
    }
    const entities = [];
    for (let i = 0; i < payload.e.length; i += 4) {
        entities.push({ code: payload.e[i], dx: payload.e[i + 1], dy: payload.e[i + 2], rot: payload.e[i + 3] });
    }
    return { v: payload.v, gv: payload.gv, w: payload.w, entities };
}

/**
 * 生成蓝图字符串。
 * @param {{gv:string, w:[number,number], entities:Array<{code:number|string,dx:number,dy:number,rot:number}>}} data
 * @returns {string}
 */
export function encodeBlueprint(data) {
    const flat = [];
    for (const e of data.entities) {
        flat.push(e.code, e.dx, e.dy, e.rot);
    }
    const payload = { v: BLUEPRINT_FORMAT_VERSION, gv: data.gv, w: data.w, e: flat };
    return BLUEPRINT_PREFIX + LZString.compressToEncodedURIComponent(JSON.stringify(payload));
}

/**
 * 给 LLM/人看的蓝图摘要（不含 code→名字翻译）。
 */
export function summarizeBlueprint(text) {
    const bp = decodeBlueprint(text);
    const byCode = new Map();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const e of bp.entities) {
        byCode.set(e.code, (byCode.get(e.code) || 0) + 1);
        minX = Math.min(minX, e.dx);
        minY = Math.min(minY, e.dy);
        maxX = Math.max(maxX, e.dx);
        maxY = Math.max(maxY, e.dy);
    }
    return {
        format_version: bp.v,
        exported_from: bp.gv,
        anchor: bp.w,
        count: bp.entities.length,
        bounds: bp.entities.length ? [maxX - minX + 1, maxY - minY + 1] : [0, 0],
        by_code: Object.fromEntries([...byCode.entries()].sort((a, b) => b[1] - a[1])),
        text_length: text.length,
    };
}

/**
 * 游戏公式的蓝图成本（与 mod 端 blueprintCost 完全一致，供离线预估）。
 */
export function blueprintCost(n) {
    const e = 4 * Math.pow(n, 1.1);
    return Math.ceil(findNiceValue(e));
}

function findNiceValue(e) {
    if (e > 1e8) return e;
    if (e < 1e-5) return 0;
    let t = 1;
    if (e > 5e4) t = 1e4;
    else if (e > 2e4) t = 5e3;
    else if (e > 5e3) t = 1e3;
    else if (e > 2e3) t = 500;
    else if (e > 1e3) t = 100;
    else if (e > 100) t = 20;
    else if (e > 20) t = 5;
    const r = Math.floor(e / t) * t;
    if (e >= 10) return Math.round(r);
    if (e >= 1) return Math.round(10 * r) / 10;
    return Math.round(100 * r) / 100;
}
