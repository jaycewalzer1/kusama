# Intentional sampling

Create or resume a small public-domain Met manifest (metadata only unless `--download` is present):

```bash
npm run corpus -- met ingest --output corpus/met-small --limit 250 --download
```

Build a small index from the existing local corpus, then run any of the three complete demos:

```bash
npm run samples -- index --corpus corpus --output out/sample-index --limit 100
npm run samples -- demo mountain --index out/sample-index --output out/sampling-mountain
npm run samples -- demo cross-medium --index out/sample-index --output out/sampling-cross-medium
npm run samples -- demo historical-collision --index out/sample-index --output out/sampling-collision
```

Retrieval and planning can also be inspected independently:

```bash
npm run samples -- search --index out/sample-index \
  --query "tiny solitary figure overwhelmed by a vast landscape" \
  --channels scale_relation,negative_space --top-k 12 \
  --contact-sheet out/mountain-search.png --output out/mountain-search.json

npm run samples -- plan --index out/sample-index \
  --commission examples/sampling/mountain-commission.json --seed 42 \
  --output out/mountain-plan.json

npm run samples -- compile --sampling-plan out/mountain-plan.json \
  --output out/mountain-program.json
```

Each demo writes the typed plan, selected source regions/contact sheet, native base and compiled
programs, structured provenance, and (when a scale source is present) a one-source ablation. Render
the result through the unchanged deterministic substrate:

```bash
npm run render -- out/sampling-mountain/base-program.json \
  --sampling-plan out/sampling-mountain/sampling-plan.json \
  --out out/sampling-mountain/rendered
```

Pass `--disable-sample sample_...` to `render`, or `--disable sample_...` to `samples compile`,
to produce a causal ablation without changing unrelated native node `rngKey` values.
