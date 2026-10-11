// Fallback rest window: used when the active tab cannot show the overlay (chrome:// pages etc.).
const $ = (id) => document.getElementById(id);
let endAt = 0;

async function sync() {
  const r = await chrome.runtime.sendMessage({ type: 'GET_REST' }).catch(() => null);
  if (!r) { window.close(); return; }
  endAt = r.endAt;
}

chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && c.state && c.state.newValue && c.state.newValue.mode !== 'rest') window.close();
});

$('skip').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'SKIP_REST' }).catch(() => {}));

setInterval(() => {
  const left = Math.max(0, endAt - Date.now());
  $('n').textContent = String(Math.ceil(left / 1000));
  if (endAt && left <= 0) setTimeout(() => window.close(), 600);
}, 200);

sync();
