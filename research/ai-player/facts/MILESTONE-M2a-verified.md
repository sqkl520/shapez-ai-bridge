# M2a 里程碑实机验证：★ 颜料物流 + 上色真的工作 ★

> M1b（切割线）之后的下一块。**已实测通过。**
> 脚本：`research/ai-player/exp-m2a-line.mjs`

## 结果

```
选址：形状矿 RuRuRuRu @ (-23,-189)   颜料矿 blue @ (-27,-188)（实测地图上离工厂较远的相邻对）
世界基线 2805

布局：
  Ru 矿机(朝上) → 竖直带 3 格 → 拐角 → 水平带 2 格 → painter 左侧输入
  blue 矿机(朝上) → 竖直带 4 格 → 水平带 6 格 → 末格朝下 → painter 顶部颜料输入
  painter(2×1, r=0) → 输出带 8 格 → trash

快进 2500 tick → 存档 → 离线解码 beltPaths

★ 带上物品：
  (-27,-189)  blue blue blue blue          ← 颜料在流
  (-23,-190)  RuRuRuRu ×4                  ← 形状在流
  (-19,-192)  RbRbRbRb                     ← ★ 上色后的形状！

=== ✅ PASS —— 颜料真的进入了 painter 并给形状上了色 ===
```

**验证要点**：`RuRuRuRu`（无色方形）+ blue 颜料 → **`RbRbRbRb`（蓝色方形）**。
这是**逐字节正确的游戏语义**（`R`=方形, `b`=blue），证明：
1. painter 的**两个输入槽几何**（shape←left、color←top）理解正确 —— 两条不同方向的物流都到位了。
2. **颜料作为独立物流**是可行的（不是"和形状混在一条带上"）。
3. painter 的输出确实从 right 出，并被我们接到了。

## 通往 level-11 目标 `CgScScCg` 的进度

主 Agent 已离线验证的 7 步链：
```
SuSuSuSu --paint cyan--> ScScScSc --cutHalf[1]--> ScSc---- --rotateCW-->  --ScSc--   (下排)
CuCuCuCu --paint green--> CgCgCgCg --cutHalf[1]--> CgCg---- --rotateCCW--> Cg----Cg   (上排)
                                                        stack(下排, 上排) ⇒ CgScScCg
```

| 步骤 | 状态 |
|---|---|
| 挖掘（miner） | ✅ M1b 验证 |
| 切割（cutter，含槽位语义） | ✅ M1b 验证 |
| **上色（painter + 颜料物流）** | ✅ **M2a 验证（本次）** |
| 旋转（rotater） | ⬜ 未单独验证（几何最简单：bottom→top 直通） |
| 堆叠（stacker） | ⬜ 未验证（几何最难：两个 bottom 输入 + 一个 top 输出） |
| 混色（mixer，青=绿\|蓝） | ⬜ 未验证 |
| **多条链的交汇（stack 两个分支）** | ⬜ 未验证 —— **这是最后一个大几何挑战** |

## ⚠️ 诚实记录：清理再次出错（已修复）

清理时用了 `bulk_delete region`，但**区域边界算窄了 1 格**，
漏掉了一个放在 `(-12,-192)` 的 trash（码 20）——它在 region 外。

**发现方式**：用**存档快照逐 uid 对比**（这正是 `INCIDENT-bulk-delete.md` 教的方法）：
```
snapshot: 2805  current: 2806
多余: 1  uid=21282 (-12,-192) code=20   ← trash
```
**修复**：`delete x=-12 y=-192` → 复核 `多余: 0，缺少: 0`。✅

**这再次证明**：
1. `bulk_delete` 的**边界必须覆盖完整产线**（包括末端的 trash、最远的带子）。
2. **"事后用快照逐 uid 对比"是唯一可靠的清理验证**——比"看实体总数"更精确
   （总数相同也可能一增一减）。
3. **这条教训应该变成工具**：见 `SYNTHESIS.md §4.1`（`bulk_delete` 的 `dry_run` / `only_uids`）——
   如果工具支持"只删我创建的 uid"，这类错误根本不会发生。

## 对布局编译器的直接输入

本次实验给出了一条**已验证可用的"颜料注入"几何模板**：

```
painter 的 color 输入在 (px+1, py) 的 top 方向 →
  颜料带必须以「朝下」的带子结束在 (px+1, py-1)

而矿机输出恒为 top（向上）→ 所以颜料路径必须是：
  上（竖直）→ 拐弯 → 横（水平）→ 再单独一格朝下
  
最后那一格不能靠 place_path 自动定向（它只会沿路径方向），
必须显式 place(building="belt", x, y, r=180)。
```

**这是布局编译器必须内建的规则**（不能指望自动定向）。
