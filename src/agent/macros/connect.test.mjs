/**
 * connect.test.mjs — `connect` 宏的单测。
 *
 * 运行：node src/agent/macros/connect.test.mjs
 * 退出码：0 全过 / 1 有失败
 *
 * 设计原则（针对本项目的真实事故形态）：
 *   1. **负例必须红**。只证明"正确的能过"是恒等式，证明不了检查器有判断力。
 *      所以每个正例都配一个手工做错的对照组（rv1↔rv2 互换、整链 rotation+180°、
 *      单格 rv 改错），并断言检查器**确实报错**、而且报的是**面闭合**那一类。
 *   2. 判据来自运行时，不是来自实现。闭合口径 `exit(a) === OPP[entry(b)]` 是
 *      在 161 条真实带子上量出来的（146 对相邻，145 对成立），不是从代码反推的。
 *   3. 硬指标跑真实存档（research/ai-plan/live-L4-entities.json，181 实体）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OPP, DIRV, beltEntry, beltExit, beltCode, solveTurn, ORDER } from "../../ai/belt-rules.mjs";
import { validateMacroResult, validateConnectArgs } from "./contract.mjs";
import {
    connect, buildWorld, portsOf, verifyChain, poseChain, legsToCells,
    candidateShapes, solveLegs, solveLegsAll, MAX_TURNS, STRATEGY_DOC,
} from "./connect.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAVE = path.resolve(HERE, "../../../research/ai-plan/live-L4-entities.json");
const SPEC = JSON.parse(fs.readFileSync(path.resolve(HERE, "../../ai/machine-spec.json"), "utf8"));

let pass = 0, fail = 0;
const results = [];
function t(name, fn) {
    try { fn(); pass++; results.push(["ok", name]); }
    catch (e) { fail++; results.push(["FAIL", name, e && e.message ? e.message : String(e)]); }
}
const eq = (a, b, m) => assert.deepEqual(a, b, m === undefined ? `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}` : m);

const world = ents => buildWorld(ents, SPEC);
const sizeOf = (type, variant) => {
    const b = SPEC.buildings[type];
    const v = b && b.variants ? (b.variants[variant] || b.variants.default || Object.values(b.variants)[0]) : null;
    return v && v.size ? v.size : [1, 1];
};
const rectOf = e => {
    const [w, h] = sizeOf(e.type, e.variant);
    return { x0: e.x, y0: e.y, x1: e.x + w - 1, y1: e.y + h - 1 };
};

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 几何权威：belt-rules 的穷举性质（方向逻辑的唯一来源）
 * ══════════════════════════════════════════════════════════════════════════ */

t("belt-rules：12 种 (entry,exit) 组合全部可解，且每种恰好 1 解", () => {
    for (const i of ORDER) for (const o of ORDER) {
        const p = solveTurn(i, o);
        if (i === o) { assert.equal(p, null, `entry===exit 应无解（${i}）`); continue; }
        assert.ok(p, `${i}→${o} 应有解`);
        eq(beltEntry(p.rotationVariant, p.rotation), i, `${i}→${o} entry 回读`);
        eq(beltExit(p.rotationVariant, p.rotation), o, `${i}→${o} exit 回读`);
        let n = 0;
        for (let s = 0; s < 4; s++) for (const rv of [0, 1, 2]) {
            if (beltEntry(rv, s * 90) === i && beltExit(rv, s * 90) === o) n++;
        }
        eq(n, 1, `${i}→${o} 解唯一`);
    }
});

t("belt-rules：180° 掉头（exit === entry）无解 —— 宏不得硬凑", () => {
    for (const i of ORDER) assert.equal(solveTurn(i, i), null);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 闭合口径（本文件最重要的判据）
 *
 * 任务书给的判据是 exit(a) === entry(b)。**实测这条是反的**：
 * 161 条真实带子、146 对相邻里，OPP 口径 145 对成立，直连口径 0 对。
 * 这一节把两个口径都量一遍，让"哪个对"变成可复现的证据而不是口头断言。
 * ══════════════════════════════════════════════════════════════════════════ */

let live = null;
try { live = JSON.parse(fs.readFileSync(SAVE, "utf8")); } catch { live = null; }

t("实测：真实存档的闭合口径是 exit(a) === OPP[entry(b)]（不是 exit===entry）", () => {
    assert.ok(live, "读不到 live-L4-entities.json");
    const belts = live.filter(e => e.type === "belt");
    assert.ok(belts.length >= 150, `带子数 ${belts.length}`);
    const by = new Map(belts.map(e => [`${e.x},${e.y}`, e]));
    let pairs = 0, oppHit = 0, directHit = 0;
    for (const b of belts) {
        const ex = beltExit(b.rotation_variant, b.r);
        const nb = by.get(`${b.x + DIRV[ex][0]},${b.y + DIRV[ex][1]}`);
        if (!nb) continue;
        pairs++;
        const en = beltEntry(nb.rotation_variant, nb.r);
        if (ex === OPP[en]) oppHit++;
        if (ex === en) directHit++;
    }
    assert.ok(pairs >= 140, `相邻对数 ${pairs}`);
    assert.ok(oppHit >= pairs - 1, `OPP 口径 ${oppHit}/${pairs}（唯一例外是 T 型侧向汇入）`);
    eq(directHit, 0, `直连口径必须 0 命中（实得 ${directHit}）—— 任务书那条 armE 断言写反了`);
});

t("实测：footprint 原点 = 左上角（181 实体零重叠）", () => {
    assert.ok(live, "读不到存档");
    const occ = new Map();
    let overlap = 0;
    for (const e of live) {
        const [w, h] = sizeOf(e.type, e.variant);
        for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++) {
            const k = `${e.x + dx},${e.y + dy}`;
            if (occ.has(k)) overlap++;
            occ.set(k, e.uid);
        }
    }
    eq(overlap, 0, "左上角原点下不应有 footprint 重叠");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 几何自洽检查器 verifyChain —— 正例 + 负例
 * ══════════════════════════════════════════════════════════════════════════ */

const L_PATH = () => poseChain(legsToCells([0, 0], [{ dir: "top", steps: 3 }, { dir: "right", steps: 3 }]), "top", "right");

t("verifyChain：正确路径通过（正例基准）", () => {
    const ch = L_PATH();
    assert.ok(ch.ok);
    const v = verifyChain(ch.cells);
    ok_true(v.ok, JSON.stringify(v.breaks));
});

t("verifyChain 负例①：rv1 ↔ rv2 互换（13 个朝向全反的形态）必须红，且报面闭合", () => {
    const ch = L_PATH();
    const swapped = ch.cells.map(c => {
        const rv = c.rotationVariant === 1 ? 2 : c.rotationVariant === 2 ? 1 : 0;
        return { ...c, rotationVariant: rv, code: beltCode(rv) };
    });
    const v = verifyChain(swapped);
    assert.equal(v.ok, false, "必须报红");
    assert.ok(v.breaks.some(b => /断裂/.test(b.why)), `断裂类型应为面闭合，实得 ${JSON.stringify(v.breaks)}`);
});

t("verifyChain 负例②：整链 rotation+180°（方向全反）必须红", () => {
    const ch = L_PATH();
    const flipped = ch.cells.map(c => ({ ...c, rotation: (c.rotation + 180) % 360 }));
    assert.equal(verifyChain(flipped).ok, false);
});

t("verifyChain 负例③：单格 rv 改错必须红（单点错位也要抓）", () => {
    const ch = L_PATH();
    const bad = ch.cells.map((c, i) => i === 2 ? { ...c, rotationVariant: 1, code: 2 } : c);
    assert.equal(verifyChain(bad).ok, false);
});

t("verifyChain 负例④：位置不连续（把某格挪开一格）必须红", () => {
    const ch = L_PATH();
    const moved = ch.cells.map((c, i) => i === 3 ? { ...c, y: c.y - 1 } : c);
    const v = verifyChain(moved);
    assert.equal(v.ok, false);
    assert.ok(v.breaks.some(b => /位置不连续|断裂/.test(b.why)), JSON.stringify(v.breaks));
});

t("verifyChain 负例⑤：code 与 rv 不一致必须红（静默事故的另一形态）", () => {
    const ch = L_PATH();
    const bad = ch.cells.map((c, i) => i === 0 ? { ...c, code: c.code + 1 } : c);
    assert.equal(verifyChain(bad).ok, false);
});

t("verifyChain 负例⑥：空链必须红（不许把什么都没生成当成功）", () => {
    assert.equal(verifyChain([]).ok, false);
});

function ok_true(v, msg) { assert.equal(v, true, msg); }

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 形状枚举：直线 / L / Z 必须都能生成，且都落在目标
 * ══════════════════════════════════════════════════════════════════════════ */

t("直线：四个方向都能生成 6 格直线，且全部候选自洽", () => {
    for (const [d, E] of [["top", [0, -5]], ["bottom", [0, 5]], ["right", [5, 0]], ["left", [-5, 0]]]) {
        const cand = candidateShapes([0, 0], d, E, d);
        const st = cand.filter(c => c.shape === "straight");
        eq(st.length, 1, `${d} 应恰有一条 straight`);
        eq(st[0].cells.length, 6, `${d} 直线格数`);
        eq(st[0].cells[5], E, `${d} 末格`);
        for (const c of cand) {
            const ch = poseChain(c.cells, d, d);
            assert.ok(ch.ok, `${d}/${c.shape} poseChain`);
            assert.ok(verifyChain(ch.cells).ok, `${d}/${c.shape} verifyChain`);
        }
    }
});

t("L 形：六种方向组合都存在，末格落目标，恰好 1 个弯带", () => {
    const cases = [
        ["top", "right", [4, -3]], ["top", "left", [-4, -3]],
        ["bottom", "right", [4, 3]], ["bottom", "left", [-4, 3]],
        ["right", "top", [3, -4]], ["left", "bottom", [-3, 4]],
    ];
    for (const [v0, vE, E] of cases) {
        const cand = candidateShapes([0, 0], v0, E, vE);
        const L = cand.filter(c => c.shape === "L");
        eq(L.length, 1, `${v0}→${vE} 应恰有一条 L`);
        const ch = poseChain(L[0].cells, v0, vE);
        assert.ok(ch.ok);
        assert.ok(verifyChain(ch.cells).ok);
        eq([ch.cells[ch.cells.length - 1].x, ch.cells[ch.cells.length - 1].y], E, `${v0}→${vE} 末格`);
        eq(ch.cells.filter(c => c.rotationVariant !== 0).length, 1, `${v0}→${vE} 弯带数`);
    }
});

t("Z 形：同向错位时必须覆盖全部拐点位置（5 种 top 拆分），且默认首选 Z", () => {
    const cand = candidateShapes([0, 0], "top", [4, -6], "top");
    const Z = cand.filter(c => c.shape === "Z");
    assert.ok(Z.length >= 3, `Z 候选数 ${Z.length}`);
    // 首段 top 步数必须覆盖 1..A-1（拐点可以在任何一行）
    const firsts = new Set(Z.filter(z => z.legs.length === 3 && z.legs[1].dir === "right").map(z => z.legs[0].steps));
    for (let k = 1; k <= 5; k++) assert.ok(firsts.has(k), `缺首段 ${k} 步的 Z（拐点行）`);
    for (const z of Z) {
        const ch = poseChain(z.cells, "top", "top");
        assert.ok(ch.ok && verifyChain(ch.cells).ok, `Z split=${z.split} 自洽`);
        eq([ch.cells[ch.cells.length - 1].x, ch.cells[ch.cells.length - 1].y], [4, -6], `Z split=${z.split} 末格`);
    }
    eq(cand[0].turns, 2, `默认第一条应是 2 转角（实得 ${cand[0].turns}）`);
    eq(cand[0].shape, "Z");
});

t("Z 形选择是确定的：同一输入连跑 20 次，选中同一条（无 RNG）", () => {
    const sig = () => candidateShapes([0, 0], "top", [4, -6], "top").map(c => c.cells.map(p => p.join(",")).join(";")).join("|");
    const first = sig();
    for (let i = 0; i < 20; i++) eq(sig(), first, `第 ${i} 次与首次不同`);
});

t("solveLegsAll：同向腿组内的整数拆分全枚举（绕行的关键能力）", () => {
    // 真实存档需要的那条：miner@(3,-8)→balancer@(8,-9) 的绕行是 right4/bottom1/right1
    const detour = solveLegsAll(["right", "bottom", "right"], [0, 1, 0], [5, 1]);
    assert.ok(detour.length > 1, `应有多解，实得 ${detour.length}`);
    assert.ok(detour.some(s => s[0] === 4 && s[1] === 1 && s[2] === 1), `应含 right4/bottom1/right1，实得 ${JSON.stringify(detour)}`);
    // 每个解都必须真的满足位移，且每条腿不低于下限
    for (const ns of detour) {
        const dx = ["right", "bottom", "right"].reduce((a, d, i) => a + ns[i] * DIRV[d][0], 0);
        const dy = ["right", "bottom", "right"].reduce((a, d, i) => a + ns[i] * DIRV[d][1], 0);
        eq([dx, dy], [5, 1], `解 ${ns} 位移`);
        assert.ok(ns[1] >= 1, `中间腿必须 >=1（${ns}）`);
    }
    // Z 形：a + c = A 的 6 种拆分都要有
    const z = solveLegsAll(["top", "right", "top"], [0, 1, 1], [4, -6]);
    eq(z.length, 6, `Z 的拆分枚举应有 6 种（a=0..5，a=0 即第一格就拐），实得 ${JSON.stringify(z)}`);
});

t("solveLegsAll：确定性 —— 同一输入多次调用给出完全相同的解序列（无 RNG）", () => {
    const sig = () => JSON.stringify(solveLegsAll(["right", "bottom", "right"], [0, 1, 0], [5, 1]));
    const first = sig();
    for (let i = 0; i < 20; i++) eq(sig(), first, `第 ${i} 次与首次不同`);
});

t("solveLegs：单解版本仍可用（取最短解）", () => {
    eq(solveLegs(["right"], [0], [5, 0]), [5]);
    eq(solveLegs(["top"], [0], [0, 5]), null, "只能向上却要向下");
    eq(solveLegs(["top", "right"], [0, 1], [0, -5]), null, "缺少向上以外的腿");
});

t("退化：两端槽位本来就贴在一起 → direct（0 格），不是失败", () => {
    const cand = candidateShapes([0, 0], "top", [0, 0], "top");
    const d = cand.filter(c => c.shape === "direct");
    eq(d.length, 1, "应有 direct 候选");
    eq(d[0].cells.length, 0, "direct 为 0 格");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 集成：真实 machine-spec 端点 → 完整 connect 调用
 * ══════════════════════════════════════════════════════════════════════════ */

t("集成·直线：miner → cutter，5 格，首格贴矿机、末格贴切割机入口", () => {
    const ents = [
        { uid: 1, type: "miner", x: 0, y: 6, r: 0 },
        { uid: 2, type: "cutter", x: 0, y: 0, r: 0 },
    ];
    const r = connect({ from: { uid: 1 }, to: { uid: 2, port: "primary" } }, { entities: ents });
    assert.ok(r.ok, JSON.stringify(r.error));
    eq(r.choice.shape, "straight");
    eq(r.pathLen, 5);
    eq([r.cells[0].x, r.cells[0].y], [0, 5], "首格 = 矿机上方一格");
    eq([r.cells[4].x, r.cells[4].y], [0, 1], "末格 = 切割机入口外一格");
    assert.ok(verifyChain(r.cells).ok);
    eq(r.cells_planned, r.cells_placed, "原子：两数相等");
    eq(r.first_mismatch, null);
});

t("集成·Z 形：miner → 侧向 cutter（两端口都朝上 ⇒ 必须 2 转角），返回值自洽", () => {
    /* 注意：miner 出口朝上、cutter 入口朝下 ⇒ v0=top、vE=top 同向，横移必须靠 Z。
       （想要 1 转角的 L，需要宿端入口朝侧向；本测试用的是 cutter，它的唯一入口在底部。） */
    const ents = [
        { uid: 1, type: "miner", x: 0, y: 6, r: 0 },
        { uid: 2, type: "cutter", x: 5, y: -1, r: 0 },
    ];
    const r = connect({ from: { uid: 1 }, to: { uid: 2, port: "primary" } }, { entities: ents });
    assert.ok(r.ok, JSON.stringify(r.error));
    eq(r.choice.turns, 2, `应选 2 转角（实得 ${r.choice.turns}）`);
    eq(r.choice.shape, "Z");
    eq(r.cells.filter(c => c.rotationVariant !== 0).length, 2, "两个弯带");
    assert.ok(verifyChain(r.cells).ok);
});

t("集成·L 形：宿端入口朝侧向时才出现 1 转角（用 painter 的左入口构造）", () => {
    /* painter(default) 的 shape 入口在局部 left 面；r=0 时世界就是 left ⇒ vE = right。
       miner 在下方朝上喷 ⇒ v0=top。两者垂直 ⇒ L。 */
    const ents = [
        { uid: 1, type: "miner", x: 0, y: 6, r: 0 },
        { uid: 2, type: "painter", x: 5, y: 0, r: 0 },
    ];
    const r = connect({ from: { uid: 1 }, to: { uid: 2, port: "shape" } }, { entities: ents });
    assert.ok(r.ok, JSON.stringify(r.error));
    eq(r.choice.turns, 1, `应选 1 转角（实得 ${r.choice.turns}，shape=${r.choice.shape}）`);
    eq(r.cells.filter(c => c.rotationVariant !== 0).length, 1, "恰好一个弯带");
    assert.ok(verifyChain(r.cells).ok);
});

t("集成·多入口：balancer 双入口 + port:auto ⇒ ambiguous_port（不猜）", () => {
    const ents = [
        { uid: 1, type: "miner", x: 0, y: 8, r: 0 },
        { uid: 2, type: "balancer", x: 0, y: 0, r: 0 },
    ];
    const r = connect({ from: { uid: 1 }, to: { uid: 2 } }, { entities: ents });
    assert.equal(r.ok, false);
    eq(r.error.code, "ambiguous_port");
    assert.ok(Array.isArray(r.error.candidates) && r.error.candidates.length === 2, "应列出候选");
});

t("集成·指定端口：port:\"secondary\" ⇒ 末格对齐 balancer 第二格", () => {
    const ents = [
        { uid: 1, type: "miner", x: 0, y: 8, r: 0 },
        { uid: 2, type: "balancer", x: 0, y: 0, r: 0 },
    ];
    const r = connect({ from: { uid: 1 }, to: { uid: 2, port: "secondary" } }, { entities: ents });
    assert.ok(r.ok, JSON.stringify(r.error));
    eq(r.cells[r.cells.length - 1].x, 1, "secondary 在 x+1");
});

t("集成·hub：{hub:{entry:0}} 精确命中 (-2,-3)，且 entry 索引口径 = hubEntriesWorld", () => {
    const ents = [
        { uid: 1, type: "miner", x: 0, y: 8, r: 0 },
        { uid: 9, type: "hub", x: -2, y: -2, r: 0 },
    ];
    const r = connect({ from: { uid: 1 }, to: { hub: { entry: 0 } } }, { entities: ents });
    assert.ok(r.ok, JSON.stringify(r.error));
    eq([r.cells[r.cells.length - 1].x, r.cells[r.cells.length - 1].y], [-2, -3], "entry=0 应在顶排第 0 格");
    assert.ok(verifyChain(r.cells).ok);
});

t("集成·hub auto：16 入口时走入口分配（不报 ambiguous），并回报选了哪个", () => {
    const ents = [
        { uid: 1, type: "miner", x: 0, y: 8, r: 0 },
        { uid: 9, type: "hub", x: -2, y: -2, r: 0 },
    ];
    const r = connect({ from: { uid: 1 }, to: { hub: {} } }, { entities: ents });
    assert.ok(r.ok, JSON.stringify(r.error));
    assert.ok(r.warnings.some(w => w.code === "hub-entry-chosen"), "应回报 chosen entry");
    assert.ok(Number.isInteger(r.choice.toPort.index));
});

t("撞墙：路径上放一台机器 ⇒ occupied + firstConflict 指向那台机器", () => {
    const ents = [
        { uid: 1, type: "miner", x: 0, y: 8, r: 0 },
        { uid: 2, type: "cutter", x: 0, y: 0, r: 0 },
        { uid: 3, type: "balancer", x: 0, y: 4, r: 0 },
    ];
    const r = connect({ from: { uid: 1 }, to: { uid: 2, port: "primary" } }, { entities: ents });
    if (r.ok) {
        // 允许绕行，但绕行方案必须自洽且不踩那块 footprint
        assert.ok(verifyChain(r.cells).ok);
        assert.ok(!r.cells.some(c => c.y === 4 && (c.x === 0 || c.x === 1)), "不得踩 balancer footprint");
    } else {
        eq(r.error.code, "occupied", `实得 ${r.error.code}: ${r.error.message}`);
        assert.ok(r.firstConflict, "firstConflict 必须非空");
        eq(r.firstConflict.what, "balancer");
        eq(r.firstConflict.uid, 3);
    }
});

t("机器永不可覆盖：allow_replace=true 时撞机器仍是 occupied", () => {
    const ents = [
        { uid: 1, type: "miner", x: 0, y: 8, r: 0 },
        { uid: 2, type: "cutter", x: 0, y: 0, r: 0 },
        { uid: 3, type: "balancer", x: 0, y: 4, r: 0 },
    ];
    const r = connect({ from: { uid: 1 }, to: { uid: 2, port: "primary" }, opts: { allow_replace: true } }, { entities: ents });
    if (!r.ok) eq(r.error.code, "occupied");
    else assert.ok(!r.cells.some(c => c.y === 4 && (c.x === 0 || c.x === 1)));
});

t("allow_replace：路径上的旧带子被允许覆盖，并给出回滚警告", () => {
    /* 三条旧带子挡在矿机与切割机之间。注意：**第一条带子正好贴在矿机出口上**，
       所以默认调用会先命中更早的判据 port_already_bound（源口已被占），
       这比 occupied 更准确 —— connect 不该抢别人的口。allow_replace 管的是"路上"，
       rebind 管的是"口上"，两者是不同的事，必须分开才能对症。 */
    const ents = [
        { uid: 1, type: "miner", x: 0, y: 6, r: 0 },
        { uid: 2, type: "cutter", x: 0, y: 0, r: 0 },
        { uid: 10, type: "belt", x: 0, y: 5, r: 0, rotation_variant: 0 },
        { uid: 11, type: "belt", x: 0, y: 4, r: 0, rotation_variant: 0 },
        { uid: 12, type: "belt", x: 0, y: 3, r: 0, rotation_variant: 0 },
    ];
    const blocked = connect({ from: { uid: 1 }, to: { uid: 2, port: "primary" } }, { entities: ents });
    assert.equal(blocked.ok, false, "默认不许覆盖");
    eq(blocked.error.code, "port_already_bound", "源口已被第一条带子占住，应先报这个");

    const r = connect({ from: { uid: 1 }, to: { uid: 2, port: "primary" }, opts: { allow_replace: true, rebind: true } }, { entities: ents });
    assert.ok(r.ok, JSON.stringify(r.error));
    assert.ok(r.warnings.some(w => w.code === "replacing-belts"), "必须给出删旧带的回滚警告");
    // 回滚警告里要能数出要删几格
    assert.ok(/3 格/.test(r.warnings.find(w => w.code === "replacing-belts").detail), "应报出要覆盖 3 格旧带");
});

t("契约错误码：uid 不存在 / 无 acceptor / 自连 / 裸坐标", () => {
    const ents = [{ uid: 1, type: "miner", x: 0, y: 0, r: 0 }];
    eq(connect({ from: { uid: 99 }, to: { uid: 1 } }, { entities: ents }).error.code, "endpoint_not_found");
    eq(connect({ from: { uid: 1 }, to: { uid: 1 } }, { entities: ents }).error.code, "precondition_failed");
    const two = [{ uid: 1, type: "miner", x: 0, y: 0, r: 0 }, { uid: 2, type: "miner", x: 0, y: 8, r: 0 }];
    eq(connect({ from: { uid: 1 }, to: { uid: 2 } }, { entities: two }).error.code, "endpoint_not_a_port");
    const bare = connect({ from: { x: 1, y: 2 }, to: { uid: 3 } }, { entities: [] });
    assert.ok(!bare.ok, "裸坐标必须在入参层被拒");
    assert.ok(["bad_type", "unknown_field"].includes(bare.error.code), bare.error.code);
    // 顶层裸坐标
    const top = connect({ from: { uid: 1 }, to: { uid: 2 }, x: 3 }, { entities: two });
    assert.ok(!top.ok);
});

t("返回值合契约：每个成功/失败结果都过 validateMacroResult", () => {
    const ents = [
        { uid: 1, type: "miner", x: 0, y: 6, r: 0 },
        { uid: 2, type: "cutter", x: 0, y: 0, r: 0 },
    ];
    for (const r of [
        connect({ from: { uid: 1 }, to: { uid: 2, port: "primary" } }, { entities: ents }),
        connect({ from: { uid: 1 }, to: { uid: 99 } }, { entities: ents }),
    ]) {
        const v = validateMacroResult(r);
        assert.ok(v.ok, `不合契约：${JSON.stringify(v.error || {})}`);
    }
});

t("入参校验统一走 contract.validateConnectArgs（不自造一套）", () => {
    const bad = validateConnectArgs({ from: { uid: 1 }, to: { uid: 2 }, opts: { made_up: 1 } });
    assert.equal(bad.ok, false);
    eq(bad.error.code, "unknown_field");
});

t("两种调用形态等价：connect(args, ctx) 与 connect(from, to, opts, ctx)", () => {
    const ents = [
        { uid: 1, type: "miner", x: 0, y: 6, r: 0 },
        { uid: 2, type: "cutter", x: 0, y: 0, r: 0 },
    ];
    const a = connect({ from: { uid: 1 }, to: { uid: 2, port: "primary" } }, { entities: ents });
    const b = connect({ uid: 1 }, { uid: 2, port: "primary" }, {}, { entities: ents });
    assert.ok(a.ok && b.ok);
    eq(b.cells.map(c => [c.x, c.y, c.rotation, c.rotationVariant]), a.cells.map(c => [c.x, c.y, c.rotation, c.rotationVariant]));
});

t("choice.legs 是权威几何：用它逐格重建 cells 必须完全一致", () => {
    /* 调用方（A6 的 loop / 人工改稿）需要"这条线由哪几段组成"。
       如果 legs 和 cells 对不上，就是两份互相矛盾的真值 —— 正是本项目最怕的那种事故。
       这条断言把两者钉死：legs 走一遍必须一格不差地还原 cells。 */
    const ents = [
        { uid: 1, type: "miner", x: 0, y: 6, r: 0 },
        { uid: 2, type: "painter", x: 5, y: 0, r: 0 },
    ];
    const r = connect({ from: { uid: 1 }, to: { uid: 2, port: "shape" } }, { entities: ents });
    assert.ok(r.ok, JSON.stringify(r.error));
    assert.ok(Array.isArray(r.choice.legs) && r.choice.legs.length >= 2, "应有多段 legs");

    let cur = [r.cells[0].x, r.cells[0].y];
    const rebuilt = [cur];
    for (const l of r.choice.legs) {
        assert.ok(DIRV[l.dir], `legs 里的方向 ${l.dir} 必须是合法方位`);
        for (let i = 0; i < l.steps; i++) {
            cur = [cur[0] + DIRV[l.dir][0], cur[1] + DIRV[l.dir][1]];
            rebuilt.push(cur);
        }
    }
    eq(rebuilt, r.cells.map(c => [c.x, c.y]), "legs 重建的格序列必须等于 cells");
    // split 只是人读标签，legs 的总步数必须与 pathLen-1 相符
    eq(r.choice.legs.reduce((s, l) => s + l.steps, 0), r.pathLen - 1, "legs 总步数 = pathLen-1");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 6. 硬指标：181 实体存档
 * ══════════════════════════════════════════════════════════════════════════ */

/** 从存档里回溯「机器 → 机器」的真实连线（沿带子走），作为"相邻机器"的**事实口径**。 */
function liveLinks(ents) {
    const at = new Map(ents.map(e => [`${e.x},${e.y}`, e]));
    const out = [];
    for (const e of ents) {
        if (e.type === "belt" || e.type === "underground_belt") continue;
        const v = SPEC.buildings[e.type] && Object.values(SPEC.buildings[e.type].variants)[0];
        if (!v) continue;
        for (const s of v.ejectors || []) {
            const d = DIRV[s.dir];
            let cur = at.get(`${e.x + s.tile[0] + d[0]},${e.y + s.tile[1] + d[1]}`);
            let steps = 0;
            while (cur && cur.type === "belt" && steps < 400) {
                const ex = beltExit(cur.rotation_variant, cur.r);
                const nb = at.get(`${cur.x + DIRV[ex][0]},${cur.y + DIRV[ex][1]}`);
                if (!nb) break;
                if (nb.type !== "belt" && nb.type !== "underground_belt") { out.push({ from: e, to: nb, steps: steps + 1 }); break; }
                cur = nb; steps++;
            }
        }
    }
    return out;
}

/** 对一对机器枚举**全部端口组合**，任一能连上就算这对成功。 */
function tryPair(A, B, entities, extraOpts) {
    const w = buildWorld(entities, SPEC);
    const pa = portsOf(w.byUid.get(A.uid), SPEC).eject;
    const pb = portsOf(w.byUid.get(B.uid), SPEC).accept;
    if (!pa.length || !pb.length) return { ok: false, code: "endpoint_not_a_port" };
    const codes = new Set();
    for (const pe of pa) {
        for (const pt of pb) {
            const r = connect({
                from: { uid: A.uid, port: { role: pe.role, index: pe.index } },
                to: B.type === "hub" ? { hub: {} } : { uid: B.uid, port: { role: pt.role, index: pt.index } },
                ...(extraOpts ? { opts: extraOpts } : {}),
            }, { entities, spec: SPEC });
            if (r.ok) return r;
            codes.add(r.error.code);
        }
    }
    return { ok: false, code: [...codes].join("|") };
}

t("硬指标①：真实存档里**实际存在的 7 条机器间连线**，用宏重新连 —— 7/7", () => {
    assert.ok(live, "读不到存档");
    const links = liveLinks(live);
    assert.ok(links.length >= 7, `回溯到的真实连线数 ${links.length}`);
    let good = 0;
    const fails = [];
    for (const L of links) {
        // 真实的带子还在原地 → 必须允许覆盖（否则报 occupied 是**对的**，不是失败）
        const r = tryPair(L.from, L.to, live, { allow_replace: true, rebind: true });
        if (r.ok) good++; else fails.push(`${L.from.type}@${L.from.x},${L.from.y}→${L.to.type}@${L.to.x},${L.to.y}: ${r.code}`);
    }
    eq(good, links.length, `真实连线 ${good}/${links.length}；失败：${fails.join("; ")}`);
});

t("硬指标②：任意两台相邻机器（机器当障碍）× gap≤8，成功率 ≥90%", () => {
    assert.ok(live, "读不到存档");
    const machines = live.filter(e => e.type !== "belt" && e.type !== "underground_belt");
    const machinesOnly = machines.map(m => ({ ...m }));
    const w = buildWorld(machinesOnly, SPEC);

    /**
     * 「相邻」的判据用**footprint 间隙**：两台机器的占地矩形之间的曼哈顿间隙 ≤ LIMIT。
     * 这不依赖带子是否还在（那个在硬指标①里单测），纯粹考宏的几何能力。
     */
    const gap = (a, b) => {
        const A = rectOf(a), B = rectOf(b);
        return Math.max(0, Math.max(A.x0 - B.x1, B.x0 - A.x1))
            + Math.max(0, Math.max(A.y0 - B.y1, B.y0 - A.y1));
    };

    const rows = [];
    for (const LIMIT of [2, 4, 8]) {
        let total = 0, impossible = 0, eligible = 0, good = 0;
        const fails = [];
        for (const A of machinesOnly) for (const B of machinesOnly) {
            if (A.uid === B.uid) continue;
            if (gap(A, B) > LIMIT) continue;
            const pa0 = portsOf(w.byUid.get(A.uid), SPEC).eject;
            const pb0 = portsOf(w.byUid.get(B.uid), SPEC).accept;
            if (!pa0.length || !pb0.length) continue;
            total++;
            /* 「物理上就不可能」是可证的，不是找借口：若 A 的全部 ejector 格 或 B 的全部
               acceptor 格都落在**别的机器**的 footprint 里，那么带子根本没地方站。
               典型：三个 balancer 挨成一排时，中间那台的出口格就是旁边机器的机身。 */
            const freeOfMachines = c => {
                const o = w.cells.get(c.join(","));
                return !o || o.type === "belt";
            };
            if (!pa0.some(pe => freeOfMachines(pe.cell)) || !pb0.some(pt => freeOfMachines(pt.cell))) {
                impossible++;
                continue;
            }
            eligible++;
            const r = tryPair(A, B, machinesOnly);
            if (r.ok) good++;
            else fails.push(`${A.type}@${A.x},${A.y}→${B.type}@${B.x},${B.y}(${r.code})`);
        }
        rows.push({ LIMIT, total, impossible, eligible, good, fails });
    }
    const main = rows.find(r => r.LIMIT === 8);
    const pct = main.eligible ? 100 * main.good / main.eligible : 0;
    assert.ok(main.eligible > 0, "样本为空");
    assert.ok(pct >= 90,
        `gap≤8 成功率 ${main.good}/${main.eligible} = ${pct.toFixed(1)}%（<90%）。`
        + `另有 ${main.impossible} 对物理不可能（端口格被别的机器占住）。失败：${main.fails.join("; ")}`);
    // 更紧的口径与"物理不可能"的分布一并打出来（只作诊断，不参与断言）
    for (const r of rows) {
        console.log(`   · gap≤${r.LIMIT}: 总 ${r.total} 对，物理不可能 ${r.impossible} 对，`
            + `应可连 ${r.eligible} 对 → 成功 ${r.good} = ${(r.eligible ? 100 * r.good / r.eligible : 0).toFixed(1)}%`);
    }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 报告
 * ══════════════════════════════════════════════════════════════════════════ */

const red = s => `\x1b[31m${s}\x1b[0m`, green = s => `\x1b[32m${s}\x1b[0m`;
for (const [st, name, msg] of results) {
    if (st === "ok") console.log(`${green("✓")} ${name}`);
    else console.log(`${red("✗")} ${name}\n    ${red(msg)}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
