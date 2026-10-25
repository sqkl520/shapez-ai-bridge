// 精确复现 C4：中间带子必须 entry=top 且 rotation 与隧道方向一致
// 隧道朝下（rot 180）。带子要 entry=top（从上方进货）⇒ 带子也是朝下流。
// belt code=1 是直带，它的 entry 由 rotation 决定？查 belt-rules。
import fs from 'node:fs';
import { encodeBlueprint } from '../../../src/shared/blueprint.mjs';
import { beltEntry, beltExit } from '../../../src/ai/belt-rules.mjs';
const RPC = 'http://127.0.0.1:7777/rpc';
const call = async (m, p = {}) => (await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) })).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 直带 rv=0：entry/exit 沿旋转轴。找 rot 使得 entry=top 且 exit=bottom（朝下流）
let rot = null;
for (const r of [0,90,180,270]) {
  if (beltEntry(0, r) === 'top' && beltExit(0, r) === 'bottom') { rot = r; break; }
}
console.log('朝下流的直带 rot =', rot);
