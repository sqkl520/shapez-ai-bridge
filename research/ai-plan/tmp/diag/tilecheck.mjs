import { tileResource } from "file:///D:/Projects/rea/Project%20work/shapez/src/ai/world.mjs";
const realRu = [[-10,4],[-9,4],[-8,5],[-7,5],[2,-8],[3,-8],[4,-8],[5,-8]];
for (const seed of [43391, 55013]) {
  const rows=[];
  for (const [x,y] of realRu) rows.push(`${x},${y}:${tileResource(seed,x,y)}`);
  console.log("seed",seed,"=>",rows.join(" "));
}
