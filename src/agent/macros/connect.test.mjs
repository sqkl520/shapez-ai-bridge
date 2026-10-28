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

/* ── 负例⑦：面闭合对、但记录的 (rot,rv) 不是 solveTurn 的唯一解 ──
 *
 * 这一条专门锁 `verifyChain` 里**单格自身复解**那段判据（connect.mjs:601-604）：
 *   `solveTurn(entry, exit)` 必须解出与记录**完全相同**的 (rotation, rotationVariant)。
 *
 * 为什么负例①~③抓不到它：
 *   · ① rv1↔rv2 互换会**改变出口面**，先被面闭合判据截胡（breaks 里没有「单格自身不自洽」）；
 *   · ③ 单格 rv 改成 1 同理（本夹具下该格 exit 从 top 变 left，也是面闭合先报）；
 *   · ② 整链 +180° 改的是 rotation，会让每一格的面**整体**转 180°，同样是面闭合/位置先报。
 * 所以这条判据此前**从未被独立触发**：把 `if (!re || re.rotation !== … || …)` 弱化成 `if (!re)`，
 * 36 条测试全绿（变异报告 C3）。
 *
 * 下面用**手写单格**构造"面看起来闭合、但复解对不上"的三种形态。每格都单独成链（不配对），
 * 这样面闭合/位置连续两条判据根本没有输入可用，只能由单格复解这一段来判。 */
t("verifyChain 负例⑦：单格 (rot,rv) 与 solveTurn 复解不符必须红（面闭合无法兜底）", () => {
    /* 三类"面看起来对、其实解不出来"的格子。`entry`/`exit` 由 beltEntry/beltExit 从
       (rv, rotation) 反算，所以只要重解不唯一/无解，这一段就必须报「单格自身不自洽」。 */
    const probes = [
        /* ① rv=3 不存在（合法 rv 只有 0/1/2）⇒ 面全 undefined，solveTurn 无解。
           这是"静默传入了非法 rv"的形态：面判据看到 undefined===undefined 会放过。 */
        { name: "rv=3（非法变体）", cell: { x: 0, y: 0, rotation: 0, rotationVariant: 3, code: 4 } },
        /* ② rotation 不是 90° 的整数倍 ⇒ 面被量化到最近象限，面看起来"等于" 0° 的格子，
           但 solveTurn 返回的 rotation 是 0，与记录的 30 不符 —— 只有复解能抓到。 */
        { name: "rotation=30（非象限角）", cell: { x: 0, y: 0, rotation: 30, rotationVariant: 1, code: 2 } },
        /* ③ rotation=450 等价于 90，但记录值与 solveTurn 的规范化结果不同。 */
        { name: "rotation=450（等价的非规范写法）", cell: { x: 0, y: 0, rotation: 450, rotationVariant: 1, code: 2 } },
    ];
    for (const p of probes) {
        const v = verifyChain([p.cell]);
        assert.equal(v.ok, false, `${p.name}：单格链必须红，实得 ${JSON.stringify(v)}`);
        assert.ok(v.breaks.some(b => /单格自身不自洽/.test(b.why)),
            `${p.name}：必须由「单格自身不自洽」报红（而不是别的判据），实得 ${JSON.stringify(v.breaks)}`);
    }

    /* 正例对照：同一段代码对**正确**的单格必须放行，否则上一条可能只是"见单格就红"。 */
    for (const rv of [0, 1, 2]) {
        for (let s = 0; s < 4; s++) {
            const rotation = s * 90;
            const cell = { x: 0, y: 0, rotation, rotationVariant: rv, code: beltCode(rv) };
            assert.ok(verifyChain([cell]).ok, `rv=${rv} rotation=${rotation} 是合法单格，不应报红`);
        }
    }
});

t("verifyChain 负例⑧：面闭合 + 位置连续都对，但单格复解不唯一的链必须红", () => {
    /* 这条把负例⑦放回**多格链**里：如果只测单格，有人可能把「单格复解」写成只对长度 1 生效。
       构造方法：先取一条正确的 L 链，再把**中间格**换成一个"面相同、但 (rot,rv) 不是唯一解"的写法。
       面相同的等价写法只有一种（rotation 相差 360° 的整数倍），所以这里用 rotation+360
       —— 面完全相同、位置不变、面闭合全过，只有复解会因为 450 !== 90 报红。 */
    const ch = L_PATH();
    const i = 2;
    const tweaked = ch.cells.map((x, k) => k === i ? { ...x, rotation: x.rotation + 360 } : x);
    const v = verifyChain(tweaked);
    assert.equal(v.ok, false, "rotation+360（面等价、非规范）必须红");
    assert.ok(v.breaks.some(b => b.at === i && /单格自身不自洽/.test(b.why)),
        `必须由第 ${i} 格的「单格自身不自洽」报红，实得 ${JSON.stringify(v.breaks)}`);
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

t("占用检查·负例：rebind 但不给 allow_replace，踩旧带子必须 occupied（不许静默铺上去）", () => {
    /* ★ 这一条专门锁 `checkOccupancy`（connect.mjs:639）本身。★
     *
     * 现有三条"撞墙"用例挡的都是**机器**，走 `fits()` / `noteBlocked` 那条路
     * （connect.mjs:766-774、804-814），根本不经过 `checkOccupancy`。
     * 唯一踩旧带子的用例给了 `allow_replace: true`。
     * 所以把 `checkOccupancy` 的返回整体改成 `{ok:true, firstConflict:null}`，
     * 36 条测试全绿 —— 而实际行为退化成"把 5 格新带子直接铺在 3 条既有带子上并报成功"。
     *
     * 夹具设计（每一步都有理由，改之前先读）：
     *   · 矿机在 (0,6)，出口格 (0,5)；切割机在 (0,0)，入口格 (0,1)。
     *   · 两条旧带子放在 (0,3)、(0,2) —— **不贴矿机出口**，所以不会先命中更早的
     *     port_already_bound（见上一条用例的注释）。
     *   · 两个 balancer 放在 (±1, 1..4)，把两侧堵死，让"绕开旧带子"在 max_cells 内无解；
     *     这样只剩"踩着旧带子走过去"这一条候选 —— 正是要判的那条。
     *     注意用 `variant: "merger"`（1×1）；`default` balancer 是 2×1，右半边会盖到 (0,·) 上，
     *     冲突会先落到"机器"而不是"旧带子"，那条判据就又测不到了。
     *   · `max_cells: 6` 让 7 格以上的绕行方案也出局，夹具因此是**确定性**的。
     *   · rebind:true 是为了让判据落到占用检查，而不是更早的端口占用判据。 */
    const ents = [
        { uid: 1, type: "miner", x: 0, y: 6, r: 0 },
        { uid: 2, type: "cutter", x: 0, y: 0, r: 0 },
        { uid: 10, type: "belt", x: 0, y: 3, r: 0, rotation_variant: 0 },
        { uid: 11, type: "belt", x: 0, y: 2, r: 0, rotation_variant: 0 },
    ];
    let uid = 100;
    for (let y = 1; y <= 4; y++) {
        ents.push({ uid: uid++, type: "balancer", variant: "merger", x: -1, y, r: 0 });
        ents.push({ uid: uid++, type: "balancer", variant: "merger", x: 1, y, r: 0 });
    }

    const r = connect({ from: { uid: 1 }, to: { uid: 2, port: "primary" }, opts: { rebind: true, max_cells: 6 } }, { entities: ents });
    assert.equal(r.ok, false, `踩旧带子且未给 allow_replace ⇒ 必须失败；实得 ok=true, cells=${JSON.stringify(r.cells && r.cells.map(c => [c.x, c.y]))}`);
    eq(r.error.code, "occupied", `错误码必须是 occupied，实得 ${r.error && r.error.code}: ${r.error && r.error.message}`);
    assert.equal(r.cells, null, "失败结果不得带回一条可执行路径（否则调用方会照着铺）");
    assert.equal(r.cells_planned, 0, "失败时 cells_planned 必须为 0");
    eq(r.warnings, [], "失败时不应给任何 replacing-belts 之类的警告");
    // 冲突必须指向**旧带子**，而不是两侧的机器（机器会先被 fits() 拦掉，那就测不到这条判据了）
    assert.ok(r.firstConflict, `firstConflict 必须非空，实得 ${JSON.stringify(r.firstConflict)}`);
    eq(r.firstConflict.what, "belt", `冲突对象必须是 belt，实得 ${r.firstConflict.what}`);
    eq(r.firstConflict.uid, 10, `应指向最靠近源端的旧带子 uid=10，实得 ${r.firstConflict.uid}`);
    eq([r.firstConflict.x, r.firstConflict.y], [0, 3], "冲突格必须是旧带子的格");

    // 正例对照：同一个夹具给 allow_replace 就必须成功，且报告的覆盖格数正好 2
    // （不然上一条可能只是"这个夹具永远失败"）。
    const ok2 = connect({ from: { uid: 1 }, to: { uid: 2, port: "primary" }, opts: { rebind: true, max_cells: 6, allow_replace: true } }, { entities: ents });
    assert.ok(ok2.ok, `allow_replace=true 时必须能铺上去，实得 ${JSON.stringify(ok2.error)}`);
    const warn = ok2.warnings.find(w => w.code === "replacing-belts");
    assert.ok(warn, "allow_replace=true 必须给出 replacing-belts 警告");
    assert.ok(/2 格/.test(warn.detail), `应报出要覆盖 2 格旧带，实得 ${warn.detail}`);
    const covered = ok2.cells.filter(c => (c.x === 0 && c.y === 3) || (c.x === 0 && c.y === 2));
    eq(covered.length, 2, "选中的路径必须真的经过那两格旧带");
    assert.ok(verifyChain(ok2.cells).ok);
});

t("占用检查·自重叠：路径自己踩自己必须 occupied(self-overlap)，不许返回带重复格的 cells", () => {
    /* ★ 这一条专门锁 `checkOccupancy` 的 self-overlap 分支（connect.mjs:644-645）。★
     *
     * 在补这条之前，`grep self-overlap connect.test.mjs` 零命中 —— 整个文件里这条判据
     * 从未被触发过（变异报告 C6：删掉这个分支，36 条全绿）。
     *
     * 为什么普通夹具碰不到它：
     *   `candidateShapes` 的每次 solve 都独立生成一条不自交的折线，但**6 转角枚举**里
     *   存在"走出去再折回来"的几何（例如 t4>l1>b1>r1 会第二次经过同一条竖线的一格）。
     *   正常排序下这些候选永远排在无重复的短路径之后，所以只有**目标贴得极近、
     *   且绕行空间被封死**时它才会被选中。
     *
     * 下面三个夹具是这个形态的三个实例（由穷举 frontier 搜出来的，不是手调）：
     *   miner 喷 top，trash 用某个侧向入口吃 bottom/left/right —— 两端只隔 1-2 格，
     *   任何"无重复"的走法都要超出 6 转角预算，只剩一条自己折回来的。
     * 判据：原实现报 `occupied` + `firstConflict.what === "self-overlap"`；
     * 变异体（删掉该分支）会返回 ok:true 且 cells 里有重复格 —— 正是要拦的事故。 */
    const cases = [
        { name: "miner(-3,-3) → trash(-4,-4) primary#1", m: [-3, -3], t: [-4, -4], port: { role: "primary", index: 1 } },
        { name: "miner(-3,-3) → trash(-2,-4) primary#3", m: [-3, -3], t: [-2, -4], port: { role: "primary", index: 3 } },
        { name: "miner(-3,-2) → trash(-4,-3) primary#1", m: [-3, -2], t: [-4, -3], port: { role: "primary", index: 1 } },
    ];
    for (const c of cases) {
        const ents = [
            { uid: 1, type: "miner", x: c.m[0], y: c.m[1], r: 0 },
            { uid: 2, type: "trash", x: c.t[0], y: c.t[1], r: 0 },
        ];
        const r = connect({ from: { uid: 1 }, to: { uid: 2, port: c.port } }, { entities: ents });
        assert.equal(r.ok, false, `${c.name}：自重叠路径必须被拒，实得 ok=true cells=${JSON.stringify(r.cells && r.cells.map(x => [x.x, x.y]))}`);
        eq(r.error.code, "occupied", `${c.name}：错误码必须是 occupied，实得 ${r.error && r.error.code}`);
        assert.ok(r.firstConflict, `${c.name}：firstConflict 必须非空`);
        eq(r.firstConflict.what, "self-overlap", `${c.name}：冲突类型必须是 self-overlap（不是撞机器/撞带子），实得 ${r.firstConflict.what}`);
        assert.equal(r.cells, null, `${c.name}：拒绝时不得带回路径`);
    }

    /* 正例对照：同一对端点换一个**可达**的入口，必须能连上且路径无重复格 ——
       否则上一条可能只是"这对端点永远连不上"。 */
    const good = connect({ from: { uid: 1 }, to: { uid: 2, port: { role: "primary", index: 0 } } },
        { entities: [
            { uid: 1, type: "miner", x: 0, y: 6, r: 0 },
            { uid: 2, type: "trash", x: 3, y: 0, r: 0 },
        ] });
    if (good.ok) {
        const seen = new Set();
        for (const x of good.cells) {
            const k = `${x.x},${x.y}`;
            assert.ok(!seen.has(k), `成功返回的路径不得有重复格（${k}）`);
            seen.add(k);
        }
    } else {
        /* 该几何在 v1 里可能没有 ≤6 转角的解；只要错误不是 self-overlap 就算这条对照成立。 */
        assert.notEqual(good.error.code, "occupied", `对照夹具不该报 occupied：${good.error && good.error.message}`);
    }
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
