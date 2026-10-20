# 实机验证报告 — shapez.io AI 接口（1.5.6）

> 环境：Windows 10 / Steam 版 shapez.io 1.5.6（ee2279d5）/ Node v24.14
> 方法：mod 安装到 `%APPDATA%\shapez.io\mods`，通过**正式桥接**（`src/bridge/bridge.mjs`）
> 驱动真实游戏做端到端验证。**所有结果均为真机实测。**
> 日期：2026-10-20

## 一、端到端功能矩阵（全部实机）

| # | 项目 | 结果 | 证据 |
|---|---|---|---|
| 1 | Mod 加载 + 握手 | ✅ | `HELLO: {"protocol":1,"game_version":"1.5.6","features":[...]}` |
| 2 | `status`（主菜单态） | ✅ | `in_game:false` |
| 3 | `obs` 无世界 → 1003 | ✅ | `not_in_game` + hint |
| 4 | 未知方法 → -32601 | ✅ | `Unknown method: step` |
| 5 | `list_saves` | ✅ | `internal_id / level:10 / version:1010` |
| 6 | `load_save` 驱动读档 | ✅ | 12s 后 `in_game:true, hub_level:10` |
| 7 | `obs` 实体类型映射 | ✅ | code 26→"hub"、code 7→"miner"，与离线解码一致 |
| 8 | `obs` 区域裁剪 + truncated | ✅ | region 过滤生效，`truncated:true` 携带全量 stats |
| 9 | `obs` 资源层 | ✅ | `[[x,y,"green"],...]` / `[[x,y,"CuCuCuCu"],...]` |
| 10 | `screenshot` | ✅ | 真实 PNG（2560×1440，可缩放） |
| 11 | `step` 快进 | ✅ | 600 ticks / 173ms；2400 ticks / 25ms |
| 12 | `await` 超时语义 | ✅ | `{met:false, timeout:true}` 非错误 |
| 13 | `place` / `delete` | ✅ | `entity_uid` 往返一致 |
| 14 | `place_path` | ✅ | 直线铺设 + 自动求向 |
| 15 | `bulk_delete` | ✅ | 区域清理 applied 计数正确 |
| 16 | `export_blueprint` | ✅ | `SZBP1.*` 字符串 |
| 17 | **离线工具解析实机蓝图** | ✅ | 与导出逐字段一致（跨实现契约成立） |
| 18 | `paste_blueprint` | ✅ | 3/3 applied，坐标精确 |
| 19 | `new_game` | ✅ | 新档创建，`hub_level:1` |
| 20 | `save_now` + 快照 | ✅ | sidecar（internal_id/level/game_version）齐全 |
| 21 | `camera` | ✅ | 镜头跳转生效（截图佐证） |
| 22 | MCP 全栈（8 工具） | ✅ | MCP client → server → bridge → WS → mod → 游戏 |
| 23 | 中文/英文输出 | ✅ | smoke test 双语 |

## 二、基准测试（阶段 6 核心，全部自动化可重复）

| 基准 | 结果 | 动作数 | 墙钟 | 失败数 | 失败类型 | 备注 |
|---|---|---|---|---|---|---|
| **B1** 采矿→传送带→HUB | **PASS** | 6 | 8.6s | 0 | none | `await met:true`，delivered 增长确证 |
| **B2** 完成当前等级目标 | **PASS** | 4 | 0.3s | 0 | none | level 1（CuCuCuCu×30）完成，进级 |
| **B3** 新档 → level 3 | **PASS** | 19 | 8.9s | 0 | none | level1 直送(5) + level2 切割链(14) |

原始结果：`test/results/b1.json` / `b2.json` / `b3.json`

**B3 的 level 2 是完整切割链**：矿机 → 切割机 → 双输出线 → HUB，14 个动作零失败。

## 三、阶段 6 其他必测项

| 项目 | 结果 | 证据 |
|---|---|---|
| **重连**（桥接重启后 mod 自动恢复） | ✅ | 杀掉桥接进程 → 重启 → mod 指数退避重连成功（全新 uptime） |
| **大世界**（1544 实体 level 10 存档） | ✅ | 全量观测 37ms / 181KB；区域裁剪 12ms；写操作 9ms |
| **长跑**（200 动作循环） | ✅ | 200/200 成功，1.0s 总耗时，平均 4.9ms/动作，零错误 |
| **只读模式** | ✅ | `place`→1004、`noop`→1005(无 mod)、`obs` 放行；拦截先于连接检查 |
| **版本不匹配** | ✅ | 桥接 selftest：protocol=2 → 连接被关、后续 1001；game_version=9.9.9 → 1002 |
| 所有自测套件 | ✅ | mod 15 + mod_rpc 11 + blueprint 7 + interop 1 + bridge 17 + mcp 47 = **98 项断言全绿** |

## 四、实机抓出并修复的真实缺陷（全部有根因分析）

1. **`root.map.getTileContentXY` 不存在** → 正确名是 `getLayerContentXY`（实机 2003 暴露）。
2. **`entityManuallyPlaced` 信号遗漏** → 放置后需 dispatch（对照游戏原生放置流程）。
3. **蓝图扣费顺序** → 改为"预检→放置→成功后扣费"（对齐 canAfford→tryPlace→takeShapeByKey）。
4. **`load_save` 状态机重入** → 游戏中读档须"先回主菜单→等待→再进入"。
5. **区域过滤漏多格建筑** → 按 AABB 相交而非 origin 点。
6. **`place_path` 退化段**（from==to）→ 2001，调用方需跳过。
7. **切割机输出堵塞致整机停转**（B3 卡在交付 2 的根因，截图+上游源码双证）：
   输出槽 ejector direction=top（向上喷），紧邻首格传送带必须**朝上流**——
   首格朝下会让物品堵死在出口；一个输出堵塞则 `queuedEjects` 不排空、不开新 charge。
8. **传送带拐角变体依赖放置时邻居**（上游 `belt.js` `computeOptimalDirection...` 源码确认）：
   分段 `place_path` 会让拐角格被相邻两段各放一次，第二次放置时上游邻带已存在、
   曲线变体才正确——逐格单次放置会把拐角铺成直带。

## 五、数值一致性（离线 ↔ 实机）

| 事实 | 离线（解码存档） | 实机（obs） | 一致 |
|---|---|---|---|
| 存档 level | 10 | 10 | ✅ |
| hub 位置 | (-2,-2) | (-2,-2) | ✅ |
| hub code | 26 | 26 | ✅ |
| 传送带 code | 1 | 1 | ✅ |
| miner code | 7 | 7 | ✅ |
| 相机中心/缩放 | (1486.17, 49.53) / 0.5614 | 同值 | ✅ |
| 传送带 rotation 语义 | 90=向右流 | place r:90 → obs r:90 | ✅ |

## 六、复现

```bash
# 1. 安装 mod（幂等）
powershell -ExecutionPolicy Bypass -File install.ps1     # Windows
bash install.sh                                          # macOS/Linux

# 2. 启动桥接（保持前台运行）
node src/bridge/bridge.mjs

# 3. 启动游戏（Steam 运行中），加载任意存档

# 4. 冒烟测试（世界原样恢复）
node scripts/smoke_test.mjs            # 期望 SMOKE TEST PASSED (5/5)

# 5. 基准
node scripts/bench_b1.mjs --new-game   # B1
node scripts/bench_b2.mjs              # B2
node scripts/bench_b3.mjs              # B3（新档→level 3）

# 6. 参考 Agent
node src/agent/play.mjs observe        # 人类可读观测摘要
node src/agent/play.mjs action '{"op":"place","building":"belt","x":20,"y":20}'
```

## 七、已知未充分覆盖部分（诚实标注）

- **level 3+ 的组合形状目标**：内置启发式未覆盖（需要多级加工链）。`bench_b3` 支持
  `--plan-dir` 提供每级布局计划；MCP/Agent 接口本身不受限（可执行任意动作计划）。
- **切割链路布局的鲁棒性**：当前 B3 的切割机布局是"够用"的确定性模板，对
  不同资源位置/地形的适配未穷举（实机验证覆盖了新档 level 2 的典型情形）。
- **macOS / Linux**：安装脚本与路径逻辑已按游戏主进程源码实现，但未在真机验证
  （本环境为 Windows）。
- **browser/mobile 版 shapez.io**：不支持 mod，明确不适用。
