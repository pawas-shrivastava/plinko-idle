// Animation sanity per ball type: peg clearance, drop time, continuity, and
// "no upward motion after a roll-off" (stuck balls must just fall).
//   node tools/check-motion.mjs
import { readFileSync } from 'node:fs';
import { buildSegments, evalSegment, SEG } from '../src/game/anim.js';
import { boardGeometry } from '../src/core/geometry.js';
import { animRngFor, resolveDrop } from '../src/core/drop.js';
import { buildDropContext, applyBoardAction } from '../src/core/economy.js';
import { Game } from '../src/game/game.js';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
const N = 400;
let ok = true;
for (let b = 0; b < config.boards.length; b++) {
  console.log(`\nBoard ${config.boards[b].id} (${config.boards[b].rows} rows)`);
  for (const type of config.ballTypes) {
    const state = { boardIndex: b, equipped: type.id, owned: {}, workshop: Object.fromEntries(Object.keys(config.workshop).map((k) => [k, 0])) };
    const ctx = buildDropContext(config, state);
    const geo = boardGeometry(ctx.rows, config.layout);
    let minD = 9, maxGap = 0, riseAfterRoll = 0, peakHop = 0;
    const durs = [], o = {}, p = {};
    for (let d = 0; d < N; d++) {
      // force some jackpot drops so the teeter path is exercised
      const drop = resolveDrop(1, d, ctx.model, 0, d % 10 === 0 ? ctx.top[0] : null);
      const a = buildSegments(drop, geo, config.animation, animRngFor(1, d), { top: ctx.top, dropperX: 0, motion: type.motion, tramp: null, lidThickness: config.layout.lidThickness });
      durs.push(a.total);
      for (let si = 0; si < a.segs.length; si++) {
        const s = a.segs[si];
        evalSegment(s, 0, o);
        if (si > 0) { evalSegment(a.segs[si - 1], 1, p); maxGap = Math.max(maxGap, Math.hypot(o.x - p.x, o.y - p.y)); }
        const afterRoll = si > 0 && a.segs[si - 1].kind === SEG.ROLL;
        let prevY = o.y;
        for (let u = 0; u <= 1.0001; u += 0.01) {
          evalSegment(s, Math.min(u, 1), o);
          if (afterRoll) riseAfterRoll = Math.max(riseAfterRoll, prevY - o.y);
          if (s.kind === SEG.HOP && s.h > 0.05) peakHop = Math.max(peakHop, s.y0 - o.y);
          prevY = o.y;
          if (s.kind === SEG.FALL && u < 0.9) continue; // dropper fall lands on the peg by design
          if (s.y0 > geo.bucketTop) continue; // in-bucket bounces
          for (let r = 0; r < geo.rows; r++) for (let j = 0; j < r + 3; j++)
            minD = Math.min(minD, Math.hypot(o.x - geo.pegX(r, j), o.y - geo.pegY(r)));
        }
      }
    }
    durs.sort((x, y) => x - y);
    const clipPct = Math.max(0, (1 - minD / geo.C) * 100);
    const pass = clipPct < 10 && maxGap < 0.01 && riseAfterRoll < 1e-6;
    ok &&= pass;
    console.log(`  ${type.name.padEnd(13)} drop ${durs[N * 0.05 | 0].toFixed(2)}–${durs[N * 0.95 | 0].toFixed(2)}s  peak hop ${peakHop.toFixed(2)}  peg overlap ${clipPct.toFixed(1)}%  seam gap ${maxGap.toExponential(1)}  rise after roll ${riseAfterRoll.toFixed(3)}  ${pass ? 'ok' : 'FAIL'}`);
  }
}
// Loaded boards: every piece at max (lids, auto-flip, pad above the bucket, suction drift).
// Clearance against pegs; lid flaps are thin plates in the gap, checked separately.
const WORST = [];
function scanSegs(segs, geo, lids, tag) {
  let minRatio = 9, maxGap = 0;
  const o = {}, p = {};
  for (let si = 0; si < segs.length; si++) {
    const s = segs[si];
    if (si > 0) { evalSegment(s, 0, o); evalSegment(segs[si - 1], 1, p); maxGap = Math.max(maxGap, Math.hypot(o.x - p.x, o.y - p.y)); }
    if (s.kind === SEG.LAUNCH || s.y0 > geo.bucketTop - 0.3) continue; // launches fly through by design
    for (let u = 0; u <= 1.0001; u += 0.02) {
      if (s.kind === SEG.FALL && !s.side && u < 0.9) continue; // top drops / relaunch drops land on the peg by design
      evalSegment(s, Math.min(u, 1), o);
      for (let r = 0; r < geo.rows; r++) for (let j = 0; j < r + 3; j++) {
        const q = Math.hypot(o.x - geo.pegX(r, j), o.y - geo.pegY(r)) / geo.C;
        if (q < minRatio) { minRatio = q; }
        if (q < 0.85 && WORST.length < 8) WORST.push({ tag, si, kind: s.kind, u: +u.toFixed(2), r, j, q: +q.toFixed(2), x0: +s.x0.toFixed(2), y0: +s.y0.toFixed(2), x1: +s.x1.toFixed(2), y1: +s.y1.toFixed(2), h: s.h });
      }
      // lid flaps: ball must not pass through a closed part of a flap (centre band of the gap)
      for (const L of lids) {
        const xa = geo.pegX(L.r, L.j), xb = geo.pegX(L.r, L.j + 1), yy = geo.pegY(L.r);
        const flap = L.cover * (xb - xa - 2 * geo.pegRadius) / 2;
        for (const [fx0, fx1] of [[xa + geo.pegRadius, xa + geo.pegRadius + flap], [xb - geo.pegRadius - flap, xb - geo.pegRadius]]) {
          const cx = Math.max(fx0, Math.min(fx1, o.x));
          const dd = Math.hypot(o.x - cx, o.y - yy);
          if (dd < geo.ballRadius * 0.75) minRatio = Math.min(minRatio, 0.5);
        }
      }
    }
  }
  return { minRatio, maxGap };
}

console.log('\nLoaded boards (all pieces max, auto-flip on) + manual flips');
for (let b = 0; b < config.boards.length; b++) {
  const game = new Game(config, { seed: 7, boardIndex: b, unlockAll: true });
  const up = game.state.boardUp, T = config.boardTree;
  for (const id of Object.keys(up.pieces)) {
    while (game.state.boardUp.pieces[id] < T.pieces[id].maxLevel) game.state.boardUp = applyBoardAction(config, game.state, { kind: 'piece', id }).boardUp;
  }
  game.state.boardUp.droppers = 2;
  game.rebuild();
  const geo = game.geo, m = game.model;
  let minRatio = 9, maxGap = 0, lid = 0, flip = 0, relaunch = 0;
  for (let d = 0; d < 1500; d++) {
    const dp = m.droppers[d % m.droppers.length];
    const drop = resolveDrop(3, d, m, d % m.droppers.length);
    for (const leg of drop.legs) for (const rd of leg.redirects) { if (rd.kind === 'lid') lid++; else if (rd.kind === 'flip') flip++; }
    relaunch += drop.bounces;
    const a = buildSegments(drop, geo, config.animation, animRngFor(3, d), { ...game.animOpts, dropperX: dp.x, dropperVia: dp.via });
    const r = scanSegs(a.segs, geo, m.lids, `b${b + 1} drop ${d}`);
    minRatio = Math.min(minRatio, r.minRatio); maxGap = Math.max(maxGap, r.maxGap);
  }
  // Manual flips: run the real game loop, tap both flippers often, scan every re-animated ball.
  game.state.boardUp.autoFlipOn = false; game.rebuild();
  game.state.workshop.dropRate = 40; game.rebuild();
  let caught = 0, flipGap = 0;
  const orig = game.retarget.bind(game);
  game.retarget = (ball, node, legIdx, f) => {
    const before = { x: ball.x, y: ball.y };
    orig(ball, node, legIdx, f);
    const o = {}; evalSegment(ball.segs[0], 0, o);
    flipGap = Math.max(flipGap, Math.hypot(o.x - before.x, o.y - before.y));
    const r = scanSegs(ball.segs, geo, m.lids, `b${b + 1} manual`);
    minRatio = Math.min(minRatio, r.minRatio); maxGap = Math.max(maxGap, r.maxGap);
  };
  for (let i = 0; i < 60 * 60; i++) { game.update(1 / 60); if (i % 7 === 0) caught += game.flip(0) + game.flip(1); }
  const clip = Math.max(0, (1 - minRatio) * 100);
  const pass = clip < 12 && maxGap < 0.01 && flipGap < 0.01 && caught > 0;
  ok &&= pass;
  console.log(`  Board ${b + 1}: lid bounces ${(lid / 15).toFixed(1)}%  auto-flips ${(flip / 15).toFixed(1)}%  bounces ${(relaunch / 15).toFixed(1)}%  manual flips caught ${caught}  overlap ${clip.toFixed(1)}%  seam gap ${maxGap.toExponential(1)}  flip jump ${flipGap.toExponential(1)}  ${pass ? 'ok' : 'FAIL'}`);
}
if (WORST.length && process.argv.includes('--why')) console.log(WORST);
console.log(ok ? '\nALL OK' : '\nPROBLEMS FOUND');
process.exit(ok ? 0 : 1);
