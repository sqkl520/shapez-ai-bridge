# 重建存档索引：可行性已证明，方案待决策

> 2026-11-02。真机闭环被 `savegames.bin` 损坏卡住。
> 本文记录**已证明的部分**和**需要决策的部分**。

---

## 已证明：payload 算得对

`.tmpverify/saveindex/build.mjs` 从磁盘上 7 个 `savegame-*.bin` 反向解出元数据：

```
1d9c8293  lv1      1575B
2b380062  lv1      1495B
5c967065  lv11    82716B    ← 用户存档（绝不许碰，只是读）
629b05f4  lv1      2725B
7c93b3dd  lv4      3164B    ← 目标世界
8f007207  lv1      1285B
cf469f75  lv5      6517B
```

生成 `{version: 1002, savegames: [...]}`，按游戏的 `compressObject` 形状压缩，
**往返自检通过**（`decompress(compress(x)) === x`）。

⇒ **索引的内容能完全离线算对。** 这是关键的一步。

---

## 卡在哪：checksum 需要游戏内的 salt

`read_write_proxy.js:86-92`：

```js
static serializeObject(obj) {
    const jsonString = JSON.stringify(compressObject(obj));
    const checksum = computeCrc(jsonString + salt);      // ← salt 在游戏里
    return compressionPrefix + compressX64(checksum + jsonString);
}
```

```js
// read_write_proxy.js:19
const salt = accessNestedPropertyReverse(globalConfig, ["file", "info"]);
```

`globalConfig.info.file` 是游戏打包进去的常量，**不在我们仓库里**。

⇒ 离线写不出能被游戏接受的 `savegames.bin`。

---

## 好消息：mod 已经有全部零件

`shapez-ai-bridge.js`：

| 零件 | 位置 | 说明 |
|---|---|---|
| `savegameSalt()` | `:4842` | `shapez.globalConfig.info.file` |
| `computeCrc` | `shapez.computeCrc`（游戏导出） | 直接用 |
| `compressX64` | `shapez.compressX64` | 直接用 |
| `compressionPrefix` | `shapez.compressionPrefix` | 直接用 |
| **完整的写入模式** | `:4816-4818`（`repairSave` 里） | 已经做过一次同样的事 |

`:4816-4818` 这段就是范本：

```js
const newChecksum = shapez.computeCrc(newJson + this.savegameSalt());
const out = shapez.compressionPrefix + shapez.compressX64(newChecksum + newJson);
```

⇒ **写索引这件事，mod 已经有全部能力，只是没暴露成 RPC。**

---

## 两个方案

### 方案 A：给 mod 加一个 `rebuild_saveindex` RPC（推荐）

**改动**：在 `shapez-ai-bridge.js` 里加一个方法，约 40 行：

```js
async rebuildSaveIndex(p) {
    this.assertWritable("rebuild_saveindex");
    const mgr = this.app.savegameMgr;
    // 1. 扫磁盘上所有 savegame-*.bin
    // 2. 对每个读 meta（level / version / lastUpdate）
    // 3. 组 {version:1002, savegames:[...]}
    // 4. computeCrc + compressX64 写回
    // dry_run: 只报告会写什么
}
```

**优点**：
- 走既有 RPC 通道，不改 loop 的代码
- 可以 `dry_run` 先看会写什么
- 与 `repair_save` 同一套模式（已经验证过的）

**风险**：
- **这是写玩家的存档目录**。必须：
  - 默认 `dry_run: true`
  - 写之前备份 `savegames.bin`
  - 只加不删（磁盘上没有的条目不编造）

### 方案 B：mod 启动时自动修复

**改动**：mod 初始化时检查「索引为空 + 磁盘有存档」⇒ 自动重建。

**优点**：不用手动触发。
**风险**：**自动改玩家的文件，没有确认**。不可接受。

⇒ **只有 A 可接受。**

---

## 重建时必须遵守的约束

1. **只加不删** — 磁盘上有什么就写什么，不编造也不遗漏
2. **先备份** — `savegames.bin` → `savegames.bin.pre-rebuild-<ts>`
3. **`dry_run` 默认开** — 第一次调用只报告
4. **不碰 `savegame-*.bin`** — 只写 `savegames.bin` 这一个文件
5. **用户存档只读** — `5c967065` 的元数据从文件名 + 离线解码得到，不打开写

---

## 为什么这件事值得做

真机闭环是所有离线实验的**最终验收**。现在：

- 8 个 bug 修了，但**没有一个经过真机验证**
- 所有重放都跳过 `planToTxOps` / `verifyRuntime` / 坐标溯源
- 真实执行率只会比离线更低

⇒ **只要索引修好，就能验证这一整轮的工作到底在真机上成不成立。**

---

## 我需要用户决定什么

1. **要不要动 mod？** 那是游戏侧的代码，改了会影响所有使用这个 mod 的会话。
2. **如果要，用方案 A 吗？**（加 `rebuild_saveindex` RPC，默认 dry_run）
3. **验证顺序**：先 dry_run 看报告，还是直接修？

---

## 诚实边界

1. **payload 的正确性只是「往返自检通过」**，没有真机验证过游戏会不会接受。
2. **`lastUpdate` 用的是文件 mtime** —— 游戏可能期望别的值（比如内部记录的保存时间）。
   如果游戏只按它排序，mtime 够用；如果要显示「上次游玩时间」，可能差几秒。
3. **`version` 字段用的是 `decodeSave` 报的 `buf[0]`**（都是 1）。而空索引里
   `#:1002` 是 SavegamesData 的 version，两回事。我按 `getDefaultData()` 的
   `getCurrentVersion() = 1002` 填的。
4. **没测过「索引里有条目但文件损坏」的情况** —— 那会让游戏在 `readAsync` 时报错。
