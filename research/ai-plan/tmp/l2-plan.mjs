/** L2 规划：保留 L1 的线（旧厂永不拆），在旁边新建带切割机的线。
 *
 * L1 用了 hub 北面入口 x=-2..1 中的 -2（从 (-4,-3) 横移进来）。
 * L2 用北面剩下的入口，或者西面入口 —— 但西面已被 L1 的 (x-10..-5) 通道占。
 * 实际最干净：**L1 那条线不动**，新线走 hub 的**南面**入口（y=hub.y+4=2）。
 *
 * 切割机几何（r=0）：输入南、输出北。矿在 y=4（南边）、hub 南入口在 y=2，
 * 所以矿机朝北 → 切割机 → 输出朝北 → 绕到 hub 南面？不行，方向反。
 *
 * 正确：矿机朝**南**（r=180）→ 切割机 r=0 在矿机南边（输入从南？不对）
 * 重新推：切割机 r=0 输入在 local(0,0) 从 bottom(南) 来 —— 货从**南边**进入切割机。
 * 所以切割机必须在矿机的**北边**，矿机朝北供货。
 * 切割机输出朝北 ⇒ hub 必须在北边。而 hub 在 (-2,-2)，矿在 y=4 —— hub 确实在北边 ✓
 *
 * 所以：矿机(y=4) 朝北 → 切割机(y=2) → 输出(y=1) 朝北 → 绕到 hub 北面入口(y=-3)。
 * 但 y=1 到 y=-3 要穿过 hub 本体（y=-2..1）！
 * 必须从侧面绕：输出往北走到 y=-3 是不可能的，因为 hub 挡在 (-2..1, -2..1)。
 *
 * 用 hub 的**东面**入口 x=hub.x+4=2：从切割机输出 (x, y) 往东绕到 x=2，再进 hub。
 */
import { rpc } from "../live/kit.mjs";

const ORDER = ["top", "right", "bottom", "left"];
const EXIT_LOCAL = { 0: "top", 1: "left", 2: "right" };
const rot = (l, r) => ORDER[(ORDER.indexOf(l) + Math.round(r / 90)) % 4];
const solve = (i, o) => {
  for (let r = 0; r < 360; r += 90) for (const rv of [0, 1, 2]) {
    if (rot("bottom", r) === i && rot(EXIT_LOCAL[rv], r) === o) return { rot: r, rv };
  }
  return null;
};

const o = await rpc("obs", { max_entities: 200, include_hub: true, include_resources: true,
  max_resources: 2000, region: [-40, -20, 20, 20] }, 120000);
const hub = o.entities.find(e => e.type === "hub");
const occ = new Set(o.entities.map(e => `${e.x},${e.y}`));
console.log("hub", [hub.x, hub.y], "| level", o.goal.level, o.goal.requirement.shape);

// 找空闲的铜矿格（避开 L1 的矿机）
const cu = o.resources.filter(r => r[2] === "CuCuCuCu" && !occ.has(`${r[0]},${r[1]}`))
  .map(r => [r[0], r[1]]);

const parts = [];
// 矿机选一列靠东的，方便往东绕
const mx = cu.filter(([x, y]) => x >= -8).map(r => r[0]);
const my = 4;

// 试：矿机 (-8,4) 朝北 → 带 (-8,3)(-8,2) → 切割机 (-8,1) r=0
// 切割机占 (-8,1) 和 (-7,1)
// 输出 (-8,0) 和 (-7,0) 朝北
// 然后从 (-8,0) 往东绕到 x=2，再进 hub 东面
console.log("尝试布局：矿机(-8,4) 朝北 → 切割机(-8,1)");

const cells = [];
// 矿机
parts.push({ op: "place", building: "miner", x: -8, y: 4, r: 0 });
// 送料 (-8,3) (-8,2)
for (const y of [3, 2]) parts.push({ op: "place", building: "belt", x: -8, y, r: 0 });
// 切割机
parts.push({ op: "place", building: "cutter", x: -8, y: 1, r: 0 });
// 输出左半 (-8,0) 朝北 —— 这是目标 ----CuCu（右半？RuRu---- 是左半）
// ----CuCu = 右半（quad 2,3），slot0 出右半
// 所以 (-8,0) 是 slot0 = 右半 = 目标 ✓
// 从 (-8,0) 往北不行（hub 挡）。往东绕：
// (-8,0) 拐角：北进东出
parts.push({ op: "place", building: "belt", x: -8, y: 0, r: solve("bottom", "right").rot });
// 东行到 x=3
for (let x = -7; x <= 3; x++) {
  parts.push({ op: "place", building: "belt", x, y: 0, r: solve("left", "right").rot });
}
// 从 (3,0) 往南到 hub 东面入口 (2,0)？hub 东面入口是 (hub.x+4, hub.y+i) = (2,-2..1)
// (2,0) 是入口，带子朝左(r=270)
parts.push({ op: "place", building: "belt", x: 3, y: 0, r: solve("left", "left")?.rot ?? solve("top","left").rot });
parts.push({ op: "place", building: "belt", x: 2, y: 0, r: 270 });
// 副产品 (-7,0) → trash
parts.push({ op: "place", building: "trash", x: -7, y: -1, r: 0 });
parts.push({ op: "place", building: "belt", x: -7, y: 0, r: solve("bottom", "top").rot });

console.log(`\n${parts.length} 个实体`);
if (process.argv.includes("--execute")) {
  let ok = 0, fail = [];
  for (const p of parts) {
    try { await rpc("act", p); ok++; } catch (e) { fail.push([p.building, p.x, p.y, e.message.slice(0, 50)]); }
  }
  console.log(`放置 ${ok}/${parts.length}`);
  if (fail.length) console.log("失败:", JSON.stringify(fail.slice(0, 8)));
}
