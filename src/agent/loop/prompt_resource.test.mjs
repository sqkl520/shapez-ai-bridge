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
import { buildHandles } from "./handles.mjs";

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

/* ══════════════════════════════════════════════════════════════════════════
 * 矿机标注：脚下有没有矿
 *
 * 实测（2026-11-03 真机）：接在**铜切割机**上的那台矿机 `M1 @(4,-16)`
 * 脚下根本没有矿（7×7 邻域内一格都没有），而 prompt 里它只是平平地写着
 * `M1 miner 输出=top:out(→C2)` —— 模型完全看不出这是一台**永久零产出**的机器。
 * 于是它反复去「修通」那条永远跑不起来的线。
 *
 * ⚠️ 第一版实现写了 `e.x` / `e.y`，而那些字段在 `normalizeHandles` 的产物里
 *    是 **undefined**（它只保留 handle/type/variant/uid/desc，位置不属于身份）。
 *    结果是**每一台矿机都被标成「没矿」** —— 包括脚下明明有钌的那三台。
 *    这种"全错"比不标更糟，所以下面 D2 专门钉住「有矿的必须说 mining」。
 * ══════════════════════════════════════════════════════════════════════════ */

const mkMinerObs = (goal, miners, resources) => ({
    goal: { level: 5, requirement: { shape: goal, required: 170, delivered: 0, progress: 0 } },
    entities: miners.map(m => ({ uid: m.uid, type: "miner", x: m.x, y: m.y, r: 0, rotation_variant: 0, variant: "default", code: 7 })),
    hub: { uid: 10000, x: 0, y: 0, w: 4, h: 4 },
    resources,
});

function minerSection(obs) {
    const r = buildPrompt({
        goal: obs.goal.requirement.shape, obs,
        handles: buildHandles(obs, null),
        diagnoses: [], candidates: ["connect"], lastRound: null,
        budget: { in_chars_max: 16000, prompt_tokens_max: 4600 },
    });
    return r.blocks.s3_machines;
}

/* ── D1：★ 核心 ★ 没矿的矿机必须被标出来 ── */
check("D1 脚下无矿的矿机被标 NO ORE", () => {
    const obs = mkMinerObs("Cu----Cu",
        [{ uid: 1, x: 4, y: -16 }],
        [[2, -6, "RuRuRuRu"]]);
    const s = minerSection(obs);
    assert(/NO ORE under this miner/.test(s), `应标出无矿，实际：\n${s}`);
});

/* ── D2：★ 回归 ★ 有矿的矿机**不加**标注（那是正常状态，不值得花字符） ──
 *
 * 第一版对有矿的也写 `[mining RuRuRuRu]`。代价立刻显形：L4 冷启动夹具有
 * 8 台矿机，8 条标注把 prompt 顶到 5098，**把 CAPACITY 段整个挤掉**。
 * 而 CAPACITY 是实测 p≈5e-7 的信息源，「这台矿机在采什么」不是。
 *
 * 信息价值也不对等：「在采 Ru」是正常状态，「没矿」是故障状态且会让
 * 下游永远零产出 —— 只标异常的那一侧。 */
check("D2 有矿的矿机不加标注（省字符给 CAPACITY）", () => {
    const obs = mkMinerObs("Cu----Cu",
        [{ uid: 1, x: 2, y: -6 }, { uid: 2, x: 3, y: -6 }],
        [[2, -6, "RuRuRuRu"], [3, -6, "RuRuRuRu"]]);
    const s = minerSection(obs);
    assert(!/NO ORE/.test(s), "有矿的矿机不该被标没矿，实际：" + s);
    assert(s.indexOf("[mining ") < 0, "有矿的正常矿机不该加标注，实际：" + s);
});

/* ── D3：混在一起时只有异常的那台被标（这是真机的形态） ── */
check("D3 一台无矿 + 三台有矿 ⇒ 只标那一台", () => {
    const obs = mkMinerObs("Cu----Cu",
        [{ uid: 1, x: 4, y: -16 }, { uid: 2, x: 2, y: -6 }, { uid: 3, x: 3, y: -6 }, { uid: 4, x: 4, y: -6 }],
        [[2, -6, "RuRuRuRu"], [3, -6, "RuRuRuRu"], [4, -6, "RuRuRuRu"]]);
    const s = minerSection(obs);
    const noOre = (s.match(/NO ORE/g) || []).length;
    assert(noOre === 1, `应恰好 1 台被标无矿，实际 ${noOre}：` + s);
});

/* ── D4：没有 resources 数据 ⇒ 一个字都不加（不猜） ── */
check("D4 无 resources 时矿机不加任何标注", () => {
    const obs = mkMinerObs("Cu----Cu", [{ uid: 1, x: 4, y: -16 }], undefined);
    delete obs.resources;
    const s = minerSection(obs);
    assert(!/NO ORE/.test(s), "无数据时不该说没矿");
    assert(!/\[mining /.test(s), "无数据时不该说在采什么");
});

/* ── D4b：无 resources 时矿机行一个方括号都不能有 ──
 *
 * 与 D4 的区别：D4 只查「没有 NO ORE / 没有 [mining」，这一条查**整行有没有方括号**，
 * 能挡住「以后有人在无数据分支里加了个别的标注」这种回归。
 *
 * ⚠️ 诚实说明：这一条**抓不到**「去掉 `&& oreAt`」那个变异 —— 因为
 * `oreMapOf` 返回 null 后 `kind` 恒为 undefined，加不加 `&& oreAt`
 * 行为完全一样。那不是真变异，是等价代码。留着这条是因为它守的是另一件事。 */
check("D4b 无 resources 时矿机行不带任何方括号标注", () => {
    const obs = mkMinerObs("Cu----Cu", [{ uid: 1, x: 4, y: -16 }], undefined);
    delete obs.resources;
    const s = minerSection(obs);
    const minerLine = s.split("\n").find(l => /^M\d/.test(l));
    assert(minerLine, "应有矿机行");
    assert(!/\[/.test(minerLine), `无数据时矿机行不该有方括号标注，实际：${minerLine}`);
});

/* ── D5：矿机标注不得破坏坐标契约 ── */
check("D5 矿机标注不含坐标数字", () => {
    const obs = mkMinerObs("Cu----Cu",
        [{ uid: 1, x: -55, y: -8 }, { uid: 2, x: 4, y: -16 }],
        [[-55, -8, "CuCuCuCu"]]);
    const s = minerSection(obs);
    const m = /-?\d{1,4}\s*,\s*-?\d{1,4}/.exec(s);
    assert(!m, `不该出现坐标形态，命中：${m && m[0]}\n${s}`);
});

console.log(`\n[after D] ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
