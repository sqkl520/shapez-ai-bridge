# 修复 `WORLD_FROZEN` 在 `truncatedPaths` 下的漏报

日期 2026-11-24 · 对应红队条目 `.findings/REDTEAM-WORLD-FROZEN-2026-11-23.md` §5.2
· 只改了 `src/agent/loop/semantic.mjs` + `src/agent/loop/world_frozen.test.mjs`

---

## 1. 复现的原始数字

脚本：每个快照都**真的调 `diagnose()`**（不是自己复刻一遍判据），
`{ recipe: null, tickSincePrev: 40 }`，与 `world_frozen.test.mjs` 的口径一致。
567 个有 `items-last.json` 的 run，0 个异常。

```
research/ai-plan/runs/ 共 575 个 run 目录，567 个有完整三件套
items.truncatedPaths === true          44
  …其中 WORLD_FROZEN 触发             17
WORLD_FROZEN 触发总数                 516
截断 + 触发 + 报的 worst 低于被切部分   10   ← 与红队 10/17 一致
```

`paths.length` 在 44 个截断快照里**恒为 40**；`pathCount` 分布 41–54。

**最严重的一例** `r-20261113084958-4e86`（pathCount 50 / 返回 40）：

```
报出来的 observed：
  整图零产出；17 条带子满载或无处可去，最堵的一条 31 件 / 19 格（100%，RuRuRuRu×31）

被切掉的部分：
  path 49 一条就有 166 件
  40–49 这 10 条路径合计 277 件（其中 3 条有货）
```

也就是说：模型被告知「最堵的是 31 件」，而真正的第一名是它的 **5.3 倍**，
且被切掉的部分里还有两条分别 ≥79 / ≥32 件。方向是最糟的一边（**低估**）。

### 红队 §5.2 的第二半（`PATHS_TRUNCATED` 没进结果）——**在当前 HEAD 上不成立**

红队写「10 个样本的 codes 里都没有 `PATHS_TRUNCATED`」。实测这 10 个 run 的
`transcript.jsonl` 的最新一条 `diagnose.data.codes` **10/10 都含 `PATHS_TRUNCATED`**。
当前 `loop.mjs:4039` 有一条「把 `ob.problems` 并入 `diagnoses`」的逻辑
（`git log -S` 追到 `d8b4acc`，早于红队那次的 HEAD 判定）。
所以「收到一句错的『最堵』却收不到截断警告」这个**双重缺陷**只剩前一半。

⚠️ 但 `PATHS_TRUNCATED` 仍有一个独立的送达问题：`renderDiagnoses` 把 `observed`
截到 120 字符、`handles` 为空、`subject` 是 `-`，整行在真机 prompt 里几乎是噪音。
本次**没有**动它（不在任务范围，且它已经被验证会进 codes）。记录在此以免下次重复调查。

### 一个额外发现：`clogged_paths` 也是下界

`clogged` 只在可见的 40 条里筛，所以截断时 `evidence.clogged_paths` 少报。
该字段没有消费者（`grep` 过 `prompt.mjs` / `loop.mjs` / `memory.mjs` / `handles.mjs`），
本次只在 evidence 里补了 `paths_shown` / `paths_total` / `paths_truncated` 让读者能自行判断。

---

## 2. 选了哪个修法，为什么不是另外两个

**选 B（纯判据层），并且比 B 多做了「把漏报的量算出来」。** 没有动 mod。

### 为什么不选 A（让 mod 按货量排序后再截断）

三条理由，第一条就足以否决：

1. **会破坏 `belts[].path` ↔ `paths[]` 的下标对齐。**
   `belts[]` 里的 `path` 是**原始下标**（`shapez-ai-bridge.js:1082` 的
   `for (let pi = 0; pi < paths.length; pi++)`）。如果 `paths[]` 改成「按货量降序取前 40」，
   那么 `paths[k].cells` 就不再对应 `belts[].path === k`，
   而 `gates.mjs:1384-1405` 的流向判据正是靠 `items.paths[loc.pi]` 反查格子。
   红队 §5.1 核过的「523/523 对齐」会当场失效 —— 用一条判据去换另一条判据，
   而这个仓库刚刚为「端口占用口径必须抄 connect」付过一次代价。
2. **`belts[]` 本来就全量，排序是多余的。** 被切部分的货量**已经拿得到**——
   只是旧代码没想到用它。改排序不是「拿到了新信息」，而是「换了个摆放方式」。
3. **改 mod 要重新 patch 游戏，当时 `mod_connected: false`，无法真机验证。**
   本项目有「算出来 ≠ 送到」「测试全绿真机无效」两条硬教训；一个改 Protocol
   契约的 40 条排序规则，靠离线推理没有任何办法证明它在真游戏里不改变别的读取面。

### 为什么不选 C（A + B）

C 的唯一增量是 A，A 的三条问题一条都没解决。且 A 与 B 组合后，
「最堵」在截断时仍然不成立（因为**排序后的前 40**依旧不是全部），
B 的警告还得留着 —— 也就是说 C 付出了重 patch 的代价，却没换掉任何一句必须说的话。

### 为什么 B 要「多算一笔」

红队给的候选 B 是「仍然漏报，只是不再撒谎」。这不完整：`observed` 如果只说
「可见的 40 条里最堵」，模型会读成「世界最堵 = 31 件」—— 它没有理由去怀疑。
本项目反复出现的失败模式是「错误的指路比不给更贵」。

所以做了**可验证的部分**：`belts[]` 不按路径截断，所以被切部分的货量是**数得出来的**：

- 口径核对：566 个快照、**16828 条路径**上，`belts[].path` 的行数
  与游戏自己报的 `paths[i].itemsOnPath` **零失配**（0 个快照、0 条路径不一致）。
  所以这个数不是从几何推的，是数出来的。
- 它是**下界**（`belts` 受 region 过滤）：文案一律用「至少」，
  evidence 字段直接命名成 `hidden_items_at_least`。
  核实：44 个截断快照里，「被切路径上的 belts 落在 region 外」的有 **0** 个 ——
  即在这批数据上它实际是精确值，但代码不依赖这一点。

于是 `observed` 从「一句错的断言」变成「一句带作用域的断言 + 一个漏报量的下界」：

```
整图零产出；可见的 40/50 条路径里 17 条满载或无处可去，可见最堵 31 件 / 19 格（100%）；
另有 10 条**未返回**，至少 277 件货（单条最多 ≥166 件） ——「最堵」只在可见部分成立
```

非截断路径**逐字不动** —— 那 500 个快照上的文案是红队逐字核过的。

---

## 3. 改了什么

### `src/agent/loop/semantic.mjs`（WORLD_FROZEN 段）

1. **新增 `pathsTruncated` / `shownPaths` / `totalPaths` 与隐藏部分的统计**
   （`hiddenPathsWithItems` / `hiddenItems` / `hiddenMaxItems` / `hiddenMaxPath`），
   数据源是已有变量 `perPath`（由全量 `itemsDoc.belts` 聚合），无新增 IO。
2. **截断判据取两者之或**：`itemsDoc.truncatedPaths === true || totalPaths > shownPaths`。
   后者是旧式只比数字 —— `truncatedPaths` 为 true 而 `pathCount` 缺失时它会漏判，
   而那正是「证据不全却断言最堵」的情形。
3. **`observed` 分两支**（见上）。截断支牺牲 `item_mix`（已在 `evidence.worst.item_mix` 留档），
   把字符预算留给必须到达的数字。原因：`prompt.mjs:renderDiagnoses` 对 `observed`
   做 `compact(…, 120)`；第一版 126 字符的文案渲染成「… —— 真正的「最堵」可…」，
   **警告本身被切掉了**。这是 `hint-truncated-before-arrival` 的同一形态，所以钉了长度。
4. **`hint` 的截断警告放在 180 字符之后**。`prompt.mjs` 对普通 hint 做 `clip(…, 180)`，
   前 180 必须留给 `REDTEAM B1` 用 516 个样本换来的定位（「这是结果，不是成因 / 先去修上面那些」）。
   实测截断样本上「先去修」出现在第 100 字符，仍在窗口内。
5. **`evidence` 新增** `paths_shown` / `paths_total` / `paths_truncated` /
   `hidden_paths_with_items` / `hidden_items_at_least` / `hidden_worst_items_at_least` /
   `hidden_worst_path`，以及 `evidence.worst.scope: "visible" | "all"`。
   旧字段一个都没删、没改名。

`itemsDoc.paths` 在语义层**只有这一处**消费者（`grep` 确认），所以改动面封闭。

### `src/agent/loop/world_frozen.test.mjs`（原有 10 条未动，新增 6 条）

| # | 测试 | 钉住什么 |
|---|---|---|
| 1 | 截断时不许把可见最堵说成全局最堵 | `observed` 不含「最堵的一条」、必须含「可见」/「未返回」/「至少」 |
| 2 | 被切部分的货量必须真的算出来 | `paths_shown=40 / paths_total=50 / hidden_worst_items_at_least=166 / hidden_worst_path=49 / hidden_items_at_least=277`，且 `166 > worst.items(31)` |
| 3 | `observed` 必须在 120 字符内 | 长度 ≤120，且 `40`/`50`/`166` 都落在前 120 字符 |
| 4 | 非截断时文案与作用域都不变 | 仍含「最堵的一条」、不含「未返回」、`scope==="all"`、`hidden_items_at_least===0` |
| 5 | 截断时 hint 的处方仍在 180 内 | 前 180 含「先去修」；截断警告也在 hint 里 |
| 6 | 被切部分无货时不许编造 | `r-20261115225425-cc9b`（41 条返回 40、被切那条无货）：说「无货」、不说「至少 N 件」、仍标记截断 |

夹具都是 `research/ai-plan/runs/` 里的真机快照，缺失即抛（不 skip）。

---

## 4. 测试结果

```
$ node --test src/agent/loop/world_frozen.test.mjs
  tests 16 / pass 16 / fail 0 / skipped 0        ← 10 原有 + 6 新增，全绿
```

全量（改动前基线，同一条命令）：

```
$ node --test src/agent/
  before : tests 773 / pass 741 / fail 28 / skipped 4
  after  : tests 799 / pass 767 / fail 28 / skipped 4
```

失败集合用 `diff` 逐条比过：**IDENTICAL**（28 条一个不差，都是既有失败）。

> 注：期间有一次全量跑出 `fail 29`，多出的是 `prompt.test.mjs` 的两条
> 「换目标 RuRu---- ⇒ 配方跟着变」。单独跑该文件**通过**；同一时刻
> `git status` 显示 `structural.mjs` / `verify.mjs` / `prompt.mjs` / `loop.mjs`
> 有**别人**的改动（本次只动了 `semantic.mjs` 与 `world_frozen.test.mjs`），
> tests 总数在那几次运行里从 779→792→799 变化。重跑后回到 28 且失败集合与基线一致，
> 判定为并发编辑的瞬时状态，与本改动无关。

---

## 5. 反证（本次修法可能引入的新问题）

### 反证 1：下界被读成精确值，模型据此低估

**已查。** 文案三处都写「至少」；`hidden_items_at_least` 这个**字段名**本身就带边界；
`hiddenWorstItems` 用 `≥`。另外实测 44 个截断快照上「被切路径的 belts 落在 region 外」
= **0** 个，所以这批数据上下界与真值相同 —— 但代码不依赖这一点，
改成任意 region 也不会说出比真值大的数（只会少说）。

### 反证 2：`perPath` 用的是 `belts[]`，而它可能漏掉「在路径上但被挡住」的货

**已查，这条不是新风险而是既有口径。** `WORLD_FROZEN` 原本就用 `belts[]` 数
`stat.n`；红队 §B3 已经核过它的容量公式。16828 条路径上与游戏自己的
`itemsOnPath` 零失配，说明这个口径在真游戏上是准的。
本次没有引入第二个口径 —— `hidden*` 复用同一个 `perPath`。

### 反证 3：截断文案变长，把 `PROMPT_OVER_BUDGET` 推过线

**已查，这是本次唯一真正踩到的坑。** 第一版 126 字符、`observed` 被 120 字符闸门切掉，
警告没到模型眼前（后面的测试 3 就是钉这个）。压到 109 字符以内后，
在 17 个截断触发快照上实测最大 `observed` 长度 109 ≤ 120。
但**总预算**是另一件事：`r-20261113084958-4e86` 的真机 prompt 是 15647–15969 字符
（`transcript.jsonl` 的 `propose.data.prompt_chars`），逼近 16000 的软上限。
截断分支是**替换**（不是追加）原有的 `item_mix` 那一段，净增量约 +30 字符；
非截断分支逐字不动（500 个快照零增长）。所以它没有改变任何快照的预算档位，
但这条诊断本来就贴着预算跑 —— 若后续再往 `observed` 里加字，必须重新量这个数。

### 反证 4：`truncatedPaths === true` 但 `pathCount === paths.length`（自相矛盾的输入）

**已查并已处理。** 判据取「任一为真」，此时按截断处理，`totalPaths - shownPaths` 为 0，
文案会读成「另有 0 条未返回」——措辞不优雅，但**不会**造成假绿或假红：
它仍然不断言全局最堵，且 `hiddenItems` 为 0 时走「其中无货」分支。
mod 在 `paths.length > 40` 时才置 `truncatedPaths`、`pathCount = paths.length`（全量），
两者不会真的矛盾；这是纯防御。

### 反证 5：改动会不会影响别的诊断

**已查。** `itemsDoc.paths` 在 `semantic.mjs` 只有 WORLD_FROZEN 一处消费者；
新增的局部变量作用域都在那个 `if (prod && !anyProduced && windowReady)` 块内；
`evidence.worst.scope` 是新字段，`evidence.worst` 的既有消费者只有测试与
`world_frozen.test.mjs`（`grep` 过 `prompt.mjs` / `loop.mjs` / `memory.mjs` / `handles.mjs`）。
全量测试 28 条失败集合逐条 diff 一致，是这条的独立证据。

---

## 6. 没做的事（明确边界）

- **没有改 `src/mod/shapez-ai-bridge.js`。** 所以不需要重新 patch 游戏，
  对**已加载的存档**没有任何影响（改动全在 Node 侧诊断代码）。
- 没有处理 `PATHS_TRUNCATED` 自身的渲染送达问题（见 §1 末）。
- 没有把「最堵」升级成「按货量给前 k 条」——那要碰 `LIMITS.TOTAL`/prompt 预算，
  且 `WORLD_FROZEN` 的定位是警报不是施工图（`REDTEAM B1`）。
