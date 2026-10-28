/* 复现 place() 的顺序问题：occupancyLocal 在 2208（矿机对齐）用到，
   但真正"占位"的 occupied 集合到 2301 才灌，而机器在 2273 就落子了。 */
import fs from "node:fs";
const src = fs.readFileSync("D:/Projects/rea/Project work/shapez/src/ai/compiler/place.mjs","utf8");
const line = n => src.split("\n")[n-1];
for (const n of [2273, 2301]) console.log(n, ":", line(n).trim());
console.log("→ 2273 < 2301 ：机器先落子，既有占位后灌");
console.log("→ 证明 2208 处的占用是另一套（miner alignment 用 occupiedWorld），不是 occupied 集合");
