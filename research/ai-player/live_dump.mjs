/**
 * live_dump.mjs — 为「AI 玩家方案」研究准备实机数据基座。
 *
 * 做四件事（幂等、可重跑）：
 *   1) snapshot_save "ai-research-base"（实验前基线，可回滚）
 *   2) load_save 指定存档（默认 level-11 档）
 *   3) 全量 obs → facts/live/world-full.json
 *   4) hub 区域 obs + resources + 摘要 → facts/live/*.json + world-summary.md
 *
 * 用法：node research/ai-player/live_dump.mjs [--save <internal_id>] [--no-load]
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const BASE = (process.env.SHAPEZ_BRIDGE_URL || "http://127.0.0.1:7777").replace(/\/+$/, "");
const OUT = path.join(import.meta.dirname, "facts", "live");
fs.mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SAVE_ID = argVal("--save", "5c96706563c0b74c4d2ce4c7f8bf7a244392de89");
const NO_LOAD = args.includes("--no-load");

let rpcId = 1;
async function rpc(method, params = {}, timeoutMs = 300000) {
    const res = await fetch(`${BASE}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", connection: "close" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json();
    if (body.error) { const e = new Error(body.error.message); e.rpc = body.error; throw e; }
    return body.result;
}

const write = (name, obj) => {
    const p = path.join(OUT, name);
    fs.writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj, null, 1));
    console.log(`  wrote ${name} (${(fs.statSync(p).size / 1024).toFixed(1)} KB)`);
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
    // 0) 桥接/游戏状态
    const st0 = await rpc("status", {});
    console.log("status:", JSON.stringify(st0));
    if (!st0.in_game && !NO_LOAD) {
        try {
            console.log("snapshot_save ai-research-base ...");
            const snap = await rpc("snapshot_save", { name: "ai-research-base" });
            console.log("  snapshot:", JSON.stringify(snap));
        } catch (e) { console.log("  snapshot failed (continuing):", e.message); }
        console.log(`load_save ${SAVE_ID} ...`);
        try { await rpc("load_save", { internal_id: SAVE_ID }); } catch (e) { console.log("  load failed:", e.message); }
        for (let i = 0; i < 40; i++) {
            await sleep(1000);
            const st = await rpc("status", {}, 8000);
            if (st.in_game) { console.log(`  in_game after ~${i + 1}s`); break; }
        }
    }

    const st = await rpc("status", {});
    write("status.json", st);
    if (!st.in_game) { console.log("NOT IN GAME — stopping. Load a save manually and rerun with --no-load."); return; }

    // 1) 全量观测（大上限；如实反映 truncated）
    console.log("full obs ...");
    const full = await rpc("obs", { max_entities: 20000, include_hub: true, include_stats: true, include_resources: true, max_resources: 3000 });
    write("world-full.json", full);

    // 2) hub 周边 40x40 观测（细看进料结构）
    const hub = (full.entities || []).find(e => e.type === "hub");
    if (hub) {
        console.log(`hub at (${hub.x},${hub.y}) — region obs ...`);
        const r = await rpc("obs", { region: [hub.x - 40, hub.y - 40, hub.x + 44, hub.y + 44], max_entities: 6000, include_hub: true });
        write("world-hub-region.json", r);
    }

    // 3) 资源清单单独存一份（大图）
    if (full.resources) write("resources.json", full.resources);

    // 4) 人类可读摘要
    const byType = Object.entries(full.stats.by_type).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join("  ");
    const goal = full.goal ? `level ${full.goal.level} — ${full.goal.requirement.shape} ${full.goal.requirement.delivered}/${full.goal.requirement.required}${full.goal.requirement.throughput_only ? " [throughput]" : ""}` : "(no goal)";
    const stock = full.hub ? Object.entries(full.hub.stored_shapes).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join("  ") : "(no hub data)";
    const up = full.goal ? JSON.stringify(full.goal.upgrade_levels) : "";
    const costs = full.hub && full.hub.blueprint_cost !== undefined ? full.hub.blueprint_cost : "n/a";
    const md = [
        `# 实机世界摘要（自动生成，live_dump.mjs）`,
        ``,
        `- 游戏版本: ${full.game_version}  tick=${full.tick}  speed=${full.speed}  paused=${full.paused}`,
        `- 目标: ${goal}`,
        `- 升级等级: ${up}   蓝图成本样本: ${costs}`,
        `- 实体: total=${full.stats.total}  truncated=${!!full.truncated} entity_count=${full.entity_count}`,
        `- 按类型: ${byType}`,
        `- hub 位置: ${hub ? `(${hub.x},${hub.y}) rot=${hub.r}` : "未发现"}`,
        `- hub 库存(>0): ${stock}`,
        `- 资源格: ${full.resources ? full.resources.length : "n/a"} 格（详见 resources.json）`,
        ``,
        `## 地图包围盒`,
        ``,
        `- region: ${JSON.stringify(full.region)}`,
        ``,
        `## 文件`,
        ``,
        `- \`world-full.json\` — 全量观测（可能 truncated；stats 恒为全量）`,
        `- \`world-hub-region.json\` — hub ±40 格精细观测`,
        `- \`resources.json\` — [x,y,shape] 资源格列表`,
        `- \`status.json\` — 状态`,
    ].join("\n");
    write("world-summary.md", md);
    console.log("done.");
}

main().catch(e => { console.error("FATAL:", e.message, e.rpc ? JSON.stringify(e.rpc) : ""); process.exit(1); });
