# shapez.io AI 可操作接口 —— 阶段 0 侦察报告

> 日期：2026-10-19/20　方法：只读解包 + 锚点搜索 + 真实存档解码
> 证据等级：【观测】直接看到源码/实测　【推断】从结构推断　【待验】需实机验证
> 所有行号引用 `recon/bundle.pretty.js`（美化后的游戏代码，原始为 `recon/bundle.js`）

---

## 1. 类型识别

| 特征 | 实测结果 |
|---|---|
| 游戏 | shapez.io（Steam appid 1318690），安装于 `D:\Steam\steamapps\common\shapez.io` |
| 游戏代码版本 | **1.5.6 @ commit ee2279d5**（bundle.js 首行注释原文）【观测】 |
| Electron 版本 | **16.2.8**（asar 内 package.json）【观测】 |
| 打包形式 | `resources/app.asar`（184 MB）+ `app.asar.unpacked`（steamworks 原生库）【观测】 |
| 主 bundle | `bundle.js` 2.4 MB minified、单行 webpack 产物；**无 sourcemap**【观测】 |
| 源码路径映射 | webpack 保留了 **318 条原始源码路径**（`recon/source_paths.txt`）——等于还原了上游目录树【观测】 |
| mods 目录 | `%APPDATA%\shapez.io\mods`（实测存在，当前为空）【观测】 |
| 存档目录 | `%APPDATA%\shapez.io\saves`（有一份真实 level 10 存档，已成功解码）【观测】 |
| 上游开源仓库 | 官方 repo（tobspr/shapez.io）与本版本的对应性核验进行中【待验】 |

**这是 Electron + webpack JS，游戏逻辑全部在渲染进程的 `bundle.js` 里。** 关键的是：**官方内置 Mod 加载器**（主进程读文件、渲染进程求值），这是一等公民路线，不需要 patch bundle。

### 渲染进程安全配置（直接决定 D1 桥接拓扑）【观测：index-main.js】

```
nodeIntegration: false        (index-main.js:69)
contextIsolation: true        (index-main.js:72)
sandbox: true                 (index-main.js:77)
preload: preload.js           (index-main.js:78)
```

preload.js 全文只有 8 行，向页面暴露 `window.ipcRenderer` 的 `invoke/on/send` 三个方法【观测】。

**结论：游戏里的 Mod 没有任何 Node 权限**（`require("http")` 不可能）。但渲染进程是完整 Chromium，**原生 `WebSocket` 永远可用**，且 index.html **没有 CSP**【观测：grep 无内容安全策略】。

→ **D1 预判 = 方案 B（外部宿主起 WebSocket 服务端、Mod 当客户端）**，这不是选择而是被安全配置锁定的结果。

### 其他环境事实（对设计有影响）

- **每次启动游戏都会 `session.clearCache()` + `clearStorageData()`**（index-main.js:92-93 附近的 createWindow 里）→ Mod 不能用 localStorage 持久化任何东西。【观测】
- 装任何 mod 后 **Steam 成就/拼图 DLC 自动禁用**（`if (mods.length === 0) steam.listen()`，index-main.js:388）→ 影响是官方预期的，写进 README 即可。【观测】
- `--load-mod=path1,path2` CLI 参数可加载任意路径的 mod；`--safe-mode` 禁用全部 mod。【观测】
- 页面禁止 navigation / 新窗口（will-navigate / new-window 被 preventDefault）→ 不影响 WebSocket。【观测】

---

## 2. 逆向结论 Q1–Q6（全部拿到【观测】级）

### Q1：Mod 加载机制

**没有 `mod.json` 清单文件——mod 是单文件 `.js`，元数据是文件内的 JS 对象。**

加载全流程【观测：index-main.js:350-360 + bundle.pretty.js:9636-9760】：

1. 主进程 `fs.readdirSync(modsPath).filter(f => f.endsWith(".js"))` 读全部 `.js` 文件内容
2. 渲染进程经 `ipcRenderer.invoke("get-mods")` 拿到源码数组
3. 每份源码被**追加一段尾巴**后 `new Function(src)()` 求值：
   ```js
   if (typeof Mod !== 'undefined') {
       if (typeof METADATA !== 'object') throw new Error("No METADATA variable found");
       window.$shapez_registerMod(Mod, METADATA);
   }
   ```
   所以 mod 文件里定义两个全局：`class Mod { init() {} }` 和 `const METADATA = {...}`。
4. `METADATA` 必需字段：`id`、`version`；可选：`minimumGameVersion`、`name`、`author`、`website`、`settings`（默认设置对象）、`doesNotAffectSavegame`（true 则不记录进存档）
5. `minimumGameVersion` 用 semver 校验，不满足 → `alert` 明确报错并跳过该 mod（**硬失败，符合要求**）
6. mod 的 `settings` 自动持久化到 `%APPDATA%\shapez.io\saves\modsettings_<id>__<version>.json`，且注入 `saveSettings()` 回调
7. 实例化：`new ModClass({ app, modLoader, meta, settings, saveSettings })`，然后调 `mod.init()`（bundle.pretty.js:32715 Mod 基类）
8. **加载时机：`app` 构造函数内、状态机启动之前**（`MODS.initMods()`，one of the first things）→ mod 可以监听全部生命周期信号，不会错过游戏启动

**Mod 实例可用的三个能力面**【观测】：
- `this.signals` = MOD_SIGNALS（11 个生命周期信号：appBooted / gameInitialized / gameStarted / gameSerialized / gameDeserialized / stateEntered / modifyLevelDefinitions / modifyUpgrades / hudInitializer / hudElementInitialized / hudElementFinalized），定义于 bundle.pretty.js:7154
- `this.modInterface` = ModInterface（bundle.pretty.js:21909 起的方法表）：
  `registerCss / registerSprite / registerAtlas / registerSubShapeType / registerTranslations / registerItem / registerComponent / registerGameSystem / registerGameSystemDrawHook / registerNewBuilding / registerIngameKeybinding / setBuildingToolbarIcon / registerGameTheme / registerGameState / addNewBuildingToToolbar / replaceMethod / runBeforeMethod / runAfterMethod / extendObject / extendClass / registerHudElement / registerBuildingTranslation / registerBuildingSprites / addVariantToExistingBuilding` + `dialogs` getter
  ——**`replaceMethod` / `runBeforeMethod` / `runAfterMethod` 允许从 mod 侧热补丁任意游戏方法**，不需要改 bundle 文件
- `this.app` = Application 实例（进入游戏后经 `app.stateMgr.currentState.core.root` 拿到游戏根对象）

### Q2：Mod 能拿到的根对象

**【观测】两层根对象：**

1. **`window.shapez`**：modloader 初始化时 `exposeExports()`（bundle.pretty.js:9681）把全部 318 个源码模块的导出以 live getter/setter 挂到全局。
   已验证导出的关键名字：`GameRoot / GameCore / GameLogic / GameMode / HubGoals / Blueprint / Vector / MapView / EntityManager / ShapeDefinition / MetaBuilding / MetaBeltBuilding / BeltComponent / ItemEjectorComponent / BasicSerializableObject / MOD_SIGNALS / enumDirection / enumHubGoalRewards …`（全模块导出，数量很大）
2. **游戏运行根对象 `root`（GameRoot 实例）**：由 `MOD_SIGNALS.gameStarted` 信号派发（bundle.pretty.js:17558 `gameStarted.dispatch(this.core.root)`）。
   root 上的字段（bundle.pretty.js:3497 构造函数全字段）：
   `root.map`（MapView）`root.logic`（GameLogic）`root.entityMgr`（EntityManager）`root.hubGoals`（HubGoals）`root.time`（GameTime）`root.dynamicTickrate` `root.camera` `root.hud` `root.systemMgr` `root.signals`（游戏内部信号）`root.gameMode` `root.savegame` `root.app` …

**读世界**：`root.entityMgr.entities`（数组）/ `getAllWithComponent(Comp)` / `findByUid(uid)`；`root.map.getLayerContentXY(x, y, layer)` 按坐标查实体；`root.hubGoals.storedShapes` / `getShapesStoredByKey(hash)` / `level` / `getCurrentGoalDelivered()`。

### Q3：实体与方块数据模型

**观测自真实存档解码 + 源码双证。**

```jsonc
// 一个实体（解码自真实存档）
{
  "uid": 10002,
  "components": {
    "StaticMapEntity": { "origin": {"x": -7, "y": 5}, "rotation": 90, "originalRotation": 90, "code": 7 },
    "Miner":           { "lastMiningTime": 20653.2666, "itemChainBuffer": [] },
    "ItemEjector":     { "slots": [ { "item": null, "progress": 1 } ] }
  }
}
```

- 实体 = `uid` + 组件字典；`StaticMapEntity` 是所有建筑共有的"位置组件"【观测：savegame_serializer.js 对应物 bundle.pretty.js:25327 反序列化路径】
- **建筑类型不是字符串而是数字 `code`**：`registerBuildingVariant(code, metaClass, variant, rotationVariant)` 注册（bundle.pretty.js 的 `getBuildingDataFromCode`），code ↔ (建筑ID, variant, rotationVariant) 双向查表。真实存档实测 code 有 1,2,3,4,7,9,11,15,16,20,22,23,26 等 14 种【观测】
- 组件类型实测：`Miner / ItemEjector / ItemProcessor / UndergroundBelt / WiredPins`（真实存档 1544 实体统计）【观测】
- 单位与坐标：tile 整数坐标（origin 可负），rotation ∈ {0,90,180,270}；传送带变体按方向枚举【观测】
- 形状（物品）用短字符串表示：`"CuCuCuCu"`、`"RuRu----"` 等，4 象限 × 2 字符（形状字母 + 颜色字母），如 `Cu`=圆形-未染色象限、`Ru`=矩形-红色象限……（字母→形状/颜色语义【推断】，颜色集从存档 values 表里确认为 cyan/red/blue/green/yellow/purple/white 系）【观测+推断】

### Q4：世界写入 API

**全部存在且是公开可调的实例方法**【观测，bundle.pretty.js 29400-29590 区段】：

```js
// 放置：先建实体再检查
logic.tryPlaceBuilding({ origin, rotation, rotationVariant, originalRotation, variant, building })
  → 成功返回 entity，失败返回 null
logic.checkCanPlaceEntity(entity, { allowReplaceBuildings: true, offset }) → bool
logic.freeEntityAreaBeforeBuild(entity)     // 需要替换时先清位
logic.tryDeleteBuilding(entity) → bool
logic.canDeleteBuilding(entity) → bool

// 批量（游戏自己 mass-delete 就是这么干的）
logic.performBulkOperation(fn)              // 期间批量标记，结束时一次性结算
logic.performImmutableOperation(fn)         // 不可变结构快照
logic.clearAllBeltsAndItems()               // 清全部传送带与物品（puzzle 校验就用它）

// 蓝图（内存对象，不是字符串！）
Blueprint.fromUids(root, uidArray) → Blueprint    // 从选区抓蓝图
blueprint.tryPlace(root, offset) → bool           // 一次性放置全部（内部走 bulkOperation）
blueprint.rotateCw() / rotateCcw() / canPlace(root, offset) / canAfford(root) / getCost()
```

- **蓝图有材料成本**：`getCost() = findNiceIntegerValue(4 × n^1.1)`，按"蓝图形状"（`gameMode.getBlueprintShapeKey()`，regular = `"CbCbCbRb:CwCwCwCw"`）从 HUB 存量扣；`gameMode.getHasFreeCopyPaste()` 为 true 的模式免费。【观测+推断：扣费点在放置流程内】
- **1.5.6 没有蓝图字符串格式**【观测：全量搜索 `blueprintString`/`btoa`/`clipboardCopy 调用方` 均无】——剪贴板助手存在但无人调用，蓝图从未序列化过。1.5.6 的"复制粘贴"是内存对象 + `pasteLastBlueprint` 键位。
  → **这是 D2 最重要的坏消息也是机会**：不能直接 paste 游戏原生蓝图字符串（不存在），但**存档序列化技术可以直接复用**（见 Q6），自定义一套"蓝图字符串"是可行且必要的。

### Q5：游戏 tick 机制（D3 的地基）

**【观测】游戏自己就有一段"无渲染快进"代码**（puzzle 校验，bundle.pretty.js:32020）：

```js
// puzzle 编辑器 "validatePuzzle"：同步模拟 30 秒游戏时间 = 300Hz × 30s = 9000 ticks
var ticks = this.root.gameMode.getFixedTickrate() * globalConfig.puzzleValidationDurationSeconds;
for (var i = 0; i < ticks && tickStep(); ++i)
    this.root.time.performTicks(deltaMs, this.root.gameState.core.boundInternalTick);
```

机制拆解：
- `GameTime.performTicks(deltaMs, tickFn)`（bundle.pretty.js:30070）：把 `deltaMs` 加进 `logicTimeBudget`，然后 `while (budget >= deltaMs) { budget -= deltaMs; tickFn(); timeSeconds += deltaSeconds }`
- 每个 tick 的内容 = `core.updateLogic()`（bundle.pretty.js:27700）= `entityMgr.update()` + `systemMgr.update()`（传送带物流系统在 systemMgr 里）——**不含任何渲染、相机、存档逻辑**
- `deltaSeconds` 是**固定值**（`1/tickRate`）而不是实际帧间隔 → **喂多少 tick 就推进多少逻辑时间，完全确定**【观测】
- 正常模式下 tickRate 默认 60Hz（=设置里的刷新率，最高 500Hz）；**puzzle 模式是 300Hz 固定 tickrate**（`getFixedTickrate() → 300`，且 `getIsDeterministic() → true`）【观测】
- 速度类：`Paused(×0) / Regular(×1) / FastForward(×3×globalConfig.fastForwardSpeed)`【观测】
- 唯一的注意点：`performTicks` 内如果 `root.hud.shouldPauseGame()` 为 true 会把预算清零；且速度中途改变会 break【观测】→ 快进前需确认无对话框打开，且不换速度。

**结论：`step(ticks)` 原语可行，且实现方式就是抄游戏自己的 puzzle 校验循环。** 代价（破坏手感/可能触发成就禁用）写 README。

### Q6：存档与序列化格式

**格式完全解开，并已写出可工作的解码器（`recon/decode_full.cjs`），成功解码了本地真实存档。**

```
文件字节布局：
[1 字节 version=1][LZString 压缩的文本，URI-safe 91 字符字母表]
   └─ 解压后 = [40 字符校验头 "crc32---------------------------XXXXXXXX"] + [JSON]
        └─ JSON = { keys: [...], values: [...], data: {...} }   ← 字典压缩
             keys/values 里的字符串被替换为单字符（91 字符自定义字母表，字符↔整数编码）
```

- 校验头是 crc32（40 字符里嵌 8 位 hex），字符串拼接了 globalConfig 的一段路径做盐【观测】
- 字典压缩 `compressObject`（bundle.pretty.js:17699）：对象键 → `keys[]` 索引编码；字符串值 → `values[]` 索引编码；整数编码字母表 `"!#%&'()*+..."` 可用小脚本完整复现
- 存档 JSON 顶层：`{version, dump:{camera, time, map, gameMode, entityMgr, hubGoals, entities[], beltPaths, pinnedShapes, waypoints, modExtraData}, stats, lastUpdate, mods}`【观测：解码真实存档 + 源码 18333】
- **`dump.modExtraData: {}` 是官方给 mod 留的存档扩展位**，配合 `MOD_SIGNALS.gameSerialized / gameDeserialized` 两个信号可读写（schema 1010 的迁移函数专门初始化了它）【观测】
- 存档 schema 版本 = **1010**（`savegame/schemas/1010.js`，真实存档里也是 1010）——本地代码/存档完全配平【观测】
- 另：游戏内所有持久化文件（app_settings.bin、savegames.bin、modsettings_*.json）走同一个 `ReadWriteProxy.serializeObject`（bundle.pretty.js:11170），格式一致
- **应用价值**：外部工具可以**不开游戏**离线解析/生成/对比存档；"蓝图字符串"可以借用同一套压缩技术做到短小；save/load 动作原语直接可用（游戏自带的存读档走 `gameState.doSave()`）

---

## 3. 值得做的地方（菜单）

按「价值 ÷ 成本」排序：

| # | 机会点 | 为什么值得做 | 已有证据 |
|---|---|---|---|
| ① | **官方 Mod 加载器直接接入** | 单文件 `.js` + METADATA，装/卸 = 拷贝/删除一个文件；有 settings 持久化、生命周期信号、`replaceMethod` 热补丁 | Q1 全【观测】 |
| ② | **观测空间已完整建模** | 实体/组件/坐标/形状/目标进度全有官方只读 API，且真实存档验证过 1544 实体的数据结构 | Q2/Q3【观测】 |
| ③ | **动作空间几乎现成** | `tryPlaceBuilding/tryDeleteBuilding/Blueprint.tryPlace/performBulkOperation` 都是公开实例方法，AI 动作原语直接映射 | Q4【观测】 |
| ④ | **`step(ticks)` 确定性快进** | 游戏自己就在 puzzle 校验里同步快进 9000 ticks；逻辑 tick 用固定 deltaSeconds | Q5【观测】 |
| ⑤ | **存档格式全解** | 已产出可用解码器；可离线全量解析存档、可定义"蓝图字符串"格式、有 modExtraData 扩展位 | Q6【观测】 |
| ⑥ | **截图可复用现成代码** | `HUDScreenshotExporter` 存在（canvas.toDataURL），多模态模型的观测可直接用 | bundle.pretty.js:26388【观测】 |
| ⑦ | **桥接拓扑已被安全配置锁定为"外部宿主+WS"** | 无需实验，直接设计 D1=方案B；渲染进程无 CSP，WebSocket 无阻碍 | §1【观测】 |
| ⑧ | **单文件 mod 的分发极简** | 无 mod.json/无依赖；install 脚本就是 copy 一个文件进 mods 目录 | Q1【观测】 |

### 已识别的风险 / 坑（提前说清）

1. **蓝图没有原生字符串格式**（1.5.6）→ D2 的 `paste_blueprint` 要自建格式。代价：需要自己写序列化+版本字段；好处：格式完全可控，且可复用游戏的压缩算法做短串。
2. **蓝图放置有材料成本**（regular 模式）→ AI 建造受 HUB 存量约束，观测里必须暴露 cost 和存量，否则 AI 会持续吃"游戏拒绝"错误。
3. **每次启动清 localStorage** → 任何跨会话状态只能写文件（经 modsettings / savegame / ipcRenderer.fs-job）。
4. **无 sourcemap**，类名保持但局部变量全被 minify → 上游仓库若没有 ee2279d5，阅读成本翻倍（正在核验）。
5. **游戏更新（1.5.6→未来版本）可能改 mods 机制** → `minimumGameVersion` 坚填 + 版本不匹配硬报错；协议层与 mod 层解耦（D1=B）正是为此。
6. **装了 mod 成就禁用**是官方行为，README 明示即可。

---

## 4. 侦察产物清单（已落盘 `recon/`）

| 文件 | 说明 |
|---|---|
| `bundle.pretty.js` | 美化后的游戏代码（44307 行，本报告全部锚点的行号来源） |
| `bundle.js` | 原始 minified bundle（从 asar 提取，游戏目录未动） |
| `index-main.js` / `preload_extracted.js` / `index.html` / `steam.js` | Electron 主进程 / 预载 / 页面 / steam 层 |
| `source_paths.txt` | webpack 保留的 318 条源码路径（上游目录树还原） |
| `decode_full.cjs` | **可工作的存档解码器**（LZString + 字典压缩双层解码） |
| `show_ents.cjs` / `show_save.cjs` | 存档实体/目标统计脚本 |
| `extract.cjs` | bundle 锚点提取小工具 |
| `asar_list.txt` / `app-package.json` | asar 清单 / Electron 依赖清单 |

---

## 5. 等你的选择

菜单上 ①–⑧ 哪条先展开？还是全展开（按阶段 2→7 顺推）？

我的建议顺序（如果全展开）：**①+⑦ 打底（mod 骨架 + WS 桥接）→ ②③④ 做动作/观测/快进 → ⑤ 做蓝图格式 → ⑥⑧ 收尾**。理由：②③④ 都依赖能先跑起一个 mod，而 ① 是零风险路径；⑤ 是唯一需要自己发明格式的部件，放中段给足设计时间。
