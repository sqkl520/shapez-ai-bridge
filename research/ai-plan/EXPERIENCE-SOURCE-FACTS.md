# 经验素材的事实基底

> 2026-11-02。做「经验形态 A/B」时，经验文本里的**每一条事实**都必须有出处。
> 这份文件是素材库的底料：只收**代码/源码核实过**的，不收「听说」「大概」。
>
> 为什么单列：这个项目最大的成本不是写错代码，是**把假设当结论用**。
> 已经发生过 5 次「简化模型替代真实实现」的事故。经验文本一旦有假事实，
> A/B 就在测「假事实有多毒」，不是测「经验有没有用」。

---

## 0. 这份文件不做什么

- **不写经验文本**。经验怎么措辞是实验臂的事（见 `EXPERIENCE-AB-PLAN.md`）。
- **不做判断**。这里只记「游戏是这样运作的」，不记「所以你应该……」。
- **不收未核实项**。每条下面必须有 `文件:行号`。

---

## 1. 速率表（`src/agent/rules.mjs` 的 `RATES`）

| 项 | 值 | 单位 | 出处 |
|---|---|---|---|
| `beltPerSec` | **2** | items/s | `src/js/core/config.js` |
| `minerPerSec` | **0.4** | items/s | `beltPerSec / 5` |
| `cutter` | **0.5** | items/s | `1/4` 每 tick? 见 §2 |
| `rotater` | **2** | items/s | |
| `painter` | **0.333** | items/s | `1/6` |
| `painterDouble` | **0.5** | items/s | `1/8` |
| `mixer` | **0.4** | items/s | `1/5` |
| `stacker` | **0.25** | items/s | `1/9` |
| `trash` | `null` | — | 无速率概念（吞掉） |

**一个常被搞错的单位口径**：`beltPerSec = 2` 是**基础**速度；实际带速要乘
`UPGRADE_MULTIPLIERS[belt]`。而 0.4 / 0.5 / 0.25 这些是 `1/N` 形式的**每 tick 概率**
派生出来的，不是独立常数。

---

## 2. 升级倍率阶梯（`UPGRADE_MULTIPLIERS`）

```
[1, 1.5, 2, 3, 4, 6, 7, 8]
```

- index = 升级等级（T0..T7）
- `T0 = ×1`（未升级）、`T1 = ×1.5`、`T2 = ×2`、……
- 四条独立的升级线：`belt` / `miner` / `processors` / `painting`
- 出处：`src/js/game/modes/regular.js`（`fixedImprovements = [0.5,0.5,1,1,2,1,1]`）

**这里曾经错过一次**（commit `bb6939d`）：只写了「T2 = RuRu----×600」，
漏了 carry-over（`unshift` 余数到下一级）和 `× tierGrowth (2.5)`。
真实 `processors T2` 是 `SuSuSuSu×1200 + RuRu----×600`。

---

## 3. 机器 → 升级线映射（`MACHINE_UPGRADE_LINE`）

| 机器 | 升级线 |
|---|---|
| `miner` | `miner` |
| `cutter` | **`processors`** |
| `rotater` | `processors` |
| `stacker` | **`processors`** |
| `painter` | `painting` |
| `painterDouble` | `painting` |
| `painterQuad` | `painting` |
| `mixer` | `painting` |
| `balancer` | `belt` |
| `reader` | `belt` |
| `trash` | `null`（无升级） |
| `hub` | `null`（无升级） |

**这张表是「有快路不走」的根源**：想提产能，改 `processors` 会同时加速
cutter / rotater / stacker 三种机器，比多摆几台更省空间。

---

## 4. 布局规则（`LAYOUT_RULES`）

| 规则 | 值 | 含义 |
|---|---|---|
| `hubBufferTiles` | **12** | hub 周围要留 12 格缓冲 |
| `preciseBalancing` | **false** | 不要求精确配比（近似即可） |
| `cutterAlwaysVertical` | **true** | cutter 必须竖直朝向（输入从南） |
| `paintBeforeCut` | **true** | **先染再切**，不是先切再染 |
| `neverDemolish` | **true** | 部署后不拆（增量构建） |
| `beltMidSpanFeeding` | **false** | 带子中段不能进料（只能从两端） |

**`paintBeforeCut = true` 这条特别值钱**：它是「先染后切」还是「先切后染」的
顺序问题，答案从物理约束来——染色机吃整块，切半之后两个半块要分别染，
成本翻倍。这是**规划顺序**的知识，不是数值知识。

**`beltMidSpanFeeding = false` 这条也值钱**：意味着你不能把新矿机接到
一条已有带子的中间——必须从末端接。这直接影响「怎么扩容」的几何。

---

## 5. cutter 的几何（核实过）

- footprint **2×1**
- 输入 `(x, y+1)`，从**南**进来
- 输出两个：`(x, y-1)` [**left**]，`(x+1, y-1)` [**right**]
- `wasteRoles = ["left"]`

**注意方向**：cutter 的坐标系和带子的 `(rotation_variant, r)` 是两套东西。
带子的方向由 `beltExit(rv, r)` / `beltEntry(rv, r)` 决定，`r=0` 单独没有意义。
这个坑在本项目里活了很久（`portsOf` 对 34 条真实带子里 21 条算错方向）。

---

## 6. 产能的核心不等式

```
utilization = process.capacityPerSec / supplyPerSec
```

L4 实测：`0.5 / 1.8 = 27.8%`。

**这条不等式本身不是经验，是判据。** 但由它推出的几条才是经验：
- `utilization < 50%` 说明**产出堵在机器前面**，不是矿不够
- `idleMiners > 0` 说明**矿机没压在矿上**，是纯浪费（和上面不是一回事）
- 两条同时看才能分清「矿少」和「机器少」

---

## 7. 「balancer 会分流一半」—— **已核实为假**

这是 shapez 社区里最常见的一条「常识」，**它是错的**。

### 真实机制

`default` 变体的 balancer（2×1）有：
- 2 个 acceptor 槽：`(0,0)` 从底、`(1,0)` 从底
- 2 个 ejector 槽：`(0,0)` 朝上、`(1,0)` 朝上

出处：`recon/upstream-full/src/js/game/buildings/balancer.js:179-200`

 ejected 时**不轮转**，而是：

```js
// item_processor.js:146-157
} else {
    // We can eject on any slot
    slot = ejectorComp.getFirstFreeSlot();
}
```

`getFirstFreeSlot()`（`item_ejector.js:117-125`）**返回第一个空槽**，不是随机、不是轮转。

### 这意味着什么

| 说法 | 真值 |
|---|---|
| 「balancer 把输入平均分到两个输出」 | ❌ **假** |
| 「balancer 先填满左边，左边堵了才走右边」 | ✅ **真** |

**后果**：如果一个 balancer 的左边输出接去了 trash，右边接去了 hub，
那么**在左边堵住之前，所有货都进 trash**。这不是「分一半」，是「全扔」。

`capacity-scenario.json` 的 A2 臂就出现了这个现象：模型给 balancer 的空
secondary 接垃圾桶（14/26 次），它以为那是「分流」,实际是「全损」。

### 在哪能核实到

- `balancer.js:179-200` —— 槽位方向
- `item_ejector.js:117-125` —— `getFirstFreeSlot` 的定义
- `item_processor.js:146-157` —— 调用点（`requiredSlot` / `preferredSlot` / 都没有 → 取第一个空槽）

**注意 `requiredSlot` 优先**：cutter 的 `left` 是 `wasteRole`，它走的是
`requiredSlot`，所以 cutter 不适用「第一个空槽」这套。

---

## 8. 已核实的两条布局事实

### 8.1 hub 占地 4×4

```js
// recon/upstream-full/src/js/game/buildings/hub.js:23-25
getDimensions() {
    return new Vector(4, 4);
}
```

**为什么重要**：hub 不是一个格子。任何「接到 hub」的路径规划都必须按 4×4 算入口，
只按 origin 索引会得出错误答案。这个错误在本项目里至少犯过 5 次
（记在 `slots_footprint.test.mjs` 的注释里）。

### 8.2 隧道是 1×1，**不占中间格**

```js
// recon/upstream-full/src/js/game/buildings/underground_belt.js:38
export class MetaUndergroundBeltBuilding extends MetaBuilding { ... }
// 没有覆写 getDimensions ⇒ 用基类默认值

// recon/upstream-full/src/js/game/meta_building.js:49-51
getDimensions(variant = defaultBuildingVariant) {
    return new Vector(1, 1);
}
```

一个隧道由**两个 1×1 的实体**组成（`rotationVariant: 0` = sender，`1` = receiver，
见 `underground_belt.js:43-66`），**中间不占格**。

**为什么重要**：
- 「隧道省带子」这条**是真的** —— 中间可以走别的带子/建筑
- 但 `rotation_variant` 是 **sender/receiver 标志位**，不是转弯形态。
  方向只由 `r` 决定。把 rv 当转弯形态用会算出错误的出口方向。
  这个坑在本项目里也犯过（`ROUTING-OVERRIDE-PLAN.md` 整份计划因此作废）。

---

## 9. 尚未核实、**不得写进经验文本**的项

以下都是常被当成常识的 shapez 知识，但**本仓库没有源码出处**，写进经验文本就是赌博：

| 说法 | 状态 |
|---|---|
| 「长竖直段要留转弯空间」 | 无源码依据，是布局习惯 |
| 「升级比加机器便宜」 | **必须用 §2 + §10 的数字算，不能当结论** |
| 「cutter 必须竖直朝向」 | `LAYOUT_RULES.cutterAlwaysVertical = true`，但**这是本项目的规则表，不是游戏源码** |

**这些要写进经验文本之前，先补核实并在这里加一行 `文件:行号`。**
否则 (b) 形态（手写心得）就是「手写猜测」，A/B 结果没有意义。

---

## 10. 算「升级 vs 加机器」需要的最少数据

要做这条比较，至少要知道：
1. 当前 `processors` 等级 → 查 `UPGRADE_MULTIPLIERS`
2. 下一级需要的形状和数量 → 查 `accumulateTiers`（**含 carry-over**）
3. 那台机器当前速率 → 查 `RATES.machinePerSec`
4. 加一台机器占几格 → 查 `footprint`

`src/agent/assess.mjs` 的 `capacityFor(raw).options` 已经把 1-4 算好了：

```js
options.upgrade = {
  line: "processors", tier: 1,
  multiplierFrom: 1, multiplierTo: 1.5,
  capacityAfter: 0.75,
  affordable: false,
  missing: [{ shape: "SuSuSuSu", short: 500 }]
}
options.addMachines = {
  kind: "cutter", from: 1, to: 4, add: 3,
  capacityAfter: 2, enough: true
}
```

⇒ **「升级 vs 加机器」不是经验，是 `capacityFor` 已经算出来的事实。**
把它写进经验文本 = 用静态文本重复一个动态可算的东西，
这正是红队要攻击的点（见 `REDTEAM-EXPERIENCE-AB.md`）。

---

## 附：核验命令

```bash
cd "D:/Projects/rea/Project work/shapez"
node -e "import('./src/agent/rules.mjs').then(m=>{
  console.log(JSON.stringify({RATES:m.RATES, MULT:m.UPGRADE_MULTIPLIERS, LINE:m.MACHINE_UPGRADE_LINE, LAYOUT:m.LAYOUT_RULES}, null, 1));
})"
```
