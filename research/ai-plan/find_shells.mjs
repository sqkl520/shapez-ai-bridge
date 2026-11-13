/**
 * find_shells.mjs — 「空壳机器」检测器（离线验证脚本，跑完即删）
 *
 * 需求真值（用户原话）：
 *   「我要的就是你删除空壳，然后查清为什么有空壳，空线路也是」
 *   「输入接着的带子如果不通电（追不到任何矿机/机器源头），这台机器就是空转的」
 *
 * 判据（与主线程手动清理同一套）：
 *   · 矿机：脚下没矿，或输出不通 hub ⇒ 空壳
 *   · 其他机器：输入端没有任何一条「通电」的带子 ⇒ 空壳
 *   · 额外：重复矿机（同一矿片只留离 mixer/painter 最近的一台）
 *
 * 「通电」= 沿上游反向追，能追到一台「脚下有矿的矿机」或一台「已被通电的机器」。
 *   这和 topology.flowReachable 是同一套几何，方向相反。
 *
 * 用法：node research/ai-plan/find_shells.mjs test/fixtures/saves/level9-mixer-obs.json [--json]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    indexOf, at, accepts, flowReachable, inputFed, outputRouted,
    isBelt, isTunnel, rvOf, entryDirOf, exitDirOf, exitCellOf, entryCellOf,
    upstreamAt, tunnelIsSender,
} from "../../src/agent/loop/topology.mjs";
import { slotsOf, beltRvOf } from "../../src/agent/verify_runtime.mjs";
import { DIRV, OPP } from "../../src/ai/belt-rules.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const K = c => `${c[0]},${c[1]}`;

/* ══════════════════════════════ 1. 通电闭包（上游→下游） ══════════════════════════════ */

/**
 * 「这台机器要转起来，几个输入槽必须同时有料？」
 *
 * ★ 这是本检测器唯一一处按建筑类型分叉的判断，也是最容易写错的一处 ★
 *
 * 初版把「有**一路**有料」就当机器能出件 —— 于是 level9 上一条
 * `矿机 → 带 → painter(缺颜色) → 带 → cutter` 的链被整条判成活的，
 * 而主线程手动清理时把 cutter 判成了空壳并删掉。差别就是这里：
 * painter 缺颜色**不产出**，所以它下游一条带子都拿不到货。
 *
 *   · 加工机（cutter / rotater / stacker / painter / mixer）：**全部**输入槽都要有料
 *     （painter 要 shape+color，mixer 要两种颜料 —— 少一样就永远出不了件）
 *   · balancer / merger：**任一路**有料就能出（轮转/合并，本来就是多进一出）
 *   · trash：任一路有料（它只是吞，没有输出）
 *
 * 未知类型保守按「全部」算：宁可少判活（多留一台半成品），不可多判活（把断点当通的）。
 */
function requiredInputs(type, ins) {
    if (type === "balancer" || type === "merger" || type === "trash") return 1;
    return ins.length;
}

/**
 * 从「脚下有矿的矿机」出发，正向推一遍：哪些带子/机器真的在跑。
 *
 * 与 `flowReachable` 共用同一条边判据（`accepts`），只是方向相反。
 * 机器节点需要**重新求值**：下游先拿到货、上游后拿到货的情况在 BFS 里很常见，
 * 所以这里不用「一次性标记」，而是把机器放进重算队列，每次有新带子变活就重推一次。
 */
function poweredClosure(idx, oreAt, hubReach) {
    const liveBelt = new Set();
    const liveMachine = new Set();

    const outlets = e => {
        if (isBelt(e)) return [{ cell: exitCellOf(e), dir: exitDirOf(e) }];
        if (isTunnel(e)) return [];                      // 本夹具无隧道；留白不猜
        const s = slotsOf(e.type, e.variant, e.x, e.y, e.r || 0, beltRvOf(e));
        return s ? s.outputs.map(o => ({ cell: o.cell, dir: o.dir })) : [];
    };

    const liveInCount = m => {
        const s = slotsOf(m.type, m.variant, m.x, m.y, m.r || 0, beltRvOf(m));
        const ins = (s && s.inputs) || [];
        return {
            total: ins.length,
            live: ins.filter(i => { const b = at(idx, i.cell); return b && liveBelt.has(b.uid); }).length,
        };
    };

    /* 队列里只放「需要重算的机器 uid」；带子的转发在标记时直接递归。 */
    const pendingM = new Set();
    const mq = [];

    const touchMachine = uid => {
        if (liveMachine.has(uid)) return;
        if (pendingM.has(uid)) return;
        pendingM.add(uid);
        mq.push(uid);
    };

    const emit = e => {
        for (const o of outlets(e)) {
            if (!accepts(idx, o.cell, o.dir).ok) continue;
            const dst = at(idx, o.cell);
            if (!dst || dst.uid === e.uid) continue;
            if (isBelt(dst)) {
                if (liveBelt.has(dst.uid)) continue;
                liveBelt.add(dst.uid);
                /* 这格带子活了 ⇒ 它下游的机器可能要重算 */
                for (const o2 of outlets(dst)) {
                    if (!accepts(idx, o2.cell, o2.dir).ok) continue;
                    const d2 = at(idx, o2.cell);
                    if (d2 && d2.uid !== dst.uid && !isBelt(d2)) touchMachine(d2.uid);
                }
            } else {
                touchMachine(dst.uid);
            }
        }
    };

    for (const e of idx.ent) {
        if (e.type === "miner") {
            /* ★ 种子必须同时满足两个条件：脚下有矿 **且** 输出能到 hub ★
             *
             * 只用「脚下有矿」当种子时，一条`矿机 → balancer → cutter → 垃圾场`的
             * 死链上的 balancer 会被判成「有料在跑」，于是我自己把它从空壳名单里漏掉
             * —— 而主线程手动清理时把它删了（level9 的 10508/10509）。
             *
             * 判据是一致的：矿机「输出通不到 hub」本身就是空壳（footprint 判据之一），
             * 一台空壳矿机不可能给下游供料。所以它的产物不算「料」。
             */
            if (oreAt.has(K([e.x, e.y])) && hubReach.has(e.uid)) {
                liveMachine.add(e.uid);
                emit(e);
            }
            continue;
        }
        if (!isBelt(e) && e.type !== "hub") touchMachine(e.uid);
    }

    while (mq.length) {
        const uid = mq.shift();
        pendingM.delete(uid);
        if (liveMachine.has(uid)) continue;
        const m = idx.byUid.get(uid);
        if (!m) continue;
        const c = liveInCount(m);
        if (c.total === 0) continue;                     // 无输入槽的机器：不进这条链
        if (c.live < requiredInputs(m.type, new Array(c.total))) continue;
        liveMachine.add(uid);
        emit(m);
    }
    return { liveBelt, liveMachine };
}

/* ══════════════════════════════ 2. 矿片聚类（找重复矿机） ══════════════════════════════ */

function oreClusters(resources) {
    const ore = new Map();
    for (const r of resources || []) if (Array.isArray(r)) ore.set(K([r[0], r[1]]), r[2]);
    const seen = new Set();
    const clusters = [];
    for (const [k, kind] of ore) {
        if (seen.has(k)) continue;
        const stack = [k]; seen.add(k);
        const cells = [];
        while (stack.length) {
            const cur = stack.pop(); cells.push(cur);
            const [x, y] = cur.split(",").map(Number);
            for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const nk = K([x + d[0], y + d[1]]);
                if (ore.has(nk) && ore.get(nk) === kind && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
            }
        }
        clusters.push({ kind, cells, set: new Set(cells) });
    }
    return { ore, clusters };
}

/* ══════════════════════════════ 3. 主检测 ══════════════════════════════ */

export function findShells(obs, opts = {}) {
    const idx = indexOf(obs);
    const { ore, clusters } = oreClusters(obs.resources);
    const hubSet = flowReachable(obs, idx);
    const { liveBelt, liveMachine } = poweredClosure(idx, ore, hubSet);
    const hub = idx.ent.find(e => e.type === "hub");

    const shells = [];
    const kept = [];
    const machines = idx.ent.filter(e => !isBelt(e) && e.type !== "hub");

    for (const m of machines) {
        const sl = slotsOf(m.type, m.variant, m.x, m.y, m.r || 0, beltRvOf(m));
        const ins = (sl && sl.inputs) || [];
        const outs = (sl && sl.outputs) || [];
        const inLive = ins.filter(i => { const b = at(idx, i.cell); return b && liveBelt.has(b.uid); });
        const inAny = ins.filter(i => at(idx, i.cell));
        const outAny = outs.filter(o => at(idx, o.cell));

        const base = {
            uid: m.uid, type: m.type, cell: [m.x, m.y], r: m.r || 0,
            in_slots: ins.length, in_fed_any: inAny.length, in_fed_live: inLive.length,
            out_slots: outs.length, out_routed: outAny.length,
            on_ore: ore.get(K([m.x, m.y])) || null,
            reaches_hub: hubSet.has(m.uid),
        };

        if (m.type === "miner") {
            if (!base.on_ore) {
                shells.push({ ...base, category: "shell", why: `矿机脚下没矿（${m.x},${m.y} 不在 resources 里）—— 永久零产出` });
                continue;
            }
            if (!hubSet.has(m.uid)) {
                shells.push({ ...base, category: "shell", why: `矿机压在 ${base.on_ore} 上，但输出一路到不了 hub（这一路断在某处，产物只会堵在带子上）` });
                continue;
            }
            kept.push({ ...base, why: `矿机压在 ${base.on_ore} 上，输出能到 hub` });
            continue;
        }

        /* 非矿机：输入端有没有「通电」的带子 */
        if (ins.length === 0) {
            /* 无输入槽的机器 —— 不该删，留给人工 */
            kept.push({ ...base, why: "没有输入槽，本检测器不判" });
            continue;
        }
        const need = requiredInputs(m.type, ins);
        if (inLive.length < need) {
            shells.push({
                ...base, category: "shell",
                why: `输入端 ${ins.length} 个槽里 ${inAny.length} 个接着带子、${inLive.length} 个通电，`
                    + `${m.type} 需要 ${need} 路同时有料才出件 —— 空转`,
            });
            continue;
        }
        kept.push({ ...base, why: `输入端 ${inLive.length}/${ins.length} 个槽通电（需 ${need} 路）` });
    }

    /* ── 重复矿机：同一矿片上留哪台 ──
       手动清理的规则是「只留离 mixer/painter 最近的一台」。
       这里给两种口径，便于对上 ground truth：
         anchor = 最近的那台 mixer/painter（没有就退回 hub） */
    const anchors = idx.ent.filter(e => e.type === "mixer" || e.type === "painter");
    const anchorList = anchors.length ? anchors : (hub ? [hub] : []);
    const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
    const duplicates = [];
    for (const cl of clusters) {
        const ms = idx.ent.filter(e => e.type === "miner" && cl.set.has(K([e.x, e.y])));
        if (ms.length <= 1) continue;
        const scored = ms.map(m => ({
            m,
            d: anchorList.length ? Math.min(...anchorList.map(a => dist([m.x, m.y], [a.x, a.y]))) : 0,
            live: liveMachine.has(m.uid),
            hub: hubSet.has(m.uid),
        })).sort((a, b) => (b.hub - a.hub) || (b.live - a.live) || (a.d - b.d) || (a.m.uid - b.m.uid));
        const keep = scored[0];
        for (const s of scored.slice(1)) {
            duplicates.push({
                uid: s.m.uid, type: "miner", cell: [s.m.x, s.m.y], on_ore: cl.kind,
                category: "duplicate", why: `同一片 ${cl.kind}（${cl.cells.length} 格）上还有 ${ms.length} 台矿机；最近的一台是 uid=${keep.m.uid}@(${keep.m.x},${keep.m.y})（距 mixer/painter ${keep.d} 格）`,
                anchor_uid: keep.m.uid, anchor_cell: [keep.m.x, keep.m.y],
            });
        }
    }

    /* ── 废带子：两种口径，**默认用级联** ──
     *
     * ① 级联（cascade）—— 这就是主线程手动清理明写的那一步：
     *    「删完之后，再把**下游指向已删机器**的带子也删掉」。
     *    所以这里**只沿下游**走，不加上游判据。迭代到不动点。
     *
     *    实测对齐（clean → purged/live，同一轮清理）：人工删了 54 台机器 + 21 条带子，
     *    本函数在同样输入上给出 54 台 + **21 条**，逐 uid 相等。
     *
     *    ⚠️ 试过「上游源头被删也算」的双向版本，结果 21 → 48，多删 27 条。
     *    那 27 条是**人工刻意保留**的：它们的上游是一台被删的机器，但下游一路通到 hub，
     *    属于「已经铺好的交付走廊」，下一轮直接复用（level9 的紫线正是接在上面）。
     *    也就是说「上游没了」在用户眼里不是删除理由 —— 只有「下游没了」才是。
     *
     * ② 「不通电」（sourceless）：
     *    上游追不到任何能到 hub 的矿机。这一档在 level9 上是 **158/159** ——
     *    比人工清理的 21 条多出 7 倍。人工保留了大量「到得了 hub、但眼下没来料」
     *    的走廊带（它们是可复用资产，不是垃圾）。
     *    所以 sourceless **不能**当作删除判据，只作为信息输出（= 用户说的「空线路」）。
     *
     * 两条口径都输出，`orphanBelts` 给的是级联那一份（与「删完再拆下游」同构），
     * `sourcelessBelts` 给的是「不通电」那一份（= 用户定义的空线路）。 */
    const removedMachineSet = new Set([...shells, ...duplicates].map(s => s.uid));
    const belts = idx.ent.filter(isBelt);
    const orphanBelts = [];
    {
        const gone = new Set(removedMachineSet);
        let changed = true;
        while (changed) {
            changed = false;
            for (const b of belts) {
                if (gone.has(b.uid)) continue;
                const dst = at(idx, exitCellOf(b));
                if (dst && gone.has(dst.uid)) { gone.add(b.uid); orphanBelts.push(b.uid); changed = true; }
            }
        }
    }
    const sourcelessBelts = belts.filter(b => !liveBelt.has(b.uid)).map(b => b.uid);

    const deadBelts = [];
    for (const b of belts) {
        const powered = liveBelt.has(b.uid);
        const toHub = hubSet.has(b.uid);
        if (powered && toHub) continue;
        deadBelts.push({
            uid: b.uid, cell: [b.x, b.y],
            powered, to_hub: toHub,
            why: !powered && !toHub ? "既没上游源头、也到不了 hub"
                : !powered ? "有下游方向但上游追不到源头（无头线）"
                    : "有上游来料但到不了 hub（断头线，货会堵在这里）",
        });
    }

    return {
        obs_entity_count: idx.ent.length,
        machines: machines.length,
        belts: belts.length,
        shells, duplicates, kept,
        orphanBelts,          // ★ 级联口径：跟着被删机器一起该拆的带子（=人工口径）
        deadBelts,            // 信息口径：不通电 / 到不了 hub（远大于人工口径，别当删除判据）
        live: { belts: liveBelt.size, machines: liveMachine.size },
        hubReachable: hubSet.size,
    };
}

/* ══════════════════════════════ 4. CLI ══════════════════════════════ */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const file = process.argv[2] || path.join(HERE, "../../test/fixtures/saves/level9-mixer-obs.json");
    const asJson = process.argv.includes("--json");
    const obs = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
    const r = findShells(obs);
    if (asJson) { console.log(JSON.stringify(r, null, 1)); process.exit(0); }

    console.log(`世界：${file}`);
    console.log(`实体 ${r.obs_entity_count} / 机器 ${r.machines} / 带子 ${r.belts}`);
    console.log(`通电：带子 ${r.live.belts}，机器 ${r.live.machines}；能到 hub 的实体 ${r.hubReachable}`);
    console.log("");
    console.log(`空壳机器 ${r.shells.length} 台：`);
    for (const s of r.shells) console.log(`  #${s.uid} ${s.type} @(${s.cell[0]},${s.cell[1]}) r=${s.r}  — ${s.why}`);
    const shellSet = new Set(r.shells.map(s => s.uid));
    const dupOnly = r.duplicates.filter(d => !shellSet.has(d.uid));
    const dupInShell = r.duplicates.length - dupOnly.length;
    console.log("");
    console.log(`重复矿机标记 ${r.duplicates.length} 台（其中 ${dupInShell} 台本身已被判为空壳，${dupOnly.length} 台是额外发现）：`);
    for (const d of (dupOnly.length ? dupOnly : r.duplicates)) {
        console.log(`  #${d.uid} miner @(${d.cell[0]},${d.cell[1]})  — ${d.why}`);
    }
    if (!dupOnly.length) console.log("  （无额外发现 —— 重复矿机在 level9 上必然也是空壳：多出来的那台输出接不进产线）");
    console.log("");
    console.log(`保留 ${r.kept.length} 台：`);
    for (const k of r.kept) console.log(`  #${k.uid} ${k.type} @(${k.cell[0]},${k.cell[1]})  — ${k.why}`);
    console.log("");
    console.log(`废带子 ${r.orphanBelts.length} 条（级联口径：下游机器/带子被删，跟着该拆）`);
    console.log(`信息口径：不通电或到不了 hub 的共 ${r.deadBelts.length} 条`
        + `（无源头 ${r.deadBelts.filter(b => !b.powered).length} / 到不了 hub ${r.deadBelts.filter(b => b.powered && !b.to_hub).length}）`);
    console.log("  注意：信息口径远大于级联口径 —— 人工清理保留了大量「暂时没来料、但到得了 hub」的走廊带。");
}
