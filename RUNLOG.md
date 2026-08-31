# Overnight run log — 2026-08-31

One line per milestone. Written as it happens.

- `f749171` snapshot: the L2-condition work committed (24 modified + 3 new deliverables). Baseline verified before the commit on the identical tree: `rm -rf dist && npm test` = 379 pass / 0 fail, 11 goldens green.
- `docs/KUSAMA_RESEARCH_EVIDENCE.md` does not exist in the repo. Proceeding from the stage specs alone.
- `out/` is gitignored (`.gitignore:14`), so `out/condition-withheld` and `out/openai-withheld` are untracked working-tree data. Not touched.
- Stage 1 done. Verbalized sampling at FIND and PROPOSE (new short call before SKETCH). 394 tests / 0 fail, 11 goldens. Found: xorshift32 near small seeds returns nearly the same first value for seeds 1/2/3 — a weighted draw came back 400/400 on the heavy candidate. Fixed with a 6-turn warm-up; the test caught it, not inspection.
