import { EyeDetector } from './detector.js';
import { BlinkEngine } from './blink-engine.js';
import { CameraLoop } from './camera-loop.js';

const $ = (id) => document.getElementById(id);
const DEFAULTS = {
  workMin: 20, restSec: 20, useCamera: true, hiRes: true, fps: 30,
  sensitivity: 'normal', onFatigue: 'notify', autoBreak: true
};

// ---------- settings ----------
const fields = {
  workMin: 'number', restSec: 'number', useCamera: 'bool', hiRes: 'bool', fps: 'number',
  sensitivity: 'text', onFatigue: 'text', autoBreak: 'bool'
};
let savedTimer = null;

async function loadSettings() {
  const s = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  for (const [k, type] of Object.entries(fields)) {
    const el = $(k);
    if (type === 'bool') el.checked = !!s[k]; else el.value = String(s[k]);
  }
}

async function saveSettings() {
  const out = {};
  for (const [k, type] of Object.entries(fields)) {
    const el = $(k);
    if (type === 'bool') out[k] = el.checked;
    else if (type === 'number') {
      let v = Number(el.value);
      if (!Number.isFinite(v) || v <= 0) v = DEFAULTS[k];
      if (k === 'workMin') v = Math.min(60, Math.max(5, Math.round(v)));
      if (k === 'restSec') v = Math.min(60, Math.max(10, Math.round(v)));
      out[k] = v;
    } else out[k] = el.value;
  }
  await chrome.storage.sync.set(out);
  $('saved').textContent = 'اتحفظ. الإعدادات الجديدة بتسري من الجلسة الجاية.';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { $('saved').textContent = ''; }, 3500);
}

$('form').addEventListener('submit', (e) => e.preventDefault());   // no inline handlers: MV3 CSP forbids them
$('form').addEventListener('change', saveSettings);

// ---------- camera test ----------
const detector = new EyeDetector();
const engine = new BlinkEngine();
let detectorReady = null;
let lastBlinks = 0;

const loop = new CameraLoop({
  detector, engine,
  onFrame: (r, state) => {
    const norm = engine.baseline && r.openness != null ? r.openness / engine.baseline : null;
    $('tOpen').style.width = (norm == null ? 0 : Math.max(0, Math.min(1, norm)) * 100).toFixed(0) + '%';
    if (state.totalBlinks !== lastBlinks) {
      lastBlinks = state.totalBlinks;
      $('flash').classList.add('on');
      setTimeout(() => $('flash').classList.remove('on'), 120);
    }
  },
  onState: (s) => {
    let st = 'بيتتبّع';
    if (s.phase === 'calibrating') st = 'معايرة ' + Math.round(s.calibrationProgress * 100) + '% (بص على الشاشة عادي)';
    else if (s.faceMissing) st = 'مش شايف وشك';
    $('tState').textContent = st;
    $('tBlinks').textContent = String(s.totalBlinks);
    $('tBpm').textContent = s.bpm == null ? '—' : Math.round(s.bpm) + ' /د';
    $('tFat').textContent = s.fatigueReady ? s.fatigue + ' / 100' : 'لسه بيقيس…';
  },
  onError: (e) => msg('حصلت مشكلة في الكشف: ' + (e && e.message || e), true)
});

function msg(text, err) {
  $('testMsg').textContent = text;
  $('testMsg').classList.toggle('err', !!err);
}

async function startTest() {
  $('testBtn').disabled = true;
  msg('بحمّل الموديل…');
  try {
    if (!detectorReady) {
      detectorReady = detector.init({
        bundleUrl: chrome.runtime.getURL('vendor/vision_bundle.mjs'),
        wasmDir: chrome.runtime.getURL('vendor/wasm'),
        modelPath: chrome.runtime.getURL('vendor/face_landmarker.task')
      }).catch((e) => { detectorReady = null; throw e; });
    }
    await detectorReady;
  } catch (e) {
    msg('ملفات الموديل ناقصة. شغّل الأمر ده في فولدر المشروع: npm install && npm run setup ثم اعمل Reload للإضافة. (' + (e && e.message || e) + ')', true);
    $('testBtn').disabled = false;
    return;
  }
  try {
    engine.recalibrate();
    lastBlinks = 0;
    const s = await chrome.storage.sync.get(DEFAULTS);
    const stream = await loop.start({ hiRes: s.hiRes, fps: s.fps });
    $('video').srcObject = stream;
    await $('video').play().catch(() => {});
    $('testBtn').textContent = 'وقّف الاختبار';
    $('calBtn').disabled = false;
    msg('شغّال. بص على الشاشة عادي 6 ثواني للمعايرة، وبعدها ارمش وشوف النقطة الحمرا بتومض.');
  } catch (e) {
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    msg(denied ? 'الإذن اترفض. اضغط على أيقونة الكاميرا في شريط العنوان واسمح بيها، وجرّب تاني.'
               : 'الكاميرا مش شغالة: ' + (e && e.message || e), true);
  }
  $('testBtn').disabled = false;
}

function stopTest() {
  loop.stop();
  $('video').srcObject = null;
  $('testBtn').textContent = 'شغّل الاختبار';
  $('calBtn').disabled = true;
  $('tState').textContent = 'واقفة';
  $('tOpen').style.width = '0';
  msg('');
}

$('testBtn').addEventListener('click', () => { loop.running ? stopTest() : startTest(); });
$('calBtn').addEventListener('click', () => { engine.recalibrate(); lastBlinks = 0; msg('بعيد المعايرة: بص على الشاشة عادي 6 ثواني.'); });
window.addEventListener('pagehide', () => loop.stop());

loadSettings();
