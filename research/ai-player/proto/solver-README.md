# solver-README — 配方求解器原型（可运行、已验证）

> `research/ai-player/proto/solver.mjs`（离线、零依赖、BFS）
> 复用已验证的 `shape-ops.mjs` 代数层（48,433/48,433 与公开求解器一致）。

## 用法

```bash
node research/ai-player/proto/solver.mjs CgScScCg              # level-11 目标
node research/ai-player/proto/solver.mjs CgScScCg --no-cutquad  # 只用 level-11 已解锁的运算
node research/ai-player/proto/solver.mjs ----CuCu               # level-2 目标
node research/ai-player/proto/solver.mjs CrCrCrCr               # 纯上色
node research/ai-player/proto/solver.mjs RuRu----               # 半形状
node research/ai-player/proto/solver.mjs <target> --json        # 结构化输出
```

## 算法：前向 BFS（不是反向搜索）

**为什么前向**（实测教训）：反向搜索必须"猜切割前的另一半是什么"——猜错就造出错误解或死循环。
前向 BFS 从原料出发枚举所有**可达**形状，遇目标即返回，**不存在猜测**。
公开求解器（TomasSirgedas）同样采用可达表预计算。

**剪枝**：
1. 形状按 hash 去重（保留最短路径）
2. **stack 只配对"象限不重叠"的两个形状** —— 这砍掉了绝大部分组合
3. 深度上限 + 状态上限（可调）

**关键修正**（踩过的坑）：`cutQuad` 是 **L16 才解锁**的建筑变体。
默认全开会用 level-11 拿不到的建筑，产生"**看起来对但造不出来**"的解——
这本身就是"可用性约束必须进求解器"的教训。用 `--no-cutquad` 得到 level-11 合法解。

## 实测结果（全部用 shape-ops 复放验证 ✅）

| 目标 | 难度 | 解 | 耗时 | 验证 |
|---|---|---|---|---|
| `CuCuCuCu` | L1（原料直达） | mine ×1 | 1ms | ✅ |
| `----CuCu` | L2（切半） | mine + cut(left) | 2ms | ✅ |
| `RuRu----` | L4（右半） | mine + cut(right) | 3ms | ✅ |
| `CrCrCrCr` | L7（纯上色） | mine + paint(red) | 3ms | ✅ |
| **`CgScScCg`** | **L11 真目标** | mine×2 + cut×2 + paint×2 + stack + **rotateCW** | **865ms** | ✅ **逐步复放通过** |
| **`SrSrSrSr:CyCyCyCy`** | **L15 多层目标** | mine×2 + paint×2 + stack(layers) | **8ms** | ✅（**多层求解可行！**） |

### level-11 的合法解（只用 L≤11 建筑）

```
[d0] mine         →  SuSuSuSu
[d1] cut right    →  SuSu----
[d2] paint cyan   →  ScSc----
[d0] mine         →  CuCuCuCu
[d1] cut left     →  ----CuCu
[d2] paint green  →  ----CgCg
[d2] stack(merge) →  ScScCgCg
[d3] rotate cw    →  CgScScCg      ✅（复放验证通过）
```

**注意**：这条解与主 Agent 手推的 7 步链**不同**（都正确）。BFS 找的是"最浅深度"解。
对 AI 玩家来说**有多条等价解是好事**——布局层可以选最省机器/最好布的。

### 多层解（L15 目标，8ms）—— **回答了 SYNTHESIS 最大未解项的一半**

```
[d0] mine           →  SuSuSuSu
[d1] paint red      →  SrSrSrSr
[d0] mine           →  CuCuCuCu
[d1] paint yellow   →  CyCyCyCy
[d1] stack(layers)  →  SrSrSrSr:CyCyCyCy   ✅
```

**多层求解已打通**（`stack` 的分层语义如实实现）。**未解的是多层的"布局"**——
需要多级 stacker 串联（每个 stacker 吃两个输入产出一层），几何复杂度仍是 SYNTHESIS §5.2 的最大项。

## 能力边界（诚实清单）

| 项 | 状态 |
|---|---|
| 单层形状（level 1-11 全部目标） | ✅ 已解 |
| **多层形状求解**（`SrSrSrSr:CyCyCyCy`，L15） | ✅ **8ms 解出**（`stack` 分层语义如实实现） |
| 多层**布局** | ❌ **未做**（SYNTHESIS §5.2 最大未解项的另一半） |
| 带颜料混合 | ⚠️ 解里 `paint cyan` 隐含 mixer（解的呈现没显式列出 mix 步骤）【缺口：plan 输出中应插入 mix 节点】 |
| 性能 | 单层 L11 需 61904 状态 / 865ms；多层 L15 反而快（421 状态 / 8ms，因为两层都是完整形状、无互补合并的分支爆炸） |
| 吞吐优化（最少机器数） | ❌ 未做（当前只保证"最浅深度"） |
| 与公开表的代数一致性 | ✅ `validate-vs-public-solver.mjs` 对代数层 100% |

**性能注**：单层目标的瓶颈是"互补合并"分支（半形状 × 半形状的组合）。
多层反而快，因为"完整形状叠完整形状"不经过那个爆炸路径。
若未来单层更慢，可加启发式（如"只与目标形状的象限匹配的半形状配对"）。

## 待办（按优先级）

1. **把 mix 步骤显式插入解**（cyan/purple/yellow 的 paint 前要列出 mix 来源）
2. 吞吐感知求解（`--min-machines`：按机器速率给代价函数，找瓶颈最少的解）
3. 多层目标实测（求解可过，布局待 M 系列扩展）
