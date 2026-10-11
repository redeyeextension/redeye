// Red Eye — service worker.
// Owns the session state machine (work -> rest -> work), the alarms, the offscreen camera
// document, the fatigue alerts and the rest overlay. State lives in chrome.storage so it
// survives the worker being suspended.
import { reasonsText } from './texts.js';

const DEFAULTS = {
  workMin: 20,          // 20-20-20 rule: 20 minutes of screen time ...
  restSec: 20,          // ... then 20 seconds looking far away
  useCamera: true,
  hiRes: true,
  fps: 30,
  sensitivity: 'normal',   // high | normal | low  (fatigue alert threshold)
  onFatigue: 'notify',     // notify | auto  (auto = start the rest straight away)
  autoBreak: true          // count looking away for a full rest as a break
};
const THRESH = { high: 35, normal: 45, low: 60 };
const FATIGUE_HOLD_MS = 15000;          // fatigue must persist this long before alerting
const FATIGUE_COOLDOWN_MS = 5 * 60000;  // and at most one alert every 5 minutes

const today = () => new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function freshState() {
  return {
    running: false, mode: 'idle', paused: false,
    workStartAt: 0, workEndAt: 0, pausedLeftMs: 0,
    restEndAt: 0, restTotalSec: 20, restReason: 'time',
    sessions: 0, early: 0, alerts: 0, naturalBreaks: 0,
    cam: { status: 'off', error: null },
    day: today()
  };
}

let S = freshState();
let M = null;                       // latest camera metrics
let ready = load();
let missingSince = 0, fatigueSince = 0, lastFatigueAlert = 0, lastMetricsSave = 0;
let restWinId = null, resolveOffscreen = null, lockedAt = 0;

async function load() {
  const { state } = await chrome.storage.local.get('state');
  if (state) S = { ...freshState(), ...state };
  const { metrics } = await chrome.storage.session.get('metrics');
  if (metrics) M = metrics;
  if (S.day !== today()) { S.sessions = 0; S.early = 0; S.alerts = 0; S.naturalBreaks = 0; S.day = today(); }
}
const save = () => chrome.storage.local.set({ state: S });

let settingsCache = null;
async function getSettings() {
  if (!settingsCache) settingsCache = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  return settingsCache;
}
chrome.storage.onChanged.addListener((_c, area) => { if (area === 'sync') settingsCache = null; });

// ---------- badge ----------
function updateBadge() {
  let text = '', color = '#2E7D83';
  if (S.running && S.mode === 'work' && !S.paused) {
    const min = Math.max(0, Math.ceil((S.workEndAt - Date.now()) / 60000));
    text = String(min);
    if (min <= 2) color = '#C7283B';
  } else if (S.mode === 'rest') { text = 'راحة'; color = '#C7283B'; }
  else if (S.paused) { text = '||'; color = '#7a8b93'; }
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// ---------- offscreen camera ----------
async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (ctx.length) return;
  const waiting = new Promise(r => { resolveOffscreen = r; });
  await chrome.offscreen.createDocument({
    url: 'src/offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Detect blinks with the camera, entirely on-device, to remind the user to rest their eyes.'
  });
  await Promise.race([waiting, sleep(4000)]);
}

async function hasOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return ctx.length > 0;
}

const sendOff = (msg) => chrome.runtime.sendMessage({ target: 'offscreen', ...msg }).catch(() => null);

async function camStart(newSession) {
  const st = await getSettings();
  if (!st.useCamera) { S.cam = { status: 'off', error: null }; return; }
  S.cam = { status: 'loading', error: null };
  await ensureOffscreen();
  const r = await sendOff({ type: 'CAM_START', settings: st, newSession });
  if (!r || !r.ok) {
    S.cam = { status: 'error', error: (r && r.error) || 'camera' };
    if (r && r.error === 'permission') chrome.runtime.openOptionsPage();
  }
  await save();
}

async function camPause() { if (await hasOffscreen()) await sendOff({ type: 'CAM_PAUSE' }); }

async function camStop() {
  if (await hasOffscreen()) {
    await sendOff({ type: 'CAM_STOP' });
    try { await chrome.offscreen.closeDocument(); } catch (_) {}
  }
  S.cam = { status: 'off', error: null };
}

// ---------- messaging to pages ----------
// Sends to the active tab of every window. Returns true only if the tab the user is
// actually looking at (focused window) received it, so callers can fall back otherwise.
async function toActiveTabs(msg) {
  const tabs = await chrome.tabs.query({ active: true });
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  let focusedOk = false;
  for (const t of tabs) {
    try {
      await chrome.tabs.sendMessage(t.id, msg);
      if (focused && t.id === focused.id) focusedOk = true;
    } catch (_) { /* page cannot host the overlay (chrome://, web store, ...) */ }
  }
  return focusedOk;
}

async function toAllTabs(msg) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(t => chrome.tabs.sendMessage(t.id, msg).catch(() => {})));
}

const restPayload = () => ({ type: 'REST_SHOW', endAt: S.restEndAt, total: S.restTotalSec, reason: S.restReason });

async function openRestWindow() {
  if (restWinId != null) {
    try { await chrome.windows.update(restWinId, { focused: true }); return; } catch (_) { restWinId = null; }
  }
  const w = await chrome.windows.create({ url: 'src/rest.html', type: 'popup', width: 480, height: 440, focused: true });
  restWinId = w.id;
}

// ---------- session state machine ----------
async function startWork(newSession = true) {
  const st = await getSettings();
  const now = Date.now();
  if (S.day !== today()) { S.sessions = 0; S.early = 0; S.alerts = 0; S.naturalBreaks = 0; S.day = today(); }
  S.running = true; S.mode = 'work'; S.paused = false;
  S.workStartAt = now; S.workEndAt = now + st.workMin * 60000; S.pausedLeftMs = 0;
  fatigueSince = 0; missingSince = 0; lastFatigueAlert = 0;   // the alert cooldown is per session
  chrome.alarms.clear('restEnd');
  chrome.alarms.create('workEnd', { when: S.workEndAt });
  chrome.alarms.create('tick', { periodInMinutes: 1 });
  await save(); updateBadge();
  await camStart(newSession);
  updateBadge();
}

async function stopAll() {
  S.running = false; S.mode = 'idle'; S.paused = false;
  chrome.alarms.clear('workEnd'); chrome.alarms.clear('restEnd'); chrome.alarms.clear('tick');
  await toAllTabs({ type: 'REST_HIDE' });
  await camStop();
  M = null; chrome.storage.session.remove('metrics');
  await save(); updateBadge();
}

async function startRest(reason) {
  const st = await getSettings();
  const now = Date.now();
  S.mode = 'rest'; S.paused = false; S.restReason = reason; S.restTotalSec = st.restSec;
  S.restEndAt = now + st.restSec * 1000;
  if (reason === 'fatigue') S.early++;
  chrome.alarms.clear('workEnd');
  chrome.alarms.create('restEnd', { when: S.restEndAt });
  chrome.notifications.clear('fatigue');
  await save(); updateBadge();
  await camPause();                                     // camera light off while resting
  const delivered = await toActiveTabs(restPayload());
  if (!delivered) {
    await openRestWindow();                             // chrome:// pages etc. cannot show the overlay
    chrome.notifications.create('rest', {
      type: 'basic', iconUrl: 'icons/icon128.png',
      title: 'العين الحمرا', message: `ريّح عينك ${st.restSec} ثانية: بص على حاجة بعيدة.`
    });
  }
}

async function endRest(counted) {
  chrome.alarms.clear('restEnd');
  if (counted) S.sessions++;
  await toAllTabs({ type: 'REST_HIDE' });
  await startWork(true);
}

async function naturalBreak() {
  S.naturalBreaks++;
  const st = await getSettings();
  const now = Date.now();
  S.workStartAt = now; S.workEndAt = now + st.workMin * 60000;
  fatigueSince = 0; missingSince = 0;
  chrome.alarms.create('workEnd', { when: S.workEndAt });
  await save(); updateBadge();
  await sendOff({ type: 'CAM_NEWSESSION' });
}

// ---------- metrics / fatigue ----------
async function onMetrics(m) {
  await ready;
  M = { ...m, at: Date.now() };
  const now = Date.now();
  if (now - lastMetricsSave > 900) { lastMetricsSave = now; chrome.storage.session.set({ metrics: M }); }
  if (S.mode !== 'work' || S.paused) return;

  const st = await getSettings();

  // Looking away from the screen for a whole rest period is a real break.
  if (m.faceMissing) {
    if (!missingSince) missingSince = now;
    else if (st.autoBreak && now - missingSince >= st.restSec * 1000 && now - S.workStartAt > 60000) {
      await naturalBreak();
      return;
    }
  } else missingSince = 0;

  const thr = THRESH[st.sensitivity] || THRESH.normal;
  if (m.fatigueReady && m.fatigue >= thr) {
    if (!fatigueSince) fatigueSince = now;
    if (now - fatigueSince >= FATIGUE_HOLD_MS && now - lastFatigueAlert >= FATIGUE_COOLDOWN_MS && now - S.workStartAt >= 60000) {
      lastFatigueAlert = now; fatigueSince = 0;
      await fatigueAlert(m, st);
    }
  } else fatigueSince = 0;
}

async function fatigueAlert(m, st) {
  S.alerts++;
  await save();
  if (st.onFatigue === 'auto') { await startRest('fatigue'); return; }
  const why = reasonsText(m.fatigueReasons);
  const text = 'عينك شكلها تعبانة' + (why ? ` (${why})` : '') + '. ريّحها ' + st.restSec + ' ثانية؟';
  const delivered = await toActiveTabs({ type: 'TOAST', text, action: `ريّح ${st.restSec} ثانية` });
  if (!delivered) {
    chrome.notifications.create('fatigue', {
      type: 'basic', iconUrl: 'icons/icon128.png', title: 'العين الحمرا', message: text,
      buttons: [{ title: `ريّح ${st.restSec} ثانية` }], requireInteraction: true
    });
  }
}

chrome.notifications.onButtonClicked.addListener(async (id) => {
  await ready;
  if (id === 'fatigue' && S.mode === 'work') startRest('fatigue');
  chrome.notifications.clear(id);
});
chrome.notifications.onClicked.addListener((id) => chrome.notifications.clear(id));

// ---------- alarms ----------
chrome.alarms.onAlarm.addListener(async (alarm) => {
  await ready;
  if (alarm.name === 'tick') {
    updateBadge();
    // watchdog: camera should be sending metrics every ~0.5 s while working
    const st = await getSettings();
    if (S.running && S.mode === 'work' && !S.paused && st.useCamera && S.cam.status !== 'error'
        && (!M || Date.now() - M.at > 90000)) await camStart(false);
    return;
  }
  if (!S.running) return;
  if (alarm.name === 'workEnd' && S.mode === 'work' && !S.paused) {
    // Woken up long after the deadline = the computer slept / user was away: that is a break.
    if (Date.now() - alarm.scheduledTime > 120000) await naturalBreak();
    else await startRest('time');
  } else if (alarm.name === 'restEnd' && S.mode === 'rest') {
    await endRest(true);
  }
});

// ---------- screen lock ----------
chrome.idle.onStateChanged.addListener(async (state) => {
  await ready;
  if (!S.running) return;
  if (state === 'locked' && S.mode === 'work' && !S.paused) {
    lockedAt = Date.now();
    S.paused = true; S.pausedLeftMs = Math.max(0, S.workEndAt - lockedAt);
    chrome.alarms.clear('workEnd');
    await save(); updateBadge(); await camPause();
  } else if (state === 'active' && S.paused) {
    const st = await getSettings();
    const away = Date.now() - lockedAt;
    if (away >= st.restSec * 1000) { S.naturalBreaks++; await startWork(true); }
    else {
      S.paused = false; S.workEndAt = Date.now() + S.pausedLeftMs;
      chrome.alarms.create('workEnd', { when: S.workEndAt });
      await save(); updateBadge(); await camStart(false);
    }
  }
});

// ---------- tabs: keep the rest overlay following the user ----------
async function showRestOn(tabId) {
  if (S.mode !== 'rest') return;
  try { await chrome.tabs.sendMessage(tabId, restPayload()); } catch (_) {}
}
chrome.tabs.onActivated.addListener(({ tabId }) => { ready.then(() => showRestOn(tabId)); });

chrome.windows.onRemoved.addListener((id) => { if (id === restWinId) restWinId = null; });

// ---------- messages ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return;
  (async () => {
    await ready;
    switch (msg.type) {
      case 'OFFSCREEN_READY': if (resolveOffscreen) resolveOffscreen(); sendResponse({}); break;
      case 'METRICS': await onMetrics(msg.state); sendResponse({}); break;
      case 'CAM_STATUS':
        S.cam = { status: msg.status, error: msg.error || null };
        await save(); sendResponse({}); break;
      case 'GET_STATE': sendResponse({ state: S, settings: await getSettings(), metrics: M }); break;
      case 'GET_REST': sendResponse(S.mode === 'rest' ? restPayload() : null); break;
      case 'START': if (!S.running) await startWork(true); sendResponse({}); break;
      case 'STOP': await stopAll(); sendResponse({}); break;
      case 'REST_NOW': if (S.running && S.mode === 'work') await startRest('manual'); sendResponse({}); break;
      case 'SKIP_REST': if (S.mode === 'rest') await endRest(false); sendResponse({}); break;
      case 'RECALIBRATE': await sendOff({ type: 'CAM_RECALIBRATE' }); sendResponse({}); break;
      case 'CAM_RETRY': if (S.running) await camStart(false); sendResponse({}); break;
      case 'OPEN_OPTIONS': chrome.runtime.openOptionsPage(); sendResponse({}); break;
      default: sendResponse({});
    }
  })();
  return true;
});

// settings changes while running
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync') return;
  await ready;
  if (!S.running) return;
  if (changes.useCamera) {
    if (changes.useCamera.newValue) { if (S.mode === 'work') await camStart(false); }
    else await camStop();
  }
});

// ---------- install / startup ----------
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
  // content scripts are not injected into tabs that were already open: do it once
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const t of tabs) {
    chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['src/overlay.js'] }).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await ready;
  // The browser restarted: camera/offscreen are gone, so begin a clean session if one was on.
  if (S.running) await startWork(true); else updateBadge();
});

ready.then(updateBadge);
