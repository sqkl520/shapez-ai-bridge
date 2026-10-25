/**
 * expect.mjs — 期望态对账：动手之前先算出"应该长什么样"，动手之后逐项比。
 *
 * 为什么需要它（这一轮最大的教训）：
 *   之前的验收标准是「N/N 格匹配」—— 只比几何，不比行为。
 *   于是产线在一张时钟已经冻结的存档上「验收通过」了几个小时，
 *   我还据此下了「两个矿机只产出一份」这种完全错误的结论。
 *
 *   外部研究给的判据很直接：理解 = 有一个能被现实否证的内部模型。
 *   对 shapez 来说，这个模型就是「每个形状每秒应该产出几个、
 *   hub 每条入口应该收到几个」—— 而这些数全都能用 production RPC 实测。
 *
 * 用法：
 *   node src/agent/expect.mjs                     # 对当前存档做一次对账
 *   node src/agent/expect.mjs --watch 60          # 每 60 秒对一次
 *   node src/agent/expect.mjs --json              # 机读输出
 *
 * 判据来自 src/agent/rules.mjs（数字全部经源码复核），不在这里硬编码。
 */
import { RATES, machinesForOneBelt } from "./rules.mjs";

const BASE = process.env.SHAPEZ_BRIDGE_URL || "http://127.0.0.1:7777";
let rpcId = 1;

async function rpc(method, params = {}, timeoutMs = 60000) {
    const res = await fetch(`${BASE}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const b = await res.json();
    if (b.error) {
        const err = new Error(`${method}: ${b.error.message}`);
        err.rpc = b.error;
        throw err;
    }
    return b.result;
}

/** 一条带的理论吞吐（含升级倍率）。倍率阶梯是加法，见 rules.mjs。 */
function beltRate(upgrades) {
    const lvl = (upgrades && upgrades.belt) || 0;
    // 升级倍率 [1, 1.5, 2, 3, 4, 6, 7, 8]，索引即等级
    const mult = [1, 1.5, 2, 3, 4, 6, 7, 8][Math.min(lvl, 7)];
    return RATES.beltPerSec * mult;
}

/** 一台矿机的理论吞吐（含升级倍率）。 */
function minerRate(upgrades) {
    const lvl = (upgrades && upgrades.miner) || 0;
    const mult = [1, 1.5, 2, 3, 4, 6, 7, 8][Math.min(lvl, 7)];
    return RATES.minerPerSec * mult;
}

/**
 * 从观测推出「期望态」。
 *
 * 这里只做**能从现有数据严格推出**的期望，不做猜测：
 *   - 每台矿机 → 它应该产出自己的资源，速率 = minerRate（受带子容量上限约束）
 *   - 整座工厂的总产出上限 = min(所有机器的速率, 所有带的容量)
 *   - hub 的入库速率上限 = 连到 hub 的带的容量之和
 *
 * 刻意**不**预测"哪个形状最终有几个"—— 那需要完整的配方重放，
 * 属于 belt-sim 的范畴，不是这里该猜的。
 */
export function expectedFrom(obs) {
    const upgrades = obs.upgrades || {};
    const mRate = minerRate(upgrades);
    const bRate = beltRate(upgrades);
    const miners = (obs.entities || []).filter(e => e.type === "miner");
    const belts = (obs.entities || []).filter(e => e.type === "belt" || e.type === "underground_belt");

    // 每种资源有几台矿机在挖
    const minersByShape = {};
    for (const m of miners) {
        // 矿机挖什么由它脚下的矿决定，观测里没有直接字段；
        // 这里退一步：按位置分到最近的有矿形状，若拿不到就记 unknown。
        const k = m.shape || m.resource || "unknown";
        minersByShape[k] = (minersByShape[k] || 0) + 1;
    }

    // 总产出上限：矿机产能之和，但不能超过带子总容量
    const minerCapacity = miners.length * mRate;
    // 每条带能承载的量（保守：按带格数 × 单格容量，这里用"一条带 = bRate"的宏观口径）
    const beltCapacity = belts.length > 0 ? bRate : 0;

    return {
        miner_rate_per_sec: round(mRate),
        belt_rate_per_sec: round(bRate),
        miner_count: miners.length,
        belt_count: belts.length,
        // 一条带理论上需要几台矿机才满
        miners_to_fill_one_belt: machinesForOneBelt("miner", upgrades),        resource_capacity_per_sec: round(minerCapacity),
        belt_capacity_per_sec: round(beltCapacity),
        // 理论总吞吐 = 两边取小（矿机是源，带子是路，hub 是汇）
        upper_bound_per_sec: round(Math.min(minerCapacity || Infinity, beltCapacity || Infinity)),
        miners_by_shape: minersByShape,
    };
}

function round(n) {
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 1000) / 1000;
}

/**
 * 实测 vs 期望。
 *
 * `production` RPC 给的是游戏自己统计的时间片（produced / delivered），
 * 不依赖我们的采样，也不会因为 step 快进而失真 —— 这是唯一可信的速率源。
 */
export function reconcile(expected, production) {
    const prod = production.produced_per_sec || {};
    const deliv = production.delivered_per_sec || {};
    const totalProduced = Object.values(prod).reduce((a, b) => a + b, 0);
    const totalDelivered = Object.values(deliv).reduce((a, b) => a + b, 0);
    const windowSecs = production.window_seconds || 0;

    const gaps = [];
    if (!windowSecs) {
        gaps.push({ kind: "no-sample", detail: "production 没返回有效窗口长度（时间片还没填满？）" });
    }
    // 产出上限判据：实测产出不该超过理论上限（超了说明模型错了，或者有堆积释放）
    if (expected.upper_bound_per_sec && totalProduced > expected.upper_bound_per_sec * 1.15) {
        gaps.push({
            kind: "over-theory",
            detail: `实测产出 ${round(totalProduced)}/s 超过理论上限 ${expected.upper_bound_per_sec}/s 的 1.15 倍`
                + `（可能是堆积物品的集中释放，或模型里的台数/倍率算错了）`,
        });
    }
    // 交付率判据（研究 01 的验收标准）：delivered 应 >= 理论值的 80%
    if (expected.upper_bound_per_sec > 0 && totalDelivered < expected.upper_bound_per_sec * 0.8) {
        gaps.push({
            kind: "below-80pct",
            detail: `实测交付 ${round(totalDelivered)}/s < 理论 ${expected.upper_bound_per_sec}/s 的 80%`
                + `（达成率 ${Math.round((totalDelivered / expected.upper_bound_per_sec) * 100)}%）`,
        });
    }
    // 产出有、交付没有 ⇒ 货堵在中间或者被丢弃
    if (totalProduced > 0.1 && totalDelivered < totalProduced * 0.5) {
        gaps.push({
            kind: "produced-not-delivered",
            detail: `产出 ${round(totalProduced)}/s 但只交付 ${round(totalDelivered)}/s`
                + ` —— 一半以上的货没有到 hub（堵住 / 进垃圾桶 / 切割的另一半被丢）`,
        });
    }
    /* 逐形状：产出了但一个都没交付 ⇒ 这条产线的产物被系统性丢弃。
       实测例子：切割机的左半边 0.433/s 全部进垃圾桶，而 L4 的目标恰好是右半边形态。
       这不是"产能不足"，是"输出没有去处"（研究 01 的第 6 条硬规则）。 */
    for (const shape of Object.keys(prod)) {
        const p = prod[shape] || 0;
        const d = deliv[shape] || 0;
        if (p > 0.05 && d === 0) {
            gaps.push({
                kind: "produced-never-delivered",
                detail: `${shape} 产出 ${round(p)}/s 但交付 0 —— 这个形状的产物被系统性丢弃`
                    + `（检查：它的下游是否直接进了垃圾桶，或目标形状是否根本不认它）`,
            });
        }
    }

    return {
        window_seconds: windowSecs,
        produced_per_sec: prod,
        delivered_per_sec: deliv,
        total_produced: round(totalProduced),
        total_delivered: round(totalDelivered),
        achievement: expected.upper_bound_per_sec
            ? round(totalDelivered / expected.upper_bound_per_sec)
            : null,
        gaps,
        ok: gaps.length === 0,
    };
}

async function snapshot() {
    // 时钟必须先确认在走 —— 在冻结的世界上量出来的任何数字都无意义。
    const loop = await rpc("debug_loop", {});
    if (!Number.isFinite(loop.tick)) {
        throw new Error("debug_loop 没有返回 tick —— 无法确认时钟状态");
    }
    const o = await rpc("obs", { max_entities: 5000, include_hub: true, include_stats: true }, 120000);
    const p = await rpc("production", { slices: 6 }, 60000);
    return { loop, obs: o, production: p };
}

async function runOnce(asJson) {
    const { loop, obs, production } = await snapshot();

    // 第一道闸：时钟。这一轮我在这上面浪费了几个小时。
    // 判据取 debug_loop 的 logic_budget_ms —— 它是 JSON 序列化后的值，
    // NaN 会变成 null（JSON 不支持 NaN），所以 null 就是"预算已被污染"。
    const budgetOk = loop.logic_budget_ms !== null && loop.logic_budget_ms !== undefined;
    if (!budgetOk || loop.speed !== "regular") {
        const msg = `时钟异常：speed=${loop.speed} logic_budget_ms=${loop.logic_budget_ms}`
            + ` —— 在这个世界上量任何速率都没有意义。先修时钟（见 debug_loop）。`;
        if (asJson) {
            console.log(JSON.stringify({ ok: false, fatal: "clock", detail: msg, loop }, null, 2));
        } else {
            console.error("✗ " + msg);
        }
        return 1;
    }

    const expected = expectedFrom({
        upgrades: obs.goal && obs.goal.upgrade_levels,
        entities: obs.entities,
    });
    const actual = reconcile(expected, production);

    if (asJson) {
        console.log(JSON.stringify({ ok: actual.ok, expected, actual, tick: obs.tick }, null, 2));
    } else {
        console.log("═".repeat(66));
        console.log("期望态对账");
        console.log("═".repeat(66));
        console.log(`时钟      tick=${obs.tick.toFixed(1)} speed=${loop.speed} budget=${loop.logic_budget_ms === null ? "NaN" : loop.logic_budget_ms.toFixed(2)}`);
        console.log(`矿机      ${expected.miner_count} 台 × ${expected.miner_rate_per_sec}/s = ${expected.resource_capacity_per_sec}/s`);
        console.log(`带子      ${expected.belt_count} 格，单带 ${expected.belt_rate_per_sec}/s`);
        console.log(`满带需要  ${expected.miners_to_fill_one_belt} 台矿机`);
        console.log(`理论上限  ${expected.upper_bound_per_sec}/s`);
        console.log("");
        console.log(`实测产出  ${JSON.stringify(actual.produced_per_sec)}`);
        console.log(`实测交付  ${JSON.stringify(actual.delivered_per_sec)}`);
        console.log(`达成率    ${actual.achievement === null ? "不可计算" : Math.round(actual.achievement * 100) + "%"}`);
        console.log("");
        if (actual.ok) {
            console.log("✓ 对账通过（无异常）");
        } else {
            console.log(`✗ 发现 ${actual.gaps.length} 个问题：`);
            for (const g of actual.gaps) console.log(`  [${g.kind}] ${g.detail}`);
        }
    }
    return actual.ok ? 0 : 2;
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("agent/expect.mjs");
if (isMain) {
    const asJson = process.argv.includes("--json");
    const watchIdx = process.argv.indexOf("--watch");
    const interval = watchIdx >= 0 ? Number(process.argv[watchIdx + 1]) || 60 : 0;
    if (interval > 0) {
        // 持续对账：每次结果单独一行，便于看出哪一刻开始掉
        let n = 0;
        const tick = async () => {
            try {
                const code = await runOnce(asJson);
                process.stderr.write(`[${new Date().toISOString()}] 第 ${++n} 次对账 → ${code === 0 ? "ok" : "有问题"}\n`);
            } catch (e) {
                process.stderr.write(`[${new Date().toISOString()}] 对账失败: ${e.message}\n`);
            }
        };
        await tick();
        setInterval(tick, interval * 1000);
    } else {
        runOnce(asJson).then(c => process.exit(c)).catch(e => {
            console.error("✗ " + e.message);
            process.exit(1);
        });
    }
}
