// Walk a resolved program and draw it. Browser only.
//
// The resolved tree is flat: `nodes` is already in paint order, every node already carries its world
// matrix, its clip in canvas coordinates and its seed inputs. Nothing here decides anything; the
// only job is to run each leaf under isolation (see compositing.js) and hand it to its operator.

import { OPS } from './ops.js';
import { withLeaf } from './compositing.js';

/**
 * @param {object} resolved output of resolveProgram
 * @param {object} pack     asset pack (fragments + motifs)
 * @param {object} fonts    { name: p5.Font }, already loaded
 */
export function drawResolved(p, brush, resolved, pack, fonts) {
  const ground = resolved.canvas.ground;
  p.background(ground);
  // The single origin shift: WEBGL puts (0,0) at the centre, our coordinates are top-left, y down.
  p.translate(-p.width / 2, -p.height / 2);
  for (const node of resolved.nodes) {
    const op = OPS[node.op];
    if (!op) throw new Error(`unknown operator "${node.op}" on node ${node.id}`);
    withLeaf(p, brush, node, resolved.seed, (stream, clip) => {
      op(p, brush, node, { clip, pack, ground, fonts }, stream);
    });
  }
}
