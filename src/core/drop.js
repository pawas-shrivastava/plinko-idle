// Drop resolution: decide the whole outcome first (buckets, peg hits, splits, shield,
// trampoline), then the game animates it. Pure and seeded.
// Rules mirror ev.js exactly — change both together.
import { makeRng, hash32, sampleIndex, STREAM } from './rng.js';
import { buildPath } from './path.js';
import { pegEffects } from './ev.js';

/** Path decisions for a rule's forced move from (r, i) to (rT, jo): all steps the same way. */
function forcedSteps(r, i, rT, jo) {
  const n = rT - r, right = jo - i;
  if (right !== 0 && right !== n) throw new Error(`forced move (${r},${i})→(${rT},${jo}) is not straight`);
  return new Uint8Array(n).fill(right ? 1 : 0);
}

/** Splice: prefix decisions of `path` (rows r0..r-1), then forced steps, then the rest. */
function splice(R, r0, path, r, forced, rest) {
  const merged = new Uint8Array(R - r0);
  merged.set(path.subarray(0, r - r0));
  merged.set(forced, r - r0);
  merged.set(rest.path, r - r0 + forced.length);
  return merged;
}

/**
 * One descent ("leg") from (r0, i0) to a bucket. When a movement rule fires (lid bounce,
 * auto-flip) the rest of the fall is re-drawn from the rule's target; the leg comes back
 * merged into one continuous path, with `redirects` saying where and why.
 * @returns leg {r0, i0, path, k, redirects[], hits[], splits[]}; updates acc {gold, factor, layer}
 */
function descend(m, rng, r0, i0, skipStart, acc, isChild, kickDir = 0) {
  const k = sampleIndex(rng, kickDir ? m.deflectDist(r0, i0, kickDir) : m.startDist(r0, i0));
  const path = buildPath(m.rows, k, rng, (r, i) => m.pegAt(r, i)?.weight ?? 1, r0, i0);
  const hits = [], splits = [];
  let i = i0;
  for (let r = r0; r < m.rows; r++) {
    const peg = skipStart && r === r0 ? null : m.pegAt(r, i);
    if (peg) {
      const e = pegEffects(peg, acc.layer === 0, m.traits);
      acc.layer = 1;
      acc.gold += e.gold;
      acc.factor *= e.factor;
      hits.push({ r, i, type: peg.type, gold: e.gold, factor: e.factor, socket: peg.socket });
      if (e.split > 0 && !acc.noSplit && rng.chance(e.split)) {
        splits.push({ r, i, child: resolveBall(m, rng, r, i, true) });
      }
    }
    const d = path[r - r0];
    const rb = m.ruleAt(r, i)?.[d].find((x) => x.chance >= 1 || rng.chance(x.chance));
    if (rb) {
      const rest = descend(m, rng, rb.rT, rb.jo, false, acc, isChild, rb.kickDir);
      return {
        r0, i0, k: rest.k, isChild,
        path: splice(m.rows, r0, path, r, forcedSteps(r, i, rb.rT, rb.jo), rest),
        redirects: [{ kind: rb.kind, id: rb.id, flipper: rb.flipper, r, i, rT: rb.rT, jo: rb.jo, blocked: d }, ...rest.redirects],
        hits: hits.concat(rest.hits), splits: splits.concat(rest.splits),
      };
    }
    i += d;
  }
  return { r0, i0, path, k, redirects: [], hits, splits, isChild };
}

/** Trampoline bounces, Golden roll and payout for a ball whose legs so far are decided. */
function finishBall(m, rng, legs, acc, isChild, golden) {
  const tr = m.trampoline;
  let k = legs[legs.length - 1].k;
  // every landing on the trampoline is relaunched; the first few bounces multiply the payout
  // (at most maxBonusBounces times; after that the ball stays in the bucket)
  while (tr && k === tr.bucket && legs.length - 1 < tr.maxBonusBounces) {
    acc.factor *= tr.bonus;
    acc.layer = 1; // traits only act before the first bounce
    acc.noSplit = true; // a relaunched ball never splits
    legs.push(descend(m, rng, tr.restartRow, tr.restartNodes[rng.int(tr.restartNodes.length)], false, acc, isChild));
    k = legs[legs.length - 1].k;
  }
  if (golden == null) golden = m.ball.golden ? rng.chance(m.ball.golden.chance) : false;
  const mult = m.mults[k];
  const gMul = golden ? m.ball.golden.mul : 1;
  const payout = (m.ball.value * mult + acc.gold) * acc.factor * gMul;
  return {
    legs, k, mult, golden, trampolined: legs.length > 1, bounces: legs.length - 1, payout,
    parts: { bucket: m.ball.value * mult * acc.factor * gMul, gold: acc.gold * acc.factor * gMul },
    isChild,
  };
}

/**
 * A full ball: first descent, optional trampoline relaunch, payout, Golden roll.
 * Children (from splits) are nested balls with their own payout.
 */
export function resolveBall(m, rng, r0, i0, isChild = false) {
  const acc = { gold: 0, factor: 1, layer: 0 };
  const legs = [descend(m, rng, r0, i0, isChild, acc, isChild)];
  return finishBall(m, rng, legs, acc, isChild, null);
}

/** Lattice index of a leg at row r. */
export function legIndexAt(leg, r) {
  let i = leg.i0;
  for (let q = leg.r0; q < r; q++) i += leg.path[q - leg.r0];
  return i;
}

/**
 * Manual flip: the ball sits on flipper `f` (at row f.r of leg `legIdx`). Keep everything
 * decided before the flipper, fling it to the flipper's target and re-draw the rest.
 * Returns a new ball node (same Golden roll), or null if the ball isn't on that peg.
 */
export function flipBall(m, rng, ball, legIdx, f) {
  const leg = ball.legs[legIdx];
  if (!leg || f.r < leg.r0 || legIndexAt(leg, f.r) !== f.i) return null;
  if (leg.redirects.some((rd) => rd.r <= f.r && rd.r >= leg.r0 && rd.rT > f.r)) return null; // flying past it
  const tr = m.trampoline;
  const acc = { gold: 0, factor: tr ? tr.bonus ** Math.min(legIdx, tr.maxBonusBounces) : 1, layer: legIdx > 0 ? 1 : 0, noSplit: legIdx > 0 };
  const keepHits = [];
  for (let n = 0; n < legIdx; n++) for (const h of ball.legs[n].hits) { acc.gold += h.gold; acc.factor *= h.factor; }
  for (const h of leg.hits) if (h.r <= f.r) { keepHits.push(h); acc.gold += h.gold; acc.factor *= h.factor; acc.layer = 1; }
  const rest = descend(m, rng, f.rT, f.jo, false, acc, ball.isChild, 0);
  const newLeg = {
    r0: leg.r0, i0: leg.i0, k: rest.k, isChild: ball.isChild,
    path: splice(m.rows, leg.r0, leg.path, f.r, forcedSteps(f.r, f.i, f.rT, f.jo), rest),
    redirects: [...leg.redirects.filter((rd) => rd.r < f.r), { kind: 'flip', manual: true, flipper: f.n, r: f.r, i: f.i, rT: f.rT, jo: f.jo }, ...rest.redirects],
    hits: keepHits.concat(rest.hits),
    splits: leg.splits.filter((sp) => sp.r <= f.r).concat(rest.splits),
  };
  const legs = [...ball.legs.slice(0, legIdx), newLeg];
  return finishBall(m, rng, legs, acc, ball.isChild, ball.golden);
}

/**
 * Resolve one drop from a dropper. Fully determined by (seed, dropIndex, model, dropper).
 * @param {number} seed
 * @param {number} dropIndex
 * @param {object} m          boardModel()
 * @param {number} dropper    index into m.droppers
 */
export function resolveDrop(seed, dropIndex, m, dropper = 0, forceBucket = null) {
  const rng = makeRng(hash32(seed, dropIndex, STREAM.OUTCOME));
  const pos = m.droppers[dropper];
  if (forceBucket != null) {
    // Rigged drop (FTUE jackpot / debug): override the first leg's odds.
    const forced = { ...m, startDist: (r, i) => (r === pos.startRow && i === pos.startI ? oneHot(m.rows, forceBucket) : m.startDist(r, i)), trampoline: null, ruleAt: () => null };
    return resolveBall(forced, rng, pos.startRow, pos.startI, false);
  }
  return resolveBall(m, rng, pos.startRow, pos.startI, false);
}

function oneHot(R, k) { const p = new Array(R + 1).fill(0); p[k] = 1; return p; }

/** Total coins a resolved ball tree pays (ball + all split descendants). */
export function treePayout(ball) {
  let s = ball.payout;
  for (const leg of ball.legs) for (const sp of leg.splits) s += treePayout(sp.child);
  return s;
}

/** Separate stream for cosmetic variation so tuning animation never changes outcomes. */
export function animRngFor(seed, dropIndex) {
  return makeRng(hash32(seed, dropIndex, STREAM.ANIM));
}
