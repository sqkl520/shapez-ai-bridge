/**
 * G4 真实性检查：按游戏**实际**的 obs 形态构造 before/after。
 *
 * 游戏里一台多格机器（cutter 2×1）在 obs 里**只有一条记录**，坐标是原点。
 * 所以 after 里每台机器只有一格有实体，而 gateG4 用展开后的格去要求"每格都有"。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve("D:/Projects/rea/Project work/shapez");
const { gateG4, expectedCells, entityCells } = await import(
    pathToFileURL(path.join(ROOT, "src/agent/gates.mjs")).href);

const intent = JSON.parse(fs.readFileSync(
    path.join(ROOT, "research/ai-plan/tmp/RuRu----.anchor40-60.intent.json"), "utf8"));

const a = intent.anchor;
// 忠实模拟：每台机器在 obs 里只出现一次，坐标 = 原点
const added = intent.entities.map((e, i) => ({
    uid: 30000 + i, type: e.kind, x: a[0] + e.dx, y: a[1] + e.dy,
    r: e.rot | 0, code: e.code, variant: "default",
}));

const mk = list => ({
    entities: list,
    byUid: new Map(list.map(e => [e.uid, e])),
    byCell: new Map(list.map(e => [`${e.x},${e.y}`, e])),
});

const before = mk([{ uid: 9001, type: "belt", x: 0, y: 0, r: 0, code: 1 }]);
const after = mk([...before.entities, ...added]);

const r = gateG4(intent, before, after);
console.log("── 忠实模拟：每台机器只在原点有一条 obs 记录 ──");
console.log("ok      :", r.ok);
console.log("reason  :", r.reason ?? "(null)");
console.log("evidence:", JSON.stringify(r.evidence));

console.log("\n── gate 的 footprint 表 vs 游戏真实尺寸 ──");
const GAME = { hub: [1, 1], miner: [1, 1], cutter: [2, 1], trash: [1, 1], rotater: [1, 1] };
for (const [kind, truth] of Object.entries(GAME)) {
    const gateCells = entityCells(kind, 0, 0, 0);
    const want = truth[0] * truth[1];
    console.log(`${kind.padEnd(8)} gate=${gateCells.length} 格  游戏=${want} 格  `
        + (gateCells.length === want ? "✓" : "✗ 不一致"));
}
