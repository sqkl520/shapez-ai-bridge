# 本轮判失败的硬条件

> 一句话：**用户存档变了、目标世界 uid 集对不上、游戏进程被重启、没做 snapshot 就写了 ——
> 任意一条成立，本轮判失败。**
>
> 下面每条都写明「判据」「怎么测」「为什么不许解释成正常」。
> 这不是"注意事项"，是**判决**。发现任一条成立时，唯一允许的动作是：
> 停下来、保留现场、把证据交回主线程。

---

## 1. 用户存档 sha256 变了

**判据**：`5c967065...bin` 的 `sha256` **或** `size` **或** `mtimeMs` 与开工基线不一致。
三项**任一**变化即失败（不是"三者都变才算"）。

**怎么测**
```bash
node research/ai-plan/live/guard.mjs --fingerprint 5c96706563c0b74c4d2ce4c7f8bf7a244392de89
# 与 .tmpverify/live/user-save-baseline.json 里的 sha256/size/mtimeMs 逐项比
```
或在 `preflightEnd` 里自动判（不符即抛 `USER_SAVE_CHANGED`）。

**基线（原文）**
```
size    82716
mtimeMs 1793178132885.165
mtime   2026-10-28 17:02:12.885165100 +0800
sha256  f5944ccd9375b12b554d0873b4e6b44c369067b758936d14686ddde4e9fb7115
```

**为什么不许解释成正常**：这是用户唯一一份正式存档（level 11，3093 实体）。
「mtime 变了但字节一样」也不行——那证明有东西**重写过**它（例如误发 `act{op:"save"}`），
只是内容碰巧相同。托词"反正内容没变"实际是在说"我差点毁了它但运气好"。

**连带判据**：`saves/` 目录里除白名单世界之外的每一条 `savegame-<40hex>.bin`
（用户存档、`cf469f75` 夹具源、以及**任何未知 id**）出现新增 / 删除 / 被 touch，判失败。
新增=有人开了新游戏，删除=有人删了档。
`preflightBegin` 会拍整目录指纹，`preflightEnd` 自动比（`PROTECTED_SAVES_CHANGED`，
检查名 `protected_saves_unchanged`）。比对项含 sha256，所以"字节变了但 size 没变"也抓得到。

**本轮白名单世界（`7c93b3dd`）的存档文件是例外 —— 只记录，不判。**
理由（2026-10-31 实机取证）：`app_settings.bin` 里 `autosaveInterval:"one_minute"`，
`AutomaticSave.update()` 每 60 秒 `doSave()` 一次，实测该 `.bin` 每分钟被重写、
内容在 1103–1118 字节之间波动。**「存档目录完全不变」与「在白名单世界里做实验」
物理上不可兼得**，旧判据会对一次「零实体写入」的运行误报 FAIL。
例外只放宽「改写」，不放宽「增删」：白名单存档被**新增或删除**仍然硬判失败
（自动存档只会重写文件，不会造/删文件）。该变化会写进 `preflight-end-*.json`
的 `saves_audit.target_changed`，不会被静默吞掉。


---

## 2. 目标世界 uid 集对不上

**判据**：`7c93b3dd` 的 uid 集合与开工时记录的集合**不相等**（多一个、少一个、或排序后
拼接的 sha256 不同）。

**怎么测**
```bash
# 开工
node --input-type=module -e "..."   # PREFLIGHT.md §7a
# 收工
node --input-type=module -e "..."   # PREFLIGHT.md §7b —— 不符即抛 UID_SET_CHANGED
```

**为什么不许解释成正常**：uid 是游戏为每个实体分配的不可复用标识。
集合对不上意味着有实体被创建或销毁了，**无论"看起来对不对"**。
历史事故：替换式贴入 `ok:true applied:3 failed:[]` 而两条旧带子 uid 静默消失。
只看返回值是全绿的，只有 uid 集能抓住它。

### 2b. 例外：本轮**有意**永久改变世界时

若本轮的目标就是"留下一条产线并让它出货"，收工时 uid 集**本来就该变**。
这不是判据失效，而是判据要换个参照系：

- 必须在 `preflightEnd` 里传**本轮声明的最终 uid 集**，而不是开工集；
- 报告中必须明确写出：「这是一次有意的永久变更；复原路径是快照 `pre-l4-live-<step>`」；
- 必须验证快照可复原（`snapshot_load` 的 dry-run 或已实测过的复原流程）。

**不许**做的是：把"uid 变了"含糊成"应该没事"。

---

## 3. 游戏进程被重启了

**判据**：`shapezio` 的 `pid` **或** `StartTime` 与开工时不同；或者进程不见了。

**怎么测**
```bash
node --input-type=module -e "..."   # PREFLIGHT.md §5b —— 不符即抛 GAME_RESTARTED / GAME_PROCESS_GONE
```

**为什么不许解释成正常**：
- 简报 §4.6 明文：**不许 kill / 重启游戏进程**。恢复窗口的手段只有
  `ensureWindowAwake()`（`ShowWindow` 恢复，可逆）。
- 重启会丢掉内存里的世界状态，重启后的"恢复"是**新一轮运行**，它的证据不能算作本轮证据。
- 重启还意味着有人撞上了 1003 卡死——那本身就是一次需要报告的事故，不是"顺手修好了"。

**连带判据**：开工时的 `in_game` 若为 `false`（在主菜单），`preflightBegin` 直接拒绝开工
（`NOT_IN_WORLD`）。**本轮的实际起点**：2026-10-30 22:00 实测 `state_key=MainMenuState`、
`root_present=false`、游戏 `pid=16040`（简报记的是 29468，说明简报之后游戏重启过一次——
这是简报与现场的偏差，已记录，不影响护栏）。

---

## 4. snapshot 没做就写了

**判据**：写操作发生时，对应 step 的快照 `.bin` + `.json` sidecar 不同时存在，
或 sidecar 的 `internal_id` 不是目标世界，或 sidecar 时间早于上一次写。

**怎么测**：这条**不需要事后测**——`guard.wrapRpc` 在发请求前就会抛
`NO_SNAPSHOT` / `NO_SNAPSHOT_SIDECAR` / `STALE_SNAPSHOT`，请求根本发不出去。
事后可用 `guard.log` 复核：
```bash
node -e "const fs=require('fs');
for(const l of fs.readFileSync('.tmpverify/live/guard.log','utf8').trim().split('\n')){
  const e=JSON.parse(l);
  if(e.type==='write_ok'||e.type==='permit_open') console.log(e.type, e.method, e.snapshot||'-', e.step||'-');
}"
```

**为什么不许解释成正常**：没有快照就没有退路。这是"能不能收场"的分界，
不是"这次运气好没出事"的问题。`tx` 自带回滚，但那只覆盖 tx 内部的 op；
`paste_blueprint` / `bulk_delete` 没有回滚，只能靠快照。

**加重情形**：`tx` / `paste_blueprint` / `bulk_delete` 带 `dry_run:true` 时**也要快照**
（tx 的 dry run 是真执行再回滚，回滚会改世界）。只有 `load_save` 豁免（无世界可快照）。

---

## 5. 附加的"必须停下来报告"条件（不判失败，但必须上报）

这些不是失败判据，但**不允许静默通过**：

| 条件 | 错误码 | 为什么必须上报 |
|---|---|---|
| 无法识别当前世界 | `CANNOT_IDENTIFY_WORLD` | 不知道在哪个世界里，任何写都可能是错的 |
| 目标世界 seed 不符 | `WORLD_SEED_MISMATCH` | id 对但 seed 不对 => 世界身份存疑 |
| 窗口状态未知 | `WINDOW_UNKNOWN` | 最小化会导致 1003 卡死，且 `status` 仍正常应答 |
| 另一个 agent 持有写锁 | `CONCURRENT_WRITE` | 并发写会把游戏状态机搞卡死 |
| 快照缺 sidecar | `NO_SNAPSHOT_SIDECAR` | 无法证明这份快照是哪个世界的 |
| dry run 有 blocked | `DRY_RUN_BLOCKED` | 提交这版会有一批失败 |
| dry run 有未声明销毁 | `UNDECLARED_DESTROYS` | 静默销毁旧带子（C1 事故） |

---

## 判失败之后做什么

1. **停手**。不再发任何写 RPC。
2. **保现场**：`guard.log`、`preflight-end-*.json`、`preflight-begin-*.json` 原样保留，
   不清理、不覆盖。
3. **不要自行"修复"**。特别地：
   - 不要重启游戏；
   - 不要 `snapshot_load` 回滚（那会在错误的前提下再写一次）；
   - 不要试图"把 sha256 恢复成原样"。
4. **交回主线程**，附：哪条判据成立、用哪个命令测出来的、原始输出。

> 判失败的定义就是"这一轮的结论作废"。它不等于"用户数据被毁了"——
> 护栏存在的意义是让第一种情况**不需要**伴随第二种。
