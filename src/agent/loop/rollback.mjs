/**
 * loop/rollback.mjs —— **什么时候该撤销上一步**。
 *
 * ## 为什么需要这个文件（而不是在 loop.mjs 里加个 if）
 *
 * `V-health` 已经能测出「这一步把世界改坏了」（`classifyNetEffect` → `regressive`）。
 * 但「测出来」与「该撤销」之间隔着一个**关键的现实约束**：
 *
 *   这套系统只有 7 个**局部**宏（connect / insert_machine / remove_run /
 *   remove_machine / extend_line / replace_run / trash_unused），没有 `build_line`。
 *   所以「先拆掉旧线、下一轮再接新线」是**唯一可行的施工模式** ——
 *   而拆的那一轮**必然** regressive（到 hub 的带子变少了）。
 *
 * 实测证据（L4 官方正解，`test/fixtures/saves/L4-obs.json` +
 * `test/fixtures/llm/l4-coldstart`）：
 *
 *   第 1 轮 `replace_run` 把一条 run 换成 cutter+trash
 *     → 到 hub 的带子 140→133、死带子 23→27
 *     → `classifyNetEffect` 判 **regressive**
 *     → 但那一步是**正解的第一步**，两轮之后产线才通。
 *
 * 如果「regressive 就回滚」，这一步会被撤销，模型永远做不完任何多轮改造。
 *
 * 所以判据必须是**多信号**的，而不是单看一步的标签。
 *
 * ## 判据：什么情况下撤销
 *
 * 三条同时成立才撤销（全部必要条件 —— 缺一条就不动世界）：
 *
 * 1. **确认是破坏，不是施工**：
 *    `regressive` 且 **本轮没有派生流/新增机器**（`constructive` 的信号）。
 *    施工的特征是「拆的同时在加东西」：`replace_run` 会同时破坏旧 run 并放下新机器。
 *    纯破坏的特征是「只删不加」。
 *
 * 2. **不可恢复**：世界已经比 **run 开始**（不是上一步）时更差。
 *    单步破坏可能是暂时的；如果累计也变差了，说明这不是在往好里改。
 *
 * 3. **没在收敛**：同一档位的破坏**连续**出现（或者累计连续两步恶化）。
 *    第一次 regressive 给一轮机会让模型自己补；连续两次说明它补不上。
 *
 * ## 为什么不撤销（重要）
 *
 * - 任何一步 `positive` / `cleanup` → 不撤销（哪怕同轮也有破坏）
 * - `churn` / `inert` → 不撤销（没弄坏东西，撤销它只是浪费一次 tx）
 * - 这是第一条 regressive → 不撤销（给模型一次自修机会）
 * - 预算里关了（`budget.ROLLBACK === false`）→ 不撤销
 *
 * 纯函数，零 IO，不读时钟 —— 同一组输入两次调用结果相同（可测、可回放）。
 */

/** 判定结果的枚举。`none` = 不撤销。 */
export const ROLLBACK_KINDS = Object.freeze([
    "none",            // 不该撤销
    "transient",       // 单步破坏，但还没到「确认要撤」—— 给模型一轮机会
    "converging",      // 正在收敛（累计在变好），单步破坏是施工代价
    "sanctioned",      // 拆的是系统标记过的残线 —— 可达率下降是预期代价，不许撤
    "rolling_back",    // 确认撤销
]);

/**
 * 判断这一轮该不该撤销。
 *
 * @param {object} p
 * @param {object} p.netEffect      本轮 `classifyNetEffect(before, after)` 的返回 `{kind, why}`
 * @param {object} p.runTotal       上一次已知的累计判定 `{kind, why}`（可能为 null）
 * @param {object} p.prevNetEffect  上一轮的 `netEffect`（首轮为 null）
 * @param {string} p.mode           `"live" | "mock" | "replay"`
 * @param {object} [p.budget]       `{ROLLBACK?:boolean, ROLLBACK_MAX?:number}`
 * @param {number} [p.rolledBackCount] 本次 run 已经撤销过几次
 * @param {boolean} [p.hadWorkThisRound] 本轮是否有「在加东西」的证据
 * @param {boolean} [p.sanctionedTeardown] 本轮拆的是**系统叫它拆的**残线
 * @returns {{kind:string, rollback:boolean, why:string[], evidence:object}}
 */
export function decideRollback({
    netEffect = null,
    runTotal = null,
    prevNetEffect = null,
    mode = "mock",
    budget = null,
    rolledBackCount = 0,
    hadWorkThisRound = false,
    sanctionedTeardown = false,
} = {}) {
    const why = [];
    const b = (budget && typeof budget === "object") ? budget : {};

    /* ── 闸门 0：总开关与模式 ──
     *
     * 离线（mock/replay）**不做**撤销，这里是**有意的**，不是偷懒：
     *
     *   `FakeGame.apply()` 只改实体表，不做 `runGuarded` 的 immutable 回写
     *   （真 tx 里游戏会按邻居重算带子方向）。所以离线算出来的
     *   `belts_reaching_hub` 变化**不可靠** —— 这正是 `V-health` 进
     *   `OFFLINE_UNVERIFIABLE` 的同一个理由。
     *
     * 基于一个不可靠的判据去撤销世界，比不撤销更危险。离线仍然会
     * **记录**「本该撤销」（`kind: "rolling_back"`, `rollback:false`, `dry:true`），
     * 这样测试能覆盖判定逻辑，而世界不动。 */
    if (b.ROLLBACK === false) {
        return { kind: "none", rollback: false, why: ["budget.ROLLBACK=false：本次 run 不做撤销"], evidence: {} };
    }

    const maxRollbacks = Number.isInteger(b.ROLLBACK_MAX) ? b.ROLLBACK_MAX : 3;
    if (rolledBackCount >= maxRollbacks) {
        return {
            kind: "none", rollback: false,
            why: [`本次 run 已撤销 ${rolledBackCount} 次（上限 ${maxRollbacks}）—— 再撤就成了在撤销里打转`],
            evidence: { rolled_back_count: rolledBackCount, max: maxRollbacks },
        };
    }

    if (!netEffect || typeof netEffect !== "object") {
        return { kind: "none", rollback: false, why: ["没有净效果证据"], evidence: {} };
    }

    const kind = String(netEffect.kind || "");

    /* ── 不撤销的四种情况（先排除，逻辑更清楚） ── */
    if (kind === "positive") {
        return { kind: "none", rollback: false, why: ["本轮有目标交付 —— 绝不撤销"], evidence: { net: kind } };
    }
    if (kind === "cleanup") {
        return { kind: "none", rollback: false, why: ["本轮让世界更干净了（死带子变少等）"], evidence: { net: kind } };
    }
    if (kind === "churn" || kind === "inert") {
        /* 没弄坏东西。撤销一个 churn 只是浪费一次 tx；
           撤销一个 inert 是纯粹的瞎忙。 */
        return { kind: "none", rollback: false, why: [`本轮 ${kind} —— 没有可恢复的破坏`], evidence: { net: kind } };
    }
    if (kind !== "regressive") {
        return { kind: "none", rollback: false, why: [`未知档位 "${kind}"，不据此撤销`], evidence: { net: kind } };
    }

    /* ── 到这里：本轮确实是 regressive ── */

    /* ★ 授权拆除：系统自己叫它拆的，不许反过来撤销它 ★
     *
     * 这条是被一个真实的反向激励逼出来的（交叉评审 + 实测确认）：
     *
     *   1. `OBSOLETE_LINE` 告诉模型「这条线是残线，拆掉它」；
     *   2. 模型照做 → 删掉几条能到 hub 的带子 → `classifyNetEffect` 判 `regressive`
     *      （到 hub 的带子变少了，这是**必然**的，因为它拆的正是那些带子）；
     *   3. 连续第二次 regressive → `decideRollback` 判 `rolling_back` → **系统把拆除撤销**。
     *
     * 结果：模型照着系统的话做，系统再把它的动作撤销。这比不提示更糟 ——
     * 它会让模型学到「拆线会被惩罚」，从而彻底不动手。
     *
     * 实测数据也印证了这条路径存在：历史 1405 次调用里 `remove_run` 只出现 **2 次**，
     * 而 `connect` 373 次、`trash_unused` 229 次。模型本来就不愿意拆；
     * 再撤销它的拆除，等于把这条路彻底封死。
     *
     * 判据由调用方给出（`sanctionedTeardown`）—— 那需要知道「本轮拆的位置是不是
     * 残线」，只有 loop 有那个信息。这里只负责尊重它。 */
    if (sanctionedTeardown) {
        return {
            kind: "sanctioned",
            rollback: false,
            why: [
                "本轮拆的是系统标记过的残线 —— 可达率下降是拆除的预期代价，不是破坏",
                ...(Array.isArray(netEffect.why) ? netEffect.why : []),
            ].filter(Boolean),
            evidence: { net: kind, sanctioned: true },
        };
    }

    /* 条件 1：是不是在「边拆边建」？
     *
     * `regressive` 的 why 里如果同时出现了「机器 +N」这种建设信号，
     * 说明这一轮是 replace_run / insert_machine 之类 —— 施工。
     * 施工的代价就是暂时的可达率下降，不该撤。 */
    const whyText = Array.isArray(netEffect.why) ? netEffect.why.join(" ") : "";
    const buildingSignal = hadWorkThisRound
        || /机器\s*\+\d+/.test(whyText)
        || /带子\s*\+\d+/.test(whyText);
    if (buildingSignal) {
        return {
            kind: "converging", rollback: false,
            why: ["本轮在拆的同时也在建（施工中）—— 暂时降低可达率是这一步的代价", whyText].filter(Boolean),
            evidence: { net: kind, building: true },
        };
    }

    /* 条件 2：累计是不是也变差了？
     *
     * 单步破坏可能是暂时的。如果**从 run 开始到现在**变好了，
     * 说明整体方向是对的，这一步是必要代价。 */
    const totalKind = runTotal && typeof runTotal === "object" ? String(runTotal.kind || "") : "";
    if (totalKind === "positive" || totalKind === "cleanup") {
        return {
            kind: "converging", rollback: false,
            why: [`累计仍在变好（${totalKind}）—— 单步破坏是必要代价`],
            evidence: { net: kind, total: totalKind },
        };
    }

    /* 条件 3：这是不是第一次？给模型一轮自修机会。
     *
     * 只撤「连续第二次」及以后的 regressive —— 模型看到 `## LAST STEP`
     * 说了「你把它改坏了」，应该有机会自己补回来。 */
    const prevKind = prevNetEffect && typeof prevNetEffect === "object"
        ? String(prevNetEffect.kind || "") : "";
    if (prevKind !== "regressive" && prevKind !== "none") {
        return {
            kind: "transient", rollback: false,
            why: [`本轮 regressive，但这是第一次 —— 给模型一轮自修机会（下一步会看到 ## LAST STEP）`, whyText].filter(Boolean),
            evidence: { net: kind, prev: prevKind || null, total: totalKind || null },
        };
    }

    /* ── 三条都成立：撤 ── */
    why.push(`连续破坏：上一轮 ${prevKind || "(无)"} → 本轮 regressive`);
    why.push(`累计也是 ${totalKind || "regressive"}`);
    if (whyText) why.push(whyText);
    return {
        kind: "rolling_back",
        /* 离线不做真撤销（见闸门 0 的说明）。这里如实返回 rollback:false + dry:true，
           让调用方与测试都能区分「判了要撤」与「真的撤了」。 */
        rollback: mode === "live",
        dry: mode !== "live",
        why,
        evidence: {
            net: kind, prev: prevKind || null, total: totalKind || null,
            mode, rolled_back_count: rolledBackCount, max: maxRollbacks,
        },
    };
}

/**
 * 撤销之后，这一轮的净效果该怎么记账。
 *
 * 三种口径必须分开，否则时间线会自相矛盾：
 *
 * | 情况 | 记成 | 理由 |
 * |---|---|---|
 * | 判定要撤 + 撤销成功 | `reverted` | 世界回到了本轮之前 |
 * | 判定要撤 + 撤销失败 | 保留 `regressive` | 破坏还在，如实记 |
 * | 离线（判了但没真撤） | 保留 `regressive` + `dry:true` | 世界真的变了 |
 *
 * `reverted` 是**新增的一种记账**，不是 `inert`：
 * 「我改坏了然后撤了」与「我什么都没做」是两件不同的事，
 * 前者说明这个动作被证明是错的（应该进跨 run 记忆），后者什么也没说明。
 *
 * @param {object} decision `decideRollback` 的返回
 * @param {object|null} restoreResult `checkpointRestore` 的返回
 * @returns {{kind:string, why:string[], reverted:boolean}}
 */
export function netEffectAfterRollback(decision, restoreResult) {
    if (!decision || decision.kind !== "rolling_back") {
        return null;
    }
    const verified = !!(restoreResult && restoreResult.ok === true && restoreResult.verified === true);
    if (decision.dry === true) {
        return {
            kind: "regressive",
            reverted: false,
            why: ["（离线）判定了要撤销，但离线不做真撤销 —— 世界确实变差了"],
        };
    }
    if (!verified) {
        const rsWhy = (restoreResult && Array.isArray(restoreResult.why)) ? restoreResult.why.join("；") : "无恢复结果";
        return {
            kind: "regressive",
            reverted: false,
            why: [`撤销失败，破坏仍在：${rsWhy}`],
        };
    }
    return {
        kind: "reverted",
        reverted: true,
        why: ["撤销成功，世界回到了本轮之前"],
    };
}
