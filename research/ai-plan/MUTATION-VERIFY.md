# 变异测试独立验证

> 执行者：变异测试 Agent（独立重做，不采信主线程「5 个变异体都杀了」的结论）
> 日期：2026-10-18
> 纪律：全部变异体在 `os.tmpdir()` 里重建（拷贝 `src/`、`test/`、`research/ai-plan/live-L4-entities.json`），
> 源仓库零改动；无 git 操作；无游戏写操作。
>
> **方法**：每个变异体只替换一处判据（锚点要求恰好命中 1 次），跑**同一份测试文件**，看退出码。
> 退出码 0 = 存活（❌）；非 0 = 被杀（✓）。**并且**区分了 `ERR_MODULE_NOT_FOUND` / `SyntaxError` 这两类
> 「假杀」——实测 25 个变异体中没有一例落进这两类（全部是真实断言失败或真实存活）。

## 0. 汇总表

| 模块 | 基线 | 变异体数 | 被杀 | 存活 | 存活率 |
|---|---|---|---|---|---|
| `gates` | 373 pass / 0 fail | 10 | 8 | **2** | 20% |
| `connect` | 36 pass / 0 fail | 8 | 5 | **3** | 38% |
| `remove` | 53 pass / 0 fail | 4 | 4 | 0 | 0% |
| `mod` | 84 pass / 0 fail | 3 | 3 | 0 | 0% |
| **合计** | | **25** | **20** | **5** | **20%** |

**核心结论**：主线程「5 个变异体都杀了」在它挑的那 5 个上成立，但**扩大覆盖面后有 5 个判据完全没有被锁住**：
`gates` 的 `cellMismatch`（uid↔cell 交叉校验）与 `unresolved`（cell 声明落空），
`connect` 的单格自洽（`solveTurn` 复解）、自重叠检查、**占用检查整体恒真**。其中**占用检查恒真**最严重：
改完之后 `connect` 会把新带子直接铺在既有带子上并报 `ok:true`，测试仍然 36/36 全绿。

---

## 1. gates 变异详情

源码 `src/agent/gates.mjs`，测试 `src/agent/gates.test.mjs`（373 条），基线 373 通过 / 0 失败。

| # | 变异体 | 具体改动 | 结果 | 触发的断言 |
|---|---|---|---|---|
| G1 | `gateGDeleteReplay` 正向删除不查 | `if (after.byUid.has(t.uid)) stillAlive.push(...)` → `if (false) stillAlive.push(...)` | ✓ 被杀（3 红） | 「声明要删的 uid 贴后仍然存在 → 红」、「reason 说「仍然存在」」、「evidence 指出声明的那 1 个仍然活着」 |
| G2 | `extraGone` 恒空 | `const extraGone = vanished.filter(...)` → `const extraGone = []` | ✓ 被杀（5 红） | 「多删」三条 + `evidence.extra_deleted` |
| G3 | `vanished` 不查 | 删掉 `for (const uid of before.byUid.keys()) ... vanished.push(uid)` | ✓ 被杀（5 红） | 同上（反向判据的两处入口都被覆盖） |
| **G4** | **uid↔cell 交叉校验恒真** | `if (t.beforeEntity && Array.isArray(item.cell) && (x/y 不符)) {` → `if (false) {` | **❌ 存活（373/0）** | 无 —— 见下 |
| G5 | 截断 fail-closed 失效 | `if (after && after.truncated)` → `if (false)` | ✓ 被杀（2 红） | 「after 截断 → undecidable」×2 |
| G6 | `gateGRollbackRestore` 只比数量 | `if (missing.length \|\| extra.length)` → `if (before.byUid.size !== afterRollback.byUid.size)`（并令 missing/extra 只按数量填） | ✓ 被杀（3 红） | 「数量相同但 uid 全变了 → 红」、「reason 明说「假还原」」、`same_count_assumed_identity` |
| G7 | 回滚内容（位置/code）不比 | `if (b.x !== r.x \|\| b.y !== r.y \|\| b.code !== r.code)` → `if (false)` | ✓ 被杀（3 红） | 「1 台位置变了 → 红」、「1 台 code 变了 → 红」、`content_changed=1` |
| G8 | 整个 G-dr 恒绿 | 函数首行插 `return { ok: true, reason: null, evidence: {} }` | ✓ 被杀（15 红） | 全部 G-dr 必红用例 |
| G9 | `unresolved` 静默跳过 | 删掉 `unresolved.push({ cell: item.cell })`，只留 `continue` | **❌ 存活（373/0）** | 无 —— 见下 |
| G10 | `extraGone` 分支不报红 | `if (extraGone.length) {` → `if (false) {` | ✓ 被杀（4 红） | 「实际删了 3 条、只声明 2 条 → 红」、「G-dr 报红」 |

> 首版的 G6 锚点字符串在文件里出现 2 次（G-rb 与 G8chains 各一处），被 harness 判为 `ANCHOR x2` 而跳过；
> 改用包含 `// 贴前有、回滚后没有` 注释的更长锚点后命中 1 次。这不是实现问题，是变异脚本的锚点问题，已修正。

### 1.1 存活体 G4 的证据（重要）

测试里那条「必红」用例是：

```js
// gates.test.mjs:1125
const gCellEmpty = gateGDeleteReplay({ removes: [{ cell: [99, 99] }] }, before, good);
ok(!gCellEmpty.ok, "cell 声明的格上贴前没有实体 → 红（计划过期）", ...);

// gates.test.mjs:1129
const gMismatch = gateGDeleteReplay({ removes: [{ uid: 10042, cell: [11, 10] }] }, before, good);
ok(!gMismatch.ok, "uid 与 cell 指向不同实体 → 红（计划写完后世界变过）", ...);
```

把 `cellMismatch` 整段改成 `if (false)` 之后，**这两条仍然是绿的**，因为：
- 第一条走的是 `unresolved`（`[99,99]` 在 `before.byCell` 里查不到 → `t.uid === null`），根本不是 `cellMismatch`；
- 第二条里 `before` 有 5 个实体、`good` 只剩 2 个 keep —— `vanished` 有 3 个（10042/10043/10044），
  只声明了 10042 一个 → 反向判据先报「多删了」，`ok:false` 成立。**这条断言是靠"多删"红的，不是靠"uid 与 cell 对不上"。**

要单独暴露 `cellMismatch`，夹具必须让**所有消失的 uid 都被声明**、且不触发 `still_alive`/`unresolved`。实测：

```js
// 变异体（去掉 cellMismatch）→ ok:true, deleted:3
gateGDeleteReplay({ removes: [{ uid: 10042, cell: [11, 10] }, { uid: 10043 }, { uid: 10044 }] },
                  before /* 10042@10,10 / 10043@11,10 / 10044@12,10 */, after /* 全删 */)
// 原实现 → ok:false, reason:「1 条声明里 uid 与 cell 对不上…」cell_mismatch:1
```

所以：**「uid 权威、cell 交叉校验」这条判据可以被整个删掉而测试全绿**。
它现在的存在只是"顺手加的"，G-dr 的测试并没有为它建夹具。

### 1.2 存活体 G9 的证据

`unresolved` 分支（cell 声明指向贴前空格）被删掉后，`gCellEmpty` 之所以还红，是因为同一个夹具的 `after` 里
10042/10043/10044 也消失了 → 又是"多删"兜住了。实测用**世界不动**的夹具单独验证：

```
变异体: gateGDeleteReplay({removes:[{cell:[99,99]}]}, same, same) → {"ok":true, "deleted":1}
原实现: 同调用 → {"ok":false, "reason":"… 贴前那格上没有实体（首条 [99,99]）…", unresolved:1}
```

比 G4 更糟：变异体不仅绿，还在 `evidence.deleted` 里**记了 1 条"已删除"**——一条从没解析到实体的声明被算成了删除成功。

---

## 2. connect 变异详情

源码 `src/agent/macros/connect.mjs`，测试 `src/agent/macros/connect.test.mjs`（36 条），基线 36 通过 / 0 失败。

| # | 变异体 | 具体改动 | 结果 | 触发的断言 |
|---|---|---|---|---|
| C1 | 面闭合检查恒真 | `if (aExit !== OPP[bEntry]) {` → `if (false) {` | ✓ 被杀（1 红） | 「verifyChain 负例①：rv1 ↔ rv2 互换…必须红，且报面闭合」 |
| C2 | 位置连续性恒真 | `if (b.x !== want[0] \|\| b.y !== want[1]) {` → `if (false) {` | ✓ 被杀（2 红） | 负例②（整链 +180°）、负例④（挪开一格） |
| **C3** | **单格自身自洽（`solveTurn` 复解）弱化** | `if (!re \|\| re.rotation !== c.rotation \|\| re.rotationVariant !== c.rotationVariant)` → `if (!re)` | **❌ 存活（36/0）** | 无 —— 见下 |
| **C4** | **占用检查整体恒真** | `return { ok: firstConflict === null, firstConflict, replaceable };` → `return { ok: true, firstConflict: null, replaceable };` | **❌ 存活（36/0）** | 无 —— 见下 |
| C5 | `code !== 1+rv` 不查 | `if (c.code !== beltCode(c.rotationVariant)) {` → `if (false) {` | ✓ 被杀（1 红） | 负例⑤ |
| **C6** | **自重叠（self-overlap）不查** | `if (seen.has(k)) return {ok:false, firstConflict:{…"self-overlap"}}` → `if (false) return …` | **❌ 存活（36/0）** | 无 |
| C7 | 面闭合口径写反 | `aExit !== OPP[bEntry]` → `aExit !== bEntry` | ✓ 被杀（17 红） | 正例基准 + 直线/L/Z/候选形状等全部崩（这是"抓反了"的强信号） |
| C8 | `replaceable` 计数恒 0 | `if (opts.allow_replace) { replaceable++; continue; }` → 去掉 `replaceable++` | ✓ 被杀（1 红） | 「allow_replace：路径上的旧带子被允许覆盖，并给出回滚警告」 |

### 2.1 存活体 C4 的证据（最严重）

```
# 变异体（占用检查 ok 恒 true）+ 既有 3 条带子挡路、rebind 但**不**给 allow_replace：
connect({from:{uid:1},to:{uid:2,port:"primary"},opts:{rebind:true}}, {entities})
  → ok: TRUE，返回 5 格 cells（(0,5)(0,4)(0,3)(0,2)(0,1)），warnings: []

# 原实现同一调用：
  → ok: false, error.code = "occupied"
```

也就是说：**变异体让 `connect` 把新带子直接铺在既有带子的格子上并报成功**，而 36 条测试一条都没红。
现有三条"撞墙"用例为什么抓不住：
- 「撞墙：路径上放一台机器」——挡路的是 `balancer`，被 `fits()`（枚举期的 `noteBlocked`）先筛掉，
  走的是 `blockedBy` → `occupied`；这条路径**不经过** `checkOccupancy`。
- 「机器永不可覆盖：allow_replace=true」——同上，仍然是 `fits()`。
- 「allow_replace：路径上的旧带子…」——用的是 `allow_replace: true`（且 `rebind: true`），
  该用例只断言"有 `replacing-belts` 警告"，**没有断言 `replaceable` 计数正确**、也没有负例
  （"不给 allow_replace 时必须 `occupied`"）。

唯一的 `checkOccupancy` 负例缺口就在这里：**默认（允许覆盖 = false）下踩旧带子必须 occupied**，无覆盖。

### 2.2 存活体 C3 的证据

负例③想测"单格 rv 改错"，做法是 `cells[2].rotationVariant = 1, code = 2`。实测这一步会**改变该格的 exit 面**，
于是先被面闭合检查抓住：

```
breaks[0].why = "断裂: 0,-2 exit=left → 0,-3 entry=bottom（要求 exit=OPP[...]=top）"
```

`breaks` 里**没有**「单格自身不自洽」那一条。所以负例③从没验证过 `solveTurn(entry,exit)` 复解这一段。
要单独锁住它，需要构造 `(rot, rv)` 与 `solveTurn` 不一致、但**面不变**的改动——例如
`rotationVariant` 互换但整体重新 `poseChain`（或直接用 `{rotation, rotationVariant}` 手写一个"面正确、解不唯一"的格子）。
在现有夹具下，把这一段弱化成 `if (!re)` 依然 36/36 全绿。

### 2.3 存活体 C6 的证据

`verifyChain` / `checkOccupancy` 里的 self-overlap 分支在**整个测试文件里零覆盖**：
`grep "self-overlap" connect.test.mjs` 无命中，`checkOccupancy` 也没有被 import。
`candidateShapes` 天然不产生重复格，所以这条判据只在"外部传入手写 cells"或"未来 Dijkstra 布线"时才起作用，
而目前没有任何用例从外部喂重复格。

---

## 3. remove 变异详情

源码 `src/agent/macros/remove.mjs`，测试 `src/agent/macros/remove.test.mjs`（53 条），基线 53 通过 / 0 失败。

| # | 变异体 | 具体改动 | 结果 | 触发的断言 |
|---|---|---|---|---|
| R1 | `would_disconnect` 恒空 | `const wouldDisconnect = analyzeRemoval(c0, picked.map(p=>p.uid));` → `= []` | ✓ 被杀（4 红） | 「报 would_disconnect（4 处）」「断开不阻止执行」「删中间一段只断 2 处」 |
| R2 | trash 落点少 DIRV 偏移 | `portCellOf` 去掉 `+ DIRV[q.dir][0/1]` | ✓ 被杀（5 红） | 「(4,-13) 换成 cutter+trash」「逐 uid 相等」「region 太小 → 报错」 |
| R3 | 不存在的 uid 静默跳过 | `if (!rec) { bad.push({uid, why:"不在当前世界…"}); continue; }` → `if (!rec) { continue; }` | ✓ 被杀（3 红） | 「删不存在的 uid → endpoint_not_found，不静默跳过」「混入 → 整单拒绝」「失败带 hint」 |
| R4 | cells 指向空格静默跳过 | `if (!occ) { bad.push({cell, why:"该格没有任何实体…"}); continue; }` → `if (!occ) { continue; }` | ✓ 被杀（1 红） | 「cells 指向空格 → endpoint_not_found」 |

remove 的判据锁得最好：4/4，且每个变异体都能指名到对应的负例。
补充：`remove.test.mjs` 自带 `--mutate` 开关（M1-M6 六个内置变异体 + import 重写自检），
作者已经在测试里防了「模块找不到被误判成被杀」这一陷阱（见 `remove.test.mjs:138-147`）。

---

## 4. mod 变异详情

源码 `src/mod/shapez-ai-bridge.js`，测试 `test/mod_selftest.mjs`（84 条），基线 `ALL 84 CHECKS PASSED`。

| # | 变异体 | 具体改动 | 结果 | 触发的断言 |
|---|---|---|---|---|
| M1 | 回滚 `restoreEntity` 变 noop | `this.restoreEntity(payload, { txRollback: true });` → `void 0;` | ✓ 被杀（7 红） | 「tx: 硬失败 → 整体回滚…entity count 10 != 12」「dry_run 不留痕」「回滚后带子路网自洽」 |
| M2 | `delete{uid}` 的 uid 分支改走坐标 | `const hasUid = a.uid !== undefined && a.uid !== null;` → `const hasUid = false;` | ✓ 被杀（9 红） | 「delete{uid}: 按 uid 删除…」「坐标与 uid 不一致 → 2001」「坐标与 uid 一致 → 正常删除」 |
| M3 | 回滚迭代轮数 4 → 1 | `const MAX_ROUNDS = 4;` → `1` | ✓ 被杀（2 红） | 「tx: 回滚迭代 —— 邻居被重算改写后…modified=[10002]」「回滚不收敛 → rounds > 1」 |

mod 的三条都杀得很准，而且和真事故形态一一对应。注意 M3 只红了 2 条，
说明"回滚必须迭代"这条判据只有两条用例在守（足够，但余量不大）。
另有两点与本次任务无关但值得记录：
- `test/mod_selftest.mjs` 里已有**两条源码变异自检**用例（`1488` 行删 `entity.uid = payload.uid`、`1596` 行 footprint 退化），
  说明作者已经在 mod 测试里内建了变异测试，这是好实践。
- `check()`（同步）与 `checkAsync()` 是两个函数：`checkAsync` 会 `await fn()`，没有"async 回调进同步 check"的假绿。
  实测 `grep "^\s*check(\"[^\"]*\",\s*async"` 零命中。

---

## 5. 假绿模式扫描结果

全仓（`src/`、`test/`、`scripts/`，`*.mjs`/`*.js`）扫了三类：

### 5.1 `check(...async...)` —— 同步断言收 async 回调

- **`test/mod_selftest.mjs`：干净。** 62 处 `check(` 全是同步函数，26 处异步用例走 `checkAsync(`（内部 `await fn()`）。
  无 async 箭头函数传给同步 `check`。
- **`src/bridge/selftest.mjs`：干净。** 19 处 `check(...)` 全部是 `await check(...)`，且 `check` 自身是 `async` 并 `await fn()`。
- **`src/agent/macros/connect.test.mjs` / `remove.test.mjs`：干净。** `t(name, fn)` 是同步 harness，所有用例都是同步函数；
  两文件里唯一的 `await` 出现在 `remove.test.mjs` 顶层 `if (process.argv.includes("--mutate"))` 块里（顶层 ESM 合法）。
- **`src/agent/gates.test.mjs`：干净。** `ok()/eq()` 是同步比较；`gateG3`/`gateClock`/`runGates` 是 `async`，
  但**所有调用点都带 `await`**（`grep` 检查 `= gateG3(` 无 `await` 的调用点 = 0）。
- ⚠️ **一个真实的"恒真断言"**（不是 async 假绿，但同类）：`src/bridge/selftest.mjs:197`
  ```js
  assert(bad.readyState !== 1 || true, "ok");
  ```
  这是**永远为真**的断言。原意是"连上后又掉线 ⇒ 桥接主动断开"，但写成了重言式。
  该用例真正有效的部分只剩上面那条 `closed`（1001/1005）——「桥接主动断开」这件事**没有被锁住**。
  建议改成 `assert(bad.readyState !== 1, "bridge must have closed the socket")`。

### 5.2 `try { ... } catch(e) {}` —— 吞掉所有错误

- 实现里 12 处**空 catch**：`src/agent/play.mjs:73`、`src/bridge/bridge.mjs:212/605/665/668/677/761/796`、
  `src/bridge/selftest.mjs:173/433`、`src/mcp/selftest.mjs:1175/1321`。
  这些多数是"清理/关闭"路径（`ws.close()`、`unlink`），吞错是合理的；**但它们都是可观测性缺口**：
  清理失败会静默。
- 测试里 1 处"忽略"型 catch：`src/agent/clock.mock.test.mjs:55`（注释明写"忽略"）。
  需要人工确认被忽略的是不是被测行为本身；本次未展开。
- 更值得注意的一类：**测试为了"可跳过"而吞错**：
  - `src/agent/macros/connect.test.mjs:82`：`try { live = JSON.parse(readFileSync(SAVE)) } catch { live = null; }`
    —— 存档缺失时 `live` 为 null，后面依赖真实存档的用例会**静默降级或跳过**（本次基线跑时存档存在，未触发）。
  - `src/agent/macros/connect.mjs:1259`（`--self-test` 里）：读不到存档时只打印 `! 跳过 F1 实测`，
    **不增加 fail** —— 这是内置自测的一个"可选择跳过"，在 CI 缺文件时会造成假绿。

### 5.3 断言在 `if (false)` / 不可达分支里

- 测试代码里**没有** `if (false)` 包裹断言的情况（`grep` 命中的两处都在 `remove.test.mjs:86` 与
  `mod_selftest.mjs:1600` 的**变异体字符串**里，属于变异测试基础设施，不是被跳过的断言）。
- 但发现一类**等价物**：**断言在"不会走到的分支"里**。前面 C4/C3/C6 就是这种：
  断言写了，但它测的分支被更早的判据先截胡（`fits()` 先于 `checkOccupancy`；面闭合先于单格复解），
  所以从覆盖率上看是"有测试"，实际上是"测的是别的判据"。这类比 `if (false)` 更隐蔽，建议纳入审查清单。
- `src/ai/compiler/types.mjs:1360` 的 `ok(true, "WorldState JSON 往返再 assert 通过")` 是**重言式断言**，
  但它上一行 `assertWorldState(normalizeWorldState(...))` 才是真正的断言，且没有 catch —— 行为上等价于"不抛即通过"，
  可接受，但 `ok(true)` 这一条本身零信息量。

---

## 6. 结论：哪些判据其实没被锁住

按严重程度排序：

### P0 — 必须补夹具（判据可以被随便删而测试全绿）

1. **`connect` 的占用检查整体（`checkOccupancy` 返回 `ok`）** — C4 存活。
   `allow_replace=false` 时踩到既有带子，原实现必须 `occupied`；变异体让它**成功铺上去**，36 条测试全绿。
   现有三条"撞墙"用例挡的是机器（走 `fits()`），**没有一条挡的是旧带子且不带 `allow_replace`**。
   补法：照抄 `connect.test.mjs:392` 的夹具，去掉 `allow_replace`（保留 `rebind: true`），断言 `!r.ok && r.error.code === "occupied"`。

2. **`connect.verifyChain` 的 self-overlap 分支** — C6 存活，且全文件零覆盖。
   补法：`verifyChain([{x:0,y:0,...}, {x:0,y:0,...}])` 断言红；或直接单测 `checkOccupancy` 喂重复格。

3. **`gates.gateGDeleteReplay` 的 `cellMismatch`（uid↔cell 交叉校验）** — G4 存活。
   现有 `gMismatch` 用例是被"多删"兜红的，不是被交叉校验红的。
   补法：`removes` 里**把所有消失的 uid 都声明掉**，只让一条 uid+cell 互相矛盾，断言 `ok:false` 且
   `evidence.cell_mismatch === 1` / reason 含「对不上」。实测这份夹具下变异体 `ok:true`。

### P1 — 判据部分失效

4. **`gates.gateGDeleteReplay` 的 `unresolved`（cell 声明落空）** — G9 存活。
   `gCellEmpty` 同样是被"多删"兜红的。补法：`before === after`（世界不动）+ `removes:[{cell:[99,99]}]`，
   断言 `ok:false` 且 `evidence.unresolved === 1`。更糟的是变异体还把这条计入 `evidence.deleted`。

5. **`connect.verifyChain` 的单格自身复解（`solveTurn(entry,exit)` 必须等于记录的 `(rot,rv)`）** — C3 存活。
   负例③的改动改变了面，被面闭合先抓；这条判据从没被独立验证过。

### P2 — 外围（不在本次四模块，但同属"判据没锁住"）

6. `src/bridge/selftest.mjs:197` 的 `assert(x || true)` —— 「桥接主动断开违规连接」这件事没有断言。
7. `connect.test.mjs:82` / `connect.mjs:1259` 的"读不到真实存档就跳过" —— 缺文件时是静默降级/假绿，CI 上应改为 fail 或显式 skip 并计数。

### 已被锁住的（独立复核通过）

- `gates`：G-dr 的正向（stillAlive）、反向（vanished/extraGone）、截断 fail-closed；
  G-rb 的身份比对（数量相同但 uid 变）、内容比对（位置/code）、截断 fail-closed。
  **主线程说的"G-dr / G-rb 都锁住了"在它点名的这几个判据上成立**，但它没覆盖 `cellMismatch` / `unresolved`。
- `connect`：面闭合（含"口径写反"的强反例，17 条红）、位置连续、`code=1+rv`、`replaceable` 计数。
- `remove`：4/4 全杀，且内置 `--mutate` 已防"模块找不到"假绿。
- `mod`：回滚 restore、`delete{uid}` 双寻址、回滚迭代轮数，3/3 全杀。

### 补充观察（不属于假绿，但影响变异测试本身）

- 基线 "373 条" 计数里包含不少正例；对 G-dr / G-rb 这种"某条判据只有 1-2 条用例守"的情况，
  1 红的杀伤力和 10 红的杀伤力不同。建议后续给 P0/P1 的补丁同时补**负例 + 正例对照**（项目现有风格已经是这样）。
- 本次全部 26 个变异体都没有落进 `ERR_MODULE_NOT_FOUND` / `SyntaxError`，且 harness 对这两类做了显式分类，
  排除了"假杀"污染结论的可能。
