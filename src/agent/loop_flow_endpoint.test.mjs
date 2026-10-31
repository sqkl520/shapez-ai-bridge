/**
 * loop_flow_endpoint.test.mjs — `deriveFlows` 的终点必须是**实体**，不能是带子。
 *
 * 实测的 bug（2026-10-29 定位）：
 *   冷启动时 obs 里没有带子，① 分支命中「本次新放的第一格带子」就返回 `{ via:"adjacent" }`。
 *   而 `checkFlow.reach()`（verify_runtime.mjs:651-680）只把 **path 的接收方实体**放进 `seen`。
 *   ⇒ `flow.to = 带子` 永远判红，哪怕 trail 里写着货已经到了 hub。
 *
 * 所以本文件的核心不是「正例能绿」，而是**反例必须先红**：
 *   一旦 `findDownstream` 退回「停在第一格带子上」，反例 D 会变成 flow.to=带子，
 *   `checkFlow` 判红是因为「to 不是接收方」而不是因为「真的是死端」—— 两者必须分得开。
 *   因此反例还额外断言 `flows` 里**没有**任何带子端点（uid 属于 belt）。
 */
import { deriveFlows } from "./loop/planToTxOps.mjs";
import { checkFlow } from "./verify_runtime.mjs";
import { obsReach } from "./loop/verify.mjs";
import { beltExit } from "../ai/belt-rules.mjs";

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra) {
    if (cond) { pass++; console.log("✓ " + label); }
    else { fail++; failures.push(label); console.log("✗ " + label + (extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 500) : "")); }
}
const eq = (got, want, label) => ok(got === want, label, { got, want });

const HUB = { uid: 10000, type: "hub", x: -2, y: -2, r: 0 };
const at = (u) => (u === HUB.uid ? HUB : null);

/** 一段从 (1,-10) 向上到 (1,-3) 的直带，出口朝 top ⇒ 再走一格进 hub 本体 (1,-2) */
function verticalRun(uid0, opts = {}) {
    const out = [];
    for (let y = -10; y <= -3; y++) out.push({ uid: uid0 + (y + 10), type: "belt", x: 1, y, r: 0, rotation_variant: 0 });
    if (opts.loop) {
        /* 自环：把最后一段改成往回走（rv0 + r180 ⇒ 出口朝 bottom） */
        out[out.length - 1] = { ...out[out.length - 1], r: 180 };
    }
    return out;
}

/* ═══════════ A. 正例：cutter → 新放带子 → hub ⇒ flow.to 必须是 hub ═══════════
 *
 * 几何（全部用 slotsOf 核对过）：cutter@(0,-9) footprint 占 (0,-9)(1,-9)，
 * right 输出槽在 (1,-9)，approach 格 (1,-10)。
 * 带子从 (1,-10) 一路朝 **top**（rot0，出口 y-1）铺到 (1,-13)，下一格 (1,-14) 是 hub 本体。
 * 带子**全部本轮新放**，obs 里只有 hub ⇒ ① 分支会先命中带子。修好后必须追到 hub。
 * （注意方向不能朝 bottom：那会走回 (1,-9)，是 cutter 自己的格子 ⇒ 被当自环。）
 */
{
    const cutter = { kind: "cutter", variant: "default", x: 0, y: -9, rot: 0, uid: null, token: "tc", cells: [[0, -9], [1, -9]] };
    const belts = [];
    for (let y = -10; y >= -13; y--) {
        belts.push({ kind: "belt", variant: "default", x: 1, y, rot: 0, rv: 0, uid: null, token: `b${y}`, cells: [[1, y]] });
    }
    /* hub 本体覆盖 x∈[-2,1], y∈[-17,-14] ⇒ (1,-14) 是本体格 */
    const HUB_A = { uid: 10000, type: "hub", x: -2, y: -17, r: 0 };
    const obs = { entities: [HUB_A] };
    const flows = deriveFlows([cutter, ...belts], obs, null);
    const right = flows.find(f => f.via_slot === "right");
    ok(!!right, "A: cutter.right 产出了 flow", flows);
    eq(right && right.to, HUB_A.uid, "A: flow.to 追到 hub（uid 10000，不是第一格带子 b-10）");
    eq(right && right.via, "chain", "A: 经过带子链 ⇒ via=chain（不是停在第一格的 adjacent）");
    /* 反向对照：若退回旧实现，to 会是 "b-10" */
    ok(!flows.some(f => String(f.to_token).startsWith("b")),
        "A: 没有任何 flow 以带子为终点", flows);

    /* 同一份几何喂给 checkFlow：给一条 cutter 出口 → hub 的 path，必须绿 */
    const items = { pathCount: 1, paths: [{ cells: [[1, -10], [1, -9]], boundAcceptor: [-2, -2] }] };
    const plan2 = { placements: [{ kind: "cutter", x: 0, y: -9, rot: 0 }] };
    const obs2 = { entities: [HUB, { uid: 20000, type: "cutter", x: 0, y: -9, r: 0 }] };
    ok(checkFlow(plan2, obs2, items, { flows: [{ from: 20000, to: 10000 }] }).ok === true,
        "A: flow.to=hub 时 checkFlow 判绿（旧实现 to=带子时恒红）");
}

/* ═══════════ B. 正例：直贴的 trash（不经带子）⇒ via adjacent ═══════════
 *
 * cutter@(0,-9) 的 left 输出槽在 (0,-9)，approach 格 (0,-10) —— 正好放 trash。
 */
{
    const cutter = { kind: "cutter", variant: "default", x: 0, y: -9, rot: 0, uid: 20000, token: "tc", cells: [[0, -9], [1, -9]] };
    const trash = { kind: "trash", variant: "default", x: 0, y: -10, rot: 0, uid: 20001, token: "tt", cells: [[0, -10]] };
    const flows = deriveFlows([cutter, trash], { entities: [HUB] }, null);
    const left = flows.find(f => f.via_slot === "left");
    ok(!!left, "B: cutter.left 产出了 flow", flows);
    eq(left && left.to, 20001, "B: flow.to 是直贴的 trash uid");
    eq(left && left.via, "adjacent", "B: 直贴仍走 via=adjacent（不因为修了链而改变）");
}

/* ═══════════ C. 正例：新放的机器作为终点 ═══════════
 *
 * balancer@(0,-9) 的 secondary 输出槽在 (1,-9)，approach 格 (1,-10) —— 放 cutter@(1,-10)。
 */
{
    const bal = { kind: "balancer", variant: "default", x: 0, y: -9, rot: 0, uid: 20000, token: "tb", cells: [[0, -9], [1, -9]] };
    const cutter = { kind: "cutter", variant: "default", x: 1, y: -10, rot: 0, uid: null, token: "tc", cells: [[1, -10], [2, -10]] };
    const flows = deriveFlows([bal, cutter], { entities: [HUB] }, null);
    const sec = flows.find(f => f.via_slot === "secondary");
    ok(!!sec, "C: balancer.secondary 产出了 flow", flows);
    eq(sec && sec.to_token, "tc", "C: flow.to 是新放机器的 token");
    eq(sec && sec.via, "adjacent", "C: 机对机直贴 via=adjacent");
}

/* ═══════════ D. 反例（必须先红）：带子链走到世界外 ⇒ 死端 ═══════════
 *
 * 从 cutter.right 的 approach 格 (1,-10) 朝 top 铺（rot0 ⇒ 出口 y-1），但**不铺到 hub**：
 * 只铺到 (1,-13) 就停了 ⇒ (1,-14) 是空的 ⇒ 必须判死端，**不许**停在最后一格带子上。
 */
{
    const cutter = { kind: "cutter", variant: "default", x: 0, y: -9, rot: 0, uid: 20000, token: "tc", cells: [[0, -9], [1, -9]] };
    const belts = [];
    for (let y = -10; y >= -13; y--) belts.push({ kind: "belt", variant: "default", x: 1, y, rot: 0, rv: 0, uid: null, token: `b${y}`, cells: [[1, y]] });
    const flows = deriveFlows([cutter, ...belts], { entities: [HUB] }, null);
    ok(!flows.some(f => f.via_slot === "right"), "D: 死端的 right 输出不产出 flow（判红：OUTPUT_UNROUTED）", flows);
    ok(!flows.some(f => String(f.to_token).startsWith("b")),
        "D: 没有 flow 以带子为终点（否则 checkFlow 的红是「to 不是接收方」，证明不了死端）", flows);

    /* 独立判红：用验证器自己的 obsReach（不借生成器的结论）走一遍，必须到不了 hub。
       注意 obs 里要放带子（obsReach 只看 obs），这里的带子用 obs 形态（rotation_variant）。 */
    const obsAll = {
        entities: [HUB, ...belts.map(b => ({ uid: 30000 + (b.y + 20), type: "belt", x: 1, y: b.y, r: 0, rotation_variant: 0 }))],
    };
    const red = obsReach(20000, { entities: [{ uid: 20000, type: "cutter", x: 0, y: -9, r: 0 }, ...obsAll.entities] });
    ok(!red.seen.has(10000), "D: obsReach 也到不了 hub（死端在验证器侧同样判红）", red.trail);
    ok(red.trail.length === 0, "D: obsReach 的 trail 为空（带子链没接到任何实体）", red.trail);
}

/* ═══════════ E. 反例：uid 不存在 ⇒ 必须红（不能「找不到就不判」） ═══════════ */
{
    const cutter = { kind: "cutter", variant: "default", x: 0, y: -9, rot: 0, uid: 20000, token: "tc", cells: [[0, -9], [1, -9]] };
    const flows = deriveFlows([cutter, { kind: "trash", variant: "default", x: 0, y: -10, rot: 0, uid: 20001, token: "tt", cells: [[0, -10]] }], { entities: [HUB] }, null);
    const plan = { placements: [{ kind: "cutter", x: 0, y: -9, rot: 0 }] };
    const r = checkFlow(plan, { entities: [HUB, { uid: 20000, type: "cutter", x: 0, y: -9, r: 0 }] },
        { pathCount: 0, paths: [] }, { flows: [{ from: 20000, to: 99999 }] });
    ok(flows.length > 0, "E: 前置 —— 计划本身能派生出 flow", flows);
    ok(r.ok === false, "E: flow.to 是不存在的 uid ⇒ 判红", r.reason);
    ok((r.evidence.unreached || []).some(u => /to 不存在/.test(u.why || "")),
        "E: 红的理由是「to 不存在」，不是「走不到」", r.evidence.unreached);
}

/* ═══════════ F. 反例：带子链自环 ⇒ 必须红 ═══════════
 *
 * 2 格自环，但**避开 cutter 的 footprint**：approach 格 (1,-10) rot0 出口朝 top → (1,-11)；
 * (1,-11) 用 rot180 出口朝 bottom → 回 (1,-10)（已在 seen 里）⇒ 判死端。
 * （若朝 bottom 会走回 (1,-9)=cutter 自己的格子，那是「撞 self」不是「绕回起点」，
 *   两种都必须红，但这里要测的是**环**，所以让环落在两格带子之间。）
 */
{
    const cutter = { kind: "cutter", variant: "default", x: 0, y: -9, rot: 0, uid: 20000, token: "tc", cells: [[0, -9], [1, -9]] };
    const loopBelts = [
        { kind: "belt", variant: "default", x: 1, y: -10, rot: 0, rv: 0, uid: null, token: "b1", cells: [[1, -10]] },
        { kind: "belt", variant: "default", x: 1, y: -11, rot: 180, rv: 0, uid: null, token: "b2", cells: [[1, -11]] },
    ];
    /* 前置：确认几何真的是环（top 的出口是 y-1，bottom 的出口是 y+1） */
    ok(beltExit(0, 0) === "top" && beltExit(0, 180) === "bottom",
        "F: 前置 —— rv0/rot0=top、rv0/rot180=bottom（两格确实成环）");
    const flows = deriveFlows([cutter, ...loopBelts], { entities: [HUB] }, null);
    ok(!flows.some(f => f.via_slot === "right"), "F: 自环的 right 输出不产出 flow（返回 null）", flows);
    ok(!flows.some(f => String(f.to_token).startsWith("b")), "F: 没有 flow 以带子为终点", flows);
    /* 独立判红：obsReach 必须拒绝自环（不能把环上的某一格当终点） */
    const red = obsReach(20000, { entities: [HUB, { uid: 20000, type: "cutter", x: 0, y: -9, r: 0 }] });
    ok(!red.seen.has(10000), "F: obsReach 也到不了 hub（自环在验证器侧同样判红）", red.trail);
}

/* ═══════════ G. 反例：obs 里的既有带子链自环（③ 分支） ═══════════
 *
 * 既有世界的带子（uid 10020/10021）互相指成环；cutter 的输出槽正好落在链头。
 * 这条必须也返回 null —— 修 ③ 分支时最容易把环走成「越界前最后一格」。
 */
{
    const loopObs = {
        entities: [
            HUB,
            { uid: 10020, type: "belt", x: 1, y: -10, r: 0, rotation_variant: 0 },
            { uid: 10021, type: "belt", x: 1, y: -11, r: 180, rotation_variant: 0 },
        ],
    };
    const cutter = { kind: "cutter", variant: "default", x: 0, y: -9, rot: 0, uid: 20000, token: "tc", cells: [[0, -9], [1, -9]] };
    const flows = deriveFlows([cutter], loopObs, null);
    ok(!flows.some(f => f.via_slot === "right"), "G: obs 里既有带子的自环也不产出 flow", flows);
    ok(!flows.some(f => f.to === 10020 || f.to === 10021), "G: 没有 flow 以既有带子为终点", flows);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failures:\n  " + failures.join("\n  ")); process.exitCode = 1; }
