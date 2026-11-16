// Landing distribution P(bucket). Pure.
//
// Base family: beta-binomial(R, c, c) where c = "concentration".
//   c small  -> flat / edge-heavy, c -> inf -> binomial(R, 1/2).
// Binomial is the tightest a beta-binomial can get, and on small boards that is
// not rare enough for the top bucket (8 rows: 1 in 128 for either edge). So a
// second knob, "sharpness" s, tempers the result: P(k) ∝ BB(k)^s. s = 1 is the
// plain beta-binomial; s > 1 is tighter than binomial. Ball Spread multiplies both.

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406,
  12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7,
];

export function lgamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  x -= 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < 8; i++) a += LANCZOS[i] / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

const lbeta = (a, b) => lgamma(a) + lgamma(b) - lgamma(a + b);
const lchoose = (n, k) => lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);

export function normalize(arr) {
  let s = 0;
  for (const v of arr) s += v;
  return arr.map((v) => v / s);
}

/** log-pmf of beta-binomial(n, a, b); falls back to binomial(n, 1/2) for huge a, b. */
export function betaBinomialLogPmf(n, a, b, binomialAbove) {
  const out = new Array(n + 1);
  for (let k = 0; k <= n; k++) {
    out[k] = a >= binomialAbove && b >= binomialAbove
      ? lchoose(n, k) + n * Math.log(0.5)
      : lchoose(n, k) + lbeta(k + a, n - k + b) - lbeta(a, b);
  }
  return out;
}

/**
 * Build P(bucket) for a board.
 * @param {number} rows             peg rows R (buckets = R + 1)
 * @param {object} dist             board.distribution from config
 * @param {object} spread           { concentrationMul, sharpnessMul } (ball Spread trait)
 * @param {object} distCfg          config.distribution (global constants)
 * @param {Array<object>} reweights optional explicit modifiers [{bucket, mul}] (board modifiers, later phases)
 */
export function bucketDistribution(rows, dist, spread, distCfg, reweights = []) {
  let p;
  if (Array.isArray(dist.weights) && dist.weights.length === rows + 1) {
    // Designer override: explicit weight table. Spread is applied as a temper.
    const s = spread?.sharpnessMul ?? 1;
    p = normalize(dist.weights.map((w) => Math.pow(w, s)));
  } else {
    const c = dist.concentration * (spread?.concentrationMul ?? 1);
    const s = (dist.sharpness ?? 1) * (spread?.sharpnessMul ?? 1);
    const lp = betaBinomialLogPmf(rows, c, c, distCfg.binomialAboveConcentration);
    const max = Math.max(...lp);
    p = normalize(lp.map((v) => Math.exp(s * (v - max))));
  }
  if (reweights.length) {
    p = p.slice();
    for (const r of reweights) p[r.bucket] *= r.mul;
    p = normalize(p);
  }
  return p;
}
