import { rpc } from "../live/kit.mjs";
const o = await rpc("obs", { max_entities: 1, include_hub: true }, 60000);
const s = o.hub.stored_shapes;
console.log("库存:", JSON.stringify(s));
console.log("升级:", JSON.stringify(o.goal.upgrade_levels));
const need = [
  ["belt I", [["CuCuCuCu", 30]]],
  ["miner I", [["RuRuRuRu", 300]]],
  ["processors I", [["SuSuSuSu", 500]]],
  ["painting I", [["RbRb----", 600]]],
];
for (const [k, reqs] of need) {
  const rows = reqs.map(([shape, amt]) => {
    const have = s[shape] || 0;
    return shape + " " + have + "/" + amt + (have >= amt ? " OK" : " --");
  });
  console.log(k.padEnd(14), rows.join("  "));
}
