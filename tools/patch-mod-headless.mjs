/**
 * 给 mod 打补丁：加「无头驱动」。
 *
 * 用法：node tools/patch-mod-headless.mjs
 * 幂等：已经打过就跳过。原文件备份在 .modbak/。
 *
 * 补丁正文在 tools/mod-patch-headless.js.txt（避免模板字符串里嵌套反引号）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOD = path.join(process.env.APPDATA, "shapez.io", "mods", "shapez-ai-bridge.js");
const PATCH_FILE = path.join(HERE, "mod-patch-headless.js.txt");

let src = fs.readFileSync(MOD, "utf8");
if (src.includes("installHeadlessDriver(opts) {")) {
    console.log("已经打过补丁，跳过。");
    process.exit(0);
}

const ANCHOR = "    installLogCapture() {";
if (!src.includes(ANCHOR)) {
    console.error("锚点没找到：" + ANCHOR);
    process.exit(1);
}

const patch = fs.readFileSync(PATCH_FILE, "utf8");
// 缩进对齐：补丁文件里已经是 4 空格缩进，直接用
src = src.replace(ANCHOR, patch + ANCHOR);
fs.writeFileSync(MOD, src);
console.log(`已插入 installHeadlessDriver（${patch.split("\n").length} 行）`);
