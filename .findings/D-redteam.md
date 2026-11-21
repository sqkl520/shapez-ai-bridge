# 方向 D：红队 —— 攻击调查前提

## 结论（一句话）

「L12 交付恒为 0」这个**数字**是真的（我复现到 stored 合计 145709、100 片 1000 秒全空），但简报给它的**四条佐证里有三条是误读**：①「货确实在动」错——376 件里 368 件在 60 游戏秒内位移 0.0000 格，是硬死锁不是流动；②「20 个 ejector 工作正常」错——实为 19 个且 18 个 `progress=1` 卡死；③「stored 不变 / delivered=0 / stored_delta=0」不是三条独立证据，而是**同一个变量 `hubGoals.storedShapes` 被读了三次**。真正的独立证据只有 `produced_total` 与 `delivered_total`，而它们的空是**另一个原因**（全线零产出）。

并且确实存在一个**完全没有 bug** 的解释，见第 5 条。

---

## 逐条攻击

### 1. `hub.stored_shapes` 的语义

**「累计账本」不成立；简报的测量方法本身是对的，但结论被过度解读了。**

`storedShapes` 是**当前库存余额**，不是历史账本：

- `recon/upstream-full/src/js/game/hub_goals.js:18-24` —— `storedShapes: types.keyValueMap(types.uint)`，是随存档序列化的状态字段。
- `hub_goals.js:219-222` —— `handleDefinitionDelivered()` 里 `storedShapes[hash] += 1`，每交付一件 +1。
- `hub_goals.js:151-157` —— `takeShapeByKey()` 里 `storedShapes[key] -= amount`，**买升级会扣**。

所以它是「实时余额」：交付加、买升级减。桥里 `src/mod/shapez-ai-bridge.js:729` 的注释写「只报**累计库存**」措辞偏松，但 `hubSnapshot()`（`shapez-ai-bridge.js:1649-1662`）读的就是这个实时余额 —— 简报把它当余额来测，**方法正确**。

**但这里藏着一个简报没意识到的漏洞**：因为买升级会扣，所以「20000 tick 内合计不变」严格来说不能单独证明零交付（可能是「交付了但同时买了升级」）。本轮可以排除该混淆——`upgrade_levels` 始终保持 `belt:1 miner:2 processors:0 painting:1`，且合计值分毫未动。但这个论证需要额外核对，简报没有做。

**更严重的是第 4 条会说明：`stored_shapes`、`goal.delivered`、`production.stored_delta` 三者同源**，不构成互相印证。

### 2. `production` 窗口问题

**「60 秒窗口漏掉了更早的交付」不成立。** 我用 `slices:100`（1000 秒）复测：

```
window_seconds=1000, slices_returned=100
produced_total={}   delivered_total={}
produced_slices 非空 0/100
delivered_slices 非空 0/100
stored_delta 22 个键全部为 0
```

1000 秒（≈16.7 分钟游戏时间）内**连一片非空都没有**。窗口假设被排除。

**但我还发现了简报没测的东西**：`produced_total` **也是空的**。这不是「没交付」，是**整张图 1000 秒内没有任何产出一件东西**。依据：`production_analytics.js:55-62` 的 `onItemProduced` 只有 `systems/miner.js:77` 与 `systems/item_processor.js:318` 两处会触发；两处都没触发过，说明矿机和加工机一件都没吐出来。

另外一个**独立的**（与本条攻击无关但与简报方法有关的）事实：`productionAnalytics` **根本不进存档** —— `recon/upstream-full/src/js/savegame/savegame_serializer.js:33-45` 的 dump 里没有 `productionAnalytics`，`recon/upstream-full/src/js/game/root.js:135` 直接置 `null`。所以它的 history 每次读档都会清零重来。这不是本次结论的成因（我在 1× 实时下连续观察 60 秒 + 多种窗口都空），但它意味着**任何「用 production 判断历史」的结论都必须附带你观察了多久**，否则窗口天然可疑。

### 3. `step` 是否真的推进了游戏逻辑

**「step 期间 productionAnalytics 不 update，切片不轮转」不成立 —— 这个 bug 早就修好了，而且已部署。**

- 源码 `src/mod/shapez-ai-bridge.js:4139-4145`：`for (let i=0;i<ticks;++i){ root.time.performTicks(...); root.productionAnalytics.update(); }`
- **实际部署的 mod**（`C:\Users\Administrator\AppData\Roaming\shapez.io\mods\shapez-ai-bridge.js`）第 **4108-4109 行**有一模一样的调用 —— 不是「修了但没部署」。
- 对照游戏主循环 `recon/upstream-full/src/js/game/core.js:284-293`，每帧也是 `performTicks` + `productionAnalytics.update()`；切片轮转在 `production_analytics.js:128-133`，超过 `analyticsSliceDurationSeconds`（正式版 10 秒，`core/config.js:66`）就 `startNewSlice()`。

我还做了**不依赖 step 的实时对照**：以 `speed=regular` 实时跑，`status.tick` 在 30 实测秒内精确前进 30.02 游戏秒（1× 无失真），期间 `produced_total` 仍为空。所以**不是 step 把逻辑弄坏了**，是产线本身没在产出。

### 4. `goal.requirement.delivered` 的语义

**它是当前关卡的实时进度，不是本关历史最好值 —— 这部分简报读对了。但它的独立性是假的。**

`hub_goals.js:171-182`：

```js
getCurrentGoalDelivered() {
    if (this.currentGoal.throughputOnly) {
        return this.root.productionAnalytics.getCurrentShapeRateRaw(
            enumAnalyticsDataSource.delivered, this.currentGoal.definition
        ) / globalConfig.analyticsSliceDurationSeconds;
    }
    return this.getShapesStored(this.currentGoal.definition);   // ← 普通关卡走这里
}
```

L12 不是 throughput-only（`recon/upstream-full/src/js/game/modes/levels.js:248-254`，`required:1000`，无 `throughputOnly` 字段），所以 L12 的 `delivered` **就是 `storedShapes["CbCbCbRb:CwCwCwCw"]`**。

**这是本次红队最重要的一条方法论发现**：简报把

- 「`delivered_total` 是空对象」
- 「hub 存量 145709 → 145709」
- 「目标 0/1000」

当成三条互相印证的证据。实际上第 1 条（`delivered_total`）来自 analytics 的 `delivered` 切片（`production_analytics.js:46-50`），第 2、3 条**都是 `hubGoals.storedShapes` 这一个数字**，而且还漏了第三条同源读数——`production.stored_delta` 也不是独立观测，`startNewSlice()` 每片就是 `Object.assign({}, this.root.hubGoals.storedShapes)`（`production_analytics.js:71`）。

也就是说：**「存量不变」和「进度 0/1000」是同一个事实念了两遍，不构成两个证据。** 真正独立的只有 `produced_slices` / `delivered_slices`（analytics 自采），而它们为空的原因见第 2 条。

顺带一个正面确认：`storedShapes` 是 hub 的**真实余额**而非仅"目标形状库存"——`handleDefinitionDelivered`（`hub_goals.js:219-222`）对**任何**形状都 `+1`，只在 `getCurrentGoalDelivered()` 里才和目标哈希比对。所以库存里能出现 22 种"垃圾形状"而目标仍是 0，这完全正常。

### 5. 有没有「根本没有 bug」的解释

**有，而且不止一个，它们同时成立。**

我实测到的事实：
- `hub.stored_shapes` 合计 **145709**，共 22 个键，**没有任何一个含 `:`**（即全图从未产出过任何 2 层形状）。
- 目标形状 `CbCbCbRb:CwCwCwCw` 在库存里 **值为 0（键都不存在）**。
- 全图 376 件在带货物：`{blue:210, ScSc----:139, CuCuCuCu:12, ----CuCu:7, green:5, red:4}`。
- 全图 19 个 ejector 槽上的货：也是 `red/blue/green` 颜料 + `SuSu----/----SuSu/CuCu----/----CuCu/RuRuRuRu/CuCuCuCu` 半成品。
- **带子上和 ejector 上都没有一件 `CbCbCbRb:CwCwCwCw`。**

**(a) 一半以上的"在流货物"物理上不可交付。** `blue/green/red` 共 **219 件**是 `ColorItem`（`items/color_item.js:27-29` 的 `getItemType()` 返回 `"color"`），而 hub 的 16 个入口全部 `filter: "shape"`（`buildings/hub.js:79-82`），`ItemAcceptorComponent.canAcceptItem()` 第一行就是 `!slot.filter || slot.filter === item.getItemType()`（`components/item_acceptor.js:83-86`）—— **颜料到 hub 门口就被类型挡掉，永远进不了 `storedShapes`**。所以「375 件在流」里只有 **157 件是形状**，其余 219 件根本不参与交付。

**(b) 剩下 157 件形状也一件都不是目标。** 它们是 `ScSc----`（半截星）、`----CuCu`（半截铜圆）、`CuCuCuCu`（纯铜圆）等中间品。hub 会照收（`hub_goals.js:221` 对任意形状 +1），只是**按自己的哈希入账**，所以库里堆了 `CrCrCrCr:41662`、`Cu------:33532` 这类，而目标键始终为 0。这是设计行为，不是 bug。

**(c) 全图结构上就造不出目标形状。** 目标是 2 层（`layer0 = CbCbCbRb`，`layer1 = CwCwCwCw`）：需要蓝色圆/蓝矩形 + **白色**（白色只能两次 mixer 混出来，见 `hub_goals.js` 与本仓 memory `shape-code-vs-color-code`）。而 `upgrade_levels = {belt:1, miner:2, processors:0, painting:1}` —— **processors 升级 0 级、painting 仅 1 级**，全图只有 1 台 stacker、1 台 rotater、4 台 mixer。库存里连一个含 `:` 的 2 层形状都没有，证明**这台工厂从未成功做出过任何 2 层形状**。

**(d) 附赠：连"货在动"都是误读。** 这是我攻击简报最狠的一刀。60 游戏秒实测（`status.tick` 精确前进 60.1 秒）：

```
path0  items 4->4   first +0.1110   (10 格，填充 25%)
path4  items 12->12 first +0.0000   ← 冻结
path5  items 7->7   first +0.0000   ← 冻结
path8  items 259->259 first +0.0000 ← 冻结，165 格，填充 98.9%
path15 items 4->4   first +0.1110
path19 items 3->3   first +0.0000   ← 冻结
path20 items 87->87 first +0.0000   ← 冻结，55 格，填充 99.7%
总件数 376 -> 376（一件没动、一件没新增）
```

只有 2 条低填充小路径蠕动 0.111 格/分钟。`belt_path.js:1130-1200` 的推进逻辑 `clampedProgress = nextDistance - minimumSpacing`（1163-1175 行）在两件间距已压到 `itemSpacingOnBelts=0.63` 且整条带满时恒为 0 —— **两条主带已经压到理论容量 98.9% / 99.7%，物理上不可能再动**。

**(e) 卡死还向上游传导，把产出也掐死了。** 19 个 ejector 里 **18 个 `progress=1`**（`systems/item_ejector.js:163-190`：progress 到 1 后 `tryAcceptItem` 因下游满而失败，`sourceSlot.item` 不清空，永远卡在 1）。矿机（如 `RuRuRuRu@2,-6`）就卡在这里 → `systems/miner.js:77` 的 `itemProduced` 永不触发 → `produced_total` 全域为空。这解释了我第 2 条里那个"整图零产出"的独立现象。

**(f) 目标货运的是空带，货堵在不通 hub 的带上。** 5 条带子末端贴着 hub 入口：`path2`(29 格)、`path3`(79 格)、`path24`(81 格) —— **全部 `items=0`**。而载满货的 `path8`、`path20` **都不通 hub**，且 `path20` 的 `boundAcceptor = null`（末端 `[37,-40]` 东侧是 `belt@38,-40`，但方向不匹配，`belt_path.js:227/265/276/282` 返回 `{}`），即**死路**，87 件蓝色颜料堆到 99.7%。

**(g) 顺带发现一个真实的布局缺陷（不是测量 bug）**：hub 北侧入口线 `y=-3, x∈{-2,-1,0,1}` 上，`(-2,-3)` 空、`(-1,-3)` 是带子、**`(0,-3)` 和 `(1,-3)` 是 `trash` 垃圾桶**。垃圾桶直接压在 hub 的两个入口格上，这大概率是历史上把入口当空地随手放了垃圾桶 —— 这是真实的设计错误，但它改变不了上面 (a)-(f) 的结论，反而进一步说明"进 hub 的路本来就少而又被堵/被占"。

**综上：(a) 收不下 + (b) 不是目标 + (c) 造不出 + (d) 根本没在动 + (e) 产出被掐死 + (f) 货堵在不通 hub 的死路上 + (g) 入口被 trash 占**。这一套解释**没有任何一处需要 mod/桥出 bug**。`delivered=0` 是这台工厂当前状态的**正确答案**，不是测量错误。

---

## 我认为简报里最可能误读的一条

**「带上有 375 件货在流」+「货确实在动（不同时刻 pos 值变化）」—— 这条错得最离谱，也最误导。**

360 多件货里 **368 件在整整 60 游戏秒内位移 = 0.0000**，整图总件数纹丝不动（376→376，无新增无消失）。简报大概是抓住了少数几件（观测时恰好有 8 件在蠕动 0.03~1.8 格，见 4 秒采样）就下了"货在动"的判断 —— 而这正是本仓 memory `computed-but-never-delivered` 警告的那类"算了但没送到"的镜像：**看到了 pos 在变，就以为整条线在流**。

这条误读会把调查引向"货到了 hub 但没入账"（怀疑入账 bug），而真相是"货压根没到 hub，堵在两条 99% 满的死路上，且一半是不能入账的颜料"。**排查方向会被带偏整整一轮。**

第二个值得记的是方法论：**`stored_shapes` / `goal.delivered` / `production.stored_delta` 是同源三重读数**，简报把它们的吻合当成"三重印证"，实际上只是把同一个数念了三遍。这个坑以后任何"交付为 0"的调查都会再踩一次。

---

## 复现命令（只读，脚本留在 `.tmp-d/`）

- `.tmp-d/q.mjs` —— 一次拿 status/obs/production(6 与 100 片)/world_info
- `.tmp-d/frozen.mjs` —— 60 游戏秒的逐路径位移对比（核心反证）
- `.tmp-d/deep.mjs` / `.tmp-d/geo.mjs` —— 逐路径成分、末端几何、hub 入口邻居
- `.tmp-d/hubfeed.mjs` —— 哪些带子末端真的贴 hub、analytics 交叉核对
- `.tmp-d/hubdoor.mjs` —— hub 入口线逐格检查（发现 trash 占位）

## 引用的源码位置（全部只读，未改 `src/`）

| 事实 | 位置 |
|---|---|
| storedShapes 是实时余额（可加可减） | `recon/upstream-full/src/js/game/hub_goals.js:18-24, 151-157, 219-222` |
| goal.delivered = storedShapes[goalHash]（同源） | `recon/upstream-full/src/js/game/hub_goals.js:171-182` |
| L12 目标非 throughput-only | `recon/upstream-full/src/js/game/modes/levels.js:248-254` |
| delivered 切片按形状自增 | `recon/upstream-full/src/js/game/production_analytics.js:46-50` |
| produced 只在矿机/加工机触发 | `recon/upstream-full/src/js/game/systems/miner.js:77`, `systems/item_processor.js:318` |
| stored 切片 = storedShapes 的拷贝（非独立） | `recon/upstream-full/src/js/game/production_analytics.js:67-79` |
| 切片 10 秒轮转 | `recon/upstream-full/src/js/game/production_analytics.js:128-133` + `core/config.js:66` |
| analytics 不进存档 | `recon/upstream-full/src/js/savegame/savegame_serializer.js:33-45`, `game/root.js:135` |
| 主循环每帧 update analytics | `recon/upstream-full/src/js/game/core.js:284-293` |
| step 期间也 update（源码 + 已部署） | `src/mod/shapez-ai-bridge.js:4139-4145`；mods 目录同名文件 `:4108-4109` |
| hub 十六入口全是 `filter:"shape"` | `recon/upstream-full/src/js/game/buildings/hub.js:79-82` |
| 颜料被类型闸挡掉 | `recon/upstream-full/src/js/game/components/item_acceptor.js:83-86`, `items/color_item.js:27-29` |
| 带满即 `clampedProgress=0` | `recon/upstream-full/src/js/game/belt_path.js:1130-1200` |
| ejector 卡在 progress=1 | `recon/upstream-full/src/js/game/systems/item_ejector.js:163-190` |
| 桥 observeProduction 默认 6 片 | `src/mod/shapez-ai-bridge.js:741-794` |
| 桥 hubSnapshot / goalSnapshot | `src/mod/shapez-ai-bridge.js:1649-1684` |
