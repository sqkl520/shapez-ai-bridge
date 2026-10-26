/**
 * look.mjs — 把实机观测喂给 assess，说出"现在该干什么"。
 *
 * 用法：node src/agent/look.mjs
 *
 * 这是"像人一样玩"的第一个真正可用的循环：
 *   观测真实存档 → 按源码规则评估 → 输出可执行的下一步
 *
 * 不猜、不硬编码：所有判断都来自 assess.mjs（规则来自 rules.mjs 的源码复核）。
 */
import { assess } from "./assess.mjs";

const BASE = process.env.SHAPEZ_BRIDGE_URL || "http://127.0.0.1:7777";
let id = 1;
async function rpc(method, params = {}) {
    const res = await fetch(`${BASE}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
        signal: AbortSignal.timeout(120000),
    });
    const b = await res.json();
    if (b.error) throw new Error(`${method}: ${b.error.message}`);
    return b.result;
}

async function main() {
    const st = await rpc("status", {}, 15000);
    if (!st.in_game) throw new Error("没进游戏");

    // 一次拿全：实体 + 库存 + 目标 + 资源
    const o = await rpc("obs", {
        max_entities: 5000, include_hub: true, include_stats: true,
        include_resources: true, max_resources: 20000,
        region: [-60, -60, 60, 60],
    }, 180000);

    const obs = {
        level: o.goal.level,
        goal: {
            shape: o.goal.requirement.shape,
            required: o.goal.requirement.required,
            delivered: o.goal.requirement.delivered,
        },
        stored: o.hub.stored_shapes || {},
        upgrades: o.goal.upgrade_levels || {},
        entities: (o.entities || []).map(e => ({ type: e.type, x: e.x, y: e.y })),
        oreCells: (o.resources || []).map(([x, y, kind]) => ({ x, y, kind })),
    };

    const r = assess(obs);

    console.log("═══ 现在 ═══");
    console.log(`关卡 L${r.level}  目标 ${r.goal.shape}  ${r.goal.delivered}/${r.goal.required}（差 ${r.goal.remaining}）`);
    console.log(`升级: ${Object.entries(r.upgrades).map(([k, v]) => `${k} L${v.tier - 1}`).join("  ")}`);
    console.log(`\n${r.headline}`);

    console.log("\n═══ 矿点利用 ═══");
    for (const u of r.oreUtilization) {
        const bar = "█".repeat(Math.round(u.utilization * 10)) + "░".repeat(10 - Math.round(u.utilization * 10));
        console.log(`  ${u.kind.padEnd(10)} ${bar} ${u.used}/${u.available}`);
    }

    console.log("\n═══ 下一步 ═══");
    for (const a of r.actions) {
        console.log(`  [P${a.priority}] ${a.kind}`);
        console.log(`        ${a.reason}`);
        if (a.suggestedMiners !== undefined) console.log(`        建议再加 ${a.suggestedMiners} 台矿机`);
        if (a.marginalGain !== null && a.marginalGain !== undefined) console.log(`        每加一台矿机省 ${a.marginalGain}s`);
    }

    /* 结构审计（研究 01 §8 的 R1~R8）。
       为什么放在最后而不是开头：`assess` 回答"下一步做什么"，
       这里回答"现在这座工厂结构上有没有病"。一个能跑的工厂也可能结构全错
       （实测：铜线 4 台矿机里 2 台永久卡死，而总产量看起来正常）。 */
    try {
        const { checkR1, checkR2, checkR3, checkR4 } = await import("./audit.mjs");
        const auditObs = {
            upgrades: obs.upgrades || {},
            entities: obs.entities || [],
            oreCells: obs.oreCells || [],
            goal: { level: obs.level, shape: obs.goal.shape },
        };
        const before = await rpc("debug_items", { region: [-60, -60, 60, 60] }, 120000);
        await rpc("act", { op: "step", ticks: 2400 });
        const after = await rpc("debug_items", { region: [-60, -60, 60, 60] }, 120000);

        const results = [checkR1(auditObs), checkR2(auditObs), checkR3(after, before), checkR4(auditObs)];
        const problems = results.flatMap(x => x.problems);
        console.log("\n═══ 结构审计 ═══");
        if (!problems.length) {
            console.log("  ✓ R1~R4 全部通过");
        } else {
            for (const p of problems) console.log(`  [${p.rule}] ${p.detail}`);
        }
    } catch (e) {
        console.log(`\n═══ 结构审计 ═══\n  （跳过：${e.message}）`);
    }

    return r;
}

main()
    .then(() => process.exit(0))
    .catch(e => { console.error("ERROR:", e.message); process.exit(2); });
