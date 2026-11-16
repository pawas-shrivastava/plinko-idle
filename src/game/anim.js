// Turns a resolved ball (legs of lattice paths + shield/trampoline/splits) into timed
// motion segments that look physical. Cosmetic only: uses its own RNG stream and never
// changes the outcome.

export const SEG = { FALL: 0, HOP: 1, ROLL: 2, WOBBLE: 3, LAUNCH: 4 };

const DEFAULT_MOTION = { hopMul: 1, timeMul: 1, doubleTapMul: 1, tapHeightMul: 1, rimRollMul: 1, spinMul: 1, landBounces: 0 };

/** Largest upward kick h whose arc rises at most `rise` above its start, for a hop that descends `dy`. */
const hForRise = (rise, dy) => (rise + Math.sqrt(rise * rise + rise * Math.max(0, dy))) / 2;

/**
 * @param {object} ball    resolveBall() node
 * @param {object} geo     boardGeometry()
 * @param {object} A       config.animation
 * @param {object} rng     animation rng stream
 * @param {object} opts    { top:number[], dropperX, motion,
 *                            lidGap(r,i,d), lidThickness, resume: {legIdx, r, x, y}|null,
 *                            tramp: {padY}|null }
 * @returns {{segs, total, spin, children: Array<{child, t}>}}
 */
export function buildSegments(ball, geo, A, rng, opts) {
  const M = { ...DEFAULT_MOTION, ...(opts.motion || {}) };
  const segs = [];
  let t = 0;
  const push = (s) => {
    s.t0 = t; t += s.dur; s.hit ??= -1; s.land ??= false;
    s.events = s.event ? [s.event] : []; delete s.event;
    segs.push(s); return s;
  };
  const R = geo.rows;
  // Bigger boards get quicker rows so a full drop stays within the target time.
  const baseRow = A.rowTimeSec * Math.pow(A.rowTimeReferenceRows / R, A.rowTimeRowsExponent);
  const rowTime = () => baseRow * M.timeMul * (1 + rng.range(-A.rowTimeJitter, A.rowTimeJitter));
  const TR = opts.tramp;
  const lidGap = opts.lidGap || (() => false); // (r, i, d) → a lid covers the gap this move passes
  const FL = A.flipper;
  const resume = opts.resume || null; // { legIdx, r, x, y }: rebuild from a ball sitting at row r
  const children = [];

  let x, y;
  const contact = (r, i) => [geo.pegX(r, i + 1), geo.pegY(r) - geo.C];

  // Slide round peg (px, py) from the ball's current spot by angle aRel (0 = top of peg).
  const rollTo = (px, py, aRel, dur) => {
    const a0 = Math.asin(Math.max(-1, Math.min(1, (x - px) / geo.C)));
    const a1 = a0 + aRel;
    push({ kind: SEG.ROLL, cx: px, cy: py, r: geo.C, a0, a1, x0: x, y0: y, dur });
    x = px + geo.C * Math.sin(a1);
    y = py - geo.C * Math.cos(a1);
  };

  // Hit events per peg, keyed r*256+i, so the arrival segment can carry them.
  const eventsAt = (leg) => {
    const map = new Map();
    for (const h of leg.hits) map.set(h.r * 256 + h.i, { kind: 'peg', type: h.type, gold: h.gold, factor: h.factor, r: h.r, i: h.i });
    return map;
  };

  ball.legs.forEach((leg, li) => {
    if (resume && li < resume.legIdx) return;
    const resumeHere = resume && li === resume.legIdx;
    const lastLeg = li === ball.legs.length - 1;
    const evs = eventsAt(leg);
    const splitAt = new Map(leg.splits.filter((sp) => !resumeHere || sp.r > resume.r).map((sp) => [sp.r * 256 + sp.i, sp.child]));
    const redirectAt = new Map(leg.redirects.map((rd) => [rd.r, rd]));
    const arrive = (seg, r, i) => {
      const key = r * 256 + i;
      if (evs.has(key)) seg.events.push(evs.get(key));
      if (splitAt.has(key)) children.push({ child: splitAt.get(key), t: seg.t0 + seg.dur, r, i });
    };

    let r = leg.r0, i = leg.i0;
    // --- entry onto the leg's first peg
    const [sx, sy] = contact(leg.r0, leg.i0);
    if (resumeHere) {
      r = resume.r;
      for (let q = leg.r0; q < r; q++) i += leg.path[q - leg.r0];
      x = resume.x; y = resume.y;
    } else if (li === 0 && ball.isChild) {
      x = sx; y = sy; // a split child starts on the splitter peg
    } else if (li === 0) {
      let fx = opts.dropperX, fy = geo.dropperY, part = 1;
      if (opts.dropperVia) { // side dropper: first slip in between the frame pegs
        const [vx, vy] = opts.dropperVia;
        push({ kind: SEG.FALL, x0: fx, y0: fy, x1: vx, y1: vy, dur: A.dropInSec * 0.7, side: true });
        fx = vx; fy = vy; part = 0.6;
      }
      arrive(push({ kind: SEG.FALL, x0: fx, y0: fy, x1: sx, y1: sy, dur: A.dropInSec * part, hit: geo.pegIndex(leg.r0, leg.i0 + 1), side: !!opts.dropperVia }), leg.r0, leg.i0);
      x = sx; y = sy;
    } else {
      // Trampoline relaunch: squash on the pad, fly up past the restart peg, drop onto it.
      push({ kind: SEG.WOBBLE, x0: x, y0: y, x1: x, y1: y, amp: 0, cycles: 0, dir: 1, dur: A.trampoline.squashSec, event: { kind: 'trampoline', bucket: ball.legs[li - 1].k } });
      const apexY = sy - A.trampoline.overshoot;
      push({ kind: SEG.LAUNCH, x0: x, y0: y, x1: sx, y1: apexY, dur: A.trampoline.launchSec, trail: true });
      x = sx; y = apexY;
      arrive(push({ kind: SEG.FALL, x0: x, y0: y, x1: sx, y1: sy, dur: A.trampoline.dropSec, hit: geo.pegIndex(leg.r0, leg.i0 + 1) }), leg.r0, leg.i0);
      y = sy;
    }

    for (; r < R; r++) {
      const d = leg.path[r - leg.r0];
      const dir = d ? 1 : -1;
      const lastRow = r === R - 1;
      const px = geo.pegX(r, i + 1), py = geo.pegY(r);
      const pegHere = geo.pegIndex(r, i + 1);
      const rd = redirectAt.get(r);

      if (rd && rd.kind === 'lid') {
        // Roll toward the gap, clonk on the lid flap, bounce back the other way.
        const bd = rd.blocked ? 1 : -1;
        const hx = px + bd * A.lidHitOffset, hy = py - opts.lidThickness / 2 - geo.ballRadius;
        push({ kind: SEG.HOP, x0: x, y0: y, x1: hx, y1: hy, h: 0.04, jit: 0, dur: A.lidHitSec, event: { kind: 'lid', id: rd.id, r, i } });
        x = hx; y = hy;
        const [tx, ty] = contact(rd.rT, rd.jo);
        const seg = push({ kind: SEG.HOP, x0: x, y0: y, x1: tx, y1: ty, h: A.lidBounceHeight, jit: 0, dur: A.lidBackSec, hit: geo.pegIndex(rd.rT, rd.jo + 1) });
        arrive(seg, rd.rT, rd.jo);
        x = tx; y = ty; i = rd.jo; r = rd.rT - 1;
        continue;
      }
      if (rd && rd.kind === 'flip') {
        // The flipper swats the ball sideways: it shoots out under the next peg along the
        // row and over the peg below it (waypoints between them), then drops onto the target.
        const fd = rd.jo > i ? 1 : -1, K = rd.rT - r;
        if (!rd.manual) push({ kind: SEG.WOBBLE, x0: x, y0: y, x1: x, y1: y, amp: 0, cycles: 0, dir: 1, dur: FL.windupSec, event: { kind: 'flip', flipper: rd.flipper } });
        if (Math.hypot(x - px, y - (py - geo.C)) > 0.01) { // caught mid-air: settle onto the flipper first
          push({ kind: SEG.HOP, x0: x, y0: y, x1: px, y1: py - geo.C, h: 0, jit: 0, dur: FL.settleSec });
          x = px; y = py - geo.C;
        }
        const fallTo = rd.rT >= R;
        const [tx, ty] = fallTo ? [geo.bucketX(rd.jo), geo.landY] : contact(rd.rT, rd.jo);
        const pts = [];
        for (let k = 1; k < K; k++) pts.push([px + fd * (k * 0.5 + 0.25), geo.pegY(r + k - 1) + geo.dy / 2]);
        pts.push([tx, ty]);
        const lens = pts.map((p, n) => Math.hypot(p[0] - (n ? pts[n - 1][0] : x), p[1] - (n ? pts[n - 1][1] : y)));
        const total = lens.reduce((u, v) => u + v, 0);
        pts.forEach(([wx, wy], n) => {
          const last = n === pts.length - 1;
          const seg = push({
            kind: SEG.HOP, x0: x, y0: y, x1: wx, y1: wy, h: n === 0 ? FL.flightHeight : 0, jit: 0, trail: true,
            dur: FL.flightSec * lens[n] / total, hit: last && !fallTo ? geo.pegIndex(rd.rT, rd.jo + 1) : -1,
            land: last && fallTo && lastLeg,
          });
          if (last && !fallTo) arrive(seg, rd.rT, rd.jo);
          x = wx; y = wy;
        });
        i = rd.jo; r = rd.rT - 1;
        continue;
      }

      const teeter = lastRow && lastLeg && opts.top.includes(leg.k);
      const pulledHere = rd && (rd.kind === 'suction' || rd.kind === 'magnet');
      const throughLid = lidGap(r, i, d); // passing a part-open lid: go through the middle of the gap
      let rolledOff = false; // once a ball rolls off a peg it falls — no more bounce until the next hit

      if (!teeter && rng.chance(A.doubleTapChance * M.doubleTapMul)) {
        const nx = x + dir * 0.02;
        push({ kind: SEG.HOP, x0: x, y0: y, x1: nx, y1: y, h: Math.min(A.doubleTapHeight * M.tapHeightMul, A.maxTapRise), jit: 0, dur: rowTime() * A.doubleTapTimeMul, hit: pegHere });
        x = nx;
      }

      if (teeter) {
        const W = A.topBucketWobble;
        push({ kind: SEG.WOBBLE, x0: x, y0: y, x1: x, y1: y, amp: W.amplitude, cycles: W.cycles, dir, dur: baseRow * W.timeMul });
        x += dir * W.amplitude * 0.5;
        rollTo(px, py, dir * (W.rollOffDeg * Math.PI) / 180, baseRow * W.rollOffTimeMul);
        rolledOff = true;
      } else if (rng.chance(A.rimRollChance * M.rimRollMul) && !throughLid && !pulledHere) {
        rollTo(px, py, dir * (A.rimRollAngleDeg * Math.PI) / 180, rowTime() * A.rimRollTimeMul);
        rolledOff = true;
      }

      i += d;
      // Wind / magnet steer this step: slide sideways early so the pull reads.
      const pulled = rd && (rd.kind === 'suction' || rd.kind === 'magnet') ? rd.kind : null;
      let x1, y1, hit = -1, xl = throughLid || pulled ? 2 : 0;
      if (!lastRow) {
        [x1, y1] = contact(r + 1, i);
        hit = geo.pegIndex(r + 1, i + 1);
      } else if (!lastLeg) {
        x1 = geo.bucketX(i); y1 = TR.padY - geo.ballRadius; // onto the trampoline over the bucket
      } else {
        x1 = geo.bucketX(i); y1 = geo.landY;
      }
      let jit = rolledOff || xl ? 0 : rng.range(-A.horizontalJitter, A.horizontalJitter);
      const dur = teeter ? baseRow * A.topBucketWobble.finalFallTimeMul : rowTime() * (rolledOff ? A.rollOffFallTimeMul : 1);
      if (pulled) segs[segs.length - 1]?.events.push({ kind: pulled, r, i }); // fires as the ball reaches this peg
      const seg = push({
        kind: SEG.HOP, x0: x, y0: y, x1, y1,
        h: rolledOff ? 0 : Math.min(rng.range(A.hopHeight[0], A.hopHeight[1]) * M.hopMul, hForRise(A.maxHopRise, y1 - y)),
        jit, dur, hit, xl, pulled,
        land: lastRow && lastLeg,
      });
      if (!lastRow) arrive(seg, r + 1, i);
      x = x1; y = y1;
    }
  });

  // Lively balls bounce a couple of times inside the bucket after landing (payout is on first contact).
  let bh = A.landBounceHeight;
  for (let n = 0; n < M.landBounces; n++) {
    const nx = x + rng.range(-A.landBounceDrift, A.landBounceDrift);
    push({ kind: SEG.HOP, x0: x, y0: y, x1: nx, y1: y, h: bh, jit: 0, dur: A.landBounceSec * Math.sqrt(bh / A.landBounceHeight) });
    x = nx;
    bh *= A.landBounceDecay;
  }

  return { segs, total: t, spin: rng.range(A.spinSpeed[0], A.spinSpeed[1]) * M.spinMul, children };
}

/** Position at local progress u ∈ [0,1] of a segment; writes into out {x, y}. */
export function evalSegment(s, u, out) {
  switch (s.kind) {
    case SEG.FALL:
      out.x = s.x0 + (s.x1 - s.x0) * u;
      out.y = s.y0 + (s.y1 - s.y0) * u * u; // accelerate under gravity
      break;
    case SEG.HOP:
      // Sideways motion is front-loaded so the ball clears the peg it bounced off;
      // projectile vertical: upward kick (h) then gravity.
      // (xl = 2: sideways even earlier — trampoline-bucket landings off-centre must clear the divider)
      out.x = s.x0 + (s.x1 - s.x0) * (s.xl === 2 ? 1 - (1 - u) ** 3 : Math.sin((Math.PI / 2) * u)) + s.jit * Math.sin(Math.PI * u);
      out.y = s.y0 + (s.y1 - s.y0) * u * u - 4 * s.h * u * (1 - u);
      break;
    case SEG.ROLL: {
      const a = s.a0 + (s.a1 - s.a0) * u * u;
      out.x = s.cx + s.r * Math.sin(a);
      out.y = s.cy - s.r * Math.cos(a);
      break;
    }
    case SEG.WOBBLE: {
      // Rock back and forth on the peg top, settling toward the fall side.
      const rock = Math.sin(Math.PI * 2 * s.cycles * u) * (1 - u) * s.amp;
      out.x = s.x0 + rock + s.dir * s.amp * 0.5 * u * u;
      out.y = s.y0 + Math.abs(rock) * 0.4;
      break;
    }
    case SEG.LAUNCH:
      // Shot upward, decelerating to the apex.
      out.x = s.x0 + (s.x1 - s.x0) * u;
      out.y = s.y0 + (s.y1 - s.y0) * (2 * u - u * u);
      break;
  }
}
