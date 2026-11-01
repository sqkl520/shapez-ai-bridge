# 存档索引损坏 —— 真机闭环的真实阻塞点

> 2026-11-02。这是「真机闭环为什么跑不起来」的完整记录。
> **结论：存档文件全部完好，损坏的是游戏自己的存档索引。**

---

## 现象

| 检查 | 结果 |
|---|---|
| 游戏进程 | 已启动（shapezio.exe），mod 已连上（`/health` → `mod_connected: true`） |
| `GET /status` | `in_game: false`（停在主菜单） |
| `list_saves` | **`{"saves":[]}`** —— 一个存档都不列 |
| `load_save 7c93b3dd…` | **2002 `game_rejected: no savegame with internal_id …`** |
| 磁盘上的 `savegame-*.bin` | **全部完好**，能离线解码 |

---

## 存档文件本身是好的（离线解码证明）

```
savegame-7c93b3dd9e949c561e5aa529974973b18c856b45.bin   3164 字节
  → decodeSave() 成功
  → level 4, seed 60908, 42 实体
  → storedShapes {CuCuCuCu:12, ----CuCu:686, RuRuRuRu:2016, ----RuRu:4575}
  → upgradeLevels {belt:1, miner:1, processors:0, painting:0}

savegame-5c96706563c0b74c4d2ce4c7f8bf7a244392de89.bin   82716 字节（用户存档）
  → 未动，sha256 未变
```

**目标世界和用户存档都完好。丢的只是「游戏认不认为它们存在」。**

---

## 根因：`savegames.bin` 被截断成空索引

```
C:\Users\Administrator\AppData\Roaming\shapez.io\saves\savegames.bin
   127 字节   mtime 2026-11-01 20:56:22
   内容：只有 1 个字节非零 → 实际是空索引（savegames: []）

C:\Users\Administrator\AppData\Roaming\shapez.io\saves\savegames.bin.backup
   1053 字节  mtime 2026-11-01 03:23
   内容：1053 字节全是 0x00 —— **备份本身也是空的**
```

### 代码路径

```
mod 的 loadSave()  （shapez-ai-bridge.js:4859）
  → this.app.savegameMgr.getSavegameById(id)          （:4861）
     → getGameMetaDataByInternalId(id)                （savegame_manager.js:122-132）
        → for (… this.currentData.savegames …)        ← 遍历的是内存里的索引
```

```js
// recon/upstream-full/src/js/savegame/savegame_manager.js:75-77
getSavegamesMetaData() {
    return this.currentData.savegames;
}
```

```js
// recon/upstream-full/src/js/savegame/savegame_manager.js:226-235
initialize() {
    // First read, then directly write to ensure we have the latest data
    return this.readAsync().then(() => {
        …
        return this.updateAfterSavegamesChanged();   // ← 读完立刻回写
    });
}
```

`currentData` 由 `ReadWriteProxy.readAsync()` 从 `savegames.bin` 反序列化。
**读到空索引 → 立刻把空索引写回去 → `.backup` 也被覆盖成空。**

⇒ **这是一个自我强化的损坏：一次读到空，之后永远是空。**

---

## 什么时候坏的

| 时间 | 事件 |
|---|---|
| 2026-11-01 03:23 | `savegames.bin.backup` 的 mtime（那时还是 1053 字节） |
| 2026-11-01 20:51 | 我启动游戏（Steam 日志：`Game process added … ProcID 31676`） |
| 2026-11-01 20:56 | `savegames.bin` 变成 127 字节（**游戏启动 5 分钟后**） |
| 2026-11-01 21:00:54 | 我第一次 `load_save` → 2002（**已经太晚**） |
| 2026-11-01 21:18:31 | 游戏进程退出（Steam 日志 `Game process removed`） |

**关键**：`load_save` 失败发生在 21:00:54，**索引在 20:56 就已经是空的了**。
所以不是「我 load 失败导致索引坏」，是**索引先坏，load 才失败**。

至于 20:56 那 5 分钟里发生了什么 —— **没有证据能确定**。
可能是上次会话遗留、可能是游戏启动时的某个初始化路径。
`savegames.bin.backup` 也是全零，说明损坏至少发生过两次（否则 backup 会是好的那次）。

---

## 恢复路径

### 方案 A：从备份重建索引（**不可行**）

`savegames.bin.backup` 全零，不能用。

### 方案 B：从 `savegame-*.bin` 反向重建（**可行，已追到全部依赖**）

磁盘上 7 个存档文件都能离线解码，能拿到 `internalId` / `level` / `lastUpdate`。

`savegames.bin` 的格式（`read_write_proxy.js:86-92`）：

```js
static serializeObject(obj) {
    const jsonString = JSON.stringify(compressObject(obj));
    const checksum = computeCrc(jsonString + salt);
    return compressionPrefix + compressX64(checksum + jsonString);
}
```

**三个依赖都追到了：**

| 依赖 | 出处 | 说明 |
|---|---|---|
| `computeCrc` | `core/sensitive_utils.encrypt.js:22-24` | `"crc32".padEnd(32,"-") + crc32(str).toString(16).padStart(8,"0")` —— **纯 CRC32，可完全复现** |
| `salt` | `core/read_write_proxy.js:19` | `accessNestedPropertyReverse(globalConfig, ["file","info"])` = `globalConfig.info.file`（mod 的 `savegameSalt()` 已经解决，见 `shapez-ai-bridge.js:4843-4856`） |
| `compressX64` / `compressObject` | `core/lzstring.js` | 仓库里已有实现：`src/shared/lz-string.cjs` |

⇒ **可行的做法**：写一个 mod RPC（或临时逻辑），用
`this.savegameSalt()` + 游戏的 `compressObject` / `compressX64` / `computeCrc`
重新生成 `savegames.bin`。

⚠️ 仍然属于「改代码」范畴，不在诊断任务里做。但它**不是不可行的**。

### 方案 C：`new_game` 绕过索引（**能进世界，但救不回目标存档**）

```js
// recon/upstream-full/src/js/savegame/savegame_manager.js:141-160
createNewSavegame() {
    const id = this.generateInternalId();
    const metaData = { lastUpdate: Date.now(), version: …, internalId: id };
    this.currentData.savegames.push(metaData);      // ← push，不是覆盖
    this.updateAfterSavegamesChanged();
    return new Savegame(this.app, { internalId: id, metaDataRef: metaData });
}
```

`new_game` 不依赖索引，它会 `push` 一条新 meta 并回写 ——
**这会让 `savegames.bin` 重新变成非空**，但里面只有新建的那一条。

⇒ 能进世界、能验证「桥接 → loop → LLM → tx → verify」全链路，
**但 `7c93b3dd` 仍然不在索引里，仍然 load 不了。**

---

## 防止再发生

1. **启动游戏前备份 `savegames.bin`**（当前 `savegames.bin.backup` 机制不可靠 —— 它也被覆盖了）
2. **诊断脚本里加一条前置断言**：
   ```bash
   node -e "…" # list_saves 为空 → 立刻停下并报警，不要继续尝试 load_save
   ```
   这一轮就是「先 load 失败、再 list 才发现」，浪费了时间。
3. **`snapshot_load` 也走 `load_save`**（`src/bridge/bridge.mjs:505`），所以**它也一起坏了**。
   这意味着所有依赖 snapshot 的安全网在索引损坏时全部失效 —— 这是安全层面的问题。

---

## 对「真机闭环」的影响

**真机闭环有一个未解决的环境依赖，而它不是 loop 的 bug。**

本轮所有实验（A/B 三臂、宏重放、预算分析）**全部是离线的**，
用的是 `.tmpverify/capacity-scenario.json` 和 `test/fixtures/saves/L4-obs.json`。

⇒ **本轮的结论没有一个经过真机验证。** 这一点必须写在任何引用它们的地方。

---

## 诚实边界

1. **20:56 那次损坏的具体原因没查明。** 我只知道时间点和结果。
2. **`new_game` 能进世界这一点是读代码得出的，没有实测**（游戏进程已退出，且重启需要授权）。
3. **重建索引的方案 B 没实施。** 三个依赖（`computeCrc` / `salt` / `compressX64`）
   都追到了出处，`computeCrc` 是纯 CRC32 可完全复现，但**没有实际跑通一次**。
4. **用户的其它 6 个存档也一起不可见了**，不只是目标存档。这是全盘问题。
