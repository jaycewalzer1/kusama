# Thursday morning — the checklist, in order

Ten minutes, start to finish. Everything below either prints something you can read or fails
loudly. Nothing here needs credit, a model call, or the network.

Do these **before** you open the runbook. The runbook is `docs/demo/THURSDAY.md`; the deck script is
`docs/demo/SLIDES.md`.

---

## 1. Am I in the right place, on the right commit

```bash
cd ~/kusama
git rev-parse --abbrev-ref HEAD          # expect: master
git log --oneline -1                     # expect: 30f629a  wednesday: master fast-forwarded ...
git status --short                       # expect: nothing, or only files you know about
```

**There is one branch now.** `master` at `30f629a`, here and on origin, and nothing else — the
Wednesday work was fast-forwarded in and the working branches were deleted once every one of them was
an ancestor of `master`. If the commit is older than `30f629a`, **stop**: everything the demo needs
went in on Wednesday.

Nothing was lost in that cleanup: `ebd95cd` (the previous `master`), `1c3dd9e`, `cf0236f` and
`67e743b` are all still reachable from `master`, and the tag `recovery/2026-08-27` is untouched. The
second worktree at `.claude/worktrees/artmine-recs` and its branch were left in place; they are not
needed for the demo and nothing there is uncommitted.

---

## 2. Does the derived data still exist

None of this is in git. All of it is on this laptop and nowhere else.

```bash
ls -la corpus/clip.f32 corpus/clip-index.json          # ~39 MB + index
ls corpus/images | wc -l                               # expect 19807
ls .models                                             # the CLIP towers, 594 MB
ls out/condition-withheld out/openai-withheld          # the two trajectories
du -sh .browsers                                       # 478 MB
```

**If `corpus/images/` or `corpus/clip.f32` is gone, the live demo is gone with it** — four of the
five commands go quiet. Do not try to rebuild: images are hours and 19,889 HTTP fetches, embeddings
are 12 minutes. Go to §6 and present from the fallback, which is complete.

Backups from 2026-09-02, in `~/kusama-backups/`, if something needs restoring:

| archive | size | sha256 (first 16) |
|---|---|---|
| `out-2026-09-02.tgz` | 8 MB | `9d1297ebe735fecf` |
| `analytics-2026-09-02.tgz` | 19 MB | `f579df7bf1256e21` |
| `notebooks-2026-09-02.tgz` | 71 MB | `8b2b770c56acbef8` |
| `models-2026-09-02.tgz` | 374 MB | `657edaf1ae520042` |

**`corpus/images/` (3.0 GB) is not in any of them.** It was never backed up — too large — so if the
pixels are gone they are gone, and the answer is §6, not a rebuild.

---

## 3. Build once, and check the clock

```bash
npm run build            # ~1.8 s
```

Then the one-command smoke test — it exercises the text tower, the image embeddings, and the
manifest in a single call:

```bash
time node dist/studio/corpus.js search "a woodcut print of a wave" -k 5
```

**Expect: about 0.4 s, and `aic-88398 The Girls on the Bridge` at the top with `4.07  99.99`.**

If that line is right, the corpus, the embeddings, the index and both towers are all working. If it
is wrong or slow, the problem is data, not code — go to §6.

After this, **call `node dist/studio/corpus.js` directly, never `npm run corpus --`**. The `npm`
wrapper re-runs `tsc` before every command and adds 1.8 s to each.

---

## 4. Open the two pages that take time to paint

Do this now, not on stage. They are the only two slow things in the demo, and both are slow *once*.

```bash
open docs/demo/influences/withheld.html                              # 8 MB, ~1.8 s to paint
open docs/demo/rendered/atlas-condition-withheld__inf-withheld.html  # tracked, 1.7 MB
```

Leave both tabs open all morning.

Check on the atlas page: the **`the same works by metadata →`** button, top right, actually
navigates. If it 404s you are looking at a copy from `corpus/`, not the tracked one in
`docs/demo/rendered/` — reopen from the path above.

---

## 5. Warm the rest of the live path

Every command in the runbook, back to back. **7.45 s cold, 6.48 s warm, and not one byte to stderr.**

```bash
node dist/studio/corpus.js search "a page of dense handwriting" -k 12
node dist/studio/corpus.js search "being watched by something that does not blink" -k 12
node dist/studio/corpus.js influences show withheld
node dist/studio/corpus.js influences blend interference many-hands
node dist/studio/corpus.js influences lens "woven cloth, linen and thread" withheld -k 3
node dist/studio/corpus.js plates out/condition-withheld
```

Anything that prints to stderr, or takes more than ~2 s, is a change since yesterday. There is no
command in this demo that should approach the 10-second limit.

---

## 6. The fallback, which is complete and needs nothing

If the laptop is not the laptop, the data is gone, or the browser will not cooperate — all three of
these are **tracked in git** and work on any machine:

```bash
open docs/demo/screens/01-search-handwriting.png     # 11 PNGs, 1920x1080, in runbook order
cat  docs/demo/terminal/03-search-does-not-blink.txt # 12 files, the real stdout of every command
open docs/demo/video/atlas-overlay-condition-withheld.webm
open docs/demo/rendered/notebooks/02_embedding_space.html   # 8 notebooks with outputs, 4.6 MB
```

`docs/demo/terminal/` is 52 KB of plain text and survives everything short of losing the repo. It can
be catted, pasted into a chat window, or read off a phone.

---

## 7. Two things that are true and easy to forget on stage

- **The atlas page has no pan and no zoom.** Colour-by buttons, a corpus grey/coloured toggle, and a
  hover readout is the entire interactive surface. Grey is the default and the legible one — against
  19,791 coloured points the plates disappear. Do not reach for a gesture that is not there.
- **Do not run the atlas rebuild.** `atlas --clip --umap --overlay ...` is 53 s, five times the
  ten-second budget, and it produces the page that is already open.

---

## 8. If someone asks about credit

**There is none, and none was spent.** Both providers were out as of 2026-08-31 — OpenAI `429
insufficient_quota`, Anthropic balance too low. Nothing in this demo makes a model call. The two
trajectories in `out/` were made before the credit ran out and are the only model output on screen.

That is worth saying plainly rather than working around: everything demonstrated today is a
measurement over work that already exists.

---

## The one thing not to lose

The honest numbers are the point of the talk, not a disclaimer at the end of it:

- The real brief reads **+1.78 sd — the strongest reading in the demo — and is still `NOTHING
  MEASURED`**, because the ±2 band was fixed before the number was seen.
- The two finished trajectories sit at the **46.4th and 1.5th percentile** against their own
  position's influences. Fifty percent means *as near as a corpus work drawn at random*.
- **No corpus image has ever reached an artist prompt.** The wiring is written up as pending.
