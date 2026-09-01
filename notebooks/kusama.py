"""One way into this repo's data from Python, so the notebooks never reimplement the pipeline.

The rule this module exists to enforce: **the notebooks read, they do not recompute**. Every number
in `corpus/` is produced by TypeScript — the sha256 dedupe, the kNN, the band, the tokenizer. A
second implementation in pandas would be a second thing that can disagree with the first, and
nothing would notice, because a wrong cosine is still a plausible cosine.

So:

* the manifest arrives as the CSV that `corpus export-analytics` writes, already joined and already
  flagged for duplicates, not as a re-parse of `manifest.jsonl`;
* the kNN arrives as the CSV, not as a `numpy` argsort;
* the text tower arrives over a subprocess, because CLIP's tokenizer is the piece most likely to be
  ported subtly wrong and a wrong tokenizer returns a vector rather than an error.

`load_clip()` is the one exception — reading a flat float32 matrix is not an algorithm.

Every loader raises `FileNotFoundError` naming the command that produces the file it wanted, because
these notebooks will be opened on a machine where the derived files were never built.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
CORPUS = ROOT / "corpus"
ANALYTICS = CORPUS / "analytics"
IMAGES = CORPUS / "images"
INFLUENCES = ROOT / "aesthetic" / "influences"
OUT = ROOT / "notebooks" / "out"

DIM = 512


def _need(path: Path, command: str) -> Path:
    if not path.exists():
        raise FileNotFoundError(
            f"{path.relative_to(ROOT) if path.is_relative_to(ROOT) else path} is not on this "
            f"machine.\nIt is derived and gitignored. Build it with:\n    {command}"
        )
    return path


# --- the corpus ------------------------------------------------------------------------------------


@lru_cache(maxsize=1)
def load_manifest() -> pd.DataFrame:
    """One row per manifest work — 20,000 of them, including the 98 that share bytes with another.

    `is_duplicate_of_kept_row` is the sha256 dedupe as a column. Filter on it before any similarity
    work; `embedding_row` is non-null exactly on the rows that survived it.
    """
    csv = _need(ANALYTICS / "manifest.csv", "npm run corpus -- export-analytics")
    df = pd.read_csv(csv, dtype={"date_begin": "Int64", "date_end": "Int64"}, low_memory=False)
    df["is_duplicate_of_kept_row"] = df["is_duplicate_of_kept_row"].astype(bool)
    df["is2D"] = df["is2D"].astype("Int64")
    df["has_image"] = df["has_image"].astype(bool)
    return df


@lru_cache(maxsize=1)
def load_knn() -> pd.DataFrame:
    """The k=20 appearance neighbours of every distinct image, one row per (image, rank).

    `same_museum` against `chance()` is the only honest way to read this table: the three museums
    contributed 34%/16%/50% of the corpus, so two works drawn at random already share a museum 39.0%
    of the time.
    """
    csv = _need(ANALYTICS / "knn-k20.csv", "npm run corpus -- export-analytics")
    return pd.read_csv(csv)


@lru_cache(maxsize=1)
def load_clip_file() -> tuple[np.ndarray, list[str]]:
    """`corpus/clip.f32` exactly as written: (19807, 512) float32, plus its sha256 row order.

    This is the file, not the corpus. 16 of its rows name an image no manifest work claims, so the
    pipeline's own row count is 16 lower — see `load_clip()`, which is the one you want.
    """
    f32 = _need(CORPUS / "clip.f32", "npm run corpus -- embed")
    index = _need(CORPUS / "clip-index.json", "npm run corpus -- embed")
    order = json.loads(index.read_text())
    rows = np.fromfile(f32, dtype=np.float32).reshape(-1, DIM)
    assert rows.shape[0] == len(order), f"{rows.shape[0]} rows but {len(order)} sha256s"
    return rows, order


@lru_cache(maxsize=1)
def load_clip() -> tuple[np.ndarray, list[str]]:
    """The corpus in appearance space: (19791, 512) float32, plus the sha256 of each row.

    Row `i` here is `embedding_row == i` in `load_manifest()`, so the two join on an integer. Two
    filters have already been applied and neither is optional:

    * **sha256 dedupe.** 98 manifest works share bytes with another work (a knife and fork, shot
      once, catalogued twice). Skipping this has already produced two wrong numbers in this project.
    * **16 rows dropped.** `clip.f32` holds 19,807 rows; 16 of them are images no manifest work
      claims. They are in the file because the embed pass ran over the image directory.

    Rows are unit length, so `X @ X.T` is cosine — but see `band()` before reading any of it.
    """
    rows, order = load_clip_file()
    m = load_manifest()
    kept = m[m["embedding_row"].notna()].sort_values("embedding_row")
    at = {sha: i for i, sha in enumerate(order)}
    take = [at[s] for s in kept["sha256"]]
    return rows[take], list(kept["sha256"])


def run_cli(*args: str, timeout: int = 900) -> str:
    """`node dist/studio/corpus.js <args>` — the way to reach a measurement that has no export.

    `corpus surface` and `corpus audit` are pixel measurements with careful definitions (a sheet's
    ground, an untouched margin, a permutation baseline). Recomputing them in PIL to get them into a
    notebook would be exactly the second implementation this module exists to avoid, so the notebook
    prints the CLI's own words instead.
    """
    proc = subprocess.run(
        ["node", "dist/studio/corpus.js", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        return f"`corpus {' '.join(args)}` exited {proc.returncode}:\n{proc.stdout}{proc.stderr}"
    return proc.stdout


def load_text_tower(phrases: list[str] | str) -> np.ndarray:
    """CLIP text embeddings, over a subprocess to the TypeScript CLI. Returns (len(phrases), 512).

    Deliberately not a Python implementation. The tokenizer is byte-BPE with two special tokens and
    a pool at the eos position; get any of that wrong and you still get 512 finite numbers back.
    """
    if isinstance(phrases, str):
        phrases = [phrases]
    proc = subprocess.run(
        ["node", "dist/studio/corpus.js", "embed-text", *phrases],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            "the text tower is not available on this machine.\n"
            f"{proc.stdout.strip()}\n{proc.stderr.strip()}"
        )
    return np.array(json.loads(proc.stdout)["vectors"], dtype=np.float32)


@lru_cache(maxsize=1)
def band() -> dict:
    """The corpus pair-similarity band. Every cosine in this project is meaningless without it.

    From a 1,500-work stride sample: min 0.156, median 0.643, max 0.969 over 1,124,250 pairs. CLIP
    image embeddings sit in a narrow cone, so 0.74 is not "similar" — it is slightly above typical.
    """
    return json.loads(_need(ANALYTICS / "band.json", "npm run corpus -- export-analytics").read_text())


def chance(k: int, n: int) -> float:
    """The share of k-nearest lists a random draw would fill from a group of size k out of n.

    Sampling without replacement, so it is (k-1)/(n-1) and not k/n — the query work is not its own
    neighbour. Sum this over group sizes to get the "two random works agree" baseline.
    """
    if n <= 1:
        return 0.0
    return (k - 1) / (n - 1)


def museum_chance() -> float:
    """P(two distinct corpus images share a museum) = 0.3897. Not 1/3."""
    return band()["sameMuseumChance"]


# --- the artist ------------------------------------------------------------------------------------


def load_influences(position: str) -> dict:
    """A resolved influence set: an artist's background as weights over the corpus.

    This is retrieval, not reading. Each work is here because its *photograph* is near a phrase
    lifted verbatim out of the position file. Nothing has looked at any of them.
    """
    f = INFLUENCES / f"{position}.resolved.json"
    if not f.exists():
        have = sorted(p.stem.removesuffix(".resolved") for p in INFLUENCES.glob("*.resolved.json"))
        raise FileNotFoundError(
            f"no resolved influences for {position!r}. On disk: {', '.join(have) or '(none)'}\n"
            f"Build it with:\n    npm run corpus -- influences resolve {position}"
        )
    return json.loads(f.read_text())


def influence_ids() -> list[str]:
    return sorted(p.name.removesuffix(".resolved.json") for p in INFLUENCES.glob("*.resolved.json"))


def load_trajectory(dir: str | Path) -> dict:
    """A run's plate sidecar — every plate placed in the corpus's space.

    Returns the parsed `scores.corpus.json` with a `vectors` key added, (n_plates, 512) float32 in
    the sidecar's own plate order. Does not touch `scores.json`.
    """
    d = Path(dir)
    if not d.is_absolute():
        d = ROOT / d
    sidecar = _need(d / "scores.corpus.json", f"npm run corpus -- plates {dir}")
    data = json.loads(sidecar.read_text())
    matrix = d / "plates.clip.f32"
    data["vectors"] = (
        np.fromfile(matrix, dtype=np.float32).reshape(-1, DIM) if matrix.exists() else None
    )
    data["dir"] = str(d)
    return data


def trajectory_dirs() -> list[str]:
    """Run directories that have a sidecar, relative to the repo root."""
    return sorted(
        str(p.parent.relative_to(ROOT)) for p in (ROOT / "out").glob("*/scores.corpus.json")
    )


# --- pictures --------------------------------------------------------------------------------------


def thumb(sha256: str, size: int = 96) -> Image.Image:
    """One corpus image, fitted into a `size` box. Missing files come back as a grey square.

    A hole rather than an exception: these grids are read against a caption list, and one raise
    partway through a 48-cell grid is less informative than 47 pictures and a grey square.
    """
    f = IMAGES / f"{sha256}.jpg"
    if not f.exists():
        return Image.new("RGB", (size, size), (40, 40, 40))
    im = Image.open(f).convert("RGB")
    im.thumbnail((size, size), Image.LANCZOS)
    return im


def thumb_grid(sha_list: list[str], cols: int = 8, size: int = 96, gap: int = 4) -> Image.Image:
    """A contact sheet. Kept small on purpose — these are committed inside notebook outputs."""
    n = len(sha_list)
    rows = max(1, -(-n // cols))
    cell = size + gap
    sheet = Image.new("RGB", (cols * cell + gap, rows * cell + gap), (24, 24, 24))
    for i, sha in enumerate(sha_list):
        im = thumb(sha, size)
        x = gap + (i % cols) * cell + (size - im.width) // 2
        y = gap + (i // cols) * cell + (size - im.height) // 2
        sheet.paste(im, (x, y))
    return sheet


# --- reading numbers honestly ------------------------------------------------------------------------


@dataclass
class Reading:
    """A measurement and the baseline it has to beat before it means anything."""

    name: str
    value: float
    baseline: float
    unit: str = ""

    @property
    def ratio(self) -> float:
        return float("inf") if self.baseline == 0 else self.value / self.baseline

    def __str__(self) -> str:
        if self.baseline == 0:
            return f"{self.name}: {self.value:.4f}{self.unit} (no baseline — NOTHING MEASURED)"
        verdict = "at chance" if abs(self.ratio - 1) < 0.05 else f"{self.ratio:.2f}x chance"
        return (
            f"{self.name}: {self.value:.4f}{self.unit} vs {self.baseline:.4f}{self.unit} — {verdict}"
        )


def report(*readings: Reading) -> None:
    for r in readings:
        print(r)
