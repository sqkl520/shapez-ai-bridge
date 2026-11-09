/**
 * verify.mjs — loop 的**裁决层**：把「一次 tx 的结果」与「两个世界快照」变成可机器判定的结论。
 *
 * 唯一真值：`research/ai-plan/PHASE2-CONTRACT-V2.md` §2.1 / §2.2 / §2.4。
 * 本文件与 v1 契约的五处差异**全部来自红队实测**，每一处都在代码里写死原因：
 *
 *   1. `tx.verify` **只在 `rolled_back===true` 时非 null**（bridge:3361-3362）。
 *      成功路径读 `tx.verify.uid_set_equal` 会 TypeError —— 所以 `applyVerdict` 只在回滚分支读它。
 *   2. `tx.results[i]` 只有 `{index, op, ok, uid, applied}`（bridge:3402-3406）：
 *      **没有 `mismatch`，也没有 `actual`**。所以 `GAME_COERCED`（游戏把 rv 改了）
 *      不在 apply 阶段判，交给 L1 的 `wrong_rv` / `wrong_code`（比较依据是世界，不是 op 返回值）。
 *      pending 桥接只用真实存在的 `results[i].uid`。
 *   3. `L4-behavior` 的 evidence **没有 `produced_delta`**（f619cca 故意删掉：跨窗口相减无意义）。
 *      增量只能读 `goal_delivered_delta`（hub 累计计数）或 `delivered_in_window_after`（同一窗口求和）。
 *      `goal_delivered_*` 为 null ⇒ 判红：读不到权威计数时**不许假设它涨了**。
 *   4. `report.uidDiff` 不存在 —— 必须由 `undeclaredDestruction()` 用两份 obs 自己算（v2 §2.4）。
 *   5. `verifyRuntime().ok` 是 `checks.every(c => c.ok || c.skipped)`（verify_runtime.mjs:919）——
 *      **skipped 会被当成绿**。所以 `strictVerdict` 是独立判据，不能拿 `report.ok` 当成功。
 *
 * 本文件不写世界、不发 tx：它只读 reader 并把读到的结果裁决掉。
 */

import { verifyRuntime, slotsOf, beltRvOf } from "../verify_runtime.mjs";
import { DIRV, beltExit } from "../../ai/belt-rules.mjs";
import { worldHealth, healthDelta, classifyNetEffect } from "./health.mjs";

const isInt = n => typeof n === "number" && Number.isInteger(n);
const K = c => `${c[0]},${c[1]}`;
const BELT_KINDS = new Set(["belt", "underground_belt"]);

/* ══════════════════════════ obs 归一化与哈希 ══════════════════════════ */

function unwrapObs(obs) {
    if (obs && typeof obs === "object" && !Array.isArray(obs.entities)
        && obs.result && Array.isArray(obs.result.entities)) return obs.result;
    return obs && typeof obs === "object" ? obs : {};
}

/**
 * 世界里 uid 集合的稳定哈希。
 *
 * 用途只有一个：在 transcript / evidence 里留一个「两份 obs 是不是同一个世界」的指纹。
 * **它不是判据** —— 判据必须是 `undeclaredDestruction()` 给出的具体 uid 列表
 * （哈希变了但说不清是谁消失了，对修复毫无用处）。这里用 FNV-1a 64（零依赖、足够区分），
 * 而不是 sha256：本文件要能在浏览器/受限环境里无 import 跑，且这个值只做对账。
 */
export function worldUidSetHash(obs) {
    const o = unwrapObs(obs);
    const uids = (o.entities || []).map(e => e && e.uid).filter(v => isInt(v)).sort((a, b) => a - b);
    let h = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    for (const uid of uids) {
        for (const ch of `${uid},`) {
            h ^= BigInt(ch.charCodeAt(0));
            h = (h * prime) & 0xffffffffffffffffn;
        }
    }
    return `fnv1a64:${h.toString(16).padStart(16, "0")}:n=${uids.length}`;
}

/* ══════════════════════════ v2 §2.4：未声明的销毁 ══════════════════════════ */

/**
 * before 里有、after 里没有、且**不在计划声明的 destroys 里**的 uid。
 * 非空 ⇒ 硬停（不是「继续修」）：有人删了我们没打算删的东西。
 *
 * 注意 v2 §2.4 的两条边界：
 *   · `declaredDestroys` 必须是**计划**声明的（planToTxOps 的 `destroys`），不是 tx 的 diff；
 *   · live 的 obs 可能是 region 过滤 / max_entities 截断的 —— 调用方必须保证两份 obs 的取数口径
 *     相同（verifyRound 用同一组 params 读两次），否则差集里会出现假消失。
 *     这也是为什么本函数只返回 uid 列表而不返回「结论」：调用方能看见具体是谁。
 *
 * @param {object} beforeObs
 * @param {object} afterObs
 * @param {number[]} declaredDestroys
 * @returns {number[]}
 */
export function undeclaredDestruction(beforeObs, afterObs, declaredDestroys) {
    const b = unwrapObs(beforeObs), a = unwrapObs(afterObs);
    const before = new Set((b.entities || []).map(e => e && e.uid).filter(v => isInt(v)));
    const after = new Set((a.entities || []).map(e => e && e.uid).filter(v => isInt(v)));
    const declared = new Set((Array.isArray(declaredDestroys) ? declaredDestroys : []).filter(v => isInt(v)));
    const out = [];
    for (const uid of before) {
        if (after.has(uid)) continue;
        if (declared.has(uid)) continue;
        out.push(uid);
    }
    return out.sort((x, y) => x - y);
}

/* ══════════════════════════ v2 §2.2：apply 判据 ══════════════════════════ */

/**
 * 一次 tx 是否算「干净地落盘」。
 *
 * 三件检查（全部按 v2 §2.2 的真实字段写）：
 *   ① `dry_run` 必须 false（loop 从不传 dry_run；传了说明调用方接错线）；
 *   ② `ok && !rolled_back`，且 `applied === requestedOps`；
 *   ③ **只有回滚路径**才读 `tx.verify.uid_set_equal`；为 false 时 `hardStop:true`
 *      （回滚没洗干净 ⇒ 继续写会污染下一次尝试，必须停手而不是重试）。
 *   ④ 成功但 `diff.added`/`diff.removed` 全空 ⇒ `NO_WORLD_CHANGE`
 *      （本项目最常见的假绿入口：tx 说成功、世界没动）。
 *
 * ★ 绝不做的事 ★
 *   · 不读 `tx.verify` 当成功证据（成功时它是 null）；
 *   · 不读 `tx.results[i].mismatch`（不存在）；
 *   · 不把 `tx.net`（「本来会发生什么」）当成功。
 *
 * @param {object} tx
 * @param {{requestedOps:number}} opts
 * @returns {{ok:boolean, hardStop:boolean, why:string[]}}
 */
export function applyVerdict(tx, { requestedOps } = {}) {
    const why = [];
    if (!tx || typeof tx !== "object") {
        return { ok: false, hardStop: true, why: ["tx 返回缺失 —— 没有可裁决的事务结果（不是「成功」）"] };
    }
    if (tx.dry_run === true) why.push("tx.dry_run=true（loop 不该传 dry_run：dry_run 不改世界，不能当落盘成功）");
    if (tx.ok !== true) {
        why.push(`tx.ok=${JSON.stringify(tx.ok)}（${tx.aborted === true ? "aborted" : "未成功"}）`);
    }
    if (tx.rolled_back === true) {
        why.push("tx.rolled_back=true —— 世界已还原，这一轮等于零动作");
        /* ★ verify 只在回滚时非 null（bridge:3361-3362）。成功时读它会 TypeError。 ★ */
        if (tx.verify && tx.verify.uid_set_equal === false) {
            why.push("回滚后世界没洗干净（uid 集合不等）→ 硬停，继续写会污染下一次尝试");
            return { ok: false, hardStop: true, why };
        }
    }
    if (isInt(requestedOps) && tx.applied !== requestedOps) {
        why.push(`applied ${JSON.stringify(tx.applied)} ≠ requested ${requestedOps}`);
    }
    if (tx.rolled_back !== true && tx.diff && typeof tx.diff === "object") {
        const added = Array.isArray(tx.diff.added) ? tx.diff.added : [];
        const removed = Array.isArray(tx.diff.removed) ? tx.diff.removed : [];
        if (added.length === 0 && removed.length === 0) {
            why.push("NO_WORLD_CHANGE：tx 成功但世界没变（added/removed 全空）");
        }
    }
    return { ok: why.length === 0, hardStop: false, why };
}

/* ══════════════════════════ pending → 真 uid 的桥接 ══════════════════════════ */

/**
 * `pendingByOp[opIndex] = token` + `tx.results[]` → `{token: uid}`。
 *
 * v2 §2.3 的裁决：桥接**只能**用 `results[i].uid`（真实存在；place 返回 entity_uid 被 mod 归一成 uid）。
 * `results[i].mismatch` 不存在，所以这里既不能判断「游戏是否改了 rv」，也不假装判断。
 * 这点事后由 L1（`wrong_rv` / `wrong_code`）负责 —— 它比的是世界，比 op 返回值更可信。
 *
 * @param {object} tx
 * @param {Record<number,string>} pendingByOp
 * @returns {{uidMap:Record<string,number>, missing:string[], coerced:Array<{token:string,uid:number}>}}
 */
export function buildUidMap(tx, pendingByOp) {
    const uidMap = {};
    const missing = [];
    if (!tx || !Array.isArray(tx.results) || !pendingByOp) return { uidMap, missing, coerced: [] };
    for (const [idxStr, token] of Object.entries(pendingByOp)) {
        const idx = Number(idxStr);
        const r = tx.results.find(x => x && x.index === idx);
        if (!r || !isInt(r.uid)) { missing.push(token); continue; }
        uidMap[token] = r.uid;
    }
    /* `coerced` 字段**不是** mismatch：tx 里没有 mismatch。这里恒为空，
       保留它只是为了给调用方一个稳定的形状（读者看到空数组就该去 L1 找 wrong_rv）。 */
    return { uidMap, missing, coerced: [] };
}

/* ══════════════════════════ obs 内的连通性（不依赖 debug_items） ══════════════════════════ */

/**
 * 从一台实体出发，在 **obs**（不是 paths）里沿「输出槽 → 下一格」能到达的 uid 集合。
 *
 * 为什么需要它：L3 的 `checkFlow` 依赖 `debug_items.paths`，而 paths 是
 * **前 40 条 + 全局 pathCount**（mod 语义；>40 就永久 undecidable）。
 * 计划自己派生的 flows 里有一类 via:"chain"（输出落在既有带子链上），
 * 这类**不靠 paths 也能验**：照着带子的 (rv, r) 逐格走即可。本函数就是那一步。
 *
 * 走法与 planToTxOps.deriveFlows 的 ③ 同源（同一套 beltExit 规则），
 * 但这里是**独立实现**（验证器不借生成器的结论 —— 只借 belt-rules 的几何定义）。
 */
export function obsReach(fromUid, obs) {
    const o = unwrapObs(obs);
    const entities = (o.entities || []).filter(e => e && isInt(e.uid));
    const byUid = new Map(entities.map(e => [e.uid, e]));
    const byCell = new Map();
    for (const e of entities) {
        const w = footprintOf(e);
        for (const c of w) if (!byCell.has(K(c))) byCell.set(K(c), e);
    }
    const start = byUid.get(fromUid);
    const seen = new Set();
    const trail = [];
    if (!start) return { seen, trail, missing: true };

    /** 一个实体的「货从这里出去」的世界格（绝对坐标） */
    const nextCells = (e) => {
        if (e.type === "belt") {
            const rv = typeof e.rotation_variant === "number" ? e.rotation_variant : (e.code - 1);
            const dir = beltExit(rv, e.r || 0);
            return [[e.x + DIRV[dir][0], e.y + DIRV[dir][1]]];
        }
        if (e.type === "underground_belt") return [];      // 隧道语义不建模
        const s = slotsOf(e.type, e.variant, e.x, e.y, e.r || 0, beltRvOf(e));
        if (!s) return [];
        return s.outputs.map(out => [out.cell[0], out.cell[1]]);
    };

    let frontier = [start];
    for (let hop = 0; hop < 64 && frontier.length; hop++) {
        const next = [];
        for (const m of frontier) {
            for (const cell of nextCells(m)) {
                /* 带子链：一格一格走，直到撞上非带子实体（机器/hub/trash） */
                let cur = cell, guard = 0, hit = null;
                while (guard++ < 512) {
                    const e = byCell.get(K(cur));
                    if (!e) { hit = null; break; }
                    if (e.uid === m.uid) { hit = null; break; }       // 自环：不算到达
                    if (e.type === "belt") {
                        const rv = typeof e.rotation_variant === "number" ? e.rotation_variant : (e.code - 1);
                        const dir = beltExit(rv, e.r || 0);
                        cur = [cur[0] + DIRV[dir][0], cur[1] + DIRV[dir][1]];
                        continue;
                    }
                    if (e.type === "underground_belt") { hit = null; break; }
                    hit = e;
                    break;
                }
                if (!hit) continue;
                trail.push({ from: m.uid, to: hit.uid, type: hit.type });
                if (!seen.has(hit.uid)) { seen.add(hit.uid); next.push(hit); }
            }
        }
        frontier = next;
    }
    return { seen, trail, missing: false };
}

function footprintOf(e) {
    const s = slotsOf(e.type, e.variant, e.x, e.y, e.r || 0, beltRvOf(e));
    if (s && s.footprint) {
        const out = [];
        for (let dy = 0; dy < s.footprint[1]; dy++) for (let dx = 0; dx < s.footprint[0]; dx++) out.push([e.x + dx, e.y + dy]);
        return out;
    }
    return [[e.x, e.y]];
}

/* ══════════════════════════ v2 §2.1：strictVerdict ══════════════════════════ */

/**
 * loop 自己的成功判据（**不是** `verifyRuntime().ok`）。
 *
 * @param {object} report  verifyRuntime 的返回（或 verifyRound 的 report）
 * @param {{mode:"live"|"mock"|"replay", goalShape?:string, flowsProvided?:boolean,
 *          hasMachines?:boolean, uidDiff?:number[]}} opts
 * @returns {{ok:boolean, why:string[]}}
 */
export function strictVerdict(report, { mode, goalShape, flowsProvided, hasMachines, uidDiff } = {}) {
    const why = [];
    if (!report || !Array.isArray(report.checks)) {
        return { ok: false, why: ["report.checks 缺失 —— 没有可裁决的对象（不许把「没有检查」当通过）"] };
    }
    if (report.error) {
        why.push(`verifyRuntime 返回 error：${report.error.code || "?"} ${report.error.message || ""}`.trim());
    }
    const byName = new Map(report.checks.map(c => [c && c.name, c]));
    const get = n => byName.get(n) || null;

    /* 1. L0：观测可信（截断/读失败时，下面每一条都不可信） */
    const l0 = get("L0-observation");
    if (!l0) why.push("L0-observation 缺失 —— 看不到完整世界，任何落地判据都不成立");
    else if (l0.undecidable === true) why.push(`L0-observation 不可判定（${l0.reason || "被截断"}）`);
    else if (l0.ok !== true) why.push(`L0-observation 未通过（${l0.reason || "ok=false"}）`);

    /* 2. L1：计划声称贴的东西真的在世界上 */
    const l1 = get("L1-landing");
    if (!l1) why.push("L1-landing 缺失 —— 没有任何落地证据");
    else if (l1.undecidable === true) why.push(`L1-landing 不可判定（${l1.reason || ""}）`);
    else if (l1.ok !== true) why.push(`L1-landing 未通过（${l1.reason || "ok=false"}）`);

    /* 3. L2：计划含机器时不得 skipped；不可判定即红 */
    const l2 = get("L2-slots");
    if (!l2) {
        if (hasMachines !== false) why.push("L2-slots 缺失 —— 无法判断机器是否被喂/有无去处");
    } else if (l2.undecidable === true) {
        why.push(`L2-slots 不可判定（${l2.reason || ""}）`);
    } else if (l2.skipped === true) {
        if (hasMachines !== false) {
            why.push("L2-slots skipped，但无法确认计划里没有机器（hasMachines 未声明 false）—— 不许把 skipped 当绿");
        }
    } else if (l2.ok !== true) {
        why.push(`L2-slots 未通过（${l2.reason || "ok=false"}）`);
    }

    /* 4. L3：必须给显式 flows；degraded 一律红（那是有边界的绿，不是验证过） */
    const l3 = get("L3-flow");
    if (flowsProvided !== true) {
        why.push("L3 未提供显式 flows（FLOW_UNVERIFIED）—— 降级检查不能当连通已验证");
    }
    if (!l3) why.push("L3-flow 缺失 —— 没有连通性证据");
    else if (l3.degraded === true) why.push(`L3-flow 降级（${l3.reason || "degraded"}）—— 只覆盖计划附近，不能当通过`);
    else if (l3.undecidable === true) why.push(`L3-flow 不可判定（${l3.reason || ""}）`);
    else if (l3.ok !== true) why.push(`L3-flow 未通过（${l3.reason || "ok=false"}）`);

    /* 5. L4：live 必须有真实交付增量；读不到 hub 计数即红 */
    const l4 = get("L4-behavior");
    if (mode === "live") {
        if (!l4) why.push("L4-behavior 缺失 —— live 模式必须有行为证据（goal 推进）");
        else if (l4.skipped === true) why.push("L4-behavior skipped —— live 模式不许跳过行为检查");
        else if (l4.undecidable === true) why.push(`L4-behavior 不可判定（${l4.reason || ""}）`);
        else {
            const ev = l4.evidence || {};
            /* ★ 跨关：`goal_delivered_delta` 合法地为 null ★
             *
             * `delivered` 是**当前关卡**的计数，升级会归零。若 step 窗口跨过关口，
             * `goalAfter - goalBefore` 会是个大负数，毫无意义 —— 所以
             * `checkBehavior` 在跨关时把它记为 **null**（「读到了但不可比」），
             * 判据改用 hub 的**累计**账本 `target_stored_*`（升级不清零）。
             *
             * 这一条不修的话：`checkBehavior` 判绿、`strictVerdict` 却因为
             * 「delta 为 null」判红 —— 又一次在真正成功的那一刻把成功读成失败。 */
            const crossed = ev.level_changed === true
                || (ev.level_before !== null && ev.level_after !== null && ev.level_before !== ev.level_after);
            const storedDelta = ev.target_stored_delta;
            const storedOk = typeof storedDelta === "number" && storedDelta > 0;

            /* 读不到 before/after 才是真的「没有证据」。delta 为 null 但两端
               delivered 都读到了 ⇒ 那是跨关，不是读失败。 */
            const readFailed = ev.goal_delivered_before === null || ev.goal_delivered_after === null
                || ev.goal_delivered_before === undefined || ev.goal_delivered_after === undefined;

            if (readFailed && !storedOk) {
                /* v2 §2.1：读不到权威计数时**不许假设它涨了**。
                   注意这里比 v2 原文更严：原文允许「或 delivered_in_window_after>0」兜底，
                   但那条分支在 hub 读不到时恰好最可疑（窗口求和分不清是本次还是旧线的存量），
                   所以 null 一律红。
                   例外：hub 累计账本确实涨了 ⇒ 那才是真权威，放行。 */
                why.push("L4-behavior 的 goal_delivered_* 为 null —— 读不到 hub 权威计数，不能假设关卡推进了");
            } else if (l4.ok !== true) {
                why.push(`L4-behavior 未通过（${l4.reason || "ok=false"}）`);
            } else if (crossed) {
                /* 跨关：只认 hub 累计账本。delivered 归零是**正常**的，不能当证据。 */
                if (!storedOk) {
                    why.push(`L4-behavior 跨关（${ev.level_before}→${ev.level_after}）但 hub.stored_shapes 没有增长`
                        + `（${ev.target_stored_before}→${ev.target_stored_after}）—— 升级不是交付的证据`);
                }
            } else {
                const delta = ev.goal_delivered_delta;
                const window = ev.delivered_in_window_after;
                const advanced = (typeof delta === "number" && delta > 0)
                    || (typeof window === "number" && window > 0)
                    || storedOk;
                if (!advanced) {
                    why.push("L4-behavior：goal_delivered_delta、delivered_in_window_after 与 target_stored_delta 都为 0 —— 关卡没有推进");
                }
            }
            if (goalShape && ev.shape && ev.shape !== goalShape) {
                why.push(`L4-behavior 测的形状是 "${ev.shape}"，不是目标 "${goalShape}" —— 测错了对象`);
            }
        }
    } else if (l4 && l4.skipped !== true && l4.ok !== true) {
        /* 非 live：允许 skipped（离线没有产线），但**不允许**「跑了且失败」被忽略 */
        why.push(`L4-behavior 未通过（${l4.reason || "ok=false"}）`);
    }

    /* 6. 任何 undecidable 都是红（不能把「没看见」读成「没问题」） */
    for (const c of report.checks) {
        if (c && c.undecidable === true && !why.some(w => w.startsWith(`${c.name}`))) {
            why.push(`${c.name} 不可判定（${c.reason || ""}）`);
        }
    }

    /* 7. 未声明销毁：硬失败（由调用方算好传进来，或由 verifyRound 放在 report.uidDiff） */
    const undeclared = Array.isArray(uidDiff) ? uidDiff
        : (Array.isArray(report.uidDiff) ? report.uidDiff
            : (report.uidDiff && Array.isArray(report.uidDiff.undeclared) ? report.uidDiff.undeclared : null));
    if (undeclared && undeclared.length) {
        why.push(`UNDECLARED_DESTRUCTION：${undeclared.length} 个实体消失了且不在 destroys 里（${undeclared.slice(0, 8).join(", ")}）`);
    }

    /* 8. ★ 部分执行：**不是成功** ★（2026-11-02，partial 模式）
     *
     * `buildTxPlan(..., {partial:true})` 会跳过失败的/不可撤销的调用，只提交一个子集。
     * 那个子集本身可能全绿 —— L1/L2/L3/L4 都在验它，而它确实做成了。
     *
     * **但「计划的一部分做成了」不等于「计划达成了」。**
     *
     * 红队（`REDTEAM-PARTIAL-APPLY.md`）用真实样本证明过：模型说的第一件事
     *（「喂 cutter，把产出送进 hub」）从未执行，而 L1/L2/V-obs-flow 全绿。
     * 只要 hub 在收货，`phaseTwoVerdict` 就会给 `achieved: true`。
     *
     * ## 判据从哪来
     *
     * 从 `report.partial` / `report.skipped` 读（由 `runLoop` 从 `buildTxPlan` 的返回值
     * 传进 `verifyRuntime` 的输入）。不新增参数 —— 那样会改签名、影响所有调用点。
     *
     * ## ⚠️ 这一条**绝不能**带 `skipped: true`
     *
     * 红队实测（`holes.mjs`）：
     *   · `{name:"P-partial", ok:false}`                → strict.ok=false, achieved=false ✔
     *   · `{name:"P-partial", ok:false, skipped:true}`  → strict.ok=true,  achieved=true  ✗
     *
     * 因为 `classifyChecks`（`offline_boundary.mjs:63`）第一句就是
     * `if (c.skipped) continue;`。本项目所有「有意跳过」的 check 都带 skipped:true，
     * 实现者照抄邻居就会踩中。
     *
     * 这里**不加到 report.checks**，直接进 `why` —— 绕开 `classifyChecks` 的
     * skipped 过滤，也就绕开了那个坑。 */
    if (report.partial === true) {
        const sk = Array.isArray(report.skipped) ? report.skipped : [];
        const detail = sk.length
            ? `：${sk.slice(0, 4).map(s => `${s.macro}(${s.reason})`).join(", ")}${sk.length > 4 ? ` 等 ${sk.length} 条` : ""}`
            : "";
        why.push(`PARTIAL_APPLY：计划没有完整执行，${sk.length} 个调用被跳过${detail}`
            + ` —— 做成了子集不等于达成了计划`);
    }

    return { ok: why.length === 0, why };
}

/* ══════════════════════════ 端点解析（token / uid / cell → uid） ══════════════════════════ */

function resolveUid(ep, uidMap) {
    if (isInt(ep)) return ep;
    if (typeof ep === "string") {
        const v = uidMap ? uidMap[ep] : undefined;
        return isInt(v) ? v : null;
    }
    if (ep && typeof ep === "object") {
        if (isInt(ep.uid)) return ep.uid;
        if (typeof ep.token === "string" && uidMap && isInt(uidMap[ep.token])) return uidMap[ep.token];
    }
    return null;
}

/* ══════════════════════════ verifyRound ══════════════════════════ */

/**
 * 一轮的验证：读 after obs（**与 before 同一取数口径**）、跑 `verifyRuntime`、裁决 apply/uidDiff/strict。
 *
 * @param {object} p
 * @param {object} p.reader              {obs, debugItems, production, step}（真桥或 FakeGame）
 * @param {object} p.txPlan              planToTxOps 的返回
 * @param {Record<string,number>|Map} [p.uidMap]  token → tx 分配的真 uid
 * @param {object} p.beforeObs           apply 之前的完整 obs（用于 undeclaredDestruction）
 * @param {"live"|"mock"|"replay"} p.mode
 * @param {string} [p.goalShape]
 * @param {Array<{from,to,via_slot?}>} [p.flows]  planToTxOps 派生的 flows（端点可为 token）
 * @param {object} [p.tx]                本轮的 tx 返回（给了才裁决 apply；apply 阶段在 loop 里是前一步）
 * @param {{ticks?:number,minPerSec?:number}|false} [p.behavior] live 下的步进参数；false = 不跑 L4
 * @returns {Promise<{ok:boolean, checks:Array, strict:{ok:boolean,why:string[]},
 *                    apply:null|{ok:boolean,hardStop:boolean,why:string[]},
 *                    uidDiff:number[], evidence:object}>}
 */
export async function verifyRound({
    reader, txPlan, uidMap, beforeObs, mode, goalShape, flows, tx, behavior,
}) {
    const uidMapObj = uidMap instanceof Map ? Object.fromEntries(uidMap) : (uidMap || {});
    const evidence = {
        mode: mode || null,
        goal_shape: goalShape || null,
        before_hash: beforeObs ? worldUidSetHash(beforeObs) : null,
        after_hash: null,
        flows: Array.isArray(flows) ? flows.length : 0,
        uid_map: { ...uidMapObj },
    };
    const fail = (why) => ({
        ok: false,
        checks: [],
        strict: { ok: false, why },
        apply: null,
        uidDiff: [],
        evidence,
    });
    if (!txPlan || !Array.isArray(txPlan.placements) || !Array.isArray(txPlan.removes)) {
        return fail(["txPlan 形状不对：需要 {placements[], removes[]}（planToTxOps 的返回）"]);
    }
    if (!reader) return fail(["verifyRound 缺 reader —— 没有读取面就没有验证"]);
    if (!beforeObs) return fail(["缺 beforeObs —— 既算不出 undeclaredDestruction，也无法对账 world_hash"]);

    /* ── 计划：token → 真 uid；removes 原样（planToTxOps 已按 obs 填好 expect） ── */
    const placements = txPlan.placements.map(p => {
        const uid = p.token ? resolveUid(p.token, uidMapObj) : (isInt(p.uid) ? p.uid : null);
        return {
            uid: isInt(uid) ? uid : null,
            kind: p.kind, variant: p.variant || "default",
            x: p.x, y: p.y,
            rot: isInt(p.rot) ? p.rot : 0,
            rv: isInt(p.rv) ? p.rv : null,
            code: p.code === undefined ? null : p.code,
        };
    });
    const plan = { placements, removes: txPlan.removes, flows: null };

    /* ── flows 解析：端点可以是 uid（int）、token（string）或 {uid}/{token}/{cell} ── */
    const declaredFlows = Array.isArray(flows) ? flows : (Array.isArray(txPlan.flows) ? txPlan.flows : []);
    const resolvedFlows = [];
    const unresolvedFlows = [];
    for (const f of declaredFlows) {
        const from = resolveUid(f && (f.from !== undefined ? f.from : f.from_token), uidMapObj);
        const to = resolveUid(f && (f.to !== undefined ? f.to : f.to_token), uidMapObj);
        if (from === null || to === null) { unresolvedFlows.push(f); continue; }
        /* 自环在这里再拦一次：L3 的 reach() 从 from 起手，from===to 恒绿。 */
        if (from === to) { unresolvedFlows.push({ ...f, why: "from===to（自环，禁止）" }); continue; }
        resolvedFlows.push({ from, to, ...(f.via_slot ? { via_slot: f.via_slot } : {}) });
    }
    evidence.flows_resolved = resolvedFlows.length;
    evidence.flows_unresolved = unresolvedFlows.length;

    /* ── L4 只在 live 下自动请求（strictVerdict 会因此判红，不能静默跳过） ── */
    const wantBehavior = behavior === false ? null
        : (behavior && typeof behavior === "object" ? { shape: goalShape, ticks: behavior.ticks === undefined ? 2400 : behavior.ticks, minPerSec: behavior.minPerSec || 0 }
            : (mode === "live" ? { shape: goalShape, ticks: 2400, minPerSec: 0 } : null));

    let report;
    try {
        report = await verifyRuntime(plan, {
            reader,
            flows: resolvedFlows,
            ...(wantBehavior ? { behavior: wantBehavior } : {}),
            /* 选项里的 flows 必须与 strict 的 flowsProvided 同源：这里一律传（可能为空数组）。
               空数组时 checkFlow 会走「无显式 flows」的降级分支 → degraded=true → strict 红。
               这正是想要的行为：没有 flows 不允许「跳过」。 */
        });
    } catch (e) {
        return fail([`verifyRuntime 抛异常：${e && e.message ? e.message : String(e)}`]);
    }

    /* ── after obs：**与 before 同一组 params**。live 的 obs 是 region 过滤的，
       两份 obs 取数口径不同会让差集出现假消失（v2 §2.4 的边界）。 ── */
    let afterObs = null;
    try {
        /* ★ 参数必须与 loop 的首轮 observe 完全一致 ★
         *
         * 第二轮验收审计（B-1）发现 loop 的主 obs 没要 resources，导致
         * `pickBeltsForGoal` 的原料线判据失效、冷启动 prompt 里一条正解带子都不出现。
         * 修的时候把这里也一起对齐 —— 两处 obs 口径不同会让「首轮看到的」与
         * 「verify 时看到的」不是同一个世界视图，排查时会白白绕路。
         * verify 本身不读 resources，但口径一致的成本是零。 */
        afterObs = await reader.obs({
            layer: "all", max_entities: 50000, include_stats: true,
            include_resources: true, max_resources: 20000,
        });
    } catch (e) {
        afterObs = null;
        evidence.after_obs_error = String(e && e.message ? e.message : e);
    }

    const uidDiff = afterObs
        ? undeclaredDestruction(beforeObs, afterObs, txPlan.destroys || [])
        : [];
    if (afterObs) evidence.after_hash = worldUidSetHash(afterObs);

    /* ── 额外判据（verifyRuntime 不管的两件事） ── */
    const checks = Array.isArray(report.checks) ? report.checks.slice() : [];
    if (!afterObs) {
        checks.push({
            name: "V-after-obs", ok: false, undecidable: true,
            reason: "apply 之后读不到 obs —— 无法算「谁消失了」", evidence: {},
        });
    } else {
        checks.push({
            name: "V-undeclared-destruction",
            ok: uidDiff.length === 0,
            reason: uidDiff.length
                ? `${uidDiff.length} 个实体的消失不在 destroys 里（${uidDiff.slice(0, 8).join(", ")}）—— 硬停`
                : null,
            evidence: { undeclared: uidDiff, declared: (txPlan.destroys || []).length },
        });
    }

    /* obs 版连通性：不依赖 debug_items（>40 条 path 时 checkFlow 永久 undecidable），
       用「从 from 沿 beltExit 走到 to」这一条独立证据。它验不了「机器输出 → 下游」之外的东西，
       所以只在 flows 解析成功时给出，且**不能**替代 L3（L3 若红，strict 仍红）。 */
    if (afterObs && resolvedFlows.length) {
        const misses = [];
        for (const f of resolvedFlows) {
            const r = obsReach(f.from, afterObs);
            if (r.missing) { misses.push({ flow: f, why: "from 不在世界（uid 过期）" }); continue; }
            if (!r.seen.has(f.to)) misses.push({ flow: f, why: "沿带子链走不到 to", trail: r.trail });
        }
        checks.push({
            name: "V-obs-flow", ok: misses.length === 0,
            reason: misses.length ? `${misses.length}/${resolvedFlows.length} 条 flow 在 obs 里走不通（首条 ${JSON.stringify(misses[0].flow)}）` : null,
            evidence: { flows: resolvedFlows.length, missed: misses.length, sample: misses.slice(0, 3) },
        });
    } else if (unresolvedFlows.length) {
        checks.push({
            name: "V-obs-flow", ok: false, undecidable: true,
            reason: `${unresolvedFlows.length} 条 flow 的端点解析不到真 uid —— uidMap 缺 token`,
            evidence: { sample: unresolvedFlows.slice(0, 3) },
        });
    }

    const apply = tx ? applyVerdict(tx, { requestedOps: Array.isArray(txPlan.ops) ? txPlan.ops.length : undefined }) : null;
    if (apply) {
        checks.push({
            name: "A-tx", ok: apply.ok,
            reason: apply.why.length ? apply.why.join(" / ") : null,
            hardStop: apply.hardStop,
            evidence: { applied: tx.applied, requested: tx.requested, rolled_back: !!tx.rolled_back },
        });
    }

    /* ── V-health：**这次改动有没有把世界改坏** ──
     *
     * ## 为什么必须有这一层
     *
     * 用户贴图那次（2026-11-03）的复盘数据：`replace_run` 一路 `applied 5/5`、
     * L1-landing 绿、A-tx 绿，而**到 hub 的带子从 140 掉到 133、死带子从 23 涨到 27**。
     * 也就是说：整个验证体系在说「一切正常」，同时世界在变糟。
     *
     * 根因是**每一层都在验「计划是否按请求落盘」，没有一层验「落盘之后世界是否更差」**：
     *   · L1-landing —— 我要放的格子真的有我要的东西吗（落盘正确性）
     *   · L2-slots   —— 我点名的槽有运行时证据吗
     *   · L3-flow    —— 我声明的 flow 走得通吗（**只管我声明的那几条**）
     *   · L4-behavior—— 关卡的交付涨了吗（只管一个数）
     *
     * 于是「在我的视角里全对，在世界的视角里更糟」是一个**结构上允许**的结果。
     * 这一层补的就是那个视角差：它不看计划，只看 before/after 两份世界的连通性。
     *
     * ## 判据（保守：只报「更差」，不奖励「更好」）
     *
     * `regressive` 才红。`cleanup` / `constructive` / `churn` / `inert` 都绿 ——
     * 因为在没有交付的一轮里，「清理死带子」和「加了东西」都是合理的中间状态，
     * 判红会让 loop 把正确的小步也回退掉。**只有确实变差才拦。**
     *
     * 与 `strictVerdict` 的关系：它进 `checks`，因此会参与 `strict` 的整体判定，
     * 但不是 `hardStop`（那会立刻终止 run）。一次改坏了应该让 loop 有机会在下一轮
     * 自己修回来，而不是当场崩掉 —— 它现在有 `## LAST STEP` 那段提示来知道自己改坏了。
     */
    let healthEffect = null;
    if (afterObs && beforeObs) {
        try {
            const hb = worldHealth({ obs: beforeObs, items: null, production: null });
            const ha = worldHealth({ obs: afterObs, items: null, production: null });
            const hd = healthDelta(hb, ha);
            healthEffect = classifyNetEffect(hb, ha, hd);
            checks.push({
                name: "V-health",
                ok: healthEffect.kind !== "regressive",
                reason: healthEffect.kind === "regressive"
                    ? `这次改动把世界改坏了：${healthEffect.why.join("；")}`
                    : null,
                evidence: {
                    kind: healthEffect.kind,
                    why: healthEffect.why,
                    belts_reaching_hub_before: hb.belts_reaching_hub,
                    belts_reaching_hub_after: ha.belts_reaching_hub,
                    belts_dead_before: hb.belts_dead,
                    belts_dead_after: ha.belts_dead,
                },
            });
        } catch (e) {
            /* 算不出来就**不判**（不伪造绿）。与 ITEMS_UNAVAILABLE 同一纪律：
               「没算出来」不许长得像「没问题」。 */
            checks.push({
                name: "V-health", ok: false, undecidable: true,
                reason: `算不出世界健康度：${e && e.message ? e.message : e}`,
                evidence: {},
            });
        }
    } else {
        checks.push({
            name: "V-health", ok: false, undecidable: true,
            reason: "缺少 before/after 世界快照 —— 无法判断改动是否让世界变差",
            evidence: {},
        });
    }

    const hasMachines = placements.some(p => !BELT_KINDS.has(p.kind));
    const hasPlacements = placements.length > 0;
    /* 纯删除轮：L1 能验「声明的删除真的发生了」，但 L3 必然不可判定（verifyRuntime 只在有
       placements 时读 debug_items）。这不是缺陷，是诚实：拆完的那一轮本来就没有可验的货流。 */
    const strict = strictVerdict(
        {
            ...report, checks, uidDiff,
            /* ★ 2026-11-02：把 partial 透传给 strictVerdict ★
             *
             * `txPlan.partial` 由 `buildTxPlan(..., {partial:true})` 设置
             * （`loop.mjs` 的 ③b 段）。这里是它到达判据层的唯一通道。
             *
             * **不传的后果**：部分执行会被判成完全成功。
             * 红队 `REDTEAM-PARTIAL-APPLY.md` 用真实样本证明过 ——
             * 模型说的第一件事（喂 cutter）从未执行，而 L1/L2/V-obs-flow 全绿，
             * `phaseTwoVerdict` 照样给 `achieved: true`。
             *
             * ⚠️ `partial` 为 false 时这两个字段是 `false` / `[]`，
             * 与「没有 partial」等价 —— 现有 345 条测试不受影响。 */
            partial: txPlan.partial === true,
            skipped: Array.isArray(txPlan.skipped) ? txPlan.skipped : [],
        },
        {
            mode,
            goalShape,
            flowsProvided: resolvedFlows.length > 0,
            hasMachines: hasPlacements ? hasMachines : false,
            uidDiff,
        },
    );

    const ok = strict.ok && uidDiff.length === 0 && (!apply || apply.ok);
    evidence.has_machines = hasMachines;
    evidence.has_placements = hasPlacements;
    evidence.checks_ok = checks.filter(c => c.ok && !c.skipped).length;
    evidence.checks_failed = checks.filter(c => !c.ok && !c.skipped).map(c => c.name);

    return { ok, checks, strict, apply, uidDiff, evidence };
}

export default verifyRound;
