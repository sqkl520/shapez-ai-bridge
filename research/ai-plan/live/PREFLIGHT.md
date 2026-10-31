# 实机开工前检查清单（PREFLIGHT）

> 由 P5 安全护栏包交付。**每一条都是可以机械执行的命令或断言**，不是"注意一下"。
> 模块：`research/ai-plan/live/guard.mjs`　测试：`research/ai-plan/live/guard.test.mjs`
>
> 自测：`node research/ai-plan/live/guard.mjs --selftest` → `71/71 passed`
> 测试：`node --test research/ai-plan/live/guard.test.mjs` → `23/23 pass`

---

## 0. 世界观（为什么这些数字是这样）

| internal_id 前 8 位 | level | 实体 | 角色 | 本轮可否写 |
|---|---|---|---|---|
| `7c93b3dd` | 4 | 1 | **本轮唯一目标世界** | ✅ 唯一允许 |
| `5c967065` | 11 | 3093 | **用户正式存档** | ❌ 绝对禁止 |
| `cf469f75` | 5 | 181 | L4/L5 离线夹具来源 | ❌ 动了夹具就失真 |
| 其余 4 个 | 1 | 0 | 空存档 | ❌ 本轮不在白名单 |

`guard.mjs` 的白名单是 `ALLOWED_WORLDS = {7c93b3dd...}` —— **不在表里的一律拒绝**，不是黑名单。

---

## 1. 目标世界白名单断言（`7c93b3dd` 之外一律拒绝）

```bash
# 1a. 机械校验：白名单常量与目标 id 一致
node -e "import('./research/ai-plan/live/guard.mjs').then(G=>{
  const ok = G.ALLOWED_WORLDS.size===1 && G.assertAllowedWorld(G.TARGET_INTERNAL_ID)===true;
  if(!ok) { console.error('FAIL: whitelist drift'); process.exit(1); }
  console.log('OK allowlist =', [...G.ALLOWED_WORLDS]);
})"
```

```bash
# 1b. 机械校验：三个"禁区" id 都必须抛错（退出码非 0 即失败）
node -e "import('./research/ai-plan/live/guard.mjs').then(G=>{
  const bad=[G.HOME_INTERNAL_ID,G.FIXTURE_INTERNAL_ID,'0123456789abcdef0123456789abcdef01234567'];
  let fail=0;
  for(const id of bad){ try{ G.assertAllowedWorld(id); console.error('LEAK: allowed',id); fail++; }
                        catch(e){ console.log('OK refused',id.slice(0,8),'->',e.code); } }
  process.exit(fail?1:0);
})"
```

```bash
# 1c. 机械校验：当前加载的世界必须就是目标（不在世界 / 在别的世界 => 非 0）
node --input-type=module -e "
import fs from 'node:fs';
import * as G from './research/ai-plan/live/guard.mjs';
const w = await G.resolveCurrentWorld();
G.assertAllowedWorld(w.internal_id);
console.log('OK live world =', w.internal_id, 'seed =', w.seed);
"
```

> **断言**：`assertAllowedWorld` 对 home 抛 `HOME_WORLD`，对 fixture / 随机 id 抛 `WORLD_NOT_ALLOWED`。
> 三种错误码可区分，失败报告能直接说出"拒绝的原因"，而不是笼统的"不允许"。

---

## 2. 每次写前必须 `snapshot_save`，名字带 `pre-l4-live-<step>`

```bash
# 2a. 写操作前：断言该 step 的快照存在、sidecar 指向目标世界、且不早于上次写
node --input-type=module -e "
import * as G from './research/ai-plan/live/guard.mjs';
try {
  const r = G.assertSnapshotBeforeWrite({ step: process.argv[1] });
  console.log('OK snapshot', r.name, 'at', r.saved_at, 'world', r.internal_id, 'lv', r.level);
} catch (e) { console.error('FAIL', e.code, e.message); process.exit(1); }
" <step>
```

```bash
# 2b. 快照本体（唯一允许的方式；guard 会校验它属于白名单世界）
#     注意：snapshot_save 内部会调 save_now，所以它本身也是一次"写"，必须走 wrapRpc。
#     snapshot_save 不要求"已有快照"（否则自锁）；它要求的是自己的名字带规定前缀。
node --input-type=module -e "
import * as G from './research/ai-plan/live/guard.mjs';
const step = process.argv[1];
if (!step) { console.error('usage: ... <step>'); process.exit(2); }
G.installTripwire({ baseUrl: 'http://127.0.0.1:7777' });
const rpc = G.wrapRpc(async (m, p) => {
  const r = await fetch('http://127.0.0.1:7777/rpc', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }),
  });
  const j = await r.json();
  if (j.error) throw new Error(m + ': ' + j.error.message);
  return j.result;
});
const name = 'pre-l4-live-' + step;
try {
  const r = await rpc('snapshot_save', { name }, { step, snapshot: name });
  console.log('OK', r.name, 'path', r.path);
} catch (e) { console.error('FAIL', e.code, e.message); process.exit(1); }
" <step>
```

**强制规则（代码里写死，不靠人记）**

- 快照名必须以 `pre-l4-live-` 开头，否则 `BAD_SNAPSHOT_NAME`。
- `.bin` 与 `.json` sidecar 必须同时存在；只有 `.bin` => `NO_SNAPSHOT_SIDECAR`
  （无法证明这份快照是哪个世界的，不能当基线用）。
- sidecar 的 `internal_id` 必须过 `assertAllowedWorld`——**快照了用户存档会被当场拒绝**。
- 跨步骤陈旧快照 => `STALE_SNAPSHOT`。同一 step 内可复用自己那份（一个 step 一份快照，
  不是一次 RPC 一份）；`SHAPEZ_GUARD_STRICT=1` 可要求每次写都有更新的快照。
- `tx` / `paste_blueprint` / `bulk_delete` **即使 `dry_run:true` 也要快照**：
  tx 的 dry run 是"真执行再回滚"，回滚本身会改世界（BeltSystem 重算邻居 rv）。

> ⚠️ **只有 `load_save` 豁免快照**——那时还没有世界可以快照，改为校验"要载入的那个世界"必须在白名单。
> 这是唯一豁免，且该豁免只在 `state_key === "MainMenuState"` 时成立。

---

## 3. 每次 tx / paste 前必须 `dry_run:true`，且 `blocked:[]` / `destroys` 已在 intent 声明

```bash
# 3a. 提交前：断言 dry run 干净
#     用法: node <这段> <dry-run.json> '<declared-json>' <tx|paste_blueprint|bulk_delete>
node --input-type=module -e "
import fs from 'node:fs';
import * as G from './research/ai-plan/live/guard.mjs';
const [dryFile, declaredJson, op] = process.argv.slice(1);
const dry = JSON.parse(fs.readFileSync(dryFile, 'utf8'));
try {
  console.log('OK', JSON.stringify(G.assertDryRunOk(dry, { op, declared: JSON.parse(declaredJson) })));
} catch (e) { console.error('FAIL', e.code, e.message); process.exit(1); }
" <dry.json> '<declared-json>' <tx|paste_blueprint|bulk_delete>
```

**断言清单（全部为硬错误，无警告级）**

| 条件 | 错误码 |
|---|---|
| 没传 dry run 结果 | `NO_DRY_RUN` |
| 结果里 `dry_run !== true`（可能是真写） | `NOT_A_DRY_RUN` |
| `blocked` 非空 | `DRY_RUN_BLOCKED` |
| `destroys` 里有未在 intent 声明的东西 | `UNDECLARED_DESTROYS` |

`destroys` 的声明可以按 uid（`[55]`）或按格（`["1,2"]`）——两种写法都接受。
**不接受**的是"没声明的销毁"，因为替换式贴入会**静默销毁**旧带子（快照 §4 第 5 条，C1）。

---

## 4. `ensureWindowAwake()` 的返回值必须写进日志（`wasIconic`）

```bash
# 4a. 返回值必须含 boolean wasIconic，并写入 .tmpverify/live/guard.log
node -e "import('./research/ai-plan/live/guard.mjs').then(async G=>{
  const kit = await import('./research/ai-plan/live/kit.mjs');
  const r = G.assertWindowAwakeLogged(await kit.ensureWindowAwake(), 'preflight');
  console.log('OK wasIconic =', r.wasIconic, '(restored=', r.restored, ')');
}).catch(e=>{ console.error('FAIL', e.code, e.message); process.exit(1); })"
```

```bash
# 4b. 之后核对日志里确实留下了这一条
node -e "const fs=require('fs');const L=fs.readFileSync('.tmpverify/live/guard.log','utf8')
  .trim().split('\n').map(l=>JSON.parse(l)).filter(e=>e.type==='window_awake');
  if(!L.length){console.error('FAIL: no window_awake record');process.exit(1);}
  console.log('OK', L.length, 'record(s); last wasIconic =', L.at(-1).result.wasIconic);"
```

**为什么是硬的**：窗口最小化 → 不跑渲染帧 → `gameStarted` 不触发 → `mod.root` 恒 null
→ 所有世界调用返回 `1003 not_in_game`，而 `status` 照常应答。历史卡死 37 分钟。
缺 `wasIconic` => `WINDOW_UNKNOWN`，不许"应该是醒着的吧"。

---

## 5. 禁止 kill / restart shapezio

```bash
# 5a. 开工时记录 pid + StartTime
node --input-type=module -e "
import fs from 'node:fs';
import * as G from './research/ai-plan/live/guard.mjs';
const p = G.recordGameProcess();
fs.writeFileSync('.tmpverify/live/game-process.json', JSON.stringify(p, null, 1));
console.log('OK', JSON.stringify(p));
"
```

```bash
# 5b. 收工（或任何时候）比对：pid 或 StartTime 变了 => GAME_RESTARTED
node --input-type=module -e "
import fs from 'node:fs';
import * as G from './research/ai-plan/live/guard.mjs';
try {
  const before = JSON.parse(fs.readFileSync('.tmpverify/live/game-process.json', 'utf8'));
  const after = G.recordGameProcess();
  G.assertGameProcessUnchanged(before, after);
  console.log('OK pid', after.pid, 'startTime', after.startTime, 'unchanged');
} catch (e) { console.error('FAIL', e.code, e.message); process.exit(1); }
"
```

> **进程不在了**（`exists:false`）也是失败（`GAME_PROCESS_GONE`），不是"重启一下继续"。
> 重启会丢掉内存里的世界，而且重启后的"恢复"是新一轮运行，不属于本轮证据。

---

## 6. 开工前 / 收工后各记一次 `5c967065` 的 sha256 + mtime，必须完全一致

```bash
# 6a. 开工（这是本轮第一条实机命令；顺带写基线报告）
#     它同时断言：当前世界是目标世界、用户存档在、且没偏离 user-save-baseline.json
node --input-type=module -e "
import * as G from './research/ai-plan/live/guard.mjs';
const label = process.argv[1];
if (!label) { console.error('usage: ... <run-label>'); process.exit(2); }
try {
  const r = await G.preflightBegin({ label });
  console.log('OK begin', r.report);
  console.log('   world        =', r.world.internal_id, 'seed', r.world.seed);
  console.log('   user save    = sha256', r.user_save.sha256, 'size', r.user_save.size, 'mtimeMs', r.user_save.mtimeMs);
  console.log('   game process =', JSON.stringify(r.process));
} catch (e) { console.error('FAIL', e.code, e.message); process.exit(1); }
" <run-label>
```

```bash
# 6b. 收工（本轮最后一条实机命令；任何一项不符 => 抛错 + 写 preflight-end-*.json + 退出码非 0）
node --input-type=module -e "
import * as G from './research/ai-plan/live/guard.mjs';
try {
  const r = G.preflightEnd({ label: process.argv[1] });
  console.log('OK end', r.verdict, r.report);
} catch (e) {
  console.error('FAIL', e.code, e.message);
  if (e.detail && e.detail.checks) console.error(JSON.stringify(e.detail.checks, null, 1));
  process.exit(1);
}
" <run-label>
```

```bash
# 6c. 独立复核（不依赖 guard 自己的记录，直接看磁盘）
sha256sum "C:/Users/Administrator/AppData/Roaming/shapez.io/saves/savegame-5c96706563c0b74c4d2ce4c7f8bf7a244392de89.bin"
stat "C:/Users/Administrator/AppData/Roaming/shapez.io/saves/savegame-5c96706563c0b74c4d2ce4c7f8bf7a244392de89.bin"
```

**基线（原文，`.tmpverify/live/user-save-baseline.json`）**

```
size    82716
sha256  f5944ccd9375b12b554d0873b4e6b44c369067b758936d14686ddde4e9fb7115
mtimeMs 1793178132885.165
mtime   2026-10-28 17:02:12.885165100 +0800
```

**比什么**：`sha256` **且** `size` **且** `mtimeMs`。三项任一变化即 `USER_SAVE_CHANGED`。
mtime 变了而字节没变，**也算失败**——那意味着有东西重写了用户存档（例如误发
`act{op:"save"}`），字节碰巧相同不代表没发生。

`preflightBegin` 还会给**整个 `saves/` 目录**拍指纹（所有 `savegame-<40hex>.bin` 的
size+mtime）。收工时：
- 新增存档 => 失败（有人开了新游戏）
- 存档消失 => 失败（有人删档）
- 任何存档被touch => 失败（包括 `cf469f75` 夹具源）

---

## 7. 收工后 `7c93b3dd` 的 uid 集必须与开工前逐字节相等

```bash
# 7a. 开工：取目标世界的 uid 集（只读 obs，不需要 save_now）
node --input-type=module -e "
import fs from 'node:fs';
import * as G from './research/ai-plan/live/guard.mjs';
G.installTripwire({ baseUrl: 'http://127.0.0.1:7777' });
const res = await fetch('http://127.0.0.1:7777/rpc', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'obs', params: { max_entities: 50000, include_stats: false } }),
});
const uids = (await res.json()).result.entities.map((e) => e.uid);
const s = G.uidSet(uids);
fs.writeFileSync('.tmpverify/live/target-uids-begin.json', JSON.stringify({ count: s.count, sha256: s.sha256, uids: s.uids }, null, 1));
console.log('OK begin uids =', s.count, 'sha256 =', s.sha256);
"
```

```bash
# 7b. 收工：再取一次并比对（逐 uid 集合相等 + 排序后再 sha256 相等）
node --input-type=module -e "
import fs from 'node:fs';
import * as G from './research/ai-plan/live/guard.mjs';
G.installTripwire({ baseUrl: 'http://127.0.0.1:7777' });
try {
  const b = JSON.parse(fs.readFileSync('.tmpverify/live/target-uids-begin.json', 'utf8'));
  const res = await fetch('http://127.0.0.1:7777/rpc', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'obs', params: { max_entities: 50000, include_stats: false } }),
  });
  const a = G.uidSet((await res.json()).result.entities.map((e) => e.uid));
  G.assertUidSetEqual({ uids: b.uids, set: new Set(b.uids), count: b.count, sha256: b.sha256 }, a, '7c93b3dd');
  console.log('OK uid set identical:', a.count, a.sha256);
} catch (e) { console.error('FAIL', e.code, e.message, JSON.stringify(e.detail)); process.exit(1); }
"
```

> ⚠️ **收工 uid 相等 ≠ 本轮成功**。它只证明"世界被复原了"。
> 若本轮的目标是"贴一条产线并让它出货"，那么收工时 uid 集**本来就该是变化的**——
> 那种情况下第 7 条应改为"与本轮**声明的最终状态**比对"，并在 `preflightEnd` 里
> 传最终 uid 集，同时在报告里明确写出"这是一次有意的永久变更 + 已有快照可复原"。
> **不许**把"uid 变了"含糊成"应该没事"。

---

## 8. 一页速查：本轮实机脚本的强制骨架

```js
import * as G from "./guard.mjs";
import * as kit from "./kit.mjs";

G.installTripwire({ baseUrl: kit.BASE });        // ① 装网：之后任何裸 fetch 写都会被拦
const rpc = G.wrapRpc(kit.rpc);                  // ② 唯一合法写入口

G.assertWindowAwakeLogged(await kit.ensureWindowAwake(), "start");   // ③
const begin = await G.preflightBegin({ label: "l4-live-1", uids: await readUids() });  // ④

await rpc("load_save", { internal_id: G.TARGET_INTERNAL_ID }, { step: "boot" });        // ⑤ 唯一豁免快照
await rpc("snapshot_save", { name: "pre-l4-live-s1" }, { step: "s1", snapshot: "pre-l4-live-s1" });

const dry = await rpc("act", { op: "tx", ops, dry_run: true },                          // ⑥
                      { step: "s1", dryRun: { dry_run: true, blocked: [], destroys: [] }, declared: [] });
G.assertDryRunOk(dry, { op: "tx", declared: [] });                                     // ⑦ 真判据看这里
await rpc("act", { op: "tx", ops }, { step: "s1", dryRun: dry, declared: damage });    // ⑧

G.preflightEnd({ label: "l4-live-1", uids: await readUids() });                        // ⑨ 不过就抛
```

> `kit.loadHome()` **本轮禁止调用**。它会把用户存档载进游戏，而 `load_save` 内部先
> `saveThenGoToState`——等于给用户存档一次"写"的机会。护栏会在 world 校验处拦下它
> （`HOME_WORLD`），但不要靠拦。

---

## 本轮判失败的硬条件

见 `research/ai-plan/live/FAIL-CONDITIONS.md`。一句话版：

> **用户存档 sha256/size/mtime 任一变化、目标世界 uid 集对不上、游戏进程被重启、
> 没做 snapshot 就写了 —— 四条中任意一条成立，本轮判失败。没有"解释成正常"这条路。**

---

## 已知缺口（我不确定的部分，写在这里而不是藏起来）

1. **`debug_app_state` 是否在所有 mod 版本都暴露 `savegame.internal_id`**：本机 mod
   `0.1.0`（sha256 `b9cb092f...`，与 `src/mod` 同源）确实有。若换 mod 版本导致该字段消失，
   `resolveCurrentWorld` 会抛 `CANNOT_IDENTIFY_WORLD` —— **fail closed，不会放行**。
2. **tripwire 只覆盖 `fetch`**。若某个脚本用 `node:http` / `undici.request` 直连 7777，
   它绕过 tripwire。当前 `kit.mjs` 用的是 `fetch`（已覆盖）。这属于"防呆"而非"防恶意"。
3. **`load_save` 豁免快照**后，若载入过程崩在中途，世界处于"载入未完成"，此时没有
   本轮快照可回。缓解：载入前先 `snapshot_save`（有当前世界时），或者接受"这一步失败
   即本轮失败"。
4. **`snapshot_save` 会真的写一次当前世界的 `.bin`**（bridge 内部调 `save_now`）。
   所以"住手，别写"的时机是在 `load_save` 之后、`snapshot_save` 之前——一旦 snapshot 了，
   目标世界已经被写过一次了。`5c967065` 不受影响（它不在白名单，snapshot 也进不去）。
