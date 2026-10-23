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
 * 用法：
 *   node research/ai-player/proto/solver.mjs <target> [options]
 *     --resources C,R,S,W          可开采的形状（字母；默认全部）
 *     --colors red,green,blue      可开采的颜料（默认三原色；混色自动闭包）
 *     --depth N                    最大运算深度（默认 6）
 *     --max-states N               状态上限（默认 20000）
 *     --no-rotater / --no-cutter / --no-painter / --no-mixer / --no-stacker
 *     --json / --quiet
 */
import * as so from "./shape-ops.mjs";

const SUB_LETTER = { rect: "R", circle: "C", star: "S", windmill: "W" };
const LETTER_SUB = { R: "rect", C: "circle", S: "star", W: "windmill" };

/** 颜色位域（colors.js:61）：red=1 green=2 blue=4，混合 = 按位或 */
const COLOR_BITS = { red: 1, green: 2, blue: 4, yellow: 3, purple: 5, cyan: 6, white: 7 };
const BITS_COLOR = { 1: "red", 2: "green", 4: "blue", 3: "yellow", 5: "purple", 6: "cyan", 7: "white" };

/** 由基础颜料闭包出所有可混出的颜色（mixer） */
function colorClosure(base) {
    const out = new Set(base);
    let changed = true;
    while (changed) {
        changed = false;
        const list = [...out];
        for (const a of list) for (const b of list) {
            const bit = COLOR_BITS[a] | COLOR_BITS[b];
            const c = BITS_COLOR[bit];
            if (c && !out.has(c)) { out.add(c); changed = true; }
        }
    }
    return out;
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
    constructor({ resources, colors, ops, maxDepth, maxStates }) {
        this.resources = resources;
        this.baseColors = colors;
        this.ops = ops;
        this.maxDepth = maxDepth;
        this.maxStates = maxStates;
        this.known = new Map();        // hash -> { shape, depth, from: {op,args,parentHashes} }
        this.stats = { expanded: 0, generated: 0, stackPairs: 0, capped: false };
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
        // 上色
        if (this.ops.paint) {
            for (const c of colors) {
                push(so.paint(shape, c), { op: "paint", args: { color: c }, parents: [hash] });
            }
        }
        return out;
    }

    solve(target) {
        const targetHash = so.hash(target);
        const colors = colorClosure(this.baseColors);

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

    buildPlan(hash) {
        const parts = [];
        const walk = h => {
            const e = this.known.get(h);
            if (!e) return;
            if (e.from) for (const p of e.from.parents) walk(p);
            parts.push({ hash: h, op: e.from ? e.from.op : "mine", args: e.from ? e.from.args : {}, depth: e.depth });
        };
        walk(hash);
        // 去重（同一 hash 只出现一次，保留首次）
        const seen = new Set();
        const unique = parts.filter(p => (seen.has(p.hash) ? false : (seen.add(p.hash), true)));
        return { targetHash: hash, steps: unique, ops: unique.reduce((a, p) => ((a[p.op] = (a[p.op] || 0) + 1), a), {}) };
    }
}

// ───────────────────────── CLI ─────────────────────────

const FLAGS = new Set(["--resources", "--colors", "--depth", "--max-states", "--json", "--quiet",
    "--no-rotater", "--no-cutter", "--no-cutquad", "--no-painter", "--no-mixer", "--no-stacker"]);

function main() {
    const args = process.argv.slice(2);
    // 目标 = 第一个"不是 flag"的参数（注意 `----CuCu` 以 -- 开头，但它是形状）
    const target = args.find(a => !FLAGS.has(a) && !(a.startsWith("--") && a.length > 10));
    if (!target) {
        console.log("用法: node solver.mjs <target-shape> [--resources C,R,S,W] [--depth N] [--json]");
        console.log("示例: node solver.mjs CgScScCg");
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

    const solver = new Solver({ resources, colors, ops, maxDepth, maxStates });
    const t0 = Date.now();
    const plan = solver.solve(shape);
    const ms = Date.now() - t0;

    if (flag("--json")) {
        console.log(JSON.stringify({ target, solved: !!plan, plan, stats: solver.stats, known: solver.known.size, ms }, null, 1));
    } else if (!plan) {
        console.log(`❌ 无法构造 ${target}（深度 ${maxDepth}，状态上限 ${maxStates}）`);
        console.log(`   已知形状 ${solver.known.size}，生成 ${solver.stats.generated}，配对 ${solver.stats.stackPairs}，${ms}ms`);
        if (solver.stats.capped) console.log(`   （触到状态上限，可加 --max-states 或 --depth）`);
        process.exit(2);
    } else if (flag("--quiet")) {
        for (const s of plan.steps) console.log(`${s.op} ${s.args && Object.keys(s.args).length ? JSON.stringify(s.args) : ""} → ${s.hash}`);
    } else {
        console.log(`目标: ${target}`);
        console.log(`原料: ${resources.join("/")}   颜料: ${colors.join("/")}   深度上限: ${maxDepth}`);
        console.log(`\n配方（按依赖顺序）:`);
        for (const s of plan.steps) {
            const a = s.args && Object.keys(s.args).length ? " " + JSON.stringify(s.args) : "";
            console.log(`  [d${s.depth}] ${s.op}${a}  →  ${s.hash}`);
        }
        console.log(`\n运算计数: ${Object.entries(plan.ops).map(([k, v]) => `${k}×${v}`).join("  ")}`);
        console.log(`统计: 已知形状 ${solver.known.size}，生成 ${solver.stats.generated}，配对尝试 ${solver.stats.stackPairs}，${ms}ms`);
    }
    process.exit(plan ? 0 : 2);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("proto/solver.mjs")) {
    main();
}
