# P20 —— Level 7 与 painter：几何全对，但它不消费

日期：2026-11-09
前置：P19 打完 level 6（`Cu------` 197/270 → 完成），hub 升到 level 7，目标变成 `CrCrCrCr`。

---

## 1. 现状

```
level 7 | CrCrCrCr 0/300 | 149 实体
矿种: CuCuCuCu×108, RuRuRuRu×87, red×69, blue×19, green×153
机器: miner×5, cutter×5, rotater×3, balancer×2, trash×5, hub×1
```

**painter 一台都没有。** 配方是：

```
CuCuCuCu ─mine→ color:red ─mineColor→ CrCrCrCr ─paint/red→
```

也就是：铜形状 + 红色颜料，送进 painter。

---

## 2. 试了什么

### 2.1 painter 能放下

```json
{"op":"place","building":"painter","x":51,"y":25,"r":0}
→ ok:true, uid:11335, code:16, variant:"default"
```

`tx` 的 `verify` 全绿，`uid_set_equal: true`。游戏接受它。

### 2.2 几何按游戏源码搭

`painter.js#setupEntityComponents`：

```js
ItemEjector.slots  = [{ pos:(1,0), direction: right }]
ItemAcceptor.slots = [{ pos:(0,0), direction: left,  filter:"shape" },
                      { pos:(1,0), direction: top,   filter:"color" }]
```

即 2×1：**形状从左进、颜色从上方进、成品从右出**。

搭了一套最小场景（铜矿 `50,27`、painter `51,25`、红矿 `52,22`）：

```
  49 50 51 52 53 54
y=21   .  . b3v1 b0v1 .
y=22   .  . b2v0  M   .
y=23   .  . b2v0  .   .
y=24   .  . b2v1  .   .
y=25   . b0v2  P   .  .
y=26   . b0v0  .   .  .
y=27   .  M   .   .   .
```

形状线（2 格）和颜色线（6 格）都接上了。修掉了两个真问题：
- `connect` 把带子铺到了 color 入口格 `52,24` 上（那里必须空着，货从上方落下）
- `51,24` 的朝向反了

### 2.3 结果：两条线都堵在 painter 前

```
3 货  [50,26],[50,25]              ← 形状线，停在 shape 入口
8 货  [52,21]...[51,24]            ← 颜色线，停在 color 入口
```

**painter 一个都不消费。** hub 里 `CrCrCrCr` 恒为 0。

---

## 3. 排除了什么

### 3.1 不是解锁问题（表面上）

`painter.js#getIsUnlocked`：

```js
return root.hubGoals.isRewardUnlocked(enumHubGoalRewards.reward_painter);
```

`levels.js` 里 **第 6 关（`Cu------`）的 reward 就是 `reward_painter`**。
我们刚从 level 6 升到 level 7 ⇒ 按这份表 painter 应该已解锁。

### 3.2 不是槽位几何问题

从存档读回来的实体：`code:16, variant:"default", r:0` —— 与 `op-templates` 一致。
`portsOf` 算出的三个槽位（shape←左、color←上、out→右）与游戏源码逐条吻合。

### 3.3 不是存档没存

`save_now` 后 `list_saves` 显示 `level: 7`。

---

## 4. 卡在哪

**没有手段能读运行时的 `gainedRewards`。**

- obs 只说 painter 实体在那儿
- `debug_items` 只说货堵着
- 日志一片安静（没有任何报错）
- 存档的 `hubGoals` 只有 `level` / `storedShapes` / `upgradeLevels` 三个键
  —— `gainedRewards` **不是存档字段**，它由 level 推导
  （`hub_goals.js:45-52` 的循环）

所以「没解锁」和「接错了线」在外部**无法区分**。

---

## 5. 这一轮加的诊断能力

### 5.1 `debug_rewards` RPC（mod）

```js
debugRewards() {
    const gained = this.root.hubGoals.gainedRewards || {};
    out.rewards = Object.keys(gained).filter(k => gained[k]);
    out.probes = { reward_painter: !!gained.reward_painter, ... };
}
```

**需要重载游戏才生效**（mod 是启动时加载的）。

### 5.2 `decodeSaveFile()` 加了 `rewarded`

从存档直接读出推导结果，不必重载。但它读到的是**存档时刻**的推导，
而游戏在运行中可能因为 freeplay 模式或别的路径改动 `gainedRewards`。

---

## 6. 下一步（按顺序）

1. **重启游戏，跑 `debug_rewards`。** 这是唯一能确认「painter 到底解锁没有」的办法。
   - 若 `probes.reward_painter === false` ⇒ 解锁问题，得看这个存档的关卡表为什么与
     `levels.js` 不同（存档 `version: 1010`，可能对应另一份定义）。
   - 若 `true` ⇒ painter 解锁了但不消费，那是更深的问题（可能 painter 需要
     `upgradeLevels.painting ≥ 1`，而 `getIsUnlocked` 只查 reward —— 两者可能不一致）。

2. 如果 painter 确实不可用，`CrCrCrCr` 这条路就断了，得先做别的：
   - 产能（`瓶颈 cutter，利用率 83%`，铜矿 108 格只用 2 格）
   - 或者先刷 `upgradeLevels.painting`（它需要 `RbRb----`×600，而那也要 painter —— 死锁）

3. 顺带该还的债：**cutter 的 `left`/`right` 与配方 `half` 语义相反**（P19 §4）。

---

## 7. 测试

618 全绿（584 + 新增 34：save_codec 与 mod 相关的既有用例）。

---

## 8. 数据位置

- `.tmpverify/capacity/obs-l7*.json` —— level 7 的观测快照
- `.tmpverify/capacity/ops-p2.json` —— 最小 painter 场景的 ops
