import test from 'node:test';
import assert from 'node:assert/strict';
import { BlinkEngine } from '../src/blink-engine.js';

// ---- synthetic eye signal -------------------------------------------------
function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }

// events: [{at, dur, depth}]  depth = lowest openness as a fraction of the base level
function run(engine, { from = 0, ms, fps = 30, base = 0.8, noise = 0.015, events = [], baseAt = null, faceLost = [], seed = 7 }) {
  const rand = rng(seed);
  const step = 1000 / fps;
  let last;
  for (let t = from; t < from + ms; t += step) {
    let b = baseAt ? baseAt(t) : base;
    let v = b;
    for (const e of events) {
      if (t >= e.at && t < e.at + e.dur) {
        const u = (t - e.at) / e.dur;
        const k = e.flat ? 1 : Math.sin(Math.PI * u);        // flat = held closed
        v = b * (1 - (1 - e.depth) * Math.min(1, k * (e.flat ? 1 : 1)));
      }
    }
    v += (rand() * 2 - 1) * noise;
    const lost = faceLost.some(([a, z]) => t >= a && t < z);
    last = engine.push({ t, openness: lost ? null : Math.max(0, Math.min(1, v)), faceOk: !lost });
  }
  return last;
}
const blinksEvery = (startAt, everyMs, count, dur = 150, depth = 0.1) =>
  Array.from({ length: count }, (_, i) => ({ at: startAt + i * everyMs, dur, depth }));

test('calibrates in ~6 s and then tracks', () => {
  const e = new BlinkEngine();
  const s = run(e, { ms: 7000 });
  assert.equal(s.phase, 'tracking');
  assert.ok(Math.abs(e.baseline - 0.8) < 0.05, `baseline ${e.baseline}`);
});

test('counts normal blinks accurately and reports ~20/min', () => {
  const e = new BlinkEngine();
  const ev = blinksEvery(8000, 3000, 20);
  const s = run(e, { ms: 8000 + 20 * 3000 + 1000, events: ev });
  assert.ok(Math.abs(s.totalBlinks - 20) <= 1, `got ${s.totalBlinks}`);
  assert.ok(s.bpm > 17 && s.bpm < 23, `bpm ${s.bpm}`);
});

test('a full blink never produces a false partial blink', () => {
  const e = new BlinkEngine();
  run(e, { ms: 8000 + 30 * 2500, events: blinksEvery(8000, 2500, 30) });
  assert.equal(e.partials.length, 0);
});

test('no false blinks from sensor noise over 60 s', () => {
  const e = new BlinkEngine();
  const s = run(e, { ms: 66000, noise: 0.03 });
  assert.equal(s.totalBlinks, 0);
});

test('fast and slow-but-normal blinks (80 ms .. 300 ms) are all counted', () => {
  const e = new BlinkEngine();
  const ev = [];
  [80, 100, 150, 200, 250, 300].forEach((d, i) => ev.push({ at: 8000 + i * 2500, dur: d, depth: 0.1 }));
  const s = run(e, { ms: 8000 + 6 * 2500 + 500, events: ev });
  assert.equal(s.totalBlinks, 6);
});

test('staring at the screen (1 blink / 12 s) is flagged as low rate', () => {
  const e = new BlinkEngine();
  const s = run(e, { ms: 8000 + 70000, events: blinksEvery(8500, 12000, 6) });
  assert.ok(s.bpm < 8, `bpm ${s.bpm}`);
  assert.ok(s.fatigueReady);
  assert.ok(s.fatigueReasons.includes('low_rate'));
  assert.ok(s.fatigue >= 25);
});

test('normal blinking does not raise fatigue', () => {
  const e = new BlinkEngine();
  const s = run(e, { ms: 8000 + 70000, events: blinksEvery(8000, 3000, 24) });
  assert.equal(s.fatigue, 0);
});

test('long closures (600 ms) are not counted as blinks', () => {
  const e = new BlinkEngine();
  const ev = blinksEvery(8000, 4000, 5, 600);
  const s = run(e, { ms: 8000 + 5 * 4000 + 500, events: ev });
  assert.equal(s.totalBlinks, 0);
  assert.equal(s.longClosures, 5);
});

test('1.5 s closure is a microsleep event', () => {
  const e = new BlinkEngine();
  const s = run(e, { ms: 12000, events: [{ at: 8000, dur: 1500, depth: 0.05, flat: true }] });
  assert.equal(s.microsleeps, 1);
});

test('incomplete blinks (dip to ~70%) are counted as partial, not as blinks', () => {
  const e = new BlinkEngine();
  const ev = blinksEvery(8000, 2500, 8, 150, 0.7);
  run(e, { ms: 8000 + 8 * 2500 + 500, events: ev });
  assert.equal(e.total, 0);
  assert.ok(e.partials.length >= 6, `partials ${e.partials.length}`);
});

test('losing the face mid-blink does not count it, and the rate pauses', () => {
  const e = new BlinkEngine();
  const s = run(e, { ms: 12000, events: [{ at: 9000, dur: 300, depth: 0.1 }], faceLost: [[9050, 9250]] });
  assert.equal(s.totalBlinks, 0);
});

test('lids drooping over a session raise the heavy-lids sign', () => {
  const e = new BlinkEngine();
  const base = (t) => (t < 130000 ? 0.8 : 0.66);
  const s = run(e, { ms: 200000, baseAt: base, events: blinksEvery(8000, 3000, 63) });
  assert.ok(e.opennessDrop() > 0.12, `drop ${e.opennessDrop()}`);
  assert.ok(s.fatigueReasons.includes('heavy_lids'));
});

test('newSession keeps calibration but clears counters', () => {
  const e = new BlinkEngine();
  run(e, { ms: 8000 + 10 * 3000, events: blinksEvery(8000, 3000, 10) });
  const b = e.baseline;
  e.newSession();
  assert.equal(e.phase, 'tracking');
  assert.equal(e.baseline, b);
  assert.equal(e.total, 0);
});

test('looking down (face present but unusable) is NOT reported as a missing face', () => {
  const e = new BlinkEngine();
  run(e, { ms: 8000 });
  let s;
  for (let t = 8000; t < 14000; t += 33) s = e.push({ t, openness: null, faceOk: false, noFace: false });
  assert.equal(s.faceMissing, false);
});

test('no face for > 1.5 s is reported as missing, and clears when the face returns', () => {
  const e = new BlinkEngine();
  run(e, { ms: 8000 });
  let s;
  for (let t = 8000; t < 12000; t += 33) s = e.push({ t, openness: null, faceOk: false, noFace: true });
  assert.equal(s.faceMissing, true);
  s = e.push({ t: 12033, openness: 0.8, faceOk: true });
  assert.equal(s.faceMissing, false);
});
