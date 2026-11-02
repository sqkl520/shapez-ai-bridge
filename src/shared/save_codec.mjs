/**
 * 离线解码 shapez 存档 —— 纯读文件，不碰游戏。
 *
 * ## 为什么需要它
 *
 * 2026-11-03 强杀游戏进程撞上自动存档，主存档文件消失、只剩
 * `.bin.backup-<ts>` 和 `.bin.tmp-<ts>`。此时：
 *
 *   · `list_saves` 照样报 `level: 5`（它读的是 `savegames.bin` 索引，索引没坏）
 *   · `load_save` 照样回 `ok: true`
 *   · 但加载出来是 **level 1 / 1 实体的空世界**
 *
 * 唯一能判断「这份文件到底是不是我要的」的办法，是不经过游戏直接解码它。
 *
 * ## 三层编码（全部照抄 upstream，不能凭记忆写）
 *
 * 1. 文件 = `\x01` + `compressX64( crc(4字符) + jsonString )`
 *    `compressX64` 是 **compressToEncodedURIComponent** 变体
 *    —— `core/lzstring.js:83-88` 用的是 `keyStrUriSafe`，**不是** `compressToBase64`。
 *    用错变体会解出乱码（实测：能看出片段但 JSON 解析失败）。
 *
 * 2. `jsonString = JSON.stringify(compressObject(payload))`
 *    —— 键值字典压缩，得到 `{keys, values, data}`。
 *
 * 3. `decompressObject` 还原（`savegame/savegame_compressor.js:135-165`）。
 *
 * ## 字段路径坑
 *
 * `entities` / `beltPaths` 挂在 `dump` **顶层**，不在 `dump.entityMgr` 下
 * （后者只放 `nextUid`）。写错路径会得到 `ents=0` 却 `level=5` —— 很容易误判。
 */
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const LZ = require("./lz-string.cjs");

/** 抄自 `savegame/savegame_compressor.js:1-2`（顺序有意义，不能改）。 */
export const CHARMAP =
    "!#%&'()*+,-./:;<=>?@[]^_`{|}~¥¦§¨©ª«¬­®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿABCDEFGHIJKLMNOPQRSTUVWXYZ";

const CHARSET_LEN = CHARMAP.length;
const dcache = new Map();

/** 抄自 `savegame_compressor.js:37-49`。 */
export function decompressInt(s) {
    const key = "" + s;
    const hit = dcache.get(key);
    if (hit !== undefined) return hit;
    let result = 0;
    for (let i = key.length - 1; i >= 0; --i) {
        result = result * CHARSET_LEN + CHARMAP.indexOf(key.charAt(i));
    }
    result -= 1;
    dcache.set(key, result);
    return result;
}

function expand(obj, keys, values) {
    if (Array.isArray(obj)) return obj.map(o => expand(o, keys, values));
    if (typeof obj === "object" && obj !== null) {
        const out = {};
        for (const k in obj) {
            out[keys[decompressInt(k)]] = expand(obj[k], keys, values);
        }
        return out;
    }
    if (typeof obj === "string") return values[decompressInt(obj)];
    return obj;
}

/** 抄自 `savegame/savegame_compressor.js:160-166`。 */
export function decompressObject(obj) {
    if (obj && obj.keys && obj.values && obj.data) {
        return expand(obj.data, obj.keys, obj.values);
    }
    return obj;
}

/** 压缩前缀。`core/async_compression.js:9` 是 `String.fromCodePoint(1)`。 */
const PREFIX = String.fromCodePoint(1);

/**
 * 解码一个存档文件。
 * @param {string} file 路径
 * @returns {{bytes:number, level:number|null, goal:string|null, entities:number,
 *            beltPaths:number, stored:string[], seed:number|null,
 *            lastUpdate:number|null, raw:object}}
 */
export function decodeSaveFile(file) {
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.startsWith(PREFIX)) {
        throw new Error(`bad compression prefix (expected \\x01, got ${JSON.stringify(raw.slice(0, 2))})`);
    }
    // decompressX64 内部会把空格还原成 '+'（core/lzstring.js:94），照做
    const decompressed = LZ.decompressFromEncodedURIComponent(raw.slice(PREFIX.length).replace(/ /g, "+"));
    if (!decompressed) throw new Error("lz decompress failed (wrong base64 variant? use URI-safe)");
    const jsonStart = decompressed.indexOf("{");
    if (jsonStart < 0) throw new Error("no json payload after checksum");
    const packed = JSON.parse(decompressed.slice(jsonStart));
    const obj = decompressObject(packed);
    const dump = obj.dump || {};
    const hg = dump.hubGoals || {};
    return {
        bytes: raw.length,
        level: hg.level ?? null,
        goal: (hg.goal && hg.goal.shape) ?? null,
        entities: (dump.entities || []).length,
        beltPaths: Object.keys(dump.beltPaths || {}).length,
        stored: Object.keys(hg.storedShapes || {}),
        seed: (dump.map && dump.map.seed) ?? null,
        lastUpdate: obj.lastUpdate ?? null,
        raw: obj,
    };
}
