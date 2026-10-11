// Red Eye — offscreen document. Owns the camera + detector so they keep running
// after the popup closes. Talks to the service worker with runtime messages.
import { EyeDetector } from './detector.js';
import { BlinkEngine } from './blink-engine.js';
import { CameraLoop } from './camera-loop.js';

const detector = new EyeDetector();
let engine = new BlinkEngine();
let detectorReady = null;
let eyePort = null;               // set while the popup is open (live eye mirroring)

const loop = new CameraLoop({
  detector,
  engine,
  onState: (state) => chrome.runtime.sendMessage({ type: 'METRICS', state }).catch(() => {}),
  onFrame: (r, state) => {
    if (!eyePort) return;
    // live eye data for the popup: normalised openness (1 = open) + whether it is closed now
    const norm = engine.baseline && r.openness != null ? r.openness / engine.baseline : null;
    try { eyePort.postMessage({ norm, closed: state.closed, face: !r.noFace && r.faceOk }); } catch (_) {}
  },
  onError: (err) => report('error', String(err && err.message || err))
});

function report(status, error) {
  chrome.runtime.sendMessage({ type: 'CAM_STATUS', status, error: error || null }).catch(() => {});
}

function loadDetector() {
  if (!detectorReady) {
    detectorReady = detector.init({
      bundleUrl: chrome.runtime.getURL('vendor/vision_bundle.mjs'),
      wasmDir: chrome.runtime.getURL('vendor/wasm'),
      modelPath: chrome.runtime.getURL('vendor/face_landmarker.task')
    }).catch((e) => { detectorReady = null; throw e; });
  }
  return detectorReady;
}

async function start({ settings, newSession }) {
  report('loading');
  try {
    await loadDetector();
  } catch (e) {
    report('error', 'model: ' + (e && e.message || e));
    return { ok: false, error: 'model' };
  }
  if (newSession) engine.newSession();
  try {
    await loop.start({ hiRes: settings.hiRes, fps: settings.fps });
  } catch (e) {
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    report('error', denied ? 'permission' : 'camera: ' + (e && e.message || e));
    return { ok: false, error: denied ? 'permission' : 'camera' };
  }
  report('running');
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  (async () => {
    switch (msg.type) {
      case 'CAM_START': sendResponse(await start(msg)); break;
      case 'CAM_PAUSE': loop.stop(); report('paused'); sendResponse({ ok: true }); break;
      case 'CAM_STOP': loop.stop(); report('off'); sendResponse({ ok: true }); break;
      case 'CAM_NEWSESSION': engine.newSession(); sendResponse({ ok: true }); break;
      case 'CAM_RECALIBRATE': engine.recalibrate(); sendResponse({ ok: true }); break;
      default: sendResponse({ ok: false });
    }
  })();
  return true;   // async response
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'eye-stream') return;
  eyePort = port;
  port.onDisconnect.addListener(() => { if (eyePort === port) eyePort = null; });
});

chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {});
