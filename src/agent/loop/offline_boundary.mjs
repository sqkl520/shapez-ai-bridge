/**
 * offline_boundary.mjs — 明确「离线能证明什么、不能证明什么」，并把这条边界钉成可执行断言。
 *
 * 为什么需要这个文件（本次实测的直接产物）：
 *   阶段 2 的 loop 大部分逻辑可以离线跑（FakeGame 提供读取面）。跑通之后最大的诱惑，
 *   是把「离线全绿」读成「阶段 2 达成」。这条边界一旦模糊，整个实验就失去意义 ——
 *   因为判据本来就是「**真实存档**上没人算坐标也能打通」，而离线环境不是真实存档。
 *
 * 实测得到的分层（不是推测，是 `coldstart_l4` 那条链路跑出来的）：
 *
 *   ┌──────────┬────────────────────────────────────────────┬──────────┐
 *   │ 检查     │ 离线（FakeGame）能证明吗                    │ 原因     │
 *   ├──────────┼────────────────────────────────────────────┼──────────┤
 *   │ L0 obs   │ 能（但只证明"读取面没截断"，不证明真实世界） │          │
 *   │ L1 落地  │ 能（实体表被 apply 改了，L1 就是比实体表）   │ 结构等价 │
 *   │ L2 槽位  │ 能（槽位由 op-templates 的几何算出）         │ 结构等价 │
 *   │ L3 流通  │ **不能**                                    │ 见下     │
 *   │ L4 行为  │ **不能**                                    │ 见下     │
 *   │ V-health │ **不能**                                    │ 见下     │
 *   │ tx 原子性│ **不能**                                    │ 见下     │
 *   └──────────┴────────────────────────────────────────────┴──────────┘
 *
 * L3 不能：`debug_items.paths` 是**游戏自己**在带子拓扑变化后重算的（belt 网络的
 *   entityPath / boundAcceptor）。FakeGame 的 `apply()` 只改实体表，**不重建 paths**。
 *   所以离线跑 L3 一定报「货流走不到目的地」——那是 FakeGame 的局限，不是计划的错。
 *
 * L4 不能：`production` 的时间片由游戏主循环推进；FakeGame 的 `step()` 只加 tick。
 *   所以离线 L4 永远是「没产出」。
 *
 * tx 原子性不能：FakeGame 没有快照/回滚；`apply()` 是原地改，失败了也没有"退回去"。
 *
 * **所以：离线跑通 = 决策链走通。它不是阶段 2 达成，也不是"接近达成"。**
 * 本文件把这句话变成 `assertOfflineBoundary()`，任何想用离线结果宣称成功的代码
 * 都必须先过它。
 */

/** 哪些检查项在离线环境下**结构上不可能**真的验证。 */
export const OFFLINE_UNVERIFIABLE = Object.freeze({
    "L3-flow": "debug_items.paths 由游戏在带线拓扑变化后重算；FakeGame.apply 不重建 paths",
    "L4-behavior": "production 时间片由游戏主循环推进；FakeGame.step 只加 tick",
    "tx-atomicity": "FakeGame 无快照/回滚，apply 是原地改",
    /* ★ V-health 为什么也算不可信（2026-11-03 加，实测逼出来的）★
     *
     * `V-health` 的可达率用的是 `flowReachable`（每跳验 `accepts`），它**自己**是
     * 结构等价的 —— 但离线的 `afterObs` 来自 `FakeGame.apply()`，而后者只改实体表、
     * **不做 `runGuarded` 的 immutable 语义回写**（真 tx 里游戏会按邻居重算带子方向）。
     *
     * 实测后果：L4 官方正解（把一条 run 换成 cutter+trash）在离线跑出来是
     * 「到 hub 的带子 140→133」⇒ V-health 判 `regressive` ⇒ `strict` 红 ⇒
     * `OFFLINE_ONLY` 那整条链全部失效（10 条断言一起变红）。
     * 而同一个计划在真机上不一定是变差的。
     *
     * 更根本的理由：**增量施工本身就会让可达率暂时下降**。这套系统只有 7 个局部宏，
     * 「先把旧带子拆掉、下一轮再接新线」是唯一可行的模式。如果每一步都要求
     * 「可达率不许下降」，那就等于禁止一切施工 —— 而这条判据本来是拿来抓
     * 「无谓破坏」的，不是拿来抓「正在施工」的。
     *
     * 所以：离线不判 V-health（记录事实，不构成结论）；真机 live 才判。
     * 靠 `evidence.kind` 与 `timeline.log` 仍然保留了全部信息，没有人失去可见性。 */
    "V-health": "离线 afterObs 来自 FakeGame.apply（不做 immutable 回写）；且增量施工天然会短暂降低可达率",
});

/** 哪些检查项离线可信（结构等价于真机）。 */
export const OFFLINE_VERIFIABLE = Object.freeze({
    "L0-observation": "读的是同一份 obs 结构；但只证明'没截断'，不证明世界真实",
    "L1-landing": "L1 比的就是实体表，FakeGame 的 apply 改的也是实体表",
    "L2-slots": "槽位由 op-templates 的 footprint/槽位几何算出，与游戏无关",
    "V-undeclared-destruction": "两份 obs 的 uid 差集，纯集合运算",
});

/**
 * 判定「这次 verify 的结果里，哪些是可信的绿，哪些是环境造成的红」。
 *
 * @param {{checks:Array<{name:string, ok:boolean, skipped?:boolean, undecidable?:boolean}>}} report
 * @param {{mode:"live"|"mock"|"replay"}} opts
 * @returns {{ok:boolean, trustworthy:Array, untrustworthy:Array, why:string[]}}
 *   `ok` = 这次有没有任何**不可信**的检查被当成结论
 */
export function classifyChecks(report, opts = {}) {
    const mode = opts.mode || "mock";
    const trustworthy = [], untrustworthy = [];
    for (const c of (report && report.checks) || []) {
        if (c.skipped) continue;
        const key = c.name;
        if (mode !== "live" && OFFLINE_UNVERIFIABLE[key]) {
            untrustworthy.push({ name: key, ok: c.ok, reason: OFFLINE_UNVERIFIABLE[key] });
        } else {
            trustworthy.push({ name: key, ok: c.ok });
        }
    }
    const why = [];
    /* 关键：离线环境下，不可信的检查**既不能算通过，也不能算失败** —— 它们是"未验证"。 */
    for (const u of untrustworthy) {
        why.push(`${u.name} 在 mode="${mode}" 下不可信（${u.reason}）—— 它的 ${u.ok ? "绿" : "红"} 都不构成结论`);
    }
    return { ok: untrustworthy.length === 0 || mode === "live", trustworthy, untrustworthy, why };
}

/**
 * 阶段 2 达标判据的**唯一入口**。任何想宣称"阶段 2 达成"的代码/脚本都必须调它。
 *
 * @param {{mode, strict, checks, goalDelta, transcriptSha, runId}} evidence
 * @returns {{achieved:boolean, why:string[], level:"none"|"offline-only"|"live"}}
 */
export function phaseTwoVerdict(evidence) {
    const e = evidence || {};
    const why = [];
    let level = "none";

    const live = e.mode === "live";
    const strictOk = !!(e.strict && e.strict.ok);
    const goalAdvanced = typeof e.goalDelta === "number" && e.goalDelta > 0;
    const cls = classifyChecks({ checks: e.checks || [] }, { mode: e.mode });

    /* ★ 红检查项必须参与判定（验收审计抓到的漏洞）★
     *
     * 以前这里只看 `strict.ok` 和 `classifyChecks`（后者判的是"这条检查在当前离线
     * 环境下可不可信"，**不判它是红是绿**）。于是出现过：
     *   strict.ok === true，但 checks 里有一条 ok:false
     *   → 仍判 level="offline-only"（读起来像"离线跑通了"）
     * 实测复现：`V-obs-flow:false` + `strict.ok:true` → offline-only。
     * 更糟的是 `hardFails` 早就算好了、写进 transcript，却**没参与判决**。
     *
     * 修法：在离线环境下**可信**的检查项里，只要有一条红，就不能说"跑通"。
     * 不可信的（L3/L4/tx）本来就不构成结论，保持原规则。
     */
    const trustedFails = cls.trustworthy.filter(c => c.ok === false).map(c => c.name);
    const anyTrustedFail = trustedFails.length > 0;

    if (strictOk && cls.ok && !anyTrustedFail) {
        if (live && goalAdvanced) {
            level = "live";
        } else if (!live) {
            /* 离线全绿 —— 这是**决策链通过**，不是阶段 2 达成。 */
            level = "offline-only";
            why.push("离线（mode!=live）跑通：证明决策链走通，**不构成阶段 2 达成**");
        } else {
            /* live 但 goal 没推进 —— 最常见的失败形态 */
            why.push(`live 模式但 goal.delivered 没有增加（delta=${e.goalDelta}）—— 产线可能全绿但没交货`);
        }
    } else {
        if (!strictOk) why.push("strictVerdict 未通过：" + ((e.strict && e.strict.why) || []).join("; "));
        if (anyTrustedFail) {
            why.push(`有可信检查项为红，不能算跑通：${trustedFails.join(", ")}`);
        }
        why.push(...cls.why);
    }

    return { achieved: level === "live", why, level };
}

/* ══════════════════════════ 自测 ══════════════════════════ */

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("agent/loop/offline_boundary.mjs");
if (isMain) {
    let pass = 0, fail = 0;
    const t = (name, cond, extra) => {
        if (cond) { pass++; console.log("✓ " + name); }
        else { fail++; console.log("✗ " + name + (extra !== undefined ? "  " + JSON.stringify(extra) : "")); }
    };

    /* ① 离线 + L3 红 ⇒ 不能据此判失败（那是环境造成的） */
    {
        const r = classifyChecks({ checks: [{ name: "L1-landing", ok: true }, { name: "L3-flow", ok: false }] }, { mode: "mock" });
        t("离线时 L3 的失败被归为不可信（不是结论）", r.untrustworthy.some(u => u.name === "L3-flow"));
        t("离线时 L3 存在 ⇒ classifyChecks 不 ok（有未验证项）", r.ok === false);
        t("离线时 L1 仍是可信的", r.trustworthy.some(x => x.name === "L1-landing"));
    }

    /* ② 离线 + L3 绿 ⇒ 同样不可信（不能把环境的绿当通过） */
    {
        const r = classifyChecks({ checks: [{ name: "L3-flow", ok: true }] }, { mode: "mock" });
        t("离线时 L3 的绿也不可信（这是最关键的一条）", r.untrustworthy.some(u => u.name === "L3-flow" && u.ok === true));
        t("离线 L3 绿 ⇒ classifyChecks.ok === false", r.ok === false);
    }

    /* ③ live 时 L3 可信 */
    {
        const r = classifyChecks({ checks: [{ name: "L3-flow", ok: true }] }, { mode: "live" });
        t("live 时 L3 可信", r.trustworthy.some(x => x.name === "L3-flow"));
        t("live + 无不可信项 ⇒ ok", r.ok === true);
    }

    /* ④ phaseTwoVerdict：离线全绿 ≠ 达成 */
    {
        const v = phaseTwoVerdict({
            mode: "mock", strict: { ok: true },
            checks: [{ name: "L0-observation", ok: true }, { name: "L1-landing", ok: true }],
            goalDelta: 0,
        });
        t("离线全绿：level = offline-only（不是 live）", v.level === "offline-only", v.level);
        t("离线全绿：achieved === false —— 这是本文件存在的全部理由", v.achieved === false);
        t("离线全绿：why 里明说「不构成阶段 2 达成」", v.why.some(s => /不构成阶段 2 达成/.test(s)));
    }

    /* ⑤ live 但 goal 没涨 ⇒ 不达成（最常见的假绿形态） */
    {
        const v = phaseTwoVerdict({
            mode: "live", strict: { ok: true },
            checks: [{ name: "L3-flow", ok: true }],
            goalDelta: 0,
        });
        t("live 全绿但 goal 没涨 ⇒ 不达成", v.achieved === false);
        t("live 全绿但 goal 没涨 ⇒ why 指出「没交货」", v.why.some(s => /没有增加|没交货/.test(s)));
    }

    /* ⑥ live + goal 涨 ⇒ 达成 */
    {
        const v = phaseTwoVerdict({
            mode: "live", strict: { ok: true },
            checks: [{ name: "L0-observation", ok: true }, { name: "L1-landing", ok: true }, { name: "L3-flow", ok: true }],
            goalDelta: 12,
        });
        t("live + goal 涨 + 全绿 ⇒ achieved === true", v.achieved === true, v);
        t("live 达成时 level === 'live'", v.level === "live");
    }

    /* ⑦ strict 没过 ⇒ 一律不达成，且离线时不可信项的说明要出现 */
    {
        const v = phaseTwoVerdict({
            mode: "mock", strict: { ok: false, why: ["L2 跳过"] },
            checks: [{ name: "L3-flow", ok: true }, { name: "L4-behavior", ok: true }],
            goalDelta: 0,
        });
        t("strict 没过 ⇒ 不达成", v.achieved === false);
        t("strict 没过时 why 带上 strict 的原因", v.why.some(s => /strictVerdict 未通过/.test(s)));
        t("离线时 L4 的绿也被列为不可信", v.why.some(s => /L4-behavior/.test(s)));
    }

    /* ⑦b ★ 红检查项必须参与判定（验收审计抓到的漏洞）★
     *
     * 实测复现过的漏洞：`strict.ok===true` 但 `checks` 里有一条红时，
     * 旧实现仍判 `level="offline-only"`（读起来像"离线跑通了"）。
     * 因为 `phaseTwoVerdict` 只把 checks 交给 `classifyChecks`，
     * 而后者判的是「这条检查在当前离线环境下可不可信」，**不看它是红是绿**。
     * `hardFails` 早已算好并写进 transcript，却没参与判决 —— 典型的"算了不用"。
     */
    {
        const okCheck = { name: "L1-landing", ok: true };
        const badCheck = { name: "V-obs-flow", ok: false };   // 离线**可信**的项

        const v1 = phaseTwoVerdict({ mode: "mock", strict: { ok: true }, checks: [okCheck, badCheck], goalDelta: 0 });
        t("strict ok 但有一条可信检查为红 ⇒ level 不能是 offline-only", v1.level === "none", v1.level);
        t("strict ok 但有一条可信检查为红 ⇒ 不达成", v1.achieved === false);
        t("strict ok 但有一条可信检查为红 ⇒ why 点名那条红", v1.why.some(s => /V-obs-flow/.test(s)), v1.why);

        /* 对照：同样的输入，把那条检查改绿 ⇒ 回到 offline-only（证明确实是"红"在起作用） */
        const v2 = phaseTwoVerdict({
            mode: "mock", strict: { ok: true },
            checks: [okCheck, { name: "V-obs-flow", ok: true }], goalDelta: 0,
        });
        t("（对照）同样输入但全绿 ⇒ offline-only", v2.level === "offline-only", v2.level);

        /* live 时也必须管 */
        const v3 = phaseTwoVerdict({
            mode: "live", strict: { ok: true },
            checks: [{ name: "L1-landing", ok: false }, { name: "L3-flow", ok: true }], goalDelta: 12,
        });
        t("live + goal 涨 + 但有可信检查为红 ⇒ 不达成（不许被 goal 增量掩盖）",
            v3.achieved === false && v3.level === "none", { achieved: v3.achieved, level: v3.level });

        /* 不可信的项（L3/L4 在离线）为红 ⇒ 不触发这条规则（它们本来就不构成结论） */
        const v4 = phaseTwoVerdict({
            mode: "mock", strict: { ok: true },
            checks: [{ name: "L1-landing", ok: true }, { name: "L3-flow", ok: false }], goalDelta: 0,
        });
        t("离线时 L3 为红不算「可信检查为红」（它本来就不可信）",
            !v4.why.some(s => /有可信检查项为红/.test(s)), v4.why);
    }

    /* ⑧ 冻结表完整 */
    {
        t("OFFLINE_UNVERIFIABLE 含 L3/L4/tx 三项",
            ["L3-flow", "L4-behavior", "tx-atomicity"].every(k => k in OFFLINE_UNVERIFIABLE));
        t("两张表都冻结", Object.isFrozen(OFFLINE_UNVERIFIABLE) && Object.isFrozen(OFFLINE_VERIFIABLE));
    }

    console.log(`\noffline_boundary 自测：${pass} 通过 / ${fail} 失败`);
    process.exit(fail ? 1 : 0);
}

export default { OFFLINE_UNVERIFIABLE, OFFLINE_VERIFIABLE, classifyChecks, phaseTwoVerdict };
