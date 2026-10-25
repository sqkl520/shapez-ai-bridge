import fs from 'node:fs';
import { encodeBlueprint } from '../../../src/shared/blueprint.mjs';
const RPC = 'http://127.0.0.1:7777/rpc';
const call = async (m, p = {}) => (await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) })).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SITE = [500, 500];
// 中间带子：rot=180（朝下流，与隧道同向）—— 这是 smartplace 会删的形态
const beltBP = encodeBlueprint({ gv: '1.5.6', w: [0,0], entities: [
  { code: 1, dx: 0, dy: 0, rot: 180 }, { code: 1, dx: 0, dy: 1, rot: 180 },
]});
const tunBP = encodeBlueprint({ gv: '1.5.6', w: [0,0], entities: [
  { code: 22, dx: 0, dy: 0, rot: 180 }, { code: 23, dx: 0, dy: 3, rot: 180 },
]});

async function read(site) {
  const r = await call('obs', { region: [site[0]-1, site[1]-1, site[0]+1, site[1]+5] });
  return (r.result.entities || []).sort((a,b)=>a.y-b.y);
}

for (const smart of [true, false]) {
  console.log(`\n===== smartplace=${smart} =====`);
  await call('game_setting', { key: 'enableTunnelSmartplace', value: smart });
  await call('act', { op: 'bulk_delete', region: [SITE[0]-2, SITE[1]-2, SITE[0]+3, SITE[1]+7] });
  await sleep(150);
  const p1 = await call('act', { op: 'paste_blueprint', text: beltBP, x: SITE[0], y: SITE[1]+1, charge: false });
  console.log('铺中间带子 rot180:', p1.result?.applied, '格');
  await sleep(200);
  console.log('  铺完:', (await read(SITE)).map(e=>`(${e.x},${e.y})${e.type[0]}`).join(' '));
  const p2 = await call('act', { op: 'paste_blueprint', text: tunBP, x: SITE[0], y: SITE[1], charge: false });
  console.log('贴隧道:', p2.result ? `applied=${p2.result.applied}` : JSON.stringify(p2.error).slice(0,120));
  await sleep(600);
  const after = await read(SITE);
  console.log('  最终:', after.map(e=>`(${e.x},${e.y})${e.type[0]}`).join(' '));
  const belts = after.filter(e => e.type === 'belt').length;
  console.log(`  >>> 中间带子剩余 ${belts}/2 ${belts < 2 ? '← 被删了（C4 复现 ✓）' : '← 保留'}`);
}
