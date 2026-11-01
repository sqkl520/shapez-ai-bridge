# 三条关键事实的独立复核

> 2026-11-02。复核者只读源码与原始数据，不引用任何既有结论。
> 最高权威：`recon/upstream-full/`（shapez.io 1.5.6，commit `ee2279d5`）。

| 事实 | 结论 | 一句话 |
|---|---|---|
| **1. CAPACITY 段效果 p=2.85e-07** | **确认（有保留）** | 用我自己的判据重判 46 条，**与原判 46/46 完全一致**；p 值在任何合理判据下都在 1e-3 以下。保留在**分母**（26/25 vs 23/23）和**判据口径**（"加了 cutter"≠"加在原料段上"）两处 |
| **2. upgrade 表** | **确认** | 四条线 T1–T3 逐项复算一致；`findNiceIntegerValue` 差分测试 2144 个输入全部一致；carry-over 与 ×2.5 都实现了 |
| **3. cutter 几何与吞吐** | **确认（有保留）** | 几何与 0.5/s 全部正确。保留在 `×2` 的**出处表述**（不是 config.js:102 里的 2），以及**邻接的一张表里有单位不一致**（painterDouble 被放大 2 倍） |

下面每条给证据。

---

# 事实 1：CAPACITY 段把「处理瓶颈」从 0/26 提到 16/25

## 结论：**确认（有保留）**

我用**自己写的判据**、从原始 `text` 重新解析 51 条记录，得到 **A2 0/26、B2 16/25** ——
与文档数字**逐条一致，46 条解析成功的样本上 0 处分歧**。

## 我的判据（写死，可复算）

**M1「处理瓶颈」= 结构化动作里真的落了 cutter 机器**，即计划里存在
`insert_machine` 且解析出的机器名含 `cutter`，**或** `replace_run` 且 `building` 列表里有 `kind/building/machine` 含 `cutter`。

选择理由与取舍：

- **不用 say 文本匹配。** 说和做是两件事，这一点上一轮就已经定死了（`arms.mjs` 的注释：
  `CAP_RE` 里的 `cutter` 在任何讨论切刀的话里都会命中）。我沿用这条纪律，并且**做得更彻底** ——
  连 `says_add_cutter` 也不参与主判据。
- **`trash_unused` 一律不算。** 它不是产能动作。注意：本场景里 `trash_unused` 全部指向
  **balancer 的 secondary 输出槽**（`{"$ref":"L1","port":"secondary"}`），不是带子 ——
  这一点我实测过拓扑（见下），所以它们既不是"扔产线"，也不解决瓶颈。
- **`connect` 一律不算。** 本场景里所有 `connect` 的目标都是把已有的（或已悬空的）流重排，
  不增加任何机器的处理能力。

**另一种同样合理的判据会导致不同结论**——我在下面「判据敏感性」一节把它量化了。

## 重算证据

### 0. 原始数据里有个必须先处理的问题：51 条记录 ≠ 51 个独立样本

`results-v2.json` 有 51 条，但只有 **46 个不同的 `arm#rep`**：

```
A2#3  {attempts:1, parse_ok:false, stop:'max_tokens'}  +  {attempts:1, parse_ok:true}
B2#4  同上
A2#9  {err:'fetch failed'}                             +  {parse_ok:true}
B2#16 {err:'fetch failed'}                             +  {parse_ok:true}
A2#16 {err:'fetch failed'}                             +  {parse_ok:true}
```

`runner-v2.mjs:53` 用 `done` 集合跳过已成功的 `arm#rep`，所以这 5 组是**同一次试验的重跑**，
不是独立样本。因此：

- **独立样本数：A2 = 23、B2 = 23（共 46）**
- 文档的 `n = 26 / 25` 是**记录条数**，把 5 条失败重跑也计进去了。
  按"失败的不计入 n"（`analyze.mjs` 自己的口径）应当是 **23/23**。

### 1. 我的逐条判定

用 `parseLlmPlan` 从 `text` 重新解析（不复用存盘的 `addresses_bottleneck`）：

```
A2: 有效 n=23，加切割产能 = 0
B2: 有效 n=23，加切割产能 = 16
```

**与存盘 `addresses_bottleneck` 逐条对账：一致 46 / 46，分歧 0。**

存盘判据本身是 `acts_capacity || says_add_cutter || says_upgrade`（`arms.mjs`），
我用的只有 `acts_capacity`。两者在本数据上给出**完全相同的结果集** ——
因为唯一一条"只说不做"的样本 `B2#21`（`says_add_cutter=true, acts_capacity=false`）
的动作是 `insert_machine {"machine":{"kind":"cutter"}}` —— 机器名在**嵌套对象**里，
而 `acts_capacity` 的 `String(a.machine)` 对这种形态取到 `"[object Object]"`，**漏判了**。
这是我的判据与原判的**唯一实质差异**，且方向对我更宽、对结论无影响（16 不变）。

> **顺带发现的实现缺陷（低危）**：`arms.mjs:judge()` 的
> `const m = String(a.machine || "")` 无法处理 `machine:{kind:"cutter"}` 这种合法形态。
> 本例里被 `says_add_cutter` 兜住了，但如果模型只写结构化参数不写 `say`，会漏判。

B2 命中明细（16 条，全部可从 `text` 复算）：

| # | 动作 |
|---|---|
| 3,4,8(×2),9,12,14,16,23 | `replace_run([cutter, trash])` |
| 20, 22 | `replace_run([cutter])` |
| 5, 21 | `insert_machine(cutter)` |
| 13, 15, 19 | `insert_machine(cutter)` × 3 |
| 6 | `replace_run([cutter,trash])` × 2 **+ `remove_run`** |

## Fisher 重算

`stats.mjs` 的 Fisher 自带 6 组教科书值自检（我核过那 6 组，与 R 的 `fisher.test` 吻合）。用它重算：

| 分母口径 | 表 | p |
|---|---|---|
| **文档口径**（记录条数） | 0/26 vs 16/25 | **2.848e-07** ← 与文档 2.85e-07 一致 |
| **独立样本口径**（我推荐） | 0/23 vs 16/23 | **4.945e-07** |

**两种口径差一个数量级以内，都远低于 1e-5。结论不依赖分母选择。**

## 判据敏感性（这是这一步的真正价值）

我把判据换了 8 种，全部在同一份数据上重跑：

| 判据 | A2 | B2 | p |
|---|---|---|---|
| **V1 任一 cutter 结构化动作（我的主判据）** | 0/23 | **16/23** | **4.95e-07** |
| V2 V1 且不破坏在用链（去 `remove_run` / 扔带子） | 0/23 | 15/23 | 1.92e-06 |
| V3 **只算 `insert_machine`**（不认 `replace_run`） | 0/23 | **5/23** | **4.91e-02** |
| V4 只算 `replace_run` | 0/23 | 11/23 | 2.03e-04 |
| V5 V1 或 say「加 cutter」 | 0/23 | 16/23 | 4.95e-07 |
| V6 V1 或 say「升级 processors」 | 0/23 | 16/23 | 4.95e-07 |
| V7 仅 say 层：说到 cutter 是瓶颈（复述） | 1/23 | 20/23 | 1.18e-08 |
| V8 仅 say 层：说「加 cutter」 | 0/23 | 9/23 | 1.48e-03 |

**结论稳健**：所有 8 种判据都给出 p < 0.05。最弱的一种（V3，只认 `insert_machine`）
是 **p = 0.049** —— **踩着 0.05 的线**。

⇒ **文档"p=2.85e-07"这个数字强烈依赖"把 `replace_run` 也算作加产能"这个选择。**
如果只认 `insert_machine`，p 从 5e-07 掉到 0.049，掉 6 个数量级。
这不是"结论没了"，但**报告里必须写明主判据包含 `replace_run`**，否则复现者用最直觉的判据
（"加机器"= `insert_machine`）会得到完全不同的显著性。

## 我在这个场景上不能确认的部分

### (a) 「处理瓶颈」这个标签本身：B2 的动作有一半把 cutter 加在了**产品段**上

我按 `belt-rules.mjs` 的规则从 `obs` 实测了整条拓扑（每个出口的落点 + 接受方向，
37 条带子全部验证闭合），得到三段：

- **原料段**（钌 → cutter）：`M1/M2 → B1,B2 → L0 → B31,B32 → L1 → B6..B9 → B33 → B34 → B10 → C1`
  以及 `M3 → B3,B4,B5 → L1`
- **产品段**（cutter 右半 → hub）：`C1.right → B11 → B35 → B12..B14 → B36 → B15..B30 → H1`
- **废料段**：`C1.left → B37 → T1`

统计 B2 的 16 条命中项落在哪一段：

| 落点 | 条数 | 说明 |
|---|---|---|
| **纯原料段** | **9** | B2#3,9,12,13,15,16,23（B31/B32/B33） |
| **纯产品段** | **7** | B2#4,5,14,19,20,21,22 |
| 横跨两段（含 `remove_run`） | 1 | B2#6 |

⇒ **16 条里 7 条把切割机插在了已经切好的产品上**（`B11`/`B13`/`B14`/`B25`/`B26`/`B27`/`B29`）。
那些形状是 `RuRu----`（半片），再切一次 `bl+tl` 得到 `----RuRu`，**与目标 `RuRu----` 相反**
（`shapeActionCutHalf` 的象限映射我已逐字复算，见事实 3）。

所以「处理瓶颈」这个判据实际测的是 **"改了切割产能相关的结构"**，
**不是"改对了"**。用更严的判据 S1（切割机必须落在**纯原料段**）：

```
S1  A2 0/23  vs  B2 9/23   p = 1.48e-03
```

**仍是显著的（p≈1.5e-3），但比 2.85e-07 弱 4 个数量级。**
文档没有报告这个区分，读者会以为 64% 都做对了 —— **实际"改对了"是 39%（9/23）**。

### (b) 文档的另外两个数字也对不上

| 文档 | 我复算 | 备注 |
|---|---|---|
| 落 cutter `0/26 vs 15/10` | 0/26 vs **15/25** | 「15/10」是笔误（10 = 25−15，被当成 n） |
| 落 cutter p = 1.03e-06 | **1.025e-06**（26/25 口径）、1.92e-06（23/23 口径） | 对得上 |
| 误判 `14/26 vs 5/25`，p = 2.01e-02 | **14/26 vs 5/25 → p = 2.005e-02** ✓ | 但存盘的 `wrong_move` 是**旧判据**版本 |
| 误判（当前 `judge()` 重判） | **11/23 vs 3/23 → p = 2.30e-02** | 5 条分歧：`A2#1,2,4`、`B2#1,2` 旧判 true、新判 false |

「误判」那组**结论方向不变（p≈0.02）**，但数字是两套判据的混合 ——
`AB-PROMPT-RESULT.md` 里写的 14/26 vs 5/25 用的是存盘值，而 `arms.mjs` 的注释明说
"这次实验中途改过判据，所以必须按文本重判"。**报告应当用重判值 11/23 vs 3/23。**

### (c) 夹具里还有一处自相矛盾（V2 声称"已修"，实际没修干净）

`.tmpverify/capacity-scenario.json` 的 `production` 块：

```
window_seconds: 60
delivered_slices: [{"RuRu----":30}, {"RuRu----":30}]   ← 共 60
delivered_per_sec: {"RuRu----":0.5}                     ← 60/60 = 1.0，不是 0.5
```

`src/mod/shapez-ai-bridge.js:644` 明确 `slice_seconds = 10`，且 `delivered_per_sec` 是
`deliveredSum / (wantSlices × sliceSecs)`。所以自洽的读法只有两种，**与 0.5 都不符**：

- 2 片 × 10s = 20s ⇒ **3.0/s**
- 按 `window_seconds: 60` ⇒ **1.0/s**

`v2.mjs` 只补了 `produced_total["RuRu----"] = 30`，**没有动 `delivered_slices`**。
这不影响事实 1 的两臂对照（两臂吃的是同一份数据），但意味着
**"V2 场景已自洽"这个说法不成立**，而且 CAPACITY 段自己说的 0.5/s 与 PRODUCTION 段
的数字仍然打架 —— 这正是上一轮"假信号"的同一类问题，只是换了个位置。

---

# 事实 2：`upgrade` 表

## 结论：**确认**

四条升级线 T1–T3 逐项一致；累计倍率阶梯一致；`findNiceIntegerValue` 差分测试全过；
carry-over 与 ×2.5 都正确实现。**commit `bb6939d` 的修复是对的。**

## 证据

### 1. 源码常量（逐行）

| 常量 | 源码位置 | 值 | 仓库 |
|---|---|---|---|
| `fixedImprovements` | `recon/upstream-full/src/js/game/modes/regular.js:80` | `[0.5, 0.5, 1, 1, 2, 1, 1]` | `rules.mjs:243` 一致 ✓ |
| `tierGrowth` | `regular.js:66` | `2.5` | `rules.mjs:244` 一致 ✓ |
| `beltSpeedItemsPerSecond` | `src/js/core/config.js:81` | `2` | `rules.mjs:28` 一致 ✓ |
| `buildingSpeeds.cutter` | `config.js:102` | `1/4` | `rules.mjs:245` 一致 ✓ |
| `minerSpeedItemsPerSecond` | `config.js:151` | `belt/5` | `rules.mjs:29-30` 一致 ✓ |

### 2. carry-over 与 ×2.5 的算法（`regular.js:244-274`）

源码（逐字）：

```js
let currentTierRequirements = [];
for (let i = 0; i < upgradeTiers.length; ++i) {
    const tierHandle = upgradeTiers[i];
    tierHandle.improvement = fixedImprovements[i];
    tierHandle.required.forEach(required => { required.amount = Math.round(required.amount * difficulty); });
    const originalRequired = tierHandle.required.slice();
    for (let k = currentTierRequirements.length - 1; k >= 0; --k) {   // ← 倒序 unshift
        const oldTierRequirement = currentTierRequirements[k];
        if (!tierHandle.excludePrevious) {
            tierHandle.required.unshift({ shape: ..., amount: ... });
        }
    }
    currentTierRequirements.push(...originalRequired.map(...));
    currentTierRequirements.forEach(tier => {                          // ← 对**累积数组**乘 2.5
        tier.amount = findNiceIntegerValue(tier.amount * tierGrowth);
    });
}
```

三处关键点，`rules.mjs:330-342` 的 `accumulateTiers` **全部复刻正确**：

1. **倒序 `unshift`**：源码从 `length-1` 递减到 0 并逐次 `unshift`，等价于把
   `[c0,c1,c2]` 插到前面得到 `[c0,c1,c2, new]`。仓库的
   `for (let k = current.length - 1; k >= 0; --k) req.unshift(...)` —— **同构**。
   顺序因此是"carry-over 在前、新档在后"，`rules.mjs:395` 的比较也把顺序算进去了。
2. **×2.5 作用在累积数组上**（`currentTierRequirements`），**不是**只作用在新档。
   仓库 `rules.mjs:338` 写的是 `for (const t of current) t.amount = findNiceIntegerValue(t.amount * tierGrowth);`
   —— 作用在 `current`（= 累积数组）上，**正确**。
   （这也解释了为什么 T2 的 `CuCuCuCu` 是 75 而不是 30：`30 × 2.5 = 75`。）
3. **`excludePrevious` 时跳过 unshift**：注意源码里 `excludePrevious` 只跳过
   **unshift**，`currentTierRequirements` 仍然 `push` 并仍被 ×2.5。仓库
   `parseRawUpgradeTiers` 在遇到 `excludePrevious` 时 `break`（`rules.mjs:324`），
   因为只登记到 T3 而前三条线 T1–T3 都没有这个标记 —— **对本表无影响**，
   但如果将来扩到 T4+（`regular.js:193/200` 的 processors 第 6、7 档就带这个标记），
   **这个 `break` 会让后续档位整体缺失**。`rules.mjs:170-172` 的注释承认了 T4/T5 是"已知边界"，
   但没有点名 `excludePrevious` 这个具体成因。

### 3. `findNiceIntegerValue` 的取整规则

源码 `src/js/core/utils.js:180` 是 `findNiceValue`，`:221` 是
`findNiceIntegerValue = num => Math.ceil(findNiceValue(num))` —— **注意外层还有个 `Math.ceil`**。

仓库 `rules.mjs:267-282` 把 `findNiceValue` 的**函数体**内联进来，并在每个 return 上
直接返回取整后的值，等价于 `Math.ceil(findNiceValue(num))`。我做了**差分测试**：

```
2144 个输入（含所有升级表实际出现的 amount、amount×2.5、amount×2.5²，以及对数扫描）
→ 游戏原版 vs 仓库实现：全部一致 ✓
```

### 4. 四条线的逐项复算

我从 `regular.js` 文本独立抽取 raw tier，逐字照抄 `utils.js` 的 `findNiceValue` 与
`regular.js:244-274` 的累积算法（**不复用 `rules.mjs` 的任何函数**），结果：

```
══ belt ══          T1 ✓  CuCuCuCu×30
                    T2 ✓  CuCuCuCu×75  +  --CuCu--×500
                    T3 ✓  CuCuCuCu×180 +  --CuCu--×1200 + CpCpCpCp×1000
══ miner ══         T1 ✓  RuRuRuRu×300
                    T2 ✓  RuRuRuRu×740 +  Cu------×800
                    T3 ✓  RuRuRuRu×1800 + Cu------×2000 + ScScScSc×3500
══ processors ══    T1 ✓  SuSuSuSu×500
                    T2 ✓  SuSuSuSu×1200 + RuRu----×600
                    T3 ✓  SuSuSuSu×3000 + RuRu----×1500 + CgScScCg×3500
══ painting ══      T1 ✓  RbRb----×600
                    T2 ✓  RbRb----×1500 + WrWrWrWr×3800
                    T3 ✓  RbRb----×3500 + WrWrWrWr×9000 + RpRpRpRp:CwCwCwCw×6500

✓ 四条线 T1–T3 全部逐项一致（12 档 × 明细顺序）
UPGRADE_MULTIPLIERS 复算 [1,1.5,2,3,4,6,7,8] == 仓库值 ✓
```

`node src/agent/rules.mjs` 的 `verifyRules()` 也返回 `{ok:true, checked:15, mismatches:[]}`。

### 5. 手算一个具体例子：`processors T2`

源码 `regular.js:175-181` 的 processors 前两档 raw 需求：
`[{SuSuSuSu, 500}]`、`[{RuRu----, 600}]`。

```
i=0: req = [SuSuSuSu×500]
     original = [SuSuSuSu×500]
     current = []           → 无 carry-over
     current.push(SuSuSuSu×500)
     current[0].amount = FNIV(500 × 2.5) = FNIV(1250)
        findNiceValue(1250): 1250 > 1000 ⇒ roundAmount=100
                             floor(1250/100)*100 = 1200；1250>=10 ⇒ 1200
        ceil(1200) = 1200
     ⇒ T1 = [SuSuSuSu × 1200]
     current = [SuSuSuSu×1200]

i=1: req = [RuRu----×600]
     original = [RuRu----×600]
     carry-over 倒序 unshift: current=[SuSuSuSu×1200] → unshift ⇒ req=[SuSuSuSu×1200, RuRu----×600]
     current.push(RuRu----×600) ⇒ current = [SuSuSuSu×1200, RuRu----×600]
     current.forEach(×2.5 + FNIV):
        SuSuSuSu: FNIV(1200×2.5)=FNIV(3000)=3000     (3000>2000 ⇒ r=500, floor(3000/500)*500=3000)
        RuRu----: FNIV( 600×2.5)=FNIV(1500)=1500     (1500>1000 ⇒ r=100, floor(1500/100)*100=1500)
     ⇒ T2.required = [SuSuSuSu×1200, RuRu----×600]
```

**这里有一个极易读错的时序，我按源码逐行走了两遍确认：**

关键在于 `req.unshift(...)` 用的是**新建对象**（`{shape, amount}`），而后面
`current.forEach(×2.5)` 改的是 `current` 里的元素。所以 T2 的 `req` 拿到的是
**T1 的最终值（1200 / 600）的原样副本，不会被这一轮再乘一次**。

- `i=0` 结束时：`current = [SuSuSuSu×1200]`
- `i=1`：
  - `req = [RuRu----×600]` → 倒序 unshift `current[0]`
    ⇒ `req = [SuSuSuSu×1200, RuRu----×600]`（unshift 时新建对象）
  - `current.push(RuRu----×600)` ⇒ `current = [SuSuSuSu×1200, RuRu----×600]`
  - `current.forEach(×2.5 + FNIV)` ⇒ `current = [SuSuSuSu×3000, RuRu----×1500]`
    —— **只影响 `current`（供 T4 用），不影响 `req`**
- ⇒ **T2 = [SuSuSuSu×1200, RuRu----×600]** ✓ 与仓库表一致

- **T3**（raw `[{CgScScCg, 3500}]`）：
  - `req = [CgScScCg×3500]`
  - unshift 倒序：先 `RuRu----×1500`，再 `SuSuSuSu×3000`
    ⇒ `req = [SuSuSuSu×3000, RuRu----×1500, CgScScCg×3500]`
  - `current.forEach(×2.5)` 只影响 `current`（供 T4 用）
  - ⇒ **T3 = [SuSuSuSu×3000, RuRu----×1500, CgScScCg×3500]**，与仓库表一致 ✓

**手算与代码一致。** 补充一点值得注意的：T2 的 `SuSuSuSu` 是 **1200**，
而 T3 的 `SuSuSuSu` 是 **3000** —— 看起来像"T3 比 T2 大 2.5 倍"，
但成因是 **T1 的 500×2.5=1250→1200**（第一次 FNIV），T2 的 1200 是 T1 的最终值，
T3 的 3000 是 `1200×2.5`（第二次 FNIV）。**每一档都只被 FNIV 处理一次，但被 ×2.5 处理过一次（T1）或两次（T3 用的值）** —— 这个嵌套很容易读错，`rules.mjs:156-175` 的注释已经钉住了，是对的。

### 6. 一处**没有被验证到**的边界

`rules.mjs:173-174` 说 difficulty 按 **1**（standalone）记，源码 `regular.js:380-388`：

```js
get difficultyMultiplicator() {
    if (G_IS_STANDALONE || WEB_STEAM_SSO_AUTHENTICATED) {
        if (G_IS_STEAM_DEMO) return 0.75;
        return 1;
    }
    return 0.5;
}
```

`G_IS_STANDALONE` 由构建配置注入（`gulp/webpack.production.config.js:33`），
**源码树里查不到它的值** —— 所以"这个部署是 standalone/Steam ⇒ difficulty=1"
**无法从源码单独证实**，只能靠"如果是网页版，表里所有数字都该减半"来证伪。
这是一个**诚实的未验证点**，不是错误：如果哪天在网页版上跑，`UPGRADES` 全表会偏大一倍。
`rules.mjs:173-174` 已经写明了这一点，措辞准确。

---

# 事实 3：`cutter` 的几何与吞吐

## 结论：**确认（有保留）**

几何、输出方向、wasteRole、0.5/s 全部正确。保留在 **`×2` 的出处表述** 与
**`capacityFor` 的实算结果**（27.8% 对得上，但口径比文档说的窄）。

## 证据

### 1. footprint 2×1

`recon/upstream-full/src/js/game/buildings/cutter.js:37-40`
`getDimensions(variant)` → `defaultBuildingVariant` 返回 `new Vector(2, 1)` ✓
（quad 变体是 `Vector(4, 1)`，`cutter.js:42`）

与 `src/ai/op-templates.mjs:296` `footprint: [2, 1]` 一致。

### 2. 输入 `(x, y+1)` 从南

`cutter.js:96-102`：

```js
new ItemAcceptorComponent({
    slots: [{ pos: new Vector(0, 0), direction: enumDirection.bottom, filter: "shape" }],
})
```

- `pos = (0,0)` = 占地左格 ⇒ 世界 `(x, y)`
- `direction = bottom` —— 注意 `item_acceptor.js:113-126` 的语义：
  **acceptor 的 `direction` 是"从哪个方向接受"**，不是"从哪里出发"。
  `bottom` ⇒ 物品从南边来 ⇒ **来向格是 `(x, y+1)`** ✓
- `enumDirectionToVector`（`src/js/core/vector.js:685-690`）：`bottom: (0,1)` ⇒ y 向下 ✓

符合 `domain` 的 y 向下约定。**正确。**

### 3. 输出 `(x, y-1)` [左] 与 `(x+1, y-1)` [右]

`cutter.js:116-119`：

```js
entity.components.ItemEjector.setSlots([
    { pos: new Vector(0, 0), direction: enumDirection.top },
    { pos: new Vector(1, 0), direction: enumDirection.top },
]);
```

- slot0：本地 `(0,0)` + `top=(0,-1)` ⇒ 世界 **`(x, y-1)`** = 占地左列上方 ✓
- slot1：本地 `(1,0)` + `top` ⇒ 世界 **`(x+1, y-1)`** = 占地右列上方 ✓

与 `op-templates.mjs:298`
`outputs: [slot([0,0],"top","left"), slot([1,0],"top","right")]` 一致 ✓

### 4. `wasteRoles = ["left"]` —— 正确，但**不是"永远"**

`shapeActionCutHalf`（`src/js/game/shape_definition.js:92-105`）：

```js
const rightSide = definition.cloneFilteredByQuadrants([2, 3]);
const leftSide  = definition.cloneFilteredByQuadrants([0, 1]);
return [registerOrReturnHandle(rightSide), registerOrReturnHandle(leftSide)];
```

配合 `arrayQuadrantIndexToOffset`（`shape_definition.js:40-45`）：
`0=tr(1,-1)  1=br(1,1)  2=bl(-1,1)  3=tl(-1,-1)`

`process_CUTTER`（`src/js/game/systems/item_processor.js:367-388`）把
`cutDefinitions[i]` 送进 `requiredSlot: i`，即 **`cutDefinitions[0] → ejector slot0 = role "left"`**。

所以：

| 返回数组 | quadrants | 视觉位置 | ejector slot | role |
|---|---|---|---|---|
| `cutDefinitions[0]` = `rightSide` | `[2,3]` = bl+tl | **x 负 = 视觉左半** | slot0 | `"left"` |
| `cutDefinitions[1]` = `leftSide` | `[0,1]` = tr+br | **x 正 = 视觉右半** | slot1 | `"right"` |

⇒ **`slot0 / role "left"` 出的确实是视觉左半。名字与几何一致。**

**但哪一半是废料取决于目标形状。** 逐字复算：

| 输入 | role "left"（slot0） | role "right"（slot1） |
|---|---|---|
| `RuRu----` (tr,br) | 空（`isEntirelyEmpty` ⇒ 该槽不喷） | `RuRu----` ← **产品** |
| `----CuCu` (bl,tl) | `----CuCu` ← **产品** | 空 |
| `RuRuRuRu` | `----RuRu` | `RuRu----` |
| `CuCuCuCu` | `----CuCu` | `CuCu----` |

⇒ 对 `RuRu----`/`Cu/Cu` 类目标，**waste = left**；对 `----CuCu` 类目标，**waste = right**。

`op-templates.mjs:322` 写死 `wasteRoles: ["left"]`，`contract.mjs:1387-1392` 的注释
**已经明确承认这一点**（"wasteRoles 是半切场景的约定…目标形状决定哪一侧是废料"），
并且把 `confirm_waste` 保留为人工签字。**所以这条事实的表述是对的**：
`wasteRoles = ["left"]` 作为"本仓库目标形状（`RuRu----` 系）下的废料侧"成立，
作为"永久约定的废料侧"不成立 —— 但文档/代码注释没有把后者当成事实。

⚠️ 一处**我认为仍然有害**的措辞：`contract.mjs:1387` 的例子写的是
「`----CuCu` 要的是左列，右列才是废料」，这与上表一致（`----CuCu` 的产品在 left），
**但同一个句子里 `wasteRoles` 是 `["left"]`** —— 读者很容易把"左列才是废料"读成
"left 永远是废料"，正好与 `----CuCu` 的情形冲突。**建议把例子换成 `RuRu----` 或明确写"本例"**。

### 5. 吞吐 `2 × upgradeImprovements.processors × (1/4)` —— 数字对，`2` 的出处表述需要修正

`hub_goals.js:553-565`（cutter 分支，逐字）：

```js
return (
    globalConfig.beltSpeedItemsPerSecond *        // 2   (config.js:81)
    this.upgradeImprovements.processors *          // 倍率 (hub_goals.js:58-62)
    globalConfig.buildingSpeeds[processorType]     // cutter: 1/4   (config.js:102)
);
```

`hub_goals.js:519` 的 docstring 写明返回单位是 **`items / sec`**。
`item_processor.js:323-324` 用 `const baseSpeed = ...; const originalTime = 1 / baseSpeed;`
→ **一个 charge 用 `1/baseSpeed` 秒** ⇒ 单位确实是 **charges/s**。

`inputsPerCharge`：`cutter.js:89` `inputsPerCharge: 1`。
`process_CUTTER` 一 charge 最多向 **2 个 slot** 各推 1 件，但 `isEntirelyEmpty()` 的那一半跳过
⇒ 对已切成两半的形状，**一 charge 出 2 件**。

⇒ **0.5/s 是 "charges/s"，进 0.5 件/s，出最多 1.0 件/s。**

**这里就是"文档表述"与"源码"的真实分歧：**

文档写 `吞吐 = 2 × upgradeImprovements.processors × (1/4)`。
`2` 来自 `beltSpeedItemsPerSecond`，**不是**"两个输出口"。如果把它读成"两个输出口 × 倍率 × 1/4"，
那对 `RuRu----` 这种只有一半有内容的输入就是**错的**（只有 1 件出）。

仓库 `rules.mjs:45-56` 的注释其实**已经说清了**（"一 charge 出 2 件…这里记的是它的出件率"），
而 `RATES.machinePerSec.cutter = 0.5` 的定义是 `2 × 1 × 1/4 = 0.5`，
`PRODUCT_PER_CHARGE.cutter = 1`（`rules.mjs:109`）表示"对目标的贡献 1 件"。
**三者是自洽的** —— 但只有当读者明白 `0.5` 是 charges/s 且 `2` 是带速时才自洽。

⇒ **建议在事实 3 的表述里把 `2` 标注为 `beltSpeedItemsPerSecond`（config.js:81），
并写明"0.5 charges/s ⇒ 最多 1.0 件/s，对半切目标贡献 1 件/charge"。**
否则"吞吐 0.5/s"与"产出 1 件/charge"会被读成矛盾。

### 6. 用真实世界数据核对 `capacityFor`

`.tmpverify/capacity-scenario.json`（3 矿机 `miner:1`、1 cutter、`processors:0`）：

```
直连 `capacityFor(obs)` 实算（我跑的，不是抄文档）：
  miners.ratePerSec   = 0.6        （0.4 × UPGRADE_MULTIPLIERS[1] = 0.4 × 1.5）
  supplyPerSec        = 1.8        （3 × 0.6）
  process.capacityPerSec = 0.5     （1 × 0.5）
  process.machines[0] = {kind:"cutter", count:1, ratePerSec:0.5, productPerSec:0.5, upgradeLine:"processors"}
  utilization         = 0.27777…   ⇒ **27.78%**  ← 文档说 27.8% ✓
  bottleneck          = "process", bottleneckMachine = "cutter"
  bottleneckDetail    = "1 台 cutter 只能处理 0.50/s，而 3 台矿机在产 1.80/s —— 72% 的产出堵在这里"
```

**手算 0.5 / 1.8 = 27.78%，与 `capacityFor` 一致。** ✓

`miner:1 ⇒ ×1.5` 这一环也独立验证了：`UPGRADE_MULTIPLIERS[1] = 1 + fixedImprovements[0] = 1.5`，
源码 `hub_goals.js:58-62` 的 `totalImprovement` 循环形状相同 ✓。

### 7. ★ 一致之外的发现：邻接的速率表有一处**单位不一致**（painterDouble 被放大 2 倍）

这是我在核事实 3 时顺带发现的，**不属于三条待核事实，但它就在同一张表里**，且形态与
`bb6939d` 那次事故同类（"同一张表里两套单位"）。

`rules.mjs:38-42` 的注释说：

> 本表**逐条核过**，结论是：除了 `painterDouble`，每条 `charges/s` 与 `items/s` 数值相同。
> `painterDouble` … 所以这里记的是它的**出件率** 0.25 charges/s × 2 = 0.5 items/s。

也就是说 `RATES.machinePerSec.painterDouble = 0.5` 是 **items/s**，而其它所有项是 **charges/s**。

然后 `assess.mjs:236` 的 `capacityOf` 又做了一次换算：

```js
const rate = machineRatePerSec(kind, levels);
const per  = PRODUCT_PER_CHARGE[kind] === undefined ? 1 : PRODUCT_PER_CHARGE[kind];
machines.push({ ..., productPerSec: +(list.length * rate * per).toFixed(3), ... });
```

`PRODUCT_PER_CHARGE.painterDouble = 2`（`rules.mjs:109`）⇒ **出件率被乘了两次 2**。

实测：

```
RATES.machinePerSec.painterDouble = 0.5   （已是出件率）
PRODUCT_PER_CHARGE.painterDouble  = 2
capacityOf 报的 productPerSec     = 1.0
真实值                            = 0.25 charges/s × 2 件/charge = 0.5 items/s
⇒ 放大 2 倍
```

**后果**：`capacityOf` 会把 `painterDouble` 的产能**高估一倍**，
于是 utilization 被高估、painterDouble 不太可能被报成瓶颈 ——
即"更说它通"，正好与 `assess.mjs:249` 声明的保守原则相反。

**cutter 不受影响**（`PRODUCT_PER_CHARGE.cutter = 1`），所以**事实 3 本身仍然成立**。

我逐个 kind 实测了 `capacityOf`（每台机器单独放在一条从矿机到 hub 的线上）：

```
cutter         ok  productPerSec = 0.5     ← 真实 0.5 件/s   ✓
rotater        ok  productPerSec = 2       ← 真实 2          ✓
stacker        ok  productPerSec = 0.25    ← 真实 0.25       ✓（吃 2 出 1，恰好抵消）
painter        ok  productPerSec = 0.333   ← 真实 0.333      ✓
painterDouble  ok  productPerSec = 1       ← 真实 0.5        ✗ 高估 2 倍
painterQuad    ✗ THROWS
mixer          ok  productPerSec = 0.4     ← 真实 0.4 色/s（但吃**颜色**不吃形状，见下）
```

`stacker` 数值恰好对：它的 `RATES` 是 charges/s（0.25），`PRODUCT_PER_CHARGE=1`，
所以 `0.25 × 1 = 0.25` 出件率 —— 正确。问题**只在 `painterDouble`**：
它的 `RATES` 已经预先乘过 2（0.25 charges/s → 0.5 items/s），`capacityOf` 又乘了一次 2。

⚠️ `mixer` 的语义问题（**不在事实 3 范围，但同一函数**）：
`mixer` 吃 2 个**颜色**、出 1 个颜色（`mixer.js:61` `inputsPerCharge: 2`，
`process_MIXER` 断言两个都是 `ColorItem`），
`SHAPES_PER_CHARGE.mixer = 0`、`PRODUCT_PER_CHARGE.mixer = 1`。
所以 `capacityOf` 报的"0.4 items/s 成品出件率"是 **0.4 色/s**，
它与"供给 1.8 形状/s"**不同量纲**，却直接进了 `Math.min(...)` 的瓶颈比较
（`assess.mjs:248`）。`rules.mjs:98` 的注释已经点明 mixer 吃的是颜色，但
`capacityOf` 还是把它跟按形状计数的机器放在同一个 min 里。
⇒ 若产线上同时有 cutter 和 mixer，mixer 的 0.4 会**被当成"这条链只能过 0.4 件形状/s"**。

⚠️ 另一处**潜在崩溃**（本次未触发，但同一个函数的另一种输入会炸）：
`machineRatePerSec("painterQuad", {})` 返回 `null`（`RATES.machinePerSec` 里没有这一项，
`rules.mjs:119-120` 对未知 kind 返回 `null`），而 `capacityOf` 在 `assess.mjs:236`
直接 `+rate.toFixed(3)` ⇒ **`TypeError: Cannot read properties of null`**。

实测：

```
machineRatePerSec('painterQuad', {}) = null
capacityOf({entities:[..., {type:'painterQuad',...}], ...}) ⇒ TypeError
```

`capacityOf` 的 `PROCESSORS` 列表（`assess.mjs:214`）**包含 `"painterQuad"`**。
触发条件：桥把一台 painter 的 quad 变体报成 `type: "painterQuad"`。
从 `recon/upstream-full/src/js/game/buildings/painter.js:22` 看，
`MetaPainterBuilding` 的 `getId()` 是 `"painter"`（变体走 `variant` 字段），
所以桥大概率报 `type:"painter"` —— **当前不会触发**。
但 `MACHINE_UPGRADE_LINE`（`rules.mjs:84`）里登记了 `painterQuad: "painting"`，
说明作者预期它会出现；一旦出现，CAPACITY 段会整段炸掉（`capacityFor` 抛异常，
`prompt.mjs:1655` 没有 try/catch 的话整轮 prompt 构建失败）。

---

# 汇总：我和文档一致 / 不一致的地方

## 一致（确认）

| 项 | 文档 | 我的重算 |
|---|---|---|
| 事实 1 主结论：CAPACITY 段有效 | 0/26 → 16/25 | **0/26 → 16/25**（逐条 46/46 一致） |
| 事实 1 Fisher p | 2.85e-07 | **2.848e-07**（同口径） |
| 事实 1 稳健性 | — | 8 种判据全部 p<0.05（最弱 p=0.049） |
| 事实 2 四条线 T1–T3 | 已修 | **12 档逐项一致** |
| 事实 2 carry-over / ×2.5 | 已实现 | **算法逐字对照正确** |
| 事实 2 `findNiceIntegerValue` | 已核 | **2144 输入差分全过** |
| 事实 2 `fixedImprovements` | `[0.5,0.5,1,1,2,1,1]` | **源码 `regular.js:80` 一致** |
| 事实 3 footprint 2×1 | 2×1 | **`cutter.js:37-40` 一致** |
| 事实 3 输入南 / 输出北 | 一致 | **`cutter.js:96-119` 一致** |
| 事实 3 `wasteRoles=["left"]` | left | **象限复算一致（对 `RuRu----` 系）** |
| 事实 3 吞吐 0.5/s | 0.5 | **`hub_goals.js:553-565` 一致** |
| 事实 3 utilization 27.8% | 27.8% | **`capacityFor` 实算 27.78%** |

## 不一致 / 需要修正

| # | 严重度 | 问题 | 位置 |
|---|---|---|---|
| 1 | **中** | 文档 `n = 26/25` 是**记录条数**，含 5 条失败重跑。独立样本是 **23/23** | `AB-PROMPT-RESULT.md` 第二轮结论表 |
| 2 | **中** | 「处理瓶颈 64%」实际是「碰了切割产能」。若要求加在**原料段**上（16 条里有 **7 条加在了已切好的产品上**，会产生相反的 `----RuRu`），只有 **9/23 = 39%**，p 从 2.9e-07 降到 **1.5e-3** | 同上 |
| 3 | **中** | 「落 cutter p=1.03e-06」的分母写成 **`15/10`**，是 `15/25` 的笔误 | 同上 |
| 4 | **低** | 「误判 14/26 vs 5/25」用的是**存盘旧判据**；按 `arms.mjs` 注释要求的"当前判据重判"应为 **11/23 vs 3/23（p=0.023）**，方向不变 | 同上 |
| 5 | **低** | 「V2 场景已自洽」不成立：`delivered_slices` 两片各 30（共 60）与 `delivered_per_sec: 0.5` 矛盾（按 60s 是 1.0/s，按 2×10s 是 3.0/s）。`v2.mjs` 只修了 `produced_total` | `.tmpverify/capacity-scenario.json` `production` |
| 6 | **低** | `arms.mjs:judge()` 的 `String(a.machine)` 对 `machine:{kind:"cutter"}` 形态漏判（本例被 `says_add_cutter` 兜住） | `.tmpverify/ab-capacity/arms.mjs` |
| 7 | **低** | 吞吐公式的 `×2` 是 `beltSpeedItemsPerSecond`，不是"两个输出口"。`0.5/s` 是 charges/s（出最多 1 件/s）——需在事实 3 的表述里点明，否则与"1 件/charge"读起来矛盾 | 事实 3 表述 / `rules.mjs:45-56` |
| 8 | **中（非本三条）** | `capacityOf` 把 `painterDouble` 产能**高估 2 倍**（`RATES` 已是出件率，又乘了 `PRODUCT_PER_CHARGE=2`）。cutter / rotater / stacker / painter 不受影响，逐个实测过 | `assess.mjs:236` + `rules.mjs:42,109` |
| 9 | **中（非本三条）** | `capacityOf` 遇到 `type:"painterQuad"` 会 **`TypeError`**（`machineRatePerSec` 返回 `null`，然后 `.toFixed`）。实测抛错。当前桥大概率不这么报，但 `MACHINE_UPGRADE_LINE` 已登记它 | `assess.mjs:214,236` |
| 10 | **中（非本三条）** | `mixer` 的 0.4 是**色/s**，却与形状/s 的供给一起进 `Math.min` 比瓶颈 —— 不同量纲直接比较 | `assess.mjs:248` + `rules.mjs:98,109` |
| 11 | **低** | `rules.mjs:324` 的 `excludePrevious ⇒ break` 在扩到 T4+ 时会让后续档位**整体缺失**；`regular.js:193,200` 的 processors 第 6/7 档就带这个标记。注释只写了"T4/T5 是已知边界"，没点名成因 | `rules.mjs:322-324` |
| 12 | **低** | `contract.mjs:1387` 的 `----CuCu` 例子与同句的 `wasteRoles=["left"]` 放在一起容易被读成"left 永远是废料" | `contract.mjs:1387-1392` |
| 13 | **低** | `G_IS_STANDALONE` 由构建配置注入，源码树里查不到值 ⇒ "difficulty=1" 无法从源码单独证实（只能证伪） | `regular.js:380-388`、`rules.mjs:173-174` |

## 我为验证做的复算脚本（未提交，仅供参考）

`/tmp/mine.mjs`、`/tmp/mine2.mjs`、`/tmp/variants.mjs`、`/tmp/upg.mjs`、`/tmp/diff.mjs`、
`/tmp/topo.mjs`、`/tmp/strict.mjs`、`/tmp/quad.mjs`、`/tmp/judge_now.mjs`。
全部是"读源码文本 / 读原始 JSON → 独立重算"，**不 import 被验证对象的核心函数**
（`upg.mjs` 连 `findNiceIntegerValue` 都是逐字照抄源码，不 import `rules.mjs`）。
