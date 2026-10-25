/**
 * fanout.test.mjs — 扇出改写（balancer 级联）的可证伪测试。
 *
 * 背景：`buildDag` 以前遇到「一个输出被 ≥2 个消费者共享」就整段拒绝
 * （`consumers > 1` → crossing-needs-tunnel）。有了 balance 模板（2 进 2 出、内容不变、
 * 轮流发两路）后，扇出有了标准解法：插一棵 balancer 树。
 *
 * 这里不测"能不能编译"（那要被布局/路由一起拖进来），只测**改写本身**：
 *   · 改写后每个消费者仍有 parents，且指向 balance 节点
 *   · balance 节点的 hash 与源相同（透传），数量 = k-1
 *   · 改写是确定性的（同输入 → 同结构）
 *
 * 反向对照：关掉改写的开关（noFanoutRewrite）必须回到原来的拒绝 —— 否则这个测试
 * 证明不了"改写真的发生了"。
 */
import assert from "node:assert/strict";

const { buildDag } = await import("../../../src/ai/compiler/place.mjs");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("✓ " + msg); } else { fail++; console.log("✗ " + msg); } };

/** 一个扇出 2 路的最小 DAG：n0(mine) → 两条 rotate 分支 → 用 stack 合回单终端。
 *  ⚠️ 必须有**唯一终端**：v1 另有一条「只画一条产出线」的规则（多终端 → out-of-scope:multilayer），
 *  那条与扇出无关，混进来会掩盖真正要测的东西。 */
const steps = [
    { op: "mine", hash: "CuCuCuCu", inputs: [], depth: 0 },
    { op: "rotate", hash: "--CuCu--", inputs: ["CuCuCuCu"], depth: 1, args: { dir: "cw" } },
    { op: "rotate", hash: "Cu----Cu", inputs: ["CuCuCuCu"], depth: 1, args: { dir: "ccw" } },
    { op: "stack", hash: "--CuCu--:Cu----Cu", inputs: ["--CuCu--", "Cu----Cu"], depth: 2 },
];

// ① 扇出 2 路：应当插入 1 个 balancer
{
    const r = buildDag(steps.map(s => ({ ...s })));
    ok(r.ok === true, "扇出 2 路：buildDag 成功（旧行为是拒绝）", r.ok === false ? r.reason : undefined);
    if (r.ok) {
        const bals = r.nodes.filter(n => n.op === "balance");
        ok(bals.length === 1, `扇出 2 路 ⇒ 1 个 balancer（实得 ${bals.length}）`);
        const b = bals[0];
        ok(b && b.hash === "CuCuCuCu", `balancer 承载源的 hash（实得 ${b && b.hash}）`);
        // 两个消费者现在都从 balancer 取货
        const kids = r.nodes.filter(n => n.op === "rotate");
        const fromBal = kids.filter(k => k.parents.some(p => p === b));
        ok(fromBal.length === 2, `2 个消费者都接到了 balancer 上（实得 ${fromBal.length}）`);
        // 源不再直接连消费者
        const src = r.nodes.find(n => n.op === "mine");
        const direct = kids.filter(k => k.parents.some(p => p === src));
        ok(direct.length === 0, `源不再直连消费者（实得 ${direct.length} 个仍直连）`);
    }
}

// ② 反向对照：关掉改写 ⇒ 回到原来的拒绝
{
    const r = buildDag(steps.map(s => ({ ...s })), { noFanoutRewrite: true });
    ok(r.ok === false, "反向对照：noFanoutRewrite ⇒ 扇出仍被拒（证明改写不是凭空通过）");
    ok(r.ok === false && r.reason === "dag-not-placeable:crossing-needs-tunnel",
        `拒绝原因是 crossing-needs-tunnel（实得 ${r.ok === false ? r.reason : "ok"}）`);
}

// ③ 无扇出时不受影响
{
    const linear = [
        { op: "mine", hash: "CuCuCuCu", inputs: [], depth: 0 },
        { op: "rotate", hash: "--CuCu--", inputs: ["CuCuCuCu"], depth: 1, args: { dir: "cw" } },
    ];
    const r = buildDag(linear.map(s => ({ ...s })));
    ok(r.ok === true, "无扇出：仍然成功");
    if (r.ok) ok(r.nodes.filter(n => n.op === "balance").length === 0, "无扇出：不插 balancer");
}

// ④ 确定性：两次构建结构相同
{
    const a = buildDag(steps.map(s => ({ ...s })));
    const b = buildDag(steps.map(s => ({ ...s })));
    const shape = r => r.ok ? r.nodes.map(n => `${n.op}:${n.parents.map(p => p && p.op).join(",")}`).join("|") : "fail";
    ok(shape(a) === shape(b), "同输入两次构建结构相同（确定性）");
}

console.log(`\n扇出改写：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
