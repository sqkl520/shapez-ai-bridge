/**
 * `HUB stored` 那一行 —— hub 里躺着哪些形状。
 *
 * ## 为什么需要它（2026-11-21，代价最大的那条教训）
 *
 * 真机 `r-20261121100232-d10f`（L12）：
 *   · `hub.stored_shapes['CgScScCg'] = 2071`
 *   · `CgScScCg` 正是**上一关（L11）的目标形状**（`levels.js:242`，1000 件通关）
 *   · 而本关目标 `CbCbCbRb:CwCwCwCw` 的 `delivered = 0`
 *
 * 模型连续两轮在修 `painter#13552` 的 color 槽；我和几个 agent 也花了大半天查
 * 那条死锁链。查完才发现：**那条链是 L11 的产线** —— 接绿色吐出 `CgScScCg`
 * （L11 目标），接蓝色吐出 `CbScScCb`（废品）。七种颜色全试过，没有一种能产出
 * L12 要的形状。它的另一路进料是 `ScSc----`（星形半片），而目标里一个星形都没有。
 *
 * ⇒ **修通它等于把上一关的线修回去。**
 *
 * 而 `hub.stored_shapes` 一直在 obs 里，**从来没进过 prompt**。
 * 这是 `computed-but-never-delivered` 的第三次重演。
 *
 * ## 这条测试钉住的四件事
 *
 * 1. 数据在 ⇒ 这一行必须出现（否则就是又退化成「算出来没送到」）
 * 2. **看起来像矿石的形状排在最后** —— 四格同色同形（`CrCrCrCr`/`RuRuRuRu`）
 *    是矿机直接挖出来的，进 hub 是常态，不携带「这条线在造什么」的信息
 * 3. `short` 档只给一条时，挑的必须是**复合形状**而不是矿石
 * 4. 没有 `stored_shapes` ⇒ 整段消失（不猜，与 CAPACITY/RECIPE 同一条纪律）
 */
import { buildPrompt } from "./prompt.mjs";
import { buildHandles } from "./handles.mjs";

let pass = 0, fail = 0;
const check = (name, fn) => {
    try { fn(); pass++; console.log("PASS", name); }
    catch (e) { fail++; console.log("FAIL", name, "->", e && e.message); }
};
const assert = (c, m) => { if (!c) throw new Error(m || "assertion failed"); };

/** 最小世界：hub 占 (0,0)，句柄表靠 buildHandles 从实体推。 */
const mkObs = (goal, stored) => ({
    goal: { level: 12, requirement: { shape: goal, required: 1000, delivered: 0, progress: 0 } },
    entities: [{ uid: 1, type: "hub", x: 0, y: 0, w: 4, h: 4 }],
    hub: { x: 0, y: 0, w: 4, h: 4, ...(stored === undefined ? {} : { stored_shapes: stored }) },
});

function promptOf(goal, stored, budget) {
    const obs = mkObs(goal, stored);
    return buildPrompt({
        goal, obs, handles: buildHandles(obs, null),
        diagnoses: [], candidates: ["connect"], lastRound: null,
        budget: budget || {},
    });
}

const GOAL = "CbCbCbRb:CwCwCwCw";

/* L12 真实的库存（截取，件数照抄） */
const LIVE_STORED = {
    CrCrCrCr: 41662,
    "Cu------": 33532,
    "Cu----Cu": 27823,
    RuRuRuRu: 14843,
    "----CuCu": 8476,
    "RbRb----": 6619,
    "----RuRu": 4575,
    CgScScCg: 2071,          // ← 上一关的目标形状
    ScScScSc: 1680,
    CuCuCuCu: 1680,
    CpCpCpCp: 1205,
};

/* ── 1. 数据在就必须出现 ── */
check("有 stored_shapes ⇒ 这一行出现", () => {
    const p = promptOf(GOAL, LIVE_STORED);
    assert(p.blocks.s3_hub_stored, "s3_hub_stored 是空的 —— 又退化成「算出来没送到」");
    assert(/stored/i.test(p.user), "正文里找不到这一行");
});

/* ── 2. 上一关的目标形状必须看得见（本测试存在的理由） ── */
check("★ CgScScCg 必须出现在 prompt 里", () => {
    /* 用宽预算，确保不是被 `short` 档挤掉的 */
    const p = promptOf(GOAL, LIVE_STORED, { in_chars_max: 60000, prompt_tokens_max: 15000 });
    assert(p.user.includes("CgScScCg"),
        "L11 的目标形状不在 prompt 里 —— 模型无法知道有一条线在造上一关的东西");
});

/* ── 3. 矿石排在复合形状之后 ── */
check("★ 四格同形（矿石）排在复合形状之后", () => {
    const p = promptOf(GOAL, LIVE_STORED, { in_chars_max: 60000, prompt_tokens_max: 15000 });
    const line = p.blocks.s3_hub_stored || "";
    const iCompound = line.indexOf("CgScScCg");
    const iOre = line.indexOf("CrCrCrCr");
    assert(iCompound >= 0, `复合形状 CgScScCg 不在这一行里 -> ${line}`);
    /* 矿石可能被 `(+N more)` 折叠掉 —— 那也算「排在后面」，只是没显示。
       真正要钉的是：**只要矿石出现了，它就必须在复合形状之后**。 */
    if (iOre >= 0) {
        assert(iCompound < iOre,
            `复合形状必须排在矿石前面，实际 CgScScCg@${iCompound} vs CrCrCrCr@${iOre}：${line}`);
    }
});

/* ── 4. short 档只给一条时，挑的必须是复合形状 ── */
check("★ short 档挑的是复合形状，不是矿石", () => {
    /* 极紧的预算逼出 short 档 */
    const p = promptOf(GOAL, LIVE_STORED, { in_chars_max: 12000, prompt_tokens_max: 500 });
    const line = p.blocks.s3_hub_stored;
    if (!line) return;                       // 紧到整段消失也可以接受，但…
    assert(line.includes("CgScScCg"),
        `short 档挑错了：给的是矿石而不是「有一条线在造别的东西」这个事实 -> ${line}`);
    assert(!line.includes("CrCrCrCr"), `short 档不该把矿石放进来 -> ${line}`);
});

/* ── 5. 目标自己打标签 ── */
check("目标形状标 ← goal", () => {
    const p = promptOf(GOAL, { [GOAL]: 500, CgScScCg: 2071 }, { in_chars_max: 60000, prompt_tokens_max: 15000 });
    assert(/CbCbCbRb:CwCwCwCw×500 ← goal/.test(p.user),
        `目标形状没标 ← goal -> ${p.blocks.s3_hub_stored}`);
});

/* ── 6. 没有数据就整段消失（不猜） ── */
check("没有 stored_shapes ⇒ 整段不出现", () => {
    const p = promptOf(GOAL, undefined);
    assert(!p.blocks.s3_hub_stored, "没有数据却渲染出了内容");
    assert(!p.user.includes("HUB stored"), "正文里不该有这一行");
    assert(p.blocks.hub_stored_dropped === "nothing-to-say",
        `原因应当是 nothing-to-say，实际 ${p.blocks.hub_stored_dropped}`);
});

/* ── 7. 全是噪声（件数不够）⇒ 也不出现 ── */
check("件数都不够阈值 ⇒ 不出现", () => {
    const p = promptOf(GOAL, { CgScScCg: 3, CrCrCrCr: 12 });
    assert(!p.blocks.s3_hub_stored, "3 件、12 件这种碎片不该占字符");
});

/* ── 8. 不许出现坐标（与 prompt.test.mjs 同一条契约） ── */
check("这一行里不许有坐标", () => {
    const p = promptOf(GOAL, LIVE_STORED, { in_chars_max: 60000, prompt_tokens_max: 15000 });
    const line = p.blocks.s3_hub_stored || "";
    assert(!/-?\d+\s*,\s*-?\d+/.test(line), `出现了坐标形态：${line}`);
});

console.log(`\nHUB stored 自测：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
