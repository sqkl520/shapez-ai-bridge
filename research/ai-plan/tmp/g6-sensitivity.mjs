/**
 * G6 灵敏度验证。
 *  A) 两次完全相同的 production → 应红
 *  B) 按 gate 期望的模型"涨了"（窗口前进、速率上升）→ 应绿
 *  C) 真实桥的两次连续采样（只读，零写入）→ 看这道闸在真数据下是什么行为
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve("D:/Projects/rea/Project work/shapez");
const { gateG6 } = await import(pathToFileURL(path.join(ROOT, "src/agent/gates.mjs")).href);

const intent = JSON.parse(fs.readFileSync(
    path.join(ROOT, "research/ai-plan/tmp/RuRu----.anchor40-60.intent.json"), "utf8"));
const SHAPE = intent.goal;
console.log(`goal=${SHAPE}，实体数=${intent.entities.length}，`
    + `miner=${intent.entities.filter(e => e.kind === "miner").length}`);

// gateG6 的 expectedRatePerSec 由调用方算：miners * 0.4 * mul
const EXPECTED = 1 * 0.4 * 1;   // 1 台矿机，无升级
console.log(`expectedRatePerSec = ${EXPECTED} ⇒ 阈值 = ${(EXPECTED * 0.8).toFixed(3)}/s`);

function show(label, r) {
    console.log(`\n── ${label} ──`);
    console.log("ok     :", r.ok);
    console.log("reason :", r.reason ?? "(null)");
    console.log("evidence:", JSON.stringify(r.evidence));
    if (r.hint) console.log("hint   :", r.hint);
}

// A) 两次完全相同 —— 模拟"产量没涨"
const same = { window_seconds: 30, delivered_per_sec: { [SHAPE]: 0.5 } };
show("场景 A：两次采样完全相同（window=30 都，速率都 0.5/s）",
    gateG6(intent, same, { ...same }));

// B) 按 gate 的模型：窗口前进 60s，速率 +0.8/s → 应当过阈值 0.32
const p1 = { window_seconds: 30, delivered_per_sec: { [SHAPE]: 0.5 } };
const p2 = { window_seconds: 90, delivered_per_sec: { [SHAPE]: 1.3 } };
show("场景 B：窗口前进 60s，速率 0.5 → 1.3/s（delta=0.8 > 0.32）",
    gateG6(intent, p1, p2, EXPECTED));

// B2) 涨了但不够 —— 应红（证明不是只看"涨没涨"）
show("场景 B2：窗口前进 60s，速率 0.5 → 0.7/s（delta=0.2 < 0.32）",
    gateG6(intent, p1, { window_seconds: 90, delivered_per_sec: { [SHAPE]: 0.7 } }, EXPECTED));

// B3) 传 NaN/undefined 的理论值 —— 观察它是否 fail-open
show("场景 B3：expectedRatePerSec 缺失（undefined）—— 看是否 fail-open",
    gateG6(intent, p1, p2));

// C) 真实桥两次连续采样（只读）
const rpc = async (method, params = {}) => {
    const r = await fetch("http://127.0.0.1:7777/rpc", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const b = await r.json();
    if (b.error) throw new Error(b.error.message);
    return b.result;
};
const real1 = await rpc("production", { slices: 3 });
await new Promise(r => setTimeout(r, 3000));
const real2 = await rpc("production", { slices: 3 });
console.log("\n真实采样 1: window=" + real1.window_seconds
    + " delivered_per_sec=" + JSON.stringify(real1.delivered_per_sec));
console.log("真实采样 2: window=" + real2.window_seconds
    + " delivered_per_sec=" + JSON.stringify(real2.delivered_per_sec));
show("场景 C：真实桥的两次连续采样，喂给 gateG6", gateG6(intent, real1, real2, EXPECTED));
