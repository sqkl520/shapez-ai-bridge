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
