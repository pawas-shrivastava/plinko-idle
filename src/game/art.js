// Painted look: scenic backgrounds per theme, shaded peg sprites, ball skins.
// Everything here is drawn once into cached canvases, never per frame.

const hexToRgb = (h) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgba = (hex, a) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; };
export const shade = (hex, t) => { // t < 0 darkens, t > 0 lightens
  const c = hexToRgb(hex).map((v) => Math.round(t < 0 ? v * (1 + t) : v + (255 - v) * t));
  return `rgb(${c.join(',')})`;
};
/** Small seeded generator so scenery is identical on every rebuild. */
const rnd = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

export function pegPath(g, shape, x, y, r) {
  switch (shape) {
    case 'diamond': { const d = r * 1.3; g.moveTo(x, y - d); g.lineTo(x + d, y); g.lineTo(x, y + d); g.lineTo(x - d, y); g.closePath(); break; }
    case 'square': { const d = r * 0.95; g.rect(x - d, y - d, d * 2, d * 2); break; }
    case 'star': {
      const R = r * 1.45, q = r * 0.65;
      for (let k = 0; k < 10; k++) {
        const a = -Math.PI / 2 + (k * Math.PI) / 5, rr = k % 2 ? q : R;
        if (k === 0) g.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); else g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      }
      g.closePath(); break;
    }
    default: g.moveTo(x + r, y); g.arc(x, y, r, 0, Math.PI * 2);
  }
}

/** A shaded peg (domed stud / cut gem) with its own soft shadow. r in device pixels. */
export function makePegSprite(shape, color, r) {
  const pad = Math.ceil(r * 1.9) + 3, size = pad * 2;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  // contact shadow
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = r * 0.9; g.shadowOffsetX = r * 0.2; g.shadowOffsetY = r * 0.55;
  g.fillStyle = shade(color, -0.45);
  g.beginPath(); pegPath(g, shape, pad, pad, r); g.fill();
  g.restore();
  // body: light from the top-left
  const body = g.createRadialGradient(pad - r * 0.45, pad - r * 0.55, r * 0.05, pad, pad, r * 1.5);
  body.addColorStop(0, '#ffffff'); body.addColorStop(0.3, color); body.addColorStop(1, shade(color, -0.5));
  g.fillStyle = body;
  g.beginPath(); pegPath(g, shape, pad, pad, r); g.fill();
  // rim + sparkle
  g.lineWidth = Math.max(1, r * 0.14); g.strokeStyle = 'rgba(0,0,0,0.28)';
  g.beginPath(); pegPath(g, shape, pad, pad, r); g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.beginPath(); g.ellipse(pad - r * 0.3, pad - r * 0.38, r * 0.28, r * 0.17, -0.6, 0, Math.PI * 2); g.fill();
  return { canvas: c, half: pad };
}

// ---------------------------------------------------------------------------
// Ball skins

/** Ball sprite centred at (m, m), radius r. skin: stripe | chrome | bubble | clover | coin. */
export function drawBallSprite(g, m, r, colors, skin = 'stripe') {
  g.clearRect(0, 0, m * 2, m * 2);
  const disc = () => { g.beginPath(); g.arc(m, m, r, 0, Math.PI * 2); };
  const grad = g.createRadialGradient(m - r * 0.35, m - r * 0.4, r * 0.1, m, m, r);
  grad.addColorStop(0, colors[0]); grad.addColorStop(0.35, colors[1]); grad.addColorStop(1, colors[2]);
  g.fillStyle = grad; disc(); g.fill();
  g.save(); disc(); g.clip();
  switch (skin) {
    case 'chrome': { // polished steel: sky / horizon / ground reflection
      const ch = g.createLinearGradient(0, m - r, 0, m + r);
      ch.addColorStop(0, '#f4f8ff'); ch.addColorStop(0.42, '#9fb0c8'); ch.addColorStop(0.5, '#3d4a5e'); ch.addColorStop(0.58, '#8493aa'); ch.addColorStop(1, '#dfe7f2');
      g.fillStyle = ch; g.fillRect(m - r, m - r, r * 2, r * 2);
      g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillRect(m - r * 0.15, m - r, r * 0.3, r * 2); // cross band so spin reads
      break;
    }
    case 'bubble': { // glassy: bright inner ring, darker core
      g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = r * 0.16;
      g.beginPath(); g.arc(m, m, r * 0.72, -2.6, -0.6); g.stroke();
      g.beginPath(); g.arc(m, m, r * 0.72, 0.6, 2.2); g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.beginPath(); g.arc(m + r * 0.3, m + r * 0.25, r * 0.16, 0, Math.PI * 2); g.fill();
      break;
    }
    case 'clover': { // four leaves and a stem
      g.fillStyle = shade(colors[2], -0.25);
      for (let k = 0; k < 4; k++) {
        const a = (k * Math.PI) / 2 + Math.PI / 4;
        g.beginPath(); g.arc(m + Math.cos(a) * r * 0.3, m + Math.sin(a) * r * 0.3, r * 0.28, 0, Math.PI * 2); g.fill();
      }
      g.fillRect(m - r * 0.06, m, r * 0.12, r * 0.75);
      break;
    }
    case 'coin': { // raised rim and a star
      g.strokeStyle = shade(colors[2], -0.1); g.lineWidth = r * 0.14;
      g.beginPath(); g.arc(m, m, r * 0.74, 0, Math.PI * 2); g.stroke();
      g.fillStyle = shade(colors[2], -0.05);
      g.beginPath(); pegPath(g, 'star', m, m, r * 0.36); g.fill();
      break;
    }
    default:
      g.fillStyle = 'rgba(255,255,255,0.6)';
      g.fillRect(m - r, m - r * 0.16, r * 2, r * 0.32);
  }
  // shared lighting: dark lower rim, glossy highlight
  const rim = g.createRadialGradient(m - r * 0.25, m - r * 0.3, r * 0.55, m, m, r * 1.02);
  rim.addColorStop(0, 'rgba(0,0,0,0)'); rim.addColorStop(1, 'rgba(0,0,0,0.42)');
  g.fillStyle = rim; g.fillRect(m - r, m - r, r * 2, r * 2);
  g.fillStyle = 'rgba(255,255,255,0.8)';
  g.beginPath(); g.ellipse(m - r * 0.36, m - r * 0.42, r * 0.3, r * 0.17, -0.65, 0, Math.PI * 2); g.fill();
  g.restore();
}

// ---------------------------------------------------------------------------
// Backgrounds

const blob = (g, x, y, r, color, a) => {
  const gr = g.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, rgba(color, a)); gr.addColorStop(1, rgba(color, 0));
  g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
};
const stars = (g, R, W, H, n, maxY = H) => {
  for (let k = 0; k < n; k++) {
    const x = R() * W, y = R() * maxY, z = R();
    g.fillStyle = `rgba(255,255,255,${0.25 + z * 0.65})`;
    g.beginPath(); g.arc(x, y, 0.5 + z * 1.4, 0, Math.PI * 2); g.fill();
    if (z > 0.93) { g.fillRect(x - 4, y - 0.5, 8, 1); g.fillRect(x - 0.5, y - 4, 1, 8); }
  }
};
/** A ridge of hills/treeline across the width, filled down to the bottom. */
const ridge = (g, R, W, H, baseY, amp, color, trees = 0) => {
  g.fillStyle = color;
  g.beginPath(); g.moveTo(0, H);
  const step = W / 28, ph = R() * 9;
  for (let x = 0; x <= W + step; x += step) {
    const y = baseY - (Math.sin(x * 0.011 + ph) * 0.5 + Math.sin(x * 0.027 + ph * 2) * 0.3 + 0.5) * amp;
    g.lineTo(x, y);
    if (trees && R() < trees) { const h = amp * (0.5 + R() * 0.9), w = h * 0.36; g.lineTo(x + w * 0.2, y); g.lineTo(x + w * 0.5, y - h); g.lineTo(x + w * 0.8, y); }
  }
  g.lineTo(W, H); g.closePath(); g.fill();
};

const SCENES = {
  /** Toy Box: soft out-of-focus lights and a stack of building blocks in the corners. */
  playroom(g, T, W, H, s, R) {
    const cols = ['#ff8a5c', '#4cc9f0', '#ffd23f', '#c77dff', '#3ddc84'];
    for (let k = 0; k < 16; k++) blob(g, R() * W, R() * H, s * (1 + R() * 2.4), cols[k % cols.length], 0.1 + R() * 0.08);
    for (const side of [0, 1]) for (let k = 0; k < 4; k++) {
      const b = s * (0.9 + R() * 0.5), x = side ? W - b * (0.9 + (k % 2) * 0.7) : b * ((k % 2) * 0.7 - 0.1), y = H - b * (0.55 + k * 0.8);
      g.save(); g.translate(x + b / 2, y + b / 2); g.rotate((R() - 0.5) * 0.35); g.globalAlpha = 0.34;
      g.fillStyle = cols[(k + side * 2) % cols.length]; g.fillRect(-b / 2, -b / 2, b, b);
      g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(-b / 2, -b / 2, b, b * 0.16);
      g.fillStyle = 'rgba(0,0,0,0.28)'; g.fillRect(-b / 2, b * 0.34, b, b * 0.16);
      g.restore();
    }
  },
  /** Deep End: sun rays from the surface, rising bubbles, seaweed and coral on the seabed. */
  reef(g, T, W, H, s, R) {
    for (let k = 0; k < 7; k++) {
      const x = W * (0.05 + R() * 0.9), w = s * (0.5 + R() * 1.3), lean = (R() - 0.3) * W * 0.35;
      const gr = g.createLinearGradient(0, 0, 0, H * 0.85);
      gr.addColorStop(0, 'rgba(190,245,255,0.20)'); gr.addColorStop(1, 'rgba(190,245,255,0)');
      g.fillStyle = gr;
      g.beginPath(); g.moveTo(x - w * 0.3, 0); g.lineTo(x + w * 0.3, 0); g.lineTo(x + lean + w * 1.6, H * 0.85); g.lineTo(x + lean - w * 1.6, H * 0.85); g.closePath(); g.fill();
    }
    ridge(g, R, W, H, H * 0.97, s * 0.9, 'rgba(3,30,48,0.75)');
    for (let k = 0; k < 16; k++) { // seaweed
      const x = R() * W, h = s * (1.2 + R() * 2.6);
      g.strokeStyle = `rgba(${20 + R() * 30},${120 + R() * 60},${110 + R() * 30},0.5)`; g.lineWidth = s * (0.1 + R() * 0.1); g.lineCap = 'round';
      g.beginPath(); g.moveTo(x, H);
      g.bezierCurveTo(x - s * 0.5, H - h * 0.35, x + s * 0.5, H - h * 0.65, x + (R() - 0.5) * s * 0.6, H - h); g.stroke();
    }
    for (let k = 0; k < 5; k++) { // coral fans
      const x = R() * W, col = ['#ff6b9a', '#ff9f43', '#c77dff'][k % 3];
      for (let q = 0; q < 6; q++) { const a = -Math.PI / 2 + (q - 2.5) * 0.3, l = s * (0.7 + R() * 0.7); g.strokeStyle = rgba(col, 0.45); g.lineWidth = s * 0.12; g.beginPath(); g.moveTo(x, H); g.lineTo(x + Math.cos(a) * l, H + Math.sin(a) * l); g.stroke(); }
    }
    for (let k = 0; k < 34; k++) { // bubbles
      const x = R() * W, y = R() * H, r = s * (0.05 + R() * 0.16);
      g.strokeStyle = 'rgba(220,250,255,0.4)'; g.lineWidth = 1.2; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.5)'; g.beginPath(); g.arc(x - r * 0.35, y - r * 0.35, r * 0.22, 0, Math.PI * 2); g.fill();
    }
  },
  /** Long Shot: a low sun cut by cloud bands, stars above, mountain ridges below. */
  dusk(g, T, W, H, s, R) {
    stars(g, R, W, H, 60, H * 0.4);
    const sx = W * 0.5, sy = H * 0.6, sr = Math.min(W, H) * 0.26;
    blob(g, sx, sy, sr * 2.6, '#ffb36b', 0.5);
    const sun = g.createLinearGradient(0, sy - sr, 0, sy + sr);
    sun.addColorStop(0, '#fff2b0'); sun.addColorStop(0.55, '#ff9a5a'); sun.addColorStop(1, '#ff4f8b');
    g.save(); g.beginPath(); g.arc(sx, sy, sr, 0, Math.PI * 2); g.clip();
    g.fillStyle = sun; g.globalAlpha = 0.85; g.fillRect(sx - sr, sy - sr, sr * 2, sr * 2);
    g.globalCompositeOperation = 'destination-out'; g.globalAlpha = 1;
    for (let k = 0; k < 6; k++) g.fillRect(sx - sr, sy + sr * (0.02 + k * 0.17), sr * 2, sr * (0.03 + k * 0.016));
    g.restore();
    ridge(g, R, W, H, H * 0.8, s * 2.2, 'rgba(92,36,104,0.75)');
    ridge(g, R, W, H, H * 0.9, s * 1.7, 'rgba(58,22,80,0.85)');
    ridge(g, R, W, H, H * 0.99, s * 1.2, 'rgba(30,10,48,0.95)');
  },
  /** Hourglass: candy stripes, giant lollipop swirls and sprinkles. */
  sweets(g, T, W, H, s, R) {
    g.save(); g.rotate(-0.5); g.fillStyle = 'rgba(255,255,255,0.05)';
    for (let x = -H; x < W + H; x += s * 1.6) g.fillRect(x, -W, s * 0.8, (W + H) * 2);
    g.restore();
    for (const [cx, cy, rr, col] of [[W * 0.08, H * 0.2, s * 2.3, '#ff9ecb'], [W * 0.95, H * 0.5, s * 2.8, '#ffd166'], [W * 0.1, H * 0.86, s * 2, '#9bf6ff']]) {
      g.save(); g.translate(cx, cy); g.globalAlpha = 0.3;
      g.fillStyle = '#ffffff'; g.beginPath(); g.arc(0, 0, rr, 0, Math.PI * 2); g.fill();
      g.fillStyle = col;
      for (let k = 0; k < 8; k += 2) { // swirl wedges
        g.beginPath(); g.moveTo(0, 0);
        for (let u = 0; u <= 1.001; u += 0.1) { const a = (k * Math.PI) / 4 + u * 1.6, d = rr * u; g.lineTo(Math.cos(a) * d, Math.sin(a) * d); }
        for (let u = 1; u >= -0.001; u -= 0.1) { const a = ((k + 1) * Math.PI) / 4 + u * 1.6, d = rr * u; g.lineTo(Math.cos(a) * d, Math.sin(a) * d); }
        g.closePath(); g.fill();
      }
      g.restore();
    }
    const cols = ['#ffd166', '#9bf6ff', '#caffbf', '#ffadad', '#ffffff'];
    for (let k = 0; k < 70; k++) {
      g.save(); g.translate(R() * W, R() * H); g.rotate(R() * Math.PI); g.globalAlpha = 0.4;
      g.fillStyle = cols[k % cols.length]; g.beginPath(); g.roundRect?.(-s * 0.13, -s * 0.04, s * 0.26, s * 0.08, s * 0.04); g.fill();
      g.restore();
    }
  },
  /** Slope: retro-future grid running to a glowing horizon with a banded sun. */
  synth(g, T, W, H, s, R) {
    stars(g, R, W, H, 70, H * 0.5);
    const hy = H * 0.62, sx = W * 0.62, sr = Math.min(W, H) * 0.2;
    blob(g, sx, hy, sr * 2.4, '#ff2e97', 0.4);
    const sun = g.createLinearGradient(0, hy - sr, 0, hy);
    sun.addColorStop(0, '#ffe66d'); sun.addColorStop(1, '#ff2e97');
    g.save(); g.beginPath(); g.rect(0, 0, W, hy); g.clip();
    g.fillStyle = sun; g.globalAlpha = 0.8; g.beginPath(); g.arc(sx, hy, sr, 0, Math.PI * 2); g.fill();
    g.globalCompositeOperation = 'destination-out'; g.globalAlpha = 1;
    for (let k = 0; k < 5; k++) g.fillRect(sx - sr, hy - sr * (0.12 + k * 0.17), sr * 2, sr * (0.07 - k * 0.01));
    g.restore();
    const floor = g.createLinearGradient(0, hy, 0, H);
    floor.addColorStop(0, 'rgba(60,10,90,0.9)'); floor.addColorStop(1, 'rgba(8,2,24,0.9)');
    g.fillStyle = floor; g.fillRect(0, hy, W, H - hy);
    g.strokeStyle = 'rgba(125,249,255,0.5)'; g.lineWidth = 1.2;
    g.beginPath();
    for (let k = -14; k <= 14; k++) { g.moveTo(W / 2 + k * s * 0.35, hy); g.lineTo(W / 2 + k * s * 3.2, H); }
    for (let k = 0; k < 9; k++) { const y = hy + (H - hy) * Math.pow(k / 9, 2.2); g.moveTo(0, y); g.lineTo(W, y); }
    g.stroke();
    g.strokeStyle = 'rgba(255,46,151,0.9)'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, hy); g.lineTo(W, hy); g.stroke();
  },
  /** Pocket: moonlit pine forest in layers, with fireflies. */
  woods(g, T, W, H, s, R) {
    blob(g, W * 0.76, H * 0.16, s * 4.5, '#e8f5c8', 0.35);
    g.fillStyle = 'rgba(244,250,220,0.85)'; g.beginPath(); g.arc(W * 0.76, H * 0.16, s * 0.75, 0, Math.PI * 2); g.fill();
    stars(g, R, W, H, 30, H * 0.35);
    ridge(g, R, W, H, H * 0.66, s * 1.6, 'rgba(34,92,64,0.65)', 0.55);
    ridge(g, R, W, H, H * 0.8, s * 1.9, 'rgba(20,66,44,0.8)', 0.6);
    ridge(g, R, W, H, H * 0.94, s * 2.2, 'rgba(8,36,24,0.92)', 0.65);
    for (let k = 0; k < 26; k++) blob(g, R() * W, H * (0.3 + R() * 0.65), s * (0.12 + R() * 0.2), '#f6ff8f', 0.75);
  },
  /** Split: nebula clouds, a dense starfield and a ringed planet. */
  cosmos(g, T, W, H, s, R) {
    for (const col of ['#7b2ff7', '#2f6bff', '#f72585', '#2ec4b6']) for (let k = 0; k < 3; k++) blob(g, R() * W, R() * H, s * (2.5 + R() * 3.5), col, 0.16);
    stars(g, R, W, H, 150);
    const px = W * 0.16, py = H * 0.2, pr = s * 1.25;
    const pg = g.createRadialGradient(px - pr * 0.4, py - pr * 0.4, pr * 0.1, px, py, pr);
    pg.addColorStop(0, '#ffd6a5'); pg.addColorStop(0.6, '#e07a5f'); pg.addColorStop(1, '#3d1f3f');
    g.globalAlpha = 0.85; g.fillStyle = pg; g.beginPath(); g.arc(px, py, pr, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(255,230,200,0.7)'; g.lineWidth = s * 0.14;
    g.beginPath(); g.ellipse(px, py, pr * 1.9, pr * 0.45, -0.35, 0.15, Math.PI - 0.15); g.stroke();
    g.globalAlpha = 1;
    blob(g, W * 0.85, H * 0.8, s * 1.1, '#bde0fe', 0.5);
  },
};

/**
 * Paint a board background. An image (theme.image, already loaded) wins over the painted scene.
 * A soft dark panel behind the peg field and a vignette keep balls and pegs readable.
 */
export function paintBackground(g, T, W, H, s, image) {
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, T.bgTop); bg.addColorStop(1, T.bgBottom);
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  if (image) {
    const k = Math.max(W / image.width, H / image.height);
    g.drawImage(image, (W - image.width * k) / 2, (H - image.height * k) / 2, image.width * k, image.height * k);
    g.fillStyle = `rgba(0,0,0,${T.imageDim ?? 0.3})`; g.fillRect(0, 0, W, H);
  } else if (SCENES[T.scene]) {
    g.save();
    SCENES[T.scene](g, T, W, H, s, rnd(T.scene.length * 7919 + 17));
    g.restore();
    g.fillStyle = rgba(T.bgBottom, 0.28); g.fillRect(0, 0, W, H); // push the scene back
  }
  const v = g.createRadialGradient(W / 2, H * 0.5, Math.min(W, H) * 0.35, W / 2, H * 0.5, Math.max(W, H) * 0.75);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.45)');
  g.fillStyle = v; g.fillRect(0, 0, W, H);
}

// ---------------------------------------------------------------------------
// "Framed" board style: art lives only outside a solid, framed play field.

const rr = (g, x, y, w, h, r) => { g.beginPath(); g.roundRect(x, y, w, h, r); };

/** Toy room: shelves with toys in the upper corners, bunting, soft lamps. u = a size unit in px. */
function toyRoom(g, W, H, u) {
  const bg = g.createRadialGradient(W / 2, H * 0.1, u, W / 2, H * 0.35, Math.max(W, H) * 0.9);
  bg.addColorStop(0, '#5a43c9'); bg.addColorStop(0.5, '#34238f'); bg.addColorStop(1, '#170f4d');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  // big soft arches for depth
  g.fillStyle = 'rgba(20,12,70,0.35)';
  g.beginPath(); g.arc(W * 0.02, H * 0.2, W * 0.42, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(W * 0.98, H * 0.24, W * 0.4, 0, Math.PI * 2); g.fill();

  const shelf = (x, y, w) => {
    blob(g, x + w / 2, y + u * 0.75, u * 1.5, '#ffb347', 0.5);                      // lamp glow under the shelf
    const sg = g.createLinearGradient(0, y, 0, y + u * 0.5);
    sg.addColorStop(0, '#8f76ff'); sg.addColorStop(0.25, '#6a50d8'); sg.addColorStop(1, '#3d2a99');
    g.fillStyle = 'rgba(0,0,0,0.3)'; rr(g, x + 2, y + 4, w, u * 0.5, u * 0.22); g.fill();
    g.fillStyle = sg; rr(g, x, y, w, u * 0.5, u * 0.22); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.3)'; rr(g, x + u * 0.15, y + u * 0.05, w - u * 0.3, u * 0.08, u * 0.04); g.fill();
    g.fillStyle = '#ffd98a'; g.beginPath(); g.ellipse(x + w / 2, y + u * 0.5, u * 0.3, u * 0.07, 0, 0, Math.PI * 2); g.fill();
  };
  const block = (x, y, b, col) => { // x,y = bottom-left on the shelf
    const bgd = g.createLinearGradient(x, y - b, x + b, y);
    bgd.addColorStop(0, shade(col, 0.35)); bgd.addColorStop(1, shade(col, -0.3));
    g.fillStyle = 'rgba(0,0,0,0.3)'; rr(g, x + 2, y - b + 3, b, b, b * 0.16); g.fill();
    g.fillStyle = bgd; rr(g, x, y - b, b, b, b * 0.16); g.fill();
    g.strokeStyle = shade(col, 0.55); g.lineWidth = b * 0.06; rr(g, x + b * 0.1, y - b * 0.9, b * 0.8, b * 0.8, b * 0.1); g.stroke();
    g.fillStyle = shade(col, -0.35); g.beginPath(); pegPath(g, 'star', x + b / 2, y - b / 2, b * 0.17); g.fill();
  };
  const star = (x, y, r) => {
    blob(g, x, y, r * 2.4, '#ffe66d', 0.6);
    const sgd = g.createRadialGradient(x - r * 0.3, y - r * 0.4, r * 0.1, x, y, r * 1.5);
    sgd.addColorStop(0, '#fffbe0'); sgd.addColorStop(0.5, '#ffd23f'); sgd.addColorStop(1, '#e08a00');
    g.fillStyle = sgd; g.lineJoin = 'round'; g.strokeStyle = sgd; g.lineWidth = r * 0.5;
    g.beginPath(); pegPath(g, 'star', x, y, r * 0.62); g.fill(); g.stroke();
  };
  const rings = (x, y, w) => { // stacking rings, base at (x, y)
    const cols = ['#ff5d73', '#ffb347', '#ffe66d', '#5ad1a0', '#4aa8ff'];
    cols.forEach((c, k) => {
      const rw = w * (1 - k * 0.15), ry = y - w * 0.16 - k * w * 0.26;
      g.fillStyle = shade(c, -0.3); g.beginPath(); g.ellipse(x, ry + w * 0.05, rw / 2, w * 0.15, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = c; g.beginPath(); g.ellipse(x, ry, rw / 2, w * 0.15, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.45)'; g.beginPath(); g.ellipse(x - rw * 0.18, ry - w * 0.05, rw * 0.2, w * 0.04, 0, 0, Math.PI * 2); g.fill();
    });
  };
  const rocket = (x, y, h) => { // base centre at (x, y)
    const w = h * 0.42;
    g.fillStyle = '#ff5d73';
    for (const d of [-1, 1]) { g.beginPath(); g.moveTo(x + d * w * 0.3, y - h * 0.35); g.lineTo(x + d * w * 0.95, y); g.lineTo(x + d * w * 0.25, y - h * 0.05); g.closePath(); g.fill(); }
    const body = g.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
    body.addColorStop(0, '#ffffff'); body.addColorStop(0.6, '#e6e9ff'); body.addColorStop(1, '#a9aee0');
    g.fillStyle = body;
    g.beginPath(); g.moveTo(x - w / 2, y - h * 0.05); g.quadraticCurveTo(x - w / 2, y - h * 0.7, x, y - h); g.quadraticCurveTo(x + w / 2, y - h * 0.7, x + w / 2, y - h * 0.05); g.closePath(); g.fill();
    g.save(); g.clip(); g.fillStyle = '#ff5d73'; g.fillRect(x - w, y - h, w * 2, h * 0.24); g.restore();
    g.fillStyle = '#2b3a8f'; g.beginPath(); g.arc(x, y - h * 0.52, w * 0.26, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#6cc7ff'; g.beginPath(); g.arc(x, y - h * 0.52, w * 0.18, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.7)'; g.beginPath(); g.arc(x - w * 0.06, y - h * 0.56, w * 0.06, 0, Math.PI * 2); g.fill();
  };
  const ball = (x, y, r, col) => {
    const bgd = g.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
    bgd.addColorStop(0, '#ffffff'); bgd.addColorStop(0.35, col); bgd.addColorStop(1, shade(col, -0.45));
    g.fillStyle = bgd; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = r * 0.22; g.beginPath(); g.arc(x, y, r * 0.62, -0.5, 1.2); g.stroke();
  };

  const sw = Math.min(W * 0.3, u * 3.4);
  // left corner
  shelf(-u * 0.3, H * 0.27, sw);
  block(u * 0.1, H * 0.27, u * 1.05, '#ff8a5c');
  star(u * 1.75, H * 0.27 - u * 0.5, u * 0.42);
  ball(u * 0.75, H * 0.27 - u * 1.4, u * 0.36, '#4aa8ff');
  shelf(-u * 0.3, H * 0.44, sw * 0.62);
  block(u * 0.05, H * 0.44, u * 0.8, '#ffc93c');
  // right corner
  shelf(W - sw + u * 0.3, H * 0.25, sw);
  rocket(W - u * 1.05, H * 0.25, u * 1.9);
  rings(W - u * 2.15, H * 0.25, u * 0.8);
  shelf(W - sw * 0.62 + u * 0.3, H * 0.42, sw * 0.62);
  block(W - u * 0.95, H * 0.42, u * 0.9, '#ffb347');
  // bunting across the top right
  const flags = ['#ffb347', '#7b5cff', '#ff5d9e', '#4fd6c8', '#ffe66d'];
  g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(W * 0.66, 0); g.quadraticCurveTo(W * 0.8, u * 1.5, W + u * 0.2, u * 1.0); g.stroke();
  flags.forEach((c, k) => {
    const t = (k + 0.6) / flags.length, x = (1 - t) * (1 - t) * W * 0.66 + 2 * (1 - t) * t * W * 0.8 + t * t * (W + u * 0.2), y = 2 * (1 - t) * t * u * 1.5 + t * t * u * 1.0;
    g.fillStyle = c; g.beginPath(); g.moveTo(x - u * 0.28, y - u * 0.05); g.lineTo(x + u * 0.28, y + u * 0.05); g.lineTo(x - u * 0.02, y + u * 0.75); g.closePath(); g.fill();
  });
}
const ROOMS = { playroom: toyRoom };

/**
 * Framed board: room art, then a solid play field shaped like the peg triangle with a tray
 * for the buckets, inside a thick glowing frame.
 * F (px): { topY, topHalf, cx, sideY, sideHalf, trayTop, trayBottom, trayHalf, u }
 */
export function paintFramedBoard(g, T, W, H, F, image) {
  if (image) { // painted room: full width, pinned to the top; the wall colour carries on below it
    const k = W / image.width, ih = image.height * k;
    g.fillStyle = T.roomFloor || '#1a1450'; g.fillRect(0, 0, W, H);
    g.drawImage(image, 0, 0, W, ih);
    if (ih < H) { const fade = g.createLinearGradient(0, ih - F.u * 2, 0, ih); fade.addColorStop(0, rgba(T.roomFloor || '#1a1450', 0)); fade.addColorStop(1, T.roomFloor || '#1a1450'); g.fillStyle = fade; g.fillRect(0, ih - F.u * 2, W, F.u * 2 + 1); }
  } else (ROOMS[T.scene] || toyRoom)(g, W, H, F.u);
  const c = F.cx, r = F.u * 0.55;
  const sL = F.sideL ?? F.sideHalf, sR = F.sideR ?? F.sideHalf, tL = F.trayL ?? F.trayHalf, tR = F.trayR ?? F.trayHalf;
  const field = () => {
    g.beginPath();
    g.moveTo(c - F.topHalf + r, F.topY);
    g.lineTo(c + F.topHalf - r, F.topY);
    g.quadraticCurveTo(c + F.topHalf, F.topY, c + F.topHalf + r * 0.5, F.topY + r * 0.9);
    g.lineTo(c + sR, F.sideY);
    g.lineTo(c + tR, F.trayTop);
    g.arcTo(c + tR, F.trayBottom, c + tR - r, F.trayBottom, r);
    g.lineTo(c - tL + r, F.trayBottom);
    g.arcTo(c - tL, F.trayBottom, c - tL, F.trayBottom - r, r);
    g.lineTo(c - tL, F.trayTop);
    g.lineTo(c - sL, F.sideY);
    g.lineTo(c - F.topHalf - r * 0.5, F.topY + r * 0.9);
    g.quadraticCurveTo(c - F.topHalf, F.topY, c - F.topHalf + r, F.topY);
    g.closePath();
  };
  g.lineJoin = 'round';
  // outer glow + drop shadow
  g.save(); g.shadowColor = rgba(T.frame, 0.9); g.shadowBlur = F.u * 0.9; g.strokeStyle = T.frame; g.lineWidth = F.u * 0.5; field(); g.stroke(); g.restore();
  // solid field
  const fg = g.createLinearGradient(0, F.topY, 0, F.trayBottom);
  fg.addColorStop(0, T.field); fg.addColorStop(1, shade(T.field, -0.25));
  g.fillStyle = fg; field(); g.fill();
  // frame: dark base, body, pale inner edge
  g.strokeStyle = shade(T.frame, -0.55); g.lineWidth = F.u * 0.56; field(); g.stroke();
  const fr = g.createLinearGradient(0, F.topY, 0, F.trayBottom);
  fr.addColorStop(0, shade(T.frame, 0.45)); fr.addColorStop(0.5, T.frame); fr.addColorStop(1, shade(T.frame, -0.25));
  g.strokeStyle = fr; g.lineWidth = F.u * 0.4; field(); g.stroke();
  g.strokeStyle = rgba('#ffffff', 0.55); g.lineWidth = F.u * 0.06; field(); g.stroke();
  // warm glints along the frame
  for (const [x, y] of [[c - (F.topHalf + sL) / 2 - r * 0.2, (F.topY + F.sideY) / 2], [c + (F.topHalf + sR) / 2 + r * 0.2, (F.topY + F.sideY) / 2], [c + (tR - tL) / 2, F.trayBottom], [c - tL * 0.7, F.trayBottom], [c + tR * 0.7, F.trayBottom]]) blob(g, x, y, F.u * 0.55, T.glint || '#ffb347', 0.7);
  if (T.bolts) for (const d of [-1, 1]) { // rivets in the tray's bottom corners
    const bx = c + d * ((d < 0 ? tL : tR) - r * 1.5), by = F.trayBottom, br = F.u * 0.13;
    g.fillStyle = shade(T.frame, -0.5); g.beginPath(); g.arc(bx, by, br, 0, Math.PI * 2); g.fill();
    g.fillStyle = shade(T.frame, 0.5); g.beginPath(); g.arc(bx - br * 0.2, by - br * 0.2, br * 0.6, 0, Math.PI * 2); g.fill();
  }
  // inner shadow at the top of the field so the frame reads as raised
  g.save(); field(); g.clip();
  const ins = g.createLinearGradient(0, F.topY, 0, F.topY + F.u * 1.2);
  ins.addColorStop(0, 'rgba(0,0,0,0.35)'); ins.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = ins; g.fillRect(0, F.topY, W, F.u * 1.2);
  g.restore();
}

/** Flat glossy bucket tile (framed style). */
export function drawTile(g, cx, top, w, h, color, label, fontPx, font, lit) {
  const x = cx - w / 2, rad = Math.min(w, h) * 0.24, lip = h * 0.1;
  g.fillStyle = shade(color, -0.45); rr(g, x, top + lip, w, h, rad); g.fill();          // lower edge
  const tg = g.createLinearGradient(0, top, 0, top + h);
  tg.addColorStop(0, shade(color, 0.3)); tg.addColorStop(0.55, color); tg.addColorStop(1, shade(color, -0.12));
  if (lit) { g.save(); g.shadowColor = color; g.shadowBlur = w * 0.5; }
  g.fillStyle = tg; rr(g, x, top, w, h, rad); g.fill();
  if (lit) g.restore();
  g.fillStyle = 'rgba(255,255,255,0.32)'; rr(g, x + w * 0.08, top + h * 0.07, w * 0.84, h * 0.3, rad * 0.7); g.fill(); // gloss
  g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = Math.max(1, w * 0.035); rr(g, x + 0.5, top + 0.5, w - 1, h - 1, rad); g.stroke();
  g.font = `700 ${fontPx}px ${font}`;
  const lw = g.measureText(label).width;
  if (lw > w * 0.84) g.font = `700 ${Math.max(6, fontPx * (w * 0.84) / lw)}px ${font}`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = shade(color, -0.72);
  g.fillText(label, cx, top + h * 0.56);
}

/** Bucket drawn from a cup image (framed style), with the multiplier across its body. */
export function drawCup(g, img, cx, top, w, h, label, fontPx, font, lit, color) {
  const cw = w * 1.06, ch = Math.min(h * 1.12, cw * img.height / img.width);
  if (lit) { g.save(); g.shadowColor = color; g.shadowBlur = w * 0.55; }
  g.drawImage(img, cx - cw / 2, top - h * 0.1, cw, ch);
  if (lit) g.restore();
  g.font = `800 ${fontPx}px ${font}`;
  const lw = g.measureText(label).width;
  if (lw > w * 0.8) g.font = `800 ${Math.max(6, fontPx * (w * 0.8) / lw)}px ${font}`;
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
  const ty = top - h * 0.1 + ch * 0.6;
  g.lineWidth = Math.max(2, fontPx * 0.28); g.strokeStyle = shade(color, -0.68); g.strokeText(label, cx, ty);
  g.fillStyle = lit ? '#fff6d0' : '#ffffff'; g.fillText(label, cx, ty);
}
