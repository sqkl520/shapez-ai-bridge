# ★ 形状代数的独立交叉验证：100% 一致（48,433/48,433）

> 用**第三方独立实现**（[TomasSirgedas/Shapez-solver](https://github.com/TomasSirgedas/Shapez-solver)，
> Unlicense/public domain）的预计算配方表，逐项验证我们的 `proto/shape-ops.mjs`。
> 验证脚本：`proto/validate-vs-public-solver.mjs`（可重跑）。

## 结果

```
配方表总项: 65536
  不可能(op=NONE): 17103
  ✅ 我们用同一配方重建且拓扑一致: 48433
  ❌ 拓扑不符: 0
  ⚠️ 重建失败/异常: 0
可构造形状中一致率: 100.00%  (48433/48433)
```

**全部 48,433 个可构造形状（单层拓扑）零误差。** 这独立确认了：
- `rotateCW` / `rotateCCW`（ROT3）/ `rotate180`（ROT2）的象限置换
- `cutHalf` 的 **[0]=quads(2,3), [1]=quads(0,1)** 顺序（CUT_LEFT/CUT_RIGHT）
- `stack(lower, upper)` 的层合并语义
- 形状 → 字符串（`hash`）→ code 的编码

## 配方表格式（已解出，可复用）

来源：`shapez_solver.html:883-894`（`loadFromBinary`）

```
65536 项 × 5 字节：
  [0..1] a: uint16 little-endian   —— 子配方 A 的 code
  [2..3] b: uint16 little-endian   —— 子配方 B 的 code
  [4]    op: uint8                 —— 运算
code = L0.b | L1.b<<4 | L2.b<<8 | L3.b<<12
  （每层 b 的 bit i = 象限 i 非空；bit0=TR, bit1=BR, bit2=BL, bit3=TL）
op: 0=NONE(不可构造) 1=RAW(原料) 2=STACK 3=CUT_LEFT 4=CUT_RIGHT 5=ROT1 6=ROT2 7=ROT3
  ROT_n = n 个四分之一圈**顺时针**（我们据 ROT1→code2(BR)、ROT3→code8(TL) 反推并全量验证通过）
```

**注意**：这张表只编码**拓扑**（哪些象限非空），不含形状与颜色。
所以它是"骨架求解器"——配上颜色 mapping 后即为完整配方（该仓库的 `bluePrintFor` 就是这么做的）。

## 对"AI 玩家方案"的含义

1. **配方求解有现成真值**：这张表（327 KB）可以直接读进我们的编译器，
   做**免费的正确性交叉验证**与**兜底答案**——不必自己从零搜。
2. **但它的最佳性目标与我们不同**：它是"最少堆叠"或"最少切割"两种模式（`recipes_0_1_1` vs `recipes_0_9_1`），
   **不是"最少机器数/最短线"**。AI 若追求布局成本最优，仍需自己的代价模型。
3. **它是拓扑层，我们是代数层**：两者互补——我们的 `shape-ops.mjs` 已验证正确，
   可以直接承担"把拓扑配方落到具体形状+颜色"的那一步。
4. **重要缺口**：该表主要覆盖**单层**形状（layer0）。多层形状（如 `CbRbRbCb:CwCwCwCw`）
   需要另外处理——我们的 `stack` 实现已支持多层，但未与此表交叉验证【待验】。
5. **这是"别人已经做完的部分"**：**不要**重写一个通用配方求解器；
   应把力气花在**布局**（配方 → 空间）与**迭代**（按等级扩张）上——那才是没人解决的。

## 附带发现：其他公开资源

| 资源 | 价值 |
|---|---|
| `nedsociety/shapezio-shape-construction` | BFS 枚举全部可构造形状（Python），与上表独立 |
| `cpcp1998/shapez2-solver` | 方法论：状态压缩 + "PP-essential" 剪枝（可迁移） |
| `jiahao-0204/Shapez2-MIP-Miner` | **OR-Tools CP-SAT** 求解矿机布局（免费，非 Gurobi） |
| `alegnani/verifactory` | **用 z3 SAT 证明蓝图性质**（不靠模拟）—— 我们做蓝图校验器时该学 |
| `Redcrafter/verilog2factorio` | "逻辑网表 → 空间布局"的成熟管线（退火布局生成器）——与"配方 DAG → 工厂布局"同构 |
| `Songxwn/shapez-auto` | **直接竞品**：LLM 出加工树 + 确定性 Eval 验证 + 自动摆建筑，Go/MIT |
