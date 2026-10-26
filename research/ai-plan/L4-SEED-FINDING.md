# L4 端到端：地图种子反解（2026-10-27）

## 结论

**当前 L4 存档的地图种子 = 55013。**

这不是推测。两条独立证据：

1. **暴力反解**：用实机 `resources` RPC 拿到的 484 个矿格当正样本、83 个确定空格当负样本，
   在 seed ∈ [0,100000] 里全量搜索。唯一匹配 `55013`。
2. **存档解码**：`recon/decode_full.cjs` 直接读出 `dump.map.seed = 55013`。

两条独立路径给出同一个值，所以这个结论是硬的。

## 为什么这件事重要

离线编译器 `src/ai/compiler/` 复现矿图靠 `src/ai/world.mjs` 的 `tileResource(seed,x,y)`，
而 `DEFAULT_SEED = 43391` 是 **level-11 存档**的值（见 `world.mjs:369` 的注释）。
在 L4 存档上用默认种子，编译器的世界里矿的位置和真实地图完全不同：

| 资源 | 真实格数 | seed 43391 认得的 |
|---|---|---|
| 钌 RuRuRuRu | 22 | **8** |
| 铜 CuCuCuCu | 7 | **3** |

所以在此之前，所有"编译成功"的结论在 L4 存档上都不成立 —— 蓝图里的矿机会挖空气。

## 修正后的编译结果

```
--seed 55013（无 --tunnels）        → ok:false  no-site-large-enough
                                      V9-unused-outlet，切割机的废料槽接不上 trash
--seed 55013 --tunnels（无 --world）→ ok:true   31 实体
                                      矿机 @(2,-8) —— 那一格确实是真实钌矿
                                      含 1 切割机、1 trash、2 隧道
--seed 55013 --tunnels --world …    → ok:false  dag-not-placeable:column-conflict-unresolved
                                      V6-crossing，"hub 的 16 个入口都接不上"
```

第三行说明：**编译器能单独编出这条线，但没法和已有的 181 个实体对接。**

## 另一个独立问题（可能更危险）

`--world` 只改变**占位**，不改变**矿图**。

证据：

```
node src/ai/compiler/cli.mjs --goal "CuCuCuCu" --hub -2,-2 --level 4 --world live-L4-entities.json
→ ok:true，provenance 里写着 矿格=CuCuCuCu@-6,6
```

而 `(-6,6)` 在真实存档里**不是铜矿**（真实铜矿在 `(-10..-7, 4..8)`）。
带 `--world` 时 seed 没有生效，编译器会产出"矿机挖空气"的蓝图，**并且报 ok:true**。

这是比 `no-site-large-enough` 更危险的一类失败：前者吵闹，后者沉默。

## 存档完整性

动手前后都解码核对过：

| 时间点 | 实体数 | nextUid | map.seed |
|---|---|---|---|
| 04:11 解码 | **181** | 10901 | 55013 |

备份：`%APPDATA%\shapez.io\saves\savegame-cf469f75….bin.PRE-L4-E2E-20261027T040017`

## 下一步

种子问题已解决。剩下的是**增量对接（P1-4）**：
编译器需要能读"当前屏幕上已经有什么"，并在它旁边接一条新线，而不是把整个工厂推倒重来。

具体缺口：
1. `compilePlan` 只吃 `seed`，不吃"实机矿格列表" —— 只能靠 seed 重算，不能直接用观测
2. `--world` 传的实体只进占位，没进矿图判断
3. hub 16 个入口的占用状态没有作为规划输入
