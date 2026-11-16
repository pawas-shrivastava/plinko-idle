// Progression check: a greedy player (always buys the upgrade that pays back fastest)
// plays each board for its target time. Prints how long each milestone takes and the
// goal that matches the target time, so goals in config.json can be set from it.
//   node tools/sim-progress.mjs            report with the goals in config.json
//   node tools/sim-progress.mjs --fit      suggest goals that hit harness.targetMinutes
import { readFileSync } from 'node:fs';
import { income, costAt, statAt, boardActionInfo, applyBoardAction, boardProgress } from '../src/core/economy.js';
import { emptyBoardUp } from '../src/core/board.js';
import { configureFormat, fmt } from '../src/core/format.js';

const config = JSON.parse(readFileSync(process.env.CFG || new URL('../config.json', import.meta.url)));
configureFormat(config.format);
const fit = process.argv.includes('--fit');
const targets = config.harness.targetMinutes;

function candidates(state) {
  const out = [];
  const board = config.boards[state.boardIndex], up = state.boardUp, T = config.boardTree;
  for (const [key, item] of Object.entries(config.workshop)) {
    const lv = state.workshop[key];
    if (lv >= item.maxLevel) continue;
    if (item.requires === 'specialPegs' && !up.sockets.some((s) => s)) continue;
    out.push({ cost: costAt(item, lv, key === 'ballValue' ? board.valueCost : undefined), apply: (s) => ({ ...s, workshop: { ...s.workshop, [key]: lv + 1 } }) });
  }
  const acts = [];
  board.sockets.forEach((_, i) => {
    if (up.sockets[i]) acts.push({ kind: 'socket', socket: i });
    else for (const t of board.pegTypes) acts.push({ kind: 'place', socket: i, type: t });
  });
  for (const id of Object.keys(T.pieces)) acts.push({ kind: 'piece', id });
  acts.push({ kind: 'dropper' });
  for (const a of acts) {
    const info = boardActionInfo(config, state, a);
    if (info.locked || info.maxed) continue;
    out.push({ cost: info.cost, apply: (s) => applyBoardAction(config, s, a) });
  }
  return out;
}

function playBoard(state, seconds, goal) {
  let t = 0;
  const marks = {};
  const board = config.boards[state.boardIndex];
  let buys = 0; const gaps = []; let last = 0;
  while (t < seconds) {
    const now = income(config, state).perSec;
    let best = null, quick = null;
    for (const c of candidates(state)) {
      const gain = income(config, c.apply(state)).perSec - now;
      if (gain <= 0) continue;
      const wait = Math.max(0, (c.cost - state.coins) / now);
      const score = wait + c.cost / gain; // time until this purchase has paid for itself
      if (!best || score < best.score) best = { ...c, score, wait };
      if (wait === 0 ? (!quick || quick.wait > 0 || score < quick.score) : (!quick || wait < quick.wait)) quick = { ...c, score, wait };
    }
    // An impatient player: rather than save up for long, buys the best thing they can afford now (or the soonest one).
    if (best && quick && best.wait > (H.patienceSec ?? Infinity)) best = quick;
    const step = Math.min(best ? best.wait : Infinity, seconds - t);
    const before = state.boardUp.earned;
    state.coins += now * step; state.boardUp.earned += now * step; t += step;
    for (const m of board.milestones) {
      if (before < m.at * goal && state.boardUp.earned >= m.at * goal) marks[m.unlock] = t - (state.boardUp.earned - m.at * goal) / now;
    }
    if (marks.goal == null && state.boardUp.earned >= goal) marks.goal = t - (state.boardUp.earned - goal) / now;
    if (!best || t >= seconds) break;
    state.coins -= best.cost;
    state = best.apply(state);
    buys++; gaps.push(t - last); last = t;
  }
  return { state, marks, buys, gaps, perSec: income(config, state).perSec };
}

const mmss = (s) => (s == null ? '—' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
const H = { ...config.harness, ...JSON.parse(process.env.H || "{}") };
const round2 = (x) => Number(x.toPrecision(2));
let state = { boardIndex: 0, coins: 0, equipped: config.startingBall, owned: { [config.startingBall]: { stars: 1 } }, workshop: Object.fromEntries(Object.keys(config.workshop).map((k) => [k, 0])), boardUp: null };
let prevEnd = null, firstStart = null;
const fitted = [];
for (let b = 0; b < config.boards.length; b++) {
  const board = config.boards[b];
  const fresh = () => ({ ...state, boardIndex: b, boardUp: emptyBoardUp(board) });
  if (fit) {
    // A new board starts at a set share of the income the last one ended on, and its
    // pieces cost the same number of seconds of income as on the first board.
    const fitOnce = () => {
      if (prevEnd != null) {
        board.payoutScale = 1;
        board.payoutScale = round2(prevEnd * H.newBoardIncomeShare / income(config, fresh()).perSec);
      }
      const start = income(config, fresh()).perSec;
      firstStart ??= start;
      // Ball Value's next level costs about valueStartSec of income when the board opens.
      const bv = config.workshop.ballValue;
      if (b > 0 && bv.late) board.valueCost = Number((H.valueStartSec * start / Math.pow(statAt(bv, state.workshop.ballValue), bv.late.k)).toPrecision(3));
      board.costScale = b === 0 ? 1 : round2(start / firstStart * H.boardCostWeight);
      // Bisect the goal so the greedy player reaches it at the target time.
      let lo = start * 60, hi = start * targets[b] * 60 * 1e4;
      for (let n = 0; n < 14; n++) {
        const mid = Math.sqrt(lo * hi);
        board.goal = mid;
        const r = playBoard(fresh(), targets[b] * 60, mid);
        if (r.marks.goal != null) lo = mid; else hi = mid;
      }
      board.goal = round2(lo);
      return playBoard(fresh(), targets[b] * 60, board.goal).perSec / start; // income growth over the board
    };
    // Lower the board's power (strength of the multiplying pieces) until income grows by about the target factor on this board.
    const G = H.growthTarget?.[b];
    if (b > 0 && H.purchaseEverySec) { // enough fine peg steps to buy one about every purchaseEverySec
      const per = board.pegTypes.reduce((a, t) => a + config.boardTree.pegs[t].maxLevel, 0) / board.pegTypes.length * board.sockets.length;
      board.pegSteps = Math.max(1, Math.ceil(targets[b] * 60 / H.purchaseEverySec / per)); board.pegCostRange = H.pegCostRange;
    }
    board.power = 1; board.flatten = b === 0 ? 1 : (H.bucketFlatten ?? 1);
    let growth = fitOnce();
    if (G && growth > G) {
      let lo = H.powerMin ?? 0.05, hi = 1;
      for (let n = 0; n < 4; n++) { board.power = Number(((lo + hi) / 2).toFixed(3)); growth = fitOnce(); if (growth > G) hi = board.power; else lo = board.power; }
      board.power = Number(lo.toFixed(2)); growth = fitOnce();
    }
    fitted.push({ id: board.id, valueCost: board.valueCost, flatten: board.flatten, power: board.power, payoutScale: board.payoutScale ?? 1, costScale: board.costScale, goal: board.goal, growth: Math.round(growth) });
  }
  const start = income(config, fresh()).perSec;
  const r = playBoard(fresh(), 6 * 3600, board.goal);
  // carry on from the moment the goal was reached
  const done = playBoard(fresh(), r.marks.goal ?? 6 * 3600, board.goal);
  state = done.state; prevEnd = done.perSec;
  if (process.env.DUMP == board.id) { const e = income(config, state).ev; globalThis.__dump = { up: state.boardUp, perDropper: e.perDropper.map((d) => ({ perBall: d.perBall, breakdown: d.breakdown, bounce: d.bounceRate, top: d.top })) }; }
  console.log(`\nBoard ${board.id} ${board.name}: goal ${fmt(board.goal)} reached at ${mmss(r.marks.goal)} (target ${targets[b]}:00) · income ${fmt(start)}/s → ${fmt(done.perSec)}/s · ${done.buys} purchases · workshop ${JSON.stringify(state.workshop)}`);
  { const g = [...done.gaps].sort((x, y) => x - y), q = (f) => Math.round(g[Math.floor((g.length - 1) * f)] || 0); console.log(`   seconds between purchases: median ${q(0.5)} · 90% under ${q(0.9)} · longest ${q(1)}`); }
  console.log('   ' + Object.entries(r.marks).filter(([k]) => k !== 'goal').map(([k, v]) => `${k.split(':').pop()} ${mmss(v)}`).join(' · '));
  if (r.marks.goal == null) { console.log('   goal not reached in 6 hours'); break; }
}
if (fit) console.log('\nFITTED ' + JSON.stringify(fitted));
if (process.env.DUMP) console.log(JSON.stringify(globalThis.__dump));
