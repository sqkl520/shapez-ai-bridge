# 红队：布局编译器开工前的假设攻击

> 立场：编译器"开始写之前"，逐条攻击它**赖以成立**的假设，找出"源码看着稳、实机会翻车"的地方。
> 只产出分析与判据，不写实现。
> 行号基准：上游 `recon/upstream-full/src/js/`（shapez 1.5.6 @ ee2279d）+ 工作树 `src/mod/shapez-ai-bridge.js`。
> 每条标注：**【源码确证】**（读了上游/工作树代码）／**【推断】**（从代码逻辑推，未跑）／**【待实机】**（只能上机定论）。
> 承接 `review/ADVERSARIAL-REVIEW.md` 的 F1/F2，本文不重复其已列结论，只做增量核证与排序。

## 排序总览（最可能翻车 × 影响）

| 排名 | 假设 | 一句话风险 | 严重度 |
|---|---|---|---|
| 1 | #3b 只有 belt/wire replaceable | 粘贴落在既有带子上**静默毁带 + 半建线**，已发生"毁 6 条真实带" | **5** |
| 2 | #3a SZBP1 丢 originalRotation | 拐角带在"增量施工/粘贴后旁补一格"时被游戏按错误的 orig **悄悄翻向** | **4** |
| 3 | #4 配方 DAG 总能空间实现 | 编译器目前**无可布性检测**；含机器的布局其带子 rv 不是"纯带-带闭合"的不动点（validate C 只有 82.5%） | **4** |
| 4 | #2 immutable 粘贴确定（邻居是机器） | belt 改写被 immutable 挡住，但 mod 的逐格 `entityManuallyPlaced` 会触发**隧道 smartplace 删带**（不认 immutable）；hub goal acceptor 无副作用 | **3** |
| 5 | #5 端到端已通 | e2e 只走 `place` 直送、零拐角零机器；**paste 通道从未端到端交付过** | **3** |
| 6 | #1 solveTurn 正确 / belt-rules 验证 | `solveTurn` 公式对，但"1906/1906 已验证"混淆了**自洽**与**语义**；且 `proto/belt-rules.mjs` 的 `beltEntry` 对弯带是**错的**，两个文件并存会误用 | **3** |
| — | #6 place 不查解锁 | 不是 bug 是**定位问题**，会改变编译器/评估口径（见 blocking question） | 流程 |

---

## #1 — `belt-rules.mjs` 的 `solveTurn` 正确

### 假设是什么
`solveTurn(beltEntry, beltExit)` 用 `rotateLocal` 求 (rotation, rv)，已用真实存档 1906 条带验证 `solveTurn(...)==存档值` 1906/1906 ⇒ 编译器可信赖它把"世界进/出方向"翻译成蓝图 rv。

### 哪里可能是错的（证据）
**(1) 验证的是内部自洽，不是语义。**【源码确证】`beltEntry`/`beltExit`/`solveTurn` 全都建在同一套 `rotateLocal` 上（`src/ai/belt-rules.mjs:24-52`）。`solveTurn(in,out)` 求 `entry==in && exit==out`，而这句 entry/exit 正是 `rotateLocal(bottom/exitlocal, rot)` —— 只要 `rotateLocal` 是双射，`solveTurn(beltEntry(rv,rot), beltExit(rv,rot))==(rv,rot)` **恒成立，与游戏无关**。`validate-belt-rules.mjs:119-135` 的 [C] 项喂进 `computeBelt` 的邻居**只有带子**（`validate-belt-rules.mjs:126-127` `if (nb.belt ...)`），机器邻居从未参与，于是它**结构上不可能**验证"蓝图 (r,rv,code) 会让游戏产出朝向该方向的带子"这件真正要的事。
**(2) `src/ai` 与 `proto` 两份 `belt-rules.mjs` 不一致，且 proto 版对弯带是错的。**【源码确证】`diff` 确认两文件不同：`src/ai` 用 `beltEntry(rv,rot)=rotateLocal("bottom",rot)`（对：FAKE_BELT_ACCEPTOR_SLOT.direction=bottom，`components/belt.js:9-12`）；`proto` 用 `beltEntry = OPP[beltExit]`（`research/ai-player/proto/belt-rules.mjs:49`）。对 rv0 直带 OPP 恰好对，但对 rv1/rv2 **入口是垂直于出口的，不是相反** —— proto 版 rv1 rot0 会说"入口=right"，真值"入口=bottom"。若编译器 import proto 版做链闭合/几何校验，弯带会静默判错。
**(3) 好消息：`src/ai` 的公式其实和游戏**是**对齐的。**【源码确证】游戏带子的世界出口 = `localDirectionToWorld(arrayBeltVariantToRotation[rv])`（`systems/belt.js:148` + `:366`），`arrayBeltVariantToRotation=[top,left,right]`（`buildings/belt.js:12`），`localDirectionToWorld(d)=transformDirectionFromMultipleOf90(d, rotation)`（`static_map_entity.js:166`）按 ORDER[top,right,bottom,left] 旋转 —— 逐字等于 `src/ai` 的 `beltExit(rv,rotation)`；入口= `localDirectionToWorld(bottom)`（`systems/belt.js:396`）等于 `beltEntry`。所以 `src/ai/belt-rules.mjs` 的公式正确，只是**没人拿游戏侧的字段交叉核对过**，而"1906/1906"给人已经核过的错觉。

### 会怎么在实机翻车
- 直接翻车概率**低**（src/ai 公式对）。真正翻车是：编译器作者**误 import `proto/` 那份**（proto 里有 solver/layout 一整套 import 习惯），弯带入口判反 → 生成的整条 L 形 rv 全错 → 粘贴后带子互相不认（`findFollowUpEntity` 判 `acceptedDirection!==followUpDirection` 断链，`systems/belt.js:378-380`），物流死在第一个拐角。
- 或：依赖"C 项已验证"跳过对**机器邻居**方向的复核 → 落到 #4 的坑。

### 实机/离线怎么提前抓出来
- **离线判据（最强，零游戏）**：用游戏字段独立重算一遍。对存档每条带，读 `sme.rotation` 与 `sme.code→rv`，令 `game_exit = rotateLocal([top,left,right][rv], rotation)`（直接照抄 `arrayBeltVariantToRotation` 常量），断言 `game_exit == beltExit_from_our_module(rv, rotation)`。这**跨了两套实现**（常量表 vs 我们的 helper），比自证强。再对每条**链**断言 `game_exit(u)` 的反方位 == `entry(v)`，entry 用 `rotateLocal(bottom, rotation_v)`。
- **实机判据（验证"朝向 X"语义）**——不动工厂区，在 2000+ 格外空地：
  1. 单格放一个带子，显式给定 (r, rv)（走 `paste_blueprint` 一格蓝图锁定 rv），四周全空。
  2. 读回 `obs` 该格 → 断言 `r`、`rotation_variant`、`code` 与传入一致（`bridge:446-455` 已回报这三项）。
  3. **真正验证"流向"**：矿机（喷口恒 top，`buildings/miner.js:82-84`）放在该带子的**我们算出的入口**方位，trash 放在**我们算出的出口**方位，`step` 后 `save_now` 离线解码 `beltPaths`，断言该带子所在 path 的 `items` 从矿机端出现在 trash 端、且 path 的 head→tail 方向 == 预测。若 `direction` 字段能读（见下"待实机"），更直接。
  4. 对 rv0/rv1/rv2 × rotation{0,90,180,270} 共 12 组各做 2-3，覆盖 solveTurn 全部输出。
- **删除误用面**：把 `proto/belt-rules.mjs` 改掉（`beltEntry=OPP[beltExit]` → `rotateLocal("bottom",rot)`）或删掉，避免编译器 import 到错的。

### 缓解建议
- 编译器**只 import `src/ai/belt-rules.mjs`**；在文档写明 proto 那份已废。
- 把上面"离线跨实现判据"做成 `test/` 一条断言（对照 `arrayBeltVariantToRotation` 常量重算），把"1906/1906"从"自洽"升级为"与游戏字段口径一致"。

---

## #2 — immutable 粘贴确定（提交 a35a481），邻居是**机器**时

### 假设是什么
`updateSurroundingBeltPlacement` 只看 `immutableOperationRunning` 豁免，故邻居含机器时和含带子时一样被屏蔽，粘贴确定。

### 哪里可能是错的（证据）
- **belt 部分：假设成立。**【源码确证】`systems/belt.js:117-216`：对受影响区（`getTileSpaceBounds().expandedInAllDirections(1)`，`:129-130`）里每个**带子**目标，重算走 `getEjectorsAndAcceptorsAtTile(tile)`（`:167` → `logic.js:391-470`）。该函数把邻居的 `ItemEjector`/`ItemAcceptor` 槽**和带子的 fake 槽**一起收集（`logic.js:421-434`），所以矿机喷口、cutter/painter/hub 收口确实进入启发式。但唯一写回 gate 是 `if (!immutableOperationRunning && ...)`（`systems/belt.js:169`）—— 整个 paste 包在该 flag 内（`bridge:1576-1577`），故**粘贴期间任何邻居（机器或带）都改不了带子**。RV-FIX v2 反例实验（`facts/RV-FIX-verified.md:30-44`）测的是"带子邻居"，源码层面机器邻居走的是同一 gate，豁免同样生效。这一半**站得住**。
- **但"接受方是机器"确实会影响别的东西，而别的东⻄不受 immutable 保护：**【源码确证】
  1. **隧道 smartplace**：mod `placeOne` 对**每个**放置的实体 `dispatch(entityManuallyPlaced)`（`bridge:821-825`），`UndergroundBeltSystem.onEntityManuallyPlaced`（`systems/underground_belt.js:53`）**不检查 `immutableOperationRunning`**，会在落一个 receiver 隧道时把它与 sender 之间的带子 `tryDeleteBuilding`（`:137-143`）。若蓝图含隧道，粘贴**过程中**会删带，且删带触发的 `entityDestroyed→updateSurroundingBeltPlacement` 又被 immutable 挡回去 → **幸存带子的 rv 不再重定向 → 悬空/错向**。对**纯带无隧道的 v1 布局**（design 阶段 B 明确"先做无隧道版"）无影响；对隧道阶段是真坑。
  2. **wire 层重算无 immutable 豁免**：`updateSurroundingWirePlacement`（`systems/wire.js:714-760`）同样以 `originalRotation` 重算并改写 wire 的 `rotation/rotationVariant/code`（`:739/:749/:753`），**没有** `!immutableOperationRunning` 判断（对比 belt 的 `:169`）。它在 `queuePlacementUpdate` 经 `staleArea.invalidate`（`:707`）延迟到下一帧 `recomputeArea` 执行。⇒ 带 wire 的蓝图粘贴后，**wire 的拐角/直向会在粘贴结束后被游戏按 (邻居, 我们丢了 originalRotation 的) orig 重算** —— 这是 #3a 在 wire 上的镜像，且比 belt 更危险（belt 至少 paste 内被保护，wire 连 paste 内的"延迟"都不给）。
  3. **hub goal acceptor**：只读它作为 acceptor 进 belt 启发式（`hub.js:79-82` 的 16 个 ItemAcceptor 槽）；`goal_acceptor` 是独立建筑，不产生"paste 会扰动的额外图边"。这一子假设**安全**。

### 会怎么在实机翻车
- v1 无隧道无 wire：安全。
- 一旦布局含 wire（信号/升级）：粘贴后 wire 拐角被 `updateSurroundingWirePlacement` 翻成错误直/弯，逻辑连线断 → 依赖信号的机器不动作。
- 一旦含隧道：smartplace 在 paste 中途删带 → 物流缺口（`applied` 还显示成功）。

### 实机/离线怎么提前抓出来
- **实机判据（机器邻居，含 wire）**：在空地 paste 一个"L 形带 + 旁边放一台 cutter（其 bottom 收口落在拐角邻居上）"的蓝图；`step 0` 后立刻读回拐角 code 应为蓝图值；再 `step 1` 触发 wire/隧道系统跑一帧，**再读一次**。belt 拐角若两读一致 → 机器邻居没在事后改 belt（预期如此）。wire 版若两读不一致 → 证实 wire 无 immutable 保护。
- **隧道判据**：paste 一条"sender—带—receiver"三段；预期 smartplace 把中间带删（`enableTunnelSmartplace` 开）→ 检查是否 `applied` 与最终实体数不符。

### 缓解建议
- 编译器 v1 **只产 regular 层、不含 wire、不含隧道**（与 design 阶段 B 一致），把这三类作为 `ok:false, reason="需 wire/隧道，未支持"` 上报。
- 若将来支持 wire：paste 完**立刻用显式 `place`（带 rv 覆盖）对每根 wire 重钉**，或给 mod 加"paste 后 freeze 一帧"。隧道：粘贴前关掉 `enableTunnelSmartplace` 或改用"隧道两侧不留带子"的画法。

---

## #3 — 蓝图路径能表达一切布局

### (a) SZBP1 stride=4 丢了 originalRotation

#### 假设是什么
`paste_blueprint` 每格显式带 (code,dx,dy,rot)，所以蓝图路径能表达任意布局的朝向。

#### 哪里可能是错的（证据）
- **【源码确证】我们只存 `rotation`，不存 `originalRotation`**：`export_blueprint` 每格只 `push({code, x, y, rot: sme.rotation})`（`bridge:1458`），flat stride=4（`:1475`）；decode `blueprint.mjs:50-51`。粘贴时 `placeOne` 把**同一个 `rot` 同时当 `rotation` 和 `originalRotation`** 传给 `tryPlaceBuilding`（`bridge:810-814`）。而游戏自己的蓝图走 `entity.clone()` 序列化，**两个字段都带**（`blueprint.js:166`；schema `static_map_entity.js:16-23` 含 `originalRotation`）。
- **【源码确证】重算以 originalRotation 为基准**：`systems/belt.js:160` `rotation: targetStaticComp.originalRotation`；wire 同样 `:739`。启发式的两个返回分支对 rotation 的处理**不同**（关键！）：`buildings/belt.js:204-223`（"侧向 ejector"分支）返回 `rotation+270`（rv2）/`rotation+90`（rv1）；`:227-244`（"侧向 acceptor"分支）返回 `rotation` **不变**（rv2/rv1）。⇒ 同一个最终 (rotation, rv) 可能来自 `orig=rotation-270` 或 `orig=rotation`，**取决于当时是哪个分支命中**。
- **【源码确证】后果（review F1(c) 复核）**：原生里被自动转向过的拐角带（如 M4 的 `(138,93) r=270`，其 orig 实为 0），导出→粘贴后 `originalRotation` 被写成 270。**日后任何一次邻域扰动**（不是 paste 那一刻——那被 immutable 挡了）触发 `updateSurroundingBeltPlacement`，重算以 270 为基准而非 0 → 得到的 rv/rotation 可能与原工厂不同 → **拐角翻向**。

#### 有多致命 / 怎么翻车
- **一次性 paste-and-run：被掩盖。**【推断】immutable 覆盖整个粘贴循环，粘贴结束不再有邻域扰动，带子停在显式 rv 上。
- **增量施工 / 扩张（design §3.3、SYNTHESIS 明确目标）：必踩。**【推断 + RV-FIX T3 实证 `facts/RV-FIX-verified.md:23-24`】"粘贴完成后在旁边再放一格，entityAdded 仍会按邻居重算那个拐角" —— T3 已实机确认。此时基准 orig 错 → 拐角静默翻向 → 物流断或反向。
- **可布性 + 不动点问题（与 #4 合流）**：编译器用 `solveTurn` **直接指定** (rotation, rv)，绕开游戏 auto-orient；但它没有为这组 (rotation,rv) 选一个"使 computeBelt 成为不动点"的 originalRotation。要让带子"日后被重算也不变"，需 `computeBelt(orig, 邻居)==(rotation,rv)`；而 `orig` 不能只从 (rotation,rv) 反推（分支二义，见上）—— `validate-belt-rules.mjs:74-79` 的 `inferOrig` 用固定 `VARIANT_SHIFT{0:0,1:90,2:270}` 猜，只覆盖一支，所以 C 项只有 82.5%。

#### 绕过法（判断可行性）
1. **stride=5 补存 originalRotation**（review C3）——治本，但要求编译器导出的每张蓝图都带着"游戏当时的 orig"，对**纯离线合成**的布局无原生 orig 可导。
2. **编译器主动选 orig 使带子成为不动点**：对每根带子，按它**最终邻居拓扑**判断该走 belt.js 哪一支（侧 ejector → 支①，侧 acceptor → 支②，否则 rv0），从而算出**该支下正确的 orig**，写进蓝图。需要实机验证"我选的 orig 让 computeBelt 命中我的 (rotation,rv)"。
3. **"粘贴后立刻补一次显式 place 钉死"（task 提的绕过）**：【推断】**部分有效但不彻底** —— 显式 `place` 带 rv 覆盖走 `tryPlaceBuilding` 时仍 `originalRotation=rot`（`bridge:814`），没修 orig，只把 rv 又写了一遍；下一次邻域扰动照样按错 orig 翻。真正"钉死"要 mod 支持传 originalRotation，或粘贴后由编译器跑一次 `computeBelt` 自检并报告"哪些带子不是不动点"。
4. **纪律型**：编译器整块 paste、绝不在已贴拐角旁增量补格；改动就整块重贴（RV-FIX-verified.md:24 的现存纪律）。脆弱（人/agent 会忘），但对 v1 足够。

### (b) 只有 belt/wire 是 replaceable —— 占用检查的不对称

#### 假设是什么
编译器"避开占用"只要判断目标格有没有东西。

#### 哪里可能是错的（证据）
- **【源码确证】不对称**：`getIsReplaceable` 默认 false（`meta_building.js:95`），仅 belt（`buildings/belt.js:68`）与 wire（`buildings/wire.js:122`）覆盖为 true。
  - 粘贴落在**既有带子**上 → `checkCanPlaceEntity` 放行（`logic.js:77-80`）→ `tryPlaceBuilding → freeEntityAreaBeforeBuild`（`logic.js:127/:140-164`）**删除旧带、放新带** = **静默毁带**。`applied/failed` **不报告被覆盖删了什么**（`bridge:1552-1575` 的 `failed` 只装"没放上的"），review F2:88 已点。
  - 粘贴落在**既有机器**上 → `checkCanPlaceEntity` 返回 false（`logic.js:81-84`）→ `placeOne` 返回 null → 进 `failed:{reason:"game_rejected"}`（`bridge:1573`）= **该格被静默跳过**。
- **【事故实证】**：`facts/INCIDENT-bulk-delete.md:28` + `facts/RV-FIX-verified.md:27-28` 记录研究期间"一次未清理的粘贴毁掉真实工厂 6 条带子"。

#### 会怎么在实机翻车
- **半建线 = 堵死**：粘贴按格独立 apply（`bridge:1553`循环）。若布局与既有机器有**部分**重叠，`applied=60, failed=[8 格 game_rejected]`，编译器若当"成功带警告"继续，落地的是**断链**——矿机喷到一格没有出口的带子、或 stacker 只接到一个输入，`await` 超时 → 死厂。
- **静默毁带**：锚点算偏一格，整条 paste **覆盖**既有产线的带子（机器格会 reject 但带子格被 replace），既毁旧厂又建出新畸形布局，且 `ok:true`。

#### 检测（提前抓）
- **粘贴前**（离线）：编译器读目标区 `obs`/存档，做**逐格矩形碰撞**，区分三类：空 / 带子(可覆盖) / 机器(会 reject)。任一格非"空"即**默认 abort**（而非跳过）。带子格的覆盖必须**列出将被删的 uid**（需 mod 在 `freeEntityAreaBeforeBuild` 时回报，当前不回报）。
- **实机判据**：在远离工厂处先 `place_path` 一条 5 格带，再 `paste` 一条与之**重叠 2 格**的蓝图 → 读回旧带 uid：应观察到旧带被删、`ok:true`、`failed` **不含**这 2 格（因为它们成功 replace 了）。证明"覆盖不报告"。再 `snapshot_load` 恢复。

#### 缓解建议
- **编译器占用模型必须是三态的**，且：
  - 目标区任一"机器"格 → 直接 `ok:false, reason="落点压到既有机器"`，绝不 paste。
  - 目标区任一"带子"格 → 视为**破坏性**，需显式 `allowOverwriteBelts:true` 才 paste，并在结果回报被覆盖 uid。
  - `applied != 蓝图格数` **一律当失败**（不是部分成功），回滚整块。
- 落地协议（review F2 建议）：L2 输出**布局 IR**，由落地层决定"整块 paste / place_path / 增量对接"，paste 仅用于**全空新址**；对接旧厂走 place_path + 拐角最后放（M3/M4 模式）。

---

## #4 — 配方 DAG 总能空间实现

### 假设是什么
solver 给的 step 序列（逻辑 DAG）总能被编译器摆成 2D 蓝图。

### 哪里可能是错的（证据）
- **【源码确证】两条流不能互穿**：物流都在 `regular` 层，一格只能一个实体（`logic.js:61-104` 碰撞拒绝；wire 才在 `wires` 层可交叉）。两条形状流要在同一格相遇必须**隧道**（`underground_belt`），而隧道**未实机验证**且触发 #2 的 smartplace 删带坑。
- **【源码确证】机器方向约束让部分拓扑不可布**（GEOMETRY-TABLE 表3 / design 三铁律）：cutter/stacker/rotater/mixer **下进上出**（+y 流，`cutter.js`/`stacker.js` 等 acceptor bottom、ejector top），painter **左进形状、上进颜料、右出**（+x 流，`painter.js`）。两类**不能简单串一条线**。
- **【源码确证】stacker/mixer 只有 2 个 bottom 输入**（`stacker.js:67-81`），quad cutter 4 路输出（`buildings/cutter.js`）—— N>2 汇合必须先二叉化，每层要 M3 式"抬车道"。review 未证断言#4：**3+ 分支、quad 切割后 4 路汇合无可行模板，车道互不交叉从未论证**。
- **【实证】带子邻居含机器时 rv 非不动点**：`validate-belt-rules.mjs:136` C 项只有 **82.5%**，`src/ai/belt-rules.mjs` 头注 C 段自己写"漂移全在邻居含机器的角落"。**纯带-带闭合通过 ≠ 含机器布局能通过**。

### "可布性"必要检查清单（编译器必须在产蓝图前逐条跑，任一失败 → 上报/降级，绝不产出会堵死的蓝图）
1. **落点矩形全空**（含多格机器 `getTileSpaceBounds` 的**旋转后**包围盒——`static_map_entity.js:127-141` 在 rot=90/180/270 时 origin 会位移，不能 `origin+size` 直算）——与既有机器/带子零冲突（衔接 #3b 三态占用模型）。
2. **每根带子是邻居拓扑下的 computeBelt 不动点**：用 `computeBelt`（proto/validate 版）**喂进机器 ejector/acceptor**（不只是带子）逐格自检；非不动点 → 要么用蓝图显式 rv + orig 修正（#3a），要么判不可布。
3. **入度 ≤ 槽位数**：stacker/mixer=2 bottom，cutter=1 bottom，hub 四边 16 格（`hub.js:79-82`）；N>2 汇合先二叉化成树。
4. **交叉检测**：两条流需要穿过的格 → 需要隧道；v1 无隧道 → 报"此 DAG 当前不可布（需隧道/换址/换配方）"。
5. **方向异质性**：DAG 里同时有 +y 类与 painter(+x) 类相邻 → 强制插入旋转/绕行段，验证不交叉。
6. **颜料独立通道**：painter 的 color 从 top 进（GEOMETRY 规则6）→ 留一条垂直颜料 lane 且该 lane 本身可达（cyan 需 mixer，mixer 未实测）。
7. **吞吐可行性**：瓶颈 `min(节点速率)`（design §吞吐），stacker 0.25 → 需复制 N 行；站址宽度不够 → 报。
8. **多层形状（`:` 分隔）**：design/GEOMETRY 都标多层布局**完全未做** → v1 编译器应显式拒绝多层 DAG（`ok:false, reason="多层未支持"`）。

### 会怎么在实机翻车
编译器无脑产出一张"逻辑对但空间堵死"的蓝图 → paste 成功、`ok:true` → `await hub_delivered_increased` 超时 → 死厂；或 paste 与既有厂冲突 → #3b 毁带/半建。

### 检测
- 离线：上述 8 条即"Level 2 几何验证"（design §阶段C）的**升级清单**。特别 (2) 需要新写"含机器的 computeBelt 自检"（现有 validate 脚本只喂带子）。
- 实机：每条布局 paste 后 `obs` 读回每根带子 (r,rv)，与编译器**意图**逐格 diff（编译器自存意图表），不符即报"落盘 ≠ 设计"。

### 缓解建议
- 编译器返回值强制 `{ok:false, reason, failingNode, hint}`（design 已写此契约，但**可布性检查逻辑目前一份都没有**）——这是开工第一件要写的，不是事后补。
- v1 范围钉死：**单层、无隧道、无 wire、无多层、分支度≤2**；超出的 DAG → "换配方/换址"上报给 L3/LLM 层。

---

## #5 — 端到端已通（exp-e2e）

### 假设是什么
offline world model 能交付进 hub（exp-e2e met=true）。

### 哪里可能是错的（证据）
- **【源码确证】e2e 测的是 `place`/`place_path` 通道，不是 `paste`。** `exp-e2e.mjs:175-194` 全程 `place_path`/`place`（拐角最后放，`:189`），**无一处 paste_blueprint**。它验证的是"place 通道能交付 level-1"。
- **【源码确证】零拐角、零机器**。`planL` 找的是"正对 hub 侧口的 CuCuCuCu"→ 矿机→带→hub 直线 + 至多一个 L 拐角（`:106-131`），**没有任何 cutter/stacker/painter**。M4 有机器+拐角但**以 trash 收尾、且走 place_path**（`MILESTONE-M4-SUCCESS.md` + review C6：grep paste_blueprint=0）。
- ⇒ **"含机器 + 含拐角 + 多分支的真实产线，用 paste 一次性建好并交付进 hub"从未发生。** review 未证断言#2、#3 同此。

### 会怎么在实机翻车
paste 通道相对 place 通道的**独有机制**从未在交付场景跑过：`freeEntityAreaBeforeBuild` 在 immutable 内删/换、`charge:false` 扣费路径、`payload.gv` 版本闸（`bridge:1514`）、多格机器 paste 的 origin 位移。任何一个出问题，"编译器 → 蓝图 → 交付"整条线在**第一次真机实验**才暴露，且因为同时改了太多变量，**难定位**。

### 第一个真机实验该测什么（最省风险地暴露问题）
分**三级**，每级只引入一个新变量，全程远离工厂（INCIDENT 教训 2/3）+ `snapshot_save`：
1. **L1-paste**：离线合成"矿机→直带→hub 侧口"的**小蓝图**，`paste_blueprint` 落地（place 已证，paste 未证），`await hub_delivered_increased`。判据：**paste 通道能否复现 exp-e2e 的 delivered 增加**。这一条只换"place→paste"，最快证伪 paste 是否 e2e 等价。读回每根带子 (r,rv,code) 与蓝图意图逐格 diff。
2. **L2-paste-one-corner**：加**一个拐角**（非直线进 hub，从顶/底口改为需要先横移再进），仍单矿机、零加工机。判据：**拐角 rv 经 paste 落地后保持**（直接打 #3a/#1），step→交付。
3. **L3-paste-one-machine**：`miner→belt→cutter→2×belt→hub` 或 `2×miner→belt→stacker→hub`，**含一台加工机 + 含拐角 + 交付 hub**。判据：机器 acceptor 邻居下的带子 rv 是否落对（#4 检查2 的首次真机）、机器 paste 的 origin 位移是否对、交付是否升。

每一级失败都能唯一归因到"paste / 拐角 / 机器"三者之一。

### 缓解建议
- 路线图把"1.5 端到端"重述为**"place 通道 level-1 已通；paste 通道端到端未证"**（与 review 未证断言#3 一致），第一个编译器里程碑 = 上面 L1-paste。

---

## #6 — place 不查解锁（§4.5）

### 假设是什么
mod 能在 level 2 放 stacker；这对"AI 玩"影响需定位。

### 哪里可能是错的（证据）
- **【源码确证】tryPlaceBuilding 不查解锁**：`logic.js:117-133` 只走 `checkCanPlaceEntity`（`logic.js:61-104`：碰撞 + 编辑器 puzzle lock + `prePlacementCheck`），**无 `getIsUnlocked`**。`getIsUnlocked` 只存在于 MetaBuilding 与 UI 工具栏（`meta_building.js:184`，`grep` 确认 mod 全文不调用，只在错误提示里"建议你查查解锁"——`bridge:1104/:1120`）。
- **【源码确证】蓝图功能本身 L12 才解锁**（`levels.js:241` reward_blueprints，review F2），正常粘贴还消耗 `CbCbCbRb:CwCwCwCw`（`game_mode.js:195`）；我们靠 `charge:false`（`bridge:1499`）特权路径绕过。
- **【源码确证】solver 默认已用未解锁机器**：`proto/solver.mjs` 默认 `cutQuad` 开 → L11 目标可给用到 L16 的 quad cutter（review C13）。

### 这是 bug 还是特性 —— 两种定位的影响
- **定位 A：忠实模拟真玩家**。必须给 `place/place_path/paste` 前置 `meta.getIsUnlocked(root)` 门控；蓝图 ≤L11 禁用；吞吐受解锁曲线约束。后果：
  - 编译器需要**"当前等级可用机器集"**输入；目标形状若用未解锁机器才解得出 → 编译器要么换配方要么**失败**。
  - 把**游戏循环**（交付中间形状以升到 level 2+）拉进范围——这块**完全未做**（SYNTHESIS §5.2）。benchmark 变成"人类式玩家能否到 level N"，效度高、难度大。
  - solver 必须默认关 cutQuad/quad painter 等（review C13 的 `--unlock-level N`）。
- **定位 B：只要通关/最优吞吐（god-mode）**。解锁不查、`charge:false` 合理。后果：
  - 编译器是纯"形状→布局"变换，不碰 progression；benchmark = "到某形状的最小布局/最大吞吐"。
  - **代价**：任何"AI 通关 level N"的宣称**不可迁移到人类玩法**；现有数字（已用 cutQuad）**已经是 god-mode 分**，若不显式标注就是作弊分（review F2:80-84、未证断言#8）。

### 检测
无需上机——这是口径问题。检测动作 = **文档与 benchmark 规则里显式声明**当前用的是哪种定位；若 B，所有"通关"claim 加 god-mode 标注；若 A，`getIsUnlocked` 成为 mod 校验项 + solver 门控项。

### 缓解建议（开工前必须定的 blocking question）
见文末。

---

## verified_ok（攻击失败、假设站得住的）

- **#2 belt 半边**：immutable gate（`systems/belt.js:169`）确实在粘贴期屏蔽"邻居含**机器**"的 belt 重算 —— 与"邻居含带子"走同一 gate，源码层面等价，豁免同样生效。
- **#2 hub goal acceptor**：hub 的 16 个 acceptor 槽（`hub.js:79-82`）只作为 `getEjectorsAndAcceptorsAtTile` 的输入喂 belt 启发式，不产生 paste 会扰动的额外图边 —— 安全。
- **#1 src/ai 公式正确性**：`belt-rules.mjs:src` 的 `beltEntry/beltExit` 与游戏 `arrayBeltVariantToRotation` + `localDirectionToWorld`（`buildings/belt.js:12`、`systems/belt.js:366/396`、`static_map_entity.js:166`）**逐字同构**；`solveTurn` 对 12 组输入返回正确 (rot,rv)。数学没错，错的是"验证叙事"和并存的第二份文件。
- **#3a 一次性 paste-and-run**：immutable 覆盖整个粘贴循环，粘贴后无邻域扰动时带子停在显式 rv —— 此场景 orig 丢失被掩盖（推断）。

## needs_live_test（只能上机定论，附判据）

1. **orig 丢失对拐角的翻向**：远离工厂处 paste 一条含"被自动转向过的拐角"的蓝图，粘贴后 `place` 一格到拐角旁触发 `updateSurroundingBeltPlacement`，读回拐角 (r,rv) 是否变了（验 #3a-推断 + RV-FIX T3 的机器邻居版）。判据：拐角 code 若变 → orig 缺口在含机器布局中真实致命。
2. **含机器的 belt 不动点**：paste `2×miner→stacker→hub`，step→读回 stacker 两个输入带子及其上游的 (r,rv) 与蓝图意图逐格 diff。判据：任一带子落盘 rv≠设计 rv → 证实"纯带-带闭合"不足（#4 检查2），必须喂机器邻居跑 computeBelt。
3. **wire 无 immutable 保护**：paste 一段带拐角的 wire 蓝图，`step 0` 读 wire code，`step 1`（让 `updateSurroundingWirePlacement` 跑一帧）再读。判据：两次不一致 → 证实 `wire.js:714-760` 无 `!immutableOperationRunning`（#2-2）真会事后改 wire。
4. **paste 通道端到端 = place 通道？**：L1-paste（本文 #5 第1级）判据：`hub_delivered_increased` met==true 且离线预测矿格==实机矿格（复刻 exp-e2e 但换成 paste）。
5. **静默毁带不报告**：paste 与既有 5 格带重叠 2 格 → 读旧带 uid 消失、`ok:true`、`failed` 不含这 2 格（#3b）。`snapshot_load` 恢复。
6. **`BeltComponent.direction` 是否可读**：当前 `obs` 只回报 code/r/rotation_variant（`bridge:446-455`），不回报 direction。判据：需要 mod 端补一个字段，才能做 #1 的"语义"直读；否则只能用 code↔rv 映射间接读。

## blocking_questions（开工前必须定）

1. **【定位，#6】编译器/评估口径 = 忠实模拟玩家（A）还是 god-mode 通关（B）？** 这决定：要不要加 `getIsUnlocked` 门控、要不要把"交付升级"的游戏循环纳入范围、solver 是否默认关 cutQuad、所有"通关"claim 是否标 god-mode。当前既有产物（charge:false + cutQuad 默认开）**事实上已是 B**，但文档按"AI 玩"叙述 —— 二者冲突必须先定。
2. **【落地契约，#3/#4】L2 到底输出什么？** 只输出"全空新址的整块 paste"（简单，但 review F2 说它无法增量对接旧厂，与 §3.3 扩张目标矛盾），还是输出布局 IR 由落地层选 paste/place_path/增量？
3. **【SZBP1 格式，#3a】现在就把 stride 扩到 5 存 originalRotation，还是先写"不动点自检 + 失败上报"绕过？** 决定 #3a 是治本还是靠纪律。
4. **【可布性失败语义，#4】编译器遇到"不可布 DAG"时报错给谁、报什么？** L3/LLM 修复 vs 直接换配方 —— 决定 `{ok:false,reason,failingNode,hint}` 的字段设计。
5. **【v1 范围钉死，#2/#4】**：确认 v1 = 单层 / 无 wire / 无隧道 / 无多层 / 分支度≤2，且把超出项作为显式 `ok:false`，而不是"先都支持以后调试"。
