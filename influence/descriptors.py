"""Per-layer pixel descriptors: one image in, four fixed-length float vectors out.

This is the only part of the influence layer that is not TypeScript. It exists because the six
operators it needs -- Otsu, Lab k-means, a Gabor bank, LBP, Canny and a structure tensor -- are all
battle-tested in scikit-image/scikit-learn/OpenCV and reimplementing them in TS would be six new
things to get subtly wrong. It is a *worker*, not a library: it reads paths on stdin and writes
JSONL on stdout, so the 19,889-image cache run pays for one interpreter start rather than 19,889.

Nothing here is optional to the repo. `influence/.venv` is gitignored and `influence/requirements.txt`
is tracked; a clone without the venv gets a skipped test and a refusal with instructions in it,
never a crash. See docs/influence/README.md.

## The three policy decisions, stated once and applied everywhere

**Resize.** Every layer is computed on the image resized so its LONGEST side is 512px, with the
aspect ratio kept. One policy for all four layers, not just texture, because a descriptor set whose
layers disagree about scale cannot be concatenated or z-scored against a single set of corpus stats.
Downscales use INTER_AREA (a box filter -- the only correct choice for minification; INTER_LINEAR
aliases and would put the sampling grid into the Gabor energies). Images already smaller than 512 on
their long side are LEFT ALONE rather than upscaled: upsampling invents no detail, and stretching a
thumbnail to 512 would hand the texture layer a smooth image and report it as a fact about the work.
That asymmetry is deliberate and is why `smallSide` is reported per image.

**Colour.** Input bytes are assumed sRGB. Conversion to CIELAB goes through skimage's `rgb2lab`,
which gamma-decodes properly rather than treating the byte value as linear light; a naive conversion
puts a systematic bias into every L* and therefore into the palette layer's L mean, which is one of
the numbers Stage 2 asks whether copyists hold. Luminance everywhere in this file means **L\\***, not
the 0.299/0.587/0.114 broadcast luma -- Otsu, the armature grid and the gradients all read L*, so
"bright" means perceptually bright and one image's threshold is comparable to another's.

**Grayscale and alpha.** A single-channel image is promoted to three identical channels; its chroma
then measures 0, which is the true answer and not a missing value. An image with alpha is composited
onto WHITE before anything else runs. White because these are works on paper and a museum scan's
transparent region is the sheet, and because compositing onto black would drag every L* toward 0 and
turn a transparency into a tonal claim. Palette images are expanded to RGB first, so a GIF's index
never reaches the arithmetic. 16-bit input is scaled to 8-bit; CMYK is converted through PIL.

## Determinism

k-means is seeded (`random_state=0`, `n_init=10`) and every other operator here is a pure function of
the pixels. The same file therefore describes identically on every run, which is what lets the
goldens in `influence/tests/` pin the descriptor version at all.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from skimage.color import rgb2lab
from skimage.feature import canny, local_binary_pattern, structure_tensor
from skimage.filters import gabor_kernel, threshold_otsu
from sklearn.cluster import KMeans

# --- the shape of the answer --------------------------------------------------------------------
#
# These four numbers are the contract with the TypeScript side. `influence/descriptors.json` is
# written from them by `--spec` so the two sides cannot drift apart silently.

GRID = 16  # armature's downsampled luminance grid is GRID x GRID
PALETTE_K = 6  # k-means clusters in Lab
GABOR_SCALES = 4
GABOR_ORIENTATIONS = 6
LBP_P = 8  # LBP neighbours; the uniform histogram then has P + 2 = 10 bins
LBP_BINS = LBP_P + 2
EDGE_HARDNESS_BINS = 8
ORIENTATION_BINS = 12
LONG_SIDE = 512

DIMS = {
    # 256 grid + aspect + area + centroid(2) + symmetry(2)
    "armature": GRID * GRID + 6,
    # 6 Lab centres (18) + 6 area fractions + L mean + L std + chroma mean
    "palette": PALETTE_K * 3 + PALETTE_K + 3,
    # (mean, std) per Gabor filter + the LBP histogram
    "texture": GABOR_SCALES * GABOR_ORIENTATIONS * 2 + LBP_BINS,
    # edge hardness + curvature(3) + elongation + orientation histogram
    "form": EDGE_HARDNESS_BINS + 3 + 1 + ORIENTATION_BINS,
}
LAYERS = ("armature", "palette", "texture", "form")

DESCRIPTOR_VERSION = "v1"


def source_hash() -> str:
    """sha256 of this file. Folded into the version so an edit here invalidates a cache."""
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def version() -> dict:
    return {
        "version": DESCRIPTOR_VERSION,
        "sourceSha256": source_hash(),
        "dims": DIMS,
        "layers": list(LAYERS),
        "longSide": LONG_SIDE,
        "grid": GRID,
        "paletteK": PALETTE_K,
        "gabor": {"scales": GABOR_SCALES, "orientations": GABOR_ORIENTATIONS},
        "lbp": {"p": LBP_P, "r": 1, "bins": LBP_BINS},
        "edgeHardnessBins": EDGE_HARDNESS_BINS,
        "orientationBins": ORIENTATION_BINS,
    }


# --- loading ------------------------------------------------------------------------------------


def load_rgb(path: str) -> np.ndarray:
    """An HxWx3 uint8 sRGB array, alpha composited onto white. See the module docstring."""
    with Image.open(path) as im:
        im.load()
        if im.mode in ("P", "PA"):
            im = im.convert("RGBA" if "A" in im.mode or "transparency" in im.info else "RGB")
        if im.mode in ("RGBA", "LA"):
            rgba = im.convert("RGBA")
            bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
            im = Image.alpha_composite(bg, rgba).convert("RGB")
        elif im.mode == "I;16" or im.mode == "I":
            arr = np.asarray(im).astype(np.float64)
            hi = arr.max() if arr.max() > 0 else 1.0
            im = Image.fromarray((arr / hi * 255.0).astype(np.uint8)).convert("RGB")
        else:
            im = im.convert("RGB")
        return np.asarray(im, dtype=np.uint8)


def resized(rgb: np.ndarray) -> np.ndarray:
    """Longest side to LONG_SIDE, never upscaled. INTER_AREA on the way down."""
    h, w = rgb.shape[:2]
    long_side = max(h, w)
    if long_side <= LONG_SIDE:
        return rgb
    scale = LONG_SIDE / long_side
    return cv2.resize(rgb, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA)


# --- the four layers ------------------------------------------------------------------------------


def armature(lab: np.ndarray) -> list[float]:
    """A 16x16 luminance grid, plus where the ink is and how symmetric it is.

    The grid is normalised to [0,1] by L*'s own fixed range (0..100), NOT by this image's own min and
    max. Per-image normalisation would make a flat grey sheet and a full-contrast print produce the
    same grid, which is the opposite of what the armature layer is for.
    """
    lum = lab[:, :, 0]
    grid = cv2.resize(lum, (GRID, GRID), interpolation=cv2.INTER_AREA) / 100.0

    # Otsu needs two modes to separate. A sheet of one flat tone has one, and `threshold_otsu`
    # returns a meaningless cut rather than failing, so the degenerate case is caught by hand and
    # reported as an empty foreground rather than as a random half of the image.
    if float(lum.max() - lum.min()) < 1e-6:
        mask = np.zeros(lum.shape, dtype=bool)
    else:
        mask = lum < threshold_otsu(lum)  # ink is darker than ground

    area = float(mask.mean())
    if mask.any():
        ys, xs = np.nonzero(mask)
        h, w = mask.shape
        # Silhouette aspect: the bounding box of the foreground, width over height. Reported as a
        # ratio rather than a log because 0 is not attainable and the z-score handles the skew.
        bw = float(xs.max() - xs.min() + 1)
        bh = float(ys.max() - ys.min() + 1)
        aspect = bw / bh
        cx = float(xs.mean()) / w
        cy = float(ys.mean()) / h
        # Symmetry as intersection-over-union of the mask with its own mirror -- the same definition
        # aesthetic/metrics.ts uses for RenderMetrics.symmetry, so the two are comparable.
        h_sym = _iou(mask, np.fliplr(mask))
        v_sym = _iou(mask, np.flipud(mask))
    else:
        aspect, cx, cy, h_sym, v_sym = 1.0, 0.5, 0.5, 0.0, 0.0

    return [*grid.flatten().astype(float).tolist(), aspect, area, cx, cy, h_sym, v_sym]


def _iou(a: np.ndarray, b: np.ndarray) -> float:
    union = np.logical_or(a, b).sum()
    if union == 0:
        return 0.0
    return float(np.logical_and(a, b).sum() / union)


def palette(lab: np.ndarray) -> list[float]:
    """k=6 k-means in Lab, clusters sorted by area, then three whole-image tone numbers.

    Sorting by area is what makes the vector comparable across images: cluster index out of k-means
    is arbitrary, so an unsorted vector would report a relabelling as a difference in palette.
    """
    flat = lab.reshape(-1, 3)
    # k-means over 260k pixels is slower than it needs to be and adds nothing: a palette is a
    # property of the colour distribution, which a fixed subsample estimates just as well. Seeded,
    # so the subsample is the same every run.
    if flat.shape[0] > 20000:
        rng = np.random.default_rng(0)
        flat = flat[rng.choice(flat.shape[0], 20000, replace=False)]

    # Fewer distinct colours than clusters (a two-tone print) makes k-means emit duplicate centres.
    # That is a true description of the image, so it is kept rather than special-cased -- but
    # n_init is fixed so the duplicates land deterministically.
    km = KMeans(n_clusters=PALETTE_K, random_state=0, n_init=10).fit(flat)
    counts = np.bincount(km.labels_, minlength=PALETTE_K).astype(float)
    fractions = counts / counts.sum()
    order = np.argsort(-fractions)

    centres = km.cluster_centers_[order]
    fracs = fractions[order]

    ell = lab[:, :, 0]
    chroma = np.sqrt(lab[:, :, 1] ** 2 + lab[:, :, 2] ** 2)
    return [
        *centres.flatten().astype(float).tolist(),
        *fracs.astype(float).tolist(),
        float(ell.mean()),
        float(ell.std()),
        float(chroma.mean()),
    ]


_GABOR_KERNELS: list[np.ndarray] | None = None


def gabor_kernels() -> list[np.ndarray]:
    """4 scales x 6 orientations, built once per process.

    Frequencies are one octave apart from 0.05 to 0.4 cycles/px. The bank is fixed rather than
    derived from the image so that one image's texture vector means the same thing as another's.
    """
    global _GABOR_KERNELS
    if _GABOR_KERNELS is None:
        kernels = []
        for scale in range(GABOR_SCALES):
            frequency = 0.05 * (2**scale)
            for o in range(GABOR_ORIENTATIONS):
                theta = np.pi * o / GABOR_ORIENTATIONS
                kernels.append(np.real(gabor_kernel(frequency, theta=theta)))
        _GABOR_KERNELS = kernels
    return _GABOR_KERNELS


def texture(lab: np.ndarray) -> list[float]:
    """Gabor energy (mean and std per filter) then a uniform LBP histogram."""
    lum = (lab[:, :, 0] / 100.0).astype(np.float64)
    out: list[float] = []
    for kernel in gabor_kernels():
        # 'symm' rather than zero padding: a zero border against a light sheet is a hard synthetic
        # edge, and it lands in every filter's energy as if the work had a black frame.
        response = cv2.filter2D(lum, -1, kernel, borderType=cv2.BORDER_REFLECT)
        out.append(float(np.abs(response).mean()))
        out.append(float(np.abs(response).std()))

    lbp = local_binary_pattern((lum * 255).astype(np.uint8), LBP_P, 1, method="uniform")
    hist, _ = np.histogram(lbp, bins=LBP_BINS, range=(0, LBP_BINS))
    total = hist.sum()
    out.extend((hist / total).astype(float).tolist() if total else [0.0] * LBP_BINS)
    return out


def form(lab: np.ndarray) -> list[float]:
    """Edge hardness, contour curvature, elongation, and a stroke-orientation histogram."""
    lum = (lab[:, :, 0] / 100.0).astype(np.float64)

    # Edge hardness: how steep the gradient is *where there is an edge at all*. Canny picks the
    # edges; Sobel measures how abruptly each one turns over. Bin edges are FIXED on [0,1] rather
    # than scaled to this image's maximum, so "hard" means the same thing in every image -- a
    # per-image normalisation would report a faint pencil study and a hard-edged poster identically.
    edges = canny(lum, sigma=1.0)
    gx = cv2.Sobel(lum, cv2.CV_64F, 1, 0, ksize=3)
    gy = cv2.Sobel(lum, cv2.CV_64F, 0, 1, ksize=3)
    mag = np.sqrt(gx**2 + gy**2)
    if edges.any():
        hard, _ = np.histogram(np.clip(mag[edges], 0, 1), bins=EDGE_HARDNESS_BINS, range=(0, 1))
        hardness = (hard / hard.sum()).astype(float).tolist() if hard.sum() else [0.0] * EDGE_HARDNESS_BINS
    else:
        hardness = [0.0] * EDGE_HARDNESS_BINS

    curvature, elongation = _contour_stats(lum)

    # Structure tensor: the dominant orientation per pixel, weighted by how anisotropic that pixel
    # is. Weighting matters -- flat areas have an orientation too, it is just noise, and an
    # unweighted histogram is mostly a picture of the paper.
    axx, axy, ayy = structure_tensor(lum, sigma=1.0, order="rc")
    orientation = 0.5 * np.arctan2(2 * axy, axx - ayy)  # in [-pi/2, pi/2]
    coherence = np.sqrt((axx - ayy) ** 2 + 4 * axy**2)
    bins = np.histogram(
        np.mod(orientation, np.pi), bins=ORIENTATION_BINS, range=(0, np.pi), weights=coherence
    )[0]
    total = bins.sum()
    orient = (bins / total).astype(float).tolist() if total else [0.0] * ORIENTATION_BINS

    return [*hardness, *curvature, elongation, *orient]


def _contour_stats(lum: np.ndarray) -> tuple[list[float], float]:
    """Mean/std absolute turning angle and the straight-segment fraction over the top 20 contours,
    plus the elongation of the largest.

    Curvature is the turning angle between consecutive edges of the contour polygon, which is the
    discrete curvature and needs no fitting. Contours are approximated first (`approxPolyDP` at 0.5%
    of the perimeter) because raw OpenCV contours are pixel-staircase polygons whose every vertex
    turns 90 degrees -- measuring those would report the rasteriser, not the drawing.
    """
    if float(lum.max() - lum.min()) < 1e-6:
        return [0.0, 0.0, 0.0], 1.0
    mask = (lum < threshold_otsu(lum)).astype(np.uint8)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:20]
    if not contours:
        return [0.0, 0.0, 0.0], 1.0

    turns: list[float] = []
    for c in contours:
        if len(c) < 4:
            continue
        approx = cv2.approxPolyDP(c, 0.005 * cv2.arcLength(c, True), True).reshape(-1, 2).astype(np.float64)
        if len(approx) < 3:
            continue
        d = np.diff(np.vstack([approx, approx[:1]]), axis=0)
        ang = np.arctan2(d[:, 1], d[:, 0])
        turn = np.abs(np.mod(np.diff(np.concatenate([ang, ang[:1]])) + np.pi, 2 * np.pi) - np.pi)
        turns.extend(turn.tolist())

    if not turns:
        curvature = [0.0, 0.0, 0.0]
    else:
        arr = np.asarray(turns)
        # "Straight" is a turn under 5 degrees. A threshold rather than a continuous statistic
        # because the question the form layer is asking is categorical: does this artist build from
        # straight runs or from curves.
        curvature = [float(arr.mean()), float(arr.std()), float((arr < np.deg2rad(5)).mean())]

    (_, _), (w, h), _ = cv2.minAreaRect(contours[0])
    short, long = min(w, h), max(w, h)
    elongation = float(long / short) if short > 1e-6 else 1.0
    return curvature, elongation


# --- the entry point ------------------------------------------------------------------------------


def describe(path: str) -> dict:
    rgb = resized(load_rgb(path))
    lab = rgb2lab(rgb.astype(np.float64) / 255.0)
    out = {
        "armature": armature(lab),
        "palette": palette(lab),
        "texture": texture(lab),
        "form": form(lab),
        "height": int(rgb.shape[0]),
        "width": int(rgb.shape[1]),
    }
    for layer in LAYERS:
        got = len(out[layer])
        if got != DIMS[layer]:
            raise AssertionError(f"{layer} produced {got} floats, expected {DIMS[layer]}")
        if not all(np.isfinite(out[layer])):
            raise AssertionError(f"{layer} produced a non-finite value")
    return out


def main() -> int:
    args = sys.argv[1:]
    if "--spec" in args:
        json.dump(version(), sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
        return 0
    if "--describe" in args:
        path = args[args.index("--describe") + 1]
        json.dump(describe(path), sys.stdout, sort_keys=True)
        sys.stdout.write("\n")
        return 0

    # Worker mode: one JSON object per line in, one per line out, flushed per line so the caller can
    # show progress and so a kill costs at most one image.
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        path = req["path"]
        try:
            result = describe(path)
            result["path"] = path
            result["ok"] = True
        except Exception as e:  # noqa: BLE001 - a bad image must not kill a 19,889-image run
            result = {"path": path, "ok": False, "error": f"{type(e).__name__}: {e}"}
        json.dump(result, sys.stdout, sort_keys=True)
        sys.stdout.write("\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
