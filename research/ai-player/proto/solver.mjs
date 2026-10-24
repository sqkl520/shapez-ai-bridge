/**
 * solver.mjs — 配方求解器：从目标形状反推生产 DAG（离线、零依赖）。
 *
 * 依据（全部已核证，见 facts/）：
 *   · 形状代数与运算语义 —— facts/ops-semantics-VERIFIED.md（实现见 proto/shape-ops.mjs）
 *   · 地图真实原料 —— facts/offline-map-reproduction.md
 *   · 运算的等级解锁 —— facts/human-strategies.md §2.2
 *     （cutter L1、rotater L4、painter L6、mixer L8、stacker L10）
 *
 * 算法：**前向 BFS**（不是反向搜索）。
 *   原因（实测教训）：切割是有损的 —— 给定一个"半形状"，有无穷多个完整形状能切出它。
 *   反向搜索必须猜"另一半是什么"，猜错就会造出循环或错误解。
 *   前向 BFS 从原料出发枚举所有可达形状，遇到目标即返回，**不存在猜测**。
 *   公开求解器（TomasSirgedas/Shapez-solver）也是这么做的（预计算可达表）。
 *
 * 剪枝：
 *   · 形状按 hash 去重（同一形状只保留首次到达的最短路径）
 *   · 旋转只在"目标需要"时展开（rotate 后 hash 相同的跳过）
 *   · stack 只配对"象限不重叠"的两个形状（其余必然失败）—— 这砍掉了绝大部分组合
 *   · 深度上限 + 状态上限
 *
 * ★ 颜料是**一等节点**（`mineColor` / `mix`），不是 `paint` 的 args 方言 ★
 *   旧版把颜料折进 `paint {color}`，产出的 plan 里没有颜料来源 ⇒ 布局层无从布线
 *   （painter 的 color 槽在 GEOMETRY 表1 里是**真实输入槽**，独立物流；见 GEOMETRY 表3 规则 6）。
 *   现在每台上色器的 `inputs = [形状 hash, 颜料节点 id]`，且间色（cyan/yellow/purple）
 *   展开成显式 `mix` 节点。颜料节点走**独立命名空间** `color:<name>`，与 shape key 空间不相交
 *   （实测 `so.parse("red")` 直接抛错 ⇒ 不可能撞 shape hash）。
 *   契约与消费方（P3 布局 / P8 映射）见 `solver-README.md` §4。
 *
 * 用法：
 *   node research/ai-player/proto/solver.mjs <target> [options]
 *     --resources C,R,S,W          可开采的形状（字母；默认全部）
 *     --colors red,green,blue      可开采的颜料（默认三原色；混色自动闭包）
 *     --depth N                    最大运算深度（默认 6）
 *     --max-states N               状态上限（默认 20000）
 *     --no-rotater / --no-cutter / --no-painter / --no-mixer / --no-stacker
 *     --no-pigments                回到旧行为：paint 不带颜料输入（**仅供对照/回归**，产物不可布）
 *     --json / --quiet / --replay
 */
import * as so from "./shape-ops.mjs";

const SUB_LETTER = { rect: "R", circle: "C", star: "S", windmill: "W" };
const LETTER_SUB = { R: "rect", C: "circle", S: "star", W: "windmill" };

/** 颜色位域（colors.js:61）：red=1 green=2 blue=4，混合 = 按位或 */
const COLOR_BITS = { red: 1, green: 2, blue: 4, yellow: 3, purple: 5, cyan: 6, white: 7 };
const BITS_COLOR = { 1: "red", 2: "green", 4: "blue", 3: "yellow", 5: "purple", 6: "cyan", 7: "white" };

/**
 * 颜料节点的 hash 命名空间：`color:<name>`。
 *
 * 为什么必须与 shape key 分开（三条硬理由，都是实测/源码事实）：
 *   1. 形状空间没有「纯颜料」这一型 —— `so.parse("red")` 抛错（shape key 每层恰 8 字符、每象限 [sub][color]）。
 *   2. 借用空形状 token（`"--------"`）会**退化成唯一值**：它是 `parse∘hash` 的不动点，而
 *      `"-r-r-r-r"` 这种「有色空位」被 hash 宋一回 `"--------"` ⇒ 一张图里只能表达**一种**颜料来源。
 *   3. 游戏里颜料是 `ColorItem`（`items/color_item.js:28` `getItemType()==="color"`），**不是** ShapeItem；
 *      布局层的 `channels[].payload` 契约要 shortKey，二者本就不同型。
 * ⇒ 颜料用独立前缀 + 前缀后的颜色名，既不会撞 shape hash，又能被消费方按前缀一眼识别。
 * @param {string} color e.g. "red"
 * @returns {string} e.g. "color:red"
 */
const pigmentHash = color => `color:${color}`;
const isPigmentHash = h => typeof h === "string" && h.startsWith("color:");

/** 由基础颜料闭包出所有可混出的颜色（mixer）：返回 Map<color, [a,b]>（`base` 颜色不在此表） */
function colorClosure(base) {
    const mix = new Map();                       // color -> [a, b]（如何混出来；确定性：字典序最小的一对）
    const out = new Set(base);
    let changed = true;
    while (changed) {
        changed = false;
        const list = [...out];
        for (const a of list) for (const b of list) {
            if (COLOR_BITS[a] === undefined || COLOR_BITS[b] === undefined) continue;
            const bit = COLOR_BITS[a] | COLOR_BITS[b];
            const c = BITS_COLOR[bit];
            if (!c || out.has(c)) continue;
            // 记下混色配方（两侧都是已知可得的颜色）；同色只混一次
            if (a !== b) { mix.set(c, [a, b].sort()); }
            out.add(c);
            changed = true;
        }
    }
    return { colors: out, mix };
}


/** 象限占用集合（单层）；多层返回 null（stack 只处理单层） */
function quadsOf(shape) {
    if (shape.layers.length !== 1) return null;
    const s = new Set();
    for (let i = 0; i < 4; i++) if (shape.layers[0][i]) s.add(i);
    return s;
}

function disjoint(a, b) {
    for (const q of a) if (b.has(q)) return false;
    return true;
}

class Solver {
    constructor({ resources, colors, ops, maxDepth, maxStates, pigments = true }) {
        this.resources = resources;
        this.baseColors = colors;
        this.ops = ops;
        this.maxDepth = maxDepth;
        this.maxStates = maxStates;
        this.pigments = pigments;      // false = 旧行为（paint 不带颜料输入），仅供对照
        const clo = colorClosure(colors);
        this.pigmentColors = clo.colors;
        this.pigmentMix = clo.mix;     // color -> [a,b]（间色的显式混法）
        this.known = new Map();        // hash -> { shape, depth, from: {op,args,parents} }
        this.stats = { expanded: 0, generated: 0, stackPairs: 0, capped: false };
    }

    /** 种子的颜料节点（地图上的纯色矿）。**只在 plan 里出现**，不进 BFS 状态空间。 */
    pigmentNode(color, depth = 0) {
        const mix = this.pigmentMix.get(color);
        if (!mix) {
            return { hash: pigmentHash(color), op: "mineColor", args: { color }, inputs: [], parents: [], depth: 0 };
        }
        const a = pigmentHash(mix[0]), b = pigmentHash(mix[1]);
        return { hash: pigmentHash(color), op: "mix", args: { color }, inputs: [a, b], parents: [a, b], depth };
    }

    /** 种子：地图上真实存在的纯形状（四象限同形、无色）。直接构造对象，不经 parse（`W` 字形 parse 无误） */
    seed() {
        const frontier = [];
        for (const letter of this.resources) {
            const sub = LETTER_SUB[letter];
            if (!sub) continue;
            const quads = [0, 1, 2, 3].map(() => ({ sub, color: "uncolored" }));
            const shape = { layers: [quads] };
            const h = so.hash(shape);
            this.known.set(h, { shape, depth: 0, from: null });
            frontier.push(h);
        }
        return frontier;
    }

    /** 从 known 里的形状生成新形状（返回 [{shape, from}]） */
    expand(hash, colors) {
        const entry = this.known.get(hash);
        const shape = entry.shape;
        const out = [];
        const push = (s, from) => { if (s) out.push({ shape: s, from }); };

        // 切割
        if (this.ops.cut) {
            const [l, r] = so.cutHalf(shape);
            push(l, { op: "cut", args: { half: "left" }, parents: [hash] });
            push(r, { op: "cut", args: { half: "right" }, parents: [hash] });
        }
        // cutQuad 是 cutter 的 quad 变体，**L16 才解锁**（human-strategies.md §2.2）——
        // 默认开启会让 solver 用 level 11 拿不到的建筑，产生"看起来对但造不出来"的解。
        if (this.ops.cutQuad) {
            for (const [i, q] of so.cutQuad(shape).entries()) {
                push(q, { op: "cutQuad", args: { quad: i }, parents: [hash] });
            }
        }
        // 旋转
        if (this.ops.rotate) {
            push(so.rotateCW(shape), { op: "rotate", args: { dir: "cw" }, parents: [hash] });
            push(so.rotateCCW(shape), { op: "rotate", args: { dir: "ccw" }, parents: [hash] });
            push(so.rotate180(shape), { op: "rotate", args: { dir: "180" }, parents: [hash] });
        }
        // 上色：**颜料是第二个输入**（painter 的 color 槽是真实槽位，GEOMETRY 表1 / 表3 规则 6）
        //   形状 hash 仍是 BFS 的去重键（颜料不影响产物形状的 hash），所以颜料分支不进状态空间。
        if (this.ops.paint) {
            for (const c of colors) {
                const isMixed = this.pigmentMix.has(c);
                if (isMixed && this.ops.mixer === false) continue;      // --no-mixer：只允许原色
                const parents = this.pigments ? [hash, pigmentHash(c)] : [hash];
                push(so.paint(shape, c), { op: "paint", args: { color: c }, parents });
            }
        }
        return out;
    }


    solve(target) {
        const targetHash = so.hash(target);
        const colors = [...this.pigmentColors];

        let frontier = this.seed();
        if (this.known.has(targetHash)) return this.buildPlan(targetHash);

        for (let depth = 1; depth <= this.maxDepth; depth++) {
            const next = new Set();

            // ① 单输入运算
            for (const h of frontier) {
                this.stats.expanded++;
                for (const { shape, from } of this.expand(h, colors)) {
                    this.stats.generated++;
                    const nh = so.hash(shape);
                    if (this.known.has(nh)) continue;
                    this.known.set(nh, { shape, depth, from });
                    next.add(nh);
                    if (nh === targetHash) return this.buildPlan(nh);
                }
                if (this.known.size > this.maxStates) { this.stats.capped = true; break; }
            }

            // ② 堆叠。两种模式（`stack` 的完整语义，shape_definition.js:538）：
            //    (a) 互补合并：两个单层形状的象限不重叠 → 合成**单层**
            //    (b) 多层堆叠：上下层象限可以重叠 → 直接叠成**新的一层**（≤4 层）
            if (this.ops.stack) {
                // 配对池有界（实测教训：全量 O(n²) 会爆炸；真实配方的输入都是浅形状）
                const pool = [...this.known.entries()]
                    .filter(([, e]) => quadsOf(e.shape) && e.depth <= 3);
                for (let i = 0; i < pool.length; i++) {
                    const [ha, ea] = pool[i];
                    const qa = quadsOf(ea.shape);
                    for (let j = 0; j < pool.length; j++) {
                        if (i === j) continue;
                        const [hb, eb] = pool[j];
                        const qb = quadsOf(eb.shape);

                        // (a) 互补合并（象限不重叠 → 单层）
                        if (disjoint(qa, qb)) {
                            this.stats.stackPairs++;
                            let s;
                            try { s = so.stack(eb.shape, ea.shape); } catch { continue; }
                            const nh = so.hash(s);
                            if (!this.known.has(nh)) {
                                this.known.set(nh, {
                                    shape: s, depth,
                                    from: { op: "stack", args: { merge: true }, parents: [hb, ha] },
                                });
                                next.add(nh);
                                if (nh === targetHash) return this.buildPlan(nh);
                            }
                        }

                        // (b) 多层堆叠：下=eb 下=先有的层，上=ea 叠成新层
                        const totalLayers = eb.shape.layers.length + ea.shape.layers.length;
                        if (totalLayers >= 2 && totalLayers <= 4) {
                            this.stats.stackPairs++;
                            const merged = {
                                layers: [
                                    ...eb.shape.layers.map(l => l.map(q => (q ? { ...q } : null))),
                                    ...ea.shape.layers.map(l => l.map(q => (q ? { ...q } : null))),
                                ].slice(0, 4),
                            };
                            const mh = so.hash(merged);
                            if (!this.known.has(mh)) {
                                this.known.set(mh, {
                                    shape: merged, depth,
                                    from: { op: "stack", args: { layers: true }, parents: [hb, ha] },
                                });
                                next.add(mh);
                                if (mh === targetHash) return this.buildPlan(mh);
                            }
                        }

                        if (this.known.size > this.maxStates) { this.stats.capped = true; break; }
                    }
                    if (this.stats.capped) break;
                }
            }

            frontier = [...next];
            if (!frontier.length || this.stats.capped) break;
        }
        return null;
    }

    /**
     * 从目标 hash 回溯成 **plan steps**（依赖序），并展开颜料节点。
     *
     * 输出每个 step（**新契约**，比旧版多 `inputs`）：
     *   { hash, op, args, depth, inputs:string[] }
     *   · 形状节点：hash = shapez shortKey（mine/cut/cutQuad/rotate/paint/mix/stack 的产物形状）
     *   · 颜料节点：hash = `color:<name>`，op ∈ {mineColor, mix}，inputs = 上游颜料节点
     *   · **inputs = 该节点在布局里必须接上的上游**（形状或颜料），顺序即槽位序：
     *       cut/cutQuad/rotate      → [shape]
     *       paint                   → [shape, pigment]      ← painter: shape←left、color←top
     *       mix                     → [colorA, colorB]      ← mixer: 两个 bottom
     *       stack                   → [lower, upper]        ← stacker: 左格=下层、右格=上层
     *   · `parents` 保留为 `inputs` 的别名（旧消费方兼容；以 inputs 为准）
     *
     * 颜料节点**不进 BFS 状态空间**（它们不是形状），只在这里按需展开 —— 所以
     * 「同一种颜料被多台上色器共用」在 plan 里是**同一个 hash**、可让消费方合并成一台矿机。
     */
    buildPlan(hash) {
        const parts = [];
        const pigmentSeen = new Set();

        /** 递归展开颜料节点（mineColor / mix），depth 记「离矿最远的层数」 */
        const walkPigment = (pHash, atDepth) => {
            if (pigmentSeen.has(pHash)) return;
            pigmentSeen.add(pHash);
            const color = pHash.slice(pigmentHash("").length);
            const node = this.pigmentNode(color);
            // 间色先展开它的两个原色（依赖序）
            if (node.op === "mix") for (const up of node.inputs) walkPigment(up, atDepth);
            parts.push({
                hash: node.hash, op: node.op, args: node.args,
                depth: Math.max(0, atDepth - 1), inputs: node.inputs.slice(), parents: node.inputs.slice(),
                kind: "pigment",
            });
        };

        const walk = h => {
            const e = this.known.get(h);
            if (!e) return;
            const inputs = e.from ? e.from.parents.slice() : [];
            // 先走上游（依赖序）；颜料输入单独展开成颜料节点
            for (const p of inputs) {
                if (isPigmentHash(p)) walkPigment(p, e.depth);
                else walk(p);
            }
            parts.push({
                hash: h, op: e.from ? e.from.op : "mine", args: e.from ? e.from.args : {},
                depth: e.depth, inputs, parents: inputs.slice(), kind: "shape",
            });
        };
        walk(hash);

        // 去重（同一 hash 只出现一次，保留首次）
        const seen = new Set();
        const unique = parts.filter(p => (seen.has(p.hash) ? false : (seen.add(p.hash), true)));
        return {
            targetHash: hash,
            steps: unique,
            ops: unique.reduce((a, p) => ((a[p.op] = (a[p.op] || 0) + 1), a), {}),
            /** 颜料清单（P3/P8 直接可用：每个颜色一条，含它是矿还是混出来的） */
            pigments: unique.filter(p => p.kind === "pigment").map(p => ({
                hash: p.hash, color: p.args.color, from: p.op, inputs: p.inputs.slice(),
            })),
        };
    }
}

// ───────────────────────── 复放（plan → 末节点 hash 必须等于目标） ─────────────────────────

/**
 * 用 shape-ops 把整条 plan **从头复放**一遍，逐节点校验：
 *   · 每个形状节点：它的 op 作用在 `inputs` 的形状上，hash 必须等于该节点声明的 hash
 *   · 每个颜料节点：mineColor → `color:<name>`；mix → 两个上游颜色的位域或
 *   · 每个节点引用的 inputs 必须**先于它出现**（依赖序）
 *   · 末节点 hash === 目标
 * 这一步是 solver 的**自证**（不是假设）：解能出来 ≠ 解能复放（solver-README 的 M4 教训）。
 * @param {object} plan buildPlan 的产物 @param {object} ops shape-ops 模块
 * @returns {{ok:boolean, checks:Array<{id:string,ok:boolean,detail:string}>, steps:number}}
 */
function replayPlan(plan, ops) {
    const checks = [];
    const done = new Map();          // hash → {kind, shape?, color?}
    const say = (id, ok, detail) => checks.push({ id, ok, detail });

    for (const st of plan.steps) {
        const missing = (st.inputs || []).filter(h => !done.has(h));
        if (missing.length) { say(`dep:${st.hash}`, false, `上游未先出现：${missing.join(",")}`); continue; }

        if (st.kind === "pigment") {
            const color = st.args && st.args.color;
            if (st.op === "mineColor") {
                done.set(st.hash, { kind: "pigment", color });
                say(`mineColor:${st.hash}`, st.hash === pigmentHash(color), `color=${color}`);
            } else if (st.op === "mix") {
                const [a, b] = st.inputs.map(h => done.get(h));
                if (!a || !b || a.kind !== "pigment" || b.kind !== "pigment") {
                    say(`mix:${st.hash}`, false, `上游不是颜料：${st.inputs.join(",")}`);
                    continue;
                }
                const bit = COLOR_BITS[a.color] | COLOR_BITS[b.color];
                const got = BITS_COLOR[bit];
                done.set(st.hash, { kind: "pigment", color: got });
                say(`mix:${st.hash}`, got === color, `${a.color} + ${b.color} = ${got}（声明 ${color}）`);
            } else {
                say(`pigment:${st.hash}`, false, `未知颜料 op ${st.op}`);
            }
            continue;
        }

        // 形状节点
        let out;
        try {
            const parents = st.inputs.map(h => done.get(h).shape);
            switch (st.op) {
                case "mine": out = ops.parse(st.hash); break;                       // 矿机产物 = 它采的形状
                case "cut": {
                    const halves = ops.cutHalf(parents[0]);
                    out = st.args.half === "left" ? halves[0] : halves[1];
                    break;
                }
                case "cutQuad": out = ops.cutQuad(parents[0])[st.args.quad | 0]; break;
                case "rotate": {
                    const d = st.args.dir || "cw";
                    out = d === "ccw" ? ops.rotateCCW(parents[0]) : d === "180" ? ops.rotate180(parents[0]) : ops.rotateCW(parents[0]);
                    break;
                }
                case "paint": {
                    // paint 的第二个输入是颜料：只校验它确实是 pigment 节点（颜色已在颜料链上验过）
                    const pig = st.inputs.length > 1 ? done.get(st.inputs[1]) : null;
                    if (pig && pig.kind !== "pigment") throw new Error(`第 2 输入不是颜料节点：${st.inputs[1]}`);
                    if (pig && pig.color !== st.args.color) throw new Error(`颜料颜色不符：节点=${pig.color} args=${st.args.color}`);
                    out = ops.paint(parents[0], st.args.color);
                    break;
                }
                case "stack": out = ops.stack(parents[0], parents[1]); break;        // [0]=下层
                default: throw new Error(`未知 op ${st.op}`);
            }
        } catch (e) {
            say(`apply:${st.hash}`, false, `${st.op}: ${e.message}`);
            continue;
        }
        const got = ops.hash(out);
        done.set(st.hash, { kind: "shape", shape: out });
        say(`apply:${st.hash}`, got === st.hash, `${st.op}() → ${got}（声明 ${st.hash}）`);
    }

    const last = plan.steps[plan.steps.length - 1];
    const lastOk = !!last && last.hash === plan.targetHash;
    say("target", lastOk, `末节点 ${last ? last.hash : "(空)"} vs 目标 ${plan.targetHash}`);

    return { ok: checks.every(c => c.ok), checks, steps: plan.steps.length };
}

// ───────────────────────── CLI ─────────────────────────

const FLAGS = new Set(["--resources", "--colors", "--depth", "--max-states", "--json", "--quiet", "--replay",
    "--no-rotater", "--no-cutter", "--no-cutquad", "--no-painter", "--no-mixer", "--no-stacker", "--no-pigments"]);

function main() {
    const args = process.argv.slice(2);
    // 目标 = 第一个"不是 flag"的参数（注意 `----CuCu` 以 -- 开头，但它是形状）
    const target = args.find(a => !FLAGS.has(a) && !(a.startsWith("--") && a.length > 10));
    if (!target) {
        console.log("用法: node solver.mjs <target-shape> [--resources C,R,S,W] [--depth N] [--json] [--replay]");
        console.log("示例: node solver.mjs CgScScCg --no-cutquad --replay");
        console.log("      node solver.mjs ----CuCu");
        process.exit(1);
    }
    const flag = n => args.includes(n);
    const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

    const resources = val("--resources", "C,R,S,W").split(",").map(s => s.trim()).filter(Boolean);
    const colors = val("--colors", "red,green,blue").split(",").map(s => s.trim()).filter(Boolean);
    const ops = {
        cut: !flag("--no-cutter"),
        cutQuad: !flag("--no-cutquad"),
        rotate: !flag("--no-rotater"),
        paint: !flag("--no-painter"),
        mixer: !flag("--no-mixer"),
        stack: !flag("--no-stacker"),
    };
    const maxDepth = parseInt(val("--depth", "7"), 10);
    const maxStates = parseInt(val("--max-states", "150000"), 10);

    let shape;
    try { shape = so.parse(target); }
    catch (e) { console.error(`❌ 无法解析目标形状 "${target}": ${e.message}`); process.exit(1); }

    const solver = new Solver({
        resources, colors, ops, maxDepth, maxStates,
        pigments: !flag("--no-pigments"),
    });
    const t0 = Date.now();
    const plan = solver.solve(shape);
    const ms = Date.now() - t0;
    const replay = plan && flag("--replay") ? replayPlan(plan, so) : null;

    if (flag("--json")) {
        console.log(JSON.stringify({
            target, solved: !!plan, plan,
            replay: replay ? { ok: replay.ok, checks: replay.checks, steps: replay.steps } : undefined,
            stats: solver.stats, known: solver.known.size, ms,
        }, null, 1));
        if (replay && !replay.ok) process.exit(3);
    } else if (!plan) {
        console.log(`❌ 无法构造 ${target}（深度 ${maxDepth}，状态上限 ${maxStates}）`);
        console.log(`   已知形状 ${solver.known.size}，生成 ${solver.stats.generated}，配对 ${solver.stats.stackPairs}，${ms}ms`);
        if (solver.stats.capped) console.log(`   （触到状态上限，可加 --max-states 或 --depth）`);
        process.exit(2);
    } else if (flag("--quiet")) {
        for (const s of plan.steps) {
            const a = s.args && Object.keys(s.args).length ? JSON.stringify(s.args) : "";
            console.log(`${s.op} ${a} ${(s.inputs || []).length ? "← [" + s.inputs.join(", ") + "] " : ""}→  ${s.hash}`);
        }
        if (replay) {
            for (const c of replay.checks) if (!c.ok) console.log(`✗ ${c.id}: ${c.detail}`);
            console.log(replay.ok ? "replay OK" : "replay FAILED");
            if (!replay.ok) process.exit(3);
        }
    } else {
        console.log(`目标: ${target}`);
        console.log(`原料: ${resources.join("/")}   颜料: ${colors.join("/")}（混色自动闭包）   深度上限: ${maxDepth}`);
        console.log(`\n配方（按依赖顺序；← 是**必须接上的上游**，顺序即槽位序）:`);
        for (const s of plan.steps) {
            const a = s.args && Object.keys(s.args).length ? " " + JSON.stringify(s.args) : "";
            const ins = (s.inputs || []).length ? `  ← [${s.inputs.join(", ")}]` : "";
            console.log(`  [d${s.depth}] ${s.op}${a}${ins}  →  ${s.hash}`);
        }
        console.log(`\n运算计数: ${Object.entries(plan.ops).map(([k, v]) => `${k}×${v}`).join("  ")}`);
        if (plan.pigments.length) {
            console.log(`颜料来源（${plan.pigments.length}）:`);
            for (const p of plan.pigments) console.log(`  ${p.color.padEnd(7)} ${p.from === "mix" ? "mix(" + p.inputs.map(h => h.replace(/^color:/, "")).join(" + ") + ")" : "mineColor（地图纯色矿）"}`);
        }
        if (replay) {
            const bad = replay.checks.filter(c => !c.ok);
            console.log(`\n复放（shape-ops 逐节点重算）：${replay.ok ? "✅ 全链通过" : `❌ ${bad.length} 处失败`}`);
            for (const c of replay.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.id}  ${c.detail}`);
            if (!replay.ok) process.exit(3);
        }
        console.log(`\n统计: 已知形状 ${solver.known.size}，生成 ${solver.stats.generated}，配对尝试 ${solver.stats.stackPairs}，${ms}ms`);
    }
    process.exit(plan ? 0 : 2);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("proto/solver.mjs")) {
    main();
}
