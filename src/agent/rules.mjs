/**
 * rules.mjs — 把攻略研究变成**数据**，而不是散落在脚本里的常量。
 *
 * 每一条规则都必须带：
 *   · 值（可以拿去算的）
 *   · 出处（哪个文件哪一行 / 哪条官方 tip）
 *   · 可证伪的判据（怎么验证它在这台机器上仍然成立）
 *
 * 为什么这样做：这一轮我反复在同一件事上栽跟头 —— 把"我以为的"当成了"游戏里是的"。
 * 隧道禁止用、hub 不该收副产品、矿机只放一台，每一个都是这种错误。
 * 规则表和源码绑定后，源码变了或我的理解错了，测试会先红。
 *
 * 来源：research/ai-plan/tmp/STRATEGY-RESEARCH.md（agent 研究，主线程已复核关键数字）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// HERE = <repo>/src/agent ⇒ 上溯两级到仓库根。写三级会跑到仓库**外面**去，
// 于是所有源码复核都报"文件不存在"——一个静默失败，看着像源码缺失。
const REPO = path.resolve(HERE, "..", "..");

/* ═══════════════ 1. 数值规则（全部源码核证）═══════════════ */

export const RATES = Object.freeze({
    /** 传送带基础速度：**items/s**（config.js:81 beltSpeedItemsPerSecond） */
    beltPerSec: 2,
    /** 矿机基础速度 = 带速 / 5（config.js:151 自动计算）：**items/s**，一 charge 一件 */
    minerPerSec: 0.4,
    /**
     * 各机器的速率 = 喂满/吃满**一条带**要几台的唯一来源（`machinesPerBelt` / `machinesForOneBelt`）。
     *
     * ## 单位（这一条以前没写清，是能算错的地方）
     *
     * 源码里 `hub_goals.js:323` 是 `originalTime = 1 / getProcessorBaseSpeed(type)`，
     * `miner.js:73` 是 `mineDuration = 1 / miningSpeed` —— 官方口径其实是 **charges/s**。
     * 本表**逐条核过**，结论是：除了 `painterDouble`，每条 `charges/s` 与 `items/s` 数值相同
     * （一个 charge 进出都恰好 1 件）。`painterDouble` 一个 charge 出 2 件
     * （`painter.js:216 inputsPerCharge 3` = 2 形状 + 1 颜色；`process_PAINTER_DOUBLE` 推 2 件
     * 到 outItems），所以这里记的是它的**出件率** 0.25 charges/s × 2 = 0.5 items/s。
     * ⚠️ 别把它改回 0.25：那会让 `machinesPerBelt("painterDouble")` 从 4 变 8。
     *
     * ## 各值出处
     *
     *   · cutter  = 2 × 1 × 1/4 = 0.5   （config.js:102；processors 线 hub_goals.js:553-565）
     *   · rotater = 2 × 1 × 1/1 = 2.0   （config.js:104；processors 线）
     *   · painter = 2 × 1 × 1/6 = 1/3   （config.js:107；**painting** 线 hub_goals.js:536-548）
     *   · painterDouble = 2 × 1/8 × 2 = 0.5（config.js:108；painting 线）
     *   · mixer   = 2 × 1/5 = 0.4       （config.js:110；**painting** 线，与 painter 同组）
     *   · stacker = 2 × 1/8 = 0.25      （config.js:111；processors 线 —— 与 mixer 不同组）
     *   · trash   = 1e30                （hub_goals.js:530，实际无限）
     *
     * ⚠️ `stacker` 这里是**吃进侧**的速率：`machinesPerBelt("stacker") = 8` 意思是
     * 「喂满一条带的 8 台」。它的**出件**侧是 4 台/带（一 charge 出 1 件、吃 2 件）。
     * 两个方向都需要时用 `SHAPES_PER_CHARGE` / `PRODUCT_PER_CHARGE` 换算，别改这张表。
     */
    machinePerSec: {
        miner: 0.4,
        cutter: 0.5,
        rotater: 2.0,
        painter: 1 / 3,
        painterDouble: 0.5,
        mixer: 0.4,
        stacker: 0.25,
        trash: Infinity,
    },
});

/**
 * 机器 kind → 它吃哪条升级线的倍率（hub_goals.js:536-565 的三个 switch 分支）。
 *
 * 单独抽出来是因为这个映射在仓库里已经有**两份**（`audit.mjs` 的 `machineSpeed` 与
 * `assess.mjs` 内联的那份）。两份真值是这个仓库出过最多事故的形态。
 * `null` = 该机器不吃任何升级线。
 */
export const MACHINE_UPGRADE_LINE = Object.freeze({
    miner: "miner",
    cutter: "processors",
    rotater: "processors",
    stacker: "processors",
    painter: "painting",
    painterDouble: "painting",
    painterQuad: "painting",
    mixer: "painting",
    balancer: "belt",
    reader: "belt",
    trash: null,
    hub: null,
});

/**
 * 一个 charge **吃进几件形状**（颜色/染料不算形状流）。
 *
 * 出处：`cutter.js:89 inputsPerCharge 1`、`rotater.js:116 1`、`painter.js:180 2`
 * （1 形状 + 1 颜色 ⇒ 形状 1）、`painter.js:216 3`（2 形状 + 1 颜色 ⇒ 形状 2）、
 * `painter.js:285 5`（1 形状 + 4 颜色 ⇒ 形状 1）、`stacker.js:61 2`（2 件都是形状）、
 * `mixer.js:61 2`（2 件都是**颜色** ⇒ 形状 0）。
 */
export const SHAPES_PER_CHARGE = Object.freeze({
    miner: 0, cutter: 1, rotater: 1, painter: 1, painterDouble: 2, painterQuad: 1, stacker: 2, mixer: 0,
});

/**
 * 一个 charge **产出几件**（用于把处理速率换算成「关卡目标形状的出货速度」）。
 * 半切的 cutter 一刀出两半，其中一半是废料 ⇒ 对目标的贡献是 1 件。
 */
export const PRODUCT_PER_CHARGE = Object.freeze({
    miner: 1, cutter: 1, rotater: 1, painter: 1, painterDouble: 2, painterQuad: 1, stacker: 1, mixer: 1,
});

/**
 * 某台机器在某组升级下的**实际速率**（单位与该 kind 在 RATES.machinePerSec 里一致）。
 *
 * 这是「升级到底加了多少产能」的唯一算法。`audit.mjs` 曾经内联了一份等价的实现 ——
 * 现在它 import 这里，不再自算。
 */
export function machineRatePerSec(kind, levels = {}) {
    const base = RATES.machinePerSec[kind];
    if (base === undefined) return null;
    if (!Number.isFinite(base)) return base;
    const line = MACHINE_UPGRADE_LINE[kind];
    const mul = line ? UPGRADE_MULTIPLIERS[Math.min(Math.max(levels[line] | 0, 0), UPGRADE_MULTIPLIERS.length - 1)] : 1;
    return base * mul;
}

/**
 * 喂满**一条带**需要几台。这是攻略里"5 矿机 : 1 带"这类配比的唯一来源。
 * ⚠️ 只在 belt 与 miner 升级同档时成立（官方 tip #7）。
 */
export function machinesPerBelt(kind) {
    const v = RATES.machinePerSec[kind];
    if (v === undefined) throw new Error(`machinesPerBelt: 未知机器 ${kind}`);
    if (!Number.isFinite(v)) return 0;
    return Math.ceil(RATES.beltPerSec / v);
}

/* ═══════════════ 2. 升级倍率与成本（regular.js:80,107-238）═══════════════ */

/**
 * 累计倍率阶梯：`UPGRADE_MULTIPLIERS[n]` = 升到第 n 级之后的总倍率。
 *
 * ⚠️ **是累加，不是累乘**。`hub_goals.js:57-62` 的算法是
 * `totalImprovement = 1; for (i<level) totalImprovement += tiers[i].improvement;`，
 * 而 `tiers[i].improvement = fixedImprovements[i]`（regular.js:248）＝ `[0.5,0.5,1,1,2,1,1,…]`。
 * 于是 1, 1.5, 2, 3, 4, 6, 7, 8 —— **不是** 1, 1.5, 2.25, … 的复利。
 * 把 `fixedImprovements` 当成「每档乘 1.5」是很容易犯的错，这里连带注释钉住。
 *
 * 第 8 档之后（endgame）增量变成 0.1 / 0.05 / 0.025 …（regular.js:96-104），本表不覆盖。
 */
export const UPGRADE_MULTIPLIERS = Object.freeze([1, 1.5, 2, 3, 4, 6, 7, 8]);

/**
 * 四条升级线的需求（regular.js:107-238 + :245-275 的**累积规则**）。
 *
 * ## 关键：每一档都带着**前面所有档**的需求（re-verified 2026-11-01）
 *
 * `regular.js:255-262` 在每个 tier 上 `unshift` 了 `currentTierRequirements`（前面各档的
 * 原始需求），只有标了 `excludePrevious: true` 的档才跳过。所以 T2 不是「只要 --CuCu--×500」，
 * 而是「CuCuCuCu×75 **加上** --CuCu--×500」；而且那些数字是**乘过 2.5 的**
 * （`regular.js:270-272`：`tier.amount = findNiceIntegerValue(tier.amount * tierGrowth)`）。
 *
 * 本表以前只记了新档位那一条，漏掉了所有 carry-over —— 于是 `upgradeGaps` 会把
 * 「佃有 RuRu---- 600 但一个 Su 都没有」的 processors T2 判成 **affordable**。
 * 这个 bug 会直接让本包的 CAPACITY 段建议一条买不起的升级。
 *
 * 数值由 `recon/upstream-full` 的源码**逐档复刻**验证过（含 `findNiceIntegerValue`
 * 的 round-to-nice：>100 取 20 的倍数、>1000 取 100 的倍数、>5000 取 1000 的倍数……）。
 *
 * ⚠️ 只登记到 T3。T4/T5 是 `SrSrSrSr:CyCyCyCy` 这一档起步的长尾，
 * 到那时 `assess` 会说「无下一档」（`tiers.find` 返回 undefined → 跳过），属于已知边界。
 *
 * ⚠️ `difficulty`（regular.js:251 `amount × difficulty`）：网页版是 0.5，standalone/Steam 是 1
 * （regular.js:380-390）。本表按 **1** 记。若哪天要支持网页版，这里是唯一要乘的位置。
 */
export const UPGRADES = Object.freeze({
    belt: [
        { tier: 1, required: [{ shape: "CuCuCuCu", amount: 30 }] },
        { tier: 2, required: [{ shape: "CuCuCuCu", amount: 75 }, { shape: "--CuCu--", amount: 500 }] },
        { tier: 3, required: [{ shape: "CuCuCuCu", amount: 180 }, { shape: "--CuCu--", amount: 1200 }, { shape: "CpCpCpCp", amount: 1000 }] },
    ],
    miner: [
        { tier: 1, required: [{ shape: "RuRuRuRu", amount: 300 }] },
        { tier: 2, required: [{ shape: "RuRuRuRu", amount: 740 }, { shape: "Cu------", amount: 800 }] },
        { tier: 3, required: [{ shape: "RuRuRuRu", amount: 1800 }, { shape: "Cu------", amount: 2000 }, { shape: "ScScScSc", amount: 3500 }] },
    ],
    processors: [
        { tier: 1, required: [{ shape: "SuSuSuSu", amount: 500 }] },
        { tier: 2, required: [{ shape: "SuSuSuSu", amount: 1200 }, { shape: "RuRu----", amount: 600 }] },
        { tier: 3, required: [{ shape: "SuSuSuSu", amount: 3000 }, { shape: "RuRu----", amount: 1500 }, { shape: "CgScScCg", amount: 3500 }] },
    ],
    painting: [
        { tier: 1, required: [{ shape: "RbRb----", amount: 600 }] },
        { tier: 2, required: [{ shape: "RbRb----", amount: 1500 }, { shape: "WrWrWrWr", amount: 3800 }] },
        { tier: 3, required: [{ shape: "RbRb----", amount: 3500 }, { shape: "WrWrWrWr", amount: 9000 }, { shape: "RpRpRpRp:CwCwCwCw", amount: 6500 }] },
    ],
});

/* ═══════════════ 3. 固定的开局矿点（map_chunk.js:319-347）═══════════════ */

/**
 * 开局五个矿点是**硬编码**的，不随 seed 变。
 * 这意味着：早期布局不需要"找矿"，直接去固定坐标。
 * （我之前的编译器在 96 格内扫矿，纯属绕远路。）
 */
export const FIXED_ORES = Object.freeze([
    { shape: "red", chunk: [0, 0], note: "红染料，7,7 附近" },
    { shape: "CuCuCuCu", chunk: [-1, 0], note: "圆矿，区块 (-1,0) 内 x=chunkSize-9=7 ⇒ 世界 (-9,7)" },
    { shape: "RuRuRuRu", chunk: [0, -1], note: "钌矿，区块 (0,-1) 内 y=chunkSize-7=9 ⇒ 世界 (5,-7)" },
    { shape: "green", chunk: [-1, -1], note: "绿染料，区块内随机" },
    { shape: "SuSuSuSu", chunk: [5, -2], note: "星矿，世界 (85,-23)，远（87 格）" },
]);

/* ═══════════════ 4. 布局纪律（官方 tips + 源码）═══════════════ */

export const LAYOUT_RULES = Object.freeze({
    /** 官方 tip #3/#43/#46：别把工厂挤在 hub 旁边 */
    hubBufferTiles: 12,
    /** 官方 tip #18：分流不用精确配平，堵了会自己改道 */
    preciseBalancing: false,
    /** 官方 tip #20：切割机永远垂直切，朝向只改输出方向 */
    cutterAlwaysVertical: true,
    /** 官方 tip #38：染色在切割之前，能省 4 倍上色器 */
    paintBeforeCut: true,
    /** 官方 tip #32：旧厂永不拆（升级供应链） */
    neverDemolish: true,
    /** 源码 belt_path.js：带子中段不给旁边机器供货，只能末端 */
    beltMidSpanFeeding: false,
});

/* ═══════════════ 5. 可证伪判据 ═══════════════ */

/**
 * 每条数值规则都配一个"怎么在源码里复核它"的指针。
 * `verifyRules()` 会去读源码，确认这些数字没变。
 *
 * 为什么值得做：这一轮我被"wiki 说链式矿机会加速"骗过一次，
 * 靠读源码才纠正。规则和源码绑定后，同类错误会在测试里先暴露。
 */
export const RULE_EVIDENCE = Object.freeze([
    { rule: "beltPerSec", file: "src/js/core/config.js", pattern: /beltSpeedItemsPerSecond:\s*(\d+)/, expect: 2 },
    { rule: "minerPerSec = belt/5", file: "src/js/core/config.js", pattern: /minerSpeedItemsPerSecond\s*=\s*globalConfig\.beltSpeedItemsPerSecond\s*\/\s*(\d+)/, expect: 5 },
    { rule: "升级倍率阶梯", file: "src/js/game/modes/regular.js", pattern: /fixedImprovements\s*=\s*\[([\d.,\s]+)\]/, expect: [0.5, 0.5, 1, 1, 2, 1, 1] },
    { rule: "升级档位增长系数", file: "src/js/game/modes/regular.js", pattern: /const tierGrowth\s*=\s*([\d.]+)/, expect: 2.5 },
    { rule: "机器速率 cutter", file: "src/js/core/config.js", pattern: /cutter:\s*1\s*\/\s*(\d+)/, expect: 4 },
    { rule: "机器速率 painter", file: "src/js/core/config.js", pattern: /painter:\s*1\s*\/\s*(\d+)/, expect: 6 },
    { rule: "机器速率 painterDouble", file: "src/js/core/config.js", pattern: /painterDouble:\s*1\s*\/\s*(\d+)/, expect: 8 },
    { rule: "机器速率 mixer", file: "src/js/core/config.js", pattern: /mixer:\s*1\s*\/\s*(\d+)/, expect: 5 },
    { rule: "机器速率 stacker", file: "src/js/core/config.js", pattern: /stacker:\s*1\s*\/\s*(\d+)/, expect: 8 },
    { rule: "固定矿点：铜", file: "src/js/game/map_chunk.js", pattern: /this\.x === -1 && this\.y === 0[\s\S]{0,200}mapChunkSize - 9/, expect: true },
    { rule: "固定矿点：钌", file: "src/js/game/map_chunk.js", pattern: /this\.x === 0 && this\.y === -1[\s\S]{0,200}mapChunkSize - 7/, expect: true },
]);

/* ── 升级需求表：从源码**重算**一遍，与 UPGRADES 逐项对账 ──
 *
 * 为什么不能只像上面那样抽查几个常量：UPGRADES 的错法恰恰不在单个数字上，而在
 * **漏掉了 carry-over**（T2 要带着 T1 的需求）和**漏乘 tierGrowth**。抽查抓不到它 ——
 * 事实上本表就是这么错了两周（processors T2 只记了 RuRu----×600，漏了 SuSuSuSu×1200）。
 *
 * 所以这里把 regular.js 的算法**照抄实现一遍**：读源码里的 raw 需求 + fixedImprovements
 * + tierGrowth，做同样的 `Math.round(amount × difficulty)`、`unshift(前面各档)`、
 * `findNiceIntegerValue(amount × tierGrowth)`，然后和 UPGRADES 比。源码变了或我们抄错了，
 * 都会红。difficulty 取 1（standalone；见 UPGRADES 的注释）。
 */

/** 复刻 `core/utils.js:180-223` 的 findNiceValue/findNiceIntegerValue（**唯一**一份复刻）。 */
export function findNiceIntegerValue(num) {
    if (num > 1e8) return Math.ceil(num);
    if (num < 0.00001) return 0;
    let roundAmount = 1;
    if (num > 50000) roundAmount = 10000;
    else if (num > 20000) roundAmount = 5000;
    else if (num > 5000) roundAmount = 1000;
    else if (num > 2000) roundAmount = 500;
    else if (num > 1000) roundAmount = 100;
    else if (num > 100) roundAmount = 20;
    else if (num > 20) roundAmount = 5;
    const niceValue = Math.floor(num / roundAmount) * roundAmount;
    if (num >= 10) return Math.round(niceValue);
    if (num >= 1) return Math.round(niceValue * 10) / 10;
    return niceValue;
}

/**
 * 从 regular.js 里抽出某条升级线的前 `maxTiers` 档 raw 需求（`{shape, amount}` 数组）。
 * 解析失败返回 null（**不抛**，由调用方记成 mismatch）。
 *
 * ⚠️ 两处坑（都实测踩过）：
 * 1. 到 T6 之后 raw 需求里出现的是**变量**（`preparementShape` / `finalGameShape`），
 *    不是字面量。所以必须按 `maxTiers` 提前收手，不能"一直解析到看不懂为止" ——
 *    那会连 T1..T3 都已经解析成功的情况下仍然整体返回 null。
 * 2. 有的档位写的是**三元**：`shape: chinaShapes ? "CuCuCuCu:…" : "RpRpRpRp:CwCwCwCw"`。
 *    取第一个字符串会拿到**中国版**的形状。运行时（`G_WEGAME_VERSION || G_CHINA_VERSION`
 *    都为假）取的是**最后**那个分支，所以这里取最后一个引号串。
 */
function parseRawUpgradeTiers(source, line, maxTiers) {
    const start = source.indexOf(`        ${line}: [`);
    if (start < 0) return null;
    const end = source.indexOf("\n        ],", start);
    if (end < 0) return null;
    const block = source.slice(start, end);
    const tiers = [];
    const re = /required:\s*\[([\s\S]*?)\]/g;
    let m;
    while ((m = re.exec(block))) {
        if (tiers.length >= maxTiers) break;
        const body = m[1];
        const reqs = [];
        const objRe = /\{([^{}]*)\}/g;
        let o;
        while ((o = objRe.exec(body))) {
            const fields = o[1];
            const amt = fields.match(/amount:\s*(\d+)/);
            const shapeExpr = fields.match(/shape:\s*([^,]+),/);
            if (!amt || !shapeExpr) { reqs.length = 0; break; }       // 变量形状 ⇒ 本档不可解析
            const quoted = [...shapeExpr[1].matchAll(/"([^"]+)"/g)].map(x => x[1]);
            if (!quoted.length) { reqs.length = 0; break; }           // preparementShape 之类
            reqs.push({ shape: quoted[quoted.length - 1], amount: Number(amt[1]) });
        }
        if (!reqs.length) return tiers.length ? tiers : null;         // 非常量 shape 档：到此为止
        tiers.push(reqs);
        /* excludePrevious 在这一档的 required 之后、下一档 required 之前 */
        const tail = block.slice(m.index + m[0].length);
        if (/^\s*,\s*excludePrevious:\s*true/.test(tail)) break;
    }
    return tiers.length === maxTiers ? tiers : null;
}

/** 完全复刻 regular.js:245-275 的累积规则。返回 `[{tier, improvement, required}]`。 */
function accumulateTiers(rawTiers, fixedImprovements, tierGrowth, difficulty = 1) {
    let current = [];
    const out = [];
    for (let i = 0; i < rawTiers.length; i++) {
        const req = rawTiers[i].map(r => ({ shape: r.shape, amount: Math.round(r.amount * difficulty) }));
        const original = req.slice();
        for (let k = current.length - 1; k >= 0; --k) req.unshift({ shape: current[k].shape, amount: current[k].amount });
        current.push(...original.map(r => ({ amount: r.amount, shape: r.shape })));
        for (const t of current) t.amount = findNiceIntegerValue(t.amount * tierGrowth);
        out.push({ tier: i + 1, improvement: fixedImprovements[i], required: req.map(r => ({ shape: r.shape, amount: r.amount })) });
    }
    return out;
}

/**
 * 复核规则表与源码是否仍然一致。返回 {ok, checked, mismatches}。
 * **不抛错**：调用方决定是警告还是失败（测试里失败，运行时只警告）。
 */
export function verifyRules() {
    const mismatches = [];
    let checked = 0;
    for (const ev of RULE_EVIDENCE) {
        const f = path.join(REPO, "recon", "upstream-full", ev.file);
        if (!fs.existsSync(f)) { mismatches.push({ ...ev, why: "源码文件不存在" }); continue; }
        const text = fs.readFileSync(f, "utf8");
        const m = text.match(ev.pattern);
        checked++;
        if (!m) { mismatches.push({ ...ev, why: "模式未匹配" }); continue; }
        if (Array.isArray(ev.expect)) {
            const got = m[1].split(",").map(s => Number(s.trim()));
            if (JSON.stringify(got.slice(0, ev.expect.length)) !== JSON.stringify(ev.expect)) {
                mismatches.push({ ...ev, got, why: "数值不符" });
            }
        } else if (ev.expect !== true) {
            const got = Number(m[1]);
            if (got !== ev.expect) mismatches.push({ ...ev, got, why: "数值不符" });
        }
    }

    /* ── UPGRADES：拿源码重算一遍，逐项对账 ──
     *
     * 这一步是「需求表漏了 carry-over」唯一能被抓住的地方。它不只是抽常量：
     * 它跑的是 regular.js 的**完整算法**（累积 + tierGrowth + findNiceIntegerValue）。 */
    const regFile = path.join(REPO, "recon", "upstream-full", "src/js/game/modes/regular.js");
    if (!fs.existsSync(regFile)) {
        mismatches.push({ rule: "UPGRADES", why: "regular.js 不存在" });
    } else {
        /* ⚠️ recon 里的上游源码是 **CRLF**（`file` 会明说），不归一化的话
           `indexOf("\n        ],")` 与 `/required: \[([\s\S]*?)\]/` 都会静默失配，
           表现成「解析不出源码里的 raw 档位」—— 一个看着像源码缺失的假失败。 */
        const src = fs.readFileSync(regFile, "utf8").replace(/\r\n/g, "\n");
        const fiMatch = src.match(/fixedImprovements\s*=\s*\[([\d.,\s]+)\]/);
        const tgMatch = src.match(/const tierGrowth\s*=\s*([\d.]+)/);
        const fixedImprovements = fiMatch ? fiMatch[1].split(",").map(s => Number(s.trim())) : null;
        const tierGrowth = tgMatch ? Number(tgMatch[1]) : null;
        if (!fixedImprovements || !tierGrowth) {
            mismatches.push({ rule: "UPGRADES", why: "regular.js 里找不到 fixedImprovements / tierGrowth" });
        } else {
            for (const [line, mine] of Object.entries(UPGRADES)) {
                checked++;
                const rawTiers = parseRawUpgradeTiers(src, line, mine.length);
                if (!rawTiers) { mismatches.push({ rule: `UPGRADES.${line}`, why: "解析不出源码里的 raw 档位" }); continue; }
                const truth = accumulateTiers(rawTiers, fixedImprovements, tierGrowth);
                const got = mine.map(t => ({ tier: t.tier, required: t.required.map(r => ({ shape: r.shape, amount: r.amount })) }));
                const want = truth.map(t => ({ tier: t.tier, required: t.required }));
                /* 顺序也参与比较：源码 unshift 之后 carry-over 在前、新档在后，是**确定**的。 */
                if (JSON.stringify(got) !== JSON.stringify(want)) {
                    mismatches.push({ rule: `UPGRADES.${line}`, why: "与源码重算结果不符", got, want });
                }
            }
        }
    }
    return { ok: mismatches.length === 0, checked, mismatches };
}

/* ═══════════════ 6. 配比计算 ═══════════════ */

/**
 * 给定升级等级，算出**填满一条带**需要几台某机器。
 *
 * ⚠️ 官方 tip #7 的真实含义：只有 belt 与 miner 同级时 5:1 才成立。
 * belt 升了而 miner 没升，需要的矿机数会变多（不是变少）。
 *
 * ★ 两个此前真实存在的 bug（2026-11-01 核对时发现）★
 *
 * 1. **倍率取错了线**：旧实现用 `levels[kind]` 当倍率，于是
 *    `machinesForOneBelt("cutter", { belt:0, processors:2 })` 会去读 `levels.cutter`
 *    （undefined → 1），报 4 台/带 —— 正确答案是 2 台（cutter 吃 **processors** 线）。
 *    painter/mixer 同理（吃 painting 线），stacker 吃 processors 线。
 *    现在走 `MACHINE_UPGRADE_LINE`（与 `machineRatePerSec` 同一份真值）。
 * 2. **倍率表抄了第二份**：这里曾经内联 `[1,1.5,2,3,4,6,7,8]` × 4 行 —— 改成引用
 *    `UPGRADE_MULTIPLIERS`。第四份真值是这个仓库最典型的开裂点。
 */
export function machinesForOneBelt(kind, levels = {}) {
    const beltMul = UPGRADE_MULTIPLIERS[Math.min(Math.max(levels.belt | 0, 0), UPGRADE_MULTIPLIERS.length - 1)];
    const beltSpeed = RATES.beltPerSec * beltMul;
    const machineSpeed = machineRatePerSec(kind, levels);
    if (machineSpeed === null) throw new Error(`machinesForOneBelt: 未知机器 ${kind}`);
    if (!Number.isFinite(machineSpeed)) return 0;
    if (machineSpeed <= 0) return Infinity;
    return Math.ceil(beltSpeed / machineSpeed);
}

if (process.argv[1] && process.argv[1].endsWith("rules.mjs")) {
    const r = verifyRules();
    console.log(`规则复核：${r.checked} 条，${r.ok ? "全部一致" : r.mismatches.length + " 条不符"}`);
    for (const m of r.mismatches) console.log("  ✗", m.rule, m.why, JSON.stringify(m.got));
    console.log("\n每带所需机器数（等级 0/0）:");
    for (const k of ["miner", "cutter", "painter", "stacker", "mixer"]) {
        console.log(`  ${k.padEnd(10)} ${machinesPerBelt(k)} 台/带`);
    }
    console.log("\nbell 升级后矿机需求（belt 升级而 miner 不升的陷阱）:");
    for (const b of [0, 1, 2, 3]) {
        console.log(`  belt L${b} / miner L0 ⇒ ${machinesForOneBelt("miner", { belt: b, miner: 0 })} 台矿机/带`);
    }
    process.exitCode = r.ok ? 0 : 1;
}
