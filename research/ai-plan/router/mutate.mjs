/**
 * mutate.mjs — P4 router 的**变异测试**（L0 验收 8）。
 *
 *   node research/ai-plan/router/mutate.mjs            跑全部变异
 *   node research/ai-plan/router/mutate.mjs --list     只列变异清单
 *
 * 判据（承 plan §4「P5 变异测试每次只报对应 check id」与 P2 的 7 组变异标准）：
 *   对每条断言所依赖的逻辑，**故意破坏它** → 主测试 `test.mjs` 必须变红。
 *   若破坏后仍全绿 ⇒ 该断言是「永绿断言」（空转），本身就是 bug。
 *
 * 实现：把 route.mjs / lane.mjs 读进内存做**字符串定点替换**，写到临时目录的
 *   影子副本里，再用一个**注入后的 test 副本**去跑（import 路径重映射到影子文件）。
 *   —— 绝不改动 src/ 下的真文件；变异只活在 tmp 里，跑完删除。
 *
 * 零依赖：ESM + node: 内置。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const COMPILER = path.join(ROOT, "src", "ai", "compiler");
const TEST = path.join(HERE, "test.mjs");

/* ───────────── 变异清单：file + 唯一锚点 search + 替换 ───────────── */
/** 每条：{id, target:"route.mjs"|"lane.mjs", label, search, replace, expect:"test 必须变红"的点名串} */
const MUTATIONS = [
    {
        id: "M-1", target: "route.mjs",
        label: "chainClosure 只查方向方程①，丢掉双侧共边②③（对手性/rv 交换失去证伪力）",
        search: `const bad = ex !== OPP[en] || ux !== v.cell.x || uy !== v.cell.y || vx !== u.cell.x || vy !== u.cell.y;`,
        replace: `const bad = ex !== OPP[en];`,
    },
    {
        id: "M-2", target: "route.mjs",
        label: "code 用固定 rv0 而不是 beltCode(rv)（G1 裁决：belt code 一律 beltCode(rv)）",
        search: `rot: p.rotation, rv: p.rotationVariant, code: p.code,`,
        replace: `rot: p.rotation, rv: p.rotationVariant, code: beltCode(0),`,
    },
    {
        id: "M-3", target: "lane.mjs",
        label: "退化段（single）丢掉末格，只留 n-1 格（plan §1.4 明令保留一格）",
        search: `    if (g.kind === "single") return [g.first];`,
        replace: `    if (g.kind === "single") return [];`,
    },
    {
        id: "M-4", target: "route.mjs",
        label: "拐角不走 solveTurn：直行/转向一律硬凑 rv0（「不许硬凑」被违反）",
        search: `    const p = solveTurn(inDir, outDir);\n    if (!p) return null;`,
        replace: `    const p = solveTurn(inDir, outDir) || { rotation: 0, rotationVariant: 0 };`,
    },
    {
        id: "M-5", target: "route.mjs",
        label: "端点对齐守卫放开：首格 inDir 不再比对 OPP[flowOut]（端点错位静默通过）",
        search: `    if (head.inDir !== OPP[g.flowOut]) {`,
        replace: `    if (false) {`,
    },
    {
        id: "M-6", target: "lane.mjs",
        label: "首格几何用 slot 名当流向（读法 A/B 混用 → 端点几何整体错一格）",
        search: `    const first = step(ch.from.cell, ch.from.outDir);`,
        replace: `    const first = step(ch.from.cell, ch.from.slot === ch.from.outDir ? ch.from.outDir : OPP[ch.from.outDir]);`,
    },
    {
        id: "M-7", target: "route.mjs",
        label: "cornerCount 恒 0（回归锁与 V7 折算被空转）",
        search: `        cornerCount: corners.length,\n    };`,
        replace: `        cornerCount: 0,\n    };`,
    },
    {
        id: "M-8", target: "route.mjs",
        label: "陷阱 #1 产出锁被摘掉：同格对向不再判死",
        search: `    const ok = lane.ok && failures.length === 0 && counter.length === 0;`,
        replace: `    const ok = lane.ok && failures.length === 0;`,
    },
    {
        id: "M-9", target: "lane.mjs",
        label: "left-edge 丢掉 vertical constraint（C2）→ 源宿反序不再判冲突",
        search: `            if (iv.group != null && cand.group != null && iv.group === cand.group &&`,
        replace: `            if (false && iv.group != null && cand.group != null && iv.group === cand.group &&`,
    },
    {
        id: "M-10", target: "lane.mjs",
        label: "left-edge 闭区间重叠改成开区间（共用端点被放行 = 陷阱 #1 的形状）",
        search: `            if (iv.lo <= cand.hi && cand.lo <= iv.hi) return "interval";`,
        replace: `            if (iv.lo < cand.hi && cand.lo < iv.hi) return "interval";`,
    },
    {
        id: "M-11", target: "lane.mjs",
        label: "车道的「前进半平面」band 两侧同时翻转（带子只能倒着走 → 选到错误车道行）",
        // 原写法 `g.flowOut==="top" ? [NEG,g.rFrom] : [g.rFrom,POS]` 的两条半平面都翻向：
        //   flowOut=top 变成 row≥rFrom（车道在源**下方**，竖直腿得先往下走 = 倒流）
        //   goalOut=top 变成 row≤rTo（车道在宿**上方**，出道腿倒着进机器）
        // ⚠️ 早先版本的 M-11 摘掉的是 pre-assigned 分支的 `inBand` 判据 —— 实测那是
        //   **等价变异**（出界的 row 必然穿过机器自身占地，已被 occupancy 拒掉，摘与不摘同结果），
        //   故换成这个真承重的半平面翻转。见 NOTES。
        search: `            g.flowOut === "top" ? [NEG, g.rFrom] : [g.rFrom, POS],
            g.goalOut === "top" ? [g.rTo, POS] : [NEG, g.rTo],`,
        replace: `            g.flowOut === "top" ? [g.rFrom, POS] : [NEG, g.rFrom],
            g.goalOut === "top" ? [NEG, g.rTo] : [g.rTo, POS],`,
    },
    {
        id: "M-12", target: "lane.mjs",
        label: "hub 4×4 不再算障碍（穿 hub）",
        search: `        if (p.kind === "hub") for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) mark(p.cell[0] + dx, p.cell[1] + dy, "hub:4x4");`,
        replace: `        if (false) for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) mark(p.cell[0] + dx, p.cell[1] + dy, "hub:4x4");`,
    },
    {
        id: "M-13", target: "lane.mjs",
        label: "既有世界 occupancy 不再算障碍（V2 想防的「静默毁带」）",
        search: `    for (const o of report.occupancy || []) mark(o.cell[0], o.cell[1], \`world:\${o.state}\${o.who ? "/" + o.who : ""}\`);`,
        replace: `    // MUTANT: occupancy ignored`,
    },
    {
        id: "M-14", target: "lane.mjs",
        label: "channels[].lane 保留陈旧值（⑬ 互逆被破坏）",
        search: `        return ch.lane === null ? ch : { ...ch, lane: null };`,
        replace: `        return ch;`,
    },
    {
        id: "M-15", target: "lane.mjs",
        label: "resolvedBy 回归 blanket 盖章（所有 kind 的 null 都被盖 left-edge = 谎报归因）",
        search: `        (ok && (c.resolvedBy === null || c.resolvedBy === undefined) && c.kind === CONFLICT_KIND.lane)`,
        replace: `        (ok && (c.resolvedBy === null || c.resolvedBy === undefined))`,
    },
    {
        id: "M-16", target: "lane.mjs",
        label: "left-edge 扫描序的 id 平局换回 localeCompare（跨 locale 不确定）",
        search: `    const order = [...intervals].sort((a, b) => a.lo - b.lo || a.hi - b.hi || cmpId(a, b));`,
        replace: `    const order = [...intervals].sort((a, b) => a.lo - b.lo || a.hi - b.hi || String(a.id).localeCompare(String(b.id)));`,
    },
    {
        id: "M-17", target: "lane.mjs",
        label: "geomCorners 的 hlane 只报 1 个拐角（进道/出道被吞一个）",
        search: `            { cell: [g.cTo, laneFixed], inDir: OPP[h], outDir: g.goalOut, where: "lane-out" },`,
        replace: `            // MUTANT: lane-out dropped`,
    },
    {
        id: "M-18", target: "route.mjs",
        label: "ok:false 时 reason 回落 null（§2.5「失败必须可归因」被违反）",
        search: `    const reason = ok ? null
        : (!lane.ok ? lane.reason
            : (failures[0] ? failures[0].reason : "dag-not-placeable:crossing-needs-tunnel"));`,
        replace: `    const reason = ok ? null : (!lane.ok ? lane.reason : (failures[0] ? failures[0].reason : null));`,
    },
    {
        id: "M-19", target: "route.mjs",
        label: "越界声称语义：P4 里塞进 P5 的语义求解器 computeBelt（应被语义边界锁拒）",
        search: `export const ROUTE_SCHEMA_VERSION = 1;`,
        replace: `export const ROUTE_SCHEMA_VERSION = 1; // computeBelt reference (semantic overreach)`,
    },
];

/* ───────────── 影子副本 + 注入 ───────────── */
const SRC = {};
for (const f of ["route.mjs", "lane.mjs"]) SRC[f] = fs.readFileSync(path.join(COMPILER, f), "utf8");

// test.mjs 里被 import 的 5 个源文件：变异只碰 route/lane，其余仍从原路径 import。
// 影子目录 = tmp/p4mut-<id>/；把 route/lane 的**影子副本**放同目录，
// 但 lane.mjs import "../belt-rules.mjs"、"./grid.mjs" 等 → 需要把这些依赖一并搬进影子树。
function buildShadow(m) {
    const target = m.target;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p4mut-${m.id}-`));
    const fwd = p => p.split(path.sep).join("/");       // node 接受正斜杠；避免 JSON 里反斜杠转义地狱
    const ai = path.join(dir, "src", "ai");
    const comp = path.join(ai, "compiler");
    fs.mkdirSync(comp, { recursive: true });
    // 依赖树：src/ai/{belt-rules.mjs,op-templates.mjs,world.mjs,machine-spec.json}
    //        src/ai/compiler/{types,grid,errors,lane,route}.mjs
    const copyInto = (src, dst) => fs.copyFileSync(src, dst);
    for (const f of ["belt-rules.mjs", "op-templates.mjs", "world.mjs", "machine-spec.json"]) {
        const p = path.join(ROOT, "src", "ai", f);
        if (fs.existsSync(p)) copyInto(p, path.join(ai, f));
    }
    for (const f of ["types.mjs", "grid.mjs", "errors.mjs", "lane.mjs", "route.mjs"]) {
        copyInto(path.join(COMPILER, f), path.join(comp, f));
    }
    // 应用变异
    const before = fs.readFileSync(path.join(comp, target), "utf8");
    const hits = before.split(m.search).length - 1;
    if (hits !== 1) { fs.rmSync(dir, { recursive: true, force: true }); return { err: `锚点命中 ${hits} 次（必须恰 1 次）` }; }
    fs.writeFileSync(path.join(comp, target), before.replace(m.search, m.replace));
    // 影子 test：ROOT 指向影子树（fixtures 仍走真实仓库）
    const tsrc = fs.readFileSync(TEST, "utf8");
    const SHADOWLIT = JSON.stringify(fwd(dir));
    const HERE2LIT = JSON.stringify(fwd(path.dirname(TEST)));
    const FIXLIT = JSON.stringify(fwd(path.join(ROOT, "research", "ai-plan", "fixtures")));
    const shim = tsrc
        .replace(`const HERE = path.dirname(fileURLToPath(import.meta.url));`,
            `const HERE = ${HERE2LIT};`)
        .replace(`const ROOT = path.resolve(HERE, "..", "..", "..");`,
            `const SHADOW = ${SHADOWLIT};\nconst ROOT = SHADOW;`)
        .replace(`const FIX = path.join(ROOT, "research", "ai-plan", "fixtures");`,
            `const FIX = ${FIXLIT};`)
        .replace(/path\.join\(COMPILER, "(route|lane)\.mjs"\)/g, `path.join(SHADOW, "src", "ai", "compiler", "$1.mjs")`);
    const tpath = path.join(dir, "test.mjs");
    fs.writeFileSync(tpath, shim);
    return { dir, tpath };
}

function runSuite(tpath) {
    const r = spawnSync(process.execPath, [tpath], { encoding: "utf8", cwd: ROOT, timeout: 300000 });
    const out = (r.stdout || "") + (r.stderr || "");
    const failed = /✗ P4 router L0/.test(out);
    // ★ 崩溃（变异把 throw 引到测试里、uncaught 退出）也算「被抓」：
    //   L0 的铁律是 routeAll 对业务失败**永不 throw**，测试里炸出 RouteError 同样是红。
    const crashed = r.status !== 0 && !failed && !/✓ P4 router L0/.test(out);
    const dead = [...out.matchAll(/^✗ (.*)$/gm)].map(x => x[1].trim());
    return { code: r.status, caught: failed || crashed, dead, crashed, note: crashed ? "CRASH(算红)" : "" , out };
}

/* ───────────── 主流程 ───────────── */
if (process.argv.includes("--list")) {
    for (const m of MUTATIONS) console.log(`${m.id} [${m.onTarget || m.target}] ${m.label}`);
    process.exit(0);
}

// 先确认基线全绿（基线不绿 = 变异结果无意义）
{
    const base = runSuite(TEST);
    if (!base.failed) console.log(`✓ 基线全绿（${(base.out.match(/全部通过（(\d+)/) || [])[1] || "?"} 条断言）`);
    else { console.log(`✗ 基线不绿！先修 test 再谈变异。失败 ${base.dead.length} 条`); for (const d of base.dead.slice(0, 5)) console.log("   ✗ " + d); process.exit(1); }
}

const results = [];
for (const m of MUTATIONS) {
    const sh = buildShadow(m);
    if (sh.err) { results.push({ m, caught: false, note: "锚点失配: " + sh.err }); continue; }
    try {
        const r = runSuite(sh.tpath);
        results.push({ m, caught: r.caught, died: r.dead.slice(0, 3), note: r.note });
    } finally {
        fs.rmSync(sh.dir, { recursive: true, force: true });
    }
}

console.log("\n── 变异测试结果（每条必须把主测试打红 = 断言非永绿）──");
let survivors = 0;
for (const { m, caught, died, note } of results) {
    if (caught) {
        console.log(`✓ ${m.id} 被抓：${m.label}`);
        for (const d of died) console.log(`      ↳ ✗ ${d}`);
    } else {
        survivors++;
        console.log(`✗ ${m.id} **存活**（永绿！）：${m.label}${note ? " [" + note + "]" : ""}`);
    }
}
console.log(`\n${survivors ? `✗ ${survivors}/${results.length} 条变异存活 → 对应断言是空转，必须补强`
    : `✓ ${results.length} 条变异全部被抓（0 存活 = 无永绿断言）`}`);
process.exitCode = survivors ? 1 : 0;
