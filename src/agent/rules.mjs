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
    /** 传送带基础速度（config.js:81 beltSpeedItemsPerSecond） */
    beltPerSec: 2,
    /** 矿机基础速度 = 带速 / 5（config.js:151 自动计算） */
    minerPerSec: 0.4,
    /** 各机器的每 charge 速度（config.js:101-113）—— 喂满一条带要几台 */
    machinePerSec: {
        miner: 0.4,
        cutter: 0.5,
        rotater: 2.0,
        painter: 1 / 3,
        painterDouble: 0.5,     // 标称；实测慢约 10%，见 MACHINES 的 note
        mixer: 0.4,
        stacker: 0.25,
        trash: Infinity,
    },
});

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

/** 累计倍率阶梯（fixedImprovements 的前 7 档，regular.js:80） */
export const UPGRADE_MULTIPLIERS = Object.freeze([1, 1.5, 2, 3, 4, 6, 7, 8]);

/** 四条升级线的 T1..T3 需求（regular.js:107-238）。null = 该档未核实。 */
export const UPGRADES = Object.freeze({
    belt: [
        { tier: 1, required: [{ shape: "CuCuCuCu", amount: 30 }] },
        { tier: 2, required: [{ shape: "--CuCu--", amount: 500 }, { shape: "CuCuCuCu", amount: 75 }] },
        { tier: 3, required: [{ shape: "CpCpCpCp", amount: 1000 }] },
    ],
    miner: [
        { tier: 1, required: [{ shape: "RuRuRuRu", amount: 300 }] },
        { tier: 2, required: [{ shape: "Cu------", amount: 800 }, { shape: "RuRuRuRu", amount: 740 }] },
        { tier: 3, required: [{ shape: "ScScScSc", amount: 3500 }] },
    ],
    processors: [
        { tier: 1, required: [{ shape: "SuSuSuSu", amount: 500 }] },
        { tier: 2, required: [{ shape: "RuRu----", amount: 600 }] },
        { tier: 3, required: [{ shape: "CgScScCg", amount: 3500 }] },
    ],
    painting: [
        { tier: 1, required: [{ shape: "RbRb----", amount: 600 }] },
        { tier: 2, required: [{ shape: "WrWrWrWr", amount: 3800 }] },
        { tier: 3, required: [{ shape: "RpRpRpRp:CwCwCwCw", amount: 6500 }] },
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
    { rule: "固定矿点：铜", file: "src/js/game/map_chunk.js", pattern: /this\.x === -1 && this\.y === 0[\s\S]{0,200}mapChunkSize - 9/, expect: true },
    { rule: "固定矿点：钌", file: "src/js/game/map_chunk.js", pattern: /this\.x === 0 && this\.y === -1[\s\S]{0,200}mapChunkSize - 7/, expect: true },
]);

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
    return { ok: mismatches.length === 0, checked, mismatches };
}

/* ═══════════════ 6. 配比计算 ═══════════════ */

/**
 * 给定升级等级，算出**填满一条带**需要几台某机器。
 *
 * ⚠️ 官方 tip #7 的真实含义：只有 belt 与 miner 同级时 5:1 才成立。
 * belt 升了而 miner 没升，需要的矿机数会变多（不是变少）。
 */
export function machinesForOneBelt(kind, levels) {
    const ladder = { belt: [1, 1.5, 2, 3, 4, 6, 7, 8], miner: [1, 1.5, 2, 3, 4, 6, 7, 8],
        processors: [1, 1.5, 2, 3, 4, 6, 7, 8], painting: [1, 1.5, 2, 3, 4, 6, 7, 8] };
    const beltMul = ladder.belt[Math.min(levels.belt || 0, 7)];
    const lineMul = ladder[kind] ? ladder[kind][Math.min(levels[kind] || 0, 7)] : 1;
    const beltSpeed = RATES.beltPerSec * beltMul;
    const machineSpeed = RATES.machinePerSec[kind] * lineMul;
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
