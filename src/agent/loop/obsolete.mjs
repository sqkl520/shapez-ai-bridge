/**
 * loop/obsolete.mjs —— **识别残线**：一条活着、在造东西、但造的不是目标、且一件都没进 hub 的线。
 *
 * ## 为什么需要它（用户贴图那次的直接成因）
 *
 * 世界从 level 5（`Cu----Cu`）升到 level 6（`Cu------`）之后，旧的产线**没有拆**。
 * 实测的形态：
 *
 *   · 136 实体 / 120 条带子 / **49 条到不了 hub（41%）**
 *   · `debug_items` 里 40 条入口带子 **0 条有货**
 *   · 产线还在造 `Cu----Cu` —— 上一个 level 的形状
 *
 * 现有诊断没有一条能说出「这条线属于已经过去的目标」。`NO_PRODUCTION` 说的是
 * 「整体没有产线在造目标」，它让模型去**建**；而这里的正确动作是先**拆**。
 * 动作方向相反的两件事合成一条诊断，模型会在「先建」和「先拆」之间摇摆 ——
 * 这正是它每轮追不同诊断、不收敛的原因之一。
 *
 * ## 判据（三条同时成立才算残线）
 *
 * 1. **它在产东西**：`produced_total[shape] > 0`，且 `shape !== goal`。
 *    只是「死带子」不算残线 —— 那是另一类问题（`DEAD_END` / `CHAIN_UNFED`）。
 * 2. **它一件都没进 hub**：`delivered_total[shape]` 为 0 或缺失。
 *    只要那个形状还在进 hub，它就可能有价值（比如它是某个配方的中间产物）。
 * 3. **产得不算太少**：占全部产出的一定比例，避免把一次性的调试残渣当成「一条线」。
 *
 * ## ⚠️ 这个判据有个致命的观测窗限制（2026-11-04 交叉评审指出，已实测确认）
 *
 * `produced_total` 是**最近 60 秒**的窗口量（mod 的 `slices:6 × sliceSecs:10`，
 * `shapez-ai-bridge.js:738-759`）。而残线的**典型形态恰恰是「旧线已经停了」**——
 * 用户贴图那次的现场数据是「40 条入口带子 0 条有货、带上货 0」。
 *
 * 实测：
 *
 *   produced_total = {}                      → 一条都不报   ← 真实场景
 *   produced_total = {"Cu----Cu": 0}         → 一条都不报
 *   produced_total = {"Cu----Cu": 25}        → 报（但这时它还在跑，不算最严重）
 *
 * 也就是说：**它只在旧线还没死时有效，而那时它并不算问题**；等它真的变成
 * 41% 死带子时，窗口早就归零了。这是判据选错了证据源，不是阈值没调好。
 *
 * ## 所以现在有两个入口
 *
 * · `findObsoleteLines`  —— 窗口证据（「还在产」）。保留，用于「刚换关、旧线还在跑」
 *   这个早期窗口 —— 那是**唯一能及时拦住它**的时刻。
 * · `findStoredObsolete` —— **累计账本证据**（`hub.stored_shapes`）。跨关不清零，
 *   窗口归零之后仍然在。用于「旧线早就停了」的场景。
 *
 * 两者的取舍写在 `findStoredObsolete` 的注释里（`stored_shapes` 混着中间产物，
 * 只能当**辅助**，不能单独定案）。
 *
 * 纯函数：只读 production / goal / hub，不 spawn。可测。
 */

const str = v => (typeof v === "string" ? v : "");
const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 一个形状的产出至少要占全部产出的这个比例，才值得单独报一条残线。 */
export const OBSOLETE_MIN_SHARE = 0.05;

/** 少于这个绝对件数的不报（防止把一两次调试残渣当成一条线）。 */
export const OBSOLETE_MIN_ITEMS = 10;

/**
 * 找残线。
 *
 * @param {object|null} production `reader.production()` 的返回
 *   （`produced_total` / `delivered_total` / `window_seconds`）
 * @param {string} goalShape 当前目标形状
 * @param {object} [opts]
 * @param {number} [opts.minShare]    覆盖 `OBSOLETE_MIN_SHARE`
 * @param {number} [opts.minItems]    覆盖 `OBSOLETE_MIN_ITEMS`
 * @param {number} [opts.maxReport]   最多报几条（默认 2）
 * @returns {Array<{shape:string, produced:number, delivered:number, share:number, ratio:number}>}
 *   按「产出量大」降序。空数组 = 没有残线。
 */
export function findObsoleteLines(production, goalShape, opts = {}) {
    const p = production && typeof production === "object" ? production : null;
    if (!p) return [];
    const produced = (p.produced_total && typeof p.produced_total === "object") ? p.produced_total : null;
    if (!produced) return [];
    const delivered = (p.delivered_total && typeof p.delivered_total === "object") ? p.delivered_total : {};

    const goal = str(goalShape).trim();
    const minShare = num(opts.minShare) !== null ? opts.minShare : OBSOLETE_MIN_SHARE;
    const minItems = num(opts.minItems) !== null ? opts.minItems : OBSOLETE_MIN_ITEMS;
    const maxReport = num(opts.maxReport) !== null ? opts.maxReport : 2;

    /* ★ 当前配方的闭包 —— 中间产物不是残线 ★
     *
     * 真机实测（2026-11-09，目标 `Cu------` / level 6）：
     *
     *   produced_total = {----CuCu:25, CuCu----:25, Cu----Cu:25, CuCuCuCu:25}
     *   delivered_total = {Cu----Cu:25}
     *
     * 第一版报了 `----CuCu` 与 `CuCu----` 两条「残线」。但 `Cu------` 的配方是
     *
     *   CuCuCuCu ─mine→ ----CuCu ─cut→ Cu----Cu ─rotate→ Cu------ ─cut→
     *
     * **`----CuCu` 是必经的中间形态**，它「交付 0」是因为它压根不该交付。
     * 把它报成残线会让模型去拆一条正在正常工作的链。
     *
     * 这与账本法（`findStoredObsolete`）是同一个坑，那里已经排除了闭包；
     * 窗口法这边漏了。现在两边同一口径：**配方闭包里的形状一律不算残线**。 */
    const own = new Set();
    if (goal) own.add(goal);
    const recipe = opts.recipe;
    if (recipe && recipe.ok === true && Array.isArray(recipe.steps)) {
        for (const st of recipe.steps) {
            const hash = str(st && st.hash).trim();
            if (hash) own.add(hash);
        }
    }

    /* 分母：全部产出之和。用它算占比，而不是用「最大值」——
       全部都在造一个错误形状时，占比是 1.0，那正是最该报的情形。 */
    let total = 0;
    for (const v of Object.values(produced)) {
        const n = num(v);
        if (n !== null && n > 0) total += n;
    }
    if (total <= 0) return [];

    const out = [];
    for (const [shape, raw] of Object.entries(produced)) {
        const s = str(shape).trim();
        if (!s) continue;
        const n = num(raw);
        if (n === null || n <= 0) continue;

        /* 条件 1：造的不是目标，**也不是当前配方的任何一步**。
         *
         * 目标形状读不到（goal 为空）时**不报** —— 「不知道目标是什么」不等于
         * 「造的东西是错的」。这条纪律与本项目其它地方一致：读不到就不判定。 */
        if (!goal || own.has(s)) continue;

        /* 条件 2：一件都没进 hub。
         *
         * 读不到 delivered ⇒ 视为 0（`production` 缺这个字段是常见形态），
         * 因为「没有交付的证据」与「确实没交付」在这里后果相同：
         * 值得让模型看一眼。而**有一件**在交付就放过 —— 那说明它还有用。 */
        const d = num(delivered[s]);
        if (d !== null && d > 0) continue;

        /* 条件 3：量足够大。 */
        if (n < minItems) continue;
        const share = n / total;
        if (share < minShare) continue;

        out.push({
            shape: s,
            produced: n,
            delivered: d === null ? 0 : d,
            share: Math.round(share * 1000) / 1000,
            /* 交付率：给模型一个「这条线白干得多彻底」的量。0 就是全白干。 */
            ratio: d === null ? 0 : Math.round((d / n) * 1000) / 1000,
        });
    }

    out.sort((a, b) => b.produced - a.produced);
    return out.slice(0, maxReport);
}

/**
 * 用**累计账本**（`hub.stored_shapes`）找「循环形状已停」的证据。
 *
 * ## 为什么需要它（实测的观测窗死角）
 *
 * `findObsoleteLines` 依赖 60 秒产出窗口。但残线的典型终局是「线停了」——
 * 那时窗口归零，它一条都不报。用户贴图那次正是这个形态。
 *
 * `hub.stored_shapes` 是**累计**的（升级不清零），窗口归零之后仍然在。
 *
 * ## 但它只能当辅助证据，而且**必须先确认换过关**
 *
 * 实测两张夹具：
 *
 *   L4（目标 RuRu----）stored = {CuCuCuCu:46, ----CuCu:47376, RuRuRuRu:112866}
 *   L5（目标 Cu----Cu）stored = {CuCuCuCu:46, ----CuCu:87446, RuRuRuRu:177830, RuRu----:31204}
 *
 * `CuCuCuCu` / `----CuCu` / `RuRuRuRu` 都是**更早关卡的遗留物**，每次挖矿都会
 * 顺带进 hub。拿「stored 里有非目标形状」当判据，会把**任何**正常存档都判成残线——
 * L4 上实测就误报了 `----CuCu` 与 `CuCuCuCu` 两条。
 *
 * 那个假阳性会经由 `isSanctionedTeardown` 让「授权拆除」对**每个世界恒成立**，
 * 于是回滚永远不会触发 —— 一条误报废掉整个安全网。
 *
 * 所以这里加一道**强制前置**：调用方必须显式给 `levelChanged: true`
 * （即「本次 run 观察到了目标形状变化」）。没有换关就没有「旧目标」，
 * 也不可能有「旧目标的残线」。默认 `false` —— 宁可少报，不许误报。
 *
 * @param {object} p
 * @param {object|null} p.hub      obs 的 `hub`（用 `stored_shapes`）
 * @param {string} p.goalShape
 * @param {object|null} [p.recipe] `recipeForCached` 的返回（用 `steps[].hash`）
 * @param {boolean} [p.levelChanged] **必须为 true 才会返回任何结果**
 * @param {object} [opts]          `{minItems, maxReport}`
 * @returns {Array<{shape:string, stored:number}>}
 */
export function findStoredObsolete({ hub, goalShape, recipe = null, levelChanged = false } = {}, opts = {}) {
    /* ★ 没有换关就没有残线 ★ 见上面那段（一条误报会废掉整个回滚机制）。 */
    if (levelChanged !== true) return [];
    const stored = hub && typeof hub === "object" && hub.stored_shapes && typeof hub.stored_shapes === "object"
        ? hub.stored_shapes : null;
    if (!stored) return [];
    const goal = str(goalShape).trim();
    if (!goal) return [];

    /* 当前配方的闭包：目标 + 每一步的产出形状。挖矿原料（`mine` 那步的 hash）
       也在 steps 里，所以一并被排除 —— 那是正确的：原料进 hub 是常态。 */
    const own = new Set([goal]);
    if (recipe && recipe.ok === true && Array.isArray(recipe.steps)) {
        for (const s of recipe.steps) {
            const h = str(s && s.hash).trim();
            if (h) own.add(h);
        }
    }
    const minItems = num(opts.minItems) !== null ? opts.minItems : OBSOLETE_MIN_ITEMS;
    const maxReport = num(opts.maxReport) !== null ? opts.maxReport : 2;

    const out = [];
    for (const [shape, raw] of Object.entries(stored)) {
        const s = str(shape).trim();
        if (!s || own.has(s)) continue;
        const n = num(raw);
        if (n === null || n < minItems) continue;
        out.push({ shape: s, stored: n });
    }
    out.sort((a, b) => b.stored - a.stored);
    return out.slice(0, maxReport);
}

/**
 * 判断本次 tx **拆掉的**是不是一条残线（供 `decideRollback` 的
 * `sanctionedTeardown` 用）。
 *
 * ## 为什么需要它（一个真实的反向激励）
 *
 * 流程是这样的：
 *   1. `OBSOLETE_LINE` 告诉模型「这条线是残线，拆掉它」；
 *   2. 模型照做 → 删掉几条**能到 hub 的**带子 → `classifyNetEffect` 判 `regressive`
 *      （到 hub 的带子变少了，这必然发生 —— 它拆的就是那些带子）；
 *   3. 连续第二次 regressive → `decideRollback` 判 `rolling_back` → **系统撤销拆除**。
 *
 * 实测确认过这条路径（`decideRollback` 在连续两次 regressive 下确实返回
 * `rollback: true`）。结果是：模型照着系统的话做，系统再把它的动作撤销。
 * 那比不提示更糟 —— 它会让模型学到「拆线会被惩罚」。
 *
 * 旁证：历史 1405 次调用里 `remove_run` 只出现 **2 次**，而 `connect` 373 次。
 * 模型本来就不愿拆；再撤销它的拆除，等于把这条路彻底封死。
 *
 * ## 判据（**四**条同时成立，非常保守）
 *
 * 1. 本次 tx **确有删除**（`removes` 非空）；
 * 2. 被删的**都**是带子/隧道（拆机器是另一回事，不走这条豁免）；
 * 3. 存在残线证据（`obsoleteLines` 非空）；
 * 4. **本次 run 确实换过关**（`levelChanged === true`）。
 *
 * 第 2 条用「都」而不是「有」：如果本轮既拆了带子又放了机器，
 * 那是一次施工 —— 施工有自己的 `converging` 豁免，不该走这条。
 *
 * 第 4 条是**血的教训**：`stored_shapes` 里存着所有更早关卡的遗留物
 * （L4 上就有 `CuCuCuCu:46` / `----CuCu:47376`）。如果不要求「确实换过关」，
 * 那么**每个世界**都会有残线证据 ⇒ 授权拆除恒成立 ⇒ 回滚永不触发 ⇒
 * 整个 P9 的安全网被一条误报废掉。实测确实是这样：E11 那条端到端用例
 * 因为「前提：这次 run 必须真的撤销过」不成立而变红。
 *
 * @param {object} p
 * @param {Array|null} p.removes `txPlan.removes`（`[{uid, expect:{type,x,y,r}}]`）
 * @param {Array|null} p.obsoleteLines 本轮算出的残线
 * @param {boolean} [p.levelChanged] 本次 run 是否观察到目标形状变化
 * @returns {boolean}
 */
/**
 * 本次 tx 拆掉的，是不是一条**已经被点名过**的残线？
 *
 * ## `levelChanged` 从「硬门」降为「一个可以不作数的入参」（2026-11-10）
 *
 * 原来这里第一行是 `if (levelChanged !== true) return false`。理由写在
 * `findStoredObsolete` 上面：账本证据在没换关时会误报，而误报会让「授权拆除」
 * 恒成立 ⇒ 回滚永不触发（实测 E11 变红）。
 *
 * 那个担心是真的，但**这道锁挂错地方了**。真正需要证据门槛的是
 * **产生残线清单**的那一步 —— `findStoredObsolete` 自己已经检查 `levelChanged`
 * 并返回空，`findObsoleteLines` 的窗口证据本来就是实测的。清单里既然已经有
 * 一条被认可的证据，拆它就是对的；再在消费端挡一次是重复的。
 *
 * 后果（可测、也正是用户贴的那张图）：run 一开始就在第 9 关，`goalChanged` 恒假
 * ⇒ 模型照 `OBSOLETE_LINE` 去拆旧线 ⇒ 判 regressive ⇒ 连撤两次。
 * 系统一边骂它不收拾残局，一边把它收拾的动作撤销掉 —— 模型学到的是「别碰」。
 *
 * 现在只认**清单本身**：`obsoleteLines` 非空即表示这一轮确实有被点名的残线，
 * 拆的又只有带子/隧道，那就不是「把世界弄坏了」，而是「执行了一条诊断」。
 *
 * E11 那条回归仍然被守住 —— 它守的是「别把**误报的**清单当证据」，
 * 而误报源（`findStoredObsolete` 的 `levelChanged` 前置）没有被改动，V38 仍然锁着它。
 *
 * @param {object} p
 * @param {Array} [p.removes]       本次 tx 的删除项
 * @param {Array} [p.obsoleteLines] 本轮算出的残线清单（**非空即为证据**）
 * @param {boolean} [p.levelChanged] 保留但**不再拦截**；仅供调用方记录上下文
 */
export function isSanctionedTeardown({ removes, obsoleteLines } = {}) {
    const rem = Array.isArray(removes) ? removes : [];
    if (!rem.length) return false;
    /* 只删了带子/隧道 —— 拆机器不算「拆残线」（机器可能正在被复用）。 */
    const allBelts = rem.every(r => {
        const t = r && r.expect && typeof r.expect === "object" ? str(r.expect.type) : "";
        return t === "belt" || t === "underground_belt";
    });
    if (!allBelts) return false;
    return Array.isArray(obsoleteLines) && obsoleteLines.length > 0;
}

/**
 * 把残线转成一句人话（供 prompt 与 timeline 复用，避免两处措辞漂移）。
 *
 * 刻意**不写修法**：拆还是改道取决于那条线长什么样，那是模型与
 * `remove_run` / `replace_run` 校验器的职责。这里只把事实摆清楚。
 *
 * @param {object} line `findObsoleteLines` 的一项
 * @param {string} goalShape
 * @returns {string}
 */
export function describeObsoleteLine(line, goalShape) {
    if (!line) return "";
    /* 两种证据源共用一个描述函数：`produced`（窗口量）与 `stored`（累计账本）。 */
    const storedOnly = num(line.produced) === null && num(line.stored) !== null;
    if (storedOnly) {
        return `${line.shape} still has ${line.stored} stored in the hub and is NOT part of `
            + `the current recipe for ${goalShape} — it can only come from an earlier goal`;
    }
    const pct = Math.round((line.share || 0) * 100);
    return `the factory is producing ${line.shape} ×${line.produced} (${pct}% of all output) `
        + `but ${line.delivered} of it ever reached the hub — ${line.shape} is not the goal (${goalShape})`;
}
