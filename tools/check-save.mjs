// Save/load, goal and offline-income check (no browser): play, buy, save, load into a fresh
// game and compare; then check milestones lock/unlock and the next board opens at the goal.
import { readFileSync } from 'node:fs';
import { Game } from '../src/game/game.js';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
let ok = true;
const check = (name, cond, extra = '') => { ok &&= !!cond; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };

const g = new Game(config, { seed: 7 });
const events = [];
g.on('milestone', (e) => events.push(e.unlock));
g.on('board_complete', (e) => events.push('complete'));
check('board 2 is shut at the start', !g.boardOpen(1) && g.setBoard(1) === false);
check('flippers locked before their milestone', g.boardInfo({ kind: 'piece', id: 'flippers' }).locked);
for (let i = 0; i < 60 * 60; i++) g.update(1 / 60);
g.state.coins += 1e4; g.buy('ballValue'); g.buy('dropRate');
g.earn(config.boards[0].goal * 0.1);
check('milestones fire as the meter fills', events.includes('piece:flippers') && events.includes('piece:lids'), events.join(','));
check('flippers unlocked, auto-flip still locked', !g.boardInfo({ kind: 'piece', id: 'flippers' }).locked && g.boardInfo({ kind: 'piece', id: 'autoFlip' }).locked);
g.state.coins += 1e6; g.buyBoard({ kind: 'piece', id: 'flippers' }); g.buyBoard({ kind: 'piece', id: 'lids' });
g.buyBoard({ kind: 'place', socket: 0, type: 'gold' });
g.earn(config.boards[0].goal);
check('goal complete opens board 2', events.includes('complete') && g.boardOpen(1) && !g.boardOpen(2));
g.setBoard(1);
for (let i = 0; i < 600; i++) g.update(1 / 60);

const data = JSON.parse(JSON.stringify(g.serialize()));
const h = new Game(config, { seed: 99 });
check('restore accepts the save', h.restore(data));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
check('coins, workshop, board, pieces identical', h.state.coins === g.state.coins && same(h.state.workshop, g.state.workshop) && h.state.boardIndex === 1 && same(h.state.boardUp, g.state.boardUp) && same(h.boardUps[0], g.serialize().boardUps[0]));
check('income identical after load', Math.abs(h.income.perSec - g.income.perSec) < 1e-9, `${h.income.perSec}`);
check('next drop identical (same seed + drop index)', (() => { g.flushBalls(); h.flushBalls(); const a = g.state.coins, b = h.state.coins; for (let i = 0; i < 1200; i++) { g.update(1 / 60); h.update(1 / 60); } g.flushBalls(); h.flushBalls(); return Math.abs((g.state.coins - a) - (h.state.coins - b)) < 1e-6; })());
h.setBoard(0);
check('board 1 keeps its pieces and meter', h.state.boardUp.pieces.lids === 1 && h.progress.done);

const O = config.offline;
const before = h.state.coins;
check('away under the minimum pays nothing', h.offlineEarn(O.minAwaySec - 1).amount === 0);
const w = h.offlineEarn(10 * 3600);
check('away time is capped and paid at the offline rate', w.capped && Math.abs(w.amount - h.income.perSec * O.capHours * 3600 * O.efficiency) < 1e-6 && Math.abs(h.state.coins - before - w.amount) < 1e-3);
check('a broken save is refused', new Game(config, { seed: 1 }).restore({ v: 0 }) === false);
console.log(ok ? '\nALL OK' : '\nSOME CHECKS FAILED');
process.exit(ok ? 0 : 1);
