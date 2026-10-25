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

    return r;
}

main()
    .then(() => process.exit(0))
    .catch(e => { console.error("ERROR:", e.message); process.exit(2); });
