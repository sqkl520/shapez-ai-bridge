/** L1 规划：矿机一行 → 汇流 → hub 北面入口。留出南侧给后续关卡。 */
import { rpc, act } from "../live/kit.mjs";

const BASE_HUB = [-2, -2];
const ORDER = ["top", "right", "bottom", "left"];
const EXIT_LOCAL = { 0: "top", 1: "left", 2: "right" };
const rot = (l, r) => ORDER[(ORDER.indexOf(l) + Math.round(r / 90)) % 4];
const solve = (i, o) => {
  for (let r = 0; r < 360; r += 90) for (const rv of [0, 1, 2]) {
    if (rot("bottom", r) === i && rot(EXIT_LOCAL[rv], r) === o) return { rot: r, rv };
  }
  return null;
};

const o = await rpc("obs", { max_entities: 100, include_hub: true, include_stats: true });
const hub = o.entities.find(e => e.type === "hub");
console.log("hub", [hub.x, hub.y], "| level", o.goal.level, o.goal.requirement.shape);

const res = await rpc("obs", { region: [hub.x - 30, hub.y - 10, hub.x + 30, hub.y + 30],
  include_resources: true, max_resources: 2000, include_stats: false }, 120000);
const cu = res.resources.filter(r => r[2] === "CuCuCuCu").map(r => [r[0], r[1]]);
console.log("铜矿:", cu.length, "格");

// 选 y 最小（最北）那行里连续的一段，放 3 台矿机
const rows = new Map();
for (const [x, y] of cu) { if (!rows.has(y)) rows.set(y, []); rows.get(y).push(x); }
let my = null, xs = null;
for (const [y, list] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
  const s = list.sort((a, b) => a - b);
  let best = [s[0]], cur = [s[0]];
  for (let i = 1; i < s.length; i++) {
    if (s[i] === s[i - 1] + 1) cur.push(s[i]);
    else { if (cur.length > best.length) best = cur; cur = [s[i]]; }
  }
  if (cur.length > best.length) best = cur;
  if (best.length >= 2) { my = y; xs = best; break; }
}
console.log(`矿行 y=${my}，可用 x=`, xs);

/* 布局：
     矿机(2)(3)(4) 一排 y=my，朝北
        │  │  │
        y=my-1 各自一格带
        └──┴──┘  汇到 x=... 横向干道
                │
        hub 北面入口 y=hub.y-1=-3
   为了不用 balancer（L1 还没解锁），只放 2 台矿机各自独立进 hub。
   这样 L1 就能过，而且给后续留了样板。 */

const WANT = Math.min(2, xs.length);
const picked = xs.slice(0, WANT);
console.log("L1 放", WANT, "台矿机:", picked);

/* 每台矿机：朝北 → 竖直上到 hub 北面入口行 → 拐进 hub
   hub 北面入口在 (hub.x+i, hub.y-1) = (-2..1, -3)，带子朝下(dir bottom) */
const parts = [];
const entries = [];
for (let i = 0; i < 4; i++) entries.push({ cell: [hub.x + i, hub.y - 1], dir: "bottom" });

picked.forEach((mx, idx) => {
  const entry = entries[idx];
  const ex = entry.cell[0], ey = entry.cell[1];
  parts.push({ op: "place", building: "miner", x: mx, y: my, r: 0 });   // 朝北
  // 竖直段：从 (mx, my-1) 往上到 (mx, ey+1)
  for (let y = my - 1; y > ey; y--) {
    parts.push({ op: "place", building: "belt", x: mx, y, r: solve("bottom", "top").rot });
  }
  // 入口行：从 (mx, ey) 横移到 (ex, ey)，再进 hub
  if (mx === ex) {
    parts.push({ op: "place", building: "belt", x: mx, y: ey, r: solve("bottom", "top").rot });
  } else {
    // 需要拐弯：在 (mx, ey) 转向
    parts.push({ op: "place", building: "belt", x: mx, y: ey, r: solve("bottom", mx > ex ? "left" : "right").rot });
    const st = mx > ex ? -1 : 1;
    for (let x = mx + st; x !== ex; x += st) {
      parts.push({ op: "place", building: "belt", x, y: ey, r: solve(st > 0 ? "right" : "left", st > 0 ? "right" : "left")?.rot ?? solve("left","right").rot });
    }
    parts.push({ op: "place", building: "belt", x: ex, y: ey, r: solve(st > 0 ? "right" : "left", "top").rot });
  }
});

console.log(`\n准备放 ${parts.length} 个实体`);
for (const p of parts.slice(0, 12)) console.log(" ", p.building, [p.x, p.y], "r=" + p.r);

if (process.argv.includes("--execute")) {
  let ok = 0, fail = [];
  for (const p of parts) {
    try { await rpc("act", p); ok++; } catch (e) { fail.push([p.building, p.x, p.y, e.message.slice(0, 40)]); }
  }
  console.log(`\n放置 ${ok}/${parts.length}`);
  if (fail.length) console.log("失败:", JSON.stringify(fail.slice(0, 6)));

  const t0 = (await rpc("obs", { max_entities: 1, include_hub: true }, 60000)).tick;
  const s0 = (await rpc("obs", { max_entities: 1, include_hub: true }, 60000)).hub.stored_shapes["CuCuCuCu"] || 0;
  await rpc("act", { op: "step", ticks: 6000 }, 300000);
  const fin = await rpc("obs", { max_entities: 1, include_hub: true }, 60000);
  const el = fin.tick - t0;
  const got = (fin.hub.stored_shapes["CuCuCuCu"] || 0) - s0;
  console.log(`\n${el.toFixed(0)}s: CuCuCuCu +${got} = ${(got/el).toFixed(3)}/s`);
  console.log(`目标 30，需要约 ${(30/(got/el)).toFixed(0)}s`);
}
