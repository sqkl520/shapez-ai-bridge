/**
 * tunnel.mjs — 用隧道（underground_belt）穿越既有带子，解决「两线交叉」的接线难题。
 *
 * ════════════════════════════ 它解决什么问题 ════════════════════════════
 *
 * `connect` 只能铺**地表带子**。当它需要跨过一条别人已经在用的线时，只有两条路：
 *   ① 绕远路 —— 常常绕不出去（对面整列/整行都被占）
 *   ② `allow_replace` 覆盖 —— 等于把别人的产线拆了
 *
 * 实测（L10，2026-11-14）：绿矿要接进混色机 slot 0，青色输出线正占着 x=-10 整列。
 * `connect` 两种修法都失败：
 *   · 直接连 → `occupied`（路径必须穿过 slot 1 的喂料格 = 另一条产线）
 *   · 放宽覆盖 → 同样 `occupied`，而且提示明确说「自动放宽不会替你覆盖别人机器的输入口」
 *
 * 正解是**隧道**：绿线从青色线底下穿过去。手工放一对 sender/receiver 后立刻见效 ——
 * `debug_items` 里第一次出现 `cyan` 这个货，产线从 0 恢复到 0.5 件/秒。
 *
 * ════════════════════════════ 为什么必须单独一个模块 ════════════════════════════
 *
 * 隧道的几何和带子**完全不同**，塞进 `poseChain` 会把那套已经验证过的判据污染：
 *
 *   · 带子：每格都要解 (rotation, rv)，`poseChain` 逐格 `solveTurn`。
 *   · 隧道：只有两格（sender/receiver），中间跨度是**空的**，不铺任何东西。
 *     两格的 rotation 相同，rv 相反（0=sender / 1=receiver）。
 *
 *   · 更关键：`templateByBuildingVariant("underground_belt", "default")` **返回 null** ——
 *     sender 和 receiver 共用 building+variant，按它反查会二选一、互相覆盖
 *     （见 `op-templates.mjs:642` 的注释）。隧道只能按 **code** 查。
 *     所以任何依赖 `slotsOf(kind, variant, ...)` 的通用路径都走不通。
 *
 * ════════════════════════════ 朝向语义（已实机验证） ════════════════════════════
 *
 * spec（`machine-spec.json` 的 `underground_belt.note`）：
 *   「入口 bottom 收、出口 top 喷，同 rotation 配对」
 *
 * 也就是在**局部坐标系**里：货从 bottom 边进来，从 top 边出去，方向是「向上」。
 * 世界方向 = `rotateLocal("top", rotation)` —— 即隧道把货往 `top` 旋转后的那个方向推。
 *
 * 实机验证（2026-11-14，L10）：
 *   sender  (-11,-8) r=90 rv=0 code=22
 *   receiver (-9,-8) r=90 rv=1 code=23
 *   → 绿色货从 (-11,-8) 进、从 (-9,-8) 出，向东穿过中间的 (-10,-8) 青色线。成功。
 *
 *   `rotateLocal("top", 90)` = "right"（东）—— 与实机一致。
 *
 * ════════════════════════════ 跨度 ════════════════════════════
 *
 * `config.js:90` → `undergroundBeltMaxTilesByTier = [5, 9]`
 * tier0（default）= 5，tier1（tier2 变体）= 9。
 *
 * 「跨度」的算法（`underground_belt.js` 的 `onEntityManuallyPlaced`）：
 * 从 receiver 出发，沿**反方向**一格格回找，最多找 `range` 步，取**最远**的那个同向同 tier sender。
 * 所以 sender 与 receiver 之间最多隔 `range - 1` 个空格：
 *   range=5 ⇒ 中间最多 4 格空隙，两格之间最大曼哈顿距离 5。
 *
 * ════════════════════════════ 扫描规则（实机确认） ════════════════════════════
 *
 * `recomputeArea` **只找 sender，不检查中间有没有别的建筑**。
 * 所以隧道可以穿过带子 —— 那正是它存在的意义。
 * 它唯一要求的是 sender 与 receiver **朝向一致、tier 一致**。
 */
import { rotateLocal, OPP, DIRV, norm360 } from "../../ai/belt-rules.mjs";

/** 与 `config.js:90` 的 `undergroundBeltMaxTilesByTier` 对齐。 */
export const TUNNEL_RANGE = Object.freeze({ default: 5, tier2: 9 });

/** code 表（`machine-spec.json` 的 note）。 */
export const TUNNEL_CODES = Object.freeze({
    default: Object.freeze({ sender: 22, receiver: 23 }),
    tier2: Object.freeze({ sender: 24, receiver: 25 }),
});

/**
 * 隧道把货往哪个世界方向推。
 * 局部是 bottom→top（向上），世界 = rotateLocal("top", rotation)。
 *
 * @param {number} rotation 0/90/180/270
 * @returns {"top"|"right"|"bottom"|"left"}
 */
export function tunnelDir(rotation) {
    return rotateLocal("top", norm360(rotation | 0));
}

/**
 * 反过来：给定想要的推进方向，求 rotation。
 *
 * @param {"top"|"right"|"bottom"|"left"} dir
 * @returns {number} 0/90/180/270
 */
export function rotationForTunnelDir(dir) {
    for (const r of [0, 90, 180, 270]) if (tunnelDir(r) === dir) return r;
    return null;
}

/**
 * 在 `line` 上找一个可以用隧道穿越的点。
 *
 * 「穿越」的定义：从 `from` 沿 `dir` 方向走，遇到一段**连续的既有带子**
 * （不是机器 —— 机器永远不能被穿越，隧道也一样），
 * 在它前一格放 sender、后一格放 receiver，把它们跳过去。
 *
 * @param {object} args
 * @param {[number,number]} args.from      起点格（sender 的候选位置，通常紧跟着上一个直段）
 * @param {"top"|"right"|"bottom"|"left"} args.dir  推进方向
 * @param {(x:number,y:number)=>object|null} args.at  格 → 实体或 null
 * @param {number} [args.range]           隧道跨度上限（默认 tier0 = 5）
 * @param {number} [args.maxSkip]         最多跳过几格（默认 range - 1）
 * @returns {{ok:true, sender:[number,number], receiver:[number,number], rotation:number,
 *            skipped:Array<[number,number]>, span:number}
 *          | {ok:false, reason:string, detail?:object}}
 */
export function planTunnelCrossing({ from, dir, at, range = TUNNEL_RANGE.default, maxSkip = null }) {
    if (!Array.isArray(from) || from.length !== 2) return { ok: false, reason: "bad_from" };
    const v = DIRV[dir];
    if (!v) return { ok: false, reason: "bad_dir" };

    const limit = maxSkip === null ? range - 1 : Math.min(maxSkip, range - 1);
    const rotation = rotationForTunnelDir(dir);
    if (rotation === null) return { ok: false, reason: "bad_dir" };

    /* 从 from 出发，先把连续的空格跳过（那些可以正常铺带子），
       然后在**第一个被占的格子**上尝试：把它和后面 (span-1) 格用隧道跳过去。 */
    const walk = (n) => [from[0] + v[0] * n, from[1] + v[1] * n];

    let lead = 0;
    while (lead <= limit + 1) {
        const c = walk(lead);
        const rec = at(c[0], c[1]);
        if (!rec) { lead++; continue; }
        break;
    }

    const firstBlocked = walk(lead);
    const blocker = at(firstBlocked[0], firstBlocked[1]);
    if (!blocker) {
        return { ok: false, reason: "no_blocker", detail: { searchedTo: walk(limit + 1) } };
    }

    /* 机器永远不能被穿越。隧道也只穿带子 —— 穿机器等于把机器埋了。 */
    if (blocker.type !== "belt" && blocker.type !== "underground_belt") {
        return { ok: false, reason: "blocked_by_machine", detail: { cell: firstBlocked, type: blocker.type, uid: blocker.uid } };
    }

    /* 找这一段连续障碍的长度（必须整段跳过去，不能只跳一格然后在里面铺带子） */
    let run = 0;
    while (run <= limit) {
        const c = walk(lead + run);
        const rec = at(c[0], c[1]);
        if (!rec || (rec.type !== "belt" && rec.type !== "underground_belt")) break;
        run++;
    }

    /* sender 放在障碍**前一格**，receiver 放在障碍**后一格**。
       两者之间的曼哈顿距离 = run + 1，必须 ≤ range。 */
    if (run + 1 > range) {
        return {
            ok: false, reason: "too_wide",
            detail: { run, span: run + 1, range, at: firstBlocked },
        };
    }

    const sender = walk(lead - 1);
    const receiver = walk(lead + run);
    const skipped = [];
    for (let i = 0; i < run; i++) skipped.push(walk(lead + i));

    /* sender 自己要能站得下：它会被铺在障碍前一格，那格必须是空的或可覆盖的带子。
       （调用方负责决定是否覆盖；这里只报事实。） */
    const senderRec = at(sender[0], sender[1]);
    const receiverRec = at(receiver[0], receiver[1]);

    return {
        ok: true,
        sender, receiver, rotation,
        skipped,
        span: run + 1,
        sender_occupied: senderRec ? { type: senderRec.type, uid: senderRec.uid } : null,
        receiver_occupied: receiverRec ? { type: receiverRec.type, uid: receiverRec.uid } : null,
        blocker: { type: blocker.type, uid: blocker.uid, cell: firstBlocked },
    };
}

/**
 * 把一个隧道穿越方案转成可直接喂给 `op:"tx"` 的 place 操作。
 *
 * 顺序有讲究：**sender 先落，receiver 后落**。
 * `onEntityManuallyPlaced` 只在 receiver 放置时触发，它需要 sender 已经在场
 * 才能连上（`underground_belt.js:53`）。反过来会得到一对没有连上的隧道。
 *
 * @param {{sender:[number,number], receiver:[number,number], rotation:number}} plan
 * @param {string} [variant] "default" | "tier2"
 */
export function tunnelOps(plan, variant = "default") {
    const codes = TUNNEL_CODES[variant] || TUNNEL_CODES.default;
    return [
        { op: "place", building: "underground_belt", x: plan.sender[0], y: plan.sender[1], r: plan.rotation, rotationVariant: 0, variant },
        { op: "place", building: "underground_belt", x: plan.receiver[0], y: plan.receiver[1], r: plan.rotation, rotationVariant: 1, variant },
    ];
}

/**
 * 隧道格的端口（供连通性分析用 —— `slotsOf` 对隧道返回 null，不能走通用路径）。
 *
 * @param {"sender"|"receiver"} mode
 * @param {number} rotation
 * @param {number} x
 * @param {number} y
 * @returns {{cell:[number,number], dir:string, kind:"in"|"out"}|null}
 */
export function tunnelPort(mode, rotation, x, y) {
    const d = tunnelDir(rotation);
    if (mode === "sender") {
        /* sender 收货：货从**背后**进来，也就是与推进方向相反的那一面。 */
        return { cell: [x, y], dir: OPP[d], kind: "in" };
    }
    if (mode === "receiver") {
        /* receiver 出货：往推进方向喷。 */
        return { cell: [x, y], dir: d, kind: "out" };
    }
    return null;
}
