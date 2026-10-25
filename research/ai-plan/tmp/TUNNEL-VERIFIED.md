# 隧道实测（P0-1，实机，2026-10-26）

**结论：隧道在实机上真的能运货。这三条以前只靠读源码的说法，现在成为一手事实。**

| 命题 | 证据 |
|---|---|
| 物品能穿过隧道 | arm A 送达 8 个铜；中间 3 格**全空**，带子无法跨越 |
| 送达不是装置自己产生的 | arm C（同装置、无隧道）送达 **0** |
| 我们的粘贴不破坏隧道下的带子 | arm D 贴完后 3/3 条带子存活 |
| 这个检查能变红 | arm E（不走保护路径）3/3 条带子**全被删**，C4 复现 |

脚本：`research/ai-plan/live/exp-tunnel-transport.mjs`、`exp-tunnel-falsify.mjs`
原始记录：`research/ai-plan/live/results/tunnel-transport.json`、`tunnel-falsify.json`

---

## 1. 装置

```
miner ──► belt ──► sender ═══ 3 EMPTY CELLS ═══► receiver ──► belts ──► corner ──► hub
(-11,10) (-10,10) (-9,10)   (-8,-7,-6)          (-5,10)      (-4,-3)   (-2,10)    (-2,2)
```

**中间三格刻意留空**，这是整个实验的核心。带子需要连续实心链，三格空着就**不存在**任何
仅靠带子的路径从矿机通到 hub。物品如果真的到了，只可能是穿过隧道来的——没有别的路。

跨度 4 格（sender 在 x，receiver 在 x+4）是 tier-1 的上限：
`findRecieverForSender`（`systems/underground_belt.js:225-290`）最多搜
`undergroundBeltMaxTilesByTier[0] = 5` 格，遇到空格 `continue`，遇到第二个 sender 就停。

## 2. 三条证伪

一门实验只有能失败才叫实验。这里三条都设计成可以变红。

### arm A/B — 隧道 vs 对照

同一套装置，把隧道那 5 格换成 5 条同向直带，其余每一格（矿机、进隧道前的带子、
出隧道后的带子、拐角、竖直段、hub 入口）**逐格相同**。唯一变量就是隧道本身。

| arm | 装置 | 送达 |
|---|---|---|
| A | 隧道 + 3 空格 | **+8**（3900 ticks） |
| B | 5 条直带 | +8（3900 ticks） |

B 是对照：B 不送达就说明装置坏了，A 的结果不可读。两者都是 8，说明装置工作正常，
且隧道的通过能力和普通带子同级。

### arm C — 阴性对照

同装置，缺口**既没有隧道也没有带子**：

```
miner ──► belt ──► belt │      (nothing)      │ belt ──► corner ──► hub
```

**送达 0**（4200 ticks）。空缺口里物品过不去——传感器不会自己响。

### arm D — 生产路径保护带子

先铺 3 条带子在缺口里，再用 `paste_blueprint`（生产路径，带挂起逻辑）贴隧道覆盖它们。

结果：**3/3 存活**，`smartplace_suspended=true`。

### arm E — 证明 arm D 能变红

同样的布置，但 receiver 用裸 `place` 放置、`enableTunnelSmartplace` 保持开启——
也就是玩家手动操作、**没有**我们保护逻辑的路径。

结果：**3/3 全被删**。

arm E 是关键：它证明 arm D 的"存活"不是因为 C4 在本版本失效，而是因为 fbfe0fe 的挂起
逻辑真的起作用了。没有 arm E，arm D 的绿是假的。

## 3. 顺带确认的编码事实

`codesAt` 实测：

```json
{"cell":[-9,10], "at":{"code":22,"type":"underground_belt","rv":0}},   ← sender
{"cell":[-5,10], "at":{"code":23,"type":"underground_belt","rv":1}}    ← receiver
```

code 22/23 与 `rv` 0/1 的对应关系，以前是从源码和存档推的，现在是一手观测。

`sender` 用 `r=90` + code 22 放置，`receiver` 用 `r=90` + code 23 —— 注意两者 **rotation
相同**，方向靠 code 区分，不是靠 rotation 翻转。这与 `src/ai/op-templates.mjs` 的
`TUNNEL_TEMPLATES` 设计一致。

## 4. 实测暴露的缺陷：`planMinerColumns` 太刚性

做完隧道实测后，用**真实存档的种子**跑完整编译：

```
node src/ai/compiler/cli.mjs --goal "CgScScCg" --seed 60908 --hub "-2,-2" --tunnels
→ ok:false, reason: no-resource-in-range
```

5 台矿机的相对偏移被 `planMinerColumns` 硬定死：

```
n0      @ rel(0,0)     SuSuSuSu
-b------@ rel(-8,0)    blue
-g------@ rel(-4,0)    green
n6      @ rel(4,0)     CuCuCuCu
---g----@ rel(-12,0)   green
```

然后只在**水平方向**上整体平移去匹配。放大到 `--range 256` 结论不变（每个矿种都有上
千格可选，但刚性偏移组合不上）。

**这不是搜索范围问题**，是几何硬约束：真实地图的矿簇是随机散布的，不可能恰好满足
"五种矿相对某个锚点呈 -12/-8/-4/0/+4 的等距排列"。

离线测试用的 `seed 43391` 恰好满足了这个关系，所以一直是绿的。**换一个真实种子立刻暴露。**

这印证了 P0 的排序理由：离线全绿不代表真实可用，而隧道本可以是解决矿机落点分散的手段——
现在它被"矿机必须先排成一条刚性直线"这个上游约束挡住了，轮不到它起作用。

修法方向（留给 P1）：`planMinerColumns` 应当逐台独立选矿，而不是先钉死相对偏移；
多条矿机馈线本来就需要各自独立的通道，这正是拓扑要处理的事。

## 5. 实验卫生

- 全程只用**已有的测试存档**（`7c93b3dd`，seed 60908），没有新建存档
- 玩家 level-11 存档 `5c967065...` 全程未触碰
- 每个 arm 跑完立刻 `bulk_delete` 清场，并断言清空（清场后实体数回到 1，只剩 hub）
- 结束时 `enableTunnelSmartplace` 已确认恢复为 `true`
