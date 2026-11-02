# `rebuild_saveindex` RPC —— 用法与回滚

> 2026-11-02。修 `savegames.bin` 索引损坏（见 `SAVEGAME-INDEX-DEFECT.md`）。

---

## 它做什么

把「磁盘上存在的 `savegame-*.bin`」重新登记进 `savegames.bin` 索引，
让游戏重新能 `list_saves` / `load_save`。

**只写 `savegames.bin` 一个文件**，绝不碰 `savegame-*.bin`。

---

## 参数

```json
{
  "ids": ["<40 位 hex>", ...],
  "dry_run": true
}
```

### 为什么 `ids` 是必需的

游戏的 `StorageInterface`（`platform/storage.js`）只有：

```js
writeFileAsync(filename, contents)
readFileAsync(filename)
deleteFileAsync(filename)
```

**没有列目录 API。** 所以 mod 无法自己发现磁盘上有哪些存档 —— 必须由调用方给。

这反而是好事：**索引里出现哪些存档，由调用方显式决定**，mod 不猜、不编造。

### `dry_run` 默认是 `true`

只传 `ids` 不会写任何东西。必须显式 `dry_run: false` 才真的写。

---

## 怎么跑

### 第 1 步：生成 ids

```bash
node -e "
const fs=require('fs'), path=require('path');
const SAVES=path.join(process.env.APPDATA||'','shapez.io','saves');
const ids=fs.readdirSync(SAVES)
  .map(f=>{const m=/^savegame-([0-9a-f]{40})\.bin\$/.exec(f); return m?m[1]:null})
  .filter(Boolean);
console.log(JSON.stringify({ids, dry_run:true}));
" > .tmpverify/saveindex/rpc-args.json
```

（已经生成好了：`.tmpverify/saveindex/rpc-args.json`，7 个 id）

### 第 2 步：启动游戏

```powershell
Start-Process -FilePath 'D:\Steam\steamapps\common\shapez.io\shapezio.exe' -WorkingDirectory 'D:\Steam\steamapps\common\shapez.io'
```

等 mod 连上（`curl http://127.0.0.1:7777/health` → `mod_connected: true`）。

⚠️ **游戏窗口必须在前台可见** —— 被遮挡时渲染循环停止，`gameStarted` 不触发，
`in_game` 永远是 false（`LIVE-LOG.md` 的 "World wedge"）。

### 第 3 步：dry run

```bash
curl -s -X POST http://127.0.0.1:7777/rpc \
  -H "content-type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"rebuild_saveindex\",\"params\":$(cat .tmpverify/saveindex/rpc-args.json)}"
```

期望输出：

```json
{"result":{
  "ok": true,
  "op": "rebuild_saveindex",
  "index_before": {"count": 0, "ids": []},
  "requested": 7,
  "rebuilt": 7,
  "skipped": [],
  "levels": [
    {"id":"1d9c8293","level":1},
    {"id":"2b380062","level":1},
    {"id":"5c967065","level":11},
    {"id":"629b05f4","level":1},
    {"id":"7c93b3dd","level":4},
    {"id":"8f007207","level":1},
    {"id":"cf469f75","level":5}
  ],
  "bytes_after": <数字>,
  "dry_run": true,
  "changed": false,
  "hint": "确认无误后传 dry_run:false 才会真的写"
}}
```

**核对 `levels`**：必须和 `node .tmpverify/saveindex/build.mjs` 的离线结果一致：

```
1d9c8293 lv1 / 2b380062 lv1 / 5c967065 lv11 / 629b05f4 lv1
7c93b3dd lv4 / 8f007207 lv1 / cf469f75 lv5
```

不一致就**停下**，不要往下走。

### 第 4 步：真写

把 `dry_run` 改成 `false` 再发一次。

### 第 5 步：验证

```bash
curl -s -X POST http://127.0.0.1:7777/rpc \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"list_saves","params":{}}'
```

期望 `saves` 数组里有 7 条。

然后 **重开游戏**（`savegames.bin` 只在启动时读），再 `list_saves` 确认。

---

## 回滚

RPC 在写之前会自动备份成：

```
savegames.bin.pre-rebuild-<ISO 时间戳>
```

要回滚：把那个文件复制回 `savegames.bin`。

另外 `.tmpverify/save-backup-2026-11-01/` 里有本会话开始时的手工备份
（包括 7 个 `savegame-*.bin` 和当时的 `savegames.bin`）。

---

## 已知限制

1. **没有列目录 API** —— 必须显式传 `ids`
2. **`lastUpdate` 用 `Date.now()`** —— storage 不给 mtime，游戏只用它排序
3. **只在游戏启动时读 `savegames.bin`** —— 写完必须重开游戏才生效
4. **不验证索引内容是否被游戏接受** —— 如果 checksum 算错，游戏会
   `bad-content / checksum-mismatch` 并回退到空索引（也就是回到现在的状态，
   不会更糟）。**这一点没测过，是推断。**

---

## 安全边界

- **绝不碰 `savegame-*.bin`** —— 只读它们拿元数据
- **用户存档 `5c967065` 只读** —— 它会被登记进索引，但文件本身不动
- **写前备份** —— 出问题能回滚
- **`dry_run` 默认开** —— 第一次调用不改任何东西
