// Canvas 2D renderer. Static board (background, pegs, dropper) is cached to an
// offscreen layer; per frame we draw only what moves.
import { fmt, fmtMult } from '../core/format.js';
import { evalSegment } from './anim.js';
import { paintBackground, makePegSprite, pegPath, shade, drawBallSprite, paintFramedBoard, drawTile, drawCup } from './art.js';
export { drawBallSprite };

const hexToRgb = (h) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const lerpColor = (a, b, t) => {
  const A = hexToRgb(a), B = hexToRgb(b);
  return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(',')})`;
};

export class Renderer {
  constructor(canvas, config) {
    this.cv = canvas;
    this.g = canvas.getContext('2d');
    this.config = config;
    this.showOdds = true;
    this.showMeasured = false;
    this.font = 'Fredoka, "Baloo 2", system-ui, sans-serif';
  }

  resize(cssW, cssH) {
    this.dpr = Math.min(window.devicePixelRatio || 1, this.config.layout.maxDevicePixelRatio);
    this.W = cssW; this.H = cssH;
    this.cv.width = Math.round(cssW * this.dpr);
    this.cv.height = Math.round(cssH * this.dpr);
    this.cv.style.width = cssW + 'px';
    this.cv.style.height = cssH + 'px';
    this.layoutKey = null; // force relayout
  }

  /** Fit the board into the canvas and rebuild cached layers. */
  layout(game) {
    const geo = game.geo, ctx = game.ctx;
    const key = `${this.W}x${this.H}:${game.state.boardIndex}:${geo.rows}:${game.model.droppers.length}`;
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    // Fit to the part of the triangle this board actually uses (shaped boards can be lopsided).
    const m = game.model, L = this.config.layout;
    this.walls = wallBlocks(m, geo);
    let lo = Infinity, hi = -Infinity;
    for (const k of m.buckets) { lo = Math.min(lo, geo.bucketX(k)); hi = Math.max(hi, geo.bucketX(k)); }
    for (const w of this.walls) { lo = Math.min(lo, w.x); hi = Math.max(hi, w.x); }
    const framed = this.config.themes[ctx.board.theme].style === 'framed' ? 0.62 : 0; // room for the frame
    const B = this.bounds = { minX: lo - 0.5 - L.sideMargin - framed, maxX: hi + 0.5 + L.sideMargin + framed, minY: geo.bounds.minY, maxY: geo.bounds.maxY + framed * 0.4 };
    const s = Math.min(this.W / (B.maxX - B.minX), this.H / (B.maxY - B.minY));
    this.s = s;
    this.ox = this.W / 2 - ((B.minX + B.maxX) / 2) * s;
    this.oy = (this.H - (B.maxY - B.minY) * s) / 2 - B.minY * s;
    this.theme = this.config.themes[ctx.board.theme];
    this.buildStatic(game);
    this.buildBallSprites(geo);
    this.multsKey = null;
  }

  X(x) { return this.ox + x * this.s; }
  Y(y) { return this.oy + y * this.s; }

  buildStatic(game) {
    const geo = game.geo, T = this.theme, s = this.s;
    const c = this.staticCv || (this.staticCv = document.createElement('canvas'));
    c.width = this.cv.width; c.height = this.cv.height;
    const g = c.getContext('2d');
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    if (T.style === 'framed') {
      // Solid play field in a frame; the room art stays outside it.
      const R = geo.rows, half = (r) => (geo.pegX(r, r + 2) - geo.pegX(r, 0)) / 2;
      const lo = Math.min(...game.model.buckets), hi = Math.max(...game.model.buckets);
      const c0 = (geo.pegX(0, 0) + geo.pegX(0, 2)) / 2, th = half(0) + 0.5;
      // Each side reaches just past the outermost bucket or wall, so shaped boards get a fitted frame.
      let xl = geo.bucketX(lo) - 1.05, xr = geo.bucketX(hi) + 1.05;
      for (const w of this.walls) { xl = Math.min(xl, w.x - 0.6); xr = Math.max(xr, w.x + 0.6); }
      const sL = Math.max(c0 - xl, th + 0.3) * s, sR = Math.max(xr - c0, th + 0.3) * s;
      paintFramedBoard(g, T, this.W, this.H, {
        u: s, cx: this.X(c0),
        topY: this.Y(geo.dropperY + 0.3), topHalf: th * s,
        sideY: this.Y(geo.pegY(R - 1) + 0.45), sideL: sL, sideR: sR,
        trayTop: this.Y(geo.bucketTop - 0.1), trayBottom: this.Y(geo.bucketBottom + 0.72), trayL: sL, trayR: sR,
      }, this.themeImage(T));
    } else {
      paintBackground(g, T, this.W, this.H, s, this.themeImage(T));
      g.globalAlpha = 0.5; drawPattern(g, T.pattern, this.W, this.H, s); g.globalAlpha = 1;
    }

    // Walls: the solid edges of the board's shape (rails joining chunky blocks).
    const m = game.model;
    if (this.walls.length) {
      const wc = T.wall || '#6f78d8', bs = s * 0.2;
      const P = (w) => [this.X(w.x), this.Y(w.y)];
      g.lineCap = 'round';
      for (const [color, dx, dy, lw] of [['rgba(0,0,0,0.3)', 2, 3, bs * 1.2], [wc, 0, 0, bs * 1.2]]) {
        g.strokeStyle = color; g.lineWidth = lw;
        g.beginPath();
        for (const a of this.walls) for (const b of this.walls) {
          if (a === b || b.y < a.y || (b.y === a.y && b.x <= a.x)) continue;
          const near = (b.r === a.r && Math.abs(b.x - a.x) < 1.01) || (b.r === a.r + 1 && Math.abs(b.x - a.x) < 0.51) || (b.r === a.r + 2 && Math.abs(b.x - a.x) < 0.01);
          if (!near) continue;
          const [ax, ay] = P(a), [bx, by] = P(b);
          g.moveTo(ax + dx, ay + dy); g.lineTo(bx + dx, by + dy);
        }
        g.stroke();
      }
      for (const w of this.walls) {
        const [x, y] = P(w);
        g.fillStyle = 'rgba(0,0,0,0.3)'; roundRect(g, x - bs + 2, y - bs + 3, bs * 2, bs * 2, bs * 0.45); g.fill();
        g.fillStyle = wc; roundRect(g, x - bs, y - bs, bs * 2, bs * 2, bs * 0.45); g.fill();
        g.fillStyle = 'rgba(255,255,255,0.35)'; roundRect(g, x - bs * 0.7, y - bs * 0.7, bs * 1.4, bs * 0.45, bs * 0.2); g.fill();
      }
    }

    // Dropper chutes: the main hopper, and any extra ones beside it leaning inward.
    const w = geo.ballRadius * s * 3.2, h = geo.ballRadius * s * 2.4;
    for (const pos of game.model.droppers) {
      g.save();
      g.translate(this.X(pos.x), this.Y(geo.dropperY));
      if (pos.x) { g.rotate(-Math.sign(pos.x) * 0.2); g.scale(0.85, 0.85); }
      const fun = this.sprite('dropper');
      if (fun) { const fw = w * 2.5, fh = fw * fun.height / fun.width; g.drawImage(fun, -fw / 2, h * 0.36 - fh, fw, fh); g.restore(); continue; }
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.beginPath(); g.moveTo(-w + 2, -h + 3); g.lineTo(w + 2, -h + 3); g.lineTo(w * 0.45 + 2, h * 0.2 + 3); g.lineTo(-w * 0.45 + 2, h * 0.2 + 3); g.closePath(); g.fill();
      const dg = g.createLinearGradient(-w, 0, w, 0); // a turned-metal funnel
      dg.addColorStop(0, shade(T.dropper, -0.45)); dg.addColorStop(0.3, shade(T.dropper, 0.35)); dg.addColorStop(0.55, T.dropper); dg.addColorStop(1, shade(T.dropper, -0.5));
      g.fillStyle = dg;
      g.beginPath(); g.moveTo(-w, -h); g.lineTo(w, -h); g.lineTo(w * 0.45, h * 0.2); g.lineTo(-w * 0.45, h * 0.2); g.closePath(); g.fill();
      g.fillStyle = shade(T.dropper, 0.55); g.fillRect(-w * 1.06, -h * 1.08, w * 2.12, h * 0.2);          // top lip
      g.fillStyle = shade(T.dropper, -0.55); g.fillRect(-w * 0.5, h * 0.12, w, h * 0.16);                 // spout ring
      g.fillStyle = 'rgba(0,0,0,0.35)'; for (const bx of [-0.7, 0.7]) { g.beginPath(); g.arc(w * bx, -h * 0.72, h * 0.07, 0, Math.PI * 2); g.fill(); } // rivets
      g.restore();
    }

    // Pegs: one shaded sprite stamped at every peg.
    const pr = geo.pegRadius * s;
    const spr = makePegSprite(T.pegShape, T.peg, pr * this.dpr);
    const half = spr.half / this.dpr, size = half * 2;
    for (let r = 0; r < geo.rows; r++) {
      for (let j = 0; j < r + 3; j++) {
        // lattice peg i = j-1; j = 0 and j = r+2 are the frame pegs beside the outermost ones
        const exists = j === 0 ? m.allowed(r, 0) : j === r + 2 ? m.allowed(r, r) : m.allowed(r, j - 1);
        if (!exists) continue;
        g.drawImage(spr.canvas, this.X(geo.pegX(r, j)) - half, this.Y(geo.pegY(r)) - half, size, size);
      }
    }
  }

  /** Optional painted background image for a theme (theme.image); repaints the board when it arrives. */
  themeImage(T) { return this.img(T.image); }

  /** A loaded image by path, or null until it arrives (the board repaints when it does). */
  img(path) {
    if (!path) return null;
    const cache = this.images || (this.images = {});
    let e = cache[path];
    if (!e) {
      e = cache[path] = { img: new Image(), ok: false };
      e.img.onload = () => { e.ok = true; this.layoutKey = null; };
      e.img.src = path;
    }
    return e.ok ? e.img : null;
  }

  /** Painted sprite for a board element in this theme (theme.sprites), or null to draw it in code. */
  sprite(name) { return this.img(this.theme.sprites?.[name]); }

  /** One cached sprite per ball type (radial gradient + stripe so spin reads). */
  buildBallSprites(geo) {
    const r = geo.ballRadius * this.s * this.dpr;
    const size = Math.ceil(r * 2) + 2;
    this.ballSprites = {};
    for (const t of this.config.ballTypes) {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      drawBallSprite(c.getContext('2d'), size / 2, r, t.colors, t.skin);
      this.ballSprites[t.id] = c;
    }
    this.ballSpriteR = r / this.dpr;
  }

  draw(game) {
    this.layout(game);
    const g = this.g, geo = game.geo, ctx = game.ctx, T = this.theme, A = this.config.animation, s = this.s;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.staticCv, 0, 0);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // Flashing pegs (flash + wobble)
    const pr = geo.pegRadius * s;
    for (let r = 0; r < geo.rows; r++) {
      for (let j = 0; j < r + 3; j++) {
        const f = game.pegFlash[geo.pegIndex(r, j)];
        if (f <= 0) continue;
        const wob = Math.sin(f * Math.PI * 5) * A.pegWobbleAmp * f * s;
        g.globalAlpha = 0.35 + 0.65 * f;
        g.fillStyle = T.pegFlash;
        g.beginPath();
        g.arc(this.X(geo.pegX(r, j)) + wob, this.Y(geo.pegY(r)), pr * (1 + 0.45 * f), 0, Math.PI * 2);
        g.fill();
      }
    }
    g.globalAlpha = 1;

    this.drawSuction(game);
    this.drawLids(game);
    this.drawSpecialPegs(game);
    this.drawFlippers(game);

    // Buckets: backs (opening) first, then balls fall in, then the fronts hide them.
    const mk = ctx.mults.join();
    if (mk !== this.multsKey) { this.multsKey = mk; this.bucketColors = bucketColors(ctx.mults, T); }
    const L = this.config.layout;
    const bw = (1 - L.bucketGap) * s;
    const bh = (geo.bucketBottom - geo.bucketTop) * s;
    const fontPx = Math.max(9, Math.min(s * 0.3, bw * 0.34));
    const bucketY = (k) => this.Y(geo.bucketTop) + Math.sin(game.bucketBounce[k] * Math.PI) * A.bucketBounceAmp * s;
    for (const k of game.model.buckets) this.drawBucketBack(this.X(geo.bucketX(k)), bucketY(k), bw, bh, this.bucketColors[k]);
    this.drawMagnet(game, bw, bh, bucketY);

    // Balls (launched balls leave a short trail)
    const br = this.ballSpriteR;
    const o = this._o || (this._o = { x: 0, y: 0 });
    for (const b of game.balls) {
      if (!b.active || b.t < 0) continue;
      let alpha = 1;
      if (b.doneAt >= 0) alpha = Math.max(0, 1 - (game.time - b.doneAt) / A.landSinkSec);
      const cx = this.X(b.x), cy = this.Y(b.y);
      const sg = b.segs[b.seg];
      if (sg && sg.trail) {
        const u = (b.t - sg.t0) / sg.dur;
        g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        for (let q = 1; q <= 4; q++) {
          const uu = u - q * 0.06;
          if (uu <= 0) break;
          evalSegment(sg, uu, o);
          g.globalAlpha = 0.28 * (1 - q / 5);
          g.fillStyle = '#ffffff';
          g.beginPath(); g.arc(this.X(o.x), this.Y(o.y), br * (1 - q * 0.12), 0, Math.PI * 2); g.fill();
        }
      }
      if (b.touched) { // tapped / Golden Touch: a bright halo
        g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        g.globalAlpha = alpha * 0.85;
        g.strokeStyle = '#fff3a0'; g.lineWidth = Math.max(2, br * 0.28);
        g.beginPath(); g.arc(cx, cy, br * (1.35 + 0.12 * Math.sin(game.time * 18)), 0, Math.PI * 2); g.stroke();
      }
      if (b.golden) {
        g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        g.globalAlpha = alpha;
        g.fillStyle = T.goldenGlow;
        g.beginPath(); g.arc(cx, cy, br * (1.7 + 0.15 * Math.sin(game.time * 14)), 0, Math.PI * 2); g.fill();
      }
      const co = Math.cos(b.rot) * this.dpr, si = Math.sin(b.rot) * this.dpr;
      g.globalAlpha = alpha;
      g.setTransform(co, si, -si, co, cx * this.dpr, cy * this.dpr);
      g.drawImage(this.ballSprites[b.typeId], -br, -br, br * 2, br * 2);
    }
    g.globalAlpha = 1;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const k of game.model.buckets) {
      const isTop = ctx.top.includes(k);
      const pulse = isTop ? 1 + 0.08 * Math.sin(game.time * 6) : 1;
      const tramp = game.model.trampoline && game.model.trampoline.bucket === k ? game.model.trampoline : null;
      this.drawBucketFront(this.X(geo.bucketX(k)), bucketY(k), bw, bh, this.bucketColors[k], tramp ? `↑×${tramp.bonus}` : fmtMult(ctx.mults[k] / (ctx.board.payoutScale ?? 1)), fontPx * pulse * (tramp ? 0.85 : 1), T.bucketText);
    }
    this.drawTrampoline(game);

    // Readable odds under each bucket
    if (this.showOdds) {
      const oddsPx = Math.max(8, fontPx * 0.72);
      g.font = `600 ${oddsPx}px ${this.font}`;
      g.fillStyle = T.oddsText;
      const yo = this.Y(geo.bucketBottom) + oddsPx * 1.0;
      const n = game.stats.landed;
      for (const k of game.model.buckets) {
        const x = this.X(geo.bucketX(k));
        g.fillText(game.model.trampoline?.bucket === k ? 'bounce' : fmtPct(ctx.probs[k]), x, yo);
        if (this.showMeasured && n > 0) {
          g.fillStyle = '#9fffa8';
          g.fillText(fmtPct(game.stats.buckets[k] / n), x, yo + oddsPx * 1.2);
          g.fillStyle = T.oddsText;
        }
      }
    }

    // Floating texts: "+coins" from buckets, peg pop-ups ("+5", "×1.1", "SPLIT!")
    const P = this.config.boardTree.pegs;
    const colors = { coin: T.floatText, golden: T.goldenText, gold: P.gold.color, mult: P.multiplier.color, split: P.splitter.color, bumper: P.bumper.color, lid: this.config.boardTree.pieces.lids.color, boing: '#ff8a5c' };
    for (const f of game.floats) {
      if (!f.active) continue;
      const u = f.age / f.life;
      const px = A.floatTextMinPx + (A.floatTextMaxPx - A.floatTextMinPx) * f.size01;
      const pop = u < 0.12 ? 0.6 + (u / 0.12) * 0.5 : 1.1 - Math.min(0.1, (u - 0.12));
      g.globalAlpha = u > 0.6 ? 1 - (u - 0.6) / 0.4 : 1;
      g.font = `800 ${px * pop}px ${this.font}`;
      const x = this.X(f.x);
      const y = this.Y(f.y - (f.rise ? A.floatTextRise * easeOut(u) : A.pegPopupDrift * u));
      g.lineWidth = Math.max(2, px * 0.16);
      g.strokeStyle = 'rgba(20,22,58,0.85)';
      g.strokeText(f.text, x, y);
      g.fillStyle = colors[f.color] || T.floatText;
      g.fillText(f.text, x, y);
    }
    g.globalAlpha = 1;
    this.drawPlacement(game);
  }

  /** Sockets: empty ones as dashed rings, filled ones as coloured special pegs with a glyph. */
  drawSpecialPegs(game) {
    const g = this.g, geo = game.geo, s = this.s, board = game.board, up = game.state.boardUp;
    const P = this.config.boardTree.pegs;
    const pr = geo.pegRadius * s;
    const glyph = { gold: '+', multiplier: '×', splitter: '÷', bumper: '!' };
    g.textAlign = 'center'; g.textBaseline = 'middle';
    board.sockets.forEach((sock, idx) => {
      if (sock.r >= geo.rows) return;
      const x = this.X(geo.pegX(sock.r, sock.i + 1)), y = this.Y(geo.pegY(sock.r));
      const peg = up.sockets[idx];
      if (!peg) {
        g.setLineDash([3, 3]);
        g.strokeStyle = 'rgba(255,255,255,0.55)';
        g.lineWidth = 1.5;
        g.beginPath(); g.arc(x, y, pr * (this.config.layout.specialPegScale + 0.5), 0, Math.PI * 2); g.stroke();
        g.setLineDash([]);
        return;
      }
      const f = game.pegFlash[geo.pegIndex(sock.r, sock.i + 1)];
      const R = pr * (this.config.layout.specialPegScale + 0.35 * f + (peg.type === 'bumper' ? 0.15 : 0));
      const pimg = this.sprite('peg_' + peg.type);
      if (pimg) {
        const d = R * 2.5;
        g.drawImage(pimg, x - d / 2, y - d / 2, d, d * pimg.height / pimg.width);
        if (peg.level > 1) { g.font = `700 ${Math.max(8, R * 0.75)}px ${this.font}`; g.fillStyle = '#fff'; g.fillText(String(peg.level), x + R * 1.25, y - R * 1.05); }
        return;
      }
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.beginPath(); g.arc(x + R * 0.12, y + R * 0.22, R, 0, Math.PI * 2); g.fill();
      g.fillStyle = P[peg.type].color;
      g.beginPath(); g.arc(x, y, R, 0, Math.PI * 2); g.fill();
      if (peg.type === 'bumper') {
        g.strokeStyle = '#fff'; g.lineWidth = 2;
        g.beginPath(); g.arc(x, y, R * 0.72, 0, Math.PI * 2); g.stroke();
      }
      g.fillStyle = 'rgba(20,22,58,0.9)';
      if (peg.type === 'splitter') {
        // fork glyph: one stem splitting into two
        g.strokeStyle = 'rgba(20,22,58,0.9)'; g.lineWidth = Math.max(1.5, R * 0.22); g.lineCap = 'round';
        g.beginPath();
        g.moveTo(x, y - R * 0.5); g.lineTo(x, y);
        g.moveTo(x, y); g.lineTo(x - R * 0.42, y + R * 0.45);
        g.moveTo(x, y); g.lineTo(x + R * 0.42, y + R * 0.45);
        g.stroke();
      } else {
        g.font = `800 ${R * 1.25}px ${this.font}`;
        g.fillText(glyph[peg.type], x, y + R * 0.05);
      }
      if (peg.level > 1) {
        g.font = `700 ${Math.max(8, R * 0.75)}px ${this.font}`;
        g.fillStyle = '#fff';
        g.fillText(String(peg.level), x + R * 0.95, y - R * 0.85);
      }
    });
  }

  /** Lids: two metal flaps hinged on the pegs either side of a gap, closing toward each other. */
  drawLids(game) {
    const g = this.g, geo = game.geo, s = this.s, L = this.config.layout;
    for (const lid of game.model.lids) {
      const color = this.config.boardTree.pieces.lids.color;
      const f = game.lidFlash[lid.id] || 0;
      const xa = geo.pegX(lid.r, lid.j) + geo.pegRadius, xb = geo.pegX(lid.r, lid.j + 1) - geo.pegRadius;
      const len = (lid.cover * (xb - xa)) / 2, y = this.Y(geo.pegY(lid.r)), th = L.lidThickness * s;
      const full = lid.cover >= 1;
      const flaps = full ? [[xa - geo.pegRadius * 0.4, xb + geo.pegRadius * 0.4]] : [[xa - geo.pegRadius * 0.4, xa + len], [xb - len, xb + geo.pegRadius * 0.4]];
      const bar = this.sprite('lid');
      for (const [u0, u1] of flaps) {
        const X0 = this.X(u0), X1 = this.X(u1);
        if (bar) { const bh2 = th * 2.4; g.drawImage(bar, X0, y - bh2 / 2 - f * 2, X1 - X0, bh2); continue; }
        g.fillStyle = 'rgba(0,0,0,0.35)';
        roundRect(g, X0 + 1, y - th / 2 + 2, X1 - X0, th, th / 2); g.fill();
        g.fillStyle = f > 0 ? lerpColor(color, '#ffffff', f * 0.7) : color;
        roundRect(g, X0, y - th / 2 - f * 2, X1 - X0, th, th / 2); g.fill();
        g.fillStyle = 'rgba(255,255,255,0.5)';
        roundRect(g, X0 + th * 0.3, y - th / 2 - f * 2 + th * 0.15, Math.max(0, X1 - X0 - th * 0.6), th * 0.25, th * 0.12); g.fill();
      }
      if (bar) continue;
      if (full) { // seam + rivets on a closed lid
        g.fillStyle = 'rgba(20,22,58,0.55)';
        const cx = this.X((xa + xb) / 2);
        g.fillRect(cx - 0.75, y - th / 2, 1.5, th);
      }
      g.fillStyle = '#14163a'; // hinge bolts
      for (const px of [geo.pegX(lid.r, lid.j), geo.pegX(lid.r, lid.j + 1)]) {
        g.beginPath(); g.arc(this.X(px), y, geo.pegRadius * s * 0.45, 0, Math.PI * 2); g.fill();
      }
    }
  }

  /** Flippers: a paddle on a peg; at rest it hangs down, when fired it swats up and outward. */
  drawFlippers(game) {
    const fl = game.model.flippers;
    if (!fl.length) return;
    const g = this.g, geo = game.geo, s = this.s, L = this.config.layout, F = this.config.animation.flipper;
    const color = this.config.boardTree.pieces.flippers.color;
    const auto = game.model.rules.size && [...game.model.rules.values()].some((p) => p[0]?.kind === 'flip');
    for (const f of fl) {
      const t = game.flipAnim[f.n];
      let p = 0; // 0 rest → 1 fully swung
      if (t < F.swingSec) p = 1 - (1 - t / F.swingSec) ** 2;
      else if (t < F.swingSec + F.holdSec) p = 1;
      else if (t < F.swingSec + F.holdSec + F.returnSec) p = 1 - (t - F.swingSec - F.holdSec) / F.returnSec;
      const th = ((F.restDeg + F.sweepDeg * p) * Math.PI) / 180;
      const px = this.X(geo.pegX(f.r, f.i + 1)), py = this.Y(geo.pegY(f.r));
      const len = L.flipperLength * s, w0 = L.flipperWidth * s, w1 = w0 * 0.5;
      const ux = Math.cos(th) * f.dir, uy = -Math.sin(th); // along the paddle (screen space)
      const nx = -uy, ny = ux;
      const tx = px + ux * len, ty = py + uy * len;
      // Catch ring: faint at rest, bright and pulsing while a ball can be flipped.
      const ready = game.flipReady[f.n];
      const rr = F.ringRadius * s * (ready ? 1 + 0.08 * Math.sin(game.time * 22) : 1);
      g.save();
      g.lineWidth = ready ? Math.max(2.5, s * 0.07) : Math.max(1, s * 0.03);
      g.strokeStyle = ready ? '#ffffff' : 'rgba(255,255,255,0.28)';
      if (!ready) g.setLineDash([s * 0.12, s * 0.1]);
      g.beginPath(); g.arc(px, py, rr, 0, Math.PI * 2); g.stroke();
      if (ready) { g.globalAlpha = 0.22; g.fillStyle = color; g.fill(); }
      g.restore();
      const paddle = () => {
        g.beginPath();
        g.moveTo(px + nx * w0 / 2, py + ny * w0 / 2);
        g.lineTo(tx + nx * w1 / 2, ty + ny * w1 / 2);
        g.arc(tx, ty, w1 / 2, Math.atan2(ny, nx), Math.atan2(-ny, -nx), f.dir < 0);
        g.lineTo(px - nx * w0 / 2, py - ny * w0 / 2);
        g.arc(px, py, w0 / 2, Math.atan2(-ny, -nx), Math.atan2(ny, nx), f.dir < 0);
        g.closePath();
      };
      const fimg = this.sprite('flipper');
      if (fimg) { // painted paddle: hub at the peg, tip along the paddle direction
        const fl2 = len * 1.5, fh2 = fl2 * fimg.height / fimg.width;
        g.save(); g.translate(px, py); g.rotate(Math.atan2(uy, ux)); if (ux < 0) g.scale(1, -1);
        g.drawImage(fimg, -fh2 * 0.5, -fh2 / 2, fl2, fh2);
        g.restore();
      } else {
      g.save();
      g.translate(1.5, 2.5); g.fillStyle = 'rgba(0,0,0,0.35)'; paddle(); g.fill();
      g.restore();
      g.fillStyle = p > 0 ? lerpColor(color, '#ffffff', 0.35 * p) : color;
      paddle(); g.fill();
      g.strokeStyle = '#ffffff'; g.lineWidth = Math.max(1, s * 0.025); paddle(); g.stroke();
      g.fillStyle = '#14163a';
      g.beginPath(); g.arc(px, py, w0 * 0.28, 0, Math.PI * 2); g.fill();
      }
      if (p > 0.3) { // swoosh
        g.strokeStyle = `rgba(255,255,255,${0.5 * p})`; g.lineWidth = 2;
        g.beginPath(); g.arc(px, py, len * 1.05, -th * (f.dir) - 0.6, -th * (f.dir) + 0.1); g.stroke();
      }
      if (auto) {
        g.font = `800 ${Math.max(7, s * 0.17)}px ${this.font}`;
        g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('AUTO', px + f.dir * s * 0.12, py - s * 0.36);
      }
    }
  }

  /**
   * Side Suction: a glowing vent on each wall, with air drawn from the centre of the board
   * outward and funnelling into the vents (comet streaks accelerate as they near the vent).
   */
  drawSuction(game) {
    const su = game.model.suction;
    if (!su) return;
    const g = this.g, geo = game.geo, s = this.s, A = this.config.animation;
    const r0 = su.rows[0], r1 = su.rows[1] - 1;
    const yTop = geo.pegY(r0) - geo.dy * 0.45, yBot = geo.pegY(r1) + geo.dy * 0.45, yc = (yTop + yBot) / 2;
    const B = this.bounds;
    const ventX = B.maxX - 0.26, ventL = B.minX + 0.26, ventH = Math.max(0.9, (yBot - yTop) * 0.9), ventW = 0.36;
    const strength = 0.35 + 0.6 * su.pull; // stronger pull → brighter, faster air
    // the wind band itself: a faint tinted strip so the affected rows are obvious
    const band = g.createLinearGradient(this.X(ventL), 0, this.X(ventX), 0);
    band.addColorStop(0, 'rgba(160,220,255,0.16)'); band.addColorStop(0.5, 'rgba(160,220,255,0.03)'); band.addColorStop(1, 'rgba(160,220,255,0.16)');
    g.fillStyle = band;
    g.fillRect(this.X(ventL), this.Y(yTop), (ventX - ventL) * s, (yBot - yTop) * s);

    // Air streaks: tapered comets, faint tail → bright head, curving into the vent mouth.
    const n = A.suctionStreaks + 6 * (su.rowCount - 1);
    g.lineCap = 'round';
    for (let k = 0; k < n; k++) {
      const side = k % 2 ? 1 : -1;
      const ph = (game.time * A.suctionStreakSpeed * (0.5 + su.pull) * (0.8 + 0.4 * ((k * 0.37) % 1)) + k / n) % 1;
      const y0 = yTop + ((k * 0.618) % 1) * (yBot - yTop);
      const at = (u) => [side * 0.2 + u * u * ((side > 0 ? ventX : ventL) - side * 0.2), y0 + (yc - y0) * Math.pow(u, 1.6)];
      const fade = Math.min(1, ph * 5) * Math.min(1, (1 - ph) * 8);
      const seg = 5;
      for (let q = 0; q < seg; q++) {
        const ua = Math.max(0, ph - 0.16 * (1 - q / seg)), ub = Math.max(0, ph - 0.16 * (1 - (q + 1) / seg));
        const [ax, ay] = at(ua), [bx, by] = at(ub);
        g.globalAlpha = fade * strength * ((q + 1) / seg);
        g.strokeStyle = '#d6f1ff';
        g.lineWidth = (0.6 + 2.4 * ph) * ((q + 1) / seg) + 0.5;
        g.beginPath(); g.moveTo(this.X(ax), this.Y(ay)); g.lineTo(this.X(bx), this.Y(by)); g.stroke();
      }
    }
    g.globalAlpha = 1;

    // Vents: housing, dark throat with an intake glow, grille slats.
    for (const side of [-1, 1]) {
      const cx = this.X(side > 0 ? ventX : ventL), cy = this.Y(yc), w = ventW * s, h = ventH * s;
      const glow = g.createRadialGradient(cx, cy, 0, cx, cy, h * 0.7);
      glow.addColorStop(0, `rgba(160,220,255,${0.28 * strength})`); glow.addColorStop(1, 'rgba(160,220,255,0)');
      g.fillStyle = glow; g.beginPath(); g.arc(cx, cy, h * 0.7, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(0,0,0,0.35)';
      roundRect(g, cx - w / 2 + 2, cy - h / 2 + 3, w, h, w * 0.45); g.fill();
      g.fillStyle = '#5560c9';
      roundRect(g, cx - w / 2, cy - h / 2, w, h, w * 0.45); g.fill();
      g.fillStyle = '#0b0d2e';
      roundRect(g, cx - w * 0.32, cy - h * 0.44, w * 0.64, h * 0.88, w * 0.3); g.fill();
      const pulse = (game.time * 2.4) % 1;
      g.fillStyle = `rgba(191,232,255,${0.4 * (1 - pulse)})`;
      roundRect(g, cx - w * 0.32, cy - h * 0.44, w * 0.64, h * 0.88, w * 0.3); g.fill();
      g.strokeStyle = '#aab3ff'; g.lineWidth = Math.max(1.2, s * 0.04);
      const slats = 6;
      for (let j = 1; j < slats; j++) {
        const yy = cy - h * 0.44 + (h * 0.88 * j) / slats;
        g.beginPath(); g.moveTo(cx - w * 0.32, yy); g.lineTo(cx + w * 0.32, yy); g.stroke();
      }
    }
  }

  /**
   * Placement mode: every legal spot for the piece being moved, coloured by what it would do
   * to income (green = better than now, red = worse); the best few carry their % label.
   * this.placement = { what, options:[{r,j}|{bucket}, pct, current] } or null (set by the UI).
   */
  drawPlacement(game) {
    const P = this.placement;
    if (!P) return;
    const g = this.g, geo = game.geo, s = this.s;
    g.fillStyle = 'rgba(8,10,40,0.45)';
    g.fillRect(0, 0, this.W, this.H);
    const best = [...P.options].sort((a, b) => b.pct - a.pct).slice(0, 3);
    const pulse = 0.5 + 0.5 * Math.sin(game.time * 6);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const o of P.options) {
      const [x, y] = this.spotXY(game, o);
      const good = o.pct >= 0.5, bad = o.pct <= -0.5;
      const col = o.current ? '#ffffff' : good ? '#5dfc9a' : bad ? '#ff6b6b' : '#c8ccff';
      const rad = s * (o.bucket != null ? 0.34 : 0.2) * (best.includes(o) ? 1.15 + 0.12 * pulse : 1);
      g.globalAlpha = o.current ? 1 : good ? 0.95 : 0.6;
      g.fillStyle = col;
      g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1;
      g.strokeStyle = '#14163a'; g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.stroke();
      if (o.current || best.includes(o)) {
        const txt = o.current ? 'now' : `${o.pct >= 0 ? '+' : ''}${o.pct.toFixed(0)}%`;
        g.font = `800 ${Math.max(9, s * 0.24)}px ${this.font}`;
        g.lineWidth = 3; g.strokeStyle = '#14163a';
        g.strokeText(txt, x, y - rad - s * 0.16);
        g.fillStyle = col;
        g.fillText(txt, x, y - rad - s * 0.16);
      }
    }
  }

  /** Canvas position of a placement spot (lid gap centre, or bucket mouth). */
  spotXY(game, o) {
    const geo = game.geo;
    if (o.bucket != null) return [this.X(geo.bucketX(o.bucket)), this.Y(geo.bucketTop - 0.1)];
    return [this.X((geo.pegX(o.r, o.j) + geo.pegX(o.r, o.j + 1)) / 2), this.Y(geo.pegY(o.r))];
  }

  /** Bucket back: the dark opening and the back half of the rim (balls drop in front of it). */
  drawBucketBack(cx, top, bw, bh, color) {
    if (this.theme.style === 'framed') return; // tiles have no opening
    const g = this.g, rim = this.config.layout.bucketRim * this.s;
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.beginPath(); g.ellipse(cx + 1, top + bh + 3, bw * 0.42, rim * 0.6, 0, 0, Math.PI * 2); g.fill(); // ground shadow
    g.fillStyle = lerpColor(color, '#000000', 0.25);
    g.beginPath(); g.ellipse(cx, top, bw / 2, rim, 0, Math.PI, 0); g.fill(); // back rim
    g.fillStyle = '#0b0d2e';
    g.beginPath(); g.ellipse(cx, top, bw / 2 - rim * 0.45, rim * 0.62, 0, 0, Math.PI * 2); g.fill(); // opening
  }

  /** Bucket front: tapered pail body with a rolled rim, a band and the multiplier label. */
  drawBucketFront(cx, top, bw, bh, color, label, fontPx, textColor) {
    const cup = this.theme.cups && this.sprite('bucket_' + this.theme.cups[this.theme.tiles.indexOf(color)]);
    if (cup) { drawCup(this.g, cup, cx, top, bw, bh * 0.92, label, fontPx * 1.15, this.font, color === this.theme.bucketTop, color); return; }
    if (this.theme.style === 'framed') { drawTile(this.g, cx, top, bw, bh * 0.92, color, label, fontPx * 1.15, this.font, color === this.theme.bucketTop); return; }
    const g = this.g, L = this.config.layout, rim = L.bucketRim * this.s;
    const w0 = bw / 2, w1 = (bw * L.bucketTaper) / 2, bot = top + bh, rr = w1 * 0.35;
    const body = () => {
      g.beginPath();
      g.moveTo(cx - w0, top);
      g.ellipse(cx, top, w0, rim * 0.62, 0, Math.PI, 0, true); // front lip of the opening (lower half)
      g.lineTo(cx + w1, bot - rr);
      g.quadraticCurveTo(cx + w1, bot, cx + w1 - rr, bot);
      g.lineTo(cx - w1 + rr, bot);
      g.quadraticCurveTo(cx - w1, bot, cx - w1, bot - rr);
      g.closePath();
    };
    const grad = g.createLinearGradient(cx - w0, 0, cx + w0, 0);
    grad.addColorStop(0, lerpColor(color, '#ffffff', 0.25));
    grad.addColorStop(0.45, color);
    grad.addColorStop(1, lerpColor(color, '#000000', 0.22));
    g.fillStyle = grad; body(); g.fill();
    // band near the bottom
    const by = top + bh * 0.8, bwid = w1 + (w0 - w1) * 0.2;
    g.fillStyle = 'rgba(20,22,58,0.18)';
    g.fillRect(cx - bwid, by, bwid * 2, Math.max(2, bh * 0.07));
    // rim: rolled lip (front half)
    g.strokeStyle = lerpColor(color, '#ffffff', 0.45);
    g.lineWidth = Math.max(2, rim * 0.55);
    g.beginPath(); g.ellipse(cx, top, w0 - g.lineWidth / 2, rim * 0.62, 0, 0, Math.PI); g.stroke();
    g.fillStyle = textColor;
    g.font = `700 ${fontPx}px ${this.font}`;
    const lw = g.measureText(label).width; // long multipliers shrink to fit the bucket
    if (lw > bw * 0.7) g.font = `700 ${Math.max(6, fontPx * (bw * 0.7) / lw)}px ${this.font}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(label, cx, top + bh * 0.5);
  }

  /** Trampoline: a framed bouncy mat on springs over the outer half of the lowest bucket's mouth. */
  drawTrampoline(game) {
    const tr = game.animOpts.tramp;
    if (!tr) return;
    const g = this.g, s = this.s, L = this.config.layout, A = this.config.animation;
    const pw = game.trampolinePad() * s, th = L.trampolinePadThickness * s;
    const fire = game.trampFlash; // 1 → 0 after a launch
    for (const k of [game.model.trampoline.bucket]) {
      const x = this.X(game.geo.bucketX(k));
      const bob = Math.sin(game.time * 5 + k) * A.trampolineBobAmp * s;
      const yTop = this.Y(tr.padY) + bob + fire * th * 0.4;
      const rimY = this.Y(game.geo.bucketTop);
      // halo
      const halo = g.createRadialGradient(x, yTop + th / 2, 0, x, yTop + th / 2, pw * 0.8);
      halo.addColorStop(0, `rgba(255,120,170,${0.35 + 0.35 * fire})`); halo.addColorStop(1, 'rgba(255,120,170,0)');
      g.fillStyle = halo; g.beginPath(); g.arc(x, yTop + th / 2, pw * 0.8, 0, Math.PI * 2); g.fill();
      // bouncing up-arrow hint
      const ay = yTop - th * (1.4 + 0.5 * Math.abs(Math.sin(game.time * 4)));
      g.fillStyle = '#ffe066';
      g.beginPath();
      g.moveTo(x, ay - th * 1.1); g.lineTo(x - th * 0.8, ay); g.lineTo(x - th * 0.3, ay); g.lineTo(x - th * 0.3, ay + th * 0.5);
      g.lineTo(x + th * 0.3, ay + th * 0.5); g.lineTo(x + th * 0.3, ay); g.lineTo(x + th * 0.8, ay);
      g.closePath(); g.fill();
      const timg = this.sprite('trampoline');
      if (timg) { // painted trampoline: squashes when it fires
        const tw = pw * 1.2, tH = tw * timg.height / timg.width * (1 - 0.18 * fire);
        g.drawImage(timg, x - tw / 2, yTop - tH * 0.12 + fire * th * 0.5, tw, tH);
        if (fire > 0) { g.strokeStyle = `rgba(255,224,102,${fire})`; g.lineWidth = 2.5; g.beginPath(); g.ellipse(x, yTop + th / 2, pw * (0.6 + (1 - fire) * 0.9), th * (0.8 + (1 - fire) * 2.2), 0, 0, Math.PI * 2); g.stroke(); }
        continue;
      }
      // springs down to the rim
      g.strokeStyle = '#ffffff'; g.lineWidth = Math.max(1.5, s * 0.03);
      for (const sx of [x - pw * 0.32, x + pw * 0.32]) {
        g.beginPath();
        const steps = 5, y0 = yTop + th, y1 = rimY + s * 0.04;
        for (let z = 0; z <= steps; z++) g.lineTo(sx + (z % 2 ? 1 : -1) * th * 0.28, y0 + ((y1 - y0) * z) / steps);
        g.stroke();
      }
      // frame
      g.fillStyle = 'rgba(0,0,0,0.35)';
      roundRect(g, x - pw / 2 + 1, yTop + 3, pw, th, th / 2); g.fill();
      g.fillStyle = '#ffffff';
      roundRect(g, x - pw / 2, yTop, pw, th, th / 2); g.fill();
      // striped mat, dipping when it fires
      const dip = fire * th * 1.4, m0 = yTop + th * 0.22, m1 = yTop + th * 0.78, inset = th * 0.3;
      g.save();
      g.beginPath();
      g.moveTo(x - pw / 2 + inset, m0);
      g.quadraticCurveTo(x, m0 + dip, x + pw / 2 - inset, m0);
      g.lineTo(x + pw / 2 - inset, m1);
      g.quadraticCurveTo(x, m1 + dip, x - pw / 2 + inset, m1);
      g.closePath();
      g.fillStyle = fire > 0 ? '#ffe066' : '#ff4d8d';
      g.fill();
      g.clip();
      g.fillStyle = 'rgba(255,255,255,0.45)';
      for (let sx = x - pw / 2 - th; sx < x + pw / 2; sx += th * 0.8) {
        g.beginPath(); g.moveTo(sx, m1 + dip); g.lineTo(sx + th * 0.3, m1 + dip); g.lineTo(sx + th * 0.6, m0 - th); g.lineTo(sx + th * 0.3, m0 - th); g.closePath(); g.fill();
      }
      g.restore();
      // launch ring
      if (fire > 0) {
        g.strokeStyle = `rgba(255,224,102,${fire})`; g.lineWidth = 2.5;
        g.beginPath(); g.ellipse(x, yTop + th / 2, pw * (0.6 + (1 - fire) * 0.9), th * (0.8 + (1 - fire) * 2.2), 0, 0, Math.PI * 2); g.stroke();
      }
    }
  }

  /**
   * Magnet: a big horseshoe under its bucket, with field lines arcing in from the
   * neighbouring buckets and sparks flowing along them into the target.
   */
  drawMagnet(game, bw, bh, bucketY) {
    const mg = game.model.magnet;
    if (!mg) return;
    const g = this.g, geo = game.geo, s = this.s, A = this.config.animation;
    const k = mg.target, cx = this.X(geo.bucketX(k)), top = bucketY(k);
    const strength = 0.4 + 0.12 * mg.level;
    // capture zone: the triangle of pegs above the bucket — every ball entering it is pulled in
    const NR = geo.rows, rTop = Math.max(0, NR - mg.reach);
    const pulse = 0.5 + 0.5 * Math.sin(game.time * 3);
    const zx0 = this.X(geo.pegX(rTop, Math.max(0, k - (NR - rTop)) + 1)) - s * 0.3;
    const zx1 = this.X(geo.pegX(rTop, Math.min(rTop, k) + 1)) + s * 0.3;
    const zy = this.Y(geo.pegY(rTop)) - s * 0.3;
    const zone = g.createLinearGradient(0, zy, 0, top);
    zone.addColorStop(0, 'rgba(255,77,109,0)'); zone.addColorStop(1, `rgba(255,77,109,${0.16 + 0.1 * pulse + 0.2 * game.magnetFlash})`);
    g.fillStyle = zone;
    g.beginPath(); g.moveTo(zx0, zy); g.lineTo(zx1, zy); g.lineTo(cx + bw * 0.5, top); g.lineTo(cx - bw * 0.5, top); g.closePath(); g.fill();
    g.strokeStyle = `rgba(255,120,150,${0.35 + 0.25 * pulse})`; g.lineWidth = 1.5; g.setLineDash([4, 4]);
    g.lineDashOffset = -game.time * 14;
    g.beginPath(); g.moveTo(zx0, zy); g.lineTo(cx - bw * 0.5, top); g.moveTo(zx1, zy); g.lineTo(cx + bw * 0.5, top); g.stroke();
    g.setLineDash([]);
    // tethers: balls caught in the zone are visibly reeled in
    for (const b of game.balls) {
      if (!b.active || b.t < 0 || b.landedAt >= 0 || b.bucket !== k) continue;
      const by = this.Y(b.y);
      if (by < zy || b.seg < b.segs.length - 6) continue;
      g.strokeStyle = 'rgba(255,170,190,0.75)'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(this.X(b.x), by); g.quadraticCurveTo((this.X(b.x) + cx) / 2, by, cx, top); g.stroke();
    }
    // magnetised rim aura on the target bucket
    const aura = 0.5 + 0.5 * Math.sin(game.time * 4);
    g.strokeStyle = `rgba(255,77,109,${0.35 + 0.35 * aura})`;
    g.lineWidth = Math.max(2, s * 0.06);
    g.beginPath(); g.ellipse(cx, top, bw * 0.56, this.config.layout.bucketRim * s * 1.4, 0, 0, Math.PI * 2); g.stroke();
    // field lines from each neighbour's mouth into the target's mouth, sparks flowing inward
    g.lineCap = 'round';
    for (const nb of [k - 1, k + 1]) {
      if (nb < 0 || nb > geo.rows) continue;
      const nx = this.X(geo.bucketX(nb));
      for (let line = 0; line < 2; line++) {
        const lift = s * (0.3 + line * 0.22);
        const mx = (cx + nx) / 2, my = top - lift;
        g.strokeStyle = `rgba(255,120,150,${0.3 + 0.08 * strength})`;
        g.lineWidth = 2; g.setLineDash([5, 5]);
        g.lineDashOffset = game.time * 40 * A.magnetFieldSpeed * Math.sign(cx - nx);
        g.beginPath(); g.moveTo(nx, top); g.quadraticCurveTo(mx, my, cx, top); g.stroke();
        g.setLineDash([]);
        for (let q = 0; q < 2; q++) {
          const u = (game.time * A.magnetFieldSpeed + q * 0.5 + line * 0.25 + (nb > k ? 0.13 : 0)) % 1;
          const bx = (1 - u) * (1 - u) * nx + 2 * u * (1 - u) * mx + u * u * cx;
          const by = (1 - u) * (1 - u) * top + 2 * u * (1 - u) * my + u * u * top;
          g.fillStyle = `rgba(255,230,240,${Math.sin(Math.PI * u) * Math.min(1, strength)})`;
          g.beginPath(); g.arc(bx, by, 1.5 + 2 * u, 0, Math.PI * 2); g.fill();
        }
      }
    }
    // horseshoe under the bucket, poles up toward it
    const mw = bw * 0.78, armW = mw * 0.32, mTop = this.Y(geo.bucketBottom) + s * 0.36, mBot = mTop + s * 0.46;
    const R = mw / 2, cyU = mBot - R;
    const mimg = this.sprite('magnet');
    if (mimg) { const mh = mw * 1.25 * mimg.height / mimg.width; g.drawImage(mimg, cx - mw * 0.625, mTop - s * 0.06, mw * 1.25, mh); } else {
    g.lineCap = 'butt';
    g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = armW;
    g.beginPath(); g.moveTo(cx - R + armW / 2 + 1.5, mTop + 2); g.lineTo(cx - R + armW / 2 + 1.5, cyU + 2); g.arc(cx + 1.5, cyU + 2, R - armW / 2, Math.PI, 0, true); g.lineTo(cx + R - armW / 2 + 1.5, mTop + 2); g.stroke();
    g.strokeStyle = '#ff4d6d';
    g.beginPath(); g.moveTo(cx - R + armW / 2, mTop); g.lineTo(cx - R + armW / 2, cyU); g.arc(cx, cyU, R - armW / 2, Math.PI, 0, true); g.lineTo(cx + R - armW / 2, mTop); g.stroke();
    g.fillStyle = '#e9ecff'; // pole tips
    g.fillRect(cx - R, mTop - s * 0.02, armW, s * 0.1);
    g.fillRect(cx + R - armW, mTop - s * 0.02, armW, s * 0.1);
    }
    // little zaps between the poles and the bucket
    for (const px of [cx - R + armW / 2, cx + R - armW / 2]) {
      const zz = (game.time * 6 + px) % 1;
      g.strokeStyle = `rgba(255,230,240,${0.7 * (1 - zz)})`; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(px, mTop - s * 0.04); g.lineTo(px + s * 0.04, mTop - s * 0.12); g.lineTo(px - s * 0.03, mTop - s * 0.2); g.stroke();
    }
  }
}

/** Bucket fill colours: low→mid→high by log multiplier; top bucket gets its own colour. */
export function bucketColors(mults, T) {
  const real = mults.filter((m) => m > 0); // 0 = a bucket this board's shape doesn't have
  const max = Math.max(...real), min = Math.min(...real);
  if (T.tiles) { // framed style: one tile colour per multiplier rank, best first
    const ranks = [...new Set(real)].sort((a, b) => b - a);
    return mults.map((m) => (m > 0 ? T.tiles[Math.min(ranks.indexOf(m), T.tiles.length - 1)] : 'rgba(0,0,0,0)'));
  }
  return mults.map((m) => {
    if (!(m > 0)) return 'rgba(0,0,0,0)';
    if (m === max) return T.bucketTop;
    const t = max > min ? Math.log(m / min) / Math.log(max / min) : 0;
    return t < 0.5 ? lerpColor(T.bucketLow, T.bucketMid, t * 2) : lerpColor(T.bucketMid, T.bucketHigh, (t - 0.5) * 2);
  });
}

/**
 * Wall blocks: every missing peg / bucket that an existing peg could otherwise drop onto.
 * @returns [{ r, x, y }] in lattice units (r = row of the block; rows = the bucket row)
 */
function wallBlocks(m, geo) {
  const seen = new Map();
  const R = m.rows;
  for (let r = 0; r < R; r++) for (let i = 0; i <= r; i++) {
    if (!m.allowed(r, i)) continue;
    for (const c of [i, i + 1]) {
      if (m.allowed(r + 1, c)) continue;
      const key = (r + 1) * 256 + c;
      if (seen.has(key)) continue;
      seen.set(key, r + 1 === R
        ? { r: R, x: geo.bucketX(c), y: geo.bucketTop + 0.05 }
        : { r: r + 1, x: geo.pegX(r + 1, c + 1), y: geo.pegY(r + 1) });
    }
  }
  return [...seen.values()];
}

/** One peg outline in the theme's shape. */
/** Faint background pattern per theme, so boards don't all look like the same room. */
function drawPattern(g, pattern, W, H, s) {
  g.save();
  g.strokeStyle = g.fillStyle = 'rgba(255,255,255,0.05)';
  const step = Math.max(18, s * 1.1);
  switch (pattern) {
    case 'stripes':
      g.lineWidth = step * 0.45;
      for (let x = -H; x < W; x += step * 1.6) { g.beginPath(); g.moveTo(x, H); g.lineTo(x + H, 0); g.stroke(); }
      break;
    case 'grid':
      g.lineWidth = 1; g.strokeStyle = 'rgba(125,249,255,0.09)';
      for (let x = 0; x < W; x += step) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
      for (let y = 0; y < H; y += step) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
      break;
    case 'stars':
      for (let k = 0; k < 90; k++) {
        const x = ((k * 7919) % 997) / 997 * W, y = ((k * 6151) % 991) / 991 * H, r = 0.6 + ((k * 31) % 5) * 0.35;
        g.fillStyle = `rgba(255,255,255,${0.15 + ((k * 13) % 7) * 0.07})`;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      }
      break;
    case 'waves':
      g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,0.07)';
      for (let y = step; y < H; y += step * 1.2) {
        g.beginPath();
        for (let x = 0; x <= W; x += 6) g.lineTo(x, y + Math.sin(x / step * 1.6 + y) * step * 0.18);
        g.stroke();
      }
      break;
    default: // dots
      for (let y = step / 2, row = 0; y < H; y += step, row++) for (let x = (row % 2 ? step : step / 2); x < W; x += step) {
        g.beginPath(); g.arc(x, y, step * 0.09, 0, Math.PI * 2); g.fill();
      }
  }
  g.restore();
}

const easeOut = (u) => 1 - (1 - u) * (1 - u);

function fmtPct(p) {
  const v = p * 100;
  if (v >= 10) return Math.round(v) + '%';
  if (v >= 1) return v.toFixed(1) + '%';
  return v.toFixed(2) + '%';
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
