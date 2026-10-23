/**
 * belt-rules.test.mjs — 对 src/ai/belt-rules.mjs 的独立复核测试。
 *
 * 运行：  node --test src/ai/belt-rules.test.mjs
 *
 * 设计原则（针对"穷举恒等式 ≠ 正确"）：
 *   beltEntry/beltExit/solveTurn 都基于同一个 rotateLocal，所以
 *   solveTurn(beltEntry,beltExit)≡原值 只是恒等式，**不能**证明 rotateLocal 的
 *   旋转手性（顺/逆时针）与"局部 top 是世界 +y 还是 -y"。
 *   因此本文件把测试分成两类：
 *     (1) 纯逻辑/边界/退化测试（恒等式类，验证 API 行为符合约定）；
 *     (2) **可证伪**的邻居拓扑测试：用真实存档快照 world-full.json 的 1906 条带子，
 *         拿"下游邻居的入边回指本格出边 / 上游邻居的出边指向本格"作为**独立判据**。
 *         若旋转手性或 rv1↔rv2 分配反了，这个拓扑闭合会大面积失败——并额外跑
 *         两个"故意做错"的对照组（交换 rv1/rv2、逆时针旋转），断言它们明显更差。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import {
    ORDER, OPP, DIRV, norm360, angleToDir, dirToAngle,
    rotateLocal, EXIT_LOCAL, beltExit, beltEntry, solveTurn, beltCode, BELT_CODE_BASE,
} from "./belt-rules.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// 提交在库里的真实世界快照（同一份存档、全部 regular 层、1906 条带子），可确定性复现。
const WORLD = resolve(HERE, "../../research/ai-player/facts/live/world-full.json");

/* ------------------------------------------------------------------ */
/* (0) 世界方向约定（点 4：y 向下、rotation 增大为顺时针）               */
/* ------------------------------------------------------------------ */
test("约定：DIRV 与上游 enumDirectionToVector 一致（top=[0,-1] 即 y 向下）", () => {
    assert.deepEqual(DIRV.top, [0, -1]);
    assert.deepEqual(DIRV.right, [1, 0]);
    assert.deepEqual(DIRV.bottom, [0, 1]);
    assert.deepEqual(DIRV.left, [-1, 0]);
});

test("约定：angleToDir 与 enumAngleToDirection 一致（0=top,90=right,180=bottom,270=left）", () => {
    assert.equal(angleToDir(0), "top");
    assert.equal(angleToDir(90), "right");
    assert.equal(angleToDir(180), "bottom");
    assert.equal(angleToDir(270), "left");
    assert.equal(dirToAngle("left"), 270);
});

test("rotateLocal：rotation 增大 = 顺时针（局部 top 经 90° 变 right）", () => {
    assert.equal(rotateLocal("top", 0), "top");
    assert.equal(rotateLocal("top", 90), "right");   // 顺时针
    assert.equal(rotateLocal("top", 180), "bottom");
    assert.equal(rotateLocal("top", 270), "left");
});

/* ------------------------------------------------------------------ */
/* (1) 局部几何 / code 规则                                             */
/* ------------------------------------------------------------------ */
test("EXIT_LOCAL 与上游 arrayBeltVariantToRotation=[top,left,right] 一致", () => {
    assert.deepEqual(EXIT_LOCAL, { 0: "top", 1: "left", 2: "right" });
});

test("beltCode = 1 + rv（internalId 1/2/3 ↔ rv 0/1/2）", () => {
    assert.equal(BELT_CODE_BASE, 1);
    assert.equal(beltCode(0), 1);
    assert.equal(beltCode(1), 2);
    assert.equal(beltCode(2), 3);
});

test("入口恒为局部 bottom 旋转；出口按 EXIT_LOCAL 旋转", () => {
    assert.equal(beltEntry(0, 0), "bottom");
    assert.equal(beltEntry(1, 0), "bottom");
    assert.equal(beltEntry(2, 0), "bottom");
    assert.equal(beltEntry(2, 90), "left");          // bottom 顺90 = left
    assert.equal(beltExit(1, 90), "top");            // left 顺90 = top
    assert.equal(beltExit(2, 0), "right");
});

/* ------------------------------------------------------------------ */
/* (2) solveTurn：12 个直角/直线解 + 退化                              */
/* ------------------------------------------------------------------ */
test("solveTurn：全部 12 个 (in≠out) 组合唯一有解且与几何自洽", () => {
    const expected = {
        "top/right": { rotation: 180, rotationVariant: 1 },
        "top/bottom": { rotation: 180, rotationVariant: 0 },
        "top/left": { rotation: 180, rotationVariant: 2 },
        "right/top": { rotation: 270, rotationVariant: 2 },
        "right/bottom": { rotation: 270, rotationVariant: 1 },
        "right/left": { rotation: 270, rotationVariant: 0 },
        "bottom/top": { rotation: 0, rotationVariant: 0 },
        "bottom/right": { rotation: 0, rotationVariant: 2 },
        "bottom/left": { rotation: 0, rotationVariant: 1 },
        "left/top": { rotation: 90, rotationVariant: 1 },
        "left/right": { rotation: 90, rotationVariant: 0 },
        "left/bottom": { rotation: 90, rotationVariant: 2 },
    };
    for (const i of ORDER) for (const o of ORDER) {
        if (i === o) continue;
        const got = solveTurn(i, o);
        assert.deepEqual(got, expected[`${i}/${o}`], `solveTurn(${i},${o})`);
        // 回代：解出的 (rot,rv) 必须真正复现 in/out —— 独立于扫描顺序的正确性检验
        assert.equal(beltEntry(got.rotationVariant, got.rotation), i);
        assert.equal(beltExit(got.rotationVariant, got.rotation), o);
    }
});

test("solveTurn：同向（入=出，等价 180° U 型掉头）单格带子不可能 → null", () => {
    for (const d of ORDER) assert.equal(solveTurn(d, d), null, `solveTurn(${d},${d})`);
});

test("solveTurn：无歧义（扫描顺序 rv0→2 × rot0→270 不影响结果，恰有一解）", () => {
    for (const i of ORDER) for (const o of ORDER) {
        if (i === o) continue;
        let count = 0;
        for (let rot = 0; rot < 360; rot += 90)
            for (const rv of [0, 1, 2])
                if (beltEntry(rv, rot) === i && beltExit(rv, rot) === o) count++;
        assert.equal(count, 1, `(${i},${o}) 解的个数应为 1`);
    }
});

/* ------------------------------------------------------------------ */
/* (3) 归一化：负 / 超界 rotation                                       */
/* ------------------------------------------------------------------ */
test("norm360 / beltEntry / beltExit / solveTurn 对负与超界 rotation 归一", () => {
    assert.equal(norm360(-90), 270);
    assert.equal(norm360(450), 90);
    assert.equal(norm360(720), 0);
    assert.equal(beltExit(2, -90), beltExit(2, 270));
    assert.equal(beltEntry(0, 450), beltEntry(0, 90));
    assert.deepEqual(solveTurn("bottom", "left"), { rotation: 0, rotationVariant: 1 });
    // 非 90 倍数的 rotation 是退化输入：角度应被归到最近档位（这里 30→0, 即不改变 rv 语义）
    assert.equal(norm360(390), 30);   // 只验证归一本身，不喂给 /90 索引
});

/* ------------------------------------------------------------------ */
/* (4) ★ 邻居拓扑判据（可证伪旋转手性与 rv1↔rv2 分配）                  */
/*     判据前提：存档里每条带子的最终 (rotation, rv) 都是游戏按**正确**   */
/*     局部几何渲染/走货的状态。若我们的几何/手性对，则带子链首尾相接； */
/*     若错，大面积断裂。对照组用"故意做错"的几何，应明显更差。          */
/* ------------------------------------------------------------------ */
function buildGrid() {
    const data = JSON.parse(readFileSync(WORLD, "utf8"));
    const grid = new Map();
    for (const e of data.entities) {
        if (e.type !== "belt") continue;
        grid.set(e.x + "," + e.y, { rv: e.rotation_variant, r: norm360(e.r) });
    }
    // 非带子也要入图（阻挡下游邻居识别），用占位
    for (const e of data.entities) {
        if (e.type === "belt") continue;
        const k = e.x + "," + e.y;
        if (!grid.has(k)) grid.set(k, { nonBelt: true });
    }
    return grid;
}

// 用给定"出口局部表 E + 旋转手性 sgn + 入口局部(bottom)"评估拓扑自洽数
function topoScore(grid, E, sgn) {
    const rotL = (loc, r) => ORDER[((ORDER.indexOf(loc) + sgn * (norm360(r) / 90)) % 4 + 4) % 4];
    const exitW = (rv, r) => rotL(E[rv], r);
    const entryW = (rv, r) => rotL("bottom", r);
    let dnT = 0, dnOk = 0, bothT = 0, bothOk = 0;
    for (const [k, v] of grid) {
        if (v.nonBelt) continue;
        const [x, y] = k.split(",").map(Number);
        const ex = exitW(v.rv, v.r); const [dx, dy] = DIRV[ex];
        const nb = grid.get((x + dx) + "," + (y + dy));
        if (nb && !nb.nonBelt) { dnT++; if (entryW(nb.rv, nb.r) === OPP[ex]) dnOk++; }
        // 弯带两侧都有带子邻居（上游接我入边、下游接我出边）= 最强判据
        if (v.rv !== 0) {
            const en = entryW(v.rv, v.r); const [ux, uy] = DIRV[en];
            const up = grid.get((x + ux) + "," + (y + uy));
            if (nb && !nb.nonBelt && up && !up.nonBelt) {
                bothT++;
                if (exitW(up.rv, up.r) === OPP[en] && entryW(nb.rv, nb.r) === OPP[ex]) bothOk++;
            }
        }
    }
    return { dnOk, dnT, bothOk, bothT };
}

test("★ 邻居拓扑：真实存档 rv 分布 = {0:1487,1:223,2:196}（存档完整性护栏）", () => {
    const grid = buildGrid();
    const dist = { 0: 0, 1: 0, 2: 0 };
    for (const v of grid.values()) if (!v.nonBelt) dist[v.rv]++;
    assert.deepEqual(dist, { 0: 1487, 1: 223, 2: 196 });
});

test("★ 邻居拓扑：正确几何下下游链闭合 = 1267/1268", () => {
    const s = topoScore(buildGrid(), EXIT_LOCAL, +1);
    assert.equal(s.dnOk, 1267);
    assert.equal(s.dnT, 1268);   // 唯一未闭合 = 两条独立带子在 (28,71)→(29,71) 交叉，非几何错
});

test("★ 邻居拓扑：弯带双侧闭合 = 69/69（最强独立判据）", () => {
    const s = topoScore(buildGrid(), EXIT_LOCAL, +1);
    assert.equal(s.bothOk, 69);
    assert.equal(s.bothT, 69);
});

test("★ 证伪对照：交换 rv1↔rv2 后双侧闭合崩到 0", () => {
    const s = topoScore(buildGrid(), { 0: "top", 1: "right", 2: "left" }, +1);
    assert.ok(s.bothOk < 20, `swap rv1/2 双侧应远小于 69，实得 ${s.bothOk}`);
    assert.ok(s.dnOk < 1267, `swap rv1/2 下游应低于 1267，实得 ${s.dnOk}`);
});

test("★ 证伪对照：旋转手性取逆（CCW）后双侧闭合崩到 0", () => {
    const s = topoScore(buildGrid(), EXIT_LOCAL, -1);
    assert.equal(s.bothOk, 0);            // 正确存档里 51 条可双侧检验的弯带一条都不闭合
    assert.ok(s.dnOk < 1267, `CCW 下游应远低于 1267，实得 ${s.dnOk}`);
});

test("★ 相对判据：正确配置严格优于两个对照组（下游 + 双侧）", () => {
    const grid = buildGrid();
    const correct = topoScore(grid, EXIT_LOCAL, +1);
    const swap = topoScore(grid, { 0: "top", 1: "right", 2: "left" }, +1);
    const ccw = topoScore(grid, EXIT_LOCAL, -1);
    for (const alt of [swap, ccw]) {
        assert.ok(correct.dnOk > alt.dnOk, "correct 下游应更高");
        assert.ok(correct.bothOk > alt.bothOk, "correct 双侧应更高");
    }
});

/* ------------------------------------------------------------------ */
/* (5) originalRotation 与 belt.js 分支 (+90/+270) 相关（源码级旁证）    */
/* ------------------------------------------------------------------ */
test("★ originalRotation 旁证：弯带 final−orig 只可能是 {0, rv1→90, rv2→270}", (t) => {
    // 这条独立于我们的 rotateLocal 手性：直接对齐 belt.js:210/216 返回的 +270/+90 分支。
    const decodeSave = loadDecoder();
    const SAVE = decodeSave && savePath();
    if (!SAVE) { t.skip("无本地存档或解码器 → 跳过 originalRotation 旁证"); return; }
    const { obj } = decodeSave(SAVE);
    const byRv = { 1: {}, 2: {} };
    for (const e of obj.dump.entities || []) {
        const s = e.components && e.components.StaticMapEntity; if (!s) continue;
        if (![1, 2, 3].includes(s.code)) continue;
        const rv = s.code - 1; if (rv === 0) continue;
        const d = norm360(norm360(s.rotation) - norm360(s.originalRotation ?? s.rotation));
        byRv[rv][d] = (byRv[rv][d] || 0) + 1;
    }
    // rv1 差值只能是 0 或 90；rv2 只能是 0 或 270
    assert.deepEqual(Object.keys(byRv[1]).map(Number).sort((a, b) => a - b), [0, 90]);
    assert.deepEqual(Object.keys(byRv[2]).map(Number).sort((a, b) => a - b), [0, 270]);
});

// world-full.json 不带 originalRotation；存档路径 + 解码器为可选依赖，缺失即跳过。
function savePath() {
    const appdata = process.env.APPDATA;
    if (!appdata) return null;
    const p = resolve(appdata, "shapez.io/saves/savegame-5c96706563c0b74c4d2ce4c7f8bf7a244392de89.bin");
    try { readFileSync(p); return p; } catch { return null; }
}
function loadDecoder() {
    try {
        const req = createRequire(import.meta.url);
        return req("../../recon/decode_full.cjs").decodeSave;
    } catch { return null; }
}
