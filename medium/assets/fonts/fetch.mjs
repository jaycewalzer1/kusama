// Vendor the type library from google/fonts, once, into assets/fonts/.
//
// This is a build-time tool, never run at render time. It writes the .ttf files, the licence text
// for each family, and manifest.json, which records for every face: the upstream URL it came from,
// the SHA256 of the bytes on disk, and which licence file governs it. `npm run fonts -- --check`
// re-hashes what is on disk against the manifest and touches the network only if a file is missing.
//
//   node assets/fonts/fetch.mjs          fetch anything missing, rewrite the manifest
//   node assets/fonts/fetch.mjs --check  verify the files on disk against the manifest

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW = 'https://raw.githubusercontent.com/google/fonts/main';

/**
 * face name -> [repo directory, font file, human family name, role]
 *
 * Every face here is a STATIC .ttf. Variable fonts are not usable: p5 2.2.0 loads one without
 * complaint and measures sensible advance widths from it, and then draws absolutely nothing --
 * the metrics tables parse, the outlines never reach the WEBGL text path (NOTES O6). Seven faces
 * were dropped for this and replaced with static families in the same role; the manifest's
 * `variable` field is kept so that a future variable face is at least labelled, and the face gate
 * in tests/fonts.test.ts asserts ink, not just determinism.
 *
 * Roles are the vocabulary the aesthetic layer talks in, not a property of the file.
 */
const FACES = [
  ['anton', 'ofl/anton', 'Anton-Regular.ttf', 'Anton', 'display'],
  ['bebas-neue', 'ofl/bebasneue', 'BebasNeue-Regular.ttf', 'Bebas Neue', 'display'],
  ['archivo-black', 'ofl/archivoblack', 'ArchivoBlack-Regular.ttf', 'Archivo Black', 'display'],
  ['fjalla-one', 'ofl/fjallaone', 'FjallaOne-Regular.ttf', 'Fjalla One', 'display'],
  ['rubik-mono-one', 'ofl/rubikmonoone', 'RubikMonoOne-Regular.ttf', 'Rubik Mono One', 'display'],

  ['barlow-condensed', 'ofl/barlowcondensed', 'BarlowCondensed-Regular.ttf', 'Barlow Condensed', 'condensed'],
  ['barlow-condensed-black', 'ofl/barlowcondensed', 'BarlowCondensed-Black.ttf', 'Barlow Condensed Black', 'condensed'],
  ['pathway-gothic', 'ofl/pathwaygothicone', 'PathwayGothicOne-Regular.ttf', 'Pathway Gothic One', 'condensed'],
  ['six-caps', 'ofl/sixcaps', 'SixCaps.ttf', 'Six Caps', 'condensed'],
  ['abel', 'ofl/abel', 'Abel-Regular.ttf', 'Abel', 'condensed'],

  ['space-mono', 'ofl/spacemono', 'SpaceMono-Regular.ttf', 'Space Mono', 'mono'],
  ['space-mono-bold', 'ofl/spacemono', 'SpaceMono-Bold.ttf', 'Space Mono Bold', 'mono'],
  ['ibm-plex-mono', 'ofl/ibmplexmono', 'IBMPlexMono-Regular.ttf', 'IBM Plex Mono', 'mono'],
  ['share-tech-mono', 'ofl/sharetechmono', 'ShareTechMono-Regular.ttf', 'Share Tech Mono', 'mono'],

  ['courier-prime', 'ofl/courierprime', 'CourierPrime-Regular.ttf', 'Courier Prime', 'typewriter'],
  ['courier-prime-bold', 'ofl/courierprime', 'CourierPrime-Bold.ttf', 'Courier Prime Bold', 'typewriter'],
  ['special-elite', 'apache/specialelite', 'SpecialElite-Regular.ttf', 'Special Elite', 'typewriter'],
  ['cutive-mono', 'ofl/cutivemono', 'CutiveMono-Regular.ttf', 'Cutive Mono', 'typewriter'],

  ['permanent-marker', 'apache/permanentmarker', 'PermanentMarker-Regular.ttf', 'Permanent Marker', 'hand'],
  ['rock-salt', 'apache/rocksalt', 'RockSalt-Regular.ttf', 'Rock Salt', 'hand'],
  ['indie-flower', 'ofl/indieflower', 'IndieFlower-Regular.ttf', 'Indie Flower', 'hand'],
  ['reenie-beanie', 'ofl/reeniebeanie', 'ReenieBeanie.ttf', 'Reenie Beanie', 'hand'],

  ['allerta-stencil', 'ofl/allertastencil', 'AllertaStencil-Regular.ttf', 'Allerta Stencil', 'stencil'],
  ['stardos-stencil', 'ofl/stardosstencil', 'StardosStencil-Bold.ttf', 'Stardos Stencil Bold', 'stencil'],
  ['saira-stencil', 'ofl/sairastencilone', 'SairaStencilOne-Regular.ttf', 'Saira Stencil One', 'stencil'],

  ['unifraktur', 'ofl/unifrakturmaguntia', 'UnifrakturMaguntia-Book.ttf', 'UnifrakturMaguntia', 'blackletter'],
  ['pirata-one', 'ofl/pirataone', 'PirataOne-Regular.ttf', 'Pirata One', 'blackletter'],

  ['vt323', 'ofl/vt323', 'VT323-Regular.ttf', 'VT323', 'pixel'],
  ['press-start', 'ofl/pressstart2p', 'PressStart2P-Regular.ttf', 'Press Start 2P', 'pixel'],
  ['silkscreen', 'ofl/silkscreen', 'Silkscreen-Regular.ttf', 'Silkscreen', 'pixel'],

  ['audiowide', 'ofl/audiowide', 'Audiowide-Regular.ttf', 'Audiowide', 'techno'],
  ['major-mono', 'ofl/majormonodisplay', 'MajorMonoDisplay-Regular.ttf', 'Major Mono Display', 'techno'],
  ['michroma', 'ofl/michroma', 'Michroma-Regular.ttf', 'Michroma', 'techno'],
  ['bungee', 'ofl/bungee', 'Bungee-Regular.ttf', 'Bungee', 'techno'],
];

/** Licence file each upstream directory carries, by directory prefix. */
const LICENCE_FILE = { ofl: 'OFL.txt', apache: 'LICENSE.txt', ufl: 'UFL.txt' };
const LICENCE_NAME = { ofl: 'OFL-1.1', apache: 'Apache-2.0', ufl: 'UFL-1.0' };

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const check = process.argv.includes('--check');
  mkdirSync(path.join(HERE, 'licenses'), { recursive: true });

  const manifest = { source: 'https://github.com/google/fonts', faces: {}, licenses: {} };
  const licencesNeeded = new Map();
  const problems = [];

  for (const [name, dir, file, family, role] of FACES) {
    // google/fonts names a variable font `Family[axis].ttf`. Refuse here rather than downstream:
    // a variable face loads, measures, and then draws nothing, which no determinism check can see.
    if (file.includes('[')) {
      problems.push(`${name}: ${file} is a variable font, which p5 loads but cannot draw (NOTES O6)`);
      continue;
    }
    const kind = dir.split('/')[0];
    const licence = LICENCE_NAME[kind];
    licencesNeeded.set(kind, `${RAW}/${dir}/${LICENCE_FILE[kind]}`);
    const local = path.join(HERE, `${name}.ttf`);
    const url = `${RAW}/${dir}/${encodeURIComponent(file)}`;
    let bytes;
    if (existsSync(local)) {
      bytes = readFileSync(local);
    } else if (check) {
      problems.push(`${name}: ${local} is missing`);
      continue;
    } else {
      process.stdout.write(`fetching ${name} ... `);
      bytes = await get(url);
      writeFileSync(local, bytes);
      process.stdout.write(`${bytes.length} bytes\n`);
    }
    manifest.faces[name] = {
      family,
      role,
      file: `assets/fonts/${name}.ttf`,
      bytes: bytes.length,
      sha256: sha256(bytes),
      license: licence,
      licenseFile: `assets/fonts/licenses/${kind}-${dir.split('/')[1]}.txt`,
      source: `https://github.com/google/fonts/blob/main/${dir}/${file}`,
      variable: file.includes('['),
    };
  }

  for (const [name, dir, file] of FACES) {
    const kind = dir.split('/')[0];
    const rel = `licenses/${kind}-${dir.split('/')[1]}.txt`;
    const local = path.join(HERE, rel);
    if (!existsSync(local)) {
      if (check) {
        problems.push(`${name}: licence ${rel} is missing`);
        continue;
      }
      writeFileSync(local, await get(`${RAW}/${dir}/${LICENCE_FILE[kind]}`));
    }
    manifest.licenses[`${kind}-${dir.split('/')[1]}`] = {
      spdx: LICENCE_NAME[kind],
      file: `assets/fonts/${rel}`,
      sha256: sha256(readFileSync(local)),
      source: `https://github.com/google/fonts/blob/main/${dir}/${LICENCE_FILE[kind]}`,
    };
    void file;
  }

  const manifestPath = path.join(HERE, 'manifest.json');
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  if (check) {
    const on = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '';
    if (on !== text) problems.push('manifest.json does not match the files on disk');
  }
  // Problems are fatal in both modes: a fetch that quietly skipped a face would write a manifest
  // that is shorter than the table above and nothing downstream would notice.
  if (problems.length) {
    for (const p of problems) console.error(`FAIL ${p}`);
    process.exit(1);
  }
  if (check) {
    console.log(`ok: ${Object.keys(manifest.faces).length} faces verified against manifest.json`);
    return;
  }
  writeFileSync(manifestPath, text);
  console.log(`wrote manifest.json: ${Object.keys(manifest.faces).length} faces, ${Object.keys(manifest.licenses).length} licence files`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
