/**
 * 「目标矿在哪」这一段。
 *
 * ## 为什么需要它
 *
 * 真机实测（2026-11-03，level 5 / 目标 `Cu----Cu`）：
 *   · 世界里有 4 台矿机，脚下全是**钌**（`resources` 里 18 格 `RuRuRuRu`）；
 *   · 目标要**铜**，铜矿在 53 格外；
 *   · prompt **从头到尾没有一个字**说铜在哪。
 *
 * 模型三轮都在修那条钌线的堵塞，推理每次都对（"the rotater's output never
 * lands at the hub"），但**物理上不可能产出铜**。
 *
 * ## 两条硬约束
 *
 * 1. **不许出现坐标** —— `prompt.test.mjs` 有一条「坐标正则 0 命中」的契约。
 *    第一版写了 `nearest 20,5`，当场把那条测试打红。
 * 2. **没有资源数据就整段消失** —— 与 CAPACITY / RECIPE 同一条纪律：
 *    拿不到数据就不说，绝不猜一个默认值。
 */
import { buildPrompt } from "./prompt.mjs";

let pass = 0, fail = 0;
const check = (name, fn) => {
    try { fn(); pass++; console.log("PASS", name); }
    catch (e) { fail++; console.log("FAIL", name, "->", e && e.message); }
};
const assert = (c, m) => { if (!c) throw new Error(m || "assertion failed"); };

const mkObs = (goal, resources) => ({
    goal: { level: 5, requirement: { shape: goal, required: 170, delivered: 0, progress: 0 } },
    entities: [],
    hub: { x: 0, y: 0, w: 4, h: 4 },
    ...(resources === undefined ? {} : { resources }),
});

function promptOf(goal, resources) {
    return buildPrompt({
        goal,
        obs: mkObs(goal, resources),
        handles: { byHandle: new Map(), list: [] },
        diagnoses: [], candidates: ["connect"], lastRound: null,
        budget: { in_chars_max: 16000, prompt_tokens_max: 4600 },
    });
}

/* 生成一片某矿种 */
const patch = (kind, n, ox = 0, oy = 0) =>
    Array.from({ length: n }, (_, i) => [ox + (i % 4), oy + Math.floor(i / 4), kind]);

/* ── R1：★ 核心 ★ 目标矿在地图上 ⇒ 明说"有" ── */
check("R1 目标 Cu 有矿 ⇒ 说 IS on the map", () => {
    const r = promptOf("Cu----Cu", patch("CuCuCuCu", 8, 20, 5));
    const s = r.blocks.s3_machines;
    assert(/target ore Cu IS on the map/.test(s), `应说目标矿存在，实际：\n${s.slice(-300)}`);
    assert(/CuCuCuCu×8/.test(s), "应给出矿种与格数");
});

/* ── R2：★ 核心 ★ 目标矿不存在 ⇒ 明说"没有"，并列出实际有什么 ── */
check("R2 目标 Cu 没矿、只有 Ru ⇒ 说 NOT in the scanned area", () => {
    const r = promptOf("Cu----Cu", patch("RuRuRuRu", 12));
    const s = r.blocks.s3_machines;
    assert(/target ore Cu is NOT in the scanned area/.test(s), `应说目标矿不在，实际：\n${s.slice(-300)}`);
    assert(/RuRuRuRu/.test(s), "应列出实际有什么矿");
    assert(/no miner can ever produce Cu/.test(s), "应点明后果");
});

/* ── R3：无 resources 数据 ⇒ 整段消失（不猜） ── */
check("R3 没有 resources ⇒ 整段不出现", () => {
    const noRes = promptOf("Cu----Cu", undefined);
    const empty = promptOf("Cu----Cu", []);
    for (const r of [noRes, empty]) {
        const s = r.blocks.s3_machines;
        assert(!/target ore/.test(s), `无数据时不该出现该段，实际：\n${s.slice(-200)}`);
    }
});

/* ── R4：★ 坐标契约 ★ 渲染结果不得含坐标形态 ── */
check("R4 该段不含任何坐标数字", () => {
    const cases = [
        promptOf("Cu----Cu", patch("CuCuCuCu", 8, 20, 5)),
        promptOf("Cu----Cu", patch("RuRuRuRu", 12, -10, -7)),
        promptOf("RuRu----", patch("RuRuRuRu", 6, 100, -200)),
    ];
    for (const r of cases) {
        const s = r.blocks.s3_machines;
        // 两数用逗号分隔（坐标形态）
        const m = /-?\d{1,4}\s*,\s*-?\d{1,4}/.exec(s);
        assert(!m, `不该出现坐标形态，实际命中：${m && m[0]}\n${s.slice(-300)}`);
        // 也不该有 "bbox"/"nearest" 这类会诱发坐标的词
        assert(!/\bbbox\b/i.test(s), "不该出现 bbox");
        assert(!/\bnearest\s*\(/i.test(s), "不该出现 nearest (");
    }
});

/* ── R5：远近档位（near / short run / far） ── */
check("R5 按距离给出远近档位", () => {
    const near = promptOf("Cu----Cu", patch("CuCuCuCu", 4, 2, 2));
    assert(/near hub/.test(near.blocks.s3_machines), `近距离应说 near hub：${near.blocks.s3_machines.slice(-160)}`);

    const mid = promptOf("Cu----Cu", patch("CuCuCuCu", 4, 10, 10));
    assert(/a short run from hub/.test(mid.blocks.s3_machines), "中距离应说 a short run");

    const far = promptOf("Cu----Cu", patch("CuCuCuCu", 4, 40, 40));
    assert(/far from hub/.test(far.blocks.s3_machines), "远距离应说 far from hub");
});

/* ── R6：目标形状前缀不是色号（如空串 / 纯符号） ⇒ 不渲染 ── */
check("R6 目标串没有色号前缀时不渲染该段", () => {
    const r = promptOf("--------", patch("CuCuCuCu", 4));
    const s = r.blocks.s3_machines;
    assert(!/target ore/.test(s), `无色号前缀时不该渲染，实际：\n${s.slice(-200)}`);
});

/* ── R7：多种目标矿都出现时全部列出（不截断到 1 个） ── */
check("R7 同色多种矿（CuCuCuCu + CuCu----）都列出", () => {
    const res = [...patch("CuCuCuCu", 4, 20, 5), ...patch("CuCu----", 3, 22, 8)];
    const s = promptOf("Cu----Cu", res).blocks.s3_machines;
    assert(/CuCuCuCu/.test(s) && /CuCu----/.test(s), `两种都该列出，实际：\n${s.slice(-300)}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
