# P4 结果：`remove_machine` —— 铜线第一次真的跑起来

> 2026-11-03。上一轮加了 `$ore`，矿机能落到铜矿上了。这一轮解决它落地之后
> 暴露的那一连串结构缺口，**最终让 `mine → cut → rotate` 整条链真正跑起来**。

---

## 一、上一轮的成果是个孤岛

`$ore` 把矿机放到了铜矿格 `(-9,3)`。但一看周围：

```
3×3 邻域全是空格
```

矿机在挖铜，但它**的输出无处可去**。想接上，三条路全堵死：

| 尝试 | 结果 |
|---|---|
| `insert_machine` 在 cutter 输入口那格 | `blocked_by_machine`（"机器永远不会被覆盖"） |
| `connect` 铜矿机 → cutter | `occupied`，撞 `trash@(3,-18)` |
| 同上，但先把 trash 算掉（离线模拟） | **还是撞 `rotater@(5,-18)`** |
| `max_cells` 提到 3000 | 一样 —— `connect` 在**第一处冲突就放弃**，不做绕路搜索 |

### 真正的源头

那台挡路的机器正是问题本身：

```
miner uid=10553 @(4,-16)  脚下没有矿（7×7 邻域一格都没有）
cutter uid=10510 @(4,-17) 输入槽朝下，正好被那台矿机占着
```

一台**永久零产出**的矿机，占着整条铜线唯一的入口。

而**没有任何宏能移除一台机器**。`remove_run` 明确只处理带子
（"要删机器是另一个动作"），但那个"另一个动作"一直没被实现。

---

## 二、新宏 `remove_machine`

### 三个专属错误码，各自对应一种「不该删」

| code | 含义 | 为什么单独一个码 |
|---|---|---|
| `immutable` | 目标是 hub | 删了这一局就终结 |
| `not_a_machine` | 那是带子 | 应该走 `remove_run`，hint 直接指过去 |
| `would_starve` | 它正在给下游供料 | 删了会饿死别人，要显式 `allow_unwired` |

合并成 `precondition_failed` 会让调用方无法分诊 —— 这三种情况的正确下一步完全不同。

### 供料判定：用现成的，别自己算

第一版我自己写了端口几何：

```js
const cell = q.outCell || q.cell;        // ← q.outCell 这个字段不存在
```

改成手算：

```js
const d = DIRV[q.face] || [0, 0];
const cell = [q.cell[0] + d[0], q.cell[1] + d[1]];
```

**还是错的。** `accept` 端口的 `cell` 是「它从哪格收货」，不是「它朝向哪一格」——
这个语义 `outLinkOfPort(q, ctx)` 早就处理掉了。直接用它：

```js
let link = outLinkOfPort(q, c0);
if (!link || link.type !== "machine") continue;
starved.push({ machine: p.uid, feeds: link.uid, cell: q.cell });
```

重写第二遍才想起先找现成实现 —— 这个教训值得记：

> **写端口/几何相关的逻辑之前，先 grep 一遍 `outLink` / `inLink` / `boundBeltOf`。
> 这个仓库里端口的四元语义（cell / slot / face / vel）已经有过一次血泪史。**

---

## 三、三处「闭集」必须同步

加一个宏不只是写一个函数。这次动了：

| 位置 | 内容 |
|---|---|
| `MACRO_SPECS` / `MACRO_VALIDATORS` / `MACRO_NAMES` | 契约 |
| `MACRO_FNS` / `REMOVE_MACROS` / `collectPlaces` | loop 与 planToTxOps |
| prompt 的 `MACRO_EXAMPLES` + 规则 3 的宏名单 | 规则 3 是 `MACRO_NAMES.join(", ")` **自动生成**的，`RULES_BEFORE` 快照必须跟上 |
| 4 个测试里的硬编码数字 | `MACRO_NAMES.length === 6` 之类，分散在 4 个文件里 |

**「宏名数量」这个数字被硬编码在 5 个地方**（`contract.mjs` 自测、`contract.test.mjs`、
`prompt.test.mjs`、`llm.test.mjs`、`loop_pipeline.test.mjs`）。这是真实的技术债，
但不在这一轮范围内 —— 记在这里。

---

## 四、可发现性：候选池里从来没有这个宏

宏写好了、注册好了，模型还是不用。查 transcript：

```
r1 candidates: ["replace_run","insert_machine","connect"]
r2 candidates: ["replace_run","insert_machine","connect"]
```

`remove_machine` **压根不在候选池里**。根因在 `loop.mjs` 的 `MACRO_REFUSED`：

```js
candidates: ["connect", "remove_run", "insert_machine", "trash_unused", "replace_run", "extend_line"],
```

恒定 6 个。改成按错误码分流：

```js
candidates: (e.code === "blocked_by_machine")
    ? ["remove_machine", "replace_run", "insert_machine", ...]
    : [...原来那 6 个],
```

改完下一轮模型就用上了 `remove_machine`（写成了 `{target:{...}}` 而不是
`{uids:...}`，被 `unknown_field` 拒 —— 那是采样波动，卡片里明明写着
`uids:Uid[]` 和 `$uids` 的示例）。

---

## 五、真机验证：铜终于产出来了

```
起手 63 实体，无矿矿机占着 cutter 输入口

拆掉它            → ok（allow_unwired=true，带 starves_downstream 警告）
connect 铜矿机→cutter → **成功 32 格**      ← 之前被那台机器挡死
planToTxOps        → 35 ops
dry_run            → 35/35 可执行
真跑               → applied=35

跑 3000 tick：
  跑前 {"RuRuRuRu":91, "CuCuCuCu":3}
  跑后 {"RuRuRuRu":71, "CuCuCuCu":18, "----CuCu":8, "CuCu----":8, "--CuCu--":6}
```

**三种铜的形状同时出现，正好对应三台机器：**

| 形状 | 数量 | 是谁产的 |
|---|---|---|
| `CuCuCuCu` | 18 | 矿机（在挖） |
| `----CuCu` | 8 | cutter（切了一半） |
| `CuCu----` | 8 | rotater（转过来的） |

`mine → cut → rotate` 整条链**第一次真正跑起来**。

---

## 六、还差一步

铜产出来了，但**还没送进 hub**：

```
delivered: {"RuRuRuRu": 46}        ← 仍然只有钌
stored_delta: 铜相关全是 0
```

rotater 的输出去向还没接通。下一环。

---

## 七、测试

| 文件 | 用例 | 变异测试 |
|---|---|---|
| `remove_machine.test.mjs` | 12 | 4 个全部被抓到 |

变异：允许删 hub / 允许删带子 / 默认不判 starve / 放行时不加警告 —— 每个都让
对应的断言变红。

全量 **427/427 通过**。
