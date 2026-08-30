// Types for the shared (Node + browser) rng module. The implementation is rng.js.

export declare function fnv1a32(str: string): number;
export declare function deriveSeed(
  masterSeed: number,
  rngKey: string,
  repeatInstance: number,
  streamName: string,
  seedOffset?: number
): number;
export declare function nodeSeed(
  masterSeed: number,
  rngKey: string,
  repeatInstance: number,
  seedOffset?: number
): number;
export declare const STREAMS: readonly string[];
export interface Rng {
  next(): number;
  between(lo: number, hi: number): number;
  int(lo: number, hi: number): number;
}
export declare function makeRng(seed: number): Rng;
