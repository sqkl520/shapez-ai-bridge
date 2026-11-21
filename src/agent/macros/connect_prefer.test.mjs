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
 * 2026-11-21 加 `cheapest` 时正是这么踩的：写了 3 个测试，跑显示 49 passed，
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
 *
 * ## ★ 夹具读不到必须 **fail**，不能 skip ★
 *
 * 第一版把快照指向 `research/ai-plan/runs/…/obs-last.json`，而那个目录在
 * `.gitignore` 里（`research/ai-plan/runs/` 下的 JSON 全部忽略）。后果：
 * 对任何新克隆的人，这两个最关键的用例**必然**走「读不到 → 打印说明 → return」
 * 的分支，而 `pass++` 照常执行 —— 实测把文件改名后输出
 * 「5 passed, 0 failed, exit=0」，M13「拆 6→1」那条断言一次都没跑却显示全绿。
 *
 * 我甚至在注释里写了「不静默通过」，代码却是 `console.log` + `return`。
 * 这正是 `computed-but-never-delivered` 的再现形态：**说出口了，没做到**。
 *
 * 现在夹具固化成 `test/fixtures/saves/L12-cheapest-obs.json`（708 实体，
 * 只保留带子 / hub / 相关的 8 台机器），随仓库走，读不到就红。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { connect } from "./connect.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, "../../../test/fixtures/saves/L12-cheapest-obs.json");

let pass = 0, fail = 0;
const results = [];
function t(name, fn) {
    try { fn(); pass++; results.push(["ok", name]); }
    catch (e) { fail++; results.push(["FAIL", name, e && e.message ? e.message : String(e)]); }
}

/* 夹具**必须**在。读不到就抛 —— 让每一个用例都红，而不是悄悄跳过。 */
function loadFixture() {
    const raw = fs.readFileSync(FIXTURE, "utf8");
    const obs = JSON.parse(raw);
    assert.ok(Array.isArray(obs.entities) && obs.entities.length > 100,
        `夹具实体数异常：${obs.entities && obs.entities.length}`);
    return obs.entities;
}
const findAt = (ents, x, y, type) => ents.find(e => e.x === x && e.y === y && e.type === type);
const cut = r => (r.changed && Array.isArray(r.changed.removed_uids) ? r.changed.removed_uids.length : 0);

/* ── 1. 契约 ── */
{
    const { validateConnectArgs } = await import("./contract.mjs");
    t("prefer：合法值集合包含 cheapest，非法值被拒且错误里列全", () => {
        for (const p of ["shortest", "fewest_turns", "reuse_existing", "cheapest"]) {
            const v = validateConnectArgs({ from: { uid: 1 }, to: { uid: 2 }, opts: { prefer: p } });
            assert.ok(v.ok, `prefer=${p} 应当合法，实得 ${v.ok ? "" : v.error.message}`);
        }
        const bad = validateConnectArgs({ from: { uid: 1 }, to: { uid: 2 }, opts: { prefer: "nope" } });
        assert.ok(!bad.ok, "非法 prefer 必须被拒");
        assert.ok(/cheapest/.test(bad.error.message), `错误必须列出 cheapest，实得：${bad.error.message}`);
    });
}

/* ── 2. 构造性对照（不依赖夹具） ── */
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
    assert.ok(cut(rC) <= cut(rS), `cheapest 覆盖 ${cut(rC)} 条不该多于 shortest 的 ${cut(rS)} 条`);
});

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

/* ── 3. ★ M13：早收敛不许把 cheaper 的候选吃掉 ★ ──
 *
 * 2026-11-21 真机验证发现的**结构性架空**：`connect` 枚举里有
 *
 *     if (occ.ok && sh.turns <= floor) break;   // 拿到下界转角就停
 *
 * 这个优化让 `cheapest` 基本等于 `shortest` —— 17 台矿机里只有 1 台出现差异。
 * 不是因为没有更便宜的候选，而是它们**进不了排序**。
 *
 * ## 断言只钉「严格更少」，不钉具体数字
 *
 * 实测数字会随夹具裁剪浮动（全量快照上 M13 是 6→1，裁剪后的夹具上是 6→0），
 * 因为覆盖数取决于世界里有哪些带子。**钉死具体数字会让测试变成
 * 「夹具指纹」，而不是「判据是否生效」** —— 后者才是要保的东西。 */
t("★ cheapest 关掉早收敛：M13 必须能找到「拆得更少」那条", () => {
    const ents = loadFixture();
    const m13 = findAt(ents, -10, -6, "miner");
    const c3 = findAt(ents, -5, 14, "painter");
    assert.ok(m13, "夹具里找不到 M13（miner @-10,-6）");
    assert.ok(c3, "夹具里找不到 C3（painter @-5,14）");
    const ep = { uid: c3.uid, port: { role: "color", index: 0 } };
    const rS = connect({ from: { uid: m13.uid }, to: ep, opts: { allow_replace: true, prefer: "shortest" } }, { entities: ents });
    const rC = connect({ from: { uid: m13.uid }, to: ep, opts: { allow_replace: true, prefer: "cheapest" } }, { entities: ents });
    assert.ok(rS.ok, `shortest 应能连通，实得 ${rS.ok ? "" : (rS.error && rS.error.code)}`);
    assert.ok(rC.ok, `cheapest 应能连通，实得 ${rC.ok ? "" : (rC.error && rC.error.code)}`);
    assert.ok(cut(rC) < cut(rS),
        `cheapest 必须比 shortest 拆得少（实得 ${cut(rS)} → ${cut(rC)} 条）。`
        + ` 若两者相等，说明 connect.mjs 里的 early-break 又对 cheapest 生效了。`);
    console.log(`  M13→C3.color：拆 ${cut(rS)} → ${cut(rC)} 条（${rS.cells.length} → ${rC.cells.length} 格）`);
});

/* ── 4. M15：另一台独立样本，同样不许被早收敛吃掉 ── */
t("★ cheapest 在 M15 上也必须严格更少", () => {
    const ents = loadFixture();
    const m15 = findAt(ents, -10, -7, "miner");
    const c3 = findAt(ents, -5, 14, "painter");
    assert.ok(m15 && c3, "夹具里找不到 M15 或 C3");
    const ep = { uid: c3.uid, port: { role: "color", index: 0 } };
    const rS = connect({ from: { uid: m15.uid }, to: ep, opts: { allow_replace: true, prefer: "shortest" } }, { entities: ents });
    const rC = connect({ from: { uid: m15.uid }, to: ep, opts: { allow_replace: true, prefer: "cheapest" } }, { entities: ents });
    assert.ok(rS.ok && rC.ok, `两个偏好都应连通（${rS.ok} / ${rC.ok}）`);
    assert.ok(cut(rC) < cut(rS), `cheapest 必须拆得更少（实得 ${cut(rS)} → ${cut(rC)}）`);
    console.log(`  M15→C3.color：拆 ${cut(rS)} → ${cut(rC)} 条（${rS.cells.length} → ${rC.cells.length} 格）`);
});

/* ══════════════════ 报告 ══════════════════ */
for (const [st, name, msg] of results) {
    console.log(`${st === "ok" ? "✓" : "✗"} ${name}${msg ? "\n    " + msg : ""}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
