/**
 * loop/handles.test.mjs — 句柄表的自测。
 *
 * 钉住四件事（每条都有负例）：
 *   ① 编号**确定性**：同一份 obs 两次得到同一张表；新实体只会让「排序更靠后」的编号变；
 *   ② `bboxOf` 必须**按 footprint 并集** —— 2×1 的 cutter 要含第二格（用真实 L4 存档验，
 *      这是 `coldstart_l4.test.mjs` 已经实测过的反例）；
 *   ③ `describeEntity` 对 **L5 全部 181 实体**跑一遍，输出**不得**匹配坐标正则；
 *   ④ `version` 必须随「世界变了」而变（`OBS_STALE` 的判据靠它，不能恒等）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    buildHandles, resolveHandle, bboxOf, describeEntity, describeWorld,
    footprintCells, obsHash, prefixOf, HANDLE_PREFIX, HANDLE_RE,
} from "./handles.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAVES = path.resolve(HERE, "../../../test/fixtures/saves");

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
        console.log("✗ " + label + (extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 500) : ""));
    }
}
const eq = (got, want, label) => ok(got === want, label, { got, want });
const jEq = (got, want, label) => ok(JSON.stringify(got) === JSON.stringify(want), label, { got, want });

/* ═══════════ 夹具 ═══════════ */

const read = f => {
    const raw = JSON.parse(fs.readFileSync(path.join(SAVES, f), "utf8"));
    return raw.result || raw;
};
const l4 = read("L4-obs.json");
const l5 = read("L5-obs.json");
const l5items = read("L5-items.json");

ok(l4.entities.length === 181, "L4 夹具 181 实体", l4.entities.length);
ok(l5.entities.length === 181, "L5 夹具 181 实体", l5.entities.length);
ok(l4.goal.requirement.shape === "RuRu----" && l5.goal.requirement.shape === "Cu----Cu",
    "两张夹具目标不同（没拿错存档）", [l4.goal.requirement.shape, l5.goal.requirement.shape]);

/* ═══════════ 1. 编号确定性 ═══════════ */

{
    const a = buildHandles(l5, l5items);
    const b = buildHandles(structuredClone(l5), l5items);
    eq(a.byHandle.size, 181, "每个实体一个句柄");
    eq(a.byUid.size, 181, "byUid 也是 181（uid 无重复）");
    eq(JSON.stringify([...a.byHandle.keys()]), JSON.stringify([...b.byHandle.keys()]),
        "同一份 obs 两次得到同一张表（确定性）");
    eq(a.version, b.version, "version 相同");

    /* 每个句柄都符合文法，且前缀与类型一致 */
    const badPrefix = [...a.byHandle.values()].filter(e => {
        const p = e.handle[0];
        return !HANDLE_RE.test(e.handle) || p !== prefixOf(e.type);
    });
    ok(badPrefix.length === 0, "句柄形态与类型前缀一致", badPrefix.slice(0, 3));

    /* 同类内从 1 递增、无空洞 */
    const groups = new Map();
    for (const e of a.byHandle.values()) {
        const p = e.handle[0];
        const n = Number(e.handle.slice(1));
        if (!groups.has(p)) groups.set(p, []);
        groups.get(p).push(n);
    }
    const gaps = [];
    for (const [p, ns] of groups) {
        ns.sort((x, y) => x - y);
        if (ns[0] !== 1) gaps.push([p, "不是从 1 开始", ns[0]]);
        for (let i = 1; i < ns.length; i++) if (ns[i] !== ns[i - 1] + 1) gaps.push([p, "有空洞", ns[i - 1], ns[i]]);
    }
    ok(gaps.length === 0, "每类句柄从 1 起连续递增（无空洞）", gaps);

    /* 合法前缀集合与实际出现的前缀 */
    const used = [...new Set([...a.byHandle.values()].map(e => e.handle[0]))].sort();
    ok(used.every(p => "HCMBTLX".includes(p)), "只用约定过的前缀 H/C/M/B/T/L/X", used);
    ok(used.includes("X"), "L5 的 constant_signal 落到 X*（兜底前缀真的生效）", used);
    eq(a.hubHandle, "H1", "唯一的 hub 是 H1");
    eq(a.byHandle.get("H1").type, "hub", "H1 真的是 hub");
}

/* ═══════════ 2. 编号规则：先 (y,x) 再类型 ═══════════ */

{
    const t = buildHandles(l5, l5items);
    const sorted = [...t.byHandle.values()].slice();
    /* 按句柄的同类序号顺序取实体，检查 (y,x) 单调不减 —— 这是「先按 (y,x) 排序」的可执行判据 */
    const byPrefix = new Map();
    for (const e of sorted) {
        const p = e.handle[0];
        if (!byPrefix.has(p)) byPrefix.set(p, []);
        byPrefix.get(p).push(e);
    }
    const broken = [];
    for (const [p, list] of byPrefix) {
        list.sort((a, b) => Number(a.handle.slice(1)) - Number(b.handle.slice(1)));
        for (let i = 1; i < list.length; i++) {
            const a = list[i - 1], b = list[i];
            if (b.y < a.y || (b.y === a.y && b.x < a.x)) broken.push([p, a.handle, b.handle]);
        }
    }
    ok(broken.length === 0, "同类句柄严格按 (y,x) 递增编号", broken);
}

/* ═══════════ 3. resolveHandle ═══════════ */

{
    const t = buildHandles(l5, l5items);
    ok(!!resolveHandle(t, "H1"), "H1 可解析");
    eq(resolveHandle(t, "B9999"), null, "负例：不存在的句柄返回 null（不抛）");
    eq(resolveHandle(t, "b7"), null, "负例：小写句柄不认");
    eq(resolveHandle(t, ""), null, "负例：空串返回 null");
    eq(resolveHandle(t, "$ref:B1"), null, "负例：带算子的字符串不是句柄");
    eq(resolveHandle(null, "H1"), null, "负例：没有表时返回 null");
    /* uid ↔ handle 双向一致 */
    const e = resolveHandle(t, "H1");
    eq(t.byUid.get(e.uid), "H1", "byUid 反查回同一句柄");
}

/* ═══════════ 4. footprintCells ═══════════ */

{
    const belt = footprintCells({ type: "belt", x: 10, y: 20 });
    jEq(belt.cells, [[10, 20]], "belt 是 1×1");
    eq(belt.assumed, false, "1×1 的 assumed=false");

    const cut = footprintCells({ type: "cutter", x: 4, y: -13 });
    jEq(cut.cells, [[4, -13], [5, -13]], "cutter 是 2×1（先 y 再 x 的确定序）");

    const trash = footprintCells({ type: "trash", x: 0, y: 0 });
    jEq(trash.cells, [[0, 0]], "trash 1×1");

    const hub = footprintCells({ type: "hub", x: -2, y: -2 });
    eq(hub.cells.length, 16, "hub 4×4 = 16 格");

    const painter = footprintCells({ type: "painter", x: 0, y: 0 });
    eq(painter.cells.length, 2, "painter default 2×1");

    const paintDouble = footprintCells({ type: "painter", variant: "double", x: 0, y: 0 });
    eq(paintDouble.cells.length, 4, "painter double 2×2");

    /* 未知类型按 1×1 保守处理（不是抛、不是 0 格） */
    const unknown = footprintCells({ type: "constant_signal", x: 44, y: -40 });
    jEq(unknown.cells, [[44, -40]], "未知类型保守按 1×1");

    /* 旋转的非方形：不猜位移，标 assumed（诚实边界） */
    const rot = footprintCells({ type: "cutter", x: 4, y: -13, r: 90 });
    eq(rot.assumed, true, "r=90 的非方形 footprint 标 assumed=true（位移未验证）");
    const rotSquare = footprintCells({ type: "hub", x: 0, y: 0, r: 90 });
    eq(rotSquare.assumed, false, "方形的 r=90 不标 assumed");
}

/* ═══════════ 5. bboxOf —— 2×1 必须含第二格（L4 真实存档） ═══════════ */

{
    /* 这条是任务书点名的：用真实 L4 存档验证 cutter 的第二步 */
    const WANT = [10143, 10209, 10149];
    const bbox = bboxOf(WANT, l4);
    jEq(bbox, [4, -14, 5, -13], "$bbox_of(L4 三条带子) = [4,-14,5,-13]");

    const t4 = buildHandles(l4, null);
    const cut = [...t4.byHandle.values()].find(e => e.type === "cutter");
    ok(!!cut, "L4 有 cutter");
    const cb = bboxOf([cut.uid], l4);
    jEq(cb, [-8, -11, -7, -11],
        "cutter(-8,-11) 的 bbox 含第二格 (-7,-11) —— 只看 origin 会得到 [-8,-11,-8,-11]");
    ok(cb[2] === cut.x + 1, "bbox.x1 = origin.x + 1（2×1 的第二格）", { cb, x: cut.x });

    /* 反例：只用 origin 的算法算不出这个结果 —— 断言两者不等 */
    const originOnly = [Math.min(...[cut].map(e => e.x)), Math.min(...[cut].map(e => e.y)),
        Math.max(...[cut].map(e => e.x)), Math.max(...[cut].map(e => e.y))];
    ok(JSON.stringify(originOnly) !== JSON.stringify(cb),
        "负例：只看 origin 的 bbox 与真 bbox 不同（证明 footprint 并集是必要的）", { originOnly, cb });

    /* 句柄形态也支持 */
    const hb = bboxOf([t4.byUid.get(10143), t4.byUid.get(10209), t4.byUid.get(10149)], l4, t4);
    jEq(hb, [4, -14, 5, -13], "$bbox_of 也接受句柄（给 table）");

    /* 单格带子 → 边长 1（v1 T2-03） */
    const one = bboxOf([10209], l4);
    jEq(one, [4, -13, 4, -13], "$bbox_of(单格带子) → 边长 1");

    /* 混合：一条带 + 一台 2×1 机器 → 并集含机器第二格 */
    const mixed = bboxOf([10143, cut.uid], l4);
    jEq(mixed, [-8, -14, 4, -11], "带子 + 2×1 机器的并集同时含两边的 footprint");

    /* 负例：空列表必须抛（返回 [0,0,0,0] 会变成「凭空造一个 region」） */
    let threw = false;
    try { bboxOf([], l4); } catch { threw = true; }
    ok(threw, "负例：$bbox_of([]) 抛错（空集没有包围盒）");

    /* 负例：不存在的 uid 必须抛（不是静默跳过） */
    let threw2 = false;
    try { bboxOf([999999], l4); } catch { threw2 = true; }
    ok(threw2, "负例：$bbox_of(不存在的 uid) 抛错");

    /* 负例：不存在的句柄 */
    let threw3 = false;
    try { bboxOf(["Z9"], l4, t4); } catch { threw3 = true; }
    ok(threw3, "负例：$bbox_of(幻觉句柄) 抛错");
}

/* ═══════════ 6. describeEntity —— 不出现坐标（L5 全部 181 实体） ═══════════ */

{
    const RE = /\(?\s*-?\d+\s*,\s*-?\d+\s*\)?/;
    const leaks = [];
    for (const e of l5.entities) {
        const s = describeEntity(e, l5, l5items);
        if (typeof s !== "string" || !s.length) { leaks.push([e.uid, "空描述"]); continue; }
        if (RE.test(s)) leaks.push([e.uid, e.type, s]);
    }
    /* 这条是任务书点名的判据：输出**不匹配**坐标正则 */
    ok(leaks.length === 0, `describeEntity 对 L5 全部 ${l5.entities.length} 实体无坐标泄漏`, leaks.slice(0, 5));
    eq(181, l5.entities.length, "（确实跑了 181 个实体）");

    /* L4 也要过 —— 两台存档的几何不同 */
    const leaks4 = l4.entities.filter(e => RE.test(describeEntity(e, l4, null)));
    eq(leaks4.length, 0, "describeEntity 对 L4 全部实体也无坐标泄漏");

    /* 负例（反向验证正则**真的能抓**）：故意拼一个含坐标的串 */
    ok(RE.test("B7 belt 上游=(4,-13)"), "负例：坐标正则确实能命中 (4,-13)（不是恒不匹配）");
    ok(RE.test("at 4, -13"), "负例：正则也能命中不带括号的 4, -13");
}

/* ═══════════ 7. describeEntity 的形状（几条点名的样例） ═══════════ */

{
    const t5 = buildHandles(l5, l5items);
    const ent = uid => l5.entities.find(e => e.uid === uid);

    /* 带子：上游/下游/货/段 */
    const beltH = [...t5.byHandle.values()].find(e => e.type === "belt");
    const s = describeEntity(ent(beltH.uid), l5, l5items);
    ok(/^B\d+ belt 上游=/.test(s) && s.includes("下游=") && s.includes("货=") && s.includes("段="),
        `带子短语形如 "B? belt 上游=… 下游=… 货=… 段=…"，实得：${s}`, s);

    /* 机器：输入/输出带方位与 role */
    const cut = l5.entities.find(e => e.type === "cutter" && e.uid === 10036);
    const cs = describeEntity(cut, l5, l5items);
    ok(/^C\d+ cutter 输入=bottom\(←/.test(cs), `cutter 短语含 input 方位，实得：${cs}`, cs);
    ok(/输出=top:left\(→/.test(cs) && /top:right\(→/.test(cs), `cutter 两个输出都列出，实得：${cs}`, cs);

    /* hub：压缩成入口数 + 已接，不能把 16 个入口全列出来（会吃光 S3 预算） */
    const hub = describeEntity(l5.entities.find(e => e.type === "hub"), l5, l5items);
    ok(/^H1 hub 入口=16 已接=\d+/.test(hub), `hub 短语是压缩形态，实得：${hub}`, hub);
    ok(hub.length < 80, `hub 短语不超过 80 字符（实得 ${hub.length}）`);

    /* 未知模板：只说类型 */
    const cs2 = describeEntity(l5.entities.find(e => e.type === "constant_signal"), l5, l5items);
    eq(cs2, "X1 constant_signal", "没有模板的实体只说类型（不猜槽位）");

    /* 上游/下游的 role 细化：cutter 的输入端应指到某个 B（不是「无」） */
    ok(cs.includes("←B"), `cutter 的输入指向一条带子，实得：${cs}`, cs);
}

/* ═══════════ 8. describeWorld（S3 预算规则） ═══════════ */

{
    const w = describeWorld(l5, l5items, { beltsMax: 12 });
    const belts = l5.entities.filter(e => e.type === "belt" || e.type === "underground_belt").length;
    eq(w.listed, 12, "带子只列 12 条（PROMPT_STATE_BELTS_MAX）");
    eq(w.total, belts, "total 是被截断前的真实带子数");
    eq(w.truncated, true, "截断了就要自曝（truncated=true）");
    ok(w.lines.length > 12, "机器全列 + 12 条带子", w.lines.length);

    /* focus 优先：点名的带子必须在场 */
    const t = buildHandles(l5, l5items);
    const focusHandle = [...t.byHandle.values()].filter(e => e.type === "belt").slice(-1)[0].handle;
    const w2 = describeWorld(l5, l5items, { beltsMax: 3, focus: [focusHandle] });
    ok(w2.lines.some(l => l.startsWith(focusHandle + " ")),
        `focus 里的带子 ${focusHandle} 即使排序靠后也被列出`, w2.lines.filter(l => l.startsWith("B")).slice(0, 5));
}

/* ═══════════ 9. obsHash / version 必须随世界而变 ═══════════ */

{
    const a = buildHandles(l5, l5items);
    /* 用 L5 自己的带子（10209 是 **L4** 的 uid，L5 里不存在 —— 拿错存档的典型形态） */
    const victimUid = l5.entities.find(x => x.type === "belt").uid;
    const moved = structuredClone(l5);
    const victim = moved.entities.find(e => e.uid === victimUid);
    victim.x += 1;
    const b = buildHandles(moved, l5items);
    ok(a.obsHash !== b.obsHash, "坐标变了 → obs_hash 变了");
    ok(a.version !== b.version, "坐标变了 → version 变了（OBS_STALE 才有判据）");

    const ticked = structuredClone(l5);
    ticked.tick += 1;
    const c = buildHandles(ticked, l5items);
    eq(c.obsHash, a.obsHash, "只变 tick → obs_hash 不变（tick 不是世界内容）");
    ok(c.version !== a.version, "但 version 变了（version 含 tick）");

    const removed = { ...l5, entities: l5.entities.filter(e => e.uid !== victimUid) };
    ok(obsHash(removed) !== obsHash(l5), "删掉一个实体 → obs_hash 变了");

    /* 顺序无关：obs.entities 的数组顺序不是世界内容 */
    const shuffled = { ...l5, entities: [...l5.entities].reverse() };
    eq(obsHash(shuffled), obsHash(l5), "obs.entities 顺序不同但内容相同 → obs_hash 相同");

    /* 负例：什么都不改 → hash 不变（否则每次读都是 OBS_STALE） */
    eq(obsHash(l5), obsHash(structuredClone(l5)), "同一份世界两次 hash 相同");
}

/* ═══════════ 10. 常量表 ═══════════ */

{
    ok(Object.isFrozen(HANDLE_PREFIX), "HANDLE_PREFIX 是冻结的");
    for (const t of ["cutter", "painter", "mixer", "stacker", "rotater"]) {
        eq(HANDLE_PREFIX[t], "C", `${t} → C 前缀`);
    }
    eq(prefixOf("belt"), "B", "belt → B");
    eq(prefixOf("underground_belt"), "B", "underground_belt 也是 B");
    eq(prefixOf("miner"), "M", "miner → M");
    eq(prefixOf("trash"), "T", "trash → T");
    eq(prefixOf("balancer"), "L", "balancer → L");
    eq(prefixOf("hub"), "H", "hub → H");
    eq(prefixOf("constant_signal"), "X", "未知类型 → X");
}

/* ═══════════ 11. 每个 entry 都带 desc（prompt.mjs 只读 handle/type/variant/desc） ═══════════ */

{
    const t = buildHandles(l5, l5items);
    const missing = [...t.byHandle.values()].filter(e => typeof e.desc !== "string" || !e.desc.length);
    eq(missing.length, 0, "每个句柄条目都有非空 desc（prompt 的 S3 段依赖它）", missing.map(e => e.handle));

    /* 正例：desc 与 describeEntity 的输出**一致**（同一份实现，不是两套） */
    const e = l5.entities.find(x => x.type === "cutter");
    eq(t.byHandle.get(t.byUid.get(e.uid)).desc, describeEntity(e, l5, l5items),
        "entry.desc === describeEntity(...)（同源，不是第二份几何真值）");

    /* desc 也不许有坐标 */
    const RE = /\(?\s*-?\d+\s*,\s*-?\d+\s*\)?/;
    eq([...t.byHandle.values()].filter(x => RE.test(x.desc)).length, 0, "desc 全部无坐标");

    /* items 缺失时 desc 仍然有（只是货量/段长的口径变成默认值） */
    const noItems = buildHandles(l5, null);
    ok([...noItems.byHandle.values()].every(x => typeof x.desc === "string" && x.desc.length > 0),
        "没有 items 时 desc 仍然生成（降级而不是缺失）");
}

/* ═══════════ 12. 性能护栏（不许退化成 O(n² 重建)） ═══════════

 * 这些函数每轮都会被调用（181 实体 × 每轮多次），所以每次 buildHandles 必须是毫秒级。
 * 曾经写过两个 O(n²)：① pathIndex 每个实体重建一次；② slotRoleAt 为拿 variant 扫全表。
 * 实测把 18ms 降到 5ms。护栏给 30ms —— 比现状宽松 6 倍，但能抓住「又写回 O(n²)」那种退化。 */

{
    const N = 10;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) buildHandles(l5, l5items);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
    ok(ms < 30, `buildHandles 平均耗时 ${ms.toFixed(1)}ms < 30ms（181 实体，含 desc）`, ms);
    eq(buildHandles(l5, l5items).byHandle.size, 181, "（性能用例之后结果仍然正确）");
}

/* ═══════════ 汇总 ═══════════ */

console.log(`\nhandles 自测：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log("失败项："); for (const f of failures) console.log("  ✗ " + f); }
process.exit(fail ? 1 : 0);
