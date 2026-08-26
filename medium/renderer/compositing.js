// Per-leaf isolation, transforms and clip transport. Browser only.
//
// Build document section 3: before every leaf, push, reset all brush state, apply the node's world
// transform, seed from the node's key, execute, then reset all brush state again and pop. Nothing
// an operator sets may survive it.

import { matInvert, matApply, matScale } from './resolve.js';
import { deriveSeed, makeRng } from './rng.js';

/**
 * Blend names the profile may allow, mapped to p5's constants lazily -- `p` is only available at
 * draw time, and naming them as strings here keeps the profile, the schema and the renderer talking
 * about the same words.
 *
 * These three and no others. p5 2.2.0's WEBGL `blendMode` accepts a shortlist and, for anything off
 * it, does nothing at all -- OVERLAY and DIFFERENCE leave the previous mode in place and paint the
 * source unchanged, with no warning for DIFFERENCE (NOTES R11). A mode that silently no-ops is worse
 * than one that throws, so the profile may not name one.
 */
const BLEND_MODES = {
  multiply: (p) => p.MULTIPLY,
  screen: (p) => p.SCREEN,
  exclusion: (p) => p.EXCLUSION,
};

/** Clear every piece of p5.brush state that an operator could have set. */
export function resetBrushState(p, brush) {
  brush.noFill();
  brush.noStroke();
  brush.noHatch();
  brush.noField();
  brush.noWash();
  brush.noMass();
  brush.noClip();
  p.blendMode(p.BLEND);
  p.noStroke();
  p.fill(255);
}

/**
 * World transform of a leaf, applied as translate -> rotate -> scale. All our transforms are
 * similarities (translate, rotate, uniform scale), so the decomposition is exact; using it instead
 * of applyMatrix keeps us off p5's WEBGL matrix-argument overloads.
 */
export function applyWorld(p, world) {
  const [a, b, , , e, f] = world;
  const s = matScale(world);
  const deg = (Math.atan2(b, a) * 180) / Math.PI;
  p.translate(e, f);
  if (deg !== 0) p.rotate(deg);
  if (s !== 1) p.scale(s);
}

/** The node's clip polygon, expressed in the node's own local coordinates. */
export function localClip(node) {
  if (!node.clip) return null;
  const inv = matInvert(node.world);
  return node.clip.map(([x, y]) => matApply(inv, x, y));
}

/**
 * Seed everything from the node's key for one named substream, and hand back a local PRNG for
 * randomness we generate ourselves. p5's randomSeed/noiseSeed also seed p5.brush (see NOTES R2).
 */
export function makeStreams(p, masterSeed, node) {
  return (name) => {
    const seed = deriveSeed(masterSeed, node.rngKey, node.instance, name, node.seedOffset ?? 0);
    p.randomSeed(seed);
    p.noiseSeed(seed);
    return makeRng(seed);
  };
}

/**
 * Run `fn` for one leaf under full isolation.
 */
export function withLeaf(p, brush, node, masterSeed, fn) {
  p.push();
  resetBrushState(p, brush);
  // After the reset, never before it: resetBrushState sets BLEND, so a blend applied earlier would
  // be wiped. The leaf carries the blend down from the nearest enclosing group (resolve.js), which
  // is the only way to express it -- the tree is flattened and there is no group left to draw into.
  if (node.blend && node.blend !== 'normal') p.blendMode(BLEND_MODES[node.blend](p));
  applyWorld(p, node.world);
  const stream = makeStreams(p, masterSeed, node);
  // Every leaf starts from the same default stream so an operator that uses no randomness still
  // leaves the generators in a node-determined state rather than the previous node's state.
  stream('misc');
  try {
    fn(stream, localClip(node));
  } finally {
    resetBrushState(p, brush);
    p.pop();
  }
}
