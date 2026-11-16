// Seeded RNG. Pure, no DOM — shared by the game and the node harness.

/** Mix any number of 32-bit ints into one 32-bit hash (stable across platforms). */
export function hash32(...xs) {
  let h = 0x811c9dc5;
  for (const x of xs) {
    h = Math.imul(h ^ (x >>> 0), 0x01000193);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
  }
  return h >>> 0;
}

/** mulberry32: small, fast, good enough for gameplay. */
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (n) => Math.floor(next() * n),
    chance: (p) => next() < p,
    sign: () => (next() < 0.5 ? -1 : 1),
    getState: () => a,
    setState: (s) => { a = s >>> 0; },
  };
}

/** Sample an index from a probability array (need not be normalized). */
export function sampleIndex(rng, probs) {
  let total = 0;
  for (let i = 0; i < probs.length; i++) total += probs[i];
  let u = rng.next() * total;
  for (let i = 0; i < probs.length; i++) {
    u -= probs[i];
    if (u < 0) return i;
  }
  return probs.length - 1;
}

/** Stream ids so outcome and animation randomness never interfere. */
export const STREAM = { OUTCOME: 1, ANIM: 2 };
