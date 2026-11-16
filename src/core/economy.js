// Economy: stats from upgrades + ball type, the board model, exact EV, previews. Pure.
import { costAt, statAt } from './economy-base.js';
import { boardModel, baseMultipliers, emptyBoardUp, boardCost, pegMaxLevel, pegEffLevel, pegNumbers, pieceNumbers, isValidLayout, lidGaps, pieceBuckets } from './board.js';
import { boardEV } from './ev.js';
import { fmt } from './format.js';

export { costAt, statAt };

/** Kept for tools: a board's bucket multipliers. */
export function multipliersFor(board) { return baseMultipliers(board); }

export function ballTypeById(config, id) {
  const t = config.ballTypes.find((b) => b.id === id);
  if (!t) throw new Error(`unknown ball type ${id}`);
  return t;
}

/** Effective stats of a ball type given workshop levels and its star level. */
export function ballStats(config, state, typeId = state.equipped) {
  const type = ballTypeById(config, typeId);
  const stars = state.owned?.[typeId]?.stars ?? 1;
  const S = config.stars;
  const ws = config.workshop;
  const valueMul = 1 + type.valueBonus + S.valueBonusPerStar * (stars - 1);
  const value = statAt(ws.ballValue, state.workshop.ballValue) * valueMul;
  const luck = Math.max(0, statAt(ws.luck, state.workshop.luck) + type.luckBonus);
  const trait = type.trait ? { id: type.trait, ...config.traits[type.trait] } : null;
  const strength = 1 + S.traitStrengthPerStar * (stars - 1);
  const golden = type.trait === 'golden' && trait.active
    ? { chance: Math.min(1, trait.chance * strength), mul: trait.payoutMul }
    : null;
  return { type, stars, value, valueMul, luck, spread: type.spread, golden, trait, traitStrength: strength };
}

const withBoardUp = (config, state) =>
  state.boardUp ? state : { ...state, boardUp: emptyBoardUp(config.boards[state.boardIndex]) };

/** Everything a drop needs, rebuilt whenever board/ball/upgrades change. */
export function buildDropContext(config, state, typeId = state.equipped) {
  state = withBoardUp(config, state);
  const ball = ballStats(config, state, typeId);
  const m = boardModel(config, state, ball);
  const ev = boardEV(m);
  const probs = ev.perDropper[0].final.map((_, k) => ev.perDropper.reduce((s, d) => s + d.final[k], 0) / ev.perDropper.length);
  return {
    model: m, board: m.board, rows: m.rows, ball, ev,
    probs, // where balls finally land (droppers take equal turns), for the odds labels and previews
    mults: m.mults, top: m.top, golden: ball.golden,
  };
}

/** Balls per second from ONE dropper (the Drop Rate upgrade; capped by its max level). */
export function dropsPerDropper(config, state) {
  return statAt(config.workshop.dropRate, state.workshop.dropRate);
}

/** Total balls per second: every dropper drops at the full rate. */
export function dropsPerSec(config, state, droppers = 1) {
  return dropsPerDropper(config, state) * droppers;
}

/**
 * Income multipliers from the automated active upgrades (manual taps and manual Frenzy are
 * the player's own bonus on top and are not counted):
 *  - Golden Touch: a share of balls glow by themselves and pay ×mul.
 *  - Auto-Frenzy: Frenzy (×mul for durationSec) fires every chargeSec + durationSec.
 */
export function activeBonus(config, state) {
  const A = config.active, ws = state.workshop;
  const chance = Math.min(1, statAt(config.workshop.goldenTouch, ws.goldenTouch || 0) / 100);
  const touch = 1 + chance * (A.tapBall.mul - 1);
  const F = A.frenzy;
  const frenzy = (ws.autoFrenzy || 0) > 0 ? 1 + (F.durationSec / (F.durationSec + F.chargeSec)) * (F.mul - 1) : 1;
  return { chance, touch, frenzy, mul: touch * frenzy };
}

/** Exact expected coins per ball (averaged over droppers) and per second. */
export function income(config, state, ctx = buildDropContext(config, state)) {
  const ev = ctx.ev ?? boardEV(ctx.model);
  const rate = dropsPerSec(config, state, ctx.model.droppers.length);
  const bonus = activeBonus(config, state);
  return { perBall: ev.perBall, rate, bonus, perSec: ev.perBall * rate * bonus.mul, ev };
}

// ---------------------------------------------------------------------------
// Board goal: coins earned on a board fill its goal meter. Milestones along the way
// unlock that board's pieces and extra droppers; a full meter opens the next board.

/** Display name of a milestone key ('piece:lids' | 'dropper:1'). */
export function unlockName(config, key) {
  const [kind, id] = key.split(':');
  return kind === 'piece' ? config.boardTree.pieces[id].name : `${config.boardTree.droppers.name} ${id}`;
}

export function boardProgress(config, state) {
  const board = config.boards[state.boardIndex];
  const earned = state.boardUp?.earned || 0;
  const goal = board.goal;
  const milestones = (board.milestones || []).map((m) => ({ ...m, name: unlockName(config, m.unlock), reached: earned >= m.at * goal }));
  return { earned, goal, frac: Math.min(1, earned / goal), done: earned >= goal, milestones, next: milestones.find((m) => !m.reached) || null };
}

/** The milestone still locking `key` on this board, or null when it is open. */
function milestoneLock(config, state, key) {
  if (state.unlockAll) return null;
  const board = config.boards[state.boardIndex];
  const m = (board.milestones || []).find((x) => x.unlock === key);
  return m && (state.boardUp?.earned || 0) < m.at * board.goal ? m : null;
}


const pctChange = (now, after) => (now > 0 ? (after / now - 1) * 100 : 0);

/** Preview of buying one level of a workshop item. */
export function previewWorkshop(config, state, key) {
  const now = income(config, state).perSec;
  const next = { ...state, workshop: { ...state.workshop, [key]: state.workshop[key] + 1 } };
  return { now, after: income(config, next).perSec, pct: pctChange(now, income(config, next).perSec) };
}

/** Landing preview for a ball type on the current board, compared with the equipped ball. */
export function previewBall(config, state, typeId) {
  const ctx = buildDropContext(config, state, typeId);
  const inc = income(config, { ...state, equipped: typeId }, ctx);
  const now = income(config, state).perSec;
  const top = ctx.top.reduce((s, k) => s + ctx.probs[k], 0);
  return { ctx, probs: ctx.probs, perSec: inc.perSec, pct: pctChange(now, inc.perSec), topOneIn: 1 / top };
}

// ---------------------------------------------------------------------------
// Board tree actions. One description drives cost, lock state, preview and purchase.
//   { kind: 'place', socket, type } | { kind: 'socket', socket } | { kind: 'piece', id } | { kind: 'dropper' }

export function boardActionInfo(config, state, action) {
  state = withBoardUp(config, state);
  const board = config.boards[state.boardIndex];
  const T = config.boardTree;
  const up = state.boardUp;
  const unlockAll = !!state.unlockAll;
  let item, level, max, locked = false, lockedText = '';
  switch (action.kind) {
    case 'place':
      item = T.pegs[action.type]; level = 0; max = 1;
      if (up.sockets[action.socket]) { max = 0; }
      if (!unlockAll && !board.pegTypes.includes(action.type)) { locked = true; lockedText = 'Later boards'; }
      break;
    case 'socket': {
      const s = up.sockets[action.socket];
      item = T.pegs[s.type]; level = s.level; max = pegMaxLevel(board, item); break;
    }
    case 'piece':
      item = T.pieces[action.id]; level = up.pieces[action.id]; max = item.maxLevel;
      if (!unlockAll && !board.pieces.includes(action.id)) { locked = true; lockedText = 'Later boards'; }
      else if (milestoneLock(config, state, `piece:${action.id}`)) { locked = true; lockedText = `Goal ${fmt(milestoneLock(config, state, `piece:${action.id}`).at * board.goal)}`; }
      else if (item.requires && !up.pieces[item.requires]) { locked = true; lockedText = `Needs ${T.pieces[item.requires].name}`; }
      break;
    case 'dropper':
      item = T.droppers; level = up.droppers || 0;
      max = (unlockAll ? 3 : Math.min(board.maxDroppers, 3)) - 1;
      if (max <= 0) { locked = true; lockedText = 'Later boards'; }
      else if (level < max && milestoneLock(config, state, `dropper:${level + 1}`)) { locked = true; lockedText = `Goal ${fmt(milestoneLock(config, state, `dropper:${level + 1}`).at * board.goal)}`; }
      break;
  }
  const maxed = level >= max;
  const cost = boardCost(config, board, item, level, action.kind === 'place' || action.kind === 'socket');
  return { action, item, level, max, maxed, locked, lockedText, cost };
}

/** Returns a new state with the action applied (no cost check). */
export function applyBoardAction(config, state, action) {
  state = withBoardUp(config, state);
  const up = structuredClone(state.boardUp);
  switch (action.kind) {
    case 'place': up.sockets[action.socket] = { type: action.type, level: 1 }; break;
    case 'socket': up.sockets[action.socket].level++; break;
    case 'piece':
      up.pieces[action.id]++;
      if (action.id === 'lids') up.lidPos.push(null); // placed below
      break;
    case 'dropper': up.droppers = (up.droppers || 0) + 1; break;
  }
  return settleLayout(config, { ...state, boardUp: up });
}

/**
 * Keep the layout legal after a change: lift any lid that would trap a ball with another
 * piece, then give every unplaced lid the best-paying free gap.
 */
export function settleLayout(config, state) {
  const up = state.boardUp;
  const ball = ballStats(config, state);
  const ok = () => isValidLayout(config, state, ball);
  // Trampoline / magnet: a freshly bought one (or one that no longer fits) goes to its best bucket.
  for (const [id, key] of [['trampoline', 'trampBucket'], ['magnet', 'magnetTarget']]) {
    if (!up.pieces[id] || (up[key] != null && ok())) continue;
    const saved = up.lidPos; up.lidPos = up.lidPos.map(() => null); // judge the bucket without lids in the way
    let best = null;
    for (const k of pieceBuckets(config, state)) {
      up[key] = k;
      if (!ok()) continue;
      const v = boardEV(boardModel(config, state, ball)).perBall;
      if (!best || v > best.v) best = { v, k };
    }
    up[key] = best ? best.k : null;
    up.lidPos = saved;
  }
  // lift lids until nothing is trapped (newest first)
  for (let n = up.lidPos.length - 1; n >= 0 && !ok(); n--) up.lidPos[n] = null;
  for (let n = 0; n < up.lidPos.length; n++) {
    if (up.lidPos[n]) continue;
    let best = null;
    for (const g of lidGaps(config, state)) {
      up.lidPos[n] = { r: g.r, j: g.j };
      if (ok()) {
        const v = boardEV(boardModel(config, state, ball)).perBall;
        if (!best || v > best.v) best = { v, g };
      }
    }
    up.lidPos[n] = best ? { r: best.g.r, j: best.g.j } : null;
  }
  return state;
}

/**
 * Where a piece could be moved, with the income change of each spot versus now.
 * what: { kind: 'lid', n } | { kind: 'trampoline' } | { kind: 'magnet' }
 * @returns [{ r, j } | { bucket }] each with { pct, current }
 */
export function placementOptions(config, state, what) {
  state = withBoardUp(config, state);
  const now = income(config, state).perSec;
  const ball = ballStats(config, state);
  const out = [];
  const tryState = (mutate) => {
    const next = { ...state, boardUp: structuredClone(state.boardUp) };
    mutate(next.boardUp);
    if (!isValidLayout(config, next, ball)) return null;
    return pctChange(now, income(config, next).perSec);
  };
  if (what.kind === 'lid') {
    const cur = state.boardUp.lidPos[what.n];
    const lifted = { ...state, boardUp: { ...state.boardUp, lidPos: state.boardUp.lidPos.map((p, n) => (n === what.n ? null : p)) } };
    for (const g of lidGaps(config, lifted)) {
      const pct = tryState((up) => { up.lidPos[what.n] = { r: g.r, j: g.j }; });
      if (pct != null) out.push({ ...g, pct, current: !!cur && cur.r === g.r && cur.j === g.j });
    }
  } else {
    const m = buildDropContext(config, state).model;
    const key = what.kind === 'trampoline' ? 'trampBucket' : 'magnetTarget';
    const cur = what.kind === 'trampoline' ? m.trampoline?.bucket : m.magnet?.target;
    for (const k of pieceBuckets(config, state)) {
      const pct = tryState((up) => { up[key] = k; });
      if (pct != null) out.push({ bucket: k, pct, current: k === cur });
    }
  }
  return out;
}

/** Apply a placement (returns a new state, or null if it would trap a ball). */
export function applyPlacement(config, state, what, spot) {
  state = withBoardUp(config, state);
  const up = structuredClone(state.boardUp);
  if (what.kind === 'lid') up.lidPos[what.n] = { r: spot.r, j: spot.j };
  else if (what.kind === 'trampoline') up.trampBucket = spot.bucket;
  else up.magnetTarget = spot.bucket;
  const next = { ...state, boardUp: up };
  return isValidLayout(config, next, ballStats(config, state)) ? next : null;
}

export function previewBoardAction(config, state, action) {
  const now = income(config, state).perSec;
  const after = income(config, applyBoardAction(config, state, action)).perSec;
  return { now, after, pct: pctChange(now, after) };
}

/** Human-readable now → next for a board action. */
export function boardActionEffect(config, state, action) {
  state = withBoardUp(config, state);
  const T = config.boardTree;
  const up = state.boardUp;
  const pct = (x) => `${Math.round(x * 100)}%`;
  switch (action.kind) {
    case 'place': case 'socket': {
      const type = action.type ?? up.sockets[action.socket].type;
      const L = action.kind === 'place' ? 0 : up.sockets[action.socket].level;
      const f = (lv) => {
        if (lv <= 0) return '—';
        const bd = config.boards[state.boardIndex], fine = (bd.pegSteps ?? 1) > 1 ? 3 : 2;
        const n = pegNumbers(T, type, pegEffLevel(bd, lv), bd.power ?? 1);
        return type === 'gold' ? `+${n.bonus}× value` : type === 'multiplier' ? `×${n.factor.toFixed(fine)}` : type === 'splitter' ? `${(n.chance * 100).toFixed(fine - 2)}% split` : `${(n.push * 100).toFixed(fine - 2)}% push`;
      };
      return [f(L), f(L + 1), ''];
    }
    case 'piece': {
      const L = up.pieces[action.id];
      const f = (lv) => {
        if (action.id === 'suctionPull') return `${pct(T.pieces.suctionPull.pullByLevel[Math.min(lv, T.pieces.suctionPull.pullByLevel.length - 1)])} pulled`;
        const n = pieceNumbers(T, action.id, lv, config.boards[state.boardIndex].power ?? 1);
        if (!n) return 'off';
        switch (action.id) {
          case 'lids': return `${n.count} lid${n.count > 1 ? 's' : ''}`;
          case 'flippers': return 'installed';
          case 'autoFlip': return `${pct(n.chance)} auto`;
          case 'trampoline': return `×${n.bonus} per bounce`;
          case 'suction': return `${n.rowCount} wind row${n.rowCount > 1 ? 's' : ''}`;
          case 'suctionPull': return `${pct(n.pull)} pulled`;
          default: return `reach ${n.reach} row${n.reach > 1 ? 's' : ''}`;
        }
      };
      return [f(L), f(L + 1), ''];
    }
  }
  if (action.kind === 'dropper') { const n = 1 + (up.droppers || 0); return [`${n}`, `${n + 1}`, 'droppers']; }
  return ['', '', ''];
}
