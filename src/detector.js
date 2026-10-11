// Red Eye — eye detector.
// Wraps MediaPipe FaceLandmarker (runs 100% on-device) and turns each camera frame into:
//   { noFace, faceOk, openness, blendOpen, ear, lookAway }
// `openness` fuses two independent measurements:
//   1) blendshapes eyeBlinkLeft/Right  (robust to head pose and lighting)
//   2) eye aspect ratio (EAR) from the eyelid landmarks (works even without blendshapes)

// Eyelid landmarks of the 468-point face mesh: [outer, top1, top2, inner, bottom2, bottom1]
const RIGHT_EYE = [33, 160, 158, 133, 153, 144];
const LEFT_EYE = [362, 385, 387, 263, 373, 380];
const NOSE = 1, CHEEK_L = 234, CHEEK_R = 454;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (a, b, w, h) => Math.hypot((a.x - b.x) * w, (a.y - b.y) * h);

export function eyeAspectRatio(lm, idx, w, h) {
  const [p1, p2, p3, p4, p5, p6] = idx.map(i => lm[i]);
  const horiz = dist(p1, p4, w, h);
  if (horiz < 1e-6) return null;
  return (dist(p2, p6, w, h) + dist(p3, p5, w, h)) / (2 * horiz);
}

// Pure function (unit-tested): MediaPipe result + frame size -> eye measurements.
export function analyzeResult(result, w, h) {
  const lm = result && result.faceLandmarks && result.faceLandmarks[0];
  if (!lm || lm.length < 468) {
    return { noFace: true, faceOk: false, openness: null, blendOpen: null, ear: null, lookAway: false };
  }

  // blendshape scores by name
  let blend = null;
  const cats = result.faceBlendshapes && result.faceBlendshapes[0] && result.faceBlendshapes[0].categories;
  if (cats) { blend = {}; for (const c of cats) blend[c.categoryName] = c.score; }

  const earR = eyeAspectRatio(lm, RIGHT_EYE, w, h);
  const earL = eyeAspectRatio(lm, LEFT_EYE, w, h);
  const ear = earR != null && earL != null ? (earR + earL) / 2 : null;
  const earOpen = ear != null ? clamp(ear / 0.30, 0, 1) : null;

  let blendOpen = null;
  if (blend && blend.eyeBlinkLeft != null && blend.eyeBlinkRight != null) {
    blendOpen = clamp(1 - (blend.eyeBlinkLeft + blend.eyeBlinkRight) / 2, 0, 1);
  }

  // Looking down at the keyboard lowers the lids without a blink: pause instead of counting.
  let lookAway = false;
  if (blend && blend.eyeLookDownLeft != null) {
    lookAway = (blend.eyeLookDownLeft + blend.eyeLookDownRight) / 2 > 0.55;
  }
  // Head turned too far: the eyelid geometry is unreliable.
  const dl = Math.abs(lm[NOSE].x - lm[CHEEK_L].x), dr = Math.abs(lm[CHEEK_R].x - lm[NOSE].x);
  const yaw = dl / Math.max(dr, 1e-6);
  if (yaw < 0.4 || yaw > 2.5) lookAway = true;

  let openness = null;
  if (blendOpen != null && earOpen != null) openness = 0.7 * blendOpen + 0.3 * earOpen;
  else if (blendOpen != null) openness = blendOpen;
  else if (earOpen != null) openness = earOpen;

  return { noFace: false, faceOk: openness != null && !lookAway, openness, blendOpen, ear, lookAway };
}

export class EyeDetector {
  constructor() { this.lm = null; this._lastTs = -1; }

  // wasmDir: folder with vision_wasm_internal.{js,wasm}; modelPath: face_landmarker.task
  async init({ wasmDir, modelPath, bundleUrl }) {
    const { FaceLandmarker, FilesetResolver } = await import(bundleUrl);
    const fileset = await FilesetResolver.forVisionTasks(wasmDir);
    // CPU delegate on purpose: it works in a hidden offscreen document with no GPU/WebGL
    // surprises, and the model is light enough (~10 ms/frame on a normal laptop).
    this.lm = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: modelPath, delegate: 'CPU' },
      runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true,
      minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5
    });
  }

  // source: VideoFrame | HTMLVideoElement ; w/h: pixel size of the source
  detect(source, tsMs, w, h) {
    let ts = Math.round(tsMs);
    if (ts <= this._lastTs) ts = this._lastTs + 1;   // MediaPipe needs strictly increasing timestamps
    this._lastTs = ts;
    return analyzeResult(this.lm.detectForVideo(source, ts), w, h);
  }

  close() { try { this.lm && this.lm.close(); } catch (_) {} this.lm = null; }
}
