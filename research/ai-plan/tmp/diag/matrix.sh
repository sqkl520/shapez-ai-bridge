#!/bin/bash
W="research/ai-plan/tmp/diag/world181.json"
run() {
  desc="$1"; shift
  out=$(timeout 300 node src/ai/compiler/cli.mjs "$@" --no-handoff --json 2>&1)
  echo "$desc" > research/ai-plan/tmp/diag/.tmpout
  printf '%s => ' "$desc"
  echo "$out" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const p=JSON.parse(s);if(p.ok)console.log('ok:true ents='+p.entities.length+' anchor='+JSON.stringify(p.site.anchor));else console.log('ok:false '+p.reason+' fail='+JSON.stringify(p.failingNode));}catch(e){console.log('RAW '+s.slice(0,200))}})"
}
run "T1 空地图 hub(-2,-2) seed默认" --goal "RuRu----" --hub -2,-2 --level 4
run "T2 空地图 hub(-2,-2) seed55013" --goal "RuRu----" --hub -2,-2 --level 4 --seed 55013
run "T3 world181 hub(-2,-2) seed默认" --goal "RuRu----" --hub -2,-2 --level 4 --world $W
run "T4 world181 hub(-2,-2) seed55013" --goal "RuRu----" --hub -2,-2 --level 4 --seed 55013 --world $W
run "T5 world181 hub(-2,-2) seed55013 tunnels" --goal "RuRu----" --hub -2,-2 --level 4 --seed 55013 --world $W --tunnels
run "T6 空地图 hub(0,30) seed默认" --goal "RuRu----" --hub 0,30 --level 4
run "T7 world181 hub(0,30) seed默认" --goal "RuRu----" --hub 0,30 --level 4 --world $W
run "T8 空地图 hub(0,30) seed55013" --goal "RuRu----" --hub 0,30 --level 4 --seed 55013
run "T9 world181 hub(0,30) seed55013" --goal "RuRu----" --hub 0,30 --level 4 --seed 55013 --world $W
run "T10 空地图 hub(-2,-2) rowGap14" --goal "RuRu----" --hub -2,-2 --level 4 --seed 55013 --row-gap 14
run "T11 空地图 hub(-2,-2) miners4" --goal "RuRu----" --hub -2,-2 --level 4 --seed 55013 --miners 4
run "T12 world181 铜目标 CuCuCuCu" --goal "CuCuCuCu" --hub -2,-2 --level 4 --seed 55013 --world $W
