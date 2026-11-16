// Phase 1/2 verification: simulate N drops per board through the exact same
// resolveDrop() the game uses and compare against config / analytic values.
//
//   node tools/verify-drops.mjs [--drops 10000] [--seed 123]
import { readFileSync } from 'node:fs';
import { resolveDrop, treePayout } from '../src/core/drop.js';
import { buildDropContext, income } from '../src/core/economy.js';
import { visitProbs } from '../src/core/ev.js';
import { pathOffsets } from '../src/core/path.js';
import { lgamma } from '../src/core/distribution.js';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
const N = arg('drops', config.harness.dropsPerBoard);
const SEED = arg('seed', config.rng.defaultSeed);

// Upper tail of chi-square via regularized incomplete gamma (series / continued fraction).
function gammaQ(a, x) {
  if (x <= 0) return 1;
  if (x < a + 1) {
    let sum = 1 / a, term = sum;
    for (let n = 1; n < 500; n++) { term *= x / (a + n); sum += term; if (term < sum * 1e-14) break; }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a); b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}
const lchoose = (n, k) => (k < 0 || k > n ? -Infinity : lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1));

let allPass = true;
const hash = (str) => [...str].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const pct = (x) => (x * 100).toFixed(2).padStart(6);

const baseState = (b, typeId) => ({
  boardIndex: b, equipped: typeId, owned: { [typeId]: { stars: 1 } },
  workshop: Object.fromEntries(Object.keys(config.workshop).map((k) => [k, 0])),
});
const verbose = process.argv.includes('--verbose');

for (let b = 0; b < config.boards.length; b++) {
  const R = config.boards[b].rows;
  console.log(`\n=== Board ${config.boards[b].id} "${config.boards[b].name}" — ${R} rows ===`);
  console.log(' ball          spread  hist p   max|Δ|  peg|Δ|  paths   jackpot 1-in   EV/ball analytic → measured (Δ, 1σ)        result');
  for (const type of config.ballTypes) {
    const state = baseState(b, type.id);
    const ctx = buildDropContext(config, state);
    const counts = new Array(R + 1).fill(0);
    const pegVisits = Array.from({ length: R }, (_, r) => new Array(r + 1).fill(0));
    let paySum = 0, paySqSum = 0, badPaths = 0;
    const seed = SEED + b * 7919 + hash(type.id);

    for (let d = 0; d < N; d++) {
      const ball = resolveDrop(seed, d, ctx.model);
      const bucket = ball.k, path = ball.legs[0].path;
      const offs = pathOffsets(path);
      if (offs[R] !== bucket) badPaths++;
      for (let r = 0; r < R; r++) pegVisits[r][offs[r]]++;
      counts[bucket]++;
      const pay = treePayout(ball) / ctx.ball.value; paySum += pay; paySqSum += pay * pay;
    }

    let chi = 0, maxDev = 0;
    for (let k = 0; k <= R; k++) {
      const e = ctx.probs[k] * N;
      if (e === 0) { if (counts[k]) badPaths++; continue; } // a bucket that doesn't exist must never be hit
      chi += (counts[k] - e) ** 2 / e;
      maxDev = Math.max(maxDev, Math.abs(counts[k] / N - ctx.probs[k]));
    }
    const pChi = gammaQ(R / 2, chi / 2);

    // Peg visits against the exact visit probabilities (walls included).
    let pegMaxDev = 0;
    const vp = visitProbs(ctx.model, 0, 0);
    for (let r = 0; r < R; r++) for (let i = 0; i <= r; i++) pegMaxDev = Math.max(pegMaxDev, Math.abs(pegVisits[r][i] / N - vp(r, i)));

    // EV per ball in units of base ball value (includes ball value bonus + Golden trait).
    // Jackpot buckets make payouts swingy (~2-4% noise at 10k), so EV uses a larger sample.
    const NE = config.harness.evDropsPerBoard;
    for (let d = N; d < NE; d++) {
      const pay = treePayout(resolveDrop(seed, d, ctx.model)) / ctx.ball.value; paySum += pay; paySqSum += pay * pay;
    }
    const evA = income(config, state, ctx).perBall;
    const evM = (paySum / NE) * ctx.ball.value;
    const sd = Math.sqrt(paySqSum / NE - (paySum / NE) ** 2) * ctx.ball.value;
    const se = sd / Math.sqrt(NE);
    const evErrPct = (evM / evA - 1) * 100;
    const top = ctx.top.reduce((s, k) => s + ctx.probs[k], 0);

    const histOk = pChi > 0.001 && maxDev <= config.harness.histogramTolerance;
    const evOk = Math.abs(evErrPct) <= config.harness.evTolerancePct;
    const pathOk = badPaths === 0;
    allPass &&= histOk && evOk && pathOk;

    console.log(
      ` ${type.name.padEnd(13)} ${ctx.ball.spread.padEnd(7)} ${pChi.toFixed(3).padStart(6)}  ${(maxDev * 100).toFixed(2).padStart(5)}pp ${(pegMaxDev * 100).toFixed(2).padStart(5)}pp  ${pathOk ? 'ok  ' : 'BAD '}   ${String(Math.round(1 / top)).padStart(6)}        ` +
      `${evA.toFixed(3).padStart(7)} → ${evM.toFixed(3).padStart(7)} (${evErrPct >= 0 ? '+' : ''}${evErrPct.toFixed(2)}%, ${(se / evA * 100).toFixed(2)}%)`.padEnd(46) +
      `${histOk && evOk && pathOk ? 'PASS' : 'FAIL'}`);
    if (verbose) {
      for (let k = 0; k <= R; k++)
        console.log(`     ${String(k).padStart(3)} ×${ctx.mults[k].toFixed(1).padStart(6)}  ${pct(ctx.probs[k])}%  ${pct(counts[k] / N)}%`);
    }
  }
}

// Determinism: same seed + index must give identical outcome
const ctx0 = buildDropContext(config, baseState(0, config.startingBall));
const a = resolveDrop(42, 1234, ctx0.model), c = resolveDrop(42, 1234, ctx0.model);
const det = a.k === c.k && a.legs[0].path.join() === c.legs[0].path.join();
console.log(`\nDeterminism (seed 42, drop 1234 twice): ${det ? 'PASS' : 'FAIL'}`);
allPass &&= det;
console.log(allPass ? '\nALL PASS' : '\nSOME CHECKS FAILED');
process.exit(allPass ? 0 : 1);
