// PNG encoding happens in Node, from the raw RGBA readback, so the image bytes never depend on the
// browser's PNG encoder (NOTES R1).

import { PNG } from 'pngjs';
import { createHash } from 'node:crypto';

export function encodePng(rgba: Buffer, width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  rgba.copy(png.data);
  return PNG.sync.write(png, { colorType: 6, deflateLevel: 9, filterType: 0 });
}

export function decodePng(buf: Buffer): { rgba: Buffer; width: number; height: number } {
  const png = PNG.sync.read(buf);
  return { rgba: png.data, width: png.width, height: png.height };
}

/** Hash of the pixels, not of the file: this is what determinism claims are made about. */
export function pixelHash(rgba: Buffer): string {
  return createHash('sha256').update(rgba).digest('hex');
}
