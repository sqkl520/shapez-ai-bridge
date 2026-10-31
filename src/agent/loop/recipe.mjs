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

/**
 * 机器解锁关卡 —— **等级门控的唯一本地真值**（P-a）。
 *
 * ⚠️ 为什么在这里写一份，而不是 `import` `src/ai/compiler/compile.mjs`：
 *   实测 import 那个模块要 **~165ms**（它拉进 place/route/validate/emit/shape-ops 一整串），
 *   而且它内部有 `spawnSync` —— 本模块要在 prompt 热路径上每轮跑。为了 5 个整数付这个代价不值得。
 *   **代价是两份真值**，所以 `recipe.test.mjs` 有一条防漂移测试，逐项与 `compile.mjs`
 *   的导出常量对拍（`MIN_LEVEL_FOR_OP` + `CUTQUAD_MIN_LEVEL`）。改这里而不同步那边，测试立刻红。
 *
 * 数值来源：`compile.mjs:67-74` / `facts/human-strategies.md`（quad cutter = L16）。
 * 与 solver 的 `--no-*` flag 一一对应（`proto/solver.mjs:444-449`）。
 */
export const MIN_LEVEL_FOR_MACHINE = Object.freeze({
    rotater: 4,
    painter: 6,
    mixer: 8,
    stacker: 10,
    cutQuad: 16,
    /* 隧道（underground_belt）不是 solver 的 op，所以这里**不**参与 `flagsForLevel` 的 `--no-*`
       映射 —— 它没有对应的 solver flag。列在这里是为了让"配方层能看见它"：
       L<6 的方案不可能合法使用隧道（reward_tunnel 是 levels.js 第 5 关完成时授予的）。
       真值来源：`op-templates.mjs` 的 `TUNNEL_UNLOCKED_LEVEL`（本项必须与它相等，测试对拍）。 */
    tunnel: 6,
});

/** 逐个导出，方便调用方只取一个；也方便测试直接断言。 */
export const ROTATER_MIN_LEVEL = MIN_LEVEL_FOR_MACHINE.rotater;
export const PAINTER_MIN_LEVEL = MIN_LEVEL_FOR_MACHINE.painter;
export const MIXER_MIN_LEVEL = MIN_LEVEL_FOR_MACHINE.mixer;
export const STACKER_MIN_LEVEL = MIN_LEVEL_FOR_MACHINE.stacker;
export const CUTQUAD_MIN_LEVEL = MIN_LEVEL_FOR_MACHINE.cutQuad;
export const TUNNEL_MIN_LEVEL = MIN_LEVEL_FOR_MACHINE.tunnel;

/** `recipeFor` 的缺省关卡：L4（第一个需要 cutter 的官方关；既有 prompt 的场景）。 */
export const DEFAULT_LEVEL = 4;

/**
 * 关卡 → solver 的 `--no-*` flag 列表（**顺序固定**：按解锁关卡升序）。
 *
 * 这是一处**已验证的真 bug 的修复**（`DIAGNOSE-V2-REDTEAM-VERDICT.md` §11）：
 *   不带门控时 `solveRecipe("Cu----Cu")` 返回 `cutQuad×2 + stack`，而 cutQuad 要 **L16**、
 *   stacker 要 **L10**；`Cu----Cu` 是 **L5** 关卡，存档里只有 2 台 cutter。这段配方在 prompt 里骗模型。
 *   实测（2026-10-30）：
 *     `solver Cu----Cu --json`                 → mine + cutQuad×2 + stack
 *     `solver Cu----Cu --json --no-cutquad`    → mine + cut + rotate   （L5 真解）
 *
 * 只做**减法**（只关机器、不换目标），所以「门控不误伤」是可测的：
 * `RuRu----`（L4）加满 L4 的门控与不加，产出的 steps 完全相同。
 *
 * @param {number} level
 * @returns {string[]} 例如 L5 → ["--no-painter","--no-mixer","--no-stacker","--no-cutquad"]
 */
export function flagsForLevel(level) {
    const lv = Number.isFinite(level) ? level : DEFAULT_LEVEL;
    const flags = [];
    if (lv < ROTATER_MIN_LEVEL) flags.push("--no-rotater");
    if (lv < PAINTER_MIN_LEVEL) flags.push("--no-painter");
    if (lv < MIXER_MIN_LEVEL) flags.push("--no-mixer");
    if (lv < STACKER_MIN_LEVEL) flags.push("--no-stacker");
    if (lv < CUTQUAD_MIN_LEVEL) flags.push("--no-cutquad");
    return flags;
}

/** solver 的 op 名 → 机器种类。**只翻译**，不做代数（代数真值在 shape-ops / solver）。 */
export const OP_TO_MACHINE = Object.freeze({
    mine: "miner",
    mineColor: "miner",       // 颜料矿：solver 用 mineColor 表示「地上本来就有的纯色矿」
    cut: "cutter",
    cutQuad: "cutter",
    rotate: "rotater",
    stack: "stacker",
    paint: "painter",
    paintQuad: "painter",
    mix: "mixer",
});

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
 * @param {{timeoutMs?:number, solverPath?:string, spawn?:Function, extraArgs?:string[],
 *          tolerateUnsolvable?:boolean}} [opts]
 * @returns {{ok:boolean, steps?:Array, ops?:object, reason?:string, raw?:string}}
 */
function runSolver(goalShape, opts = {}) {
    if (typeof goalShape !== "string" || !goalShape.trim()) {
        return { ok: false, reason: "empty goal shape" };
    }
    const solver = opts.solverPath || SOLVER_PATH;
    const timeout = Number.isInteger(opts.timeoutMs) ? opts.timeoutMs : 20000;
    /* `opts.spawn` 可注入（签名同 spawnSync）—— 测试用它，**永不真 spawn**。 */
    const doSpawn = typeof opts.spawn === "function" ? opts.spawn : spawnSync;
    const extra = Array.isArray(opts.extraArgs) ? opts.extraArgs : [];
    const argv = [solver, goalShape, ...extra, "--json"];

    let res;
    try {
        res = doSpawn(process.execPath, argv, {
            encoding: "utf8",
            timeout,
            maxBuffer: 4 * 1024 * 1024,
        });
    } catch (e) {
        return { ok: false, reason: `spawn failed: ${e && e.message ? e.message : e}` };
    }
    if (!res || typeof res !== "object") {
        return { ok: false, reason: "spawn returned no result object" };
    }
    if (res.error) return { ok: false, reason: `spawn error: ${res.error.message || res.error}` };

    const text = String(res.stdout || "").trim();
    /* ★ status !== 0 不等于「跑挂了」★
     * solver 在**未解出**时也打印合法 JSON（`{"solved":false,…}`）然后 `exit(2)`
     * （`proto/solver.mjs:283`）。`recipeFor` 走 `tolerateUnsolvable`，先解析再判 status，
     * 于是「不可解」能被归成 `solved:false` 而不是一个假的「进程崩了」。
     * `solveRecipe` 保持旧顺序（先判 status），**行为一字不改**。 */
    if (!opts.tolerateUnsolvable && res.status !== 0) {
        return { ok: false, reason: `solver exited ${res.status}`, raw: (res.stderr || "").slice(0, 400) };
    }
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
    if (res.status !== 0 && opts.tolerateUnsolvable) {
        /* solved:true 却非零退出：solver 自相矛盾，不许静默吞掉 */
        return {
            ok: false,
            reason: `solver output is self-contradictory: solved:true but exited ${res.status}`,
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
 * 跑 solver 解一个目标形状（**旧接口，行为不变**）。
 *
 * @param {string} goalShape 例如 "RuRu----"
 * @param {{timeoutMs?:number, solverPath?:string}} [opts]
 * @returns {{ok:boolean, steps?:Array, ops?:object, reason?:string, raw?:string}}
 */
export function solveRecipe(goalShape, opts = {}) {
    return runSolver(goalShape, opts);
}

/* ════════════════════════ 结构化配方（P-a）════════════════════════ */

/**
 * 解一个目标形状，返回**结构化**的配方（不只是能渲染的 steps）。
 *
 * 与 `solveRecipe` 的差别：**关卡门控** + **派生字段**（needs/closure/raw）+
 * 对 `solved:false` 的正确归因（solver 不可解时 `exit(2)`，必须先解析 JSON 再判 status）。
 * 失败一律 `ok:false` + `reason`，绝不抛 —— prompt 与 diagnose 都不该被 solver 拖死。
 *
 * @param {string} goalShape
 * @param {{level?:number, timeoutMs?:number, solverPath?:string, spawn?:Function}} [opts]
 * @returns {{ok:boolean, reason?:string, steps?:Array, ops?:object,
 *            needs?:Map<string,number>, closure?:Set<string>, raw?:Set<string>,
 *            level:number, gated:string[]}}
 */
export function recipeFor(goalShape, opts = {}) {
    const level = Number.isFinite(opts.level) ? opts.level : DEFAULT_LEVEL;
    const gated = flagsForLevel(level);

    /* 注意 `tolerateUnsolvable`：solver 不可解时 exit(2) 但仍吐合法 JSON，必须先解析。 */
    const r = runSolver(goalShape, { ...opts, extraArgs: gated, tolerateUnsolvable: true });
    if (!r.ok) return { ok: false, reason: r.reason || "unknown", level, gated };

    const steps = r.steps;

    /* 机器需求：从 steps[].op 反推（op → 机器）。**只翻译**，不重算代数。 */
    const needs = new Map();
    for (const s of steps) {
        const m = OP_TO_MACHINE[s && s.op];
        if (m) needs.set(m, (needs.get(m) || 0) + 1);
    }

    /* 闭包：steps 的全体 hash（含 raw 与 goal —— 末节点就是 goal）。
       `raw` 只认 op === "mine"（颜料矿 `mineColor` 不是形状原料，不进 raw）。 */
    const closure = new Set();
    const raw = new Set();
    for (const s of steps) {
        if (!s || typeof s.hash !== "string") continue;
        closure.add(s.hash);
        if (s.op === "mine") raw.add(s.hash);
    }

    return {
        ok: true,
        steps,
        ops: r.ops,
        needs,
        closure,
        raw,
        level,
        gated,
    };
}

/* ═══════════════════════════ 缓存（P-a）═══════════════════════════ */

/** 模块内 memo 的容量上限。一次 run 里见到的目标形状是个位数（一个 goal + 诊断里引用的少数变体），8 够用。 */
export const RECIPE_CACHE_CAPACITY = 8;

/** Map 本身有插入序：命中时 delete+set 把键挪到末尾 ⇒ **LRU**（不是 FIFO）。 */
const RECIPE_CACHE = new Map();

/** 假配方对象的**浅拷贝**：needs/closure/raw 各给一份新的，调用方改了也污染不到缓存。 */
function copyRecipe(r) {
    if (!r || r.ok !== true) return { ...r };
    return {
        ...r,
        steps: r.steps,                       // steps 是 solver 原样输出，只读消费；不深拷
        needs: new Map(r.needs),
        closure: new Set(r.closure),
        raw: new Set(r.raw),
    };
}

/**
 * `recipeFor` 的带缓存版本。key = `${goal}|L${level}`。
 *
 * - **失败也缓存**：不可解目标每次重试都要跑一遍组合爆炸（实测 CgScScCg 单次 1.6s），
 *   缓存失败是这里唯一合理的策略。
 * - **LRU**：容量 8，命中即刷新位置。
 * - **不许持久化到磁盘** —— 磁盘上的配方会成为第二份真值，改了 solver 就悄悄过期。
 *
 * @param {string} goalShape
 * @param {object} [opts] 同 `recipeFor`
 * @returns {ReturnType<typeof recipeFor>}
 */
export function recipeForCached(goalShape, opts = {}) {
    const level = Number.isFinite(opts.level) ? opts.level : DEFAULT_LEVEL;
    const key = `${goalShape}|L${level}`;

    if (RECIPE_CACHE.has(key)) {
        const hit = RECIPE_CACHE.get(key);
        RECIPE_CACHE.delete(key);             // LRU：命中后挪到末尾
        RECIPE_CACHE.set(key, hit);
        return copyRecipe(hit);
    }

    const r = recipeFor(goalShape, opts);
    RECIPE_CACHE.set(key, r);
    while (RECIPE_CACHE.size > RECIPE_CACHE_CAPACITY) {
        const oldest = RECIPE_CACHE.keys().next().value;
        RECIPE_CACHE.delete(oldest);
    }
    return copyRecipe(r);
}

/** 清空缓存（测试用；也是「换 solver 版本后要重算」的唯一入口）。 */
export function clearRecipeCache() {
    RECIPE_CACHE.clear();
}

/** 当前缓存条数（测试/诊断用，只读）。 */
export function recipeCacheSize() {
    return RECIPE_CACHE.size;
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

    /* 需要哪些机器：从 op 名反推（op → 机器）。**只翻译**，不重算代数。
     *
     * ⚠️ 这里**刻意**只认旧的那 7 个 op：`mineColor`/`mix` 是颜料节点（`kind:"pigment"`），
     *    把它们算进「形状产的机器」会改掉既有渲染文本（`CgScScCg` 的 miner 数会从 2 变 4）。
     *    渲染器是已上线的模型的输入，行为冻结在这里；结构化字段 `recipeFor().needs`
     *    用的是完整映射（含颜料），两者口径不同是**有意的**，不是漂移。
     *    机器种类本身仍只有一份：`OP_TO_MACHINE`（模块级）。 */
    const VISIBLE_OPS = new Set(["mine", "cut", "cutQuad", "rotate", "stack", "paint", "paintQuad"]);
    const need = new Map();
    for (const s of recipe.steps) {
        if (!VISIBLE_OPS.has(s.op)) continue;
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

export default {
    solveRecipe, renderRecipe, recipeBlock, SOLVER_PATH,
    recipeFor, recipeForCached, clearRecipeCache, flagsForLevel, OP_TO_MACHINE,
};
