// Exact expected value of a drop on a fully upgraded board. Pure.
// Mirrors resolveBall() in drop.js rule-for-rule (see board.js header for the rules).
//
// For a ball starting at peg (r0, i0) we condition on its sampled bucket kp and run a
// backward DP over the lattice. Per peg state, two layers h: h=0 "no special peg hit yet"
// (Comet / Splitter trait still armed), h=1 "already hit one".
//   Z = Σ path weights            Q = Σ w·[no rule fired]
//   A = Σ w·ΠM·[no rule fired]    B = Σ w·ΠM·Gold·[no rule fired]
//   S = Σ w·(expected EV of split children spawned below), kept as const + coeff·σ where σ is
//       the (initially unknown) children value of one trampoline arrival — see boardEV.
// Movement rules (lids, auto-flippers) fire on one branch of a peg with some chance and
// send the ball to a target peg, from where its fall is re-drawn. A forward pass collects,
// per (rule, layer), the probability mass that fires it together with the bonuses so far
// (F, F·ΠM, F·ΠM·Gold); the continuation from the target is itself a descent, independent
// given the layer, so the products combine. Children are independent balls: their EV adds.

/** Per-peg effects for a ball, depending on whether this is its first special peg. */
function effects(peg, first, traits) {
  let gold = peg.gold, factor = peg.factor, split = peg.split;
  if (first && traits.comet) { gold *= 2; factor = 1 + 2 * (factor - 1); }
  if (first && traits.splitChance > 0) split = 1 - (1 - split) * (1 - traits.splitChance);
  return { gold, factor, split };
}
export { effects as pegEffects };

/**
 * Expectations for one descent from (r0, i0).
 * @param env {childEV(r,i) → [const, coeff], cont(r,i,layer,kickDir)}
 * @returns {{q:number[], a:number[], b:number[], sc:number, sk:number}}
 *   q[k]: P(lands k), a[k]: E[ΠM; lands k], b[k]: E[Gold·ΠM; lands k],
 *   children EV = sc + sk·σ   ("lands" = this descent's bucket, before any trampoline bounce)
 */
function descend(m, r0, i0, skipStart, layerStart, env, kickDir = 0) {
  const R = m.rows;
  const P = kickDir ? m.deflectDist(r0, i0, kickDir) : m.startDist(r0, i0);
  const q = new Array(R + 1).fill(0), a = q.slice(), b = q.slice();
  let sc = 0, sk = 0;
  const W = R + 2, N = (R + 1) * W;
  const Z = new Float64Array(N), Q = new Float64Array(N);
  const A = [new Float64Array(N), new Float64Array(N)];
  const B = [new Float64Array(N), new Float64Array(N)];
  const S = [new Float64Array(N), new Float64Array(N)];   // const part
  const K = [new Float64Array(N), new Float64Array(N)];   // σ coefficient
  const keepOf = (list) => { let k = 1; if (list) for (const x of list) k *= 1 - x.chance; return k; };
  const skip = (r) => skipStart && r === r0;
  const anyRules = m.maxRuleRow >= r0;
  const Ff = anyRules ? [new Float64Array(N), new Float64Array(N)] : null;
  const Fa = anyRules ? [new Float64Array(N), new Float64Array(N)] : null;
  const Fb = anyRules ? [new Float64Array(N), new Float64Array(N)] : null;
  const fired = new Map(); // rule object → per layer {f, fa, fb}

  for (let kp = 0; kp <= R; kp++) {
    if (P[kp] <= 0) continue;
    Z.fill(0); Q.fill(0); for (let h = 0; h < 2; h++) { A[h].fill(0); B[h].fill(0); S[h].fill(0); K[h].fill(0); }
    const end = R * W + kp;
    Z[end] = 1; Q[end] = 1; A[0][end] = 1; A[1][end] = 1;
    for (let r = R - 1; r >= r0; r--) {
      for (let i = 0; i <= r; i++) {
        const c0 = (r + 1) * W + i, c1 = c0 + 1, here = r * W + i;
        const zc = Z[c0] + Z[c1];
        if (zc === 0) continue;
        const peg = skip(r) ? null : m.pegAt(r, i);
        const w = peg ? peg.weight : 1;
        const rule = m.ruleAt(r, i);
        const kL = keepOf(rule?.[0]), kR = keepOf(rule?.[1]);
        Z[here] = w * zc;
        Q[here] = w * (kL * Q[c0] + kR * Q[c1]);
        for (let h = 0; h < 2; h++) {
          let factor = 1, gold = 0, split = 0, nh = h;
          if (peg) { ({ factor, gold, split } = effects(peg, h === 0, m.traits)); nh = 1; }
          const ac = kL * A[nh][c0] + kR * A[nh][c1];
          A[h][here] = w * factor * ac;
          B[h][here] = w * factor * (kL * B[nh][c0] + kR * B[nh][c1] + gold * ac);
          const ch = split > 0 ? env.childEV(r, i) : null;
          S[h][here] = w * (kL * S[nh][c0] + kR * S[nh][c1] + (ch ? split * ch[0] * zc : 0));
          K[h][here] = w * (kL * K[nh][c0] + kR * K[nh][c1] + (ch ? split * ch[1] * zc : 0));
        }
      }
    }
    const st = r0 * W + i0, z = Z[st];
    const pz = P[kp] / z;
    q[kp] += pz * Q[st];
    a[kp] += pz * A[layerStart][st];
    b[kp] += pz * B[layerStart][st];
    sc += pz * S[layerStart][st];
    sk += pz * K[layerStart][st];

    if (!anyRules) continue;
    // Forward: mass reaching each peg with no rule fired yet, and its bonuses so far.
    for (let h = 0; h < 2; h++) { Ff[h].fill(0); Fa[h].fill(0); Fb[h].fill(0); }
    Ff[layerStart][st] = 1; Fa[layerStart][st] = 1;
    for (let r = r0; r <= Math.min(m.maxRuleRow, R - 1); r++) {
      for (let i = 0; i <= r; i++) {
        const here = r * W + i;
        const peg = skip(r) ? null : m.pegAt(r, i);
        const w = peg ? peg.weight : 1;
        const rule = m.ruleAt(r, i);
        for (let h = 0; h < 2; h++) {
          const f = Ff[h][here];
          if (!f) continue;
          let factor = 1, gold = 0, nh = h;
          if (peg) { ({ factor, gold } = effects(peg, h === 0, m.traits)); nh = 1; }
          const f2 = f * w, fa2 = Fa[h][here] * w * factor, fb2 = (Fb[h][here] + gold * Fa[h][here]) * w * factor;
          for (let br = 0; br < 2; br++) {
            const ch = (r + 1) * W + i + br;
            let keep = 1;
            if (rule && Z[ch]) for (const rb of rule[br]) {
              const k = pz * Z[ch] * keep * rb.chance;
              const e = fired.get(rb) || [{ f: 0, fa: 0, fb: 0 }, { f: 0, fa: 0, fb: 0 }];
              e[nh].f += k * f2; e[nh].fa += k * fa2; e[nh].fb += k * fb2;
              fired.set(rb, e);
              keep *= 1 - rb.chance;
            }
            if (r < m.maxRuleRow) { Ff[nh][ch] += f2 * keep; Fa[nh][ch] += fa2 * keep; Fb[nh][ch] += fb2 * keep; }
          }
        }
      }
    }
  }

  // Fired rules: bonuses so far × a fresh descent from the rule's target peg.
  for (const [rb, layers] of fired) {
    for (let h = 0; h < 2; h++) {
      const e = layers[h];
      if (!e.f) continue;
      const D = env.cont(rb.rT, rb.jo, h, rb.kickDir);
      for (let k = 0; k <= R; k++) {
        q[k] += e.f * D.q[k];
        a[k] += e.fa * D.a[k];
        b[k] += e.fb * D.a[k] + e.fa * D.b[k];
      }
      sc += e.f * D.sc; sk += e.f * D.sk;
    }
  }
  return { q, a, b, sc, sk };
}

/**
 * Exact EV per ball for each dropper.
 *
 * Trampoline on bucket t: a ball arriving there with bonuses (P = ΠM, GP = Gold·ΠM) after n
 * earlier bounces is relaunched (n < N = max bounces); its expected payout is linear,
 * W_n = α_n·P + β_n·GP, with
 *   β_n = bonus·(c0 + β_{n+1}·u),  α_n = bonus·(c1 + α_{n+1}·u + β_{n+1}·v),  α_N = V·m_t, β_N = 1
 * where for one relaunch descent: u = E[ΠM; lands t], v = E[Gold·ΠM; lands t],
 * c1 = Σ_{k≠t}(V·m_k·a[k] + b[k]), c0 = Σ_{k≠t} a[k]. Relaunched balls do not split.
 * @param {object} m  boardModel()
 */
export function boardEV(m) {
  const V = m.ball.value, R = m.rows;
  const gf = m.ball.golden ? 1 + m.ball.golden.chance * (m.ball.golden.mul - 1) : 1;
  const mults = m.mults;
  const tr = m.trampoline, t = tr ? tr.bucket : -1;

  const makeEnv = (childEV) => {
    const contCache = new Map();
    const env = {
      childEV,
      cont(r, i, h, dir) {
        const key = ((r * 256 + i) * 2 + h) * 3 + dir + 1;
        if (!contCache.has(key)) contCache.set(key, descend(m, r, i, false, h, env, dir));
        return contCache.get(key);
      },
    };
    return env;
  };
  /** Relaunch descent: uniform over the (existing) pegs of the restart row; traits already spent. */
  const relaunch = (env) => {
    const rt = tr.restartRow, n = tr.restartNodes.length;
    const agg = { q: new Array(R + 1).fill(0), a: new Array(R + 1).fill(0), b: new Array(R + 1).fill(0), sc: 0, sk: 0 };
    for (const i of tr.restartNodes) {
      const d = descend(m, rt, i, false, 1, env);
      for (let k = 0; k <= R; k++) { agg.q[k] += d.q[k] / n; agg.a[k] += d.a[k] / n; agg.b[k] += d.b[k] / n; }
      agg.sc += d.sc / n; agg.sk += d.sk / n;
    }
    return agg;
  };

  // Relaunched balls never split, so a relaunch descent has no children.
  // After maxBonusBounces bounces the pad lets the ball through: it lands in bucket t for good.
  const N = tr ? tr.maxBonusBounces : 0;
  let alpha = 0, beta = 0, q2 = null, G = 0;
  if (tr) {
    const d2 = relaunch(makeEnv(() => [0, 0]));
    q2 = d2.q;
    const u = d2.a[t], v = d2.b[t];
    let c0 = 0, c1 = 0;
    for (let k = 0; k <= R; k++) if (k !== t) { c0 += d2.a[k]; c1 += V * mults[k] * d2.a[k] + d2.b[k]; }
    alpha = V * mults[t]; beta = 1; // out of bounces: an ordinary landing in t
    for (let n = N - 1; n >= 0; n--) {
      const nb = tr.bonus * (c0 + beta * u), na = tr.bonus * (c1 + alpha * u + beta * v);
      beta = nb; alpha = na;
    }
    for (let n = 0; n < N; n++) G += Math.pow(q2[t], n); // expected bounces per arrival
  }

  /** A fresh ball's own expected payout from a descent (trampoline included) plus its children. */
  const own = (d) => {
    let pay = 0;
    for (let k = 0; k <= R; k++) pay += k === t ? alpha * d.a[k] + beta * d.b[k] : V * mults[k] * d.a[k] + d.b[k];
    return { pay: gf * pay, c: gf * pay + d.sc };
  };

  const childCache = new Map();
  const env = makeEnv((r, i) => {
    const key = r * 256 + i;
    if (!childCache.has(key)) {
      childCache.set(key, [0, 0]); // guard (children only spawn strictly lower, so never read)
      childCache.set(key, [own(descend(m, r, i, true, 0, env)).c, 0]);
    }
    return childCache.get(key);
  });

  const perDropper = m.droppers.map((pos) => {
    const d = descend(m, pos.startRow, pos.startI, false, 0, env);
    const o = own(d);
    // Where balls finally end up (after any bounces).
    const final = d.q.map((p, k) => (!tr ? p : k === t ? p * Math.pow(q2[t], N) : p + d.q[t] * q2[k] * G));
    return {
      perBall: o.c,
      breakdown: { own: o.pay, splits: d.sc },
      q: d.q, final,
      bounceRate: tr ? d.q[t] * G : 0, // expected bounces per dropped ball (excl. children)
      top: m.top.reduce((x, k) => x + final[k], 0),
    };
  });

  return { perDropper, perBall: perDropper.reduce((x, d) => x + d.perBall, 0) / perDropper.length };
}

/** Analytic P(visit peg (r,i)) on the first descent from a start (incl. rule redirects). */
export function visitProbs(m, r0, i0, kickDir = 0) {
  const R = m.rows, W = R + 2;
  const P = kickDir ? m.deflectDist(r0, i0, kickDir) : m.startDist(r0, i0);
  const out = new Float64Array((R + 1) * W);
  const Z = new Float64Array((R + 1) * W), F = new Float64Array((R + 1) * W);
  const fired = new Map(); // rule → mass
  for (let kp = 0; kp <= R; kp++) {
    if (P[kp] <= 0) continue;
    Z.fill(0); F.fill(0);
    Z[R * W + kp] = 1;
    for (let r = R - 1; r >= r0; r--) for (let i = 0; i <= r; i++) {
      const peg = m.pegAt(r, i);
      Z[r * W + i] = (peg ? peg.weight : 1) * (Z[(r + 1) * W + i] + Z[(r + 1) * W + i + 1]);
    }
    const z = Z[r0 * W + i0];
    F[r0 * W + i0] = 1;
    for (let r = r0; r < R; r++) for (let i = 0; i <= r; i++) {
      const f = F[r * W + i];
      if (!f) continue;
      const peg = m.pegAt(r, i);
      const w = peg ? peg.weight : 1;
      const rule = m.ruleAt(r, i);
      for (let br = 0; br < 2; br++) {
        const ch = (r + 1) * W + i + br;
        let keep = 1;
        if (rule) for (const rb of rule[br]) {
          fired.set(rb, (fired.get(rb) || 0) + (P[kp] / z) * f * w * Z[ch] * keep * rb.chance);
          keep *= 1 - rb.chance;
        }
        F[ch] += f * w * keep;
      }
    }
    for (let r = r0; r < R; r++) for (let i = 0; i <= r; i++) out[r * W + i] += (P[kp] / z) * F[r * W + i] * Z[r * W + i];
  }
  for (const [rb, mass] of fired) {
    if (rb.rT >= R) continue;
    const v = visitProbs(m, rb.rT, rb.jo, rb.kickDir);
    for (let r = rb.rT; r < R; r++) for (let i = 0; i <= r; i++) out[r * W + i] += mass * v(r, i);
  }
  return (r, i) => out[r * W + i];
}
