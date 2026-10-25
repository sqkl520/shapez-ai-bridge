import fs from 'node:fs';
const RPC = 'http://127.0.0.1:7777/rpc';
const call = async (method, params = {}) => {
  const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return r.json();
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const bp = fs.readFileSync(new URL('./tun-exp-bp.txt', import.meta.url), 'utf8').trim();

const obsBudget = async (region) => {
  const r = await call("obs", region ? { region } : {});
  if (!r.result) throw new Error(JSON.stringify(r.error));
  return r.result.entities;
};

// 找一块空地（远离 hub）
const SITE = [300, 300];

async function trial(label, smartplace) {
  console.log(`\n===== ${label}（enableTunnelSmartplace=${smartplace}）=====`);
  // 1. 设置
  const st = await call('game_setting', { key: 'enableTunnelSmartplace', value: smartplace });
  console.log('设置:', JSON.stringify(st.result || st.error));
  // 2. 清场
  await call('act', { op: 'bulk_delete', region: [SITE[0]-2, SITE[1]-2, SITE[0]+4, SITE[1]+8] });
  await sleep(200);
  // 3. dry_run
  const dr = await call('act', { op: 'paste_blueprint', text: bp, x: SITE[0], y: SITE[1], dry_run: true });
  console.log('dry_run:', JSON.stringify(dr.result || dr.error).slice(0, 200));
  // 4. paste
  const pa = await call('act', { op: 'paste_blueprint', text: bp, x: SITE[0], y: SITE[1], charge: false });
  console.log('paste:', JSON.stringify(pa.result || pa.error).slice(0, 250));
  await sleep(600);
  // 5. 读回
  const ents = await obsBudget([SITE[0]-1, SITE[1]-1, SITE[0]+3, SITE[1]+7]);
  const mine = ents.filter(e => e.x >= SITE[0]-1 && e.x <= SITE[0]+2 && e.y >= SITE[1]-1 && e.y <= SITE[1]+7);
  console.log('读回实体数:', mine.length);
  for (const e of mine.sort((a,b)=>a.y-b.y)) console.log(`   (${e.x},${e.y}) ${e.type} code=${e.code} r=${e.r}`);
  return mine;
}

const before = await trial('关闭 smartplace', false);
const after = await trial('开启 smartplace', true);

console.log('\n===== 对比 =====');
console.log('关闭时实体数:', before.length);
console.log('开启时实体数:', after.length);
