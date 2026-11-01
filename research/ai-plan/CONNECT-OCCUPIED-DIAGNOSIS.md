# `connect:occupied` 诊断：**不是布线能力不足，是端口选错 + 一个开关没开**

> 2026-11-02。诊断对象：`EXECUTION-RATE-BOTTLENECK.md` 报的 9 次 `connect:occupied`。
> 数据：`.tmpverify/ab-real/results.json` + `results-v2.json`，重放后实得 **15 次**命中（v1 6 次 + v2 9 次），
> 去掉 `(from,to,port,allow_replace)` 全同的重复后是 **7 个唯一失败调用**。

---

## 1. 结论一句话

**宏的搜索够用。7 个唯一失败调用里，没有一个需要「更好的布线」。**

| 分类 | 唯一调用数 | 命中次数 | 根因 | 修哪里 |
|---|---|---|---|---|
| **A 端口格被非带实体占死** | 4 | 9 | 模型选的那个端口，它在世界里的**落点格**是 `underground_belt` / `balancer`。connect 的起点**必须**是空或带，这条路物理上不存在 | **prompt / 端口选择**（宏无责） |
| **D 只差 `allow_replace`** | 3 | 6 | 宏已经枚举出 89~1045 条合法路径，全部只因「路径上有既有带子」被拒；`fits` 是过的，`checkOccupancy` 卡住 | **`hint` 到不了模型**（`MACRO_REFUSED` 丢 hint） |
| B 折线语法/预算不够 | **0** | 0 | — | — |
| C 物理无解 | **0** | 0 | — | — |

**「有解但宏没找到」的比例：0/7。**
`connect.mjs:966` 那句「要绕开需要阶段 3 的布线」在这批样本上**一次都不成立** ——
它是写死的常量文案，不是对本次失败的判断。这条注释式的诚实边界（原文档 §诚实边界 4）现在有答案了：**它不是对的**。

---

## 2. 逐条分析（7 条全做，含格子级证据）

存档 `test/fixtures/saves/L4-obs.json`，181 实体、204 占格，世界 bbox `x[-10,11] y[-34,5]`。
判定器：`.tmpverify/connocc/classify2.mjs`（BFS + 0-1 BFS，与 `candidateShapes` 独立），原始数据 `.tmpverify/connocc/final-verdicts.json`。

判定的**关键前提**（`connect.mjs:922-930`）：路径上除 `belt` 外的任何实体都进不了 `fits`，
而 `cells[0]` / `cells[n-1]` **也在 `cells` 里** ——
所以「端口格本身是机器/隧道」时，这条端口对**没有任何一条候选能存在**，与转角数、长度都无关。

---

### 2.1 `cutter#10036@(-8,-11)` → `hub#10000` — 6 次（最大单一来源）

失败调用：`{from:{uid:10036, port:"right"}, to:{uid:10000}}`，v1 OLD#15 / NEW#6 / NEW#15，v2 OLD#1 / NEW#4 / NEW#7。
其中 4 次模型已经写了 `allow_replace:true`（甚至 `rebind:true`），仍然 `occupied`。

```
        -12  -11  -10   -9   -8   -7   -6   -5   -4   -3   -2
  -15 |   .    .    .    .    .    T    .    .    .    .    .     ← trash
  -14 |   .    .    .    .    .    U    .    .    .    .    .     ← 隧道接收端 rv=1
  -13 |   .    .    .    .    b    b    b    b    b    b    .     ← 横排带子
  -12 |   .    .    .    b    U    .    .    .    .    b    .     ← 隧道发送端 rv=0
  -11 |   .    .    .    C    C    .    .    .    .    b    .
  -10 |   .    .    .    b    .    .    .    .    .    b    .
```

- cutter 在 `(-8,-11)`，2×1，两个 ejector 都在 **face=top**：
  - `left#0` → `cell=(-8,-12)`，`vel=top`
  - `right#0` → `cell=(-7,-12)`，`vel=top`
- `(-7,-12)` 是 **`underground_belt#10077`（sender, rv=0）** —— 不是带子，`fits` 直接剔。
- 模型原文报的冲突点 `-7,-12 underground_belt uid=10077` **完全准确**（`connect.mjs:965`）。

**16 个 hub 端口全试（`.tmpverify/connocc/cutterleft.mjs`）：**

| from 端口 | opts | 结果 |
|---|---|---|
| `right#0@(-7,-12)` | 任意（含 `allow_replace+rebind`） | **0/16** —— 首格是隧道，永不通过 |
| `left#0@(-8,-12)` | `{}` | 0/16，`port_already_bound`（`belt#10059` 已经在这一格接货） |
| `left#0@(-8,-12)` | `{allow_replace:true}` | 0/16，仍是 `port_already_bound`（`allow_replace` 管**路**，`rebind` 管**口**） |
| `left#0@(-8,-12)` | **`{rebind:true, allow_replace:true}`** | ✅ **16/16**，最短 `len=18 turns=2` |

走通的路径（`-2,-3` 入口）：
```
-8,-12 > -8,-13 > -7,-13 > -6,-13 > -5,-13 > -4,-13 > -3,-13 > -2,-13
       > -2,-12 > -2,-11 > -2,-10 > -2,-9 > -2,-8 > -2,-7 > -2,-6 > -2,-5 > -2,-4 > -2,-3
```
（复用 cutter 自带的那条 `(-8,-13)→(-2,-13)` 横排，再走 `(-2,-12..-3)` 竖排 —— 就是它自己的输出线。）

**⇒ A 类。路由是通的，是端口选错。**
模型看到的是 `C1 ... 输出=top:left(→B84)/top:right(→B85) port=left|right`
（`handles.mjs` 的 desc —— 这是 prompt 里唯一提到端口的地方），
它无从知道 `right#0` 的落点格被一条隧道占着、`left#0` 的落点格已被别条带子接货。
它选了 `right`，然后在「撞了」的 hint 下面反复重试 6 次。

---

### 2.2 `belt#10008@(-10,-3)` → `hub#10000` — 4 次

失败调用：`{from:{uid:10008}, to:{uid:10000}}`，**opts 全空**（v1 NEW#9，v2 OLD#6 / NEW#2 / NEW#13）。

宏的原话：
> 3661 条候选路径全部被挡住：撞既有带子 3253 条（2 格 1104 条 / 3 格 509 条 / …）；
> 枚举阶段撞机器被剔除 18183 条

**逐个端口对测（16 个 hub 入口）：**

| 判据 | 结果 |
|---|---|
| `candidateShapes(fits=只排非带)` | **89 ~ 514 条 / 每口**（即有大量合法折线） |
| BFS 最短（`allow_replace=true`，只排机器） | 9 ~ 19 步，最少转角 2 ~ 4 |
| BFS 最短（只走空格） | 24 ~ 35 步，需 7~11 转角（远超 `MAX_TURNS=6`） |

**⇒ D 类：只差 `allow_replace:true`。** 实测：

```
connect({from:{uid:10008}, to:{uid:10000}})                        → occupied
connect({from:{uid:10008}, to:{uid:10000}, opts:{allow_replace:true}})
  → ✅ len=14 turns=2，out#0@-10,-4 → primary#8@0,-3
     路径 -10,-4>-10,-5>-9,-5>-8,-5>-7,-5>-6,-5>-5,-5>-4,-5>-3,-5>-2,-5>-1,-5>0,-5>0,-4>0,-3
     只覆盖 2 格：(-8,-5)=belt#10053、(-2,-5)=belt#10072
```

**而宏的 hint 已经把这句话写出来了**（`connect.mjs:994`）：

> 有 3253 条走法只需要覆盖既有带子（最少 2 格）就能通 —— **传 `opts.allow_replace=true` 即可**

**模型没看到。** 见 §4.1 —— `MACRO_REFUSED` 这个诊断码把 `hint` 丢掉了。

---

### 2.3 `belt#10030@(-3,-3)` → `hub#10000` — 1 次

失败调用：`{from:{uid:10030}, to:{uid:10000}}`，opts 空（v1 NEW#11）。

`belt#10030` 在 `(-3,-3)`，`rv=2`（弯带），ejector 落点 `cell=(-2,-3)` —— 那是 **`belt#10074`**，
它同时是 hub 的 `primary#0` 入口格。所以 16 个端口对全部「路径至少压 1 格既有带子」。

| 判据 | 结果 |
|---|---|
| `candidateShapes(fits)` | 2 ~ 106 条 / 每口 |
| 只走空格 | **全部无解**（`(-2,-3)` 这个首格本身就被带子占着） |

**⇒ D 类。** `+allow_replace` 后立刻通，而且极短：

```
connect({from:{uid:10030}, to:{uid:10000}, opts:{allow_replace:true}})
  → ✅ len=3 turns=1：-2,-3 > -1,-3 > 0,-3（覆盖 belt#10074、belt#10032 两格）
```

---

### 2.4 `balancer#10035@(-8,-3)` → `belt#10027@(-6,-3)` — 2 次

失败调用：`{from:{uid:10035, port:"secondary"}, to:{uid:10027}}`，
v1 NEW#12（opts 空）、v2 OLD#15（`{rebind,allow_replace}`）。

```
        -9   -8   -7   -6   -5
  -4 |   .    b    .    .    .     ← balancer 的 secondary ejector 落在这里
  -3 |   b    B    B    b    b     ← balancer 本体 + belt10027
```

- `secondary#0` → `cell=(-7,-4)`，`vel=top`
- 目标 `belt#10027@(-6,-3)`，`r=90`，acceptor 落点 `cell=(-7,-3)` —— 那是 **`balancer#10035` 自己的第二格**。

唯一端口对 `(-7,-4) → (-7,-3)`，**末格是 balancer 本身**。`fits` 直接剔，候选数 **0**。

**⇒ A 类。** 走不通不是「转角不够」，是 `manh=1` 的两个格子里有一格是机器：
`(-7,-4)` 到 `(-7,-3)` 只有一步向下，而 `(-7,-3)` 就是 balancer。
**换端口或换目标**是唯一出路。模型在这里犯了「从平衡器输出直接连回平衡器」的拓扑错误。

---

### 2.5 `miner#10001@(-10,4)` → `balancer#10186@(8,-9)` — 1 次

失败调用：`{from:{uid:10001, port:"out"}, to:{uid:10186, port:"primary"}, opts:{prefer:"shortest", rebind:true}}`（v2 OLD#2）。

宏原文：1045 条候选全撞带子（4 格 190 条 / … / 15 格 6 条），枚举阶段撞机器剔除 5637 条。

`miner#10001` 的 ejector 落点 `(-10,3)` 是 **`belt#10002`**（`allow_replace=false` → 软阻塞）。

**⇒ D 类**（虽然模型开了 `rebind`，但 `rebind` 管端口占用、不管路径覆盖 —— 它没开 `allow_replace`）：

```
connect({... , opts:{rebind:true, allow_replace:true}})
  → ✅ len=30 turns=2：-10,3 › -10,2 › -9,2 › … › 8,2 › 8,1 › 8,0 › 8,-1 › … › 8,-8
     覆盖 5 格：-10,3 / -10,2 / -9,2 / -8,2 / -7,2
```

注意这条**只用了 2 个转角、30 格**，完全在 `MAX_TURNS=6` / `budget=manh+8=38` 之内 ——
宏在 `allow_replace=true` 下 1045 条候选里挑得出它。

---

### 2.6 `belt#10024@(-9,-3)` → `hub#10000` — 1 次

失败调用：`{from:{uid:10024}, to:{uid:10000}, opts:{allow_replace:true, prefer:"shortest"}}`（v2 OLD#14）。
模型这次**已经开了 `allow_replace`**，仍然失败。

`belt#10024` 在 `(-9,-3)`、`rv=2`（弯带），ejector 落点 `cell=(-8,-3)` —— 那是 **`balancer#10035` 的第一格**。

**⇒ A 类。** 16 个端口对里首格全是 `balancer#10035`，`fits` 全剔，候选 0。
实测 `belt#10024 → hub` 在 `allow_replace=true` 下：`target_already_fed` 3 次 + `occupied` 29 次，**0 成功**。

（旁证：`balancer#10035` 和这条弯带的关系本身可疑 —— 弯带的出口指着 balancer 的格子，这个布局可能早就坏了。但那是上游问题，不是 connect 的。）

---

### 2.7 `balancer#10035 → belt#10027`（`allow_replace=true` 版本）— 1 次

见 2.4，同一个端口对，只是 v2 OLD#15 多带了 `allow_replace:true`。末格仍是 `balancer#10035`，**A 类**。

---

## 3. 搜索策略的实际能力（并**不是**瓶颈）

读 `src/agent/macros/connect.mjs`，逐项核过：

| 项 | 实际值 | 位置 |
|---|---|---|
| `MAX_TURNS` | **6** | `connect.mjs:1088` |
| 候选生成 | 方向序列递归枚举（相邻两腿必须成直角），每序列再枚举**同向腿组内的整数步数拆分** | `candidateShapes` `connect.mjs:474-580` |
| 长度预算 | `budget = manhattan + 8`（`cells.length` 上限） | `connect.mjs:481-483` |
| 可通行判定 | `fits`：只排除 **非 belt** 实体；`checkOccupancy` 另判带子（`allow_replace` 可解） | `connect.mjs:922-930` / `709-740` |
| 是否 BFS/A* | **都不是**，是**折线枚举**：n 个转角 = n+1 条正交腿 | `walk()` `connect.mjs:567-573` |
| 有没有「绕远路」能力 | **有，但只在「同轴同符号」方向**（见下） | `solveLegsAll` `connect.mjs:381-467` |

### 3.1 一个真实的语法限制（但与本次 9 次无关）

`solveLegsAll` 的步数分配（`connect.mjs:405-424`）：按轴把腿分成 `axis:+` / `axis:-` 两组，
算出 `gap = want − Σ mins*sign`，然后把 `|gap|` **整组加给其中一个符号组**，另一组永远停在 `mins`。

后果：**同一轴上「正腿 > 0 且 负腿 > 0」的走法生成不出来**，即「冲出包围盒再折回来」。
我构造了反例验证（`.tmpverify/connocc/legs.mjs`）：

```
S=(-10,-4) v0=top  →  E=(0,-3) vE=bottom   disp=[10,1]
那条 BFS 路：top12 → right10 → bottom13
  · poseChain 逐格 solveTurn：✓ 全解得出（几何合法）
  · 沿途不可通行格：无
  · solveLegsAll([top,right,bottom], mins=[0,1,0], disp=[10,1]) → 只有 1 个解 [0,10,1]（不含 [12,10,13]）
    因为 gap=1 被整组加给了 y:+
```

**但这不影响本次结论**：这条 `top12/right10/bottom13` 路是 `len=36`，超预算 17 格；
而且真正要连的话，宏在 `allow_replace=true` 下用 `len=14` 就通了（§2.2）。

反事实模拟（`.tmpverify/connocc/quantify.mjs`）说明这个限制**要么单独修不动、要么要修两处**：

| 场景 | 结果 |
|---|---|
| ① 现状（原分配 + `manh+8`） | 0 条 |
| ② 只放大预算（原分配，一直试到 `manh+48`） | **仍然 0 条** —— 分配策略才是硬墙 |
| ③ 只改分配（仍 `manh+8`） | 0 条 —— 省下的绕行量不超过 8 格 |
| ④ 改分配 **且** 放到最小够用预算 | 8/8 全部有解，需 `manh+10 ~ manh+24`（中位 +16） |

⇒ 这是**两个改动绑在一起才有收益**的能力缺口，而且**在这 9 次里一次都用不上**。
要动的话，量级是「重写 `solveLegsAll` 的分配策略 + budget 从 +8 放到约 +20」，不是改一个常量。

---

## 4. 该修什么（按性价比排）

### 4.1 P0：`MACRO_REFUSED` 吞掉了 `hint`（**这是本次 15 次里 6 次失败的直接原因**）

`connect.mjs:994` 已经把正确答案写好了：

```
有 3253 条走法只需要覆盖既有带子（最少 2 格）就能通 —— 传 opts.allow_replace=true 即可
```

`loop.mjs:1226-1236` 把它塞进诊断的 `hint` 字段：
```js
return reject("MACRO_REFUSED", { …, hint: e.hint || null, ... });
```

但 `prompt.mjs:renderDiagnoses()`（`src/agent/loop/prompt.mjs:1460-1543`）**从头到尾不渲染 `hint`**。
实测（`prompt.mjs` 的 `buildPrompt`，喂一条带 `hint` 的 `MACRO_REFUSED`）：

```
prompt 里出现 "传 opts.allow_replace" 吗?  false
prompt 里出现 "撞了" 吗?                  false
渲染出来的是：MACRO_REFUSED [plan/blocker]: C1 (cutter); expected connect 返回 ok:true;
              observed occupied: 所有候选路径都被挡住; handles C1; candidates connect
```

**模型只看到「撞了」，看不到「怎么解」。** `prompt.mjs` 里 `hint` 只在 `PROCESSOR_REQUIRED`
分支里出现过一次（`prompt.mjs:1518`），是硬编码的句子，不是读 `d.hint`。

修法：`renderDiagnoses` 的每行末尾追加 `; ${hint}`（`renderParams` 已有 30 字符截断的先例，同样截断即可）。
量级：**1 个函数、约 5 行**。收益：§2.2 / §2.3 / §2.5 的 6 次失败里，模型照 hint 加一个 `allow_replace:true` 就通。

> 顺带：`contract.mjs:1135-1139` 里 `opts.rebind` / `opts.allow_replace` 的 description 写得很清楚
> （「口上的开关」vs「路上的开关」），`prompt.mjs:342` 的 `renderParams` 也已经把它们首句渲染出来了。
> 所以「模型不知道有这个开关」不是问题，**「知道有、但不知道这次该开哪个」才是** —— 而这正是 hint 要回答的。

### 4.2 P1：`occupied` 的 hint 是写死的，对 A 类完全误导

`connect.mjs:966`：
```js
hint: "这是「撞了」，不是参数错。要绕开需要阶段 3 的布线；机器永远不会被覆盖。",
```
这句话在 §2.1 / §2.4 / §2.6 的场景里指向「绕开」，而真相是**换端口**（绕开根本无意义 —— 首格/末格就是那台机器）。
它还有一个副作用：在 §2.2/§2.3/§2.5（D 类）里完全不出现，因为那些走 `summarizeBlocked` 分支（`connect.mjs:994`），
两条路径的 hint 语义不同却都叫 `occupied`。

修法：在 `connect.mjs:960-970` 的 `blockedBy` 分支里区分「端点格被占」：
```js
const atStart = rf 的某个端口 cell === blockedBy 的格；
```
`portsOf` 已经给出了每个端口的 `cell`，比一下即可。若是端点格，hint 改成
「端口 X 的落点格是 Y，connect 不能覆盖它 —— 换 port，或先拆 Y」。
量级：**约 10 行**。

### 4.3 P2：prompt 里端口信息不足以选对端口

模型现在只能看到 `C1 cutter ... 输出=top:left(→B84)/top:right(→B85) port=left|right`
（`handles.mjs`）。它不知道 `→B84` 那条带子的**落点格**是不是空着。
§2.1 里 16 个端口组合中只有 1 个可用，模型没有信息能选中它。

两条路（都不小）：
- **(a) 便宜**：在 `renderMachines` / `renderDesc` 里给每个端口标注「落点格 = 空 / 带 / `underground_belt`」。
  §2.1 的可用组合恰好就是落点格为 `belt` 的那个（`left#0@(-8,-12)`）。
- **(b) 贵**：让宏在 `occupied` 时直接给出「本实体哪个端口能连」的枚举结果（宏内部已经全算过一遍了，
  见 `connect.mjs:932-958` 的双层端口循环），作为 `error.candidates` 返回。

### 4.4 不该做的

- **不要**为了这 9 次去实现「阶段 3 布线 / dijkstraOriented」。0/7 需要它（§1）。
- **不要**把 `MAX_TURNS` 从 6 调大。`candidateShapes` 的耗时对转角数极敏感
  （实测 `maxTurns` 6→10 时单次 `connect` 从 153ms 涨到 6722ms，候选从 767 涨到 53848 条），
  而 §2 的 A 类**调多大都没用**（首格是机器）、D 类**本来就够**。
- **不要**把 §3.1 的分配策略当成本次的修法。它是个真缺口，但与 `occupied` 这 9 次无关，
  且单独改它没有收益（`quantify.mjs` 场景③ = 0 条）。

---

## 5. 量化总表

**15 次命中 / 7 个唯一调用：**

| # | 调用 | 次数 | 分类 | 需要的修复 | 实测修后 |
|---|---|---|---|---|---|
| 1 | `cutter#10036[port=right] → hub` | **6** | A：首格 `underground_belt#10077` | `port:"left"` + `{rebind:true, allow_replace:true}` | ✅ len=18 t=2 |
| 2 | `belt#10008 → hub` | **4** | D：只差 `allow_replace` | `{allow_replace:true}` | ✅ len=14 t=2，覆盖 2 格 |
| 3 | `belt#10030 → hub` | 1 | D：只差 `allow_replace` | `{allow_replace:true}` | ✅ len=3 t=1，覆盖 2 格 |
| 4 | `balancer#10035[secondary] → belt#10027` | 1 | A：末格是 balancer 自己 | 换端口/换目标（拓扑错误） | ❌ 无解 |
| 5 | `miner#10001 → balancer#10186[primary]` | 1 | D：只差 `allow_replace`（模型开了 `rebind`，开错了） | `{allow_replace:true}` | ✅ len=30 t=2，覆盖 5 格 |
| 6 | `belt#10024 → hub` | 1 | A：首格是 `balancer#10035` | 需先修那个布局 | ❌ 无解 |
| 7 | `balancer#10035[secondary] → belt#10027`（+ar） | 1 | A：同 #4 | 同上 | ❌ 无解 |

- **真无解（A 类）：9/15 次，4/7 唯一调用。**
- **有解、只差一个布尔开关（D 类）：6/15 次，3/7 唯一调用。全部是 `allow_replace`。**
- **有解但宏搜索不到：0/15，0/7。**
- 差几格 / 差几个转角：D 类全部 **0 格 0 转角**（宏早就枚举出来了，是被 `checkOccupancy` 挡的）。

---

## 6. 一句话给下一轮

> `connect:occupied` 这 9 次里，**没有一次**是「宏的布线搜索不够」。
> 一半是模型选了个落点格被机器/隧道占死的端口（该改 prompt 的端口信息），
> 另一半是宏已经把答案写在 `hint` 里、而 `prompt.mjs:renderDiagnoses` 把 `hint` 丢了（该改 5 行）。
>
> **最该修的是那个 5 行的 hint 透传** —— 它一次修掉 6/15 次失败，
> 而且它同时会让 `port_already_bound` / `target_already_fed` 那两大类（8 次）的 hint 终于到达模型。

---

## 附：复现方式

```bash
cd "D:/Projects/rea/Project work/shapez"
node .tmpverify/connocc/extract.mjs      # 抽出 15 条 occupied（含完整 args）
node .tmpverify/connocc/classify2.mjs    # 逐端口对判定 A/D/B/C
node .tmpverify/connocc/workarounds.mjs  # 每个失败调用换 opts/port 后能否通
node .tmpverify/connocc/legs.mjs         # §3.1 的语法限制反例
node .tmpverify/connocc/quantify.mjs     # §3.1 的四种修复组合量化
node .tmpverify/connocc/cutterleft.mjs   # §2.1 的 16×4 端口/开关矩阵
```

数据落盘：`.tmpverify/connocc/{hits,final-verdicts,porttrials}.json`。

**诚实边界：**
1. 重放用的是 `replay.mjs` 的路径（`resolveRefs` → 逐条宏），跳过 `planToTxOps` / `verifyRuntime`；
   「宏可执行」是必要条件。
2. 只测一个存档（L4-obs，181 实体）。§5 的「A 类无解」是**在这个世界里**无解。
3. §3.1 的语法限制是我构造反例证实的；它**不在**这 15 次的因果链上，列出来只是为了让「宏到底能绕多远」有个明确答案。
