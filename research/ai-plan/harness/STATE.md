# P8 harness — STATE

> 最后更新：本轮收尾。L0 全绿；`run-all` 13/13 组绿。

## 进度

| # | 项 | 状态 |
|---|---|---|
| 1 | `compile.mjs` 骨架 → 逐段填实（inspectGoal/solveGoal/rebuildDag/mapOps/pigmentGate/place/route/site/validate/emit） | ✅ |
| 2 | `compilePlan()` 永不 throw + 结构化失败（reason ∈ §2.5 + `class` 精确码 + `stages` 逐段） | ✅ |
| 3 | 加宽重试闭环（rowGap/colGap ×3 + 通道序 asis/long/short，确定性笛卡尔积） | ✅ |
| 4 | `cli.mjs`（`--goal/--seed/--hub/--site/--json/--out`，人读摘要 + JSON） | ✅ |
| 5 | 交接件三件套（`out/`，只在 validator.pass 时写） | ✅ |
| 6 | L0 `test.mjs`（A-I 九组，253 断言） | ✅ |
| 7 | `run-all.mjs`（13 组 / ≈1873 断言 / grep lint） | ✅ |
| 8 | L3（真机 paste + `hub_delivered_increased`） | ⛔ **不归本包**（P7）；交接件已就绪 |

## 当前能力边界（诚实）

- **能出蓝图**：`CuCuCuCu` / `RuRuRuRu` / `Cu----Cu` / `--CuCu--` / `Ru----Ru` / `--SuSu--`（6 个，全过 P5 闸）。
- **布不通（上游阻断，已精确归因）**：
  - `----CuCu`、`CuCu----`、`RuRu----` —— P3 废料通道压 hub 底排（NOTES B-1，V3）
  - 所有上色目标（`CrCrCrCr`/`RbRb----`/`CgScScCg`…）—— solver 折颜料、painter color 槽无供料（NOTES B-2，V4）
  - 多分支汇合（`CgScScCg` 几何层）—— P3/P4 车道冲突（NOTES B-3）
- 多层目标 —— v1 scope 明确拒（`out-of-scope:multilayer`），设计如此。

## 下一步（blocked on 主线程）

1. 裁决 NOTES §5 的 4 条（尤其 B-2 归谁修：solver 在禁改清单里）。
2. 上游修好后：`node research/ai-plan/harness/test.mjs` 应自动把 `----CuCu`/`CrCrCrCr` 从「断言失败语义」翻成「断言通过」——
   把 C5/C4 两组的断言目标改成正向即可（现在锁的是失败语义，不是能力）。
3. P7 拿 `out/*.intent.json` 做 L3；回写 `live/results/` 后本包的 `readLiveResults()` 可汇总。
