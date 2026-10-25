const RPC = 'http://127.0.0.1:7777/rpc';
const call = async (m, p = {}) => (await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) })).json();

const KEEP = new Set([
  '5c96706563c0b74c4d2ce4c7f8bf7a244392de89',  // 用户 level-11 工厂
  'cf469f75342e5be252915e4d882164769a7fe70a',  // 用户原有
  '1d9c8293579d2ad43f99e7b462afd6e109af2ae8',  // 存疑保留
  '7c93b3dd9e949c561e5aa529974973b18c856b45',  // 存疑保留
]);

const r = await call('list_saves');
const saves = r.result.saves;
const toDelete = saves.filter(s => !KEEP.has(s.internal_id));
console.log(`总 ${saves.length}，保留 ${saves.length - toDelete.length}，待删 ${toDelete.length}`);

// 先 dry_run 一条确认语义
if (toDelete.length) {
  const dr = await call('delete_save', { internal_id: toDelete[0].internal_id, dry_run: true });
  console.log('dry_run:', JSON.stringify(dr.result || dr.error).slice(0, 200));
}

let ok = 0, fail = 0;
for (const s of toDelete) {
  const res = await call('delete_save', { internal_id: s.internal_id });
  if (res.result && res.result.ok) ok++;
  else { fail++; if (fail <= 3) console.log('  失败:', s.internal_id.slice(0,12), JSON.stringify(res.error).slice(0,150)); }
}
console.log(`删除完成: ok=${ok} fail=${fail}`);
const after = await call('list_saves');
console.log('剩余存档:', after.result.saves.length);
for (const s of after.result.saves) console.log('  ', s.internal_id.slice(0,16), 'level', s.level);
