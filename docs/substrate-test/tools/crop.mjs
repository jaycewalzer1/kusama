// Nearest-neighbour crop and zoom, used to inspect probe renders at 2x when deciding "faked"
// against "achieved" in the trait table.
//
//   node docs/substrate-test/tools/crop.mjs <src.png> <out.png> <x> <y> <w> <h> [scale]
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync } from 'node:fs';
const [src, out, x, y, w, h, scale] = process.argv.slice(2);
const p = PNG.sync.read(readFileSync(src));
const X=+x, Y=+y, W=+w, H=+h, S=scale?+scale:1;
const ow=Math.round(W*S), oh=Math.round(H*S);
const o = new PNG({width:ow, height:oh});
for(let j=0;j<oh;j++)for(let i=0;i<ow;i++){
  const sx=Math.min(p.width-1,X+Math.floor(i/S)), sy=Math.min(p.height-1,Y+Math.floor(j/S));
  const si=4*(sy*p.width+sx), di=4*(j*ow+i);
  for(let c=0;c<4;c++) o.data[di+c]=p.data[si+c];
}
writeFileSync(out, PNG.sync.write(o));
console.log(out, ow+'x'+oh);
