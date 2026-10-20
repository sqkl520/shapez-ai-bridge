/**
 * lz-string 互通性测试（蓝图/存档格式的基础契约）。
 *
 * 背景（协议 §6）：蓝图字符串与游戏存档使用同一压缩算法（LZString URI-safe）。
 * - mod 端：使用游戏自带的 shapez.compressX64 / decompressX64
 * - 桥接/工具端：使用 vendored 的 src/shared/lz-string.cjs
 * 两端必须逐字节兼容，否则蓝图字符串无法跨端使用。
 *
 * 本测试用上游游戏源码的原始 lzstring.js（ee2279d5 的 src/js/core/lzstring.js，
 * test/fixtures/ 内）作为"游戏端"，与 vendored 副本做双向对拍。
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const game = require("./fixtures/game_lzstring_cjs.cjs");
const vendored = require("../src/shared/lz-string.cjs");

const samples = [
    "hello world",
    JSON.stringify({ v: 1, gv: "1.5.6", w: [-2, -2], e: [1, 0, 0, 90, 1, 1, 0, 90, 7, 0, 3, 0] }),
    JSON.stringify({ v: 1, gv: "1.5.6", w: [0, 0], e: [] }),
    "x".repeat(1000),
    JSON.stringify({
        v: 1,
        gv: "1.5.6",
        w: [-100, -100],
        e: Array.from({ length: 400 }, (_, i) => [1, 2, 3, 4][i % 4]),
    }),
    JSON.stringify({ v: 1, gv: "1.5.6", w: [0, 0], e: [26, 0, 0, 0] }), // hub-only blueprint
];

let ok = true;
for (const s of samples) {
    const gz = game.compressX64(s);
    const vz = vendored.compressToEncodedURIComponent(s);
    const identical = gz === vz;
    const gameReadsVendored = game.decompressX64(vz) === s;
    const vendoredReadsGame = vendored.decompressFromEncodedURIComponent(gz) === s;
    const line = `len=${String(s.length).padStart(5)} identical=${identical} game<-vendored=${gameReadsVendored} vendored<-game=${vendoredReadsGame}`;
    console.log(line);
    if (!(identical && gameReadsVendored && vendoredReadsGame)) ok = false;
}

// 边界：空串与 null 行为对齐
const nullParity =
    game.compressX64(null) === vendored.compressToEncodedURIComponent(null) &&
    game.decompressX64("") === vendored.decompressFromEncodedURIComponent("");
console.log("null/empty parity:", nullParity);
if (!nullParity) ok = false;

console.log(ok ? "INTEROP OK — blueprint format is cross-implementation safe" : "INTEROP FAILED");
process.exit(ok ? 0 : 1);
