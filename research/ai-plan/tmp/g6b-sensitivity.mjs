/**
 * G6b 灵敏度验证：伪造 debug_items 的 paths 打 gateG6b。
 * 关键：场景 B 是"空的死路"（itemsOnPath=0 且 boundAcceptor=null），
 * 用来证明判据真的不看 itemsOnPath。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve("D:/Projects/rea/Project work/shapez");
const { gateG6b, expectedCells } = await import(pathToFileURL(path.join(ROOT, "src/agent/gates.mjs")).href);

const file = path.join(ROOT, "research/ai-plan/tmp/RuRu----.anchor40-60.intent.json");
const intent = JSON.parse(fs.readFileSync(file, "utf8"));

const cells = expectedCells(intent);
const beltKeys = [...cells].filter(([, v]) => v.kind === "belt" || v.kind === "underground_belt").map(([k]) => k);
console.log(`蓝图带子格数 = ${beltKeys.length}，anchor=[${intent.anchor}]`);

const parse = k => k.split(",").map(Number);

function show(label, r) {
    console.log(`\n── ${label} ──`);
    console.log("ok     :", r.ok);
    console.log("reason :", r.reason ?? "(null)");
    console.log("evidence:", JSON.stringify(r.evidence));
    if (r.hint) console.log("hint   :", r.hint);
}

// 基线：把全部带子格塞进一条 path，boundAcceptor 非空 → 应绿
const allPath = {
    cells: beltKeys.map(parse),
    boundAcceptor: { x: 0, y: 0, type: "hub" },
    itemsOnPath: 0,
};
show("基线：一条覆盖全部带子格、有接收者的路径",
    gateG6b(intent, { paths: [allPath] }));

// 场景 A：某条路径 boundAcceptor = null（死路），有物品
const deadPath = {
    cells: [parse(beltKeys[0]), parse(beltKeys[1])],
    boundAcceptor: null,
    itemsOnPath: 3,
};
const restA = beltKeys.slice(2).map(parse);
show("场景 A：一段 2 格路径 boundAcceptor=null，itemsOnPath=3（有货的死路）",
    gateG6b(intent, { paths: [deadPath, { cells: restA, boundAcceptor: { x: 0, y: 0 }, itemsOnPath: 0 }] }));

// 场景 B：同样的死路，但 itemsOnPath = 0 —— 空的死路
const emptyDeadPath = { ...deadPath, itemsOnPath: 0 };
show("场景 B：同一段死路，itemsOnPath=0（空的死路 —— 验证判据不看 itemsOnPath）",
    gateG6b(intent, { paths: [emptyDeadPath, { cells: restA, boundAcceptor: { x: 0, y: 0 }, itemsOnPath: 0 }] }));

// 额外：完全没有任何路径 → uncovered 应当红（证明第二道判据也活着）
show("附加：paths=[] —— 所有带子格都没被覆盖",
    gateG6b(intent, { paths: [] }));
