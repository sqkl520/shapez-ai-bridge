# ★ 权威几何表：机器 + 槽位 + 速率（全部实机验证）

> **这是布局编译器与求解器的唯一几何真值。**每一行都有源码行号 + 实机验证记录。
> 证据：`facts/ops-semantics-VERIFIED.md`（源码核证）+ `facts/MILESTONE-M1b/M2a/M3-*.md`（实机验证）

## 表 1：建筑几何（rotation=0 时）

| 建筑 | 占地 | 输入槽（相对格 / 方向） | 输出槽 | 实机验证 |
|---|---|---|---|---|
| **miner** | 1×1 | —（"吃"它所在的资源格） | `(0,0)` **top** | ✅ M1b/M2a/M3 |
| **belt** | 1×1 | 任意相邻朝它的 | 自身 rotation 方向 | ✅ M1b + H7 |
| **cutter**（default） | 2×1 | `(0,0)` **bottom** | `(0,0)` top → **左列**<br>`(1,0)` top → **右列** | ✅ M1b（产物逐字符一致） |
| **cutter**（quad） | 4×1 | `(0,0)` bottom | `(0..3,0)` top ×4 → 四象限 | ⬜ 未测 |
| **rotater** | 1×1 | `(0,0)` **bottom** | `(0,0)` **top** | ⬜ 未测（几何最简，同 stacker 的一半） |
| **stacker** | 2×1 | `(0,0)` bottom → **下层**<br>`(1,0)` bottom → **上层** | `(0,0)` **top** | ✅ **M3**（`CuCuSuSu:RuRuCuCu`） |
| **painter**（default） | 2×1 | `(0,0)` **left**（shape）<br>`(1,0)` **top**（color） | `(1,0)` **right** | ✅ **M2a**（`RbRbRbRb`） |
| **painter**（mirrored） | 2×1 | `(0,0)` left（shape）<br>`(1,0)` **bottom**（color） | `(1,0)` right | ⬜ 未测（几何对称于 default） |
| **mixer** | 2×1 | `(0,0)` bottom（color）<br>`(1,0)` bottom（color） | `(0,0)` top | ⬜ 未测（同 stacker 几何） |
| **trash** | 1×1 | 四边全收（top/right/bottom/left） | — | ✅ M1b/M2a/M3 |
| **hub** | 4×4 | 四边共 16 格（顶排 top、底排 bottom、左列 left、右列 right） | —（有 WiredPins 信号输出） | ⬜ 未测 |

**源码出处**：miner `buildings/miner.js:82`；cutter `buildings/cutter.js:105-127` + `systems/item_processor.js:367-388`；
rotater `buildings/rotater.js:121-131`；stacker `buildings/stacker.js:67-81`；painter `buildings/painter.js:118-183`；
mixer `buildings/mixer.js:72-86`；trash `buildings/trash.js:78-91`；hub `buildings/hub.js:73-91`。

## 表 2：速率（base 值，× 对应升级倍率）

| 建筑 | base 速率 | 与带速之比 | 含义 |
|---|---|---|---|
| belt | **2.0 /s** | 1× | 基准 |
| miner | 0.4 /s | 1/5 | **5 矿机 = 1 条满带**（官方 tips #16） |
| rotater | 2.0 /s | 1× | 永远够快 |
| cutter | 0.5 /s | 1/4 | 4 台吃满一条带 |
| stacker | **0.25 /s** | **1/8** | **最慢 → 工厂瓶颈** |
| painter | 0.33 /s | 1/6 | 6 台吃满一条带 |
| mixer | 0.4 /s | 1/5 | |
| 隧道 | — | — | T1=5 格，T2=9 格跨度 |

**源码**：`config.js:81,101-111` + `hub_goals.js:487-532`（子 agent 已核，见 `human-strategies.md §2.4`）。

## 表 3：布局编译器必须内建的规则（全部实机确认）

1. **矿机输出恒为 top** → 矿机的料总要"先往上走"。
2. **cutter/stacker/mixer/rotater 全是"下进上出"** → 沿 **+y** 流动。
3. **painter 是"左进（形状）、上进（颜料）、右出"** → 沿 **+x** 流动。
   → **两类机器不能简单串在一条线上**，这是布局的核心矛盾。
4. **cutter 的两条输出带都必须朝上**（否则堵死——开发期 B3 卡住的根因）。
5. **stacker 的两条输入带都必须朝上**，且**必须避开输出带** → 需要"抬高一行绕行"（M3 验证过这个模式）。
6. **颜料是独立物流**：painter 的 color 从 **top** 进 → 必须为颜料留垂直通道。
   **青（cyan）不是矿** —— 必须 mixer 混绿+蓝。
7. **传送带形状由邻居派生**（`belt.js:161`）→ **逐格 `place_path` 时顺序重要**。
   ⚠️ **修正**：早期实验（H7）曾以为"蓝图粘贴不走这条路"，后来发现 `placeOne` 把 rv 交给自动定向重算
   （见 `facts/ROOT-CAUSE-rotationVariant-override.md`），**H7 的结论一度是错的**。
   **修复后**（`placeOne` 支持 rv 覆盖）蓝图才真正确定 —— 见 `facts/RV-FIX-verified.md`。
   **现状**：蓝图可用且确定；`place_path` 仍依赖顺序（拐角格应**最后放**）。
8. **hub 四边共 16 个入口** → 不必把产线都挤向一边。

## 表 4：本仓库已实测的"能/不能"

| 能力 | 状态 | 证据 |
|---|---|---|
| 离线复现整张资源图 | ✅ 3002/3002 一致 | `facts/offline-map-reproduction.md` |
| 离线复刻形状运算 | ✅ 48,433/48,433 与公开求解器一致 | `facts/solver-cross-validation.md` |
| 零观测盲建（2099 格外） | ✅ 26ms | `facts/offline-map-EXPERIMENTS.md` H3 |
| 未生成区域物流流动（2855 格外） | ✅ 20 个 blue 流动 | 同上 H5b |
| 蓝图一次实例化 49 实体（2404 格外） | ✅ | 同上 H6 |
| 蓝图保留带子拐角变体 | ✅ 逐格 r/rv 一致 | `facts/blueprint-integrity-EXPERIMENT.md` H7 |
| **切割产线自动建成并运转** | ✅ 两条输出带分别承载左列/右列 | `facts/MILESTONE-M1b-verified.md` |
| **颜料物流 + 上色** | ✅ `RuRuRuRu`+blue → `RbRbRbRb` | `facts/MILESTONE-M2a-verified.md` |
| **堆叠（含上/下层映射）** | ✅ → `CuCuSuSu:RuRuCuCu` | `facts/MILESTONE-M3-stacker-verified.md` |
| rotater / mixer / quad cutter / hub 直连 | ⬜ 未测（几何已知） | — |
| **多分支交汇**（两个上游 → 一个 stacker，完整 level-11 链） | ⬜ 未测 | — |
