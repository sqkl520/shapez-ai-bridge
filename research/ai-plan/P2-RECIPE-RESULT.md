# P2 结果：RECIPE 是对的，真正缺的是「目标矿在哪」

> 2026-11-03。这一轮把 P2（查 RECIPE 在真机 prompt 的渲染）做完了，
> 并且顺带挖出并修掉了两个更底层的问题。

---

## 一、P2 的原始假设被证伪

`PARTIAL-ON-FINAL.md` 里我猜的是「模型不知道目标形状需要切，RECIPE 段可能没进 prompt」。
**查完发现不是。**

用真机 obs 重建 prompt（`.tmpverify/p2-recipe/check.mjs`），三条判据全绿：

| 判据 | 结果 |
|---|---|
| `s3_recipe` 非空 | ✅ 490 字符 |
| 与门控后离线渲染逐字节一致 | ✅ |
| **真的拼进最终 user prompt** | ✅ |
| user 含 "cutter" | ✅ |
| 截断压力下配方幸存 | ✅ |

真机 prompt 里的原文：

```
## RECIPE (how the goal shape is made — computed, do NOT guess)
  CuCuCuCu  ⇐  mine   [mine it]
  ----CuCu  ⇐  cut(half="left") from CuCuCuCu   [cut it with a cutter]
  Cu----Cu  ⇐  rotate(dir="cw") from ----CuCu   [rotate it with a rotater]
⇒ machines this shape needs: miner×1, cutter×1, rotater×1
⇒ it does NOT need: stacker, painter — no such step appears above. Do not add them.
```

⚠️ **一个我自己踩的坑**：第一次对照时我用 `solveRecipe`（不门控）比，
它给的是 `cutQuad×2 + stack`，看着像是「真机和离线不一致」的严重 bug。
实际上 `recipeFor` 才是生产路径，它在 L5 会加 `--no-cutquad --no-stacker`，
给出 `mine + cut + rotate`。`cutQuad` 要 L16、`stacker` 要 L10，L5 根本不允许。
这个门控是**已修过的真 bug**（见 `flagsForLevel` 的注释），不是缺陷。

---

## 二、真正的原因：产线在造错的东西，而 prompt 没说

看真机 run 的产出数据（`.tmpverify/live-multiround/runs/.../production-last.json`）：

```
produced_total: {"RuRuRuRu": 99}      ← 钌整块，1.65/s
delivered_total: {"RuRuRuRu": 116}
stored_delta: {"CuCuCuCu":0, "----CuCu":0, ...}   ← 铜相关全是 0
```

目标是 `Cu----Cu`（**铜**的半块），而整条线在产**钌**。模型三轮都在修钌线的堵塞。

再看 prompt 里这两段，它们**紧挨着**：

```
## GOAL
shape: Cu----Cu

## PRODUCTION
produced RuRuRuRu: 105
rate RuRuRuRu: 1.767
```

**没有一句话说它们矛盾。** 模型得自己把两个形状串做「颜色 + 形状」对比才能发现
「整条线在造别的颜色」。它没发现。

### 修改 1：`renderProduction` 加一句对比陈述

```js
if (!producedNames.includes(goal)) {
  lines.push(`⇒ WARNING: nothing above IS the goal shape (${goal}). `
    + `The line is making ${...}, which is a DIFFERENT shape — fixing a jam on it `
    + `will not produce the goal. Check the RECIPE above and whether a miner is on the right color.`);
}
```

只做**陈述**，不猜原因、不给修法。只在确有产出时加（没产出时「空」本身已说明问题）。

---

## 三、更底层的发现：地图资源列表只有 hub 附近

顺着「矿机在挖错颜色」查下去，翻 `obs.resources`：

```
18 个资源，全是 RuRuRuRu，bbox x[2,5] y[-10,-5]
```

**一个铜都没有。** 但用 `resources` RPC 拉大范围，铜是有的：

```
range=64: CuCuCuCu count=53, bbox [-40,-40, 23, 10]
```

根因在 mod：`obs` 的 `resources` 用的是 `effectiveRegion`（**实体包围盒**）。
实体都挤在 hub 附近，所以扫描范围也只有那一小片 —— 而矿在 20 格外。

### 修改 2：资源扫描范围改成「实体 bbox ∪ 固定大范围」

```js
const R = 64;
const resRegion = [
  Math.min(base[0], -R), Math.min(base[1], -R),
  Math.max(base[2], R),  Math.max(base[3], R),
];
```

`±64` = 4×4 个 chunk（chunk 是 16），覆盖铜矿 bbox 两端还有余量。

**真机验证**：

| | 修复前 | 修复后 |
|---|---|---|
| 资源格数 | 18 | **436** |
| `CuCuCuCu` | **0** | **108** |
| `RuRuRuRu` | 18 | 87 |

### 修改 3：把「目标矿有没有、在哪」渲染进 prompt

`renderGoalResource()`，接在 MACHINES 段末尾：

```
⇒ target ore Cu IS on the map: CuCuCuCu×108 (a short run from hub)
```

没有目标矿时反过来说：

```
⇒ target ore Cu is NOT in the scanned area (resources found: RuRuRuRu, ...) 
   — no miner can ever produce Cu here; check for a Cu patch or a different route
```

⚠️ **不许出现坐标**：prompt 有一条硬契约「坐标正则 0 命中」
（`prompt.test.mjs`）。第一版我写了 `nearest 20,5`，当场把那条测试打红。
改成档位（`near hub` / `a short run from hub` / `far from hub`），
模型本来也不许用坐标下指令。

---

## 四、效果：模型第一次说对了

加完资源段后跑真机，第 2 轮的推理：

> "The Cu chain (miner→cutter→rotater→belts→hub) is wired but **fed from the Ru miner**,
> so nothing makes Cu----Cu; **tap the Cu ore run into the existing cutter** and let
> the rotater chain deliver the goal."

**这是三轮实验以来第一次有模型说出「矿机喂的是钌不是铜」。** 之前它只会说
"the rotater's output never reaches the hub"（描述现象，不知道原因）。

---

## 五、还差一步（宏能力缺口，不是 prompt 能修的）

模型现在知道该接铜矿了，但它接不上：

```
r2: connect(B12 → C2.primary)
  ✗ macro_failed
```

因为 `C2` 的输入口已经被 `M1`（那台挖钌的矿机）占死 —— prompt 里写着
`输入=bottom:primary(←M1)`。要接铜矿必须先**换掉/移走那台矿机**，
而现有宏里没有「把矿机挪到某个矿点」或「在某格新建矿机」的能力。

这是一个**真实的宏层缺口**，记在这里：

- `connect` 只能连已有实体到已有端口，不能「连到一个资源格」
- 资源格不是实体，没有 handle，模型无法指名它
- 需要的能力：`insert_machine` 支持 `machine: "miner"` 落在资源格上
  （要验证：矿机 2×2，资源格是否够、origin 该选哪格）

---

## 六、一并修掉的 R13 冲突

这个不是 P2 挖出来的，是同一次真机 run 撞上的。

**现象**：三轮全部 `PLAN_REJECTED / R13 destroys_not_named`，0 次执行。

**冲突**：

| 谁 | 说了什么 |
|---|---|
| prompt 里 `allow_replace` 的描述 | 「路上的开关：是否允许覆盖路径上的既有带子」 |
| R13 | 「删除的每个 uid 都必须是 LLM 点名过的」 |

模型照 prompt 传 `{"allow_replace": true}`，想覆盖路径上的带子；
而**被覆盖的带子从来没被点名过** —— 它是路径推演的产物。
两个都正确的东西互相打架，模型只能反复撞墙。

**R13 原本要拦的是另一回事**：`$bbox_of` 的矩形误框（点 B69/B81/B82，
矩形顺带框进没点名的 B70，删错对象而宏回 `ok:true`）。

**修法**：豁免范围**恰好**是 `derived`（= `connectDestroysFromObs` 按
`cells[] ∩ obs` 补算出来的那部分，只可能来自开了 allow_replace 的 connect）：

```js
const allowedByReplace = new Set(derived.map(d => d.uid));
const extra = deleteUids.filter(u => !named.has(u) && !allowedByReplace.has(u));
```

不改安全边界：覆盖格仍逐格进 `warnings`（`DESTROYS_DERIVED`），审计看得见。

**效果**：

```
[guard] dry_run: 42/42 → 可执行
[guard] real tx: ok=true applied=42
```

**第一次在真机上真正执行了 42 条 op**（此前三次 run 全是 0 次执行）。

---

## 七、测试

| 文件 | 用例 | 变异测试 |
|---|---|---|
| `prompt_production_mismatch.test.mjs` | 7 | 2 个全被抓到 |
| `prompt_resource.test.mjs` | 7 | 5 个全被抓到 |
| `planToTxOps.test.mjs`（R13 段） | +7 | 2 个全被抓到 |

全量 **423/423 通过**。

`tohub_machine.test.mjs` 的 E 用例（prompt 字符预算）里 `capacity` 夹具
上限 3400 → 3460：那个夹具自带 3 格钌矿，会真渲染资源行（+60 字符）。
另外两个夹具（L4 / half）没有 resources，字符数没变。

---

## 八、下一轮做什么

1. **宏能力**：让 `insert_machine` 能在资源格上放矿机（或加一个 `move_miner`）。
   这是当前最硬的阻塞 —— 模型已经知道该做什么，但工具不支持。
2. R13 豁免后 `connect` 能执行了，但**执行了不等于产出**：
   这一轮 42 条 op 落地、L1/L3 全绿，而 `goal_delta=0`。
   下一步要查「连上的线为什么不跑货」。
3. `partial` 在这一轮的真机 run 里出现了 1 次执行（`replace_run`），
   但仍 `partial: false`。
