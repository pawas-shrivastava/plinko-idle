// Lattice path builder. Pure.
//
// The ball hits peg (r, i) on row r, where i = number of rights taken so far.
// After the last row, landing bucket k = total rights. Given a target k we sample
// one of the C(R, k) monotone paths, weighted by the product of the weights of
// the pegs it visits. With all weights = 1 every path is equally likely; special
// pegs later get weight > 1 (ball Luck × peg attraction) so they are passed more
// often — without changing P(bucket), because k is fixed before the walk.

/**
 * @param {number} rows      R
 * @param {number} k         target bucket
 * @param {object} rng       seeded rng
 * @param {(r:number,i:number)=>number} [pegWeight]  weight of lattice peg (r, i); default 1
 * @param {number} [r0]      start row (side droppers, split children, relaunches)
 * @param {number} [i0]      start lattice offset on that row
 * @returns {Uint8Array} decisions for rows r0..R-1 (1 = right)
 */
export function buildPath(rows, k, rng, pegWeight = null, r0 = 0, i0 = 0) {
  // f[r][i]: weighted number of completions from peg (r, i) to bucket k.
  const W = rows + 2;
  const f = new Float64Array((rows + 1) * W);
  const idx = (r, i) => r * W + i;
  f[idx(rows, k)] = 1;
  for (let r = rows - 1; r >= r0; r--) {
    for (let i = 0; i <= r; i++) {
      const tail = f[idx(r + 1, i)] + f[idx(r + 1, i + 1)];
      f[idx(r, i)] = tail === 0 ? 0 : tail * (pegWeight ? pegWeight(r, i) : 1);
    }
  }
  if (f[idx(r0, i0)] === 0) throw new Error(`no path from (${r0},${i0}) to bucket ${k} on ${rows} rows`);

  const path = new Uint8Array(rows - r0);
  let i = i0;
  for (let r = r0; r < rows; r++) {
    const left = f[idx(r + 1, i)];
    const right = f[idx(r + 1, i + 1)];
    const goRight = rng.next() * (left + right) < right ? 1 : 0;
    path[r - r0] = goRight;
    i += goRight;
  }
  return path;
}

/** Lattice offsets visited by a path: i at each row from r0, plus the final bucket. */
export function pathOffsets(path, i0 = 0) {
  const out = new Array(path.length + 1);
  let i = i0;
  for (let r = 0; r < path.length; r++) {
    out[r] = i;
    i += path[r];
  }
  out[path.length] = i;
  return out;
}
