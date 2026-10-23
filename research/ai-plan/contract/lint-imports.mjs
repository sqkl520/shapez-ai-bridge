/**
 * lint-imports.mjs — P1 的 import lint 判据（plan-compiler.md §1.1-3，红队 #1(2)）。
 *
 * 断言 src/ai/compiler/*.mjs 里没有任何 import 指向 research/ai-player/proto/belt-rules.mjs：
 *   ❌ 错误副本 proto/belt-rules.mjs:49 的 `beltEntry = OPP[beltExit]` 对弯带是错的
 *      → 整条 L 形 rv 全错、物流死在第一个拐角（实机已证 entry 恒为旋转后的局部 bottom）。
 *   ✅ 权威 src/ai/belt-rules.mjs:35。
 *
 * 为什么单独成文件（而不是塞进 grid.mjs / types.mjs 的 --test 里）：
 *   lint 的判据本身要写正则/字符串，源码文本里就会出现 `import` 与引号 —— 自检代码去扫自己
 *   所在的文件会误报（P1 开发时真的被 `["from", "to"]` 和 `/\bimport\s*\(/` 骗过两次）。
 *   所以：**库文件保持干净，判据集中在测试侧**。
 *
 * 运行：node research/ai-plan/contract/lint-imports.mjs [目录]   （默认 src/ai/compiler）
 * 零依赖：ESM + node: 内置。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** 去掉注释但**保留换行**（保住「行首」这个锚点）。正则字面量不作区分，见下方 anchored 策略。 */
export function stripComments(src) {
    let out = "", i = 0;
    const n = src.length;
    while (i < n) {
        const c = src[i], c2 = src[i + 1];
        if (c === "/" && c2 === "/") { while (i < n && src[i] !== "\n") { out += " "; i++; } continue; }
        if (c === "/" && c2 === "*") {
            out += "  "; i += 2;
            while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { out += src[i] === "\n" ? "\n" : " "; i++; }
            out += "  "; i += 2; continue;
        }
        if (c === '"' || c === "'" || c === "`") {   // 字符串整段保留：静态 import 的规格符就在字符串里
            const q = c; out += c; i++;
            while (i < n) {
                if (src[i] === "\\") { out += src[i] + (src[i + 1] ?? ""); i += 2; continue; }
                out += src[i];
                if (src[i] === q) { i++; break; }
                i++;
            }
            continue;
        }
        out += c; i++;
    }
    return out;
}

/**
 * 收集 import 规格符。策略：**行首锚定** + 动态 import。
 * 本仓库（含编译器包）的 import 语句一律顶格或缩进起行，行首锚定足以排除
 * 「字符串/正则里出现的 import 字样」—— 这正是裸 `from ["']` 正则的翻车点。
 * @param {string} src @returns {string[]}
 */
export function collectImportSpecifiers(src) {
    const code = stripComments(src);
    // 语句边界用「行首 或 ;」，中间不允许跨 ; —— 这样回溯不会吃到别的语句
    const SPECS = String.raw`["']([^"']+)["']`;
    const specs = [
        // import [clause 可跨行, 不含 ;] from "spec"
        ...[...code.matchAll(new RegExp(`(?:^|[;\\n])[ \\t]*import\\b[^;]{0,300}?\\bfrom[ \\t]*${SPECS}`, "g"))].map(m => m[1]),
        // import "spec"（side-effect：规格符紧跟 import）
        ...[...code.matchAll(new RegExp(`(?:^|[;\\n])[ \\t]*import[ \\t]+${SPECS}`, "g"))].map(m => m[1]),
        // 动态：import("spec") / await import("spec")
        ...[...code.matchAll(new RegExp(`(?:^|[^A-Za-z0-9_$.])import[ \\t]*\\([ \\t]*${SPECS}`, "g"))].map(m => m[1]),
    ];
    return [...new Set(specs)];
}

/** 规格符是否指向 proto/belt-rules（已知错误副本）？ */
export const isProtoBeltRules = s => /(^|\/)proto\/belt-rules(\.mjs)?$/.test(String(s).replace(/\\/g, "/"));
/** 规格符是否指向权威 src/ai/belt-rules.mjs（相对写法也认） */
export const isAuthoritativeBeltRules = s => /(^|\/)src\/ai\/belt-rules\.mjs$|^\.\.?\/.*\/ai\/belt-rules\.mjs$|^\.\.\/belt-rules\.mjs$/.test(String(s).replace(/\\/g, "/"));

/**
 * 扫一个目录（或单文件）。
 * @param {string} target @returns {Array<{file:string, kind:string, detail:string}>} 违规项（空数组 = 干净）
 */
export function lintDirectory(target) {
    const stat = fs.statSync(target);
    const files = stat.isDirectory()
        ? fs.readdirSync(target).filter(f => f.endsWith(".mjs") || f.endsWith(".cjs") || f.endsWith(".js")).map(f => path.join(target, f))
        : [target];
    const problems = [];
    for (const f of files) {
        const src = fs.readFileSync(f, "utf8");
        const specs = collectImportSpecifiers(src);
        for (const s of specs) if (isProtoBeltRules(s)) problems.push({ file: f, kind: "proto/belt-rules import", detail: s });
        for (const s of specs) {
            if (/belt-rules/.test(s) && !isAuthoritativeBeltRules(s)) problems.push({ file: f, kind: "非权威 belt-rules 路径", detail: s });
        }
        const bare = specs.filter(s => !s.startsWith(".") && !s.startsWith("node:") && !s.startsWith("/"));
        for (const s of bare) problems.push({ file: f, kind: "零依赖违例（裸包名 import）", detail: s });
    }
    return problems;
}

/* ───────────── 自测（lint 自己的判据也要有测试） ───────────── */
const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly || process.argv.includes("--selftest")) {
    let fails = 0;
    const eq = (got, want, m) => { const A = JSON.stringify(got), B = JSON.stringify(want); if (A === B) console.log("✓ " + m); else { fails++; console.log(`✗ ${m} got=${A} want=${B}`); } };
    // 反例：裸 from 正则会把字符串内容当模块（这就是为什么用行首锚定）
    eq(collectImportSpecifiers('const k = ["from", "to"]; import { a } from "./real.mjs";'), ["./real.mjs"], "只收行首 import，不被 [\"from\",\"to\"] 骗");
    eq(collectImportSpecifiers('const re = /\\bimport\\s*\\(\\s*["\']x["\']\\)/; import y from "./y.mjs";'), ["./y.mjs"], "正则字面量里的 import 不算");
    eq(collectImportSpecifiers('await import("./dyn.mjs");'), ["./dyn.mjs"], "动态 import 收下");
    eq(collectImportSpecifiers('import "./side.mjs";'), ["./side.mjs"], "side-effect import 收下");
    eq(collectImportSpecifiers('import {\n  a, b,\n} from "./multi.mjs";'), ["./multi.mjs"], "跨行 import clause 收下");
    eq(collectImportSpecifiers('// import { x } from "./cmt.mjs"\nimport real from "./r.mjs";'), ["./r.mjs"], "注释里的 import 不算");
    eq(isProtoBeltRules("../../research/ai-player/proto/belt-rules.mjs"), true, "认得 proto/belt-rules");
    eq(isProtoBeltRules("../belt-rules.mjs"), false, "src/ai/belt-rules.mjs 是权威，放行");
    console.log(fails ? `lint-imports: ${fails} 条失败` : "lint-imports: 判据自测通过");
    if (fails) process.exitCode = 1;
}
