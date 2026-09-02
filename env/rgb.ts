// Minimal image decoding shared by reproducible environment artifacts.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const require = createRequire(import.meta.url);

export interface RgbImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export function decodeRgb(file: string): RgbImage {
  const bytes = readFileSync(file);
  let width: number, height: number, rgba: Uint8Array;
  if (file.toLowerCase().endsWith('.png')) {
    const image = PNG.sync.read(bytes);
    width = image.width; height = image.height; rgba = image.data;
  } else {
    const jpeg = require('jpeg-js') as { decode: (b: Buffer, o: { useTArray: boolean }) => { width: number; height: number; data: Uint8Array } };
    const image = jpeg.decode(bytes, { useTArray: true });
    width = image.width; height = image.height; rgba = image.data;
  }
  const data = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; j < data.length; i += 4, j += 3) {
    const a = rgba[i + 3]! / 255;
    data[j] = Math.round(rgba[i]! * a + 255 * (1 - a));
    data[j + 1] = Math.round(rgba[i + 1]! * a + 255 * (1 - a));
    data[j + 2] = Math.round(rgba[i + 2]! * a + 255 * (1 - a));
  }
  return { width, height, data };
}

