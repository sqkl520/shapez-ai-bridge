# 02 — 如何把 AI / 程序接到 shapez 上：现有方案调研

> **调研日期**：2026-10-25
> **调研方式**：本地源码逐行核对（`recon/upstream-full/`，即 shapez.io 1.5.6 = `version` 文件内容）+ GitHub REST/Code Search API（`gh api` / `gh search`）+ WebSearch。
> **说明**：本机 `WebFetch` 对 `github.com` / `arxiv.org` / `wiki.factorio.com` 被安全策略拦截，所有仓库内容均通过 `gh api repos/.../contents/...` 直接取原文；arXiv 摘要通过 `export.arxiv.org/api/query` 取原始 Atom XML。WebSearch 的 shapez 专项查询命中率很低（多次返回空），因此 shapez 生态的结论主要来自 GitHub API，而非搜索引擎。
> **证据分级**：`[有源码可查]` = 我读到了实现代码；`[文档说明]` = 官方 README / 仓库 README / arXiv 摘要原文；`[仅博客/口述]` = 二手转述，未验证。

---

## 1. TL;DR

1. **shapez.io 1.5.6 的 mod 系统比一般想象强得多，但它没有"AI 接口"这层抽象**。它是一个「单文件 JS + 任意方法替换 + 全局 Signal」的系统：能注册建筑/组件/GameSystem/物品/子形状/HUD/键位/主题/GameState，能替换任意类的任意方法，能读写存档里的 `modExtraData`。**没有** mod.json 运行时清单、**没有**沙箱、**没有**网络 API、**没有**输入注入 API——但渲染进程里 `window.shapez` 暴露了全部模块导出（仅 standalone/dev 构建），配合 `camera.downPreHandler` / `keyMapper` 可以做到"模拟点击"。
2. **shapez 1 根本没有 blueprint 字符串格式**。`Blueprint` 类只有 `fromUids / getCost / draw / tryPlace / rotate*`，复制粘贴是纯内存对象（`blueprint_placer.js` 的 `lastBlueprintUsed`）。**`.szbp` 不是任何游戏的原生格式**——我们的 `SZBP1.` 是自建的，这一点必须在文档里说清，别让后来人以为在找轮子；这个轮子不存在。反过来，**shapez 2 有** `SHAPEZ2-1-<base64(gzip(json))>-$` 的蓝图字符串，且有 3 个可查的开源解析器。
3. **shapez 1 的存档格式已经被完整逆向过至少 3 次**（Python / Go / JS 各一份），算法可完全复现：`\x01` + LZString-URI-safe(CRC32hex + JSON(dictionary-compress(data)))，字符表是 **base-146**（不是某些二手文档写的 base110）。存档版本 1010。我们其实不需要这些库（mod 里直接 `JSON.stringify(root)` 更省事），但**离线存档分析 / 造假数据做回归**可以直接抄。
4. **「AI 玩 shapez」这个赛道基本是空的**。GitHub 全站搜 `shapez + bot/AI/agent/llm/mcp` 只捞到一个 Logitech 宏脚本（0 star）。真正有营养的是 shapez 2 生态（MIP 求解器、蓝图解析）和 Factorio 生态（FLE 1206★、draftsman 185★、verifactory 39★、Factompiler 421★）。
5. **最值得抄的三样东西**（详见 §5/§6）：
   - **FLG（Factorio Layout Generator）的「通道几何预留」**：把路由失败前移到放置之前，用"同一侧判定"纯算术决定可行性，而不是铺完再回溯。我们的 P4 是"lane-column + 冲突重试"，正缺这一层。
   - **FLE 的「code-as-action + REPL 命名空间」**：agent 不是一 action 一 RPC，而是写一段程序，观察是这段程序的 stdout。这对 token 和长程任务的优势是数量级的。
   - **verifactory 的「SAT 证明而非逐 tick 模拟」**：把"这条 balancer 是否平衡/是否满吞吐"变成 z3 的命题，1 秒证完 64×64。我们的 V3/V7 是跑 tick，慢且只能抽样。
6. **我们最大的能力缺口不是"放东西"，是"看结果"**：`obs` 只报实体，不报**产出速率 / 机器内部状态 / 缓冲存量 / 线路吞吐 / 解锁状态**。于是"这条线到底跑不跑得动"只能靠 hub `delivered` 的净增量猜——这正是 `research/ai-plan/live/MOD-GAPS.md` 里反复出现的"把没产出的线当成产出"的根因。游戏里 `root.productionAnalytics.history`（produced/stored/delivered 三路时间片）和 `BeltReaderComponent.lastThroughput` **已经存在**，我们一个都没接。

---

## 2. 官方 mod API 能力边界

### 2.1 装载模型（先破除两个常见误解）

| 误解 | 事实 | 证据 |
|---|---|---|
| "shapez 1 用 `mod.json` manifest" | **运行时不用**。1.5.6 的 mod 是**单个 `.js` 文件**，扔进 `%APPDATA%/shapez.io/mods/`；加载器读全文，尾部拼一段自注册代码，然后 `new Function(modCode)()` 执行 | `src/js/mods/modloader.js:198-214`（`modCode += "...window.$shapez_registerMod(Mod, METADATA)"` + `new Function`）；`electron/index.js:352-368`（`readdirSync(modsPath).filter(f => f.endsWith(".js"))`）——`[有源码可查]` |
| "`mod.json` 是 shapez 1 的东西" | `mod.json` 是**构建工具**（`create-shapez.io-mod`）的清单，打包后仍产出一个 `<id>@<version>.js`；另有社区 mod 源的 `mod.json` 只被 gulp 读 | `entibo/shapezio-mods/src/compact/mod.json`（`{"entry":"main.ts","id":"compact",...,"modId":"1935972"}`）+ `create-shapez.io-mod` README「`yarn build` 生成 `<mod_id>@<version>.js`」——`[文档说明]` |
| "浏览器版也能装 mod" | 不能。`initMods()` 在非 standalone / 非 dev 时**直接 return**；`exposeExports()` 对 `G_IS_STEAM_DEMO` 直接 return | `modloader.js:142-152`、`107-113`——`[有源码可查]` |

**METADATA 的字段**（`modloader.js:19-30` 的 typedef，`mod_examples/*.js` 全部实测使用）：
`name / version / author / website / description / id / minimumGameVersion? / settings? / doesNotAffectSavegame?`。
- `minimumGameVersion` 是 semver range，不满足 → `alert` + 跳过该 mod（`modloader.js:222-240`）。
- `settings` 会被持久化到 `modsettings_<id>__<version>.json`，`this.saveSettings()` 写回（`modloader.js:242-265`；`mod_examples/mod_settings.js`）。
- `doesNotAffectSavegame: true` 让该 mod 不出现在存档的 mod 列表里（影响的是"读档时缺 mod 的警告"，不影响加载）。

**两种开发/注入通道**（对我们最有用）：
1. `--load-mod=<绝对路径>` 启动参数：Electron 主进程把外部文件拼进 mod 列表（`electron/index.js:18, 363-368`）。**这是免安装注入的正路**。
2. `config.local.js` 里 `debug.externalModUrl: "http://localhost:3005/combined.js"`：dev 构建下 `fetch` 远程 mod（`modloader.js:166-182`）。**这是热重载的正路**——改文件→刷新即可，不用重装。

### 2.2 能做什么（逐条带证据）

| 能力 | API | 证据 |
|---|---|---|
| **替换任意类的任意方法**（最强的一条） | `modInterface.replaceMethod(cls, name, (old, args) => ...)`；`runBeforeMethod` / `runAfterMethod` / `extendClass` / `extendObject` | `mod_interface.js:450-528`；`mod_examples/class_extensions.js`——`[有源码可查]` |
| 注册新建筑（含变体/旋转变体/图标/精灵/教程图） | `registerNewBuilding` / `addVariantToExistingBuilding` / `setBuildingToolbarIcon` / `registerBuildingSprites` | `mod_interface.js:252-316, 366-379, 569-599, 600+`——`[有源码可查]` |
| 注册新 **Component**（进实体，随存档序列化） | `registerComponent(component)` | `mod_interface.js:208`；`mod_examples/usage_statistics.js`——`[有源码可查]` |
| 注册新 **GameSystem**（每 tick 的 `update()` + 按 chunk 的 `drawChunk()`） | `registerGameSystem({id, systemClass, before, drawHooks})`；`before: "belt"` / `"end"`；`drawHooks: ["staticAfter", ...]` | `mod_interface.js:220-251`；`mod_examples/custom_drawing.js`、`notification_blocks.js`——`[有源码可查]` |
| 注册新物品类型 / 子形状 / 主题 / GameState | `registerItem` / `registerSubShapeType` / `registerGameTheme` / `registerGameState` | `mod_interface.js:171-207, 400-428`；`mod_examples/new_item_type.js`——`[有源码可查]` |
| 往 HUD 塞自定义部件（任意 DOM） | `registerHudElement(id, elementClass)`；`BaseHUDPart` 有 `createElements(parent)` / `update()` / `draw()` | `mod_interface.js:530-535`；`mod_examples/modify_ui.js`——`[有源码可查]` |
| 注册游戏内键位（可带 shift/alt/ctrl 修饰、可返回 `STOP_PROPAGATION` 吞事件） | `registerIngameKeybinding({id, keyCode, modifiers, handler})` | `mod_interface.js:317-355`；`mod_examples/custom_keybinding.js`——`[有源码可查]` |
| 注入 CSS / 替换精灵 / 替换翻译 | `registerCss` / `registerSprite` / `registerAtlas` / `registerTranslations` | `mod_interface.js:70-170, 183-198`——`[有源码可查]` |
| 弹窗（info / warning / option chooser / loading） | `mod.dialogs` → `HUDModalDialogs.showInfo/showWarning/showOptionChooser/...` | `mod_interface.js:356-364`；`mod_examples/modify_ui.js`——`[有源码可查]` |
| **读写存档里的自定义数据** | `signals.gameSerialized.add((root, data) => data.modExtraData[id] = ...)`；`signals.gameDeserialized` | `mod_signals.js:31-32`；`mod_examples/storing_data_in_savegame.js`——`[有源码可查]` |
| **拿全部游戏模块**（可读 `gBuildingVariants`、`logic`、`GameSystem` 基类、`types` 序列化原语等） | `window.shapez` = 全部模块导出的 getter 表 | `modloader.js:107-140`（`require.context("../", true, /\.js$/)`）——`[有源码可查]` |
| 监听游戏事件（**Signal 就是事件总线**） | `Mod` 上有 `this.signals`（= `MOD_SIGNALS`，12 个）；`root.signals`（~26 个） | 见 §2.4——`[有源码可查]` |

### 2.3 不能做什么（以及为什么）

| 限制 | 原因 / 证据 |
|---|---|
| **不能在 modloader 初始化之后再注册 mod** | `$shapez_registerMod` 里 `if (this.initialized) throw`，且注册完立刻 `delete window.$shapez_registerMod`（`modloader.js:184-196, 216`）——`[有源码可查]` |
| **不能在浏览器/网页版跑 mod** | 见 §2.1——`[有源码可查]` |
| **没有沙箱，mod 就是渲染进程里的任意 JS** | 没有 iframe/worker 隔离；`new Function(modCode)` 直接跑；`registerCss` 注入任意样式。官方文档的姿态是"装 mod 就信任它"——`[有源码可查]` |
| **没有 Node / 文件 / 网络 API**（渲染进程 `nodeIntegration:false`） | 这是**我们当初选"外部桥接进程 + WebSocket"的直接原因**（`docs/PROTOCOL.md` §0 D1）。原生 `WebSocket` 可用、页面无 CSP——`[有源码可查]`（沿用我们 P0 的结论） |
| **装 mod 会关掉成就 / 排行榜 / 谜题 DLC** | `electron/index.js:386-387`：`if (mods.length === 0) steam.listen()`——`[有源码可查]` |
| **没有"输入注入"的一等 API**（没有 `simulateClick`） | 但有可用的底层面，见 §2.5——`[有源码可查]` |
| **没有 mod 之间的显式依赖/加载顺序声明** | `modLoadQueue` 按文件读入顺序，只按 `meta.id` 去重（`modloader.js:188-196`）。跨 mod 协作只能靠"谁先 patch 谁"——`[有源码可查]` |
| **没有官方 mod API 文档站** | 仓库里只有 `mod_examples/README.md`（一份很好的示例索引）+ Discord。`THIRDPARTY_URLS.modBrowser = "https://shapez.mod.io/"`（`core/config.js:34`）——**该域名当前不可达**（curl 超时）——`[文档说明]` + `[观测]` |

### 2.4 事件总线：`Signal` 的完整清单（这是最被低估的一块）

`Signal` 是同步的、有 `add/addToTop/dispatch/removeAll`、支持 `STOP_PROPAGATION` 返回值（`core/signal.js`）。

**`MOD_SIGNALS`（全局/生命周期，`mods/mod_signals.js:12-33`）**
```
appBooted                应用启动完
modifyLevelDefinitions   改关卡定义（[]）
modifyUpgrades           改升级表（{}）
hudElementInitialized    每个 HUD 部件初始化后 (part)
hudElementFinalized      每个 HUD 部件销毁前 (part)
hudInitializer           建 HUD 时 (root)  ← registerHudElement 就挂这里
gameInitialized          root 建好 (root)
gameLoadingStageEntered  (inGameState, stageName)
gameStarted              (root)
stateEntered             任意 GameState 进入 (state)  ← 判断 MainMenuState / InGameState
gameSerialized           (root, serializedData)  ← 往存档塞数据
gameDeserialized         (root, serializedData)  ← 从存档取数据
```

**`root.signals`（游戏内，`game/root.js:146-195`）**——与 AI 相关的高价值项：
```
entityAdded / entityChanged / entityDestroyed / entityQueuedForDestroy / entityManuallyPlaced
gameFrameStarted         每帧
shapeDelivered           (ShapeDefinition)  ← hub 收到一个目标形状，最细粒度的"产出"事件
itemProduced             (BaseItem)         ← 任何机器产出一个物品
upgradePurchased         (upgradeId)
storyGoalCompleted       (level, reward)
bulkOperationFinished / immutableOperationFinished   ← 批量操作边界，天然的事务钩子
prePlacementCheck        (entity, offset)   ← 可以否决放置（我们目前没用）
freeEntityAreaBeforeBuild(entity)           ← 放置前腾地方（我们目前没用）
achievementCheck / bulkAchievementCheck
puzzleComplete
```

> **结论**：所谓"没有事件总线"是误判。真正缺的是**把 Signal 桥接成 mod→bridge 的推送**——我们的 mod 只订阅了 `gameStarted` 和 `stateEntered` 两个（`src/mod/shapez-ai-bridge.js:227,233`），bridge 侧只有 3 种事件且全是连接生命周期（`mod_connected / mod_disconnected / rejected`，`src/bridge/bridge.mjs:615,671,706`）。

### 2.5 能不能"模拟点击"？

**没有一等 API，但底层面齐全，可以做到"走 UI 的放置路径"**（这条能力我们完全没用）：

| 面 | 代码 | 能干什么 |
|---|---|---|
| 鼠标位置 | `app.mousePosition = new Vector(x, y)`（`application.js:149,293`） | 让 `buildingPlacerLogic` / `blueprintPlacer` 的 `draw()` 和"跟随鼠标"逻辑认为指针在这 |
| 按下/移动 | `root.camera.downPreHandler.dispatch(pos, enumMouseButton.left/right/middle)`；`root.camera.movePreHandler.dispatch(pos)`（`game/camera.js:87-88, 682, 702`） | **直接触发实际的放置/删除/蓝图粘贴**，走 `HUDBlueprintPlacer.onMouseDown` 等同一条路径（`blueprint_placer.js:110-135`） |
| 抬起 | `camera.upPostHandler.dispatch(pos)`（`camera.js:747`） | 完成一次点击手势 |
| 键位 | `root.keyMapper.getBindingById(id).signal.dispatch()`（`key_action_mapper.js:345, 563`） | 触发任意内置键位：`massSelectCopy`(C) / `pasteLastBlueprint`(V) / `rotateBlueprint` / 切层…… |
| 键位（运行时动态） | `app.inputMgr.forwardToReceiver("keydown", {keyCode, ...})`（`core/input_distributor.js:189-215`） | 走完整的 InputReceiver 栈 |

**为什么值得做**：`Blueprint.tryPlace()` 内部已经包了 `performBulkOperation` + `performImmutableOperation`（`game/blueprint.js:157-182`），**它就是官方那套"带成本、带撤销、带成就统计"的粘贴路径**。我们现在的 `opPasteBlueprint` 是自己重实现了一遍逐格 `tryPlaceBuilding`——正确性靠我们自己的 `performImmutableOperation` 调用保证（`shapez-ai-bridge.js:2145-2160`），而官方路径是免费的对照组，天然适合做**差分测试**（同一蓝图，两条路径，比对最终实体集）。

### 2.6 能力边界小结（一张表）

```
能做                                      不能做
──────────────────────────────────────    ──────────────────────────────────────
✓ 换任何方法 / 加任何类 / 加任何 DOM        ✗ 加"运行时"新 mod（只能启动时）
✓ 每 tick 跑自己的逻辑（GameSystem）        ✗ 在网页版跑
✓ 读写存档自定义字段                        ✗ 拿 Node / fs / net
✓ 监听 12 个 MOD_SIGNAL + 26 个 root.signal        ✗ 官方 mod 门户（mod.io 域名当前不可达）
✓ 拿 window.shapez 全部模块                 ✗ 声明 mod 间依赖
✓ 走 UI 放置路径（downPreHandler 等）        ✗ 输入注入的一等 API（只能自己拼）
✓ 弹窗 / 键位 / CSS / 翻译                  ✗ 沙箱（mod = 任意代码）
```

---

## 3. 存档与 blueprint 格式解析方案

### 3.0 先纠正三个名字

| 名字 | 真相 |
|---|---|
| `savegame.json` | **shapez 2** 的 `.spz2` 存档是 ZIP，里面有 `savegame.json` / `research.json` / `local-player.json` 等可读 JSON + 若干自定义二进制段。**shapez 1 没有这个文件**——`[文档说明]`（Neighbor-Z/shapez2-savegame-tool README 原文） |
| `.szbp` | **两个游戏都没有这个扩展名**。shapez 1 无蓝图字符串；shapez 2 的蓝图字符串是 `SHAPEZ2-1-...-$`（无扩展名，剪贴板文本）。**我们的 `SZBP1.` 是自建格式**（`docs/PROTOCOL.md` §6 已注明"自建——1.5.6 无原生格式【观测】"）——`[有源码可查]` |
| "变长整数 + base64" | 我们的 `SZBP1` 是 **LZString + URI-safe base64 变体**，不是 varint；**存档**里那层"变长整数"是真的（base-146 字典编码），见 §3.2 |

### 3.1 shapez 1 存档：文件与编码

**文件布局**（Windows）：`%APPDATA%\shapez.io\saves\`
```
savegames.bin                索引：{version:1010, savegames:[{internalId,lastUpdate,version,level,name}]}
savegame-<internalId>.bin    单个存档：{version, dump:{...}, stats, lastUpdate, mods}
```
证据：`electron/index.js:26`（`storePath`）、`savegame/savegame_manager.js:23`（`super(app, "savegames.bin")`）、`savegame/savegame.js:40`（`"savegame-" + internalId + ".bin"`）、`savegame.js:58`（`getCurrentVersion() === 1010`）——`[有源码可查]`

**编码管线**（`core/read_write_proxy.js:83-120`）：
```
写：
  json    = JSON.stringify( compressObject(data) )
  crc     = "crc32" + "-"*27 + crc32hex(json + salt)     // 共 40 字符
  payload = LZString.compressToEncodedURIComponent(crc + json)
  file    = "\x01" + payload
读：
  去掉首字节 \x01 → LZString 解压 → 前 40 字符是校验和 → 剩下 JSON.parse → decompressObject
  校验和不匹配 → "bad-content / checksum-mismatch"
```
- `salt = globalConfig.info.file = "Ec'])@^+*9zMevK3uMV4432x9%iK'="`（`core/config.js:138`，`read_write_proxy.js:18` 取的是 `["file","info"]` 即 `info.file`）。
- `compressionPrefix = String.fromCodePoint(1)`，若 localStorage 写不了该前缀则退化成 `" "`（`core/async_compression.js:10-25`）。
- LZString 字母表：`"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$"`（`core/lzstring.js:14`）——**和 npm `lz-string` 的 `compressToEncodedURIComponent` 逐字节一致**（我们已用 `test/lzstring_interop.mjs` 验证互通）。
- 注意 `decompressX64` 会先把空格替换成 `+`（`lzstring.js:94`），所以文本里的 `+` 可能被写成空格。

**`compressObject` 的字典压缩**（`savegame/savegame_compressor.js`）——这是"变长整数"的真实来源：
```
输入 obj（任意 JSON）
输出 {keys: [...], values: [...], data: ...}
  - 每个 key 第一次出现 → 分配序号 i，写成 compressInt(i)
  - 每个 **string 值**第一次出现 → 分配序号 i，写成 compressInt(i)
  - 数字 / 布尔 / null 原样保留
  - 数组逐元素递归；对象逐键递归
compressInt(n): n+1 然后反复 % 146，每次取 charmap 的一位，低位在前（小端）
charmap 长度 = 146（!!）
```
**坑**：至少有 2 份二手实现/文档把它写成 "base110"（`Neighbor-Z/shapez-save-editor-flask` README 原文）。实测 `charmap.length === 146`（我用 node 从 `savegame_compressor.js` 里正则取字符串并计数）。抄这些库时要**重新数一遍**，否则字典序号一错，整个存档解出来是乱的。`[有源码可查]`

`charmap` 的前 5 个字符是 `!#%&'`、后 3 个是 `XYZ`，中间大量 Latin-1 补充字符（`¥¦§¨©ª...`）。这意味着**存档不是 ASCII**，跨语言实现必须按 UTF-8 读文件、按 code point 索引，不能用 byte 索引。

**schema 层**：`savegame/schemas/1000..1010.{js,json}`，用 `ajv` 编译 JSON Schema 校验（`savegame/savegame_interface.js:32-45`）。`1010.json` 本体极其宽松（`{"type":"object","required":[],"additionalProperties":true}`）——真正的结构约束在各 Component 的 `getSchema()` 里（`savegame/serialization.js` 的 `types.*`：`uint / float / ufloat / vector / tileVector / keyValueMap / array / nullable / objData / pair / structured`）。

**实体序列化**（`game/entity.js:78-83` + `components/static_map_entity.js:15-24`）：
```jsonc
{ "uid": 10002,
  "components": {
    "StaticMapEntity": { "origin": [x,y], "rotation": 0|90|180|270,
                         "originalRotation": 0|90|180|270, "code": <int|string> },
    "Belt": {...}, "ItemEjector": {...}, ...
  } }
```
`code` 是**建筑码**，由 `gBuildingVariants` 表（`game/building_codes.js:27-60`）把 `"<buildingId>/<variant>/<rotationVariant>"` 映射到数字。**这张表由 `registerBuildingVariant` 在启动时构建，顺序即码值**——所以码值跨版本不稳定（这正是我们 `gv` 字段 + `2006 blueprint_incompatible` 的依据）。

### 3.2 blueprint：三条互不兼容的路线

#### (A) shapez 1.5.6 原生：**没有字符串格式**
- `game/blueprint.js`（186 行）只有 `constructor(entities)` / `fromUids(root, uids)` / `get layer` / `getCost()` / `draw()` / `tryPlace(root, tile)` / `rotateCw/Ccw/180` / `canAfford(root)`。**没有任何 encode/decode/serialize**。
- 复制粘贴是内存对象：`blueprint_placer.js:33-35`（`currentBlueprint` / `lastBlueprintUsed`），粘贴成本 `findNiceIntegerValue(4 * n^1.1)`（`blueprint.js:70-75`），成本形状 `CbCbCbRb:CwCwCwCw`（`game_mode.js:195-197`）。
- 全仓 `grep -rn "b64\|btoa\|atob\|szbp"` 无蓝图相关命中；`clipboard-copy` 只用在谜题分享 / 形状查看 / 线材 overlay。

**结论**：`[有源码可查]` shapez 1 的蓝图**无法离开进程**。任何"shapez 1 蓝图字符串"都是第三方发明。所以要"跨工具交换蓝图"，只能：
1. 用我们的 `SZBP1`（唯一实现，无生态）；
2. 或者抄 shapez 2 的容器格式（见 C），但 `code` 语义仍然是 1.5.6 私有的。

#### (B) 我们的 `SZBP1`（现状）
```
SZBP1.<LZString-URI-safe( JSON )>
JSON = { v:1|2, gv:"1.5.6", w:[minx,miny],
         e:[code,dx,dy,rot, ...],        // 恒 4 列
         o:[orig, orig, ...] }           // v2 可选，平行数组
```
- 压缩算法与游戏存档**完全相同**（`compressX64` = `compressToEncodedURIComponent`），已双向互通（`test/lzstring_interop.mjs`）。
- `o` 用**平行数组**而不是 stride=5，是为了"旧解码器能原样读、长度不符能显式报错"——`docs/PROTOCOL.md` §6 有完整论证与实测数据（2000 格 3899→4950 字符，+12~27%）。
- 粘贴走 `performBulkOperation` + `performImmutableOperation` + 逐格 `tryPlaceBuilding`，并支持 `dry_run`（`shapez-ai-bridge.js:2111-2240`）。
- 实现：mod 侧 `opExportBlueprint` / `opPasteBlueprint`；tools 侧 `src/shared/blueprint.mjs`（`decodeBlueprint` / `encodeBlueprint` / `summarizeBlueprint` / `blueprintCost`）。

**它缺的东西**（影响"能不能复用别人做的线"）：蓝图里**只有几何 + 建筑码**，没有每实体的**配置**。`Filter` 的过滤项、`ConstantSignal` 的信号值、`ItemProcessor` 的配方、`Display` 的内容、`Wire` 的连接关系全丢。所以导出一条带 filter/常量信号的线，贴回来是"默认配置"——这在 L10+ 复合形状关卡里是致命的。

#### (C) shapez 2 的蓝图字符串（可抄的容器设计）
`SHAPEZ2-1-<base64( gzip( UTF8(JSON) ) )>-$`，JSON 结构：
```ts
{ V: number,                      // savegame version
  BP: { Entries: Array<{ X:number, Y:number,
                         L:0|1|2,          // layer
                         R:0|1|2|3,        // rotation (90° 单位)
                         T:string,         // building type id
                         C:string }> } }   // config（每建筑的附加配置，字符串）
```
证据：`EmeraldBlock/s2bp2s/src/serializer.ts`（`PREFIX="SHAPEZ2"`、`DIVIDER="-"`、`SUFFIX="$"`、`gunzip(Buffer.from(content,"base64"))`）+ `src/blueprint.ts`（上面的 type）——`[有源码可查]`（3★，最后提交 2023-06，已停更但格式读得通）

**对我们的启示**：`C:string` 那一列就是"每实体配置"的位置。`SZBP1` 升 v3 时，最省事的做法是加一个**稀疏的 `c: {idx: configString}` 映射**（而不是每格都带），保持旧解码器可读。

#### (D) Factorio 的蓝图字符串（生态最成熟，算法最标准）
```
"0" + base64( zlib_deflate_level9( UTF8(JSON) ) )     // 1.x
"1" + ...                                             // 2.0
```
- 版本字节在 **base64 内部**（压缩流之前），不是 base64 字符。
- 标准 base64 字母表（`A-Za-z0-9+/`，带 `=` 填充），**不是** URL-safe。
- zlib 是**带 2 字节头和 Adler-32 的 zlib**，不是 raw deflate。
证据：`demipixel/factorio-blueprint/src/util.ts`（`zlib.inflateSync(Buffer.from(str.slice(1),'base64'))` / `'0'+zlib.deflateSync(...).toString('base64')`）——`[有源码可查]`；编码细节另见 `[文档说明]`（Factorio wiki "Blueprint string format"，WebSearch 摘要）。

> 顺带：Factorio 的 `zlib+base64` 比我们的 LZString 通用得多（任何语言一行就能解），但体积更大。如果将来要做"给非 JS 工具消费的蓝图"，建议**双格式**：`SZBP1.`（内部，紧凑）+ `SZBJ.`（`base64(zlib(json))`，跨语言）。

### 3.3 第三方解析库清单（能不能直接用）

| 库 | 覆盖 | 语言 | 结论 |
|---|---|---|---|
| `Neighbor-Z/shapez-save-editor-flask`（0★，2026-03） | shapez **1** 存档 encode/decode（LZString + 字典 + CRC32/SHA1） | Python | **能抄**，`shapez_parser.py` 是完整移植。**但 README 写 "Base110" 是错的（实为 146）**，代码里用的是 `len(CHARMAP)` 所以实现是对的——`[有源码可查]` |
| `mrmelon54/go-shapezio-compression`（0★，2021-10） | shapez 1 存档 | Go | **能抄**，常量表齐全（含 `_crcPrefix` / `_charmap` / `_keyStrUriSafe`）——`[有源码可查]` |
| `LilyRose2798/shapez.io-save-editor`（7★，2024-05） | shapez 1 存档 + GUI | JS/Electron | 直接把游戏那套代码抄了过去，`common.js` 里有完整 `compressInt` / `compressObject`——`[有源码可查]` |
| `EmeraldBlock/s2bp2s`（3★，2023-06） | shapez **2** 蓝图字符串 → PNG | TypeScript | **能抄容器格式**，`src/serializer.ts` 约 50 行，`deserialize()` 一眼看完——`[有源码可查]` |
| `Loupau38/shapez2-python`（5★，2026-08） | shapez 2 形状代数库（PyPI `shapez2`） | Python | 形状运算可参考（`Vystel/shapez2-solver` 的运算逻辑就是从它移植的）——`[文档说明]` |
| `DontMash/shapez-vortex`（20★，2026-10 活跃） | shapez 2 蓝图查看/分享平台 | Svelte | 前端蓝图渲染可参考——`[文档说明]` |
| **shapez 1 蓝图字符串库** | — | — | **不存在**。GitHub code search `"SZBP1"` 0 命中；`shapez + blueprint + LZString` 仅 2 条无关命中——`[观测]` |

**结论**：存档解析有现成轮子（3 份，可抄可对拍）；**蓝图字符串没有轮子，因为原生就不存在**。我们的 `SZBP1` 在这个生态里是孤本，这既是风险（无外部校验）也是机会（可以定义事实标准）。

---

## 4. 现有项目清单

> star 数与 `pushed_at` 均为 **2026-10-25 通过 `gh api repos/<owner>/<repo>` 实取**，非记忆值。
> "活跃度"判据：`pushed_at` 在 6 个月内 = 活跃；1 年内 = 低频；更早 = 停更。

### 4.1 shapez 1（我们这一代）

| 名称 | 用途 | 语言 | ★ | 最后 push | 活跃 | 我们能不能用 |
|---|---|---|---|---|---|---|
| `tobspr-games/shapez.io` | 官方源码（GPL-3.0） | JS | 6999 | 2026-09-07 | 低频（已转 CE/2 代） | **是**，就是我们的 `recon/upstream-full` |
| `tobspr-games/shapez-community-edition` | 社区续作，TS 化 + 新 modloader（`mod.json` + `.asar`） | JS/TS | 206 | 2026-10-16 | 活跃 | **参考**：它的 `mod_metadata.ts`（zod schema）是"如果 1.5.6 有 mod.json 会长什么样"的答案；`electron/src/mods/{loader,locator,metadata}.ts` 是完整实现 |
| `tobspr-games/shapez.io-viewer` | 任意形状 → 预览图 | JS | 24 | 2023-03 | 停更 | 形状渲染可抄（我们目前不做形状可视化） |
| `entibo/shapezio-mods` | mod 集合（含 Compact Machines）+ 构建脚手架 | TS | 6 | 2026-10-01 | 低频 | `src/compact/mod.json` 是**构建期**清单范例 |
| `DJ1TJOO/create-shapez.io-mod` | mod 脚手架 CLI（`npx create-shapezio-mod`） | JS | 6 | 2023-04 | 停更 | 若要做多文件 mod + 资源打包，可抄 webpack 配置 |
| `LilyRose2798/shapez.io-save-editor` | 存档编辑器 | JS | 7 | 2024-05 | 停更 | 存档编解码可抄 |
| `Neighbor-Z/shapez-save-editor-flask` | 存档编解码（Python 移植） | Python | 0 | 2026-03 | 低频 | **直接抄**（注意 base146 笔误） |
| `mrmelon54/go-shapezio-compression` | 存档编解码（Go） | Go | 0 | 2021-10 | 停更 | 可抄常量表 |
| `Sense101/shapez-industries` | 大型内容 mod（新建筑/新形状） | JS | 11 | 2022-06 | 停更 | 学"怎么加一整套建筑" |
| `Bagel03/Shapez.io-Multiplayer` | 多人 mod | JS | 7 | 2021-02 | 停更 | 学"怎么在 mod 里做网络同步"（虽然它用的是另一套） |
| **`shapez` + bot/AI/agent/llm/mcp** | — | — | **0 命中** | — | — | **这个赛道是空的**（唯一的 `onkncn/shapez_bot` 是 Logitech 宏脚本，0★） |

### 4.2 shapez 2（下一代，但算法可迁移）

| 名称 | 用途 | 语言 | ★ | 最后 push | 活跃 | 能不能用 |
|---|---|---|---|---|---|---|
| `jiahao-0204/Shapez2-MIP-Miner` | **矿区布局 ILP/CP-SAT 最优解**（OR-Tools CP-SAT；在线版 shapez2-tools.com） | Python | 26 | 2026-08-14 | 活跃 | **强参考**：把"选哪些矿 + 矿机/延长器/带子/电梯怎么摆"写成 CP-SAT，最大化采矿数。我们的 miner 选点是启发式，可换这个 |
| `jiahao-0204/Shapez2-MIP-Router` | **布线 MILP**（Gurobi），给定板 + 连接需求求最优路径 | Python | 14 | 2026-08-11 | 活跃 | **强参考**：这是"布线当 ILP"最干净的样例。注意它自己承认开源求解器（PULP/CBC）慢到不可用 |
| `Vystel/shapez2-solver` | 形状合成最优步骤搜索（Web） | JS | 13 | 2026-07-31 | 活跃 | 形状代数 + 搜索，和我们 `proto/solver.mjs` 同类；可对拍 |
| `TomasSirgedas/Shapez-solver` | 形状合成求解器（C++ 核心 + JS 前端，2019 竞赛） | C++/JS | 6 | 2022-03 | 停更 | 老但快；算法是 BFS/DP over 形状状态 |
| `DontMash/shapez-vortex` | 蓝图查看/分享平台 | Svelte | 20 | 2026-10-25 | 活跃 | 蓝图可视化 / 社区格式参考 |
| `EmeraldBlock/s2bp2s` | 蓝图字符串 → PNG | TS | 3 | 2023-06 | 停更 | **格式定义可抄**（见 §3.2 C） |
| `Neighbor-Z/shapez2-savegame-tool` | `.spz2` 存档查看/迁移 | Python/Flask | 2 | 2026-04 | 低频 | 学"ZIP + JSON + 二进制段"的混合存档 |
| `Loupau38/shapez2-python` | 形状代数库（PyPI） | Python | 5 | 2026-08-19 | 活跃 | 形状运算参考 |
| `tobspr-games/shapez2-shifter` | **官方** shapez 2 mod API（C#，MonoMod detour） | C# | 14 | 2026-08-13 | 活跃 | 架构参考：三层（Sharp Detours / Hijack / Flow）+ Kit，比 shapez 1 的"裸 patch"工程化得多 |

### 4.3 Factorio（自动化游戏 AI 的主战场）

| 名称 | 用途 | 语言 | ★ | 最后 push | 活跃 | 能不能用 |
|---|---|---|---|---|---|---|
| `JackHopkins/factorio-learning-environment` (FLE) | **LLM agent 评测环境**：Docker 起 Factorio 集群 + RCON + Lua 工具层 + Python REPL 命名空间 + MCP server + 排行榜 | Python/Lua | **1206** | 2026-09-18 | 活跃 | **最值得读的一个**。见 §5.2 |
| `redruin1/factorio-draftsman` | 蓝图程序化构造库（185★，PyPI，文档齐全） | Python | 185 | 2026-10-04 | 活跃 | **"用代码生成蓝图"的黄金标准**：`Blueprint()` + `entities.append(...)` + `version` 管理 + 校验/警告 |
| `Snagnar/Factompiler` | 类 C 语言 → 电路网络蓝图（编译器） | Python | 421 | 2026-05-18 | 活跃 | 学"DSL → 蓝图"的编译管线；我们是"goal → 蓝图"，结构同构 |
| `alegnani/verifactory` | **用 z3/SAT 证明蓝图性质**（balancer 平衡、满吞吐） | Rust | 39 | 2026-10-15 | 活跃 | **强参考**：把"验证"从"跑 tick"换成"解命题"。见 §6.4 |
| `gusxo999/FLG` | **Factorio 布局自动生成器**（recipe → 机器/机械臂/带子自动摆） | TypeScript | 1 | 2026-10-08 | 活跃 | **强参考**：`src/autoLayout/{tree,module,link,channel,perimeter}` 的分解方式，尤其 `channel/`（通道几何预留）。见 §6.5 |
| `piebro/factorio-blueprint-visualizer` | 蓝图 → 艺术化 PNG | JS/Python | 587 | 2025-01 | 低频 | 可视化 |
| `teoxoy/factorio-blueprint-editor` | 蓝图编辑器（已停维护） | TS | 428 | 2026-08-16 | 低频 | UI/交互参考 |
| `demipixel/factorio-blueprint` | 蓝图字符串 ↔ JSON（JS） | TS | 112 | 2026-10-10 | 活跃 | **格式实现最干净**（`src/util.ts` 30 行） |
| `tzwaan/factorio_balancers` | balancer 测试框架（PyPI，HTML 报告） | Python | 44 | 2024-07 | 停更 | **测试方法学可抄**：`-s` / `-es` 扫所有进出口组合做吞吐测试 |
| `Buildasaurus/Factorio-Blueprint-Generator` | 需求 → 布局 → 蓝图（Python，可接 solver） | Python | 15 | 2025-01 | 低频 | 架构同我们：solver 出配方/数量，generator 出布局 |
| `CuteZerg/FactorioLLM` | 微调 LLM 写 draftsman 脚本 → 蓝图（Docker 沙箱自愈循环） | Python | 0 | 2026-10-25 | 活跃 | **架构强参考**：LLM 只写**代码**不写坐标；编译失败把错误回灌重试 |
| `lvshrd/factorio-agent` | AI agent 分析状态 + 执行操作 | Python | 17 | 2025-09 | 低频 | 通用参考 |
| `AI-Ascension/jev-factorio-agent` | "LLM 只做选择，确定性代码做执行" | Python | 4 | 2026-10-25 | 活跃 | **架构强参考**：把"决策"和"执行"彻底分离，见 §5.3 |

### 4.4 与 shapez 无关但架构直接可抄

| 名称 | 用途 | 语言 | ★ | 最后 push | 活跃 | 能不能用 |
|---|---|---|---|---|---|---|
| `MineDojo/Voyager` | LLM 自主玩 Minecraft：自动课程 + 技能库 + 迭代提示 + 自我验证 | Python/JS | **7288** | 2024-04 | 停更（但代码完整） | **最值得读的 agent 架构**。`voyager/agents/{curriculum,skill,critic,action}.py` 各 200 行 |
| `joonspk-research/generative_agents` | 25 个 agent 的 Smallville：memory stream + retrieval(recency/importance/relevance) + reflection + planning | Python | **22291** | 2026-10-25 | 活跃 | 记忆架构；对"长程工厂规划"直接可用 |
| `git-disl/awesome-LLM-game-agent-papers` | ACM CSUR 综述 + 每周更新的论文索引（按 genre/mechanism 分类） | — | 973 | 2026-06-07 | 活跃 | 查文献的第一站 |
| `davidhershey/ClaudePlaysPokemonStarter` | 最小可跑的"Claude 玩 Pokemon"（截图 + 内存读 + 函数调用） | Python | 205 | 2025-04 | 低频 | **最小闭环模板**，200 行就能读懂 |
| `imjeasung/Factory-Layout-Optimizer` | 遗传算法做厂区布局（16 设备线性流程） | Python | 11 | 2025-06 | 停更 | 只适合"连续坐标"厂区，不适合网格；参考 fitness 设计 |
| `SonicDMG/mcp-game-server` | MCP 游戏服务器样板（SSE + 工具 schema） | TS | 6 | 2025-10 | 低频 | MCP 传输层样板 |

### 4.5 明确"找不到"的

- **shapez 1 的 AI/bot/求解器**：GitHub 全站无（除宏脚本）。`[观测]`
- **shapez 1 的蓝图字符串生态**：无。`[观测]`
- **shapez 1 的 headless / 模拟器**：无。`[观测]`
- **Satisfactory / DSP 的空间布局自动生成器**：WebSearch 结论是"只有产量计算器（FactorioLab / satisfactorytools / dyson-calculator），没有活跃的开源空间布局优化器"。`[文档说明]`（搜索摘要，未逐个验证仓库）
- **社区 mod 门户**：`shapez.mod.io` 域名不可达（curl 超时）。`[观测]`
- **shapez 1 官方 mod API 文档站**：不存在；只有 `mod_examples/README.md` + Discord。`[观测]`

---

## 5. LLM-agent 玩游戏的架构模式

### 5.1 三种主流形态（先分类，再选）

```
┌─ 形态 A：像素级（computer use / VLM）─────────────────────────────┐
│  观察 = 截图；动作 = 鼠标/键盘坐标                                     │
│  优点：零侵入，任何游戏都能玩                                          │
│  缺点：token 极贵（一张图 ~1-2k tokens）、精度差（点不准格子）、        │
│        无法读内部状态（"这条带子堵了"看不出来）                          │
│  代表：Claude Plays Pokemon（205★）、各类 computer-use benchmark      │
└──────────────────────────────────────────────────────────────┘
┌─ 形态 B：结构化 API（tool call / RPC）────────────────────────────┐
│  观察 = JSON；动作 = 语义化 op（place/delete/step）                    │
│  优点：精确、便宜、可验证；能读内部状态                                 │
│  缺点：每个游戏要写适配层；动作空间由人设计（agent 不能"发明"操作）        │
│  代表：FLE（1206★）、我们的 bridge、MCP game server                   │
└──────────────────────────────────────────────────────────────┘
┌─ 形态 C：代码即动作（code-as-action / REPL）─────────────────────┐
│  观察 = 上一段程序的 stdout；动作 = 写一段程序                          │
│  优点：一次调用做 N 件事（循环/函数/条件），token 效率最高；             │
│        可复用（技能库就是一串函数）；错误可回灌自愈                      │
│  缺点：需要沙箱；程序错了可能一次毁掉大片工厂（我们踩过：误删 42 实体）    │
│  代表：Voyager（7288★）、FLE 的 Python REPL、FactorioLLM              │
└──────────────────────────────────────────────────────────────┘
```

**我们的位置**：形态 B（JSON-RPC + MCP tool）。**该往 C 走**——理由见 §7「需要一周」第 2 条。

### 5.2 FLE 的完整架构（最接近我们的场景，建议逐文件读）

```
┌──────────────────────────── Docker ────────────────────────────┐
│  Factorio (headless server)                                     │
│   └─ mod: fle/env/mods/*.lua                                    │
│        initialise.lua / serialize.lua / connection_points.lua   │
│        tools/agent/<name>/{client.py, server.lua, agent.md}     │
│              ↑ 每个工具 = 一段 Lua（游戏内执行）+ 一段 Python（客户端）│
└──────────────────────────┬─────────────────────────────────────┘
                           │ RCON（TCP）
┌──────────────────────────┴─────────────────────────────────────┐
│  Python 进程                                                     │
│   LuaScriptManager  ── 把 Lua 工具注入游戏、校验 checksum          │
│   FactorioNamespace ── 暴露 Python 函数：place_entity /           │
│                        connect_entities / get_entities / ...      │
│                        ★ 这就是 agent 的"动作空间"，是可组合的函数   │
│   gym_env            ── Observation / Action / Reward 包装         │
│   agents/gym_agent   ── 提示词：PLANNING 段（自然语言）→            │
│                        POLICY 段（Python 代码块）                   │
│   protocols/_mcp     ── MCP server（stdio / SSE）                 │
│   server.py          ── `fle cluster start` / `fle eval`          │
└─────────────────────────────────────────────────────────────────┘
```

关键设计（`[有源码可查]`，`fle/env/tools/agent/` 与 `fle/env/gym_env/`）：

1. **工具通常是 Lua + Python 双端**（`agent/get_entities/` 里就有 `client.py` / `server.lua` / `agent.md` 三件）。Lua 端在游戏里跑（能拿到 `game.*` 全部状态），Python 端负责类型/默认值/错误信息清洗（`Tool.get_error_message` 会把 `[string "..."]:148:` 前缀剥掉再回给 LLM）。
2. **观察是"格式化文本"，不是原始 JSON**。`BasicObservationFormatter` 输出 5 个固定小节：`Inventory`（按数量降序）/ `Entities`（按类型分组计数）/ `Production Flows`（**输入输出每秒速率**）/ `Task Status`（✅/❌ 逐条判据）/ `Available Functions`（签名 + docstring）。
   → **这一点我们完全没做**：我们给 agent 的是原始 `entities: [{uid,type,x,y,r,...}]`，2000 条就是几万 token，而且没有"速率"。
3. **动作是 Python 程序**，提示词明确要求「MAXIMUM 50 lines of code」「每段一个明确目的」「不要破坏已有的自动化结构」。
4. **错误回灌**：程序抛异常 → 异常文本进下一轮提示 → agent 自己修。
5. **任务系统自带判据**（`Task Status` 的 ✅/❌），等价于"自我验证"。

论文结论（`arXiv:2503.09617` 摘要原文）：*"models still lack strong spatial reasoning... LLMs exhibit promising short-horizon skills, yet are unable to operate effectively in constrained environments, reflecting limitations in error analysis."*
→ **对我们的直接意义**：LLM 短程能干（放矿机、拉一条带），**长程+受限空间不行**。所以"布局"必须交给确定性编译器（我们的 P3/P4、FLG、MIP），LLM 只负责"要什么"（goal）和"哪里不对"（诊断）。这正好是我们现在的架构，**但我们的诊断信息太弱**（见 §7）。

### 5.3 Voyager 的三件套（可直接搬到 shapez）

```
        ┌──────────────── 自动课程 (Curriculum) ────────────────┐
        │  输入：当前状态 + 已完成/失败任务 + 技能摘要             │
        │  输出：下一个"略难一点"的任务（novelty-seeking）         │
        └───────────────────────┬──────────────────────────────┘
                                │ task
        ┌───────────────────────▼──────────────────────────────┐
        │  技能检索 (SkillManager)                              │
        │  skills.json: {name: {code, description}}             │
        │  Chroma 向量库：description 的 embedding               │
        │  top-k=5 相似技能 → 拼进 prompt                        │
        └───────────────────────┬──────────────────────────────┘
                                │ prompt(任务 + 5 个相关技能代码)
        ┌───────────────────────▼──────────────────────────────┐
        │  代码生成 → 执行 → 反馈                                │
        │   环境反馈（中间观察）/ 执行错误 / 自我验证（critic）    │
        │   最多 ~4 轮迭代，每轮把错误拼回 prompt                 │
        └───────────────────────┬──────────────────────────────┘
                                │ 通过验证
        ┌───────────────────────▼──────────────────────────────┐
        │  写入技能库（code + description + embedding）           │
        │  → 下次可被检索/组合 → 回到课程                        │
        └──────────────────────────────────────────────────────┘
```

文件对应（`[有源码可查]`）：`voyager/agents/curriculum.py`（`completed_tasks` / `failed_tasks` / `qa_cache` 三份 JSON，支持 resume）、`skill.py`（`Chroma(collection_name="skill_vectordb")` + `retrieval_top_k=5` + `programs` property 把技能代码拼成 prompt）、`critic.py`（输入 `events[-1]` 必须是 `observe`，读 biome/time/voxels/health/hunger/inventory，输出"是否完成"）、`action.py`（`chest_memory.json` 记住箱子位置——**这就是"外部记忆"的最小形态**）。

**搬到 shapez 的映射**：
| Voyager | shapez 对应 |
|---|---|
| skill = JS 函数操作 Mineflayer | skill = `.mjs` 函数调用我们的 RPC（`buildMinerLine(goal)`、`upgradeBeltTo(3)`、`fixBlockedBelt(region)`） |
| curriculum "获得 X 个物品" | "把 level 推到 N"、"这条线吞吐到 X/s"、"把这条线改成 4 并 1" |
| critic 看 health/hunger | critic 看 `throughput`/`blocked_cells`/`delivered_delta`（**我们现在没有前两个**） |
| 技能库向量检索 | 同一套，description 用中文/英文都行 |

### 5.4 "LLM 只选择，代码负责执行"（jev / Factompiler / FactorioLLM 的共同点）

三个独立项目收敛到同一结论：
- `AI-Ascension/jev-factorio-agent`：「Jev chooses goals and actions as typed questions **while deterministic code owns game rules and actuation**」。
- `CuteZerg/FactorioLLM`：「LLMs lack spatial reasoning. Asking an LLM to output a raw JSON blueprint with exact x/y coordinates ... results in broken layouts.」→ 让 LLM 写**脚本**，脚本用 `for` 循环处理间距/对齐/比例。
- `Snagnar/Factompiler`：人写 DSL，编译器生成优化后的电路。

**模式名**：`LLM = 编译器前端 / 规划器`，`确定性代码 = 后端 / 求解器`。这与我们 `docs/PROTOCOL.md` 的分层（LLM → plan → P1..P8 compiler → blueprint）完全一致，**说明架构方向是对的，差距在"后端反馈的丰富度"**。

### 5.5 记忆：文件系统 > 上下文（一个有数据支撑的教训）

Claude Plays Pokemon 的公开复盘（`[仅博客/口述]`，中文二手转述 Anthropic 的 memory 实践）：给模型一个"读写文件夹"的工具后，早期 Sonnet 3.5 **把 memory 当游戏日志写**——记 NPC 说了什么，但不记"下次该干什么"；**14000 步写了 31 个记忆文件，还卡在第二个城镇**。

对我们的意义：如果要做"跨 session 的工厂规划记忆"，**不要**让它自由写日记；应该给**结构化槽位**（当前目标 / 已完成产线清单 / 已知坑 / 待验证假设），并强制"每条记忆必须能回答'下一步做什么'"。我们的 `research/ai-plan/*/NOTES.md` 事实上就是这个东西的人工版——可以把它变成 agent 的结构化记忆 schema。

---

## 6. 工厂布局求解的算法综述

### 6.1 问题分解（把"工厂布局"拆成 4 个可独立求解的子问题）

```
        goal (要产出的形状/速率)
              │
              ▼
  ① 配方选择 / 产线展开      ← 图搜索 / DP / ILP（选择用哪条配方路径）
              │  DAG: 机器节点 + 边(物料流, 速率)
              ▼
  ② 装箱 (packing)           ← 2D 带约束装箱：机器矩形 → 网格，最小化面积
              │  每个机器有 bbox、输入/输出槽位(方向+偏移)
              ▼
  ③ 布线 (routing)           ← 多商品流 / Steiner 树：把边变成带子格序列
              │  约束：不重叠、拐弯规则、隧道、带宽(每格 1 物品)
              ▼
  ④ 验证 (verification)      ← 模拟 tick / 符号证明（流量守恒、固定点）
```

我们现在的实现映射：① `proto/solver.mjs`（BFS over 形状状态）；② `place.mjs`（模板 + row/col gap，**不是通用装箱**）；③ `route.mjs`（lane-column + 冲突重试 + A*）；④ `validate.mjs`（V1..V10，部分靠 `belt-sim.mjs` 跑 tick）。

### 6.2 装箱（子问题 ②）

| 方法 | 适用 | 复杂度/质量 | 备注 |
|---|---|---|---|
| Bottom-Left / Skyline / Guillotine | 矩形、可旋转、允许空隙 | 快，O(n log n)，质量一般 | 工业界排样主力；**我们的 row/col 布局本质是 Guillotine 的特例** |
| No-Fit-Polygon (NFP) | 任意多边形 | 中，几何计算重 | 对"非矩形机器"才值得 |
| CP-SAT（OR-Tools）| 带复杂侧约束（槽位对齐、邻接要求） | 慢但**可证最优/不可行** | `Shapez2-MIP-Miner` 用的就是这条（Gurobi/CP-SAT）。**它的杀手锏是"不可行时告诉你为什么"** |
| MILP | 同上，线性目标 | 同上 | `Shapez2-MIP-Router` |
| 遗传算法 / 模拟退火 | 连续坐标厂区（非网格） | 快，无最优保证 | `imjeasung/Factory-Layout-Optimizer`（学术厂区布局），**不适合网格游戏** |

**关键洞察**：游戏里的装箱不是"最小化面积"，而是**"满足槽位对齐"**——机器 A 的输出槽必须在某一行，机器 B 的输入槽必须在同一行（否则要多拐弯）。所以正确的做法是**按"行/通道"来装箱**（row-based packing），这正是 FLG 的 `tree/` + `module/` 做的事，也是我们 `place.mjs` 的 `ROW_H / COL_GAP` 在做的事——**方向对，但我们的 gap 是常数，没有按"这个通道要过几条带"来算**。

### 6.3 布线（子问题 ③）——最难的一块

**理论结果**（`[文档说明]`，WebSearch 汇总，逐条注明来源可靠性）：

| 问题 | 结论 | 对我们的用法 |
|---|---|---|
| **Rectilinear Steiner Minimum Tree (RSMT)** | **NP-hard**；最优解必在 **Hanan 网格**（过所有端点的水平/垂直线构成的网格）上 → 连续问题降为有限图上的 Steiner 树 | 我们的通道布线就是小规模 RSMT。端子数 < 10 时可以直接枚举 Hanan 网格上的 Steiner 点 |
| RSMT 近似 | MST 是 **3/2** 近似（Hwang 的 Steiner ratio ≤ 3/2）；Zelikovsky **11/8 = 1.375**，近线性时间可达 `11/8+ε` | 如果只要"不太差"，先连 MST 再局部加 Steiner 点 |
| **Minimum Manhattan Network** | **强 NP-complete**（3-SAT 归约）；最好已知 2-近似，O(n log n) | 多终端共享走线时才会遇到；我们目前是两两独立布线，绕开了 |
| **Channel routing**（VLSI，把线段分配到 track） | knock-knee 模式下：全二端网 `d_max` 条 track 够；含三端网 `⌈3d_max/2⌉`；**`2d_max−1` 条恒够**，线性时间可算 | **直接对应我们的"通道要留几列"问题**：`d_max` = 该通道内水平跨度的最大重叠数。我们现在用固定 `COL_GAP`，应该改成算 `d_max` |
| 障碍下的布线 | 网格 A* / Dijkstra 是标准解；多商品流要 ILP | 我们 `route.mjs` 的 A* 就是这条 |

**工程方案对比**：

| 方案 | 代表 | 优点 | 缺点 |
|---|---|---|---|
| **A* / Dijkstra（逐条）** | 我们、多数游戏 bot | 简单、快、可增量 | **顺序敏感**：先铺的抢位，后面的绕远或失败；要重试/回溯 |
| **预留式通道（reservation）** | **FLG**、VLSI channel routing | **失败前移**：先算几何可行性再铺，铺的时候不会失败 | 需要"通道"这个显式概念；不适合自由形态布局 |
| **多商品流 ILP** | `Shapez2-MIP-Router`（Gurobi） | 全局最优；能证不可行 | 慢（它自己说开源求解器不可用）；需要商业 solver |
| **协商拥塞（negotiated congestion）** | FPGA 布线（PathFinder） | 允许暂时重叠，迭代加价直到无冲突；质量接近 ILP，速度快得多 | 实现复杂；不保证收敛 |
| **SAT/CP 编码** | `Patterson et al. 2023`（Factorio 蓝图 CP 模型） | 声明式；能加任意约束（吞吐、面积） | 规模上不去；论文自己也只做到"feasibility" |

> `Patterson, Espasa, Chang, Hoffmann, "Towards Automatic Design of Factorio Blueprints", arXiv:2310.01505 (2023-10-02)`。
> 摘要原文（我通过 `export.arxiv.org/api/query` 取的 Atom XML）：*"The design of an optimal blueprint is a hard combinatorial problem, **interleaving elements of many well-studied problems such as bin-packing, routing or network design**. This work presents a new challenging problem and explores the feasibility of a constraint model to optimise Factorio blueprints, balancing correctness, optimality, and performance."*
> → **这是唯一一篇把"工厂蓝图"当成 CP 问题正式建模的论文**，且它明确说这是"bin-packing + routing + network design 的交织"。**这正是我们问题的学术定义**，值得作为我们文档的引用锚点。

### 6.4 验证（子问题 ④）——最被低估的一块

| 方法 | 代表 | 代价 | 能证什么 |
|---|---|---|---|
| 逐 tick 模拟 | 我们 `belt-sim.mjs`、`tzwaan/factorio_balancers` | 慢（要跑到稳态）；只覆盖跑过的输入组合 | 特定输入下的行为 |
| **SAT / SMT 证明** | **`alegnani/verifactory`（z3）** | 快（64×64 balancer < 1 秒） | **对所有输入**成立的命题（平衡性、满吞吐、universal） |
| 流量守恒 / 固定点分析 | 我们 V3（`computeBelt` 不动点）、V7（min 速率 × 行数） | 极快 | 结构性性质；不覆盖时序 |

**verifactory 的做法**（`[有源码可查]`，README 明确写）：
```
蓝图 → 每个实体转成一个或多个图节点（中间表示）→ 图化简 → 边的吞吐取最小化
     → 用 SAT solver（z3）把图转成逻辑公式与约束 → 证明/证伪性质
```
它支持的 4 个性质：belt balancing / equal input drain / throughput unlimited / universal balancer。**它的关键论点**：「does not need to try all the combinations of inputs and simulate the actual blueprint, relying instead on the resolution of logical formulas」——这就是"验证 ≠ 模拟"。

**对我们的直接用法**：V7（throughput）现在是"min(节点速率) × 行数 vs 需求"的粗算。如果把它写成"每条边流量 ≤ 容量 ∧ 每个节点流入 = 流出 ∧ 需求被满足"的线性约束组，就能**证明**"这条线在任何输入组合下都不堵"，而不是"跑 5000 tick 看起来没堵"。用 z3 或直接用 CP-SAT 都行（我们已经有 node 侧，可以调 Python 子进程，和 `spawnSync(solver.mjs)` 同构）。

### 6.5 FLG 的"通道几何预留"——我认为最值得抄的单点

FLG（`gusxo999/FLG`，1★，但代码与文档质量远超 star 数）的目录结构就是它的架构：

```
src/autoLayout/
├── tree/        配方树展开 → 机器数量、模块划分
├── module/      每个模块内部：机器装箱、端口(port)位置
├── link/        模块之间的"链接"：谁连谁、几条流、什么物料
├── channel/     ★ 通道：模块之间的走线走廊
│   ├── ledger/      账本：算这个通道要几条 track、谁占哪条
│   ├── shape/       把"第 k 条 track"变成绝对坐标
│   └── policy/      决策：从哪个边出去（N/S）
└── perimeter/   外圈：把料送进/送出整个布局
```

它的核心设计（`docs/auto-layout/channel/channel-geometry-reservation.md`，`[有源码可查]`）：

> **现状问题**：通道只预留"宽度"（几条带），不预留"几何"（谁占哪一格）。于是先铺的路径抢了后铺的位置，被挤出去的箱子**物理上被困在布局中间**，怎么搜都搜不出来。
>
> **解法**：把预留从"宽度"升级为"几何"。核心工具是**同一侧判定（sameSideOfCut）**：一条反出路径在通道上画一条**切割线**；一条进料路径只有当它的两个端点位于切割线**同一侧**时才可能走地面，否则地面路径**几何上不存在**——而这个判定**在铺一格带子之前、纯数字比较就能做完**。

**为什么这对我们是降维打击**：
- 我们现在的 `route.mjs` 是"先按 lane 分列 → 铺 → 撞了就 A* 绕 → 绕不过就加宽 rowGap/colGap 重试（`ROUTE_RETRY_MAX`）"。**失败发生在铺完之后**，只能整体重试。
- FLG 的思路是：**在放置阶段就把"这条流能不能到达"算成布尔判定**，不可行就调整模块位置/通道顺序，**永远不进入"铺了再拆"的状态**。
- 这直接对应我们 `MOD-GAPS.md` 里最痛的问题（paste 静默覆盖、拐角翻向、误删）——因为那些都是"铺完才发现不对"的后果。**预留式布线把这类错误从"运行时事故"变成"编译期不可行"**。

**可抄的具体形式**（不需要抄它 8000 行 TS，只抄判定）：
```
给定：模块 A 的出口在 (ax, ay) 朝东；模块 B 的入口在 (bx, by) 朝西；
      通道是 x ∈ [x0, x1] 的竖条，里面已有 k 条"切割线"（来自反出路径）
判定：A 能否到 B 走地面？
  若 ay 与 by 之间存在任一已占用的切割线 → 不可行（需要隧道/换层/改布局）
  否则 → 可行，且可直接算出需要几条水平 track（= 该区间内已有水平段的最大重叠数 d_max）
```

---

## 7. 我们缺的能力清单

> 判据：只列**有明确用途**的。每条写"为什么重要"。分档按"改动面"而不是"重要性"。
> 现状基线：`src/mod/shapez-ai-bridge.js`（2240 行）+ `src/bridge/bridge.mjs` + `src/mcp/server.mjs` + `src/ai/compiler/*` + `src/agent/*`。

### 7.1 能立刻补（半天 ~ 2 天/条，全是"加字段/加事件"，不动架构）

| # | 缺什么 | 怎么补（具体到 API） | 为什么重要 |
|---|---|---|---|
| **1.1** | **产出速率观测**（最大缺口） | 读 `root.productionAnalytics.history`（`{produced, stored, delivered}` 三路，每路是时间片数组，`globalConfig.statisticsGraphSlices` 个）；读 `BeltReaderComponent.lastThroughput` + `lastItemTimes`（`components/belt_reader.js`）；暴露成 `obs.production = {produced_per_s, delivered_per_s, slices:[...]}` | **没有它，agent 无法闭环优化吞吐**。现在只能看 hub `delivered` 的净增量，粒度为"整关"，无法定位"哪条线慢"。V7 的吞吐校验也因此只能靠公式估算 |
| **1.2** | **机器内部状态** | `ItemProcessor.ongoingCharges` / `nextOutputSlot`（`components/item_processor.js:46-50`）；`ItemEjector.slots[].item/progress`（已在 `debugItems` 里读了一半）；`StorageComponent.storedCount/storedItem`（`components/storage.js:13-17`）；`Filter.pendingItemsToLeaveThrough/Reject` | 区分"没料"、"堵住"、"在加工"、"配方错"。**这是 agent 自我诊断的唯一依据**，也是 critic 的输入 |
| **1.3** | **解锁/奖励的真实状态** | `root.hubGoals.gainedRewards`（`hub_goals.js:83,201-211`）+ `isRewardUnlocked(reward)` + `root.gameMode.getLevelDefinitions()` | 我们现在用**硬编码表**猜解锁等级（`compile.mjs` 的 `CUTQUAD_MIN_LEVEL = 16`、"UNLOCK_LEVEL_FALLBACK 是编译器侧估计"）。猜错 → 生成"看起来对但造不出来"的蓝图。**游戏里就有真值，没理由猜** |
| **1.4** | **事件推送 mod → bridge** | mod 侧订阅 `root.signals.{level 相关, shapeDelivered, itemProduced, entityDestroyed, storyGoalCompleted, upgradePurchased}` + `hud.parts.dialogs` 的开合；去抖后 `sendRaw({method:"event", params:{type, data}})`。bridge 侧 `broadcastEvent` 已经存在（`bridge.mjs:731`），只需加类型 | 现在 agent 只能轮询。**"等一个事件"比"每 60 tick 查一次"省 10~100 倍调用**；也是"卡住自动告警"的基础 |
| **1.5** | **paste 的 `replaced/destroyed` 回填 + `place` 的 `rv`** | `MOD-GAPS.md` #1/#4 已写明：`opPasteBlueprint` 的 `applied` 分支要把被覆盖的 uid 列出来；`actionSpecs.place` 加 `rv` 字段（`placeOne` 里 `rotationVariantOverride` 已存在，只差透传） | 静默覆盖是**已发生过的事故**（一次毁 6 条带、一次误删 42 实体）。"成功但偷偷改了别的"比"失败"危险得多 |
| **1.6** | **`dismiss_overlays` / 弹窗状态** | `root.hud.parts.dialogs.closeDialog(dialog)` / `close()`（`hud/parts/modal_dialogs.js:174-201`）；`root.hud.parts.shop.close()`（`hud/parts/shop.js:233-237`，注意方法名是 `close()` 不是 `hide()`）；观测加 `hud.parts.{dialogs,shop}.isBlockingOverlay()` | `MOD-GAPS.md` #5：升级弹窗可见时 `step/await` 抛 2002。L3 实机必踩 |
| **1.7** | **`frames_advancing` / stalled 信号** | `root.signals.gameFrameStarted` 记时间戳；`status` 返回 `last_frame_age_ms` | `MOD-GAPS.md` #6：窗口最小化 → render loop 停 → 所有 world op 返回 1003，看起来像"游戏卡死"。**这是运维级 bug，不是功能缺失** |
| **1.8** | **相机/视口观测** | `obs.camera` 已有 x/y/zoom；补 `viewport_tiles`（`camera.getVisibleRect()`）+ `currentLayer` | 现在 `obs.layer` 有，但"屏幕上能看到什么"没有。截图/区域观测/人机协同都需要 |
| **1.9** | **`obs` 精简模式** | 加 `fields: ["type","x","y","r"]` 或 `group_by: "type"` 汇总；对 >500 实体默认给"按类型计数 + bbox"，细节按 region 拉 | `max_entities: 2000` 现在直接吐 2000 条 JSON（几万 token）。FLE 的做法是**永远先给汇总，细节按需**（`observation_formatter.py` 的 `Entities` 小节就是"按类型分组计数"） |

### 7.2 需要一周左右（有设计工作量，但不推翻现有架构）

| # | 缺什么 | 方案 | 为什么重要 |
|---|---|---|---|
| **2.1** | **蓝图带"每实体配置"（SZBP1 v3）** | 加稀疏 `c: {idx: cfg}`；cfg 是每种建筑的配置子集（`Filter` 的 item、`ConstantSignal` 的 signal、`ItemProcessor` 的 recipe、`Display` 的内容）。参照 shapez 2 的 `C:string` 列 | 现在导出一条带 filter/常量的线，贴回来配置全丢。L10+ 复合形状关卡里**几乎每条线都有配置**。这是"能不能复用别人蓝图"的分水岭 |
| **2.2** | **code 表随蓝图走** | 蓝图里带 `codes: [{code, building, variant, rv}]`（只带用到的），粘贴时若当前 `gv` 不同则用表重建 | 现在 `gv` 不匹配直接 `2006`。带上表就能跨小版本复用（code 值变但语义没变的情况） |
| **2.3** | **UI 级驱动 + 差分测试** | 用 `camera.downPreHandler.dispatch` + `app.mousePosition` 走官方 `Blueprint.tryPlace` 路径；同一蓝图跑"我们的 paste"和"UI paste"，比对最终实体集/uid/成本/撤销栈 | **免费的 oracle**。官方路径已被玩家用了几十万小时，我们重实现的路径不可能比它更对。差分测试能持续证明"我们没退化" |
| **2.4** | **事务 / 回滚** | 暴露 `root.logic` 的 bulk operation 边界（`bulkOperationFinished` 已经是 signal），实现 `begin_txn` / `commit` / `rollback`（rollback = 记录 touched uid 的 pre-state，或直接 `load` 一个内存快照） | agent 要能"试错"。现在一次错的 `bulk_delete` 就毁 42 实体且不可逆（我们踩过）。有回滚才敢让 LLM 自由探索 |
| **2.5** | **headless tick 驱动** | 现在 `step` 复刻 puzzle 的 `time.performTicks`，但仍依赖 render loop（窗口最小化就 wedge）。方案：直接调 `core.boundInternalTick()`（`debugLoop` 已在探测它，`shapez-ai-bridge.js:548-560`）循环 N 次，不走 rAF | **CI 里跑不了实机测试**，所有 live 测试都要人开着窗口。这是"能不能自动化回归"的关键。也是将来做 RL/大规模搜索的前提 |
| **2.6** | **线材层（wire）最小支持** | 读：`WireNetwork.currentValue` / `valueConflict`（`systems/wire.js:66-90`）；写：`ConstantSignal.signal`、`Filter` 配置；V8 从"拒绝"改成"允许只读观测" | 现在 `V8` 直接拒绝 wire。但**形状代数里的"动态配方"（按信号切换 cutter/rotater）是 L20+ 的核心玩法**。至少先能"看"，才能谈"造" |
| **2.7** | **验证器升级：从模拟到证明** | 把 V7（吞吐）写成线性约束组（每条边流量 ≤ 容量、节点流量守恒、需求满足），用 CP-SAT 或 z3 解。参照 `verifactory` 的"图 → 逻辑公式"路径 | 现在 V7 是"min 速率 × 行数"的粗算 + `belt-sim` 抽样。**"证明对所有输入不堵" vs "跑 5000 tick 看着没堵"** 是两个可信度量级 |
| **2.8** | **结构化记忆** | `research/ai-plan/*/NOTES.md` 的人工格式 → JSON schema：`{goal, done:[], known_pitfalls:[], open_questions:[], verified_facts:[]}`；每轮 agent 启动时注入 | 见 §5.5 的教训：自由写日记 = 14000 步 31 个文件还卡在第二个城镇。**结构化槽位 > 自由文本** |
| **2.9** | **多客户端写租约** | bridge 的 `clients` 是 Set（可多连），但写操作无互斥。加"写租约"（同一时刻只有一个 client 能发 `act`），或按 region 加锁 | 现在是"谁先发谁赢"，两个 agent 同时改一片区域 = 静默互相覆盖 |

### 7.3 需要重写（架构级，先别做，除非触发条件成立）

| # | 要重写什么 | 为什么现在不做 | 触发条件 |
|---|---|---|---|
| **3.1** | **装箱：模板 → 通用 CP-SAT** | 我们 `place.mjs` 是"模板 + 固定 ROW_H/COL_GAP"，对 v1 的 9 种建筑够用，且**已经被 78 条断言锁住**。换成 CP-SAT 要重写 P3/P4 全部契约 + fixture | 当出现"非矩形机器 / 旋转机器 / 多层 / 需要按通道宽度算 gap"时。**先做 6.3 的 `d_max` 计算**（这是 CP 的 10% 工作量拿到 70% 收益） |
| **3.2** | **布线：A* + 重试 → 预留 + 协商拥塞** | 现在 `route.mjs` 184 断言全绿 + 18 组变异全抓（`router/NOTES.md`）。重写风险极高 | 当"同一通道 > 8 条流"或"需要跨层"时。**先加 sameSideOfCut 判定**（§6.5），它是增量而不是重写 |
| **3.3** | **动作层：逐 op RPC → code-as-action REPL** | 我们的 MCP 是 8 个 tool（`shapez_status/observe/action/batch/screenshot/blueprint/save/load`），agent 每一步一次调用。改成"写 JS 程序"要引入沙箱（`node:vm` 或子进程）、要重做错误模型、要重做权限 | 当"一个任务 > 50 次 tool call"或"token 成本成为瓶颈"时。**FLE 证明这条路可行**（它的工具就是 Python 函数，agent 直接写代码调） |
| **3.4** | **形状求解器：BFS → 更强** | `proto/solver.mjs` 是禁改清单里的（零 export，只能 spawn CLI）。它能解到 L11 左右 | 当 goal 复杂度超出 BFS 状态空间（多层/多色/大深度）时。可参考 `Vystel/shapez2-solver`（13★）和 `TomasSirgedas/Shapez-solver`（6★, C++） |

### 7.4 一句话总结缺口

> **我们不缺"手"，缺"眼睛和耳朵"。**
> 放置能力（place/paste/delete/upgrade/step）已经比任何公开的 shapez 项目都强；
> 但**观测面只有"实体在哪"**，没有"跑得多快 / 堵在哪 / 为什么堵 / 解锁了什么"。
> 所有 §7.1 的 9 条加起来不到 10 天，却能让 agent 从"照着模板摆"变成"看着数据调"。
> 这是投入产出比最高的一块，应该排在最前面。

---

## 8. 参考来源

### 8.1 本地源码（`recon/upstream-full/`，shapez.io 1.5.6）

| 文件 | 用来证明 |
|---|---|
| `src/js/mods/modloader.js` | 装载模型、`$shapez_registerMod`、`new Function`、`exposeExports`、standalone/dev 限制 |
| `src/js/mods/mod.js` / `mod_interface.js`（684 行） | `Mod` 基类、全部 `register*` / `replaceMethod` / `extendClass` API |
| `src/js/mods/mod_signals.js` | 12 个 `MOD_SIGNALS` |
| `src/js/game/root.js:146-195` | 26 个 `root.signals` |
| `src/js/core/signal.js` / `input_distributor.js` / `input_receiver.js` | Signal 语义、输入栈、`forwardToReceiver` |
| `src/js/game/camera.js:87-88, 440-460, 680-750` | `downPreHandler` / `movePreHandler` / `upPostHandler`（模拟点击的底层面） |
| `src/js/game/key_action_mapper.js:324-348, 550-565` | `Keybinding.signal`、`getBindingById` |
| `src/js/savegame/savegame.js:40,58` / `savegame_manager.js:23` | 存档文件名、版本 1010、索引文件 |
| `src/js/core/read_write_proxy.js:83-120` | 存档编码管线（CRC + LZString + `\x01` 前缀） |
| `src/js/savegame/savegame_compressor.js` | 字典压缩 + **146** 字符 charmap |
| `src/js/core/lzstring.js:14, 83-98` | URI-safe 字母表、`compressX64` / `decompressX64` |
| `src/js/savegame/schemas/1000..1010.{js,json}` | schema 版本链、ajv 校验 |
| `src/js/game/entity.js:78-83` + `components/static_map_entity.js:15-24` | 实体序列化结构 |
| `src/js/game/building_codes.js:27-108` | `gBuildingVariants`、`code ↔ (building, variant, rv)` |
| `src/js/game/blueprint.js`（全 186 行） | **无 serialize**；`tryPlace` 的 bulk+immutable 包裹；成本公式 |
| `src/js/game/hud/parts/blueprint_placer.js` | 内存蓝图、`lastBlueprintUsed`、`onMouseDown` 粘贴路径 |
| `src/js/game/logic.js:60-133, 170-200` | `checkCanPlaceEntity`、`tryPlaceBuilding`、`performBulkOperation` / `performImmutableOperation` |
| `src/js/game/components/{item_processor,storage,belt_reader,filter,constant_signal}.js` | 机器/缓冲/吞吐/配置的**可读状态**（我们缺的观测面） |
| `src/js/game/production_analytics.js` | `history.{produced,stored,delivered}` 时间片（我们缺的速率源） |
| `src/js/game/hub_goals.js:83,188-211` | `gainedRewards` / `isRewardUnlocked`（我们硬编码猜测的地方） |
| `src/js/states/mods.js` / `main_menu.js:224-241` | mod 列表 UI、`browseMods` |
| `src/js/core/config.js:16-35, 130-146` | `modBrowser: https://shapez.mod.io/`、`info.file` salt、`info.sgSalt` |
| `src/js/core/config.local.template.js:114-121` | `manualTickOnly`、`externalModUrl` |
| `electron/index.js:17-35, 340-388` | mods/saves 路径、`--load-mod`、`--safe-mode`、成就禁用 |
| `mod_examples/README.md` + 24 个示例 | 官方唯一的"文档"：每个 API 的最小用例 |

### 8.2 本地项目文档（我们自己的）

- `docs/PROTOCOL.md`（协议 v1：RPC 方法、观测/动作 schema、SZBP1、错误码）
- `research/ai-plan/live/MOD-GAPS.md`（6 条实机缺口，本报告 §7.1 的直接输入）
- `research/ai-plan/router/NOTES.md` / `placer/NOTES.md` / `validator/NOTES.md`（P3/P4/P5 的设计与变异测试）
- `research/ai-player/04-ai-planning-research.md`（LLM planning 文献综述，与本文互补）

### 8.3 外部仓库（★ 与 `pushed_at` 为 2026-10-25 实取）

**shapez 系**
- `tobspr-games/shapez.io` — 6999★, 2026-09-07 — https://github.com/tobspr-games/shapez.io
- `tobspr-games/shapez-community-edition` — 206★, 2026-10-16 — https://github.com/tobspr-games/shapez-community-edition
- `tobspr-games/shapez2-shifter` — 14★, 2026-08-13 — https://github.com/tobspr-games/shapez2-shifter
- `tobspr-games/shapez2-mod-samples` — 18★, 2026-08-26 — https://github.com/tobspr-games/shapez2-mod-samples
- `jiahao-0204/Shapez2-MIP-Miner` — 26★, 2026-08-14 — https://github.com/jiahao-0204/Shapez2-MIP-Miner
- `jiahao-0204/Shapez2-MIP-Router` — 14★, 2026-08-11 — https://github.com/jiahao-0204/Shapez2-MIP-Router
- `Vystel/shapez2-solver` — 13★, 2026-07-31 — https://github.com/Vystel/shapez2-solver
- `TomasSirgedas/Shapez-solver` — 6★, 2022-03-20 — https://github.com/TomasSirgedas/Shapez-solver
- `DontMash/shapez-vortex` — 20★, 2026-10-25 — https://github.com/DontMash/shapez-vortex
- `EmeraldBlock/s2bp2s` — 3★, 2023-06-08 — https://github.com/EmeraldBlock/s2bp2s
- `Neighbor-Z/shapez2-savegame-tool` — 2★, 2026-04-26 — https://github.com/Neighbor-Z/shapez2-savegame-tool
- `Loupau38/shapez2-python` — 5★, 2026-08-19 — https://github.com/Loupau38/shapez2-python
- `Neighbor-Z/shapez-save-editor-flask` — 0★, 2026-03-24 — https://github.com/Neighbor-Z/shapez-save-editor-flask
- `mrmelon54/go-shapezio-compression` — 0★, 2021-10-09 — https://github.com/mrmelon54/go-shapezio-compression
- `LilyRose2798/shapez.io-save-editor` — 7★, 2024-05-10 — https://github.com/LilyRose2798/shapez.io-save-editor
- `entibo/shapezio-mods` — 6★, 2026-10-01 — https://github.com/entibo/shapezio-mods
- `DJ1TJOO/create-shapez.io-mod` — 6★, 2023-04-10 — https://github.com/DJ1TJOO/create-shapez.io-mod
- `tobspr-games/shapez.io-viewer` — 24★, 2023-03-04 — https://github.com/tobspr-games/shapez.io-viewer
- `Sense101/shapez-industries` — 11★, 2022-06-17 — https://github.com/Sense101/shapez-industries

**Factorio 系**
- `JackHopkins/factorio-learning-environment` — 1206★, 2026-09-18 — https://github.com/JackHopkins/factorio-learning-environment
- `redruin1/factorio-draftsman` — 185★, 2026-10-04 — https://github.com/redruin1/factorio-draftsman
- `Snagnar/Factompiler` — 421★, 2026-05-18 — https://github.com/Snagnar/Factompiler
- `alegnani/verifactory` — 39★, 2026-10-15 — https://github.com/alegnani/verifactory
- `gusxo999/FLG` — 1★, 2026-10-08 — https://github.com/gusxo999/FLG
- `demipixel/factorio-blueprint` — 112★, 2026-10-10 — https://github.com/demipixel/factorio-blueprint
- `piebro/factorio-blueprint-visualizer` — 587★, 2025-01-10 — https://github.com/piebro/factorio-blueprint-visualizer
- `teoxoy/factorio-blueprint-editor` — 428★, 2026-08-16 — https://github.com/teoxoy/factorio-blueprint-editor
- `tzwaan/factorio_balancers` — 44★, 2024-07-24 — https://github.com/tzwaan/factorio_balancers
- `Buildasaurus/Factorio-Blueprint-Generator` — 15★, 2025-01-29 — https://github.com/Buildasaurus/Factorio-Blueprint-Generator
- `CuteZerg/FactorioLLM` — 0★, 2026-10-25 — https://github.com/CuteZerg/FactorioLLM
- `lvshrd/factorio-agent` — 17★, 2025-09-15 — https://github.com/lvshrd/factorio-agent
- `AI-Ascension/jev-factorio-agent` — 4★, 2026-10-25 — https://github.com/AI-Ascension/jev-factorio-agent

**Agent 框架**
- `MineDojo/Voyager` — 7288★, 2024-04-03 — https://github.com/MineDojo/Voyager
- `MineDojo/MineDojo` — 2277★, 2024-03-18 — https://github.com/MineDojo/MineDojo
- `joonspk-research/generative_agents` — 22291★, 2026-10-25 — https://github.com/joonspk-research/generative_agents
- `git-disl/awesome-LLM-game-agent-papers` — 973★, 2026-06-07 — https://github.com/git-disl/awesome-LLM-game-agent-papers
- `davidhershey/ClaudePlaysPokemonStarter` — 205★, 2025-04-03 — https://github.com/davidhershey/ClaudePlaysPokemonStarter
- `SonicDMG/mcp-game-server` — 6★, 2025-10-17 — https://github.com/SonicDMG/mcp-game-server

### 8.4 论文（arXiv 摘要原文经 `export.arxiv.org/api/query` 取得）

- Wang et al., **Voyager: An Open-Ended Embodied Agent with Large Language Models**, arXiv:2305.16291 (2023-05-25) — https://arxiv.org/abs/2305.16291
- Hopkins, Bakler, Khan, **Factorio Learning Environment**, arXiv:2503.09617 (2025-03-06) — https://arxiv.org/abs/2503.09617
- Patterson, Espasa, Chang, Hoffmann, **Towards Automatic Design of Factorio Blueprints**, arXiv:2310.01505 (2023-10-02) — https://arxiv.org/abs/2310.01505
- Park et al., **Generative Agents: Interactive Simulacra of Human Behavior**, arXiv:2304.03442 (2023-04) — https://arxiv.org/abs/2304.03442
- 综述：**A Survey on Large Language Model-Based Game Agents**, arXiv:2404.02039（ACM CSUR） — https://arxiv.org/abs/2404.02039

### 8.5 算法文献（`[文档说明]`，来自 WebSearch 汇总，未逐篇读原文）

- Factorio 蓝图字符串格式：`0/1` + base64(zlib(JSON))，wiki "Blueprint string format"
- Rectilinear Steiner Tree：NP-hard；Hanan 网格；MST 3/2 近似（Hwang）；Zelikovsky 11/8
- Minimum Manhattan Network：强 NP-complete；2-近似 O(n log n)
- Channel routing：knock-knee 模式 `2d_max − 1` track 恒够（线性时间）
- Zelikovsky, **Faster Approximation Algorithms for the Rectilinear Steiner Tree Problem**, Discrete & Computational Geometry
- Gibson & Dhakal, **Accelerating Discrete Facility Layout Optimization: A Hybrid CDCL and CP-SAT Architecture**, arXiv:2512.18034 (2025-12)
- Van Dyk, Klause, Koenemann, Megow, **Fast Combinatorial Algorithms for Efficient Sortation**, arXiv:2311.05094 (2023-11)（sortation 可行性 NP-hard）
- Meller, Narayanan, Vance, **Optimal facility layout design**, Operations Research Letters 23 (1999)（MIP 经典）

### 8.6 明确未验证 / 找不到的（诚实清单）

- `shapez.mod.io` 是否还活着：**未验证**（域名 curl 超时，2026-10-25）。`core/config.js` 仍指向它。
- shapez 1 的 Discord / Steam `1.5.0-modloader` beta 分支的当前状态：**未验证**（无法访问 Steam）。`mod_examples/README.md` 说要在 Steam 选该分支。
- 「shapez 1 有 AI/bot 项目」：**没找到**（GitHub 全站搜索，唯一命中是宏脚本）。
- 「shapez 1 有蓝图字符串格式」：**确认没有**（源码级）。
- Satisfactory / DSP 的空间布局自动生成器：**没找到活跃的开源项目**（只有产量计算器）。
- Patterson 2023 论文正文（用了哪个 solver、具体编码）：**没读到**（PDF 被拦，只有摘要）。摘要明确说"explores the feasibility of a constraint model"，但没说是 CP 还是 ASP。
- FLE 论文里的具体分数（各模型 lab-play/open-play 得分）：**没读到**（只有摘要的定性结论）。
- Claude Plays Pokemon 的 memory 失败数据（14000 步 / 31 文件）：**仅中文二手转述**，未找到 Anthropic 原文。

---

## 附：一页速查（给实现者）

```
我要做的事                         看哪里
─────────────────────────────────────────────────────────────────
加一个新的观测字段                  §7.1 的 1.1~1.3；源码 production_analytics.js / belt_reader.js
让 agent 不轮询、等事件             §2.4 的 signal 清单 + §7.1 的 1.4
让 mod 支持热重载                   §2.1 的 externalModUrl / --load-mod
抄一个"通道预留"的路由思路           §6.5 + FLG 的 docs/auto-layout/channel/
把吞吐验证从"跑 tick"换成"证明"       §6.4 + verifactory
让 LLM 少花 token                   §5.2 的 ObservationFormatter + §7.1 的 1.9
给 agent 加技能库                   §5.3 Voyager 的四段式
给 agent 加结构化记忆               §5.5 + §7.2 的 2.8
让蓝图能带 filter/常量配置           §3.2 的 (C) shapez2 的 C:string 列
让蓝图能跨版本                      §7.2 的 2.2（code 表随蓝图走）
把"官方 UI 粘贴路径"当 oracle        §2.5 + §7.2 的 2.3
让 CI 能跑实机测试                  §7.2 的 2.5（boundInternalTick 循环）
```
