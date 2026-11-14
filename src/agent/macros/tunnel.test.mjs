/**
 * tunnel.test.mjs — 隧道规划器的判据。
 *
 * 每条测试都对应一个**实机见过或源码可证**的事实，不是凭空构造的断言。
 * 参考真值：2026-11-14 L10 手工放置的那一对隧道
 *   sender  (-11,-8) r=90 rv=0 code=22
 *   receiver (-9,-8) r=90 rv=1 code=23
 */
import {
    tunnelDir, rotationForTunnelDir, planTunnelCrossing, tunnelOps, tunnelPort,
    TUNNEL_RANGE, TUNNEL_CODES,
} from "./tunnel.mjs";

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass++; return; }
    fail++;
    console.log(`✗ ${name}`);
    if (detail !== undefined) console.log("   ", JSON.stringify(detail));
};
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b });

/* ── T1 朝向语义：rotateLocal("top", r) ── */
eq(tunnelDir(0), "top", "T1a r=0 推向 top");
eq(tunnelDir(90), "right", "T1b r=90 推向 right（实机验证的那一对）");
eq(tunnelDir(180), "bottom", "T1c r=180 推向 bottom");
eq(tunnelDir(270), "left", "T1d r=270 推向 left");

/* ── T2 反向求解是单向可逆的 ── */
for (const d of ["top", "right", "bottom", "left"]) {
    eq(tunnelDir(rotationForTunnelDir(d)), d, `T2 ${d} 反解后回代一致`);
}

/* ── T3 跨度上限与 config.js:90 对齐 ── */
eq(TUNNEL_RANGE.default, 5, "T3a tier0 跨度 5");
eq(TUNNEL_RANGE.tier2, 9, "T3b tier1 跨度 9");
eq(TUNNEL_CODES.default, { sender: 22, receiver: 23 }, "T3c code 22/23");
eq(TUNNEL_CODES.tier2, { sender: 24, receiver: 25 }, "T3d code 24/25");

/* ── T4 实机那一对：复现出来 ── */
{
    /* 场景：绿线沿 y=-8 向东，(-10,-8) 是青色线的竖墙。 */
    const world = new Map();
    world.set("-10,-8", { type: "belt", uid: 13353 });
    const at = (x, y) => world.get(`${x},${y}`) || null;

    const p = planTunnelCrossing({ from: [-12, -8], dir: "right", at });
    ok(p.ok === true, "T4a 能规划出穿越", p);
    eq(p.sender, [-11, -8], "T4b sender 在障碍前一格（实机位置）");
    eq(p.receiver, [-9, -8], "T4c receiver 在障碍后一格（实机位置）");
    eq(p.rotation, 90, "T4d r=90（实机值）");
    eq(p.skipped, [[-10, -8]], "T4e 跳过青色墙那一格");
    eq(p.span, 2, "T4f 跨度 2");
}

/* ── T5 障碍太宽 ⇒ 明确拒绝，不静默铺一个够不着的隧道 ── */
{
    const world = new Map();
    for (let x = -10; x <= -4; x++) world.set(`${x},-8`, { type: "belt", uid: 100 + x });
    const at = (x, y) => world.get(`${x},${y}`) || null;
    /* 连续 7 格障碍 ⇒ 跨度至少 8 > range 5。
       规划器在 limit 内数到 5 就停（它不需要知道完整宽度），
       但报出的 span 必须已经超过 range —— 那才是拒绝的依据。 */
    const p = planTunnelCrossing({ from: [-12, -8], dir: "right", at });
    ok(p.ok === false, "T5a 宽障碍被拒", p);
    eq(p.reason, "too_wide", "T5b 理由是 too_wide");
    ok(p.detail && p.detail.span > p.detail.range, "T5c 报出的跨度确实超过射程", p.detail);
    ok(p.detail && p.detail.run >= 5, "T5d 数到的障碍长度不超过搜索上限", p.detail);
}

/* ── T6 机器永不可穿越 ── */
{
    const world = new Map();
    world.set("-10,-8", { type: "mixer", uid: 11803 });
    const at = (x, y) => world.get(`${x},${y}`) || null;
    const p = planTunnelCrossing({ from: [-12, -8], dir: "right", at });
    ok(p.ok === false, "T6a 撞机器被拒", p);
    eq(p.reason, "blocked_by_machine", "T6b 理由是 blocked_by_machine");
}

/* ── T7 前方没有障碍 ⇒ 不需要隧道（不硬造） ── */
{
    const at = () => null;
    const p = planTunnelCrossing({ from: [-12, -8], dir: "right", at });
    ok(p.ok === false, "T7a 空路径不造隧道", p);
    eq(p.reason, "no_blocker", "T7b 理由是 no_blocker");
}

/* ── T8 sender 必须先于 receiver 落 ── */
{
    const ops = tunnelOps({ sender: [-11, -8], receiver: [-9, -8], rotation: 90 });
    eq(ops.length, 2, "T8a 一对隧道 = 俩 op");
    eq(ops[0].rotationVariant, 0, "T8b 第一个是 sender(rv=0)");
    eq(ops[1].rotationVariant, 1, "T8c 第二个是 receiver(rv=1)");
    eq(ops[0].r, 90, "T8d sender 的 rotation");
    eq(ops[1].r, 90, "T8e receiver 同 rotation —— 不同向就连不上");
    ok(ops[0].x < ops[1].x, "T8f sender 在 receiver 之前（沿推进方向）");
}

/* ── T9 tier2 用 24/25 且能跨更远 ── */
{
    const ops = tunnelOps({ sender: [0, 0], receiver: [8, 0], rotation: 90 }, "tier2");
    eq(ops[0].variant, "tier2", "T9a tier2 变体");
    const world = new Map();
    for (let x = 1; x <= 7; x++) world.set(`${x},0`, { type: "belt", uid: x });
    const at = (x, y) => world.get(`${x},${y}`) || null;
    const p5 = planTunnelCrossing({ from: [0 - 1, 0], dir: "right", at, range: 5 });
    const p9 = planTunnelCrossing({ from: [0 - 1, 0], dir: "right", at, range: 9 });
    ok(p5.ok === false && p5.reason === "too_wide", "T9b tier0 跨不过 7 格障碍", p5);
    ok(p9.ok === true, "T9c tier2 能跨过", p9);
}

/* ── T10 端口方向：sender 从背后收货、receiver 往前喷 ── */
{
    const s = tunnelPort("sender", 90, -11, -8);
    eq(s.dir, "left", "T10a sender 收货面朝左（推进 right 的反面）");
    const r = tunnelPort("receiver", 90, -9, -8);
    eq(r.dir, "right", "T10b receiver 出货面朝右");
}

/* ── T11 前置空格会被跳过，sender 紧贴障碍 ── */
{
    const world = new Map();
    world.set("-8,-8", { type: "belt", uid: 1 });
    const at = (x, y) => world.get(`${x},${y}`) || null;
    const p = planTunnelCrossing({ from: [-12, -8], dir: "right", at });
    ok(p.ok, "T11a 能规划", p);
    eq(p.sender, [-9, -8], "T11b sender 紧贴障碍前一格（跳过前面的空格）");
    eq(p.receiver, [-7, -8], "T11c receiver 在障碍后");
}

console.log(`\ntunnel.test.mjs: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
