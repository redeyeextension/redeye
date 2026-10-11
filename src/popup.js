import { reasonsText, fatigueLabel } from './texts.js';

const $ = (id) => document.getElementById(id);
const THRESH = { high: 35, normal: 45, low: 60 };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const send = (type) => chrome.runtime.sendMessage({ type }).catch(() => null);

let data = { state: null, settings: null, metrics: null };
let port = null;
let live = false;            // true while real eye data is arriving from the camera
let lastLive = 0;
let idleBlinkAt = 0, blinkStart = -1;
let redShown = 0.04;

// ---------- data ----------
async function refresh() {
  const r = await send('GET_STATE');
  if (r) data = r;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.state) data.state = changes.state.newValue;
  if (area === 'session' && changes.metrics) data.metrics = changes.metrics.newValue;
  if (area === 'sync') refresh();
  connectEye();
});

// ---------- live eye mirroring ----------
function connectEye() {
  const st = data.state;
  const want = st && st.running && st.mode === 'work' && st.cam && st.cam.status === 'running';
  if (want && !port) {
    try {
      port = chrome.runtime.connect({ name: 'eye-stream' });
      port.onMessage.addListener(onEye);
      port.onDisconnect.addListener(() => { port = null; live = false; void chrome.runtime.lastError; });
    } catch (_) { port = null; }
  } else if (!want && port) {
    try { port.disconnect(); } catch (_) {}
    port = null; live = false;
  }
}

function onEye(m) {
  lastLive = performance.now();
  if (!m.face || m.norm == null) { live = false; return; }
  live = true;
  // norm 1 = open ... <=0.15 = closed
  setLid(clamp((m.norm - 0.15) / 0.7, 0.06, 1));
}

function setLid(s) { $('eye').style.transform = 'scaleY(' + s.toFixed(3) + ')'; }

// ---------- render ----------
function fmt(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function render(now) {
  const S = data.state, set = data.settings, M = data.metrics;
  if (!S || !set) return;
  const thr = THRESH[set.sensitivity] || 45;
  const running = S.running;
  const resting = S.mode === 'rest';
  const fatigue = running && S.mode === 'work' && M && M.fatigueReady ? M.fatigue : 0;

  // timer
  let remaining = set.workMin * 60, frac = 0;
  if (running && S.mode === 'work') {
    remaining = S.paused ? S.pausedLeftMs / 1000 : (S.workEndAt - Date.now()) / 1000;
    frac = 1 - remaining / (set.workMin * 60);
  } else if (resting) {
    remaining = (S.restEndAt - Date.now()) / 1000;
    frac = 1 - remaining / S.restTotalSec;
  }
  $('clock').textContent = fmt(remaining);
  $('clockLabel').textContent = resting ? 'وقت الراحة، بص بعيد' : S.paused ? 'واقفة (الشاشة مقفولة)' : 'الباقي على الراحة';
  $('barFill').style.width = (clamp(frac, 0, 1) * 100).toFixed(1) + '%';

  // buttons
  $('startBtn').textContent = !running ? 'ابدأ الجلسة' : resting ? 'كمّل شغل' : 'وقّف';
  $('startBtn').classList.toggle('primary', !running);
  $('restBtn').hidden = !(running && S.mode === 'work' && !S.paused);

  // status line
  let status = 'جاهز لجلسة جديدة', warn = false, why = '';
  if (running && S.mode === 'work') {
    if (S.paused) status = 'واقفة لحد ما ترجع';
    else if (!M || !M.fatigueReady) status = set.useCamera ? 'بقيس رمشك…' : 'الجلسة شغالة';
    else { status = fatigueLabel(fatigue, thr); warn = fatigue >= thr; why = reasonsText(M.fatigueReasons); }
  } else if (resting) status = 'ريّح عينك';
  $('status').textContent = status;
  $('status').classList.toggle('warn', warn);
  $('why').textContent = why;

  // stats
  $('bpm').textContent = M && M.bpm != null && running && S.mode === 'work' ? Math.round(M.bpm) + ' /د' : '—';
  $('sessions').textContent = String(S.sessions);
  $('alerts').textContent = String(S.alerts);

  renderCam(S, set, M);

  // eye: redness from time on screen + fatigue score
  const target = running && S.mode === 'work' ? clamp(Math.max(frac * 0.6, fatigue / 100 * 1.1), 0, 1) : 0.04;
  redShown += (target - redShown) * 0.08;
  $('veinsA').setAttribute('opacity', clamp(redShown * 2.2, 0, 1).toFixed(2));
  $('veinsB').setAttribute('opacity', clamp(redShown * 2.2 - 0.7, 0, 1).toFixed(2));
  $('wash').setAttribute('opacity', (redShown * 0.28).toFixed(3));

  // no camera data: gentle idle blink so the eye never looks frozen
  if (performance.now() - lastLive > 800) live = false;
  if (!live) {
    if (now >= idleBlinkAt) { blinkStart = now; idleBlinkAt = now + 3000 + Math.random() * 2500; }
    if (blinkStart >= 0) {
      const u = (now - blinkStart) / 200;
      if (u < 1) setLid(1 - 0.94 * Math.sin(Math.PI * u)); else { setLid(1); blinkStart = -1; }
    }
    if (resting) setLid(0.06);
  }
}

function renderCam(S, set, M) {
  const el = $('camLine'), fix = $('fixBtn');
  let text = '', err = false, fixText = '', fixType = '';
  const cam = S.cam || { status: 'off' };
  if (!set.useCamera) text = 'الكاميرا مقفولة، المؤقت بس شغال.';
  else if (!S.running) text = 'الكاميرا بتشتغل أول ما تبدأ الجلسة، والتحليل بيتم على جهازك بس.';
  else if (S.mode === 'rest') text = 'الكاميرا واقفة وقت الراحة.';
  else if (cam.status === 'loading') text = 'بحمّل موديل الكشف…';
  else if (cam.status === 'error') {
    err = true;
    if (cam.error === 'permission') { text = 'محتاج إذن الكاميرا.'; fixText = 'اديني الإذن'; fixType = 'OPEN_OPTIONS'; }
    else if (cam.error === 'model') { text = 'ملفات الموديل ناقصة: شغّل npm run setup.'; }
    else { text = 'الكاميرا مش شغالة: ' + (cam.error || ''); fixText = 'جرّب تاني'; fixType = 'CAM_RETRY'; }
  } else if (M && M.phase === 'calibrating') {
    text = 'معايرة ' + Math.round(M.calibrationProgress * 100) + '% — بص على الشاشة عادي.';
  } else if (M && M.faceMissing) { text = 'مش شايف وشك قدام الكاميرا.'; }
  else if (M) { text = 'الكاميرا شغالة · ' + M.totalBlinks + ' رمشة في الجلسة'; }
  el.textContent = text;
  el.classList.toggle('err', err);
  fix.hidden = !fixText;
  fix.textContent = fixText;
  fix.dataset.type = fixType;
}

// ---------- events ----------
$('startBtn').addEventListener('click', async () => {
  const S = data.state;
  if (!S.running) await send('START');
  else if (S.mode === 'rest') await send('SKIP_REST');
  else await send('STOP');
  await refresh();
});
$('restBtn').addEventListener('click', () => { send('REST_NOW'); window.close(); });
$('gear').addEventListener('click', () => { send('OPEN_OPTIONS'); window.close(); });
$('fixBtn').addEventListener('click', async (e) => { if (e.currentTarget.dataset.type) await send(e.currentTarget.dataset.type); });

// ---------- boot ----------
function loop(now) { render(now); requestAnimationFrame(loop); }
refresh().then(() => { connectEye(); requestAnimationFrame(loop); });
