# ⚠️ 实验事故与修复记录（必读——写实验脚本前先看这个）

## 事故：控制组清理误删真实工厂实体

**时间**：2026-10-23 06:5x（本次研究期间，主 Agent 自己犯的错）
**脚本**：`research/ai-player/exp-remote-belt-3.mjs`（H5b 实验）

### 发生了什么

H5b 为了对照"未生成区域 vs 已生成区域"，在 **hub 附近**建了一个对照组：
矿机 @ (5,-2) + 传送带 (6,-2)→(20,-2)。

选 (5,-2) 的理由是：它是源码里的**预置资源格**（`map_chunk.js` 的 `generatePredefined` 里
硬编码的 `SuSuSuSu` 在 chunk (5,-2)）—— 我**误以为**那是空地。

**但真实工厂恰好在那里有产线。** 实验结束时的清理：
```js
rpc("act", { op: "bulk_delete", region: [4, -4, 22, 0] })   // ← 删掉了 42 个真实实体
```

离线存档 diff 确认：**snapshot 2805 → 当前 2763，恰好少 42 个，全部在 (10..23, -4..0) 区域**，
uid 13207–13481，全是真实产线的 belt/balancer/cutter（code 1/2/4/23）。

### 怎么修的

实验前做的 `snapshot_save ai-research-base`（见 `docs/PROTOCOL.md §11.3`）正是为此准备的：

```bash
curl -X POST http://127.0.0.1:7777/rpc -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"snapshot_load","params":{"name":"ai-research-base"}}'
```

恢复后实测：**entities = 2805**，与基线**完全一致**（by_type 也逐项吻合：belt:1906 balancer:475
underground_belt:182 miner:143 painter:44 mixer:24 cutter:16 trash:10 …）。✅

### 教训（给未来的实验脚本）

1. **绝不能凭空假设某区域是空的** —— 哪怕源码说是"预置资源点"，真实存档里也可能已经建满了产线。
   实测数据（`facts/live/world-full.json`）显示工厂横跨 x[-28,231] y[-189,127]，
   **hub 附近 (10..23, -4..0) 是产线密集区**。
2. **清理必须精确**：`bulk_delete` 一个"大概范围"是危险的。正确做法：
   - 只 `delete` 自己建的 uid（`place`/`place_path` 的返回值里有 uid / first_uid）
   - 或：**把实验做到远离工厂的地方**（本次 H3/H4/H5b 的主实验都在 2000+ 格外，没问题）
3. **对照组的选址**要查 `world-full.json` 的实体分布，不要靠源码推断。
4. **实验前必须 snapshot** —— 这次能无损恢复全靠它。**每个动世界的脚本都应先自己快照。**

### 对工具本身的启示（重要的产品结论）

- **`bulk_delete` 缺少"安全检查"**：如果 region 内有**不是本次会话创建的**实体，应该警告或拒绝。
  这是一个**真实可用性缺陷**，建议列为 tool 层的改进项：
  `bulk_delete` 可加 `dry_run: true` 返回"将删除的实体清单"，或加 `only_uids: [...]` 白名单模式。
- **`place`/`place_path` 应该支持"事务"语义**：返回 uid 列表，配合 `delete_uids` 精确回滚。
  （当前 `place_path` 只返回 `first_uid`，回滚需要额外观测——建议改为返回全部 uid 或加
  `return_uids: true`。）
- **建议新增 `obs` 的 `created_by` 或"最近变更"视图**：让 agent 能区分"我建的"与"原有的"。

以上三条已写入 `research/ai-player/designs/` 相关设计（基础设施方向）的待办。
