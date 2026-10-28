# 阶段 2 前置实测（主线程，2026-10-28）

不是设计，是**在真实 181 实体存档上跑现有宏得到的接口摩擦**。loop 的设计必须处理这些。

## F1. connect 在真实存档上撞的第一堵墙：`port_already_bound`

```
connect({from:{uid:10902,port:'right'}, to:{uid:10901,port:{role:'primary',index:N}}})
→ port_already_bound : from 的端口 right#0@5,-14（货流 top） 已经有带子接货
```

**这正是 L4 的真实形态**：cutter 右槽已经接了带子，但 `goal.delivered === 0`。
即「结构上看着连了，实际没通」。

对 loop 的含义：
- 单纯 `connect` 无法修复这类故障 —— 它不是"缺一条线"，是"线在但流向错/下游死"。
- 必须先 `remove_run` 再 `connect`，或直接用 `replace_run`。
- **loop 的 diagnose 必须能区分「没连」与「连了但流不动」**，否则它会对同一个故障无限重试 connect。

## F2. `trash` 的 4 个输入端同名，必须用 `{role,index}` 而非字符串

```
connect({..., to:{uid:trashUid, port:'left'}})   → bad_type : to.port="left" 不是合法角色
connect({..., to:{uid:trashUid, port:{role:'primary',index:0..3}}}) → 通过校验
```

trash 模板有 4 个 `role:"primary"` 的输入（四边全收）。`"left"` 是**面的名字**，不是角色名。
对 loop 的含义：LLM 不能自己编端口名；**端口选择必须由宏或检索层给出**。

## F3. `cutter` 的输出槽也必须点名（`ambiguous_port`）

```
connect({from:{uid:cutter}, to:{uid:trash}}) → ambiguous_port : to 有 4 个 acceptor，必须显式给 port
connect({from:{uid:cutter}, to:{...}})       → ambiguous_port（from 侧同理）
```

## F4. 真实存档里已经存在一台 cutter @ (-8,-11)，且目标是 Cu----Cu

ASCII 渲染（r/rotation_variant）：

```
y=-13  ..  ..  b02 b10 b10 b10 b10 b10 b12  ..  ..  b20 b00 b00 C00  ..
y=-12  ..  ..  b00 U00 ..  ..  ..  ..  b20  ..  ..  b20 b00 b00 b00  ..
y=-11  ..  ..  C00 ..  ..  ..  ..  ..  b20  ..  ..  b20 b00 b00 b00  ..
       -10 -9  -8  -7  -6  -5  -4  -3  -2  -1  0   1   2   3   4
```

两台 cutter，成对的 trash（-7,-15 与 (3,-14)），以及一条 r=90 的横向带（y=-13）。
**这不是一张白纸**——loop 面对的是改造，不是新建。

## F5. 离线可跑：`verifyRuntime` 的 reader 完全可注入

`verify_runtime.test.mjs` 已有 `mkReader(obs, items, prodBefore, prodAfter, steps)` 范式。
仓库里还有真实 dump 可直接当夹具：
- `.tmpverify/obs-live-baseline.json` — 181 实体，`truncated:false`，含 `goal`/`hub`/`stats`
- `.tmpverify/di-after-tx.json` — `debug_items`，`paths[20]`，每项 `{cells, itemsOnPath, spacingToFirstItem, boundAcceptor}`

⇒ **阶段 2 可以在无游戏实例的情况下跑通全链路**。实机只是最后一步。

## F6. 桥接当前不在线

`127.0.0.1:7777` connection refused（游戏未启动）。任何实机验收都要先起游戏 + 装 mod。

## F7. 真实存档的 `delivered:0` 根因（用游戏自己的 paths 追出来的）

`debug_items.paths` 20 条，关键几条：

```
#2  len 1  items 0   head/tail [-1,-3]        acc "yes"   ← 单格带，外推不出接收方
#3  len 4  items 0   head [-6,-3] tail [-3,-3] acc null   ← 断头
#13 len 4  items 0   head [5,-9]  tail [5,-12] acc null   ← **断头，且零物品**
#15 len 3  items 0   head [9,-11] tail [9,-13] acc null   ← 断头
#17 len 2  items 0   head [5,-14] tail [5,-15] acc "yes"
```

对照地面图：`(4,-13)` 是 cutter（C00），`(4,-14)` 是 trash（T00），`(5,-14)(5,-15)` 是带子。

**推断的故障链**：cutter 右槽在 `(5,-14)` 喷货 → 带子走到 `(5,-15)` → 断了，
而 trash 在 `(4,-14)`（cutter 正下方，收 cutter 的**左槽**或机身侧，收不到右槽）。
所以 cutter 右槽的货没有去处，右半形状堆在带上 → 左半 Cu-- 也没有意义（切割机两路必须都有去处才能持续运转）。

**这正是 loop 必须能自动诊断的形态**：
- 不是"少一条带子"
- 是"一条带子接错了地方（接到断头，而不是接到 trash/hub）"

⇒ diagnose 必须能从 `paths[].boundAcceptor === null` + `itemsOnPath === 0` + 端点坐标
推出"这条链是死端"，并定位到产生它的机器槽位。

## F8. `boundAcceptor` 有三种值：`null` / `"yes"` / `[x,y]`

`src/mod/shapez-ai-bridge.js:1017-1022`：只有当 `boundAcceptor.entity` 存在时才能给真坐标；
否则给字符串 `"yes"`。所以：
- `null` = 确定没有接收方
- `"yes"` = 有接收方但拿不到坐标（实体结构不同，例如 hub/机器）
- `[x,y]` = 有接收方且有坐标

**loop 不能把 `"yes"` 当成坐标用**，也不能把 `null` 与 `"yes"` 混为一谈（前者是死端，后者是通的）。
`verify_runtime.mjs:307 acceptorOf` 已正确处理这一点，loop 应复用它的判据而不是自己解析。

## F9. 「itemsOnPath」是诊断的关键信号，不只是展示

- `itemsOnPath > 0` + `boundAcceptor === null` ⇒ **货在路上堆着，但没去处**（最典型的堵死）
- `itemsOnPath === 0` + `boundAcceptor === null` ⇒ **这条链从来没进过货**（上游断，或压根没接矿机）
- `itemsOnPath > 0` + `boundAcceptor !== null` ⇒ 正常

这三种形态对应**三种完全不同的修复动作**。loop 的 diagnose 必须分开，不能都报"链路不通"。

## F10. `L3-flow` 不显式给 flows 时会假绿（实测，且是我自己踩到的）

`verify_runtime.mjs:692-709`：没给 `opts.flows` 时，L3 退化成「检查计划 placements 的 bbox（外扩 `flowPad=2`）内的断头路」。

实测：把 `replace_run({region:[2,-12,5,-11]})` 的计划落盘后，verify 全绿。但同一张存档里
`paths #13`（`[5,-9]..[5,-12]`，断头，零物品）距离这次改动**只有 3 格**，落在 pad=2 的 bbox 之外，
所以 L3 没看见它 —— 而它很可能就是 `delivered:0` 的真因。

**对 loop 的硬约束**：
- loop **不能**依赖 L3 的无 flows 模式做最终判定。必须要么显式给 flows（从 diagnose 推出的起点→终点），要么把 L3 判成「未验证」而不是「通过」。
- 更一般地：**`verifyRuntime` 绿 ≠ 关卡打通**。它只验「我声称干的事干成了」。关卡是否推进要看 L4 行为或 `goal.delivered` 的增量。
- loop 的成功判据必须是「goal 推进」，不能是 `verifyRuntime().ok`。这条要写进契约，否则 loop 会开开心心地做一堆局部正确、全局无用的改动。

## F11. `FakeGame` 已落地，离线全链路可跑（红→落盘→绿，实测）

新建 `src/agent/fake_game.mjs`，夹具在 `test/fixtures/saves/`（`L4-obs.json` 181 实体 / `L4-items.json` 20 条 path，都是真实 dump）。

实测序列：
```
replace_run({region:[2,-12,5,-11], building:["cutter",{kind:"trash",port:"left",confirm_waste:true}]})
 → plan.ok=true, 5 ops (3 delete + 2 place)
verify(pre-apply)  → ok=false  (L1 报 5 处不符，首处 [2,-11] want cutter got belt)
FakeGame.apply(ops) → {applied:5, added:[...], removed:[...]}
verify(post-apply) → ok=true
```

诚实边界（写在文件头）：`FakeGame.apply` **只模拟 tx 的效果，不模拟 tx 的原子性/回滚/读回自证**。
它能证明「loop 的决策链走通」，**不能**证明「宏在这张存档上真能落盘」。后者必须实机验。

## F12（可能改变阶段 2 的整个设计）：L4 正解只需**一个** replace_run

实测（L4 冷启动夹具 `test/fixtures/saves/L4-obs.json`，goal=`RuRu----`）：

```js
replace_run({ region: [4,-14, 5,-13],
              building: ["cutter", {kind:"trash", port:"left", confirm_waste:true}] },
            { entities: l4.entities })
→ ok, cells_planned=6
   removes: 10143@(4,-14) / 10209@(4,-13) / 10149@(5,-13)   ← 正好是"删 3 带"
   placed:  cutter@(4,-13) rot=0 / trash@(4,-14) rot=0
   warnings: kept-belts, cut-upstream-feeds, consumed-by-machine, trash-cuts-chain
```

**这意味着什么（非常重要）**：

1. 阶段 2 的判据「L4 五 op 用 ≤5 个宏调用重写」——**实测只需 1 个**。
2. 不需要 `connect`（那个在真实存档上 0/160 的宏）。
3. 不需要人算坐标：`region` 是 bbox，机器落点由宏内部解；这正是 `connect` 等宏做不到的。
4. 不需要多轮：一轮 replace_run 就是完整正解。

**所以阶段 2 的 loop 应当围绕 `replace_run` 设计，而不是围绕 `connect`。**
`replace_run` 才是唯一具备「给定一个区域，自己解出该放什么、放哪、朝向哪」能力的宏。

**但这里有一个必须先回答的问题**：`region: [4,-14, 5,-13]` 这个 bbox 是怎么来的？
- 如果是人算的 → 「没人算坐标」这条判据没通过，整个实验无意义。
- 必须来自 `$bbox_of` 句柄组 → LLM 要能说出"这 3 条带子 + 那个 trash"，然后由 loop 算出 bbox。

**这正是 `$bbox_of` 算子的价值所在**，也说明 Q2 的设计方向是对的。但契约要补一条：
`$bbox_of` 算出的 bbox 必须**恰好**是 `replace_run` 想要的 region（含机器 footprint 与废料槽喷口格），
否则宏会报 `precondition_failed`。这一点必须实测验证，不能假设。

**下一步必须做的事**：构造一次**真正的冷启动**——LLM（mock）只看句柄表，输出
`replace_run(region: $bbox_of([B1,B2,B3]), building: ["cutter", {kind:"trash",port:"left",confirm_waste:true}])`，
loop 把它解析成具体的 region，宏跑通，tx 落盘，verify 通过，goal 推进。
**这条链路跑通之前，阶段 2 不能声称达成。**
