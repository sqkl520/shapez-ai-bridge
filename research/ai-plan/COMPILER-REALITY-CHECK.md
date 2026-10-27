# 编译器的真实成绩：独立实测

日期：2026-10-28
方法：`node src/ai/compiler/cli.mjs --goal G --seed 55013 --hub -2,-2 --level 5 --no-handoff [--world F]`

---

## 空地：9/12

```
✓ CuCuCuCu   ✓ ----CuCu   ✓ Cu----Cu   ✓ Ru----Ru
✓ RuRuRuRu   ✓ Cu------   ✓ --CuCu--   ✓ RbRb----   ✓ --SuSu--
✗ CrCrCrCr   ✗ CpCpCpCp   ✗ RuRu----
```

**红队报告说 6/12，实测是 9/12。** 那个数字偏悲观。

## 带真实世界（181 实体）：0/4

```
✗ CuCuCuCu    dag-not-placeable:column-conflict-unresolved / V6-crossing
✗ ----CuCu    ✗ Cu----Cu    ✗ RuRuRuRu
```

**这是本项目最尖锐的事实：编译器在真实存档上完全不可用。**

## 一处对红队报告的修正

红队说根因是 `regionClear()` 一票否决（"世界里除 hub 外有任何实体就拒绝"）。

实测发现：修复 `--world` 合流问题之后，`CuCuCuCu` 失败的原因是
**`V6-crossing`（布线撞车）**，不是 `no-site-large-enough`。

说明 `regionClear` 在钉死 hub 的路径上（`compile.mjs:1044`）虽然还在，
但多候选 anchor 里有位置躲开了既有实体 —— **`regionClear` 不再是唯一杀手，
布线撞车是新的主要失败模式。**

结论不变：**带真实世界 0/N。** 但根因比红队说的更分散。

## 三类失败模式的实测分布

| 失败 | 出现次数 | 含义 |
|---|---|---|
| `V6-crossing` / `column-conflict-unresolved` | 多数 | 布线撞车，hub 入口接不上 |
| `no-site-large-enough` / `V9-unused-outlet` | 少数 | 选址空间不足，或废料槽接不上 trash |

两类共同点：**都需要多流路汇入 hub**。能过的九个目标里，多数是单产线或简单结构。

## 这意味着什么

1. **编译器不是"差一点"，是"在真实场景下为零"**
2. 它的价值全在**空地**，而真实存档永远不是空地
3. 继续加厚编译器（补建筑、优化布线），收益上限是"让 9/12 变成 11/12"，
   但真实场景仍然是 0 —— **除非它能接受"世界不干净"**

## 一个反方观点（公平给出）

编译器并非一文不值：
- 它产出的 `op-templates.mjs` 几何真值库（槽位、footprint、code）是**独立可用的资产**
- `src/ai/world.mjs` 的矿图复现 3002/3002 逐格对拍
- 它的验证器 V1-V10 抓到过真实的几何错误

**问题不在"写了编译器"，在"把编译器当主线"。**
