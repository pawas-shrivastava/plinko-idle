// Board model: everything the board tree changes, resolved into numbers the drop
// resolver and the EV calculator share. Pure.
//
// Order of operations for one ball (simulation and EV follow the same rules):
//   1. Landing odds from its start peg: beta-binomial over the remaining rows, × reweights
//      (Bumper pegs, Side Suction), Magnet pull, then the jackpot cap.       → bucket
//   2. Lattice path to that bucket, special pegs weighted by Luck × attraction.
//      Pegs on the way: Gold (+coins), Multiplier (× payout), Splitter (child ball).
//      Comet / Splitter traits act on the ball's FIRST special peg of its first descent.
//   3. Movement rules at pegs. When the ball at peg (r, i) is about to go left/right, the
//      rules on that branch are tried in order; one that fires moves the ball to a target
//      peg (rT, jo) instead and the rest of the fall is re-drawn from there (step 1).
//        Flipper (Auto-Flip chance): flings the ball `flyRows` rows outward in one arc.
//        Blocks (always fire): the ball simply goes the other way.
//          Lid over the gap between row-r pegs j and j+1: closes the way into (r+1, j);
//            the bounce also shifts the re-drawn odds `kick` buckets further that way.
//          Suction (pull-rate chance): in the wind rows a ball heading inward is turned
//            toward the nearer wall instead — unless a lid or the magnet closes that way.
//          Magnet with reach n: inside the triangle of pegs n rows above its bucket,
//            a ball may only move so that the bucket stays reachable — it always lands there.
//      Bonuses and trait state carry over. Rules act on children too.
//      A peg with both ways blocked would trap the ball: such a layout is invalid.
//   4. Trampoline: every ball (children too) landing in its bucket is relaunched from a
//      random peg of a mid row; the first `maxBonusBounces` bounces each multiply the
//      ball's payout by the bonus. Traits are spent after the first bounce.
//   payout = (value × bucketMult + gold) × Π multiplierPegs × (Golden ? ×2 : 1)
import { bucketDistribution, normalize } from './distribution.js';
import { statAt, costAt } from './economy-base.js';

/**
 * Board shape: which lattice pegs (r < rows) and buckets (r = rows) exist. A board is a
 * triangle by default; `shape` carves it, in units of peg spacing from the centre line
 * (x = i - r/2). Each field is a number or a per-row array (rows + 1 entries, last = buckets):
 *   halfWidth: keep |x| ≤ w        (hourglass waists, narrow boards)
 *   xMin / xMax: keep xMin ≤ x ≤ xMax   (a wall down one side)
 *   gap: drop |x| < g              (a wedge splitting the board)
 * Where a peg's way down leads to a missing peg there is a wall: the ball goes the other way.
 */
export function shapeFn(board) {
  const S = board.shape;
  if (!S) return () => true;
  const at = (v, r) => (Array.isArray(v) ? v[r] : v);
  return (r, i) => {
    const x = i - r / 2, e = 1e-9;
    if (S.halfWidth != null && Math.abs(x) > at(S.halfWidth, r) + e) return false;
    if (S.xMin != null && x < at(S.xMin, r) - e) return false;
    if (S.xMax != null && x > at(S.xMax, r) + e) return false;
    if (S.gap != null && Math.abs(x) < at(S.gap, r) - e) return false;
    return true;
  };
}

/** Fresh per-board upgrade state. */
export function emptyBoardUp(board) {
  return {
    sockets: board.sockets.map(() => null), // { type, level }
    pieces: { lids: 0, flippers: 0, autoFlip: 0, trampoline: 0, suction: 0, suctionPull: 0, magnet: 0 },
    lidPos: [],                 // one { r, j } (gap between pegs j and j+1 of row r) or null per owned lid
    trampBucket: null,          // null = default (lowest bucket)
    magnetTarget: null,         // null = default (next to the lowest bucket)
    autoFlipOn: true,
    earned: 0,                  // coins earned on this board (fills its goal meter)
    droppers: 0,                // extra side droppers bought
  };
}

/** Bucket multipliers: explicit array or symmetric curve. Fixed per board (no upgrades). */
export function baseMultipliers(board) {
  const rows = board.rows;
  const m = board.multipliers;
  const scale = board.payoutScale ?? 1; // later boards pay more: the whole row of buckets is scaled up
  // flatten < 1 squeezes the gap between jackpot and centre buckets; board.power weakens the multiplying pieces
  const flat = (x) => (x > 0 ? Number(Math.pow(x, board.flatten ?? 1).toPrecision(2)) : 0);
  if (Array.isArray(m)) {
    if (m.length !== rows + 1) throw new Error(`board ${board.id}: ${m.length} multipliers for ${rows + 1} buckets`);
    return m.map((x) => flat(x) * scale);
  }
  const half = rows / 2;
  const out = [];
  for (let k = 0; k <= rows; k++) {
    const d = Math.abs(k - half) / half;
    out.push(scale * flat(m.center * Math.pow(m.edge / m.center, Math.pow(d, m.curve))));
  }
  return out;
}

const lvl = (base, per, L) => base + per * (L - 1); // value at level L ≥ 1

const pw = (x, p) => Number(Math.pow(x, p).toFixed(4)); // a multiplier weakened by the board's power

/** Per-peg numbers at a level (level ≥ 1). power = the board's strength setting (1 = full). */
export function pegNumbers(T, type, level, power = 1) {
  const P = T.pegs[type];
  switch (type) {
    case 'gold': return { bonus: Number((lvl(P.bonusBase, P.bonusPerLevel, level) * power).toFixed(3)) };
    case 'multiplier': return { factor: pw(lvl(P.factorBase, P.factorPerLevel, level), power) };
    case 'splitter': return { chance: Math.min(P.chanceMax, lvl(P.chanceBase, P.chancePerLevel, level)) };
    case 'bumper': return { push: lvl(P.pushBase, P.pushPerLevel, level) };
  }
  return {};
}

export function pieceNumbers(T, id, level, power = 1) {
  const P = T.pieces[id];
  if (level <= 0) return null;
  switch (id) {
    case 'lids': return { level, count: level, kick: P.kick };
    case 'flippers': return { level, flyRows: P.flyRows };
    case 'autoFlip': return { level, chance: P.chanceByLevel[Math.min(level, P.chanceByLevel.length) - 1] };
    case 'trampoline': return { level, bonus: pw(P.bonusByLevel[Math.min(level, P.bonusByLevel.length) - 1], power), maxBonusBounces: P.maxBonusBounces, restartRowFrac: P.restartRowFrac };
    case 'suction': return { level, rowCount: level, startRowFrac: P.startRowFrac };
    case 'suctionPull': return { level, pull: P.pullByLevel[Math.min(level, P.pullByLevel.length - 1)] };
    case 'magnet': return { level, reach: P.reachByLevel[Math.min(level, P.reachByLevel.length) - 1] };
  }
  return null;
}

/**
 * Resolve the board for a given ball.
 * @param {object} config
 * @param {object} state  needs boardIndex, boardUp
 * @param {object} ball   ballStats(): { value, luck, spread, type, trait, traitStrength, golden }
 */
export function boardModel(config, state, ball) {
  const board = config.boards[state.boardIndex];
  const T = config.boardTree;
  const up = state.boardUp;
  const R = board.rows;
  const base = baseMultipliers(board);
  const mults = base;
  const allowed = shapeFn(board);
  const buckets = base.map((_, k) => k).filter((k) => allowed(R, k)); // buckets that exist
  const maxBase = Math.max(...buckets.map((k) => base[k])), minBase = Math.min(...buckets.map((k) => base[k]));
  const top = buckets.filter((k) => base[k] === maxBase);
  const lowest = buckets.filter((k) => base[k] === minBase);

  const traitId = ball.trait && ball.trait.active ? ball.type.trait : null;
  const heavy = traitId === 'heavy';

  // Special pegs on sockets
  const pegs = new Map(); // key r*256+i
  const bumpers = [];
  board.sockets.forEach((sock, idx) => {
    const s = up.sockets[idx];
    if (!s || s.level <= 0) return;
    if (sock.r >= R) return;
    const nums = pegNumbers(T, s.type, pegEffLevel(board, s.level), board.power ?? 1);
    if (s.type === 'bumper') { bumpers.push(nums.push); if (heavy) return; }
    const P = T.pegs[s.type];
    pegs.set(sock.r * 256 + sock.i, {
      socket: idx, type: s.type, level: s.level, r: sock.r, i: sock.i,
      weight: 1 + ball.luck * P.attraction,
      gold: s.type === 'gold' ? ball.value * nums.bonus * (board.payoutScale ?? 1) : 0, // scales with the board's payouts
      factor: s.type === 'multiplier' ? nums.factor : 1,
      split: s.type === 'splitter' ? nums.chance : 0,
    });
  });

  const clampBucket = (k, dflt) => (k == null || !buckets.includes(k) || top.includes(k) ? dflt : k);
  const trampoline = pieceNumbers(T, 'trampoline', up.pieces.trampoline, board.power ?? 1);
  if (trampoline) {
    trampoline.bucket = clampBucket(up.trampBucket, lowest[0]);
    trampoline.restartRow = Math.max(1, Math.round(R * trampoline.restartRowFrac));
    trampoline.restartNodes = Array.from({ length: trampoline.restartRow + 1 }, (_, i) => i).filter((i) => allowed(trampoline.restartRow, i));
  }
  const magnet = pieceNumbers(T, 'magnet', up.pieces.magnet);
  if (magnet) magnet.reach = Math.min(magnet.reach, Math.floor(R / 2)); // never more than half the board
  if (magnet) magnet.target = clampBucket(up.magnetTarget, top[0] === 0 ? 1 : top[0] - 1); // default: beside a jackpot
  if (magnet && trampoline && magnet.target === trampoline.bucket) {
    const e = new Error(`board ${board.id}: magnet and trampoline share bucket ${magnet.target}`);
    e.trap = true;
    throw e;
  }
  const suction = pieceNumbers(T, 'suction', up.pieces.suction);
  if (suction) {
    const r0 = Math.max(1, Math.floor(R * suction.startRowFrac));
    suction.rows = [r0, Math.min(R - 1, r0 + suction.rowCount)]; // [first, end)
    suction.pull = T.pieces.suctionPull.pullByLevel[Math.min(up.pieces.suctionPull || 0, T.pieces.suctionPull.pullByLevel.length - 1)];
  }

  // Movement rules: key r*256+i → [rulesIfGoingLeft[], rulesIfGoingRight[]], tried in order.
  //   rule = { kind, id, chance, rT, jo, kickDir }
  const rules = new Map();
  const addRule = (r, i, branch, rule) => {
    if (rule.chance <= 0 || r < 0 || r >= R || i < 0 || i > r) return;
    const key = r * 256 + i;
    const pair = rules.get(key) || [[], []];
    if (rule.chance >= 1 && pair[branch].some((x) => x.chance >= 1)) return; // already blocked that way
    pair[branch].push(rule);
    rules.set(key, pair);
  };
  /** Block one way out of (r, i): the ball goes the other way instead. */
  const block = (r, i, branch, kind, id, kickDir) =>
    addRule(r, i, branch, { kind, id, chance: 1, rT: r + 1, jo: branch ? i : i + 1, kickDir });

  const flipN = pieceNumbers(T, 'flippers', up.pieces.flippers);
  const autoN = flipN && up.autoFlipOn ? pieceNumbers(T, 'autoFlip', up.pieces.autoFlip) : null;
  const flippers = flipN ? (board.flippers || []).filter((f) => f.r + flipN.flyRows <= R).map((f, n) => {
    const rT = f.r + flipN.flyRows;
    return { n, ...f, rT, jo: f.dir < 0 ? f.i : f.i + flipN.flyRows };
  }) : [];
  if (autoN) for (const f of flippers) {
    for (const branch of [0, 1]) addRule(f.r, f.i, branch, { kind: 'flip', id: `flip${f.n}`, flipper: f.n, chance: autoN.chance, rT: f.rT, jo: f.jo, kickDir: 0 });
  }

  // Walls: the edges of the board's shape.
  for (let r = 0; r < R; r++) for (let i = 0; i <= r; i++) {
    if (!allowed(r, i)) continue;
    if (!allowed(r + 1, i)) block(r, i, 0, 'wall', 'wall', 0);
    if (!allowed(r + 1, i + 1)) block(r, i, 1, 'wall', 'wall', 0);
  }

  const lidN = pieceNumbers(T, 'lids', up.pieces.lids);
  const lids = [];
  if (lidN) (up.lidPos || []).slice(0, lidN.count).forEach((pos, n) => {
    if (!pos) return;
    const { r, j } = pos;
    lids.push({ n, id: `lid${n}`, r, j, cover: 1 });
    block(r, j - 1, 1, 'lid', `lid${n}`, lidN.kick ? -1 : 0); // from the left peg, going right
    block(r, j, 0, 'lid', `lid${n}`, lidN.kick ? 1 : 0);      // from the right peg, going left
  });

  if (magnet) {
    const t = magnet.target;
    for (let r = Math.max(0, R - magnet.reach); r < R; r++) {
      const left = R - r; // rows still to fall
      // (never closes a way that could still reach a jackpot bucket)
      const jackpotFrom = (ci) => top.some((k) => k >= ci && k <= ci + left - 1);
      for (let i = Math.max(0, t - left); i <= Math.min(r, t); i++) {
        if (i === t && !jackpotFrom(i + 1)) block(r, i, 1, 'magnet', 'magnet', 0);    // going right would overshoot
        if (t - i === left && !jackpotFrom(i)) block(r, i, 0, 'magnet', 'magnet', 0); // going left would fall short
      }
    }
  }

  if (suction) {
    for (let r = suction.rows[0]; r < suction.rows[1]; r++) {
      for (let i = 0; i <= r; i++) {
        if (2 * i === r) continue; // dead centre: the wind is balanced
        const inward = 2 * i < r ? 1 : 0; // left of centre the inward step is "right"
        const outwardShut = rules.get(r * 256 + i)?.[1 - inward].some((x) => x.chance >= 1);
        if (outwardShut) continue; // can't be pulled through a lid / against the magnet
        addRule(r, i, inward, { kind: 'suction', id: 'suction', chance: suction.pull, rT: r + 1, jo: inward ? i : i + 1, kickDir: 0 });
      }
    }
  }

  for (const [key, pair] of rules) {
    if (pair[0].some((x) => x.chance >= 1) && pair[1].some((x) => x.chance >= 1)) {
      const e = new Error(`board ${board.id}: peg (${key >> 8},${key & 255}) is blocked both ways`);
      e.trap = true;
      throw e;
    }
  }
  const maxRuleRow = Math.max(-1, ...[...rules.keys()].map((k) => k >> 8));

  // Bucket reweights (outward pushes) — explicit, configurable, multiplicative.
  const out = (k) => Math.abs(k - R / 2) / (R / 2);
  const reweight = new Array(R + 1).fill(1).map((w, k) => {
    for (const push of bumpers) if (!heavy) w *= 1 + push * out(k);
    return w;
  });

  const traits = {
    comet: traitId === 'comet',
    splitChance: traitId === 'splitter' ? Math.min(1, config.traits.splitter.chance * ball.traitStrength) : 0,
  };

  const spread = config.distribution.spreads[ball.spread];
  const capTop = T.topBucketMaxChance;
  const distCache = new Map();

  /** P(bucket) for a ball starting on lattice peg (r0, i0). Length R+1. */
  function startDist(r0, i0) {
    const key = r0 * 256 + i0;
    let p = distCache.get(key);
    if (p) return p;
    const n = R - r0;
    const local = bucketDistribution(n, board.distribution, spread, config.distribution);
    p = new Array(R + 1).fill(0);
    for (let j = 0; j <= n; j++) p[i0 + j] = local[j] * reweight[i0 + j];
    p = normalize(p);
    p = capJackpot(p);
    distCache.set(key, p);
    return p;
  }

  // Jackpot cap: stacking pushes must never make the top bucket common.
  function capJackpot(p) {
    const topSum = top.reduce((s, k) => s + p[k], 0);
    if (topSum <= capTop || topSum > 1 - 1e-9) return p;
    const fTop = capTop / topSum, fRest = (1 - capTop) / (1 - topSum);
    return p.map((v, k) => (top.includes(k) ? v * fTop : v * fRest));
  }

  /** Odds after a lid bounce: startDist from (r0, i0) shifted `kick` buckets toward dir (±1). */
  function deflectDist(r0, i0, dir) {
    const key = -((r0 * 256 + i0) * 2 + (dir > 0 ? 1 : 0)) - 1;
    let p = distCache.get(key);
    if (p) return p;
    const base = startDist(r0, i0), n = R - r0;
    p = new Array(R + 1).fill(0);
    const kick = T.pieces.lids.kick;
    for (let k = i0; k <= i0 + n; k++) {
      let to = Math.max(i0, Math.min(i0 + n, k + dir * kick));
      while (to !== k && top.includes(to)) to -= dir; // a kick never pushes a ball into the jackpot
      p[to] += base[k];
    }
    p = capJackpot(p);
    distCache.set(key, p);
    return p;
  }

  return {
    board, rows: R, base, mults, top, lowest, allowed, buckets, pegs, bumpers, lids, flippers, trampoline, suction, magnet, traits, heavy,
    rules, maxRuleRow, ruleAt: (r, i) => rules.get(r * 256 + i) || null,
    droppers: dropperPositions(config, board).filter((d) => allowed(d.startRow, d.startI)).slice(0, 1 + Math.max(0, up.droppers || 0)),
    startDist, deflectDist, reweight,
    pegAt: (r, i) => pegs.get(r * 256 + i) || null,
    ball,
  };
}

/**
 * Dropper positions for a board: the main one over the top peg, then one either side of it
 * at the same height, feeding the two end pegs of an early row. `via` is a waypoint that
 * steers the ball in between the frame pegs.
 */
export function dropperPositions(config, board) {
  const D = config.boardTree.droppers, L = config.layout;
  const r = Math.min(D.startRow, board.rows - 1);
  // A side ball slips in between the frame pegs of rows r-2 and r-1, then drops onto row r's end peg.
  const via = (side) => [side * ((r + 1) / 2 - 0.25), (r - 1.5) * L.rowSpacing];
  return [
    { startRow: 0, startI: 0, x: 0, via: null },
    { startRow: r, startI: 0, x: -D.chuteX, via: via(-1) },
    { startRow: r, startI: r, x: D.chuteX, via: via(1) },
  ];
}

/** Board-tree costs (scaled per board). */
export function boardCost(config, board, item, level, peg = false) {
  if (peg && board.pegCostRange) { // fine-stepped pegs: price climbs by pegCostRange over the whole level range
    const max = pegMaxLevel(board, item);
    return Math.ceil(item.cost.base * board.costScale * Math.pow(board.pegCostRange, level / Math.max(1, max - 1)));
  }
  return Math.ceil(costAt(item, level) * board.costScale);
}
/** Pegs can be bought in fine steps: pegSteps purchases make one full level. */
export const pegMaxLevel = (board, item) => item.maxLevel * (board.pegSteps ?? 1);
export const pegEffLevel = (board, n) => 1 + (n - 1) / (board.pegSteps ?? 1);
export { statAt };

// ---------------------------------------------------------------------------
// Placement helpers (player-placed pieces)

/** Would this upgrade state build without trapping a ball? */
export function isValidLayout(config, state, ball) {
  try { boardModel(config, state, ball); return true; } catch (e) { if (e.trap) return false; throw e; }
}

/** Every gap a lid could go in (ignoring traps): rows 1..R-2, not touching a flipper peg. */
export function lidGaps(config, state) {
  const board = config.boards[state.boardIndex], R = board.rows;
  const taken = new Set((state.boardUp.lidPos || []).filter(Boolean).map((p) => p.r * 256 + p.j));
  const flip = new Set((board.flippers || []).map((f) => f.r * 256 + f.i));
  // a flung ball drops through the gap right above its landing peg: keep that gap open
  const fly = config.boardTree.pieces.flippers.flyRows;
  const allowed = shapeFn(board);
  const flight = new Set((board.flippers || []).map((f) => (f.r + fly - 1) * 256 + (f.dir < 0 ? f.i : f.i + fly)));
  const out = [];
  const T = config.boardTree.pieces.lids;
  for (let r = Math.ceil(R * T.minRowFrac); r <= R - 2; r++) {
    for (let j = 0; j <= r + 1; j++) {
      if (taken.has(r * 256 + j)) continue;
      if (flip.has(r * 256 + j - 1) || flip.has(r * 256 + j)) continue; // lattice j-1 / j are the two pegs
      if (flight.has(r * 256 + j)) continue;
      if (!allowed(r + 1, j)) continue;                                        // nothing below to close off
      if (!(j >= 1 && allowed(r, j - 1)) && !(j <= r && allowed(r, j))) continue; // no peg beside it
      out.push({ r, j });
    }
  }
  return out;
}

/** Buckets a trampoline or magnet may sit on: anything but a jackpot bucket. */
export function pieceBuckets(config, state) {
  const board = config.boards[state.boardIndex];
  const allowed = shapeFn(board);
  const base = baseMultipliers(board);
  const ks = base.map((_, k) => k).filter((k) => allowed(board.rows, k));
  const max = Math.max(...ks.map((k) => base[k]));
  return ks.filter((k) => base[k] !== max);
}
