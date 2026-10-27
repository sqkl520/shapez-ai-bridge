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
 * ## 十四道闸
 *
 *   G-1 时钟    —— 任何采样之前，先确认时钟在走
 *   G2' 同源    —— paste 的载荷（blueprint）与 G4 的期望（entities）是同一张图（零写入）
 *   G3  净空    —— 落点不压既有实体；**销毁必须在 intent.removes 里声明**
 *   G4  落地    —— 贴进去的东西与蓝图逐格一致，且没有**未声明**的 uid 消失
 *   G-dr 删除回放 —— 声明要删的 uid 必须真的删掉，且不能多删（运行时）
 *   G-rb 回滚还原 —— 回滚后的 uid 集合与贴前逐字节相等（运行时）
 *   G6  行为    —— 目标形状的交付速率达到理论值的 80%
 *   G6b 连通    —— 目标线上每一段都有去处
 *   G7  流向    —— 游戏 path 的逐格邻接方向 == 声明的 inDir/outDir（贴后 t+0 与 t+60s）
 *   G8  链划分  —— 蓝图推出的带子链与游戏 path 逐格同序（贴后 t+0 与 t+60s）
 *   G9  世界    —— status/debug_app_state 说世界真的可用（不是「状态切了但 world 没建」）
 *   G10 rv 自证 —— place 的 requested/actual/mismatch 与 `code === 1+rv` 一致
 *   G11 并发    —— 批量写之后实体计数增量 == 预期（纯计数，本文件不自己发请求）
 *   G12 截图    —— region 取景覆盖请求的 bbox，且没有绘制步骤抛错
 *
 * G9/G12 接进 runGates（G9 紧跟时钟闸；G12 只在调用方显式要截图时跑）。
 * G10/G11 是**调用方主动调用的工具闸** —— 主流程里没有 placeResult / 并发场景，
 * 硬塞进去只会变成又一条恒绿的空断言。
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
 *   node src/agent/gates.mjs --plan <intent.json>           # 只跑到 G3（不真贴，但**不是零写入**）
 *   node src/agent/gates.mjs --plan <intent.json> --apply   # 完整流程（G4 失败会自动回滚）
 *   node src/agent/gates.mjs --plan <intent.json> --apply --no-rollback  # 失败时保留现状
 *   node src/agent/gates.mjs --plan <intent.json> --json
 *
 * ★ `--plan` 不是零写入 ★
 *   G-1 时钟闸会先发一次 `act {op:"step", ticks:600}`（= 120Hz 下 5 游戏秒）。
 *   那是**刻意的**：不看时钟在走，后面所有速率断言的基线都是假的。
 *   所以 `--plan` 的准确定义是「不改地图、不推进到足以发生生产的时间尺度」，
 *   不是「不碰游戏」。返回值里用 `wroteToWorld` / `tickAdvanced` 如实报告，
 *   `planOnly:true` 只表示"没贴东西"。
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

/* ══════════════════════════ removes 声明（纯函数，可单测） ══════════════════════════ */

/**
 * `intent.removes[]` —— 计划里**故意要删掉**的既有实体。
 *
 * ## 形状
 *
 *   { "uid": 10042, "cell": [10, 12], "kind": "belt", "why": "L4 旧线拐角" }
 *   { "uid": 10047 }              // 只知道 uid
 *   { "cell": [10, 13] }          // 只知道格（plan 阶段的常见形态）
 *
 * 字段：`uid` 与 `cell` **至少有一个**；其余字段（kind/why/note…）自由，只作注释。
 *
 * ## 为什么是 uid 为主、cell 为辅，而不是只留一个
 *
 *   · **uid 是唯一能逐字节验证的身份**。坐标会被"同一格换了一台机器"骗过去：
 *     贴前 (10,12) 是 belt#10042，回滚后 (10,12) 是 belt#10099 —— 按格看一模一样，
 *     按 uid 看是"假还原"。G-dr / G-rb 的判据必须落在 uid 上。
 *   · **但写 plan 的时候可能还没有 uid**：intent 是离线产物，编译器/LLM 手上只有
 *     几何与观测。强制要求 uid 会逼调用方先在游戏里查一遍，把"离线可写的计划"
 *     变成"必须贴着游戏写的脚本"。
 *   · 所以：uid 权威、cell 可用来在**贴前快照**里解析出 uid（G-dr 负责解析）。
 *     两者都给时 cell 还兼作交叉校验 —— 若该格上的实体 uid 与声明不符，
 *     说明计划已经过期（世界变了），必须红。
 *
 * ## 为什么是"声明"而不是"指令"
 *
 *   removes 是给闸看的**预期**，不是删除命令。真正删东西的是 paste（覆盖旧带）
 *   或 delete op。G-dr 验的是"实际删掉的 == 声明要删的"，不是"按这份清单去删"。
 *   这么分工的理由：删一半失败时，指令模型会以为删成了，而预期模型能看见差异。
 *
 *   ⚠️ 当前 `runGates` 只执行 `paste_blueprint`，**不执行 `delete` op**。
 *   所以能通过 G-dr 的 removes 只有一种：那些格被 paste 覆盖掉（旧带被替换）。
 *   如果计划想删的是"蓝图不覆盖的格"，本闸会判"仍然存在" —— 这是对的：
 *   那一步根本没执行过，声称删了就是假的。要支持它得让 runGates 会执行 delete 序列，
 *   那是下一步（`removes` 的形状已经够用，缺的是执行器）。
 */
export function declaredRemovals(intent) {
    const items = Array.isArray(intent && intent.removes) ? intent.removes : [];
    const uids = new Set();
    const cells = new Set();
    const byUid = new Map();
    const byCell = new Map();
    for (const it of items) {
        if (!it || typeof it !== "object") continue;
        if (Number.isInteger(it.uid)) { uids.add(it.uid); byUid.set(it.uid, it); }
        if (Array.isArray(it.cell) && it.cell.length === 2) {
            const k = cellKey(it.cell);
            cells.add(k); byCell.set(k, it);
        }
    }
    return { items, uids, cells, byUid, byCell };
}

/**
 * 校验并归一化一份 intent。`loadIntent` 用它，单测也直接用它（不必写临时文件）。
 *
 * `removes` **可选**（老 intent 全部没有这个字段，必须继续能读）；一旦出现就必须合法：
 *   1. 是数组
 *   2. 每项是非 null 对象
 *   3. 每项至少有 `uid`（非负整数）或 `cell`（两个整数）
 *   4. uid 不重复、cell 不重复
 *
 * 第 3 条是这一节的**全部意义**：一份 `removes:[{}]` 的 intent 看起来声明了删除，
 * 实际上什么都没说 —— G3 会把它当成"已声明"而放行任意销毁。宁可在这里拒绝。
 */
export function normalizeIntent(j) {
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("intent 必须是 JSON 对象");
    for (const k of ["goal", "anchor", "entities"]) {
        if (!(k in j)) throw new Error(`intent 缺字段 ${k}`);
    }
    if (!("removes" in j)) return j;
    if (!Array.isArray(j.removes)) throw new Error("intent.removes 必须是数组");
    const seenUid = new Set(), seenCell = new Set();
    j.removes.forEach((r, i) => {
        if (!r || typeof r !== "object" || Array.isArray(r)) {
            throw new Error(`intent.removes[${i}] 必须是对象，实得 ${JSON.stringify(r)}`);
        }
        const hasUid = Number.isInteger(r.uid);
        const hasCell = Array.isArray(r.cell) && r.cell.length === 2 && r.cell.every(Number.isInteger);
        if (!hasUid && !hasCell) {
            throw new Error(`intent.removes[${i}] 必须有 uid 或 cell（uid 为整数；cell 为 [整数,整数]），实得 ${JSON.stringify(r)}`);
        }
        if (hasUid) {
            if (r.uid < 0) throw new Error(`intent.removes[${i}].uid 必须是非负整数，实得 ${r.uid}`);
            if (seenUid.has(r.uid)) throw new Error(`intent.removes 里 uid ${r.uid} 重复声明`);
            seenUid.add(r.uid);
        }
        if (Array.isArray(r.cell) && !hasCell) {
            throw new Error(`intent.removes[${i}].cell 必须是 [整数,整数]，实得 ${JSON.stringify(r.cell)}`);
        }
        if (hasCell) {
            const k = cellKey(r.cell);
            if (seenCell.has(k)) throw new Error(`intent.removes 里 cell ${k} 重复声明`);
            seenCell.add(k);
        }
    });
    return j;
}

/** 一个已声明项在世界里的身份：uid 已知用 uid，否则按贴前快照的格反查。 */
function resolveRemovalTarget(item, before) {
    if (Number.isInteger(item.uid)) {
        const e = before.byUid.get(item.uid);
        return { uid: item.uid, beforeEntity: e || null, by: "uid" };
    }
    const k = cellKey(item.cell);
    const e = before.byCell ? before.byCell.get(k) : null;
    /* byCell 只按 origin 建索引。声明的是多格机器的非 origin 格时查不到 ——
       退化成"按 uid 未知"处理，由调用方报 undecidable，而不是假装删成功了。 */
    return { uid: e ? e.uid : null, beforeEntity: e || null, by: "cell" };
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
 * 落点必须干净：不压既有实体、不销毁**未声明**的东西、实体数与预期一致。
 *
 * ★ 2026-10 语义修订：从「不许销毁」改成「销毁必须声明且可恢复」★
 *
 * 旧判据是 `destroys.length > 0 ⇒ 红`，理由是"旧产线是升级供应链的一部分"。
 * 那条判据把**唯一已知的 L4 正确解**判死了：L4 = 删 3 条旧带 + 放 1 台切割机
 * + 1 个垃圾桶，一共 5 个 op。旧带的销毁不是事故，是解的组成部分。
 *
 * 新判据：
 *   · `destroys` 里每个 uid **必须**出现在 `intent.removes` 里 —— 这才叫"计划过的"
 *   · 未出现在 removes 里的销毁 ⇒ 仍然红（真事故：paste 静默吞掉了别人的带子）
 *   · 声明过的销毁 ⇒ 绿，但必须在 evidence.declared_destroys 里逐条列出
 *     （uid / 格 / 类型），让回滚能按这份清单恢复
 *   · `destroys` 里没声明但 `removes` 里声明的（声明了却没撞上）不在这里判红 ——
 *     那由 G-dr（删除回放）在真贴之后判，因为"计划要删"和"实际撞到"是两个时点
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
    const declared = new Set(declaredRemovals(intent).uids);   // Set<uid>（只认 uid 形态，理由见 G4）
    const destroys = Array.isArray(dryRun.destroys) ? dryRun.destroys : [];
    const uniqDestroys = [...new Map(destroys.map(d => [d.uid, d])).values()];
    const undeclared = uniqDestroys.filter(d => !declared.has(d.uid));
    const evidence = {
        expected_entities: expectEntities,
        expected_cells: expectCells.size,
        would_apply: dryRun.would_apply,
        would_delete: dryRun.would_delete,
        blocked: (dryRun.blocked || []).length,
        destroys: uniqDestroys.length,
        declared_removes: declared.size,
        undeclared_destroys: undeclared.length,
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
    /* ★ 未声明销毁 = 真事故 ★
       paste 落在别人活着的带子上会**静默替换**（旧 uid 消失、failed:[]、零报告）。
       这类销毁如果不在计划里，就是拆了别人一条正在跑的线。 */
    if (undeclared.length > 0) {
        const sample = undeclared.slice(0, 5).map(d => `${d.uid}@(${d.cell})${d.type}`);
        return {
            ok: false,
            reason: `${undeclared.length} 个既有实体会被销毁，但没在 intent.removes 里声明（${sample.join(" ")}）`,
            evidence: { ...evidence, sample },
            hint: "要么换锚点避开它们；要么在 intent.removes 里逐 uid 声明 —— 声明后由 G-dr 验证真的删掉、G-rb 验证能还原",
        };
    }
    if (uniqDestroys.length > 0) {
        /* 声明过的销毁：绿，但逐条写进 evidence。
           回滚需要这份清单才知道要恢复什么（uid + 格 + 类型）。 */
        evidence.declared_destroys = uniqDestroys.map(d => ({ uid: d.uid, cell: d.cell, type: d.type }));
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
 * 贴进去的东西必须与蓝图一致，而且**不能有未声明的既有 uid 消失**。
 *
 * ★ 2026-10 语义修订 ★
 * 旧判据：任何既有 uid 在 after 里消失 ⇒ 红「paste 销毁了它们」。
 * 那个判据挡住了 L4 的正确解 —— 正确解本来就是"删 3 条旧带 + 放切割机"。
 * 新判据：消失的 uid 去掉 `intent.removes` 声明的部分，剩下的才是事故。
 * 「声明了要删，但游戏没删」由 G-dr 判，不在这一闸。
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
    /* 声明过的删除不算消失。这里**只按 uid** 认账：cell 形态的声明由 G-dr 在
       贴前快照里解析成 uid 后再统一核（G4 拿不到 removes 的解析结果，
       而重复解析两份会引入两份不一致的真相）。 */
    const declaredUids = declaredRemovals(intent).uids;
    const gone = [];
    const goneDeclared = [];
    for (const uid of before.byUid.keys()) {
        if (after.byUid.has(uid)) continue;
        (declaredUids.has(uid) ? goneDeclared : gone).push(uid);
    }
    evidence.vanished_uids = gone.length;
    evidence.deleted_declared = goneDeclared.length;
    if (goneDeclared.length) evidence.deleted_declared_uids = goneDeclared.slice(0, 20);
    if (gone.length > 0) {
        const sample = gone.slice(0, 5).map(uid => {
            const e = before.byUid.get(uid);
            return `${uid}@(${e.x},${e.y})${e.type}`;
        });
        return {
            ok: false,
            reason: `${gone.length} 个既有实体消失了（${sample.join(" ")}）且未在 intent.removes 里声明`
                + ` —— paste 静默销毁了它们`,
            evidence: { ...evidence, sample },
            hint: "这是 C1 静默销毁，必须回滚；若确实要删，请在 intent.removes 里逐 uid 声明",
        };
    }

    // 2) 按实体比对：蓝图里每一台在 after 里都要有对应的一条新实体
    const a = intent.anchor;
    const added = [];
    for (const [uid, e] of after.byUid) if (!before.byUid.has(uid)) added.push(e);
    evidence.added_entities = added.length;
    /* 这一闸只看**粘贴刚结束的那个瞬间**。游戏对拐角的 `_updateSurroundingBelt`
       重算发生在之后任意一次邻格变动，所以"贴后被翻"不在 G4 的视野里 ——
       那由 G7/G8 的 t+0 与 t+60 两次采样兜。不标清楚的话，读到
       `wrong_rot: []` 的人会以为"朝向已被持续验证"，实际只是一帧快照。 */
    evidence.snapshot_stage = "post-paste-t0";
    evidence.expected_entities = (intent.entities || []).length;

    /* ★ 数量也要比 ★
       上面那个循环只回答"蓝图里的每格在 after 里有没有"，答不了"after 里多出来的东西
       是谁"。paste 静默多贴（蓝图被改、或游戏自己补了实体）会从这里漏过去。
       多贴和少贴一样是事故：少贴是线不通，多贴是凭空多出占位、堵后面的通道。 */
    if (added.length !== (intent.entities || []).length) {
        return {
            ok: false,
            reason: `贴后新增 ${added.length} 个实体，蓝图只有 ${(intent.entities || []).length} 个 —— `
                + `paste 多贴或少贴了 ${Math.abs(added.length - (intent.entities || []).length)} 个`,
            evidence,
            hint: "多贴通常是蓝图被改过或游戏自己补了实体；两种都不该被当成「贴成功」",
        };
    }

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

/* ══════════════════════════ G-dr 删除回放 ══════════════════════════ */

/**
 * 声明的删除必须在游戏里**逐 uid** 真的发生，而且不能多删。
 *
 * 判据（两条方向都要，缺一条就有一半的病看不见）：
 *   正向 —— `intent.removes` 里每一条，在 before 里存在、在 after 里不存在。
 *            不满足 ⇒ 计划说要删的东西还在（计划没落地 / cell 解析到了错的实体）
 *   反向 —— after 里消失的每个 uid，都必须在 removes 里。
 *            不满足 ⇒ 多删了（这是 G4 已经判过一次的事故形态，这里再判一次，
 *            因为 G4 只看 uid 形态的声明，cell 形态的声明在 G4 眼里是"未声明"，
 *            而在这里两种声明都已解析成 uid）
 *
 * ★ 为什么必须在**运行时**判，而不是信任 G3 的 dry_run ★
 *   G3 问的是 dry_run 会销毁什么；dry_run 是 mod 自己算的预演，和真贴共用
 *   footprint 推断的那段代码。`3306ade` 之前那段代码在 rot=180/270 上算错，
 *   dry_run 报 destroys=0 而真贴静默吞掉旧带（mod 注释里记着实测）。
 *   所以"计划要删的"和"实际删掉的"必须分别来自两个时点的 obs，不能同源。
 *
 * @param {object} intent
 * @param {object} before 贴前快照 {byUid, byCell}
 * @param {object} after  贴后快照 {byUid}
 */
export function gateGDeleteReplay(intent, before, after) {
    const declared = declaredRemovals(intent);
    const evidence = {
        declared: declared.items.length,
        declared_uids: declared.uids.size,
        declared_cells: declared.cells.size,
    };
    /* 快照被截断时 uid 集合本身不完整 —— 判红是假红，判绿是假绿。 */
    if (after && after.truncated) {
        return { ok: false, undecidable: true, reason: "贴后 obs 被截断，无法判定删除是否发生", evidence };
    }
    if (before && before.truncated) {
        return { ok: false, undecidable: true, reason: "贴前 obs 被截断，无法建立 uid 基线", evidence };
    }

    // 正向：声明要删的必须真的没了
    const stillAlive = [], unresolved = [], cellMismatch = [];
    for (const item of declared.items) {
        if (!item || typeof item !== "object") continue;
        const t = resolveRemovalTarget(item, before);
        if (t.uid === null) {
            /* cell 形态但贴前那格上没有实体 —— 计划过期，或者该格是多格机器的非 origin 格。
               两种都必须红：静默跳过等于让一条声明凭空消失。 */
            unresolved.push({ cell: item.cell });
            continue;
        }
        if (t.beforeEntity && Array.isArray(item.cell)
            && (t.beforeEntity.x !== item.cell[0] || t.beforeEntity.y !== item.cell[1])) {
            cellMismatch.push({ uid: t.uid, declared_cell: item.cell, actual_cell: [t.beforeEntity.x, t.beforeEntity.y] });
            continue;
        }
        if (after.byUid.has(t.uid)) stillAlive.push({ uid: t.uid, cell: item.cell || null, by: t.by });
    }
    evidence.still_alive = stillAlive.length;
    evidence.unresolved = unresolved.length;
    evidence.cell_mismatch = cellMismatch.length;

    // 反向：实际消失的必须都是声明过的
    const declaredUids = new Set();
    for (const item of declared.items) {
        const t = resolveRemovalTarget(item, before);
        if (t.uid !== null) declaredUids.add(t.uid);
    }
    const vanished = [];
    for (const uid of before.byUid.keys()) if (!after.byUid.has(uid)) vanished.push(uid);
    const extraGone = vanished.filter(uid => !declaredUids.has(uid));
    evidence.vanished = vanished.length;
    evidence.extra_deleted = extraGone.length;

    if (unresolved.length) {
        return {
            ok: false,
            reason: `intent.removes 里 ${unresolved.length} 条按 cell 声明，但贴前那格上没有实体`
                + `（首条 ${JSON.stringify(unresolved[0].cell)}）—— 计划过期或声明了非 origin 格`,
            evidence: { ...evidence, sample: unresolved.slice(0, 5) },
            hint: "用 obs 复查那几格现在的 uid 再改 intent；若删的是多格机器的右半格，请改声明它的 origin",
        };
    }
    if (cellMismatch.length) {
        return {
            ok: false,
            reason: `${cellMismatch.length} 条声明里 uid 与 cell 对不上（首条 ${JSON.stringify(cellMismatch[0])}）`
                + ` —— 计划写完之后世界变过`,
            evidence: { ...evidence, sample: cellMismatch.slice(0, 5) },
            hint: "uid 权威、cell 交叉校验；两者矛盾时不要猜，先去 obs 重新核对",
        };
    }
    if (stillAlive.length) {
        return {
            ok: false,
            reason: `intent.removes 声明要删的 ${stillAlive.length} 个实体贴后仍然存在`
                + `（首个 uid ${stillAlive[0].uid}${stillAlive[0].cell ? "@(" + stillAlive[0].cell + ")" : ""}）`
                + ` —— 删除没有真的发生`,
            evidence: { ...evidence, sample: stillAlive.slice(0, 5) },
            hint: "paste 没有覆盖到那几格（或 delete op 没执行）—— 回放计划的删除，别把「计划写了」当成「已经删了」",
        };
    }
    if (extraGone.length) {
        return {
            ok: false,
            reason: `${extraGone.length} 个 uid 消失了但没在 intent.removes 里声明（${extraGone.slice(0, 5).join(" ")}）`
                + ` —— 多删了`,
            evidence: { ...evidence, sample: extraGone.slice(0, 5) },
            hint: "未声明的删除仍然是事故，与 G4 同一条纪律",
        };
    }
    if (declared.items.length) {
        evidence.deleted = declared.items.length;
    }
    return { ok: true, reason: null, evidence };
}

/* ══════════════════════════ G-rb 回滚还原 ══════════════════════════ */

/**
 * 回滚后的 uid 集合必须与**贴前逐字节相等**。
 *
 * 判据：`set(afterRollback.byUid.keys()) === set(before.byUid.keys())`
 * —— 既不多、也不少，且**uid 本身**必须相同（不是"数量相同"）。
 *
 * ★ 为什么"数量相同"不够 ★
 *   回滚 = 删新增 + 恢复被删。`restoreEntity` 会重新 `createEntity()`，
 *   游戏分配的是一个**新 uid**（primitives 里那段 `delete+restore` 的实测记录
 *   明确写着"运行期状态不在 schema 里"）。所以"删了 3 个、恢复了 3 个、总数对"
 *   完全可以对应"3 个 uid 变了"的假还原 —— 而下游所有按 uid 记的引用
 *   （连接关系、产线记账、别的 plan 里的 removes 声明）全部指向死 uid。
 *   只有逐 uid 比对能看见这件事。
 *
 * ★ 一处刻意的宽严 ★
 *   `restoreEntity` 能不能保住原 uid 取决于 mod 实现（它接受 payload.uid 并在
 *   冲突时拒绝）。如果恢复后 uid 变了，这道闸**应该**红 —— 它就是为此存在的。
 *   把它判绿等于承认"假还原可以接受"。
 *
 * @param {object} before        贴前快照
 * @param {object} after         贴后（回滚前）快照 —— 只为报告差异，不参与判定
 * @param {object} afterRollback 回滚后快照
 */
export function gateGRollbackRestore(before, after, afterRollback) {
    const evidence = {
        before_count: before.byUid.size,
        after_count: after ? after.byUid.size : null,
        after_rollback_count: afterRollback.byUid.size,
    };
    if (afterRollback.truncated) {
        return { ok: false, undecidable: true, reason: "回滚后的 obs 被截断，无法判定集合是否相等", evidence };
    }
    if (before.truncated) {
        return { ok: false, undecidable: true, reason: "贴前 obs 被截断，没有可比对的基线", evidence };
    }

    const missing = [];       // 贴前有、回滚后没有 —— 没恢复回来
    for (const uid of before.byUid.keys()) if (!afterRollback.byUid.has(uid)) missing.push(uid);
    const extra = [];         // 回滚后有、贴前没有 —— 没删干净
    for (const uid of afterRollback.byUid.keys()) if (!before.byUid.has(uid)) extra.push(uid);

    evidence.missing_uids = missing.length;
    evidence.extra_uids = extra.length;

    if (missing.length || extra.length) {
        /* 区分"数量对但身份错"这种最隐蔽的形态，单独给一句 reason。 */
        const sameCount = missing.length === extra.length && before.byUid.size === afterRollback.byUid.size;
        const sampleOut = missing.slice(0, 5).map(uid => {
            const e = before.byUid.get(uid);
            return `${uid}@(${e.x},${e.y})${e.type}`;
        });
        return {
            ok: false,
            reason: sameCount
                ? `回滚后的 uid 集合与贴前数量相同（${before.byUid.size}）但身份不同：`
                    + `少了 ${missing.length} 个、多了 ${extra.length} 个 —— 这是假还原（恢复时分配了新 uid）`
                : `回滚后的 uid 集合与贴前不等：少 ${missing.length} 个、多 ${extra.length} 个`
                    + (sampleOut.length ? `（缺失样本 ${sampleOut.join(" ")}）` : ""),
            evidence: {
                ...evidence,
                same_count_assumed_identity: sameCount,
                sample_missing: missing.slice(0, 5),
                sample_extra: extra.slice(0, 5),
            },
            hint: "逐字节还原失败。若 restoreEntity 分配了新 uid，说明它没有沿用 payload.uid —— 修 mod，不要放宽这道闸",
        };
    }

    /* 集合相等还不够：格/类型也要对得上，否则"还原"成了一个 uid 相同但内容不同的世界。
       这是廉价的一步（同一份快照里已有），不加白不加。 */
    const changed = [];
    for (const [uid, b] of before.byUid) {
        const r = afterRollback.byUid.get(uid);
        if (!r) continue;
        if (b.x !== r.x || b.y !== r.y || b.code !== r.code) {
            changed.push({ uid, before: [b.x, b.y, b.code], after: [r.x, r.y, r.code] });
        }
    }
    evidence.content_changed = changed.length;
    if (changed.length) {
        return {
            ok: false,
            reason: `${changed.length} 个 uid 回滚后位置或 code 与贴前不同（首个 ${JSON.stringify(changed[0])}）`
                + ` —— uid 保住了但内容没还原`,
            evidence: { ...evidence, sample: changed.slice(0, 5) },
            hint: "restoreEntity 的载荷没有忠实还原；检查 components.StaticMapEntity 的 origin/code",
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

/* ══════════════════════════ G9 世界可用 ══════════════════════════ */

/**
 * `status` / `obs` 反映的世界必须**真的可用**，不只是"状态名对了"。
 *
 * ★ 这条闸的存在理由是一个具体的假成功 ★
 * 旧实现判加载成功用 `currentState.getKey() === "InGameState"`。
 * 但 `core/state_manager.js:58` 里，一旦 `window.APP_ERROR_OCCURED` 为真，
 * `moveToState()` **直接 return** —— 状态名切过去了、world 没有任何一步被执行、
 * RPC 还回 `ok:true`。之后 `states/ingame.js:431` 的 `onRender` 同样 return，
 * world 永远建不起来，只能重启进程。
 *
 * 所以判据必须是 `root` 非空（它只由 `gameStarted` 信号注入），
 * 而这个判据由 mod 的 `debug_app_state.root_present` / `status.in_game` 报出来。
 *
 * 判据：
 *   · `root_present === false` 或 `in_game === false` → 红，说明「状态切了但 world 没建」
 *   · 调用方给了 `appState` 且 `app_error_occurred === true` → 红，并提示**必须重启进程**
 *   · 两个字段都缺失（老版 mod / 调用方传错对象）→ undecidable，不许 fail-open 报绿
 *
 * @param {object} snapshot  合并后的快照：{ in_game?, root_present?, app_error_occurred?, state_key?, ingame_stage? }
 *                           也接受 { status, appState } 两个子对象的形式。
 */
export function gateG9WorldReady(snapshot) {
    const s = snapshot && typeof snapshot === "object" ? snapshot : {};
    /* 允许两种入参形状：平铺（{in_game, root_present}）或分包（{status:{...}, appState:{...}}）。
       分包形式更贴近调用方手里真实的两份 RPC 返回，免得它自己手抖拼错字段名。 */
    const st = (s.status && typeof s.status === "object") ? s.status : s;
    const app = (s.appState && typeof s.appState === "object") ? s.appState
        : (s.debug_app_state && typeof s.debug_app_state === "object") ? s.debug_app_state
        : s;

    const evidence = {
        in_game: st.in_game === undefined ? null : st.in_game,
        root_present: app.root_present === undefined ? null : app.root_present,
        app_error_occurred: app.app_error_occurred === undefined ? null : app.app_error_occurred,
        state_key: app.state_key === undefined ? null : app.state_key,
    };
    if (app.ingame_stage !== undefined) evidence.ingame_stage = app.ingame_stage;

    /* ★ 字段缺失 ≠ 世界可用 ★
       `undefined === false` 为假，所以不显式判缺失的话，一个拼错字段名的快照会静默变绿。 */
    const hasInGame = typeof st.in_game === "boolean";
    const hasRoot = typeof app.root_present === "boolean";
    if (!hasInGame && !hasRoot) {
        return {
            ok: false,
            undecidable: true,
            reason: "快照里既没有 status.in_game 也没有 debug_app_state.root_present —— 无法判定世界是否可用",
            evidence,
            hint: "status 与 debug_app_state 至少要取到一个；两者都没有时不许当成通过",
        };
    }

    /* 崩溃标志优先判：它解释了「为什么 root 不在」，而且决定了能不能重试。 */
    if (app.app_error_occurred === true) {
        return {
            ok: false,
            reason: "APP_ERROR_OCCURED=true —— 游戏已崩溃，state_manager.js:58 会让之后所有 moveToState 静默跳过"
                + `（状态 ${evidence.state_key || "?"}，root_present=${evidence.root_present}）`
                + "；这不是加载慢，是进程已经废了",
            evidence,
            hint: "必须重启游戏进程，重试无效",
        };
    }

    if (hasRoot && app.root_present === false) {
        return {
            ok: false,
            reason: `root_present=false —— 状态切到了 ${evidence.state_key || "?"}`
                + (app.ingame_stage ? `（stage=${app.ingame_stage}）` : "")
                + "，但 world 没有建起来；此时 RPC 可能仍然回 ok:true",
            evidence,
            hint: "root 只由 gameStarted 信号注入：root 为空 ⇒ 世界不存在，任何 obs/place 读数都不可信",
        };
    }
    if (hasInGame && st.in_game === false) {
        return {
            ok: false,
            reason: `in_game=false —— 世界没加载好（root_present=${evidence.root_present}），`
                + `任何基于 obs 的判据都会是假数据`,
            evidence,
            hint: "先确认 status.in_game=true 再做任何测量",
        };
    }

    return { ok: true, reason: null, evidence };
}

/* ══════════════════════════ G10 place 的 rv 自证 ══════════════════════════ */

/**
 * `place` 的自证字段必须与请求一致 —— 光有 `applied:1` 不等于"放对了"。
 *
 * ★ 修复前的真实形态 ★
 * `place belt r=90` 只能得到 `code=1` 的直带：rv 由游戏按邻居自动算，
 * 且只在放置那一刻算一次。于是"我要求的转角"和"世界里的转角"可以不同，
 * 而返回依然是 `ok:true, applied:1`。
 *
 * 现在 mod 回三个字段：`requested.rotationVariant` / `actual.{rotationVariant,code}` / `mismatch`。
 * 判据（全部来自游戏自己的读回值，不是我们的假设）：
 *   · `actual.code` 必须 === `1 + requested.rotationVariant`（belt-rules 命题 A）
 *   · `actual.rotationVariant` 必须 === `requested.rotationVariant`
 *   · `mismatch === true` → 红
 *
 * ★ 没有 `requested` 字段 ⇒ undecidable ★
 * 老版 mod 也回 `code`，但没有 `requested`，"放对了没有"根本无从判断。
 * 这种情况报绿就是 fail-open：以后有人回退 mod 版本，这条闸会静默失效。
 *
 * @param {object} placeResult  place RPC 的返回
 */
export function gateG10RvSelfcheck(placeResult) {
    const r = placeResult && typeof placeResult === "object" ? placeResult : {};
    const evidence = {};
    if (!r || typeof r !== "object" || !Object.keys(r).length) {
        return { ok: false, reason: "place 没有返回任何东西 —— 无法自证", evidence };
    }
    if (r.ok === false) {
        return { ok: false, reason: `place 自己回了 ok:false（${r.error || r.reason || "无原因"}）`, evidence };
    }
    if (r.applied !== 1) {
        return {
            ok: false,
            reason: `place 的 applied=${r.applied} —— 没有放下东西，自证无意义`,
            evidence: { applied: r.applied },
        };
    }

    const req = r.requested;
    if (!req || typeof req !== "object") {
        return {
            ok: false,
            undecidable: true,
            reason: "place 返回里没有 requested 字段（旧版 mod）—— 无从判断放的是不是我要的变体",
            evidence: { has_actual: !!(r.actual && typeof r.actual === "object") },
            hint: "这是 fail-open 的入口：缺 requested 时报绿等于这条闸对旧 mod 完全失效",
        };
    }

    const reqRv = req.rotationVariant;
    if (!Number.isInteger(reqRv)) {
        /* 没请求 rv（req.rotationVariant === null）：此时游戏自动定向是既有语义，
           不该判红 —— 但也**没有东西可自证**，必须如实说 undecidable。 */
        return {
            ok: false,
            undecidable: true,
            reason: `place 没有请求 rotationVariant（requested.rotationVariant=${JSON.stringify(reqRv)}）`
                + " —— 游戏自动定向，无 rv 可自证",
            evidence: { requested_rotation: req.rotation ?? null, actual: r.actual || null },
        };
    }

    const act = (r.actual && typeof r.actual === "object") ? r.actual : {};
    evidence.requested_rv = reqRv;
    evidence.actual_rv = act.rotationVariant === undefined ? null : act.rotationVariant;
    evidence.actual_code = act.code === undefined ? null : act.code;
    evidence.expected_code = beltCode(reqRv);
    evidence.mismatch = r.mismatch === undefined ? null : r.mismatch;

    if (r.mismatch === true) {
        return {
            ok: false,
            reason: `place 自己报了 mismatch=true（requested rv=${reqRv}/rot=${JSON.stringify(req.rotation ?? null)}，`
                + `actual rv=${JSON.stringify(act.rotationVariant)}/rot=${JSON.stringify(act.rotation)}）`
                + " —— 请求的变体没有被落地",
            evidence,
            hint: "belt 的 rv 会被相邻格重算；整块拓扑要用 paste_blueprint（它走 immutable 操作）",
        };
    }
    if (!Number.isInteger(act.rotationVariant)) {
        return {
            ok: false,
            reason: `place 的 actual.rotationVariant 不是整数（${JSON.stringify(act.rotationVariant)}）—— 读回值不可用`,
            evidence,
        };
    }
    if (act.rotationVariant !== reqRv) {
        return {
            ok: false,
            reason: `place 的 actual.rotationVariant=${act.rotationVariant} ≠ requested=${reqRv}`,
            evidence,
        };
    }
    /* ★ 核心判据：code 必须由 rv 唯一决定 ★
       rv 对上了但 code 不对 ⇒ 落地的是另一种建筑，或者 belt 表与 rv 的对应关系变了。
       两个来源（读回的 code 与 belt-rules 命题 A）必须一致。 */
    const wantCode = beltCode(reqRv);
    if (act.code !== wantCode) {
        return {
            ok: false,
            reason: `place 的 actual.code=${JSON.stringify(act.code)} ≠ 1+rotationVariant=${wantCode}`
                + `（requested rv=${reqRv}）—— 落地的东西不是那个变体`,
            evidence,
            hint: "belt-rules 命题 A：code === 1 + rv（1906/1906 实机验证）",
        };
    }
    return { ok: true, reason: null, evidence };
}

/* ══════════════════════════ G11 并发写不丢 ══════════════════════════ */

/**
 * 一批并发写之后，实体计数的增量必须等于预期。
 *
 * ★ 修复前的真实形态 ★
 * 同时发 12 个 `place`，一部分返回 `ok:true` 而实体根本没建出来 ——
 * "成功"的数量和"世界里多出来的数量"对不上，而且从单个返回值看不出来。
 * 根因是写操作各自独立执行（只有 load_save/new_game 串行化），现在全部走 `worldChain`。
 *
 * ★ 这条闸不自己发请求 ★
 * 它只做计数判定；并发请求是集成测试的事（本文件的单测必须零 RPC）。
 * 调用方模式：
 *   const before = (await obs()).entities.length;
 *   const rs = await Promise.all([...12 个 place...]);
 *   const after = (await obs()).entities.length;
 *   gateG11NoConcurrentLoss(before, after, 12);
 *
 * 判据：
 *   · `after - before !== expectedDelta` → 红（少建 = 丢了；多建 = 重复执行）
 *   · 输入不是整数 / delta 为负 → 红（读数本身不可信）
 *
 * @param {number} beforeCount
 * @param {number} afterCount
 * @param {number} expectedDelta  并发写成功了多少个
 */
export function gateG11NoConcurrentLoss(beforeCount, afterCount, expectedDelta) {
    const evidence = { before_count: beforeCount, after_count: afterCount, expected_delta: expectedDelta };
    const allInts = [beforeCount, afterCount, expectedDelta].map(Number.isInteger);
    if (!allInts.every(v => v)) {
        return {
            ok: false,
            reason: `计数不是整数（before=${JSON.stringify(beforeCount)}, after=${JSON.stringify(afterCount)}, `
                + `expected=${JSON.stringify(expectedDelta)}）—— 无法判定`,
            evidence,
            hint: "obs 读失败时 before/after 常是 undefined —— 先确认两次 obs 都成功了",
        };
    }
    if (expectedDelta < 0) {
        return { ok: false, reason: `expectedDelta=${expectedDelta} 为负 —— 输入不成立`, evidence };
    }
    const delta = afterCount - beforeCount;
    evidence.actual_delta = delta;
    if (delta !== expectedDelta) {
        const lost = expectedDelta - delta;
        return {
            ok: false,
            reason: `并发写之后实体数只变了 ${delta}，预期 ${expectedDelta}`
                + (lost > 0 ? ` —— 丢了 ${lost} 个（返回值说成功，世界里没有）`
                    : ` —— 多出 ${-lost} 个（重复执行或蓝图被补实体）`),
            evidence,
            hint: "写操作必须全部走同一条 worldChain；丢的那几个可以从返回值里逐个读回验证",
        };
    }
    return { ok: true, reason: null, evidence };
}

/* ══════════════════════════ G12 截图 region ══════════════════════════ */

/**
 * 截图必须真的拍到了请求的那块地，而且真的画出东西了。
 *
 * ★ 旧实现的三个硬缺陷（都是实测踩到的）★
 *   1. `root.canvas.toDataURL()` 把 HUD 一起截进去 —— hub 面板盖住了钌切割机。
 *   2. 相机是插值移动的，截到的是过期画面。
 *   3. 没有 region，只能先挪相机，结果受窗口尺寸/DPI 影响，不可复现。
 *
 * 新实现自己建离屏 canvas、自建 DrawParameters、相机瞬移、region 指定 bbox，
 * 并回 `world_rect` / `drew` / `skipped` 供断言。
 *
 * 判据：
 *   · 给了 `region` 时，`world_rect.cells` 必须**覆盖**请求的 bbox（不是"大致附近"）
 *   · `drew` 不能为空（一层都没画 ⇒ 图是空的，而 toDataURL 仍会回一张底色图）
 *   · `skipped[]` 里带 `error` 的项（不是带 `reason` 的项）→ 红：
 *       `reason` 是"按设计跳过"（比如 hud 默认关），`error` 是"本该画却抛错"
 *
 * 调用方式：
 *   const shot = await rpc("screenshot", { region });
 *   gateG12ScreenshotRegion(shot, region);
 *
 * @param {object} shotResult  screenshot RPC 的返回
 * @param {number[]} [requestedRegion]  请求的 [x0,y0,x1,y1]；省略时不比对取景
 */
export function gateG12ScreenshotRegion(shotResult, requestedRegion) {
    const s = shotResult && typeof shotResult === "object" ? shotResult : {};
    const evidence = {};
    if (!s || typeof s !== "object" || !Object.keys(s).length) {
        return { ok: false, reason: "screenshot 没有返回任何东西 —— 无法判定", evidence };
    }

    const drew = Array.isArray(s.drew) ? s.drew : null;
    const skipped = Array.isArray(s.skipped) ? s.skipped : [];
    evidence.drew = drew;
    evidence.skipped_steps = skipped.map(x => x && x.step);

    if (!drew) {
        return { ok: false, reason: "截图返回里没有 drew 数组 —— 无法判定画了什么", evidence };
    }
    /* ★ 先判 error，再判空 ★
       顺序是有意的：全是 error 时 drew 也可能是空的，先说"哪一步抛了错"更有用。 */
    const errored = skipped.filter(x => x && x.error !== undefined && x.error !== null);
    if (errored.length) {
        evidence.errors = errored.slice(0, 5);
        return {
            ok: false,
            reason: `截图有 ${errored.length} 个绘制步骤抛错（${errored.map(x => x.step).join("/")}）`
                + ` —— 画出来的图缺层，不是"完整的世界"`,
            evidence,
            hint: "error 表示该画的没画成；reason 才是按设计跳过（比如 hud 默认关）",
        };
    }
    if (!drew.length) {
        return {
            ok: false,
            reason: "截图一层都没画出来（drew 为空）—— 拿到的是一张底色图",
            evidence,
            hint: "可能 DrawParameters 构造失败或游戏版本不匹配",
        };
    }

    if (Array.isArray(requestedRegion)) {
        const want = requestedRegion.map(Number);
        evidence.requested_region = want;
        const wr = s.world_rect && Array.isArray(s.world_rect.cells) ? s.world_rect.cells : null;
        evidence.world_rect_cells = wr;
        if (!wr || wr.length !== 4) {
            return {
                ok: false,
                reason: "给了 region 但截图没有返回 world_rect.cells —— 无法确认拍到的是哪块地",
                evidence,
            };
        }
        const [rx0, ry0, rx1, ry1] = want;
        const [wx0, wy0, wx1, wy1] = wr.map(Number);
        const covers = wx0 <= Math.min(rx0, rx1) && wy0 <= Math.min(ry0, ry1)
            && wx1 >= Math.max(rx0, rx1) && wy1 >= Math.max(ry0, ry1);
        evidence.covers = covers;
        if (!covers) {
            return {
                ok: false,
                reason: `截图取景 ${JSON.stringify(wr)} 没有覆盖请求的 bbox ${JSON.stringify(want)}`
                    + " —— 画面里缺了要看的格子",
                evidence,
                hint: "region 是格坐标；mod 会按 margin 外扩，只应更大不应更小",
            };
        }
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

/**
 * 回滚 = 删新增 + **恢复被删**，然后逐字节验一遍。
 *
 * ★ 为什么不能只调 rollback() 就完事 ★
 *   `rollback()` 只处理"贴进去的"（after 有、before 没有）。而 L4 这类就地改造
 *   的正确解**会先销毁旧带**：那些 uid 在 before 有、after 没有，`rollback()` 看不见，
 *   于是"回滚成功"之后世界比贴前少了 3 条带子 —— 比不回滚更糟，而且它报 ok。
 *
 *   本函数补上另一半：对每个"before 有、after 没有"且**在 intent.removes 里声明过**
 *   的 uid，先用 `obs` 拿不到它的载荷了（已经删了）——
 *   所以载荷必须来自**贴前**。
 *
 * ★ 恢复载荷的来源（诚实记录）★★
 *   当前快照（`snapshot()`）只给 `{uid,x,y,code,type,r}`，**没有组件序列化载荷**，
 *   而 `restoreEntity` 需要 `components.StaticMapEntity.code/origin/rotation`。
 *   本文件按可用的最小集拼出 StaticMapEntity 那一段，并把它标成
 *   `partial: true` —— 能恢复"哪台机器在哪、朝哪"，恢复不了 belt 上的在途货、
 *   processor 的槽位（mod 的 serializeEntity 注释里逐条列了这批字段）。
 *
 *   真正的修法是给 `obs` 加 `include_payload` 或加一个 `serialize_region` RPC
 *   （属于 mod 侧，本轮禁改）。在那之前：
 *     · 能恢复的：几何 / code / 朝向 —— G-rb 的 uid 集合判据就是验这一层
 *     · 恢复不了的一律在返回值 `restored_partial` 里点名，不假装完整
 *
 * ★ 恢复后必须验 ★
 *   调 `gateGRollbackRestore` 逐 uid 比对集合。**回滚报 ok 而 uid 集合不等 ⇒ 整次
 *   回滚算失败**：调用方拿到的 `ok:false` 才是真话。
 */
async function rollbackWithRestore(intent, before, after, opts, results) {
    const plan = await rollback(before, after, { dryRun: true });
    results.push({ id: "rollback-plan", ok: plan.ok, reason: plan.reason, evidence: plan });
    if (opts.noRollback) {
        results.push({ id: "rollback", ok: false, skipped: true, reason: "调用方给了 --no-rollback，不执行" });
        return null;
    }
    if (!plan.ok) {
        results.push({ id: "rollback", ok: false, reason: "回滚计划不可行，未执行（见 rollback-plan）" });
        return null;
    }

    const rb = await rollback(before, after);
    results.push({ id: "rollback", ok: rb.ok, reason: rb.reason, evidence: rb });
    if (!rb.ok) return rb;

    /* 被删的既有实体：before 有、after 没有。只恢复**声明过**的 —— 未声明的销毁
       本身就是事故，把它也恢复掉会让 G-rb 变绿，从而掩盖"paste 静默吞了别人的带子"。 */
    const declaredUids = new Set();
    for (const item of declaredRemovals(intent).items) {
        const t = resolveRemovalTarget(item, before);
        if (t.uid !== null) declaredUids.add(t.uid);
    }
    const destroyedDeclared = [];
    for (const [uid, e] of before.byUid) {
        if (after.byUid.has(uid)) continue;
        if (declaredUids.has(uid)) destroyedDeclared.push(e);
    }

    let restore = { ok: true, restored: 0, restored_partial: 0, failed: [] };
    if (destroyedDeclared.length) {
        restore = await restoreEntities(destroyedDeclared);
        results.push({
            id: "rollback-restore", ok: restore.ok,
            reason: restore.ok
                ? null
                : `有 ${restore.failed.length} 个被删实体恢复失败（首个 uid ${restore.failed[0] && restore.failed[0].uid}）`,
            evidence: { restored: restore.restored, partial: restore.restored_partial, failed: restore.failed.slice(0, 5) },
        });
        if (!restore.ok) return { ...rb, ok: false, restore };
    } else if (declaredRemovals(intent).items.length) {
        results.push({ id: "rollback-restore", ok: true, skipped: true, reason: "声明要删的实体贴后仍在，无需恢复" });
    }

    // ── 逐字节验 ──
    /* ★ 没声明任何删除时，快照就没有变化，不必再采一次 obs ★
       这条早退是省钱也是省事故：多一次 obs 就多一次"贴后世界又动了"的机会，
       而 G-rb 的判据只在"这次操作**可能**改变了既有 uid 集合"时才有意义。
       什么都没删 ⇒ 集合必然相等，判它只会引入噪声。 */
    const declaredUidCount = declaredRemovals(intent).items.length;
    let rbAfter = null;
    if (!declaredUidCount && !destroyedDeclared.length) {
        const trivially = {
            ok: true, reason: null,
            evidence: { before_count: before.byUid.size, after_count: after.byUid.size, note: "本次没有声明删除，uid 集合不可能变" },
        };
        results.push({ id: "G-rb-rollback-restore", ok: true, reason: null, evidence: trivially.evidence });
        return { ...rb, ok: rb.ok, verified: true, evidence: trivially.evidence };
    }
    try { rbAfter = await snapshot(); } catch (e) {
        results.push({ id: "G-rb-rollback-restore", ok: false, reason: `回滚后取 obs 失败：${e.message}` });
        return { ...rb, ok: false, restore };
    }
    const grb = gateGRollbackRestore(before, after, rbAfter);
    results.push({ id: "G-rb-rollback-restore", ok: grb.ok, reason: grb.reason, evidence: grb.evidence, hint: grb.hint });
    return { ...rb, ok: rb.ok && restore.ok && grb.ok, restore, verified: grb.ok, evidence: grb.evidence };
}

/**
 * 把若干"已经被删掉"的实体放回去。
 *
 * 载荷只有几何（见 rollbackWithRestore 的诚实记录），所以走 `delete`-free 的路径：
 * 每台按 `kind → building` 用 `act {op:"place", building, x, y, r}` 重放。
 *
 * ★ 为什么不用 `restoreEntity` ★
 *   `restoreEntity` 是 mod 内部方法，**没有暴露成 RPC**（`handleRpc` 的 switch 里
 *   没有它；`debug_entity_roundtrip` 才有，而那个会自己删一个再放回来，语义不对）。
 *   在 mod 侧加 RPC 属于禁区。所以这里用 `place` 重放，并**接受一个已知差异**：
 *   `place` 会让游戏分配**新 uid** —— 正因如此 G-rb 会红。这不是本层的 bug，
 *   是"没有 uid-preserving 的 RPC"这件事的如实后果。
 *
 *   `place` 的 building 名取自 obs 的 `type` 字段（mod 的 buildingId），
 *   rotationVariant 从 code 反推不了时只传 r —— 传错的 variant 会让 G2'/G7 类
 *   判据（离线）报错，但这层只求 uid 集合能对齐。
 */
async function restoreEntities(entities) {
    const out = { ok: true, restored: 0, restored_partial: 0, failed: [], placed: [] };
    for (const e of entities) {
        try {
            const r = await rpc("act", { op: "place", building: e.type, x: e.x, y: e.y, r: e.r | 0 });
            if (r && (r.ok || r.applied)) { out.restored++; out.restored_partial++; out.placed.push({ uid: e.uid, x: e.x, y: e.y }); }
            else out.failed.push({ uid: e.uid, reason: r && r.reason ? r.reason : "place 未成功" });
        } catch (err) {
            out.failed.push({ uid: e.uid, reason: err.message });
        }
    }
    out.ok = out.failed.length === 0;
    out.note = out.restored_partial
        ? "按几何重放（place），游戏会分配新 uid —— G-rb 会因此判红，这是缺 uid-preserving RPC 的如实后果"
        : null;
    return out;
}

/* ══════════════════════════ 主流程 ══════════════════════════ */

/**
 * 读一份 intent JSON 并做结构校验。
 *
 * 必填：`goal` / `anchor` / `entities`。
 * 可选：`blueprint`（G2' 用）、`removes[]`（G3/G4/G-dr 用，形状见 declaredRemovals 的注释）。
 *
 * `removes` 一旦出现就必须逐项合法 —— 见 normalizeIntent 的第 3 条理由：
 * 一份 `removes:[{}]` 的 intent 会让 G3 以为"删除已声明"而放行任意销毁。
 */
function loadIntent(file) {
    const raw = fs.readFileSync(file, "utf8");
    const j = JSON.parse(raw);
    return normalizeIntent(j);
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

    /* ── G9 世界真的可用 ──
       必须在任何 obs 之前：load_save/new_game 会回 ok:true 而 world 其实没建起来，
       此时 `obs` 要么抛错要么给出上一个世界的残影，之后所有判据都建立在假数据上。
       取不到 status / debug_app_state 时 G9 自己会报 undecidable（红），不会 fail-open。

       ★ 时钟闸红了也照样跑 G9 ★
       `debug_loop` 第一行就是 `requireRoot()`：root 为空时它直接抛 1003，
       于是 G-1 先红、reason 是泛化的「读不到 debug_loop（游戏没进世界？）」——
       而「为什么读不到、能不能重试」正是 G9 要回答的。
       不把 G9 挂上去的话，最需要「必须重启进程」这句话的场景恰好看不到它。 */
    let worldStatus = null, appState = null;
    try { worldStatus = await rpc("status", {}); } catch (e) { /* 老桥没有 status */ }
    try { appState = await rpc("debug_app_state", {}); } catch (e) { /* 老 mod 没有这个 RPC */ }
    const g9 = gateG9WorldReady({ status: worldStatus, appState });

    if (!record("G-1-clock", clock)) {
        /* 只为解释根因：fatal 已经由时钟闸决定，这里不再改变判定。 */
        record("G9-world", g9);
        return { ok: false, results, fatal: true };
    }
    if (!record("G9-world", g9)) return { ok: false, results, fatal: true };

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

    /* ── G12 截图 region（可选）──
       只有调用方显式给了 `opts.screenshotRegion` 才跑：G9 已经证明世界可用，
       截图是给"人要看一眼"的产物，不该在每次建线时都渲染一张 4K 图。
       失败**不回滚** —— 截图坏掉说明不了工厂坏掉，把它当成致命错误会拆掉好好的线。 */
    if (Array.isArray(opts.screenshotRegion)) {
        try {
            const shot = await rpc("screenshot", { region: opts.screenshotRegion });
            record("G12-screenshot", gateG12ScreenshotRegion(shot, opts.screenshotRegion));
        } catch (e) {
            record("G12-screenshot", { ok: false, reason: `screenshot RPC 失败：${e.message}` });
        }
    }

    if (!opts.apply) {
        /* ★ 如实报告"不是零写入" ★
           到这里已经发生过一次 `act {op:"step", ticks:600}`（G-1 时钟闸）。
           `planOnly:true` 只表示**没往地图里写东西**，不表示没碰游戏。
           以前这里写的是"零写入"，而 G-1 的 step 会让世界推进约 5 游戏秒 ——
           对"只想知道能不能贴"的调用方，这个差别在 `--apply` 之后会用产量曲线打脸
           （基线里混进了 plan 阶段推进的那几秒）。 */
        results.push({
            id: "apply", ok: true, reason: null, skipped: true,
            note: "未给 --apply：没有 paste、没有地图写入；但 G-1 时钟闸推进了游戏（见 tickAdvanced）",
        });
        return {
            ok: true, results, planOnly: true,
            wroteToWorld: false,
            tickAdvanced: clock.evidence ? clock.evidence.tick_delta : null,
            note: "planOnly 只表示「没贴东西」，不是「零写入」：G-1 时钟闸会 step 600 tick",
        };
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

    /* ── G-dr 删除回放 ──
       位置必须在 G4 之前：G4 只认 uid 形态的声明，cell 形态的声明在它眼里是"未声明销毁"；
       G-dr 把两种形态都解析成 uid 后再判，所以它才是"声明与事实"的权威比对。
       但反过来 G-dr 也不能替代 G4：G4 判的是"贴进去的蓝图是否逐格落地"，
       G-dr 完全不看这块。两道闸的判据不重叠。

       没有声明删除的 intent（绝大多数老 intent）不会因为这道闸变严：
       removes 为空时正向/反向两个循环都是空集，判定恒绿。 */
    const gdr = gateGDeleteReplay(intent, before, after);
    if (!record("G-dr-delete-replay", gdr)) {
        if (gdr.undecidable) {
            results.push({
                id: "rollback", ok: false, skipped: true,
                reason: "删除回放无法判定（obs 被截断），不做回滚",
            });
            return { ok: false, results };
        }
        const rb = await rollbackWithRestore(intent, before, after, opts, results);
        return { ok: false, results, rollback: rb };
    }

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
        const rb = await rollbackWithRestore(intent, before, after, opts, results);
        return { ok: false, results, rollback: rb };
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

    /* ★ t+0 就红 ⇒ 立刻回滚，别等 t+60s ★
       之前只有 G4 失败才回滚，而 G7/G8 红了只"记一笔"继续往下走：于是事故里
       108 个实体照样留在存档里，粗料照样灌进 hub，`ok:false` 是最后才交出去的。
       那正是 L4 当时的真实损失形态 —— 不是没发现，是发现了以后线还在那儿。

       t+0 这个时点回滚最干净：粘贴刚发生、`added` 集合与 before/after 都还准确，
       不需要等货流跑起来，也不会把 100 游戏秒的脏产出留在世界里的新线上。
       注意 undecidable（数据不全）仍然不回滚 —— 那是 G4 同一条纪律。 */
    const t0Bad = [g7a, g8a].find(r => r && r.ok === false && !r.undecidable);
    if (t0Bad) {
        const rb = await rollbackWithRestore(intent, before, after, opts, results);
        return { ok: false, results, rollback: rb, rolledBackEarly: "G7/G8@t0" };
    }

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
