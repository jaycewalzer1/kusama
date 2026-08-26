// Authoring script for the `core-v1` asset pack. Run `node assets/packs/core-v1/author.mjs`.
//
// core-v1 is core plus a type library. The shapes are not re-authored here: they are read from
// core/pack.json, so there is exactly one definition of `figure.standing` in the repo and the two
// packs cannot drift. What v1 adds is `faces`, taken wholesale from assets/fonts/manifest.json,
// which is what makes the pack hash cover the bytes of every font file the medium can draw with.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash } from '../../../dist/env/profile.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEDIUM = path.join(HERE, '..', '..', '..');

const core = JSON.parse(readFileSync(path.join(MEDIUM, 'assets/packs/core/pack.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(path.join(MEDIUM, 'assets/fonts/manifest.json'), 'utf8'));

/**
 * The two v0 faces keep their names and their files. They are not in the Google Fonts manifest --
 * they were vendored before it existed -- so they are declared here by hand, with the same shape as
 * every other face, and hashed the same way.
 */
const LEGACY = {
  grotesque: {
    family: 'the face vendored as fonts/grotesque.ttf in V0',
    role: 'display',
    file: 'fonts/grotesque.ttf',
    license: 'OFL-1.1',
    licenseFile: 'fonts/OFL.txt',
    source: 'vendored in V0; see fonts/OFL.txt',
    variable: false,
  },
  serif: {
    family: 'the face vendored as fonts/serif.ttf in V0',
    role: 'serif',
    file: 'fonts/serif.ttf',
    license: 'OFL-1.1',
    licenseFile: 'fonts/OFL.txt',
    source: 'vendored in V0; see fonts/OFL.txt',
    variable: false,
  },
};

const { createHash } = await import('node:crypto');
const sha256 = (file) => createHash('sha256').update(readFileSync(path.join(MEDIUM, file))).digest('hex');

const faces = {};
for (const [name, f] of Object.entries(LEGACY)) {
  faces[name] = { ...f, bytes: readFileSync(path.join(MEDIUM, f.file)).length, sha256: sha256(f.file) };
}
for (const [name, f] of Object.entries(manifest.faces)) faces[name] = f;

/**
 * The legacy faces' licence, which the manifest cannot supply for the same reason it cannot supply
 * the faces: it did not exist when they were vendored. Keyed `OFL` because the key is the licence
 * file's basename everywhere else, and a pack that carries a face pointing at `fonts/OFL.txt` with
 * no entry under `OFL` is a pack shipping type whose terms it does not itself carry.
 *
 * `source` is not a URL and is not going to become one by guessing. The text names ParaType and the
 * Reserved Font Names "PT Sans", which is a real fact about what these two files are; where the
 * bytes were fetched from in V0 is not recorded anywhere, and writing a plausible Google Fonts URL
 * here would be inventing provenance rather than citing it.
 */
const LEGACY_LICENSE = {
  OFL: {
    spdx: 'OFL-1.1',
    file: 'fonts/OFL.txt',
    sha256: sha256('fonts/OFL.txt'),
    source: 'vendored in V0 with no recorded origin; the text is SIL OFL 1.1 as published by ParaType for the PT family',
  },
};

const pack = {
  id: 'core-v1',
  fragments: core.fragments,
  motifs: core.motifs,
  faces,
  licenses: { ...LEGACY_LICENSE, ...manifest.licenses },
};
pack.hash = contentHash(pack);

writeFileSync(path.join(HERE, 'pack.json'), `${JSON.stringify(pack, null, 2)}\n`);
console.log(
  `core-v1: ${Object.keys(pack.fragments).length} fragments, ${Object.keys(pack.motifs).length} motifs, ` +
    `${Object.keys(faces).length} faces -> ${pack.hash.slice(0, 12)}`
);
