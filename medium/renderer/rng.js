// Seeded randomness. Shared by Node (resolve, budget) and the browser (operators).
//
// The whole point of this file is clause 5.2 of the build document: a node's randomness is derived
// from its own opaque rngKey and nothing else. Not its path, not its parent, not its index among
// siblings, not its position. That is what makes a node keep its exact marks when it is moved,
// reparented, wrapped in a new group, or preceded by an unrelated new node.

/** FNV-1a, 32 bit, over a UTF-8-ish string. Returns an unsigned int. */
export function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    const hi = str.charCodeAt(i) >>> 8;
    if (hi) {
      h ^= hi;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
}

/**
 * Node/stream seed derivation.
 * seed = fnv1a32(masterSeed, rngKey, repeatInstance, streamName, seedOffset)
 */
export function deriveSeed(masterSeed, rngKey, repeatInstance, streamName, seedOffset) {
  return fnv1a32(
    `${masterSeed >>> 0}|${rngKey}|${repeatInstance | 0}|${streamName}|${seedOffset | 0}`
  );
}

/** The seed reported for a node in resolved.json. Streams derive from the same inputs, not from this. */
export function nodeSeed(masterSeed, rngKey, repeatInstance, seedOffset) {
  return deriveSeed(masterSeed, rngKey, repeatInstance, 'node', seedOffset);
}

/** The four named substreams. Documented per operator in ops.js. */
export const STREAMS = ['placement', 'geometry', 'texture', 'misc'];

/**
 * sfc32, a small fast counter PRNG. Used for randomness we generate ourselves (repeat jitter, point
 * sampling, field marks) so that Node and the browser agree exactly. Randomness generated *inside*
 * p5.brush is seeded separately, through p5's randomSeed/noiseSeed.
 */
export function makeRng(seed) {
  let a = (seed ^ 0x9e3779b9) >>> 0;
  let b = (seed ^ 0x243f6a88) >>> 0;
  let c = (seed ^ 0xb7e15162) >>> 0;
  let d = 1;
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    d = (d + 1) >>> 0;
    t = (t + d) >>> 0;
    c = (c + t) >>> 0;
    return (t >>> 0) / 4294967296;
  };
  // Discard a few outputs so low-entropy seeds decorrelate.
  for (let i = 0; i < 12; i++) next();
  return {
    next,
    between: (lo, hi) => lo + next() * (hi - lo),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo)),
  };
}
