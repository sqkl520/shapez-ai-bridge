# 真机验证：部分执行被提交，但判据层正确地判成「不达成」

> 2026-11-02。**这是方案 E 最关键的一次验证。**
> 脚本：`.tmpverify/live-partial/verify.mjs`

---

## 结果

```
preflight: 42 实体
找到失败调用: M1→C1.primary (MACRO_REFUSED)
找到可撤销成功调用: B34→H1 (3 ops)

[guard] snapshot: live-partial-probe
[guard] dry_run: applied=3/3 → 可执行
[guard] real tx: ok=true applied=3

outcome=halt reason=BUDGET_ROUNDS level=none
verdict: achieved=false
why: [
 "strictVerdict 未通过：PARTIAL_APPLY：计划没有完整执行，1 个调用被跳过：
  connect(macro_failed) —— 做成了子集不等于达成了计划"
]

plan 行: partial=true skipped=[{macro:"connect",reason:"macro_failed"}] ops=3
实体: 42 → 45 (+3)
```

**三条验收全过：**

| # | 断言 | 结果 |
|---|---|---|
| 1 | `PARTIAL_APPLY` 出现在 `verdict.why` | ✓ |
| 2 | `achieved === false`（不是假绿） | ✓ |
| 3 | 世界真的变了（子集提交了） | ✓ |

---

## 为什么这次验证值得单独记

这是**红队警告的那个假绿场景的真实运行**：

- 部分执行真的落盘了（`applied: 3`，实体 42→45）
- 如果判据层不知道 `partial`，L1/L2 会全绿（它们验的就是那 3 个 op）
- 而 `phaseTwoVerdict` 会因为「hub 在收货」给 `achieved: true`

**实际结果是 `achieved: false`，`why` 里明确写了原因。**

⇒ **假绿被挡住了。**

---

## 怎么测的（因为真机场景太简单）

42 实体的真实世界，模型两次都**第一次就成功**，走不到「失败→部分执行」。

所以脚本先 **probe**：在真机上逐个试，找到
- 一个必失败的调用（`M1 → C1.primary`，`port_already_bound`）
- 一个可撤销的成功调用（`B34 → H1`，产 3 个 `place:belt`）

然后用 `ScriptedClient` 把这两条一起喂给**真的 `runLoop`**（`mode:"live"`）。

⚠️ **这不是「LLM 自然写出的部分执行」** —— 而是「人为构造的部分执行」。
它验证的是**判据层**，不是「模型会不会写这种计划」。后者需要另一个实验。

---

## 路上修的一个真 bug（桥接）

第一次跑报：

```
TX_UNAVAILABLE: tx 抛异常：snapshot_save: mod_error:
  savegame file not found: …\savegame-7c93b3dd….bin
```

但那个文件**实际存在**（3178 字节，mtime 就是那一刻）。

根因：`save_now` 是**异步写盘**的，桥接拿到 RPC 回包就去 `fs.existsSync`，
输给了文件系统的 flush 竞态。世界小的时候通常来得及，大一点就会踩。

修法（`bridge.mjs` 的 `snapshotSave`）：轮询等文件出现，最多 5 秒、50ms 一次。

⚠️ 只**等**，不重试 `save_now` —— 那可能触发第二次写盘。

**这个 bug 之前没暴露，是因为以前的脚本在 `snapshot_save` 前面都隔了别的操作。**
这次 guard 里是一拿到就检查，正好踩中。

---

## 复原

```
snapshot_load pre-partial-verify → ok
复原后实体: 42
stored: {"CuCuCuCu":12,"----CuCu":686,"RuRuRuRu":2016,"----RuRu":4575}
```

**世界完全复原，用户存档全程未动。**

---

## 现在的状态

### ✅ 已验证

1. 方案 E 的**提交逻辑**在真机上工作（`applied: 3`，世界真的变了）
2. **判据层正确地拒绝假绿**（`achieved: false` + `PARTIAL_APPLY`）
3. `plan` 行的 `partial` / `skipped` 明细可读
4. 桥接的 snapshot 竞态 bug 修了

### ❌ 仍未验证

1. **LLM 自然写出部分执行时**，判据层是不是也这样（这次是人为构造的）
2. **`NO_REVERSIBLE_CALL` 的 hint 有没有让模型改掉 `trash_unused`**
3. **被跳过之后，下一轮模型会不会换修法**
4. **打开 `partial:true` 之后，多轮 run 的整体成功率**

---

## 建议

现在的证据支持「可以打开 `partial: true`」——判据层在真机上验过了。

但**打开之后要立刻做一件事**：跑一次多轮真机 loop（`ROUNDS_MAX: 3`），看
被跳过之后模型会不会换修法。如果它下一轮还写 `trash_unused`，
那 `PARTIAL_APPLY` 虽然正确，但会让 run **一轮都达不成**（因为每轮都是 partial）。

⚠️ **这是一个真实的风险**：在没有 `partial` 之前，全有或全无会导致
「要么全成、要么全败」；有了 `partial` 之后可能变成「轮轮都提交一点、
但轮轮都判 partial ⇒ 永远 `achieved: false`」。

**这个风险必须在打开之前想清楚。**
