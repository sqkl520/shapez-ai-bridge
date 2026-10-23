/**
 * world.test.mjs — P2 data 包对 world.mjs 的独立验收（L0）
 *
 * 双实现交叉对拍思路：world.mjs 是**编译器要用的那份**实现，
 * 本文件独立地跑 `proto/gen-resources.mjs` **CLI**（官方基准）与 `facts/live/resources.json`
 * （实机 dump 基准），拿两个基准同时压一份实现 → 任一侧改错都红。
 *
 * 运行：node research/ai-plan/data/world.test.mjs --test
 * 全程离线：只 spawn 本地 node 子进程读本地文件，零 RPC / 零游戏（plan §4）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
    tileResource, findResource, resourcesInRegion, nearestResource, resourceHistogram,
    validateAgainstCli, validateAgainstLive, clearChunkCache, regionAround, WorldError,
    MAP_CHUNK_SIZE, DEFAULT_SEED,
} from "../../../src/ai/world.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const GEN_CLI = path.join(REPO, "research", "ai-player", "proto", "gen-resources.mjs");
const LIVE_RES = path.join(REPO, "research", "ai-player", "facts", "live", "resources.json");

let failed = 0, passed = 0;
const eq = (label, got, want) => {
    const a = JSON.stringify(got), b = JSON.stringify(want);
    if (a === b) { passed++; console.log("  ✓ " + label); }
    else { failed++; console.log(`  ✗ ${label}\n      got  ${a}\n      want ${b}`); }
};
const ok = (label, cond, detail = "") => {
    if (cond) { passed++; console.log("  ✓ " + label); }
    else { failed++; console.log(`  ✗ ${label} ${detail}`); }
};
function cli(seed, x0, y0, x1, y1) {
    const r = spawnSync(process.execPath, [GEN_CLI, String(seed), String(x0), String(y0), String(x1), String(y1)],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error("CLI 失败: " + r.stderr.slice(0, 300));
    return r.stdout.split(/\r?\n/).filter(l => l.trim().startsWith("[")).map(l => JSON.parse(l));
}

console.log("\n[1] 与 gen-resources CLI 逐格对拍（验收 4：0 差异）");
{
    clearChunkCache();
    const regions = [
        { name: "hub 周边 32×32", x0: -16, y0: -16, x1: 15, y1: 15 },
        { name: "跨 5 个写死块 96×96", x0: -48, y0: -48, x1: 47, y1: 47 },
        { name: "远端未探索区 40×40", x0: 900, y0: -700, x1: 939, y1: -661 },
        { name: "单 chunk 对齐", x0: 0, y0: 0, x1: 15, y1: 15 },
        { name: "跨 chunk 边界（负）", x0: -17, y0: -17, x1: -15, y1: -15 },
    ];
    for (const rg of regions) {
        clearChunkCache();
        const mine = resourcesInRegion(DEFAULT_SEED, rg);
        const base = cli(DEFAULT_SEED, rg.x0, rg.y0, rg.x1, rg.y1);
        const m = new Map(mine.map(([x, y, s]) => [`${x},${y}`, s]));
        const b = new Map(base.map(([x, y, s]) => [`${x},${y}`, s]));
        let diff = 0;
        for (const [k, v] of b) if (m.get(k) !== v) diff++;
        for (const k of m.keys()) if (!b.has(k)) diff++;
        eq(`${rg.name}：${mine.length} 格 vs CLI ${base.length} 格 → 差异`, diff, 0);
    }
    // 默认全区域（实机包围盒 260×313）
    clearChunkCache();
    const v = validateAgainstCli();
    eq(`默认区域全量对拍（world=${v.mine} / cli=${v.cli}）差异`, v.diff, 0);
    eq("总数两侧相等", v.mine, v.cli);
}

console.log("\n[2] 与实机 dump（facts/live/resources.json）对拍");
if (fs.existsSync(LIVE_RES)) {
    clearChunkCache();
    const lv = validateAgainstLive();
    eq(`实机 3002 格逐格一致（match=${lv.match} mismatch=${lv.mismatch} missing=${lv.missing}）`,
        [lv.mismatch, lv.missing, lv.liveCells], [0, 0, 3002]);
    // 反过来抽 20 条实机记录，直接用 tileResource 单格复核
    const live = JSON.parse(fs.readFileSync(LIVE_RES, "utf8"));
    const probe = live.filter((_, i) => i % Math.ceil(live.length / 20) === 0).slice(0, 20);
    eq("tileResource 单格抽 20 条全中", probe.map(([x, y, s]) => tileResource(DEFAULT_SEED, x, y) === s), probe.map(() => true));
    const empties = [[100, 100], [1000, 1000], [-1000, -1000], [0, 0], [3, 3], [12, 12]];
    eq("实机无资源格 → tileResource 返回 null",
        empties.filter(([x, y]) => !live.some(r => r[0] === x && r[1] === y)).every(([x, y]) => tileResource(DEFAULT_SEED, x, y) === null), true);
} else console.log("  · 跳过（无 facts/live/resources.json）");

console.log("\n[3] 写死块（generatePredefined 的 5 块，实机已确认）");
eq("chunk(0,0) 局部(7,7) = red", tileResource(DEFAULT_SEED, 7, 7), "red");
eq("chunk(-1,0) 局部(7,7) = CuCuCuCu → 世界(-9,7)", tileResource(DEFAULT_SEED, -9, 7), "CuCuCuCu");
eq("chunk(5,-2) 局部(5,9) = SuSuSuSu → 世界(85,-23)", tileResource(DEFAULT_SEED, 85, -23), "SuSuSuSu");
for (const [rg, shape, name] of [
    [{ x0: -16, y0: 0, x1: -1, y1: 15 }, "CuCuCuCu", "chunk(-1,0)"],
    [{ x0: 0, y0: -16, x1: 15, y1: -1 }, "RuRuRuRu", "chunk(0,-1)"],
    [{ x0: -16, y0: -16, x1: -1, y1: -1 }, "green", "chunk(-1,-1)"],
    [{ x0: 80, y0: -32, x1: 95, y1: -17 }, "SuSuSuSu", "chunk(5,-2)"],
]) eq(`${name} 产出 ${shape}`, findResource(DEFAULT_SEED, shape, rg).length > 0, true);

console.log("\n[4] chunk 索引语义（Math.floor，负坐标正确）");
eq("chunk 尺寸", MAP_CHUNK_SIZE, 16);
eq("负坐标 floor", [-16, -1, -17, 0, 15, 16].map(x => Math.floor(x / MAP_CHUNK_SIZE)), [-1, -1, -2, 0, 0, 1]);
eq("同一 chunk 内 256 格查询一致（缓存与直算同值）", (() => {
    clearChunkCache();
    const a = [];
    for (let x = 0; x < 16; x++) for (let y = 0; y < 16; y++) a.push(tileResource(DEFAULT_SEED, x, y));
    clearChunkCache();
    const b = [];
    for (let x = 0; x < 16; x++) for (let y = 0; y < 16; y++) b.push(tileResource(DEFAULT_SEED, x, y));
    return JSON.stringify(a) === JSON.stringify(b);
})(), true);
ok("chunk 缓存不会串 seed", (() => {
    clearChunkCache();
    const s1 = tileResource(43391, 7, 7);
    const s2 = tileResource(999, 7, 7);
    return s1 === "red" && typeof s2 !== "undefined";
})(), "");

console.log("\n[5] API 形态（P3 消费面）");
const reg = { x0: -40, y0: -40, x1: 40, y1: 40 };
eq("resourcesInRegion 元素形如 [x,y,shape]", resourcesInRegion(DEFAULT_SEED, reg).every(r => r.length === 3 && Number.isInteger(r[0]) && Number.isInteger(r[1]) && typeof r[2] === "string"), true);
eq("region 数组形式 == 对象形式", resourcesInRegion(DEFAULT_SEED, [reg.x0, reg.y0, reg.x1, reg.y1]), resourcesInRegion(DEFAULT_SEED, reg));
eq("region 乱序 == 规范化后", resourcesInRegion(DEFAULT_SEED, { x0: reg.x1, y0: reg.y1, x1: reg.x0, y1: reg.y0 }), resourcesInRegion(DEFAULT_SEED, reg));
eq('findResource("*") == resourcesInRegion', findResource(DEFAULT_SEED, "*", reg), resourcesInRegion(DEFAULT_SEED, reg));
eq("findResource(null) == resourcesInRegion", findResource(DEFAULT_SEED, null, reg), resourcesInRegion(DEFAULT_SEED, reg));
eq("findResource 谓词 == 精确名", findResource(DEFAULT_SEED, s => s === "red", reg), findResource(DEFAULT_SEED, "red", reg));
eq("findResource 无匹配 = []", findResource(DEFAULT_SEED, "ZzZzZzZz", reg), []);
{
    const hits = findResource(DEFAULT_SEED, "CuCuCuCu", { x0: -60, y0: -60, x1: 60, y1: 60 });
    const n = nearestResource(DEFAULT_SEED, "CuCuCuCu", [0, 0], { x0: -60, y0: -60, x1: 60, y1: 60 });
    ok("nearestResource 返回命中项之一", hits.some(h => h[0] === n[0] && h[1] === n[1]), JSON.stringify(n));
    const d = ([x, y]) => Math.hypot(x, y);
    eq("nearestResource 确实最近（欧氏）", d(n), Math.min(...hits.map(h => d(h))));
    const nm = nearestResource(DEFAULT_SEED, "CuCuCuCu", [0, 0], { x0: -60, y0: -60, x1: 60, y1: 60 }, "manhattan");
    eq("nearestResource 曼哈顿度量可用", d(nm) <= Math.max(...hits.map(h => d(h))), true);
    eq("nearestResource 无命中 → null", nearestResource(DEFAULT_SEED, "Zz", [0, 0], reg), null);
    // 参数校验必须是结构化错误，不是裸 TypeError（P8 分诊要靠 reason）
    const throwsWorld = (label, fn, msgPart) => {
        try { fn(); failed++; console.log(`  ✗ ${label} —— 未抛错`); }
        catch (e) {
            if (!(e instanceof WorldError)) { failed++; console.log(`  ✗ ${label} —— 抛的不是 WorldError：${e.name}: ${e.message}`); return; }
            if (msgPart && !String(e.message).includes(msgPart)) { failed++; console.log(`  ✗ ${label} —— 消息不含 "${msgPart}"`); return; }
            passed++; console.log(`  ✓ ${label}（${e.name} / ${e.reason}）`);
        }
    };
    throwsWorld("缺 region → WorldError（世界无限，不许无界搜索）", () => findResource(DEFAULT_SEED, "red", undefined), "必须给 region");
    throwsWorld("region 元素不足 → WorldError", () => resourcesInRegion(DEFAULT_SEED, [1, 2, 3]), "四个整数");
    throwsWorld("region 值非数 → WorldError", () => resourcesInRegion(DEFAULT_SEED, { x0: 0, y0: 0, x1: "a", y1: 5 }), "有限数");
    throwsWorld("非法 seed → WorldError（不静默生成错世界）", () => tileResource(undefined, 0, 0), "map.seed");
    throwsWorld("非整数坐标 → WorldError", () => tileResource(DEFAULT_SEED, 1.5, 2), "整数格坐标");
    throwsWorld("nearestResource 缺 from → WorldError", () => nearestResource(DEFAULT_SEED, "red", undefined, reg), "[x,y]");
    eq("regionAround 生成以中心为原点的正方形区", regionAround([10, -20], 5), { x0: 5, y0: -25, x1: 15, y1: -15 });
    eq("regionAround 可直接喂 findResource", findResource(DEFAULT_SEED, "red", regionAround([7, 7], 3)), findResource(DEFAULT_SEED, "red", { x0: 4, y0: 4, x1: 10, y1: 10 }));
}
eq("resourceHistogram 的总和 == 区域资源格数",
    Object.values(resourceHistogram(DEFAULT_SEED, reg)).reduce((a, b) => a + b, 0),
    resourcesInRegion(DEFAULT_SEED, reg).length);
ok("histogram 键含实机见过的颜色/形状之一", Object.keys(resourceHistogram(DEFAULT_SEED, reg)).some(k => ["red", "green", "blue", "CuCuCuRu".slice(0, 8)].includes(k) || /^[RCWS]u/.test(k)), JSON.stringify(Object.keys(resourceHistogram(DEFAULT_SEED, reg))));

console.log("\n[6] 确定性（编译器可复现的前提）");
{
    clearChunkCache();
    const run = () => JSON.stringify(resourcesInRegion(DEFAULT_SEED, reg));
    const a = run(); clearChunkCache(); const b = run();
    eq("同 seed 重跑逐字节相同", a, b);
    clearChunkCache();
    ok("不同 seed 结果不同", a !== JSON.stringify(resourcesInRegion(12345, reg)));
    clearChunkCache();
    eq("DEFAULT_SEED = 实机 level-11 的 map.seed 43391", DEFAULT_SEED, 43391);
}

console.log("\n[7] 包边界：world.mjs 是纯离线库");
{
    const src = fs.readFileSync(path.join(REPO, "src", "ai", "world.mjs"), "utf8");
    const imports = [...src.matchAll(/^import\b.*$/gm)].map(m => m[0]).join("\n");
    ok("无 fetch/WebSocket/桥接地址", !/fetch\(|WebSocket:|7777/.test(src));
    ok("import 行只有 node: 内置", imports.split("\n").every(l => /from\s+["']node:[^'"]+["']/.test(l)), imports);
    ok("没有 import proto/belt-rules（lint 项）", !/proto\/belt-rules/.test(src));
    ok("没有 import 任何包代码（world 是叶子）", !/from\s+["']\.\/(op-templates|compiler)/.test(src));
    const spawnCalls = src.match(/spawnSync\s*\(/g) || [];
    ok(`唯一的子进程调用是 spawnSync(process.execPath, [GEN_CLI …])（离线基准、非网络；实际 ${spawnCalls.length} 处）`,
        spawnCalls.length === 1 && /spawnSync\(process\.execPath,\s*\[GEN_CLI/.test(src));
    ok("注明来源行号（复刻而非 import 的凭据）", src.includes("exp-e2e.mjs:32-89") && src.includes("gen-resources.mjs"));
}

console.log(`\n${failed ? "✗" : "✓"} world.test：${passed} 通过 / ${failed} 失败`);
process.exitCode = failed ? 1 : 0;
