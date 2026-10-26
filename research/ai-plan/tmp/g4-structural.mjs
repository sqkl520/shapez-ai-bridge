/**
 * 决定性检验：gateG4 能否在"游戏真实会产生的 after"上判绿。
 *
 * 游戏 obs 每台机器只报**一条**记录（entityToObs 用 sme.origin），
 * 多格机器也只占一条。所以 after 里 cutter 只有原点一格。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve("D:/Projects/rea/Project work/shapez");
const { gateG4 } = await import(pathToFileURL(path.join(ROOT, "src/agent/gates.mjs")).href);

const mk = list => ({
    entities: list,
    byUid: new Map(list.map(e => [e.uid, e])),
    byCell: new Map(list.map(e => [`${e.x},${e.y}`, e])),
});
const oldChest = { uid: 9001, type: "belt", x: 0, y: 0, r: 0, code: 1 };
const before = mk([oldChest]);
const run = (label, intent, added) => {
    const r = gateG4(intent, before, mk([oldChest, ...added]));
    console.log(`\n── ${label} ──`);
    console.log("ok:", r.ok, "| reason:", r.reason ?? "(null)");
    console.log("evidence:", JSON.stringify(r.evidence));
    return r;
};

// 1) 只有带子：每格一条，游戏就是这样报的
run("纯带子蓝图（每格一条 obs）→ 应该绿", {
    goal: "X", anchor: [10, 10],
    entities: [
        { kind: "belt", dx: 0, dy: 0, rot: 0, code: 1 },
        { kind: "belt", dx: 0, dy: 1, rot: 0, code: 1 },
        { kind: "belt", dx: 0, dy: 2, rot: 0, code: 1 },
    ],
}, [
    { uid: 1, type: "belt", x: 10, y: 10, r: 0, code: 1 },
    { uid: 2, type: "belt", x: 10, y: 11, r: 0, code: 1 },
    { uid: 3, type: "belt", x: 10, y: 12, r: 0, code: 1 },
]);

// 2) 一台 cutter：游戏 obs 只报原点（与真实世界一致）
run("含一台 cutter（obs 只在原点报一条，与真实游戏一致）→ ？", {
    goal: "X", anchor: [10, 10],
    entities: [{ kind: "cutter", dx: 0, dy: 0, rot: 0, code: 9 }],
}, [{ uid: 4, type: "cutter", x: 10, y: 10, r: 0, code: 9 }]);

// 3) 一台 miner：gate 认为是 2 格，游戏里是 1 格
run("含一台 miner（游戏里 miner 只占 1 格）→ ？", {
    goal: "X", anchor: [10, 10],
    entities: [{ kind: "miner", dx: 0, dy: 0, rot: 0, code: 7 }],
}, [{ uid: 5, type: "miner", x: 10, y: 10, r: 0, code: 7 }]);

// 4) 对照：如果 after 真的每格都有实体（现实中不会发生），才会绿
run("cutter 蓝图但伪造两条 obs（现实不会发生）→ 应该绿", {
    goal: "X", anchor: [10, 10],
    entities: [{ kind: "cutter", dx: 0, dy: 0, rot: 0, code: 9 }],
}, [
    { uid: 6, type: "cutter", x: 10, y: 10, r: 0, code: 9 },
    { uid: 7, type: "cutter", x: 11, y: 10, r: 0, code: 9 },
]);
