import { rpc } from "../live/kit.mjs";
const o = await rpc("obs", { region: [-40, -40, 40, 40], include_resources: true, max_resources: 20000, include_stats: false }, 120000);
const cu = o.resources.filter(r => r[2] === "RuRuRuRu");
const rows = {};
for (const [x, y] of cu) (rows[y] = rows[y] || []).push(x);
console.log("钌矿格:", cu.length);
for (const y of Object.keys(rows).map(Number).sort((a, b) => a - b)) {
  const xs = rows[y].sort((a, b) => a - b);
  const runs = []; let s = xs[0], p = xs[0];
  for (let i = 1; i < xs.length; i++) { if (xs[i] === p + 1) p = xs[i]; else { runs.push(s === p ? "" + s : s + ".." + p); s = p = xs[i]; } }
  runs.push(s === p ? "" + s : s + ".." + p);
  console.log("y=" + String(y).padStart(4), runs.join("  "));
}
