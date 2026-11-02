# 真机闭环打通了 —— 存档索引重建成功

> 2026-11-02。**这是本会话最重要的进展。**
> 困扰了整轮的阻塞（`savegames.bin` 索引损坏）已解除。

---

## 结果

```
list_saves → 7 条，level 全对
load_save 7c93b3dd → ok
status     → in_game: true, hub_level: 4
obs        → 42 实体，level 4，目标 RuRu----
stored     → {"CuCuCuCu":12,"----CuCu":686,"RuRuRuRu":2016,"----RuRu":4575}
```

**世界内容和离线解码逐字一致。**

---

## 怎么做到的

### 1. 先证明「内容能算对」（离线）

`.tmpverify/saveindex/build.mjs` 从磁盘上 7 个 `savegame-*.bin` 反向解元数据，
按游戏的 `compressObject` 形状压缩，**往返自检通过**。

### 2. 定位到唯一的阻塞：salt

`read_write_proxy.js:90` 要 `computeCrc(jsonString + salt)`，
而 `salt = globalConfig.info.file` 是游戏打包的常量 —— 仓库里没有，离线拿不到。

### 3. mod 已经有全部零件，只是没暴露成 RPC

| 零件 | 位置 |
|---|---|
| `savegameSalt()` | `shapez-ai-bridge.js:4842` |
| `computeCrc` | `shapez.computeCrc`（游戏导出） |
| `compressX64` / `compressionPrefix` | 游戏导出 |
| **写入范本** | `repairSave` 的 `:4816-4818` |

### 4. 加 `rebuild_saveindex` RPC（约 100 行）

关键设计决定：

**`ids` 是必需的，mod 不能自己扫磁盘。**
因为游戏的 `StorageInterface`（`platform/storage.js:7-55`）只有
`readFileAsync` / `writeFileAsync` / `deleteFileAsync` —— **没有列目录 API**。

这反而更安全：**索引里出现哪些存档，由调用方显式决定**，mod 不猜、不编造。

### 5. dry_run 先跑，核对再写

dry run 输出的 `levels`：

```
1d9c8293 lv1 / 2b380062 lv1 / 5c967065 lv11 / 629b05f4 lv1
7c93b3dd lv4 / 8f007207 lv1 / cf469f75 lv5
```

与离线结果**完全一致** ⇒ 才传 `dry_run: false` 真写。

### 6. 重开游戏让内存重新加载索引

`savegames.bin` 只在启动时读（`savegame_manager.js:226-235` 的 `initialize()`）。
写完不重开，内存里的 `currentData` 还是旧的。

---

## 安全措施（都做到了）

| 措施 | 结果 |
|---|---|
| **写前备份** | `savegames.bin.pre-rebuild-2026-11-02T09-34-33-824Z`（127 字节原件） |
| **`dry_run` 默认开** | 必须显式 `dry_run: false` 才写 |
| **只写一个文件** | 只碰 `savegames.bin`，`savegame-*.bin` 全部只读 |
| **用户存档只读** | `5c967065` 被登记进索引，文件本身未动 |
| **只加不删** | 磁盘上有什么写什么，`skipped: []` |

---

## 回溯：为什么这个 bug 值得花这么多功夫

索引一旦变空，`initialize()` 读到空就**回写空**（`savegame_manager.js:226-235`），
`.backup` 也被覆盖。这是一个**自我强化**的损坏。

而且 `snapshot_load` 也走 `load_save`（`bridge.mjs:505`）——
所以所有依赖 snapshot 的安全网在索引损坏时**一起失效**。

⇒ 它不是「一个小配置问题」，是**整个真机验证链路的前提**。

---

## 现在可以做什么了

**这是会话开始以来第一次，可以验证那些离线结论在真机上成不成立。**

八轮修复、十几个实验，全部跳过 `planToTxOps` / `verifyRuntime` / 坐标溯源。
真实执行率只会比离线的 5% 更低。

下一步该跑真机 loop，看：
1. 那些修好「接口错误」的改动在真机上有没有用
2. `planToTxOps` 那层会拒掉多少（离线重放跳过了它）
3. `verifyRuntime` 的 L0-L4 会不会判红

⚠️ **真机跑之前必须做的**：
- `snapshot_save` 备份当前世界
- 只写 `7c93b3dd`，绝不碰 `5c967065`
- 跑完 `snapshot_load` 复原

---

## 诚实边界

1. **没验证 checksum 是否被游戏接受** —— 但事实上成功了（`list_saves` 返回 7 条），
   所以 checksum 是对的。
2. **`lastUpdate` 全用 `Date.now()`** —— 7 条同一时刻。游戏只用来排序，不影响功能，
   但主菜单的「上次游玩」显示会都变成刚刚。
3. **`skipped: []`** 说明 7 个都能解码。如果将来有条目解不开，脚本会跳过并报告，不猜。
4. **这次成功依赖于我手工生成 `ids`** —— 如果存档增减，需要重新生成。
5. **mod 现在装的是改过的版本**（`src/mod/` 与 `%APPDATA%/mods/` 已同步）。
