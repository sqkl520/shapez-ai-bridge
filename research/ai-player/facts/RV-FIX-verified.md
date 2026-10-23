# ★ rotationVariant 修复已实机验证 ★（游戏重启后）

> `facts/ROOT-CAUSE-rotationVariant-override.md` 里的修复（`placeOne` 支持 rv 覆盖）
> **已通过实机验证**。脚本：`research/ai-player/exp-rv-fix.mjs`

## 验证方法

1. 造一条**含拐角**的产线（矿机朝上 → 竖直 3 格 → 拐角右转 → 水平 4 格）
2. 导出为蓝图
3. 在**两个不同的空区域**各粘贴一次
4. 比对**逐格的 r / rotationVariant / code**

## 结果

```
源蓝图（含拐角）：
  (0,-5) r=0  rv=2  code=3    ← ★ 拐角（右转）
  其余 rv=0 code=1

粘贴 #1 @ (74,-83)        粘贴 #2 @ (154,-83)
  (0,0) r=0 rv=2 code=3     (0,0) r=0 rv=2 code=3    ← ★ 两次都是 code=3
  (1,0) r=90 rv=0 code=1    (1,0) r=90 rv=0 code=1
  (2,0) r=90 rv=0 code=1    (2,0) r=90 rv=0 code=1
  (3,0) r=90 rv=0 code=1    (3,0) r=90 rv=0 code=1
  (4,0) r=90 rv=0 code=1    (4,0) r=90 rv=0 code=1
  (0,1..3) r=0 rv=0 code=1  (0,1..3) r=0 rv=0 code=1

粘贴 #1 vs #2: ✅ **完全一致（幂等，与位置无关）**
拐角变体: ✅ **两次都精确复现源码的 code=3（右转）**
```

## 为什么这是决定性证据

**修复前**：拐角格的 `rv` 由邻居派生。在**空区域**粘贴时，邻居逐格出现，
拐角会算成"直带"（rv=0）或"左转"（rv=1）——取决于粘贴循环到那一格时邻居的状态。
**同一蓝图在不同位置粘贴会得到不同结果。**

**修复后**：蓝图里的 `code`（= base + rotationVariant）被**直接采用**。
所以：

| 检验项 | 结果 |
|---|---|
| 两次粘贴结果相同（**幂等**） | ✅ |
| 拐角保留为**右转**（code=3，非 0/1） | ✅ |
| 与源产线在同一格位置一致 | ✅（归一化后逐格 r/rv/code 相同） |

**这是"离线布局 → 实机确定性落地"闭环的最后一块**，
配合 `facts/building-code-table.md` 的 code 表，就可以：
```
离线算布局 → 算每格的 (building, rotation, rotationVariant) → 算 code
  → 生成 SZBP1 → paste_blueprint → 结果完全确定
```

## 附带：回归测试

`test/mod_selftest.mjs` 加了 3 条断言（**全绿，总计 18 条**）：
- `placeOne honours rotationVariant override` —— 覆盖参数生效，不调用自动定向
- `placeOne falls back to auto-orientation when no override` —— 不传时行为不变（向后兼容）
- `paste_blueprint passes code's rotationVariant through` —— 粘贴链路正确传递

**全套回归：103 条断言全绿**（mod 18 + blueprint 7 + rpc 12 + bridge 19 + mcp 47）。

## 世界状态

测试后逐 uid 对比基线：**2805 / 2805，extra 0，missing 0** ✅
（过程中出现 2 个残留 trash，靠"逐 uid 对比"发现并精确删除 —— 第 4 次验证这套流程有效。）

## 对路线图的更新

`SYNTHESIS.md` 第一批的 **#0（修 placeOne 的 rv 覆盖）已完成并验证**：
- ✅ 修复（约 10 行）
- ✅ 回归用例（3 条）
- ✅ 实机验证（幂等 + 拐角保真）
- ✅ 已提交（`fix(mod): let callers pin a building's rotationVariant`）

**下一步**：用这个修复重做双分支汇合（M4），此时拐角可控 —— 应当一次通过。
