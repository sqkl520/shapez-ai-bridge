# 人类策略与机制文档 —— shapez.io 的「人类怎么玩」与社区机制知识

> 调研日期：2026-10-23　作者：人类策略调研 agent
> **证据纪律**：【观测】= 本机 `recon/upstream-full/` 源码（1.5.6 @ `ee2279d`，git log 已核）；
> 【社区】= GitHub 上可核实的社区产物（仓库/issue/blog，附 URL）；
> 【推断】= 有依据的推测，非实测。
> ⚠️ 网络受限：fandom / reddit / steamcommunity 全部不可达（curl 返回 000，非 404）。
> 社区渠道只剩 **GitHub（gh CLI / clone / issue）** 与 **shapez.io 官网**（可达但只有落地页，无 wiki）。
> 因此社区证据以 GitHub 上的仓库、issue 讨论、Alt-F4（Factorio 社区博客，托管在 GitHub）为主。

---

## 1. 游戏官方教程：游戏自己怎么教玩家

shapez 的「官方教学」由 **4 个独立系统**叠加。它们不是补充，而是**官方钦定的人类策略**——tobspr 给玩家的标准解法路径。

### 1.1 交互式教程（强制、按等级触发）

**源码**：`src/js/game/hud/parts/interactive_tutorial.js:24-160`（`tutorialsByLevel` 数组，按 `hubGoals.level - 1` 索引）
**文案**：`translations/base-en.yaml:628-667`（`ingame.interactiveTutorial.hints.*`）
**GIF**：`res/ui/interactive_tutorial.noinline/<hintId>.gif`（官方每一步都配了示范动画）

只有 level 1、2、3、21 有交互教程，其余等级为 `[]`（空数组占位，见 `interactive_tutorial.js:109-125`）。

| 步骤 id | 等级 | 条件（源码行） | 官方文案（译） |
|---|---|---|---|
| `1_1_extractor` | 1 | 场上没有任何 Extractor（`:30-32`） | 把**开采器**放在**圆形资源**上以开采它！ |
| `1_2_conveyor` | 1 | 没有从矿机直达 HUB 的传送带（`:36-54`） | 用**传送带**把开采器连到 HUB！提示：**按住鼠标拖拽**铺带！（并画箭头引导） |
| `1_3_expand` | 1 | 恒为真（`:57-60`，即上一步完成就显示） | 这**不是**放置游戏！造**更多开采器和传送带**来更快完成目标。提示：按住 **SHIFT** 一次放多个开采器，用 **R** 旋转。 |
| `2_1_place_cutter` | 2 | 场上没有 cutter（`:65-71`） | 放一台**切割机**把圆形切成两半！PS：无论朝向，切割机**永远从上到下切**。 |
| `2_2_place_trash` | 2 | 场上没有 trash（`:74-80`） | 切割机会**堵塞停摆**！用**垃圾站**处理当下（!）不需要的废料。（UI 高亮切割机的右下槽位 `:424-426`） |
| `2_3_more_cutters` | 2 | 恒为真（`:83-86`） | 干得好！再放 **2 台切割机**加速这个缓慢的过程！PS：用 **0-9 快捷键**更快取建筑。 |
| `3_1_rectangles` | 3 | 已交付 ≥10 或场上采 `RuRuRuRu` 的矿机 <4 台（`:92-105`） | 现在开采些矩形！**建 4 台开采器**并连到 HUB。PS：拖带时按住 **SHIFT** 激活传送带规划器。 |
| `21_1_place_quad_painter` | 21 | 没有 quad painter（`:130-136`） | 放置**四色上色器**，拿一些**圆形**、**白色**和**红色**颜料！ |
| `21_2_switch_to_wires` | 21 | 电线 <5 条（`:140-143`） | 按 **E** 切到电线层！然后把上色器的**四个输入全接上电线**。 |
| `21_3_place_button` | 21 | 没有拨杆（`:147-150`） | 太棒了！放一个**开关**并用线连上。 |
| `21_4_press_button` | 21 | 有拨杆未按（`:154-157`） | 按下开关让它**发出真信号**，从而激活上色器。PS：你不必连接所有输入！试试只连两个。 |

【观测】**关键含义（对 AI）**：官方教学 = **"贪心配对"**：每级只教「多放几台同类机器 + 连到 HUB」。level 1 官方就打破了「一台矿机一条带」的直觉（`1_3_expand`），level 3 官方指定 **4 台**开采器转同一目标。**「横向复制（scale out）」是官方认可的第一策略**。

### 1.2 解锁通知（每级一发，含建筑教学图）

**源码**：`hud/parts/unlock_notification.js:80-99`；建筑教学图集 `res/ui/building_tutorials/*.png`（44 张，`building_placer.js:139-144` 在放置时也常驻显示）

奖励文案全文：`translations/base-en.yaml:1004-1165`（`storyRewards.*`），含每级解锁建筑的**官方用法说明 + 官方陷阱警告**。

### 1.3 随机 tips（加载画面 / 主菜单）

**源码**：`src/js/game/hints.js:9-22`（会话内不重复随机），调用点 `states/preload.js:298`、`states/login.js:77`
**全文**：`translations/base-en.yaml:1540-1596`（56 条；中文版 `base-zh-CN.yaml:1020+`）

**这 56 条就是官方版的「人类策略清单」**。逐条翻译 + 分类见 §3.1。

### 1.4 升级/蓝图/按键介绍弹窗（等级触发）

**源码**：`hud/parts/unlock_notification.js:158-170`
- **level 3** → 弹「Unlock Upgrades」（`base-en.yaml:303-307`）：*"你生产的所有图形都能用来解锁升级 —— **不要拆掉旧工厂！**"*
- **level 5** → 弹「快捷键介绍」
- **level 26** 奖励文案（`base-en.yaml:1155-1160`）→ 官方点名 **MAM**：*"我强烈建议造一台自动交付请求图形的机器！HUB 会把请求的图形**输出到电线层**，你只需分析它并自动配置你的工厂。"*

### 1.5 官方教学视频（外链，等级触发）

**源码**：`hud/parts/tutorial_hints.js:9,58-69` —— `tutorialVideos = [3,4,5,6,7,9,10,11]`，来自 `https://static.shapez.io/tutorial_videos/level_N.webm`。【观测】这佐证了 3-11 级是新手最难段（官方专门录了视频）。

---

## 2. 解锁时间表（等级 → 建筑/升级）

### 2.1 剧情等级表（STANDALONE = 完整版，`modes/levels.js:164-364`）

【观测】`levels` 数组按 index = level-1；`reward` 映射到建筑见 `tutorial_goals_mappings.js:30-68`。

| 级 | 目标图形 | 数量 | 解锁（reward → 实际内容） | 官方同时给的游戏机制提示 |
|---|---|---|---|---|
| 1 | `CuCuCuCu` 圆 | 30 | `reward_cutter_and_trash` → **切割机 + 垃圾站** | 「切完的废料必须扔掉，否则**堵塞**」（yaml:1006-1010） |
| 2 | `----CuCu` 半圆 | 40 | `no_reward`（无） | 「别拆工厂，**所有**图形后面升级都要用」（yaml:1144-1148） |
| 3 | `RuRuRuRu` 矩形 | 70 | `reward_balancer` → **平衡器** | 「用**分流/汇流**把产线扩到多条带上」（yaml:1032-1034） |
| 4 | `RuRu----` 半矩形 | 70 | `reward_rotater` → **旋转器** | — |
| 5 | `Cu----Cu` | 170 | `reward_tunnel` → **隧道** | 「可以钻过建筑和带」（yaml:1036-1038） |
| 6 | `Cu------` 四分之一圆 | 270 | `reward_painter` → **上色器** | 「采颜色矿放进上色器」（yaml:1016-1020） |
| 7 | `CrCrCrCr` 青圆 | 300 | `reward_rotater_ccw` → **逆时针旋转（T 切换变体）** | 「选中旋转器按 **T** 切变体」（yaml:1040-1044） |
| 8 | `RbRb----` 蓝半矩形 | 480 | `reward_mixer` → **调色器** | 「调色器用**加性混色**」（yaml:1022-1024） |
| 9 | `CpCpCpCp` 紫圆 | 600 | `reward_merger` → **汇流器** | 「两个输入合成一输出」（yaml:1056-1059） |
| 10 | `ScScScSc` 星形 | 800 | `reward_stacker` → **堆叠器** | 「能并排就**融合**，不能就把右输入**叠在上层**」（yaml:1026-1030） |
| 11 | `CgScScCg` | 1000 | `reward_miner_chainable` → **链式开采器**（替换工具栏旧矿机） | 「可把资源**转给相邻开采器**」（yaml:1046-1050） |
| 12 | `CbCbCbRb:CwCwCwCw` 蓝图图形 | 1000 | `reward_blueprints` → **蓝图功能**（Ctrl 拖选 → C 复制；**粘贴要付蓝图图形**） | 「复制粘贴要花钱，需要产蓝图图形」（yaml:1087-1091） |
| 13 | `RpRpRpRp:CwCwCwCw` | 3800 | `reward_underground_belt_tier_2` → **隧道 T2**（更长，可混搭） | — |
| 14 | `--Cg----:--Cr----` | **8/秒（吞吐）** | `reward_belt_reader` → **传送带计数器** | ⚠️ **第一个 `throughputOnly` 级**：不再看累计，看**每秒速率** |
| 15 | `SrSrSrSr:CyCyCyCy` | 10000 | `reward_storage` → **仓库**（容量 5000；**优先出左侧口**，可当**溢流门**） | yaml:1081-1085 |
| 16 | `SrSrSrSr:CyCyCyCy:SwSwSwSw` | 6000 | `reward_cutter_quad` → **四切机**（一次切 4 块） | yaml:1071-1073 |
| 17 | `CbRbRbCb:CwCwCwCw:WbWbWbWb` | 20000 | `reward_painter_double` → **双联上色器**（两个图形共用一份颜料） | yaml:1075-1079 |
| 18 | `Sg----Sg:CgCgCgCg:--CyCy--` | 20000 | `reward_rotater_180` → **180° 旋转** | — |
| 19 | `CpRpCp--:SwSwSwSw` | 25000 | `reward_splitter` → **紧凑分流器** | — |
| 20 | `RuCw--Cw:----Ru--`（官方「终局图形」`finalGameShape`） | 25000 | `reward_wires_painter_and_levers` → **电线层（E 键）+ 四色上色器 + 拨杆/开关** | 「按 **E** 进电线层；设置里**开 Hints 才激活电线教程**」（yaml:1097-1104） |
| 21 | `CrCwCrCw:CwCrCwCr:CrCwCrCw:CwCrCwCr` | 25000 | `reward_filter` → **物品过滤器** | 「按电线信号把物品路由到上/右输出」（yaml:1106-1111） |
| 22 | `Cg----Cr:Cw----Cw:Sy------:Cy----Cy` | 25000 | `reward_constant_signal` → **常量信号** | 「可发**图形/颜色/布尔**」（yaml:1119-1123） |
| 23 | `CcSyCcSy:SyCcSyCc:CcSyCcSy` | 25000 | `reward_display` → **显示屏** | 「把信号可视化」;PS 提到 **belt reader / 仓库会输出最后读到的物品**（yaml:1113-1117） |
| 24 | `CcRcCcRc:RwCwRwCw:Sr--Sw--:CyCyCyCy` | 25000 | `reward_logic_gates` → **逻辑门（AND/OR/XOR/NOT）+ 晶体管** | yaml:1125-1130 |
| 25 | `Rg--Rg--:CwRwCwRw:--Rg--Rg` | 25000 | `reward_virtual_processing` → **虚拟处理器**（虚拟切割/旋转/堆叠/分析/比较…） | 「你现在有三条路：① 造 **MAM**（推荐!）② 用线玩花样 ③ 正常玩」（yaml:1132-1141） |
| 26 | `CbCuCbCu:Sr------:--CrSrCr:CwCwCwCw`（火箭） | 50000 | `reward_freeplay` → **自由模式**（无限随机图） | 「HUB **输出请求图形到电线层**，你只需分析并自动配置工厂」（yaml:1155-1160） |
| 27+ | 随机生成 | 见下 | `no_reward_freeplay` | 自由模式 |

**自由模式目标公式**【观测】`hub_goals.js:254-261`：
```
required = min(200, floor(4 + (level - 27) * 0.25))   // 吞吐/秒（throughputOnly）
```
层数 `clamp(level/25, 2, 4)`（`hub_goals.js:398`）；颜色集从**相邻三原色 + 白**里按 seed 取（`:370-390`）；level > 75 起可能出「缺 2 格」图形（`:466-472`）。

### 2.2 建筑解锁谓词（精确 line refs，`buildings/*.js`）

| 建筑 | 解锁 reward | 文件:行 |
|---|---|---|
| 切割机 / 垃圾站 | `reward_cutter_and_trash` | `cutter.js:78` / `trash.js:46` |
| 旋转器 | `reward_rotater` | `rotater.js:105` |
| ├ 逆时针 | `reward_rotater_ccw` | `rotater.js:93` |
| └ 180° | `reward_rotater_180` | `rotater.js:96` |
| 上色器 | `reward_painter` | `painter.js:110` |
| ├ 镜像变体 | （同上，默认可用） | `painter.js:94` |
| ├ 双联 | `reward_painter_double` | `painter.js:95` |
| └ 四色 | `reward_wires_painter_and_levers` | `painter.js:98-102` |
| 调色器 | `reward_mixer` | `mixer.js:37` |
| 堆叠器 | `reward_stacker` | `stacker.js:50` |
| 平衡器 | `reward_balancer` | `balancer.js:138` |
| ├ 汇流（+反向） | `reward_merger` | `balancer.js:124` |
| └ 分流（+反向） | `reward_splitter` | `balancer.js:128` |
| 隧道 | `reward_tunnel` | `underground_belt.js:178` |
| └ T2 | `reward_underground_belt_tier_2` | `underground_belt.js:121` |
| 链式开采器 | `reward_miner_chainable` | `miner.js:59` |
| 仓库 | `reward_storage` | `storage.js:47` |
| 带计数器 | `reward_belt_reader` | `reader.js:37` |
| 电线 + 拨杆 + 电线桥 | `reward_wires_painter_and_levers` | `wire.js:129` / `lever.js:31` / `wire_tunnel.js:32` |
| 过滤器 | `reward_filter` | `filter.js:34` |
| 常量信号 | `reward_constant_signal` | `constant_signal.js:33` |
| 显示屏 | `reward_display` | `display.js:30` |
| 逻辑门 + 晶体管 | `reward_logic_gates` | `logic_gate.js:72` / `transistor.js:45` |
| 虚拟处理器 + 分析器 + 比较器 | `reward_virtual_processing` | `virtual_processor.js:75` / `analyzer.js:33` / `comparator.js:30` |
| 蓝图（非建筑） | `reward_blueprints` | `hub_goals.js:196-212` + `mass_selector.js:136` |

【观测】**注意**：所有建筑（含 hub/带/矿机）**从 level 1 就在注册表**（`meta_building_registry.js:55-85`），靠 `getIsUnlocked()` 按 reward 门槛隐藏；未覆写该方法的建筑一律视为已解锁（`meta_building.js:184-186` 基类 `return true`）——矿机默认版本、传送带、hub 从未覆写，故**永远可用**；链式矿机是其变体。

### 2.3 升级（Upgrade）表 —— 4 条科技线

**源码**：`modes/regular.js:75-295`（`generateUpgrades`）。

- 4 条线：`belt`（带/分流/隧道）、`miner`（开采）、`processors`（切/转/叠）、`painting`（混/涂）。
- **7 个固定 tier**，每级 improvement：`[0.5, 0.5, 1, 1, 2, 1, 1]`（`regular.js:80`）——**tier 5 是「+2」的大跳**。买满 7 个 → 总倍率 **8x**（带速 2→16/s）；再买完 992 级无限升级 → 总倍率上限 **23.9x**（带速 **47.8/s**，即**单带永远到不了 50/s**）。【推断，用 `regular.js` 数据算得】
- tier 7（VIII）之后是 **1000 级无限升级**（`regular.js:81-105`）：20 级 +0.1 → 30 级 +0.05 → 50 级 +0.025 → 之后 +0.0125（递减回报）。
- **要求形状递增**（`regular.js:107-238`）；每 tier 自动把**上一 tier 的全部要求**加进来（`excludePrevious` 除外，`regular.js:246-273`）——所以**升级需求只会变多，永不减少**。tier 间需求增长 `tierGrowth = 2.5`（`regular.js:66`）。
- 【观测】游戏内 UI 显示 **x<当前倍率> → x<新倍率>**（`shop.js:100-103`，翻译 `shopUpgrades`，`base-en.yaml:766-778`）。

**升级线的关键形状**（首 tier）：belt 要 `CuCuCuCu×30`；miner 要 `RuRuRuRu×300`；processors 要 `SuSuSuSu×500`；painting 要 `RbRb----×600`。

### 2.4 基础速度常量（AI 算吞吐必须用）

**源码**：`src/js/core/config.js`（行号已核）

| 量 | 值 | 行 |
|---|---|---|
| 带速 | **2 items/s**（× belt 升级倍率） | `:81`, `hub_goals.js:487-492` |
| 矿机速 | **0.4 items/s** = belt/5（× miner 倍率） | `:151`, `hub_goals.js:509-514` |
| 电线信号速 | 6 items/s | `:88` |
| 隧道跨度 | T1=5 格，T2=9 格 | `:90` |
| 计数器采样间隔 | 10 s | `:92` |
| 仓库容量 | 5000 | `storage.js:15` |
| **切割/四切机** | base 1/4 × processors 倍率（→ 0.5/s 起步） | `:102-103` |
| **旋转（全 3 变体）** | 1/1 × processors（→ **2/s 起步，永远跟得上带**） | `:104-106` |
| 上色器 | 1/6 × painting（→ 0.33/s） | `:107` |
| 双联上色器 | 1/8 × painting（→ **0.25/s 但一次 2 个 = 0.5/s 有效**） | `:108` |
| 四色上色器 | 1/2 × painting（→ 1/s） | `:109` |
| 调色器 | 1/5 × painting（→ 0.4/s） | `:110` |
| 堆叠器 | 1/8 × processors（→ **0.25/s，最慢的建筑**） | `:111` |
| 平衡/分流/汇流 | belt×2（`:532`） | `hub_goals.js` |

【推断】**官方 ratio 一句话**：带 2/s、矿机 0.4/s → **5 矿机 = 1 条满带**（tips #16 明说，`base-en.yaml:1556`）；同 tier 时切割机 0.5/s → **4 台切割机 = 1 条满带（每台 0.5/s）**；而上色器仅 0.33/s、堆叠器 0.25/s → 一条满带需要 **6 台上色器 / 8 台堆叠器**才吃得下。**这就是「正确比例」策略的量化基础，也是「机器速度有限，分开它们」的含义（tips #28）。**

---

## 3. 人类策略清单

### 3.1 官方 tips 逐条（`base-en.yaml:1540-1596`，**编号 = 文件顺序 / tips 数组下标**）—— 这是最重要的一组「官方人类策略」

按主题重新归类（56 条全列，编号即 `T.tips` 索引）：

**A. 布局与规划（7 条）**
| # | 原文（译） | 对 AI 的含义 |
|---|---|---|
| 2 | 让工厂**模块化**，会有回报！ | 布局要能复制粘贴复用 |
| 3 | 别建得离 HUB 太近，否则一团糟 | **HUB 周围留缓冲区**（43 重复强调） |
| 30 | 有条理；尽量**少交叉**传送带 | 一区一带，减少交叉 |
| 31 | **提前规划**，否则一团糟 | 先规划再动手 |
| 39 | 「有了模块，空间只是凡人感知的问题」 | 空间不稀缺 |
| 43 | 建得离 HUB 太近会挡后面的项目 | 同 3 |
| 46 | 你有**无限地图**。别挤，**扩展**！ | 优先可读性，别压缩 |

**B. 效率与比例（10 条）**
| # | 原文（译） | 对 AI 的含义 |
|---|---|---|
| 7 | 只要**所有设施等级一致**，**比例就不变** | **四条升级线要齐头并进**，否则比例失衡 |
| 8 | **串行执行**比并行更高效 | 同带串接多台机器优于多台并行做同一加工 |
| 13 | 试着建**紧凑工厂**，会有回报 | 紧凑利于复用 |
| 15 | 正确的**设施比例**能最大化效率 | 算 ratio（见 §2.4） |
| 16 | 满级时 **5 开采器占满一条带** | 5:1 开采:带 |
| 18 | **不必平均分配**物品也能满效率 | 不需要精确 1/n balancer（与 Factorio 不同！） |
| 26 | 效率是关键！ | — |
| 28 | 机器速度有限，**分开它们**能提效 | 瓶颈机器用分流/多台堆量 |
| 29 | 用**平衡器**最大化效率 | balancer 用于并行扩产 |
| 38 | **切割前先上色**，效率最高 | ⚠️ paint→cut 比 cut→paint 省上色器工作量 |

**C. 具体机制（11 条）** —— 判定 AI 行为正确性的「官方答案」
| # | 原文（译） |
|---|---|
| 4 | 堆叠失败就试试**交换输入顺序** |
| 11 | **对称是关键**（指自由模式目标图形常有对称性，可利用） |
| 12 | 不同等级的隧道可以**编织** |
| 20 | 切割机**永远垂直切**，不论朝向 |
| 21 / 45 | 三原色混出白（重复强调两次） |
| 22 | **仓库优先左侧输出**（可当溢流门） |
| 36 | **有时地图上直接有你要的图形**，不必用堆叠器合成 |
| 37 | **完整风车图形永远不会自然生成** |
| 41 | 仔细看**调色器**，答案自现（= 位域 OR 混色） |
| 48 | **四切机从右上开始顺时针切** |

**D. 运营与流程（8 条）**
| # | 原文（译） |
|---|---|
| 1 | 基地接受**所有**图形，不限于当前目标 |
| 23 | 花时间做**可重复设计**，值得 |
| 27 | **远离基地的矿点图形更复杂** |
| 32 | **不要删掉旧工厂！**升级需要它们 |
| 33 | 试着**自己**打完 level 20/26 再看攻略 |
| 34 | 别把问题复杂化，保持简单 |
| 35 | 你后面可能**要复用工厂，把工厂设计成可复用的** |
| 40 | 做一个**单独的蓝图工厂**，模块要靠它 |

**E. 操作/UI 技巧（20 条）** —— AI 不需要：5（R 反转）、6（CTRL 拖带不自动定向）、9/10（变体用 T）、14（镜像上色器）、17（别忘隧道）、19/24（SHIFT 规划器/批量）、25（ALT 反向）、42（CTRL+Click 框选）、44（固定图标）、47（去玩 Factorio）、49-56（指南针、清带技巧、F4、下载存档、快捷键页、设置页、取消固定）……

【推断】**官方策略摘要**：官方鼓励「**模块化 + 一定比例 + 留白 + 不删旧厂 + 串行 + 对称**」，**没有任何一条**提到「主总线 / main bus」。

### 3.2 社区策略（GitHub 可核实）

#### (1) 蓝图模块集：【社区】`Sharaal/shapez.io`（`https://github.com/Sharaal/shapez.io`，4★）

仓库自述「Collection of shapez.io blueprints」，README 里是**一族标准化模块**的截图（PNG 实图，我这里读到了图片）：

- **T1/T2 分级模块化**——作者按「是否已解锁链式开采器/双联上色器」二分成 T1/T2 两套布局：
  - `t1-colormixer.png` 调色模块、`t1-whitemixer.png` 混白模块、`t1-painter.png` 上色模块、`t1-miner.png` 采矿模块
  - `t2-*.png` 同四类，但利用双联上色器把**所需颜料减半**（README 明说 "T2 starts if having the larger painter which halfs the amount of needed color"）
- `quartly-painter.png` 四色上色器模块（"helps with the different colored shapes"）
- `combiner.png` 合成（stacker）模块
- README 关键句："T2 starts if having the chain extractor" —— **模块随解锁演进而换代**。

【对 AI 含义】这是**人类标准的「模块库」范式**：为每类算子（采矿/上色/调色/合成/四色上色）各做一个*紧凑可复制*的版图，T1/T2/T3 各一套，解锁新变体就换新版。**AI 可直接照抄这个模式**：把常见「源→算子→汇」片段存成蓝图（SZBP1），等级解锁升级后自动重算比例并替换。

#### (2) MAM（Make Anything Machine）—— 社区公认的终局工程

**游戏内定义**【观测】：`achievement_provider.js:527-529` `isMamValid = level > 27 && !failedMam`；`achievement_proxy.js:139-153`：**从完成第 27 级起**，任何 `entityAdded`/`entityDestroyed` 都会把 `failedMam` 置 true；而 `storyGoalCompleted` 时会先检查成就、再把 `failedMam` 清空。结合「无 signal 的成就每 10 秒（`config.js:62 achievementSliceDuration`）被周期检查一次」，实际语义是：

> **等级 > 27 之后，在任何一次成就检查时刻，你都没有放置/拆除过任何建筑**（即「机器建好后不再动手，让它自己跑完随机级」）。

这就是官方给「人类最优解」下的定义：**一台（组）永不再碰的机器，能自动交付任意随机图形**。

**Archipelago 随机化的形式化依赖**【社区】：`https://github.com/ArchipelagoMW/Archipelago/blob/main/worlds/shapez/regions.py:39-73` 给出了**造 MAM 的能力闭包**——这是社区对「MAM 必需件」最精确的工程化表述：

```ts
can_build_mam =
    can_make_stitched_shape        // 能造拼合图形
  and can_paint and can_mix_colors
  and has_balancer and has_tunnel
  and has_all(belt_reader, storage, item_filter, wires, logic_gates, virtual_proc)

can_make_stitched_shape = stacker and ( (cutter_quad and not floating)
                                        or (cutter and rotator) )
can_paint   = painter | painter_double | (painter_quad and wires and (switch|const_signal))
has_balancer = balancer | (merger and splitter)
```
【对 AI 含义】MAM = **虚拟处理（把目标图形信号拆成象限/层）+ 物理产线（按信号切换源与算子）**。L25 解锁 `virtual_processing` 正是让「分析 HUB 输出的图形信号」可行（HUB 通过 `systems/hub.js:36-40` 把 `currentGoal.definition` 写进电线 pin 槽 0）。**这是 AI 的终局目标，也是本项目「自动交付」能力的官方锚点。**

**社区 MAM 工程经验（issue 讨论）**【社区】`tobspr-games/shapez.io#974`：
- 社区玩家 `darkwater4213`：MAM 通常在 HUB 前放一个「**dump gate**（清空门）」——新目标图形到来时把仓库里旧图形清掉，否则旧图形混进新交付。
- 玩家 `edorfaus`（level 115 存档，实测）：不接受「等仓库满再倒」，而是**做图形计数器**——「存到刚好够交付量就触发倒仓」，这样倒仓只需几秒；他的 MAM 约 **92 秒/级**（含 buildup+dump）。

#### (3) 图形运算求解器：【社区】`TomasSirgedas/Shapez-solver`（6★）

`https://github.com/TomasSirgedas/Shapez-solver` —— 网页版 `shapez_solver.html` + C++ 求解器 + `recipes_0_*_*.bin`（预计算**配方表**：从基础图形到目标图形的算子序列），含 `shape_is_possible.bin`（不可行图形黑名单）。
【对 AI 含义】人类早有「**离线预计算配方**」的思路——这正是我们 `research/ai-player/proto/shape-ops.mjs` 应该走的路：**把图形代数求解交给确定性代码，LLM 只做布局决策**。

#### (4) Shapez 2 的 MAM 形式化（跨代迁移参考）：【社区】`my04337/shapez2-in-lean`

`https://github.com/my04337/shapez2-in-lean/blob/main/docs/shapez2/mam.md` ——用 Lean 形式化 Shapez **2** 的 MAM：
- 核心不变量：**「任意象限可与其他象限独立抽取」**（halfDestroy∘rotateCCW∘halfDestroy 抽取单象限）；
- 反面教训被明确列出：*"There is a dependency on the Stacker steps"*（浮层/第 5 层）、*"circuit design is restricted to a flat surface … constants and variables are limited, so the circuit to achieve the same function becomes bloated"*。这与 shapez 1 完全同构（`tutorial_goals_mappings` + 虚拟处理器能力有限）。
【对 AI 含义】形状 1 的 MAM 也可用同样的「象限抽取」引理做**正确性验证**，无需模拟——纯代数。

#### (5) 中文社区工具：【社区】`MengLeiFudge/shapezTools`（4★）

`https://github.com/MengLeiFudge/shapezTools` ——「异形工厂工具箱，包含各种计算可合成图形、获取谜题等功能」——**中文社区独立做出同类的配方求解器**，佐证「求解器」是社区刚需。

#### (6) 速通/存档：[社区] `xnuk/shapez-speedrun-hack`

`https://github.com/xnuk/shapez-speedrun-hack` —— 生成「预填好 level 1 但仓库已塞满关键图形」的存档（`index.js` 里硬编码了 STANDALONE 前 12 级的 `storedShapes` 需求 = 我们的 §2.1 表的数字）。这反向验证了 1-12 级所需的全部图形序列，也说明**速通圈把前 12 级视为一个整体分段**。

### 3.3 官方成就里的「目标行为」

【观测】`platform/achievement_provider.js:180-260` 的成就列表本身就是**官方认定的「人类高手在追求什么」**：

| 成就 | 定义 | 行 |
|---|---|---|
| `mam` | level > 27 且未增删建筑（见上，`:527-529`） | `:196-199` 注册 |
| `speedrunBp30/60/120` | **12 级在 30/60/120 分钟内**完成 | `:235-237` |
| `noBeltUpgradesUntilBp` | **到 12 级且 belt 升级等级仍为 0** | `:540-542` |
| `noInverseRotater` | 到 **14 级**从未放过 CCW/180° 旋转器（用 CW 转三次代替） | `:565-567` |
| `throughputBp25/50` | **25 / 50 蓝图图形/秒**。基础带速 2/s；7 个固定 tier 全买满 → 倍率 **8x = 16/s**；再买 90 级无限升级 → **12.5x = 25/s**。**单带物理上限 47.8/s**（总倍率 23.9）→ **50/s 必须 ≥2 条带** | `:252-253` |
| `throughputLogo50` | 50 logo/秒 | `:254-255` |
| `throughputRocket10/20` | 10 / 20 火箭/秒 | `:256-257` |
| `store100Unique` | 仓库里存过 **100 种不同**图形 | — |
| `place5000Wires` | 放 5000 根电线（电路规模指标） | `:225` |
| `upgradesTier5/8` | 四条升级线全部到 tier V / VIII | `:259-260` |
| `level50/100` | 纯肝度 | — |

【推断】官方用成就把「人类优秀玩法」编码成 4 类：**效率（throughput）、速通（speedrun 12 级）、洁癖（noInverse/noBeltUpgrade）、终局（MAM）**。**AI 的目标函数应当对应这四类**，而不是「完成当前等级」。

---

## 4. 可迁移 / 不可迁移：其他工厂游戏的智慧

【社区】主要来源：Factorio 社区博客 **Alt-F4**（`https://github.com/AlternativeFFFF/Alt-F4`，托管在 GitHub，65 期可全文 clone）+ `raynquist/balancer`（482★ 标准平衡器书）。

### 4.1 可迁移（适用于 shapez）

| 原则 | 出处（可核） | 为什么在 shapez 成立 |
|---|---|---|
| **主总线（Main Bus）** —— 所有材料沿一条主干平行输运，生产线从干上分叉 | Alt-F4 #36（Bentham「tree method」起源，`_posts/en/2021-05-21-ALTF4-36.md:33-37`）；Factorio wiki "Tutorial:Main bus"（Alt-F4 #10 引用 `_posts/en/2020-10-23-ALTF4-10.md:45`） | 【推断】shapez 早期（1-11 级）**多材料下游**成立：同一形状要同时送 HUB（剧情）和升级线（升级），一条「形状总线」分叉到两端合逻辑。**但 shapez 无多材料合成**（不像 Factorio 有铜+铁+塑胶），总线较窄——建议叫「**形状总线**」而非材料总线。 |
| **模块化 / ROFL（Recipe-Oriented）** —— 每配方一个独立可互换模块，模块间用统一接口 | Alt-F4 #28（`_posts/en/2021-03-19-ALTF4-28.md`，Ph.X）：「high cohesion inside, low coupling between」 | 【观测】官方 tips #2「模块化」、#23「可重复设计」、#35「把工厂设计成可复用的」、#40「做一个单独的蓝图工厂」——**shapez 官方与 Factorio 社区结论一致**。 |
| **1:1 balancer 不必均分** —— 「不必为了满效率而平均分配」 | 官方 tip #18（`base-en.yaml:1558`）；raynquist/balancer（n-m balancer 设计） | 【观测】shapez 的 balancer 是**严格 1:1 轮询**（`systems/item_processor.js:342-360`，每 charge 取前 2 个输入槽，`nextOutputSlot++ % availableSlots` 轮流分配）；tip 18 指「不必强行均分」= 用简单 splitters 就够。 |
| **横向复制（scale out）高于纵向优化** —— 产能不足就复制模块 | Alt-F4 #28「copy and paste the corresponding factory module」；官方 tip #8「serial > parallel」反向佐证（同一机器串接优于多台并行做同一加工） | 【观测】shapez 建筑便宜、空间无限 → 复制模块成本极低。**AI 应默认 scale-out**。 |
| **「不要拆旧厂」（Don't break what works）** | Alt-F4 多处；官方 tip #32 + level 3 弹窗 | 【观测】**在 shapez 里强于 Factorio**：形状永远用于升级，拆掉立刻断供。 |
| **瓶颈识别 / 吞吐分析** | Alt-F4 #7「Megabase Thinking」（`_posts/en/2020-10-02-ALTF4-7.md`）；Factorio 的 throughput 概念 | 【观测】shapez 有 **belt reader**（L14）+ **Statistics 面板**（`hud/parts/statistics.js`）+ **ProductionAnalytics**（`production_analytics.js`）——官方内建吞吐计量，AI 可读（桥接 `obs` 已有 delivered/rate）。 |
| **优先做正确的**（correctness before optimization） | 「简单优先」官方 tip #34 | 【观测】先满足 `required` 再谈效率；`await` 直到 `hub_delivered_increased`。 |

### 4.2 不可迁移（+ 为什么）

| 原则 | 为什么**不适用** shapez |
|---|---|
| **城市块（City Block） / 铁路网格** | 【推断】**shapez 没有火车、没有列车网络**。城市块的价值在「跨远距离高吞吐运输」，而 shapez 只有传送带（2/s）且**资源矿点就在附近**（§5）。没有物流网格的需求。 |
| **火车 / 车站 / LTN 式物流** | 同上——shapez 传送带 + 隧道即上限；没有等价的调度问题。 |
| **吞吐是距离受限的（运输成本）** | Factorio 的一大策略是「就地冶炼/就地组装以减半运输量」（Alt-F4 #7 的核心论点）。shapez **没有堆叠/密度概念**（1 物品 = 1 格带位），**运输量与图形复杂度无关**——「先加工再运」的收益只体现在缩短链路，不体现在运输效率。 |
| **电力/污染/虫子（功率管理、防御）** | shapez 无电无污染无敌人。 |
| **矿脉耗竭与再勘探** | 【观测】shapez 资源矿点**永久无穷**（`map_chunk.js` 资源是静态地形）。 |
| **液体/管道/化工** | shapez 只有图形 + 颜色。 |
| **「主总线承载十几种材料」** | 【推断】shapez 每级只产 1-2 种目标形状 + 4 种颜色 → 总线只有 1-2 车道，**Factorio 式宽总线无意义**。窄「形状干线」才是对的形式。 |
| **精确比例（perfect ratios，蓝图级）** | 官方 tip #18 明说**不必**均分；且升级会变比例（tip #7），追求完美比例会不断返工。**近似比例 + 可调分流**更实际。 |
| **机器间直接插入（inserter chaining）** | shapez 建筑之间靠带/槽位（slot）连接，无 inserter 自由取放。 |

---

## 5. 额外机制事实（人类常踩、AI 必须知道的坑）

| 事实 | 证据 | 影响 |
|---|---|---|
| **矿点永久无穷、无耗竭** | 【观测】`map_chunk.js` 生成的是静态地形（`generatePatches`），无 depletion 逻辑 | 矿机持续产出；布局无需考虑矿量 |
| **矿点按距 HUB 出现复杂度** | 【观测】`map_chunk.js:186-247`：距原点 <7 chunk 无星形/风车；<10 chunk **单形**；<15 chunk 双形拼；≥15 chunk 随机 4 象限；颜色 `internalGenerateColorPatch:171-178`: 距 HUB ≤2 chunk 只有红/绿，>2 才有蓝 | **离 HUB 越近越简单**；AI 应偏好近处矿点做早期产线，远端才有复杂形 |
| **固定预置矿点** | 【观测】`map_chunk.js:319-347`：chunk(0,0)=红, (-1,0)=`CuCuCuCu`, (0,-1)=`RuRuRuRu`, (-1,-1)=绿, (5,-2)=`SuSuSuSu` | **开局五矿坐标恒定**——AI 可硬编码第一批路径（也解释了 tutorial GIF 里的位置） |
| **HUB 接受任何图形、4×4、每边 4 格可入** | 【观测】`buildings/hub.js:23,76-90`：4 边 × 4 格 = 16 个方向槽（角格双向重复计数），`filter: "shape"` | **不需要"送对"**；任意输入即刻计数（`hub_goals.js:219-234`） |
| **多余图形会自动入库** | 【观测】`hub_goals.js:219-223` 任何 delivered definition 都进 `storedShapes` | **冗余产出不浪费**，可用于升级 |
| **形状瓶颈来自加工，不是带** | 【观测】`config.js:101-112` 加工速度慢于带速 | L14「8/s 吞吐」目标：按带速 2/s×(1+升级) 计算需 1.5–4 条满带（取决于 belt 升级档），**核心是让加工链不断料**，不能只铺一条大带 |
| **堆叠器最慢（0.25/s）**；切割 0.5/s；上色 0.33/s；旋转 2/s | 【观测】同 `config.js:101-112` | **堆叠步骤是 MAM 吞吐瓶颈**——必须并行多台堆叠器 + 用 balancer |
| **同一带上的多台加工器串接无额外损耗** | 【观测】`systems/item_processor.js:18`（`MAX_QUEUED_CHARGES = 2`）+ `:130-133`：一个输入槽 + 排入 charge queue | 官方 tip #8「串行优于并行」的机制基础 |
| **蓝图粘贴消耗蓝图图形（L12 起）** | 【观测】`blueprint_placer.js:16-28` + `mass_selector.js:136`；tips「Pasting it is **not free**」yaml:1090-1091 | AI 想用蓝图批量化必须自建蓝图厂（tip #40「做一个单独的蓝图工厂」），且**模块复制有真实成本**——鼓励先廉价验证再批量复制 |
| **四色上色器的颜色输入由电线决定，非物品** | 【观测】`painter.js:195-220`（4 个 `logicalAcceptor` pin）+ `systems/item_processor.js:558-575` | 四色上色需要**电路规划**，物理解法不可用 |
| **仓库「优先左侧输出」= 溢出逻辑的实现** | 【观测】`storage.js:57-68` ejector 槽 0 = pos(0,0)（局部左格），槽 1 = pos(1,0)；`systems/storage.js:34-37` 调 `getFirstFreeSlot()`，`components/item_ejector.js:117-124` 从 index 0 起找第一个可出 | **仓库可做溢流门（overflow gate）**：左口堵了才走右口——AI 可用它做「优先供给 + 泄流」 |
| **HUB 输出请求图形到电线层** | 【观测】`systems/hub.js:36-40`（`pinsComp.slots[0].value = currentGoal.definition`） | **MAM 的信号源**：只需 `analyzer`/`comparator` 读它 |

---

## 6. 对 AI 的直接含义（浓缩）

1. **官方教学 = 贪心 + 横向复制**（§1.1）。初期（L1-3）AI 应完全照抄官方交互教程的三个决策，不必"更聪明"。
2. **形状代数必须交给确定性代码**（§3.2-3/4）。human 社区做求解器（Shapez-solver）就是为了不靠脑子；AI 更应如此。
3. **模块库范式**（§3.2-1）：为每类算子维护 T1/T2/T3 版模块；解锁升级后自动升级模块。
4. **不要追求完美比例**（§4.2）；用近似比例 + 可调分流（balancer/splitter）。
5. **终局 = MAM**（§3.2-2）：官方成就将其定义为「建完不动还能自动完成任意随机级」。L25 解锁的虚拟处理器 + HUB 电线输出，是 MAM 的两块拼图。
6. **官方成就 = 官方的目标函数**（§3.3）：效率（throughput）、速通（12 级分段）、洁癖（不升级带/不用反向旋转）、终局（MAM）四类。
7. **「不删旧厂」是硬约束**（§4.1）：旧图形持续用于升级，拆掉即断供。
8. **近矿优先**（§5）：距 HUB ≤10 chunk 的矿点形状简单；固定五矿开局可用。

---

## Sources

**本机源码（精确 1.5.6 @ `ee2279d`，`recon/upstream-full/`）**
- `src/js/game/modes/levels.js`（STANDALONE_LEVELS:164-364；自由模式 needs）
- `src/js/game/modes/regular.js`（generateUpgrades:75-295）
- `src/js/game/hub_goals.js`（自由模式图形生成:370-479；速度:487-575）
- `src/js/game/tutorial_goals.js` / `tutorial_goals_mappings.js`
- `src/js/game/hud/parts/interactive_tutorial.js`（tutorialsByLevel:24-160）
- `src/js/game/hud/parts/unlock_notification.js` / `building_placer.js`
- `src/js/game/hud/parts/tutorial_hints.js` / `pinned_shapes.js` / `shop.js` / `statistics.js`
- `src/js/game/hints.js`、`src/js/states/preload.js:298`、`states/login.js:77`
- `src/js/game/map_chunk.js`（矿点生成:171-347）
- `src/js/game/systems/item_processor.js`（BALANCER:342）、`systems/hub.js:36-40`、`systems/storage.js`
- `src/js/game/buildings/*.js`（各 getIsUnlocked）
- `src/js/core/config.js`（速度常量:81-112,151）
- `src/js/platform/achievement_provider.js` / `achievement_proxy.js`
- `translations/base-en.yaml`（storyRewards:1004-1165；tips:1540-1596；interactiveTutorial:628-667；shopUpgrades:766-778；dialogs:303-307）/ `base-zh-CN.yaml`（tips:1020+）
- `res/ui/building_tutorials/*.png`（44 张）、`res/ui/interactive_tutorial.noinline/*.gif`（11 个）

**社区（GitHub，可核实）**
- https://github.com/Sharaal/shapez.io （蓝图模块集 T1/T2）
- https://github.com/TomasSirgedas/Shapez-solver （配方求解器）
- https://github.com/raynquist/balancer （Factorio 标准平衡器书，482★）
- https://github.com/AlternativeFFFF/Alt-F4 （Factorio 社区博客 #7/#28/#36 等）
- https://github.com/ArchipelagoMW/Archipelago/blob/main/worlds/shapez/regions.py （MAM 能力闭包）
- https://github.com/my04337/shapez2-in-lean/blob/main/docs/shapez2/mam.md （Shapez 2 MAM 形式化）
- https://github.com/xnuk/shapez-speedrun-hack （速通存档生成，含 1-12 级完整需求）
- https://github.com/MengLeiFudge/shapezTools （中文求解器/工具）
- https://github.com/tobspr-games/shapez.io/issues/974 （MAM dump gate 讨论）、#781/#1631/#974/#981、#1478 等
- https://github.com/ritsusonn/shapez-mam （MAM 分析器：stacker 依赖与「电路平面限制」教训）
- https://github.com/tristanstraub/busmaker 、 https://github.com/sgielen/blocktorio （Factorio 主总线/城市块生成器，作为对照）
- https://github.com/factorio-realms/factorio-tutorials （Factorio 教学）

**不可达（已实测，供后续参考）**：shapez.fandom.com、reddit.com/r/shapezio、steamcommunity.com（curl 000）；shapez.io 官网可达但仅落地页（`/wiki`、`/modding.html` 均 404）。
