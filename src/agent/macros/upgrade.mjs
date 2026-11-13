/**
 * upgrade.mjs — 宏：**花 hub 里存着的形状，买一档全局升级**。
 *
 * ═════════════════════════ 为什么这是一个宏，而不是「顺便调用一下」═════════════════════════
 *
 * 另外七个宏都在改**拓扑**：多一条带子、少一台机器。而玩家真实的效率提升
 * 从来不只是「再多接一条线」—— 是**同样的线跑得更快**。游戏里那是四条升级链
 * （`belt` / `miner` / `processors` / `painting`），每条最高 ×2，靠 hub 里存着的形状去买。
 *
 * 实测（2026-11-13，level 9 实机）：
 *
 *     belt        L1  can_buy=false   下一档需 CuCuCuCu×75 + --CuCu--×500
 *     miner       L1  can_buy=true    下一档需 RuRuRuRu×740 + Cu------×800      ← 买得起
 *     processors  L0  can_buy=false   下一档需 SuSuSuSu×500
 *     painting    L0  can_buy=true    下一档需 RbRb----×600                     ← 买得起
 *
 * 而 hub 里存着 RuRuRuRu×15583、Cu------×34332、RbRb----×7219。
 * **两档白送的升级躺在那里没人拿**，模型连它们存在都不知道：
 * `prompt.mjs` 里 `canBuyUpgrade = false` 是写死的，注释说
 * 「等 `upgrade` 宏真的接进 loop 的执行面，这里再打开」。这个文件就是那次打开。
 *
 * ═════════════════════════ 它不走 tx ═════════════════════════
 *
 * `place` / `delete` 类宏的产物是 op 列表，经 tx 落盘、经 verify 对账。
 * 升级**不增删任何实体**，没有任何 op 可以生成 —— 它走 mod 的顶层 RPC
 * `upgrade{id}`（`shapez-ai-bridge.js:1187` 的 `upgrades(params)`）。
 *
 * 这条通道本身是完整且带对账的：返回 `before` / `after` / `spent`，
 * 调用方不必再发一次 obs 去猜「到底买成功没有」。
 * 所以这个宏的实现只有一件事要做：**把我们这边的语义映射到那条通道上**，
 * 并把「买不起」和「买不了（满级）」这两个不同的事实分开报告 ——
 * 前者是游戏状态（会随生产变化，值得下一轮再试），后者是终局（永远不用再试）。
 *
 * ═════════════════════════ 几何：没有 ═════════════════════════
 *
 * 这个文件里**一行方向逻辑都没有**，因为它没有几何。升级是全局的，
 * 不落到任何格子。契约里也因此没有给它任何坐标类参数（见 `validateUpgradeArgs`）。
 */

import { validateUpgradeArgs, UPGRADE_LINES } from "./contract.mjs";

/** 与 remove.mjs 同形：一套信封，调用方不必按宏分诊。 */
function failure(macro, err, extras = {}) {
    const e = {
        code: err.code,
        field: err.field === undefined ? null : err.field,
        message: err.message,
        hint: err.hint || null,
    };
    if (err.candidates) e.candidates = err.candidates;
    if (err.detail) e.detail = err.detail;
    return {
        ok: false, macro,
        cells_planned: 0, cells_placed: 0,
        first_mismatch: null,
        changed: { added_uids: [], removed_uids: [] },
        warnings: [],
        error: e,
        /* 升级**永不**产生 op —— 这两个字段不是「这次恰好没有」，是结构性的。 */
        ops: [],
        dry_run: true,
        planned_only: true,
        reason: err.message,
        upgrades: null,
        ...extras,
    };
}

const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * 读当前升级状态（不写）。
 *
 * 与购买走同一个 RPC，只是不带 `id`。mod 侧返回四条链的
 * `{level, maxed, multiplier, next:{required}, can_buy}`。
 *
 * @param {object} reader
 * @returns {Promise<{ok:boolean, upgrades?:object, stored?:object, error?:string}>}
 */
export async function readUpgrades(reader) {
    if (!reader || typeof reader.upgrade !== "function") {
        return { ok: false, error: "reader 没有 upgrade 通道（真桥上它是顶层 RPC，不是 act/tx）" };
    }
    try {
        const r = await reader.upgrade({});
        if (!r || r.ok !== true) return { ok: false, error: (r && r.error && r.error.message) || "upgrade 读失败" };
        return { ok: true, upgrades: r.upgrades || {}, stored: r.stored || {} };
    } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
    }
}

/**
 * 「现在能买哪几档」。供 `prompt.mjs` 的 `canBuyUpgrade` 打开后调用。
 *
 * 返回的每一项都是**可以立刻执行**的（`can_buy === true`），
 * 而不是「离能买还差多少」—— 后者不需要模型，那是 `CAPACITY` 段的事。
 *
 * @param {object} reader
 * @returns {Promise<Array<{id:string, level:number, multiplier:number|null, required:Array}>>}
 */
export async function affordableUpgrades(reader) {
    const s = await readUpgrades(reader);
    if (!s.ok) return [];
    const out = [];
    for (const id of UPGRADE_LINES) {
        const u = s.upgrades[id];
        if (!u || u.can_buy !== true || u.maxed === true) continue;
        out.push({
            id,
            level: u.level,
            multiplier: Number.isFinite(u.multiplier) ? u.multiplier : null,
            required: (u.next && Array.isArray(u.next.required)) ? u.next.required : [],
        });
    }
    return out;
}

/**
 * 宏入口：买一档升级。
 *
 * @param {object} args 契约形态 `{id, opts?}`（也可能是 `{macro:"upgrade", args:{...}}`）
 * @param {object} [ctx] `{reader}`；`reader.upgrade` 是唯一的写面
 * @returns {Promise<object>} MacroResult 信封（形状与其余七个宏一致）
 */
export async function upgradeUpgradeLine(a, ctx = {}) {
    /* 允许 `upgrade(args, ctx)` 与 `upgrade({args, ctx})` 两种调法 ——
       与 remove.mjs 的 `ctxOf` 保持同一约定，调用方不必记「哪个宏是哪种」。 */
    let args = a, c = ctx;
    if (isObj(a) && a.args !== undefined && a.reader === undefined && a.ctx === undefined) {
        args = a.args; c = a.ctx || a;
    }

    const v = validateUpgradeArgs(args);
    if (!v.ok) return failure("upgrade", v.error);
    const { id, opts } = v.value;

    const reader = c && c.reader;
    if (!reader || typeof reader.upgrade !== "function") {
        return failure("upgrade", {
            code: "tx_unavailable", field: null,
            message: "没有 upgrade 通道可用",
            hint: "升级不走 tx：它需要 reader.upgrade（真桥上的顶层 RPC `upgrade`）。"
                + "离线计划态无法买到升级 —— 这不是失败，是这类动作没有离线形态。",
        });
    }

    const dry = opts.dry_run === true;

    /* ── 先读一次：把「满级」「买不起」这两个不同事实分开 ──
     *
     * 都为 false 才去买。这不是防御性编程，是**语义**：
     *   · maxed        ⇒ 终局，再试一百次也不会变，值得明确告诉模型「别再来」；
     *   · !can_buy     ⇒ 库存不够，会随生产变化，下一轮可能就行了。
     * 混成一句「买不了」会让模型在该等的时候放弃、在该放弃的时候重试。 */
    const before = await readUpgrades(reader);
    if (!before.ok) {
        return failure("upgrade", {
            code: "tx_unavailable", field: null,
            message: `读升级状态失败：${before.error}`,
        });
    }
    const cur = before.upgrades[id];
    if (!cur) {
        /* 校验器已经保证 id 在闭集里，走到这里说明 mod 与契约不同步 —— 值得如实报。 */
        return failure("upgrade", {
            code: "unsupported_building", field: "id",
            message: `mod 里没有 '${id}' 这条升级链（契约认为有 —— mod 与契约不同步）`,
            hint: `mod 报告的链：${Object.keys(before.upgrades).join(", ")}`,
        });
    }

    if (cur.maxed === true) {
        return {
            ok: true, macro: "upgrade",
            cells_planned: 0, cells_placed: 0, first_mismatch: null,
            changed: { added_uids: [], removed_uids: [] },
            warnings: [], error: null, ops: [],
            dry_run: dry, planned_only: true, reason: "already-maxed",
            bought: false, id,
            spent: [],
            before: cur, after: cur,
            upgrades: before.upgrades,
            /* 满级是**终局**，不是可重试的失败。模型需要的是「别再来」这个确定感。 */
            stars: null,
        };
    }

    if (cur.can_buy !== true) {
        return failure("upgrade", {
            code: "game_rejected", field: null,
            message: `买不起 ${id} 的下一档（L${cur.level} → L${cur.level + 1}）`,
            hint: `还差：${(cur.next && cur.next.required || []).map(r => `${r.shape}×${r.amount}`).join(" + ") || "未知"}`
                + `。库存够是游戏状态，会随生产变化 —— 先去看 CAPACITY 段该增产什么，不要在同一轮重试。`,
            ...{ upgrades: before.upgrades },
        });
    }

    if (dry) {
        const req = (cur.next && cur.next.required) || [];
        return {
            ok: true, macro: "upgrade",
            cells_planned: 0, cells_placed: 0, first_mismatch: null,
            changed: { added_uids: [], removed_uids: [] },
            warnings: [], error: null, ops: [],
            dry_run: true, planned_only: true, reason: null,
            bought: false, id,
            spent: [], would_spend: req,
            before: cur, after: cur,
            upgrades: before.upgrades,
        };
    }

    /* ── 真买 ── */
    let res;
    try {
        res = await reader.upgrade({ id });
    } catch (e) {
        return failure("upgrade", {
            code: "game_rejected", field: null,
            message: `upgrade RPC 抛异常：${String(e && e.message ? e.message : e)}`,
        });
    }
    if (!res || res.ok !== true) {
        const msg = (res && res.error && res.error.message) || "upgrade RPC 返回 ok!=true";
        return failure("upgrade", {
            code: "game_rejected", field: null,
            message: `买 ${id} 失败：${msg}`,
            hint: (res && res.error && res.error.hint) || null,
        });
    }

    /* `bought:false` 且不是 maxed —— 游戏状态在两次读之间变了。
       这不是我们的失败，但必须如实报告，不能当成成功。 */
    if (res.bought !== true) {
        return failure("upgrade", {
            code: "game_rejected", field: null,
            message: `游戏拒绝购买 ${id}（状态在读取与购买之间变了）`,
            hint: "同一 tick 内重试无意义；下一轮重新读状态再决定。",
        });
    }

    return {
        ok: true, macro: "upgrade",
        /* 升级不改拓扑 ⇒ 计划写入 0 格、落地 0 格。这不是「什么都没做」，
           而是「它的效果不在格子这一维上」。 */
        cells_planned: 0, cells_placed: 0, first_mismatch: null,
        changed: { added_uids: [], removed_uids: [] },
        warnings: [], error: null, ops: [],
        dry_run: false, planned_only: false, reason: null,
        bought: true, id,
        spent: Array.isArray(res.spent) ? res.spent : [],
        before: res.before || cur,
        after: res.after || null,
        upgrades: before.upgrades,
    };
}

export const MACRO_IMPLS = Object.freeze({
    upgrade: upgradeUpgradeLine,
});
