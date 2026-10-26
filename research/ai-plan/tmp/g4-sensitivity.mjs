/**
 * G4 灵敏度验证：用伪造的 before/after 快照打 gateG4。
 * 不写游戏，纯本地。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve("D:/Projects/rea/Project work/shapez");
const GATES = pathToFileURL(path.join(ROOT, "src/agent/gates.mjs")).href;
const { gateG4, expectedCells } = await import(GATES);

const intent = JSON.parse(fs.readFileSync(
    path.join(ROOT, "research/ai-plan/tmp/RuRu----.anchor40-60.intent.json"), "utf8"));

// 一个"既有实体"，uid 9001，模拟真实工厂里的一条旧带子
const existing = { uid: 9001, type: "belt", x: 0, y: 0, r: 0, code: 1, variant: "default" };

// 按蓝图展开出"新贴的实体"（每格一个，只为验证逐格比对，够用）
const cells = expectedCells(intent);
let uid = 20000;
const added = [];
for (const [k, v] of cells) {
    const [x, y] = k.split(",").map(Number);
    added.push({ uid: uid++, type: v.kind, x, y, r: 0, code: v.code, variant: "default" });
}

const mkSnap = (list) => ({
    entities: list,
    byUid: new Map(list.map(e => [e.uid, e])),
    byCell: new Map(list.map(e => [`${e.x},${e.y}`, e])),
});

const before = mkSnap([existing]);
const afterGood = mkSnap([existing, ...added]);

function show(label, r) {
    console.log(`\n── ${label} ──`);
    console.log("ok     :", r.ok);
    console.log("reason :", r.reason ?? "(null)");
    console.log("evidence:", JSON.stringify(r.evidence));
    if (r.hint) console.log("hint   :", r.hint);
}

// 0) 基线：应当绿（证明这个 gate 不是无脑红）
show("基线：before 的 uid 都在，每格 code 都对", gateG4(intent, before, afterGood));

// A) 静默销毁：after 里少了 before 的 uid 9001
const afterVanished = mkSnap(added);
show("场景 A：after 少了 before 的 uid 9001（静默销毁）", gateG4(intent, before, afterVanished));

// B) code 与意图不符：把蓝图里第一格的新实体 code 改掉
const bad = added.map(e => ({ ...e }));
const firstCell = [...cells.keys()][0];
const victim = bad.find(e => `${e.x},${e.y}` === firstCell);
const wantCode = cells.get(firstCell).code;
victim.code = wantCode === 1 ? 2 : 1;
const afterWrongCode = mkSnap([existing, ...bad]);
show(`场景 B：格子 ${firstCell} 的 code 从 ${wantCode} 改成 ${victim.code}`,
    gateG4(intent, before, afterWrongCode));
