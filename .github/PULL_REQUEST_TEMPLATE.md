## What this changes

<!-- One or two sentences. What behaviour is different after this PR? -->

## Why

<!-- The problem this solves. If it came from a real failure, say what the
     symptom was — the log line, what the world looked like. -->

## How it was verified

<!-- Which commands you ran, and what they printed. "Tests pass" alone is not
     enough if the change touches anything that needs a running game. -->

- [ ] `node --test src/agent/` passes
- [ ] `node scripts/smoke_test.mjs` passes
- [ ] Verified against a running game (if the change touches the mod, bridge or world-editing code)

## Checklist

- [ ] Tests that cover the change are included, and fail without it
- [ ] If a defect was fixed, a comment records the observable symptom
- [ ] Docs updated in this same PR for any behaviour, config or interface change
- [ ] No secrets, tokens, real user data, or absolute local paths added
- [ ] No unrelated changes bundled in
