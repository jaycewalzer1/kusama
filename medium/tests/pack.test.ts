// The shipped `core` pack is content-addressed and is authored by assets/packs/core/author.mjs. These
// tests are the pack's acceptance criteria: they are what "an excellent fragment" was reduced to.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPack, packHash } from '../env/pack.js';
import { loadProfile } from '../env/profile.js';

const pack = loadPack('core');
const { profile } = loadProfile('default-v0');

/** Spec §8 requires these names to exist, whatever else a pack chooses to carry. */
const REQUIRED = ['light.beam', 'mark.sponsor-a', 'mark.sponsor-b', 'mark.sponsor-c'];
const REQUIRED_PREFIXES = ['figure.', 'hand.', 'animal.', 'arch.', 'object.', 'debris.'];

test('the pack on disk hashes to the hash it declares', () => {
  assert.equal(pack.hash, packHash(pack));
  assert.equal(pack.id, 'core');
});

test('the pack carries the named vocabulary the medium promises', () => {
  const names = Object.keys(pack.fragments);
  assert.ok(names.length >= 12 && names.length <= 15, `${names.length} fragments is outside 12..15`);
  for (const name of REQUIRED) assert.ok(names.includes(name), `missing fragment "${name}"`);
  for (const prefix of REQUIRED_PREFIXES) {
    assert.ok(names.some((n) => n.startsWith(prefix)), `no fragment named ${prefix}*`);
  }
  assert.ok(Object.keys(pack.motifs).includes('hibiscus'));
});

test('every fragment is a normalized outline the profile can actually draw', () => {
  for (const [name, frag] of Object.entries(pack.fragments)) {
    const n = frag.points.length;
    assert.ok(n >= 20 && n <= profile.limits.maxPolygonPoints, `${name}: ${n} points`);
    for (const [x, y] of frag.points) {
      assert.ok(Number.isFinite(x) && Number.isFinite(y), `${name}: non-finite point`);
      assert.ok(Math.abs(x) <= 0.5 + 1e-9 && Math.abs(y) <= 0.5 + 1e-9, `${name}: [${x}, ${y}] escapes the unit box`);
    }
    // Normalized means the outline touches the unit box on its longer axis, so `span` means the same
    // thing for every fragment: two fragments placed at the same span are the same size on the page.
    const w = Math.max(...frag.points.map((p) => p[0])) - Math.min(...frag.points.map((p) => p[0]));
    const h = Math.max(...frag.points.map((p) => p[1])) - Math.min(...frag.points.map((p) => p[1]));
    assert.ok(Math.abs(Math.max(w, h) - 1) < 1e-3, `${name}: longest axis is ${Math.max(w, h)}, not 1`);
  }
});

test('every motif part is a primitive in the unit box, not another macro', () => {
  for (const [name, motif] of Object.entries(pack.motifs)) {
    assert.ok(motif.parts.length > 0, `${name}: no parts`);
    for (const part of motif.parts) {
      assert.ok(part.type === 'stroke' || part.type === 'paint', `${name}: part type "${part.type}"`);
      const points =
        part.type === 'stroke'
          ? part.points
          : ((part.region as { points?: [number, number][] }).points ?? []);
      for (const [x, y] of points) {
        assert.ok(Math.abs(x) <= 0.5 + 1e-9 && Math.abs(y) <= 0.5 + 1e-9, `${name}: [${x}, ${y}] escapes the unit box`);
      }
    }
  }
});
