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

const pack = {
  id: 'core-v1',
  fragments: core.fragments,
  motifs: core.motifs,
  faces,
  licenses: manifest.licenses,
};
pack.hash = contentHash(pack);

writeFileSync(path.join(HERE, 'pack.json'), `${JSON.stringify(pack, null, 2)}\n`);
console.log(
  `core-v1: ${Object.keys(pack.fragments).length} fragments, ${Object.keys(pack.motifs).length} motifs, ` +
    `${Object.keys(faces).length} faces -> ${pack.hash.slice(0, 12)}`
);
