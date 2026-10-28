#!/usr/bin/env node
/**
 * probe-hub-reach.mjs — 只读探针：看 BELTS 段里被点名的带子，哪些**真的接进了 hub**。
 *
 * 为什么需要它（2026-10-28 第二轮真 LLM 实验的直接产物）：
 *   5 次冷启动里 4 次，模型选中了 hub 环上的 `B135/B136/B137` —— 推理是
 *   「hub 没交货 ⇒ 问题在 hub 入口 ⇒ 把入口带子改成切割机」。听起来完全合理。
 *   但它错在事实层面：那三条带子**并不真的连通到 hub**。
 *
 *   模型没法知道这件事，因为 prompt 的 BELTS 段只写「上游=X 下游=Y 货=N」，
 *   没有任何字段说明"这条链能不能走到终点"。
 *
 * 本探针把那个缺失的事实算出来，用于：(a) 判断这个假设是否成立；
 * (b) 若成立，把它加成 BELTS 段的一个字段。
 *
 * 用法：node src/agent/probe-hub-reach.mjs [--json]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import FakeGame from "./fake_game.mjs";
import { buildHandles } from "./loop/handles.mjs";
import { DIRV, beltExit } from "../ai/belt-rules.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

const g = FakeGame.fromFiles(path.join(REPO, "test/fixtures/saves/L4-obs.json"), null, { goal: "RuRu----" });
const obs = g.observe({ max_entities: 50000 });
const tbl = buildHandles(obs, g.debugItems());

const ents = obs.entities || [];
const belts = ents.filter(e => e && (e.type === "belt" || e.type === "underground_belt"));
const at = new Map();
for (const e of ents) for (let dx = 0; dx < 1; dx++) at.set(`${e.x + dx},${e.y}`, e);

/** 带子出口格。rv 的字段在 obs 里叫 rotation_variant。 */
function exitCell(e) {
    const rv = Number.isInteger(e.rotation_variant) ? e.rotation_variant : 0;
    const r = Number(e.r) || 0;
    /* 用 belt-rules 的 beltExit —— 不自己写第二份方向表 */
    try {
        const dir = beltExit(rv, r);
        const d = DIRV[dir];
        if (d) return [e.x + d[0], e.y + d[1]];
    } catch { /* 落到下面的保守回退 */ }
    return [e.x, e.y - 1];
}

/* hub 占地：4×4，从 origin 起 */
const hub = ents.find(e => e && e.type === "hub");
const hubCells = new Set();
if (hub) for (let dx = 0; dx < 4; dx++) for (let dy = 0; dy < 4; dy++) hubCells.add(`${hub.x + dx},${hub.y + dy}`);

/* 反向可达：从「出口直接落进 hub 占地」的带子出发，沿"谁指向我"扩散 */
const reach = new Set();
const frontier = [];
for (const b of belts) {
    const ex = exitCell(b);
    if (hubCells.has(`${ex[0]},${ex[1]}`)) { reach.add(b.uid); frontier.push(b); }
}
for (let hop = 0; hop < 512 && frontier.length; hop++) {
    const next = [];
    for (const cur of frontier) {
        for (const b of belts) {
            if (reach.has(b.uid)) continue;
            const ex = exitCell(b);
            if (ex[0] === cur.x && ex[1] === cur.y) { reach.add(b.uid); next.push(b); }
        }
    }
    frontier.length = 0;
    frontier.push(...next);
}

const byUid = new Map(belts.map(b => [b.uid, b]));
const handleOf = uid => tbl.byUid.get(uid);

/* 三个在实验里被模型反复选中的位置 */
const WATCH = [10074, 10032, 10183];   // B135/B136/B137（hub 环，模型常选）
const TRUTH = [10209, 10149, 10143];   // B81/B82/B69（正解）

const rows = [];
for (const [label, uids] of [["hub 环（模型常选）", WATCH], ["正解三条", TRUTH]]) {
    for (const uid of uids) {
        const b = byUid.get(uid) || belts.find(x=>x.uid===uid);
        if (!b) { rows.push({ label, uid, handle: handleOf(uid) || "?", exists: false }); continue; }
        const ex = exitCell(b);
        const nextOwner = at.get(`${ex[0]},${ex[1]}`);
        rows.push({
            label,
            uid,
            handle: handleOf(uid) || "?",
            pos: [b.x, b.y],
            exitsTo: ex,
            exitsIntoHub: hubCells.has(`${ex[0]},${ex[1]}`),
            nextOwner: nextOwner ? `${nextOwner.type}${nextOwner.uid === undefined ? "" : "#" + nextOwner.uid}` : null,
            reachesHub: reach.has(uid),
        });
    }
}

if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ hub: hub ? [hub.x, hub.y] : null, reachable: reach.size, totalBelts: belts.length, rows }, null, 2));
} else {
    console.log("═".repeat(72));
    console.log(`hub @ ${hub ? `(${hub.x},${hub.y})` : "?"} · 能到 hub 的带子 ${reach.size}/${belts.length}`);
    console.log("═".repeat(72));
    for (const r of rows) {
        if (!r.exists) { console.log(`${r.label} ${r.handle} — 不存在`); continue; }
        console.log(`${r.label}  ${r.handle}(uid=${r.uid}) @(${r.pos})`);
        console.log(`   出口 → (${r.exitsTo})  下一格: ${r.nextOwner || "空"}  直入hub=${r.exitsIntoHub}  可达hub=${r.reachesHub}`);
    }
    console.log("");
    const watchReach = rows.filter(r => r.label.startsWith("hub") && r.reachesHub).length;
    const truthReach = rows.filter(r => r.label.startsWith("正解") && r.reachesHub).length;
    console.log(`模型常选的三条里，真正能到 hub 的：${watchReach}/3`);
    console.log(`正解三条里，真正能到 hub 的：${truthReach}/3`);
    console.log("");
    if (watchReach === 0 && truthReach === 0) {
        console.log("⚠ 两组都不可达 —— 那「可达性」本身区分不了它们，需要另外的线索。");
    } else if (watchReach > truthReach) {
        console.log("✓ 「可达性」解释了模型的误选：它选的那组确实更接近 hub。");
        console.log("  ⇒ 应该把这条路堵上：在 BELTS 段标注「这条链不接 hub」。");
    } else {
        console.log("△ 正解更可达 —— 模型选错了方向。");
    }
}
