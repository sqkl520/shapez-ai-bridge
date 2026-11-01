/**
 * 诊断的 `hint` 必须到达 prompt。
 *
 * ## 为什么单独一个测试文件
 *
 * 这是本次会话里**最值钱的一个发现**，也是最容易静默回退的一个：
 *
 * `MACRO_REFUSED` 诊断带着 `hint`（`loop.mjs:1232`），而那个 hint 是宏
 * **已经算出的解法**。以 `connect:occupied` 为例（`connect.mjs:987-993`）：
 *
 *   「有 N 条走法只需要覆盖既有带子（最少 M 格）就能通 —— 传 opts.allow_replace=true 即可」
 *
 * 宏枚举了几千条走法，发现它们**只差一个开关**。这句话到了诊断里，
 * 却从来没到过 prompt（`renderDiagnoses` 只给 `PROCESSOR_REQUIRED` 一个特例写了 hint）。
 *
 * 实测（`CONNECT-OCCUPIED-DIAGNOSIS.md`，7 个唯一失败调用）：
 *   · 4/7 是端口落点被占死（换端口即可，与路径无关）
 *   · 3/7 只差 `allow_replace:true`，宏已枚举出 89~1045 条合法折线
 *   · **0/7 需要更好的布线**
 *
 * ⇒ 模型看到「撞了」，但看不到「怎么解」。
 *
 * ## 这个文件钉住什么
 *
 * 1. `hint` 出现在渲染出的诊断行里
 * 2. 没有 `hint` 时不多出空串（不能渲染成 `; hint: `）
 * 3. `hint` 被截到 180 字符（预算是硬的）
 * 4. `hint` 里的坐标形态被 sanitize 掉（它是自由文本，不能因为这行是我们写的就跳过清洗）
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPrompt } from "./prompt.mjs";
import { buildHandles } from "./handles.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const FIX = path.join(REPO, "test/fixtures/saves");

const OBS = JSON.parse(fs.readFileSync(path.join(FIX, "L4-obs.json"), "utf8")).result;
const handles = buildHandles(OBS, null);

/** 造一条 `MACRO_REFUSED` 诊断，`hint` 可给可不给。 */
function diagWith(hint, over = {}) {
    return {
        code: "MACRO_REFUSED", layer: "plan", severity: "blocker",
        subject: { handle: "M1" },
        expected: { ok: true },
        observed: { code: "occupied", message: "所有候选路径都被挡住" },
        evidence: { macro: "connect", macro_code: "occupied" },
        ...(hint !== undefined ? { hint } : {}),
        candidates: ["connect", "replace_run"],
        ...over,
    };
}

function render(diagnoses, budget = { in_chars_max: 16000, prompt_tokens_max: 4600 }) {
    return buildPrompt({
        goal: "RuRu----", obs: OBS, handles,
        diagnoses, candidates: ["connect"], lastRound: null, budget,
    });
}

/* ═══════════ 1. hint 到达 ═══════════ */
test("H1 `MACRO_REFUSED` 的 hint 出现在渲染出的诊断行里", () => {
    const HINT = "这是「撞了」，不是参数错。有 3253 条走法只需要覆盖既有带子（最少 2 格）就能通"
        + " —— 传 opts.allow_replace=true 即可";
    const p = render([diagWith(HINT)]);
    assert.match(p.blocks.S4, /hint: /, `诊断行里必须有 hint 段，实际：${p.blocks.S4}`);
    /* 关键：**开关名**必须到模型眼前。这是那句 hint 唯一可执行的部分。 */
    assert.match(p.blocks.S4, /allow_replace/, "开关名 allow_replace 必须出现");
});

test("H2 没有 hint 时不多出 `; hint: `（不许渲染空段）", () => {
    const p = render([diagWith(undefined)]);
    assert.doesNotMatch(p.blocks.S4, /hint:/, `没有 hint 就不该出现这个键，实际：${p.blocks.S4}`);
});

test("H3 hint 是空串 / 纯空白时也不渲染", () => {
    for (const h of ["", "   ", "\n\t "]) {
        const p = render([diagWith(h)]);
        assert.doesNotMatch(p.blocks.S4, /hint:/, `空 hint（${JSON.stringify(h)}）不该渲染，实际：${p.blocks.S4}`);
    }
});

/* ═══════════ 2. 长度被截断 ═══════════ */
/* hint 段之后还可能跟 `; candidates …`，所以正则不能吃整行 —— 用 `; ` 作为段分隔。 */
const hintOf = (s4) => {
    const m = s4.match(/hint: ([\s\S]*?)(?:; |\n|$)/);
    return m ? m[1] : null;
};

test("H4 hint 被截到 ≤180 字符（预算硬约束）", () => {
    const LONG = "传 opts.allow_replace=true 即可。" + "补充说明".repeat(100);
    const p = render([diagWith(LONG)]);
    const h = hintOf(p.blocks.S4);
    assert.ok(h !== null, "应当有 hint 段");
    assert.ok(h.length <= 180, `hint 必须截到 ≤180，实际 ${h.length}：${h.slice(0, 40)}…`);
    assert.match(h, /allow_replace/, "截断不能把开头那句解法吃掉");
});

/* ═══════════ 3. 清洗没过期 ═══════════ */
test("H5 hint 里的坐标形态被 sanitize（它是自由文本）", () => {
    /* hint 的**当前**来源（connect/trash_unused/…）不含坐标，所以这条是防御性的：
       将来谁在 hint 里写了个格坐标，不能就这样漏进 prompt。 */
    const p = render([diagWith("回退到 (12,-34) 那个格子就能通")]);
    const h = hintOf(p.blocks.S4);
    assert.ok(h !== null, "应当有 hint 段");
    assert.doesNotMatch(h, /\(\s*-?\d{1,4}\s*,\s*-?\d{1,4}\s*\)/,
        `hint 里的坐标形态必须被清洗，实际：${h}`);
});

/* ═══════════ 4. 真实场景不炸预算 ═══════════ */
test("H6 真实 L4 存档：加 hint 后 CAPACITY 仍在（hint 不能挤掉它）", async () => {
    const { diagnose } = await import("../loop.mjs");
    const diags = diagnose(OBS, null, OBS.production || null, null, "RuRu----", handles, {});
    const p = buildPrompt({
        goal: "RuRu----", obs: OBS, handles, diagnoses: diags,
        candidates: ["connect", "replace_run", "insert_machine"], lastRound: null,
        budget: { in_chars_max: 16000, prompt_tokens_max: 4600 },
    });
    assert.ok(p.blocks.s3_capacity,
        `CAPACITY 必须在（unavailable=${p.blocks.capacity_unavailable}）`);
    assert.ok(p.system.length + p.user.length <= 16000, "总字符不许超上限");
});


/* ═══════════ 5. 端到端：宏的真实 hint 走完 buildTxPlan → 诊断 → prompt ═══════════
 *
 * 前面 H1-H6 用的是手写的假 hint。这一条用**真实宏产出的 hint**，
 * 走完整链路：`buildTxPlan` reject → `diagnosis.hint` → `renderDiagnoses` → S4。
 *
 * 为什么必须有这条：如果 `loop.mjs:1232` 的 `hint: e.hint || null` 哪天被删掉，
 * 或者 `connect.mjs` 改了 hint 的内容，前面那些用假 hint 的测试**全都还是绿的**。
 *
 * 实测（本次会话）：这个世界上最常见的 hint 就是
 * 「确实要抢过来就传 opts.rebind=true」—— 因为所有矿机→端口的连接
 * 都撞在 `port_already_bound` / `target_already_fed` 上（四轮共 6-14 次）。
 */
test("H7 端到端：真实宏的 rebind hint 走到 prompt", async () => {
    const { buildTxPlan } = await import("../loop.mjs");

    /* ① 宏确实拒了，并且给出了 hint —— 链路的源头 */
    const plan = {
        say: "feed the cutter",
        calls: [{
            macro: "connect",
            args: { from: { $ref: "M1" }, to: { $ref: "C1", port: "primary" } },
            why: "cutter is starved",
        }],
    };
    const txp = buildTxPlan(plan, OBS, null, handles);
    assert.equal(txp.ok, false, "M1→C1.primary 应当被拒（那个端口已经有供料方）");
    const d = txp.diagnosis;
    assert.ok(d, "拒绝必须带诊断");
    assert.equal(d.code, "MACRO_REFUSED", `诊断码应为 MACRO_REFUSED，实际 ${d.code}`);
    assert.equal(typeof d.hint, "string", `诊断必须带 hint，实际 ${JSON.stringify(d.hint)}`);
    assert.match(d.hint, /rebind/, `hint 必须点出开关名 rebind，实际：${d.hint}`);

    /* ② 那条诊断渲染进 prompt 时，hint 跟着走 */
    const p = render([d]);
    assert.match(p.blocks.S4, /rebind/,
        `真实 hint 里的 rebind 必须到达 prompt，实际 S4：${p.blocks.S4}`);
    assert.match(p.blocks.S4, /hint: /, "而且是作为 hint 段出现的");
});

/* ═══════════ 6. `LAST ROUND` 要带上「为什么失败 + 怎么解」 ═══════════
 *
 * 原来 `LAST ROUND` 只说 `round 2: calls [connect]; codes: MACRO_REFUSED`。
 * 模型知道上一轮失败，但不知道**原因和修法** —— 于是它常常重写一个几乎一样的计划。
 *
 * 现在多了 `previous failures: · connect → occupied: <hint>`，
 * 其中 hint 是宏**已经算出的解法**。
 */
test("H8 `LAST ROUND` 带上失败原因与 hint", () => {
    const p = buildPrompt({
        goal: "RuRu----", obs: OBS, handles,
        diagnoses: [], candidates: ["connect"], budget: { in_chars_max: 16000, prompt_tokens_max: 4600 },
        lastRound: {
            round: 1, calls: ["connect"],
            verify: { checks: [], codes: ["MACRO_REFUSED"] },
            decision: "plan_rejected",
            failures: [{ macro: "connect", code: "MACRO_REFUSED", hint: "确实要抢过来就传 opts.rebind=true" }],
        },
    });
    const s5 = p.blocks.S5;
    assert.match(s5, /previous failures:/, `S5 必须有 failures 段，实际：${s5}`);
    assert.match(s5, /connect → MACRO_REFUSED/, "要写清哪个宏、什么码");
    assert.match(s5, /rebind/, "hint 里的开关名必须到模型眼前");
});

test("H9 没有 failures 时不渲染空段", () => {
    const p = buildPrompt({
        goal: "RuRu----", obs: OBS, handles,
        diagnoses: [], candidates: ["connect"], budget: { in_chars_max: 16000, prompt_tokens_max: 4600 },
        lastRound: { round: 1, calls: ["connect"], verify: { checks: [], codes: ["X"] }, decision: "plan_rejected" },
    });
    assert.doesNotMatch(p.blocks.S5, /previous failures:/, "没有 failures 就不该出现这个标题");
});

test("H10 failures 超过 2 条时折叠（预算纪律）", () => {
    const many = ["a", "b", "c", "d"].map(m => ({ macro: m, code: "MACRO_REFUSED", hint: "hint text" }));
    const p = buildPrompt({
        goal: "RuRu----", obs: OBS, handles,
        diagnoses: [], candidates: ["connect"], budget: { in_chars_max: 16000, prompt_tokens_max: 4600 },
        lastRound: { round: 1, calls: ["a"], failures: many, decision: "plan_rejected" },
    });
    assert.ok(p.blocks.S5.includes("+2 more"),
        `4 条时应显示 2 条 + 折叠 2 条，实际：${p.blocks.S5}`);
});
