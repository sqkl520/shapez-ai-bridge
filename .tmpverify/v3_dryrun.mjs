import { rpc } from "./rpc.mjs";
const BX = -300, BY = 300;
async function clean(region){ try{ await rpc("act",{op:"bulk_delete",region}); }catch(e){} }
async function place(building,x,y,r){ return rpc("act",{op:"place",building,x,y,r}); }
async function dryPaste(text,x,y){ return rpc("act",{op:"paste_blueprint",text,x,y,dry_run:true}); }
async function bpr(region){ return rpc("act",{op:"export_blueprint",region}); }

const results = [];
const check = (label, cond, extra) => { results.push({label, pass: cond, extra}); console.log(`${cond?"PASS":"FAIL"}  ${label}  ${extra?JSON.stringify(extra):""}`); };

async function scenario(label, makeExisting, blueprintFrom, pasteAt, expectKey) {
  await clean([BX-4,BY-4,BX+24,BY+4]);
  const existing = await makeExisting();
  const bp = await bpr(blueprintFrom);
  const dry = await dryPaste(bp.text, pasteAt[0], pasteAt[1]);
  const ev = { existing: existing && existing.entity_uid, dry: { would_apply: dry.would_apply, would_delete: dry.would_delete, blocked: dry.blocked.map(b=>b.cell), destroys: dry.destroys.map(d=>d.cell) } };
  results.push({label, ev});
  console.log(`${label}\n   ${JSON.stringify(ev)}`);
  return dry;
}

/* A: existing rot=180 cutter at (BX,BY). dry_run a 1-belt blueprint onto its LEFT half (BX-1,BY) */
{
  await clean([BX-6,BY-6,BX+6,BY+6]);
  await place("cutter", BX, BY, 180);
  // make a belt blueprint: place belt at some far tile, export 1x1
  await place("belt", BX+20, BY+20, 0);
  const bp = await bpr([BX+20,BY+20,BX+20,BY+20]);
  await rpc("act",{op:"delete",x:BX+20,y:BY+20});
  const dry = await dryPaste(bp.text, BX-1, BY);
  check("A1 rot180 cutter 左半格 → blocked/destroys >= 1",
    dry.blocked.length + dry.destroys.length >= 1,
    { blocked: dry.blocked.map(b=>b.cell), destroys: dry.destroys.length, would_apply: dry.would_apply });
  // control: origin cell (BX,BY)
  await clean([BX-6,BY-6,BX+6,BY+6]); await place("cutter", BX, BY, 180);
  const dry2 = await dryPaste(bp.text, BX, BY);
  check("A2 rot180 cutter origin 格 → blocked", dry2.blocked.length >= 1, { blocked: dry2.blocked.map(b=>b.cell) });
  // control: right side (free) should be applyable
  await clean([BX-6,BY-6,BX+6,BY+6]); await place("cutter", BX, BY, 180);
  const dry3 = await dryPaste(bp.text, BX+1, BY);
  check("A3 rot180 cutter 右侧空格 → 可放 (would_apply=1)", dry3.would_apply===1 && dry3.blocked.length===0, { would_apply: dry3.would_apply, blocked: dry3.blocked.length });
  await clean([BX-6,BY-6,BX+6,BY+6]);
}

/* B: blueprint containing a rot=180 cutter, pasted so that its left half overlaps an existing belt */
{
  await clean([BX-6,BY-6,BX+8,BY+8]);
  // build a cutter-180 blueprint by placing a cutter rot180 at (BX+10,BY) and exporting that single tile region... 
  // Problem: export computes bbox from origins. A single entity at origin (X,Y) rot180 exports as dx=0,dy=0 and when pasted at (x,y) occupies (x-1..x). Good.
  await place("cutter", BX+10, BY, 180);
  const bp = await bpr([BX+10,BY,BX+10,BY]);
  await rpc("act",{op:"delete",x:BX+10,y:BY});
  // existing belt at (BX,BY) which the pasted cutter's left half would cover if pasted at (BX+1,BY)
  await place("belt", BX, BY, 0);
  const dry = await dryPaste(bp.text, BX+1, BY);
  check("B1 蓝图含 rot180 cutter，贴到压 belt 左半格 → destroys>=1",
    dry.destroys.length >= 1, { destroys: dry.destroys.map(d=>d.cell), blocked: dry.blocked.map(b=>b.cell), would_apply: dry.would_apply });
  // control: paste at (BX+2,BY) so no overlap -> clean
  const dry2 = await dryPaste(bp.text, BX+2, BY);
  check("B2 同蓝图贴到不压任何东西 → would_apply=1, destroys=0",
    dry2.would_apply===1 && dry2.destroys.length===0, { would_apply: dry2.would_apply, destroys: dry2.destroys.length });
  await clean([BX-6,BY-6,BX+8,BY+8]);
}

/* C: rot=270 cutter: occupies (x, y-1) and (x,y) */
{
  await clean([BX-6,BY-6,BX+6,BY+6]);
  await place("cutter", BX, BY, 270);
  // belt blueprint
  await place("belt", BX+20, BY+20, 0);
  const bp = await bpr([BX+20,BY+20,BX+20,BY+20]);
  await rpc("act",{op:"delete",x:BX+20,y:BY+20});
  const d1 = await dryPaste(bp.text, BX, BY-1);
  check("C1 既有 rot270 cutter 上格 → blocked/destroys>=1", d1.blocked.length+d1.destroys.length>=1, { blocked: d1.blocked.map(b=>b.cell), destroys: d1.destroys.length });
  const d2 = await dryPaste(bp.text, BX+1, BY);
  check("C2 既有 rot270 cutter 右侧 → 空格可放", d2.would_apply===1 && d2.blocked.length===0, { would_apply: d2.would_apply, blocked: d2.blocked.length });
  await clean([BX-6,BY-6,BX+6,BY+6]);
}

/* D: rot=0 and rot=90 still work */
{
  await clean([BX-6,BY-6,BX+6,BY+6]);
  await place("belt", BX+20, BY+20, 0);
  const bp = await bpr([BX+20,BY+20,BX+20,BY+20]);
  await rpc("act",{op:"delete",x:BX+20,y:BY+20});
  await place("cutter", BX, BY, 0);
  const dR = await dryPaste(bp.text, BX+1, BY);
  check("D1 rot0 cutter 右半格 → blocked", dR.blocked.length>=1, { blocked: dR.blocked.map(b=>b.cell) });
  const dL = await dryPaste(bp.text, BX-1, BY);
  check("D2 rot0 cutter 左邻空格 → 可放", dL.would_apply===1 && dL.blocked.length===0, { would_apply: dL.would_apply });
  await clean([BX-6,BY-6,BX+6,BY+6]);
  await place("cutter", BX, BY, 90);
  const d90 = await dryPaste(bp.text, BX, BY+1);
  check("D3 rot90 cutter 下格 → blocked", d90.blocked.length>=1, { blocked: d90.blocked.map(b=>b.cell) });
  const d90b = await dryPaste(bp.text, BX, BY-1);
  check("D4 rot90 cutter 上邻空格 → 可放", d90b.would_apply===1 && d90b.blocked.length===0, { would_apply: d90b.would_apply });
  await clean([BX-6,BY-6,BX+6,BY+6]);
}
console.log("\nSUMMARY:", results.filter(r=>r.pass===false).length+" failed of "+results.filter(r=>r.pass!==undefined).length);
