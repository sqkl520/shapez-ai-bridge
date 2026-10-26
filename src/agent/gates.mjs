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
 *   · 游戏运行时的实际连接关系（G6b）
 *
 * ## 五道闸
 *
 *   G-1 时钟    —— 任何采样之前，先确认时钟在走
 *   G3  净空    —— 落点不压既有实体、不销毁任何东西
 *   G4  落地    —— 贴进去的东西与蓝图逐格一致，且没有 uid 消失
 *   G6  行为    —— 目标形状的交付速率达到理论值的 80%
 *   G6b 连通    —— 目标线上每一段都有去处
 *
 * G0/G1/G2/G5/G7 降级为诊断信息，因为它们的判据与编译器同源，
 * 独立信息量接近零（详见 research/ai-plan/M3-REVIEW.md）。
 *
 * ## 用法
 *
 *   node src/agent/gates.mjs --plan <intent.json>           # 只跑到 G3（零写入）
 *   node src/agent/gates.mjs --plan <intent.json> --apply   # 完整五闸
 *   node src/agent/gates.mjs --plan <intent.json> --json
 *
 * 退出码：0 全绿 / 2 有闸红 / 1 致命（无法继续）
 */
import fs from "node:fs";

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

/** 各建筑变体的占地。数字来自 op-templates.mjs 的 footprint。 */
const FOOTPRINT = {
    hub: [4, 4],
    miner: [2, 1],
    cutter: [2, 1],
    cutter_quad: [4, 1],
    rotater: [2, 1],
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
export function entityCells(kind, x, y, rot = 0) {
    const key = FOOTPRINT[kind] ? kind : (kind === "cutter" ? "cutter" : "belt");
    let [w, h] = FOOTPRINT[key] || [1, 1];
    // 旋转 90/270 时宽高互换
    if (rot === 90 || rot === 270) [w, h] = [h, w];
    const out = [];
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) out.push([x + dx, y + dy]);
    return out;
}

/**
 * intent 里的全部实体，展开成世界坐标下逐一占用的格。
 * 世界坐标 = anchor + [dx, dy]。
 */
export function expectedCells(intent) {
    const a = intent.anchor;
    if (!Array.isArray(a) || a.length !== 2) throw new Error("intent.anchor 必须是 [x,y]");
    const cells = new Map();     // "x,y" → { kind, code, rot, nodeId }
    for (const e of intent.entities || []) {
        const wx = a[0] + e.dx, wy = a[1] + e.dy;
        for (const [x, y] of entityCells(e.kind, wx, wy, e.rot | 0)) {
            cells.set(`${x},${y}`, { kind: e.kind, code: e.code, rot: e.rot | 0, nodeId: e.nodeId, origin: [wx, wy] });
        }
    }
    return cells;
}

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

    if (!(advanced > 0)) {
        return {
            ok: false, reason: `推进了 ${probeTicks} tick 但时间只走了 ${advanced} —— 时钟没有真的在走`,
            evidence,
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
 * 贴进去的东西必须与蓝图逐格一致，而且**不能有既有的 uid 消失**。
 *
 * 两条判据：
 *   1. 没有任何 uid 消失 —— 这是"静默销毁"的兜底。
 *      paste 落在既有带子上会把带子换成新的，旧的 uid 就没了，
 *      而游戏返回 `failed: []`，零报告。
 *   2. 每个新增实体在它该在的格上、code 与 rot 都对。
 *
 * 刻意**不看** paste 返回的 `applied` / `failed` —— 它们不可信。
 */
export function gateG4(intent, before, after) {
    const expectCells = expectedCells(intent);
    const evidence = {};

    // 1) 有没有 uid 消失
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

    // 2) 每个预期格上是否有对应的新实体
    const added = [];
    for (const [uid, e] of after.byUid) if (!before.byUid.has(uid)) added.push(e);
    evidence.added_entities = added.length;

    const addedByCell = new Map(added.map(e => [`${e.x},${e.y}`, e]));
    const missing = [], wrongCode = [];
    for (const [k, want] of expectCells) {
        const got = addedByCell.get(k);
        if (!got) { missing.push(k); continue; }
        if (got.code !== want.code) wrongCode.push({ cell: k, want: want.code, got: got.code });
    }
    evidence.missing_cells = missing.length;
    evidence.wrong_code = wrongCode.length;

    if (missing.length) {
        return {
            ok: false,
            reason: `${missing.length} 个预期格上没有新实体（首处 ${missing[0]}）`,
            evidence: { ...evidence, sample: missing.slice(0, 5) },
            hint: "蓝图没贴全 —— 可能是 apply 中途失败",
        };
    }
    if (wrongCode.length) {
        return {
            ok: false,
            reason: `${wrongCode.length} 格的 code 与蓝图不符（首处 ${JSON.stringify(wrongCode[0])}）`,
            evidence: { ...evidence, sample: wrongCode.slice(0, 5) },
        };
    }
    return { ok: true, reason: null, evidence };
}

/* ══════════════════════════ G6 行为 ══════════════════════════ */

/**
 * 目标形状的交付速率必须达到理论值的 80%。
 *
 * 关键：**按形状算增量**，不能用全厂总量。
 * 全厂口径下，一座正在跑的老工厂会把新线的失败完全掩盖 ——
 * 实测 L4 全厂 4.18/s 恒过阈值，而新线一个货都没产出。
 *
 * 理论值 = 该线矿机数 × 单台速率（带升级倍率）。
 * 保守起见只用矿机算：矿机是最慢的一环，也是我们唯一能精确数的。
 */
export function gateG6(intent, prod1, prod2, expectedRatePerSec) {
    const shape = intent.goal;
    const dt = (prod2.window_seconds || 0) - (prod1.window_seconds || 0);
    const dDelivered = ((prod2.delivered_per_sec || {})[shape] || 0) - ((prod1.delivered_per_sec || {})[shape] || 0);

    const evidence = {
        shape, window_delta_sec: dt,
        delivered_rate_before: (prod1.delivered_per_sec || {})[shape] || 0,
        delivered_rate_after: (prod2.delivered_per_sec || {})[shape] || 0,
        expected_rate: expectedRatePerSec,
    };

    if (!(dt > 0)) {
        return { ok: false, reason: `两次采样之间窗口没前进（dt=${dt}）—— 时钟可能停了`, evidence };
    }
    const target = expectedRatePerSec * 0.8;
    evidence.threshold = +target.toFixed(3);
    evidence.actual = +dDelivered.toFixed(3);

    if (dDelivered < target) {
        return {
            ok: false,
            reason: `${shape} 的交付速率 ${dDelivered.toFixed(3)}/s < 阈值 ${target.toFixed(3)}/s`
                + `（理论 ${expectedRatePerSec}/s 的 80%）`,
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
    const beltCells = new Set();
    for (const [k, v] of expect) if (v.kind === "belt" || v.kind === "underground_belt") beltCells.add(k);

    const toKey = c => `${c[0]},${c[1]}`;
    const covered = new Set();
    const deadEnds = [];
    for (const p of items.paths || []) {
        const onOurLine = (p.cells || []).filter(c => beltCells.has(toKey(c)));
        if (!onOurLine.length) continue;
        for (const c of onOurLine) covered.add(toKey(c));
        if (p.boundAcceptor === null) {
            deadEnds.push({
                head: p.cells[0], tail: p.cells[p.cells.length - 1],
                len: p.cells.length, items: p.itemsOnPath,
            });
        }
    }

    const uncovered = [...beltCells].filter(k => !covered.has(k));
    const evidence = {
        our_belt_cells: beltCells.size,
        covered_cells: covered.size,
        uncovered_cells: uncovered.length,
        dead_end_paths: deadEnds.length,
        dead_ends: deadEnds.slice(0, 6),
    };

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
    const outsiders = [];
    for (const [uid, e] of before.byUid) {
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

    const r = await rpc("act", { op: "bulk_delete", region });
    return { ok: true, deleted: r.applied, region };
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

/** 该线理论上每秒能产出多少（只用矿机算，它是最慢的一环） */
function expectedRateOf(intent, upgrades = {}) {
    const MUL = [1, 1.5, 2, 3, 4, 6, 7, 8];
    const minerMul = MUL[Math.min(upgrades.miner | 0, 7)];
    const miners = (intent.entities || []).filter(e => e.kind === "miner").length;
    return miners * 0.4 * minerMul;
}

export async function runGates(intent, opts = {}) {
    const results = [];
    const record = (id, r) => {
        results.push({ id, ok: r.ok, reason: r.reason, evidence: r.evidence, hint: r.hint });
        return r.ok;
    };

    // ── G-1 时钟 ──
    const clock = await gateClock(opts.probeTicks || 600);
    if (!record("G-1-clock", clock)) return { ok: false, results, fatal: true };

    const before = await snapshot();
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
        const rb = await rollback(before, after, { dryRun: true });
        results.push({ id: "rollback-plan", ok: rb.ok, reason: rb.reason, evidence: rb });
        return { ok: false, results };
    }

    // ── G6b 连通（先等货流起来）──
    const settle = opts.settleTicks || 7200;   // 60 游戏秒
    await rpc("act", { op: "step", ticks: settle }).catch(() => null);
    const items = await rpc("debug_items", { region: [-80, -80, 80, 80] });
    const g6b = gateG6b(intent, items);
    record("G6b-connectivity", g6b);

    // ── G6 行为（两个窗口）──
    const prod1 = await rpc("production", { slices: 3 });
    await rpc("act", { op: "step", ticks: opts.sampleTicks || 3600 }).catch(() => null);
    const prod2 = await rpc("production", { slices: 3 });
    const upgrades = (before.goal && before.goal.upgrade_levels) || {};
    const g6 = gateG6(intent, prod1, prod2, expectedRateOf(intent, upgrades));
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
