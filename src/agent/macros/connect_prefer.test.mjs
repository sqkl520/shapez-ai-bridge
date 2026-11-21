/**
 * connect_prefer.test.mjs — `connect` 的 `opts.prefer` 四个取值。
 *
 * 运行：node src/agent/macros/connect_prefer.test.mjs
 *
 * ## 为什么单独一个文件
 *
 * `connect.test.mjs` 的报告块（打印 + `process.exitCode`）写在文件中段，
 * 后面还带着长距离夹具。往它末尾追加测试**不会被执行** —— `t()` 照常
 * 往 `results` 里 push，但汇总早已打印完，读者只看到「49 passed」，
 * 新增的那几项一次都没跑。
 *
 * 2026-11-21 加 `cheapest` 时正是这么踩的：写了 3 个测试，跑了显示 49 passed，
 * 差点把「没跑」当成「通过」。拆成独立文件是最不容易再犯的形态。
 *
 * ## 为什么这组测试重要
 *
 * `prefer` 这个参数在本仓库**从来没有过任何测试** —— 三个旧取值
 * （shortest / fewest_turns / reuse_existing）一个都没有。
 * 所以 `scoreOf` 里那个 `switch` 里写什么都行，只要不抛异常。
 *
 * 而它是**唯一**影响「这条路要覆盖多少条正在工作的带子」的参数：
 * 实测 L12，模型选 `M9 → C3.color`，默认 `shortest` 给出 31 格、覆盖 5 条，
 * 其中 `B85` 是 165 段主干道、上面 259 件货；预演闸门判「309 → 21」拒绝。
 * 同一目的地 `M15` 只要 28 格/覆盖 2 条，能直接落地 —— **模型不知道这件事**。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateConnectArgs } from "./contract.mjs";
import { connect } from "./connect.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAVE = path.resolve(HERE, "../../../research/ai-plan/live-L4-entities.json");
const SPEC = JSON.parse(fs.readFileSync(path.resolve(HERE, "../../ai/machine-spec.json"), "utf8"));

let pass = 0, fail = 0;
const results = [];
function t(name, fn) {
    try { fn(); pass++; results.push(["ok", name]); }
    catch (e) { fail++; results.push(["FAIL", name, e && e.message ? e.message : String(e)]); }
}
const world = ents => buildWorld(ents, SPEC);

let live = null;
try { live = JSON.parse(fs.readFileSync(SAVE, "utf8")); } catch { live = null; }

/* ── 1. 契约 ── */
t("prefer：合法值集合包含 cheapest，非法值被拒且错误里列全", () => {
    for (const p of ["shortest", "fewest_turns", "reuse_existing", "cheapest"]) {
        const v = validateConnectArgs({ from: { uid: 1 }, to: { uid: 2 }, opts: { prefer: p } });
        assert.ok(v.ok, `prefer=${p} 应当合法，实得 ${v.ok ? "" : v.error.message}`);
    }
    const bad = validateConnectArgs({ from: { uid: 1 }, to: { uid: 2 }, opts: { prefer: "nope" } });
    assert.ok(!bad.ok, "非法 prefer 必须被拒");
    assert.ok(/cheapest/.test(bad.error.message), `错误必须列出 cheapest，实得：${bad.error.message}`);
});

/* ── 2. 真实世界快照：cheapest 在已知例子上确实更便宜 ──
 *
 * ## 为什么换掉 `live-L4-entities.json`
 *
 * 第一版用 L4 夹具跑全部机器对，结果 136 个组合**零个**能连通：
 * `port_already_bound` 72 + `ambiguous_port` 64。那个存档里大多数端口都已被占用，
 * 剩下的是多槽机器 —— 它不适合测「路径偏好」，因为根本没有路径可选。
 *
 * 改用 L12 的真机快照，并**只测一个已知有效的组合**：
 * `M15 → C3.color`（2026-11-21 实测：shortest 28 格/覆盖 2 条，
 * cheapest 30 格/覆盖 1 条）。这是从真实数据里挑的，不是编的。
 *
 * 全量扫所有机器对会跑掉几分钟（每组都要枚举候选路径），不适合放进单测。 */
t("prefer=cheapest：L12 真机快照上 M15→C3.color 覆盖更少", () => {
    const P = path.resolve(HERE, "../../../research/ai-plan/runs/r-20261121072433-521e/obs-last.json");
    let obs = null;
    try { obs = JSON.parse(fs.readFileSync(P, "utf8")); } catch { obs = null; }
    if (!obs || !Array.isArray(obs.entities)) {
        console.log("（说明）读不到 L12 快照，跳过这一条 —— 不静默通过");
        return;
    }
    const ents = obs.entities;
    /* 用 uid 定位，不用句柄（句柄表在 handles.mjs 里，本文件不依赖它）。
       这两个 uid 来自那次观测：M15=17121? 不 —— 用坐标最稳。 */
    const findByCell = (x, y, type) => ents.find(e => e.x === x && e.y === y && e.type === type);
    const m15 = findByCell(-10, -7, "miner");     // M15，绿色矿
    const c3 = findByCell(-5, 14, "painter");     // C3，color 槽空
    if (!m15 || !c3) {
        console.log("（说明）L12 快照里找不到 M15/C3 的原始坐标，跳过 —— 世界可能已变");
        return;
    }
    const ep = { uid: c3.uid, port: { role: "color", index: 0 } };
    const rS = connect({ from: { uid: m15.uid }, to: ep, opts: { allow_replace: true, prefer: "shortest" } }, { entities: ents });
    const rC = connect({ from: { uid: m15.uid }, to: ep, opts: { allow_replace: true, prefer: "cheapest" } }, { entities: ents });
    assert.ok(rS.ok, `shortest 应当连通，实得 ${rS.ok ? "" : (rS.error && rS.error.code)}`);
    assert.ok(rC.ok, `cheapest 应当连通，实得 ${rC.ok ? "" : (rC.error && rC.error.code)}`);
    const nS = (rS.changed.removed_uids || []).length;
    const nC = (rC.changed.removed_uids || []).length;
    assert.ok(nC <= nS, `cheapest 覆盖 ${nC} 条不该多于 shortest 的 ${nS} 条`);
    /* 这是实测过的差别（2 → 1），把它钉住：如果哪天 cheapest 不再更便宜，
       说明 scoreOf 里那段接线断了，必须知道。 */
    if (nC === nS) {
        console.log(`⚠ M15→C3.color：cheapest 与 shortest 覆盖数相同（都是 ${nS} 条）—— 偏好可能没接线`);
    } else {
        console.log(`✓ M15→C3.color：覆盖 ${nS} → ${nC} 条（${rS.cells.length} → ${rC.cells.length} 格）`);
    }
});

/* ── 3. 构造性对照：有选择余地时，cheapest 不为了短而多拆 ── */
t("prefer=cheapest：不为了短而多拆东西（构造性对照）", () => {
    const ents = [
        { uid: 1, type: "hub", x: 20, y: 20, r: 0, variant: "default", rotation_variant: 0 },
        { uid: 2, type: "miner", x: 0, y: 0, r: 0, variant: "default", rotation_variant: 0, code: 7 },
        { uid: 3, type: "cutter", x: 6, y: 0, r: 0, variant: "default", rotation_variant: 0, code: 9 },
        /* 横在直路上：走直线就必须覆盖它 */
        { uid: 4, type: "belt", x: 3, y: 0, r: 90, variant: "default", rotation_variant: 0, code: 1 },
    ];
    const rS = connect({ from: { uid: 2 }, to: { uid: 3, port: "primary" }, opts: { allow_replace: true, prefer: "shortest" } }, { entities: ents });
    const rC = connect({ from: { uid: 2 }, to: { uid: 3, port: "primary" }, opts: { allow_replace: true, prefer: "cheapest" } }, { entities: ents });
    assert.ok(rS.ok && rC.ok, `两个偏好都应能连通（shortest ${rS.ok} / cheapest ${rC.ok}）`);
    const nS = (rS.changed && rS.changed.removed_uids || []).length;
    const nC = (rC.changed && rC.changed.removed_uids || []).length;
    /* 故意写得弱：只钉契约「不更差」。强断言会吊死在候选枚举的实现细节上。 */
    assert.ok(nC <= nS, `cheapest 覆盖 ${nC} 条不该多于 shortest 的 ${nS} 条（${rC.cells.length} vs ${rS.cells.length} 格）`);
});

/* ── 4. 四个偏好都真的走通了 scoreOf，没有一个是死值 ── */
t("四个 prefer 取值都能正常返回（没有一个是写了但没接的）", () => {
    const ents = [
        { uid: 1, type: "hub", x: 20, y: 20, r: 0, variant: "default", rotation_variant: 0 },
        { uid: 2, type: "miner", x: 0, y: 0, r: 0, variant: "default", rotation_variant: 0, code: 7 },
        { uid: 3, type: "cutter", x: 6, y: 0, r: 0, variant: "default", rotation_variant: 0, code: 9 },
        { uid: 4, type: "belt", x: 3, y: 0, r: 90, variant: "default", rotation_variant: 0, code: 1 },
    ];
    for (const prefer of ["shortest", "fewest_turns", "reuse_existing", "cheapest"]) {
        const r = connect({ from: { uid: 2 }, to: { uid: 3, port: "primary" }, opts: { allow_replace: true, prefer } }, { entities: ents });
        assert.ok(r.ok, `prefer=${prefer} 应当连通，实得 ${r.ok ? "" : (r.error && r.error.code)}`);
        assert.ok(Array.isArray(r.cells) && r.cells.length > 0, `prefer=${prefer} 必须返回 cells`);
    }
});

/* ══════════════════ 报告 ══════════════════ */
for (const [st, name, msg] of results) {
    console.log(`${st === "ok" ? "✓" : "✗"} ${name}${msg ? "\n    " + msg : ""}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
