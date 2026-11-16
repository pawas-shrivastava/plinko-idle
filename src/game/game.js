// Game state + simulation. No DOM, no canvas.
import { resolveDrop, animRngFor, flipBall, legIndexAt } from '../core/drop.js';
import { boardGeometry } from '../core/geometry.js';
import { emptyBoardUp } from '../core/board.js';
import { makeRng, hash32 } from '../core/rng.js';
import { fmt } from '../core/format.js';
import { buildSegments, evalSegment } from './anim.js';
import {
  buildDropContext, income, costAt, statAt, previewWorkshop, previewBall, dropsPerSec,
  boardActionInfo, applyBoardAction, previewBoardAction, boardActionEffect,
  placementOptions, applyPlacement, boardProgress,
} from '../core/economy.js';

const num = (v) => fmt(v, { decimals: true });
const splitKeys = (node) => new Set(node.legs.flatMap((leg) => leg.splits.map((s) => s.r * 256 + s.i)));

export class Game {
  constructor(config, { seed, boardIndex = 0, unlockAll = false }) {
    this.config = config;
    const owned = {};
    for (const t of config.ballTypes) {
      if (config.prototype.allBallsOwned || t.id === config.startingBall) owned[t.id] = { stars: 1 };
    }
    this.state = {
      seed,
      boardIndex,
      coins: config.economy.startCoins,
      totalEarned: 0,
      ftue: 0,                    // tutorial step reached (steps in config.ftue)
      unlocked: 1,                // how many boards are open (board N+1 opens when board N's goal is met)
      dropIndex: 0,
      equipped: config.startingBall,
      owned,
      workshop: Object.fromEntries(Object.keys(config.workshop).map((k) => [k, 0])),
      boardUp: emptyBoardUp(config.boards[boardIndex]),
      unlockAll,
    };
    this.stats = { drops: 0, landed: 0, jackpots: 0, goldens: 0, splits: 0, relaunches: 0, lidBounces: 0, autoFlips: 0, manualFlips: 0, buckets: [] };
    this.time = 0;
    this.listeners = {};

    // Pools — no allocation per frame once warmed.
    const P = config.pools;
    this.balls = Array.from({ length: P.maxBalls }, () => ({ active: false }));
    this.floats = Array.from({ length: P.maxFloatTexts }, () => ({ active: false }));
    this.activeBalls = 0;
    this.trampFlash = 0;
    this.boardUps = {};           // board index → its upgrade state while you're on another board
    this.forceNext = null;
    this.flipReady = [false, false]; // a ball is in each flipper's catch window (drawn as a lit ring)
    this.flipAnim = [0, 0];       // seconds since each flipper last fired (large = at rest)
    this.lidFlash = {};           // lid id → flash 0..1
    this.pieceEarned = {};        // 'lid' | 'trampoline' | 'magnet' | 'suction' | 'flip' → coins paid by balls it touched
    this.magnetFlash = 0;
    this.flipCount = 0;
    this.touchCount = 0;
    this.frenzy = { charge: 0, left: 0 }; // seconds of charge / seconds of Frenzy left

    // Rolling measured income (1s buckets) to sanity-check the analytic number.
    this.incomeRing = new Float64Array(config.sim.incomeWindowSec);
    this.ringSec = 0;
    this.ringFilled = 0;

    this.rebuild();
    this.dropAcc = 1 - config.sim.firstDropDelaySec * this.releasesPerSec; // first release almost immediately
  }

  on(evt, fn) { (this.listeners[evt] ||= []).push(fn); }
  emit(evt, data) { for (const fn of this.listeners[evt] || []) fn(data); }

  /** Recompute everything derived from board / ball / upgrades. */
  rebuild() {
    const prevRows = this.geo?.rows;
    this.ctx = buildDropContext(this.config, this.state);
    this.model = this.ctx.model;
    this.geo = boardGeometry(this.ctx.rows, this.config.layout);
    this.income = income(this.config, this.state, this.ctx);
    this.releasesPerSec = this.income.rate; // every dropper drops at the full Drop Rate
    this.animOpts = this.buildAnimOpts();
    if (prevRows !== this.geo.rows) {
      this.flushBalls(); // geometry changed: pay in-flight balls now rather than animate on a stale board
      this.pegFlash = new Float32Array(this.geo.pegCount);
      this.bucketBounce = new Float32Array(this.ctx.rows + 1);
      this.stats.buckets = new Array(this.ctx.rows + 1).fill(0);
      this.stats.landed = 0;
    }
    this.previewCache = new Map();
    this.emit('rebuild');
  }

  get board() { return this.ctx.board; }

  /** Switch to another board. Each board keeps its own pieces; Workshop and balls carry over. */
  setBoard(index) {
    const st = this.state;
    if (index === st.boardIndex || !this.boardOpen(index)) return false;
    this.flushBalls();
    this.boardUps[st.boardIndex] = st.boardUp;
    st.boardIndex = index;
    st.boardUp = this.boardUps[index] || emptyBoardUp(this.config.boards[index]);
    this.pieceEarned = {};
    this.geo = null; // force per-board arrays (peg flashes, bucket stats) to be rebuilt
    this.rebuild();
    this.emit('board_change', { board: this.board.id });
    return true;
  }

  /** Board-piece geometry the animation needs. */
  buildAnimOpts() {
    const m = this.model, geo = this.geo, L = this.config.layout;
    return {
      top: this.ctx.top, motion: this.ctx.ball.type.motion,
      lidThickness: L.lidThickness,
      tramp: m.trampoline ? { padY: geo.bucketTop - L.trampolinePadLift } : null,
    };
  }

  /** Trampoline pad width in lattice units: the whole bucket mouth. */
  trampolinePad() {
    return this.model.trampoline ? 1 - this.config.layout.bucketGap : 0;
  }

  /** Pay every in-flight ball immediately (used when the board's shape changes). */
  flushBalls() {
    for (const b of this.balls) {
      if (!b.active) continue;
      if (b.landedAt < 0) {
        this.earn(b.payout * this.payoutMul(b));
      }
      b.active = false;
    }
    this.activeBalls = 0;
  }

  // ---------- Board goal ----------
  /** Goal meter of the current board: { earned, goal, frac, done, milestones, next }. */
  get progress() { return boardProgress(this.config, this.state); }

  boardOpen(index) {
    if (!this.config.boards[index]) return false;
    return this.state.unlockAll || this.config.prototype.allBoardsOpen || index < this.state.unlocked;
  }

  /** Add coins; they also fill this board's goal meter (milestones unlock pieces, a full meter the next board). */
  earn(amount) {
    const st = this.state, up = st.boardUp, board = this.config.boards[st.boardIndex];
    const before = up.earned || 0;
    st.coins += amount;
    st.totalEarned += amount;
    up.earned = before + amount;
    const goal = board.goal;
    let crossed = false;
    for (const m of board.milestones || []) {
      if (before < m.at * goal && up.earned >= m.at * goal) { crossed = true; this.emit('milestone', { board: board.id, unlock: m.unlock }); }
    }
    if (before < goal && up.earned >= goal) {
      crossed = true;
      st.unlocked = Math.min(this.config.boards.length, Math.max(st.unlocked, st.boardIndex + 2));
      this.emit('board_complete', { board: board.id, next: this.config.boards[st.boardIndex + 1] || null });
    }
    if (crossed) { this.previewCache = new Map(); this.emit('rebuild'); } // lock states changed
  }

  // ---------- Save / load / offline ----------
  serialize() {
    const st = this.state;
    return {
      v: 1, savedAt: Date.now(),
      seed: st.seed, dropIndex: st.dropIndex, coins: st.coins, totalEarned: st.totalEarned,
      equipped: st.equipped, owned: st.owned, workshop: st.workshop, unlocked: st.unlocked, frenzyCharge: this.frenzy.charge, ftue: st.ftue,
      boardIndex: st.boardIndex, boardUps: { ...this.boardUps, [st.boardIndex]: st.boardUp },
    };
  }

  /** Load a save made by serialize(). Returns false (and changes nothing) if it doesn't fit this config. */
  restore(d) {
    if (!d || d.v !== 1 || !this.config.boards[d.boardIndex]) return false;
    const st = this.state;
    const fill = (idx, saved) => {
      const e = emptyBoardUp(this.config.boards[idx]);
      return { ...e, ...saved, pieces: { ...e.pieces, ...(saved.pieces || {}) } };
    };
    this.flushBalls();
    Object.assign(st, {
      seed: d.seed ?? st.seed, dropIndex: d.dropIndex || 0, coins: d.coins || 0, totalEarned: d.totalEarned || 0,
      unlocked: d.unlocked || 1, boardIndex: d.boardIndex, ftue: d.ftue || 0,
    });
    if (d.equipped && this.config.ballTypes.some((t) => t.id === d.equipped)) st.equipped = d.equipped;
    st.owned = { ...st.owned, ...(d.owned || {}) };
    for (const k of Object.keys(st.workshop)) st.workshop[k] = Math.min(this.config.workshop[k].maxLevel, d.workshop?.[k] || 0);
    this.frenzy = { charge: Math.min(this.config.active.frenzy.chargeSec, d.frenzyCharge || 0), left: 0 };
    this.boardUps = {};
    for (const [idx, up] of Object.entries(d.boardUps || {})) if (this.config.boards[idx]) this.boardUps[idx] = fill(idx, up);
    st.boardUp = this.boardUps[d.boardIndex] || emptyBoardUp(this.config.boards[d.boardIndex]);
    this.geo = null;
    try { this.rebuild(); } catch (e) { // a layout that no longer builds: start that board's pieces again
      st.boardUp = { ...emptyBoardUp(this.config.boards[d.boardIndex]), earned: st.boardUp.earned };
      this.rebuild();
    }
    return true;
  }

  /** Coins for time away: capped hours at a reduced rate. Returns { amount, sec } (0 if too short). */
  offlineEarn(awaySec) {
    const O = this.config.offline;
    if (!(awaySec >= O.minAwaySec)) return { amount: 0, sec: 0 };
    const sec = Math.min(awaySec, O.capHours * 3600);
    const amount = this.income.perSec * sec * O.efficiency;
    this.earn(amount);
    return { amount, sec, capped: awaySec > sec };
  }

  // ---------- Feature gates ----------
  hasFeature(name) {
    if (name === 'specialPegs') return this.state.boardUp.sockets.some((s) => s && s.level > 0);
    return true;
  }

  cached(key, fn) {
    if (!this.previewCache.has(key)) this.previewCache.set(key, fn());
    return this.previewCache.get(key);
  }

  // ---------- Workshop ----------
  workshopInfo(key) {
    const item = this.config.workshop[key];
    const level = this.state.workshop[key];
    const maxed = level >= item.maxLevel;
    const locked = item.requires ? !this.hasFeature(item.requires) : false;
    return {
      key, item, level, maxed, locked,
      cost: costAt(item, level, key === 'ballValue' ? this.config.boards[this.state.boardIndex].valueCost : undefined),
      now: statAt(item, level),
      next: statAt(item, level + 1),
      preview: this.cached(`ws:${key}`, () => previewWorkshop(this.config, this.state, key)),
    };
  }

  buy(key) {
    const info = this.workshopInfo(key);
    if (info.locked || info.maxed || this.state.coins < info.cost) return false;
    this.state.coins -= info.cost;
    this.state.workshop[key]++;
    this.rebuild();
    this.emit('purchase', { tree: 'ball', item: key, level: this.state.workshop[key], cost: info.cost });
    return true;
  }

  // ---------- Board tree ----------
  boardInfo(action) {
    const info = boardActionInfo(this.config, this.state, action);
    const preview = info.locked || info.maxed ? null : this.cached(`bd:${JSON.stringify(action)}`, () => previewBoardAction(this.config, this.state, action));
    return { ...info, preview, effect: boardActionEffect(this.config, this.state, action) };
  }

  buyBoard(action) {
    const info = boardActionInfo(this.config, this.state, action);
    if (info.locked || info.maxed || this.state.coins < info.cost) return false;
    this.state.coins -= info.cost;
    this.state.boardUp = applyBoardAction(this.config, this.state, action).boardUp;
    this.rebuild();
    const item = action.kind === 'place' ? action.type
      : action.kind === 'socket' ? this.state.boardUp.sockets[action.socket].type
      : action.id ?? action.kind;
    this.emit('purchase', { tree: 'board', item, level: info.level + 1, cost: info.cost });
    if (action.kind === 'place') this.emit('special_peg_placed', { type: action.type, socket: action.socket, board: this.board.id });
    return true;
  }

  setAutoFlip(on) {
    this.state.boardUp.autoFlipOn = on;
    this.rebuild();
  }

  // ---------- Placement (lids, trampoline, magnet) ----------
  /** Spots a piece can move to, each with its income change. what: {kind:'lid',n}|{kind:'trampoline'}|{kind:'magnet'} */
  placementOptions(what) {
    return this.cached(`place:${JSON.stringify(what)}`, () => placementOptions(this.config, this.state, what));
  }

  place(what, spot) {
    const next = applyPlacement(this.config, this.state, what, spot);
    if (!next) return false;
    this.state.boardUp = next.boardUp;
    this.flushBalls(); // balls in the air were aimed at the old layout: pay them now
    this.rebuild();
    this.emit('piece_placed', { piece: what.kind, board: this.board.id, ...spot });
    return true;
  }

  // ---------- Ball collection ----------
  ballInfo(typeId) {
    return {
      owned: !!this.state.owned[typeId], equipped: this.state.equipped === typeId,
      ...this.cached(`ball:${typeId}`, () => previewBall(this.config, this.state, typeId)),
    };
  }

  equip(typeId) {
    if (!this.state.owned[typeId] || this.state.equipped === typeId) return false;
    this.state.equipped = typeId;
    this.rebuild();
    this.emit('equip', { type: typeId, board: this.board.id });
    return true;
  }

  // ---------- Simulation ----------
  update(dt) {
    this.time += dt;
    const A = this.config.animation;

    // Frenzy: the meter charges with time (and taps); while it runs every payout is multiplied.
    const F = this.config.active.frenzy, fz = this.frenzy;
    if (fz.left > 0) { fz.left = Math.max(0, fz.left - dt); if (fz.left === 0) this.emit('frenzy_end'); }
    else {
      fz.charge = Math.min(F.chargeSec, fz.charge + dt);
      if (fz.charge >= F.chargeSec && this.state.workshop.autoFrenzy > 0) this.startFrenzy(true);
    }

    // Auto-drop
    this.dropAcc += dt * this.releasesPerSec;
    while (this.dropAcc >= 1) {
      this.dropAcc -= 1;
      this.spawn();
    }

    const tmp = this._tmp || (this._tmp = { x: 0, y: 0 });
    for (const b of this.balls) {
      if (!b.active) continue;
      b.t += dt;
      if (b.t < 0) continue; // split child not out yet
      while (b.seg < b.segs.length && b.t >= b.segs[b.seg].t0 + b.segs[b.seg].dur) {
        const s = b.segs[b.seg];
        if (s.hit >= 0) { this.pegFlash[s.hit] = 1; b.spinDir = -b.spinDir; }
        for (const e of s.events) this.onSegEvent(e, b);
        if (s.land) this.land(b); // pay on first contact; in-bucket bounces may follow
        b.seg++;
      }
      if (b.seg >= b.segs.length) {
        // Finished moving: sink into the bucket, then free the slot.
        if (b.doneAt < 0) { b.doneAt = this.time; const e = b.segs[b.segs.length - 1]; b.x = e.x1; b.y = e.y1; }
        if (this.time - b.doneAt > A.landSinkSec) { b.active = false; this.activeBalls--; }
        continue;
      }
      const s = b.segs[b.seg];
      evalSegment(s, Math.min(1, (b.t - s.t0) / s.dur), tmp);
      b.x = tmp.x; b.y = tmp.y;
      b.rot += b.spin * b.spinDir * dt;
    }

    // Catch rings: is a ball on (or about to land on) each flipper right now?
    const fl = this.model.flippers;
    this.flipReady[0] = this.flipReady[1] = false;
    if (fl.length) {
      for (const b of this.balls) {
        if (!b.active || b.t < 0 || b.landedAt >= 0) continue;
        for (const f of fl) if (!this.flipReady[f.n] && this.flipWindow(b, f)) this.flipReady[f.n] = true;
      }
    }

    const pegDecay = dt / A.pegFlashSec;
    for (let i = 0; i < this.pegFlash.length; i++) if (this.pegFlash[i] > 0) this.pegFlash[i] = Math.max(0, this.pegFlash[i] - pegDecay);
    const bDecay = dt / A.bucketBounceSec;
    for (let i = 0; i < this.bucketBounce.length; i++) if (this.bucketBounce[i] > 0) this.bucketBounce[i] = Math.max(0, this.bucketBounce[i] - bDecay);
    this.trampFlash = Math.max(0, this.trampFlash - bDecay);
    this.flipAnim[0] += dt; this.flipAnim[1] += dt;
    for (const id in this.lidFlash) this.lidFlash[id] = Math.max(0, this.lidFlash[id] - pegDecay);
    this.magnetFlash = Math.max(0, this.magnetFlash - pegDecay);

    for (const f of this.floats) {
      if (!f.active) continue;
      f.age += dt;
      if (f.age >= f.life) f.active = false;
    }

    const sec = Math.floor(this.time);
    while (this.ringSec < sec) {
      this.ringSec++;
      this.ringFilled = Math.min(this.ringFilled + 1, this.incomeRing.length);
      this.incomeRing[this.ringSec % this.incomeRing.length] = 0;
    }
  }

  onSegEvent(ev, b) {
    const A = this.config.animation;
    if (ev.kind === 'peg') {
      const at = { x: b.x, y: b.y - A.pegPopupRise, size01: 0, life: A.pegPopupSec };
      if (ev.type === 'gold') this.spawnFloat({ ...at, text: '+' + num(ev.gold), color: 'gold' });
      else if (ev.type === 'multiplier') this.spawnFloat({ ...at, text: '×' + ev.factor.toFixed(2).replace(/\.?0+$/, ''), color: 'mult' });
      else if (ev.type === 'bumper') this.spawnFloat({ ...at, text: 'BOING', color: 'bumper' });
      if (b.splitAt.has(ev.r * 256 + ev.i)) { this.stats.splits++; this.spawnFloat({ ...at, y: at.y - 0.3, text: 'SPLIT!', color: 'split' }); }
      this.emit('special_peg_hit', { type: ev.type });
    } else if (ev.kind === 'lid') {
      this.lidFlash[ev.id] = 1;
      this.stats.lidBounces++;
      this.spawnFloat({ x: b.x, y: b.y - A.pegPopupRise, size01: 0, life: A.pegPopupSec, text: 'CLONK', color: 'lid' });
    } else if (ev.kind === 'magnet') {
      this.magnetFlash = 1;
    } else if (ev.kind === 'flip') {
      this.flipAnim[ev.flipper] = 0;
      this.stats.autoFlips++;
    } else if (ev.kind === 'trampoline') {
      this.trampFlash = 1;
      this.bucketBounce[ev.bucket] = 1;
      const tr = this.model.trampoline;
      const n = (b.bounced = (b.bounced || 0) + 1);
      const txt = tr ? `BOING ×${tr.bonus}` : 'BOING';
      this.spawnFloat({ x: b.x, y: b.y - A.pegPopupRise, size01: 0.25, life: A.pegPopupSec, text: txt, color: 'boing' });
      this.stats.relaunches++;
    }
  }

  spawn() {
    const st = this.state;
    const idx = st.dropIndex++;
    const forced = this.forceNext;
    this.forceNext = null;
    const d = idx % this.model.droppers.length; // droppers take turns, each at the full Drop Rate
    const ball = resolveDrop(st.seed, idx, this.model, d, forced);
    this.stats.drops++;
    this.spawnVisual(ball, animRngFor(st.seed, idx), this.model.droppers[d], 0, makeRng(hash32(st.seed, idx, 3)), idx);
  }

  // ---------- Frenzy + tap-a-ball ----------
  get frenzyReady() { return this.frenzy.left <= 0 && this.frenzy.charge >= this.config.active.frenzy.chargeSec; }

  startFrenzy(auto = false) {
    if (!this.frenzyReady) return false;
    this.frenzy.left = this.config.active.frenzy.durationSec;
    this.frenzy.charge = 0;
    this.stats.frenzies = (this.stats.frenzies || 0) + 1;
    this.emit('frenzy', { auto, board: this.board.id });
    return true;
  }

  /** Tap at lattice (x, y): the nearest falling ball in reach starts to glow and pays ×mul. */
  tapBall(x, y) {
    const T = this.config.active.tapBall;
    let best = null, bd = T.radius;
    for (const b of this.balls) {
      if (!b.active || b.t < 0 || b.landedAt >= 0 || b.touched) continue;
      const d = Math.hypot(b.x - x, b.y - y);
      if (d < bd) { bd = d; best = b; }
    }
    if (!best) return false;
    best.touched = true;
    this.stats.taps = (this.stats.taps || 0) + 1;
    if (this.frenzy.left <= 0) this.frenzy.charge = Math.min(this.config.active.frenzy.chargeSec, this.frenzy.charge + T.chargeSec);
    const A = this.config.animation;
    this.spawnFloat({ x: best.x, y: best.y - A.pegPopupRise, size01: 0.2, life: A.pegPopupSec, text: `×${T.mul}`, color: 'golden' });
    this.emit('tap_ball', {});
    return true;
  }

  /** What a landing ball's payout is multiplied by right now (glow, Frenzy). */
  payoutMul(ball) {
    const A = this.config.active;
    const touch = ball ? (ball.touched ? A.tapBall.mul : 1) : this.income.bonus.touch; // no sprite: the average
    return touch * (this.frenzy.left > 0 ? A.frenzy.mul : 1);
  }

  // ---------- Flippers (manual) ----------
  /**
   * Fire flipper n (0 = left, 1 = right). Every ball sitting on it — or about to land on it —
   * is flung toward the edge and its rest of the fall re-drawn. Returns how many it caught.
   */
  flip(n) {
    const f = this.model.flippers[n];
    if (!f) return 0;
    const FL = this.config.animation.flipper;
    if (this.flipAnim[n] < FL.cooldownSec) return 0;
    this.flipAnim[n] = 0;
    let caught = 0;
    for (const b of this.balls) {
      if (!b.active || b.t < 0 || b.landedAt >= 0) continue;
      const hit = this.flipWindow(b, f);
      if (!hit) continue;
      const rng = makeRng(hash32(this.state.seed, b.dropIdx, 1000 + this.flipCount++));
      const node = flipBall(this.model, rng, b.node, hit.legIdx, f);
      if (!node) continue;
      this.retarget(b, node, hit.legIdx, f);
      caught++;
    }
    this.stats.manualFlips += caught;
    if (caught) {
      const A = this.config.animation;
      this.spawnFloat({ x: this.geo.pegX(f.r, f.i + 1), y: this.geo.pegY(f.r) - A.pegPopupRise, size01: 0.3, life: A.pegPopupSec, text: caught > 1 ? `FLIP ×${caught}!` : 'FLIP!', color: 'boing' });
    }
    this.emit('flip', { flipper: n, caught });
    return caught;
  }

  /** Is ball b on flipper f right now (resting on it, or arriving within the window)? */
  flipWindow(b, f) {
    const FL = this.config.animation.flipper;
    const s = b.segs[b.seg];
    if (!s) return null;
    const u = (b.t - s.t0) / s.dur;
    const pegIdx = this.geo.pegIndex(f.r, f.i + 1);
    // segment arriving onto the flipper peg, close to touching down
    if (s.hit === pegIdx && s.t0 + s.dur - b.t <= FL.windowBeforeSec) return this.legOfFlipperVisit(b, f);
    // already on it: the previous segment ended there and this one has barely left
    const prev = b.segs[b.seg - 1];
    if (prev && prev.hit === pegIdx && u <= FL.windowAfterU && !s.land) return this.legOfFlipperVisit(b, f);
    return null;
  }

  legOfFlipperVisit(b, f) {
    // The leg currently being animated: count trampoline launches already passed.
    let legIdx = b.legBase;
    for (let k = 0; k < b.seg; k++) if (b.segs[k].kind === 4) legIdx++; // SEG.LAUNCH
    const leg = b.node.legs[legIdx];
    if (!leg || f.r < leg.r0 || legIndexAt(leg, f.r) !== f.i) return null;
    return { legIdx };
  }

  /** Swap a flying ball's outcome and re-animate it from the flipper. */
  retarget(b, node, legIdx, f) {
    const anim = buildSegments(node, this.geo, this.config.animation, makeRng(hash32(this.state.seed, b.dropIdx, 2000 + this.flipCount)), {
      ...this.animOpts, dropperX: 0, resume: { legIdx, r: f.r, x: b.x, y: b.y },
    });
    // Children that hadn't appeared yet belonged to the old path: drop them.
    for (const k of b.kids) this.cancelVisual(k);
    Object.assign(b, { t: 0, seg: 0, segs: anim.segs, total: anim.total, node, bucket: node.k, payout: node.payout, kids: [], splitAt: splitKeys(node), legBase: legIdx });
    const childRng = makeRng(hash32(this.state.seed, b.dropIdx, 3000 + this.flipCount));
    for (const c of anim.children) b.kids.push(this.spawnVisual(c.child, makeRng(childRng.int(2 ** 31)), null, -c.t, childRng, b.dropIdx));
  }

  /** Remove a not-yet-visible child ball and its own children; visible ones keep going. */
  cancelVisual(v) {
    if (!v || !v.active) return;
    if (v.t >= 0) return;
    v.active = false; this.activeBalls--;
    for (const k of v.kids) this.cancelVisual(k);
  }

  /** Create a visual ball and, recursively, its split children. Over the cap: pay now, no sprite. */
  spawnVisual(node, rng, dropper, startT, childRng, dropIdx) {
    const b = this.balls.find((x) => !x.active);
    if (!b) {
      // Over the visual cap: pay immediately without a sprite. (Phase 7 replaces this
      // with merged "×N" visual balls; payouts are identical either way.)
      this.creditTree(node);
      return null;
    }
    const anim = buildSegments(node, this.geo, this.config.animation, rng, { ...this.animOpts, dropperX: dropper?.x ?? 0, dropperVia: dropper?.via ?? null });
    Object.assign(b, {
      active: true, t: startT, seg: 0, segs: anim.segs, total: anim.total,
      x: anim.segs[0].x0, y: anim.segs[0].y0, rot: 0, spin: anim.spin, spinDir: 1,
      node, bucket: node.k, payout: node.payout, landedAt: -1, doneAt: -1,
      typeId: this.ctx.ball.type.id, golden: node.golden, child: node.isChild, splitAt: splitKeys(node),
      dropIdx, kids: [], legBase: 0, bounced: 0,
      touched: this.income.bonus.chance > 0 && makeRng(hash32(this.state.seed, dropIdx, 5000 + this.touchCount++)).chance(this.income.bonus.chance),
    });
    this.activeBalls++;
    // Children appear when the parent reaches the splitter peg.
    for (const c of anim.children) {
      b.kids.push(this.spawnVisual(c.child, makeRng(childRng.int(2 ** 31)), null, startT - c.t, childRng, dropIdx));
    }
    return b;
  }

  creditTree(node) {
    this.credit(node.payout, node, null);
    for (const leg of node.legs) for (const s of leg.splits) this.creditTree(s.child);
  }

  land(b) {
    b.landedAt = this.time;
    this.credit(b.payout, b.node, b);
  }

  credit(amount, node, ball) {
    const st = this.state;
    const bucket = node.k;
    amount *= this.payoutMul(ball);
    this.earn(amount);
    this.incomeRing[this.ringSec % this.incomeRing.length] += amount;
    // credit the pieces this ball touched (shown next to each piece in the Board tab)
    const touched = new Set(node.legs.flatMap((leg) => leg.redirects.map((rd) => rd.kind)));
    if (node.bounces > 0) touched.add('trampoline');
    for (const k of touched) this.pieceEarned[k] = (this.pieceEarned[k] || 0) + amount;
    this.stats.landed++;
    this.stats.buckets[bucket]++;
    if (node.golden) this.stats.goldens++;
    this.bucketBounce[bucket] = 1;
    if (this.ctx.top.includes(bucket)) {
      this.stats.jackpots++;
      this.emit('jackpot', { board: this.board.id, bucket, ballType: this.state.equipped });
    }
    if (ball) {
      const maxM = Math.max(...this.ctx.mults), minM = Math.min(...this.ctx.mults);
      const m = this.ctx.mults[bucket];
      const size01 = maxM > minM ? Math.log(m / minM) / Math.log(maxM / minM) : 0;
      this.spawnFloat({
        x: this.geo.bucketX(bucket) + (Math.random() - 0.5) * 0.3, y: this.geo.bucketTop, rise: true,
        text: (node.golden ? '×2 +' : '+') + num(amount), color: node.golden || ball.touched || this.frenzy.left > 0 ? 'golden' : 'coin',
        size01: Math.min(1, size01 + (node.golden ? 0.25 : 0)), life: this.config.animation.floatTextSec,
      });
    }
    this.emit('land', { bucket, amount });
  }

  spawnFloat(f0) {
    let f = this.floats.find((x) => !x.active);
    if (!f) f = this.floats.reduce((a, c) => (c.age > a.age ? c : a)); // recycle oldest
    Object.assign(f, { active: true, age: 0, rise: false }, f0);
  }

  /** Measured coins/sec over the rolling window (excludes the current partial second). */
  measuredIncome() {
    const n = Math.min(this.ringFilled, this.incomeRing.length - 1);
    if (n <= 0) return 0;
    let s = 0;
    for (let k = 1; k <= n; k++) s += this.incomeRing[(this.ringSec - k + this.incomeRing.length) % this.incomeRing.length];
    return s / n;
  }
}
