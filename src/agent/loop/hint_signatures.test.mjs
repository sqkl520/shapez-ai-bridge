/**
 * hint_signatures.test.mjs — 诊断提示里写的宏调用，参数名必须真的存在。
 *
 * ══════════════════════════ 为什么需要这条 ══════════════════════════
 *
 * 2026-11-15，L12 真机：agent 连续几轮的最后一步都撞同一个墙 ——
 *
 *   remove_run {region: $path_of([...])}
 *   → LLM_ARGS: remove_run 没有参数 "region" —— 它只接受 uids / cells / opts.*
 *
 * 模型不是乱写：**诊断提示就是这么教它的**（`semantic.mjs` 的 DEAD_LINES 提示）。
 * 而宏卡片教的是 `uids`。两处说法不一致，模型只能二选一猜，
 * 猜错了也没有办法知道是提示错了而不是自己错了。
 *
 * 这类 bug 单测全绿、宏单测也全绿 —— 因为它不在任何一方的判据里：
 * 提示是字符串模板，宏签名是另一份数据，没人核对两者是否对得上。
 *
 * 这条测试就是那个核对。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MACRO_SPECS } from "../macros/contract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra) {
    if (cond) { pass++; console.log("✓ " + label); }
    else {
        fail++; failures.push(label);
        console.log("✗ " + label + (extra !== undefined ? "  " + String(extra).slice(0, 400) : ""));
    }
}

/* 收集所有非测试源文件 */
const files = [];
(function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) walk(p);
        else if (f.name.endsWith(".mjs") && !f.name.includes(".test.")) files.push(p);
    }
})(path.join(ROOT, "agent"));

/* 只扫「提示文本」——即出现在模板字符串或普通字符串里的 `macro {param:` 形态。
 * 注释里的历史记录（"它原来写的是 remove_run {region:...}"）故意不算，
 * 那些是在描述过去的 bug，不是在教模型怎么写。 */
const re = /\b(remove_run|connect|replace_run|insert_machine|trash_unused|extend_line|build_line|upgrade)\s*\{\s*([a-z_]+)\s*:/g;

/** 把注释行剔掉，只留代码行 */
function stripComments(src) {
    return src
        .split("\n")
        .filter((line) => {
            const t = line.trim();
            return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
        })
        .join("\n");
}

const bad = [];
for (const f of files) {
    const raw = fs.readFileSync(f, "utf8");
    const lines0 = raw.split("\n");
    const src = stripComments(raw);
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(src))) {
        const [, macro, param] = m;
        const spec = MACRO_SPECS[macro];
        if (!spec || !Array.isArray(spec.params)) continue;
        /* 合法名 = 顶层参数名；`opts` 下挂的子键（如 `allow_replace`）也算合法，
           因为提示里常写成 `connect {allow_replace:true}` 这种省略 opts 的简写。 */
        const names = new Set();
        for (const p of spec.params) {
            const n = String(p.name);
            names.add(n.split(".")[0]);
            if (n.startsWith("opts.")) names.add(n.slice(5));
        }
        if (!names.has(param)) {
            /* 在**原始**文本里找这一行，报出来的行号才对得上编辑器 */
            const line = src.slice(0, m.index).split("\n").length;
            const origLine = lines0.findIndex((L) => L.includes(`${macro} {${param}`));
            bad.push(`${path.relative(ROOT, f)}:${origLine + 1 || line}  ${macro} {${param}:…}  ← 合法参数: ${[...names].join(", ")}`);
        }
    }
}

ok(bad.length === 0,
    "诊断提示里的宏调用参数名，必须都在该宏的声明里",
    bad.length ? bad.join("\n") : undefined);

/* ── 反向对照：故意喂一个错的，确认扫描器抓得住 ──
 * 没有这条，上面那条「全绿」可能只是因为正则压根没匹配到东西。 */
{
    const probe = "用 `remove_run {region:$path_of([B1])}` 拆";
    re.lastIndex = 0;
    const m = re.exec(probe);
    ok(!!m && m[1] === "remove_run" && m[2] === "region",
        "扫描器本身能抓到 `macro {param:` 形态（否则上面那条是假绿）");
}

/* ── 每个宏都必须真的有 params 声明 ── */
{
    const missing = [];
    for (const [name, spec] of Object.entries(MACRO_SPECS)) {
        if (!Array.isArray(spec.params) || !spec.params.length) missing.push(name);
    }
    ok(missing.length === 0, "每个宏都有 params 声明（没有就无从核对）", missing.join(", "));
}

console.log(`\nhint_signatures: ${pass} passed, ${fail} failed`);
if (fail) { console.log("失败项："); for (const f of failures) console.log("  ✗ " + f); }
process.exit(fail ? 1 : 0);
