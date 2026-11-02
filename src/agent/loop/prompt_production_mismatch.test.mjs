/**
 * PRODUCTION 段的「产的不是目标」告警。
 *
 * ## 为什么需要它
 *
 * 真机实测（2026-11-03，level 5 / 目标 `Cu----Cu`）时 prompt 里是：
 *
 *   ## GOAL        shape: Cu----Cu
 *   ## PRODUCTION  produced RuRuRuRu: 105 / rate RuRuRuRu: 1.767
 *
 * 两段相邻却**没有一句话说它们矛盾**。模型得自己把 `Cu----Cu` 和 `RuRuRuRu`
 * 做颜色+形状对比才能发现「整条线在造别的颜色」—— 它没发现，三轮都在修
 * 钌传送带的堵塞，而一条铜都没产（post-run `production` 里铜的计数全是 0）。
 *
 * 所以这一段的职责从「列数字」扩到「在明显矛盾时把话说明白」。判据：
 *   · 目标形状不在 produced_total 的键里 ⇒ 加一句 WARNING，点名两边
 *   · 目标形状**在**里面 ⇒ 不加（否则是噪音）
 *   · 没有产出数据 ⇒ 不加（「produced 空」本身已说明问题）
 */
import { buildPrompt } from "./prompt.mjs";

let pass = 0, fail = 0;
const check = (name, fn) => {
    try { fn(); pass++; console.log("PASS", name); }
    catch (e) { fail++; console.log("FAIL", name, "->", e && e.message); }
};
const assert = (c, m) => { if (!c) throw new Error(m || "assertion failed"); };

/** 最小 obs：只要 goal.requirement.shape 与 entities 空表即可。 */
const mkObs = goal => ({
    goal: { level: 5, requirement: { shape: goal, required: 170, delivered: 0, progress: 0 } },
    entities: [],
    hub: { x: 0, y: 0, w: 4, h: 4 },
});

const mkProduction = producedTotal => ({
    window_seconds: 60,
    slice_seconds: 10,
    slices_returned: 6,
    produced_total: producedTotal,
    produced_per_sec: Object.fromEntries(Object.entries(producedTotal).map(([k, v]) => [k, v / 60])),
    delivered_total: producedTotal,
    delivered_per_sec: Object.fromEntries(Object.entries(producedTotal).map(([k, v]) => [k, v / 60])),
});

/** 建 prompt 并返回 PRODUCTION 段。 */
function prodSection(goal, producedTotal) {
    const res = buildPrompt({
        goal,
        obs: mkObs(goal),
        handles: { byHandle: new Map(), list: [] },
        diagnoses: [],
        candidates: ["replace_run", "insert_machine", "connect"],
        lastRound: null,
        production: mkProduction(producedTotal),
        budget: { in_chars_max: 16000, prompt_tokens_max: 4600 },
    });
    return res.blocks.s3_production || "";
}

/* ── A1：★ 核心 ★ 产的是别的形状 ⇒ 必须警告 ── */
check("A1 目标 Cu----Cu 但只产 RuRuRuRu ⇒ 出现 WARNING", () => {
    const s = prodSection("Cu----Cu", { RuRuRuRu: 105 });
    assert(/WARNING/.test(s), "PRODUCTION 段应含 WARNING");
    assert(s.includes("Cu----Cu"), "警告里应点名目标形状");
    assert(s.includes("RuRuRuRu"), "警告里应点名实际在产的形状");
    assert(/DIFFERENT shape/.test(s), "应明说这是不同的形状");
});

/* ── A2：目标就在产出里 ⇒ 不得警告（否则是狼来了） ── */
check("A2 产的就是目标 ⇒ 不出现 WARNING", () => {
    const s = prodSection("RuRu----", { "RuRu----": 88, RuRuRuRu: 12 });
    assert(!/WARNING/.test(s), `不该有 WARNING，实际段内容：\n${s}`);
});

/* ── A3：完全没有产出数据 ⇒ 不警告（「空」本身已说明问题） ── */
check("A3 produced_total 为空 ⇒ 不出现 WARNING", () => {
    const s = prodSection("Cu----Cu", {});
    assert(!/WARNING/.test(s), "无产出时不该补这句（噪音）");
});

/* ── A4：production 读不到 ⇒ 保持原来的 unavailable 文案，不崩 ── */
check("A4 production 为 null ⇒ unavailable 文案且无 WARNING", () => {
    const res = buildPrompt({
        goal: "Cu----Cu", obs: mkObs("Cu----Cu"),
        handles: { byHandle: new Map(), list: [] },
        diagnoses: [], candidates: ["connect"], lastRound: null,
        production: null,
        budget: { in_chars_max: 16000, prompt_tokens_max: 4600 },
    });
    const s = res.blocks.s3_production;
    assert(/unavailable/.test(s), "应保留 unavailable 文案");
    assert(!/WARNING/.test(s), "不可用不该有警告");
});

/* ── A5：多个产出形状时，警告里点名（截断到 3 个，不刷屏） ── */
check("A5 多个非目标形状 ⇒ 警告里最多点 3 个", () => {
    const s = prodSection("Cu----Cu", { RuRuRuRu: 50, "RuRu----": 30, "----RuRu": 20, "RbRb----": 10 });
    assert(/WARNING/.test(s), "应含 WARNING");
    // 只取 "The line is making X, Y, Z, which is a DIFFERENT" 这一段
    const m = /The line is making ([^—]+?), which is a DIFFERENT/.exec(s);
    assert(m, `应列出在产的形状，实际：\n${s}`);
    const listed = m[1].split(",").map(x => x.trim()).filter(Boolean);
    assert(listed.length <= 3, `最多点 3 个，实际 ${listed.length}: ${listed.join("|")}`);
    assert(!listed.includes("RbRb----"), "第 4 个形状不该出现（截断应生效）");
});

/* ── A6：警告不得挤掉原有的产出数字（信息不能丢） ── */
check("A6 加警告后产出数字仍在", () => {
    const s = prodSection("Cu----Cu", { RuRuRuRu: 105 });
    assert(/produced RuRuRuRu: 105/.test(s), `产出数字应保留，实际：\n${s}`);
    assert(/rate RuRuRuRu/.test(s), "速率应保留");
});

/* ── A7：goal 是空白串 ⇒ 不误报（trim 后为空，无从比较） ── */
check("A7 goal 为空白串时不误报 WARNING", () => {
    const r = buildPrompt({
        goal: "   ", obs: mkObs("   "),
        handles: { byHandle: new Map(), list: [] },
        diagnoses: [], candidates: ["connect"], lastRound: null,
        production: mkProduction({ RuRuRuRu: 10 }),
        budget: { in_chars_max: 16000, prompt_tokens_max: 4600 },
    });
    const s = r.blocks.s3_production;
    assert(s, "PRODUCTION 段应仍存在");
    assert(!/WARNING/.test(s), `空白 goal 不该触发警告（无从比较），实际：\n${s}`);
    assert(/produced RuRuRuRu: 10/.test(s), "产出数字应仍在");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
