[简体中文](CONTRIBUTING.md) | English

# Contributing

Thanks for taking a look. This is a small project — the process below is short
because it is the actual process, not a template.

## Before you start

- **Node.js ≥ 20** (`node --version`).
- A **shapez.io 1.5.6 desktop (Steam) build** if your change touches anything
  that talks to the game. Much of the codebase — the bridge protocol, the MCP
  server, the agent loop's planning layer — can be worked on and tested without
  a running game.
- No other dependencies. The project deliberately ships with zero runtime
  dependencies, and a PR that adds one needs a strong reason in its description.

## Get it running

Most of the codebase can be checked out and tested with nothing but Node — no
game, no bridge:

```bash
git clone https://github.com/sqkl520/shapez-ai-bridge.git
cd shapez-ai-bridge
npm test                  # 677 unit tests, no game needed
node src/bridge/selftest.mjs   # bridge layer, no game needed
node src/mcp/selftest.mjs      # MCP layer, no game needed
```

Those three are the ones to run before opening a PR.

The **smoke test** is different: it is genuinely end-to-end and needs the real
thing. Start the bridge, open shapez.io with the mod installed, and load a
savegame first:

```bash
node src/bridge/bridge.mjs      # terminal 1
node scripts/smoke_test.mjs     # terminal 2, after the game is in a world
```

If it prints `SMOKE TEST PASSED (5/5)`, all five layers are wired up. Its exit
codes tell you which layer is missing: `1` the bridge is not running, `2` the
bridge is up but no game is connected or it is still in the menu, `3` another
check failed. It briefly places and deletes one belt near the hub to prove
writes work, and leaves your world unchanged.

There is no way to fake this one — the whole point is that it exercises the
real game. For a test that runs without a game, use `npm test` above.

## Running the tests

```bash
# Everything under src/agent (the largest test surface)
node --test src/agent/

# A single file while you iterate
node --test src/agent/loop/handles.test.mjs

# The bridge and MCP servers each ship a self-test
node src/bridge/selftest.mjs
node src/mcp/selftest.mjs
```

Some tests need a live game connection and are skipped when the bridge has no
mod attached. A skipped test is not a passing test — do not delete a skip to
make a suite look green.

## Making a change

1. **Branch.** Even as the only maintainer, work on a branch and open a PR.
   `type/short-description`, e.g. `fix/belt-handoff-direction`.
2. **Keep the diff focused.** One concern per PR. If you notice an unrelated
   problem, open an issue instead of fixing it in passing.
3. **Tests come with the change, not after it.** If you fix a defect, add a
   regression test that fails without your fix. Tests that were written against
   a wrong assumption should be rewritten with a comment explaining what the old
   assumption was — not deleted.
4. **Commit messages** use `type(scope): summary`, and explain *why* the change
   is needed. Types in use: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`,
   `chore`.
5. **Update docs in the same commit** when you change behaviour, configuration
   or a public interface. See the checklist below.

## What reviewers look at

- Does the change say why it is needed, not just what it does?
- If behaviour changed, is there a test that would catch a regression?
- If the change came from observing a real failure, does a comment record the
  observable symptom (what the log said, what the world looked like) so the next
  person does not have to rediscover it?
- Does any new output that reaches the model actually reach it? A value computed
  and then dropped before rendering is the single most common defect class in
  this repository.

## Privacy and repository hygiene

This repository is public. Before you commit:

- **No secrets, tokens or keys.** Use environment variables. `.gitignore` blocks
  `.env` and friends; do not force-add them.
- **No real user data.** Example saves, paths and hostnames must be fabricated
  (`example.com`, `*.test`, `<repo>`, `<user-home>`).
- **No absolute paths from your machine** in code, tests or docs.
- **No runtime artifacts.** Logs, `.pid` files, run transcripts and build output
  are ignored; keep them out of the index.

## Code layout

| Path | What lives there |
| --- | --- |
| `src/mod/` | The single-file game mod (runs inside shapez.io's renderer) |
| `src/bridge/` | The local Node bridge: WebSocket + HTTP + RPC |
| `src/mcp/` | MCP server exposing the bridge as tools |
| `src/agent/` | The reference agent: planning loop, macros, verification |
| `gui/` | Local setup wizard and dashboard |
| `docs/` | Design notes and GUI walkthrough |
| `research/` | Research notes; not part of the shipped tool |

`src/agent/` is the largest and most delicate part. Its `loop/` directory holds
the planning loop, the diagnostic layer and the verifier; `macros/` holds the
world-editing primitives. Read `src/agent/loop.mjs`'s file header before
changing anything there — it records why several non-obvious decisions are the
way they are.

## Reporting a bug

Use the bug report template. The details that actually help:

- shapez.io version and OS,
- Node version,
- the exact command you ran,
- what you expected, what happened,
- if the agent was involved: the `transcript.jsonl` from the run directory,
  with any personal paths scrubbed.

## Security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).
