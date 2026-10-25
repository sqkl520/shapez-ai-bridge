// C4 复现：sender 在 (0,0)、receiver 在 (0,3)，中间的 (0,1)(0,2) 先铺上普通带子。
// 然后：开/关 smartplace 各贴一次隧道，看中间带子是否被删。
import fs from 'node:fs';
import { encodeBlueprint } from '../../../src/shared/blueprint.mjs';
const RPC = 'http://127.0.0.1:7777/rpc';
const call = async (method, params = {}) => (await fetch(RPC, { method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SITE = [400, 400];
// 中间的两格带子（先铺）
const beltBP = encodeBlueprint({ gv: '1.5.6', w: [0,0], entities: [
  { code: 1, dx: 0, dy: 0, rot: 0 }, { code: 1, dx: 0, dy: 1, rot: 0 },
]});
// 隧道蓝图：sender(0,0) receiver(0,3)
const tunBP = encodeBlueprint({ gv: '1.5.6', w: [0,0], entities: [
  { code: 22, dx: 0, dy: 0, rot: 180 }, { code: 23, dx: 0, dy: 3, rot: 180 },
]});

async function read(site) {
  const r = await call('obs', { region: [site[0]-1, site[1]-1, site[0]+1, site[1]+5] });
  return (r.result.entities || []).sort((a,b)=>a.y-b.y);
}

for (const smart of [false, true]) {
  console.log(`\n===== smartplace=${smart} =====`);
  await call('game_setting', { key: 'enableTunnelSmartplace', value: smart });
  await call('act', { op: 'bulk_delete', region: [SITE[0]-2, SITE[1]-2, SITE[0]+3, SITE[1]+7] });
  await sleep(150);
  // 1) 先铺中间两格带子
  const p1 = await call('act', { op: 'paste_blueprint', text: beltBP, x: SITE[0], y: SITE[1]+1, charge: false });
  console.log('铺中间带子:', p1.result ? `applied=${p1.result.applied}` : JSON.stringify(p1.error).slice(0,120));
  await sleep(200);
  console.log('  铺完:', (await read(SITE)).map(e=>`(${e.x},${e.y})${e.type}`).join(' '));
  // 2) 再贴隧道（sender 在 traget 上方一格，receiver 在下方）
  const p2 = await call('act', { op: 'paste_blueprint', text: tunBP, x: SITE[0], y: SITE[1], charge: false });
  console.log('贴隧道:', p2.result ? `applied=${p2.result.applied} failed=${JSON.stringify(p2.result.failed)}` : JSON.stringify(p2.error).slice(0,150));
  await sleep(500);
  const after = await read(SITE);
  console.log('  最终:', after.map(e=>`(${e.x},${e.y})${e.type}`).join(' '));
  const belts = after.filter(e => e.type === 'belt').length;
  console.log(`  >>> 中间的普通带子剩余: ${belts} / 2  ${belts < 2 ? '← 被删了（C4 复现）' : '← 保留'}`);
}
