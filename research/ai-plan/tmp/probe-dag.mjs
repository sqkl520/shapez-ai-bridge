import { compilePlan } from '../../../src/ai/compiler/compile.mjs';
for (const g of ['CpCpCpCp','CgScScCg']) {
  const p = compilePlan({ goal: g, seed: 43391, range: 400, allowUnpinned: true });
  console.log(`=== ${g} ok=${p.ok} ===`);
  if (!p.layout) { console.log(p.reason); continue; }
  console.log('placements', JSON.stringify(p.layout.placements.map(x => [x.nodeId, x.op, x.cell])));
  console.log('channels', JSON.stringify(p.layout.channels.map(c => [c.from.nodeId+'->'+c.to.nodeId, c.from.slot+'/'+c.from.outDir, c.to.slot+'/'+c.to.inDir, c.payload])));
  console.log('hubConn', JSON.stringify(p.layout.hubConnection));
}
