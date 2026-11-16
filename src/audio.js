// Sound: everything is synthesised with Web Audio (no audio files). Starts on the first tap,
// because browsers block sound until the player touches the page.
export function createAudio(cfg = {}) {
  const vol = cfg.volume ?? 0.5, minGap = cfg.minGapSec ?? {};
  let ac = null, master = null, noiseBuf = null;
  let muted = false;
  try { muted = localStorage.getItem('plinko.muted') === '1'; } catch { /* storage blocked */ }
  const last = {};

  function start() {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ac = new AC();
    const comp = ac.createDynamicsCompressor(); // keeps many overlapping balls from clipping
    master = ac.createGain(); master.gain.value = muted ? 0 : vol;
    master.connect(comp); comp.connect(ac.destination);
    noiseBuf = ac.createBuffer(1, ac.sampleRate * 0.4, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, start, { passive: true });

  const ready = (name) => {
    if (!ac || muted || ac.state !== 'running' || document.hidden) return false;
    const gap = minGap[name] ?? 0.03;
    if (ac.currentTime - (last[name] ?? -1) < gap) return false;
    last[name] = ac.currentTime; return true;
  };

  /** One enveloped oscillator note. f2 slides the pitch over the note. */
  function tone(f, { at = 0, dur = 0.15, type = 'sine', gain = 0.2, f2 = null, attack = 0.004 } = {}) {
    const t = ac.currentTime + at, o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.02);
  }
  function noise({ at = 0, dur = 0.08, gain = 0.2, freq = 2000, q = 1, kind = 'bandpass' } = {}) {
    const t = ac.currentTime + at, s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    s.buffer = noiseBuf; f.type = kind; f.frequency.value = freq; f.Q.value = q;
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(master); s.start(t); s.stop(t + dur + 0.02);
  }
  const SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24]; // major pentatonic, so any mix of balls sounds in tune
  const note = (step, base = 392) => base * Math.pow(2, SCALE[Math.max(0, Math.min(SCALE.length - 1, step))] / 12);

  const sounds = {
    /** A ball lands. size01: 0 = lowest-paying bucket, 1 = jackpot. */
    land(size01 = 0) {
      const f = note(Math.round(size01 * 8));
      tone(f, { dur: 0.16, type: 'triangle', gain: 0.10 + 0.08 * size01 });
      tone(f * 2, { dur: 0.07, gain: 0.04 });
    },
    jackpot() {
      [5, 7, 8, 10].forEach((s, i) => tone(note(s), { at: i * 0.07, dur: 0.28, type: 'triangle', gain: 0.2 }));
      [0, 1, 2, 3, 4].forEach((i) => tone(2600 + 500 * Math.random(), { at: 0.28 + i * 0.05, dur: 0.12, gain: 0.05 }));
    },
    purchase() { tone(988, { dur: 0.09, type: 'square', gain: 0.07 }); tone(1319, { at: 0.07, dur: 0.22, type: 'square', gain: 0.07 }); },
    gold() { tone(1568, { dur: 0.22, gain: 0.12 }); tone(2349, { at: 0.03, dur: 0.18, gain: 0.06 }); },
    multiplier() { tone(523, { dur: 0.14, type: 'square', gain: 0.06, f2: 1047 }); },
    bumper() { tone(180, { dur: 0.22, type: 'sine', gain: 0.25, f2: 520 }); },
    flip() { noise({ dur: 0.07, gain: 0.3, freq: 900, q: 0.8 }); tone(140, { dur: 0.09, gain: 0.25, f2: 70 }); },
    tap() { tone(700, { dur: 0.08, gain: 0.2, f2: 1400 }); },
    place() { tone(220, { dur: 0.12, type: 'triangle', gain: 0.25, f2: 110 }); noise({ dur: 0.05, gain: 0.15, freq: 500 }); },
    frenzy() { tone(220, { dur: 0.6, type: 'sawtooth', gain: 0.09, f2: 1760 }); [4, 6, 8].forEach((s, i) => tone(note(s), { at: 0.45 + i * 0.08, dur: 0.25, type: 'triangle', gain: 0.18 })); },
    frenzyEnd() { tone(880, { dur: 0.35, type: 'triangle', gain: 0.12, f2: 330 }); },
    milestone() { [3, 5, 7].forEach((s, i) => tone(note(s), { at: i * 0.1, dur: 0.3, type: 'triangle', gain: 0.2 })); },
    boardComplete() { [2, 4, 5, 7, 5, 7, 10].forEach((s, i) => tone(note(s), { at: i * 0.12, dur: i === 6 ? 0.9 : 0.25, type: 'triangle', gain: 0.22 })); noise({ at: 0.72, dur: 0.5, gain: 0.06, freq: 6000, kind: 'highpass' }); },
    click() { tone(600, { dur: 0.04, gain: 0.08 }); },
  };

  return {
    play(name, ...args) { if (sounds[name] && ready(name)) sounds[name](...args); },
    get muted() { return muted; },
    setMuted(m) {
      muted = m;
      try { localStorage.setItem('plinko.muted', m ? '1' : '0'); } catch { /* storage blocked */ }
      if (master) master.gain.value = m ? 0 : vol;
    },
  };
}
