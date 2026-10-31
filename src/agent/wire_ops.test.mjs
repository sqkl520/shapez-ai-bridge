/**
 * wire_ops.test.mjs — 锁死「发给游戏的 ops 不得带本地校验字段」。
 *
 * ## 这个文件存在的原因（2026-11-01 受控实验扒出来的第 5 个堵点）
 *
 * `attachProvenance` 给每条 place op 挂 `provenance` 标签，`assertProvenance` 用它证明
 * 「每条落盘坐标都能追回 obs 句柄或宏 token」。那是 loop **本地**的溯源层。
 *
 * 但 `doApply` 曾经把**同一份数组**直接发给 `reader.tx`。而 mod 的 `validateAction`
 * 对未知字段是硬拒的（`shapez-ai-bridge.js:2400-2412`）：
 *
 *     if (!spec.fields.has(k)) {
 *         throw this.rpcError(2001, "invalid_action", `unknown field '${k}' for op '${a.op}'`, ...);
 *     }
 *
 * `place` 的允许字段是 `x / y / building / variant / r / rotationVariant /
 * originalRotation / rv / orig`，**没有 `provenance`**。
 *
 * 实测后果：带上 provenance 直接发 ⇒ tx 返回 2001，`dry_run` 也是 `rolled_back:true`，
 * `applied:0/3`。剥掉之后 `applied:3/3` 正常。
 *
 * ⇒ 校验用带标签的，落盘用剥干净的。两者不能是同一份数组。
 *
 * ## 为什么这条必须有测试
 *
 * 这个 bug 是**我自己的修复引入的**：`32262ad` 加 provenance 时只跑了离线测试
 * （离线 `FakeGame.apply` 不看字段），真桥上才发现 mod 拒收。
 * 纯离线测试**结构上**抓不到这类「协议字段」问题 —— 除非有一条测试直接盯着
 * 「发给写面的 ops 长什么样」。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { runLoop } from "./loop.mjs";

/* ══════════════════════ 夹具：一个只有 connect 的最小世界 ══════════════════════ */

const HUB = { uid: 10000, type: "hub", x: -2, y: -2, r: 0, variant: "default", rotation_variant: 0, code: 26 };
/* B1 在 (1,3)：hub 覆盖 x∈[-2,1], y∈[-2,1]，所以 B1 的出口朝 top 到 (1,2)，
   再上一格 (1,1) 是 hub 本体 —— 但它还没接到 hub（中间空着）。
   `connect(from:B1)` 要补的就是 (1,2)(1,1) 这一小段。

   取 y=3 而不是更远，是为了让「出口格 (1,2)」不被判成 already_bound：
   `(1,2)` 是空地。 */
const B1 = { uid: 20001, type: "belt", x: 1, y: 5, r: 0, variant: "default", rotation_variant: 0, code: 1 };

/**
 * 跑一轮 loop，捕获**真正发给写面的 ops**。
 *
 * 关键：`apply` 拿到的数组就是 `doApply` 转发给桥接的那一份 —— 正是 mod 会校验的东西。
 */
async function captureWireOps() {
    let captured = null;
    const entities = [HUB, B1];

    const reader = {
        async obs() {
            return {
                entities,
                goal: { level: 4, requirement: { shape: "RuRu----", required: 70, delivered: 0 } },
                hub: { stored_shapes: {} },
            };
        },
        async debugItems() {
            return {
                pathCount: 1,
                paths: [{ cells: [[1, 4], [1, 3], [1, 2]], boundAcceptor: [-2, -2] }],
            };
        },
        async production() {
            return {
                produced_total: {}, delivered_per_sec: {}, delivered_slices: [{}], window_seconds: 60,
            };
        },
        async step() { return { ticks_run: 600 }; },
    };

    /* 预置的 LLM：一轮就给出 connect(B1 → hub)。不调真 API。
       ⚠️ `propose` 的返回形态是 `{text: "<JSON 字符串>"}` —— loop 用 `parseLlmPlan(llmOut.text)`
       解析（不是直接收 `plan` 对象）。写成 `{plan:{...}}` 会被判成解析失败并耗尽预算。 */
    const llmClient = {
        async propose() {
            return {
                text: JSON.stringify({
                    say: "connect the dead-end belt to the hub",
                    calls: [{ macro: "connect", args: { from: { $ref: "B1" }, to: { $ref: "H1" } }, why: "dead end" }],
                }),
                usage: { in: 0, out: 0 },
            };
        },
    };

    const apply = async (ops) => {
        captured = JSON.parse(JSON.stringify(ops));      // 深拷贝，留住那一份
        const added = ops.map((o, i) => ({
            uid: 30000 + i, type: o.building, x: o.x, y: o.y, r: o.r || 0,
            variant: o.variant || "default", rotation_variant: o.rotationVariant || 0, code: o.code || 1,
        }));
        entities.push(...added);
        return {
            ok: true, applied: ops.length, requested: ops.length, rolled_back: false,
            dry_run: false, aborted: false, failures: [],
            diff: { added: added.map(a => a.uid), removed: [], modified: [] },
            results: added.map((a, i) => ({ index: i, op: ops[i].op, ok: true, uid: a.uid })),
            verify: null,
        };
    };

    await runLoop({
        reader, llmClient, goal: "RuRu----", mode: "mock", apply,
        budget: { ROUNDS_MAX: 1, LLM_CALLS_MAX: 1, TX_MAX: 1 },
        runDir: ".tmpverify/wire-ops-test",
    });

    return captured;
}

/* ══════════════════════════ 1. 核心断言 ══════════════════════════ */

test("★ 发给写面的 ops 不得带 provenance（mod 对未知字段是硬拒）", async () => {
    const ops = await captureWireOps();
    assert.ok(Array.isArray(ops) && ops.length > 0, "这一轮必须真的产生了 ops（否则测试没测到东西）");
    for (const op of ops) {
        assert.equal(
            Object.prototype.hasOwnProperty.call(op, "provenance"), false,
            `op 带着 provenance 发给游戏了 —— mod 会回 2001 unknown field。op=${JSON.stringify(op)}`,
        );
    }
});

test("★ 剥掉 provenance 之后，op 的其余字段一个不少", async () => {
    /* 护栏：修「别带 provenance」不能顺手把 op 本身弄坏。
       place 必须留着 x / y / building（mod 的必填字段）。 */
    const ops = await captureWireOps();
    assert.ok(ops.length > 0);
    for (const op of ops) {
        assert.equal(typeof op.op, "string", "op.op 必须是字符串");
        assert.equal(typeof op.building, "string", "place 必须有 building");
        assert.equal(Number.isInteger(op.x), true, "place 必须有整数 x");
        assert.equal(Number.isInteger(op.y), true, "place 必须有整数 y");
    }
});

test("★ 对照：本地 txPlan 里的 op **仍然**带 provenance（校验层没被削弱）", async () => {
    /* 这条防止「为了不发出去，干脆不挂标签」——
       那样 assertProvenance 会失去输入，等于把溯源检查废掉。 */
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("./loop.mjs", import.meta.url), "utf8");
    assert.match(src, /attachProvenance\(/, "loop.mjs 必须仍然调用 attachProvenance");
    assert.match(src, /assertProvenance\(/, "loop.mjs 必须仍然调用 assertProvenance");
    assert.match(src, /wireOps/, "loop.mjs 必须有「剥掉 provenance 再发」的那一层（wireOps）");
});

test("wireOps 是浅拷贝派生，不修改原数组（txPlan 之后还要用于对账）", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("./loop.mjs", import.meta.url), "utf8");
    /* 必须是 `.map(({provenance, ...rest}) => rest)` 这种派生，
       不能是 `delete op.provenance` 原地改（那会让后续 verifyRound 拿不到标签）。 */
    assert.equal(/delete\s+\w+\.provenance/.test(src), false,
        "不许原地 delete provenance —— 后面 verifyRound 还要用它");
});
