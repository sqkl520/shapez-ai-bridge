// 隧道实测：控制变量对比
// 段 A：belt (0,0) → sender(0,1) → [穿过 (0,2),(0,3)] → receiver(0,4) → belt(0,5)
// 中间 (0,2),(0,3) 留空 = 隧道该穿过的位置
import { encodeBlueprint } from '../../../src/shared/blueprint.mjs';

// 蓝图相对坐标从 (0,0) 起
const entities = [
  { code: 1, dx: 0, dy: 0, rot: 0 },   // belt 直带
  { code: 22, dx: 0, dy: 1, rot: 180 }, // sender（朝下）
  { code: 23, dx: 0, dy: 4, rot: 180 }, // receiver（朝下）
  { code: 1, dx: 0, dy: 5, rot: 0 },   // belt
];
const bp = encodeBlueprint({ gv: '1.5.6', w: [0, 0], entities });
console.log(bp);
