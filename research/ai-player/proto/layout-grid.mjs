/**
 * layout-grid.mjs — 网格化布局编译器（M4 失败的正面回答）。
 *
 * 设计原则（直接对应 facts/MILESTONE-M4-partial-and-pitfalls.md 的陷阱表）：
 *   1. 布局 = 一个字符网格，用**确定性算法**涂抹（不手算坐标）→ 解决陷阱 #2/#6
 *   2. 输出 **SZBP1 蓝图**（显式携带 r 与 rotationVariant）→ 绕开陷阱 #1
 *   3. 路径生成自动过滤退化段 → 解决陷阱 #3
 *   4. 每个未使用的输出槽自动接 trash → 解决陷阱 #7
 *
 * 网格符号：
 *   `.` 空   `M` 矿机(朝上)   `C` 切割机(2×1, 左格)   `R` 旋转器
 *   `S` 堆叠器(2×1, 左格)    `T` trash              `^v<>` 传送带(方向)
 *
 * 本文件先实现**单分支**（矿→切割→旋转→输出），验证网格方法本身；
 * 多分支汇合是它的自然扩展（加"车道分配"逻辑）。
 *
 * 用法：node research/ai-player/proto/layout-grid.mjs [--dry]
 */
import fs from "node:fs";
import path from "node:path";

// ───────────── 网格 ─────────────

class Grid {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.cells = Array.from({ length: h }, () => new Array(w).fill("."));
    // 记录"这个格是谁放的"，便于自检
    this.owner = Array.from({ length: h }, () => new Array(w).fill(null));
  }
  get(x, y) { return (x >= 0 && x < this.w && y >= 0 && y < this.h) ? this.cells[y][x] : "#"; }
  set(x, y, ch, who = "?") {
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) throw new Error(`out of grid (${x},${y})`);
    if (this.cells[y][x] !== ".") throw new Error(`cell (${x},${y}) already occupied by '${this.cells[y][x]}' (this='${ch}', who=${who}, prev=${this.owner[y][x]})`);
    this.cells[y][x] = ch; this.owner[y][x] = who;
  }
  /** 强制占用（用于 2×1 机器的第二格） */
  occupy(x, y, ch, who) {
    if (this.cells[y][x] !== ".") throw new Error(`cell (${x},${y}) already occupied by '${this.cells[y][x]}'`);
    this.cells[y][x] = ch; this.owner[y][x] = who;
  }
  isFree(x, y) { return this.get(x, y) === "."; }
  /** 竖直直线段（含两端），方向由 y 顺序决定：向上 = ty<fy */
  vline(x, fy, ty, who) {
    const dir = ty < fy ? "^" : "v";
    for (let y = Math.min(fy, ty); y <= Math.max(fy, ty); y++) this.set(x, y, dir, who);
  }
  /** 水平直线段（含两端） */
  hline(y, fx, tx, who) {
    const dir = tx > fx ? ">" : "<";
    for (let x = Math.min(fx, tx); x <= Math.max(fx, tx); x++) this.set(x, y, dir, who);
  }
  toString() {
    const header = "    " + Array.from({ length: this.w }, (_, i) => String(i % 10)).join("");
    const rows = this.cells.map((row, y) => String(y).padStart(3) + " " + row.join(""));
    return [header, ...rows].join("\n");
  }
}

// ───────────── 布局算法（确定性涂抹）─────────────

/**
 * 单分支布局：
 *   矿机在 (mx,my)，朝上 → 竖直预留给进料
 *   切割机在 (mx, cutY)（2×1，占 (mx,cutY)+(mx+1,cutY)）
 *     输入槽 = 左格 bottom ← 进料带必须结束在 (mx, cutY+1) 且朝上
 *     输出槽 = 左格 top（左列）、右格 top（右列）
 *   旋转器在 (mx+1, rotY)，输入 bottom ← 右列输出带结束在 (mx+1, rotY+1) 朝上
 *   输出带：从 (mx+1, rotY-1) 朝上到末端，然后接 trash
 *   左列输出（不用）：从 (mx, cutY-1) 朝上 → trash
 */
function layoutSingleBranch({ mx, my, useRightColumn = true }) {
  const cutY = my - 3;
  const rotY = my - 6;
  const outTop = my - 9;

  const g = new Grid(10, 14);            // 网格局部坐标：x 从 mx-2 起，y 从 outTop 起
  const OX = 2, OY = 3;                  // 偏移：网格 (0,0) = 世界 (mx-2, outTop-3)
  const W = (gx, gy) => [mx - OX + gx, outTop - OY + gy];   // 网格 → 世界
  const gx = wx => wx - (mx - OX);
  const gy = wy => wy - (outTop - OY);

  // ① 矿机
  g.set(gx(mx), gy(my), "M", "miner");
  // ② 进料带：从矿机上方到切割机输入（含两端）
  g.vline(gx(mx), gy(my - 1), gy(cutY + 1), "feed");
  // ③ 切割机（2×1）
  g.set(gx(mx), gy(cutY), "C", "cutter");
  g.occupy(gx(mx + 1), gy(cutY), "c", "cutter");
  // ④ 未使用的左列输出 → trash（陷阱 #7）
  g.vline(gx(mx), gy(cutY - 1), gy(cutY - 2), "leftOut");
  g.set(gx(mx), gy(cutY - 3), "T", "trash(left)");
  // ⑤ 右列输出 → 旋转器
  g.vline(gx(mx + 1), gy(cutY - 1), gy(rotY + 1), "rightOut");
  g.set(gx(mx + 1), gy(rotY), "R", "rotater");
  // ⑥ 输出带
  g.vline(gx(mx + 1), gy(rotY - 1), gy(outTop + 1), "out");
  g.set(gx(mx + 1), gy(outTop), "T", "trash(out)");

  return { grid: g, world: { mx, my, cutY, rotY, outTop }, toWorld: W };
}

// ───────────── 网格 → 动作序列 ─────────────

/** 把网格翻译成动作列表（按"先机器、再直线、后拐角"的顺序 —— 陷阱 #6） */
function gridToActions(layout) {
  const { grid: g, world, toWorld } = layout;
  const { mx, my, cutY, rotY, outTop } = world;
  const acts = [];
  // 1) 机器（先放，让带子能"看见"邻居）
  acts.push({ op: "place", building: "miner", x: mx, y: my, r: 0 });
  acts.push({ op: "place", building: "cutter", x: mx, y: cutY, r: 0 });
  acts.push({ op: "place", building: "trash", x: mx, y: cutY - 3, r: 0 });
  acts.push({ op: "place", building: "rotater", x: mx + 1, y: rotY, r: 0 });
  acts.push({ op: "place", building: "trash", x: mx + 1, y: outTop, r: 0 });
  // 2) 带子：竖直直线段（它们不涉及拐角）
  acts.push({ op: "place_path", building: "belt", from: [mx, my - 1], to: [mx, cutY + 1] });
  acts.push({ op: "place_path", building: "belt", from: [mx, cutY - 1], to: [mx, cutY - 2] });
  acts.push({ op: "place_path", building: "belt", from: [mx + 1, cutY - 1], to: [mx + 1, rotY + 1] });
  acts.push({ op: "place_path", building: "belt", from: [mx + 1, rotY - 1], to: [mx + 1, outTop + 1] });
  return acts;
}

// ───────────── 自检 ─────────────

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("proto/layout-grid.mjs")) {
  const dry = process.argv.includes("--dry");
  const mx = 0, my = 0;    // 相对坐标（实机会填真实值）
  const layout = layoutSingleBranch({ mx, my });
  console.log("=== 网格（相对坐标，矿机在 (0,0)）===");
  console.log(layout.grid.toString());
  console.log("\n=== 翻译成的动作 ===");
  for (const a of gridToActions(layout)) console.log("  " + JSON.stringify(a));
  console.log("\n（本文件是布局算法的骨架；实机执行见 exp-grid-line.mjs）");
}
