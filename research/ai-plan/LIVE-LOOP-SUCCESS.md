# 真机闭环：第一次「loop 说成功，世界真的变了，两者一致」

> 2026-11-02。**本会话第一次在真游戏上拿到一个可独立核实的成功。**
> transcript：`.tmpverify/live-loop/runs/r-20261102095020-d916/`

---

## 结果

```
status: in_game=true hub_level=4
preflight: 42 实体, level 4

[guard] snapshot: live-pre-tx
[guard] dry_run: applied=3/3 failures=0 rolled_back=true → 可执行
[guard] real tx: ok=true applied=3 rolled_back=false

outcome=success  reason=null  level=live
rounds=2  llm_calls=2  tx=1
verdict: achieved=true  level=live  why=[]
```

**独立核对（不看 loop 的 verdict）**：

```
实体: 42 → 45  (+3)
  新增 uid: 10549, 10550, 10551
stored 前: {..., "----RuRu": 4575}
stored 后: {..., "----RuRu": 4575, "RuRu----": 36}
stored 有变化: true
```

⇒ **`RuRu----` 从「不存在」变成 36。世界真的产出了目标形状。**

---

## 为什么这次和之前不同

之前的「成功」（`PHASE2-SUCCESS.md`）也报过 `achieved: true`，但那时的核对是：

| 项 | 那次 | 这次 |
|---|---|---|
| loop verdict | `achieved: true` | `achieved: true` |
| 实体数变化 | 42 → 45（3 格带子） | 42 → 45（3 格带子） |
| **`stored[goal]` 增量** | **45**（可疑 —— 正好等于实体数） | **36**（来自真实产出） |
| `why` | `[]` | `[]` |

⚠️ 上次那个「45」我事后看是可疑的：它和实体数完全相同，可能是把「建造」误读成「产出」。
这次的 36 是**新增的 `RuRu----` 键**，之前那个键根本不存在。

---

## 这一轮做了三件事才走到这里

### 1. 修好存档索引（前提）

见 `LIVE-UNBLOCKED.md`。`savegames.bin` 被截断成空，
`list_saves` 返回空、`load_save` 2002、`in_game` 永远 false。

加了 `rebuild_saveindex` RPC，dry_run 核对后真写，重开游戏生效。
**7 条存档全部恢复，`in_game: true`。**

### 2. 修 guard 对 `dry_run` 的判据（拦路虎）

第一次跑，guard 报 `dry_run: ok=false` 就不写了。但那个 `ok:false` 是**正常的**：

```json
{"ok": false, "applied": 1, "requested": 1, "rolled_back": true, "dry_run": true,
 "failures": [], "verify": {"uid_set_equal": true, "entities_equal": true}}
```

`ok` 反映「tx 之后世界是否处于提交态」——dry_run 必然回滚，所以 `rolled_back:true` ⇒ `ok:false`。
**这是设计，不是错误。**

正确判据：`failures` 为空 **且** `applied === requested`。

**这个坑如果不查清，会让人以为「真机的 dry_run 一直失败」** ——
而实际上是判据写错了。这是「用错指标」的又一个例子。

### 3. 修 LLM 端点（`HTTP 403`）

`makeClient({mode:"live"})` 默认打 `api.anthropic.com`，
而这个 key 属于第三方端点。必须显式给 `baseUrl`。

---

## ★ 关键验证：产出是真的在涨，不是瞬间灌入

第一次成功后我怀疑那个 36 可能是「补上带子瞬间灌入」而不是「稳定产出」。
第二次成功后每隔 14 秒读一次：

```
09:56:14  RuRu---- = 50
09:56:28  RuRu---- = 56   (+6 / 14s ≈ 0.43/s)
09:56:42  RuRu---- = 61   (+5 / 14s ≈ 0.36/s)
```

**稳定产出约 0.4 个/秒。**

对照理论值：`RATES.cutter = 0.5/s`（一台 cutter 的产出速率）。
实测 0.36-0.43 —— **是理论值的 72-86%，符合「有产出但没跑满」的预期**
（供料或路径有损耗）。

⇒ **这不是假绿。世界真的在生产目标形状。**

---

## 第二次运行：更干净

第二次跑（`r-20261102095510-ec80`）：

```
rounds=1  llm_calls=1  tx=1
outcome=success  achieved=true  why=[]
实体 42 → 45 (+3)
stored['RuRu----'] = 37
```

**只用了 1 轮就成功**（第一次是 2 轮）。说明模型第一次就选对了。

---

## 复原

两次都复原了：

```
snapshot_load pre-live-loop-2026-11-02 → ok
复原后实体数: 42
stored: {"CuCuCuCu":12,"----CuCu":686,"RuRuRuRu":2016,"----RuRu":4575}
新增的 10549/10550/10551 还在吗: []
```

**用户存档 `5c967065` 全程未动。**

---

## 这验证了什么，没验证什么

### ✅ 验证了

1. **`rebuild_saveindex` 真的能修好索引** —— 7 条全部恢复，游戏接受 checksum
2. **`load_save` 真的能载入** —— 42 实体、level 4，与离线解码一致
3. **loop 真的能在真机上跑通** —— 1-2 轮、1-2 次 LLM、1 次 tx
4. **`planToTxOps` / `verifyRuntime` / 坐标溯源这一整条链没坏** —— `applied: 3/3`
5. **`applyVerdict` / `strictVerdict` / `phaseTwoVerdict` 判对了** ——
   `achieved: true` 且**世界真的在稳定产出**
6. **产出速率 0.4/s ≈ 理论的 80%** —— 不是瞬间灌入

### ❌ 没验证

1. **只跑了一个场景**（L4 的断点修复）。产能、布局、冷启动都没测。
2. **模型选的还是那个「老正解」**（补 3 格带子），不是这一轮修的任何一个新东西。
   ⇒ **这一轮的修复（hint、端口图例、动作集计数、一轮一改）在真机上还没被检验。**
3. **两次都第一次就成功**，没走到「失败→重试」的路径 ——
   而那正是这一轮所有修复针对的场景。
4. **`level: 4 → 4`** —— 没升级。目标 required 70，产出到 61，还差一点。

---

## 下一步（真机上有价值的方向）

### A. 在真机上跑那个「会失败」的场景

`ab-real` 用的 `L4-obs.json`（181 实体、163 带子）就是。但它是离线夹具，
真机上对应的是用户存档 `5c967065`（**绝不能碰**）。

⇒ 需要一个「真机上的密集存档」。`7c93b3dd` 只有 42 实体。
可以用 `capacity-scenario` 的 45 实体灌进去？那要先构造。

### B. 验证这一轮的修复

要验证「hint 进 prompt」「端口图例」「一轮一改」在真机上的效果，
需要一个**第一次会失败**的场景。现在的 L4 场景第一次就成功了（补 3 格带子）。

### C. 接受现状，记录「真机闭环可用」

**这个本身就有价值**：之前所有结论都标注「未经过真机验证」，
现在至少有一条完整的真机证据链。

---

## 诚实边界

1. **`stored` 的 36 是在多少游戏秒内产出的，我没测。** 如果只等了很短时间就已经 36，
   那可能是「补上带子后瞬间灌入」而不是「稳定产出 36/s」。
2. **`level: 4 → 4`** —— 没升级。目标是 required 70，36 < 70，所以只完成了一半。
   `achieved: true` 判的是「有产出」，不是「达成关卡」。
3. **`verdict.why: []`** 说明所有检查都过了。但我没有逐项核对 L0-L4 的具体值。
4. **两次运行的结果不同**（第一次 `dry_run` 判据错导致 halt，第二次成功）——
   说明结果的稳定性没测。
