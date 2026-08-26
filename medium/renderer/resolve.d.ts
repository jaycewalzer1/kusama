// Types for the resolver. The implementation is resolve.js, shared with the browser.

export type Point = [number, number];
/** 2x3 affine [a,b,c,d,e,f]: x' = a*x + c*y + e, y' = b*x + d*y + f. */
export type Matrix = number[];

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Transform {
  translate?: Point;
  rotate?: number;
  scale?: number;
}

export interface ResolvedLeaf {
  id: string;
  sourceId: string;
  op: string;
  args: Record<string, unknown>;
  world: Matrix;
  rngKey: string;
  seedOffset: number;
  instance: number;
  seed: number;
  clip: Point[] | null;
  decisions: string[];
  label?: string;
  note?: string;
  expandedFrom?: string;
  bounds: Bounds;
}

export interface ResolvedGroup {
  id: string;
  sourceId: string;
  type: 'group' | 'repeat' | 'macro';
  macro?: string;
  world: Matrix;
  clip: Point[] | null;
  decisions: string[];
  label?: string;
  note?: string;
  count?: number;
  parts?: string[];
  expandedFrom?: string;
}

export interface Canvas {
  width: number;
  height: number;
  ground: string;
  brushScale: number;
}

export interface ResolvedProgram {
  version: string;
  profile: string;
  assetPack: string;
  canvas: Canvas;
  palette: Record<string, string>;
  seed: number;
  meta: Record<string, unknown>;
  nodes: ResolvedLeaf[];
  groups: ResolvedGroup[];
  warnings: string[];
  counts: { resolvedNodes: number; repeatInstances: number; groups: number };
}

export interface ResolveLimits {
  maxResolvedNodes?: number;
  maxDepth?: number;
  maxRepeatInstances?: number;
  maxRepeatNesting?: number;
}

export declare class ResolveError extends Error {}

export declare const IDENTITY: Matrix;
export declare const CLIP_CIRCLE_SEGMENTS: number;

export declare function matMul(m: Matrix, n: Matrix): Matrix;
export declare function matApply(m: Matrix, x: number, y: number): Point;
export declare function matInvert(m: Matrix): Matrix;
export declare function matScale(m: Matrix): number;
export declare function localMatrix(transform?: Transform): Matrix;

export declare function clipPolygon(subject: Point[], clip: Point[] | null): Point[];
export declare function polygonArea(pts: Point[]): number;
export declare function pointInPolygon(pt: Point, poly: Point[]): boolean;
export declare function clipPolyline(points: Point[], clip: Point[] | null): Point[][];
export declare function clipSegment(p: Point, q: Point, clip: Point[]): [Point, Point] | null;

export declare function fragmentPolygon(args: Record<string, never> | any, pack: any): Point[];
export declare function regionPolygon(region: any, pack: any, segments?: number): Point[];
export declare function styleMargin(style: any, brushScale?: number): number;
export declare function leafBounds(node: any, pack: any, brushScale?: number): Bounds;
export declare function resolveColor(name: string, palette: Record<string, string>): string;

export declare function resolveProgram(program: any, pack: any, limits?: ResolveLimits): ResolvedProgram;

export declare function fontsUsed(resolved: ResolvedProgram): string[];
