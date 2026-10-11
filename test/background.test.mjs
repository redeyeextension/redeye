// Drives src/background.js with a fake `chrome` API and a fake clock:
// work -> rest -> work, fatigue alerts, natural breaks, screen lock, overlay fallback.
import test from 'node:test';
import assert from 'node:assert/strict';

// ---------- fake clock ----------
let clock = 1_700_000_000_000;
Date.now = () => clock;
const advance = (ms) => { clock += ms; };

// ---------- fake chrome ----------
const mem = { local: {}, sync: {}, session: {} };
const events = () => { const fns = []; return { fns, addListener: (f) => fns.push(f) }; };
const pick = (area, keys) => {
  if (keys == null) return { ...mem[area] };
  if (typeof keys === 'string') return keys in mem[area] ? { [keys]: mem[area][keys] } : {};
  if (Array.isArray(keys)) return Object.fromEntries(keys.filter(k => k in mem[area]).map(k => [k, mem[area][k]]));
  return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in mem[area] ? mem[area][k] : d]));
};
const area = (name) => ({
  get: async (k) => structuredClone(pick(name, k)),
  set: async (o) => { Object.assign(mem[name], structuredClone(o)); chrome.storage.onChanged.fns.forEach(f => f({}, name)); },
  remove: async (k) => { delete mem[name][k]; }
});

const rec = { off: [], tabs: [], notifications: [], windows: [], alarms: new Map(), offscreen: false, closed: 0, badge: [] };
let tabsFail = false;

globalThis.chrome = {
  storage: { local: area('local'), sync: area('sync'), session: area('session'), onChanged: events() },
  alarms: {
    create: (name, info) => rec.alarms.set(name, info),
    clear: (name) => { const had = rec.alarms.delete(name); return Promise.resolve(had); },
    onAlarm: events()
  },
  action: { setBadgeText: ({ text }) => rec.badge.push(text), setBadgeBackgroundColor: () => {} },
  runtime: {
    onMessage: events(), onInstalled: events(), onStartup: events(),
    getContexts: async () => (rec.offscreen ? [{}] : []),
    sendMessage: async (msg) => {
      if (msg && msg.target === 'offscreen') { rec.off.push(msg); return { ok: true }; }
      return {};
    },
    openOptionsPage: () => { rec.options = (rec.options || 0) + 1; }
  },
  offscreen: {
    createDocument: async () => {
      rec.offscreen = true;
      setTimeout(() => chrome.runtime.onMessage.fns.forEach(f => f({ type: 'OFFSCREEN_READY' }, {}, () => {})), 0);
    },
    closeDocument: async () => { rec.offscreen = false; rec.closed++; }
  },
  tabs: {
    query: async () => [{ id: 1 }],
    sendMessage: async (id, msg) => { if (tabsFail) throw new Error('no receiver'); rec.tabs.push({ id, ...msg }); },
    onActivated: events()
  },
  windows: {
    create: async (o) => { rec.windows.push(o); return { id: 99 }; },
    update: async () => {}, onRemoved: events()
  },
  notifications: {
    create: (id, o) => rec.notifications.push({ id, ...o }), clear: () => {},
    onButtonClicked: events(), onClicked: events()
  },
  idle: { onStateChanged: events() },
  scripting: { executeScript: async () => {} }
};

await import('../src/background.js');

// ---------- helpers ----------
const bg = (msg) => new Promise((resolve) => {
  const fns = chrome.runtime.onMessage.fns;
  let handled = false;
  for (const f of fns) {
    const r = f(msg, {}, (x) => resolve(structuredClone(x)));   // real messaging clones, so do we
    if (r === true) handled = true;
  }
  if (!handled) resolve(undefined);
});
const state = async () => (await bg({ type: 'GET_STATE' })).state;
const fireAlarm = (name, scheduledTime = clock) => Promise.all(chrome.alarms.onAlarm.fns.map(f => f({ name, scheduledTime })));
const sentTypes = () => rec.off.map(m => m.type);
const reset = async () => {
  await bg({ type: 'STOP' });
  rec.off.length = 0; rec.tabs.length = 0; rec.notifications.length = 0; rec.windows.length = 0; tabsFail = false;
  mem.sync = {};
  chrome.storage.onChanged.fns.forEach(f => f({}, 'sync'));
};
const metrics = (o = {}) => bg({ type: 'METRICS', state: {
  phase: 'tracking', calibrationProgress: 1, faceMissing: false, bpm: 15, totalBlinks: 10,
  fatigue: 0, fatigueReasons: [], fatigueReady: true, ...o } });

// ---------- tests ----------
test('START begins a 20-minute session and starts the camera', async () => {
  await reset();
  await bg({ type: 'START' });
  const s = await state();
  assert.equal(s.running, true);
  assert.equal(s.mode, 'work');
  assert.equal(s.workEndAt - s.workStartAt, 20 * 60000);
  assert.equal(chrome.alarms.fns === undefined, true);   // sanity: mock shape
  assert.equal(rec.alarms.get('workEnd').when, s.workEndAt);
  assert.ok(rec.offscreen);
  const start = rec.off.find(m => m.type === 'CAM_START');
  assert.ok(start && start.newSession === true);
  assert.equal(start.settings.workMin, 20);
});

test('after 20 minutes: rest for 20 s, camera paused, overlay shown, then a new session', async () => {
  await reset();
  await bg({ type: 'START' });
  const s0 = await state();
  advance(20 * 60000);
  await fireAlarm('workEnd', s0.workEndAt);
  let s = await state();
  assert.equal(s.mode, 'rest');
  assert.equal(s.restEndAt - clock, 20000);
  assert.ok(sentTypes().includes('CAM_PAUSE'));
  const show = rec.tabs.find(m => m.type === 'REST_SHOW');
  assert.ok(show && show.endAt === s.restEndAt && show.total === 20);

  rec.off.length = 0;
  advance(20000);
  await fireAlarm('restEnd', s.restEndAt);
  s = await state();
  assert.equal(s.mode, 'work');
  assert.equal(s.sessions, 1);
  assert.ok(rec.tabs.some(m => m.type === 'REST_HIDE'));
  const again = rec.off.find(m => m.type === 'CAM_START');
  assert.ok(again && again.newSession === true);
});

test('skipping the rest starts a new session but does not count it', async () => {
  await reset();
  await bg({ type: 'START' });
  await bg({ type: 'REST_NOW' });
  assert.equal((await state()).mode, 'rest');
  const before = (await state()).sessions;
  await bg({ type: 'SKIP_REST' });
  const s = await state();
  assert.equal(s.mode, 'work');
  assert.equal(s.sessions, before);
});

test('if the page cannot show the overlay, a rest window + notification are used', async () => {
  await reset();
  await bg({ type: 'START' });
  tabsFail = true;
  await bg({ type: 'REST_NOW' });
  assert.equal(rec.windows.length, 1);
  assert.match(rec.windows[0].url, /rest\.html$/);
  assert.equal(rec.notifications.some(n => n.id === 'rest'), true);
});

test('sustained fatigue triggers ONE toast, then respects the cooldown', async () => {
  await reset();
  await bg({ type: 'START' });
  advance(70000);                                    // past the 60 s warm-up
  const tired = { fatigue: 70, fatigueReasons: ['low_rate', 'heavy_lids'] };
  await metrics(tired);
  advance(16000);
  await metrics(tired);
  const toasts = rec.tabs.filter(m => m.type === 'TOAST');
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].text, /تعبانة/);
  assert.equal((await state()).alerts, 1);
  advance(20000); await metrics(tired); advance(20000); await metrics(tired);
  assert.equal(rec.tabs.filter(m => m.type === 'TOAST').length, 1);   // cooldown
});

test('short spikes of fatigue do not alert', async () => {
  await reset();
  await bg({ type: 'START' });
  advance(70000);
  await metrics({ fatigue: 70 });
  advance(5000);
  await metrics({ fatigue: 10 });                    // recovered before 15 s
  advance(20000);
  await metrics({ fatigue: 70 });
  assert.equal(rec.tabs.filter(m => m.type === 'TOAST').length, 0);
});

test('fatigue below the sensitivity threshold never alerts; high sensitivity alerts earlier', async () => {
  await reset();
  await bg({ type: 'START' });
  advance(70000);
  await metrics({ fatigue: 40 }); advance(20000); await metrics({ fatigue: 40 });
  assert.equal(rec.tabs.filter(m => m.type === 'TOAST').length, 0);      // normal threshold = 45
  mem.sync.sensitivity = 'high';
  chrome.storage.onChanged.fns.forEach(f => f({}, 'sync'));
  await metrics({ fatigue: 40 }); advance(16000); await metrics({ fatigue: 40 });
  assert.equal(rec.tabs.filter(m => m.type === 'TOAST').length, 1);      // high threshold = 35
});

test('onFatigue=auto starts the rest immediately', async () => {
  await reset();
  mem.sync.onFatigue = 'auto';
  chrome.storage.onChanged.fns.forEach(f => f({}, 'sync'));
  await bg({ type: 'START' });
  advance(70000);
  await metrics({ fatigue: 80, fatigueReasons: ['low_rate'] });
  advance(16000);
  await metrics({ fatigue: 80, fatigueReasons: ['low_rate'] });
  const s = await state();
  assert.equal(s.mode, 'rest');
  assert.equal(s.restReason, 'fatigue');
  assert.equal(s.early, 1);
});

test('no face for a full rest period counts as a natural break and resets the timer', async () => {
  await reset();
  await bg({ type: 'START' });
  advance(5 * 60000);
  await metrics({ faceMissing: true });
  advance(10000);
  await metrics({ faceMissing: true });
  assert.equal((await state()).naturalBreaks, 0);
  advance(11000);                                    // > 20 s away
  await metrics({ faceMissing: true });
  const s = await state();
  assert.equal(s.naturalBreaks, 1);
  assert.equal(s.mode, 'work');
  assert.equal(s.workEndAt - clock, 20 * 60000);
  assert.ok(sentTypes().includes('CAM_NEWSESSION'));
});

test('an alarm that fires > 2 minutes late (computer slept) is treated as a break, not a rest', async () => {
  await reset();
  await bg({ type: 'START' });
  const s0 = await state();
  advance(3 * 3600000);
  await fireAlarm('workEnd', s0.workEndAt);
  const s = await state();
  assert.equal(s.mode, 'work');
  assert.equal(s.naturalBreaks, s0.naturalBreaks + 1);
  assert.equal(rec.tabs.filter(m => m.type === 'REST_SHOW').length, 0);
});

test('locking the screen pauses; a short absence resumes with the remaining time, a long one restarts', async () => {
  await reset();
  await bg({ type: 'START' });
  advance(5 * 60000);
  chrome.idle.onStateChanged.fns.forEach(f => f('locked'));
  await new Promise(r => setTimeout(r, 20));
  let s = await state();
  assert.equal(s.paused, true);
  assert.ok(Math.abs(s.pausedLeftMs - 15 * 60000) < 1000);
  advance(5000);
  chrome.idle.onStateChanged.fns.forEach(f => f('active'));
  await new Promise(r => setTimeout(r, 20));
  s = await state();
  assert.equal(s.paused, false);
  assert.ok(Math.abs((s.workEndAt - clock) - 15 * 60000) < 1000);

  chrome.idle.onStateChanged.fns.forEach(f => f('locked'));
  await new Promise(r => setTimeout(r, 20));
  advance(10 * 60000);
  chrome.idle.onStateChanged.fns.forEach(f => f('active'));
  await new Promise(r => setTimeout(r, 20));
  s = await state();
  assert.equal(s.paused, false);
  assert.equal(s.workEndAt - clock, 20 * 60000);
  assert.ok(s.naturalBreaks >= 1);
});

test('STOP ends everything: alarms cleared, camera closed', async () => {
  await reset();
  await bg({ type: 'START' });
  await bg({ type: 'STOP' });
  const s = await state();
  assert.equal(s.running, false);
  assert.equal(s.mode, 'idle');
  assert.equal(rec.alarms.has('workEnd'), false);
  assert.equal(rec.offscreen, false);
});

test('custom durations from settings are honoured', async () => {
  await reset();
  mem.sync.workMin = 25; mem.sync.restSec = 30;
  chrome.storage.onChanged.fns.forEach(f => f({}, 'sync'));
  await bg({ type: 'START' });
  let s = await state();
  assert.equal(s.workEndAt - s.workStartAt, 25 * 60000);
  advance(25 * 60000);
  await fireAlarm('workEnd', s.workEndAt);
  s = await state();
  assert.equal(s.restEndAt - clock, 30000);
});
