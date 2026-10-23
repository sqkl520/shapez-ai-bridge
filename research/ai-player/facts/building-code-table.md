# ★ 建筑 code 表（实机提取）—— 离线生成蓝图的关键 ★

> 从运行中的游戏**逐个放置并读回**得到的完整 code 表。
> 这是"离线生成 SZBP1 蓝图"的最后一块拼图（见 `MERGE-diagnosis-final.md` 的方案 2）。

## 提取方法

`/tmp/extract-codes.mjs`（在极远处空地逐建筑 × 逐变体 × 逐 rotation 放置，读回 `obs` 的 `code`）

**验证**：提取后清理，世界逐 uid 对比基线 **2805 = 2805，extra 0, missing 0** ✅

## 表（15 个 code，覆盖 level-11 所需全部建筑）

| code | 建筑 / 变体 | rotation 覆盖 | rotationVariant 覆盖 |
|---|---|---|---|
| **1** | `belt` / default | 0,90,180,270 | 0 |
| **7** | `miner` / default | 0,90,180,270 | 0 |
| 8 | `miner` / chainable | 0,90,180,270 | 0 |
| **9** | `cutter` / default | 0,90,180,270 | 0 |
| 10 | `cutter` / quad | 0,90,180,270 | 0 |
| **11** | `rotater` / default (CW) | 0,90,180,270 | 0 |
| 12 | `rotater` / ccw | 0,90,180,270 | 0 |
| 13 | `rotater` / rotate180 | 0,90,180,270 | 0 |
| **14** | `stacker` / default | 0,90,180,270 | 0 |
| 15 | `mixer` / default | 0,90,180,270 | 0 |
| **16** | `painter` / default | 0,90,180,270 | 0 |
| 17 | `painter` / mirrored | 0,90,180,270 | 0 |
| 18 | `painter` / double | 0,90,180,270 | 0 |
| 19 | `painter` / quad | 0,90,180,270 | 0 |
| **20** | `trash` / default | 0,90,180,270 | 0 |

（粗体 = level-11 及以下需要的）

## ⚠️ 重要发现：**rotationVariant 不编码在 code 里**

无论 rotation 是 0/90/180/270，**同一个建筑的 `code` 都相同**，
且 `obs` 返回的 `rotation_variant` 恒为 **0**（直带）。

**例外**：真实工厂里的**拐角带**有不同的 `code` 与 `rotation_variant`：
```
实测（研究过程中的原地产线）：
  (‑23,‑183) r=90 rv=0 code=1    ← 直带
  (‑23,‑180) r=90 rv=1 code=2    ← 左转（rv=1 → code 变成 2！）
  (‑24,‑192) r=0  rv=2 code=3    ← 右转（rv=2 → code 3）
```

**⇒ code 的规律（实测推断 + 源码印证）**：
```
code = base + rotationVariant
  belt:  base=1  →  直带=1, 左转=2, 右转=3
  其它建筑多为 base + 0（无变体）
```

这与 `building_codes.js:99 getCodeFromBuildingData(metaBuilding, variant, rotationVariant)`
的签名一致 —— **rotationVariant 是 code 的组成部分**。

**这是"离线生成蓝图"的关键规则**：
```js
// 离线算 code（belt）
function beltCode(rotationVariant) { return 1 + rotationVariant; }   // 1=直, 2=左, 3=右
```

而 `rotationVariant` 的取值由 `belt.js:161` 的自动定向算法决定（我们已逐行实现，
见 `ops-semantics-VERIFIED.md §11`）—— **两者结合 = 完全离线的带子 code 计算**。

## 对 M4（双分支汇合）的直接应用

`MERGE-diagnosis-final.md` 定位的障碍是"拐角格的 rv 需要邻居就位"。
现在有了 code 表 + rv 算法，**可以完全绕开**：

```js
// 1) 离线算出布局里每一格的 (building, rotation, rotationVariant)
// 2) 用 code 表映射成 code
// 3) 打包成 SZBP1 蓝图 → paste_blueprint 一次性落地
//    ⚠️ 前提：先修 placeOne 的 rv 覆盖（H7 曾误以为蓝图天然保真，后推翻；修复已验证）

// 例：A 分支的拐角（竖直进、向右出）
//   进度方向 = 北（rotation 0），要右转 → rotationVariant 2 → code = 1 + 2 = 3
//   {code: 3, dx, dy, rot: 0}
```

**这是把"5 次失败"变成"确定性成功"的路径。**

## 待办（明确、可执行）

1. **把 `belt.js:161` 的自动定向算法实现在 `proto/` 里**（已有逐行理解，约 50 行 JS）
2. **写 `proto/blueprint-gen.mjs`**：网格 → 算 rv → 算 code → 输出 SZBP1
3. 用 M4 的布局跑一遍，`paste_blueprint` 验证

第 1、2 步是纯离线代码，**不需要开游戏**；第 3 步一次实机验证。
