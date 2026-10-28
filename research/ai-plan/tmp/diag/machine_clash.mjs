/* 关键验证：placeMachines 只用 Grid，Grid 里有没有既有世界占位？
   看 place() 里 Grid 的构造与 markOccupancy 调用。 */
import fs from "node:fs";
const src = fs.readFileSync("D:/Projects/rea/Project work/shapez/src/ai/compiler/place.mjs","utf8").split("\n");
const idx = src.findIndex(l=>l.includes("const grid = new Grid"));
console.log("Grid 构造在行", idx+1);
for(let i=idx;i<idx+14;i++) console.log(i+1, src[i]);
console.log("--- 全文里 markOccupancy 的调用 ---");
src.forEach((l,i)=>{ if(l.includes("markOccupancy")) console.log(i+1, l.trim()); });
