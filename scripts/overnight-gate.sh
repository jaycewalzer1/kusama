#!/usr/bin/env bash
# The additive-only gate for the 2026-09-01 overnight run.
#
# It does NOT assert that recompute says "exact" or that replay says "REPLAYED".
# Neither is true at HEAD: the environment moved after these runs were recorded, so
# recompute already DIFFERS and replay already refuses with NOT COMPARABLE. Asserting
# the ideal would have meant starting the night with a red gate and learning nothing.
#
# What it asserts instead is that tonight's changes move NOTHING that was already on
# disk: the protected file bytes, and the environment hashes that replay prints as
# "now". If a change bumps observationHash/protocolHash/positionHash/briefHash, or
# rewrites a scores.json, this fails.
#
#   scripts/overnight-gate.sh --write   # capture the baseline (once, at stage 0)
#   scripts/overnight-gate.sh           # compare against it (before every commit)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
BASELINE="docs/overnight/baseline-hashes.txt"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
CUR="$TMP/current.txt"

# Trajectories that are complete enough for the gate. first-withheld has no final.json
# (replay crashes with ENOENT) and no scores.json, so it is inventory, not a gate input.
DIRS=(out/condition-withheld out/openai-withheld)

hash_of() { [ -f "$1" ] && shasum -a 256 "$1" | cut -d' ' -f1 || echo "ABSENT"; }

{
  echo "## protected bytes (rule 12: these may not move)"
  for f in corpus/manifest.jsonl corpus/clip.f32 corpus/clip-index.json aesthetic/holdout.json; do
    echo "$(hash_of "$f")  $f"
  done
  for f in aesthetic/elements/pack/*.json; do echo "$(hash_of "$f")  $f"; done
  for d in "${DIRS[@]}" out/first-withheld; do
    for f in scores.json studio.jsonl final.png final.json; do
      echo "$(hash_of "$d/$f")  $d/$f"
    done
  done

  echo
  echo "## artist recompute (output text, normalised)"
  node dist/studio/artist.js recompute "${DIRS[@]}" 2>&1 | sed "s#$ROOT#<ROOT>#g"

  echo
  echo "## artist replay (output text, normalised; the 'now' hashes are the point)"
  for d in "${DIRS[@]}"; do
    echo "--- $d"
    node dist/studio/artist.js replay "$d" -o "$TMP/replay/$(basename "$d")" 2>&1 \
      | sed "s#$ROOT#<ROOT>#g" | sed "s#$TMP#<TMP>#g"
  done
} > "$CUR" 2>&1

if [ "${1:-}" = "--write" ]; then
  mkdir -p "$(dirname "$BASELINE")"
  cp "$CUR" "$BASELINE"
  echo "GATE BASELINE WRITTEN -> $BASELINE ($(wc -l < "$BASELINE" | tr -d ' ') lines)"
  exit 0
fi

if [ ! -f "$BASELINE" ]; then
  echo "GATE ERROR: no baseline at $BASELINE. Run with --write first."
  exit 2
fi

if diff -u "$BASELINE" "$CUR" > "$TMP/diff.txt"; then
  echo "GATE PASS: nothing that was already on disk moved."
  exit 0
fi
echo "GATE FAIL: something moved."
cat "$TMP/diff.txt"
exit 1
