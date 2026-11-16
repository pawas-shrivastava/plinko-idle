import { createAudio } from './audio.js';
import { Game } from './game/game.js';
import { Renderer, bucketColors, drawBallSprite } from './game/renderer.js';
import { configureFormat, fmt } from './core/format.js';
import { applyBoardAction, multipliersFor } from './core/economy.js';
import { createAnalytics } from './analytics.js';

const config = await (await fetch('config.json', { cache: 'no-store' })).json();
configureFormat(config.format);

// URL params for review/testing: ?seed=123&board=2&coins=1000&warp=30&ball=steel&tab=balls&measured
const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed')) || config.rng.defaultSeed;
const boardIndex = Math.max(0, Math.min(config.boards.length - 1, (Number(params.get('board')) || 1) - 1));

const game = new Game(config, { seed, boardIndex, unlockAll: params.has('unlockAll') });

// ---------- Save / load ----------
// Any testing parameter (?board, ?coins, ?unlockAll, ?demo, ...) makes this a sandbox session:
// nothing is loaded or saved, so tests never touch real progress. ?reset wipes the save.
const SAVE = config.save;
const sandbox = [...params.keys()].some((k) => !['seed', 'tab', 'measured', 'reset'].includes(k));
const store = { get() { try { return JSON.parse(localStorage.getItem(SAVE.key)); } catch { return null; } }, set(v) { try { localStorage.setItem(SAVE.key, JSON.stringify(v)); } catch { /* storage full or blocked */ } } };
if (params.has('reset')) { try { localStorage.removeItem(SAVE.key); } catch { /* ignore */ } }
let welcome = null; // { amount, sec } earned while away, shown once the UI is up
if (!sandbox) {
  const saved = store.get();
  if (saved && game.restore(saved)) welcome = game.offlineEarn((Date.now() - saved.savedAt) / 1000);
}
const save = () => { if (!sandbox) store.set(game.serialize()); };

// ---------- Analytics (off in sandbox sessions) ----------
const analytics = createAnalytics(config.analytics, { enabled: !sandbox });
window.plinkoAnalytics = analytics;
const snap = () => ({ board: game.board.id, coins: Math.round(game.state.coins), perSec: Math.round(game.income.perSec), ftue: game.state.ftue });
analytics.startSession(welcome?.sec || 0);
for (const evt of ['purchase', 'milestone', 'board_complete', 'board_change', 'piece_placed', 'equip', 'frenzy', 'ftue_step', 'jackpot']) {
  game.on(evt, (e) => analytics.track(evt, { ...(e && typeof e === 'object' ? { ...e, next: e.next?.id } : {}), board: game.board.id }));
}
setInterval(() => analytics.flush(), config.analytics.flushEverySec * 1000);
if (params.has('coins')) game.state.coins = Number(params.get('coins'));
if (params.has('ball')) game.equip(params.get('ball'));
for (const key of Object.keys(config.workshop)) {
  if (params.has(key)) { game.state.workshop[key] = Number(params.get(key)); game.rebuild(); }
}
/** Testing helper: raise a board piece to a level through the normal purchase path (free). */
function setPiece(id, level) {
  while (game.state.boardUp.pieces[id] < level) game.state.boardUp = applyBoardAction(config, game.state, { kind: 'piece', id }).boardUp;
}
// ?demo: fill this board's sockets and pieces so every board feature is visible.
if (params.has('demo')) {
  const b = game.board, up = game.state.boardUp, T = config.boardTree;
  const types = params.has('unlockAll') ? Object.keys(T.pegs) : b.pegTypes;
  b.sockets.forEach((_, i) => { up.sockets[i] = { type: types[i % types.length], level: 3 }; });
  for (const id of (params.has('unlockAll') ? Object.keys(T.pieces) : b.pieces)) setPiece(id, Math.min(2, T.pieces[id].maxLevel));
  game.rebuild();
}
// ?droppers=3 sets the number of droppers (testing).
if (params.has('droppers')) { game.state.boardUp.droppers = Math.max(0, Number(params.get('droppers')) - 1); game.rebuild(); }
// ?pieces=lids:2,autoFlip:2 sets board-piece levels directly (testing).
if (params.get('pieces')) {
  for (const kv of params.get('pieces').split(',')) {
    const [id, lv] = kv.split(':');
    if (id in game.state.boardUp.pieces) setPiece(id, Number(lv));
  }
  game.rebuild();
}
window.game = game; // console access while prototyping
// ?place=lid0 | trampoline | magnet opens placement mode straight away (testing).
const openPlace = params.get('place');

// ?warp=N: fast-forward N seconds of simulation (fixed 60Hz steps) before the first frame.
if (params.has('warp')) {
  const steps = Math.round(Number(params.get('warp')) * 60);
  for (let i = 0; i < steps; i++) game.update(1 / 60);
}

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const renderer = new Renderer($('cv'), config);
renderer.showMeasured = params.has('measured');

new ResizeObserver(() => renderer.resize(stage.clientWidth, stage.clientHeight)).observe(stage);
renderer.resize(stage.clientWidth, stage.clientHeight);

const num = (v) => fmt(v, { decimals: true });
const signedPct = (p) => `${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(0)}%`;
const dpr = () => Math.min(window.devicePixelRatio || 1, config.layout.maxDevicePixelRatio);

// ---------- Tabs ----------
function showTab(name) {
  if (name === 'board') document.querySelector('.tab[data-page="board"]').classList.remove('ping');
  for (const t of document.querySelectorAll('.tab[data-page]')) t.classList.toggle('active', t.dataset.page === name);
  for (const p of document.querySelectorAll('.page')) p.hidden = p.id !== `page-${name}`;
  if (name === 'balls') refreshBallCards();
  if (name === 'board') renderBoardTab();
}
for (const t of document.querySelectorAll('.tab[data-page]')) t.addEventListener('click', () => showTab(t.dataset.page));

// ---------- Workshop cards ----------
const keys = Object.keys(config.workshop);
const cards = {};
for (const key of keys) {
  const el = document.createElement('button');
  el.className = 'upg';
  el.innerHTML = `
    <div class="upg-fill"></div>
    <div class="upg-top"><span class="upg-name"></span><span class="upg-lv"></span></div>
    <div class="upg-effect"></div>
    <div class="upg-gain"></div>
    <div class="upg-cost"><span class="coin-icon"></span><span class="c"></span></div>`;
  el.addEventListener('click', () => { if (game.buy(key)) refreshCards(); });
  $('upgrades').appendChild(el);
  cards[key] = {
    el,
    name: el.querySelector('.upg-name'), lv: el.querySelector('.upg-lv'),
    effect: el.querySelector('.upg-effect'), gain: el.querySelector('.upg-gain'),
    cost: el.querySelector('.upg-cost .c'), coin: el.querySelector('.upg-cost .coin-icon'),
    fill: el.querySelector('.upg-fill'),
  };
}

function refreshCards() {
  for (const key of keys) {
    const c = cards[key], info = game.workshopInfo(key);
    c.name.textContent = info.item.name;
    c.lv.textContent = `Lv ${info.level}`;
    const val = (v) => (info.item.labels ? info.item.labels[Math.min(v, info.item.labels.length - 1)] : num(v));
    c.effect.innerHTML = info.maxed
      ? `<b>${val(info.now)}</b> ${info.item.unit}`
      : `<b>${val(info.now)} → ${val(info.next)}</b> ${info.item.unit}`;
    c.el.classList.toggle('locked', info.locked);
    c.coin.style.display = info.locked || info.maxed ? 'none' : '';
    if (info.locked) {
      c.gain.textContent = info.item.lockedText;
      c.cost.textContent = '🔒 Locked';
      c.el.classList.remove('cant');
      c.fill.style.width = '0';
      continue;
    }
    c.gain.textContent = info.maxed ? 'MAX' : `${gainAbs(info.preview)}/s`;
    c.cost.textContent = info.maxed ? 'MAX' : fmt(info.cost);
    const can = !info.maxed && game.state.coins >= info.cost;
    c.el.classList.toggle('cant', !can);
    c.el.classList.toggle('maxed', info.maxed);
    c.fill.style.width = info.maxed ? '100%' : `${Math.min(100, (game.state.coins / info.cost) * 100)}%`;
  }
}

// ---------- Ball cards (collection + landing preview) ----------
const ballCards = {};
for (const t of config.ballTypes) {
  const el = document.createElement('div');
  el.className = 'bcard';
  const rar = config.rarities[t.rarity];
  el.innerHTML = `
    <div class="bhead">
      <canvas class="bswatch"></canvas>
      <div><div class="bname">${t.name}</div><div class="brar" style="color:${rar.color}">${rar.label}</div></div>
    </div>
    <div class="bblurb">${t.blurb}</div>
    <div class="bchips"></div>
    <canvas class="bhist"></canvas>
    <div class="bstats"><span class="bjack"></span><span class="bgain"></span></div>
    <button class="bbtn">Equip</button>`;
  const sw = el.querySelector('.bswatch');
  const d = dpr();
  sw.width = sw.height = Math.round(26 * d);
  drawBallSprite(sw.getContext('2d'), sw.width / 2, sw.width / 2 - 1, t.colors, t.skin);
  el.querySelector('.bbtn').addEventListener('click', () => { game.equip(t.id); });
  $('ballList').appendChild(el);
  ballCards[t.id] = {
    el, chips: el.querySelector('.bchips'), hist: el.querySelector('.bhist'),
    jack: el.querySelector('.bjack'), gain: el.querySelector('.bgain'), btn: el.querySelector('.bbtn'),
  };
}

function traitChips(t) {
  const sp = config.distribution.spreads[t.spread];
  const chips = [`<span class="chip">${sp.label}</span>`];
  if (t.valueBonus) chips.push(`<span class="chip ${t.valueBonus > 0 ? 'pos' : 'neg'}">${signedPct(t.valueBonus * 100)} value</span>`);
  if (t.luckBonus) chips.push(`<span class="chip ${t.luckBonus > 0 ? 'pos' : 'neg'}">${t.luckBonus > 0 ? '+' : '−'}${Math.abs(t.luckBonus)} luck</span>`);
  if (t.trait) {
    const tr = config.traits[t.trait];
    const desc = tr.desc.replace('{chance}', Math.round((tr.chance ?? 0) * 100)).replace('{mul}', tr.payoutMul ?? '');
    chips.push(`<span class="chip trait${tr.active ? '' : ' off'}" title="${tr.active ? '' : tr.inactiveText}">★ ${tr.name}: ${desc}</span>`);
  }
  return chips.join('');
}

/** Mini landing histogram: bars for this ball, ticks for the equipped one. sqrt scale so edges show. */
function drawHist(canvas, probs, equippedProbs, colors, isEquipped) {
  const d = dpr();
  const w = canvas.clientWidth || 134, h = canvas.clientHeight || 40;
  if (canvas.width !== Math.round(w * d)) { canvas.width = Math.round(w * d); canvas.height = Math.round(h * d); }
  const g = canvas.getContext('2d');
  g.setTransform(d, 0, 0, d, 0, 0);
  g.clearRect(0, 0, w, h);
  const n = probs.length, bw = w / n;
  const peak = Math.sqrt(Math.max(...probs, ...equippedProbs));
  for (let k = 0; k < n; k++) {
    const bh = Math.max(1.5, (Math.sqrt(probs[k]) / peak) * (h - 2));
    g.fillStyle = colors[k];
    g.fillRect(k * bw + 1, h - bh, bw - 2, bh);
    if (!isEquipped) {
      const eh = (Math.sqrt(equippedProbs[k]) / peak) * (h - 2);
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.fillRect(k * bw + 1, h - eh - 1, bw - 2, 2);
    }
  }
}

function refreshBallCards() {
  if ($('page-balls').hidden) return;
  const colors = bucketColors(game.ctx.mults, config.themes[game.board.theme]);
  const eqProbs = game.ctx.probs;
  for (const t of config.ballTypes) {
    const c = ballCards[t.id], info = game.ballInfo(t.id);
    c.el.classList.toggle('equipped', info.equipped);
    c.chips.innerHTML = traitChips(t);
    drawHist(c.hist, info.probs, eqProbs, colors, info.equipped);
    c.jack.textContent = `Jackpot 1/${Math.round(info.topOneIn)}`;
    c.gain.textContent = info.equipped ? `${num(info.perSec)}/s` : `${signedPct(info.pct)} /s`;
    c.gain.className = 'bgain' + (info.equipped ? '' : info.pct >= 0.5 ? ' up' : info.pct <= -0.5 ? ' down' : '');
    c.btn.textContent = !info.owned ? 'Not owned' : info.equipped ? 'Equipped' : 'Equip';
    c.btn.disabled = !info.owned || info.equipped;
  }
}
game.on('rebuild', refreshBallCards);


// ---------- Board tab ----------
const boardRows = []; // { info(), btn, onTick }
function buyBtn(action, label) {
  const btn = document.createElement('button');
  btn.className = 'bbuy';
  btn.addEventListener('click', () => { game.buyBoard(action); });
  btn.dataset.label = label || '';
  return btn;
}

function setBuyBtn(btn, info) {
  if (info.locked) { btn.textContent = '🔒'; btn.disabled = true; return; }
  if (info.maxed) { btn.textContent = 'MAX'; btn.disabled = true; return; }
  btn.disabled = false;
  btn.innerHTML = `${btn.dataset.label ? btn.dataset.label + ' ' : ''}<span class="coin-icon"></span>${fmt(info.cost)}`;
  btn.classList.toggle('cant', game.state.coins < info.cost);
}

function row(container, { title, level, sub, action, swatch, extra }) {
  const el = document.createElement('div');
  el.className = 'brow';
  el.innerHTML = `${swatch ? `<span class="swatch" style="background:${swatch}"></span>` : ''}<div class="bt"><div class="bt1">${title}${level != null ? `<span class="lv">Lv ${level}</span>` : ''}</div><div class="bt2">${sub}</div></div>`;
  if (extra) el.appendChild(extra);
  if (action) {
    const info = game.boardInfo(action);
    el.classList.toggle('locked', info.locked);
    const btn = buyBtn(action);
    el.appendChild(btn);
    boardRows.push({ btn, action });
  }
  container.appendChild(el);
  return el;
}

const gainTxt = (info) => (info.locked ? info.lockedText : info.maxed ? 'maxed' : info.preview ? `<span class="g">${gainAbs(info.preview)}/s</span>` : '');
// Coins per second an upgrade adds, as a number (reads bigger and clearer than a percentage).
function gainAbs(pv) { const d = pv.after - pv.now, a = Math.abs(d); return (d < 0 ? '−' : '+') + (a < 10 ? a.toFixed(a < 1 ? 2 : 1) : fmt(a)); }
const effTxt = (info) => {
  const [a, b, unit] = info.effect;
  return info.maxed || info.locked ? `<b>${a}</b> ${unit}` : `<b>${a} → ${b}</b> ${unit}`;
};

function renderBoardTab() {
  const list = $('boardList');
  if ($('page-board').hidden) return;
  const scroll = list.scrollTop;
  list.innerHTML = '';
  boardRows.length = 0;
  const T = config.boardTree, b = game.board, up = game.state.boardUp;
  const sec = (t) => { const d = document.createElement('div'); d.className = 'sec'; d.textContent = t; list.appendChild(d); };

  sec('Special pegs');
  b.sockets.forEach((sock, idx) => {
    const peg = up.sockets[idx];
    if (sock.r >= game.geo.rows) return;
    if (peg) {
      const action = { kind: 'socket', socket: idx }, info = game.boardInfo(action);
      row(list, { title: T.pegs[peg.type].name, level: peg.level, swatch: T.pegs[peg.type].color, sub: `${effTxt(info)} · ${gainTxt(info)}`, action });
    } else {
      const pick = document.createElement('div');
      pick.className = 'pegpick';
      const types = Object.keys(T.pegs).filter((t) => game.state.unlockAll || b.pegTypes.includes(t));
      for (const t of types) {
        const action = { kind: 'place', socket: idx, type: t };
        const btn = buyBtn(action, T.pegs[t].name.split(' ')[0]);
        btn.style.borderLeft = `4px solid ${T.pegs[t].color}`;
        pick.appendChild(btn);
        boardRows.push({ btn, action });
      }
      row(list, { title: `Empty socket ${idx + 1}`, sub: `row ${sock.r + 1} · pick a peg`, extra: pick });
    }
  });
  const nextTypes = Object.keys(T.pegs).filter((t) => !game.state.unlockAll && !b.pegTypes.includes(t));
  if (nextTypes.length) row(list, { title: nextTypes.map((t) => T.pegs[t].name).join(', '), sub: 'unlock on later boards' }).classList.add('locked');

  sec('Board pieces');
  for (const id of Object.keys(T.pieces)) {
    const action = { kind: 'piece', id }, info = game.boardInfo(action);
    let extra = null;
    if (id === 'autoFlip' && info.level > 0) {
      extra = document.createElement('button');
      extra.className = 'mini';
      extra.textContent = up.autoFlipOn ? 'ON' : 'OFF';
      extra.classList.toggle('on', up.autoFlipOn);
      extra.addEventListener('click', () => game.setAutoFlip(!up.autoFlipOn));
    }
    // Player-placed pieces: a Move button per piece (one per lid).
    const movers = id === 'lids' ? up.lidPos.map((_, n) => [{ kind: 'lid', n }, up.lidPos.length > 1 ? `Move ${n + 1}` : 'Move'])
      : (id === 'trampoline' || id === 'magnet') && info.level > 0 ? [[{ kind: id }, 'Move']] : [];
    if (movers.length) {
      extra = document.createElement('div');
      extra.style.display = 'flex'; extra.style.gap = '4px';
      for (const [what, lbl] of movers) {
        const mb = document.createElement('button');
        mb.className = 'mini move'; mb.textContent = lbl;
        mb.addEventListener('click', () => startPlacement(what));
        extra.appendChild(mb);
      }
    }
    const earnedKey = { lids: 'lid', autoFlip: 'flip' }[id] || id;
    const earned = game.pieceEarned[earnedKey];
    const desc = info.locked ? T.pieces[id].desc : effTxt(info);
    row(list, { title: T.pieces[id].name, level: info.locked ? null : info.level, sub: `${desc} · ${gainTxt(info)}${info.level > 0 && !info.locked ? ` · <span class="earn" data-earn="${earnedKey}">${earned ? `earned ${fmt(earned)}` : ''}</span>` : ''}`, action, extra });
  }

  sec('Machine');
  {
    const action = { kind: 'dropper' }, info = game.boardInfo(action);
    row(list, { title: T.droppers.name, level: null, sub: info.locked ? `${T.droppers.desc} · ${info.lockedText}` : `${effTxt(info)} · ${gainTxt(info)}`, action });
  }

  list.scrollTop = scroll;
  tickBoardTab();
}

function tickBoardTab() {
  if ($('page-board').hidden) return;
  for (const e of document.querySelectorAll('#boardList .earn')) {
    const v = game.pieceEarned[e.dataset.earn];
    if (v) e.textContent = `earned ${fmt(v)}`;
  }
  for (const r of boardRows) setBuyBtn(r.btn, game.boardInfo(r.action));
}
game.on('rebuild', renderBoardTab);

// ---------- Placement mode: move a lid / trampoline / magnet by tapping a spot ----------
const placeBar = document.createElement('div');
placeBar.id = 'placeBar';
placeBar.hidden = true;
placeBar.innerHTML = '<span></span><button>Cancel</button>';
stage.appendChild(placeBar);
placeBar.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); endPlacement(); });
placeBar.addEventListener('pointerdown', (e) => e.stopPropagation());

function startPlacement(what) {
  const options = game.placementOptions(what);
  if (!options.length) return;
  renderer.placement = { what, options };
  placeBar.querySelector('span').textContent = `Tap a spot for the ${what.kind} — green pays more`;
  placeBar.hidden = false;
}
function endPlacement() { renderer.placement = null; placeBar.hidden = true; }
game.on('rebuild', () => { if (renderer.placement) endPlacement(); });

function placementTap(px, py) {
  const P = renderer.placement;
  let best = null;
  for (const o of P.options) {
    const [x, y] = renderer.spotXY(game, o);
    const d = Math.hypot(px - x, py - y);
    if (d < renderer.s * 0.55 && (!best || d < best.d)) best = { o, d };
  }
  if (!best) return;
  const { what } = P;
  endPlacement();
  if (!best.o.current) game.place(what, best.o);
}

// ---------- Flippers: tap anywhere on the board ----------
stage.addEventListener('pointerdown', (e) => {
  const rect = stage.getBoundingClientRect();
  if (renderer.placement) { placementTap(e.clientX - rect.left, e.clientY - rect.top); return; }
  // One tap does both jobs: a ball under the finger starts to glow (pays more), and both
  // flippers fire (they only catch a ball that is in a ring).
  const tapped = game.tapBall((e.clientX - rect.left - renderer.X(0)) / renderer.s, (e.clientY - rect.top - renderer.Y(0)) / renderer.s);
  const caught = game.flip(0) + game.flip(1);
  if (tapped) navigator.vibrate?.(8);
  if (caught) navigator.vibrate?.(15);
});

// ---------- Board picker: tap the board name to try another board ----------
const picker = $('boardPicker');
function renderPicker() {
  const list = $('boardPickList');
  list.innerHTML = '';
  config.boards.forEach((b, idx) => {
    const th = config.themes[b.theme];
    const mults = multipliersFor(b);
    const el = document.createElement('button');
    el.className = 'pick' + (idx === game.state.boardIndex ? ' cur' : '');
    el.innerHTML = `
      <span class="sw" style="background:linear-gradient(${th.bgTop},${th.bgBottom})"><i style="background:${th.bucketHigh}"></i><i style="background:${th.bucketMid}"></i><i style="background:${th.bucketLow}"></i></span>
      <span class="pt"><b>${b.id}. ${b.name}</b><small>${b.blurb || ''}</small><small class="meta">${b.rows} rows · ${mults.filter((m) => m > 0).length} buckets · top ×${fmt(Math.max(...mults) / (b.payoutScale ?? 1))}${(b.payoutScale ?? 1) > 1 ? ` · coins ×${fmt(b.payoutScale)}` : ''}</small></span>
      <span class="go">${idx === game.state.boardIndex ? 'Here' : 'Play'}</span>`;
    const open = game.boardOpen(idx);
    if (!open) { el.classList.add('shut'); el.querySelector('.go').textContent = '🔒'; el.querySelector('.meta').textContent = `Fill the goal on Board ${idx} to open`; }
    else if (game.boardUps[idx]?.earned >= b.goal || (idx === game.state.boardIndex && game.progress.done)) el.querySelector('.pt b').insertAdjacentHTML('beforeend', ' <span class="done">✓</span>');
    el.addEventListener('click', () => { if (!open) return; game.setBoard(idx); picker.hidden = true; });
    list.appendChild(el);
  });
}
$('boardName').addEventListener('click', () => { renderPicker(); picker.hidden = false; });
$('boardPickClose').addEventListener('click', () => { picker.hidden = true; });
picker.addEventListener('click', (e) => { if (e.target === picker) picker.hidden = true; });
game.on('board_change', () => { shownCoins = game.state.coins; showTab(document.querySelector('.tab.active')?.dataset.page || 'workshop'); refreshSlow(); });

// ---------- Board goal: meter, unlock banners, next board ----------
const goalFill = $('goalFill'), goalText = $('goalText'), goalTicks = $('goalTicks');
function renderGoalTicks() {
  goalTicks.innerHTML = game.progress.milestones.map((m) => `<i style="left:${m.at * 100}%"></i>`).join('');
}
function refreshGoal() {
  const p = game.progress;
  goalFill.style.width = `${p.frac * 100}%`;
  $('goal').classList.toggle('done', p.done);
  const ticks = goalTicks.children;
  p.milestones.forEach((m, n) => ticks[n]?.classList.toggle('on', m.reached));
  const nextBoard = config.boards[game.state.boardIndex + 1];
  goalText.textContent = p.done
    ? (nextBoard ? `Goal complete · tap for Board ${nextBoard.id} ▸` : 'Goal complete · last board')
    : `Goal ${fmt(p.earned)} / ${fmt(p.goal)}${p.next ? ` · ${p.next.name} at ${fmt(p.next.at * p.goal)}` : nextBoard ? ` · opens Board ${nextBoard.id}` : ''}`;
}
$('goal').addEventListener('click', () => { renderPicker(); picker.hidden = false; });
game.on('rebuild', renderGoalTicks);

const toast = $('toast');
let toastTimer = 0;
function showToast(html, sec = 2.6) {
  toast.innerHTML = html; toast.hidden = false;
  toast.classList.remove('in'); void toast.offsetWidth; toast.classList.add('in');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, sec * 1000);
}
game.on('milestone', (e) => {
  const [kind, id] = e.unlock.split(':');
  const name = kind === 'piece' ? config.boardTree.pieces[id].name : config.boardTree.droppers.name;
  showToast(`<small>Unlocked</small><b>${name}</b><small>Buy it in the Board tab</small>`);
  document.querySelector('.tab[data-page="board"]').classList.add('ping');
  navigator.vibrate?.(20);
});

const modal = $('modal');
function showModal({ title, body, primary, onPrimary, secondary }) {
  $('modalTitle').textContent = title; $('modalBody').innerHTML = body;
  $('modalPrimary').textContent = primary; $('modalSecondary').textContent = secondary || '';
  $('modalSecondary').hidden = !secondary;
  $('modalPrimary').onclick = () => { modal.hidden = true; onPrimary?.(); };
  $('modalSecondary').onclick = () => { modal.hidden = true; };
  modal.hidden = false;
}
game.on('board_complete', (e) => {
  save();
  if (e.next) showModal({
    title: 'Board complete!', body: `You filled the goal on <b>${game.board.name}</b>.<br>Board ${e.next.id} · <b>${e.next.name}</b> is open: ${e.next.blurb || ''}.<br><small>Your Workshop upgrades and balls come with you. You can come back any time.</small>`,
    primary: `Go to ${e.next.name}`, onPrimary: () => game.setBoard(game.config.boards.indexOf(e.next)), secondary: 'Stay here',
  });
  else showModal({ title: 'All boards complete!', body: 'You filled the goal on every board.', primary: 'Nice' });
});

// ---------- Frenzy button ----------
const frenzyBtn = $('frenzyBtn'), FZ = config.active.frenzy;
frenzyBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); if (game.startFrenzy()) navigator.vibrate?.(30); });
function refreshFrenzy() {
  const f = game.frenzy, on = f.left > 0, ready = game.frenzyReady;
  frenzyBtn.classList.toggle('on', on); frenzyBtn.classList.toggle('ready', ready);
  stage.classList.toggle('frenzy', on);
  frenzyBtn.style.setProperty('--fill', `${(on ? f.left / FZ.durationSec : f.charge / FZ.chargeSec) * 100}%`);
  frenzyBtn.querySelector('span').textContent = on ? `⚡ ×${FZ.mul} · ${Math.ceil(f.left)}s` : ready ? '⚡ FRENZY! Tap' : `⚡ Frenzy ${Math.floor((f.charge / FZ.chargeSec) * 100)}%`;
}
game.on('frenzy', () => showToast(`<b>⚡ FRENZY!</b><small>Every ball pays ×${FZ.mul} for ${FZ.durationSec}s</small>`, 1.8));

// ---------- Tutorial: one coach line at a time, each cleared by doing the thing ----------
const FT = config.ftue, coach = $('coach');
// Testing sessions skip it unless ?ftue is given.
if (!FT.enabled || (sandbox && !params.has('ftue'))) game.state.ftue = FT.steps.length + 1;
const ftueDone = {
  watch: () => game.stats.landed >= 3,
  jackpot: () => game.stats.jackpots >= 1,
  tap: () => game.stats.taps >= 1,
  buy: () => game.state.workshop.ballValue >= 1,
  goal: () => game.progress.milestones[0]?.reached ?? true,
  flippers: () => game.state.boardUp.pieces.flippers >= 1,
  flip: () => game.stats.manualFlips >= 1,
  frenzy: () => game.stats.frenzies >= 1,
};
let coachShown = -1;
function refreshFtue() {
  const st = game.state;
  while (st.ftue < FT.steps.length && ftueDone[FT.steps[st.ftue].id]()) {
    st.ftue++;
    game.emit('ftue_step', { step: st.ftue, id: FT.steps[st.ftue - 1].id });
    if (st.ftue === FT.steps.length) { st.ftue++; showToast(`<b>${FT.doneText}</b>`, 3.5); }
  }
  if (st.ftue === coachShown) return;
  coachShown = st.ftue;
  for (const el of document.querySelectorAll('.coachmark')) el.classList.remove('coachmark');
  const step = FT.steps[st.ftue];
  coach.hidden = !step;
  if (!step) return;
  coach.textContent = step.text;
  coach.classList.remove('in'); void coach.offsetWidth; coach.classList.add('in');
  if (step.highlight) document.querySelector(step.highlight)?.classList.add('coachmark');
  if (step.id === 'jackpot') game.forceNext = game.ctx.top[0]; // one arranged lucky ball to show what an edge bucket pays
  if (step.id === 'buy') showTab('workshop');
}

// ---------- Odds toggles ----------
$('oddsBtn').addEventListener('click', (e) => {
  renderer.showOdds = !renderer.showOdds;
  e.currentTarget.classList.toggle('on', renderer.showOdds);
});
$('measBtn').classList.toggle('on', renderer.showMeasured);
$('measBtn').addEventListener('click', (e) => {
  renderer.showMeasured = !renderer.showMeasured;
  if (renderer.showMeasured) renderer.showOdds = true;
  $('oddsBtn').classList.toggle('on', renderer.showOdds);
  e.currentTarget.classList.toggle('on', renderer.showMeasured);
});

// ---------- HUD ----------
let shownCoins = game.state.coins;
const coinsEl = $('coins'), coinsBox = $('coinsBox');
game.on('land', () => {
  coinsBox.classList.remove('bump'); void coinsBox.offsetWidth; coinsBox.classList.add('bump');
});
// ---------- Sound ----------
const audio = createAudio(config.audio);
game.on('land', (e) => {
  const ms = game.ctx.mults, lo = Math.min(...ms), hi = Math.max(...ms);
  audio.play('land', hi > lo ? Math.log(ms[e.bucket] / lo) / Math.log(hi / lo) : 0);
});
game.on('jackpot', () => audio.play('jackpot'));
game.on('purchase', () => audio.play('purchase'));
game.on('special_peg_hit', (e) => audio.play(e.type));
game.on('flip', () => audio.play('flip'));
game.on('tap_ball', () => audio.play('tap'));
game.on('piece_placed', () => audio.play('place'));
game.on('frenzy', () => audio.play('frenzy'));
game.on('frenzy_end', () => audio.play('frenzyEnd'));
game.on('milestone', () => audio.play('milestone'));
game.on('board_complete', () => audio.play('boardComplete'));
game.on('equip', () => audio.play('click'));
function showSound() { const b = $('soundBtn'); b.classList.toggle('on', !audio.muted); b.textContent = audio.muted ? 'Sound off' : 'Sound on'; b.setAttribute('aria-pressed', String(!audio.muted)); }
$('soundBtn').addEventListener('click', () => { audio.setMuted(!audio.muted); showSound(); audio.play('click'); });
showSound();
game.on('jackpot', (e) => console.log('[jackpot]', e));
game.on('purchase', (e) => console.log('[purchase]', e));
game.on('equip', (e) => console.log('[equip]', e));

function refreshHud(dt) {
  const target = game.state.coins;
  if (target < shownCoins) shownCoins = target; // spend: snap down
  else shownCoins += (target - shownCoins) * Math.min(1, config.animation.coinCounterLerpPerSec * dt);
  if (target - shownCoins < 0.5) shownCoins = target;
  coinsEl.textContent = fmt(shownCoins);
}

function refreshSlow() {
  $('boardName').textContent = `Board ${game.board.id} · ${game.board.name} ▾`;
  // The rate right now: Frenzy multiplies it while it runs (the long-run average is used for upgrade previews).
  const inc = game.income, fzOn = game.frenzy.left > 0;
  const nowRate = inc.perBall * inc.rate * inc.bonus.touch * (fzOn ? config.active.frenzy.mul : 1);
  $('rate').textContent = `+${num(nowRate)}/s`;
  if ($('rate').classList.contains('frenzy') !== fzOn) {
    $('rate').classList.toggle('frenzy', fzOn);
    if (fzOn) { $('rate').classList.remove('jump'); void $('rate').offsetWidth; $('rate').classList.add('jump'); }
  }
  const st = game.stats;
  $('stats').textContent = renderer.showMeasured
    ? `${st.landed} landed · ${st.jackpots} jackpots · ${st.goldens} golden · measured ${num(game.measuredIncome())}/s`
    : `${num(game.income.rate)} balls/s · ${st.jackpots} jackpot${st.jackpots === 1 ? '' : 's'}`;
  refreshCards();
  tickBoardTab();
  refreshGoal();
  refreshFrenzy();
  refreshFtue();
}

// ---------- Loop ----------
let last = performance.now();
let slowAcc = 0;
function frame(now) {
  const dt = Math.min((now - last) / 1000, config.sim.maxFrameDtSec);
  last = now;
  game.update(dt);
  renderer.draw(game);
  refreshHud(dt);
  slowAcc += dt;
  if (slowAcc > 0.1) { slowAcc = 0; refreshSlow(); }
  requestAnimationFrame(frame);
}
// ---------- Away time: save on leaving, pay offline income on return ----------
const awayText = (sec) => (sec >= 3600 ? `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m` : sec >= 60 ? `${Math.round(sec / 60)} min` : `${Math.round(sec)}s`);
function showWelcome(w) {
  if (!w || !(w.amount > 0)) return;
  shownCoins = game.state.coins - w.amount; // let the counter roll up
  showModal({
    title: 'Welcome back!',
    body: `Your board kept dropping for <b>${awayText(w.sec)}</b>${w.capped ? ` (the most it runs unattended is ${config.offline.capHours}h)` : ''}.<br><span class="big"><span class="coin-icon"></span> +${fmt(w.amount)}</span><br><small>Away earnings are ${Math.round(config.offline.efficiency * 100)}% of the normal rate.</small>`,
    primary: 'Collect',
  });
}
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  // rAF pauses while hidden; reset the clock so we don't fast-forward on return.
  last = performance.now();
  if (document.hidden) { hiddenAt = Date.now(); save(); analytics.endSession(snap()); }
  else if (hiddenAt) {
    const away = (Date.now() - hiddenAt) / 1000;
    const w = game.offlineEarn(away); hiddenAt = 0; showWelcome(w); save();
    analytics.startSession(away); // every return is a session; awaySec tells short switches from real returns
  }
});
window.addEventListener('pagehide', () => { save(); if (!document.hidden) analytics.endSession(snap()); });
setInterval(save, SAVE.everySec * 1000);
if (params.get('tab')) showTab(params.get('tab'));
if (openPlace) startPlacement(openPlace.startsWith('lid') ? { kind: 'lid', n: Number(openPlace.slice(3)) || 0 } : { kind: openPlace });
renderGoalTicks();
refreshSlow();
showWelcome(welcome);
requestAnimationFrame(frame);
