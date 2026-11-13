/**
 * upgrade.test.mjs — `upgrade` 宏的守卫。
 *
 * 这个宏和另外七个不一样：它**不产生任何 op**，不走 tx，效果不在格子这一维上。
 * 所以常规的那些判据（L1-landing / cells_planned）对它全是恒真的，
 * 必须另立一套：花钱对不对、买不起怎么报、满级怎么报、拼错怎么拒。
 *
 * 用法：node --test src/agent/macros/upgrade.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { upgradeUpgradeLine, affordableUpgrades, readUpgrades } from "./upgrade.mjs";
import { MACRO_NAMES, MACRO_VALIDATORS, ERROR_CODES, validateMacroCall } from "./contract.mjs";

const eq = (a, b, m) => assert.deepEqual(a, b, m);
const ok = (v, m) => assert.ok(v, m);

/**
 * 假 reader：模拟 mod 的 `upgrades(params)` 语义。
 * 库存与档位都可配，`bought` 之后状态真的会变（否则测不出「买完就不该再买」）。
 */
function fakeReader(cfg) {
    const state = {
        levels: { ...(cfg.levels || { belt: 1, miner: 1, processors: 0, painting: 0 }) },
        stored: { ...(cfg.stored || {}) },
        calls: [],
    };
    const TIERS = cfg.tiers || {
        belt: [{ required: [{ shape: "CuCuCuCu", amount: 30 }] }, { required: [{ shape: "CuCuCuCu", amount: 75 }] }],
        miner: [{ required: [{ shape: "RuRuRuRu", amount: 300 }] }, { required: [{ shape: "RuRuRuRu", amount: 740 }, { shape: "Cu------", amount: 800 }] }],
        processors: [{ required: [{ shape: "SuSuSuSu", amount: 500 }] }],
        painting: [{ required: [{ shape: "RbRb----", amount: 600 }] }],
    };
    const snap = () => {
        const out = {};
        for (const id of Object.keys(TIERS)) {
            const lvl = state.levels[id] || 0;
            const next = TIERS[id][lvl] || null;
            out[id] = {
                level: lvl, maxed: !next,
                multiplier: 1,
                next: next ? { required: next.required } : null,
                can_buy: !!next && next.required.every(r => (state.stored[r.shape] || 0) >= r.amount),
            };
        }
        return out;
    };
    return {
        state,
        async upgrade(p = {}) {
            state.calls.push(p);
            if (p.id === undefined) return { ok: true, op: "upgrade", upgrades: snap(), stored: { ...state.stored } };
            const cur = snap()[p.id];
            if (!cur) { const e = new Error(`unknown upgrade id: ${p.id}`); e.rpc = { message: e.message }; throw e; }
            if (cur.maxed) return { ok: true, bought: false, reason: "already-maxed", before: cur, after: cur };
            if (!cur.can_buy) { const e = new Error(`cannot afford ${p.id}`); e.rpc = { message: e.message }; throw e; }
            if (p.dry_run === true) return { ok: true, dry_run: true, would_buy: true, would_spend: cur.next.required, before: cur };
            for (const r of cur.next.required) state.stored[r.shape] -= r.amount;
            state.levels[p.id] = cur.level + 1;
            return { ok: true, bought: true, spent: cur.next.required, before: cur, after: snap()[p.id] };
        },
    };
}

/* ═══════════════ 1. 注册与契约 ═══════════════ */

test("U1 upgrade 在 MACRO_NAMES 与 MACRO_VALIDATORS 里（少一个就是实机 2001）", () => {
    ok(MACRO_NAMES.includes("upgrade"), "MACRO_NAMES 里有 upgrade");
    ok(typeof MACRO_VALIDATORS.upgrade === "function", "MACRO_VALIDATORS 里有 upgrade");
});

test("U2 拼错链名必须被拒，且 hint 列出四条合法值（不能猜）", () => {
    for (const bad of ["speed", "rotator", "painter", "belt2", "Processors", ""]) {
        const v = validateMacroCall("upgrade", { id: bad });
        eq(v.ok, false, `"${bad}" 应被拒`);
        eq(v.error.code, "bad_type", `"${bad}" 的错误码`);
        ok(/belt \| miner \| processors \| painting/.test(v.error.hint), `"${bad}" 的 hint 要列出合法值`);
    }
});

test("U3 四条合法链全部通过校验", () => {
    for (const good of ["belt", "miner", "processors", "painting"]) {
        const v = validateMacroCall("upgrade", { id: good });
        eq(v.ok, true, `${good} 应通过`);
    }
});

test("U4 不接受任何坐标类参数（升级不落到格子上）", () => {
    for (const bad of ["x", "y", "r", "rv", "at", "uids", "cells"]) {
        const v = validateMacroCall("upgrade", { id: "miner", [bad]: 1 });
        eq(v.ok, false, `${bad} 应被拒`);
        eq(v.error.code, "unknown_field", `${bad} 的错误码`);
    }
});

/* ═══════════════ 2. 买得起 / 买不起 / 满级 ═══════════════ */

test("U5 买得起 ⇒ 真买，spent 与库存逐项对账", async () => {
    const r = fakeReader({ stored: { "RuRuRuRu": 1000, "Cu------": 900 } });
    const out = await upgradeUpgradeLine({ id: "miner" }, { reader: r });
    eq(out.ok, true, "应当成功");
    eq(out.bought, true, "bought 必须是 true");
    eq(out.spent, [{ shape: "RuRuRuRu", amount: 740 }, { shape: "Cu------", amount: 800 }]);
    eq(r.state.stored["RuRuRuRu"], 260, "库存真的扣了 740");
    eq(r.state.stored["Cu------"], 100, "库存真的扣了 800");
    eq(r.state.levels.miner, 2, "档位真的涨了一级");
});

test("U6 升级不产生任何 op —— 这是结构性的，不是「这次恰好没有」", async () => {
    const r = fakeReader({ stored: { "RuRuRuRu": 1000, "Cu------": 900 } });
    const out = await upgradeUpgradeLine({ id: "miner" }, { reader: r });
    eq(out.ops, [], "ops 必须是空数组");
    eq(out.cells_planned, 0, "计划写入 0 格");
    eq(out.cells_placed, 0, "落地 0 格");
    eq(out.changed.added_uids, [], "没有新增实体");
    eq(out.changed.removed_uids, [], "没有删除实体");
});

test("U7 买不起 ⇒ game_rejected（不是 precondition_failed），且 hint 说还差什么", async () => {
    const r = fakeReader({ stored: { "RuRuRuRu": 100, "Cu------": 0 } });
    const out = await upgradeUpgradeLine({ id: "miner" }, { reader: r });
    eq(out.ok, false);
    eq(out.error.code, "game_rejected", "买不起必须是 game_rejected —— 它是游戏状态，会变");
    ok(/RuRuRuRu×740/.test(out.error.hint), `hint 要点名差什么，实得：${out.error.hint}`);
    eq(r.state.calls.filter(c => c.id !== undefined).length, 0, "买不起时**不许**发出购买请求");
});

test("U8 满级 ⇒ ok:true + reason:already-maxed（终局，不是错误）", async () => {
    const r = fakeReader({ levels: { painter: 0, belt: 1, miner: 1, processors: 0, painting: 1 },
        stored: { "RbRb----": 99999 }, tiers: {
            belt: [{ required: [] }], miner: [{ required: [] }],
            processors: [{ required: [] }],
            painting: [{ required: [{ shape: "RbRb----", amount: 600 }] }],
        } });
    const out = await upgradeUpgradeLine({ id: "painting" }, { reader: r });
    eq(out.ok, true, "满级是 ok:true —— 它不是失败");
    eq(out.bought, false, "bought 必须是 false");
    eq(out.reason, "already-maxed", "reason 必须说清是满级");
    eq(out.spent, [], "没花钱");
});

test("U9 dry_run 不扣库存，并要求回报 would_spend", async () => {
    const r = fakeReader({ stored: { "RuRuRuRu": 1000, "Cu------": 900 } });
    const out = await upgradeUpgradeLine({ id: "miner", opts: { dry_run: true } }, { reader: r });
    eq(out.ok, true);
    eq(out.bought, false, "dry_run 不许真买");
    eq(out.dry_run, true);
    eq(out.would_spend, [{ shape: "RuRuRuRu", amount: 740 }, { shape: "Cu------", amount: 800 }]);
    eq(r.state.stored.RuRuRuRu, 1000, "dry_run 一个形状都不许扣");
});

test("U10 没有 upgrade 通道 ⇒ tx_unavailable（不是崩）", async () => {
    const out = await upgradeUpgradeLine({ id: "miner" }, { reader: {} });
    eq(out.ok, false);
    eq(out.error.code, "tx_unavailable");
    ok(/顶层 RPC/.test(out.error.hint || ""), "hint 要说清它为什么不走 tx");
});

/* ═══════════════ 3. 给 prompt 用的辅助 ═══════════════ */

test("U11 affordableUpgrades 只返回**买得起**的，且带出 required", async () => {
    const r = fakeReader({
        stored: { "RbRb----": 700, "RuRuRuRu": 10, "Cu------": 10, "SuSuSuSu": 0 },
    });
    const aff = await affordableUpgrades(r);
    eq(aff.map(a => a.id), ["painting"], "只有 painting 买得起");
    eq(aff[0].required, [{ shape: "RbRb----", amount: 600 }]);
});

test("U12 readUpgrades 在 reader 缺失时返回结构化失败，不抛", async () => {
    const s = await readUpgrades(null);
    eq(s.ok, false);
    ok(typeof s.error === "string" && s.error.length > 0);
});

test("U13 game_rejected 在 ERROR_CODES 闭集里（新码必须登记）", () => {
    ok("game_rejected" in ERROR_CODES, "game_rejected 必须是 ERROR_CODES 的成员");
    ok(/库存/.test(ERROR_CODES.game_rejected), "它的说明要提到库存这个会变的事实");
});
