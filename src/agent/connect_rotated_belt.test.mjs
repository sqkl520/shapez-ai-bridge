/**
 * connect_rotated_belt.test.mjs — 锁死「带子 r≠0 时 connect 必须能用」。
 *
 * ## 为什么
 *
 * `connect()` 拿到 from/to 实体后有一道检查：
 *
 *     for (const [rec, field] of [[rf.rec, "from"], [rt.rec, "to"]]) {
 *         if (rec.r !== 0) {
 *             return failure({ code: "out_of_scope", field,
 *                 message: `${field} 指向的 ${rec.type} rotation=${rec.r}；v1 只支持 r=0
 *                           （旋转机器的槽位偏移需 P2 的 origin 位移表）` });
 *         }
 *     }
 *
 * 这条限制的**理由**是「旋转**机器**的槽位偏移需要 origin 位移表」—— 说的是机器。
 * 但代码没有区分实体类型，于是**带子也被拦了**。
 *
 * 而带子的方向完全由 `(rotation_variant, r)` 共同决定，与机器槽位无关：
 *
 *     beltExit(0,   0) = top        beltExit(0, 180) = bottom
 *     beltExit(0,  90) = right      beltExit(0, 270) = left
 *
 * 带子在 r=180 时是完全正常的实体。真实世界里 r≠0 的带子占绝大多数
 * （长直的竖直段全是 r=180 或 r=0，转角是 r=270）。
 *
 * ## 实测后果（这是本文件存在的原因）
 *
 * 半成品世界实验（2026-10-31）：一条 22 格的链被砍掉最后 3 格，
 * 断点 `(1,-6)` 是 **r=180 / rv=0**（朝 bottom 喷到 `(1,-5)` 空地）。
 * loop 的诊断完全正确（`DEAD_END`），模型也**选对了动作**（`connect`，它的 `say`
 * 原文是「Route the dead-ended output into the hub」），但宏拒绝了：
 *
 *     out_of_scope: from 指向的 belt rotation=180；v1 只支持 r=0
 *
 * ⇒ 一个正确的计划被能力缺口挡死。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { connect, portsOf, verifyChain } from "./macros/connect.mjs";
import { beltExit } from "../ai/belt-rules.mjs";

const t = (name, fn) => test(name, fn);

/* 带子 r=180 朝 bottom（y+1），把它接到下方的 hub。 */
t("前置：带子 r=180 rv=0 确实朝 bottom（不是错误数据）", () => {
    assert.equal(beltExit(0, 180), "bottom");
    assert.equal(beltExit(0, 0), "top");
});

t("★ from 是 r=180 的带子 ⇒ connect 必须被接受（当前 bug：out_of_scope）", () => {
    const ents = [
        /* 带子 r=180 在 (1,-6)，朝 bottom 喷到 (1,-5) */
        { uid: 1, type: "belt", x: 1, y: -6, r: 180, rotation_variant: 0, code: 1 },
        { uid: 2, type: "hub", x: -2, y: -2, r: 0 },
    ];
    const r = connect({ from: { uid: 1 }, to: { hub: { uid: 2 } } }, { entities: ents });
    assert.equal(r.ok, true, `带子 r=180 必须可用，实际：${JSON.stringify(r.error)}`);
    assert.ok(Array.isArray(r.cells) && r.cells.length > 0, "必须给出路径");
});

t("★ from 是 r=270 的带子 ⇒ 同样必须被接受", () => {
    /* r=270 rv=0 → left。带子在 (1,-6) 朝左喷。 */
    assert.equal(beltExit(0, 270), "left");
    const ents = [
        { uid: 1, type: "belt", x: 1, y: -6, r: 270, rotation_variant: 0, code: 1 },
        { uid: 2, type: "hub", x: -2, y: -2, r: 0 },
    ];
    const r = connect({ from: { uid: 1 }, to: { hub: { uid: 2 } } }, { entities: ents });
    assert.equal(r.ok, true, `带子 r=270 必须可用，实际：${JSON.stringify(r.error)}`);
});

t("★ to 是 r=180 的带子 ⇒ 也必须被接受", () => {
    const ents = [
        { uid: 1, type: "miner", x: 0, y: 6, r: 0 },
        { uid: 2, type: "belt", x: 0, y: 0, r: 180, rotation_variant: 0, code: 1 },
    ];
    const r = connect({ from: { uid: 1 }, to: { uid: 2 } }, { entities: ents });
    assert.equal(r.ok, true, `to 是 r=180 的带子必须可用，实际：${JSON.stringify(r.error)}`);
});

/* ══════════════ r≠0 的**机器**：2026-11-10 起不再被拒 ══════════════
 *
 * 这两条原来是「护栏：机器 r≠0 仍然必须被拒」，理由是
 * 「旋转机器的槽位偏移需要 origin 位移表，v1 没有」。
 *
 * **那个前提已经不成立。** P19（2026-11-09）做了两件事：
 *   · `portSlots()` 从 spec 快照按 `rotate90` 转 tile、按 `rotateLocal` 转 dir
 *   · `machinePorts()` / `makeContext()` 不再对 r≠0 短路返回空表
 * 真机验证过：cutter r=180 放着、接货、真的产出（level 6 从 0/270 打到 73%）。
 *
 * 而 `connect` 里那道闸是**第五份**判断，修完前四份才轮到它。
 * 真机现场：红矿机 r=180 在 level 7 的 painter 场景里被它拒成 `out_of_scope`。
 *
 * 所以这两条测试改成断言「**能连上**」—— 如果哪天有人把闸加回来，
 * 这两条会立刻变红，提醒他先去读 portSlots 的注释。 */

t("机器 r=90 作 from ⇒ 必须被接受（P19 之后不再限制）", () => {
    const ents = [
        { uid: 1, type: "miner", x: 0, y: 6, r: 90 },
        { uid: 2, type: "cutter", x: 0, y: 0, r: 0 },
    ];
    const r = connect({ from: { uid: 1 }, to: { uid: 2, port: "primary" } }, { entities: ents });
    assert.notEqual(r.error && r.error.code, "out_of_scope",
        `r=90 的机器不该再被 out_of_scope 拒，实际 ${JSON.stringify(r.error)}`);
});

t("机器 r=90 作 to ⇒ 同样不再被拒", () => {
    const ents = [
        { uid: 1, type: "miner", x: 0, y: 6, r: 0 },
        { uid: 2, type: "cutter", x: 0, y: 0, r: 90 },
    ];
    const r = connect({ from: { uid: 1 }, to: { uid: 2, port: "primary" } }, { entities: ents });
    assert.notEqual(r.error && r.error.code, "out_of_scope",
        `r=90 的目标机器不该再被 out_of_scope 拒，实际 ${JSON.stringify(r.error)}`);
});

t("★ 空链是合法结果：from 的喷口与 to 的接收格相邻时不需要铺带子", () => {
    /* 2026-11-10 真机踩到的第二个 connect bug：
     * 红矿机 r=180 在 (54,21) 往下喷，painter 的 color 接收格正是 (54,22) —— 零距离。
     * `connect` 算出 `cells: []`（不用铺），但 `verifyChain([])` 判 `ok:false`
     * 报「internal: 生成的路径几何不自洽（第 chain 处）：空链」——
     * 一个**正确且最短**的连接被自己的自证层拒掉。
     *
     * ⚠️ to 必须是**机器**不是带子：带子那边有另一道正确的闸
     * （`port_already_bound` —— 已经有带子接货时再连一条会饿死旧的）。 */
    const ents = [
        { uid: 1, type: "miner", x: 54, y: 21, r: 180 },
        { uid: 2, type: "painter", x: 53, y: 23, r: 0 },
    ];
    const r = connect({ from: { uid: 1 }, to: { uid: 2, port: "color" } }, { entities: ents });
    assert.equal(r.ok, true, `零距离连接必须成功，实际：${JSON.stringify(r.error)}`);
    assert.equal(r.cells.length, 0, "零距离时不该铺任何带子");
});

t("verifyChain：空数组 ok、非数组仍不合法", () => {
    /* ⚠️ runner 是**同步**的（`t(name, fn)` 里 try/catch）。
       第一版这里写了 `async () => { const {verifyChain} = await import(...) }`
       —— `t()` 拿到一个 Promise，`try/catch` 抓不到里面的断言失败，
       测试会静默"通过"或报一个看不懂的错。改成同步 import。 */
    assert.equal(verifyChain([]).ok, true, "空链是合法结果（不需要铺带子）");
    assert.equal(verifyChain(null).ok, false, "非数组仍是调用方传错");
    assert.equal(verifyChain(undefined).ok, false);
});

t("护栏：hub 不是机器，不受 r=0 限制影响（它永远 r=0，但语义要分清）", () => {
    const ents = [
        { uid: 1, type: "miner", x: 0, y: 6, r: 0 },
        { uid: 2, type: "hub", x: -2, y: -2, r: 0 },
    ];
    const r = connect({ from: { uid: 1 }, to: { hub: { uid: 2 } } }, { entities: ents });
    assert.equal(r.ok, true, JSON.stringify(r.error));
});

/* ══════════════════════════ portsOf 也要能处理 r≠0 的带子 ══════════════════════════ */

t("portsOf 对带子不依赖 r=0（带子的「槽」是它自己的出口格）", () => {
    /* portsOf 对带子本就走特殊路径；这里只断言它**不因为 r≠0 就返回空**，
       否则下游会拿不到任何 eject 端点。 */
    const spec = { buildings: {} };
    for (const r of [0, 90, 180, 270]) {
        const belt = { uid: 1, type: "belt", x: 1, y: -6, r, rotation_variant: 0, code: 1 };
        const p = portsOf(belt, spec);
        assert.ok(Array.isArray(p.eject), `r=${r} 时必须返回 eject 数组`);
        assert.ok(Array.isArray(p.accept), `r=${r} 时必须返回 accept 数组`);
    }
});
