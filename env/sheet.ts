// Tiling images into a contact sheet. Pure, integer-only and deterministic, so a contact sheet is
// reproducible like everything else here.

export interface Image {
  rgba: Buffer;
  width: number;
  height: number;
}

export interface SheetOptions {
  cols: number;
  /** Each image is fitted inside a cell x cell box, preserving its aspect ratio. */
  cell: number;
  gap: number;
  background: [number, number, number];
}

/**
 * Box-average downscale. Averaging rather than sampling matters here: a contact sheet exists to show
 * whether a batch is varied, and nearest-neighbour thumbnails of brush texture alias into moire that
 * looks like variation that isn't there.
 */
export function thumbnail(src: Image, maxW: number, maxH: number): Image {
  const scale = Math.min(maxW / src.width, maxH / src.height, 1);
  const width = Math.max(1, Math.round(src.width * scale));
  const height = Math.max(1, Math.round(src.height * scale));
  const out = Buffer.allocUnsafe(width * height * 4);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * src.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * src.height) / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * src.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * src.width) / width));
      const sums = [0, 0, 0, 0];
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = 4 * (sy * src.width + sx);
          for (let c = 0; c < 4; c++) sums[c]! += src.rgba[i + c]!;
          n++;
        }
      }
      const o = 4 * (y * width + x);
      for (let c = 0; c < 4; c++) out[o + c] = Math.round(sums[c]! / n);
    }
  }
  return { rgba: out, width, height };
}

export function contactSheet(images: Image[], opts: SheetOptions): Image {
  const rows = Math.ceil(images.length / opts.cols);
  const step = opts.cell + opts.gap;
  const width = opts.cols * step + opts.gap;
  const height = rows * step + opts.gap;
  const sheet = Buffer.allocUnsafe(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const i = 4 * p;
    sheet[i] = opts.background[0];
    sheet[i + 1] = opts.background[1];
    sheet[i + 2] = opts.background[2];
    sheet[i + 3] = 0xff;
  }
  images.forEach((image, index) => {
    const thumb = thumbnail(image, opts.cell, opts.cell);
    // Centre the thumbnail in its cell, so portrait and landscape pages sit on a common grid.
    const left = opts.gap + (index % opts.cols) * step + Math.floor((opts.cell - thumb.width) / 2);
    const top = opts.gap + Math.floor(index / opts.cols) * step + Math.floor((opts.cell - thumb.height) / 2);
    for (let y = 0; y < thumb.height; y++) {
      thumb.rgba.copy(sheet, 4 * ((top + y) * width + left), 4 * y * thumb.width, 4 * (y + 1) * thumb.width);
    }
  });
  return { rgba: sheet, width, height };
}
