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
// v2 = 引入可选平行数组 o（originalRotation）；e 仍是 4 列 stride（见 decodeBlueprint 注释）
export const BLUEPRINT_FORMAT_VERSION = 2;

/**
 * 解析蓝图字符串。
 *
 * 版本语义（v2 引入可选的 `o` 平行数组，见 PROTOCOL §6）：
 *   v:1 → `e` 按 4 列解；`o` 若存在则**照读**（向后兼容：v2 编码器写 v:2，这里是防御）
 *   v:2 → `e` 仍按 4 列解（**不改成 stride=5** —— 那样 n%4==0 时旧解码器会静默错位），
 *         另可带 `o:[originalRotation,...]`，长度必须 === e.length/4
 * 缺 `o` 时 `entities[i].orig = rot`（= 今天的行为），所以 v2 文本能被 v1 解码器读、反之亦然。
 *
 * @param {string} text
 * @returns {{v:number, gv:string, w:[number,number], entities:Array<{code:number|string,dx:number,dy:number,rot:number,orig:number}>}}
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
    const okVersion = payload && (payload.v === 1 || payload.v === BLUEPRINT_FORMAT_VERSION);
    if (!okVersion || !Array.isArray(payload.e) || payload.e.length % 4 !== 0) {
        const e = new Error(`blueprint payload malformed (expect v1|v${BLUEPRINT_FORMAT_VERSION}, e[code,dx,dy,rot,...])`);
        e.code = "2001";
        throw e;
    }
    const n = payload.e.length / 4;
    let orig = null;
    if (payload.o !== undefined) {
        if (!Array.isArray(payload.o) || payload.o.length !== n) {
            // 长度不符必须报，不能静默按短的截断（那正是 stride=5 静默错位的同族风险）
            const e = new Error(`blueprint payload malformed: o.length (${Array.isArray(payload.o) ? payload.o.length : "not-array"}) !== entity count (${n})`);
            e.code = "2001";
            throw e;
        }
        orig = payload.o;
    }
    const entities = [];
    for (let i = 0; i < n; i++) {
        const rot = payload.e[i * 4 + 3];
        entities.push({
            code: payload.e[i * 4],
            dx: payload.e[i * 4 + 1],
            dy: payload.e[i * 4 + 2],
            rot,
            // 缺 o（或该位为 null）→ 回落到 rot，与 v1 时代语义一致
            orig: orig && orig[i] !== null && orig[i] !== undefined ? orig[i] : rot,
        });
    }
    return { v: payload.v, gv: payload.gv, w: payload.w, entities };
}

/**
 * 生成蓝图字符串。
 *
 * 写法选择（见 `research/ai-plan/emitter/NOTES.md` §一 的实测）：
 * 用**平行数组** `o` 而不是把 stride 改成 5。官方理由是"兼容性默认方向"：
 *   · 若改 stride=5 却忘了升 v，n%4==0 时旧解码器会静默读出 10 个错位实体并盖进世界（实测 n=4/8/12/16 中招）；
 *   · 平行数组让 v1 解码器原样可读（多出的 o 被忽略），且长度不符能**显式报错**。
 * 代价是容量 +12~27%（同一列整数进 JSON，实测 2000 格从 3899 → 4950 字符），可接受。
 *
 * @param {{gv:string, w:[number,number], entities:Array<{code:number|string,dx:number,dy:number,rot:number,orig?:number}>, version?:number}} data
 *        `entities[i].orig`（可选）：该格的 originalRotation；全缺则写纯 v1 载荷
 * @returns {string}
 */
export function encodeBlueprint(data) {
    const flat = [];
    const origs = [];
    let anyOrig = false;
    for (const e of data.entities) {
        flat.push(e.code, e.dx, e.dy, e.rot);
        const o = e.orig === undefined || e.orig === null ? null : e.orig;
        if (o !== null) anyOrig = true;
        origs.push(o);
    }
    const useV2 = anyOrig || data.version === 2;
    const payload = { v: useV2 ? BLUEPRINT_FORMAT_VERSION : 1, gv: data.gv, w: data.w, e: flat };
    // 只有真的要表达 orig 时才写 o（纯 v1 载荷保持逐字节与历史产物一致）
    if (useV2) payload.o = origs;
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
