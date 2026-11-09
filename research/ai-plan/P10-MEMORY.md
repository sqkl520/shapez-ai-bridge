# P10 —— 跨 run 记忆：让模型不再每次从零开始

日期：2026-11-03
前置：P8（度量）、P9（回滚）。这一轮把「试过什么、结果如何」跨 run 传下去。

---

## 0. 起点：8 次 run 里 6 次 `goal_delta = 0`

复盘数据：同一批宏在同一个诊断指纹下反复重试，实体数不变。
已有的机制（`st.fpSeen` / `mustChange` / `## LAST ROUND`）全都在 `runLoop`
的局部作用域里，**run 结束就没了**。

---

## 1. 两条必须守住的分组

### 1.1 按 `goal_shape` 分组

level 5 的 `Cu----Cu` 经验对 level 6 的 `Cu------` **是误导**。
用户贴图那次的成因就是这个：世界升到 level 6，旧产线没拆，变成 41% 死带子。
记忆若不分组，模型会拿旧关卡的成功经验在新关卡上重演一遍。

### 1.2 按 `world` 隔离（红队加的）

**同一个目标形状可能出现在完全不同的世界里**：离线 L4 夹具（无 seed）、
真机存档（另一个 seed）、同一个 `runDir` 跑过的不同实验、被 `new_game` 重开过的同关卡。

拿离线夹具上「`remove_run` 被撤销」的负例去指导真机，会堵死一个在那里本来正确的动作。

`worldKeyOf()` 的取值顺序：`seed:<n>`（真桥 `world_info`）→ `world_key`（离线夹具名）
→ `hubuid:<uid>|L<level>` → `unknown`。
**绝不能用 uid 集合或实体数**：它们每次 tx 都变，用它们当 key 会让记忆跨不过一次 run。

---

## 2. 记什么（只记有信息量的）

| 结果 | 记？ | 理由 |
|---|---|---|
| `reverted`（被系统撤销） | ✅ 最硬 | 机器判定 + 实际执行 + 验证通过 |
| `regressive`（把世界改坏） | ✅ | 负例，可能是施工中途 |
| `inert`（世界没变） | ✅ | 「等于没做」，比犯错更浪费 |
| `positive`（交货） | ✅ | 正例 |
| `cleanup`（删死带子等） | ✅ | 正例 |
| `constructive` / `churn` | ❌ | 绝大多数中间步骤的正常形态，是噪音 |

**不存 uid / 坐标**：`restoreNextUid` 只在安全时才回收，uid 会变，存它等于存过期指针。
只存宏名 + 动作集哈希 + 少量世界标量。

---

## 3. 三个只有读代码才能发现的时序陷阱

### 3.1 净效果与动作**错开一格**

```
round N-1：plan → tx（动作发生）
round N  ：轮首 observe → classifyNetEffect，push netEffects[{round: N}]
```

所以 `round: N` 的净效果描述的是 **round N-1** 那套宏的结果。
`final:true` 的收尾观测是唯一例外。

按 `byRound.get(e.round)` 直接取，会记出「A 动作 → B 动作的结果」——
**那比没有记忆更糟**，它教模型一个错误的因果。

### 3.2 `roundCalls` 必须在 tx **成功之后**才 push

初版放在 plan 全绿后、tx 之前。于是 dry_run / BUDGET_TX / tx 失败回滚
这些「一个 op 都没落地」的轮次也留下记录，而下一轮的净效果会被归因到
那套**从未执行**的动作 —— 记忆里出现「`remove_run` 让世界没变化」这种假因果。

修法：挪到 `st.worldTouched = true` 之后（它只在 `applyVerdict.ok` 后置位）。

### 3.3 `actionSetHash` 只哈希宏名 ⇒ key 会撞

「第 1 轮 `replace_run`」与「第 2 轮又 `replace_run`」是同一个 `action_set`。
收尾观测与正式观测撞 key 后，后写的 `inert` 会把真实的 `regressive` 洗掉。

修法**不是**「无脑跳过 final」（那会丢掉「正式 inert、收尾 regressive」这种更硬的结论），
而是**按硬度合并**：

- 同 key 有正式观测时，收尾读数只有在**更硬**时才采用；
- `mergeMemory` 里 `kind` 保留最硬的那个，同时用 `last_kind` / `n` 记下最近一次与次数。

prompt 里因此会印 `[seen 3×; most recent: changed nothing]` ——
既守住负例，又不让旧结论永久冒充现状。

---

## 4. 出闸消毒（红队抓到的一个真漏洞）

`why` 抄自 `netEffects[].why` 与 rollback 的 `restore_why`，后者可能含 mod 报错里的
`JSON.stringify(errors[0])` —— 形状是 `"uid":10143` / `"x":5,"y":-3`，
**现有的 `sanitize` 认不出来**（它只认 `uid 123` 与裸 `[-3,5]`）。

一旦写进 `attempts.json`，下次 run 就会把坐标带进 prompt，坐标系防火墙当场破功。
所以记忆在**落盘之前**就自己清一遍（`safeWhy`），不依赖 prompt 那层兜底。

同时 `macros` 走白名单正则、`loadMemory` **逐条** `normalizeEntry` ——
一个「合法 JSON + 正确版本」但内层畸形的文件（`[null]` / `{macros:"x"}`）
不许把一次正常 run 变成 `error`。

---

## 5. 离线 vs 真机的身份

`FakeGame` 新增 `fixtureWorldKey`（`fixture:<文件名>`）与 `worldInfo()`。
**故意不返回 seed**：夹具没有真实 seed，编一个会让记忆误以为它属于某个真世界。

⚠️ e2e 测试里有个坑：写成 `reader: l4().reader(), game: l4()` 会创建**两个**实例，
写面改 A、读面读 B —— 世界永远不变，每条 netEffect 都是 inert，
用例实际测的是「什么都没发生」。必须用 `mkGame()` 返回同一个实例。

---

## 6. 测试

| 文件 | 条数 | 钉住什么 |
|---|---|---|
| `loop/memory.test.mjs` | 40 | 轮次错开一格；final 合并规则；world 隔离；消毒；内层畸形；硬负例保护 |
| `loop/memory.e2e.test.mjs` | 11 | 落盘位置；halt 也写；第二次 run 读到；换 goal 看不到旧记录；单条也渲染 |

全量 `node --test src/agent/`：446 → **497 全绿**。

---

## 7. 下一步

1. **关卡变更检测**：`goal_shape` 变了就把旧产线的可达率算出来，判 `OBSOLETE_LINE`，
   让模型先拆再建。（用户贴图那次的直接成因）
2. **`connect` 的路径搜索**：撞到第一个冲突就放弃是「一坨玩意」的另一成因 ——
   14 个空 hub 入口它看不见。
