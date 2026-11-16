// Phase 4 verification: the analytic EV (ev.js) must match the simulated drops
// (drop.js) on fully upgraded boards — splits, trampolines, shields, magnets, suction,
// bumpers, traits, Luck — and special-peg hit rates must match.
//   node tools/verify-board.mjs [--drops 200000]
import { readFileSync } from 'node:fs';
import { resolveDrop, treePayout } from '../src/core/drop.js';
import { buildDropContext, income } from '../src/core/economy.js';
import { emptyBoardUp } from '../src/core/board.js';
import { visitProbs } from '../src/core/ev.js';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
// Test-only ball carrying the Heavy trait (no shipped ball has it yet).
config.ballTypes.push({ id: 'test-heavy', name: 'Heavy (test)', rarity: 'epic', spread: 'tight', valueBonus: 0.1, luckBonus: 0, trait: 'heavy', colors: ['#fff', '#888', '#333'], blurb: '' });

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const N = arg('drops', 200000);
const TOL = config.harness.evTolerancePct;

function scenario(name, boardIndex, ball, ws, edit) {
  const board = config.boards[boardIndex];
  const up = emptyBoardUp(board);
  edit(up, board);
  const workshop = Object.fromEntries(Object.keys(config.workshop).map((k) => [k, ws[k] ?? 0]));
  return { name, state: { boardIndex, equipped: ball, owned: { [ball]: { stars: 1 } }, workshop, boardUp: up, unlockAll: true } };
}

const scenarios = [
  scenario('B1 rubber · gold+mult pegs, 2 lids (one moved off-centre), auto-flip', 0, 'rubber', { ballValue: 4, luck: 5 }, (u) => {
    u.sockets = [{ type: 'gold', level: 3 }, { type: 'multiplier', level: 2 }];
    u.pieces.lids = 2; u.lidPos = [{ r: 5, j: 3 }, { r: 4, j: 1 }]; u.pieces.flippers = 1; u.pieces.autoFlip = 3;
  }),
  scenario('B2 clover (Splitter trait) · splitter peg, 3 lids, trampoline ×2, auto-flip, 3 droppers', 1, 'clover', { ballValue: 10, luck: 8 }, (u) => {
    u.sockets = [{ type: 'gold', level: 4 }, { type: 'multiplier', level: 3 }, { type: 'splitter', level: 5 }];
    u.pieces.lids = 3; u.lidPos = [{ r: 7, j: 4 }, { r: 5, j: 3 }, { r: 6, j: 6 }]; u.pieces.trampoline = 3; u.pieces.flippers = 1; u.pieces.autoFlip = 5; u.droppers = 2;
  }),
  scenario('B3 bouncy (Comet) · all pegs, all pieces, magnet beside the trampoline', 2, 'bouncy', { ballValue: 20, luck: 3 }, (u) => {
    u.sockets = [{ type: 'gold', level: 5 }, { type: 'multiplier', level: 4 }, { type: 'splitter', level: 6 }, { type: 'bumper', level: 4 }];
    Object.assign(u.pieces, { lids: 2, flippers: 1, autoFlip: 4, trampoline: 5, suction: 3, suctionPull: 4, magnet: 3 });
    u.lidPos = [{ r: 8, j: 1 }, { r: 6, j: 3 }]; u.magnetTarget = 7; u.trampBucket = 6;
  }),
  scenario('B3 gold (Golden) · trampoline moved to bucket 4, magnet reach 2 on bucket 9', 2, 'gold', { ballValue: 20 }, (u) => {
    u.pieces.trampoline = 5; u.trampBucket = 4; u.pieces.magnet = 2; u.magnetTarget = 9; u.pieces.lids = 1; u.lidPos = [{ r: 9, j: 5 }];
  }),
  scenario('B3 heavy (test) · bumpers ignored, 2 wind rows, auto-flip switched off', 2, 'test-heavy', { ballValue: 20, luck: 2 }, (u) => {
    u.sockets = [null, null, { type: 'gold', level: 2 }, { type: 'bumper', level: 8 }];
    u.pieces.suction = 2; u.pieces.suctionPull = 1; u.pieces.flippers = 1; u.pieces.autoFlip = 5; u.autoFlipOn = false;
  }),
];

let allPass = true;
for (const sc of scenarios) {
  const ctx = buildDropContext(config, sc.state);
  const m = ctx.model;
  const inc = income(config, sc.state, ctx);
  console.log(`\n=== ${sc.name} — ${m.rows} rows, ${m.droppers.length} dropper(s) ===`);
  for (let d = 0; d < m.droppers.length; d++) {
    const analytic = inc.ev.perDropper[d];
    let sum = 0, sq = 0, splits = 0, bounces = 0, tops = 0;
    const redirects = {};
    const landed = new Array(m.rows + 1).fill(0);
    const hits = new Map();
    const pos = m.droppers[d];
    for (let n = 0; n < N; n++) {
      const ball = resolveDrop(1000 + d * 17, n, m, d);
      const p = treePayout(ball);
      sum += p; sq += p * p;
      bounces += ball.bounces;
      for (const leg of ball.legs) for (const rd of leg.redirects) redirects[rd.kind] = (redirects[rd.kind] || 0) + 1;
      if (m.top.includes(ball.k)) tops++;
      landed[ball.k]++;
      for (const leg of ball.legs) splits += leg.splits.length;
      for (const h of ball.legs[0].hits) hits.set(h.socket, (hits.get(h.socket) || 0) + 1);
    }
    const mean = sum / N, se = Math.sqrt(sq / N - mean * mean) / Math.sqrt(N);
    const err = (mean / analytic.perBall - 1) * 100;
    const ok = Math.abs(err) <= TOL && Math.abs(mean - analytic.perBall) <= 4 * se;
    allPass &&= ok;
    const b = analytic.breakdown;
    console.log(`  dropper ${d} @(${pos.startRow},${pos.startI}): EV analytic ${analytic.perBall.toFixed(2)} vs sim ${mean.toFixed(2)} (${err >= 0 ? '+' : ''}${err.toFixed(2)}%, 1σ ${(se / analytic.perBall * 100).toFixed(2)}%)  ${ok ? 'PASS' : 'FAIL'}`);
    const bok = !m.trampoline || Math.abs(bounces / N - analytic.bounceRate) < Math.max(0.004, 0.03 * analytic.bounceRate);
    allPass &&= bok;
    console.log(`     own ${b.own.toFixed(2)} · children ${b.splits.toFixed(2)} | sim: ${(splits / N * 100).toFixed(1)}% split, bounces/ball ${(bounces / N).toFixed(3)} (analytic ${analytic.bounceRate.toFixed(3)}) ${bok ? 'ok' : 'FAIL'}, jackpot 1/${tops ? Math.round(N / tops) : '∞'} (analytic 1/${Math.round(1 / analytic.top)})  redirects/ball: ${Object.entries(redirects).map(([k, v]) => `${k} ${(v / N).toFixed(3)}`).join(', ') || 'none'}`);
    // Displayed odds (final landing incl. lids, flips, relaunch) vs simulated landings
    const worst = Math.max(...analytic.final.map((p, k) => Math.abs(landed[k] / N - p) / Math.max(Math.sqrt(p * (1 - p) / N), 1e-9)));
    const fok = worst < 4.5;
    allPass &&= fok;
    console.log(`     displayed odds vs sim: worst deviation ${worst.toFixed(1)}σ  ${fok ? 'ok' : 'FAIL'}`);
    // Special-peg hit rates on the first descent vs analytic
    const vp = visitProbs(m, pos.startRow, pos.startI);
    for (const peg of m.pegs.values()) {
      const exp = vp(peg.r, peg.i), got = (hits.get(peg.socket) || 0) / N;
      const sd = Math.sqrt(exp * (1 - exp) / N);
      const hok = Math.abs(got - exp) <= Math.max(4 * sd, 0.002);
      allPass &&= hok;
      console.log(`     ${peg.type.padEnd(10)} peg (${peg.r},${peg.i}) w=${peg.weight.toFixed(2)}: hit ${(exp * 100).toFixed(2)}% expected, ${(got * 100).toFixed(2)}% sim  ${hok ? 'ok' : 'FAIL'}`);
    }
  }
}
console.log(allPass ? '\nALL PASS' : '\nSOME CHECKS FAILED');
process.exit(allPass ? 0 : 1);
