import { rpc } from "./rpc.mjs";
for (let i=0;i<40;i++){
  try {
    const s = await rpc("status");
    if (s.in_game) { console.log("in_game after", i, "polls:", JSON.stringify(s)); break; }
    console.log("poll", i, "in_game=", s.in_game);
  } catch(e){ console.log("poll",i,"err",e.message); }
  await new Promise(r=>setTimeout(r,1500));
}
