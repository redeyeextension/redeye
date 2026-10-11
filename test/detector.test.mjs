import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeResult } from '../src/detector.js';

const W = 640, H = 480;

function face({ dy = 0.024, blink = 0.05, lookDown = 0.0, noseX = 0.5, withBlend = true } = {}) {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  lm[1] = { x: noseX, y: 0.5, z: 0 };          // nose
  lm[234] = { x: 0.25, y: 0.5, z: 0 };         // cheeks
  lm[454] = { x: 0.75, y: 0.5, z: 0 };
  const eye = (idx, x0, x1) => {               // [outer, top1, top2, inner, bottom2, bottom1]
    const cy = 0.4;
    lm[idx[0]] = { x: x0, y: cy, z: 0 };
    lm[idx[3]] = { x: x1, y: cy, z: 0 };
    const q1 = x0 + (x1 - x0) * 0.33, q2 = x0 + (x1 - x0) * 0.66;
    lm[idx[1]] = { x: q1, y: cy - dy / 2, z: 0 }; lm[idx[5]] = { x: q1, y: cy + dy / 2, z: 0 };
    lm[idx[2]] = { x: q2, y: cy - dy / 2, z: 0 }; lm[idx[4]] = { x: q2, y: cy + dy / 2, z: 0 };
  };
  eye([33, 160, 158, 133, 153, 144], 0.30, 0.38);
  eye([362, 385, 387, 263, 373, 380], 0.62, 0.70);
  const categories = [
    { categoryName: 'eyeBlinkLeft', score: blink }, { categoryName: 'eyeBlinkRight', score: blink },
    { categoryName: 'eyeLookDownLeft', score: lookDown }, { categoryName: 'eyeLookDownRight', score: lookDown }
  ];
  return { faceLandmarks: [lm], faceBlendshapes: withBlend ? [{ categories }] : [] };
}

test('no face -> noFace', () => {
  const r = analyzeResult({ faceLandmarks: [] }, W, H);
  assert.equal(r.noFace, true); assert.equal(r.faceOk, false); assert.equal(r.openness, null);
});

test('open eye reads high, closed eye reads low (blendshapes + EAR fused)', () => {
  const open = analyzeResult(face({ dy: 0.024, blink: 0.05 }), W, H);
  const closed = analyzeResult(face({ dy: 0.003, blink: 0.9 }), W, H);
  assert.ok(open.openness > 0.8, `open ${open.openness}`);
  assert.ok(closed.openness < 0.2, `closed ${closed.openness}`);
  assert.ok(open.faceOk && closed.faceOk);
});

test('EAR alone works when blendshapes are missing', () => {
  const open = analyzeResult(face({ dy: 0.032, withBlend: false }), W, H);   // EAR ~0.30
  const closed = analyzeResult(face({ dy: 0.003, withBlend: false }), W, H);
  assert.ok(open.openness > 0.9, `open ${open.openness}`);
  assert.ok(closed.openness < 0.1, `closed ${closed.openness}`);
});

test('looking down at the keyboard pauses measuring instead of counting a blink', () => {
  const r = analyzeResult(face({ dy: 0.012, blink: 0.3, lookDown: 0.8 }), W, H);
  assert.equal(r.lookAway, true); assert.equal(r.faceOk, false); assert.equal(r.noFace, false);
});

test('head turned far to the side pauses measuring', () => {
  const r = analyzeResult(face({ noseX: 0.30 }), W, H);
  assert.equal(r.lookAway, true); assert.equal(r.faceOk, false);
});

test('centered head is fine', () => {
  const r = analyzeResult(face({ noseX: 0.5 }), W, H);
  assert.equal(r.lookAway, false);
});
