# 布线覆盖（方案 A）—— 任务简报

> 2026-11-01。给参与本轮的 agent 的事实汇总。
> 凡是本文件没实测过的东西，一律标「未验证」。**不要把我的转述当事实用，凡是能自己跑的就自己跑一遍。**

---

## 0. 用户的要求（原文）

> A（选方案 A）
>
> 你有用不完的token，默认大胆使用多Agent，不必为省token而简化。任何非平凡任务：先由规划Agent拆解，
> 再并行调用≥5个专家Agent（执行、检索、批判、红队、验证等），复杂任务≥5个，并允许递归派生子Agent。
> 子Agent必须独立分析、交叉质疑、补充验证；主Agent负责汇总冲突并输出最优解。
> 简单任务可降为"主Agent+审查Agent"。token不是约束，充分探索、充分辩论、充分验证，
> 期间如有agent因任何问题报错，都必须全量重跑，不要有任何缩水和将任务推给主线程，
> 主线程只负责调度agent和整理信息向用户提交信息

---

## 1. 方案 A 是什么（原话）

> **A. 让 `connect` 在「无解时才考虑覆盖」，而不是要求调用方预先开**
>
> 现在 `allow_replace` 是**调用方**的安全阀。这个开关不该模型随手开（它会静默删 uid）。
> 但可以让 `connect` 在**842 条全撞**之后，再试一轮「只允许覆盖 1 格」的搜索，
> 并把那一格作为 `warnings` 报出来，由 loop 决定要不要接受。
>
> - 好处：修掉真正的缺口，模型不用知道 `allow_replace`
> - 风险：`connect` 从「绝不删东西」变成「可能删 1 格」，语义变松

---

## 2. 直接触发这件事的实验事实（已实测，可复现）

### 2.1 场景

一个「半成品世界」：44 实体方案砍掉 cutter 产品侧到 hub 那条链的最后 3 格
（`(1,-5) (1,-4) (1,-3)`，全是 r=180 的带子）。断点 `(1,-6)` 朝 bottom 喷到空地。

### 2.2 loop 的表现（诊断/意图/动作全对）

```
[DEAD_END] 出口方向 bottom 的那一格上没有实体（货会堆在这里）
say: The only belt run that ends in mid-air is the exit of the existing cut line;
     route it into the hub so the cut product finally gets delivered.
call: connect({from:{uid:B34}, to:{uid:H1}})
```

### 2.3 但宏失败在路径搜索

```
occupied: 所有候选路径都被挡住；第一处冲突在 (-3,-8)（self-overlap）
tried: 842
```

### 2.4 `allow_replace` 就能解

```
默认            : ok=false  occupied  self-overlap at (-3,-8)  tried=842
allow_replace   : ok=true   cells=6
```

路径 6 格，**只有 1 格有既有带子**：

| 格 | 原本 |
|---|---|
| `(1,-7)` | belt **uid=10537** ← 必须覆盖它才能转向 |
| `(0,-7)` `(0,-6)` `(0,-5)` `(0,-4)` `(0,-3)` | 空地 |

hub entry 8 在 `(0,-3)`。

### 2.5 阳性对照

手动 `connect` + `allow_replace:true` ⇒ `delivered` 32 → 38。世界能修好。

复现命令：

```bash
cd "D:/Projects/rea/Project work/shapez"
node --input-type=module -e "
import { connect } from './src/agent/macros/connect.mjs';
import fs from 'node:fs';
const j=JSON.parse(fs.readFileSync('.tmpverify/final-half/probe-obs.json','utf8'));
const ents=j.obs.entities;
const b34=ents.find(e=>e.uid===10538); const hub=ents.find(e=>e.type==='hub');
const r=connect({from:{uid:b34.uid},to:{hub:{uid:hub.uid}},opts:{allow_replace:true}},{entities:ents});
console.log(r.ok, r.cells&&r.cells.length);
"
```

---

## 3. 我摸到的现场事实（**你要独立验证，不要照抄**）

### 3.1 `self-overlap` 检查在 `belt` 检查之前

`src/agent/macros/connect.mjs:648-659`：

```js
let firstConflict = null;
for (const c of cells) {
    const k = key(c[0], c[1]);
    if (seen.has(k)) return { ok: false, firstConflict: { x: c[0], y: c[1], what: "self-overlap" }, replaceable };
    seen.add(k);
    const rec = world ? world.cells.get(k) : null;
    if (!rec) continue;
    if (rec.type === "belt") {
        if (opts.allow_replace) { replaceable++; continue; }
        if (!firstConflict) firstConflict = { x: c[0], y: c[1], what: "belt", uid: rec.uid };
        continue;
    }
    ...
```

⇒ 报 `self-overlap` 时，`replaceable` 可能已经计过数。**要看清楚这个 `return` 是否让
「有 1 格带子可覆盖」这种情况走不到 `firstConflict` 分支。**

### 3.2 候选枚举在 842 条封顶

`connect.mjs:820-860` 附近。要看清楚：
- 842 是**全部**折线候选，还是中途截断的？
- `MAX_TURNS` 是多少？放宽它能否找到绕过路径（不需要覆盖）？
- 顺序是确定的还是依赖遍历顺序？

### 3.3 ★ `connect` 不返回被覆盖的 uid ★

实测（2026-11-01）：

```js
const r = connect({from:..., to:..., opts:{allow_replace:true}}, {entities});
// r.ok === true
// r 的顶层 keys: ok,macro,cells_planned,cells_placed,first_mismatch,changed,
//                warnings,error,dry_run,cells,pathLen,choice,strategy,alternatives
// r.replaces === undefined
```

它只在 `warnings` 里说：

```
{ code: "replacing-belts",
  detail: "allow_replace=true：路径上有 1 格是既有带子，执行时必须先 delete{uid} 并纳入 tx 回滚" }
```

**注意 detail 里连 uid 都没有。**

**这是方案 A 必须先解决的前提**：如果 `connect` 不告诉调用方「要删哪个 uid」，
下游没法生成 `delete{uid}` op。

### 3.4 ★ `planToTxOps` 的 R13 会拒绝「删了没点名的 uid」★

`src/agent/loop/planToTxOps.mjs:712-730`：

```js
if (named && named.size && deleteUids.length) {
    const extra = deleteUids.filter(u => !named.has(u));
    if (extra.length) return reject("R13", ...,
        `计划要删除 ${deleteUids.length} 个实体，其中 ${extra.length} 个**不在 LLM 指名的句柄里**：${who}。`);
} else if (deleteUids.length) {
    // 只警告
}
```

⇒ 即使 `connect` 报了 uid，只要模型的 `calls` 里没点名它，R13 就会拒绝整轮。

**这条与方案 A 直接冲突，必须一起设计。**

### 3.5 历史事故：静默覆盖

`gates.mjs` 的 C1（项目记忆里也有）：

> 贴入会**静默销毁**旧带子。实测：`ok:true applied:3 failed:[]`，两条旧带子 uid 消失，mod 不报任何警告。

ⓘ 那是 `paste_blueprint` 的形态。`tx` 里的 `delete` 是显式的、可回滚的，不完全一样。
但「用户/调用方不知道某条带子被删了」这个核心风险是同一个。

---

## 4. 安全约束（不遵守即失败）

1. **游戏实例是独占资源**：同一时刻只允许一个 agent 做写操作
2. 用户的正式存档 `5c96706563c0b74c4d2ce4c7f8bf7a244392de89`（level 11）
   **绝不许当试验场**。本轮目标世界是 `7c93b3dd9e949c561e5aa529974973b18c856b45`（L4）
3. **不许 kill / 重启 shapezio 进程**
4. 写前必 `snapshot_save`；先 `dry_run`
5. 实机实验前必须确认 7777 上跑的是 `src/bridge/bridge.mjs`，**不是** `test/live_bridge.mjs`
   （后者没有 `snapshot_save`，会返回 `method_not_found`）
6. `autosaveInterval:"one_minute"` 会让目标世界存档每 60 秒被重写 ——
   护栏判据只能对 home/fixture 硬判，目标世界只记录

---

## 5. 纪律

### 5.1 不许「简化模型代替真实现」

主线程这一轮在这一类错误上栽了 **5 次**：
L4/L5 夹具混用、手抄 `hubReachable`、`byCell` 用 origin 索引、
以为 footprint 只对 hub 重要、把夹具 bug 当成「堵点 D」。

所以：**每一项结论必须附「用什么命令测出来的」**。没有命令的结论一律标 `未验证`。

### 5.2 不许把「看起来对」当「测过」

- 「842 条全撞」≠「无解」—— `allow_replace` 一下就解了
- 「connect 报了警告」≠「调用方能据此生成 delete op」—— 它连 uid 都没给
- 「R13 只警告」—— 看清楚是 `if (named && named.size)` 还是 `else`

### 5.3 报告格式

```
## 结论（一句话）
## 证据（命令 + 原始输出，可复跑）
## 我没验证的 / 我不确定的
## 如果我是错的，最可能是哪里错
```

第四项**不能空着**。

---

## 6. 本轮的边界

主线程只做三件事：写本简报、派 agent、汇总结果。
**所有代码阅读、设计、实现、验证，都由 agent 做。**

发现与修复必须是不同 agent：发现者写带复现命令的报告，修复者拿报告干活。

---

## 7. 追加：一个已由主线程独立实测的**决定性事实**

**「搜得更好」救不了这个场景。方案 A 不是偷懒，是唯一解。**

用规划 agent 的枚举脚本（`.tmpverify/planner-probe2.mjs`，只读、纯离线）
在 `(1,-6)` → hub 这个真实场景上扫搜索空间：

| maxTurns | maxLen 余量 | 候选数 | 几何可行 | **零覆盖可行** | 覆盖直方图 |
|---|---|---|---|---|---|
| 6（现行） | 曼哈顿+8 | 842 | 686 | **0** | 1格 473 / 2格 207 / 3格 6 |
| 8 | +8 | 7,508 | 5,059 | **0** | 1格 3179 / 2格 1767 / 3格 79 / 4格 34 |
| 10 | +14 | 75,059 | 32,949 | **0** | 最多 6 格 |
| 12 | +20 | **437,947** | **138,894** | **0** | 最多 7 格 |

复现：

```bash
node .tmpverify/planner-probe2.mjs 6 8
node .tmpverify/planner-probe2.mjs 12 20
```

### 三个可以直接采信的推论

1. **842 是完整枚举，不是截断。** 放宽后候选数暴涨（7508 → 437947），说明枚举确实是
   在 `maxTurns`/`maxLen` 约束下穷尽的。所以「842 条全撞」这个失败信息是诚实的。
2. **不存在「不覆盖就能连」的路径。** 在 13.9 万条几何可行路径里，零覆盖的是 **0** 条。
   这不是搜索能力不足 —— 是这个世界状态下物理上必须占用 `(1,-7)` 那一格。
3. **覆盖 1 格就够。** 现行 842 条里已有 **473 条**只需要覆盖 1 格。方案 A 不需要复杂的
   多格覆盖策略，先做「最多覆盖 1 格」就能解这个场景。

### 对设计的直接约束

- **不需要**重写布线算法。折线枚举在 `maxTurns=6` 下已经包含了解（473 条）。
  缺的不是搜索，是**决策**：`connect` 现在把「有 1 格可覆盖」的候选全部当失败扔掉。
- **不需要**放宽 `MAX_TURNS`。那会让候选数涨到 3–4 个数量级（437947 条 = 单次 connect
  从 0.6s 涨到几十秒），却换不来一条零覆盖解。
- **应当**把 `MAX_TURNS` 留在 6，只在「842 条全撞」时**放宽覆盖策略**，而不是放宽搜索。

---

## 8. 追加：契约里**早就写明了**这个缺口

`src/agent/macros/contract.mjs:183-206` 的 `WARNING_CODES["replacing-belts"]`：

```
what:   "本单会销毁既有带子（allow_replace / replace_belts / replace_belt 打开时）"
action: "把要删的 uid（connect 在 detail 里给格数，insert_machine 给 removed_uids，
         trash_unused 给 replaced_belt_uid）纳入 tx 的 destroys；不处理 = 覆盖没有回滚。"
```

**注意括号里那句**：三个宏里，`insert_machine` 给 `removed_uids`、
`trash_unused` 给 `replaced_belt_uid`，**唯独 `connect` 只给格数**。

⇒ 这个缺口不是新发现的 bug，是**契约里记在案的已知不一致**，只是没人补。

### 直接含义

方案 A 的 uid 传递**不需要发明新协议** —— 照着另外两个宏的既有做法补齐即可：
`connect` 的 `warnings` 里那条 `replacing-belts` 要带上被覆盖的 uid（建议 `replaced_belt_uids`，
复数，因为实测有覆盖 2–3 格的候选）。

### 另一条契约事实（影响实现方式）

`validateMacroResult`（`contract.mjs:1549`）只校验 `RETURN_ENVELOPE.required`
（`ok / cells_planned / cells_placed / first_mismatch`）**存在且类型对**，
**不拒绝额外字段**。所以：

- ✅ 在 `connect` 返回值**顶层**加字段（如 `replaces: [{uid, x, y, kind}]`）是安全的
- ⚠️ 在 `warnings[].code` 里加**新的码**会被 `WARNING_CODES` 闭集拒绝 —— 必须扩闭集
- ✅ 在既有 `replacing-belts` 的 `detail` / 同级字段里加 uid **不受闭集限制**
  （闭集只管 `code`，不管其它字段）

### `planToTxOps` 的 R13 现状（`planToTxOps.mjs:712-730`）

```js
if (named && named.size && deleteUids.length) {
    const extra = deleteUids.filter(u => !named.has(u));
    if (extra.length) return reject("R13", ..., "不在 LLM 指名的句柄里");
} else if (deleteUids.length) {
    // 只警告
}
```

⇒ `ctx.namedUids` **为空时只警告不拒绝**。所以如果 loop 侧不传 `namedUids`，
覆盖删 uid 不会触发 R13。但那是**绕过**保护，不是解决 —— 要看 loop 实际传不传。
