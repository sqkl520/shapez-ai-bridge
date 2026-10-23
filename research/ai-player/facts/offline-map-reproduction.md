# 🎯 离线资源图复现：成功（主 Agent 实测）

> **这是本次研究最重要的单项技术突破**：AI 现在可以在**不开游戏**的情况下，从 `map.seed` 算出整张资源图。

## 结论

shapez 1.5.6 的资源图是 **`map.seed` 的纯确定性函数**，可在 Node 里逐格复现。

## 证据（实测）

实现：`research/ai-player/proto/gen-resources.mjs`（纯 JS，零依赖，逐行对照上游源码）

```
$ node research/ai-player/proto/gen-resources.mjs 43391 --validate
seed=43391  区域: x[-28,231] y[-189,123]
live 资源格: 3002   离线生成: 3284
✅ 完全一致: 3002
❌ 形状不符: 0
❌ live 有/离线无: 0
⚠️  离线有/live 无: 282  （未探索 chunk）

chunk 级: 111/111 个 chunk 逐格完全一致
```

**3002/3002 一致，0 不符，111/111 chunk 逐格相同。** 282 个"多出来"的格子经查是游戏尚未生成/探索的 chunk（游戏按需生成 chunk）。

## 算法（含关键细节）

来源：`recon/upstream-full/src/js/game/map_chunk.js`、`src/js/core/rng.js`、`src/js/core/config.js:72`

1. **chunk 大小 16×16**（`config.js:72 mapChunkSize: 16`）。
2. **每 chunk 一个独立 RNG**，种子 = **字符串拼接** `"<chunkX>|<chunkY>|<map.seed>"`（`map_chunk.js:277`）——
   注意是**字符串**，不是数值合成。RNG 是 **ALEA**（Baagøe，`rng.js:67`）。
3. **预置 chunk**（`generatePredefined`，`map_chunk.js:311`）——原点附近手工放置：
   - `(0,0)` → red 色块 @ (7,7)
   - `(-1,0)` → `CuCuCuCu` @ (16-9, 7) = (7,7)
   - `(0,-1)` → `RuRuRuRu` @ (5, 16-7) = (5,9)
   - `(-1,-1)` → green 色块（随机位置）
   - `(5,-2)` → `SuSuSuSu` @ (5, 9)
   这些 `overrideX/Y` 仍会**先消耗 2 次 `nextIntRange`**（源码无条件先算再覆盖）——RNG 序列必须照抄。
4. **否则**（`generatePatches`）：`d = round(|chunkCenter|)`（到原点距离，单位 chunk）
   - 色块概率 = `(0.9 - clamp(d/25,0,1)*0.5) / 4`，尺寸 = `max(2, round(1 + clamp(d/8,0,4)))`
   - 形状块概率同上，尺寸同上
   - **色块可选颜色**：`[red, green]`，`d > 2` 时加 `blue`（`map_chunk.js:200`）
   - **形状权重**（`map_chunk.js:224`）：`rect:100, circle: round(50+clamp(d*2,0,50)), star: round(20+clamp(d,0,30)), windmill: round(6+clamp(d/2,0,20))`；
     `d < 7` 时 star/windmill 权重归零。
5. **形状块的象限构成**（`map_chunk.js:239`）——**这是"为什么地图上有混合形状"的答案**：
   - `d < 10`：**4 象限同形**（`[a,a,a,a]`）→ 纯形状如 `RuRuRuRu`
   - `10 <= d < 15`：**两两相同**（`[a,a,b,b]`）→ 如 `RuRuSuSu`
   - `d >= 15`：**四象限各自随机** → 如 `RuWuSuRu`
   - **风车不会成对出现**：若 >1 个 windmill，则强制 `[0]=[1]=rect`（`map_chunk.js:254`）
   - 颜色一律 `uncolored`（'u'）
6. **patch 形状生成**（`internalGeneratePatch`）：椭圆的叠加，逐格 `if (!occupied) set`——
   **先到先得，后画的补在前面没覆盖的地方**（所以 color patch 先画、shape patch 后画，形状会填色块的空隙）。

## 对"AI 玩家方案"的意义（变革性）

1. **全局离线规划成为可能**：AI 拿到 `map.seed`（`obs`/存档里都有）就能**离线算出整张资源图**，
   不需要"边探索边发现"。选址、物流距离、原料可得性——全部可以**离线优化**。
2. **配方可行性可离线判定**：知道地图上有哪些形状/颜色 → 知道哪些目标形状可造、要几步。
3. **确定性实验**：同一 seed 的规划可离线反复试错，再一次性实机执行。
4. **可缓存**：整个世界的资源图可在毫秒级生成（3284 格实测 < 1s），可以做成 agent 的"世界知识"。
5. **与 `step` 快进互补**：`step` 是"时间快进"，离线地图是"空间预知"——两者合起来，AI 有了
   "全知的规划 + 可验证的执行"。

## 待验 / 局限

- **282 格差异**：已确认是未探索 chunk（游戏按需生成）。**AI 若要在未探索区域建厂，离线图仍然准确**
  （因为算法是纯函数）——但这需要**实机验证**：在离线预测有资源、游戏里还没生成的坐标放矿机，
  是否成功？【待验】— 这是最有价值的下一个实机实验。
- 风车（windmill）形状在初始区域不生成（`d < 7` 权重为 0）——影响早期配方。
- `MODS_ADDITIONAL_SHAPE_MAP_WEIGHTS` 是 mod 钩子（`map_chunk.js:16`），**装了会改地图**——
  我们的 mod 没用它，所以纯净。如果用户装了别的 mod 改了这个，离线图会不准。**已在 `compat.json` 的
  硬失败机制保护范围内**（版本不符直接拒绝），但**同类版本不同 mod 组合**是真实风险，需在文档标注。

## 复现方法

```bash
node research/ai-player/proto/gen-resources.mjs 43391 --validate     # 与实机数据对拍
node research/ai-player/proto/gen-resources.mjs <seed> -100 -100 100 100   # 生成任意区域
```
