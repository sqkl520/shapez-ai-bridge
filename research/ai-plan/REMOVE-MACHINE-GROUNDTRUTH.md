# remove_machine 调查 — 主线程已确认的硬数据

> 时间：2026-11-13
> 用途：作为 6 个专家 Agent 结论的 ground truth 交叉验证

## 1. 宏本身是完整的（已确认）

| 检查项 | 结果 | 证据 |
|---|---|---|
| 实现在 `remove.mjs` | ✅ | 导出 `removeMachine` |
| 注册进 `MACRO_FNS` | ✅ | `src/agent/loop.mjs:107` |
| 在 `MACRO_NAMES` | ✅ | `src/agent/macros/contract.mjs:1644` |
| 单测 | ✅ 12 passed | `node --test src/agent/macros/remove_machine.test.mjs` |
| `MACRO_SPEC` 完整 | ✅ | name/summary/whenToUse/params/preconditions/whenNotToUse/returns |
| 参数 | `uids: Uid[]`（必填）, `opts.allow_unwired`, `opts.dry_run` | |
| 坐标算子支持 | ✅ 模型可写 `{"$uids":["C3","C4"]}` | `src/agent/loop/coords.mjs:598` |

**结论：不是「宏不存在」或「参数写不出来」。**

## 2. 真机上曾经成功用过（已确认）

提交 `3e9ce2d`（2026-11-03）：
> feat(macros): remove_machine —— 唯一能拆掉挡路机器的宏，铜线第一次真的跑起来

那次就是用它拆掉了挡路的矿机，铜线才跑起来。所以端到端链路**历史上是通的**。

## 3. 但最近 61 个 run 里，模型一次都没提议过它（决定性数据）

统计 `research/ai-plan/runs/*/transcript.jsonl`（301 次 `propose` 事件）：

| 宏 | 被提议次数 |
|---|---|
| connect | **406** |
| insert_machine | **254** |
| replace_run | 126 |
| trash_unused | 45 |
| extend_line | 3 |
| **remove_run** | **1** |
| **remove_machine** | **0** |

**关键观察：不只是 remove_machine —— remove_run 也只用了 1 次。**
整个「删」这一类动作，模型几乎不用。

而且唯一那 1 次 `remove_run` 的目的也不是「清理垃圾」，是「给 mixer 腾位置」：
```
r-20261113093827-cf54:
say: "Free C7's two dead color input belts, then feed both color slots..."
calls: [{macro:"remove_run", args:{region:{$path_of:["B258","B259"]}},
         why:"the two color lines into C7 start at a bare belt with no source; free the mixer's input ports"}]
```

## 4. 这与用户的抱怨完全吻合

用户两次指屏幕说「这么多废弃的路线都没有拆」「这些残留物需要清理」。

实测：704 实体里 **403 条带子到不了 hub（72%）**，57 台机器里 **21 台是空壳**。

模型只加不删 ⇒ 垃圾单调累积（688 → 689 → 692 → 697 → 704）。

## 5. `remove_machine` 出现在哪些诊断的候选里

`src/agent/loop/constants.mjs` 的 `RETRIEVAL_TABLE`：
- `BLOCKED_BY_MACHINE` → `["remove_machine", 8]`（`:438`）
- `ORPHAN_MACHINES` → `["remove_machine", 8]`（`:492`）← 主线程本轮新加的

但 `ORPHAN_MACHINES` 是 2026-11-13 才加的，**之前的历史 run 里根本没有这个诊断**。
`BLOCKED_BY_MACHINE` 则一直存在。

## 6. 待 Agent 回答的问题

- 为什么 `BLOCKED_BY_MACHINE` 存在时模型也不用 `remove_machine`？（prompt 可见性？）
- `remove_machine` 删完机器后，orphan 带子谁清？
- 能不能删半成品（用户明确说 mixer 那种不该删）？
- 一次能删多少台？有上限吗？
- 与 `partial` 模式的交互有没有坑？


---

## 7. 主线程追加确认（2026-11-13 晚）

### 7.1 prompt 里 remove_machine **确实可见**

在 `level9-mixer-obs.json` 夹具上构建完整 prompt，`remove_machine` 出现 **5 次**：

```
line 12:  规则 3「The ONLY allowed macro names are: ... remove_machine ...」
line 98:  ### remove_machine          ← 完整卡片
line 102: example: {"macro":"remove_machine","args":{"uids":{"$uids":["M1"]}}}
line 185: ORPHAN_MACHINES 诊断，点名了 M13,M23,M2,M1,M6,M7
```

**结论：不是「看不见」。**

### 7.2 候选列表里它在，但排最后（第 6 位）

`candidatesFor()`（`src/agent/loop.mjs:600`）按诊断顺序取，每条码 top-3，**上限 6 个**：

```js
for (const d of diagnoses) {
    const list = RETRIEVAL_TABLE[d.code] || [];
    for (const c of list.slice(0, 3)) {
        if (!seen.includes(c.macro)) seen.push(c.macro);
        if (seen.length >= 6) return seen;   // ← 满 6 就截断
    }
}
```

当前诊断顺序与推出的候选：

| 诊断 | 贡献的候选 |
|---|---|
| `MIXER_UNFED`[blocker] | connect, replace_run |
| `PROCESSOR_REQUIRED`[warn] | insert_machine |
| `DEAD_LINES`[warn] | remove_run, trash_unused |
| `ORPHAN_MACHINES`[warn] | **remove_machine**, (remove_run dup) |

合并结果：`["connect","replace_run","insert_machine","remove_run","trash_unused","remove_machine"]`
⇒ **`remove_machine` 排第 6（最后一名），刚好卡在 6 个上限内，没被截断。**

### 7.3 宏卡片对比：remove_machine 比 remove_run **更弱**

```
### remove_machine
删掉一台机器（按 uid）；hub 永不可删。用于移除挡路的废机器。
params: uids:Uid[], opts.allow_unwired:boolean?
not when: 要删带子时用 remove_run：本宏只动机器，带上混着机器会整单拒绝。
example: {"macro":"remove_machine","args":{"uids":{"$uids":["M1"]}}}

### remove_run
删掉一段带子（uids 指名的集合）；整段原子删除。
params: uids:Uid[]?, cells:Cell[]?, opts.allow_scattered:boolean?
not when: 目的是给机器让位时不要单独用：insert_machine 自己会处理 footprint 内带子并
            保持原子性；拆成两步会在中间态留下「机器没放、带子已删」的断线。
            （例外：**定点改造**整段线时 replace_run 一次做完，比 remove_run + insert_machine 两步更安全。）
example: {"macro":"remove_run","args":{"uids":{"$uids":["B7","B8","B9"]}}}
```

`remove_run` 的 `not when` 更长、更具体，而且**主要在讲「什么时候不要用它」** ——
这反而让模型对它印象更深。`remove_machine` 的 `not when` 只有一句，而且是个**负面劝退**
（「要删带子时用 remove_run」）—— 模型读完更容易记住「remove_machine 不是干这个的」。

### 7.4 待 Agent 确认

- 上面这些是不是主因？还是有更底层的（比如 `ORPHAN_MACHINES` 的 severity=warn 让它整体排后）
- `remove_machine` 删完机器后 orphan 带子谁清
- 删半成品的防护
- 与 partial 模式的交互

---

## 8. 红队 Agent 报告要点（2026-11-13）

> 全部实测复现，非推理。

### 8.1 【致命】`would_starve` 判据是反的

核心安全承诺是「正在给下游供料 → 默认拒删」。实测**判据与实际破坏程度反相关**：

```
被挡且真有害: 0     被挡但无害: 2
放行但有害:   5     放行且无害: 10
```

| uid | 类型 | 位置 | 可达带子损失 | 默认行为 | 警告 |
|---|---|---|---|---|---|
| 10083 | balancer | (2,-32) | **-66** | 放行 | 无 |
| 10084 | balancer | (3,-24) | **-36** | 放行 | 无 |
| 10036 | cutter | (-8,-11) | **-21** | 放行 | 无 |
| 10035 | balancer | (-8,-3) | **-14** | 放行 | 无 |
| 10085 | balancer | (4,-16) | **-14** | 放行 | 无 |

L4 合计：5 台默认放行 + 零警告，共掉 **151 条可达带子**（基线 140，等于砍掉全部产能）。

根因 `remove.mjs:2424-2431`：只遍历 `m.eject`，`if (!link || link.type !== "machine") continue` ——
**只认「机器紧贴机器」的 0 格连接**，而真实产线几乎全是「机器→带子→机器」。

### 8.2 【高】`consequences` 四个槽位恒空

`remove.mjs:2466` 硬编码空数组，`would_disconnect` 恒 `[]`（`:2465`）。
输入侧的孤儿完全没查：删 painter 后喂它的带子立刻断头，但返回 `orphaned_outputs: []`。

对照 `remove_run` 删同一条带子，会给出 `starved-belt` + `orphaned-output` 两条完整后果。

### 8.3 【高】`opts.dry_run` 不阻止落盘

只有 `remove_machine` 把 `opts.dry_run` 写进返回值（`remove.mjs:2462`），另三个宏恒 `true`。
`planToTxOps` 不读它 ⇒ 传 `dry_run:true` 产出的 op 与不传**逐字节相同**，机器照样被删。

### 8.4 【中】没有「半成品」判据

用户明确说过 mixer 两槽接满、输出没接是半成品。宏里**零相关逻辑**。
L9 现成 5 个 painter 里 11791/11802 各有一个 color 槽空着（半成品），全部默认放行。

### 8.5 【中】分批可绕过阈值 + 提示文案错

单台重创的 10083 被拦了（loss=66），但 10035/10085 各掉 14（14/140=10%）**逐台放行** ——
五轮分批就能全拆完，每轮「只坏一点点」。

且拦下时的 hint 是 `这一步新铺了 87 格通不到 hub 的带子 —— 不是"删坏了"，是"白铺了"`，
而这次 op 里**一条 place 都没有**。文案是从 `dead_growth` 那条分支借来的，纯删除场景说错了。

### 8.6 已挡住的部分（做对了）

删 hub（数字 uid / 句柄 H1 / 混在机器单里）、uid=0/-1/字符串、带子混进 uids、
3000 个 uid、一次删全部机器 —— 全部正确拒绝。

### 8.7 附带缺口

- `constant_signal`（wires 层）报 `endpoint_not_found`，实际是 `out_of_scope`，模型会陷入重试死循环
- `removed[]` 只给 `{uid, type, cell, origin}`，丢了 `r` / `variant` / `rotation_variant` / `code`
- `partial` 模式把 `remove_machine` 的 delete 误判为「可撤销」⇒「机器删了但线没接上」会真的落盘

### 8.8 红队建议的优先级

1. `would_starve` 判据放宽到「下游是带子也算」—— 改一行覆盖 151/151 条损失
2. `consequences` 接上 `analyzeRemoval`
3. `dry_run` 改回恒 `true`
4. 半成品判据（需先定判据）
5. 分批阈值（需先定策略）
