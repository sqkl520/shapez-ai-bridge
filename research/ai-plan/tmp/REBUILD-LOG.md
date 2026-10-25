# 从第一关重建（2026-10-26）

存档 `cf469f75`（level 1 干净档），全程用编译器 + 框架，不手工摆格子。

## 进度

| 关 | 目标 | 需求 | 结果 |
|---|---|---|---|
| 1 | `CuCuCuCu` | 30 | ✅ 2 矿机手建（L1 还没 balancer） |
| 2 | `----CuCu` | 40 | ✅ 编译器产出 2 矿机+1 balancer+1 切割机+2 隧道 |
| 3 | `RuRuRuRu` | 70 | ✅ 编译器产出 **4 矿机+3 balancer**（107 实体） |
| 4 | `RuRu----` | 70 | 进行中 |

## 关键：L3 是第一次用上多矿机

```
machines = { miner: 4, balancer: 3 }
矿格: RuRuRuRu@(2,-8) (3,-8) (4,-8) (5,-8)
```

编译 → 107/107 格实机对拍全对 → 50 秒产 23 个 → 通关。

对比之前：单矿机版本只有 10 个实体，产能 0.4/s。现在 4 台并联。

## 现在的工厂

```
175 个实体
  8 台矿机（4 铜 + 4 钌）
  4 个 balancer
158 格带子
  2 个隧道
  1 个切割机
  1 个垃圾站
```

之前那个"空地图到第四关"是 12 个实体、1 台矿机。

## 每一步都做了什么

L1：手建（2 矿机朝北 → hub 北面入口）。这时候还没有 balancer。
     买 belt T1（34 个 CuCuCuCu ≥ 30）。
L2：`compilePlan{goal:'----CuCu', minersPerLine:2, tunnels:true}` → 46 实体 → 实机 46/46。
     注意 `destroys:3`：编译器不知道旧厂不能拆，销毁了 L1 的 3 个带子。
L3：`compilePlan{goal:'RuRuRuRu', minersPerLine:4, tunnels:true}` → 107 实体 → 实机 107/107，
     `destroys:0`（这次没碰旧厂）。

## 这轮修的 bug（都在 P4/P5 链路）

1. **balancer 链共列** → 通道同格相交。改成阶梯错开（每个右移 2 列）。
2. **balancer 在 OUT_OF_SCOPE_KINDS** → 移除，加入 V1_KINDS。
3. **ENTITY_KINDS 不含 balancer** → 加上。
4. **code 范围检查只允许 7..20** → balancer 的 code 4 单独放行。
5. **terminals 不随矿机组展开重算** → hub 从"已不存在的矿机"出发，P5 报 V4。

第 5 条最关键：它让所有多矿机目标在 validate 阶段死掉，而布局和路由都已经成功了。

## 待解决

- `destroys` 不区分"能拆"和"不能拆"：L2 拆了 L1 的 3 个带子。研究说"旧厂永不拆"，
  但编译器不知道。需要在 `worldEntities` 里区分 replaceable / protected。
- L4 还没跑。
