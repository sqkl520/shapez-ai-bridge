# 红队：`node --test src/agent/` 的 28 个失败里，有几个是真 bug？

日期：2026-11-25
范围：`src/agent/`（784 tests / 28 fail / 4 skipped，HEAD = `185d06b`）
硬约束遵守情况：没碰游戏、没改 `src/`、没 `git stash/commit/push/checkout/reset`、
临时脚本全在 `.tmp-28/`（跑完删）。

---

## 0. 一句话结论

**28 个失败里，27 个是同一个真 bug（handle 编号不稳定）造成的「跨轮对象错位」，
另有 1 个（`T4 冷启动的完整输出可复现`）是它的纯字符串投影。
也就是说：28 个全部是真实信号的同一根因，但这个根因不在 `src/agent/loop/*.test.mjs`
里，而在 `src/agent/loop/handles.mjs`——修它会让 27 条转绿。**

但结论还要更细：

| 性质 | 条数 | 该改哪 |
|---|---|---|
| `real-bug`（代码错了） | **6** | `src/agent/loop/handles.mjs` |
| `stale-fixture`（夹具里的「旧句柄名」是过期引用） | **22** | 测试里的句柄字面量 |
| `stale-expectation` | 0 | — |
| `flaky` | 0 | — |

**这 28 个失败没有一个是「测试跑不过就改测试」**：
- 它们**全部**在把 `handles.mjs` 回退到重编号之前那一版（`65ba014^`）后转绿（实测 784 个测试 774 pass / 6 fail，
  剩下 6 个是 renumbering 之后才写的测试，见 §6）。
- 它们在 HEAD 上全红，**唯一变化的相关文件**是 `handles.mjs`（`65ba014`，2026-11-20）。

★ 所以「28 个基线」这个说法背后确实藏着一个**正在污染真机的真 bug**，
不是「夹具旧了」，而是「夹具里的句柄名按旧编号写死，而编号规则被换了」。

---

## 1. 判据方法（怎么证明的）

我做了两个**互逆**的实验，都在 `.tmp-28/` 的 `src/` 副本里跑，没动真仓库：

### 实验 A —— 只回退 `handles.mjs`（其余 HEAD 原样）

```
cp -r src .tmp-28/oldnum/src
git show 65ba014^:src/agent/loop/handles.mjs > .tmp-28/oldnum/src/agent/loop/handles.mjs
cd .tmp-28/oldnum && node --test src/agent/
```

结果：**784 tests / 774 pass / 6 fail**（原始 HEAD 是 28 fail）。
28 个里 **27 个转绿**。剩下 6 个见 §6 末尾（都是 renumbering 之后新写的、依赖新编号的测试）。

### 实验 B —— 换一套**真正稳定**的编号（uid 充当编号）

```
# .tmp-28/stable/src/agent/loop/handles.mjs
const handle = `${p}${e.uid}`;       # 原来是 `${p}${counts[p]}`（按名次递增）
HANDLE_RE: /^[A-Z]{1,2}[0-9]{1,6}$/  # 原来是 {1,3} 位
cd .tmp-28/stable && node --test src/agent/loop/rollback.e2e.test.mjs
```
结果：`rollback.e2e.test.mjs` **11/11 全绿**（HEAD 上 5 红）。

### 两侧一致 ⇒ 判决

28 个失败的**唯一共同自变量**是 `handles.mjs` 的编号规则。

---

## 2. 根因（真 bug）：`handles.mjs` 说「按 uid 稳定编号」，实际是「按名次递增编号」

### 2.1 代码事实

`src/agent/loop/handles.mjs:66-68`

```js
function cmpEntity(a, b) {
    return a.uid - b.uid;       // 排序：按 uid，正确
}
```

`src/agent/loop/handles.mjs:180-181`

```js
counts[p] = (counts[p] || 0) + 1;
const handle = `${p}${counts[p]}`;     // ★ 编号：按「第几个」递增，不是按 uid
```

排序是对的，**编号用的是名次**。于是只要世界里少一个实体，
它后面所有同前缀实体的名次 −1 ⇒ **句柄整体平移**。

这正是 `65ba014` 那条提交**声称要修掉**的那个 bug —— 它把排序从 `(y,x)` 改成了 `uid`，
但编号仍然是 rank。改完之后**同类实体之间仍会整体平移**，只是原因从「按位置排」变成了「按名次排」。

### 2.2 实测（HEAD 上）

```
$ node .tmp-28/p15.mjs
BEFORE:  B2=10003 B3=10004 B4=10005 B5=10006 ...
AFTER 删 2 条带子(uid 10003,10019):
         B2=10004 B3=10005 B4=10006 B5=10007 ...
handles B1..B161 whose uid CHANGED after deleting 2 belts: 160 / 161
entities keeping their handle name: 19 / 181
```

```
$ node .tmp-28/p16.mjs     # 删 3 条带子
surviving entities: 178; whose handle name now points elsewhere: 159 (89.3%)
  B10:  uid 10020 -> 10022  **DRIFTED**
  B50:  uid 10068 -> 10071  **DRIFTED**
  B100: uid 10135 -> 10138  **DRIFTED**
  B150: uid 10199 -> 10204  **DRIFTED**
```

**删 3 条带子 ⇒ 89% 的句柄名换了个实体。** 而 `buildHandles` 每轮都重建
（`loop.mjs:3593`、`loop.mjs:3873`、`loop.mjs:5170`）。

### 2.3 这个 bug 直接进到了模型眼前（生产后果）

`prompt.mjs:3213` 的 `reoriented belts` 段用**上一轮的句柄表**渲染，
喂给**下一轮**的 prompt。用 HEAD 代码实测（`.tmp-28/p39.mjs`）：

```
reoriented item: uid 10144 , LAST ROUND 渲染的 handle = B106
同一 uid 在下一轮 BELTS 表里的 handle = B105
```

也就是说**同一个 prompt 里，同一个实体被叫两个名字**：

```
## LAST ROUND
reoriented belts ...
  · B106: in bottom→bottom, out top→right      ← 旧表
...
## BELTS
B105 belt 上游=B156.out 下游=L4.primary ...     ← 新表
```

模型被告知「B106 被游戏改了朝向」，然后它去 BELTS 里找 B106 —— 那是**另一条带子**。
这正是 `65ba014` 提交信息里写的那个事故：「模型上一轮记住 B106，下一轮 B106 已经是另一条带子，
而它继续修 B106 —— 改的是完全不同的东西」。**那个事故没有被修掉，只是换了个触发条件。**

跨轮更明显（`.tmp-28/p27.mjs`，live 模式删 3 次低 uid 带子）：

```
prompt 1: B106 belt 上游=B105.out 下游=L4.primary    ← 喂 balancer 的那条
prompt 2: B105 belt 上游=B104.out 下游=L4.primary    ← 同一条，改名了
prompt 3: B104 belt 上游=B103.out 下游=L4.primary    ← 又改名
```

### 2.4 守卫测试为什么没拦住

`handles.test.mjs:131` 有一条「跨轮稳定性」测试，HEAD 上是绿的（实测）：

```
$ node src/agent/loop/handles.test.mjs
✓ 加一条新带子后，已有实体的句柄必须不变（实得 0 个移位：）
```

它**只加了**一条新带子（`uid 999001`）。加法让排序位置往后挪，名次不变 ⇒ 恒真。
**它没有覆盖「删一个」，而删除才是这个 bug 的触发条件。**
（这个项目记忆里那条「算出来 ≠ 送到」的同族缺陷：测试覆盖了加法，漏了减法。）

### 2.5 应该怎么办

改代码（`src/agent/loop/handles.mjs`），三选一：

1. **编号直接用 uid**：`const handle = `${p}${e.uid}``。
   最小改动、绝对稳定；代价是名字变长（`B10003`）且与日志里的历史命名不连续。
2. **按「该 uid 在同前缀里的名次」但用一张**持久化**映射**：需要跨轮状态，改动大。
3. 保持 uid 名次，但**把测试与夹具里的字面句柄名全部改成按坐标查**（`65ba014` 的提交信息说它这么做了，
   实际只改了 8 个文件，剩下 7 个测试文件里的字面量没改 —— 见 §3）。

并**补一条守卫**：`handles.test.mjs` 的稳定性测试必须同时覆盖「删一条」和「加一条」。

复现命令：
```
node .tmp-28/p15.mjs     # 删 2 条 ⇒ 160/161 个句柄换了 uid
node .tmp-28/p27.mjs     # 三轮 prompt 里同一条带子叫三个名字
node .tmp-28/p39.mjs     # 同一 prompt 内 LAST ROUND 与 BELTS 对同一 uid 用两个名字
```
后果：模型跨轮指错对象；`reoriented` 反馈失效；`## LAST ROUND` 与 `## BELTS` 自相矛盾。
**不改的代价**：`65ba014` 想修的事故继续发生，只是现在连测试也一起红了，没人再信这条信号。

---

## 3. 逐条：28 个失败

先给「旧名 → 新名」映射（L4 夹具，由 `65ba014^` 与 HEAD 两张表对拍得出，`.tmp-28/p3.mjs` 等）：

| 测试里写的 | uid | 坐标 | HEAD 上的真名 |
|---|---|---|---|
| B2 | 10184 | (2,-34) | **B144** |
| B34（half 夹具） | 10538 | (1,-6) | **B27** |
| B69 | 10143 | (4,-14) | **B105** |
| B81 | 10209 | (4,-13) | **B156** |
| B82 | 10149 | (5,-13) | **B111** |
| B83 | 10193 | (9,-13) | **B148** |
| B85（隧道 sender） | 10077 | (-7,-12) | **B59** |
| B129 | 10008 | (-10,-3) | **B7** |
| B130 | 10024 | (-9,-3) | **B14** |
| B131 | 10027 | (-6,-3) | **B15** |
| B134 | 10030 | (-3,-3) | **B18** |
| B136 | 10032 | (-1,-3) | **B19** |
| M4 | 10082 | (5,-8) | **M8** |
| M8 | 10034 | (-7,5) | **M4** |
| C1（cutter#10902，L5） | 10902 | (4,-13) | **C2** |

---

### X3 ★ 即使 outcome=halt（预算耗尽）也写记忆

- **文件**：`src/agent/loop/memory.e2e.test.mjs:102`
- **失败原因**：`mem.goals` 为空 ⇒ `Object.keys(mem.goals).length > 0` 假。
- **分类**：`stale-fixture`
- **判据**：`.tmp-28/p7.mjs` 打印实际落盘的 `attempts.json`：
  ```json
  {"version":2,"goals":{},"worlds":{"fixture:L4-obs.json":{...}}}
  ```
  `goals` 空是因为**这一轮没有产生任何净效果**——测试的 `L4_CALL` 用的是
  `$bbox_of:["B81","B82","B69"]`，在新编号下这三个名字指向不相邻的三条带子，
  `replace_run` 报 `not_a_run`（`{…,"skip":[{"macro":"replace_run","reason":"macro_failed","code":"not_a_run"}]}`），
  整轮 0 op ⇒ 没有 netEffect ⇒ 记忆里没有可记的东西。
  换成新名 `["B156","B111","B105"]` 后同一份代码写出：
  ```json
  "goals":{"RuRu----":[{"macros":["replace_run"],"kind":"regressive",...}]}
  ```
  （`.tmp-28/p11.mjs`）
- **为什么当前代码是对的**：记忆只记「这一轮改变了世界」的东西（`buildMemory` 里
  `const macros = rc ? rc.macros : []; if (!macros.length) continue;`，`memory.mjs:248-249`）。
  一轮 0 op 没有经验可记，空是对的。**代码没错，是夹具的调用被拒了。**
- **应该怎么办**：改夹具（把 `$bbox_of` 换成 `["B156","B111","B105"]`，或更稳：按坐标查句柄）。

---

### X4 记忆里带 goal 分组、宏名、kind（不是空壳）

- **文件**：`memory.e2e.test.mjs:114`
- **失败原因**：`mem.goals["RuRu----"]` 为 `[]`。
- **分类**：`stale-fixture`（与 X3 同根因，同一份 `L4_CALL`）
- **判据**：`.tmp-28/p7.mjs` 输出 `"goals":{}`；`.tmp-28/p11.mjs` 换上正确句柄后
  `"goals":{"RuRu----":[{...macros:["replace_run"], kind:"regressive"...}]}`。
- **为什么当前代码是对的**：同 X3。
- **应该怎么办**：改夹具（同 X3）。

---

### X5 ★ 第二次 run 的 prompt 里出现 `## PRIOR ATTEMPTS`

- **文件**：`memory.e2e.test.mjs:132`
- **失败原因**：前提断言「至少 1 条记录」先红（`mem.goals["RuRu----"]` 空）。
- **分类**：`stale-fixture`
- **判据**：同 X3/X4。这一条自己写着「前提：至少要有 1 条记录」——
  它就是**设计成**在前提不成立时炸，而不是让后面变成假绿。夹具修好即成。
- **为什么当前代码是对的**：`renderPriorAttempts` 只在有记录时渲染（`prompt.mjs`），
  空 history 不渲染是正确行为。
- **应该怎么办**：改夹具（同 X3）。

---

### P0 夹具前提：FAIL_M1 失败、OK_BELT 可撤销成功、OK_CUTTER 不可撤销成功

- **文件**：`src/agent/loop/partial_apply.test.mjs:81`
- **失败原因**：`OK_BELT 应当成功，实际 MACRO_REFUSED`。
- **分类**：`stale-fixture`
- **判据**：
  ```
  $ node .tmp-28/p24.mjs
  old B83 = uid 10193 = new B148   @(9,-13)  下游=无
  new B83 = uid 10113 @(3,-29)    ← 已接 B84
  connect B83->H1: ok=false port_already_bound
  connect B148->H1: ok=true
  ```
  `OK_BELT` 的字面注释写着「把 **B83** 接进 hub」，`65ba014` 之前 B83 = uid 10193 @(9,-13)，
  出口为空（`下游=无`）⇒ 可接。HEAD 上 `B83` 指向 (3,-29) 的一条**下游已经接着 B84** 的带子
  ⇒ `port_already_bound` 是**正确**拒绝。
- **为什么当前代码是对的**：`connect` 拒绝抢已占用端口是本项目的核心保护
  （见 `P0` 自己引用的 `FAIL_M1` 断言语义）。
- **应该怎么办**：改夹具（`OK_BELT` 用 `B148`；`OK_CUTTER`/`OK_TRASH` 的 `at` 也用 `B148`）。

---

### P3 ★ `partial:true`：失败的跳过，可撤销的仍被提交

- **文件**：`partial_apply.test.mjs:114`
- **失败原因**：`实际 NO_REVERSIBLE_CALL`（因为 `OK_BELT` 失败了，没有可撤销调用）。
- **分类**：`stale-fixture`
- **判据**：P0 的直接下游。`.tmp-28/p24.mjs` 证明 `B83` 现在指向已占端口；`B148` 成功。
- **为什么当前代码是对的**：`partial` 找不到可撤销调用时返回 `NO_REVERSIBLE_CALL` 是设计语义
  （P4/P7 就在钉这条）。
- **应该怎么办**：改夹具（随 P0）。

---

### P6 全部可撤销且全部成功时，partial 应为 false

- **文件**：`partial_apply.test.mjs:200`
- **失败原因**：`assert.equal(p.ok, true)` 红（`OK_BELT` 失败）。
- **分类**：`stale-fixture`
- **判据**：同 P0/P3。
- **为什么当前代码是对的**：无跳过时 `partial:false` 的语义由 `ed7582b` 钉住，测试本身没意见，
  是输入被拒了。
- **应该怎么办**：改夹具。

---

### S3 ★ 预演判据必须看**损失规模**，不能看调用类型

- **文件**：`partial_apply.test.mjs:390`
- **失败原因**：`★ B2 上放 cutter 会切断整条链（-68），必须被预演拦下` —— 实际 `ok=true`。
- **分类**：`stale-fixture`
- **判据**（`.tmp-28/p6.mjs`）：
  ```
  $ node .tmp-28/p6.mjs
  BEFORE reach 140 dead 23
  insert cutter at B2      (HEAD 的 B2 = uid 10003 @(-10,2)):
      AFTER reach 140 dead 21  loss=0 deadGrowth=-2   ⇒ 放行
  insert cutter at B144    (old B2 = uid 10184 @(2,-34)):
      rejected: 预演：死带子 23 → 90（+67），到 hub 的带子 140 → 72
      evidence {stage:"simulate", dead_growth:67, lost_reach:68, loss:68}
  ```
  测试的注释写着「`B2` 在链中段」，`65ba014^` 的 `B2` 是 uid 10184 @(2,-34)；HEAD 的 `B2`
  是 uid 10003 @(-10,2)，而那条带子**在操作前后都是死的**（`dead` 23→21，还少了 2）。
  **闸门在正确的落点上仍然 −68 拦下来，一个数字都没变。**
- **为什么当前代码是对的**：预演闸门在正确落点上精确复现了测试期望的 `-68`；
  在错误落点上放行也是对的（那儿没有产能可损失）。
- **应该怎么办**：改夹具（`B144`）。

---

### S4 ★ 预演必须也拦「白铺」：死带子净增 ≥20 格

- **文件**：`partial_apply.test.mjs:464`
- **失败原因**：`必须被预演拦下` —— 实际 `ok=true`。
- **分类**：`stale-fixture`
- **判据**：同 S3，同一份 `B2` 夹具。`B144` 上 `dead_growth=67`，`evidence.dead_growth` 有值、
  `observed` 含「死带子」——测试要的三条全满足（`.tmp-28/p6.mjs`）。
- **为什么当前代码是对的**：S4 的判据（`deadGrowth >= 20 && !landsOnMachine`，`loop.mjs:2715`）
  在正确落点上**照常触发**。
- **应该怎么办**：改夹具（`B144`）。

---

### S7 ★ 纯删除造成的死带子增长 ⇒ hint 不许说「白铺了」

- **文件**：`partial_apply.test.mjs:573`
- **失败原因**：`这条夹具必须被预演拦下，否则测不到措辞` —— 实际 `ok=true`。
- **分类**：`stale-fixture`
- **判据**（`.tmp-28/p6.mjs`）：
  ```
  remove_run B144 (old B2):  rejected
    evidence {stage:"simulate", dead_growth:67, pure_removal:true, lost_reach:68, loss:68}
  remove_run B2   (new B2):  ok=true   (deadGrowth=-1，什么都没破坏)
  ```
  `pure_removal:true` 正是这条测试要的前提。
- **为什么当前代码是对的**：`isPureRemoval` 分流（`loop.mjs:2733`）是 2026-11-19 修的真缺陷，
  在正确落点上照常生效。
- **应该怎么办**：改夹具（`B144`）。

---

### S8a ★ 删颜料入口带：deliverableLoss 必须算得出来且为 0（不是 null）

- **文件**：`partial_apply.test.mjs:656`
- **失败原因**：`实得 NO_REVERSIBLE_CALL`，原因 `remove_run:run_not_contiguous`。
- **分类**：`stale-fixture`
- **判据**（`.tmp-28/p28.mjs` / `p29.mjs`）：
  ```
  HEAD:  B1..B26 是「按 uid 升序」挑的前 26 条，包含形状链的 B2
         ⇒ 选集被分成两段 ⇒ run_not_contiguous（宏正确拒绝）
  OLD :  B1..B26 恰好是那条 26 格的竖直颜料链（uid 124,123,...,100,2）
  ```
  这是夹具注释自己写的风险：「这个编号来自 buildHandles 的实际输出，不是假设」——
  它当时是对的，`65ba014` 之后就不再是了。
  按 uid 重新取那 26 条（`p29.mjs`）：
  ```
  S8a (correct paint uids): ok=true          ← deliverableLoss=0，放行，正确
  ```
- **为什么当前代码是对的**：`deliverableLoss` 的类型口径（`loop.mjs:2592-2612`）在正确的选集上
  算出 0 并放行 —— 这正是这条测试存在的目的（它守的是前三版把 `deliverableLoss` 恒取
  `null` 的死代码）。现在它真的在工作。
- **应该怎么办**：改夹具（别用 `B(p+1)` 生成名字，改成「按 uid 取那条链的句柄」）。

---

### S8b ★ 删运形状的带子：损失必须被算出来（>0），不能是 null

- **文件**：`partial_apply.test.mjs:671`
- **失败原因**：`assert.equal(r.ok, true)` 红 —— 实际 `PLAN_REJECTED`。
- **分类**：`stale-fixture`
- **判据**（`.tmp-28/p28.mjs`）：
  ```
  HEAD: remove B2 (= 形状链末端 uid 3) ⇒ 预演 死带子 0→25，到 hub 52→26 ⇒ 拦
  OLD : remove B2 (= 颜料链中段 uid 123) ⇒ 损失 1 < 20 ⇒ 放行
  ```
  测试注释写着「小夹具里单删一条只损失 1」——那是**旧 B2（颜料链）**。HEAD 的 `B2`
  是形状链的 hub 入口带，删它损失 25，被正确拦下。
- **为什么当前代码是对的**：删形状入口带确实该拦；测试自己的注释说这条只测「算不算得出来」，
  不测「拦不拦」，但 `ok=true` 的断言编码了那个前提。
- **应该怎么办**：改夹具（用颜料链的任一格，例如按 uid 取 uid=123 那条）。

---

### 0. 夹具：B34 在句柄表里、是带子、且**不**在无诊断时的 12 条里

- **文件**：`src/agent/loop/prompt_belt_visibility.test.mjs:121`
- **失败原因**：`★ B34 不在无诊断的列表里` ——实际它在（12 条里第 8 位）。
- **分类**：`stale-fixture`
- **判据**（`.tmp-28/p22.mjs` / `p41.mjs`，夹具 `half-L4-obs.json`）：
  ```
  OLD: B34 = uid 10538 @(1,-6)   —— 断头带子，**不在**走廊 12 条里
  NEW: B34 = uid 10548 @(4,-18)  —— 走廊里第 8 位
       uid 10538 现在叫 B27
  ```
  用 `B27` 重跑这条测试的全部断言（`p41.mjs`）：
  ```
  noDiag 12 条, old-B34(B27) present? false       ← 前提成立
  with diag B27: 13 条, includes B27? true        ← 正例成立（追加不是替换）
  ```
- **为什么当前代码是对的**：`pickBeltsForGoal` 的走廊选择是按几何/分量算的，
  与句柄名无关；B34 换了对象是编号的事，不是选择逻辑的事。
- **应该怎么办**：改夹具（`B34` → `B27`；或按 uid 10538 反查）。

---

### A2. 正例：B34 出现时**追加**在 cap 之外

- **文件**：`prompt_belt_visibility.test.mjs:149`
- **失败原因**：`12 !== 13`（总数没增加，因为 B34 本来就在走廊里）。
- **分类**：`stale-fixture`
- **判据**：同 §0 —— 前提（B34 不在走廊）不成立，所以「追加」测不出来。
  `p41.mjs` 用 `B27` 得 13 条，断言成立。
- **为什么当前代码是对的**：`pushExtra` 溢出机制本身没变（A/B/C/D 六条测试里只红了这一组的两条）。
- **应该怎么办**：改夹具（`B27`）。

---

### E. 回归：L4 目标走廊的正解三条仍然可见（保底不能把它们挤光）

- **文件**：`prompt_belt_visibility.test.mjs:269`
- **失败原因**：`0 !== 3` ——三条正解一条都看不见。
- **分类**：`stale-fixture`
- **判据**（`.tmp-28/p23.mjs`）：
  ```
  走廊 12 条: B106,B105,B156,B155,B154,B104,B103,B113,B112,B111,B110,B109
  测试写的 TARGETS ["B69","B81","B82"] 在走廊里: []
  真实 TARGETS ["B156","B111","B105"]  在走廊里: ["B156","B111","B105"]
  ```
  测试自己的注释写着 `uid 10143/10209/10149` —— 那三条**确实**都在走廊里，
  只是名字变成了 B105/B156/B111。
- **为什么当前代码是对的**：走廊仍然是 12 条、仍然含那三条 uid，`pickBeltsForGoal` 没退化。
- **应该怎么办**：改夹具（用 uid 或新名）。

---

### E2. 对照：若点名**不**能溢出 cap，B34 就必须看不见

- **文件**：`prompt_belt_visibility.test.mjs:310`
- **失败原因**：`前提：走廊里已经含着三条正解` 红（`[]` vs `["B69","B81","B82"]`）。
- **分类**：`stale-fixture`
- **判据**：同 E，`p23.mjs` 直接给出旧/新两条集合。
- **为什么当前代码是对的**：同 E。
- **应该怎么办**：改夹具。

---

### E4 live：连续破坏 ⇒ 真撤销并写进 rollbacks

- **文件**：`src/agent/loop/rollback.e2e.test.mjs:167`
- **失败原因**：`res.rollbacks.length === 0`。
- **分类**：`real-bug`（`handles.mjs`）
- **判据**：`.tmp-28/p9.mjs` 用测试自己的 `liveBeltHandlePairs` 跑：
  ```
  pairs [["B20","B27"],["B21","B28"]]
  round1: remove B20,B27  → 落地
  round2: remove B21,B28  → plan 被拒 remove_run:run_not_contiguous
  ```
  原因：round1 删掉两条低 uid 带子后所有名字平移，round2 的「B21/B28」指向**两条不相邻**的带子
  （实测 `.tmp-28/p14.mjs`：`B21` 从 uid 10039 变成 uid 10040，`B28` 从 10046 变成 10048）。
  只有一轮破坏 ⇒ `decideRollback` 判 `transient`（第一次给自修机会）⇒ 永不 `rolling_back`。
  **实验 A**：只回退 `handles.mjs` ⇒ E4 绿。
  **实验 B**：uid 稳定编号 ⇒ E4 绿。
- **后果**：「连续破坏自动回滚」这条能力在**多轮真机上只剩一轮有效**——
  第二轮的目标集合被编号漂移打散，撤销链路永远凑不齐「连续两次 regressive」。
- **应该怎么办**：改代码（§2.5），不急着重写这条测试。

---

### E6 ★ 撤销后本轮记成 reverted，下一轮判 inert

- **文件**：`rollback.e2e.test.mjs:221`
- **失败原因**：`{"regressive","inert","inert","inert"}` 里没有 `reverted`。
- **分类**：`real-bug`（`handles.mjs`）
- **判据**：E4 的下游 —— 没撤销就永远没有 `reverted`。实验 A/B 都转绿。
- **后果**：跨 run 记忆里永远看不到 `reverted` 这类「被系统否掉的动作」，而那正是
  `netEffectAfterRollback` 注释里说要写进记忆的最有信息量的一档。
- **应该怎么办**：改代码。

---

### E7 撤销后重新 observe 再诊断（留下 WORLD_REVERTED 标记）

- **文件**：`rollback.e2e.test.mjs:248`
- **失败原因**：`撤销后必须有一条 WORLD_REVERTED 诊断` —— 0 条。
- **分类**：`real-bug`（`handles.mjs`）
- **判据**：E4 的下游（无撤销 ⇒ 无该标记诊断）。实验 A/B 转绿。
- **后果**：模型在撤销后的下一轮收不到「世界刚被回退、旧诊断已失效」这条提示。
- **应该怎么办**：改代码。

---

### E9 budget.ROLLBACK=false ⇒ 一次都不撤

- **文件**：`rollback.e2e.test.mjs:308`
- **失败原因**：`179 !== 177`（只少了 2 个实体，期望少 4）。
- **分类**：`real-bug`（`handles.mjs`）
- **判据**：`.tmp-28/p20.mjs` 复现 `final entities 179, expected 177` ——
  第二轮 `remove B21,B28` 因 `run_not_contiguous` 被拒，只有第一轮落地。
  实验 A/B 转绿。
- **后果**：与 E4 同源（这一条不撤销，所以它暴露的是「第二轮根本没执行」而不是撤销）。
  ★ 注意：这条测试**测的不是撤销**（它关掉了 ROLLBACK），它是**唯一一条**把
  「编号漂移导致第二轮没执行」暴露成数字的测试。
- **应该怎么办**：改代码。

---

### E11 ★ 撤销之后 prompt 必须说 reverted，且明说「别去修」

- **文件**：`rollback.e2e.test.mjs:353`
- **失败原因**：`前提：这次 run 必须真的撤销过` 红。
- **分类**：`real-bug`（`handles.mjs`）
- **判据**：E4 的下游。实验 A/B 转绿。
- **后果**：`## LAST STEP` 里那句 `your last change: reverted … Do NOT try to repair（UNDONE）`
  永远不会出现 ⇒ 模型会把「被撤销」误读成「我什么都没干」，然后重复同一动作
  （这条测试的注释引用过「实测过：没有反馈时连续三轮同一套宏」）。
- **应该怎么办**：改代码。

---

### T3 ★ L5：DISCARDED_INTERMEDIATE，subject=cutter#10902

- **文件**：`src/agent/loop/semantic.test.mjs:194`
- **失败原因**：`首条 subject 必须是 cutter#10902` —— 实际 `10036 !== 10902`。
- **分类**：`stale-fixture`
- **判据**（`.tmp-28/p19.mjs` / `p33.mjs`）：
  ```
  L5 cutters: [["C1", 10036, -8,-11], ["C2", 10902, 4,-13]]
  OLD: C1 = uid 10902
  NEW: C1 = uid 10036,  C2 = uid 10902
  ```
  测试同时断言 `subject.uid === 10902`（对）和 `subject.handle === "C1"`（编号变了）。
  `p33.mjs` 用注入矿图的方式跑一遍：诊断**确实**以 uid 10902 为首条，
  `discarded:["----CuCu"]`、`sibling:["CuCu----"]`、`one_rotation_from_goal:true` 全对，
  只是它的 handle 现在叫 **C2**。
- **为什么当前代码是对的**：语义判据按 uid 算，输出顺序与 uid 无关地稳定
  （`semantic.test.mjs` 自己还有一条 `T9 ★ 句柄重编号后语义结论不变` 的测试，那条一直是绿的）。
- **应该怎么办**：改夹具（`"C1"` → `"C2"`；`T2` 同理要按 uid 反查）。

---

### T7 ★ 负例：L4 的隧道 B85 只出 SHAPE_UNKNOWN{tunnel}

- **文件**：`semantic.test.mjs:334`
- **失败原因**：`subject 是隧道 sender` —— `'B59' !== 'B85'`。
- **分类**：`stale-fixture`
- **判据**（`.tmp-28/p19.mjs`）：
  ```
  L4 tunnels: [["B59", 10077, -7,-12], ["B60", 10078, -7,-14]]
  OLD: B85 = uid 10077（隧道 sender）
  NEW: B59 = uid 10077;  B85 = uid 10115（普通带子 @3,-31）
  ```
  测试断言的是**类型与数量**（`reason:"tunnel"`, `count>=1`, `candidates:[]`,
  不许升级成 `GOAL_SHAPE_STRANDED`）—— 这些全对，只有句柄名错。
- **为什么当前代码是对的**：语义层对隧道 Sender/Receiver 的判据没变；
  `p32.mjs` 显示 `SHAPE_UNKNOWN` 仍是 `{h:"B59", uid:10077, reason:"tunnel"}`。
- **应该怎么办**：改夹具（`"B85"` → `"B59"`）。

---

### T4 L4 冷启动的完整输出可复现（钉住 7 条与它们的码）

- **文件**：`src/agent/loop/structural.test.mjs:182`
- **失败原因**：7 条的**码与顺序全部一致**，只有句柄名不同。
- **分类**：`stale-fixture`
- **判据**（`.tmp-28/p40.mjs`，直接对比 uid）：
  ```
  got     by uid: [["DEAD_END",10008],["BELT_HANDOFF_REJECTED",10024],["CHAIN_UNFED",10032],
                   ["CHAIN_UNFED",10082],["DEAD_END",10193],["BELT_HANDOFF_REJECTED",10030],
                   ["CHAIN_UNFED",10027]]
  expected by uid (test 注释里写的): 完全一致
  IDENTICAL: true
  ```
  测试注释里**逐条写着 uid**（`10008 @ x=-10` …），那七个 uid 一个不差。
  也就是说「7 条与它们的码」**没有退化**，只是名字换了：
  `B129→B7`, `B130→B14`, `B136→B19`, `M4→M8`, `B83→B148`, `B134→B18`, `B131→B15`。
- **为什么当前代码是对的**：`structuralDiagnoses` 的输出顺序按 uid 排，
  与句柄编号无关（`.tmp-28/p40.mjs` 逐项一致）。**诊断逻辑没退化。**
- **应该怎么办**：改夹具。★ 顺带建议：这条测试**不该钉句柄名**，应该钉 `[code, uid]`
  —— 它自己注释里已经写了 uid，改成 uid 就再也不会被编号变动影响。

  （这一条正是主线程怀疑的「是夹具过期还是诊断逻辑退化」——
  答案：**诊断逻辑一字未变**，是夹具。判据在 `.tmp-28/p40.mjs`。）

---

### T4 ★ 回归 1：第 2 轮的净效果**不许**是 inert

- **文件**：`src/agent/loop/timeline.test.mjs:98`
- **失败原因**：`["inert","inert"]` —— 两轮都没有净效果（第一轮被拒）。
- **分类**：`stale-fixture`
- **判据**（`.tmp-28/p7.mjs` 同款 transcript）：
  ```
  plan {"ok":false,"rejected":{"code":"NO_REVERSIBLE_CALL", ...,
        "skipped":[{"macro":"replace_run","reason":"macro_failed","code":"not_a_run"}]}}
  ```
  `L4_CALL` 的 `$bbox_of:["B81","B82","B69"]` 在新编号下不是一条连续的带子
  （`not_a_run`）⇒ 0 op ⇒ 每轮 inert。**「before 被提前覆盖」那个老 bug 没有复发。**
  换上正确名字后（`.tmp-28/p11.mjs`）：
  ```
  net_effects [{"round":2,"kind":"regressive",...},{"round":2,"kind":"inert","final":true}]
  ```
  非 inert ⇒ 这条测试守的性质成立。
- **为什么当前代码是对的**：transcript 里 `plan.ok=false` 与 `tx 0 op` 是自洽的。
- **应该怎么办**：改夹具。

---

### T5 ★ 回归 2：规模变了就必须印出来，不许写成「无变化」

- **文件**：`timeline.test.mjs:109`
- **失败原因**：`实体数变化必须印出来`（`/entities \d+→\d+/` 不匹配）。
- **分类**：`stale-fixture`
- **判据**：同 T4 —— 没有 tx，就没有 `entities 181→180(-1)` 这一行。
  `.tmp-28/p11.mjs` 的 timeline 实测：
  ```
  · entities 181→180(-1)  · belts 163→160(-3)  · machines 17→19(+2) ...
  ```
  三条正则全部命中。
- **为什么当前代码是对的**：`formatDelta` 只在该轮真的改了世界时打印规模变化；
  0 op 不打印是正确行为。
- **应该怎么办**：改夹具。

---

### T6 ★ 回归 3：最后一步有收尾观测，累计段不漏它

- **文件**：`timeline.test.mjs:117`
- **失败原因**：`/── 收尾世界|── 累计/` 不匹配。
- **分类**：`stale-fixture`
- **判据**：同上 —— 没有 tx，收尾观测段不生成。`.tmp-28/p11.mjs` 的 timeline 末尾有
  `── r2 …` 与收尾段（见 `p11` 输出）。
- **为什么当前代码是对的**：dry/0-op 的 run 不生成收尾观测是设计（T15 就在钉这一条）。
- **应该怎么办**：改夹具。

---

### T7 收尾观测的 net_effect 带 final:true

- **文件**：`timeline.test.mjs:124`
- **失败原因**：`0 !== 1`（一条 final 都没有）。
- **分类**：`stale-fixture`
- **判据**：`.tmp-28/p11.mjs`：`[{"round":2,"kind":"regressive"},{"round":2,"kind":"inert","final":true}]`
  —— 有且只有一条 `final:true`。夹具修好即成立。
- **为什么当前代码是对的**：final 观测的生成条件没变。
- **应该怎么办**：改夹具。

---

### T15 dry_run 不做收尾观测

- **文件**：`timeline.test.mjs:236`
- **失败原因**：`res.reason` 是 `BUDGET_ROUNDS`，期望 `DRY_RUN`。
- **分类**：`stale-fixture`
- **判据**（`.tmp-28/p31.mjs`，直接跑同一份测试代码）：
  ```
  OLD handles (B81/B82/B69) => outcome halt reason BUDGET_ROUNDS finals 0 nEffects 2
  NEW handles (B156/B111/B105) => outcome halt reason DRY_RUN  finals 0 nEffects 0
  ```
  第二轮 `DRY_RUN` 的终止路径要求第一轮真的产出了一个 tx（有东西可 dry-run）。
  第一轮被 `not_a_run` 拒 ⇒ 直接烧完预算 ⇒ `BUDGET_ROUNDS`。
  测试的另一半断言（`finals === 0`、timeline 无收尾段）**一直是对的**。
- **为什么当前代码是对的**：dry_run 的收尾观测确实没做（`finals 0` 两种情况下都成立）；
  变的是 `reason`，而 `reason` 由「这一轮有没有 tx」决定 —— 那是正确语义。
- **应该怎么办**：改夹具。

---

## 4. 五条被特别怀疑的，逐条回答

| 怀疑对象 | 结论 |
|---|---|
| `T4 L4 冷启动的完整输出可复现（7 条）` | **夹具过期**。7 条的码与顺序、以及注释里写的 7 个 uid **一字不差**（`.tmp-28/p40.mjs` `IDENTICAL: true`）。诊断逻辑没退化。 |
| `S3/S4/S7`（`partial_apply`）| **夹具过期**，且 `connect` 的行为**没有退化**。`OK_BELT` 的 `MACRO_REFUSED: port_already_bound` 是**正确**拒绝：`B83` 现在指向 (3,-29) 的一条下游已接 B84 的带子；`65ba014` 之前 `B83`(uid 10193 @9,-13) 的出口是空的。闸门在正确落点上精确复现了 `-68`。 |
| `X3/X4/X5`（记忆）| **夹具过期**。三条都卡在「这一轮 0 op ⇒ 没有经验可记」。记忆代码按设计不记空轮。 |

---

## 5. 汇总表

| # | 测试 | 文件 | 分类 | 改哪 |
|---|---|---|---|---|
| 1 | X3 ★ halt 也写记忆 | memory.e2e | stale-fixture | 夹具 |
| 2 | X4 记忆带 goal/宏名/kind | memory.e2e | stale-fixture | 夹具 |
| 3 | X5 ★ PRIOR ATTEMPTS | memory.e2e | stale-fixture | 夹具 |
| 4 | P0 夹具前提 | partial_apply | stale-fixture | 夹具 |
| 5 | P3 ★ partial 提交可撤销子集 | partial_apply | stale-fixture | 夹具 |
| 6 | P6 partial=false | partial_apply | stale-fixture | 夹具 |
| 7 | S3 ★ 看损失规模 | partial_apply | stale-fixture | 夹具 |
| 8 | S4 ★ 拦白铺 | partial_apply | stale-fixture | 夹具 |
| 9 | S7 ★ 纯删除措辞 | partial_apply | stale-fixture | 夹具 |
| 10 | S8a ★ deliverableLoss=0 | partial_apply | stale-fixture | 夹具 |
| 11 | S8b ★ deliverableLoss>0 | partial_apply | stale-fixture | 夹具 |
| 12 | 0. 夹具 B34 不在走廊 | prompt_belt_visibility | stale-fixture | 夹具 |
| 13 | A2. 追加在 cap 之外 | prompt_belt_visibility | stale-fixture | 夹具 |
| 14 | E. 走廊 3/3 可见 | prompt_belt_visibility | stale-fixture | 夹具 |
| 15 | E2. 对照：溢出有效 | prompt_belt_visibility | stale-fixture | 夹具 |
| 16 | E4 live 连续破坏⇒撤销 | rollback.e2e | **real-bug** | 代码 |
| 17 | E6 ★ reverted⇒inert | rollback.e2e | **real-bug** | 代码 |
| 18 | E7 WORLD_REVERTED 标记 | rollback.e2e | **real-bug** | 代码 |
| 19 | E9 ROLLBACK=false | rollback.e2e | **real-bug** | 代码 |
| 20 | E11 ★ prompt 说 reverted | rollback.e2e | **real-bug** | 代码 |
| 21 | T3 ★ L5 cutter#10902 | semantic | stale-fixture | 夹具 |
| 22 | T7 ★ 隧道 B85 | semantic | stale-fixture | 夹具 |
| 23 | T4 L4 冷启动 7 条 | structural | stale-fixture | 夹具（建议改钉 uid） |
| 24 | T4 ★ 回归 1 非 inert | timeline | stale-fixture | 夹具 |
| 25 | T5 ★ 回归 2 规模印出 | timeline | stale-fixture | 夹具 |
| 26 | T6 ★ 回归 3 收尾观测 | timeline | stale-fixture | 夹具 |
| 27 | T7 收尾 final:true | timeline | stale-fixture | 夹具 |
| 28 | T15 dry_run 无收尾 | timeline | stale-fixture | 夹具 |

注意：**16-20 这 5 条 `real-bug` 与 23-28 这 6 条 `stale-fixture` 是同一个根因的两面**
（编号漂移既打断真机能力，也让夹具里的名字失真）。修 `handles.mjs` 会让 1-28 里的 27 条一起转绿；
但那不是「正确的修法」——把测试改回按 uid/坐标查句柄，才是能长期活下来的写法（见 §7）。

---

## 6. 为什么剩下的 6 个「回退 handles.mjs 也不绿」

实验 A（只回退 `handles.mjs`）后仍有 6 个红：

```
✖ src\agent\loop.test.mjs
✖ src\agent\loop\handles.test.mjs
✖ E3 升级需求表与源码一致（prompt_capacity.test.mjs）
✖ ★ stacker 的两路进料必须分得开（slot_role_unique.test.mjs）
✖ ★ hub 的同名入口必须带索引（slot_role_unique.test.mjs）
✖ ★ 回归：全表 `下游=<机器>.<角色>` 不许有重复（slot_role_unique.test.mjs）
```

这 6 个**不是本次红队的对象**（它们在 HEAD 上是绿的），它们只是说明：
**renumbering 之后新写的测试反过来依赖了新编号**。
这正是「编号不稳定」最贵的地方：**它会持续把每一批新测试也钉死在一张会漂的表上。**

`handles.test.mjs` 里那条跨轮稳定性测试（§2.4）也属于这一类：
它被写成只覆盖「加」，所以 HEAD 绿、回退反而红。

---

## 7. 「基线应该是多少」

**在 `handles.mjs` 保持现状的前提下**：0。
**在把测试改成按 uid 或坐标查句柄之后**：0。

但这需要分开做两件事：

1. **改 `handles.mjs`（真 bug，必做）**：让编号真正稳定（uid 或持久映射），
   并给 `handles.test.mjs` 补上「删一条也不许移位」的负例。
   这是 E4/E6/E7/E9/E11 这 5 条红转绿的唯一正确途径。
2. **把 22 条 `stale-fixture` 测试里的字面句柄名换掉（按 uid 或坐标反查）**。
   `65ba014` 的提交信息说它把测试改成「按坐标查句柄」了 —— **实际只改了 8 个文件**，
   剩下这 7 个测试文件里的字面量一直没跟上。
   若只改字面量（不改 `handles.mjs`），这 22 条会绿，但下次世界一变又全红 —— 那是倒退。

**写完后应该剩 0 个失败。** 但在做到第 1 步之前，「0 个失败」是假的，
因为 `handles.mjs` 的漂移会让下一批测试再红一遍（§6 那 6 个就是证据）。

---

## 8. 有没有测试根本不该存在？

有 **1 条**值得重写而不是修补：

- `handles.test.mjs:131` 的「跨轮稳定性」测试。
  它断言了正确的性质（「世界变了旧句柄不变」），但**用加一条来验证**——
  加法不改变名次，所以它恒真。这不是「不该存在」，是**写成了恒真**。
  必须补「删一条」「改一条类型」两个方向。

另外 **1 条建议改判据**：

- `structural.test.mjs:182`（T4 七条）。它自己注释里逐条写了 uid，
  但断言用的是 `d.subject.handle`。改成 `[code, uid]` 之后，它对编号变动免疫，
  而且**信息量不减**（uid 是比句柄更硬的真值）。

---

## 9. 复现清单（全部只读，不碰游戏）

```
node .tmp-28/p15.mjs   # 删 2 条 ⇒ 160/161 句柄换了 uid（根因，最小复现）
node .tmp-28/p16.mjs   # 删 3 条 ⇒ 89.3% 漂移
node .tmp-28/p27.mjs   # 三轮 prompt：同一条带子叫 B106/B105/B104
node .tmp-28/p39.mjs   # 同一 prompt 内 LAST ROUND(B106) 与 BELTS(B105) 打架
node .tmp-28/p40.mjs   # structural T4：7 条码与 uid 完全一致，只有名字变了
node .tmp-28/p6.mjs    # S3/S4/S7：B144 上 −68 拦下，B2 上 0 损失放行
node .tmp-28/p29.mjs   # S8a/S8b：按 uid 取选集后行为正确
node .tmp-28/p24.mjs   # P0：B83 现在指向已占端口，B148 可用
node .tmp-28/p19.mjs   # T3/T7：cutter#10902 现在叫 C2，隧道 B85 现在叫 B59
node .tmp-28/p31.mjs   # T15：旧名 BUDGET_ROUNDS，新名 DRY_RUN
```

实验（需 `.tmp-28/oldnum` / `.tmp-28/stable` 两份 src 副本）：
```
cd .tmp-28/oldnum && node --test src/agent/        # 774 pass / 6 fail（= 28 里 27 条转绿）
cd .tmp-28/stable && node --test src/agent/loop/rollback.e2e.test.mjs   # 11/11 绿
```

⚠️ `.tmp-28/` 已按约定删除。上面的探针全部基于同一个 20 行脚本，重放即可：

```js
// 根因最小复现：删两条带子，看句柄漂移
import fs from "node:fs";
import { buildHandles } from "../src/agent/loop/handles.mjs";
const OBS = JSON.parse(fs.readFileSync("test/fixtures/saves/L4-obs.json", "utf8")).result;
const h0 = buildHandles(OBS, null);
const after = { ...OBS, entities: OBS.entities.filter(e => ![10003, 10019].includes(e.uid)) };
const h1 = buildHandles(after, null);
let drift = 0, total = 0;
for (const [name, e] of h0.byHandle) {
    if ([10003, 10019].includes(e.uid)) continue;
    total++; if (h1.byHandle.get(name)?.uid !== e.uid) drift++;
}
console.log(`drift ${drift}/${total}`);   // HEAD: 158/179 左右；修好后应为 0
```

重放两组实验的完整命令：

```bash
# 实验 A：只回退 handles.mjs
cp -r src .tmp-28/oldnum/src
git show 65ba014^:src/agent/loop/handles.mjs > .tmp-28/oldnum/src/agent/loop/handles.mjs
cd .tmp-28/oldnum && node --test src/agent/
# 期望 774 pass / 6 fail（那 6 个是 65ba014 之后新写、依赖新编号的）

# 实验 B：改成 uid 稳定编号
# 在 handles.mjs 里把  `${p}${counts[p]}`  改成  `${p}${e.uid}`
# 并把 HANDLE_RE 的 {1,3} 放宽到 {1,6}
cd .tmp-28/stable && node --test src/agent/loop/rollback.e2e.test.mjs
# 期望 11/11 绿
```

★ 注意：跑实验前先把 `research/ai-plan` 与 `test/fixtures/llm` 一并拷进副本，
否则会有 4 个测试因 `ENOENT` 假红（它们按仓库相对路径读运行记录）。
