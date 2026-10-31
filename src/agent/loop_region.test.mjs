/**
 * loop_region.test.mjs — 复现/锁死「loop 的 debug_items 必须带合法 region」。
 *
 * ## 这个文件存在的原因
 *
 * 真 mod 的 `debugItems(params)` 第一件事就是校验 region：
 *
 *   src/mod/shapez-ai-bridge.js:903-908
 *     debugItems(params) {
 *         const root = this.requireRoot();
 *         const region = params.region;
 *         if (!Array.isArray(region) || region.length !== 4) {
 *             throw this.rpcError(2001, "invalid_action", "region must be [x0,y0,x1,y1]");
 *         }
 *
 * 而 `loop.mjs` 的 `observeOnce` 曾经传 `{}` ⇒ 真桥上**每次** observe 都抛 2001 ⇒
 * `items` 恒 null ⇒ `ITEMS_UNAVAILABLE` ⇒ `checkFlow` 的 `paths=null` ⇒
 * `L3-flow` 永久 `undecidable` ⇒ `strictVerdict` 第 4 条判红 ⇒ `outcome` 永不为 `success`。
 *
 * `FakeGame.debugItems` 接受 `{}`（假世界不需要 region，这不是 bug），所以
 * 既有 2000+ 条离线测试**结构上**发现不了它。本文件用一个「和真 mod 一样严格」的
 * reader 把这条约束钉死。
 *
 * ## 断言分两层
 *
 *   ① 结构层：loop 每次调 `debug_items` 时收到的 region 都必须是长度 4 的整数数组
 *      （非法就抛 2001，与 mod 同一句话）；
 *   ② 行为层：正常路径下 transcript / handler 里**不得**出现 `ITEMS_UNAVAILABLE`，
 *      且 `buildHandles` 拿到的 items 不是 null（否则「货=」列全是假的 0）。
 *
 * 用法：node src/agent/loop_region.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runLoop, readTranscript, debugItemsRegion } from "./loop.mjs";
import { LLMClient } from "./loop/llm.mjs";
import FakeGame from "./fake_game.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const L4 = path.join(REPO, "test/fixtures/saves/L4-obs.json");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra) {
    if (cond && typeof cond.then === "function") {
        fail++; failures.push(label + " [Promise 当布尔]");
        console.log("✗ " + label + "  [cond 是 Promise，漏了 await？]");
        return;
    }
    if (cond) { pass++; console.log("✓ " + label); }
    else {
        fail++; failures.push(label);
        console.log("✗ " + label + (extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 600) : ""));
    }
}
const eq = (got, want, label) => ok(got === want, label, { got, want });

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "loopregion-"));
const cleanup = d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } };

/** L4 的 FakeGame（每次新建，避免用例间串味）。 */
const l4Game = () => FakeGame.fromFiles(L4, null, { goal: "RuRu----" });

/** 与 loop.test.mjs 同一条计划（句柄来自 handles.mjs 的确定性编号）。 */
const L4_PLAN = JSON.stringify({
    say: "swap the run for a cutter and a trash",
    calls: [{
        macro: "replace_run",
        args: {
            region: { $bbox_of: ["B81", "B82", "B69"] },
            building: ["cutter", { kind: "trash", port: "left", confirm_waste: true }],
        },
        why: "that run is only belts and forms a rectangle",
    }],
});

/** 一个按调用次数返回固定文本的客户端。 */
class ScriptedClient extends LLMClient {
    constructor(texts) { super(); this.texts = texts.slice(); this.calls = 0; }
    async propose() {
        const t = this.texts[Math.min(this.calls, this.texts.length - 1)];
        this.calls++;
        return { text: typeof t === "string" ? t : JSON.stringify(t), usage: null, raw: null };
    }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 严格 reader：debug_items 与真 mod 一样校验 region
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * FakeGame + 「真 mod 的 region 校验」。
 *
 * 为什么不是直接改 FakeGame：`FakeGame.debugItems(p = {})` 接受 `{}` 是**正确**的
 * （假世界没有 region 的概念，`fake_game.mjs` 的注释写明它与 mod 的唯一差异就是
 * 「paths 不按 region 过滤」）。把校验加进 FakeGame 会让既有的 2000+ 条离线测试
 * 全部改用「必须带 region」的假世界，从而丢掉「FakeGame 与 mod 在这一点上不同」
 * 这个**已知且有意**的事实。所以校验只在本测试的 reader 里加。
 *
 * @param {FakeGame} game
 * @returns {{reader:object, calls:Array}}
 */
function strictRegionReader(game) {
    const base = game.reader();
    const calls = [];
    const reader = {
        ...base,
        async debugItems(p) {
            const region = p && p.region;
            calls.push(region);
            /* 这一句与 mod 的 `shapez-ai-bridge.js:903-908` 逐字同义。 */
            if (!Array.isArray(region) || region.length !== 4) {
                throw Object.assign(
                    new Error("debug_items: region must be [x0,y0,x1,y1]"),
                    { code: 2001 },
                );
            }
            if (!region.every(v => typeof v === "number" && Number.isFinite(v))) {
                throw Object.assign(
                    new Error("debug_items: region must be [x0,y0,x1,y1]"),
                    { code: 2001 },
                );
            }
            return base.debugItems(p);
        },
    };
    return { reader, calls };
}

const transcriptOf = res => readTranscript(res.transcript_path);
const allCodes = rows => {
    const out = [];
    for (const r of rows) {
        if (r.kind === "observe" && Array.isArray(r.data && r.data.problems)) out.push(...r.data.problems);
        if (r.kind === "diagnose" && Array.isArray(r.data && r.data.codes)) out.push(...r.data.codes);
    }
    return out;
};

/* ══════════════════════════════════════════════════════════════════════════
 * 0. 纯函数：debugItemsRegion 的口径
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 0. debugItemsRegion（region 从 obs 实体 bbox 来，外扩 6）──");
{
    const g = l4Game();
    const r = debugItemsRegion(g.obs);
    const xs = g.obs.entities.map(e => e.x), ys = g.obs.entities.map(e => e.y);
    eq(JSON.stringify(r), JSON.stringify([
        Math.min(...xs) - 6, Math.min(...ys) - 6, Math.max(...xs) + 6, Math.max(...ys) + 6,
    ]), "region = 实体 origin 的 bbox 外扩 6（pad 与 verify_runtime 同口径）", r);
    ok(r.every(v => Number.isInteger(v)), "region 四个分量都是整数（mod 只要求数字，整数更稳）", r);

    /* 兜底：没有实体时用 obs.region；再没有就给 [0,0,0,0]（合法的最小矩形，不抛）。 */
    eq(JSON.stringify(debugItemsRegion({ entities: [] })), "[0,0,0,0]",
        "空世界 → [0,0,0,0]（合法值，不是 undefined —— 缺 region 才是 2001）");
    eq(JSON.stringify(debugItemsRegion({ entities: [], region: [1, 2, 3, 4] })), "[1,2,3,4]",
        "空实体但有 obs.region → 用 obs.region");
    eq(JSON.stringify(debugItemsRegion(null)), "[0,0,0,0]", "obs=null 也返回合法数组（不抛）");
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 结构层：每次 debug_items 都必须带长度 4 的数字 region
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 1. loop 调 debug_items 必须带合法 region（与 mod 的校验一致）──");
{
    const dir = tmpRoot();
    const g = l4Game();
    const { reader, calls } = strictRegionReader(g);
    const res = await runLoop({
        reader, goal: "RuRu----",
        llmClient: new ScriptedClient([L4_PLAN]),
        mode: "mock", runDir: dir, game: g,
    });

    ok(calls.length > 0, "loop 至少调用了一次 debug_items", calls.length);
    const bad = calls.filter(r => !Array.isArray(r) || r.length !== 4
        || !r.every(v => typeof v === "number" && Number.isFinite(v)));
    eq(bad.length, 0,
        "★ 每一次 debug_items 的 region 都是长度 4 的数字数组（缺 region 就是真桥 2001）", bad);

    const rows = transcriptOf(res);
    const codes = allCodes(rows);
    ok(!codes.includes("ITEMS_UNAVAILABLE"),
        "★ 正常路径下 transcript 里不得出现 ITEMS_UNAVAILABLE（它意味着 items=null，"
        + "L3 永久 undecidable、outcome 永不为 success）", codes);
    ok(res.outcome !== "error", "outcome 不是 error（reader 没抛）", res.outcome);
    cleanup(dir);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 行为层：items 真的被读到了（不是 null）—— 由 observe 行里的 paths 数证明
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 2. items 非 null：observe 行必须给出 paths 计数 ──");
{
    const dir = tmpRoot();
    const g = l4Game();
    const { reader } = strictRegionReader(g);
    const res = await runLoop({
        reader, goal: "RuRu----",
        llmClient: new ScriptedClient([L4_PLAN]),
        mode: "mock", runDir: dir, game: g,
    });
    const ob = transcriptOf(res).find(r => r.kind === "observe");
    ok(!!ob, "有 observe 行");
    ok(ob && ob.data.paths !== null && ob.data.paths !== undefined,
        "★ observe.paths 不是 null —— items=null 时 loop 只能记 null（真桥的表现）",
        ob && ob.data.paths);
    cleanup(dir);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 反例对照：region 非法时**确实**会走 ITEMS_UNAVAILABLE
 *
 * 这条不是测 loop 的 bug，是测本文件的夹具**真的能抓到它** ——
 * 否则第 1 条断言可能只是因为 strictRegionReader 没接上而「碰巧通过」。
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n── 3. 反例对照：把 region 强制抹成 {} 必须产生 ITEMS_UNAVAILABLE ──");
{
    const dir = tmpRoot();
    const g = l4Game();
    const { reader } = strictRegionReader(g);
    /* 拦截 debug_items 的入参，把 region 抹掉 —— 模拟修复前的 loop.mjs:377。
       这不是「注入 bug」，是证明本文件的 strict reader 与诊断链路真的连在一起。 */
    const broken = {
        ...reader,
        debugItems: async (p) => reader.debugItems({ ...(p || {}), region: undefined }),
    };
    const res = await runLoop({
        reader: broken, goal: "RuRu----",
        llmClient: new ScriptedClient([L4_PLAN]),
        mode: "mock", runDir: dir, game: g,
    });
    const codes = allCodes(transcriptOf(res));
    ok(codes.includes("ITEMS_UNAVAILABLE"),
        "★ 反例对照：缺 region ⇒ 真桥 2001 ⇒ ITEMS_UNAVAILABLE（证明夹具抓得到）", codes);
    cleanup(dir);
}

console.log(`\nloop region 自测：${pass} 通过 / ${fail} 失败`);
if (fail) {
    console.log("失败项：");
    for (const f of failures) console.log("  ✗ " + f);
    process.exitCode = 1;
}
