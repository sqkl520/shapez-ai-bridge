# 模型为什么反复去 `connect … C4.upper`？

2026-11-25。**全程离线**，没有碰游戏（另一个 agent 独占），没有改 `src/`。
临时脚本在 `.tmp-c4/`，跑完删掉。

数据来源：

| 来源 | 内容 |
|---|---|
| `research/ai-plan/runs/r-20261123235846-de15` | 真机 run，3 轮（10:00 上下文里被引用最多的那一份） |
| `research/ai-plan/runs/r-20261124090316-0c8d` | **修复之后**的真机 run（11-24 17:12，HEAD `185d06b`） |
| `.findings/data-EXISTENCE-WORLD-FROZEN/llm-samples.json` | 192 条真调 LLM 样本（四臂 A/B/C/P × 48），同一份 L12 世界 |

---

## 一句话结论

**先说三件被证实的事，再说根因。**

1. **修复生效了，但它对这个 prompt 的净效果是 2 行、0 个 `C4.*` 字面量。**
   `B90 → 下游=C4.upper`、`B133 → 下游=C4.lower` —— 现在是对的（`handles.mjs:645` 修好了）。
   但这**两条带子根本不在 prompt 里**：`## BELTS (17 of 699)` 那 17 条里 B90/B133 一条都没有。
   所以「改对 `desc`」这件事，在**送达端等于没改**。这是 `computed-but-never-delivered` 的第 N 次复发。

2. **模型不是从 `desc` 得出「upper 空着」的 —— 它是从「handle 顺序」猜的。**
   `## MACHINES` 那一行确实写着 `输入=lower@bottom(←B133)/upper@bottom(←B90)`，
   两个槽都标了「已接」。但模型 83 次指向 C4 的调用里 **77 次选 `upper`、0 次选 `lower`、6 次没写 port**，
   而 `lower` 才是真正缺的那个槽。**它不是在读「哪个槽空着」，它是在按顺序取最后一个。**

3. **真正该修的是：`MACHINE_STARVED` 知道缺的是 `lower`，但在送达模型之前把角色名丢了。**
   `semantic.mjs:3952-3956` 的 `evidence.starved[]` 只保留 `missing_cells`（坐标），
   **没有保留 `role`**；`observed` 里也只写 `缺 [-2,6]`，而这个坐标会被 `sanitize()` 打成 `缺 [<coord>]`。
   `d.slot` 这个字段（`prompt.mjs:2803` 专门为渲染 `@role` 准备的）**从来没被 `MACHINE_STARVED` 填过**
   —— 全 run 的 24 条诊断里 `.slot` 出现 **0 次**。

**根因一句话：诊断算出了「缺 lower」，送到模型眼前时只剩「这台机器缺进料」；
模型只能靠猜，而它猜的顺序偏好是 `upper`。**

---

## 1. 修复到底生效没有？

### 生效了（在句柄表这一层）

用 `r-20261123151728-52a3` 的 obs+items 建表：

```
B90  => B90  belt 上游=B89.out  下游=C4.upper 货=259 段=165
B133 => B133 belt 上游=B132.out 下游=C4.lower 货=0   段=16
C4   => C4 stacker 输入=lower@bottom(←B133)/upper@bottom(←B90) 输出=out@top(→B134) port=out in.port=lower|upper
```

对照**修复前**的 `handles.mjs`（`git show f30bcdb~1`，把依赖按相对路径摆好再 import）：

```
B90  => B90  belt 上游=B89.out 下游=C4.lower 货=259   ← 错（真值 upper）
B133 => B133 belt 上游=B132.out 下游=C4.lower 货=0    ← 这个才对
C4   => C4 stacker 输入=lower@bottom(←B133)/upper@bottom(←B90) ...   ← 机器那行**修复前后一模一样**
```

**注意最后一行**：`## MACHINES` 里的 `C4` 那行在修复**前就已经是对的**
（它走的是 `slotsOf()` 枚举，不是 `slotRoleAt()` 的 `find` 短路）。
修复改的只有 `## BELTS` 段里那两条带子的 `下游=` 标注。

### 但它没送到 prompt 里

用 `buildPrompt`（参数照 `loop.mjs:4265` 的真实调用，`prompt_tokens_max: 5300`、`in_chars_max: 24000`）
重建 `de15` 第 2 轮的 prompt，然后数：

```
C4.upper 出现次数: 0
C4.lower 出现次数: 0
## BELTS 段里出现 "C4." 的行数: 0
```

**两路都被修对了，然后两路都没进 prompt。**

为什么：`## BELTS` 只列 `STATE_BELTS_MAX = 12` 条（+诊断点名的追加位），
选择顺序是「目标走廊 > 诊断点名 > 表顺序」。B90/B133 既不在目标走廊上、
也没被任何诊断的 `evidence.handles` 点到（`MACHINE_STARVED` 的 handles 只有 `["C4"]`），
于是掉到「表顺序兜底」那一档 —— 699 条带子里排在第 90 和 133 位，永远轮不到。

**修前 vs 修后，同一份 obs 重建的 prompt 逐行 diff 只有 2 行不同**，
而且都是 `H1.primary` → `H1.{role:"primary", index:N}`（hub 入口索引那次改动），
与 C4 无关：

```
L200  PRE : B135 belt 上游=C5.out 下游=H1.primary 货=0 段=1
      POST: B135 belt 上游=C5.out 下游=H1.{role:"primary", index:1} 货=0 段=1
L201  PRE : B180 belt 上游=B181.out 下游=H1.primary 货=0 段=29
      POST: B180 belt 上游=B181.out 下游=H1.{role:"primary", index:7} 货=0 段=29
```

⇒ **候选 1「修复没送到 prompt」成立，而且比「没送到」更强：这次修复对这份 prompt 的净效果就是 0。**

---

## 2. 重建的 prompt 里所有提到 C4 的原文（逐字）

`r-20261123235846-de15` 第 2 轮。重建长度 18577 vs 实际 `prompt_chars` 18505（+0.4%，
差值来自 `runLog`/`stickyGoal` 的运行时状态，不影响 DIAGNOSIS 段）。

### `## MACHINES (20 of 49)` 段

图例 + `C4` 行（**全文**）：

```
(`(→X)`=taken, `(→无)`=free(use it), `port=a|b`⇒must name one)
C4 stacker 输入=lower@bottom(←B133)/upper@bottom(←B90) 输出=out@top(→B134) port=out in.port=lower|upper
```

`C4` **在**显示的那 20 台里，排第一位。**预算降级没有砍掉它**（`MACHINES_MAX = 20`，
`ordered` 里机器按「有诊断点名的优先」排，`C4` 是 `MACHINE_STARVED` 的 subject ⇒ 第一位）。

另有 10 台矿机带 `· 到C4 N格` 的距离标注（`M1`–`M11`、`M13`–`M16`）。

### `## BELTS (17 of 699; 5 referenced by diagnosis)` 段

**没有一行提到 `C4`。** 全文（17 行）里与 C4 相关的：**0 行**。

### `## DIAGNOSIS (8)` 段 —— `MACHINE_STARVED` 全文

```
1. MACHINE_STARVED [L4/blocker]: C4 (stacker); expected 每台多输入机器（stacker/painter/painterDouble）的每个输入槽都有货; observed 1 台机器缺进料：stacker#14684(1/2，缺 [<coord>]); nearest sources with a free output: C8(mixer, 7格, 造缺失色), C2(cutter, 6格), M4(miner, 8格); handles C4; hint: **1 台机器只吃到一半的料，永远不会产出**，整条链会一起冻死。**从 stacker#14684（句柄 C4）开始**—— 它在缺料机器里最靠**上游**，是这条链的根。把缺的那一路接上：`connect` 到它的缺料口；源头不存在就 `insert_machine`。; candidates connect,insert_machine
```

**逐字要点：**

| 字段 | 模型实际读到的 | 质量问题 |
|---|---|---|
| `subject` | `C4 (stacker)` | ✅ 对 |
| `observed` | `stacker#14684(1/2，缺 [<coord>])` | ❌ **`[<coord>]` 是被 sanitize 打掉的 `[-2,6]`** |
| `hint` | 全文 137 字符（**未被截断**，`clip(180)` 没触发） | ❌ 只说「缺的那一路」，**不说哪一路** |
| `feed_sources` | `C8, C2, M4` | ❌ 这三个是**算给 lower 槽的**，但没说是给哪个槽 |
| `d.slot` | **不存在**（`slot: undefined`） | ❌ `prompt.mjs:2803` 那段 `@role` 渲染永远不会触发 |

`hint` 里的「它在缺料机器里最靠**上游**」是一个**双关**：
「上游」在这里是拓扑位置（upstream），而模型把它读成了 stacker 的 **upper 槽**。

### `## PROGRESS`（GOAL 段）

```
PROGRESS delivered 0/1000 | layers: CbCbCbRb absent · CwCwCwCw absent | pigments on belts: blue 222, white 0 | this goal has NEVER entered the hub
```

（`CwCwCwCw` 是目标的**上层**，`CbCbCbRb` 是**下层**。这段明确写了 upper layer 缺 —— 但它缺的是**右上层的形状**，不是 stacker 的 upper 输入槽。这是一个语义陷阱。）

---

## 3. 模型是从哪句话得出「upper 空着」的？

**结论：它不是从任何一句「upper 空着」的话得出的 —— 没有任何一句这么说。
它是从「两个槽都在 `输入=` 里、`in.port=lower|upper`、而 `lower` 排在前面」按顺序取的后一个。**

证据是 192 条真 LLM 样本（`.findings/data-EXISTENCE-WORLD-FROZEN/llm-samples.json`，四臂 × 48）：

```
目标 C4 的提案： 83 次
  port=upper:  77
  port=lower:   0     ← 一次都没有
  无 port:      6
```

**77 : 0。** 这不是「读错了」，这是**没有可读的依据，只能按顺序猜**。

对照组（同一库里历史上 `lower` 真的空着的时候）：`SLOT_STARVED` 报
`输入槽 lower/upper 无上游`（`r-20261115214352-78ae` R5），模型立刻写了 `port:"lower"` 并落地。
另有 14 个历史样本在 `C9`/`C1`/`C5`/`C6` 上选 `lower` —— **都是那次诊断点名了 lower 的时候**。
⇒ **模型会读角色名；问题是这次的诊断没给角色名。**

### 逐句排除

| 候选句子 | 能不能推出「upper 空着」 | 判定 |
|---|---|---|
| `C4 stacker 输入=lower@bottom(←B133)/upper@bottom(←B90)` | **不能**。这句明说 upper 被 B90 接着 | ❌ 不成立（而且它是对的） |
| `observed …缺 [<coord>]` | **不能**。坐标被打码，且模型根本不知道 lower 在哪个坐标 | ❌ 不成立（但它确实**没提供**任何可用信息） |
| `hint …把缺的那一路接上` | **不能**。只说「那一路」，不给哪一个 | ❌ 不成立 |
| `hint …它在缺料机器里最靠**上游**` | **能，但是误读**。「上游」→「upper」是同形词诱导 | ✅ **部分成立** |
| `PROGRESS layers: … · CwCwCwCw absent` | **不能**。那是目标形状的**上层形状**，不是输入槽 | ❌ 不成立 |
| `OUTPUT_STRANDED: C2 有输出口悬空` | **不能**推出 upper，但它提供了「C2 有东西可给」 | ❌ 不成立（组合起来才是问题，见候选 3） |
| `in.port=lower\|upper`（图例 `port=a\|b`⇒must name one） | **不能**。但它告诉模型「必须从这两个里挑一个」 | ❌ 不成立（但它是**唯一**要求二选一的地方） |

### 真正发生的事（把上面拼起来）

1. 诊断说「C4 缺一路料」→ 模型去看 `C4` 那行。
2. 那行给两个候选：`lower`、`upper`，**都标着已接**（`←B133` / `←B90`）。
3. 图例说 `port=a|b ⇒ must name one` —— 逼它二选一。
4. 没有任何一句说「缺的是 lower」。`missing_cells` 是坐标，坐标被打码。
5. `hint` 里「最靠**上游**」是它唯一能抓的线索 —— 而 `上游` 和 `upper` 在中文模型里高度混淆。
6. 于是它取**最后一个**（`upper`），并且自己在 `why` 里把它复述成
   「its upper input is the missing feed」（de15 R2 原文）—— 它**以为**自己读到了这个事实。

`why` 的用词分布（77 条 upper 样本）：

```
提到 "upstream / 上游"              44 / 77
提到 "upper" 字面                   18 / 77
提到 "starved / 缺料 / 饥饿"          55 / 77
提到 "white / 颜色 / pigment"         4 / 77
提到 "layer"                         0 / 77
```

⇒ **模型脑子里装的是「上游」(upstream)，写出来的 `port` 是 `upper`。这两个词在这份 prompt 里
只差两个字母，而 prompt 里同时出现了 44 次「上游」和 1 次「upper」。**

---

## 4. 三个候选根因的判定

### 候选 1：`slotRoleAt` 的修复没进 prompt —— **✅ 成立（强于原判）**

- `B90 → C4.upper`（修复后）/ `下游=C4.lower`（修复前）—— **句柄表层修对了**
- prompt 里 `C4.upper` 出现 **0 次**、`C4.lower` 出现 **0 次**
- `## BELTS` 段里 `C4.` 出现 **0 行**
- 修前 vs 修后 prompt 逐行 diff：**只有 2 行不同，都与 C4 无关**

⇒ 修复对象（`## BELTS` 的 `下游=`）**根本没被渲染**。
「修了但没送到」是这个仓库最高频的缺陷形态（`computed-but-never-delivered`），这是它的一次教科书式复发。

### 候选 2：`MACHINE_STARVED` 的 hint 在说反话 —— **✅ 成立，但机制不是「说反话」**

不是「说反话」，是「**丢字段**」：

```js
// semantic.mjs:3694/3706 —— 缺的是哪个槽，这里算出来了
const missSlotIdx = target.fed.findIndex(f => !f.ok);
const missRole = (target.fed[missSlotIdx] || {}).role || "";   // ← missRole 算出来了

// semantic.mjs:3952-3956 —— 进 evidence 时只留坐标，role 丢了
starved: starved.slice(0, 6).map(s => ({
    type: s.m.type, uid: s.m.uid, at: [s.m.x, s.m.y],
    fed: s.nFed, need: s.total,
    missing_cells: s.fed.filter(f => !f.ok).map(f => f.cell),   // ← 只有 cell，没有 role
})),
```

`missRole` 被用来**筛源头**（`wantsColor = /color/i.test(missRole)`），
但**没有被写进任何送到 prompt 的字段**。

而 `d.slot`（`prompt.mjs:2803` 的 `@${d.slot.role}` 渲染位）**全 run 24 条诊断出现 0 次**
—— 那个渲染位从造出来那天起就是死代码。

⇒ 诊断「知道」缺 lower，「说」出来的只有「缺料」。中间那一跳掉了。

### 候选 3：`OUTPUT_STRANDED` + `MACHINE_STARVED` 组合诱导 `C2 → C4.upper` —— **✅ 部分成立，但它是「放大器」不是「起因」**

- `OUTPUT_STRANDED`（C2 有输出口悬空）确实贡献了来源端：83 个 C4 提案里 **67 个 from=C2**。
- 但**它不能解释「upper」**。若要解释，必须是「C2 → 某个槽」，而槽的选择仍然是 77 上 / 0 下（其余 6 条没写 port）。
- 而且单独看它：**77 条样本里 0 条说「把 C2 接到 upper 因为 upper 空」**；
  说 upper 的 18 条里，理由全是 `starved stacker input`，没有一个引用 C2 的悬空输出作为
  「所以 upper 空着」的推论。

⇒ 组合效应**存在**（两条各自正确的诊断给出了「目标端」+「来源端」），
但**「接哪一路」完全由候选 2 的字段缺失决定**。
把它当独立根因会修错地方。

---

## 5. 一句话结论 + 修法方向

**根因：`MACHINE_STARVED` 算出了缺料槽的角色（`lower`），但只在 `evidence` 里保留了坐标、
没保留 `role`；坐标又被 `sanitize()` 打成 `<coord>`。模型面对 `lower|upper` 二选一时
没有任何依据，只能按顺序/同形词（「上游」→ upper）猜 —— 77 个写了 port 的全是 upper。**

### 修法（一句话）

**在 `MACHINE_STARVED` 的 `subject` 旁边填上 `slot: {role: <缺失的槽>}`，
并让 `observed` 直接写角色名而不是坐标** —— 例如
`stacker C4 缺进料：lower 槽空着（upper 已由 B90 供料）`。

具体三处（任一处都能翻转，建议都做，且互相校验）：

1. **`semantic.mjs:3952-3956`** —— `evidence.starved[].missing` 加 `role`：
   ```js
   missing: s.fed.filter(f => !f.ok).map(f => ({ role: f.role }))   // 只给角色，不给坐标
   ```
2. **`semantic.mjs:3942-3948`（`MACHINE_STARVED` 的 push）** —— 填 `slot` 字段：
   ```js
   slot: { role: target.fed[missSlotIdx].role },     // prompt.mjs:2803 已经在等这个字段了
   ```
   它会在 `1. MACHINE_STARVED …: C4 (stacker) @lower` 里直接渲染出来（**+6 字符**）。
3. **`observed` 去坐标**（顺带**省**字符）：`缺 [<coord>]` → `缺 lower`。
   这段的源码是 `semantic.mjs:3653-3656`（`detail`），它直接 `JSON.stringify(f.cell)` 写坐标，
   正是给 `sanitize()` 白白送掉的 9 个字符。换成 `f.role` 是「更短 + 有信息」。
   同时把 hint 的「最靠**上游**」改成「最靠**上游（拓扑意义上，与 upper 槽无关）**」或者
   干脆换成「链条起点」——**这个词是 44/77 的唯一误读入口**。

**为什么这条优先于「把 B90/B133 塞进 BELTS」**：后者要抢 12 个名额之一（而
`prompt_belt_visibility.test.mjs` 的回归 E 会红），收益是「模型能看见两个槽都被占」；
前者只花 **+6 字符**，直接给出「缺的是 lower」这个结论本身。**给结论比给证据便宜。**

---

## 5b. 独立复核（方法不同、结论相同）

上面第 3/4 节的 77:0 来自对 `.findings/data-EXISTENCE-WORLD-FROZEN/llm-samples.json`
**结构化解析**（读 `args.to.port`）。事后我又跑了一次**完全独立的原始 grep**
（对每个 `transcript.jsonl` 直接数 `"port":"upper"` / `"port":"lower"` 字面量），
两者应当互为对照：

| 组 | run 数 | upper | lower | toC4 |
|---|---|---|---|---|
| **6 个 L12 run**（含修复后的 `0c8d`） | 6 | **10** | **0** | 11 |
| **9 个历史 run**（别的关卡，toC4 = 0） | 9 | 2 | **12** | 0 |

**两条互相印证的结论：**

1. **在 L12 这 6 个 run 里，`lower` 作为 `to.port` 出现 0 次。** 与 192 样本的 0/77 一致。
2. **`lower` 不是模型不会写的词** —— 在 9 个历史 run 里它写了 **12 次**，
   而那 9 个 run 的 `toC4` 全是 **0**。也就是说 `lower` 只在「诊断点名了 lower」
   （`SLOT_STARVED: 输入槽 lower/upper 无上游`）时出现，与 C4 无关。

⇒ 「模型缺的是**事实**（哪个槽空着），不是**能力**（不会选 lower）」这条，
现在有两个独立方法的样本支持。

---

## 6. 反证：我的结论有没有可能是错的？

**可能性一：模型其实读到了 `## MACHINES` 那行，「upper」是它自己的另一套推理。**
有 18/77 条 `why` 字面写了 `upper`，看起来像在读那行。但**如果它读了，它就该看到
`upper@bottom(←B90)` 已经接着 B90** —— 它没看到 —— **192 条样本里提到 `B90` 或 `B133` 的有 0 条**（`grep` 全 192 条 `calls`+`say`）。
更可能的解释是那几个字是从 `in.port=lower|upper` 的第二个词抄的。

**可能性二：因为 `upper` 在这台世界上本来就是「正确的直觉」，只是这个存档里被占了。**
L12 的目标 `CbCbCbRb:CwCwCwCw` 里 `CwCwCwCw` 是**上层**，`CbCbCbRb` 是**下层**。
按「缺什么补什么」，缺上层形状 ⇒ 去喂 stacker 的 upper 槽 —— **这在语义上是通的**。
这条我优先度很高：它意味着那 77 个 upper 里有一部分是**正确的领域推理**落在了错误的槽上
（喂 upper 会得到 `X:CbCbCbRb`，正好反了）。
⇒ 这**加强**而不是削弱我的结论：它说明模型缺的不是「思考能力」，是「这台机器上哪个槽是空的」
这个**事实**。也说明修法 3（把「上游」换成无歧义的词）必须做，否则同形词会一直咬。

**可能性三：换成 `slot` 字段后，模型会不会改成去喂 `lower`，然后撞同一堵墙？**
会撞。实测（`buildTxPlan`，`partial:true`）：

```
C8 -> C4.upper (rebind)  => 拒：交付带子 309→111 (-64%)，死带子 390→584
C8 -> C4.lower (rebind)  => 拒：交付带子 309→276 (-11%)，死带子 390→420
C8 -> C4.lower (no rebind) => 拒：connect:target_already_fed
C2.right -> C4.lower (rebind) => 拒：死带子 390→424 (+34)
```

**喂 lower 也过不了闸门**（-11% 已经超过容忍）。所以这个修法**不会让世界变好**，
它只会把「用一个必拒的动作」换成「用另一个必拒的动作」。
**这一点必须写清楚**：它是「消除 13 个无效动作」的修法，不是「让 L12 通」的修法。
真正的正解（`C8 → C3.color`）**能过闸门**（实测 `buildTxPlan` `ok`），
但它在 prompt 里**从来没有被推荐过** —— `C3 painter 输入=shape@top(←B107)/color@right(←无)`
在 MACHINES 第 8 位（`de15` R2 的 prompt 第 176 行），而 `MACHINE_STARVED` 的 hint 说
「从 C4 开始，它是这条链的根」。**根指错了**：真正的根是 `C3`（painter），
它 0/2 个输入槽有料 —— 而 `MACHINE_STARVED` 的判据刻意排除了「全空」的机器
（`semantic.mjs` 注释：「两路全空是上游没建好，属于 CHAIN_UNFED 的地盘」），
于是**这台真正的根机器一条诊断都没有**。

**可能性四：我的样本来自 `52a3` 那台世界，de15 是不是同一台？**
是。`world_hash` 三个 run 全是 `fnv1a64:b963440bd7629f2a:n=749`，
`C4` 的 uid 全是 14684，槽位坐标一致。192 个样本也来自同一份 obs（`r-20261123151728-52a3`）。

**可能性五：「修复没送到」会不会只是我重建参数不对？**
我核对过三点：① 用 `diagnose` 的**逐字节记录**（不是重跑 diagnosis）；
② 用 `propose` 记录里的 `candidates` 数组（不是重算）；
③ 重建总长 18577 vs 实际 18505（+0.4%）。
另外有一个独立的重建产物（`.tmp-why/r-20261123135733-fe21.txt`，别人写的，17:23）
—— 它的 `## MACHINES` 第 176 行与我的一致，`BELTS` 段同样没有 B90/B133。
**两条独立重建互相印证。**

---

## 附：一条我顺手确认、但**不**构成根因的事

de15 R3 与 0c8d R1/R2 的 `connect C2.right → C4.upper` 撞的不是 `target_already_fed`，
而是 **`PLAN_REJECTED`（预演：死带子 390→568）**。那说明 `opts.rebind:true` 让 `connect`
绕过了「已被供料」的检查，**改成把 B90 拔掉重接** —— 然后预演闸门拦下了破坏性后果。

也就是说这个模型在 R3 已经开始「加 rebind 强行重接」，被闸门救了下来。
**这在数据上是好事**（闸门在工作），但它掩盖了 R2 的真空洞：
R2 那次没有 `rebind`，直接吃 `target_already_fed`，模型学到的教训是
「加个 rebind 再来」而不是「upper 已经被占了」。`LAST ROUND` 段的
`target_already_fed → hint: 换一个 port，或传 opts.rebind=true`
**正是在教它加 rebind**。这条 hint 该改成「**先看 `## MACHINES` 那行：两个槽各自接着哪条带子**」。

---

## 附：本次操作的边界（自证）

- **没有**碰游戏（无 `curl`、无 `load_save`、无 tx apply）。
- **没有**改 `src/` 下任何文件。临时文件全在 `.tmp-c4/`（含从 git 取出的修复前 `handles.mjs` 副本）。
- **没有** `git stash` / `commit` / `push` / `checkout` / `reset`（只用了 `git show` 读历史）。
- **没有**读 `ANTHROPIC_BASE_URL`，没有发起任何 LLM 调用（192 条样本是既有归档数据）。
- 所有结论可用 `.tmp-c4/` 下的脚本复现（`rebuild.mjs` / `diffprompt.mjs` / `plan*.mjs` / `gate.mjs`）。
