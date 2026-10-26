/**
 * gates.mjs — M3 Gate Runner：建产线前/后必须通过的闸。
 *
 * 为什么需要它：这一轮两次事故都不是"编译失败"，而是"编译成功但工厂是死的"：
 *   1. 调 set_speed fast_forward 让游戏时钟 NaN 永久停摆，之后所有读数都是假的，
 *      而我还在用那些数字做判断 —— 几小时后才发现。
 *   2. L4 贴了 108 个实体，`dry_run` 报 0 阻断 0 销毁，看起来完美，
 *      但切割机的输入方向是反的，产线根本不通。
 *
 * 第二件事尤其重要：它说明**几何正确 ≠ 工厂能跑**。
 *
 * ## 设计上最重要的一条
 *
 * 判据必须来自**游戏运行时**，不能来自编译器自己。
 *
 * 我们有一个布局编译器，也有一个和它同源的带子模拟器（belt-sim）。
 * 用那个模拟器去验编译器的产物，等于让同一套假设自我确认：
 * "方向反了"在编译器的表示里是**不动点**，模拟器会说"一切正常"。
 * 实测就是这么发生的 —— 108/108、0 销毁、drift=[]，而线是死的。
 *
 * 所以这里只用三样东西当 oracle：
 *   · 游戏分配的 uid（G4）
 *   · 游戏自己的产量统计（G6）
 *   · 游戏运行时的实际连接关系（G6b / G7 / G8）
 *
 * ## 八道闸
 *
 *   G-1 时钟    —— 任何采样之前，先确认时钟在走
 *   G2' 同源    —— paste 的载荷（blueprint）与 G4 的期望（entities）是同一张图（零写入）
 *   G3  净空    —— 落点不压既有实体、不销毁任何东西
 *   G4  落地    —— 贴进去的东西与蓝图逐格一致，且没有 uid 消失
 *   G6  行为    —— 目标形状的交付速率达到理论值的 80%
 *   G6b 连通    —— 目标线上每一段都有去处
 *   G7  流向    —— 游戏 path 的逐格邻接方向 == 声明的 inDir/outDir（贴后 t+0 与 t+60s）
 *   G8  链划分  —— 蓝图推出的带子链与游戏 path 逐格同序（贴后 t+0 与 t+60s）
 *
 * ★ 为什么必须有 G2' / G7 / G8 ★
 * 2026-10-26 的 L4 事故里，G-1/G3/G4/G6b 全绿（G6 要等 100 游戏秒才红）。
 * 根因是 G4 的期望值与被粘贴的载荷同源于 `plan.entities` —— 编译器把拐角算成直带时，
 * 两边一起错，G4 拿错的期望去比游戏里忠实落地的错值 ⇒ 恒绿。
 * G2' 把 blueprint 与 entities 钉在一起，G7/G8 把"蓝图说的图"与"游戏运行时的拓扑"
 * 分开比 —— 三者中只有 G8 能在"intent 与 blueprint 都自洽但都错"时变红。
 * 详见 research/ai-plan/M3-REDTEAM-L4.md。
 *
 * G0/G1/G2/G5 降级为诊断信息，因为它们的判据与编译器同源，
 * 独立信息量接近零（详见 research/ai-plan/M3-REVIEW.md）。
 *
 * ## 用法
 *
 *   node src/agent/gates.mjs --plan <intent.json>           # 只跑到 G3（零写入）
 *   node src/agent/gates.mjs --plan <intent.json> --apply   # 完整五闸（G4 失败会自动回滚）
 *   node src/agent/gates.mjs --plan <intent.json> --apply --no-rollback  # 失败时保留现状
 *   node src/agent/gates.mjs --plan <intent.json> --json
 *
 * 退出码：0 全绿 / 2 有闸红 / 1 致命（无法继续）
 */
import fs from "node:fs";
import { decodeBlueprint } from "../shared/blueprint.mjs";
import { DIRV, OPP, beltEntry, beltExit, beltCode } from "../ai/belt-rules.mjs";

const BASE = process.env.SHAPEZ_BRIDGE_URL || "http://127.0.0.1:7777";
let rpcId = 1;

async function rpc(method, params = {}, timeoutMs = 120000) {
    const res = await fetch(`${BASE}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const b = await res.json();
    if (b.error) {
        const e = new Error(`${method}: ${b.error.message}`);
        e.rpc = b.error;
        throw e;
    }
    return b.result;
}

/* ══════════════════════════ 几何工具（纯函数，可单测） ══════════════════════════ */

/**
 * 各建筑变体的占地。数字来自 op-templates.mjs 的 footprint，并经实机核对。
 *
 * ⚠️ 与 obs 的关系（这是本文件最容易搞错的一件事）：
 *   `obs.entities[]` 对每台建筑只报**一条**记录，坐标是它的 origin。
 *   物理占地是另一回事 —— cutter 2×1 占两格，但 obs 里只有一条。
 *   实测：cutter@(-8,-11) 在 obs 里只有 uid 10036 一条；往 (-7,-11) 放 belt
 *   会被游戏拒绝（那里被 cutter 占着），但 obs 里查不到任何实体。
 *
 *   所以「按格比对」和「按实体比对」是两个不同的判据，不能混用：
 *     · 判断"蓝图贴全了没有" → 按**实体**（obs 一条 = 一台）
 *     · 判断"这块地能不能放" → 按**格**（要问 dry_run，不能只看 obs）
 */
const FOOTPRINT = {
    hub: [4, 4],
    miner: [1, 1],        // ← 实测：四台矿机可以在 (2..5,-8) 相邻共存
    cutter: [2, 1],
    cutter_quad: [4, 1],
    rotater: [1, 1],      // ← 继承默认 Vector(1,1)，没有 getDimensions override
    stacker: [2, 1],
    mixer: [2, 1],
    painter: [2, 1],
    trash: [1, 1],
    balancer: [2, 1],
    belt: [1, 1],
    underground_belt: [1, 1],
};

/**
 * 一台建筑在世界上占的全部格。
 *
 * 为什么要展开：intent 里每台机器只有一个原点 `[dx,dy]`，
 * 但切割机是 2×1、hub 是 4×4。只比原点格会漏掉右半/外圈 ——
 * 那正是"净空假绿"和"回滚漏格"的来源。
 */
/**
 * 一台建筑在世界上占的全部格。
 *
 * 对齐游戏的 `StaticMapEntity.getTileSpaceBounds()`：
 * rot=0 时向 +x/+y 长；rot=180 时向 **-x/-y** 长（origin 是锚点）。
 * rot=90/270 时宽高互换，且 origin 位移方向也随旋转走。
 *
 * 只有 rot=0/90 是"向正向长"；180/270 必须向负方向 —— 这一点实测核对过：
 *   cutter rot=0   → (0,0)(1,0)
 *   cutter rot=90  → (0,0)(0,1)
 *   cutter rot=180 → (-1,0)(0,0)
 *   cutter rot=270 → (0,-1)(0,0)
 */
export function entityCells(kind, x, y, rot = 0) {
    const key = FOOTPRINT[kind] ? kind : "belt";
    let [w, h] = FOOTPRINT[key] || [1, 1];
    const r = ((Number(rot) || 0) % 360 + 360) % 360;
    if (r === 90 || r === 270) [w, h] = [h, w];
    const out = [];
    // 180/270 时向负方向长
    const dx0 = (r === 180 || r === 270) ? -(w - 1) : 0;
    const dy0 = (r === 180 || r === 270) ? -(h - 1) : 0;
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) out.push([x + dx0 + dx, y + dy0 + dy]);
    return out;
}

/**
 * intent 里的全部实体，展开成世界坐标下逐一占用的格。
 * 世界坐标 = anchor + [dx, dy]。
 *
 * 同格被两个实体占用时**不静默覆盖** —— 那是蓝图自叠，必须能被发现。
 * 实测过后果：belt 和 cutter 同在 (0,0) 时，cutter 覆盖 belt，
 * belt 从集合里消失 → G6b 少要求一格 → 可以假绿。
 *
 * @returns {Map} key "x,y" → { kind, code, rot, nodeId, origin, collisions? }
 */
export function expectedCells(intent) {
    const a = intent.anchor;
    if (!Array.isArray(a) || a.length !== 2) throw new Error("intent.anchor 必须是 [x,y]");
    if (!Number.isInteger(a[0]) || !Number.isInteger(a[1])) {
        throw new Error(`intent.anchor 必须是整数坐标，实得 ${JSON.stringify(a)}`);
    }
    const cells = new Map();
    const collisions = [];
    for (const e of intent.entities || []) {
        if (!Number.isInteger(e.dx) || !Number.isInteger(e.dy)) {
            throw new Error(`实体 ${e.nodeId} 的 dx/dy 必须是整数，实得 ${e.dx},${e.dy}`);
        }
        const wx = a[0] + e.dx, wy = a[1] + e.dy;
        for (const [x, y] of entityCells(e.kind, wx, wy, e.rot | 0)) {
            const k = `${x},${y}`;
            if (cells.has(k)) {
                const prev = cells.get(k);
                if (prev.nodeId !== e.nodeId) {
                    collisions.push({ cell: [x, y], a: prev.nodeId, b: e.nodeId });
                }
                continue;      // 不覆盖：先写的留着，冲突单独报
            }
            cells.set(k, { kind: e.kind, code: e.code, rot: e.rot | 0, nodeId: e.nodeId, origin: [wx, wy] });
        }
    }
    if (collisions.length) {
        cells.collisions = collisions;
    }
    return cells;
}

/* ══════════════════════════ 方向工具（纯函数，可单测） ══════════════════════════ */

/** 从 from 格指向 to 格的方位面；非正交邻接返回 null。 */
export function dirOf(from, to) {
    const dx = to[0] - from[0], dy = to[1] - from[1];
    if (dx === 0 && dy === -1) return "top";
    if (dx === 0 && dy === 1) return "bottom";
    if (dx === -1 && dy === 0) return "left";
    if (dx === 1 && dy === 0) return "right";
    return null;
}

/** 本格 + 方位 → 邻格。 */
export function stepCell(cell, dir) {
    const v = DIRV[dir];
    return v ? [cell[0] + v[0], cell[1] + v[1]] : null;
}

const cellKey = c => `${c[0]},${c[1]}`;

/* ══════════════════════════ 数据采集 ══════════════════════════ */

async function snapshot() {
    const o = await rpc("obs", { max_entities: 20000, include_hub: true });
    return {
        entities: o.entities || [],
        byUid: new Map((o.entities || []).map(e => [e.uid, e])),
        byCell: new Map((o.entities || []).map(e => [`${e.x},${e.y}`, e])),
        goal: o.goal,
        hub: o.hub,
        truncated: o.truncated === true,
        tick: o.tick,
    };
}

/* ══════════════════════════ G-1 时钟闸 ══════════════════════════ */

/**
 * 时钟必须真的在走。
 *
 * 这是所有速率类断言的前提。没有它，一个冻结的时钟会让 G6 表现为
 * "产量为零" —— 那是**假红**，会触发回滚，把好好的工厂拆掉。
 *
 * 判据全部来自游戏：
 *   · logic_budget_ms 为 null ⇒ NaN（JSON 不支持 NaN）⇒ 预算已被污染
 *   · speed 必须是 regular（paused/fast-forward 不可用：paused 与 fast-forward
 *     都没有注册进游戏的序列化工厂，一旦写进存档，那个存档就永远读不回来）
 *   · 推进一段时间后 tick 必须真的增加
 *
 * 特别注意：**不看 step 的返回值**。历史上它推进 0 tick 时也返回过 ok。
 */
export async function gateClock(probeTicks = 600) {
    const evidence = {};
    let loop;
    try {
        loop = await rpc("debug_loop", {});
    } catch (e) {
        return { ok: false, reason: "读不到 debug_loop（游戏没进世界？）", evidence: { error: e.message } };
    }
    evidence.logic_budget_ms = loop.logic_budget_ms;
    evidence.speed = loop.speed;

    if (loop.logic_budget_ms === null || loop.logic_budget_ms === undefined) {
        return {
            ok: false, reason: "logic_budget_ms 为 null ⇒ 预算已被 NaN 污染 ⇒ 时钟停摆",
            evidence, hint: "这是不可恢复的：先停下来，不要做任何测量",
        };
    }
    if (loop.speed !== "regular") {
        return {
            ok: false, reason: `游戏速度是 ${loop.speed}，只有 regular 可用`,
            evidence, hint: "paused/fast-forward 未注册进序列化工厂，存档会读不回来",
        };
    }

    const tick0 = loop.tick;
    try { await rpc("act", { op: "step", ticks: probeTicks }); } catch (e) {
        return { ok: false, reason: `step 失败：${e.message}`, evidence: { ...evidence, stepError: e.message } };
    }
    const loop2 = await rpc("debug_loop", {});
    const advanced = loop2.tick - tick0;
    evidence.tick_before = tick0;
    evidence.tick_after = loop2.tick;
    evidence.tick_delta = +advanced.toFixed(3);

    /* ★ 下界，不只是 > 0 ★
       游戏主循环在两次 RPC 之间自己也会走一点点（实测 0.025~0.067 游戏秒），
       所以 `advanced > 0` 在 step 完全失效时也能满足 —— 那个下界等于没有。
       要求至少走完请求量的 60%。

       ⚠️ tickRate 不能硬编码成 120 ★
       游戏的 refreshRateOptions 是 ["30","60","120","180","240"]（application_settings.js:125）。
       第一个版本写死 `probeTicks / 120`，在 240Hz 上会把"请求 600 tick"
       算成"应该走 5 秒"，而实际 240Hz 只需 2.5 秒 —— 健康游戏被判死，
       然后触发拆线。必须用**游戏自己报告的** tick_rate。 */
    const tickRate = Number.isFinite(loop.tick_rate) && loop.tick_rate > 0 ? loop.tick_rate : 120;
    evidence.tick_rate = tickRate;
    const expectedSec = probeTicks / tickRate;
    const minSec = expectedSec * 0.6;
    evidence.expected_seconds = +expectedSec.toFixed(3);
    evidence.min_seconds = +minSec.toFixed(3);

    if (!(advanced >= minSec)) {
        return {
            ok: false,
            reason: `请求推进 ${probeTicks} tick（按 ${tickRate}Hz 算应走 ${expectedSec.toFixed(2)} 游戏秒），`
                + `实际只走了 ${advanced.toFixed(3)} 秒（低于 ${minSec.toFixed(2)} 的下界）`
                + ` —— 时钟没有真的在走`,
            evidence,
            hint: "环境本身的少量 tick 不该被当成推进成功",
        };
    }
    return { ok: true, reason: null, evidence };
}

/* ══════════════════════════ G3 净空 ══════════════════════════ */

/**
 * 落点必须干净：不压既有实体、不销毁任何东西、实体数与预期一致。
 *
 * ⚠️ 单位（实测确认，不是推测）：
 *   `dry_run.would_apply` 是**实体数**，不是格数。
 *   源码 shapez-ai-bridge.js 的 dry_run 分支给每个蓝图条目 push 一次
 *   `{cell:[wx,wy], kind}`，多格机器（cutter 2×1）仍只算 1。
 *   设计评审里曾断言它是格数 —— 实测否掉了：空地上 29 实体 → would_apply=29，
 *   而按 footprint 展开是 31 格。
 *
 *   所以这一闸比的是 `intent.entities.length`（实体数）；
 *   展开的格数只用在 G4 的逐格比对和回滚的 region 计算里。
 */
export async function gateG3(intent, dryRun) {
    const expectCells = expectedCells(intent);
    const expectEntities = (intent.entities || []).length;
    const evidence = {
        expected_entities: expectEntities,
        expected_cells: expectCells.size,
        would_apply: dryRun.would_apply,
        would_delete: dryRun.would_delete,
        blocked: (dryRun.blocked || []).length,
        destroys: (dryRun.destroys || []).length,
    };

    /* 蓝图内部自叠 —— dry_run 只在 origin 层面查 duplicateInPlan，
       多格机器压到另一台的非 origin 格时它看不见。
       而自叠会让 expectedCells 少格、G6b 少要求，最终假绿。 */
    if (Array.isArray(expectCells.collisions) && expectCells.collisions.length) {
        evidence.collisions = expectCells.collisions.slice(0, 6);
        return {
            ok: false,
            reason: `蓝图内部有 ${expectCells.collisions.length} 处自叠`
                + `（首处 ${JSON.stringify(expectCells.collisions[0])}）`,
            evidence,
            hint: "回到编译器，不要贴一份自己压自己的蓝图",
        };
    }

    /* 蓝图里有游戏不认识的 building code —— dry_run 会把它报成 would_apply 对不上，
       但"对不上"这个理由会让人去查数量，而不是去查 code。 */
    if (Array.isArray(dryRun.unknown_code) && dryRun.unknown_code.length) {
        evidence.unknown_code = dryRun.unknown_code.slice(0, 6);
        return {
            ok: false,
            reason: `蓝图里有游戏不认识的 code：${JSON.stringify(dryRun.unknown_code.slice(0, 6))}`,
            evidence,
            hint: "编译器产出的 code 与当前游戏版本不匹配",
        };
    }

    if ((dryRun.blocked || []).length > 0) {
        const b = dryRun.blocked[0];
        return {
            ok: false, reason: `${evidence.blocked} 处被阻断，首处 ${JSON.stringify(b.cell)}（${b.reason || b.kind}）`,
            evidence, hint: "若 occupant 是既有实体 → 换锚点重编译；若是 plan 内自叠 → 回蓝图",
        };
    }
    if ((dryRun.destroys || []).length > 0) {
        return {
            ok: false, reason: `会销毁 ${evidence.destroys} 个既有实体`,
            evidence, hint: "旧产线是升级供应链的一部分，不能拆",
        };
    }
    if (dryRun.would_apply !== expectEntities) {
        return {
            ok: false,
            reason: `would_apply=${dryRun.would_apply} 而蓝图有 ${expectEntities} 个实体 —— 对不上`,
            evidence,
            hint: "would_apply 是实体数（每个蓝图条目算一个，多格机器不重复计）",
        };
    }
    return { ok: true, reason: null, evidence };
}

/* ══════════════════════════ G4 落地 ══════════════════════════ */

/**
 * 贴进去的东西必须与蓝图一致，而且**不能有既有的 uid 消失**。
 *
 * ★ 这里必须按**实体**比对，不能按格 ★
 *
 * `obs.entities[]` 对每台建筑只报一条记录（坐标是 origin），
 * 而 cutter 2×1、hub 4×4 物理上占多格。按格比对会要求"每一格都有一条 obs"，
 * 那是游戏永远不会给的东西 —— 任何含 cutter/hub 的蓝图都会被判死。
 * 实测就是这个错误：忠实模拟的 after（与蓝图完全一致）也被判红，
 * 理由是"2 个预期格上没有新实体（miner 右半、cutter 右半）"。
 *
 * 所以：
 *   · 实体层面：intent.entities 每条 → after 里必须有一条新实体在同一 origin、同 code
 *   · 格层面：留给 G3（dry_run 问的是真实世界），这里不做
 */
export function gateG4(intent, before, after) {
    const evidence = {};

    /* ★ after 被截断时不能判红 ★
       obs 有 max_entities 上限。贴完实体变多之后，after 里可能只剩前 N 条：
         · 新贴的实体"没出现在预期位置" → 假红"没贴全"
         · 排在后面的既有 uid 在 after 里"消失" → 假红"被销毁了，必须回滚"
       两种都是错误诊断，而且会误导去回滚一个其实没问题的工厂。
       这种情况必须是"无法判定"，不是红也不是绿。 */
    if (after.truncated) {
        return {
            ok: false,
            undecidable: true,
            reason: `贴后的 obs 被截断（实体数超过上限），无法判定落地是否完整`,
            evidence: { before_count: before.byUid.size, after_count: after.byUid.size },
            hint: "调大 mod 设置里的 max_entities，或先清掉远处的旧实体",
        };
    }
    if (before.truncated) {
        return {
            ok: false,
            undecidable: true,
            reason: `贴前的 obs 被截断，无法建立完整的 uid 基线`,
            evidence: { before_count: before.byUid.size },
        };
    }

    // 1) 有没有 uid 消失 —— A3 静默销毁的兜底
    const gone = [];
    for (const uid of before.byUid.keys()) {
        if (!after.byUid.has(uid)) gone.push(uid);
    }
    evidence.vanished_uids = gone.length;
    if (gone.length > 0) {
        const sample = gone.slice(0, 5).map(uid => {
            const e = before.byUid.get(uid);
            return `${uid}@(${e.x},${e.y})${e.type}`;
        });
        return {
            ok: false,
            reason: `${gone.length} 个既有实体消失了（${sample.join(" ")}）—— paste 销毁了它们`,
            evidence: { ...evidence, sample },
            hint: "这是 C1 静默销毁，必须回滚",
        };
    }

    // 2) 按实体比对：蓝图里每一台在 after 里都要有对应的一条新实体
    const a = intent.anchor;
    const added = [];
    for (const [uid, e] of after.byUid) if (!before.byUid.has(uid)) added.push(e);
    evidence.added_entities = added.length;
    evidence.expected_entities = (intent.entities || []).length;

    const addedByCell = new Map(added.map(e => [`${e.x},${e.y}`, e]));
    const missing = [], wrongCode = [], wrongRot = [];
    for (const ent of intent.entities || []) {
        const wx = a[0] + ent.dx, wy = a[1] + ent.dy;
        const got = addedByCell.get(`${wx},${wy}`);
        if (!got) { missing.push({ cell: [wx, wy], nodeId: ent.nodeId, kind: ent.kind }); continue; }
        if (got.code !== ent.code) {
            wrongCode.push({ cell: [wx, wy], nodeId: ent.nodeId, want: ent.code, got: got.code });
        }
        /* ★ 朝向也必须比 ★
           code 相同不代表落对了：cutter 2×1 在 rot=0 占 {(x,y),(x+1,y)}，
           在 rot=90 占 {(x,y),(x,y+1)} —— origin 和 code 都一样，物理格完全不同。
           这正是 A2（方向反了）的形态，光靠 code 抓不到。 */
        const wantR = (ent.rot | 0) % 360;
        const gotR = typeof got.r === "number" ? got.r : (got.rotation | 0);
        if (gotR !== wantR) {
            wrongRot.push({ cell: [wx, wy], nodeId: ent.nodeId, kind: ent.kind, want: wantR, got: gotR });
        }
    }
    evidence.missing_entities = missing.length;
    evidence.wrong_code = wrongCode.length;
    evidence.wrong_rot = wrongRot.length;

    if (missing.length) {
        return {
            ok: false,
            reason: `${missing.length} 台实体没有出现在预期位置（首处 ${JSON.stringify(missing[0])}）`,
            evidence: { ...evidence, sample: missing.slice(0, 5) },
            hint: "蓝图没贴全 —— 可能是 apply 中途失败",
        };
    }
    if (wrongCode.length) {
        return {
            ok: false,
            reason: `${wrongCode.length} 台的 code 与蓝图不符（首处 ${JSON.stringify(wrongCode[0])}）`,
            evidence: { ...evidence, sample: wrongCode.slice(0, 5) },
        };
    }
    if (wrongRot.length) {
        return {
            ok: false,
            reason: `${wrongRot.length} 台的朝向与蓝图不符（首处 ${JSON.stringify(wrongRot[0])}）`
                + ` —— 朝向错会让机器的物理占地和进出料口全变`,
            evidence: { ...evidence, sample: wrongRot.slice(0, 5) },
            hint: "这是 A2 的形态：origin 和 code 都对，但方向反了，产线实际不通",
        };
    }
    return { ok: true, reason: null, evidence };
}

/* ══════════════════════════ G6 行为 ══════════════════════════ */

/**
 * 目标形状的产出必须达到理论值的 80%，**而且必须是这条线带来的**。
 *
 * ★ 数据源：`delivered_slices` ★
 * 桥里 `delivered_total` / `delivered_per_sec` 都是"最近 N 片之和"，不是累计计数器：
 * 切片轮转时最老的一片掉出去 → 值会下降（实测 55→48）；最后一片永远在累积 → 偏少。
 * 拿两次的差算速率等于在两个滑动窗口上求斜率。实测：健康线 7 组配对里 6 组判红。
 *
 * `delivered_slices` 是每片固定 `slice_seconds` 的投递计数，直接算平均就与滑窗无关。
 *
 * ★ 但光平均还不够 —— 那是全厂口径 ★
 * 给同一目标加第二条线时，老线自己的产出就超过阈值，新线一根带子都没通也会绿。
 * 所以必须和**贴前的基线**比：新线要么把速率抬上去，要么本身就在达标线上。
 *
 * @param {object} p1  贴前采样的 production（基线；null 表示没取到）
 * @param {object} p2  采样窗口结束时的 production
 */
export function gateG6(intent, p1, p2, expectedRatePerSec) {
    const shape = intent.goal;
    const evidence = { shape, expected_rate: expectedRatePerSec };

    const slices2 = Array.isArray(p2.delivered_slices) ? p2.delivered_slices : null;
    const sliceSecs = p2.slice_seconds;

    if (!slices2 || slices2.length < 2) {
        return {
            ok: false,
            reason: `production 没有足够的 delivered_slices（${slices2 ? slices2.length : 0} 片）—— 无法算速率`,
            evidence,
            hint: "时间片每 10 游戏秒才生成一片，至少等 20 秒再采样",
        };
    }
    if (!(sliceSecs > 0)) {
        return { ok: false, reason: `slice_seconds 不可用（${sliceSecs}）—— 无法换算速率`, evidence };
    }

    // 排除最后一片（还在累积）
    const done2 = slices2.slice(0, slices2.length - 1);

    /* 刚读档：构造时会 push 满 statisticsGraphSlices 个空片，
       所以 slices.length 永远够，"片数不足"这个保护不会触发。
       全部片都空 ⇒ 还没跑起来，不是"零产出"，是"没有数据"。 */
    const anyData = done2.some(s => s && Object.keys(s).length > 0);
    if (!anyData) {
        return {
            ok: false,
            undecidable: true,
            reason: `最近 ${done2.length} 片全是空的 —— 游戏刚加载，还没积累到可判定的数据`,
            evidence,
            hint: "先推进至少 30 游戏秒让片填满",
        };
    }

    const avgRate = (slices) => {
        const done = slices.slice(0, slices.length - 1);
        if (!done.length) return null;
        const counts = done.map(s => (s || {})[shape] || 0);
        const total = counts.reduce((a, b) => a + b, 0);
        return { rate: total / (done.length * sliceSecs), total, counts, n: done.length };
    };

    const after = avgRate(slices2);
    evidence.slices_used = after.n;
    evidence.slice_seconds = sliceSecs;
    evidence.counts_per_slice = after.counts;
    evidence.total_in_window = after.total;
    evidence.rate = +after.rate.toFixed(3);

    /* 形状键从未出现 —— 不能当成"速率为 0"。
       intent.goal 是字符串，production 的键是游戏的 getHash()，
       两者格式差一点查表就是 0，而"线是死的"和"键打错了"要修的地方完全不同。 */
    const appears = done2.some(s => s && shape in s)
        || (p2.produced_slices || []).some(s => s && shape in s);
    if (!appears) {
        const known = new Set();
        for (const s of done2) for (const k of Object.keys(s || {})) known.add(k);
        return {
            ok: false,
            reason: `形状 ${shape} 在最近 ${after.n} 片里从未出现过 —— 无法判定`
                + `（intent.goal 与游戏 hash 格式不符？片里见过的形状：${[...known].slice(0, 6).join("/") || "无"}）`,
            evidence: { ...evidence, known_shapes: [...known].slice(0, 12) },
            hint: "先确认 intent.goal 与 obs.goal.requirement.shape 是同一个字符串",
        };
    }

    if (!(expectedRatePerSec > 0)) {
        return {
            ok: false,
            reason: "理论产出为 0（蓝图里没有可识别的生产机器）—— 没有可比基准，无法判定",
            evidence,
        };
    }

    const target = expectedRatePerSec * 0.8;
    evidence.threshold = +target.toFixed(3);

    /* ★ 贴前基线 ★
       新线要么把全厂速率抬上去（增量），要么全厂本来就在达标线上且这条线不是唯一来源。
       判据：rate_after >= max(target, baseline + target*0.5)
         · 基线很低（0）时 → 只要达到 target 即可
         · 基线已经很高（老线在交）时 → 必须比基线再多出至少半个阈值，
           否则无法证明新线有贡献，宁可判"被既有产能掩盖"。
       这在语义上是"不能证明就算没通过"，而不是"看起来达标就通过"。 */
    let baselineRate = null;
    if (p1 && Array.isArray(p1.delivered_slices) && p1.delivered_slices.length >= 2) {
        const b = avgRate(p1.delivered_slices);
        if (b) baselineRate = b.rate;
    }
    evidence.baseline_rate = baselineRate === null ? null : +baselineRate.toFixed(3);

    if (baselineRate !== null) {
        const mustExceed = Math.max(target, baselineRate + target * 0.5);
        evidence.must_exceed = +mustExceed.toFixed(3);
        if (after.rate < mustExceed) {
            return {
                ok: false,
                reason: `贴前全厂已在交 ${baselineRate.toFixed(3)}/s，贴后 ${after.rate.toFixed(3)}/s`
                    + `（需要至少 ${mustExceed.toFixed(3)}/s 才能证明这条线有贡献）`
                    + ` —— 被既有产能掩盖，无法归因`,
                evidence,
                hint: "老线在交同一个形状时，光看全厂速率说明不了新线通没通；看 G6b 的连通性",
            };
        }
        return { ok: true, reason: null, evidence };
    }

    if (after.rate < target) {
        return {
            ok: false,
            reason: `${shape} 最近 ${after.n} 片平均 ${after.rate.toFixed(3)}/s（共 ${after.total} 个）`
                + ` < 阈值 ${target.toFixed(3)}/s（理论 ${expectedRatePerSec}/s 的 80%）`,
            evidence,
            hint: "只诊断不回滚：回滚会把可能能跑的线拆掉",
        };
    }
    return { ok: true, reason: null, evidence };
}

/* ══════════════════════════ G6b 连通 ══════════════════════════ */

/**
 * 目标线上的每一段都必须有去处。
 *
 * 这是**唯一能防住"方向反了"的闸** —— 因为 dry_run 只报格占用，
 * 而带子的方向在运行时才体现为"有没有 boundAcceptor"。
 *
 * 判据刻意**不看 itemsOnPath**：
 * 实测 4 条死路里有 2 条是空的（items=0），
 * 刚贴完还没流起来的那一刻，有货才判会全部漏掉。
 */
export function gateG6b(intent, items, opts = {}) {
    const expect = expectedCells(intent);
    const beltCells = new Set();       // 只放普通带子
    const tunnelCells = new Set();     // 隧道单独处理
    for (const [k, v] of expect) {
        if (v.kind === "belt") beltCells.add(k);
        else if (v.kind === "underground_belt") tunnelCells.add(k);
    }

    /* ★ 隧道格不会出现在 belt_paths 里 ★
       游戏的地下带没有 Belt 组件，而 beltPaths 只由 Belt 组件构成
       （systems/belt.js 第一行就 `if (!entity.components.Belt) return;`）。
       实测确认：隧道在 (-7,-12)/(-7,-14)，经过它的路径 cells 是
       [-8,-13],[-7,-13],[-6,-13] —— 直接跨过去了，两个隧道格都不在。

       所以拿隧道格去比对"有没有被 path 覆盖"必然全部落空，
       任何含隧道的蓝图都会被判成"没连上"。这里只验普通带子，
       隧道在 evidence 里如实记数，不参与判定。 */

    const toKey = c => `${c[0]},${c[1]}`;
    const covered = new Set();
    const deadEnds = [];
    for (const p of items.paths || []) {
        const onOurLine = (p.cells || []).filter(c => beltCells.has(toKey(c)));
        if (!onOurLine.length) continue;
        for (const c of onOurLine) covered.add(toKey(c));
        /* 用真值判断而不是 `=== null`：
           桥在异常分支里可能根本不带这个 key，`undefined !== null` 会 fail-open。 */
        if (!p.boundAcceptor) {
            deadEnds.push({
                head: p.cells[0], tail: p.cells[p.cells.length - 1],
                len: p.cells.length, items: p.itemsOnPath,
            });
        }
    }

    const uncovered = [...beltCells].filter(k => !covered.has(k));
    const evidence = {
        our_belt_cells: beltCells.size,
        tunnel_cells_not_verifiable: tunnelCells.size,
        covered_cells: covered.size,
        uncovered_cells: uncovered.length,
        dead_end_paths: deadEnds.length,
        dead_ends: deadEnds.slice(0, 6),
        paths_returned: (items.paths || []).length,
    };

    /* ★ 真空绿：没有一个带子格要验 ★
       只有机器、只有隧道、或蓝图自叠把带子吃掉时，beltCells 是空的，
       下面所有断言都会在空集上平凡成立 —— 那是"零断言真空绿"，
       比红更危险，因为它看起来像通过。 */
    if (beltCells.size === 0) {
        return {
            ok: false,
            reason: tunnelCells.size > 0
                ? `蓝图里没有普通带子格（只有 ${tunnelCells.size} 格隧道）—— 没有可验证的连通性`
                : "蓝图里没有带子 —— 没有可验证的连通性（真空绿）",
            evidence: {
                our_belt_cells: 0,
                tunnel_cells_not_verifiable: tunnelCells.size,
                collisions: Array.isArray(expect.collisions) ? expect.collisions.length : 0,
            },
            hint: "如果确实是一条纯机器产线（机器直连），这道闸不适用，应显式跳过而不是报绿",
        };
    }

    /* 解析失败（桥内部 try 抛错）会和"真的没连上"给出同样的表象。
       必须先把这两件事分开，否则会去修一条本来没问题的线。 */
    if (items.beltError) {
        return {
            ok: false,
            reason: `debug_items 自己报错（${items.beltError}）—— 无法判定连通性`,
            evidence: { ...evidence, beltError: items.beltError },
        };
    }
    if (!Array.isArray(items.paths)) {
        return {
            ok: false,
            reason: "debug_items 没有返回 paths 数组 —— 无法判定连通性",
            evidence,
        };
    }

    /* 桥对 paths 做了 `slice(0, 40)`，但同时给了 `pathCount`（未截断的总数）。
       两者不等 ⇒ 我们看到的只是前 40 条 ⇒ "没覆盖"不代表"没连上"，
       而是"我们没看到"。这种情况必须显式说出来，不能当成红 ——
       否则会误导去修一条本来没问题的线。 */
    const totalPaths = typeof items.pathCount === "number" ? items.pathCount : null;
    const truncated = totalPaths !== null && totalPaths > evidence.paths_returned;
    evidence.total_path_count = totalPaths;
    evidence.truncated = truncated;

    /* ★ 截断本身就该让结论降级 ★
       原实现只在 `truncated && uncovered.length > 0` 时判"无法判定"。
       但当目标线恰好被覆盖时它会绿 —— 而截断意味着我们**没看到全部路径**，
       可能有属于目标线、但排在 40 条之外的那段（它的 boundAcceptor 也许是 null）。
       "恰好看到的部分没问题"不等于"整条线没问题"。
       所以只要 truncated，这次结论就只能是"无法判定"，不管覆没覆盖。 */
    if (truncated) {
        return {
            ok: false,
            undecidable: true,
            reason: `debug_items 只返回了 ${evidence.paths_returned}/${totalPaths} 条路径（被截断）`
                + (uncovered.length ? `，且目标线有 ${uncovered.length} 格没出现在其中` : "")
                + ` —— 没看到全部路径，无法判定连通性`,
            evidence: { ...evidence, sample: uncovered.slice(0, 5) },
            hint: "缩小 debug_items 的 region 到目标线附近再试",
        };
    }

    if (deadEnds.length) {
        const d = deadEnds[0];
        return {
            ok: false,
            reason: `目标线上有 ${deadEnds.length} 段没有去处，首段 ${JSON.stringify(d.head)}..${JSON.stringify(d.tail)}`
                + `（${d.len} 格，${d.items} 个物品）`,
            evidence,
            hint: "带子末端没有接收者 = 货会堆在那里，上游被堵死",
        };
    }
    if (uncovered.length) {
        return {
            ok: false,
            reason: `蓝图里 ${uncovered.length} 格带子没出现在任何路径上（首处 ${uncovered[0]}）`,
            evidence: { ...evidence, sample: uncovered.slice(0, 5) },
            hint: "可能是带子没连上（孤立格），或 debug_items 的解析漏了",
        };
    }
    return { ok: true, reason: null, evidence };
}

/* ══════════════════════════ G2' 同源自洽（贴前，零写入） ══════════════════════════ */

/**
 * `paste` 用的载荷与 G4 的期望值必须是**同一张图**。
 *
 * ★ 这是新增三道闸里最关键的一道 ★
 *
 * `runGates` 把 `intent.blueprint` 交给 paste（载荷），G4 却拿 `intent.entities`
 * 当期望值。两者在编译器里同源于 `plan.entities`（compile.mjs 的 writeHandoff），
 * 所以**编译器自己算错时，两边一起错** —— G4 拿错的期望去比游戏里忠实落地的错值，
 * 永远绿。2026-10-26 的 L4 事故就是这么漏掉的。
 *
 * G2' 补的是这条腿：decode 一次 blueprint（现有五闸全文一次都没 decode 过），
 * 逐格比对 (code, rot)，再对每格 belt 断言
 *     code === 1 + rotationVariant                      （belt-rules 命题 A，1906/1906）
 *     (rv, rot) 反推的 beltEntry/beltExit === inDir/outDir（belt-rules 命题 B）
 * 任何一条不满足 ⇒ 红。它纯离线，`--plan`（不 apply）阶段就能跑，零写入。
 *
 * 归一化：blueprint 的 `dx/dy` 与 intent 的 `anchor+dx/dy` 可能差一个平移
 * （实测 L4 交接件两者差的就是 anchor），所以两侧各自按 min corner 归一。
 *
 * 它验不了什么（诚实记录）：如果编译器把 in/out 与几何**一起**写错（形态 C），
 * 内部完全自洽，这道闸会绿 —— 那种情况只有 G8 能抓。
 *
 * @param {object} intent
 * @param {Function} [decode] 注入点（默认 decodeBlueprint），便于单测替换
 */
export function gateIntentMatchesBlueprint(intent, decode = decodeBlueprint) {
    const evidence = {};
    if (typeof intent.blueprint !== "string" || !intent.blueprint) {
        return {
            ok: false,
            reason: "intent 缺 blueprint 字段 —— paste 会拿到 undefined",
            evidence,
        };
    }
    let bp;
    try { bp = decode(intent.blueprint); } catch (e) {
        return { ok: false, reason: `blueprint 解码失败：${e.message}`, evidence };
    }
    if (!Array.isArray(bp.entities) || !bp.entities.length) {
        return { ok: false, reason: "blueprint 里没有任何实体", evidence };
    }
    if (!Array.isArray(intent.entities) || !intent.entities.length) {
        return { ok: false, reason: "intent.entities 为空", evidence };
    }
    const a = intent.anchor;
    if (!Array.isArray(a) || a.length !== 2) {
        return { ok: false, reason: "intent.anchor 必须是 [x,y]", evidence };
    }

    const bxs = bp.entities.map(e => e.dx), bys = bp.entities.map(e => e.dy);
    const ixs = intent.entities.map(e => a[0] + e.dx), iys = intent.entities.map(e => a[1] + e.dy);
    const bmx = Math.min(...bxs), bmy = Math.min(...bys);
    const imx = Math.min(...ixs), imy = Math.min(...iys);
    const bpMap = new Map(bp.entities.map(e => [cellKey([e.dx - bmx, e.dy - bmy]), e]));
    const inMap = new Map(intent.entities.map((e, i) => [cellKey([ixs[i] - imx, iys[i] - imy]), e]));

    evidence.blueprint_count = bpMap.size;
    evidence.intent_count = inMap.size;

    const onlyBp = [...bpMap.keys()].filter(x => !inMap.has(x));
    const onlyIn = [...inMap.keys()].filter(x => !bpMap.has(x));
    const fieldDiff = [], dirBad = [];

    for (const [key, b] of bpMap) {
        const e = inMap.get(key);
        if (!e) continue;
        /* 先比 rot 再比 code：rot 错通常意味着"同一个 code、不同的物理占地"，
           比 code 错更常见也更难从计数上看出来。 */
        if (((b.rot | 0) % 360) !== ((e.rot | 0) % 360)) {
            fieldDiff.push({ cell: key, field: "rot", blueprint: b.rot, intent: e.rot });
            continue;
        }
        if (b.code !== e.code) {
            fieldDiff.push({ cell: key, field: "code", blueprint: b.code, intent: e.code });
            continue;
        }
        if (e.kind !== "belt") continue;

        /* ★ 每格带子都必须有 rv ★
           缺 rv 时 `| 0` 会把 undefined 变成 0，于是"忘了写"被静默当成直带 ——
           那正是要抓的形态。 */
        if (!Number.isInteger(e.rotationVariant)) {
            dirBad.push({ cell: key, nodeId: e.nodeId, field: "rotationVariant", got: e.rotationVariant });
            continue;
        }
        const wantCode = beltCode(e.rotationVariant);
        if (b.code !== wantCode || e.code !== wantCode) {
            fieldDiff.push({
                cell: key, field: "code-vs-rv",
                blueprint: b.code, intentCode: e.code, wantCode, rv: e.rotationVariant,
            });
            continue;
        }
        /* ★ inDir/outDir 必须显式声明，不许 fail-open ★
           缺失时跳过 = 这道闸对 L4 那种"声明与几何不符"的事故完全失明。 */
        if (!e.inDir || !e.outDir) {
            dirBad.push({ cell: key, nodeId: e.nodeId, field: "inDir/outDir", got: { in: e.inDir, out: e.outDir } });
            continue;
        }
        const gi = beltEntry(e.rotationVariant, e.rot);
        const go = beltExit(e.rotationVariant, e.rot);
        if (gi !== e.inDir || go !== e.outDir) {
            dirBad.push({
                cell: key, nodeId: e.nodeId, rv: e.rotationVariant, rot: e.rot,
                declared: { in: e.inDir, out: e.outDir },
                from_rv_rot: { in: gi, out: go },
            });
        }
    }

    Object.assign(evidence, {
        only_in_blueprint: onlyBp.slice(0, 5),
        only_in_intent: onlyIn.slice(0, 5),
        field_diff: fieldDiff.slice(0, 5),
        direction_inconsistent: dirBad.slice(0, 5),
        field_diff_count: fieldDiff.length,
        direction_inconsistent_count: dirBad.length,
    });

    if (bpMap.size !== inMap.size || onlyBp.length || onlyIn.length) {
        return {
            ok: false,
            reason: `intent.entities 与 blueprint 不是同一张图`
                + `（蓝图 ${bpMap.size} 格 / intent ${inMap.size} 格，`
                + `只在蓝图 ${onlyBp.length} 格、只在 intent ${onlyIn.length} 格）`
                + ` —— paste 用的不是 G4 比的那张图`,
            evidence,
            hint: "这是形状 C 的前身：paste 的载荷与期望值不同源，G4 再准也没意义",
        };
    }
    if (fieldDiff.length) {
        return {
            ok: false,
            reason: `${fieldDiff.length} 格在 blueprint 与 intent 之间不一致（首处 ${JSON.stringify(fieldDiff[0])}）`
                + ` —— paste 的载荷不是编译器推理的那张图`,
            evidence,
            hint: "code-vs-rv 说明 rv 与 code 矛盾；rot 不一致说明两侧的旋转不同源",
        };
    }
    if (dirBad.length) {
        return {
            ok: false,
            reason: `${dirBad.length} 格的 (rot,rotationVariant) 与声明的 inDir/outDir 不自洽`
                + `（首处 ${JSON.stringify(dirBad[0])}）`,
            evidence,
            hint: "L4 的形态：intent 里写的是拐角语义，几何字段却是直带",
        };
    }
    return { ok: true, reason: null, evidence };
}

/* ══════════════════════════ G7 逐格流向 ══════════════════════════ */

/**
 * 贴后：游戏 `debug_items.paths[].cells` 的**邻接关系**必须与声明的 in/out 一致。
 *
 * 与 G4 的根本区别：G4 问"我要求的东西贴准了吗"（期望来自 intent），
 * G7 问"世界现在真的这么流吗"（期望来自游戏自己的 `entityPath`）。
 * 事故里游戏把拐角重算成直带后，坐标没变、`code` 也没变（都还是 1），
 * 变的只有 `rotationVariant` —— 而 `cells` 的邻接是**唯一**能看见这件事的 oracle。
 *
 * 判据（每个声明了 inDir/outDir 的带子格）：
 *   中间格：actualIn  = dirOf(cell, prev)
 *           actualOut = dirOf(cell, next)                       （链尾用 boundAcceptor）
 *   链首格：声明的上游若在蓝图内是带子 → 它必须出现在同一 path 的 prev，
 *           否则是 `disconnected-from-belt`；
 *           若上游是机器 → 它的 outDir 必须指向本格。
 *
 * ★ 不许 fail-open ★
 *   `not_on_any_path`（格不在任何 path 上）与 `disconnected-from-belt` 都算红。
 *   只有"链尾且游戏没给接收者"才算不可验证（那是 G6b 的职责）。
 *
 * 截断（`pathCount > paths.length`）→ 无法判定，不是绿。
 */
export function gateG7flow(intent, items) {
    const evidence = {};
    if (!items || typeof items !== "object") {
        return { ok: false, reason: "debug_items 没有返回任何东西", evidence };
    }
    if (items.beltError) {
        return { ok: false, reason: `debug_items 自己报错（${items.beltError}）—— 无法判定流向`, evidence };
    }
    if (!Array.isArray(items.paths)) {
        return { ok: false, reason: "debug_items 没有返回 paths 数组 —— 无法判定流向", evidence };
    }
    const total = typeof items.pathCount === "number" ? items.pathCount : items.paths.length;
    evidence.paths_returned = items.paths.length;
    evidence.total_path_count = total;
    if (total > items.paths.length) {
        evidence.truncated = true;
        return {
            ok: false,
            undecidable: true,
            reason: `debug_items 只返回了 ${items.paths.length}/${total} 条路径（被截断）—— 没看到全部，无法判定流向`,
            evidence,
            hint: "缩小 debug_items 的 region 到目标线附近再试",
        };
    }

    const at = new Map();
    items.paths.forEach((p, pi) => {
        (p.cells || []).forEach((c, ci) => {
            if (!at.has(cellKey(c))) at.set(cellKey(c), { pi, ci });
        });
    });
    evidence.cells_indexed = at.size;

    const a = intent.anchor;
    const byCell = new Map();
    for (const e of intent.entities || []) byCell.set(cellKey([a[0] + e.dx, a[1] + e.dy]), e);

    const violations = [];
    let checkedIn = 0, checkedOut = 0, unverifiableOut = 0;
    for (const e of intent.entities || []) {
        if (e.kind !== "belt") continue;
        const cell = [a[0] + e.dx, a[1] + e.dy];
        const loc = at.get(cellKey(cell));
        if (!loc) {
            violations.push({ cell, nodeId: e.nodeId, field: "path", got: "not_on_any_path" });
            continue;
        }
        const p = items.paths[loc.pi];
        const cells = p.cells || [];

        if (e.inDir) {
            if (loc.ci > 0) {
                const actualIn = dirOf(cell, cells[loc.ci - 1]);
                checkedIn++;
                if (actualIn !== e.inDir) {
                    violations.push({ cell, nodeId: e.nodeId, field: "in", want: e.inDir, got: actualIn, path: loc.pi, idx: loc.ci });
                }
            } else {
                const upCell = stepCell(cell, e.inDir);
                const up = byCell.get(cellKey(upCell));
                if (!up) {
                    violations.push({ cell, nodeId: e.nodeId, field: "in", want: e.inDir, got: "no-upstream-in-blueprint", upstreamCell: upCell });
                } else if (up.kind === "belt") {
                    violations.push({ cell, nodeId: e.nodeId, field: "in", want: e.inDir, got: "disconnected-from-belt", upstreamNode: up.nodeId, path: loc.pi });
                } else if (up.outDir && up.outDir !== OPP[e.inDir]) {
                    violations.push({ cell, nodeId: e.nodeId, field: "in", want: e.inDir, got: `upstream(${up.nodeId}).outDir=${up.outDir}` });
                } else {
                    checkedIn++;
                }
            }
        }

        if (e.outDir) {
            let actualOut = null, via = null;
            if (loc.ci < cells.length - 1) {
                actualOut = dirOf(cell, cells[loc.ci + 1]);
                via = "next";
            } else if (Array.isArray(p.boundAcceptor)) {
                actualOut = dirOf(cell, p.boundAcceptor);
                via = "boundAcceptor";
            }
            if (actualOut === null) {
                /* 链尾 + 没有接收者：这是 G6b 的判据，G7 不重复判，
                   但必须记数 —— 静默跳过会让"整条线断头"在 G7 里看起来全绿。 */
                unverifiableOut++;
            } else {
                checkedOut++;
                if (actualOut !== e.outDir) {
                    violations.push({ cell, nodeId: e.nodeId, field: "out", want: e.outDir, got: actualOut, via, path: loc.pi, idx: loc.ci });
                }
            }
        }
    }

    Object.assign(evidence, {
        violations: violations.length,
        checked_in: checkedIn,
        checked_out: checkedOut,
        unverifiable_out: unverifiableOut,
    });

    /* 真空绿保护：一条可判的邻接都没比过（比如蓝图里的带子格全不在 path 上，
       或者根本没声明方向），不能因为 violations=0 就报绿。 */
    if (checkedIn === 0 && checkedOut === 0) {
        return {
            ok: false,
            reason: "没有任何一格能比出实际流向（checked_in=checked_out=0）—— 真空绿",
            evidence: { ...evidence, sample: violations.slice(0, 6) },
            hint: "带子是不是没声明 inDir/outDir？或者 debug_items 的 paths 里没有这条线",
        };
    }
    if (violations.length) {
        return {
            ok: false,
            reason: `${violations.length} 处运行时流向与 intent 声明不符（首处 ${JSON.stringify(violations[0])}）`
                + ` —— 游戏实际把货送去的方向 ≠ 蓝图说的方向`,
            evidence: { ...evidence, sample: violations.slice(0, 6) },
            hint: "L4 的形态：intent/blueprint/粘贴三方自洽，但游戏运行时的拓扑不是那张图",
        };
    }
    return { ok: true, reason: null, evidence };
}

/* ══════════════════════════ G8 链划分 ══════════════════════════ */

/**
 * 贴后：**蓝图应当产生的带子链** 必须与 **游戏实际的 path** 逐格同序。
 *
 * ★ 这是唯一能在形态 C 下变红的闸 ★
 * 形态 C：intent 与 blueprint 都自洽地写成直带（G2' 绿）、游戏也忠实贴成直带（G4 绿）、
 * 每格都有去处（G6b 绿），但货到不了切割机。G8 比的是两个独立来源：
 *   · 期望：从蓝图自己的 `succ(c) = c + DIRV[outDir]` 推出来的链划分；
 *   · 实际：游戏 `beltPaths` 连出来的 path（上游→下游序）。
 * 事故里期望链尾指向切割机，游戏链却接到 82 格绕行、最终进 hub —— 链划分不等。
 *
 * 比对是**顺序敏感**的：`[[a,b],[c]]` 与 `[[a],[b,c]]` 不是同一张图。
 */
export function gateG8chains(intent, items) {
    const evidence = {};
    if (!items || typeof items !== "object") {
        return { ok: false, reason: "debug_items 没有返回任何东西", evidence };
    }
    if (items.beltError) {
        return { ok: false, reason: `debug_items 自己报错（${items.beltError}）—— 无法判定链划分`, evidence };
    }
    if (!Array.isArray(items.paths)) {
        return { ok: false, reason: "debug_items 没有返回 paths 数组 —— 无法判定链划分", evidence };
    }
    const total = typeof items.pathCount === "number" ? items.pathCount : items.paths.length;
    evidence.paths_returned = items.paths.length;
    evidence.total_path_count = total;
    if (total > items.paths.length) {
        evidence.truncated = true;
        return {
            ok: false,
            undecidable: true,
            reason: `debug_items 只返回了 ${items.paths.length}/${total} 条路径（被截断）—— 没看到全部链，无法判定`,
            evidence,
            hint: "缩小 debug_items 的 region 到目标线附近再试",
        };
    }

    const a = intent.anchor;
    const allEnts = intent.entities || [];
    const belts = allEnts.filter(e => e.kind === "belt");
    if (!belts.length) {
        return {
            ok: false,
            reason: "蓝图里没有带子 —— 没有可推导的链（真空绿）",
            evidence,
            hint: "纯机器直连的产线这道闸不适用，应显式跳过而不是报绿",
        };
    }
    const byCell = new Map();
    for (const e of belts) {
        /* ★ 缺 in/out 不许 fail-open ★
           没有方向就推不出链，跳过等于"图对不上我也看不出来"。 */
        if (!e.inDir || !e.outDir) {
            return {
                ok: false,
                reason: `带子 ${e.nodeId} 缺 inDir/outDir —— 无法推导链（不许 fail-open）`,
                evidence: { ...evidence, nodeId: e.nodeId },
            };
        }
        byCell.set(cellKey([a[0] + e.dx, a[1] + e.dy]), e);
    }
    evidence.expected_cells = byCell.size;

    /* 1) 从蓝图推链：链头 = 链内没有 pred 的格 */
    const hasPred = new Set();
    for (const [key, e] of byCell) {
        const pred = stepCell(key.split(",").map(Number), e.inDir);
        if (pred && byCell.has(cellKey(pred))) hasPred.add(key);
    }
    const expectedChains = [];
    for (const [key, e] of byCell) {
        if (hasPred.has(key)) continue;
        const chain = [];
        let cur = key, guard = 0;
        while (cur !== null && guard++ <= byCell.size + 2) {
            chain.push(cur.split(",").map(Number));
            const ce = byCell.get(cur);
            const nxt = stepCell(chain[chain.length - 1], ce.outDir);
            cur = nxt && byCell.has(cellKey(nxt)) ? cellKey(nxt) : null;
        }
        if (guard > byCell.size + 2) {
            /* succ 成环 ⇒ 没有链头能走到头。蓝图里出现环是错的，
               继续走会把同一格比两次、掩盖问题。 */
            return {
                ok: false,
                reason: `蓝图推出的带子链有环（从 ${key} 出发超过 ${byCell.size} 步）—— 蓝图自身不成立`,
                evidence: { ...evidence, cycle_start: key },
            };
        }
        const tail = chain[chain.length - 1];
        const te = byCell.get(cellKey(tail));
        const exitCell = stepCell(tail, te.outDir);
        const exitEnt = allEnts.find(x => x.kind !== "belt"
            && a[0] + x.dx === exitCell[0] && a[1] + x.dy === exitCell[1]);
        expectedChains.push({ cells: chain, exitCell, exitNode: exitEnt ? exitEnt.nodeId : null, broken: false });
    }

    /* ★ 声明邻接必须互反 ★
       某格声明 outDir 指向另一格带子，那另一格必须声明 inDir 指回本格 —— 否则
       "蓝图说的货流"本身是断的（形态 C：两侧各说各的）。这类格子上面推不出链，
       以前会被静默漏掉；现在显式列成一条「断链」，照样参与逐格比对。 */
    const brokenCells = [];
    for (const [key, e] of byCell) {
        const succ = stepCell(key.split(",").map(Number), e.outDir);
        const se = succ && byCell.get(cellKey(succ));
        if (se && se.inDir !== OPP[e.outDir]) {
            brokenCells.push({ cell: key, nodeId: e.nodeId, outDir: e.outDir, succCell: succ, succIn: se.inDir, succNode: se.nodeId });
        }
        const pred = stepCell(key.split(",").map(Number), e.inDir);
        const pe = pred && byCell.get(cellKey(pred));
        if (pe && pe.outDir !== OPP[e.inDir]) {
            brokenCells.push({ cell: key, nodeId: e.nodeId, inDir: e.inDir, predCell: pred, predOut: pe.outDir, predNode: pe.nodeId });
        }
    }
    if (brokenCells.length) {
        evidence.broken_adjacency = brokenCells.slice(0, 5);
        return {
            ok: false,
            reason: `蓝图内部有 ${brokenCells.length} 处带子邻接不互反（首处 ${JSON.stringify(brokenCells[0])}）`
                + ` —— 这一格声明的方向与邻格声明的不对接，货流在蓝图里就是断的`,
            evidence,
            hint: "形态 C：in/out 文本与几何可以各自自洽，但相邻两格对不上",
        };
    }

    /* 每一格带子都必须恰好落在一条推出来的链里（上面已保证邻接互反，
       这里兜"链推导漏格"这类实现级错误）。 */
    const seen = new Set(expectedChains.flatMap(ch => ch.cells.map(cellKey)));
    if (seen.size !== byCell.size) {
        const missing = [...byCell.keys()].filter(k => !seen.has(k));
        return {
            ok: false,
            reason: `蓝图推出的链只覆盖 ${seen.size}/${byCell.size} 格带子（首处漏 ${missing[0]}）—— 链推导不完整`,
            evidence: { ...evidence, missing: missing.slice(0, 5) },
        };
    }
    evidence.expected_chains = expectedChains.length;

    /* 2) 实际链：所有与本蓝图带子格有交集的 path，按 cells 原序 */
    const actual = [];
    for (const p of items.paths) {
        if ((p.cells || []).some(c => byCell.has(cellKey(c)))) actual.push(p);
    }
    evidence.actual_chains = actual.length;

    const norm = cells => cells.map(cellKey).join(">");
    const expectMap = new Map(expectedChains.map(ch => [norm(ch.cells), ch]));
    const actualMap = new Map(actual.map(p => [norm(p.cells), p]));
    const missing = [], extra = [];
    for (const [sig, ch] of expectMap) if (!actualMap.has(sig)) missing.push({ sig, cells: ch.cells, exitNode: ch.exitNode, exitCell: ch.exitCell });
    for (const [sig, p] of actualMap) if (!expectMap.has(sig)) extra.push({ sig, cells: p.cells, acceptor: p.boundAcceptor });

    Object.assign(evidence, {
        missing_chains: missing.length,
        extra_chains: extra.length,
        missing: missing.slice(0, 3).map(m => ({ len: m.cells.length, exitNode: m.exitNode, exitCell: m.exitCell, head: m.cells[0] })),
        extra: extra.slice(0, 3).map(m => ({ len: m.cells.length, head: m.cells[0], tail: m.cells[m.cells.length - 1], acceptor: m.acceptor })),
    });

    if (missing.length || extra.length) {
        let reason = `${missing.length} 条蓝图链在游戏里不存在、${extra.length} 条游戏链不在蓝图里`;
        const m = missing[0];
        if (m) {
            const mSet = new Set(m.cells.map(cellKey));
            const cand = actual.find(p => (p.cells || []).some(c => mSet.has(cellKey(c))));
            if (cand) {
                const tail = cand.cells[cand.cells.length - 1];
                reason += `；期望链尾 ${m.exitNode || "?"}@${JSON.stringify(m.exitCell)}，`
                    + `游戏却把这条货流接到了 ${JSON.stringify(tail)}`
                    + (Array.isArray(cand.boundAcceptor) ? `（boundAcceptor=${JSON.stringify(cand.boundAcceptor)}）` : "（无接收者）")
                    + `，链长 ${m.cells.length} → ${cand.cells.length}`;
            } else {
                reason += `；首条缺失链的链头 ${JSON.stringify(m.cells[0])} 不出现在任何游戏 path 上`;
            }
        }
        return {
            ok: false,
            reason,
            evidence,
            hint: "L4 事故的形态：拐角被游戏重算成直带后，货顺着既有绕行接到了别处",
        };
    }
    return { ok: true, reason: null, evidence };
}

/* ══════════════════════════ 回滚 ══════════════════════════ */

/**
 * 回滚：把这次贴进去的东西删掉。
 *
 * 约束：`bulk_delete` 只支持 `region:[x0,y0,x1,y1]`，不支持按 uid 删。
 * 所以 uid 清单**不是删除指令**，而是 Region 删除的**准入校验**：
 * 我们算出新增实体的最小包围盒，先 dry_run 那个 region，
 * 断言"region 内不含任何贴前就存在的 uid"。
 * 只要混进一个旧实体，就说明这个 region 会误伤旧产线，拒绝执行。
 */
export async function rollback(before, after, opts = {}) {
    const added = [];
    for (const [uid, e] of after.byUid) if (!before.byUid.has(uid)) added.push(e);
    if (!added.length) return { ok: true, deleted: 0, note: "没有新增实体，无需回滚" };

    const xs = added.map(e => e.x), ys = added.map(e => e.y);
    const region = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];

    // 准入校验：region 内不能有贴前就存在的实体
    /* 准入校验：region 内不能有**仍然活着的**既有实体。
       ⚠️ 不能拿 before.byUid 直接判 —— A3 场景里那个旧实体已经被 paste 销毁了，
       但它的记录还在 before 里。把它当 outsider 会导致"回滚计划 ok、执行必拒"，
       而那正是最需要回滚的场景（新实体恰好覆盖旧实体的格）。
       判据改成：在 before 里存在 **且** 在 after 里仍然存在。 */
    const outsiders = [];
    for (const [uid, e] of before.byUid) {
        if (!after.byUid.has(uid)) continue;       // 已被销毁的不算外人
        if (e.x >= region[0] && e.x <= region[2] && e.y >= region[1] && e.y <= region[3]) {
            outsiders.push({ uid, cell: [e.x, e.y], type: e.type });
        }
    }
    if (outsiders.length) {
        return {
            ok: false,
            reason: `回滚 region ${JSON.stringify(region)} 里混着 ${outsiders.length} 个既有实体，删它会误伤旧产线`,
            sample: outsiders.slice(0, 5),
            hint: "需要人工决定：要么按 uid 逐个删（桥不支持），要么整档恢复",
        };
    }

    const dry = await rpc("act", { op: "bulk_delete", region, dry_run: true });
    if (dry.would_delete !== added.length) {
        return {
            ok: false,
            reason: `region 内应删 ${added.length} 个，实际会删 ${dry.would_delete} 个 —— 不一致`,
            dry,
        };
    }
    if (opts.dryRun) return { ok: true, dryRun: true, would_delete: dry.would_delete, region };

    /* 真删前后各取一次时钟。
       ⚠️ 不能要求 tick **完全不变** —— 游戏主循环在两次 RPC 之间
       自己会走 0.025~0.067 游戏秒，所以"完全不变"几乎恒假。
       实测：10 次真回滚里 8 次被判"世界推进了，结果不可信"，而 applied 已经是 3/3。
       合理的判据是"推进量小到不足以发生大规模变化"（比如 < 1 游戏秒）。 */
    const t0 = (await rpc("debug_loop", {})).tick;
    const r = await rpc("act", { op: "bulk_delete", region });
    const t1 = (await rpc("debug_loop", {})).tick;
    const drift = t1 - t0;

    const failed = (r.failed || []).length;
    if (r.applied !== added.length || failed > 0) {
        return {
            ok: false,
            reason: `回滚只删了 ${r.applied}/${added.length} 个（失败 ${failed} 个）—— 回滚不完整`,
            applied: r.applied, expected: added.length, failed: r.failed, region,
        };
    }
    if (drift >= 1) {
        return {
            ok: false,
            reason: `世界在回滚期间推进了 ${drift.toFixed(2)} 游戏秒 —— 结果可能不完整`,
            applied: r.applied, region, tick_drift: +drift.toFixed(3),
        };
    }
    return { ok: true, deleted: r.applied, region, tick_drift: +drift.toFixed(3) };
}

/* ══════════════════════════ 主流程 ══════════════════════════ */

function loadIntent(file) {
    const raw = fs.readFileSync(file, "utf8");
    const j = JSON.parse(raw);
    for (const k of ["goal", "anchor", "entities"]) {
        if (!(k in j)) throw new Error(`intent 缺字段 ${k}`);
    }
    return j;
}

/**
 * 该线理论上每秒能交付几个成品。
 *
 * ★ 不能只用「矿机数 × 单台速率」★
 * 每件成品需要的矿石不是 1 份：
 *   · stacker 吃 2 份输入产 1 份 → 输出 ≤ 输入/2
 *   · 双输入 painter/mixer 同理
 * 2 台矿机的 CpCpCpCp 线按"矿机数×速率"算是 0.8/s，而它物理上只能交付 0.4/s ——
 * 阈值 0.64 永远达不到，任何带 stacker/双输入上色的线都会被判死。
 *
 * 这里按实体种类给保守折算：把每种机器的**速率上限**取出来，
 * 遇到"消耗多份输入"的种类再除以它的输入份数。
 *
 * 数值来自 op-templates 的 ratePerSec（已与源码核对）：
 *   miner 0.4 / cutter 0.5 / rotater 2.0 / painter 1/3 / mixer 0.4 / stacker 0.25
 * stacker 与 mixer 是二进一，所以各自产出上限还要除以 2 的实际输入需求。
 */
const BASE_RATE = {
    miner: 0.4, cutter: 0.5, rotater: 2.0,
    painter: 1 / 3, mixer: 0.4, stacker: 0.25,
    balancer: null, trash: null, belt: null, underground_belt: null, hub: null,
};
/** 这些机器吃 2 份输入才产 1 份 —— 产出速率要按输入份数折算 */
const INPUT_FACTOR = { stacker: 2, mixer: 2 };

const MUL = [1, 1.5, 2, 3, 4, 6, 7, 8];

function upgradesMul(level) {
    const l = Math.max(0, level | 0);
    // 前 8 档查表；超出时按"每档 +0.5"保守外推（游戏 fixedImprovements 之后还有 1000 档）
    if (l < MUL.length) return MUL[l];
    return MUL[MUL.length - 1] + (l - (MUL.length - 1)) * 0.5;
}

/**
 * @param {object} intent
 * @param {{miner?:number, processors?:number, painting?:number}} upgrades
 * @returns {number} 保守的成品交付速率上限（0 表示算不出）
 */
export function expectedRateOf(intent, upgrades = {}) {
    const counts = {};
    for (const e of intent.entities || []) counts[e.kind] = (counts[e.kind] || 0) + 1;

    let bound = Infinity;
    let anyKnown = false;
    for (const [kind, n] of Object.entries(counts)) {
        const base = BASE_RATE[kind];
        if (base === undefined || base === null) continue;
        // 档位：矿机看 miner，其它加工看 processors，上色看 painting
        const lvl = kind === "miner" ? upgrades.miner
            : (kind === "painter" || kind === "mixer") ? upgrades.painting
            : upgrades.processors;
        const speed = base * upgradesMul(lvl || 0);
        const factor = INPUT_FACTOR[kind] || 1;
        // 这一类的合计产出上限
        const cap = (n * speed) / factor;
        bound = Math.min(bound, cap);
        anyKnown = true;
    }

    if (!anyKnown) return 0;
    return +bound.toFixed(4);
}

/**
 * `debug_items` 要查的区域必须**覆盖 intent 的 bbox**，不能写死。
 * 写死 [-80,80]² 时，贴到范围外的蓝图会得到空覆盖 → G6b 假红。
 * 用 origin 而不是 footprint：多格机器的 origin 就够把 bbox 撑到位，
 * 而 footprint 需要 kind（G7/G8 只关心带子）。
 */
export function itemsRegionFor(intent, pad = 12) {
    const ax = intent.anchor[0], ay = intent.anchor[1];
    const xs = (intent.entities || []).map(e => ax + e.dx);
    const ys = (intent.entities || []).map(e => ay + e.dy);
    return [
        Math.min(ax, ...xs) - pad, Math.min(ay, ...ys) - pad,
        Math.max(ax, ...xs) + pad, Math.max(ay, ...ys) + pad,
    ].map(Math.round);
}

export async function runGates(intent, opts = {}) {
    const results = [];
    const record = (id, r) => {
        results.push({ id, ok: r.ok, reason: r.reason, evidence: r.evidence, hint: r.hint });
        return r.ok;
    };

    /* ── G2' 同源自洽（纯离线、零写入、最先跑）──
       放在时钟闸之前：它不需要任何采样，坏蓝图应该在碰游戏之前就被拒掉。
       这道闸红了就不能贴 —— paste 的载荷与 G4 的期望不同源，后面全部无意义。 */
    const g2 = gateIntentMatchesBlueprint(intent);
    if (!record("G2'-source", g2)) return { ok: false, results, fatal: true };

    // ── G-1 时钟 ──
    const clock = await gateClock(opts.probeTicks || 600);
    if (!record("G-1-clock", clock)) return { ok: false, results, fatal: true };

    const before = await snapshot();

    /* 贴前基线：G6 需要它来区分"这条线带来的产出"和"老线本来就在交"。
       取不到就用 null，G6 会退回"只看绝对速率"的口径并在 evidence 里标注。 */
    let baselineProd = null;
    try { baselineProd = await rpc("production", { slices: 6 }); } catch (e) { /* 新存档可能还没数据 */ }
    if (before.truncated) {
        results.push({ id: "G0-context", ok: false, reason: "obs 被截断（实体超过 max_entities），任何判据都不可靠" });
        return { ok: false, results, fatal: true };
    }

    // ── 诊断：目标与 intent 是否一致 ──
    const goalMatches = before.goal && before.goal.requirement
        && before.goal.requirement.shape === intent.goal;
    results.push({
        id: "diag-goal-match", ok: goalMatches,
        reason: goalMatches ? null : `当前目标 ${before.goal && before.goal.requirement && before.goal.requirement.shape} ≠ 蓝图目标 ${intent.goal}`,
        diagnosticOnly: true,
    });

    // ── G3 净空（dry_run，零写入）──
    const dry = await rpc("act", {
        op: "paste_blueprint", text: intent.blueprint,
        x: intent.anchor[0], y: intent.anchor[1], dry_run: true,
    });
    const g3 = await gateG3(intent, dry);
    if (!record("G3-clearance", g3)) return { ok: false, results };

    if (!opts.apply) {
        results.push({ id: "apply", ok: true, reason: null, skipped: true, note: "未给 --apply，停在这里（零写入）" });
        return { ok: true, results, planOnly: true };
    }

    // ── 真粘贴 ──
    const paste = await rpc("act", {
        op: "paste_blueprint", text: intent.blueprint,
        x: intent.anchor[0], y: intent.anchor[1],
        charge: opts.charge === undefined ? false : opts.charge,
    });
    results.push({
        id: "apply", ok: paste.applied > 0,
        reason: paste.applied > 0 ? null : "paste 一个都没贴上",
        evidence: { applied: paste.applied, count: paste.count, failed: (paste.failed || []).length },
    });

    const after = await snapshot();

    // ── G4 落地 ──
    const g4 = gateG4(intent, before, after);
    if (!record("G4-landing", g4)) {
        /* ★ 只有"确定是我们贴坏的"才真回滚 ★
           · undecidable（obs 被截断）：不碰世界 —— 数据不全时回滚可能删错东西
           · 有既有 uid 消失（A3 静默销毁）或落地不一致：真回滚
           先跑一次 dry_run 拿回滚计划，再把计划如实报出来，
           然后真删（除非调用方显式 --no-rollback）。 */
        if (g4.undecidable) {
            results.push({
                id: "rollback", ok: false, skipped: true,
                reason: "落地无法判定（obs 被截断），不做回滚 —— 数据不全时回滚可能误删",
            });
            return { ok: false, results };
        }
        const plan = await rollback(before, after, { dryRun: true });
        results.push({ id: "rollback-plan", ok: plan.ok, reason: plan.reason, evidence: plan });
        if (opts.noRollback) {
            results.push({ id: "rollback", ok: false, skipped: true, reason: "调用方给了 --no-rollback，不执行" });
            return { ok: false, results };
        }
        if (!plan.ok) {
            results.push({ id: "rollback", ok: false, reason: "回滚计划不可行，未执行（见 rollback-plan）" });
            return { ok: false, results };
        }
        const rb = await rollback(before, after);
        results.push({ id: "rollback", ok: rb.ok, reason: rb.reason, evidence: rb });
        return { ok: false, results };
    }

    /* ── G7/G8：贴后立刻（t+0）各判一次 ──
       必须在任何 step 之前采：t+0 与 t+60s 两次都判是刻意的 ——
       游戏对拐角的重算（`_updateSurroundingBelt`）发生在**粘贴之后**的任意一次邻格变动，
       所以 t+0 可能还是对的，t+60s 才被翻。两次都判 = 两次之间的差异本身就是翻转检测。 */
    const region = itemsRegionFor(intent);

    let items0 = null, g7a = null, g8a = null;
    try {
        items0 = await rpc("debug_items", { region });
        g7a = gateG7flow(intent, items0);
        g8a = gateG8chains(intent, items0);
    } catch (e) {
        const r = { ok: false, reason: `t+0 的 debug_items 失败：${e.message}` };
        record("G7-flow@t0", r);
        record("G8-chains@t0", r);
    }
    if (g7a) record("G7-flow@t0", g7a);
    if (g8a) record("G8-chains@t0", g8a);

    // ── G6b 连通（先等货流起来）──
    const settle = opts.settleTicks || 7200;   // 60 游戏秒
    try {
        await rpc("act", { op: "step", ticks: settle });
    } catch (e) {
        /* step 失败**不能吞**。吞掉之后 G6b 会读到刚贴完的瞬时状态（path 可能还没建），
           报成"线没连上"；G6 会拿到混着贴前产量的窗口。
           两种都是把基础设施故障伪装成内容结论。 */
        record("step-settle", {
            ok: false, reason: `等待货流的 step 失败：${e.message}`,
            hint: "游戏可能停在对话框（2002）、或桥设了 allow_step=false（1004）、或超时",
        });
        return { ok: false, results };
    }

    const items = await rpc("debug_items", { region });
    const g6b = gateG6b(intent, items);
    record("G6b-connectivity", g6b);

    /* ── G7/G8：t+60s 再判一次，并记录两次的 pathCount 差异 ──
       差异本身就是翻转检测：粘贴后游戏把拐角重算成直带会把两条 path 合成一条
       （或拆成两条），而 pathCount 是最早能看见这件事的廉价信号。 */
    try {
        const g7b = gateG7flow(intent, items);
        const g8b = gateG8chains(intent, items);
        if (items0 && typeof items0.pathCount === "number" && typeof items.pathCount === "number") {
            g7b.evidence = { ...g7b.evidence, path_count_t0: items0.pathCount, path_count_t60: items.pathCount };
        }
        record("G7-flow@t60", g7b);
        record("G8-chains@t60", g8b);
    } catch (e) {
        const r = { ok: false, reason: `t+60s 的流向判定抛错：${e.message}` };
        record("G7-flow@t60", r);
        record("G8-chains@t60", r);
    }

    /* G6 行为：用游戏自己的时间片算速率。
       时间片每 10 游戏秒一片，所以要推进够久才有 >= 2 片可算。
       最后一个片在累积中，G6 内部会排除它。 */
    try {
        await rpc("act", { op: "step", ticks: opts.sampleTicks || 4800 });   // 40 游戏秒 = 4 片
    } catch (e) {
        record("step-sample", {
            ok: false, reason: `采样窗口的 step 失败：${e.message}`,
            hint: "同 step-settle：请看是不是对话框/权限/超时",
        });
        return { ok: false, results };
    }
    const prod2 = await rpc("production", { slices: 6 });
    const upgrades = (before.goal && before.goal.upgrade_levels) || {};
    const g6 = gateG6(intent, baselineProd, prod2, expectedRateOf(intent, upgrades));
    record("G6-behavior", g6);

    const ok = results.filter(r => !r.diagnosticOnly && !r.skipped).every(r => r.ok);
    return { ok, results };
}

/* ══════════════════════════ CLI ══════════════════════════ */

function render(results) {
    const lines = [];
    lines.push("═".repeat(72));
    lines.push("M3 Gate Runner");
    lines.push("═".repeat(72));
    for (const r of results) {
        const mark = r.diagnosticOnly ? "·" : (r.skipped ? "–" : (r.ok ? "✓" : "✗"));
        lines.push(`${mark} ${r.id}`);
        if (r.reason) lines.push(`    ${r.reason}`);
        if (r.hint) lines.push(`    → ${r.hint}`);
        if (r.evidence && Object.keys(r.evidence).length) {
            const ev = JSON.stringify(r.evidence);
            lines.push(`    ${ev.length > 200 ? ev.slice(0, 200) + "…" : ev}`);
        }
    }
    return lines.join("\n");
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("agent/gates.mjs");
if (isMain) {
    const argv = process.argv.slice(2);
    const argVal = name => {
        const i = argv.indexOf(name);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const planFile = argVal("--plan");
    if (!planFile) {
        console.error("用法：node src/agent/gates.mjs --plan <intent.json> [--apply] [--json]");
        process.exit(1);
    }
    let intent;
    try {
        intent = loadIntent(planFile);
    } catch (e) {
        console.error("✗ 读 intent 失败：" + e.message);
        process.exit(1);
    }
    const opts = {
        apply: argv.includes("--apply"),
        charge: argv.includes("--charge") ? true : false,
        /* 默认 G4 失败时真回滚（把这次贴的删掉）。
           想保留现状做人工检查时给 --no-rollback。 */
        noRollback: argv.includes("--no-rollback"),
    };
    runGates(intent, opts).then(res => {
        if (argv.includes("--json")) console.log(JSON.stringify(res, null, 2));
        else console.log(render(res.results));
        process.exit(res.ok ? 0 : (res.fatal ? 1 : 2));
    }).catch(e => {
        console.error("✗ " + (e && e.message ? e.message : e));
        process.exit(1);
    });
}
