// C4 的真实场景：sender 与 receiver 之间**本来就有带子**（要穿过去的那条）
// 这是隧道存在意义：从上方跨过一条已有的带
import { encodeBlueprint } from '../../../src/shared/blueprint.mjs';
const entities = [
  { code: 22, dx: 0, dy: 0, rot: 180 }, // sender（朝下）
  { code: 23, dx: 0, dy: 3, rot: 180 }, // receiver（朝下），中间 (0,1)(0,2) 是要被穿过的带
];
console.log(encodeBlueprint({ gv: '1.5.6', w: [0, 0], entities }));
