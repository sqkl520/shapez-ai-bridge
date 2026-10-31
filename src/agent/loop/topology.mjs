/**
 * loop/topology.mjs — 结构层诊断的**唯一几何真值**（P-a0）。
 *
 * 这个文件只回答拓扑问题，不判断「在造什么形状」：
 *   · 一条带子/隧道往哪出、往哪进；
 *   · 某个格子上是什么、它收不收这个来向的货；
 *   · 从某处顺着货流跑下去，终点是什么；
 *   · 哪些实体能影响 hub。
 *
 * ## 为什么单独一个文件
 *
 * `loop.mjs` 里的 `buildIndex` / `hubReachable` / `upstreamAt` / `inputFed` / `outputRouted`
 * 原本是私有的、只服务于 `diagnose()` 的 ①② 两段。P-a0 要把它们变成**可单测的纯函数**，
 * 并且让结构层诊断与语义层（P-a）共用同一份几何 —— 这个项目已经因为「同一件事两份实现」
 * 出过三次事故（见 `research/ai-plan/tmp/DIAGNOSE-BASELINE.md` §10）。
 *
 * ## 三条被实测钉死的几何事实（不要再「简化」它们）
 *
 * 1. **隧道不能用 `beltExit` / `beltEntry`**。`slotsOf("underground_belt", …)` 返回 `null`，
 *    而 `beltExit(rv=1, r=0)` 会得到 `"left"` —— 那是弯带的语义，套到隧道上是错的。
 *    隧道的 `rotation_variant` 是 **sender(0)/receiver(1)** 位，方向只看 `r`：
 *        `exitDirOf(t)  = dirOfRotation(t.r)`
 *        `entryDirOf(t) = OPP[dirOfRotation(t.r)]`
 *    依据：`buildings/underground_belt.js:270-300`（sender 的 acceptor 在局部 bottom、
 *    receiver 的 ejector 在局部 top），以及 `systems/underground_belt.js:240-290`
 *    （sender 沿 `localDirectionToWorld(top)` 搜 1..5 格找 receiver）。
 *
 * 2. **`byCell` 必须是 footprint 级**。hub 是 4×4，机器是 2×1；只用 origin 建索引时，
 *    「出口落进 hub 占地」的带子会被误判成死端（L4 上 6 条，实测 8 vs 2）。
 *
 * 3. **机器入口判据是「落点格 == 槽位本体格」**，不是「落点格 == 槽位邻接格」。
 *    `slotsOf` 返回的 `{slot, dir, cell}` 里：`slot` = 槽位所在的本体格，
 *    `cell` = 本体格 + DIRV[dir] = 上游带子所在的那一格（approach）。
 *    游戏判的是本体格：`belt_path.js:219-275` 的 `findMatchingSlot(worldToLocalTile(ejectSlotTargetWsTile), …)`，
 *    其中 `ejectSlotTargetWsTile` 就是**落点格**。
 *    写错成 approach 格，L4 上机器类误拒收会从 **2** 条涨到 **14** 条 —— 2×1 机器上尤其致命
 *    （cutter/balancer 的两格本体里只有一格带槽）。
 *
 * ## 判据的独立验证（不是自证）
 *
 * `accepts()` 在 L5 上与**游戏自己**的 `debug_items.paths[].boundAcceptor` 对拍：
 * 18/20 条 path 一致，2 条不一致的两条 path 落在 obs 区域外（末格 (60,-44)/(61,-47)
 * 不在 `entities[]` 里），是观测覆盖问题，不是判据问题。见 `topology.test.mjs`。
 *
 * 零依赖（只用 node 内置 + 仓库内只读模块），无 IO，无副作用。
 */
import { DIRV, OPP, ORDER, beltEntry, beltExit } from "../../ai/belt-rules.mjs";
import { templateByBuildingVariant } from "../../ai/op-templates.mjs";
import { slotsOf, beltRvOf } from "../verify_runtime.mjs";

/* ══════════════════════════════════════════════════════════════════════════
 * 0. 小工具
 * ══════════════════════════════════════════════════════════════════════════ */

export const K = c => `${c[0]},${c[1]}`;
const IN_CELL = c => Array.isArray(c) && c.length >= 2;

/** 实体在 obs 里声明的旋转变体；belt 缺字段时按 `code-1` 回退（`belt-rules.mjs` 命题 A）。 */
export const rvOf = e => (typeof e.rotation_variant === "number" ? e.rotation_variant : (e.code - 1));

export const isTunnel = e => !!e && e.type === "underground_belt";
export const isBelt = e => !!e && e.type === "belt";

/** 隧道是 sender（入口）还是 receiver（出口）。rv=0 → sender，rv=1 → receiver。 */
export function tunnelIsSender(e) {
    return isTunnel(e) && rvOf(e) === 0;
}

/**
 * 角度 → 世界方位。0→top、90→right、180→bottom、270→left。
 * 与 `belt-rules.mjs#angleToDir` 同口径（量化到最近象限，非 0/90/180/270 也给合法值）。
 */
export function dirOfRotation(deg) {
    const a = Number.isFinite(Number(deg)) ? Number(deg) : 0;
    return ORDER[(((Math.round(a / 90) % 4) + 4) % 4)];
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 出入口方向 / 出入口格
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 实体的**出口方向**（货从这里离开本格的方向）。带子按 rv+r 算；隧道只看 r；
 * 机器没有单一出口（它有多个槽），返回 null —— 调用方应改用 `slotsOf().outputs`。
 */
export function exitDirOf(e) {
    if (!e) return null;
    if (isBelt(e)) return beltExit(rvOf(e), e.r || 0);
    if (isTunnel(e)) return dirOfRotation(e.r || 0);
    return null;
}

/** 实体的**入口方向**（货从哪个方位进入本格）。隧道 = 出口的反面。 */
export function entryDirOf(e) {
    if (!e) return null;
    if (isBelt(e)) return beltEntry(rvOf(e), e.r || 0);
    if (isTunnel(e)) return OPP[dirOfRotation(e.r || 0)];
    return null;
}

/** 出口格（origin + DIRV[出口方向]）。带子/隧道以外返回 null。 */
export function exitCellOf(e) {
    const d = exitDirOf(e);
    if (!d) return null;
    return [e.x + DIRV[d][0], e.y + DIRV[d][1]];
}

/** 入口格（origin + DIRV[入口方向]）。带子/隧道以外返回 null。 */
export function entryCellOf(e) {
    const d = entryDirOf(e);
    if (!d) return null;
    return [e.x + DIRV[d][0], e.y + DIRV[d][1]];
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 索引（footprint 级）
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * obs → `{ent, byUid, byCell}`。**`byCell` 是 footprint 级的**：
 * 一台 2×1 的 cutter 会在 (x,y) 与 (x+1,y) 都能查到；hub 的 4×4 全部展开。
 *
 * 重叠时**先出现的实体赢**（按 obs.entities 的顺序，也就是 uid 序）。这条规则与
 * `loop.mjs` 原来的 `buildIndex` 逐字一致 —— 改变它会让 `hubReachable` 的结果漂移。
 *
 * @param {object} obs ObsSnapshot（`reader.obs` 的 result 或整个返回体）
 * @returns {{ent: object[], byUid: Map<number,object>, byCell: Map<string,object>}}
 */
export function indexOf(obs) {
    const src = obs && obs.result && Array.isArray(obs.result.entities) ? obs.result : obs;
    const ent = ((src && src.entities) || []).filter(e => e && Number.isInteger(e.uid));
    const byUid = new Map(ent.map(e => [e.uid, e]));
    const byCell = new Map();
    for (const e of ent) {
        const tpl = templateByBuildingVariant(e.type, e.variant || "default");
        const fp = tpl && Array.isArray(tpl.footprint) ? tpl.footprint : [1, 1];
        for (let dy = 0; dy < fp[1]; dy++) {
            for (let dx = 0; dx < fp[0]; dx++) {
                const k = K([e.x + dx, e.y + dy]);
                if (!byCell.has(k)) byCell.set(k, e);
            }
        }
    }
    return { ent, byUid, byCell };
}

/** 某格上的实体（footprint 级）。没有返回 null。 */
export function at(idx, cell) {
    if (!idx || !IN_CELL(cell)) return null;
    return idx.byCell.get(K(cell)) || null;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 隧道配对
 * ══════════════════════════════════════════════════════════════════════════ */

/** 隧道最大跨度（tier 0）。`core/config.js:90` 的 `undergroundBeltMaxTilesByTier: [5, 9]`。 */
export const TUNNEL_MAX_TILES = Object.freeze({ default: 5, tier2: 9 });

/**
 * 从 sender 出发，沿它的朝向找 1..N 格内的 receiver。
 *
 * 复刻 `systems/underground_belt.js:240-290` 的搜索规则：
 *   · 空格 `continue`（所以压在隧道上的带子**不会**挡住隧道 —— L4 的 (-7,-13) 就是这种情况）；
 *   · 非同 tier / 非隧道 `continue`；
 *   · rotation 不一致 `continue`；
 *   · **遇到另一个 sender 立刻停**（`break`，防止双重投递）；
 *   · 找到 receiver 返回它。
 *
 * @returns {object|null} receiver 实体，或 null（span 内没有配对）
 */
export function tunnelPeer(idx, sender) {
    if (!idx || !isTunnel(sender) || !tunnelIsSender(sender)) return null;
    const d = dirOfRotation(sender.r || 0);
    const tier = sender.variant || "default";
    const span = TUNNEL_MAX_TILES[tier] || TUNNEL_MAX_TILES.default;
    for (let i = 1; i <= span; i++) {
        const c = [sender.x + DIRV[d][0] * i, sender.y + DIRV[d][1] * i];
        const e = idx.byCell.get(K(c));
        if (!e) continue;                                  // 空格：继续找
        if (!isTunnel(e)) continue;                        // 带子/机器压在隧道上：穿过它
        if ((e.variant || "default") !== tier) continue;   // 不同 tier 不配对
        if (dirOfRotation(e.r || 0) !== d) continue;       // 朝向不一致
        if (!tunnelIsSender(e)) return e;                  // 另一个 sender：游戏在这里 break
        return null;
    }
    return null;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 接收判定
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 落在 `cell` 上的实体，是否接受「沿 `fromDir` 方向走进来」的货。
 *
 * @param {object} idx   `indexOf(obs)`
 * @param {[number,number]} cell 落点格（**不是**带子自身所在格）
 * @param {string} fromDir 货流进入落点格时的**行进方向**（= 上游带子的 exitDir）
 * @returns {{ok:boolean, kind:string, by:number|null, opaque:boolean}}
 *   - `kind`：`"empty"` / `"belt"` / `"tunnel_sender"` / `"tunnel_receiver"` / 机器类型名
 *   - `by`：落点实体的 uid（空格为 null）
 *   - `opaque`：该实体没有可解析的槽位几何（未知建筑）—— 此时 `ok:false` 但**不应据此报错**
 */
export function accepts(idx, cell, fromDir) {
    const e = at(idx, cell);
    if (!e) return { ok: false, kind: "empty", by: null, opaque: false };
    if (isBelt(e)) {
        return { ok: beltEntry(rvOf(e), e.r || 0) === OPP[fromDir], kind: "belt", by: e.uid, opaque: false };
    }
    if (isTunnel(e)) {
        // sender 的 acceptor 在局部 bottom（≈ 与出口相反的一侧）；receiver 的 acceptor 是空的。
        if (tunnelIsSender(e)) {
            return { ok: fromDir === dirOfRotation(e.r || 0), kind: "tunnel_sender", by: e.uid, opaque: false };
        }
        return { ok: false, kind: "tunnel_receiver", by: e.uid, opaque: false };
    }
    const s = slotsOf(e.type, e.variant, e.x, e.y, e.r || 0, beltRvOf(e));
    if (!s) return { ok: false, kind: e.type, by: e.uid, opaque: true };
    /* ★ 比的是 `sl.slot`（槽位本体格）== 落点格，不是 `sl.cell`（approach 格）。★
       见文件头第 3 条：游戏判的就是本体格（belt_path.js 的 findMatchingSlot）。 */
    const ok = s.inputs.some(sl => sl.slot[0] === cell[0] && sl.slot[1] === cell[1] && sl.dir === OPP[fromDir]);
    return { ok, kind: e.type, by: e.uid, opaque: false };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 跑链
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 从 `cell` 出发，沿货流一路跑到终点。
 *
 * 语义：`cell` 是**货将要进入的第一格**，`dir` 是它进入这一格时的**行进方向**。
 * 常见用法：给一条带子的出口格与出口方向 —— `runEnd(idx, exitCellOf(b), exitDirOf(b))`。
 *
 * 路径上的每一格：
 *   · 带子 → 改向（用带子自己的 exit），继续；
 *   · 隧道 sender → 跳到 `tunnelPeer` 找到的 receiver，再从 receiver 的出口继续
 *     （**这是「穿过隧道」而不是「停在隧道」** —— 见 v2 裁决 F-5）；
 *   · 隧道 receiver（作为落点）→ 停，`accepted:false`（receiver 没有 acceptor）；
 *   · 机器/hub/trash → 停，用 `accepts()` 判它收不收。
 *
 * @param {object} idx
 * @param {[number,number]} cell
 * @param {string} dir
 * @param {{maxBelts?:number}} [opts]
 * @returns {{kind:string, by:number|null, belts:number[], cells:Array<[number,number]>,
 *            accepted:boolean, truncated:boolean}}
 *   `kind` ∈ `"empty" | "cycle" | "truncated" | 实体类型名`
 */
export function runEnd(idx, cell, dir, opts = {}) {
    const maxBelts = Number.isInteger(opts.maxBelts) ? opts.maxBelts : 512;
    const belts = [];
    const cells = [];
    const seen = new Set();
    let cur = cell;
    let d = dir;
    let guard = 0;

    const stop = (kind, by, accepted, truncated = false) =>
        ({ kind, by, belts, cells, accepted, truncated });

    while (guard++ < maxBelts) {
        const e = at(idx, cur);
        if (!e) return stop("empty", null, false);
        if (seen.has(e.uid)) return stop("cycle", e.uid, false);

        if (isBelt(e)) {
            seen.add(e.uid); belts.push(e.uid); cells.push([e.x, e.y]);
            d = exitDirOf(e);
            cur = exitCellOf(e);
            continue;
        }
        if (isTunnel(e)) {
            if (!tunnelIsSender(e)) {
                // 落点是 receiver：它没有 acceptor，货进不去（正常走法不会到这里）
                return stop("underground_belt", e.uid, false);
            }
            seen.add(e.uid); belts.push(e.uid); cells.push([e.x, e.y]);
            const peer = tunnelPeer(idx, e);
            if (!peer) return stop("empty", null, false);   // 隧道没配对 = 断在隧道口
            seen.add(peer.uid); belts.push(peer.uid); cells.push([peer.x, peer.y]);
            cur = exitCellOf(peer);
            continue;
        }
        // 机器 / hub / trash：跑链终点
        const acc = accepts(idx, cur, d);
        return stop(e.type, e.uid, acc.ok);
    }
    return stop("truncated", null, false, true);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 6. 上游供给
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 某格的「供货方」：带子则沿入口回溯一格，其余就地返回。用于判断输入槽有没有上游。
 *
 * 与旧 `loop.mjs#upstreamAt` 逐字一致（`up === e` 的自环保护也保留了）。
 */
export function upstreamAt(cell, idx) {
    if (!idx || !IN_CELL(cell)) return null;
    const e = idx.byCell.get(K(cell));
    if (!e) return null;
    if (isBelt(e)) {
        const d = entryDirOf(e);
        const up = idx.byCell.get(K([e.x + DIRV[d][0], e.y + DIRV[d][1]]));
        return up === e ? null : up;
    }
    return e;
}

/**
 * 机器输入槽是否真被喂。与 `verify_runtime#checkSlots` 的 `obsFeeds` **同判据、同方向**
 * （那一份是「上游供不供这个 approach」，这一份是「这个 approach 供不供这个槽」）。
 *
 * 与旧实现的差异（有意的，见 `structural.mjs` 文件头）：隧道不再一律算「供了」，
 * 只有 **receiver** 会吐货（sender 只会往隧道里吞）。
 */
export function inputFed(sl, idx) {
    if (!sl || !sl.cell) return false;
    const f = upstreamAt(sl.cell, idx);
    if (!f) return false;
    if (isBelt(f)) return accepts(idx, [f.x + DIRV[exitDirOf(f)][0], f.y + DIRV[exitDirOf(f)][1]],
        exitDirOf(f)).ok && exitCellOf(f)[0] === sl.cell[0] && exitCellOf(f)[1] === sl.cell[1];
    if (isTunnel(f)) {
        if (tunnelIsSender(f)) return false;
        const c = exitCellOf(f);
        return c[0] === sl.cell[0] && c[1] === sl.cell[1];
    }
    const os = slotsOf(f.type, f.variant, f.x, f.y, f.r || 0, beltRvOf(f));
    if (!os) return false;
    const my = [sl.cell[0] - DIRV[sl.dir][0], sl.cell[1] - DIRV[sl.dir][1]];
    return os.outputs.some(o => o.cell[0] === my[0] && o.cell[1] === my[1] && o.dir === OPP[sl.dir]);
}

/**
 * 机器输出槽是否有去处。与 `checkSlots` 同判据。
 *
 * 与旧实现的差异：隧道只有 **sender** 能接货（receiver 的 acceptor 是空的）。
 */
export function outputRouted(sl, idx) {
    if (!sl || !sl.cell) return false;
    const e = at(idx, sl.cell);
    if (!e) return false;
    if (isBelt(e)) return beltEntry(rvOf(e), e.r || 0) === OPP[sl.dir];
    if (isTunnel(e)) return tunnelIsSender(e);
    const os = slotsOf(e.type, e.variant, e.x, e.y, e.r || 0, beltRvOf(e));
    if (!os) return false;
    return os.inputs.some(i => i.slot[0] === sl.slot[0] && i.slot[1] === sl.slot[1] && i.dir === OPP[sl.dir]);
}

/**
 * 一条带子的入口是否被**有效**供给。
 *
 * 有效 = 入口格上的实体真的往这条带子里吐货：
 *   · 上游带子：它的出口格 == 本条带子的 origin，且本条带子的入口朝向能接住；
 *   · 上游隧道：只有 receiver 会吐货（sender 只会往隧道里吞）；
 *   · 上游机器：它的某个输出槽的 `cell`（落点）== 本条带子的 origin，且方向对得上。
 */
export function upstreamFed(idx, belt) {
    if (!idx || !isBelt(belt)) return false;
    const origin = [belt.x, belt.y];
    const up = at(idx, entryCellOf(belt));
    if (!up) return false;

    if (isBelt(up)) {
        const c = exitCellOf(up);
        if (c[0] !== origin[0] || c[1] !== origin[1]) return false;
        return accepts(idx, origin, exitDirOf(up)).ok;
    }
    if (isTunnel(up)) {
        if (tunnelIsSender(up)) return false;          // sender 往隧道里吞，不往带子里吐
        const c = exitCellOf(up);
        return c[0] === origin[0] && c[1] === origin[1];
    }
    const s = slotsOf(up.type, up.variant, up.x, up.y, up.r || 0, beltRvOf(up));
    if (!s) return false;
    return s.outputs.some(o =>
        o.cell[0] === origin[0] && o.cell[1] === origin[1] && accepts(idx, origin, o.dir).ok);
}

/**
 * 顺着上游一路爬，回答「这条流的源头是**哪个实体**」。
 *
 * @returns {{kind:string, entity:object|null}}
 *   `kind` ∈ `"miner" | "none" | "cycle" | "tunnel_sender" | <机器类型名>`
 *   （`"none"` = 断在空格上；`"cycle"` = 上游成环）
 */
export function sourceEntityOf(idx, belt, maxHops = 256) {
    let cur = belt;
    const seen = new Set();
    for (let i = 0; i < maxHops; i++) {
        if (!cur) return { kind: "none", entity: null };
        if (seen.has(cur.uid)) return { kind: "cycle", entity: cur };
        seen.add(cur.uid);

        let up = null;
        if (isTunnel(cur) && !tunnelIsSender(cur)) {
            // receiver 的上游是它的 sender：沿反方向找 1..span 格
            const d = dirOfRotation(cur.r || 0);
            const op = OPP[d];
            const tier = cur.variant || "default";
            const span = TUNNEL_MAX_TILES[tier] || TUNNEL_MAX_TILES.default;
            for (let k = 1; k <= span; k++) {
                const e = idx.byCell.get(K([cur.x + DIRV[op][0] * k, cur.y + DIRV[op][1] * k]));
                if (!e) continue;
                if (!isTunnel(e)) continue;
                if (!tunnelIsSender(e)) continue;
                if (dirOfRotation(e.r || 0) !== d) continue;
                up = e;
                break;
            }
            if (!up) return { kind: "none", entity: null };
        } else {
            up = at(idx, entryCellOf(cur));
        }
        if (!up) return { kind: "none", entity: null };
        if (isBelt(up) || isTunnel(up)) { cur = up; continue; }
        return { kind: up.type, entity: up };      // 机器（含 miner）/ hub / trash
    }
    return { kind: "cycle", entity: cur };
}

/** 只要类型名的简版（`sourceEntityOf` 的薄包装）。 */
export function sourceKindOf(idx, belt, maxHops = 256) {
    return sourceEntityOf(idx, belt, maxHops).kind;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 7. hub 反向可达（从 loop.mjs 原样搬来，语义不变）
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 从 hub 的输入槽**反向**走一遍，得到「能影响 goal 的实体集合」。
 *
 * 为什么要这个过滤器：L4 存档里有 163 条带子，其中大量属于旧产线/装饰性支线。
 * 不过滤时结构层诊断会产出十几条与目标形状无关的东西。**这是精度换召回的一次有意识取舍**。
 *
 * 走法与 `verify.mjs#obsReach` 同向（下游→上游的反向），但这里只用于诊断排序，
 * 不参与任何裁决 —— 裁决仍然只看 verifyRuntime/verifyRound 的结果。
 *
 * ⚠️ 本函数从 `loop.mjs` **原样搬来**，`topology.test.mjs` 里有与旧实现的逐 uid 对拍。
 *    改动它之前先想清楚：它的输出直接决定诊断的 tier。
 */
export function hubReachable(obs, idx) {
    const ix = idx || indexOf(obs);
    const seen = new Set();
    const hub = ix.ent.find(e => e.type === "hub");
    if (!hub) return seen;
    seen.add(hub.uid);
    const q = [hub];
    while (q.length) {
        const e = q.shift();
        const s = slotsOf(e.type, e.variant, e.x, e.y, e.r || 0, beltRvOf(e));
        if (!s) continue;
        for (const sl of s.inputs) {
            let cur = sl.cell;
            let guard = 0;
            let hit = null;
            const passed = [];
            while (guard++ < 512) {
                const c = ix.byCell.get(K(cur));
                if (!c) break;
                if (c.uid === e.uid) break;
                if (c.type === "belt") {
                    passed.push(c.uid);
                    const rv = rvOf(c);
                    const d = beltEntry(rv, c.r || 0);
                    cur = [c.x + DIRV[d][0], c.y + DIRV[d][1]];
                    continue;
                }
                hit = c;
                break;
            }
            for (const u of passed) {
                if (!seen.has(u)) { seen.add(u); const b = ix.byUid.get(u); if (b) q.push(b); }
            }
            if (hit && !seen.has(hit.uid)) { seen.add(hit.uid); q.push(hit); }
        }
    }
    return seen;
}
