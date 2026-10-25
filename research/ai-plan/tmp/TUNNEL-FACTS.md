# 隧道：从真实存档读出的确证事实

来源：`savegame-5c96...bin`（level 11，玩家真实工厂，3071 实体）

## 1. 编码
| code | 含义 | 出处 |
|---|---|---|
| 22 | sender（入口），rv=0 | `buildings/underground_belt.js:45-48` |
| 23 | receiver（出口），rv=1 | 同上 |
| 24/25 | tier2 变体（range 更长） | 同上 + `globalConfig.undergroundBeltMaxTilesByTier: [5, ...]` |

存档里的形态：
```json
{"uid":11142,"components":{"StaticMapEntity":{"origin":{"x":4,"y":10},"rotation":180,"originalRotation":180,"code":22},...}}
{"uid":11143,"components":{"StaticMapEntity":{"origin":{"x":4,"y":13},"rotation":180,"originalRotation":0},"code":23},...}}
```
- sender 与 receiver **同一条直线**（同 x），朝向一致（rotation 180 = 朝下）
- `origin` 是 1×1

## 2. 玩家的实际用法（107 对）
| 跨度 | 对数 |
|---|---|
| 2 格 | 10 |
| 3 格 | 97 |

**最大跨度 3 格**，标称 range 是 5。也就是说隧道在真实工厂里只用来**跨过 1~2 格宽的障碍**（穿过一条带、一台机器）。

## 3. C4 那个坑的真实机制
`systems/underground_belt.js:53`：
```js
onEntityManuallyPlaced(entity) {
    if (!this.root.app.settings.getAllSettings().enableTunnelSmartplace) {
        return;   // ← 关掉就完全不删带
    }
    ...
```
- 开着：放一个 receiver 时，会把它与 sender 之间的带子 `tryDeleteBuilding` 掉
- 我们的 paste 每格都 dispatch `entityManuallyPlaced` ⇒ 粘贴**中途**被拆
- 关掉：整段逻辑不执行 ⇒ 隧道可安全粘贴

## 4. 尚未验证（需要重启 mod 才能测）
1. `game_setting` RPC 能否真的关掉开关
2. 蓝图能否携带隧道（`src/shared/blueprint.mjs` 的 code 表是否含 22/23）
3. 关掉 smartplace 后，`sender-带-receiver` 粘贴是否保留中间带
