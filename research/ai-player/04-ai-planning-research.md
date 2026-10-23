# 04 — What actually makes an LLM smarter at shapez?

**Survey date:** 2026-10-22
**Scope:** LLM-driven agents that plan in complex simulated/industrial environments, evaluated against the concrete constraints of this project: shapez.io exposed over JSON-RPC with deterministic, cheap, fast-forwardable simulation.
**Output feeds:** an engineering design for a "genuinely smart" shapez agent that solves compound-shape levels and optimizes throughput with few actions and few observations.

---

## 0. Method, evidence grading, and honest caveats

### 0.1 What I actually did

- Queried the **arXiv API** (`export.arxiv.org/api/query`) with title- and abstract-phrase searches, then read the returned abstracts. Where a paper is cited below, the cited URL is the `arxiv.org/abs/<id>` page for an entry I actually retrieved. I did **not** open many PDFs; where I report a specific number, it is from the abstract, and I flag it when the claim is abstract-level only.
- Queried the **GitHub REST API** for `tobspr-games/shapez.io` (the upstream game source) and for repository search on `shapez`. Read `shape_definition.js` and `shape_definition_manager.js` in full.
- Read the **local** project substrate: `docs/PROTOCOL.md` (bridge protocol v1) and `src/agent/play.mjs` (the B1 reference heuristic).
- Web search (`web_search`) for shapez-specific prior art. **This was the weakest channel** — the search backend returned mostly irrelevant GitHub-trending noise for shapez queries. I compensated with direct GitHub API calls. I did **not** find and could **not** verify a shapez AI competition; see §7.5.

### 0.2 Evidence grades used throughout

| Grade | Meaning |
|---|---|
| **[STRONG]** | Peer-reviewed paper with a quantitative result I read directly, or a fact read directly out of the shapez source code. |
| **[MEDIUM]** | Peer-reviewed paper with a result I read at abstract level, or a single-source community artifact. |
| **[WEAK]** | Anecdotal, single repo, or abstract-level claim without the supporting experiment in hand. |
| **[SPECULATIVE]** | My inference from the evidence. Not a finding. |

### 0.3 Two things that change the shape of the answer before any literature is read

**(A) shapez's shape algebra is already a first-class deterministic data structure in the game source.** [STRONG]
`src/js/game/shape_definition.js` defines `ShapeDefinition` as an array of layers (bottom→top), each layer an array of exactly 4 quadrants in the fixed order `[tr, br, bl, tl]`, each quadrant `{subShape, color}`. Sub-shapes are `rect|star|circle|windmill`; the canonical string form is 2 chars per quadrant per layer, layers joined by `:` — e.g. `CbCbCbRb:CwCwCwCw`, exactly the `goal.requirement.shape` field in our protocol. `getHash()` produces that canonical key deterministically. Four algebraic operations are implemented as pure functions:

| Operation | Source method | Semantics |
|---|---|---|
| **Cut** | `cloneFilteredByQuadrants(includeQuadrants)` | keep only selected quadrants; empty layers are spliced out |
| **Rotate** | `cloneRotateCW()` / `cloneRotateCCW()` / `cloneRotate180()` | permute the 4-quadrant ring |
| **Stack** | `cloneAndStackWith(other)` | merge two definitions, aligning so the minimum inter-layer gap is 1, capped at 4 layers; **asserts** that no quadrant collides (`"Shape merge: Sub shape got lost"`) |
| **Paint** | `cloneAndPaintWith(c)` / `cloneAndPaintWith4Colors(cs)` | recolor all / per-quadrant |

`src/js/game/shape_definition_manager.js` wraps these in a **memoized operation table** keyed by strings like `"cut/<hash>"`, `"rotate-cw/<hash>"`, `"stack/<hash>/<hash>"`, `"paint/<hash>/<color>"`. So the game already ships a memoized, total, deterministic algebra over shapes.

*Implication:* the "is this layout right?" question for shapez has an **exact algebraic answer** that costs no LLM and no tokens. This is the single most important fact in this document and it reframes every question in §1–§3.

**(B) Our simulation is a first-class, cheap, deterministic oracle.** [STRONG]
`docs/PROTOCOL.md` exposes `step {ticks: 1..20000}` and `await {until: "hub_delivered_increased"|"level_increased"|"entities_changed", timeout_ticks}` with hard timeouts, plus `place`, `place_path`, `delete`, `bulk_delete`, `paste_blueprint`, `export_blueprint`. It returns `delivered`/`required`/`progress`/`throughput_only` per goal. So we can **run a candidate layout to completion in one RPC round trip** and read off the objective. That is a genuine model-based planner's dream and it is strictly stronger than every learned-model approach in §3.1.

**(C) The baseline to beat is already competent on the easy axis.** [STRONG]
`src/agent/play.mjs::runB1` finds the nearest resource, places a miner with the rotation matching the first belt segment direction, lays an L-shaped belt in 2–3 `place_path` calls, and `await`s a hub delivery — with per-path fallback (up to 4 path variants), error-code-specific hints, and re-observation of occupants on `2002`. It handles miner-rotation semantics, belt-direction-equals-flow-direction, and the axis-aligned-path constraint. It is ~10 actions and 1 observation for the first delivery.

*Implication:* the win is **not** "connect a miner to a hub." The win is **compound-shape construction** (level 10+ goals: cutter/stacker/painter recipes) and **throughput optimization** (`throughput_only: true`), where the number of parallel lines, belt-tier upgrades, and buffer placement become the problem. Those are exactly the axes the literature in §2–§5 addresses.

---

## 1. LLM + symbolic planner hybrids: the real literature

### 1.1 LLM+P — the canonical "translate, solve, translate back" loop

Liu, Jiang, Zhang, Liu, Zhang, Biswas, Stone (2023), **LLM+P: Empowering Large Language Models with Optimal Planning Proficiency**, arXiv:2304.11477. [STRONG for mechanism; MEDIUM for transfer]

- **Mechanism:** the LLM is a *front-end compiler*, not a planner. Natural language → PDDL problem file (one in-context example suffices) → classical planner finds a (near-)optimal plan → LLM back-translates to natural language.
- **Evidence:** the abstract states LLM+P "is able to provide optimal solutions for most problems, while LLMs fail to provide even feasible plans for most problems." Across 7 IPC-derived robot domains with 20 auto-generated tasks each. Secondary summaries of the paper report LLM+P at 85–100% success vs. **0%** for standalone LLMs and Tree-of-Thoughts on complex domains like Barman and Storage, and ~35–50% GPT-4 vs. 95–100% LLM+P on Grippers. (Those specific numbers come from secondary write-ups I read, not the PDF — treat as [WEAK].)
- **Transfer to shapez:** **Partial and indirect.** shapez has no PDDL domain and never will; but the *shape* half of the problem is exactly PDDL-shaped. The goal shape is a declarative object; the four operations (cut/rotate/stack/paint) are a finite, complete, sound operator set; the target is a fully-specified conjunction of quadrants and layers. This is a **solvable, checkable, finite-horizon derivation problem** over a 4-quadrant × ≤4-layer algebra — closer to the geometry/theorem-proving regime of §4.4 than to blocksworld.
- **Transfer caveat:** LLM+P's strength is *front-end translation of natural language into a formal spec*. Our spec (`goal.requirement.shape`) is **already machine-readable**. We have no NL→spec translation problem to solve. Therefore **the LLM+P pattern is not the LLM's job here** — the LLM's job is the *layout* (where to put things), not the *shape spec*. §2.8 covers what the LLM actually should own.

### 1.2 LLM-Modulo — the framework that answers "what is the LLM for?"

Valmeekam, Guan, Verma, Bhambri, Stechly, Saldyt, Murthy, Kambhampati (2024), **"LLMs Can't Plan, But Can Help Planning in LLM-Modulo Frameworks"**, ICML 2024, arXiv:2402.01817. [STRONG]

- **Mechanism:** pairs an LLM with *sound external verifiers* in a bi-directional loop. The verifier rejects a bad output and the LLM repairs it. The paper's position, stated in the abstract, is that "auto-regressive LLMs cannot, by themselves, do planning or self-verification," and that LLMs should be treated as "universal approximate knowledge sources" with meaningful roles **beyond** simple front-end/back-end format translation.
- **Why this matters for us:** it reframes the LLM's role from *executor* to *proposal generator + knowledge source*, with a deterministic verifier as the gate. That is precisely the shapez architecture we want: LLM proposes a layout program, the shape algebra + simulator check it, the LLM repairs it.
- Corroborating results: **"Robust Planning with Compound LLM Architectures: An LLM-Modulo Approach"** (Gundawar, Valmeekam, Verma, Kambhampati, 2024), arXiv:2411.14484 — "an LLM is paired with a complete set of sound verifiers that validate its output, re-prompting it if it fails… the system can never output any fallacious output"; "significant performance gains… across four scheduling domains." [MEDIUM]
- And the travel-planning instantiation: **"Robust Planning with LLM-Modulo Framework: Case Study in Travel Planning"**, arXiv:2405.20625 — CoT / ReAct / Reflexion score **0% / 0.6% / 0%** with GPT-3.5-Turbo on TravelPlanning; LLM-Modulo gives **4.6× improvement for GPT-4-Turbo** and takes GPT-3.5-Turbo from **0% to 5%**. The paper also reports that the LLM is useful in two *additional* roles: **extracting useful critics** and **reformulating critic feedback**. [STRONG for the numbers as stated in the abstract]
- **Transfer:** ★★★★★. This is the core architectural template for our agent. The "sound verifier" for shapez is not an LLM judge — it is the shape algebra (exact) plus the simulator (exact). The LLM's job is to *propose* and to *reformulate the critique*.

### 1.3 The negative evidence: LLMs cannot plan, and search beats them

- Valmeekam, Marquez, Olmo, Sreedharan, Kambhampati (2022/2023), **PlanBench**, NeurIPS 2023 D&B, arXiv:2206.10498 — "on many critical capabilities—including plan generation—LLM performance falls quite short, even with the SOTA models." [STRONG]
- Valmeekam, Stechly, Kambhampati (2024), **"LLMs Still Can't Plan; Can LRMs?"**, arXiv:2409.13373 — o1's PlanBench performance is "a quantum improvement… but it is still far from saturating it. This improvement also brings to the fore questions about accuracy, efficiency, and guarantees which must be considered before deploying such systems." [STRONG]
- Aghzal, Plaku, Stein, Yao (2025), **"A Survey on Large Language Models for Automated Planning"**, arXiv:2502.12435 — the survey's thesis, in the abstract: "although LLMs are not well-suited to serve as standalone planners because of these limitations, they nonetheless present an enormous opportunity to enhance planning applications when combined with other approaches… we advocate for a balanced methodology that leverages the inherent flexibility and generalized knowledge of LLMs alongside the rigor and cost-effectiveness of traditional planning methods." [STRONG]
- **The most transferable single data point:** Zhang et al. (2026), **"From Solver Feedback to Faithful Plans: Multi-Role Reinforcement Learning for Symbolic Planning"**, arXiv:2608.21897. On PlanBench they report "improves average success from **35.5% for LLM+P to 70.8%**, achieves **66.3% faithful success**, and reduces **semantic drift to 6.4%**," by making one LM act as **Actor, Judge, and Editor** over solver feedback. [STRONG as reported in the abstract]
  - **Read this as a template, not a result.** The shapez analogue is: **Actor** = LLM emits a layout program; **Judge** = deterministic shape-algebra checker + simulator; **Editor** = LLM repairs the program given the Judge's structured critique. Their "semantic drift" metric maps onto a shapez metric I call *shape drift*: the fraction of programs that satisfy the checker operationally but produce a shape different from the goal. §4.6 defines it.
- **A caution about hierarchy:** Puerta-Merino, Núñez-Molina, Mesejo, Fernández-Olivares (2025), **L2HP**, arXiv:2511.18165 — on PlanBench, "parsing success is limited but comparable in both settings (around 36%), while **syntactic validity is substantially lower in the hierarchical case (1% vs. 20% of instances)**." [MEDIUM]
  - **Transfer:** [SPECULATIVE→STRONG by analogy] Hierarchical *specification* generation is much harder for LLMs than flat specification generation. If we ask an LLM to emit a multi-stage layout DSL (stage 1 builds a cutter, stage 2 stacks, stage 3 paints), expect the nesting to break. **Emit flat, single-stage programs; compose them in deterministic Python.**

### 1.4 SayPlan — the "scene-graph simulator as replanner" pattern

Park, Rana, Garg, Abou-Chakra, Yang, Ahn, Kwon, Park, Kwon, ... Hong (2023), **SayPlan**, CoRL 2023, arXiv:2307.06135. [STRONG]

- **Mechanism (three components, all relevant to us):**
  1. **Hierarchical abstraction** — collapse a large scene graph into a smaller task-relevant subgraph so the LLM plans over a small semantic space ("semantic search for task-relevant subgraphs from a smaller, collapsed representation of the full graph").
  2. **Classical path planner in the loop** — "reduce the planning horizon for the LLM by integrating a classical path planner." (i.e. the LLM does not compute the geometry; a deterministic planner does.)
  3. **Iterative replanning with simulator feedback** — "refines the initial plan using feedback from a scene graph simulator, correcting infeasible actions and avoiding planning failures."
- **Evidence:** grounded long-horizon plans in environments "spanning up to 3 floors and 36 rooms with 140 assets and objects," with real-robot video demonstrations.
- **Transfer:** ★★★★★ — and it is the *closest published architecture to what we want*. SayPlan is literally "LLM plans → deterministic component (path planner) does the geometry → simulator critiques → LLM replans." Map:
  - scene graph → our `obs` entity list + `stats.by_type` + `hub.stored_shapes`
  - collapsed subgraph → our `region`-scoped observation + goal requirement summary (the "few observations" objective)
  - classical path planner → deterministic belt-router / path-finder that emits `place_path` calls
  - scene-graph simulator → our `step`/`await` fast-forward
- **Transfer caveat:** SayPlan's LLM plans at the *task* level ("go to the drawer") and the classical planner handles *geometry*. For shapez, the interesting geometry (belt routing) is easy and deterministic; the interesting part (recipe topology) is what the LLM should own. So the split is inverted relative to SayPlan but the *loop* is identical.

### 1.5 ProgPrompt, ToRA, Code-as-Policies — the "program, not coordinates" family

| Paper | Mechanism | Evidence | Transfer |
|---|---|---|---|
| Singh, Blukis, Mousavian, Goyal, Xu, Tremblay, Fox, Thomason, Garg (2022), **ProgPrompt**, arXiv:2209.11302 | Prompt the LLM with *program-like specifications* of available actions/objects plus example programs that can be executed. Explicitly avoids both "enumerating all possible next steps for scoring" and "free-form text that may contain actions not possible on a given robot in its current context." | "demonstrate state of the art success rates in VirtualHome household tasks, and deploy our method on a physical robot arm"; ablation-driven prompt-design recommendations. [STRONG for mechanism, MEDIUM for numbers] | ★★★★☆. Our action set is small and typed (`place`, `place_path`, `delete`, `bulk_delete`, `paste_blueprint`, `step`, `await`) with a closed error vocabulary (2001/2002/2003). That is exactly the regime where program-like prompting wins: constrain the *shape* of the output so hallucinated actions become impossible. |
| Gou, Shao, Gong, Shen, Yang, Huang, Duan, Chen (2023/2024), **ToRA**, ICLR 2024, arXiv:2309.17452 | Tool-integrated reasoning: natural-language reasoning interleaved with external tool calls (computation libraries, symbolic solvers). Trained via imitation on curated tool-use trajectories + **output space shaping**. | "13%–19% absolute improvements on average" on 10 math datasets; ToRA-7B reaches 44.6% on MATH, beating WizardMath-70B by 22% absolute. [STRONG] | ★★★★☆. Directly transferable as a *training* recipe if we ever fine-tune: the highest-leverage part is **output space shaping** — constrain the decoder to emit only tokens that can form valid actions. |
| Liang, Huang, Xia, Xu, Hausman, Ichter, Florence, Zeng (2022/2023), **Code as Policies**, arXiv:2209.07753 | LLM writes *robot policy code* (functions, feedback loops) that call perception + control primitives. **Hierarchical code-gen**: recursively define undefined functions. | Policies "exhibit spatial-geometric reasoning, generalize to new instructions, and prescribe precise values… depending on context"; hierarchical code-gen "improves state-of-the-art to solve 39.8% of problems on HumanEval." [STRONG] | ★★★★★, and it is the *most directly copyable* mechanism in this list. Our reference agent is already a program. The upgrade is: **let the LLM write that program**, with recursive definition for "make a cutter" / "make a stacker line". |
| Ahn, Choi, Lee, Park, Woo (2025), **"Towards Reliable Code-as-Policies"**, NeurIPS 2025 Spotlight, arXiv:2510.21302 | Neuro-symbolic Code-as-Policies: **explicit symbolic verification and interactive validation** during code generation; the validation phase "generates exploratory code that actively interacts with the environment to acquire missing observations while preserving task-relevant states." | "improves task success rates by **46.2%** over Code-as-Policies baselines and attains over **86.8% executability** of task-relevant actions," on RLBench and real-world dynamic/partially-observable settings. [STRONG] | ★★★★★ — this is the single best template for our "propose → simulate → critique → repair" loop, *with numbers*. Note the phrasing: it improves over Code-as-Policies **and** adds **interactive validation**. Both halves transfer. |

### 1.6 Game agents: Voyager, GITM, JARVIS-1, STEVE-1, ADAM

| System | Mechanism | Reported gain | Transfer to shapez |
|---|---|---|---|
| **Voyager** (Wang, Xie, Jiang, Mandlekar, Xiao, Zhu, Fan, Anandkumar, 2023), arXiv:2305.16291 | Three components: (1) **automatic curriculum** maximizing exploration; (2) **ever-growing skill library** of executable code; (3) **iterative prompting** that incorporates environment feedback, execution errors, and self-verification. Black-box GPT-4, no weight updates. | "**3.3×** more unique items, **2.3×** longer distances, and unlocks key tech tree milestones up to **15.3×** faster than prior SOTA." [STRONG] | ★★★★☆. Voyager's **skill library** is the shapez analog of "reusable layout recipes" (e.g. `build_cutter_chain`, `build_stack_line`, `build_paint_line`). Its **self-verification via execution** is the analog of "run the simulator and check the shape." |
| **GITM / Ghost in the Minecraft** (Zhu, Chen, Tian, Tao, Su, Yang, Gao, Li, Lu, Wang, Yang, Qiao, Zhang, Dai, 2023), arXiv:2305.17144 | LLM + text-based knowledge + memory; **"a set of structured actions"** with the LLM generating action plans; no GPU training, 32 CPU cores. | "**+47.5%** success rate on 'ObtainDiamond'"; "first to procure all items in the Overworld technology tree." [STRONG] | ★★★★★ on one specific point: **structured actions**. GITM's gain came from constraining the action space into a typed, small set — exactly our §5 mitigation for hallucinated building ids. |
| **JARVIS-1** (Wang, Cai, Liu, Jin, Hou, Zhang, Lin, He, Zheng, Yang, Ma, Liang, 2023), arXiv:2311.05997 | Multimodal LM maps (observation, instruction) → plan → dispatched to goal-conditioned controllers; **multimodal memory**. | "capable of completing over 200 different tasks"; on ObtainDiamondPickaxe "surpasses the reliability of current state-of-the-art agents by **5×**"; "nearly perfect" on short-horizon tasks. [STRONG] | ★★★☆☆. Memory-augmented planning matters for *long* shapez campaigns, less for per-level solving. The "LLM plans, controller executes" split is the relevant bit. |
| **STEVE-1** (Lifshitz, Paster, Chan, Ba, McIlraith, 2023), arXiv:2306.00937 | Instruction-tuned Video Pre-training model; MineCLIP latent space for text→behavior; **hindsight relabeling**. | "robustly completing **12 of 13** tasks" in an early-game evaluation suite, for "$60 of compute." [STRONG] | ★★☆☆☆. STEVE-1 is a *pixel-policy* model. shapez is a **symbolic, text-native** environment — a VLA is the wrong tool. Included to mark the boundary: do not go down the pixel-policy path. |
| **ADAM** (Yu, Lu, 2024), arXiv:2410.22194 | Builds a **causal graph from scratch** as the world model; controller = planner + actor + memory pool; perception via multimodal LLM. | "constructs an almost perfect causal graph from scratch, enabling efficient task decomposition and execution with strong interpretability"; maintains performance with **no prior knowledge**. [MEDIUM] | ★★★★☆. The causal-graph-as-world-model is a good answer to "what does the LLM actually hold in its head about the factory?" — but we can do better: we have an *exact* simulator, so we should not ask the LLM to maintain a causal graph. (§3.1 explains why learned models lose here.) |

### 1.7 NetHack and StarCraft — the "does an LLM beat search?" tests

- Hambro et al. (2022), **"Insights From the NeurIPS 2021 NetHack Challenge"**, arXiv:2203.11889 — "it served as a direct comparison between neural (e.g. deep RL) and **symbolic AI**, as well as hybrid systems, demonstrating that on NetHack **symbolic bots currently outperform deep RL by a large margin**. Lastly, no agent got close to winning the game." [STRONG]
- Küttler et al. (2020), **The NetHack Learning Environment**, NeurIPS 2020, arXiv:2006.13760 — the environment design rationale: complexity *and* simulation speed. [STRONG]
- Quarantiello, Marzeddu, Guzzi, Lomonaco (2023), **LuckyMera**, arXiv:2307.08532 — modular framework mixing **hard-coded symbolic skills and neural RL modules** into compositional hybrids, reaching "state-of-the-art performances in the complete NetHack game." [MEDIUM]
- Paglieri, Cupiał, Coward, Piterbarg, Wolczyk, Khan, Pignatelli, Kuciński, Pinto, Fergus, Parker-Holder, Rocktäschel, Nicolaus Foerster (2024/2025), **BALROG**, ICLR 2025, arXiv:2411.13543 — benchmarks agentic LLM/VLM reasoning on games incl. NLE; "while current models achieve partial success in the easier games, they struggle significantly with more challenging tasks. Notably, we observe **severe deficiencies in vision-based decision-making**, as several models perform **worse** when visual representations of the environments are provided." [STRONG]
- Mathieu et al. (2023), **AlphaStar Unplugged**, arXiv:2308.03526 — offline RL benchmark for SC2 with behavior cloning, offline actor-critic, and **MuZero** baselines; 90% win rate vs. published AlphaStar BC. [STRONG]
- **Transfer reading:** BALROG's finding that *adding vision makes models worse* is the strongest available evidence that **a symbolic, text-native observation channel is an advantage, not a limitation**. Our `obs` payload (entities with uid/type/x/y/r, goal requirement, resources, stats) is already the right representation. Do not add screenshots to the action loop.

### 1.8 Outer-loop vs inner-loop decomposition — and what the LLM actually owns

There is no single paper titled "outer loop vs inner loop"; the distinction is assembled from the evidence above. [SPECULATIVE synthesis, grounded in §1.2, §1.4, §1.5, §1.6, §2]

| Layer | Who | Evidence it works | shapez instantiation |
|---|---|---|---|
| **Outer loop** (choose strategy, choose recipe, choose topology) | **LLM** | SayPlan (hierarchical abstraction + replanning); Code-as-Policies (hierarchical code-gen, 39.8% HumanEval); LLM-Modulo (actor/judge/editor, 35.5%→70.8% on PlanBench); Knowledge-Model Prompting (Goh, Kos, Goel, 2026, arXiv:2602.03900 — structured task decomposition lifted a reasoning model from **31.5% → 97.3%** on opaque Blocksworld by steering it into "formal, code-execution pathways") | "This goal is a 2-layer compound shape; the base is a stacked pair, the top layer is a painted circle. Choose: build a cutter to make the half-split, a stacker to combine, a painter to color." |
| **Inner loop** (emit coordinates, choose belt routes, place entities) | **Deterministic code** | SayPlan (classical path planner reduces LLM horizon); Code-as-Policies (code calls primitives that compute geometry); ProgPrompt (program constraints); shapez's own `ShapeDefinition` algebra | `place_path` from A→B with computed rotation; miner rotation from path direction; blueprint paste. |
| **Verification loop** (is it right?) | **Deterministic code** (shape algebra + simulator) | LLM-Modulo (sound verifiers, "can never output any fallacious output"); NL2AGBench (execution-based verification >> textual similarity); AlphaGeometry (symbolic engine, §4.4) | Compile the goal shape algebraically; compare against what the program produces; run `await` and read `delivered`. |
| **Repair loop** (fix it) | **LLM** | LLM-Modulo travel planning (4.6× GPT-4-Turbo improvement; LLM as "extractor of useful critics and reformulator"); Towards Reliable Code-as-Policies (+46.2%) | Feed the checker error (not the raw sim state) back: "your stacker line stacks the wrong operand; the goal's bottom layer is `CbCbCbRb` and your second operand yields `CuCuCuCu`." |

**The single most important design consequence:** the LLM should never see a coordinate and should never emit one. It should emit a **program over a shapez-shaped DSL** (§7). The coordinate arithmetic is the part LLMs are worst at (§6.1–§6.2) and the part that is easiest to make deterministic.

---

## 2. Simulator-in-the-loop: does generate–simulate–revise beat one-shot?

### 2.1 The "learn a world model" family is the wrong tool here

Dreamer-style model-based RL (DreamerV3; MuZero baselines in AlphaStar Unplugged) learns a latent dynamics model and plans in imagination. [MEDIUM]

- The mechanism's justification is **sample efficiency under expensive or unbounded environment interaction**. CBET (Ferrao, Cunha, 2025), arXiv:2503.21047, shows the failure mode directly: "pre-training DreamerV3 with intrinsic rewards does not immediately lead to a policy that maximizes extrinsic rewards in Minigrid," and "the behaviours promoted by CBET in DreamerV3 may not align with the task objectives of the environment, leading to reduced returns and suboptimal policies." [STRONG as reported]
- **Our situation is the exact opposite.** We have a *ground-truth* simulator that is faster, exacter, and cheaper than any learned model. A learned model can only lose information relative to the real simulator. The Dreamer recipe is for environments where you *cannot* simulate; we can.
- **Therefore: [SPECULATIVE→STRONG by reasoning] Do not build a learned world model. Use the real one.** This is a case where the literature's headline method is actively wrong for the problem, and knowing that is worth more than the citations.

### 2.2 The evidence that propose→simulate→critique→revise beats one-shot

| System | Loop | Reported gain | Strength |
|---|---|---|---|
| **LLM-Modulo** (arXiv:2402.01817, 2411.14484, 2405.20625) | LLM proposes → sound verifier rejects → LLM repairs | "the system can never output any fallacious output"; 4.6× on TravelPlanning (GPT-4-Turbo); CoT/ReAct/Reflexion at 0% / 0.6% / 0% | [STRONG] The clearest "verifier-in-the-loop beats one-shot" result in the planning literature. |
| **Towards Reliable Code-as-Policies** (arXiv:2510.21302) | Generate code → symbolic verification → interactive validation → repair | **+46.2%** success over Code-as-Policies; >86.8% executability | [STRONG] Same shape as ours, with a large effect size. |
| **SayPlan** (arXiv:2307.06135) | Plan → classical planner → simulator feedback → replan | "correcting infeasible actions and avoiding planning failures" on 3-floor/36-room envs | [STRONG for mechanism] |
| **RAP** (Hao, Gu, Ma, Hong, Wang, Wang, Hu, 2023), EMNLP 2023, arXiv:2305.14992 | LLM-as-world-model + MCTS over reasoning states with task-specific rewards | "RAP on LLAMA-33B surpasses CoT on GPT-4 with **33% relative improvement** in a plan generation setting" | [MEDIUM] The search-over-plans pattern. See §9.3 for why we may want a bounded version of it. |
| **T2BM / 3D Building Generation in Minecraft via LLMs** (Hu, Huang, Hu, Liu, 2024), IEEE CoG, arXiv:2406.08751 | "refining prompts, decoding interlayer representation and **repairing**" | "LLMs hold significant potential for 3D building generation… can generate correct buildings with complete structures and incorporate specific building blocks such as windows and beds" | [MEDIUM] Closest published analogue to shapez: **LLM generating a spatial construction**, with an explicit repair stage. |
| **Harness evolution** (Wang, Zhu, Hu, Wang, Hajishirzi, Smith, Dasigi, Xiao, 2026), arXiv:2607.12227 | Repeatedly evaluate and revise a candidate harness using task feedback | "automatic harness evolution fails to outperform simple test-time scaling methods both with and without test cases, and exhibits limited generalization… **However**, we find that long-horizon games are a promising setting… task-specific harness evolution improves over the search baseline by **80% on ARC-AGI-3** and by **11% on EdgeBench games** under matched budgets." | [STRONG] The most directly relevant recent result: **harness/agent-code evolution works in long-horizon games, and does not work on ordinary benchmarks.** shapez is a long-horizon game. |
| **Mastering Rate based Curriculum Learning** (Willems, Lahlou, Bengio, 2020), arXiv:2008.06456 | Replace "learning progress" with "mastering rate" | "significantly outperforms learning progress-based algorithms" | [STRONG] Relevant to §7. |

**Direct answer to the brief's question:** *Is there evidence that a generate–simulate–revise loop beats a one-shot LLM layout proposal?* **Yes, and the effect sizes are large and replicated across independent groups**: +46.2% (Code-as-Policies + neuro-symbolic verification, NeurIPS 2025 Spotlight), 4.6× on TravelPlanning and "can never output any fallacious output" (LLM-Modulo, ICML 2024 + follow-ups), 35.5%→70.8% on PlanBench with Actor/Judge/Editor roles (arXiv:2608.21897). The mechanism is not "the LLM gets better at planning" — it is **"the wrong proposal is detected before it costs anything."** [STRONG synthesis]

### 2.3 What objective functions to use inside the loop

The loop needs a scalar or structured score. The literature gives the vocabulary:

- **Outcome reward from the environment** — the natural choice here. `delivered / required` is already computed by the game and exposed via `obs.goal.requirement`. [STRONG, from `docs/PROTOCOL.md`]
- **Throughput for `throughput_only` goals** — for these, `delivered` over a fixed tick budget is the objective. Our `await`/`step` makes this measurable at zero cost.
- **Cost terms** — action count and observation count are *ours* to charge, and the brief explicitly wants both minimized. This makes shapez unusually well-suited to a **Pareto** objective rather than a scalar one (cf. InteractionCS-RL's "Pareto boundary between user reward and global cost constraints", arXiv:2602.22667 → arXiv:2602.22697; and arXiv:2610.24194 SURE-Act which ranks alternative actions by "task completion, interaction cost, and irreversible errors"). [MEDIUM]
- **Learned reward from an LLM** — MaestroMotif (Klissarov, Henaff, Raileanu, Sodhani, Vincent, Zhang, Bacon, D'Oro, Machado, 2024), arXiv:2412.08542, has LLMs "automatically design rewards corresponding to each skill, starting from their natural language description," and evaluates in NLE. ONI (Zheng, Henaff, Zhang, Grover, Amos, 2024), arXiv:2410.23022, distills LLM annotations into an intrinsic reward model and reaches SOTA on NLE tasks. [MEDIUM]
  - **Transfer: low, and negative.** See §4 — LLM-generated reward is a proxy, and shapez's reward is *exactly computable*. Introducing an LLM reward function here trades a known-correct signal for an unknown-error one. **Do not.**
- **Checklist / binary criteria instead of scalar** — CM2 (Zhang et al., 2026), arXiv:2602.12268, replaces "verifiable outcome rewards" with fine-grained binary criteria to turn "open-ended judging into more stable classification-style decisions." [MEDIUM]
  - **Transfer: good.** For shapez, the natural checklist is: (a) does the program compile to a legal layout? (b) does the produced shape hash equal the goal hash? (c) did any required shape get delivered? (d) did it fit in the action budget? Each is a separate boolean with a distinct diagnostic — exactly what an LLM needs to repair against. §5.3 makes this the recommended objective shape.

### 2.4 The loop, concretely, for shapez

```
observe (once)  →  goal {shape, required, delivered, throughput_only}, hub pos, resources, stats
        ↓
LLM emits a LAYOUT PROGRAM in the shapez DSL (§7), not coordinates
        ↓
deterministic compiler: program → sequence of protocol Actions (place/place_path/delete/paste_blueprint)
        ↓
SIMULATOR: paste + step/await → read {delivered, required, shape hashes produced, ticks_run, applied/failed}
        ↓
DETERMINISTIC CHECKER: (goal hash == produced hash?) ∧ (delivered ≥ required) ∧ (actions ≤ budget)
        ↓
   PASS → done (report)      FAIL → structured critique → LLM repairs program → loop (bounded k times)
```

Every step above is either free, deterministic, or a single LLM call. The LLM is called **once per attempt**, not once per action.

---

## 3. Verification and criticism: why deterministic beats LLM self-judging

### 3.1 Self-critique without external feedback does not work — this is the load-bearing result

- **Self-Refine** (Madaan, Tandon, Gupta, Hallinan, Gao, Wiegreffe, Yang, Prabhumoye, Xiong, Majumder, Hermann, Welleck, Yazdanbakhsh, Clark, 2023), arXiv:2303.17651 — same LLM generates, critiques, and refines; "improving by ~20% absolute on average in task performance" across 7 tasks. [STRONG]
- **"Large Language Models Cannot Self-Correct Reasoning Yet"** (Huang, Chen, Mishra, Zheng, Yu, Song, Zhou, 2023), ICLR 2024, arXiv:2310.01798 — "LLMs struggle to self-correct their responses without external feedback, and **at times, their performance even degrades after self-correction**." [STRONG]
- **Reconciled reading:** Self-Refine's ~20% gains come from tasks where the output has an *intrinsically checkable* property (short text, code that can be run, a reply with a determinable quality) and the self-critique is a *re-prompting* mechanism, not a reasoning mechanism. Where there is no external signal, self-critique is at best neutral and often negative (Huang et al.).
- **Transfer to shapez: decisive.** "Does my layout produce the target shape?" has a **zero-cost exact answer** via `ShapeDefinition.getHash()` on the goal key and on the observed produced-shape key. "Does my layout look right?" has only an LLM answer. So:
  - Use the **algebraic checker** for the shape question. Always.
  - The LLM self-critique slot should be spent on questions the algebra cannot answer — e.g. "which of these two equally-valid topologies has fewer bottleneck stages for `throughput_only`?" — and even then, prefer measuring than asking.

### 3.2 LLM-as-judge: measured failure modes

- Zheng, Chiang, Sheng, Zhuang, Wu, Zhu, Li, Li, Chuang, Zhang, Gonzalez, Stroma, Stenger (2023), **MT-Bench / "Judging LLM-as-a-Judge"**, NeurIPS 2023 D&B, arXiv:2306.05685 — documents **position bias, verbosity bias, self-enhancement bias**, and limited reasoning ability. GPT-4 judges match human preferences >80% of the time "the same level of agreement between humans" — but the *documented biases* are systematic, not noise. [STRONG]
- Li (2026), **"Frozen Judges, Moving Agents: Version-Dependent LLM-Judge Error and the Limits of Judge-Assisted Agent Evaluation"**, arXiv:2609.34198 — the most directly on-point result for our use case:
  - "All three coding-agent judges and all four tau-bench judges **reject task-conditioned error invariance** after multiplicity adjustment."
  - "In tau-bench, one judge **reverses a nine-point reference-reward gap** by penalizing a procedural habit the reward ignores."
  - "**False acceptance of failed coding patches rises with agent capability**" (mean Spearman +0.944 across 8,743 aligned cells) — i.e. **the better your agent gets, the more a judge will rubber-stamp its failures.** That is a catastrophic property for a self-improving loop.
  - "Transporting old-version calibration raises SWE-bench comparison error from 3.8 to 19.5 points."
  - Conclusion the authors favor: "**paired audits of current outputs over judge-only release decisions**." [STRONG]
- **Transfer to shapez: high and slightly scary.** Our reference implementation *is* an improving agent. If we use an LLM judge to score layout proposals, the judge will get more permissive exactly as our agent improves. The fix is the same as theirs: **execution-based scoring, with LLM judging only as a secondary, non-gating signal.**

### 3.3 Execution-based verification as the standard

- **NL2AGBench** (Xiao, Song, Hu, Zong, 2026), arXiv:2608.28481 — "uses **execution-based verification within AlphaGeometry** to assess translation quality rather than relying solely on textual similarity." Leading closed-source models reach "executable translation rates above 80%, while even the largest open-source models struggle to consistently preserve geometric constraints." It also provides "an error taxonomy distinguishing syntax and logic errors." [STRONG]
  - **Transfer:** our checker should be *execution-based* (compile + simulate), and it should **classify errors** (syntax vs. logic) rather than returning a boolean. §3.4 and §5.3 build on this.
- **ToolSandbox** (Lu, Holleis, Zhang, Aumayer, Nan, Bai, Ma, Ma, Li, Yin, Wang, Pang, 2024), arXiv:2408.04682 — identifies **State Dependency**, **Canonicalization**, and **Insufficient Information** as the hard task classes for LLM tool use, "challenging even the most capable SOTA LLMs." [STRONG]
  - **Transfer:** "**Canonicalization**" is exactly our shape-hash problem: the agent must map its *internal* representation of a shape onto the game's canonical `getHash()` key. Agents that don't canonicalize produce wrong-but-plausible shapes. Our protocol's `goal.requirement.shape` is already the canonical key, so we should make the agent's output canonical too and compare hashes, never strings-by-eye.
  - "State Dependency" ≈ "the belt I lay depends on what is already on the map" → this is why `place` returns `2002` with a hint, and why the agent must re-observe after a rejection.

### 3.4 AlphaGeometry: the neuro-symbolic construction pattern

- Sinha, Prabhu, Kumaraguru, Bhat, Bethge (2024), **"Wu's Method can Boost Symbolic AI to Rival Silver Medalists and AlphaGeometry to Outperform Gold Medalists at IMO Geometry"**, arXiv:2404.06405 — "Combining Wu's method with the classic synthetic methods of deductive databases and angle, ratio, and distance chasing solves **21 out of 30**… with just a CPU-only laptop… Combining Wu's method with AlphaGeometry we set a new state-of-the-end… solving **27 out of 30** problems." [STRONG]
  - **Read this carefully for §9: a 2024 symbolic method on a laptop nearly matches a 2024 neuro-symbolic deep model.** The message is not "symbolic beats neural" but "**the symbolic baseline was catastrophically under-reported**." Any claim that an LLM is needed must first beat the symbolic baseline.
- Trinh et al. (2024) / Chervonyi, Trinh, Olšák, Yang, Nguyen, Menegali, Jung, Kim, Verma, Luong, Le (2025), **AlphaGeometry2**, arXiv:2502.03544 — coverage of IMO geometry by the DSL rose 66%→88%; solving rate over 25 years of IMO geometry rose **54% → 84%**; part of the system that achieved IMO 2024 silver-medal standard. [STRONG]
  - **Transfer:** AlphaGeometry's structure is *exactly* our problem shape: **a DSL over a small algebraic domain + a symbolic engine that checks derivations + a search loop over the DSL.** shapez's DSL is smaller and more symmetric than geometry's. The lesson from AlphaGeometry's own history: **DSL coverage is the binding constraint.** If our DSL cannot express a required shape, the LLM will fail for a *representational* reason, not a reasoning reason. §7.4 makes "DSL coverage" a first-class metric.
- Sicca, Xia, Friedrich, Gorinski, Frieder, Shuling, Jui, Reppel (2024), **Newclid**, arXiv:2411.11938 — a refactored symbolic solver "with a **command line interface (CLI) for agents to guide DDARN**"; "DDARN is flexible with respect to its internal reasoning, **which can be steered by agents**"; re-evaluation of the 5 unsolved AG-30 problems finds DDARN solves an additional one in "breadth-first-search **agentic mode**." [MEDIUM]
  - **Transfer:** the architecture where a symbolic solver exposes an agent-steerable interface is what our shape-algebra checker should look like: not just "hash equals or not" but "here is the derivation that failed, at step k, expected X got Y."

### 3.5 Deterministic checkers for shapez — the design

Three tiers, all deterministic, all cheap:

**Tier 1 — Shape algebra (exact, no simulation).**
- Goal key → `ShapeDefinition.fromShortKey(goalShape)`; program → the shape it produces (computed by applying the DSL's ops to a base shape) → `getHash()`; compare strings.
- If they differ, report the **first differing layer/quadrant**. The shape is 4 quadrants × ≤4 layers — a tiny, human-readable diff. This is where most LLM errors will surface, and the diff is the critique the LLM needs.
- Additional deterministic predicates available free from the game's own algebra:
  - `isValidShortKey(key)` — is the produced key even legal?
  - `cloneFilteredByQuadrants` invertibility: a "cut" is legal only if the resulting quadrants are non-empty in a way the game allows.
  - `cloneAndStackWith`'s own assertion (`"Shape merge: Sub shape got lost"`) is the game's own statement of when a stack is illegal — **we can reuse the game's semantics instead of inventing them.**

**Tier 2 — Static layout legality (exact, no simulation).**
- No two buildings on the same tile; hub tiles not overwritten; miner on a resource tile; belt paths axis-aligned (the protocol already enforces this and returns `2001` for non-axis-aligned `place_path`).
- Count buildings per type; check the shapez tier-unlock constraints.

**Tier 3 — Simulator verdict (exact, one round trip).**
- `paste_blueprint` or the action batch, then `await {until:"hub_delivered_increased", timeout_ticks}` → `{met, ticks_run}`.
- Read `obs.goal.requirement.{delivered, required, progress, throughput_only}`.
- Read `obs.hub.stored_shapes` to confirm the *right* shape was delivered (a factory can deliver the wrong shape and still increment a counter — this is exactly ToolSandbox's "Canonicalization" hazard).

**Why this beats an LLM judge, concretely:** a judge gives one noisy bit per evaluation and needs a reference distribution of "good" layouts to calibrate; the checker gives a *structured, causal* failure ("layer 2 quadrant tl is `R` but the goal says `C`") with no calibration and no drift. Per arXiv:2609.34198, judge reliability *degrades as agent capability rises* — the exact regime we are in.

---

## 4. Reward and objective design for a shapez attempt

### 4.1 Candidate objective terms

Given the protocol, a shapez attempt is scored by terms that are all directly observable:

| Term | Observable | Direction | Notes |
|---|---|---|---|
| **Delivery ratio** | `delivered / required` from `obs.goal.requirement` | ↑ | Primary. Already computed by the game. |
| **Goal reached** | `level_increased` / `met:true` | ↑ | Binary; use as a gate, not a gradient. |
| **Ticks to goal** | `await.ticks_run`, or `obs.tick` delta | ↓ | Real cost; the game charges you time. |
| **Throughput** | delivered per tick over a fixed budget | ↑ | Only meaningful when `throughput_only: true`. |
| **Action count** | count of protocol actions issued | ↓ | The brief's "few actions". |
| **Observation count / bytes** | count of `obs` calls, `truncated` flags, payload size | ↓ | The brief's "few observations". |
| **Material waste** | total items produced vs. items delivered; `hub.stored_shapes` residue | ↓ | Needs care: leftovers are also *inventory*, which is not waste in shapez. |
| **Rejected actions** | count of `2001` / `2002` failures | ↓ | Direct measure of flailing. |
| **Blueprint cost** | `obs.hub.blueprint_cost` | ↓ | The game's own cost metric for copy-paste solutions; `findNiceIntegerValue(4 * n^1.1)` per PROTOCOL §6. |

### 4.2 Proxy-metric failure: the literature's hard warnings

- **Goodhart's law, operationalized:** Gao, Schulman, Hilton (2022), **"Scaling Laws for Reward Model Overoptimization"**, arXiv:2210.10760 — "Because the reward model is an imperfect proxy, optimizing its value too much can hinder ground truth performance, in accordance with Goodhart's law… We find that this relationship follows a **different functional form** depending on the method of optimization [RL vs. best-of-n], and in both cases its coefficients **scale smoothly with the number of reward model parameters**." [STRONG]
  - **Transfer:** if we optimize the LLM against `delivered` alone, we will get a layout that maximizes deliveries and ignores everything else. The measured failure is not a slow drift; it is a *predictable functional relationship* between proxy optimization intensity and true performance loss. This is the single strongest reason to use a **lexicographic** objective (feasibility first, then goal, then efficiency) rather than a weighted sum: a weighted sum lets a large improvement in the proxy buy a violation of the hard constraint.
- **Emergent proxy behavior in game agents:** Yu, Velu, Vinitsky, Gao, Wang, Bayen, Wu (2021/2022), **"The Surprising Effectiveness of PPO in Cooperative, Multi-Agent Games"**, NeurIPS 2022 D&B, arXiv:2103.01955 — this paper is famous for two reasons, and the second matters more than the first here: (a) simple PPO is a *very strong* baseline across particle-world, SMAC, Google Research Football and Hanabi; (b) the authors report **"suspiciously optimal" emergent behaviors** that the reward did not intend (agents adopting degenerate tactics that exploit the reward's structure rather than the task's). [STRONG]
  - **Transfer:** a shapez agent optimizing "delivered count" will discover that *flooding the hub with any shape* or *mass-producing one component* may score well without producing the goal shape. The mitigation is to make the reward **structurally incapable** of being gamed: score *the goal shape specifically*, verified by hash, not *total throughput*.
- **Naively designed dense rewards actively hurt:** Modecrua, Kaewtawee, Pachtrachai, Touchapon Kraisingkorn (2026), arXiv:2604.02869 — "we discover that **naively designed dense per-turn rewards degrade performance by up to 14 percentage points** due to misalignment between reward discriminativeness and advantage direction." They introduce Iterative Reward Calibration. [MEDIUM]
  - **Transfer:** the direct lesson is that *adding* a dense shaping term (e.g. "reward partial progress toward the shape") is dangerous. Prefer sparse, exact, few-term objectives and calibrate them against actual data.
- **Intrinsic motivation drifting off-task:** CBET, arXiv:2503.21047 — "the behaviours promoted by CBET in DreamerV3 **may not align with the task objectives** of the environment, leading to reduced returns and suboptimal policies" (verified in Crafter and Minigrid). [MEDIUM]
  - **Transfer:** do not reward "exploration" or "number of distinct shapes attempted" as a shaping term; it optimizes away from the goal.
- **Judge drift, revisited:** arXiv:2609.34198 (above). [STRONG]
- **Checklist over scalar:** CM2, arXiv:2602.12268 — fine-grained binary criteria with explicit evidence grounding turn "open-ended judging into more stable classification-style decisions"; +8 pts on tau-bench, +12 on ToolSandbox over SFT. [MEDIUM]

### 4.3 Recommended objective for this project

**Lexicographic, not weighted.** This is the key recommendation, and it follows directly from Gao et al. (arXiv:2210.10760): a weighted sum permits the proxy to purchase constraint violations.

```
Feasibility    (hard gate, binary)
  ├─ program compiles to legal actions
  ├─ layout is statically legal (no overlaps, miner on resource)
  └─ produced shape hash == goal shape hash

Goal           (hard gate, binary)
  └─ delivered ≥ required   (or throughput ≥ target when throughput_only)

Efficiency     (reported, minimized; only compared among Feasibility+Goal passers)
  ├─ actions used
  ├─ observations used
  ├─ ticks elapsed
  └─ rejected actions (2001/2002)

Waste          (reported only, never optimized)
  └─ leftover hub inventory, blueprint cost
```

Rationale, tied to sources:
1. Feasibility-first prevents Goodhart damage (Gao et al. 2022; PPO emergent proxies 2021).
2. Binary criteria with explicit evidence are more stable than scalar shaping (CM2 2026; Modecrua et al. 2026's 14pp degradation).
3. Efficiency terms are compared only among passers, so they cannot be traded against correctness — this is the "hard constraints separated through a lexicographic objective" pattern that CM-DPO (Karanjai, Guo, Madhavarao, Sun, Xiao, Xie, Kumar, George, Williamson, Pang, Mekhail, Ashraf, Shehata, Huang, 2026), arXiv:2610.09219, implements for PDDL: "Hard and soft constraints are separated through a lexicographic objective, ensuring **hard constraints are never traded off against preferences**." [MEDIUM]
4. Waste is *reported*, not optimized, because shapez's notion of leftover material is genuinely ambiguous (leftovers are inventory) — optimizing an ambiguous term is exactly how a proxy gets gamed. [SPECULATIVE but well-grounded]

### 4.4 A concrete reward-hacking trap specific to shapez

`delivered` counts deliveries *of the goal shape*. But a factory can also deliver **wrong** shapes to the hub (stored in `hub.stored_shapes`). Two failure modes:

- **Under-delivery of the goal shape, over-delivery of junk** — if the reward is "hub deliveries," junk counts. Fix: always read `hub.stored_shapes[goalShape]` and use *that* as the numerator, not a global delivery counter.
- **Over-delivery of the goal shape via brute force** — the factory produces the goal shape but at 1/1000 the throughput. If the metric is only "reached required count," a slow factory passes. Fix: measure ticks-to-goal and report it; for `throughput_only` goals, measure delivered-per-tick.

Both are the shapez instance of "the proxy reward model and the gold-standard reward model diverge" (Gao et al. 2022), and both are caught by using the game's own `hub.stored_shapes` breakdown, which is free.

---

## 5. Failure modes of LLM agents in spatial/construction tasks

### 5.1 Spatial reasoning is the headline deficit

- **Factorio Learning Environment** (Hopkins, Bakler, Khan, 2025), arXiv:2503.09617 — "We demonstrate across both settings that **models still lack strong spatial reasoning**. In lab-play, we find that LLMs exhibit promising short-horizon skills, yet are **unable to operate effectively in constrained environments, reflecting limitations in error analysis**. In open-play, while LLMs discover automation strategies that improve growth (e.g. electric-powered drilling), they **fail to achieve complex automation** (e.g. electronic-circuit manufacturing)." [STRONG]
  - **This is the single closest published analogue to our problem and it is sobering.** Factorio is a factory automation game; the LLM agents (Claude/GPT-class, 2025) do fine on short-horizon resource gathering and fail at multi-stage factory construction for the same reasons we should expect: spatial layout + error analysis.
  - Note the FLE paper's own framing: it "tests agents in long-term planning, **program synthesis**, and resource optimization."
- **BALROG**, arXiv:2411.13543 — LLM/VLM agents "struggle significantly with more challenging tasks"; **vision made them worse**. [STRONG]
- **T2BM (Minecraft)**, arXiv:2406.08751 — the paper's framing (prompt refinement + interlayer representation decoding + **repair**) is the acknowledgement that raw LLM spatial generation needs a scaffold. [MEDIUM]
- **3D-GPT**, arXiv:2310.12945 — decomposes 3D modeling into a **task dispatch agent**, a **conceptualization agent**, and a **modeling agent**, with "procedural generation, extracting parameter values from enriched text." [STRONG for mechanism] **Transfer: the multi-agent decomposition is overkill for us; the *decomposition of scene description → parameter extraction → procedural call* is exactly right.**

### 5.2 Coordinate arithmetic and rotation confusion — the specific shapez traps

shapez has a **rotation convention that is easy to get wrong and expensive to get wrong**:

- Building `r` is 0/90/180/270. From `src/agent/play.mjs`'s verified notes: **miner rotation = spray direction** (0=up, 90=right, 180=down, 270=left); **belt rotation = flow direction**. The reference agent encodes these as `minerRot` derived from the first path segment direction, and it *re-places the miner with a new rotation* if the first segment fails.
- The **shape** algebra has its own rotation convention: quadrant order `[tr, br, bl, tl]` with `cloneRotateCW()` implemented as `quadrants.unshift(quadrants[3]); quadrants.pop()`. Note this is **not** the intuitive "shift left" — a CW rotation moves tl→tr. An LLM that reasons about rotations from prose will get this wrong, and it will get it wrong *silently* (the produced shape is still a legal shape, just rotated).
- **Mitigations with evidence:**
  - **Never let the LLM compute a rotation.** Compute it in code from the path geometry, exactly as `runB1` already does. The DSL should express "belt from A to B" and let the compiler derive `r`. [SPECULATIVE, but strongly supported by the coordinate-arithmetic literature and by the fact that the reference agent's miner-rotation logic is already a hand-written function.]
  - **Express rotations as DSL ops on shapes** (`rotate_cw`, `rotate_ccw`), and let the game's own `ShapeDefinition` implement them. Then a rotation mistake becomes a *different program*, not a corrupted one — and the checker catches it.
  - **T2BM's "interlayer representation decoding"** (arXiv:2406.08751) is the general principle: use an intermediate representation that is *permuted* rather than *predicted*. [MEDIUM]
  - **CAD-Recode** (Rukhovich, Dupont, Mallis, Cherenkova, Kacem, Aouada, 2024), arXiv:2412.14042 — represents CAD sketch-extrude sequences **as Python code** and uses "the exposure of pre-trained LLMs to Python code" to let "a relatively small LLM" act as the decoder; the output "is interpretable by off-the-shelf LLMs, enabling CAD editing and CAD-specific question answering." [STRONG] **Transfer: have the LLM emit code over a DSL, never a coordinate list.** This is also why `Code as Policies` and `ProgPrompt` work: the LLM's competence is *code*, and code is composable and checkable.
  - **ShapeAssembly** (Jones, Barton, Xu, Wang, Jiang, Guerrero, Mitra, Ritchie, 2020), SIGGRAPH Asia 2020, arXiv:2009.08026 — "a domain-specific 'assembly-language' for 3D shape structures… Its functions are parameterized with free variables, so that **one program structure is able to capture a family of related shapes**." Their generated programs are "more plausible and **physically-valid**" than prior deep models. [STRONG] **Transfer: a shapez DSL with parameterized ops (cut by quadrant set, stack by pair, paint by color) is the direct analogue of ShapeAssembly's assembly language, and it gives us *one program per shape family* instead of one per shape.**

### 5.3 Hallucinated building ids, invalid ops, and the error-recovery gap

- **AgentBench** (Liu, Yu, Zhang, Xu, Lei, Lai, Gu, Ding, Men, Yang, Zhang, Deng, Zeng, Zheng, Du, Zhang, Shen, Zhang, Zhang, Su, Huang, Dong, Tang, ICLR 2024), arXiv:2308.03688 — "we identify the typical reasons of failures in environments and LLMs, showing that **poor long-term reasoning, decision-making, and instruction following abilities are the main obstacles** for developing usable LLM agents." [STRONG]
- **PlanBench-XL** (Liu, Qian, Cai, Wan, Acikgoz, Yang, Liu, Zhang, Wang, Chen, Zhao, Hakkani-Tür, Li, Wang, 2026), arXiv:2606.22388 — 1,665 tools, 327 tasks; "agents are especially vulnerable when **failures lack explicit error signals** or when recovery requires **longer alternative tool-use paths**." GPT-5.4: 51.90% block-free → **11.36%** under severe blocking. [STRONG]
  - **Transfer, and it is the most actionable finding in this section.** Our protocol is *unusually good* on the first half: errors carry a code **and** a `hint` (`2001`/`2002` include `hint` per PROTOCOL §7). That is an explicit error signal. **But** PlanBench-XL says agents fail when *recovery* requires long alternative paths. The recovery path in shapez — "that layout is wrong, try a different belt topology" — *is* a long alternative path. This is the strongest argument for putting the recovery in **deterministic code** (a fixed set of retry topologies) and keeping the LLM out of the inner retry loop.
- **ToolSandbox**, arXiv:2408.04682 — Canonicalization / State Dependency / Insufficient Information are the hard classes. [STRONG]
- **CM2**, arXiv:2602.12268 — fine-grained binary criteria with explicit evidence grounding. [MEDIUM]
- **Mitigation stack, ranked:**
  1. **Typed, closed action space.** The protocol already rejects unknown ops/fields with `2001` and unknown buildings with `2001`. Never widen it. (GITM's structured-actions gain, arXiv:2305.17144.)
  2. **Compile, don't execute, LLM output.** The LLM emits a program; a compiler emits actions. Invalid actions become compile errors, not game errors. (Code-as-Policies, arXiv:2209.07753; Towards Reliable Code-as-Policies, arXiv:2510.21302.)
  3. **Use the game's error `hint` as the critique channel.** PROTOCOL §7 already mandates `hint` for `2001`/`2002` — "修复建议，给 AI 读". This is a purpose-built structured critique channel. Use it verbatim.
  4. **Re-observe on rejection, in code.** `runB1` already does this (`regionAround(action)` + list occupants on `2002`). Make it systematic: after any `2002`, re-observe the affected region and feed the occupants into the repair prompt. This is "grounding via re-observation" and it is the mechanism that OntoAct (Lee, Kang, Ahn, Yoon, 2026), arXiv:2610.21983, calls out: "Verification identifies **missing evidence**, and **new observations and intervention outcomes** update hypothesis assessments and guide subsequent actions." [MEDIUM]
  5. **Bound the loop.** Cap repair attempts (e.g. 4). Every paper that reports loops says an unbounded loop is a cost sink, not a quality sink.

### 5.4 Long-horizon drift and context blowup

- Liu, Lin, Hewitt, Paranjape, Bevilacqua, Petroni, Liang (2023), **"Lost in the Middle"**, TACL 2023, arXiv:2307.03172 — "performance can degrade significantly when changing the position of relevant information… performance is often highest when relevant information occurs at the **beginning or end** of the input context, and **significantly degrades when models must access relevant information in the middle** of long contexts." [STRONG]
  - **Transfer, and it is a hard constraint on the design.** Our `obs` can return up to 20,000 entities. If we hand the LLM a full entity dump, the goal requirement and the hub position can end up in the middle of the context and be ignored. **Design consequence: the observation the LLM sees must be *small and structured*, with the goal first and the actionable facts last.** This is the "few observations" objective made concrete.
- BALROG (arXiv:2411.13543) and AgentBench (arXiv:2308.03688) both report long-horizon degradation.
- **MITIGATION: summary-observation pipeline.** Before the LLM ever sees an observation, deterministic code computes:
  - goal requirement (shape key, required, delivered, progress, throughput_only) — **first**
  - hub position and its 4×4 footprint
  - the *k* nearest resource tiles (k ≈ 3–5), not the whole resource map
  - `stats.by_type` counts (not per-entity lists)
  - a *local* entity list for the region the agent is about to build in (bounded, e.g. ≤ 40 entities)
  - and put the "what to do next" slot **last** (Lost in the Middle).
  This is SayPlan's "collapsed representation" (arXiv:2307.06135) applied to our protocol, and it directly serves the brief's "few observations."

### 5.5 No error recovery

- PlanBench-XL (arXiv:2606.22388): failures without explicit error signals and long recovery paths are the dominant failure mode. [STRONG]
- The design implication is asymmetric and worth stating plainly: **the agent should never be the thing that decides how to recover.** Recovery is a deterministic policy over a *small, enumerated* set of topologies (like `runB1`'s 4 path variants). The LLM decides *what to build*, and only re-enters when the deterministic layer says the whole strategy failed.

---

## 6. Program synthesis and DSL approaches for factory layouts

### 6.1 The core claim: shapez has an unusually good DSL, already implemented in the game

From `shape_definition.js` + `shape_definition_manager.js` (both read in full; [STRONG]):

| DSL op | Underlying game op | Inverse available? |
|---|---|---|
| `cut(quadrants)` | `cloneFilteredByQuadrants` / `shapeActionCutHalf` / `shapeActionCutQuad` | Partially — a cut is invertible only if the two halves are disjoint, which the game's own quadrant semantics guarantee |
| `rotate_cw/ccw/180` | `cloneRotateCW/CCW/180` | **Yes** — rotations are permutations of a 4-ring |
| `stack(a, b)` | `cloneAndStackWith` / `shapeActionStack` | **No** — stacking is lossy (merge + layer alignment + 4-layer cap) |
| `paint(c)` / `paint4(cs)` | `cloneAndPaintWith` / `cloneAndPaintWith4Colors` | **No** — painting discards original colors |
| `base()` | `getDefinitionFromSimpleShapes([rect,rect,rect,rect], uncolored)` | — |
| `key()` | `getHash()` | — the canonical form for comparison |

**`stack` and `paint` are lossy; `cut` and `rotate` are (partly) invertible.** That asymmetry is the entire design of a shapez compiler: a shape must be *decomposed* into a DAG of base → (cut|rotate)* → paint → stack, where the lossy ops sit at the *end* of each branch. The compiler's job is a **backward search over a ≤4-layer, 4-quadrant space**, which is small enough to search exactly.

This is the "compile a target shape into a construction sequence" prior art the brief asked about — and it exists, in the game's own source, as an *algebra* rather than as a *compiler*. The compiler is the thing to build.

### 6.2 Published prior art on compiling constructions (analogous domains)

| Work | Mechanism | Transfer |
|---|---|---|
| **EvoCraft** (Grbic, Palm, Najarro, Glanois, Risi, 2020), arXiv:2012.04751 | "an API that provides an open-source Python interface for communicating with Minecraft to **place and track blocks**… the grand challenge we pose here is to **automatically search for increasingly complex artifacts**." Result: "evolution **succeeds when tasked to grow a structure towards a specific target**, it is **unable to find a solution when rewarded for creating a simple machine that moves**." | ★★★★☆. Two lessons: (a) **target-matching construction is tractable** for search; (b) **functional/throughput objectives are not** — exactly the shapez split between compound-shape levels (tractable) and throughput optimization (hard). Also: a clean precedent for an **API-level construction interface**, which our protocol already is. |
| **Evolving Flying Machines in Minecraft Using Quality Diversity** (Medina, Richey, Mueller, Schrum, 2023), GECCO 2023, arXiv:2302.00782 | MAP-Elites with a behavior characterization over structures | ★★★☆☆. Relevant for *throughput* diversity: QD over "layout archetype" rather than scalar score is a plausible way to explore factory topologies without a proxy collapse (§4.2's PPO warning). |
| **Organic Building Generation in Minecraft** (Green, Salge, Togelius, 2019), FDG PCG Workshop, arXiv:1906.05094 | Constrained growth + cellular automata to fill a 3D space with a floor plan | ★★☆☆☆. Constraint-based generation, not search. |
| **CAD-Recode**, arXiv:2412.14042 | CAD sequences **as Python code**; small LLM decoder; interpretable output | ★★★★★ (mechanism). Program-over-geometry representation; LLM emits code, not coordinates. |
| **ShapeAssembly**, arXiv:2009.08026 | A domain-specific **assembly language** with parameterized functions; one program covers a family of shapes; generated programs more physically valid than deep-model outputs | ★★★★★. The closest published analogue to a shapez DSL, and it validates the "one program per family" idea. |
| **3D-GPT**, arXiv:2310.12945 | Task dispatch / conceptualization / modeling agents; parameter extraction → procedural call | ★★★★☆. The "conceptualize then parameterize then call" pipeline maps to "name the recipe, then bind parameters, then emit ops." |
| **Text2CAD** (Khan, Sinha, Sheikh, Ali, Afzal, NeurIPS 2024 Spotlight), arXiv:2409.17106 | End-to-end transformer generating **parametric CAD models from text**; ~170K models, ~660K text annotations; metrics = visual quality, parametric precision, geometrical accuracy | ★★★★☆. The *metric* lesson matters: evaluate parametric programs on **execution-derived geometric accuracy**, not on text similarity. Same as our Tier-1/Tier-2/Tier-3 checker. |
| **PLLM** (Li, Shu, Chen, Klenk, Ritchie, 2026), arXiv:2602.12561 | Self-training for CAD program synthesis **without paired data**: "iteratively samples candidate programs, selects high-fidelity **executions**, and augments programs" | ★★★★☆. This is the exact shape of a shapez self-improvement loop: sample programs, keep the ones whose *execution* matches, fine-tune on them. Requires a deterministic executor — we have one. |

### 6.3 shapez-specific prior art that actually exists

Found via the GitHub repository API (`https://api.github.com/search/repositories?q=shapez`, 459 total hits; I read the top-25 by stars). [MEDIUM for descriptions — I read the API descriptions, not the repos' internals]

| Repo | Description (from API) | Relevance |
|---|---|---|
| `jiahao-0204/Shapez2-MIP-Miner` | "Shapez2 Miner Layout Solver. **Uses Gurobi to solve optimal miner layout**." (Python, MIT, ~26★, homepage shapez2-tools.com) | ★★★★★. **Real prior art on shapez layout optimization via MIP.** Evidence that the *layout* subproblem is treated as a constrained optimization, i.e. a deterministic solver problem — not an LLM problem. Note: shapez **2**, not shapez 1. |
| `TomasSirgedas/Shapez-solver` | C++ shapez solver (2022, ~6★) | ★★★☆☆. Exists; internals unexamined. |
| `tobspr-games/shapez.io-viewer` | "Allows to generate and view any shapez.io shape." (official org, ~24★) | ★★★★☆. The official shape generator — it embodies the canonical shape algebra and probably a recipe generator. Worth reading as the reference for shape construction semantics. |
| `entibo/shapezio-mods` | Modding repo; homepage `shapez.mod.io/compact-machines` | ★★★★☆. "**Compact machines**" = programmatic layout designs, i.e. human prior art on the construction DSL we want to automate. |
| `DJ1TJOO/create-shapez.io-mod` | A shapez mod (2022, ~6★) | ★★☆☆☆. Mod ecosystem exists. |
| `YXHXianYu/Shapez2-Blueprint` | Blueprint repo (2024, ~7★) | ★★★☆☆. Blueprint-level prior art. |
| `DontMash/shapez-vortex` | Community platform to view/share/modify Shapez 2 content | ★★☆☆☆. |

### 6.4 The honest gap statement

- **There is no published LLM/AI research on shapez.io.** An arXiv API search for the literal abstract term `shapez` returns **zero** shapez-related papers (verified: the query `abs:"shapez"` returned 8 totalResults, none about shapez.io). [STRONG, verified by search]
- **There is no published shape→construction-sequence compiler** for shapez in the literature or in the upstream repo's file tree. The upstream repo has `shape_definition.js`, `shape_definition_manager.js`, `blueprint.js`, `hub_goals.js`, `systems/item_processor.js`, `tutorial_goals.js` — **no `recipes.js`**. The *algebra* is there; the *compiler* is not. [STRONG, verified by reading the repo's `src/js/game` listing]
- **I could not verify a shapez AI competition.** I have a recollection that shapez.io ran an AI competition around 2020–2021, but a targeted web search returned only unrelated GitHub-trending noise, the upstream repo has no `ai/` directory at root, and the repo search surfaced no competition repo. **Treat this as unverified.** [WEAK]
- **Implication:** the shapez compound-shape compiler is *greenfield*. That is simultaneously an opportunity (no prior art to match, clean design space) and a risk (nobody has published that this is hard, so the difficulty may be underestimated). §9.4 recommends sizing it before betting on it.

### 6.5 Recommended DSL (design)

Sketch only — this is an engineering recommendation, not a literature finding.

```
# Layout program (LLM output)
recipe  := stack_expr
stack_expr := branch (+) branch (+) ...        # merge at min gap 1, cap 4 layers
branch  := paint4(rotate_cw|ccw|180? (cut(base(), QUADS)))
          | paint4(cut(base(), QUADS))
          | paint4(base())
```

Every op corresponds 1:1 to a `ShapeDefinition` method, so:
- the compiler is ~50 lines and uses the game's own semantics;
- the checker is `getHash()` equality;
- the DSL is small enough that a strong LLM can emit it reliably (contrast with PDDL, where L2HP measured 1% syntactic validity for hierarchical specs).

The **spatial** part (belt routes, miner placement, hub approach) is a *separate* deterministic program that consumes the recipe's "required input shapes" and emits `place`/`place_path` calls.

---

## 7. Curriculum and self-play

### 7.1 Automatic curriculum learning: the state of the art

- Portelas, Colas, Weng, Hofmann, Oudeyer (2020), **"Automatic Curriculum Learning For Deep RL: A Short Survey"**, IJCAI 2020, arXiv:2003.04664 — ACL "has become a cornerstone of recent successes in Deep RL… shape the learning trajectories of agents by **challenging them with tasks adapted to their capacities**." [STRONG]
- Willems, Lahlou, Bengio (2020), arXiv:2008.06456 — "**mastering rate**" significantly outperforms learning-progress-based algorithms. [STRONG]
- Sullivan, Pégoud, Rehman, Yang, Huang, Verma, Mitra, Dickerson (2025), **Syllabus**, RLC 2025, arXiv:2411.11318 — "We present the **first examples of automatic curriculum learning in NetHack and Neural MMO**, two of the most challenging RL benchmarks, and find evidence that **existing methods do not directly transfer to complex new environments**." [STRONG]
  - **Transfer warning, directly applicable.** A curriculum that worked on ALFRED/rooms will not simply transfer to shapez. It must be *designed* for shapez's difficulty axis.
- LEACL (Heravi, Ouyang, Xu, Sun, Stone, IROS 2026), arXiv:2607.23515 — LLMs **decompose tasks into subtasks and generate task-dependent specifications** for the ACL algorithm, using only sparse rewards; "LEACL achieves better asymptotic performance in terms of the success rates compared to **human-designed dense rewards**" on 5 LIBERO long-horizon manipulation tasks. [MEDIUM]
  - **Transfer:** LLMs are good at *naming* subproblems and specifying them; they're bad at the search. This is the same split as §1.8.
- Pappalardo, Herr, Rocktäschel (2026), arXiv:2610.04604 — combines online learning-progress with "LLM-informed estimates of (i) the potential downstream benefits of learning on each task and (ii) whether direct training on a task is currently likely to produce progress"; evaluated on 256 textual goals in Craftax; "strongest gains when optimizing for individual target tasks." [MEDIUM]
- **Voyager's automatic curriculum** (arXiv:2305.16291) — "an automatic curriculum that maximizes exploration," as one of three components; it is what makes the skill library grow. [STRONG]

### 7.2 Self-play

- Chen, Deng, Yuan, Ji, Gu (2024), **SPIN**, ICML 2024, arXiv:2401.01335 — self-play fine-tuning from a weak model to a strong one "without the need for acquiring additional human-annotated data"; the model "refines its policy by discerning these self-generated responses from those obtained from human-annotated data"; "SPIN can significantly improve the LLM's performance across a variety of benchmarks and even outperform models trained through **direct preference optimization (DPO) supplemented with extra GPT-4 preference data**." [STRONG]
- **The honest shapez analogue of self-play is not model self-play — it is program self-play:**
  - Generate N candidate layout programs (sampled from the LLM with temperature).
  - **Execute all N** in the deterministic simulator.
  - Keep the ones that pass the deterministic checker (shape hash + delivery) — this is the "high-fidelity executions" filter of PLLM (arXiv:2602.12561) and the STaR loop (Zelikman, Wu, Goodman, 2022, arXiv:2203.14465, which "iteratively leverage[s] a small number of rationale examples… if the generated answers are wrong, try again to generate a rationale given the correct answer; fine-tune on all the rationales that ultimately yielded correct answers").
  - Add the passers to a **skill library** (Voyager's mechanism) or a **few-shot exemplar pool**.
  - **This requires zero human labels and zero LLM judging** — the verifier is the game's own hash comparison. That is the key enabler.
- **Self-play at scale (LLM weights) is not warranted here.** The brief asks "whether LLM in the loop helps or hurts at scale." The evidence-based answer for a small project:
  - **At program scale, LLM-in-the-loop clearly helps** — Voyager (+15.3× on tech-tree milestones), GITM (+47.5% on ObtainDiamond), Code-as-Policies (+46.2% with verification) all show gains.
  - **At *memory-library* scale, it can hurt:** CTIM-Rover (Lindenbauer, Groh, Schütze, 2025), arXiv:2505.23422, "CTIM-Rover **does not outperform AutoCodeRover in any configuration** and thus we conclude that **neither ExpeL nor DoT-Bank scale to real-world SE problems**. Our analysis indicates **noise introduced by distracting CTIM items or exemplar trajectories** as the likely source of the performance degradation." [STRONG]
  - **Transfer: a shapez skill library must be kept small and *filtered by the checker*, not merely by "it seemed to work".** An unfiltered library is a noise source. Our deterministic checker makes filtering cheap, so we should filter hard. [SPECULATIVE→STRONG by analogy]
  - **ExpeL** (Zhao, Huang, Xu, Lin, Liu, Huang, AAAI 2024), arXiv:2308.10144 — the LLM "autonomously gathers experiences and extracts knowledge using natural language from a collection of training tasks. At inference, the agent recalls its extracted insights and past experiences." [STRONG for mechanism; MEDIUM for numbers] — the "natural-language insight" mechanism is weaker than the "checked executable skill" mechanism for shapez, because we have a ground-truth verifier and don't need a natural-language summary of it.

### 7.3 A shapez curriculum (design)

The difficulty axis for shapez is **not** level number; it's **the depth of the shape-DAG and the topology of the required factory**:

| Stage | Goal shape class | Prerequisite skills |
|---|---|---|
| 0 | single-quadrant circle/rect (`CuCuCuCu`) | miner → belt → hub |
| 1 | full-layer shape (4 identical quadrants), any color | paint operation, colorer placement |
| 2 | 2-quadrant shapes (`CuCuCu--`) | cutter placement + splitter routing |
| 3 | 2-layer shapes (stack) | stacker placement, layer alignment, dual-input routing |
| 4 | 2-layer with per-quadrant colors (`paint4`) | 4-color painter, quadrant-indexed routing |
| 5 | rotated sub-shapes (star/windmill) | rotator placement, rotation-direction correctness |
| 6 | 3–4 layer compound | multi-stage cascade, buffer/back-pressure |
| 7 | throughput-only variants | parallel lines, belt tiers, throughput measurement |

Note the **operation-count axis**: cut/rotate/paint/stack are 4 ops, so a 4-layer shape with per-quadrant colors and rotations has an *algebraic* depth that is small but a *layout* depth that is not. Stage 6–7 is where the LLM's spatial reasoning will fail, and where deterministic layout search matters most.

### 7.4 DSL coverage is a curriculum gate

AlphaGeometry's history (arXiv:2502.03544: coverage 66%→88%, solving 54%→84%) shows that **DSL coverage, not model capability, was the binding constraint** for a long time. For shapez:

- **Metric: "DSL coverage of goal shapes."** For each of shapez's actual goal shapes (the game has a fixed, enumerable set of goal shapes across levels), determine whether our DSL can express it at all.
- If coverage < 100%, the LLM will fail on unrepresentable goals for reasons unrelated to reasoning, and we will misdiagnose the problem.
- Because the shape space is small (4 quadrants × 4 sub-shapes × 5 colors × ≤4 layers), coverage is computable **exactly, offline, today**. Do this before building anything else.

### 7.5 Self-play at the meta level

The shapez AI competition question (unverified, §6.4) would be the natural source of a population to self-play against. Since I could not verify its existence, treat "acquire a shapez opponent population" as **an open dependency, not a plan**.

---

## 8. Cost/benefit: what is the minimum viable "smart" architecture?

### 8.1 The evidence for LLM-vs-scaffolding allocation

- **Symbolic beats learned in a hard, long-horizon game:** NetHack Challenge (arXiv:2203.11889) — "symbolic bots currently outperform deep RL by a large margin." [STRONG]
- **Symbolic beats a deep neuro-symbolic model on a construction task, on a laptop:** arXiv:2404.06405 (Wu's method + AlphaGeometry = 21/30 and 27/30). [STRONG]
- **LLMs fail at long-horizon factory construction even in a purpose-built factory env:** FLE, arXiv:2503.09617. [STRONG]
- **LLMs fail at planning; a balanced hybrid is the recommended methodology:** PlanBench (arXiv:2206.10498), LLMs Still Can't Plan (arXiv:2409.13373), Survey on LLMs for Automated Planning (arXiv:2502.12435). [STRONG]
- **But the LLM does add real value when it is the *proposal* source and a verifier is the gate:** LLM-Modulo (arXiv:2402.01817 / 2411.14484 / 2405.20625), Towards Reliable Code-as-Policies (arXiv:2510.21302, +46.2%), Actor/Judge/Editor (arXiv:2608.21897, 35.5%→70.8%). [STRONG]
- **Simple baselines are stronger than folklore says:** PPO in cooperative multi-agent games (arXiv:2103.01955) — simple PPO matches or beats competitive off-policy methods across four testbeds with minimal tuning. [STRONG] And in shapez's own ecosystem, a MIP solver (Gurobi) is used for miner layout (`Shapez2-MIP-Miner`).
- **Harness/agent-code evolution helps in long-horizon games but not elsewhere:** arXiv:2607.12227 — 80% over the search baseline on ARC-AGI-3, 11% on EdgeBench games; fails to beat simple test-time scaling on ordinary benchmarks. [STRONG]

### 8.2 Component-by-component verdict

| Component | Verdict | Justification |
|---|---|---|
| **Goal → recipe compiler (shape DAG)** | **Pure deterministic code. No LLM.** | The algebra is in the game source; the space is small enough to search exactly; AlphaGeometry's coverage lesson. |
| **Recipe → spatial layout (belts, miners, cutters, stackers, painters)** | **Mostly deterministic; LLM only as a tie-breaker for novel topologies** | FLE shows LLM spatial failure; `Shapez2-MIP-Miner` shows the layout subproblem is an optimization problem. |
| **Layout → protocol actions** | **Pure deterministic code.** | `place_path` semantics, rotation derivation, axis-alignment. Never let the LLM emit a coordinate. |
| **Shape verifier (Tier 1)** | **Pure deterministic code.** | `getHash()` equality. Free. |
| **Legality verifier (Tier 2)** | **Pure deterministic code.** | Overlap/occupancy checks. |
| **Outcome verifier (Tier 3)** | **Pure deterministic code.** | `await`/`step` + `hub.stored_shapes`. |
| **Strategy selection (which recipe, which topology)** | **LLM** | This is where world knowledge pays: "the goal is 2 layers with different colors, so I need a cutter and a 4-color painter, not a stacker." |
| **Repair after a failed attempt** | **LLM, given structured critique** | LLM-Modulo travel planning: LLM as critic-extractor and critique-reformulator; Code-as-Policies +46.2%. |
| **Self-critique on shape correctness** | **Never. Always deterministic.** | Huang et al. (arXiv:2310.01798): self-correction without external feedback can *degrade* performance. |
| **LLM-as-judge for scoring layouts** | **Never as a gate.** At most as a tiebreaker among checker-passing candidates. | arXiv:2609.34198: judge false-acceptance *rises with agent capability*. |
| **Learned world model** | **Never.** | The real simulator is the model. |
| **Skill library** | **Yes, but filtered by the deterministic checker and kept small.** | CTIM-Rover: unfiltered memory libraries degrade performance. |
| **Curriculum** | **Yes, deterministic stage ladder + checker-gated progression.** | ACL survey (arXiv:2003.04664); Syllabus warns about transfer (arXiv:2411.11318). |
| **Vision / screenshots in the loop** | **Never.** | BALROG: models perform *worse* with visual representations. |
| **Prompt optimization (DSPy/MIPRO-style)** | **Later, if at all** | Only worth it once you have a checker and a benchmark; then it becomes "harness evolution" (arXiv:2607.12227), which *does* pay off in long-horizon games. |

### 8.3 The minimum viable architecture (recommended)

```
┌──────────────────────────────────────────────────────────────┐
│  LAYER 3  Strategy (LLM, 1 call per attempt)                │
│    Input : goal{shape,required,throughput_only} +             │
│            summary obs (small, goal-first) +                │
│            skill-library hits (≤3, checker-filtered)         │
│    Output: LAYOUT PROGRAM in the shapez DSL (§6.5)           │
│    Forbidden: coordinates, rotation values, building ids     │
├──────────────────────────────────────────────────────────────┤
│  LAYER 2  Deterministic compiler + verifiers                 │
│    program → Actions (place/place_path/delete/paste)         │
│    Tier1 shape hash check · Tier2 legality · Tier3 simulate  │
│    On failure → structured critique (error code + hint +     │
│                  first-diff layer/quadrant + occupants)      │
├──────────────────────────────────────────────────────────────┤
│  LAYER 1  Deterministic layout search / retry policy         │
│    fixed topology enumeration (like runB1's 4 variants),      │
│    belt routing, rotation derivation, throughput variants     │
├──────────────────────────────────────────────────────────────┤
│  LAYER 0  Simulator (already exists)                         │
│    paste → await/step → read delivered/throughput/ticks      │
└──────────────────────────────────────────────────────────────┘
```

**Cost profile:** 1 LLM call per attempt; the deterministic layers cost RPC round trips (one `paste_blueprint`, one `await`). If the deterministic layer alone solves compound shapes, the LLM layer is *optional* — which is exactly the right property for an architecture that should be safe to disable.

### 8.4 Token/cost economics

- The whole loop is O(1) LLM calls per attempt with a *small* prompt (goal + summary + ≤3 library entries). That is ~1–2k input tokens and ~300 output tokens per attempt. [SPECULATIVE arithmetic, but the structure — small structured observations, not raw dumps — is mandated by Lost in the Middle (arXiv:2307.03172) and by the brief's "few observations."]
- The *simulator* is the cheap oracle: `step` up to 20,000 ticks per call and `await` with a timeout budget. One `await` costs one round trip. **Spending simulator time is far cheaper than spending LLM tokens** — so the architecture should bias toward "try many deterministic candidates, ask the LLM rarely." [SPECULATIVE but directly supported by arXiv:2507.14419 ("It's Not That Simple": scaling behavior attributed to *scaling down* by length limits, with "Wait"-appending causing oscillation) and by arXiv:2607.12227's matched-budget finding.]
- **Cost trap to avoid:** the loop that looks cheap — "ask the LLM to plan each action, observe, repeat" — is O(actions) LLM calls *and* O(actions) observations *and* suffers long-horizon degradation (AgentBench arXiv:2308.03688; Lost in the Middle arXiv:2307.03172). For a 200-belt layout that is 200 LLM calls and a 200-step observation stream. This is precisely the architecture to reject.

---

## 9. What the literature says we should NOT do

### 9.1 Do not let the LLM be the planner of record

PlanBench (arXiv:2206.10498), LLMs Still Can't Plan (arXiv:2409.13373), Survey on LLMs for Automated Planning (arXiv:2502.12435), FLE (arXiv:2503.09617). The synthesis in the 2025 survey is the right posture: "LLMs are **not well-suited to serve as standalone planners**… but they present an enormous opportunity to enhance planning applications when combined with other approaches… a **balanced methodology**." [STRONG]

### 9.2 Do not let the LLM compute geometry, coordinates, or rotations

- BALROG (arXiv:2411.13543), FLE (arXiv:2503.09617): spatial reasoning is the deficit.
- CAD-Recode (arXiv:2412.14042), Code as Policies (arXiv:2209.07753), ProgPrompt (arXiv:2209.11302), ShapeAssembly (arXiv:2009.08026): emit **code over a DSL**, not coordinates.
- TickingCollabBench (Yi, Wang, Zhang, Yan, 2026), arXiv:2606.15684 — in Minecraft, LLM agents "frequently fail under dynamic environments and **fall significantly short of a global-knowledge oracle**." [MEDIUM]

### 9.3 Do not build a learned world model / a deep-RL policy

- The simulator *is* the world model, exactly. Dreamer/MuZero are for environments you cannot simulate; CBET (arXiv:2503.21047) shows the intrinsic-reward variants can *hurt* the extrinsic objective.
- NetHack Challenge (arXiv:2203.11889): symbolic bots ≫ deep RL on a long-horizon game.
- PPO (arXiv:2103.01955): a simple classical baseline is often competitive; and it also shows the *reward-hacking* risk. [STRONG]

### 9.4 Do not build the whole thing before measuring the hard subproblem

- Compile a **DSL-coverage** number first (§7.4). If our DSL can't express some real goal shapes, the LLM's failure rate is a *representation* problem and no amount of prompt engineering fixes it.
- Separately, size the **spatial layout** subproblem: FLE (arXiv:2503.09617) and `Shapez2-MIP-Miner` both indicate this is the genuinely hard part. If a deterministic layout solver (or a MIP/CP formulation, per the Gurobi precedent) solves compound shapes, **the LLM is not needed for correctness at all** — only for choosing among topologies.
- [SPECULATIVE] This is the single largest schedule risk in the project.

### 9.5 Do not build a general multi-agent LLM system

- The 2026 Coordination-as-Architectural-Layer paper (Nechepurenko & Shvalov, arXiv:2605.03310) reports "Multi-agent LLM systems **fail in production at rates between 41% and 87%**, mostly due to **coordination defects rather than base-model capability**." [MEDIUM]
- MaestroMotif (arXiv:2412.08542) and ONI (arXiv:2410.23022) use LLMs to *design rewards*; we have exact rewards.
- **For a small project, one LLM call per attempt beats four LLM agents arguing.**

### 9.6 Do not build an unfiltered memory/skill library

CTIM-Rover (arXiv:2505.23422): "neither ExpeL nor DoT-Bank scale… noise introduced by distracting CTIM items or exemplar trajectories [is] the likely source of the performance degradation." [STRONG]
Keep the library small and **checker-filtered**. Three entries maximum in-context.

### 9.7 Do not use an LLM judge as the gate, ever

- MT-Bench (arXiv:2306.05685): position, verbosity, self-enhancement biases.
- Frozen Judges (arXiv:2609.34198): false acceptance **rises with agent capability**; a judge reversed a nine-point gap.
- **Our agent improves over time — exactly the regime where judge reliability degrades.** If you build a judge into the loop, you are building a reward that gets more permissive as you succeed.
- The game's own hash comparison costs nothing and never drifts.

### 9.8 Do not add test-time scaling as a substitute for a verifier

- arXiv:2507.14419 ("It's Not That Simple"): naive scaling-down by length limits *lowers* the performance ceiling; "Wait"-appending causes oscillation between solutions. [MEDIUM]
- arXiv:2607.12227: automatic harness evolution "fails to outperform simple test-time scaling methods" on ordinary benchmarks — *but* does (80% over baseline on ARC-AGI-3) on long-horizon games. shapez is a long-horizon game, so harness evolution *may* pay off — **but only after the checker exists** (otherwise you're scaling a broken signal). [STRONG]
- arXiv:2412.16260 ("Inference Scaling vs Reasoning"): combining a high-accuracy method and a high-efficiency method "unexpectedly results in **degraded performance**" (9.38% vs 32.03%) — a caution against naively stacking LLM tricks. [MEDIUM]
- **Concrete reading:** for shapez, "more thinking" is the wrong axis; "more simulated candidates" is the right one. arXiv:2607.00454 (Agri-SAGE) is a useful data point on the cost side: "**Reflexion achieves comparable agronomic outcomes at substantially lower computational cost**" than Tree-of-Thoughts, by leveraging episodic memory.

### 9.9 Do not add vision

BALROG (arXiv:2411.13543): "several models perform **worse** when visual representations of the environments are provided." [STRONG] The `screenshot` op exists in our protocol; keep it for debugging and human review, not for the agent loop.

### 9.10 Do not chase the "reward hacking" tail without a hedge

Gao et al. (arXiv:2210.10760) measured the *functional form* of proxy over-optimization. The hedge is structural: **lexicographic objectives with hard feasibility gates** (arXiv:2610.09219's "hard constraints are never traded off against preferences"), and score the *goal shape specifically* via `hub.stored_shapes[goalShape]` rather than a global delivery count.

### 9.11 Risk register for the project

| Risk | Evidence | Mitigation |
|---|---|---|
| LLM emits invalid actions / hallucinated ids | AgentBench (arXiv:2308.03688), ToolSandbox (arXiv:2408.04682) | Compile, don't execute; closed typed op set; `2001` rejects unknown fields |
| Rotation confusion (silent) | Shape algebra vs. prose intuition; `runB1`'s verified miner/belt conventions | Never let the LLM compute rotation; derive in code; checker catches wrong shapes |
| Long-horizon drift | Lost in the Middle (arXiv:2307.03172), AgentBench (arXiv:2308.03688) | Small summary observations, goal-first, action-last; bounded loop; ≤1 LLM call per attempt |
| No recovery | PlanBench-XL (arXiv:2606.22388) | Deterministic retry-topology enumeration; `hint` + occupants re-observation |
| Proxy collapse | Gao (arXiv:2210.10760), PPO emergent proxies (arXiv:2103.01955) | Lexicographic objective; score goal-shape-specific deliveries; waste reported, not optimized |
| Judge drift | Frozen Judges (arXiv:2609.34198) | No LLM judge as gate |
| DSL cannot express the goal | AlphaGeometry coverage history (arXiv:2502.03544) | Measure coverage offline, exhaustively, first |
| Library noise | CTIM-Rover (arXiv:2505.23422) | Filter by checker; cap context at 3 |
| Over-engineering | Survey (arXiv:2502.12435), NetHack Challenge (arXiv:2203.11889) | Keep the LLM to one role: strategy selection + repair |

---

## 10. Reference table — mechanism → evidence → transferability to shapez

| # | Mechanism | Key evidence (source, year) | Reported effect | Transferability to shapez | Grade |
|---|---|---|---|---|---|
| 1 | LLM translates NL → formal spec; classical planner solves | LLM+P, arXiv:2304.11477 (2023) | Optimal solutions for most problems; LLMs fail to give feasible plans | **Low** — our spec is already machine-readable | STRONG |
| 2 | LLM + sound external verifiers, re-prompt on failure | LLM-Modulo, arXiv:2402.01817 (ICML'24); 2411.14484; 2405.20625 | "Can never output a fallacious output"; TravelPlanning 4.6× (GPT-4-Turbo); CoT/ReAct/Reflexion 0%/0.6%/0% | **Very high** — the core template | STRONG |
| 3 | Actor / Judge / Editor over solver feedback | arXiv:2608.21897 (2026) | PlanBench 35.5% (LLM+P) → **70.8%**; 66.3% faithful; drift 6.4% | **Very high** — maps to LLM / checker / LLM-repair | STRONG |
| 4 | LLM plans; classical planner does geometry; simulator feeds back | SayPlan, arXiv:2307.06135 (CoRL'23) | Corrects infeasible actions; 3 floors / 36 rooms | **Very high** — closest architecture to ours | STRONG |
| 5 | LLM writes policy **code**; recursive definition | Code as Policies, arXiv:2209.07753 (2022) | HumanEval 39.8% via hierarchical code-gen; spatial reasoning | **Very high** | STRONG |
| 6 | Code-gen + **symbolic verification + interactive validation** | Towards Reliable Code-as-Policies, arXiv:2510.21302 (NeurIPS'25 Spotlight) | **+46.2%** success; >86.8% executability | **Very high** | STRONG |
| 7 | Program-like prompt structure constraining valid actions | ProgPrompt, arXiv:2209.11302 (2022) | SOTA on VirtualHome; real robot deployment | **High** — our op set is small and typed | STRONG |
| 8 | Tool-integrated reasoning + output space shaping | ToRA, arXiv:2309.17452 (ICLR'24) | +13–19% abs.; ToRA-7B 44.6% MATH | **Medium-high** — mostly a *training* recipe | STRONG |
| 9 | Automatic curriculum + skill library + exec-error feedback | Voyager, arXiv:2305.16291 (2023) | 3.3× items; 2.3× distance; **15.3×** faster milestones | **High** — skill library + self-verification | STRONG |
| 10 | Structured actions + text knowledge + memory | GITM, arXiv:2305.17144 (2023) | **+47.5%** ObtainDiamond; first full tech tree | **High** — for the typed-action lesson | STRONG |
| 11 | Multimodal LM → plan → goal-conditioned controller + memory | JARVIS-1, arXiv:2311.05997 (2023) | 200+ tasks; **5×** reliability on diamond pickaxe | **Medium** | STRONG |
| 12 | Pixel-policy instruction following (the boundary case) | STEVE-1, arXiv:2306.00937 (2023) | 12/13 tasks, $60 compute | **Low** — wrong tool for a symbolic env | STRONG |
| 13 | LLM-as-world-model + MCTS over reasoning states | RAP, arXiv:2305.14992 (EMNLP'23) | LLaMA-33B beats GPT-4 CoT by **33% rel.** | **Medium** — bounded variant maybe | MEDIUM |
| 14 | Learned world model + imagination | DreamerV3 / MuZero (via arXiv:2308.03526, arXiv:2503.21047) | Strong in Atari; **intrinsic reward misaligned** in Minigrid | **Very low / negative** — we have the real model | MEDIUM |
| 15 | Self-critique with **no** external signal | Self-Refine, arXiv:2303.17651 (2023) | ~20% abs. gain | **Low** — and risky | STRONG |
| 16 | Self-correction **without** external feedback | arXiv:2310.01798 (ICLR'24) | "Performance even **degrades** after self-correction" | **Very low / negative** — never gate on this | STRONG |
| 17 | LLM-as-judge | MT-Bench, arXiv:2306.05685 (NeurIPS'23) | >80% human agreement; position/verbosity/self-enhancement biases | **Low / negative** | STRONG |
| 18 | Frozen LLM judges on agent outputs | arXiv:2609.34198 (2026) | Judge **reversed a 9-pt gap**; false acceptance ↑ with capability (ρ=+0.944) | **Very low / negative** — and *dangerous* as the agent improves | STRONG |
| 19 | Execution-based verification instead of text similarity | NL2AGBench, arXiv:2608.28481 (2026) | Closed models >80% executable; open models fail | **Very high** — our checker | STRONG |
| 20 | Small DSL + symbolic engine + search | AlphaGeometry / AG2, arXiv:2502.03544 (2025); arXiv:2404.06405 (2024) | 54%→84% solving; **classic symbolic + laptop = 21/30** | **Very high** — shapez's algebra is smaller than geometry's | STRONG |
| 21 | Symbolic solver with an **agent-steerable** interface | Newclid, arXiv:2411.11938 (2024) | Agentic BFS mode solves an extra AG-30 problem | **High** — checker should return a diff, not a bool | MEDIUM |
| 22 | Program representation for geometry (LLM decodes code) | CAD-Recode, arXiv:2412.14042 (2024) | Small LLM suffices; output interpretable/editable | **Very high** | STRONG |
| 23 | Domain-specific assembly language for 3D shapes | ShapeAssembly, arXiv:2009.08026 (SIGGRAPH'20) | More physically-valid than deep models; one program per family | **Very high** | STRONG |
| 24 | LLM building generation with repair (Minecraft) | T2BM, arXiv:2406.08751 (CoG'24) | Correct complete buildings with specified blocks | **High** — closest analogue | MEDIUM |
| 25 | Search for artifacts via a block-placement API | EvoCraft, arXiv:2012.04751 (2020) | Target-matching succeeds; **functional machines fail** | **High** — the tractable/hard split | STRONG |
| 26 | Self-training for program synthesis via high-fidelity executions | PLLM, arXiv:2602.12561 (2026) | Consistent gains from unlabeled shapes | **High** — the shapez self-play loop | MEDIUM |
| 27 | Bootstrapping from verified-correct self-generated solutions | STaR, arXiv:2203.14465 (2022) | Comparable to a 30× larger model on CSQA | **Medium** | STRONG |
| 28 | Program synthesis for factory automation (LLM agents) | **FLE**, arXiv:2503.09617 (2025) | **"Models still lack strong spatial reasoning"**; fail at complex automation | **Very high** — the warning label | STRONG |
| 29 | Fault diagnosis + repair in factories, LLM + symbolic verifier + re-observation | OntoAct / Tacit-FLE, arXiv:2610.21983 (2026) | Leading performance with efficient interaction | **Very high** — closest *factory* analogue | MEDIUM |
| 30 | Symbolic vs. deep RL in a long-horizon game | NetHack Challenge, arXiv:2203.11889 (2022) | **Symbolic bots outperform deep RL by a large margin** | **Very high** | STRONG |
| 31 | Hybrid symbolic + neural skill modules | LuckyMera, arXiv:2307.08532 (2023) | SOTA in full NetHack | **Medium** | MEDIUM |
| 32 | Agentic LLM/VLM benchmark across games | BALROG, arXiv:2411.13543 (ICLR'25) | Strong on easy games; **vision makes it worse** | **Very high** (as a warning) | STRONG |
| 33 | Tool-use benchmark with stateful execution | ToolSandbox, arXiv:2408.04682 (2024) | Canonicalization / State-Dependency hardest | **Very high** — maps to canonical shape keys | STRONG |
| 34 | Agentic planning with 1,665 tools; blocking perturbations | PlanBench-XL, arXiv:2606.22388 (2026) | 51.9% → **11.4%** under blocking; no explicit error signal ⇒ worst | **Very high** — recovery design | STRONG |
| 35 | Failure taxonomy for LLM agents | AgentBench, arXiv:2308.03688 (ICLR'24) | Long-term reasoning, decision-making, instruction-following are the blockers | **High** | STRONG |
| 36 | Position bias in long contexts | Lost in the Middle, arXiv:2307.03172 (TACL'23) | Middle-of-context information largely missed | **Very high** — dictates observation design | STRONG |
| 37 | Proxy over-optimization, measured | arXiv:2210.10760 (2022) | Gold-vs-proxy score degrades predictably with proxy size | **Very high** — objective design | STRONG |
| 38 | Emergent proxy exploitation in game agents | PPO cooperative multi-agent, arXiv:2103.01955 (NeurIPS'22) | "Suspiciously optimal" unintended behaviors | **Very high** | STRONG |
| 39 | Naively designed dense rewards degrade performance | arXiv:2604.02869 (2026) | Up to **−14 pts** from dense per-turn rewards | **High** | MEDIUM |
| 40 | Intrinsic motivation drifting off extrinsic objective | CBET / arXiv:2503.21047 | DreamerV3 + intrinsic reward hurts Minigrid | **Medium** | MEDIUM |
| 41 | Lexicographic hard/soft constraint separation (deterministic verifier margin) | CM-DPO, arXiv:2610.09219 (2026) | 89.2% pass; hard constraints never traded off | **High** | MEDIUM |
| 42 | Binary checklist criteria with evidence grounding | CM2, arXiv:2602.12268 (2026) | +8 tau-bench / +10 BFCL / +12 ToolSandbox over SFT | **High** | MEDIUM |
| 43 | Automatic curriculum learning | ACL survey, arXiv:2003.04664 (IJCAI'20); mastering rate arXiv:2008.06456 | Mastering rate ≫ learning progress | **High** | STRONG |
| 44 | ACL does **not** transfer to new complex environments | Syllabus, arXiv:2411.11318 (RLC'25) | First NetHack/Neural-MMO ACL; transfer fails | **High** (as a warning) | STRONG |
| 45 | LLM-generated subtask specs for ACL | LEACL, arXiv:2607.23515 (IROS'26) | Beats human-designed dense rewards on LIBERO | **Medium** | MEDIUM |
| 46 | LLM-informed curriculum decisions | arXiv:2610.04604 (2026) | Gains strongest for individual target tasks | **Medium** | MEDIUM |
| 47 | Self-play fine-tuning without human labels | SPIN, arXiv:2401.01335 (ICML'24) | Beats DPO with extra GPT-4 preference data | **Medium** (model-level; program-level is better) | STRONG |
| 48 | Experience-derived natural-language insights | ExpeL, arXiv:2308.10144 (AAAI'24) | Consistent gains as experience accumulates | **Low-medium** — superseded by checker-filtered skills | STRONG |
| 49 | Experience libraries that **fail to scale** | CTIM-Rover, arXiv:2505.23422 (2025) | Does not beat baseline in any config; distracting items are the cause | **Very high** (as a warning) | STRONG |
| 50 | Harness/agent-code evolution vs. simple test-time scaling, matched budget | arXiv:2607.12227 (2026) | Fails on ordinary benchmarks; **+80% ARC-AGI-3, +11% EdgeBench** games | **High** — shapez is long-horizon; needs a checker first | STRONG |
| 51 | Test-time scaling done naively | arXiv:2507.14419 (2025) | Length-limit scaling lowers the ceiling; "Wait" causes oscillation | **Medium** (as a warning) | MEDIUM |
| 52 | Combining high-accuracy and high-efficiency LLM methods | arXiv:2412.16260 (2024) | 32.03% → **9.38%** when naively combined | **Medium** (as a warning) | MEDIUM |
| 53 | Reflection vs. ToT on cost | Agri-SAGE, arXiv:2607.00454 (2026) | Reflexion ≈ ToT quality at substantially lower cost | **Medium** | MEDIUM |
| 54 | Formal verification of LLM plans (LTL model checking) | arXiv:2510.03469 (2025) | GPT-5 F1 96.3% classification; semantics still open | **Medium** | MEDIUM |
| 55 | Multi-agent LLM coordination failures | arXiv:2605.03310 (2026) | Production failure rates 41–87%; coordination > model capability | **Medium** (as a warning) | MEDIUM |
| 56 | LLM judge version-dependence / transport failure | arXiv:2609.34198 (2026) | Transported calibration: 3.8 → 19.5 points error | **High** (as a warning) | STRONG |
| 57 | Benchmark sample-size needs for agent decisions | arXiv:2607.12338 (2026) | tau-bench needs 25% of tasks for a 5-pt budget; SWE-bench Verified 90% | **Medium** — tells you how to evaluate your own agent | MEDIUM |
| 58 | shapez's own shape algebra (cut/rotate/stack/paint + canonical hash) | `shape_definition.js` / `shape_definition_manager.js`, upstream source | Memoized operation table; canonical `getHash()` keys | **N/A** — the substrate | STRONG |
| 59 | shapez layout optimization prior art (MIP/Gurobi) | `Shapez2-MIP-Miner` (GitHub) | Exists; not examined in detail | **N/A** — precedent for deterministic solvers | MEDIUM |
| 60 | shapez blueprint/construction community prior art | `shapezio-mods` (compact-machines), `shapez.io-viewer`, `Shapez2-Blueprint` | Exists; not examined in detail | **N/A** — DSL hints | MEDIUM |
| 61 | **Published shapez AI research** | arXiv `abs:"shapez"` → **0 relevant hits** | — | **N/A** — greenfield | STRONG (verified negative) |

---

## 11. Cheapest experiments to run first (each falsifies a design assumption)

Ordered by information-per-hour. None of these needs an LLM.

1. **DSL coverage audit (hours).** Enumerate shapez's real goal shapes from `src/js/game/hub_goals.js` (18.9 KB, upstream) and `tutorial_goals.js`; for each, attempt to construct it in the §6.5 DSL. Output: coverage %. If < 100%, fix the DSL *before* writing any agent. This directly de-risks the AlphaGeometry-style coverage trap (#20).
2. **Deterministic recipe compiler (1–2 days).** Backward search over the 4-quadrant/≤4-layer algebra to produce a recipe DAG per goal shape. Compare against the game's own behavior. Output: (a) does a backward search work at all; (b) what fraction of goals are reachable with a ≤N-op recipe.
3. **Does the deterministic layer alone solve compound shapes? (1–2 days).** Build the layout compiler for the 4 canonical topologies (cut-line, stack-line, paint-line, cascade). If the deterministic layer solves level 10-style compound goals, then **the LLM's role is reduced to topology choice, and the project is nearly complete without one.** This is the single most valuable experiment because it bounds the LLM's necessity.
4. **Checker differential test (hours).** Fuzz the recipe compiler: random recipe → simulate → compare produced shape hash to the compiler's predicted hash. Any mismatch is a bug in the compiler, in the game's semantics, or in our understanding. Run ≥10⁴ cases.
5. **Throughput baseline (1 day).** For one `throughput_only` goal, hand-build 2–3 topologies and measure delivered-per-tick. This produces the reference point that any "smart" agent must beat, and it calibrates the objective.
6. **Only then:** an LLM that emits DSL programs, with the deterministic checker as gate and the simulator as oracle. Measure: pass rate, actions, observations, LLM calls.

---

## 12. Sources actually opened

**arXiv (retrieved via `export.arxiv.org/api/query`; cited as `arxiv.org/abs/<id>`):**
2304.11477 · 2402.01817 · 2411.14484 · 2405.20625 · 2608.21897 · 2307.06135 · 2209.11302 · 2309.17452 · 2209.07753 · 2510.21302 · 2305.16291 · 2305.17144 · 2311.05997 · 2306.00937 · 2410.22194 · 2204.01691 · 2305.14992 · 2303.11366 · 2303.17651 · 2310.01798 · 2305.20050 · 2306.05685 · 2609.34198 · 2206.10498 · 2409.13373 · 2502.12435 · 2510.03469 · 2602.03900 · 2511.18165 · 2610.09219 · 2609.09898 · 2607.12338 · 2606.22388 · 2608.28481 · 2404.06405 · 2502.03544 · 2411.11938 · 2411.13543 · 2203.11889 · 2006.13760 · 2307.08532 · 2412.08542 · 2410.23022 · 2308.10144 · 2505.23422 · 2503.09617 · 2610.21983 · 2406.08751 · 2012.04751 · 2302.00782 · 1906.05094 · 2412.14042 · 2409.17106 · 2310.12945 · 2009.08026 · 1706.03741 · 2210.10760 · 2103.01955 · 2308.03688 · 2307.03172 · 2401.01335 · 2408.04682 · 2003.04664 · 2008.06456 · 2411.11318 · 2610.04604 · 2607.23515 · 2203.14465 · 2308.03526 · 2404.03683 · 2503.21047 · 2507.14419 · 2506.18957 · 2507.01231 · 2412.16260 · 2607.00454 · 2607.12227 · 2605.03310 · 2606.15684 · 2602.12268 · 2604.02869 · 2610.24194 · 2602.22697 · 2607.12338 · 2410.23022 · 2403.04664 · 2602.12561 · 2308.03688 · 2505.03335\* (not retrieved — excluded from the body)

\* `2505.03335` (Absolute Zero) and `2406.12045` (τ-bench) were targeted but their abstracts were not retrieved in this session; they are therefore **not** cited as evidence above. τ-bench is referenced only second-hand via arXiv:2609.34198 and arXiv:2607.12338.

**shapez primary sources:**
- `https://github.com/tobspr-games/shapez.io` — upstream game repo (GPL-3.0, ~7.0k★, ~1.3k forks at retrieval; created 2020-04-13, last push 2026-09-07).
- `https://raw.githubusercontent.com/tobspr-games/shapez.io/master/src/js/game/shape_definition.js` — the shape algebra: `ShapeDefinition`, layer/quadrant model, `getHash()`, `fromShortKey()`, `isValidShortKey()`, `cloneFilteredByQuadrants`, `cloneRotateCW/CCW/180`, `cloneAndStackWith`, `cloneAndPaintWith`, `cloneAndPaintWith4Colors`.
- `https://raw.githubusercontent.com/tobspr-games/shapez.io/master/src/js/game/shape_definition_manager.js` — memoized operation table (`"cut/<hash>"`, `"cut-quad/<hash>"`, `"rotate-cw|ccw|fl/<hash>"`, `"stack/<hash>/<hash>"`, `"paint/<hash>/<color>"`, `"paint4/<hash>/<colors>"`), `shapeActionCutHalf/CutQuad/Rotate*/Stack/PaintWith*`, `getDefinitionFromSimpleShapes`.
- `https://api.github.com/repos/tobspr-games/shapez.io/contents/src/js/game` — full file listing of `src/js/game` (confirms `shape_definition.js`, `shape_definition_manager.js`, `blueprint.js`, `hub_goals.js`, `tutorial_goals.js`, `systems/`, and **no** `recipes.js`).
- `https://api.github.com/repos/tobspr-games/shapez.io/contents/` — repository root listing (no `ai/` directory).
- `https://api.github.com/search/repositories?q=shapez&per_page=25&sortBy=stars` — 459 total hits; top-25 inspected (descriptions only).
- `https://github.com/tobspr-games/shapez.io-viewer` — official shape generator/viewer.
- `https://github.com/jiahao-0204/Shapez2-MIP-Miner` — Gurobi miner-layout solver (shapez **2**).
- `https://github.com/TomasSirgedas/Shapez-solver` — C++ shapez solver.
- `https://github.com/entibo/shapezio-mods` — compact-machines mod ecosystem.
- `https://github.com/DJ1TJOO/create-shapez.io-mod` · `https://github.com/YXHXianYu/Shapez2-Blueprint` · `https://github.com/DontMash/shapez-vortex` — community prior art.
- `https://shapez.io/wiki/` — **404** (negative result; the guessed wiki path does not exist).

**Local project files read:**
- `docs/PROTOCOL.md` — bridge protocol v1: observation schema, action set, error codes 1001–2006, blueprint format `SZBP1.<LZString>`, `step`/`await` semantics.
- `src/agent/play.mjs` — the B1 reference heuristic: nearest-resource discovery, miner rotation derivation, L-shaped belt paths, per-path fallback, error-hint handling, occupant re-observation.
