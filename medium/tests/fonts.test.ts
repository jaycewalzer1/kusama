// The type library: 34 vendored faces, the v1 pack that carries them, and the two gates a face has
// to clear before it can be drawn with.
//
// These tests never launch a browser. They are the acceptance criteria for the claim the pack makes
// about type -- "the pack hash covers the bytes of the fonts" -- which is only true if the bytes on
// disk are actually the bytes the manifest says. Nothing else in the repo checks that at test time.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env/browser.js';
import { loadPack, loadPackFor, packHash, PackError, type Face, type License } from '../env/pack.js';
import { loadProfile, loadProfileFor, ProfileError } from '../env/profile.js';
import { validateProgram } from '../env/validate.js';

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'assets/fonts/manifest.json'), 'utf8')) as {
  faces: Record<string, Face>;
  licenses: Record<string, License>;
};

const coreV1 = loadPack('core-v1');
const core = loadPack('core');
const v1 = loadProfile('default-v1');
const v0 = loadProfile('default-v0');

/** The only licences this medium is prepared to ship under. A fourth would be a decision, not a fix. */
const PERMITTED_SPDX = ['OFL-1.1', 'Apache-2.0', 'UFL-1.0'];

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(path.join(ROOT, file))).digest('hex');
}

test('every vendored face on disk is byte-for-byte the file the manifest declares', () => {
  // This is the test that makes the pack hash mean something. If a face's bytes drift -- a re-fetch
  // from upstream, a stray reformat -- the pack still declares its old hash, and every render made
  // under that hash would be a render of different glyphs. Re-hashing all 34 files takes a moment;
  // that is the price of the guarantee.
  const names = Object.keys(manifest.faces);
  assert.equal(names.length, 34, 'the manifest is supposed to carry 34 vendored faces');
  for (const [name, face] of Object.entries(manifest.faces)) {
    assert.equal(statSync(path.join(ROOT, face.file)).size, face.bytes, `${name}: file size does not match the declared bytes`);
    assert.equal(sha256(face.file), face.sha256, `${name}: file contents do not match the declared sha256`);
    assert.equal(typeof face.variable, 'boolean', `${name}: does not record whether it is a variable font`);
  }
});

test('no vendored face is a variable font', () => {
  // p5 2.2.0 loads a variable font without complaint and returns sensible advance widths from it, and
  // then draws nothing at all: the metrics tables parse, the outlines never reach the WEBGL text path
  // (NOTES O6). Seven faces shipped that way and cleared the two-independent-process determinism gate
  // with a perfect score, because nothing renders byte-identically to nothing. They were replaced with
  // static families in the same role. This is the cheap standing check; the expensive one is
  // docs/substrate-test/tools/face-ink.mjs, which counts pixels.
  const variable = Object.entries(manifest.faces).filter(([, f]) => f.variable).map(([n]) => n);
  assert.deepEqual(variable, [], 'a variable face draws nothing and must not be vendored');
});

test('every face names a licence that is on disk, unmodified, and one this medium may ship', () => {
  // Licensing provenance is not decoration here: the faces are redistributed inside the repo, so the
  // licence text has to travel with them and has to be the text upstream actually published.
  for (const [name, face] of Object.entries(manifest.faces)) {
    assert.ok(face.licenseFile, `${name}: names no licence file`);
    const key = path.basename(face.licenseFile!, '.txt');
    const license = manifest.licenses[key];
    assert.ok(license, `${name}: licence file "${face.licenseFile}" has no entry in the licenses map`);
    assert.equal(license!.file, face.licenseFile, `${name}: licence entry points at a different file`);
    assert.equal(license!.spdx, face.license, `${name}: face and licence entry disagree on the SPDX id`);
    assert.ok(PERMITTED_SPDX.includes(license!.spdx), `${name}: licensed ${license!.spdx}, which is not one of ${PERMITTED_SPDX.join(', ')}`);
    assert.equal(sha256(license!.file), license!.sha256, `${name}: the licence text on disk does not match its declared sha256`);
    assert.match(face.source, /^https:\/\//, `${name}: source is not a URL`);
  }
});

test('core-v1 declares exactly the faces default-v1 allows', () => {
  // A profile that allows a face the pack does not carry is a crash at render time, once a browser is
  // already up. A pack carrying a face the profile forbids is bytes nobody can ever draw with.
  assert.deepEqual([...v1.profile.fonts].sort(), Object.keys(coreV1.faces ?? {}).sort());
});

test("core-v1's shapes are byte-identical to core's, so the two packs cannot drift", () => {
  // author.mjs reads core/pack.json rather than re-authoring the outlines. This pins that claim: v1
  // is v0 plus type, and nothing about `figure.standing` changed on the way through.
  assert.deepEqual(coreV1.fragments, core.fragments);
  assert.deepEqual(coreV1.motifs, core.motifs);
});

test('both packs on disk hash to the hash they declare', () => {
  assert.equal(packHash(core), core.hash);
  assert.equal(packHash(coreV1), coreV1.hash);
  assert.equal(coreV1.hash.slice(0, 12), 'dd47bb1c2e34');
});

test('a pack whose declared face bytes are altered no longer matches its hash', () => {
  const tampered = loadPack('core-v1');
  tampered.faces!['anton']!.sha256 = '0'.repeat(64);
  assert.notEqual(packHash(tampered), tampered.hash, 'swapping a face hash must change the pack hash');
});

test('loadProfileFor refuses a program that names no profile, and an override beats the program', () => {
  // There is deliberately no default profile: a silent fallback would let a program render against a
  // medium it never asked for, which is exactly what hashing the profile into the trace exists to stop.
  assert.throws(() => loadProfileFor({ seed: 1 }), ProfileError);
  assert.throws(() => loadProfileFor(null), ProfileError);
  assert.equal(loadProfileFor({ profile: 'default-v1' }).profile.id, 'default-v1');
  assert.equal(loadProfileFor({ profile: 'default-v1' }, 'default-v0').profile.id, 'default-v0');
});

test('loadPackFor refuses a program that names no pack, and an override beats the program', () => {
  // Same rule, same reason: a fragment name means nothing until you know which pack it was looked up in.
  assert.throws(() => loadPackFor({ seed: 1 }), PackError);
  assert.throws(() => loadPackFor(null), PackError);
  assert.equal(loadPackFor({ assetPack: 'core-v1' }).id, 'core-v1');
  assert.equal(loadPackFor({ assetPack: 'core-v1' }, 'core').id, 'core');
});

test('the v0 profile and the v0 pack still hash to the values v0 was frozen at', () => {
  // Hard-coded on purpose. The four goldens were rendered against these two artefacts; if either
  // changes, the goldens no longer describe anything and this test is the loudest way to find out.
  assert.equal(v0.hash.slice(0, 12), '15ad87c16095');
  assert.equal(core.hash.slice(0, 12), '003e484d9602');
  assert.deepEqual(v0.profile.fonts, ['grotesque', 'serif']);
  assert.deepEqual(v0.profile.assetPacks, ['core']);
});

/** A one-text-op program, the smallest thing that puts a font name through both gates. */
function textProgram(font: string, profileId: string, packId: string): Record<string, unknown> {
  return {
    version: '0.2',
    profile: profileId,
    assetPack: packId,
    canvas: { width: 400, height: 400, ground: '#fdf9f0', brushScale: 3 },
    seed: 12345,
    root: {
      id: 'root',
      type: 'group',
      children: [
        {
          id: 't1',
          type: 'op',
          op: 'text',
          rngKey: 'key-t1',
          args: { text: 'CUT IT UP', x: 40, y: 200, size: 28, font, color: '#4a3c31', align: 'left' },
        },
      ],
    },
  };
}

test('a v1 program set in a face from the type library validates clean', () => {
  const result = validateProgram(textProgram('anton', 'default-v1', 'core-v1'), v1.profile, coreV1);
  assert.deepEqual(result.issues, []);
  assert.equal(result.valid, true);
});

test('a face that exists nowhere is refused twice, once by the profile and once by the pack', () => {
  // Two gates, two issues. The profile says what this medium may speak in at all; the pack is the
  // only artefact whose hash covers the bytes the glyphs are drawn from. Neither subsumes the other.
  const codes = validateProgram(textProgram('helvetica', 'default-v1', 'core-v1'), v1.profile, coreV1).issues.map((i) => i.code);
  assert.ok(codes.includes('font.notAllowed'), `expected font.notAllowed, got ${codes.join(', ')}`);
  assert.ok(codes.includes('font.unknown'), `expected font.unknown, got ${codes.join(', ')}`);
});

test('v0 did not quietly gain the type library', () => {
  // The point of keeping v0 on disk is that it still means what it meant. It has two faces; a v1 face
  // named under it is refused by the profile gate even though the file is sitting right there.
  assert.deepEqual(validateProgram(textProgram('grotesque', 'default-v0', 'core'), v0.profile, core).issues, []);
  const codes = validateProgram(textProgram('anton', 'default-v0', 'core'), v0.profile, core).issues.map((i) => i.code);
  assert.deepEqual(codes, ['font.notAllowed']);
});

test('a pack with no faces map skips the face check instead of failing it', () => {
  // core predates `faces` entirely. The manifest gate has to be absent for it, not empty: an empty
  // map would make every font name unknown and refuse every v0 program that sets any type at all.
  assert.equal(core.faces, undefined);
  const codes = validateProgram(textProgram('serif', 'default-v0', 'core'), v0.profile, core).issues.map((i) => i.code);
  assert.deepEqual(codes, []);
});
