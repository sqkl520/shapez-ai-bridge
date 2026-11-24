# 回归审计 —— 最近 10 个提交的 6 个源文件，其它地方被改坏了什么

2026-11-24。审计员视角：**不复查改动本身对不对，只找它在别处造成的破坏。**

- 起点 `3967aa5`（HEAD 开工时），工作区在审计期间被另一个 agent 改动过（见文末「干扰」一节）。
- 全程离线，未碰游戏；未改 `src/`；临时脚本在 `.tmp-regress/`，报告落盘后删除。
- 未执行 `git stash / commit / push / checkout / reset`。

## 总判定

| # | 怀疑点 | 判定 |
|---|---|---|
| 1 | `slotRoleAt` 重写 + `[N]` 后缀 | **有问题（B1）**：`[N]` 是宏不接受的形态，47/47 被 `bad_type` 拒 |
| 2 | `health.mjs` 的 `items_on_belts` 条件化 | **有问题（B2、B3）**：「死掉那一轮」仍判 cleanup；且该事实从时间线整行消失 |
| 3 | `st.obsTickPrev` 时序 | **有问题（B4）**：取的是「verify 之后」而非「上一轮 observe」，等价于换了判据 |
| 4 | `diff.modified` 落盘 | **无问题**（量极小，且传递来源是对的） |

测试基线：`node --test src/agent/` = **800 tests / 754 pass / 42 fail**。
**注意：42 与交接的 28 不符** —— 差的 14 条全部来自工作区里**别人未提交的改动**
（`structural.test.mjs` / `reorient.test.mjs` / `world_frozen.test.mjs` 的新增断言），
不是这 6 个文件造成的。见文末「干扰」。

---

## 怀疑点 1：`slotRoleAt` 重写 —— `[N]` 后缀是一个宏必然拒绝的字符串

**核查方法**

```bash
node .tmp-regress/probe-all-templates.mjs     # 穷举 49 个 building/variant，比较两套 index 空间
node .tmp-regress/probe-nsuffix-consequence.mjs  # 把 desc 里的 [N] 原样抄进 port，看宏怎么答
node .tmp-regress/probe-desc-full.mjs         # 旧实现 vs 新实现，逐条对拍全部 desc
```

**结果 1.1：`[N]` 与宏的 `port` 形态不兼容**

`handles.mjs` 现在产出 `下游=H1.primary[12]` 这样的 desc。宏的 `port` 只接受三种形态
（`contract.mjs:122` `PORT_FORMS = ["auto", "role", "{role,index}", "{entry}"]`），
`validatePort` 对字符串的判据是 `/^[a-z][a-z0-9_]{0,31}$/`（`contract.mjs:700`）。
`"primary[12]"` 含 `[` `]` `1` `2`，**必被拒**。

实测（fixture 里全部 47 处 `[N]` 下游引用）：

```
fixture 里出现 [N] 的 belt 下游引用: 47
  原样抄成字符串 "role[N]" ⇒ bad_type: 47/47
  改写成 {role,index} ⇒ ok: 0, port_already_bound: 33, 其它: 14
```

逐条：

```
port="primary[12]"                 ⇒ bad_type: to.port 角色名必须是小写标识符
port="primary"                     ⇒ ambiguous_port: to.port="primary" 命中 16 个，需 {role,index}
port={"role":"primary","index":12} ⇒ 能被解析（本例撞 port_already_bound，说明形态对了）
```

**判定：有问题。**
`[N]` 携带的**信息**是对的（`N` 与宏的 `index` 同一空间，见 1.3），但**形态**是错的，
而 prompt 里没有任何一句说明它需要转写。这是本项目第八次「格式与参数格式不一致」——
`handles.mjs` 的 `角色@方位` 改 `role` 那次（`prompt.mjs:1177` 起的长注释）踩的是同一个坑，
当时写下的纪律是「名字不唯一时，模型必须能指名到具体哪一个」，
但这次只解决了「读得懂」，没有解决「写得出」。

**后果**：模型只要照 desc 抄一次端口，就白掉一轮。历史数据里 `bad_type` 曾经 4→0
被清零过（`prompt.mjs:4333`），这次改动会把它重新打开，且**触发点就在 L4/L9/L12 每一轮
的 BELTS 段里**（`[N]` 只在与 hub/mixer/quad-painter 相邻的带子上出现）。

**修法方向（不在本次职责内，仅记录）**：要么 desc 直接渲染成 `H1.primary#12` 并在
MACHINES 图例里说明「`#N` ⇒ 写 `{role:"primary",index:N}`」，要么干脆渲染成
`{role:"primary",index:12}` 字面量。

---

### 1.2 兜底「最近距离」是**不可达**的（不是问题，但要写下来）

**核查方法**

```bash
node .tmp-regress/probe-structural-fallback.mjs  # 49 模板 × 4 旋转 × 2 side × 每 dir 分组
node .tmp-regress/probe-hitkind.mjs              # fixture 上实际走哪条分支
node .tmp-regress/probe-cross-collision.mjs      # cell/slot 交叉撞
```

**结果**

```
(side,dir) 组总数: 168 其中同向多槽: 48
★ 同向多槽且 cell/slot 相撞（⇒ 会走兜底）的组合数: 0
交叉撞（传后者的 slot 会先命中前者）: 0
fixture 上的实际命中方式: cell 命中=0  slot 命中=108  需兜底=0
```

**判定：无问题。** 兜底分支在 168 个 (side,dir) 组合上结构性地不可达：
任何两个同向槽的 `cell` 与 `slot` 两两互不相等，所以传入的 `cell` 一定能被
`eq(sl.cell)` 或 `eq(sl.slot)` 命中。

**但「实际全走 slot 命中」这一点值得记一笔**：108 次多槽消歧里 **cell 命中 0 次**，
全都是靠 `sl.slot` 匹配的。也就是说调用方（`describeEntity:500/502`）传进来的 `cell`
在这条路径上永远是**机器本体格**，不是 approach 格 —— 与 `handles.mjs` 注释里
「带子的进料侧传的是带子自己那一格（在机器外侧，与 `sl.cell` 相同）」的描述**相反**。
注释写错了，但结论（不会选错）不受影响。

---

### 1.3 `[N]` 的下标空间与宏一致（无问题）

`handles.mjs:697` 用 `list.indexOf(picked)`（整个 list 的全局下标）。宏的 `port.index`
本该按「同一角色内编号」（`connect.mjs:355-371` 的 `seen` map），两者**名义上不同**。

```
painter/quad inputs color: handles 用 [1,2,3,4]  宏用 [0,1,2,3]   ← 不一致
mixer/default  inputs color: handles 用 [0,1]    宏用 [0,1]       ← 一致
hub/default    inputs primary: handles 用 [0..15] 宏用 [0..15]    ← 一致
```

**但 painter/quad 不在 v1 支持矩阵内**（`place.mjs` 的 `SUPPORTED_BUILDINGS` 只有
`painter: [default, mirrored, double]`），历史 570 个 run 的实体里 **0 台 painter/quad**。

**判定：无问题（当前）。** 这是一个**沉睡的不一致**：一旦 quad painter 进 v1 支持矩阵，
`下游=C?.color[1..4]` 就会整体偏 1。建议在 `slotRoleAt` 的注释里写明这条前提，
否则下一个人会以为两套编号是同源的。

---

## 怀疑点 2：`items_on_belts` 条件化 —— 「世界死掉那一轮」仍然判 cleanup

**核查方法**

```bash
node .tmp-regress/probe-died-round.mjs      # 五组受控对照
node .tmp-regress/probe-real-died.mjs       # 真实 run r-20261115121951-39ea 重放
node .tmp-regress/probe-dead-world-replay.mjs  # 520 个零产出快照重放
```

**结果 2.1：OR 判据使「刚死的那一轮」逃过修正**

`health.mjs:760` 写的是

```js
const producingNow = anyProducedIn(after) || anyProducedIn(before);
```

而它上方的注释写的是「用 `after` 主判、`before` 兜底，避免把**刚开始堵的那一轮**误判成改善」。
**OR 的实际行为与那句话相反**：

```
== 两边都产出，货量涨 50→62                      ⇒ cleanup ["带上的货 50→62"]
== ★ 世界这一轮死掉（before 有产出，after 零产出），货量涨 350→362
                                                  ⇒ cleanup ["带上的货 350→362"]
== 两边都零产出，货量涨 50→62                     ⇒ churn
== before 零产出、after 有产出，货量涨             ⇒ cleanup
== 两边 produced 都是 null（读不到），货量涨       ⇒ churn
```

第 2 例正是注释里点名修复的那条 `r-20261115121951-39ea` 形态 ——
「before 有产出、after 零产出」意味着**世界在这一轮里死了**，而货量上涨仍被算成改善。
用 `after` 主判（`anyProducedIn(after)` 而不是 `||`）才符合注释的意图。

**判定：有问题（B2）。** 修法只是把 `||` 换成只看 `after`，但要注意副作用：
「before 零产出、after 有产出」那一例（世界刚活过来）会从 cleanup 变成别的档 ——
那是对的，因为它本来就不该靠「货堆起来」当改善证据。

**后果**：本应被这次改动消灭的那一类假绿，在**世界死亡的那一刻**仍然存在。
而「世界死亡的那一刻」恰好是整个项目最想识别的一刻。

---

### 2.2 `produced === null` 与 `produced === {}` 被判成同一件事

```
produced={}（读到、确实零产出）           ⇒ items_on_belts sign="0"，净效果 inert
produced=null（production RPC 失败/超时） ⇒ items_on_belts sign="0"，净效果 inert   ← 完全相同
produced={Cu:5}（有产出）                ⇒ sign="+"
```

`health.mjs` 自己的 H3 / H21 钉死了「null 与 0 在 diff 里必须不同」这条纪律，
而 `anyProducedIn` 把 null 当 false，把两者合并了。

**实测影响面：小。** 570 个 run 里 `production-last.json` 缺失/无 `produced_total`
的只有 8 个，且**没有一个**同时带上有货（`probe-production-null.mjs`：`noProdButItems = 0`）；
`PRODUCTION_UNAVAILABLE` 在 579 个 transcript 里出现 **0 次**。

**判定：有问题但优先级低。** 它是对既有纪律的一次例外，且今天没有观测到触发。
但 `health.mjs` 是纯函数、会被预演路径调用（`loop.mjs:2560` 传 `items: null`），
一旦真机上 `production` 超时，就会静默降级成「零产出」并**抑制改善判定**。

---

### 2.3 时间线上这一整行会消失（B3，比 2.1 更隐蔽）

`formatDelta`（`health.mjs:925`）默认的 `keep` 判据是
`sign ∈ {+,-} || delta === null || NO_DIRECTION.has(metric)`。
`items_on_belts` 不在 `NO_DIRECTION`（`health.mjs:898`）里，所以一旦它的 `sign` 变成 `"0"`，
**整条事实从时间线消失**。

```
items 350→362，其余完全不变：
  healthDelta 行: [["shape",null],["items_on_belts","0"]]
  时间线一行 → "无变化"                              ← 事实消失
  净效果     → churn（原地打转） — …但规模、连通性、货量、目标全都没动
```

**而且判词是假的**：`churn` 的分支文字写「规模、连通性、**货量**、目标全都没动」，
而同一行的 delta 里货量明明涨了 12。

**量（历史 570 个 run 的 timeline.log）**

```
runs=570 零产出 run=520
delta 行总数=1339，其中零产出 run 的=1123
零产出 run 里含 items_on_belts 的行=742
其中「只有 items_on_belts（+redundancy）」⇒ 改后整行变「无变化」= 403
```

**判定：有问题（B3）。**
403 行历史记录在新代码下会印成「无变化」—— 这个数字本身不致命（历史是只读的），
致命的是一旦重跑，**读日志的人再也看不到货量在动**。
这正是本项目最高频的缺陷形态 `computed-but-never-delivered` 的新一次重演：
值算出来了、delta 产出了，被渲染层的过滤器吞掉。

**顺带一提**：`sign: "0"` 不是「无方向」，是「**这一轮故意不判方向**」。
`formatDelta` 里 `NO_DIRECTION` 这一档的语义是「规模类，没有方向」，
而 `items_on_belts` 的零产出情形是「有值、但方向被条件抑制」—— 两者不该共用一条规则。
最小修法：在 `classifyNetEffect` 的 churn 判词里不再声称「货量没动」，
并把 `items_on_belts` 加进 `NO_DIRECTION`（这样它总是打印，只是标记为 `·`）。

---

### 2.4 `stalled_growth` 触发率没有变化（无问题）

```
零产出快照: 521
加 3 条死带子 + 货量 +12：旧 {"stalled_growth":521} → 新 {"stalled_growth":521}
```

**判定：无问题。** 原因是这条路径上 `noFlowProgress` 通常已经由
`havePw ? !pathsMoved : !itemsMoved` 的 `pathsMoved` 分支决定，`itemsMoved` 只是兜底，
所以加条件不改变结果。交接里「触发率会变高吗」的担心不成立。

### 2.5 52 条 health 测试逐条核过（无问题）

`node --test src/agent/loop/health.test.mjs` = **52 tests / 52 pass / 0 fail**。
逐条查了夹具里的 `produced`：

- 用了 `base()` / `withObs()`（不带 production）的：H9/H10/H10b/H11/H12/H13/H14/H18/H19/H20/H21/H22/H24 等。
  它们的 `produced` 是 `null`，`anyProducedIn` 恒 false —— **但**这些测试判的是
  `belts_dead` / `reach_pct` / `delivered` 等**与 `items_on_belts` 无关**的项，
  或断言 `sign === null`（H21），不受影响。已逐条确认 H20 只断言 `belts_dead`。
- 用了 `snap()` 手写快照的：H28/H28b/H29/H29b/H29c/H29d/H30/H30b/H30c/H31…
  这些**没有 `produced` 字段**（→ `anyProducedIn` false），只有 H29b/H30c 被显式加了
  `produced`，H29d 显式给了 `{}`。H29/H30/H31 系列本来就期望「停滞/regressive」，
  零产出前提与它们一致，不会假绿。
- 交接里问「其余 49 条有没有夹具也没有 `produced`」：**有，但它们测的不是这个指标**，
  行为没有被悄悄改变。这一条**攻击失败**。

---

## 怀疑点 3：`st.obsTickPrev` —— 取到的是「verify 之后」的 tick

**核查方法**

```bash
node .tmp-regress/probe-obstickprev.mjs   # 按「上一轮有没有 apply」拆开 observe 间隔
node .tmp-regress/probe-frozen-miss.mjs   # 残差 < 10s 且本轮确为死世界的轮次
node .tmp-regress/probe-tickgap.mjs       # 2204 个 observe→observe 间隔
```

**结果 3.1：`st.lastObs` 有两个写入点，其中一个是 verify 之后**

```bash
$ grep -n "st.lastObs =" src/agent/loop.mjs
3597:  st.lastObs = ob.obs;        # 轮首 observe
3877:  st.lastObs = ro;            # 撤销后重读
5174:  st.lastObs = afterObs;      # ★ verify 之后
```

`obsTickPrev` 在轮首取旧值（`loop.mjs:3596`），而旧值可能来自 **5174 那一行**
（上一轮 verify 之后）。于是 `tickSincePrev` 量的是
**「上一轮 verify 结束 → 本轮 observe」的闲置间隔**，而不是
「上一次 observe → 这一次 observe」。

**这不是理论担心，量级很大。** verify 内部会 `step(2400)`（`loop.mjs:5184`，
`checkBehavior` 里还会再 extend 最多 2×2400）。按 120Hz 算，2400 tick = **20 游戏秒**，
而这 20 秒里 `productionAnalytics.update()` 每 tick 都在跑（`stepTicks` 的循环，
`shapez-ai-bridge.js:4140-4145`）—— 也就是说**统计窗口在 verify 期间必然已经轮转**。

```
上一轮**有** apply（= 跑过 verify step）: n=945
  间隔 p10 26.5  p25 29.8  median 36.1
  其中 <10s 的: 0 /945 (0.0%)
上一轮**没有** apply（= 没 step）: n=1259
  间隔 p10 6.5  p25 9.4  median 15.3
  其中 <10s 的: 365 /1259 (29.0%)
```

按 `-20s`（一次 2400 tick）估残差：

```
resid(=gap-20s) n=945  p10 6.5  median 16.1  p90 46.1
resid < 10（⇒ WORLD_FROZEN 判「窗口不 ready」⇒ 不报）: 245 /945 (25.9%)
```

**而这 245 个被跳过的轮次，100% 都是真实的死世界**（本轮诊断含 `NO_PRODUCTION` 或
`WORLD_FROZEN`）：

```
post-apply 轮次: 945
  残差(verify→observe) < 10s ⇒ WORLD_FROZEN 跳过: 245 (25.9%)
  其中本轮诊断含 NO_PRODUCTION / WORLD_FROZEN（真是死世界）: 245

样例:
  r-20261111193036-f92e  r2  gap=27.4 resid=7.4  MIXER_UNFED,NO_PRODUCTION,…
  r-20261112165043-0210  r3  gap=29.1 resid=9.1  MIXER_UNFED,PROCESSOR_REQUIRED,NO_PRODUCTION,…
  r-20261112165043-0210  r4  gap=22.8 resid=2.8  …
  r-20261112165043-0210  r5  gap=25.7 resid=5.7  …
  r-20261112165043-0210  r8  gap=28.8 resid=8.8  …
  r-20261112190707-de26  r2  gap=26.8 resid=6.8  …
```

**判定：有问题（B4）。**
`3967aa5` 的提交说明写「改成用 `tickSincePrev`（两次 `obs.tick` 相减）」，
但代码实际相减的是「上一次 **lastObs**（可能是 verify 后）」与「本次 observe」。
判据的**单位**对了（游戏秒），**事件**错了。
而且这个错误的方向恰好是**漏报**：残差比真实间隔小 20 秒，于是
「窗口够老」被判成「窗口还不够老」——在 945 个 post-apply 轮次里漏掉 245 个（25.9%），
而这 245 个**全部**是真正需要这条诊断的死世界。

讽刺的是：这 25.9% 的漏报率，与 `3967aa5` 声称要修掉的那个 25%（红队测的
「<10s 的轮次」）**数值接近、成因相反**。改前漏报是因为间隔真的短；
改后漏报是因为判据取错了事件，把一段**已经必然轮转过**的时间算成了「窗口不新鲜」。

**修法方向（不在本次职责内）**：`obsTickPrev` 应该单独记「上一次 **observe** 的 tick」，
不要复用 `st.lastObs`。或者更简单：在 5174 那一行旁边**不要**更新它想被当基准的那个变量。

---

### 3.2 首轮的两种初始化路径都返回 null（无问题）

`st.lastObs` 在 `loop.mjs:3142` 初始化成 `null`。
`(null && typeof null.tick === "number")` ⇒ `null`；即便有人把它改成 `{}`，
`typeof undefined !== "number"` ⇒ 仍是 `null`。
两条路径都落到 `obsTickPrev = null`，`Number.isFinite(null)` = false ⇒
`tickSincePrev` 为 `null` ⇒ `semantic.mjs:3621` 的 `dt === null` ⇒ 不判。
**判定：无问题。**

### 3.3 撤销路径（3877）也有同一个问题（同 B4 的一部分）

撤销后 `st.lastObs = ro`，那是一次**在撤销动作之后**的重读。下一轮的 `obsTickPrev`
会取它 —— 同样是「非 observe 事件」。这条路径更少见（只在 regressive 撤销时走），
但成因与 B4 完全一样。

---

## 怀疑点 4：`diff.modified` 落盘 —— 量极小，不撑 transcript

**核查方法**

```bash
node .tmp-regress/probe-tx-modified.mjs
```

**结果**

```
tx-last.json 总数: 358 有 diff: 358 diff.modified 非空: 33
modified 条数: n=358  min 0  p50 0  p90 0  p99 2  max 3

最大的几个 tx-last.json:
  r-20261118121720-7f46 bytes=13680 modified=0 added=79
  r-20261116003251-c82f bytes=13337 modified=0 added=116
  r-20261113141840-a195 bytes=10034 modified=1 added=44
```

`modified` 的最大值是 **3**，p99 = 2，`.slice(0, 20)` 的截断永远不会生效。
`modified_uids` 最多加 ~60 字节（3 个 5 位整数 + 括号逗号），
相对 359MB 总量与 13KB 的最大单文件可以忽略。

**判定：无问题。**

### 4.2 `canonicalEntityPayload` 的粒度（无问题）

`shapez-ai-bridge.js:3459-3476`：

```js
return JSON.stringify(sortValue({
    uid: payload.uid,
    code: payload.code ?? null,
    layer: payload.layer ?? null,
    components: payload.components || {},
}));
```

`components` 来自 `entity.serialize()`，即各组件的 `getSchema()` 字段。
**带子上的货不在其中**：`belt.js` 根本**没有 `getSchema`**（`grep -c getSchema belt.js` = 0），
`BeltPath.items` 也不在实体 schema 里（`shapez-ai-bridge.js:3937` 的
`non_serialized_state` 明写「items on belts may be lost」）。
所以「带子上有货了」**不会**产生 `modified`。

会进 `modified` 的是：`ItemEjector.slots[].item/progress`（`item_ejector.js:27-37` 的 schema
确实含这两个字段）、`ItemProcessor.inputCount`（只存 `nextOutputSlot`）、
`Filter.pendingItems*`、`UndergroundBelt.pendingItems`、`StaticMapEntity` 的 origin/rotation。
再叠上 `boundaries.time.tick_advance = 0`（359/359 全为 0，`probe-tx-modified.mjs`），
tx 期间世界不推进，所以**机器里的在途货不变**。

实测 33 个有 `modified` 的 tx，最大 3 —— 与「只改几何 + 少量 ejector 缓存」一致。
**判定：不构成噪音，`modified` 是个干净的信号。**

---

## 附：`desc` 的下游消费者穷举（怀疑点 1 的分支检查）

交接要求「`grep -rn "下游=" src/` 查所有解析点」。全仓扫一遍（含 `tools/`、`scripts/`）：

```bash
$ # 对每个 .desc 出现点检查是否含 match/exec/test/split/replace/RegExp
src/agent/loop/prompt.mjs:1027:  if (/已接=\d+\(/.test(hub.desc || "")) {
```

**只有这一个解析点**，且它匹配的是 hub 的 `已接=N(...)` 前缀，
与 belt 的 `下游=<机器>.<role>[N]` 完全不相交。已用 L4/L5/L9/L12 四份 fixture 验证
`／已接=\d+\(/` 仍命中（`probe-prompt-budget.mjs` 的兄弟脚本人工核过）。

其余 `desc` 使用点全是**透传**（`prompt.mjs:637/972/1014/1254/2337`），不做结构解析。
`semantic.mjs` / `topology.mjs` / `obsolete.mjs` / `memory.mjs` **完全不读 `desc`**
（它们各自从 obs 重算几何，这是对的）。

---

## 附：prompt 预算影响（怀疑点 1 的副作用量化）

`[N]` 与角色纠正会让 desc 变长：

```
half-L4-obs.json         desc 总字符 2001→2006 (+5)
L4-obs.json              8584→8603 (+19)
L5-obs.json              8663→8683 (+20)
L12-cheapest-obs.json    31101→31116 (+15)
level9-mixer-obs.json    31980→32021 (+41)
```

端到端 `buildPrompt` 实测：

```
L12-cheapest-obs.json: old 5874 → new 5880, Δ=+6 字符, 含 [N] 2 处
level9-mixer-obs.json: old 4894 → new 4897, Δ=+3 字符, 含 [N] 1 处
L5-obs.json:           old 4086 → new 4086, Δ=0
L4-obs.json:           old 4305 → new 4307, Δ=+2
```

**判定：可忽略。** 单轮最多 +6 字符；`## CAPACITY` 与 `## HUB stored` 没被挤掉
（这两段在 L12 上仍然出现）。

---

## 干扰：工作区在审计期间被另一个 agent 改动

开工时 HEAD = `3967aa5`，`git status` 干净。审计进行中工作区出现了**别人未提交的改动**：

```
 M src/agent/loop.mjs                   |  56 +++-
 M src/agent/loop/prompt.mjs            |  55 +++
 M src/agent/loop/semantic.mjs          | 108 ++++-
 M src/agent/loop/structural.mjs        | 293 +++++++++++
 M src/agent/loop/structural.test.mjs   | 178 +++++++++
 M src/agent/loop/verify.mjs            | 142 ++++++
 M src/agent/loop/world_frozen.test.mjs | 162 +++++++++
?? src/agent/loop/reorient.test.mjs
```

（mtime 2026-11-24 07:01 ~ 08:18，覆盖了本审计的时间窗。）

**这解释了测试数从 773 → 800、失败从 28 → 42**：
新增的 27 条测试里有 14 条红（`★ 反例：hint 里不许推荐任何动作`、
`★ 排序：它是警报，必须排在可行动的成因类诊断之后`、
`★ 句柄必须指向源头端`、`★ 截断时：…` 系列等），全部来自 `world_frozen.test.mjs`
与 `structural.test.mjs` 的新断言。

**交接给我的基线 28 是 `3967aa5` 的数。** 我在 `3967aa5` 干净状态下没能跑到 28
（第一次跑就已经是 29，第二次是 28，说明**基线本身有 1 条 flaky**，
在 `gates.test.mjs` 整体超时那次出现）。

对本报告的影响：**怀疑点 1~4 的结论全部基于 `git show` 里 `3967aa5` 的源码**，
不受工作区改动影响；但**测试计数**这一项无法给出干净的对照，
只能把两次读数都记下来：

```
run 1 (工作区已被改动): 773 tests / 740 pass / 29 fail
run 2 (同上):            773 tests / 740 pass / 28 fail   ← gates.test.mjs 整体超时是 flaky 项
run 3 (同上, 稍后):      800 tests / 754 pass / 42 fail
```

---

## 我试过但没攻破的路径（明确记录）

1. **「最近距离」兜底选错格** —— 结构上不可达。168 个 (side,dir) 组合 × 4 旋转 × 49 模板，
   `cell`/`slot` 交叉撞 **0**。`probe-structural-fallback.mjs` / `probe-cross-collision.mjs`。
2. **邻机差一格导致命中错机** —— `cellOf` 是「先到先得」，理论上重叠格会选错。
   实测 fixture 里只有 `level9-*` 有 1~2 个格被两台实体共用，且都是**非带子邻格**，
   `slotRoleAt` 对这些格返回 `null`（不是错值）。`probe-cellcollision.mjs`。
3. **`[N]` 让 prompt 撑爆预算** —— 单轮最多 +6 字符，`## CAPACITY` 仍在。`probe-e2e-prompt2.mjs`。
4. **`stalled_growth` 触发率上升** —— 521 个零产出快照重放，前后**完全一致**（521/521）。`probe-stalled-rate.mjs`。
5. **health.test.mjs 其余 49 条被悄悄改行为** —— 52/52 全绿；逐条查夹具，
   不带 `produced` 的那些测的都是别的指标。`probe-classify-replay.mjs`。
6. **`diff.modified` 撑大 transcript** —— 历史最大值 3，p99=2，截断永不生效。`probe-tx-modified.mjs`。
7. **`canonicalEntityPayload` 把「带上有货」算成 modified** —— `belt.js` 无 `getSchema`，
   `BeltPath.items` 不在 entity payload 里，且 tx 期间 `tick_advance=0`。**不成立。**
8. **`produced_total` 为空的世界其实是活的** —— 红队 §1.2 给过一个反例
   （同 world_hash 一个报 66、一个报 0），我试图在 520 个零产出 run 里找同类：
   时间线上出现过 `positive` 的 **0 个**。**攻击失败**，但红队的那个反例仍然成立，
   说明「`produced_total` 空 ⇔ 世界没产出」这个代理量在**特定窗口下**仍不可靠。
   这一点是 B2/B3 的**背景**，但不是它们的成因。

---

## 结论

**找到 4 个真问题**，按严重度排：

1. **B1（`[N]` 是宏拒收的形态）** —— 影响每一轮 prompt 里的 BELTS 段，
   47/47 原样抄会被 `bad_type` 拒；这是「read-only 改进」引入的 **write 侧回归**。
2. **B4（`obsTickPrev` 取错事件）** —— `WORLD_FROZEN` 在 945 个 post-apply 轮次里
   漏报 245 个（25.9%），而这 245 个**全部**是真正的死世界。
   修法只是「不要复用 `st.lastObs`」，但这正是 `3967aa5` 自己声称修掉的那类 bug。
3. **B3（时间线上 403 行事实消失 + churn 判词与事实相反）** ——
   `computed-but-never-delivered` 的新一次重演。
4. **B2（`anyProducedIn` 的 OR 让「刚死那一轮」逃过修正）** ——
   与代码注释声明的意图相反，修法是把 `||` 换成 `after` 单判。

**另有 2 个已知但当前不可达的隐患**（建议只加注释，不修）：
`painter/quad` 的两套 index 空间不一致（quad 不在 v1 矩阵内）；
`produced === null` 被当成零产出（当前无观测触发）。

**攻击失败**：怀疑点 4（`diff.modified`）完全无问题；怀疑点 2 里「其余 49 条 health 测试」
与「`stalled_growth` 触发率」两项也攻击失败。怀疑点 1 的「兜底选错」攻击失败。
