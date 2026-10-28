/**
 * verify_runtime.mjs — 「宏的计划 → 真实世界」这一段唯一的裁决器。
 *
 * 为什么要有它（红队 WAVE1 §1.4）：
 *   终裁阶段 0 承诺了 `verifyRuntime(planId)`，全库只命中两处注释，**代码零实现**。
 *   在此之前，所有"验证"都是离线自证：宏拿自己算出的期望去比自己的返回值。
 *   这与 gates.mjs 文件头记录的那次 108 实体事故是同一个病：
 *   **生成器的输出不能当验证器的期望。**
 *
 * 所以本文件的判据全部来自**游戏运行时**：
 *   · `obs.entities[]`            —— 游戏分配的 uid、origin、(r, rotation_variant, code)
 *   · `debug_items.paths[]`       —— 游戏自己的带子链（entityPath + boundAcceptor）
 *   · `production`                —— 游戏自己的产量统计
 *   计划（plan）只提供"我声称贴了什么"；plan 的 `ok` 字段**一概不读**。
 *
 * ## 检查项（名字稳定，供 loop/诊断消费）
 *
 *   L1 landing    —— 计划里每一台/每一格在 obs 里真的存在，且 type/code/rotation/rv 一致；
 *                    带子若声明了 inDir/outDir，与世界的 (rv,rot) 推出来的入口/出口一致；
 *                    计划里声明删除的 uid 真的消失了；计划给了 uid 的必须同 uid 同格。
 *   L2 slots      —— 每台机器的输入槽是否真有上游（obs 邻接 + debug_items 的 path 双证），
 *                    输出槽是否有去处；`opts.slots.require` 可点名必须连通的槽。
 *   L3 flow       —— 从源端点出发，沿游戏自己的 paths 逐段走，真的能到达目的地
 *                    （`opts.flows`）；未给 flows 时退化为「计划区域内的断头路」检测。
 *   L4 behavior   —— （可选）推进 N tick 后 `production` 里目标形状真的出现。
 *
 * 每项返回 `{name, ok, skipped?, undecidable?, degraded?, evidence, reason}`；`ok` = 非 skipped 全绿。
 * **截断即不可判定**：obs 截断 / paths 截断时返回 `undecidable:true, ok:false` ——
 * 不能把"没看见"读成"没问题"（gates G4/G6b 同一条纪律）。
 *
 * **降级即自曝**（`degraded:true`）：某项检查在缺少必要输入时会退化成更弱的版本
 * （目前只有 L3：无 flows 时只看计划 bbox 外扩 flowPad 格内的断头路）。这种绿是
 * **有边界的绿**，必须带 `degraded:true` 且 reason 里写明范围 —— 实测事故：一次
 * replace_run 落盘后 L3 绿，但 bbox 外 3 格处就有一条零物品死端带，正是 delivered:0
 * 的真因。调用方（loop）不得把 `degraded` 当作"已验证"。
 *
 * ## 绿不等于通关（给调用方的硬提醒）
 *
 * 本文件只回答「**我声称干的事干成了吗**」，不回答「**关卡推进了吗**」。
 * 局部全绿 + 全局无用是一类真实且常见的失败：计划贴对了、槽位也接了，
 * 但货流不通到 hub，`goal.delivered` 一动不动。**loop 的成功判据必须是
 * `goal.delivered` 的增量或 L4-behavior 绿，不能是 `verifyRuntime().ok`。**
 *
 * ## 用法
 *
 *   import { verifyRuntime } from "./verify_runtime.mjs";
 *   const r = await verifyRuntime(plan, { flows: [{ from: beltUid, to: trashUid }] });
 *   const r2 = await verifyRuntime("my-plan.json");       // 或 plansDir 下的 id
 *
 * CLI（调试用）：
 *   node src/agent/verify_runtime.mjs --plan <file.json> [--flows '<json>'] [--json]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DIRV, OPP, rotateLocal, beltEntry, beltExit } from "../ai/belt-rules.mjs";
import { templateByBuildingVariant } from "../ai/op-templates.mjs";

const BASE = process.env.SHAPEZ_BRIDGE_URL || "http://127.0.0.1:7777";
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 计划默认放在 research/ai-plan/plans/ —— 没有就退到 research/ai-plan/（现有交接件都在那）。 */
const DEFAULT_PLANS_DIR = path.resolve(HERE, "../../research/ai-plan/plans");
let rpcId = 1;

/* ══════════════════════════ 读面（可注入，单测不连游戏） ══════════════════════════ */

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

const BRIDGE_READER = {
    async obs(p) { return rpc("obs", { max_entities: 50000, layer: "all", include_stats: true, ...p }); },
    async debugItems(p) { return rpc("debug_items", p); },
    async production(p) { return rpc("production", p || { slices: 6 }); },
    async step(ticks) { return rpc("act", { op: "step", ticks }); },
};

/* ══════════════════════════ 计划归一化 ══════════════════════════
 *
 * 计划有四种常见形态（都是现有宏/意图的真实产物）：
 *   ① intent：{anchor:[x,y], entities:[{dx,dy,kind,code,rot,rotationVariant}]}  ← build_line / 编译器
 *   ② 宏返回：{placed:[{kind, origin|x,y, rotation, rotationVariant, code}], removed:[]} ← replace_run/connect
 *   ③ 原始 op 列表：[{op:"place",building,x,y,r,rotationVariant}, {op:"delete",uid}] ← 阶段 0 的 L4 五 op
 *   ④ 显式 placement：{placements:[...], removes:[...]}（便于把多个宏结果拼成一份计划）
 *
 * 归一化的唯一职责是**统一坐标与字段名**；不做任何"补齐/推测"。
 * 计划没声明的字段（例如 rotation）就不比 —— 但会记进 evidence.unchecked，
 * 免得读的人以为"没报错 = 已经验过"。
 */

const isInt = n => typeof n === "number" && Number.isInteger(n);
const rot90 = r => (((Math.round((Number(r) || 0) / 90) * 90) % 360) + 360) % 360;

/** 局部格 → 旋转后的偏移。与游戏 `Vector.rotateFastMultipleOf90` 同号（y 向下）。
 *  独立实现（不 import 生成器 place.mjs）—— 验证器不借生成器的算术。 */
function rotOffset(cell, rotation) {
    let [x, y] = cell;
    for (let i = 0; i < rot90(rotation) / 90; i++) { const nx = -y, ny = x; x = nx; y = ny; }
    return [x === 0 ? 0 : x, y === 0 ? 0 : y];
}

function pickCell(o) {
    if (Array.isArray(o.cell) && isInt(o.cell[0])) return [o.cell[0], o.cell[1]];
    if (Array.isArray(o.origin) && isInt(o.origin[0])) return [o.origin[0], o.origin[1]];
    if (isInt(o.x) && isInt(o.y)) return [o.x, o.y];
    if (isInt(o.dx) && isInt(o.dy)) return [o.dx, o.dy];   // 仅当 anchor 已知时调用方已加过
    return null;
}

function placementFrom(o, anchor) {
    const raw = pickCell(o);
    if (!raw) return null;
    const x = anchor ? anchor[0] + raw[0] : raw[0];
    const y = anchor ? anchor[1] + raw[1] : raw[1];
    const kind = o.building || o.kind || o.type || null;
    if (!kind) return null;
    const rot = o.rotation !== undefined ? o.rotation : (o.r !== undefined ? o.r : (o.rot !== undefined ? o.rot : null));
    let rv = o.rotationVariant !== undefined ? o.rotationVariant
        : (o.rotation_variant !== undefined ? o.rotation_variant : (o.rv !== undefined ? o.rv : null));
    const code = o.code !== undefined ? o.code : null;
    // belt 的 code 唯一权威 = 1 + rv（belt-rules 命题 A，1906/1906）。只在这一个方向补：
    // code → rv 仅在 kind==="belt" 且 code 是 1..3 时有定义，其余不猜。
    if (rv === null && code !== null && kind === "belt" && code >= 1 && code <= 3) rv = code - 1;
    return {
        uid: isInt(o.uid) && o.uid >= 0 ? o.uid : null,
        kind, variant: o.variant || "default",
        x, y,
        rot: rot === null || rot === undefined ? null : rot90(rot),
        rv: rv === null || rv === undefined ? null : Number(rv),
        code,
        /* 宏的 cells/entities 会声明 inDir/outDir（connect / build_line 都有）。
           它不是几何推演的产物，而是"我声称这条带子从哪进、往哪出"——
           正好是 L4 事故里被游戏静默翻掉的那两个字段。声明了就比。 */
        inDir: o.inDir || null,
        outDir: o.outDir || null,
    };
}

function placementsFromOps(ops) {
    const out = [];
    for (const op of ops) {
        if (!op || typeof op !== "object") continue;
        if (op.op === "place" || op.op === "place_path") {
            if (op.op === "place_path") {
                // place_path 的 from/to 是端点；逐格展开的方向/朝向由游戏决定 —— 本函数不猜，
                // 只把两端记成"待落地"的格子（rot/rv 留 null，不算它们已验）。
                const { from, to } = op;
                if (Array.isArray(from) && Array.isArray(to)) {
                    const dx = Math.sign(to[0] - from[0]), dy = Math.sign(to[1] - from[1]);
                    const n = Math.abs(to[0] - from[0]) + Math.abs(to[1] - from[1]) + 1;
                    for (let i = 0; i < n; i++) {
                        out.push({ uid: null, kind: op.building, variant: op.variant || "default",
                            x: from[0] + dx * i, y: from[1] + dy * i, rot: null, rv: null, code: null });
                    }
                }
                continue;
            }
            const p = placementFrom({ ...op, kind: op.building }, null);
            if (p) out.push(p);
        }
    }
    return out;
}

/**
 * @param {object|Array} plan
 * @returns {{placements:Array, removes:Array, source:string, flows:Array|null, warnings:string[]}}
 */
export function normalizePlan(plan) {
    const warnings = [];
    if (Array.isArray(plan)) {
        /* ★ 数组有两种：raw ops（元素带 op 字段）与裸实体表（obs.entities 那种）★
           不加区分会把 `live-L4-entities.json` 这类**世界快照**当成"空计划"，
           然后 L1 报"真空绿"——看起来像计划坏了，实际是调用方把世界当计划传了进来。
           裸实体表不是计划（没有 anchor、没有"要做什么"），必须显式拒绝。 */
        const looksLikeOps = plan.length > 0 && plan.every(x => x && typeof x === "object" && typeof x.op === "string");
        if (looksLikeOps) {
            return { placements: placementsFromOps(plan), removes: opsRemoves(plan), source: "ops[]", flows: null, warnings };
        }
        const looksLikeEntities = plan.length > 0 && plan.every(x => x && typeof x === "object" && x.type && isInt(x.uid) && isInt(x.x) && isInt(x.y));
        if (looksLikeEntities) {
            throw new Error("这是一个**世界快照**（obs.entities 数组），不是计划。"
                + "计划必须说明要做什么：给 {anchor,entities}（intent）、{placed}（宏返回）、{placements} 或 raw ops[]。");
        }
        return { placements: placementsFromOps(plan), removes: opsRemoves(plan), source: "ops[]", flows: null, warnings };
    }
    if (!plan || typeof plan !== "object") throw new Error("plan 必须是对象、数组或文件路径");

    if (Array.isArray(plan.ops)) {
        return { placements: placementsFromOps(plan.ops), removes: opsRemoves(plan.ops), source: "plan.ops[]", flows: plan.flows || null, warnings };
    }
    // ① intent
    if (Array.isArray(plan.entities) && Array.isArray(plan.anchor)) {
        const a = plan.anchor;
        const pl = [];
        for (const e of plan.entities) {
            const p = placementFrom(e, a);
            if (p) pl.push(p);
        }
        return {
            placements: pl,
            removes: normalizeRemoves(plan.removes || plan.removes_uids || []),
            source: "intent{anchor,entities}",
            flows: plan.flows || null,
            warnings,
        };
    }
    // ② 宏返回
    if (Array.isArray(plan.placed)) {
        const pl = [];
        for (const e of plan.placed) {
            const p = placementFrom({ ...e, kind: e.kind || e.building }, null);
            if (p) pl.push(p);
        }
        return {
            placements: pl,
            removes: normalizeRemoves(plan.removes || plan.removed || plan.removed_uids || []),
            source: "macro{placed,removed}",
            flows: plan.flows || null,
            warnings,
        };
    }
    // ④ 显式
    if (Array.isArray(plan.placements)) {
        const pl = [];
        for (const e of plan.placements) {
            const p = placementFrom(e, null);
            if (p) pl.push(p);
        }
        return {
            placements: pl,
            removes: normalizeRemoves(plan.removes || []),
            source: "placements[]",
            flows: plan.flows || null,
            warnings,
        };
    }
    // connect 的返回：cells[] 带 x,y,building,rotation,rotationVariant,code
    if (Array.isArray(plan.cells) && plan.cells.some(c => c && (c.building || c.kind))) {
        const pl = [];
        for (const c of plan.cells) {
            const p = placementFrom({ ...c, kind: c.kind || c.building }, null);
            if (p) pl.push(p);
        }
        return { placements: pl, removes: [], source: "connect.cells[]", flows: plan.flows || null, warnings };
    }
    // extend_line 的返回：execution.cells[] 带 {x,y,code,r,rv}
    if (plan.execution && Array.isArray(plan.execution.cells)) {
        const pl = [];
        for (const c of plan.execution.cells) {
            const p = placementFrom({ x: c.x, y: c.y, kind: plan.from && plan.from.kind === "machine" ? "belt" : "belt", rot: c.r, rv: c.rv, code: c.code }, null);
            if (p) pl.push(p);
        }
        return { placements: pl, removes: [], source: "macro.execution.cells[]", flows: plan.flows || null, warnings };
    }
    throw new Error("无法识别的 plan 形态：需要 {anchor,entities} / {placed} / {placements} / ops[] / {ops} 之一");
}

function opsRemoves(ops) {
    const out = [];
    for (const op of ops) if (op && op.op === "delete" && isInt(op.uid)) out.push({ uid: op.uid, expect: null });
    return out;
}

function normalizeRemoves(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const r of list) {
        if (isInt(r)) { out.push({ uid: r, expect: null }); continue; }
        if (r && isInt(r.uid)) out.push({ uid: r.uid, expect: r.expect || null });
    }
    return out;
}

/* ══════════════════════════ 机器槽位（几何真值来自 op-templates） ══════════════════════════ */

/** 一台机器的世界槽位。rot≠0 时按 rotOffset 旋转局部格（与游戏 origin 语义一致）。 */
export function slotsOf(kind, variant, ox, oy, rot) {
    const tpl = templateByBuildingVariant(kind, variant || "default");
    if (!tpl) return null;
    const conv = s => {
        const off = rotOffset(s.cell, rot || 0);
        const slot = [ox + off[0], oy + off[1]];
        const dir = rotateLocal(s.dir, rot90(rot || 0));
        return { role: s.role, slot, dir, cell: [slot[0] + DIRV[dir][0], slot[1] + DIRV[dir][1]] };
    };
    return {
        footprint: tpl.footprint,
        inputs: (tpl.inputs || []).map(conv),
        outputs: (tpl.outputs || []).map(conv),
    };
}

const K = c => `${c[0]},${c[1]}`;

/**
 * path 的接收方坐标。
 *
 * ★ 为什么不能直接用 `p.boundAcceptor` ★
 *   桥只在接收方实体带 StaticMapEntity 时回坐标，否则回字符串 `"yes"`
 *   （mod 的 `boundAcceptor` 三目：拿不到 origin 就写 "yes"）。
 *   实测：带子插进 **cutter** 的 path 回的是 `"yes"` —— 而那正是我们最关心的情况。
 *   所以这里用「path 末格 + 末两格的走向」外推接收格，这是纯几何、不依赖生成器：
 *   末格是最后一格带子，货从它走向的那一格就是接收方本体格。
 *
 * @returns {[number,number]|null} 接收方的**本体格**，或 null（整条 path 断头/太短）
 */
export function acceptorOf(p) {
    if (Array.isArray(p.boundAcceptor)) return [p.boundAcceptor[0], p.boundAcceptor[1]];
    /* 显式 null/undefined = 游戏说"这条 path 没有接收者" ⇒ 死端，**不许外推**。
       只有 `"yes"`（有接收者但拿不到坐标）才走几何外推。
       把 null 也外推会把死端算成"接到了下一格"，这是最危险的一类假绿。 */
    if (p.boundAcceptor === null || p.boundAcceptor === undefined) return null;
    const cells = p.cells || [];
    if (cells.length < 2) return null;      // "yes" 但只有一格：没有走向，无法外推
    const last = cells[cells.length - 1], prev = cells[cells.length - 2];
    const dir = dirBetween(prev, last);
    if (!dir) return null;
    return [last[0] + DIRV[dir][0], last[1] + DIRV[dir][1]];
}

/** 从 from 格指向 to 格的方位；非正交返回 null。 */
function dirBetween(from, to) {
    const dx = to[0] - from[0], dy = to[1] - from[1];
    if (dx === 0 && dy === -1) return "top";
    if (dx === 0 && dy === 1) return "bottom";
    if (dx === -1 && dy === 0) return "left";
    if (dx === 1 && dy === 0) return "right";
    return null;
}

/* ══════════════════════════ 检查实现（纯函数，可单测） ══════════════════════════ */

/**
 * L1 落地：计划声明的每一台在 obs 里真的存在且一致。
 *
 * 比对维度（缺一即红）：
 *   · 存在性   —— obs 里同 origin 必须有实体（或同 uid，若计划给了 uid）
 *   · 身份     —— type 必须一致
 *   · uid      —— 计划给了 uid 就必须是**那个** uid 在那个格（uid 是游戏分配的身份，换 uid = 不是同一台）
 *   · code     —— 计划给了 code 就必须一致（belt 的 code 编码 rv；机器 code 编码 kind+variant）
 *   · rotation —— 计划给了 r 就必须一致（origin+code 相同但方向反了，是最危险的一类）
 *   · rv       —— 计划给了 rv 就必须一致
 *
 * ★ 为什么 origin 与 uid 两个方向都查 ★
 *   只查 origin：游戏把旧实体删了又补一个新的，origin 一样，uid 变了 —— 看起来全绿。
 *   只查 uid：计划里根本没 uid（宏的计划态 uid=null），什么也查不出。
 */
export function checkLanding(plan, obs) {
    const evidence = { checked: 0, missing: [], wrong_type: [], wrong_uid: [], wrong_rot: [], wrong_rv: [], wrong_code: [], wrong_dir: [], unchecked: [] };
    const ent = obs.entities || [];
    const byUid = new Map(ent.map(e => [e.uid, e]));
    const byOrigin = new Map();
    for (const e of ent) if (!byOrigin.has(K([e.x, e.y]))) byOrigin.set(K([e.x, e.y]), e);

    for (const p of plan.placements) {
        evidence.checked++;
        let got = p.uid !== null ? byUid.get(p.uid) : byOrigin.get(K([p.x, p.y]));
        if (!got) {
            evidence.missing.push({ cell: [p.x, p.y], kind: p.kind, uid: p.uid });
            continue;
        }
        if (got.x !== p.x || got.y !== p.y) {
            evidence.missing.push({ cell: [p.x, p.y], kind: p.kind, uid: p.uid, got_cell: [got.x, got.y] });
            continue;
        }
        if (got.type !== p.kind) {
            evidence.wrong_type.push({ cell: [p.x, p.y], want: p.kind, got: got.type, uid: got.uid });
            continue;
        }
        if (p.uid !== null && got.uid !== p.uid) {
            evidence.wrong_uid.push({ cell: [p.x, p.y], want: p.uid, got: got.uid });
        }
        if (p.code !== null && got.code !== p.code) {
            evidence.wrong_code.push({ cell: [p.x, p.y], want: p.code, got: got.code, uid: got.uid });
        }
        if (p.rot !== null && got.r !== p.rot) {
            evidence.wrong_rot.push({ cell: [p.x, p.y], kind: p.kind, want: p.rot, got: got.r, uid: got.uid });
        }
        if (p.rv !== null) {
            const gotRv = typeof got.rotation_variant === "number" ? got.rotation_variant : (got.code - 1);
            if (gotRv !== p.rv) evidence.wrong_rv.push({ cell: [p.x, p.y], want: p.rv, got: gotRv, uid: got.uid });
        }
        if (p.rot === null) evidence.unchecked.push({ cell: [p.x, p.y], field: "rotation" });
        /* 带子的流向：声明了 inDir/outDir 就必须与 (code, rot) 推出来的入口/出口一致。
           ★ 为什么这条重要 ★ L4 事故的形态就是「origin 对、code 对、rv 被游戏重算成另一个」——
           那时 code 也会跟着变，所以 code 比对已经能抓；但宏有时只给 inDir/outDir 不给 code
           （connect 的 cells 两者都给，build_line 的 entities 也只给 inDir/outDir）。
           这条把「声明流向」与「世界里的 (rv,rot)」独立地钉在一起。 */
        if (p.kind === "belt" && (p.inDir || p.outDir)) {
            const rv = typeof got.rotation_variant === "number" ? got.rotation_variant : (got.code - 1);
            const gotIn = beltEntry(rv, got.r || 0), gotOut = beltExit(rv, got.r || 0);
            if (p.inDir && gotIn !== p.inDir) {
                evidence.wrong_dir.push({ cell: [p.x, p.y], field: "in", want: p.inDir, got: gotIn, uid: got.uid });
            }
            if (p.outDir && gotOut !== p.outDir) {
                evidence.wrong_dir.push({ cell: [p.x, p.y], field: "out", want: p.outDir, got: gotOut, uid: got.uid });
            }
        }
    }

    // 声明删除的必须真的消失
    evidence.removed_ok = 0;
    evidence.removed_still_there = [];
    for (const r of plan.removes || []) {
        if (byUid.has(r.uid)) evidence.removed_still_there.push({ uid: r.uid, cell: [byUid.get(r.uid).x, byUid.get(r.uid).y] });
        else evidence.removed_ok++;
    }

    const bad = evidence.missing.length + evidence.wrong_type.length + evidence.wrong_uid.length
        + evidence.wrong_rot.length + evidence.wrong_rv.length + evidence.wrong_code.length
        + evidence.wrong_dir.length + evidence.removed_still_there.length;
    if (!plan.placements.length && !(plan.removes || []).length) {
        return { name: "L1-landing", ok: false, reason: "计划里没有任何可验证的实体（placements 与 removes 都是空）—— 真空绿", evidence };
    }
    if (bad) {
        const first = evidence.missing[0] || evidence.wrong_rot[0] || evidence.wrong_dir[0] || evidence.wrong_code[0] || evidence.wrong_rv[0] || evidence.wrong_type[0] || evidence.wrong_uid[0] || evidence.removed_still_there[0];
        return {
            name: "L1-landing", ok: false,
            reason: `${bad} 处计划与世界不符（首处 ${JSON.stringify(first)}）`
                + (evidence.wrong_rot.length ? " —— 朝向/旋转不对，机器物理占地与进出料口全变" : "")
                + (evidence.wrong_dir.length ? " —— 带子流向与声明不符（rv 被重算/贴反）" : ""),
            evidence,
        };
    }
    return { name: "L1-landing", ok: true, reason: null, evidence };
}

/**
 * L2 槽位邻接：机器的输入槽是否真有上游、输出槽是否有去处。
 *
 * 双证据（任一成立即算"有上游"，两者都算不出才算红）：
 *   ① obs 邻接：槽的 approach 格上有带子，且带子的**出口朝向**这个槽（beltExit === OPP[slot.dir]）；
 *      或者 approach 格上是另一台机器的输出槽（机器直连）。
 *   ② 游戏 path：某条 path 的末格 == approach 格，且 `boundAcceptor` == 这台机器的 origin。
 *
 * 判据口径（避免假红）：
 *   · 输入：一台机器只要有**至少一个**输入槽被喂，就算这台机器被喂了（cutter 只有 1 个主输入；
 *     painter 的 color 槽、trash 的 3 个空槽都不是必须的）。未被喂的槽记进 evidence.unfed_inputs。
 *     `opts.slots.require` 可以点名"这个槽必须连通"，那才逐个判红。
 *   · 输出：同样只要求**至少一个**输出有去处（cutter 的两个输出有一个通向 trash 是合法设计）；
 *     未被接的输出记进 evidence.unrouted_outputs。`opts.slots.strictOutputs=true` 时全判。
 */
export function checkSlots(plan, obs, items, opts = {}) {
    const require = opts.slots && Array.isArray(opts.slots.require) ? opts.slots.require : [];
    const strictOutputs = !!(opts.slots && opts.slots.strictOutputs);
    const evidence = { machines: 0, fed_inputs: 0, unfed_inputs: [], unrouted_outputs: [], via_obs: 0, via_paths: 0 };
    const ent = obs.entities || [];
    const byOrigin = new Map(ent.map(e => [K([e.x, e.y]), e]));
    const byUid = new Map(ent.map(e => [e.uid, e]));

    // path 索引：末格 → boundAcceptor；首格 → path
    const paths = (items && Array.isArray(items.paths)) ? items.paths : null;
    const endAt = new Map();     // approach cell → boundAcceptor cell
    const startAt = new Map();   // approach cell → path
    if (paths) {
        for (const p of paths) {
            const cells = p.cells || [];
            if (!cells.length) continue;
            if (!startAt.has(K(cells[0]))) startAt.set(K(cells[0]), p);
            const acc = acceptorOf(p);
            if (acc) endAt.set(K(cells[cells.length - 1]), acc);
        }
    }

    /** 某台机器 origin 是否是 path 的 boundAcceptor */
    const pathLandsOn = (approach, origin) => {
        const acc = endAt.get(K(approach));
        return !!acc && acc[0] === origin[0] && acc[1] === origin[1];
    };
    /**
     * obs 里 approach 格上的东西是否朝本槽供货。
     *
     * ★ 这里必须比"**对端**的格"，不是"对端的 approach 格" ★
     *   本槽的 `slot.dir` 是「机器 → 带子」的方向，`slot.cell = slot + DIRV[dir]`。
     *   对端（带子/机器）的 slot 格就是本槽的 `slot.cell`。
     *   上一版拿对端的**输出 approach** 去比本槽的 approach，两边都多走了一格，
     *   机对机直连（cutter 左槽 → trash）永远比不中 —— 实测就是这么假红的。
     */
    const obsFeeds = (approach, slotDir) => {
        const e = byOrigin.get(K(approach));
        if (!e) return false;
        if (e.type === "belt") {
            const rv = typeof e.rotation_variant === "number" ? e.rotation_variant : (e.code - 1);
            // 带子的出口必须朝机器本身：本槽 dir 的反方向
            return beltExit(rv, e.r || 0) === OPP[slotDir];
        }
        if (e.type === "underground_belt") return true;   // 隧道口能收货（语义不建模，只当"有东西"）
        /* 机对机直连：本槽的 approach 格上就是上游机器的本体格；
           上游机器的**出口格** = 本机器的本体格 = approach - DIRV[slotDir]。 */
        const myCell = [approach[0] - DIRV[slotDir][0], approach[1] - DIRV[slotDir][1]];
        const s = slotsOf(e.type, e.variant, e.x, e.y, e.r);
        return !!s && s.outputs.some(o =>
            o.cell[0] === myCell[0] && o.cell[1] === myCell[1] && o.dir === OPP[slotDir]);
    };

    const all = plan.placements.filter(p => p.kind !== "belt" && p.kind !== "underground_belt");
    let machinesUnknown = 0;
    for (const m of all) {
        /* ★ 槽位用**世界的** (type, variant, r) 算，不用计划里的 ★
           计划的 rotation 可能与世界不符（那由 L1 判红）。L2 问的是"这台机器现在接上了没有"，
           如果用计划的朝向算槽位，就会去检查一个**不存在的**机器的槽 —— 两个检查会互相污染。
           实测教训：故意把计划里 cutter 的 r 改成 90，若 L2 用计划的 r，它会报
           "另一个朝向的 left/right 槽没接上"，而那台 90° 的机器根本不存在。
           世界里有实体就用世界的；世界没有（还没贴）才退回计划值。 */
        const actual = byOrigin.get(K([m.x, m.y]));
        const kind = actual ? actual.type : m.kind;
        const variant = actual ? (actual.variant || "default") : m.variant;
        const rot = actual ? (actual.r || 0) : m.rot;
        const s = slotsOf(kind, variant, m.x, m.y, rot);
        if (!s) { machinesUnknown++; continue; }
        evidence.machines++;
        evidence.used_world_orientation = (evidence.used_world_orientation || 0) + (actual ? 1 : 0);
        if (s.inputs.length) {
            const fed = [], unfed = [];
            for (const slot of s.inputs) {
                const viaPath = pathLandsOn(slot.cell, [m.x, m.y]);
                const viaObs = obsFeeds(slot.cell, slot.dir);
                if (viaPath) evidence.via_paths++;
                if (viaObs) evidence.via_obs++;
                (viaPath || viaObs ? fed : unfed).push({ slot: slot.slot, approach: slot.cell, dir: slot.dir, role: slot.role });
            }
            evidence.fed_inputs += fed.length;
            if (!fed.length) evidence.unfed_inputs.push({ cell: [m.x, m.y], kind: m.kind, slots: unfed });
        }
        if (s.outputs.length) {
            const routed = [], unrouted = [];
            for (const slot of s.outputs) {
                const viaPath = !!paths && startAt.has(K(slot.cell));
                const viaObs = (() => {
                    const e = byOrigin.get(K(slot.cell));
                    if (!e) return false;
                    if (e.type === "belt") {
                        // 带子的入口必须朝本机器：本槽 dir 的反方向
                        const rv = typeof e.rotation_variant === "number" ? e.rotation_variant : (e.code - 1);
                        return beltEntry(rv, e.r || 0) === OPP[slot.dir];
                    }
                    const os = slotsOf(e.type, e.variant, e.x, e.y, e.r);
                    /* 机对机直连：下游机器的**入口格**（approach）必须落在我这台机器的本体格上，
                       且它的 dir 指向我。`slot.slot` 是本槽所在的本体格。 */
                    return !!os && os.inputs.some(i =>
                        i.cell[0] === slot.slot[0] && i.cell[1] === slot.slot[1] && i.dir === OPP[slot.dir]);
                })();
                (viaPath || viaObs ? routed : unrouted).push({ slot: slot.slot, approach: slot.cell, dir: slot.dir, role: slot.role });
            }
            if (unrouted.length) evidence.unrouted_outputs.push({ cell: [m.x, m.y], kind: m.kind, slots: unrouted });
        }
    }

    // 点名要求（opts.slots.require）
    const requireFails = [];
    for (const r of require) {
        const m = r.cell ? byOrigin.get(K(r.cell)) : (r.uid !== undefined ? byUid.get(r.uid) : null);
        if (!m) { requireFails.push({ want: r, why: "实体不存在" }); continue; }
        const s = slotsOf(m.type, m.variant, m.x, m.y, m.r);
        if (!s) { requireFails.push({ want: r, why: "槽位表未知" }); continue; }
        const list = r.side === "out" ? s.outputs : s.inputs;
        const slot = list.find(x => x.role === r.role) || list[0];
        const okv = r.side === "out"
            ? (paths ? startAt.has(K(slot.cell)) : obsFeeds(slot.cell, slot.dir))
            : (pathLandsOn(slot.cell, [m.x, m.y]) || obsFeeds(slot.cell, slot.dir));
        if (!okv) requireFails.push({ want: r, at: slot.cell, why: "该槽没有运行时证据" });
    }
    evidence.require_fails = requireFails;
    evidence.machines_unknown_geometry = machinesUnknown;
    evidence.paths_truncated = !!(items && typeof items.pathCount === "number" && paths && items.pathCount > paths.length);
    evidence.paths_available = !!paths;

    if (!evidence.machines) {
        return { name: "L2-slots", ok: true, skipped: true, reason: "计划里没有可解析槽位的机器（纯带子计划）", evidence };
    }
    if (evidence.paths_truncated) {
        return {
            name: "L2-slots", ok: false, undecidable: true,
            reason: `debug_items 只给了 ${paths.length}/${items.pathCount} 条路径 —— 邻接/去处判据不完整`,
            evidence,
        };
    }
    if (requireFails.length) {
        return { name: "L2-slots", ok: false, reason: `${requireFails.length} 个被点名的槽没有运行时证据（首处 ${JSON.stringify(requireFails[0])}）`, evidence };
    }
    if (evidence.unfed_inputs.length) {
        const first = evidence.unfed_inputs[0];
        return {
            name: "L2-slots", ok: false,
            reason: `${evidence.unfed_inputs.length} 台机器一个输入槽都没被喂（首台 ${first.kind}@${JSON.stringify(first.cell)}）—— 放进去了但线是死的`,
            evidence,
        };
    }
    if (strictOutputs && evidence.unrouted_outputs.length) {
        return {
            name: "L2-slots", ok: false,
            reason: `${evidence.unrouted_outputs.length} 台机器有未接的输出（strictOutputs）`,
            evidence,
        };
    }
    return { name: "L2-slots", ok: true, reason: null, evidence };
}

/**
 * L3 连通：沿**游戏自己的** paths 从 from 走到 to。
 *
 * 这不是"图上有没有路"（那是生成器自证），是"游戏现在真的把货送去哪里"。
 * 走法：from 实体 → 它的输出槽 approach → 首格等于该格的 path → 沿 path 到 boundAcceptor
 *       → 若接收方是目标则成功，否则若接收方是机器就从它继续（≤32 跳）。
 *
 * 没给 flows 时退化为「计划 bbox（外扩 2 格）内的断头路」检测：一条 path 的 boundAcceptor
 * 为 null 且落在该区域 ⇒ 货会堆在那里。既有的旧厂线路不参与（只看计划附近）。
 */
export function checkFlow(plan, obs, items, opts = {}) {
    const evidence = { flows: 0, reached: 0, unreached: [], dead_ends: [], hops_max: 32 };
    const paths = (items && Array.isArray(items.paths)) ? items.paths : null;
    if (!paths) {
        return { name: "L3-flow", ok: false, undecidable: true, reason: "debug_items 没有返回 paths —— 无法判定连通", evidence };
    }
    if (typeof items.pathCount === "number" && items.pathCount > paths.length) {
        evidence.paths_truncated = true;
        return { name: "L3-flow", ok: false, undecidable: true, reason: `debug_items 只给了 ${paths.length}/${items.pathCount} 条路径`, evidence };
    }
    const ent = obs.entities || [];
    const byUid = new Map(ent.map(e => [e.uid, e]));
    const byOrigin = new Map();
    for (const e of ent) if (!byOrigin.has(K([e.x, e.y]))) byOrigin.set(K([e.x, e.y]), e);

    const startAt = new Map();
    for (const p of paths) {
        const c = (p.cells || [])[0];
        if (c) startAt.set(K(c), p);
    }
    const resolve = ep => {
        if (isInt(ep)) return byUid.get(ep) || null;
        if (Array.isArray(ep)) return byOrigin.get(K(ep)) || null;
        if (ep && isInt(ep.uid)) return byUid.get(ep.uid) || null;
        if (ep && Array.isArray(ep.cell)) return byOrigin.get(K(ep.cell)) || null;
        return null;
    };

    /** 从一台实体出发，沿 paths 能到达的实体集合（逐跳） */
    const reach = (start) => {
        const seen = new Set([start.uid]);
        let frontier = [start];
        const trail = [];
        for (let hop = 0; hop < evidence.hops_max && frontier.length; hop++) {
            const next = [];
            for (const m of frontier) {
                const s = slotsOf(m.type, m.variant, m.x, m.y, m.r);
                if (!s) continue;
                for (const out of s.outputs) {
                    const p = startAt.get(K(out.cell));
                    if (!p) continue;
                    const accCell = acceptorOf(p);
                    if (!accCell) continue;
                    const acc = byOrigin.get(K(accCell));
                    if (!acc) continue;
                    trail.push({ from: m.uid, path_first: p.cells[0], path_last: p.cells[p.cells.length - 1], to: acc.uid, at: [acc.x, acc.y] });
                    if (!seen.has(acc.uid)) { seen.add(acc.uid); next.push(acc); }
                }
            }
            frontier = next;
        }
        return { seen, trail };
    };

    const flows = Array.isArray(opts.flows) && opts.flows.length ? opts.flows : (plan.flows || []);
    evidence.flows = flows.length;
    if (flows.length) {
        for (const f of flows) {
            const a = resolve(f.from), b = resolve(f.to);
            if (!a || !b) { evidence.unreached.push({ flow: f, why: !a ? "from 不存在" : "to 不存在" }); continue; }
            const { seen, trail } = reach(a);
            if (seen.has(b.uid)) { evidence.reached++; evidence.last_trail = trail; }
            else evidence.unreached.push({ flow: f, from: a.uid, to: b.uid, trail });
        }
        if (evidence.unreached.length) {
            return {
                name: "L3-flow", ok: false,
                reason: `${evidence.unreached.length}/${flows.length} 条货流走不到目的地（首条 ${JSON.stringify(evidence.unreached[0].flow)}）—— 游戏自己的 path 没连上`,
                evidence,
            };
        }
        return { name: "L3-flow", ok: true, reason: null, evidence };
    }

    // 无显式 flows：计划附近的断头路检测
    const xs = plan.placements.map(p => p.x), ys = plan.placements.map(p => p.y);
    if (!xs.length) return { name: "L3-flow", ok: true, skipped: true, reason: "没有 placements 也没有 flows", evidence };
    const pad = opts.flowPad === undefined ? 2 : opts.flowPad;
    const bx0 = Math.min(...xs) - pad, bx1 = Math.max(...xs) + pad;
    const by0 = Math.min(...ys) - pad, by1 = Math.max(...ys) + pad;
    const inBox = c => c && c[0] >= bx0 && c[0] <= bx1 && c[1] >= by0 && c[1] <= by1;
    for (const p of paths) {
        const cells = p.cells || [];
        if (!cells.some(inBox)) continue;
        if (!acceptorOf(p)) {
            evidence.dead_ends.push({ head: cells[0], tail: cells[cells.length - 1], len: cells.length, items: p.itemsOnPath });        }
    }
    evidence.scope = [bx0, by0, bx1, by1];
    /* ★ 降级模式必须自曝（F10 实测的假绿入口）★
       没有显式 flows 时，本检查**只**看计划 bbox 外扩 `flowPad` 格内的断头路。
       实测过：一次 replace_run 的 bbox 外 3 格处就有一条零物品的死端带，L3 没看见，
       于是「局部全绿」被读成「连通没问题」。这不是判据写错，是**覆盖范围没被说出来**。
       所以 ok:true 的同时必须带上 `degraded:true`，让调用方知道这个绿是**有边界的绿**。
       编排放面（loop）不得把 degraded 的 L3 当作「连通已验证」——它只回答
       「我改的那一小块附近没有新死端」。要真验连通，必须给 flows。
     */
    const degradedEvidence = { ...evidence, degraded: true, degraded_reason: "未给 opts.flows：仅检查计划 bbox 外扩 " + pad + " 格内的断头路" };
    if (evidence.dead_ends.length) {
        const d = evidence.dead_ends[0];
        return {
            name: "L3-flow", ok: false, degraded: true,
            reason: `计划附近有 ${evidence.dead_ends.length} 段带子没有去处（${JSON.stringify(d.head)}..${JSON.stringify(d.tail)}，${d.len} 格）—— 货会堆在那里`,
            evidence: degradedEvidence,
        };
    }
    return {
        name: "L3-flow", ok: true, degraded: true,
        reason: `未给 flows，只检查了 ${JSON.stringify(evidence.scope)} 范围内的断头路（通过）；连通性本身未验证`,
        evidence: degradedEvidence,
    };
}

/**
 * L4 行为（可选）：推进游戏 N tick，看目标形状的交付真的**增量**了。
 *
 * 只在 `opts.behavior` 给出时运行；读的是游戏自己的时间片统计，不是估算。
 *
 * ★ 为什么不能比 `produced_total` 的差值（这是本文件最深的一个坑）★
 *   `production()` 返回的 `produced_total` 是**最近 N 片的求和**（mod 的
 *   `observeProduction`：`history[key].slice(-wantSlices)` 再 sum），**不是累计量**。
 *   于是 `production({slices:2}).produced_total` 是 20 秒窗口，`production({slices:6})`
 *   是 60 秒窗口 —— **两个不同长度的窗口相减，差值没有任何物理意义**。
 *
 *   更要命的是旧判据 `got <= 0 && was <= 0` 才判红：只要老产线本来就在生产同一个形状，
 *   一条全死的线也判绿。实测（factcheck）：before=99 / after=99 / delta=0 → 绿。
 *
 *   正确判据必须落在**同一口径**上，三选一：
 *     ① `delivered_slices` 逐片求和（每片固定 slice_seconds，天然同口径）；
 *     ② `goal.requirement.delivered` 的增量（hub 的真实交付计数，最权威）；
 *     ③ 单窗口的 `delivered_per_sec > minPerSec`（速率口径一致时可直接比）。
 *   本实现用 ① 求增量、用 ② 交叉校验（两者都给就都要过）。
 *
 * ★ produced ≠ delivered ★
 *   废料侧在产出而目标侧零交付，是 L4 这类改造最典型的失败形态。旧实现只读
 *   `produced_total`，把"线在转"读成"关卡在推进"。这里两者都要看，且交付是硬判据。
 */
export async function checkBehavior(plan, reader, opts = {}) {
    const b = opts.behavior;
    if (!b) return { name: "L4-behavior", ok: true, skipped: true, reason: "未请求行为检查（opts.behavior）", evidence: {} };
    const shape = b.shape || (plan.goal || null);
    if (!shape) return { name: "L4-behavior", ok: false, reason: "行为检查缺目标形状（opts.behavior.shape）", evidence: {} };
    const ticks = b.ticks === undefined ? 2400 : b.ticks;      // 20 游戏秒 @120Hz
    const minPerSec = b.minPerSec === undefined ? 0 : b.minPerSec;

    /* 前置：交付量的**同口径**基线。goal 的 delivered 是累计计数（hub 权威），
       slices 的 delivered 是窗口求和 —— 两者分开记，不混。 */
    const prodBefore = await reader.production({ slices: 2 });
    const goalBefore = await readGoalDelivered(reader);

    await reader.step(ticks);

    const prodAfter = await reader.production({ slices: 6 });
    const goalAfter = await readGoalDelivered(reader);

    /* ① 同口径增量：逐片求和（每片都是 slice_seconds，窗口长度不同不影响） */
    const sliceSum = (slices, s) => (Array.isArray(slices) ? slices : [])
        .reduce((a, sl) => a + ((sl && sl[s]) || 0), 0);

    const delAfter = sliceSum(prodAfter.delivered_slices, shape);
    const delBefore = sliceSum(prodBefore.delivered_slices, shape);
    /* 注意：before/after 的 slices 数不同，所以这两个绝对值不可相减。
       增量只能用 **goal 的累计交付**，或只看 after 窗口内是否真有交付。 */
    const prodAfterN = (prodAfter.produced_total && prodAfter.produced_total[shape]) || 0;
    const prodBeforeN = (prodBefore.produced_total && prodBefore.produced_total[shape]) || 0;
    const rate = prodAfter.delivered_per_sec ? (prodAfter.delivered_per_sec[shape] || 0) : null;

    const goalDelta = (goalBefore !== null && goalAfter !== null) ? goalAfter - goalBefore : null;
    const evidence = {
        shape, ticks,
        produced_window_before: prodBeforeN, produced_window_after: prodAfterN,
        produced_window_secs_before: prodBefore.window_seconds, produced_window_secs_after: prodAfter.window_seconds,
        delivered_in_window_after: delAfter, delivered_in_window_before: delBefore,
        goal_delivered_before: goalBefore, goal_delivered_after: goalAfter, goal_delivered_delta: goalDelta,
        rate_per_sec: rate, window_seconds: prodAfter.window_seconds,
        /* 明确写出「哪些数字不能相减」，免得读 evidence 的人再踩一次 */
        caveat: "produced_*/delivered_in_window_* 是窗口求和，before/after 窗口长度不同，不可相减；增量只看 goal_delivered_delta",
    };

    /* ── 判据一：交付必须真的发生（不是"产出过"） ── */
    const deliveredHappened = delAfter > 0 || (goalDelta !== null && goalDelta > 0);
    if (!deliveredHappened) {
        /* 区分三种"没交付"，因为修法完全不同 */
        const producedSomething = prodAfterN > 0;
        const reason = !producedSomething && prodBeforeN <= 0
            ? `跑完 ${ticks} tick 后 ${shape} 一件都没产出 —— 这条线在游戏里没跑起来`
            : producedSomething
                ? `${shape} 在产出（窗口内 ${prodAfterN} 件）但**一件都没交付**到 hub —— 货流没通到终点，或产物被丢弃`
                : `${shape} 没有新产出，也没有新交付 —— 这条线处于停滞`;
        return { name: "L4-behavior", ok: false, reason, evidence };
    }

    /* ── 判据二：速率（给了才判） ── */
    if (rate !== null && minPerSec > 0 && rate < minPerSec) {
        return { name: "L4-behavior", ok: false, reason: `${shape} 交付速率 ${rate}/s < 要求 ${minPerSec}/s`, evidence };
    }

    return { name: "L4-behavior", ok: true, reason: null, evidence };
}

/** 读 goal 的累计交付量（hub 权威计数）。读不到返回 null —— 不猜。 */
async function readGoalDelivered(reader) {
    try {
        const o = await reader.obs({ max_entities: 1, include_hub: true });
        const d = o && o.goal && o.goal.requirement && o.goal.requirement.delivered;
        return typeof d === "number" ? d : null;
    } catch { return null; }
}

/* ══════════════════════════ 主入口 ══════════════════════════ */

function loadPlanArg(arg, opts) {
    if (typeof arg !== "string") return { plan: arg, fromFile: null };
    const candidates = [
        path.resolve(arg),
        path.resolve(opts.plansDir || DEFAULT_PLANS_DIR, arg.endsWith(".json") ? arg : arg + ".json"),
        path.resolve(opts.plansDir || DEFAULT_PLANS_DIR, arg),
    ];
    for (const c of candidates) {
        try {
            if (fs.existsSync(c) && fs.statSync(c).isFile()) {
                return { plan: JSON.parse(fs.readFileSync(c, "utf8")), fromFile: c };
            }
        } catch (e) { /* 继续找下一个 */ }
    }
    throw new Error(`planId "${arg}" 找不到（尝试过：${candidates.join(" | ")}）`);
}

/**
 * @param {string|object|Array} planOrId  planId（文件名）、plan 对象或 raw ops 数组
 * @param {object} [opts]
 * @param {object} [opts.reader]   注入 {obs, debugItems, production, step}（单测用；缺省连桥）
 * @param {Array}  [opts.flows]    [{from: uid|cell, to: uid|cell}]
 * @param {object} [opts.slots]    {require:[{cell|uid, side:"in"|"out", role}], strictOutputs:bool}
 * @param {object} [opts.behavior] {shape, ticks, minPerSec}
 * @param {string} [opts.region]   obs 的范围（缺省全量，layer:"all"）
 * @param {number} [opts.flowPad]
 * @param {string} [opts.plansDir]
 * @returns {Promise<{ok:boolean, plan:{source,from_file,placements,removes}, checks:Array, obs:{entities,truncated,tick}, error?:object}>}
 */
export async function verifyRuntime(planOrId, opts = {}) {
    const reader = { ...BRIDGE_READER, ...(opts.reader || {}) };
    let plan, fromFile = null;
    try {
        const loaded = loadPlanArg(planOrId, opts);
        plan = loaded.plan; fromFile = loaded.fromFile;
    } catch (e) {
        return { ok: false, error: { code: "plan_not_found", message: e.message }, checks: [] };
    }
    let norm;
    try {
        norm = normalizePlan(plan);
    } catch (e) {
        return { ok: false, error: { code: "bad_plan", message: e.message }, checks: [] };
    }
    if (plan && typeof plan === "object" && !Array.isArray(plan) && plan.anchor) norm.anchor = plan.anchor;

    const obsParams = { layer: "all", max_entities: 50000 };
    if (Array.isArray(opts.region)) obsParams.region = opts.region;
    let obs;
    try { obs = await reader.obs(obsParams); } catch (e) {
        return { ok: false, error: { code: "obs_failed", message: e.message }, plan: briefNorm(norm, fromFile), checks: [] };
    }
    const checks = [];
    if (obs.truncated) {
        checks.push({
            name: "L0-observation", ok: false, undecidable: true,
            reason: `obs 被截断（entity_count=${obs.entity_count}）—— 没看到全部实体，任何落地判据都不可靠`,
            evidence: { entity_count: obs.entity_count, returned: (obs.entities || []).length },
        });
        return { ok: false, plan: briefNorm(norm, fromFile), checks };
    }
    const g0 = {
        name: "L0-observation", ok: true, reason: null,
        evidence: { entity_count: obs.entity_count, tick: obs.tick, layer: obs.layer },
    };
    checks.push(g0);

    checks.push(checkLanding(norm, obs));

    // 槽位与连通需要 debug_items；区域覆盖计划的 bbox（外扩 6 格），否则会假红
    let items = null;
    if (norm.placements.length) {
        const xs = norm.placements.map(p => p.x), ys = norm.placements.map(p => p.y);
        const pad = opts.flowPad === undefined ? 6 : Math.max(6, opts.flowPad);
        const region = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad].map(Math.round);
        try {
            items = await reader.debugItems({ region });
        } catch (e) {
            items = { beltError: e.message };
        }
    }

    checks.push(checkSlots(norm, obs, items, opts));
    checks.push(checkFlow(norm, obs, items, opts));

    if (opts.behavior) checks.push(await checkBehavior(norm, reader, opts));

    const ok = checks.every(c => c.ok || c.skipped);
    return {
        ok,
        plan: briefNorm(norm, fromFile),
        checks,
        obs: { entity_count: obs.entity_count, tick: obs.tick, truncated: !!obs.truncated },
    };
}

function briefNorm(norm, fromFile) {
    return {
        source: norm.source,
        from_file: fromFile,
        placements: norm.placements.length,
        removes: norm.removes.length,
        anchor: norm.anchor || null,
    };
}

/* ══════════════════════════ CLI ══════════════════════════ */

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("agent/verify_runtime.mjs");
if (isMain) {
    const argv = process.argv.slice(2);
    const argVal = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
    const planArg = argVal("--plan");
    if (!planArg) {
        console.error("用法：node src/agent/verify_runtime.mjs --plan <plan.json> [--flows '<json>'] [--json]");
        process.exit(1);
    }
    const opts = {};
    try {
        if (argVal("--flows")) opts.flows = JSON.parse(argVal("--flows"));
        if (argVal("--region")) opts.region = JSON.parse(argVal("--region"));
    } catch (e) {
        console.error("✗ --flows / --region 不是合法 JSON：" + e.message);
        process.exit(1);
    }
    verifyRuntime(planArg, opts).then(r => {
        if (argv.includes("--json")) { console.log(JSON.stringify(r, null, 2)); }
        else {
            console.log("═".repeat(64));
            if (r.error) console.log(`✗ ${r.error.code}: ${r.error.message}`);
            for (const c of r.checks) {
                const mark = c.skipped ? "–" : (c.ok ? "✓" : (c.undecidable ? "?" : "✗"));
                console.log(`${mark} ${c.name}${c.reason ? "  " + c.reason : ""}`);
                if (c.evidence && Object.keys(c.evidence).length) {
                    const ev = JSON.stringify(c.evidence);
                    console.log("    " + (ev.length > 240 ? ev.slice(0, 240) + "…" : ev));
                }
            }
            console.log(`ok=${r.ok}`);
        }
        process.exit(r.ok ? 0 : 2);
    }).catch(e => { console.error("✗ " + e.message); process.exit(1); });
}
