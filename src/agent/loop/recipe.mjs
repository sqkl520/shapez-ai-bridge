/**
 * recipe.mjs — 把目标形状的**配方**接进 prompt。
 *
 * 为什么需要（第四轮真 LLM 实验的直接产物，2026-10-28）：
 *   加了 `$path_of` 之后，模型的选择质量反而下降了：5 次里 **4 次**坚持要一个 `rotater`。
 *
 *     "Goal RuRu---- is a rotated half-shape: the factory has a cutter but no rotater at all,
 *      so add one on the cutter's left output belt so the half gets turned into the goal."
 *
 *   **这个推理是错的**：`RuRu----` = `cutHalf(RuRuRuRu)` 取右半，**不需要旋转**。
 *   模型把「半形状」误读成「旋转出来的形状」。
 *
 *   而正确配方**就在仓库里**：`research/ai-player/proto/solver.mjs` 早就能解出
 *   `mine(RuRuRuRu) → cut(half:"right") → RuRu----`。`src/ai/compiler/compile.mjs`
 *   也一直在用（`solveGoal` → `spawnSync(solver)`）。
 *   只是这个能力**从来没接进 prompt** —— 模型只能靠形状串自己猜该用哪些机器。
 *
 * 本模块只做一件事：把 solver 的 `steps[]` 渲染成模型能读的几句话。
 * **不重写代数** —— 形状代数只有一份真值（shape-ops.mjs / solver），
 * 这里再算一遍就是第二份真值，会立刻腐烂。
 *
 * 零依赖（只用 node: 内置 + spawnSync 跑仓库内的 solver）。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* 本文件在 `src/agent/loop/`，仓根要往上 **3** 层：loop → agent → src → 仓根。
   写成 2 层会得到 `src/research/...` —— 一个不存在但看着很合理的路径，
   而 spawnSync 对此只回 status:1，看不出是路径错。 */
const REPO = path.resolve(HERE, "../../..");
export const SOLVER_PATH = path.join(REPO, "research", "ai-player", "proto", "solver.mjs");

/** solver 的 op 名 → 说给模型听的中文/英文短语（**只翻译，不做代数**）。 */
const OP_PHRASE = Object.freeze({
    mine: "mine it",
    cut: "cut it with a cutter",
    cutQuad: "cut it into quarters",
    rotate: "rotate it with a rotater",
    stack: "stack two shapes with a stacker",
    paint: "paint it",
    paintQuad: "paint it per-quadrant",
});

/**
 * 跑 solver 解一个目标形状。
 *
 * **优雅降级**：solver 不可用（文件缺失 / 超时 / 非 JSON）时返回 `{ok:false, reason}`，
 * 调用方（prompt）跳过这一段 —— 少一段配方比让整个 prompt 崩掉好。
 * 但降级必须**留痕**（返回 reason），不许静默。
 *
 * @param {string} goalShape 例如 "RuRu----"
 * @param {{timeoutMs?:number, solverPath?:string}} [opts]
 * @returns {{ok:boolean, steps?:Array, ops?:object, reason?:string, raw?:string}}
 */
export function solveRecipe(goalShape, opts = {}) {
    if (typeof goalShape !== "string" || !goalShape.trim()) {
        return { ok: false, reason: "empty goal shape" };
    }
    const solver = opts.solverPath || SOLVER_PATH;
    const timeout = Number.isInteger(opts.timeoutMs) ? opts.timeoutMs : 20000;

    let res;
    try {
        res = spawnSync(process.execPath, [solver, goalShape, "--json"], {
            encoding: "utf8",
            timeout,
            maxBuffer: 4 * 1024 * 1024,
        });
    } catch (e) {
        return { ok: false, reason: `spawn failed: ${e && e.message ? e.message : e}` };
    }
    if (res.error) return { ok: false, reason: `spawn error: ${res.error.message}` };
    if (res.status !== 0) {
        return { ok: false, reason: `solver exited ${res.status}`, raw: (res.stderr || "").slice(0, 400) };
    }
    const text = String(res.stdout || "").trim();
    if (!text) return { ok: false, reason: "solver produced no output" };

    let data;
    try { data = JSON.parse(text); }
    catch { return { ok: false, reason: "solver output is not JSON", raw: text.slice(0, 400) }; }

    if (!data || data.solved !== true || !data.plan || !Array.isArray(data.plan.steps)) {
        return {
            ok: false,
            reason: data && data.solved === false ? "solver says the shape is unreachable" : "unexpected solver payload",
            raw: text.slice(0, 400),
        };
    }
    return {
        ok: true,
        steps: data.plan.steps,
        ops: data.plan.ops || {},
        pigments: data.plan.pigments || [],
        target: data.target,
    };
}

/**
 * 把 solver 的 steps 渲染成 prompt 用的几行。
 *
 * 输出形如：
 *   ## RECIPE (how the goal shape is made — do NOT guess, this is computed)
 *   RuRu----  ⇐  cut(half=right)            ← needs a cutter
 *   RuRuRuRu  ⇐  mine                       ← needs a miner
 *   ⇒ this shape needs: cutter×1, miner×1
 *   ⇒ it does NOT need a rotater: no rotation step appears above.
 *
 * 最后那句「does NOT need」是**直接针对实测失败模式**写的：模型 4/5 次误以为要 rotater。
 * 这句话必须由**步骤表**推出（"上面没有 rotate"），不能是硬编码断言 ——
 * 否则将来目标变成一个真的需要旋转的形状时就会撒谎。
 *
 * @param {{ok:boolean, steps?:Array, ops?:object}} recipe
 * @param {{maxSteps?:number}} [opts]
 * @returns {string|null} 渲染好的段落；solver 不可用时返回 null（调用方跳过）
 */
export function renderRecipe(recipe, opts = {}) {
    if (!recipe || recipe.ok !== true || !Array.isArray(recipe.steps) || !recipe.steps.length) return null;
    const maxSteps = Number.isInteger(opts.maxSteps) ? opts.maxSteps : 8;

    const lines = [
        "## RECIPE (how the goal shape is made — computed, do NOT guess)",
        "The toolchain already solved how to build this shape. Follow it instead of guessing which machines to add.",
    ];

    /* 从叶子往根渲染：steps 是 BFS 序，depth 小的在前（原料在前）。 */
    const steps = recipe.steps.slice(0, maxSteps);
    for (const s of steps) {
        const op = String(s.op || "?");
        const phrase = OP_PHRASE[op] || op;
        const args = s.args && typeof s.args === "object" && Object.keys(s.args).length
            ? `(${Object.entries(s.args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")})`
            : "";
        const from = Array.isArray(s.inputs) && s.inputs.length ? ` from ${s.inputs.join(" + ")}` : "";
        lines.push(`  ${s.hash}  ⇐  ${op}${args}${from}   [${phrase}]`);
    }
    if (recipe.steps.length > maxSteps) lines.push(`  (+${recipe.steps.length - maxSteps} more steps)`);

    /* 需要哪些机器：从 op 名反推（op → 机器）。**只翻译**，不重算代数。 */
    const OP_TO_MACHINE = {
        mine: "miner", cut: "cutter", cutQuad: "cutter",
        rotate: "rotater", stack: "stacker", paint: "painter", paintQuad: "painter",
    };
    const need = new Map();
    for (const s of recipe.steps) {
        const m = OP_TO_MACHINE[s.op];
        if (m) need.set(m, (need.get(m) || 0) + 1);
    }
    if (need.size) {
        lines.push(`⇒ machines this shape needs: ${[...need.entries()].map(([k, n]) => `${k}×${n}`).join(", ")}`);
    }

    /* 「不需要什么」：由**步骤表**推出，不硬编码 —— 见函数头注释。 */
    const present = new Set(recipe.steps.map(s => s.op));
    const NOT_NEEDED = [
        ["rotate", "rotater"],
        ["stack", "stacker"],
        ["paint", "painter"],
        ["paintQuad", "painter"],
    ];
    const absent = NOT_NEEDED.filter(([op]) => !present.has(op)).map(([, m]) => m);
    if (absent.length) {
        const uniq = [...new Set(absent)];
        lines.push(`⇒ it does NOT need: ${uniq.join(", ")} — no such step appears above. Do not add them.`);
    }
    return lines.join("\n");
}

/**
 * 一步到位：解 + 渲染。solver 不可用时返回 null 且带 reason（供调用方记警告）。
 * @returns {{text:string|null, reason:string|null, recipe?:object}}
 */
export function recipeBlock(goalShape, opts = {}) {
    const r = solveRecipe(goalShape, opts);
    if (!r.ok) return { text: null, reason: r.reason || "unknown", recipe: null };
    const text = renderRecipe(r, opts);
    return { text, reason: text ? null : "recipe rendered empty", recipe: r };
}

/* ══════════════════════════ 自测 ══════════════════════════ */

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("agent/loop/recipe.mjs");
if (isMain) {
    let pass = 0, fail = 0;
    const t = (name, cond, extra) => {
        if (cond) { pass++; console.log("✓ " + name); }
        else { fail++; console.log("✗ " + name + (extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 300) : "")); }
    };

    /* ① 真实目标：RuRu---- */
    const r = solveRecipe("RuRu----");
    t("solver 能解 RuRu----", r.ok, r.reason);
    if (r.ok) {
        t("steps 里有 cut", r.steps.some(s => s.op === "cut"));
        t("steps 里有 mine", r.steps.some(s => s.op === "mine"));
        t("**没有** rotate 步骤（这正是模型误判的地方）", !r.steps.some(s => s.op === "rotate"),
            r.steps.map(s => s.op));

        const txt = renderRecipe(r);
        t("渲染出非空文本", typeof txt === "string" && txt.length > 0);
        t("文本含目标形状串", txt.includes("RuRu----"));
        t("文本明确说不需要 rotater", /does NOT need.*rotater/.test(txt), txt && txt.slice(0, 400));
        t("文本说明用 cutter", /cutter/.test(txt));
        /* 坐标必须不出现（配方是形状层面的，不含世界坐标） */
        t("渲染结果不含坐标形态", !/\(?\s*-?\d{1,4}\s*,\s*-?\d{1,4}\s*\)?/.test(txt));
    }

    /* ② 对照：一个**真的**需要旋转的目标 ⇒ 不得说「不需要 rotater」 */
    {
        const rr = solveRecipe("--Ru----");
        if (rr.ok) {
            const txt = renderRecipe(rr);
            const needsRotate = rr.steps.some(s => s.op === "rotate");
            t(`对照 --Ru----（needsRotate=${needsRotate}）：「不需要 rotater」那句必须与步骤表一致`,
                needsRotate ? !/does NOT need.*rotater/.test(txt || "") : true,
                { needsRotate, snippet: (txt || "").slice(0, 200) });
        } else {
            console.log("  – --Ru---- 不可解，跳过对照（已显式记录，不是静默跳过）");
        }
    }

    /* ③ 降级路径：solver 不存在时不许抛，要返回结构化原因 */
    {
        const bad = solveRecipe("RuRu----", { solverPath: path.join(REPO, "no-such-solver.mjs") });
        t("solver 缺失 ⇒ ok:false 且带 reason（不抛）", bad.ok === false && typeof bad.reason === "string", bad);
        const blk = recipeBlock("RuRu----", { solverPath: path.join(REPO, "no-such-solver.mjs") });
        t("recipeBlock 降级时 text=null 且 reason 非空", blk.text === null && !!blk.reason, blk);
    }

    /* ④ 空输入 */
    {
        const empty = solveRecipe("");
        t("空目标 ⇒ ok:false", empty.ok === false);
        t("renderRecipe(null) ⇒ null", renderRecipe(null) === null);
        t("renderRecipe({ok:false}) ⇒ null", renderRecipe({ ok: false }) === null);
        t("renderRecipe({ok:true, steps:[]}) ⇒ null", renderRecipe({ ok: true, steps: [] }) === null);
    }

    /* ⑤ 渲染器不依赖 solver：手工构造 steps 也能渲染（保证纯函数） */
    {
        const fake = {
            ok: true,
            steps: [
                { hash: "AAAA----", op: "mine", args: {}, inputs: [] },
                { hash: "----AAAA", op: "rotate", args: { dir: "cw" }, inputs: ["AAAA----"] },
            ],
        };
        const txt = renderRecipe(fake);
        t("手工 steps 也能渲染", typeof txt === "string" && txt.includes("rotate"));
        t("有 rotate 时**不**说「不需要 rotater」", !/does NOT need.*rotater/.test(txt), txt);
        t("有 rotate 时列出 rotater×1", /rotater×1/.test(txt), txt);
    }

    console.log(`\nrecipe 自测：${pass} 通过 / ${fail} 失败`);
    process.exit(fail ? 1 : 0);
}

export default { solveRecipe, renderRecipe, recipeBlock, SOLVER_PATH };
