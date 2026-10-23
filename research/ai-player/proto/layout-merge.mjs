/**
 * layout-merge.mjs — 网格布局法的**多分支汇合**扩展（攻克 M4 失败的那部分）。
 *
 * 核心思路（针对"汇合需要拐角"的困难）：
 *   · 用**网格占位**预先分配每个分支的通道（列）与车道（行）—— 不再边算边放
 *   · 拐角**显式建模**：网格里写死拐角格的"进入方向"，并**在放完所有直线段后**才放拐角
 *     （陷阱 #1/#6：rv 由邻居派生，邻居必须已存在）
 *   · 关键技巧：**拐角格用 place 显式指定 r**，且其邻居（上游竖直段、下游水平段）
 *     此前已放好 —— 这样游戏算出的 rotationVariant 必然正确
 *
 * 布局（两个分支 + 一个 stacker）：
 *
 *      colA        colB
 *        │           │            ← 各分支的竖直通道
 *        ↓           ↓            （从矿机上来）
 *     ┌──┘           └──┐         ← 拐角（A 向右、B 向左）
 *     └──────→  ←──────┘          ← 水平车道（不同行，避免交叉）
 *        ↓           ↓
 *     [  stacker  ]               ← 两个输入都朝上
 *        ↓
 *      trash
 *
 * 用法：node research/ai-player/proto/layout-merge.mjs（打印网格 + 动作）
 */
import fs from "node:fs";

class Grid {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.cells = Array.from({ length: h }, () => new Array(w).fill("."));
    this.owner = Array.from({ length: h }, () => new Array(w).fill(null));
  }
  get(x, y) { return (x >= 0 && x < this.w && y >= 0 && y < this.h) ? this.cells[y][x] : "#"; }
  set(x, y, ch, who = "?") {
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) throw new Error(`out of grid (${x},${y})`);
    if (this.cells[y][x] !== ".") throw new Error(`(${x},${y}) occupied by '${this.cells[y][x]}' (want '${ch}' from ${who}, prev owner=${this.owner[y][x]})`);
    this.cells[y][x] = ch; this.owner[y][x] = who;
  }
  occupy(x, y, ch, who) {   // 2×1 机器的第二格（允许同一 owner 反复占位）
    if (this.cells[y][x] !== "." && this.owner[y][x] !== who) throw new Error(`(${x},${y}) occupied`);
    this.cells[y][x] = ch; this.owner[y][x] = who;
  }
  toString() {
    const header = "    " + Array.from({ length: this.w }, (_, i) => String(i % 10)).join("");
    return [header, ...this.cells.map((r, y) => String(y).padStart(3) + " " + r.join(""))].join("\n");
  }
}

/**
 * 双分支汇合布局（网格局部坐标）。
 * 参数（网格坐标）：分支A 通道列 aCol、分支B 通道列 bCol、stacker 左格 (sCol, sRow)
 */
function layoutMerge({ aCol, bCol, sCol, sRow }) {
  const g = new Grid(24, 18);
  // 布局参数
  const aLane = sRow + 2;      // A 的横向车道行
  const bLane = sRow + 4;      // B 的横向车道行（错开，避免交叉）
  // A 的目标列 = sCol，B 的目标列 = sCol+1
  const aTarget = sCol, bTarget = sCol + 1;

  // ① 两条竖直通道（从底部上来，到拐角前一格）
  for (let y = sRow + 8; y >= aLane + 1; y--) g.set(aCol, y, "^", "chA-v");
  for (let y = sRow + 8; y >= bLane + 1; y--) g.set(bCol, y, "^", "chB-v");

  // ② 拐角格
  //   A：从下方来（↑）→ 向右拐（→）→ 用 '>' 表示"拐角后朝右"，但网格记号上标为 corner
  g.set(aCol, aLane, ">", "cornerA");    // A 拐角：进自下、出向右
  //   B：从下方来（↑）→ 向左拐（←）
  g.set(bCol, bLane, "<", "cornerB");    // B 拐角：进自下、出向左

  // ③ 水平车道（拐角后一格 → 目标列前一格）
  if (aTarget > aCol + 1) for (let x = aCol + 1; x <= aTarget - 1; x++) g.set(x, aLane, ">", "chA-h");
  else if (aTarget < aCol - 1) for (let x = aTarget + 1; x <= aCol - 1; x++) g.set(x, aLane, "<", "chA-h");
  if (bTarget > bCol + 1) for (let x = bCol + 1; x <= bTarget - 1; x++) g.set(x, bLane, "<", "chB-h");
  else if (bTarget < bCol - 1) for (let x = bTarget + 1; x <= bCol - 1; x++) g.set(x, bLane, ">", "chB-h");

  // ④ 目标列的第二个拐角（从水平 → 向上）
  g.set(aTarget, aLane, "^", "cornerA2");
  g.set(bTarget, bLane, "^", "cornerB2");

  // ⑤ 从第二个拐角到 stacker 输入的竖直段
  for (let y = aLane - 1; y >= sRow + 1; y--) g.set(aTarget, y, "^", "chA-last");
  for (let y = bLane - 1; y >= sRow + 1; y--) g.set(bTarget, y, "^", "chB-last");

  // ⑥ stacker（2×1）
  g.occupy(sCol, sRow, "S", "stacker");
  g.occupy(sCol + 1, sRow, "s", "stacker");
  // ⑦ 输出
  for (let y = sRow - 1; y >= sRow - 3; y--) g.set(sCol, y, "^", "out");
  g.set(sCol, sRow - 4, "T", "trash-out");

  return { grid: g, params: { aCol, bCol, sCol, sRow, aLane, bLane, aTarget, bTarget } };
}

// ───────────── 网格 → 动作（顺序：机器 → 直线 → 拐角）─────────────
function gridToActions(L) {
  const { grid: g, params: p } = L;
  const acts = [];
  // ① stacker 与 trash（机器优先）
  acts.push({ op: "place", building: "stacker", x: p.sCol, y: p.sRow, r: 0 });
  acts.push({ op: "place", building: "trash", x: p.sCol, y: p.sRow - 4, r: 0 });
  // ② 直线段（不含拐角格）
  const vline = (x, y0, y1) => {                 // y 递减 = 向上
    if (y0 === y1) return;
    acts.push({ op: "place_path", building: "belt", from: [x, y0], to: [x, y1] });
  };
  const hline = (y, x0, x1) => { if (x0 !== x1) acts.push({ op: "place_path", building: "belt", from: [x0, y], to: [x1, y] }); };
  // A 通道竖直段（到拐角下方一格）
  vline(p.aCol, p.sRow + 8, p.aLane + 1);
  vline(p.bCol, p.sRow + 8, p.bLane + 1);
  // 车道水平段（拐角后一格到第二个拐角前一格）
  if (p.aTarget > p.aCol) hline(p.aLane, p.aCol + 1, p.aTarget - 1);
  else hline(p.aLane, p.aTarget + 1, p.aCol - 1);
  if (p.bTarget < p.bCol) hline(p.bLane, p.bTarget + 1, p.bCol - 1);
  else hline(p.bLane, p.bCol + 1, p.bTarget - 1);
  // 末端竖直段
  vline(p.aTarget, p.aLane - 1, p.sRow + 1);
  vline(p.bTarget, p.bLane - 1, p.sRow + 1);
  // 输出
  vline(p.sCol, p.sRow - 1, p.sRow - 3);
  // ③ 拐角格（**最后放**，此时邻居都已存在 → rv 会算对）
  acts.push({ op: "place", building: "belt", x: p.aCol, y: p.aLane, r: 90 });      // A 拐角：朝右
  acts.push({ op: "place", building: "belt", x: p.bCol, y: p.bLane, r: 270 });     // B 拐角：朝左
  acts.push({ op: "place", building: "belt", x: p.aTarget, y: p.aLane, r: 0 });    // A 第二拐角：朝上
  acts.push({ op: "place", building: "belt", x: p.bTarget, y: p.bLane, r: 0 });    // B 第二拐角：朝上
  return acts;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("proto/layout-merge.mjs")) {
  // 设计一个具体的网格参数：A 在左、B 在右、stacker 在中间
  const p = { aCol: 3, bCol: 12, sCol: 7, sRow: 6 };
  const L = layoutMerge(p);
  console.log("=== 双分支汇合布局（网格，局部坐标）===");
  console.log(L.grid.toString());
  console.log("\n参数:", JSON.stringify(L.params));
  console.log("\n=== 动作序列（机器 → 直线 → 拐角）===");
  const acts = gridToActions(L);
  let i = 0;
  for (const a of acts) console.log(`  ${String(++i).padStart(2)}. ${JSON.stringify(a)}`);
  console.log(`\n共 ${acts.length} 个动作；网格 ${L.grid.w}×${L.grid.h}`);
  console.log("\n（网格冲突检测在生成阶段完成 —— 有冲突会直接抛错）");
}
