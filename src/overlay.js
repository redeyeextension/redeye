// Red Eye — content script. Shows the full-screen rest overlay and the "your eyes look tired"
// toast on top of any web page. Everything lives in a closed-style Shadow DOM so the page's
// CSS cannot break it and it cannot break the page.
(() => {
  if (window.__redEyeOverlay) return;
  window.__redEyeOverlay = true;

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .root { font-family: "IBM Plex Sans Arabic", "Segoe UI", Tahoma, Arial, sans-serif; direction: rtl; }
    .rest {
      position: fixed; inset: 0; z-index: 2147483647; background: #0B1F26; color: #E8F1F3;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      text-align: center; padding: 24px;
    }
    h2 { margin: 0 0 6px; font-size: clamp(30px, 6vw, 44px); font-weight: 700; line-height: 1.2; }
    p { margin: 0; color: #8FB0B9; max-width: 34ch; font-size: 18px; line-height: 1.7; }
    .ring { position: relative; width: 220px; height: 220px; margin: 26px 0; }
    .ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
    .num { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      font-size: 74px; font-weight: 500; direction: ltr; font-variant-numeric: tabular-nums; }
    .breath { transform-origin: 110px 110px; animation: breathe 4s ease-in-out infinite; }
    @keyframes breathe { 0%,100% { transform: scale(.94); } 50% { transform: scale(1.04); } }
    @media (prefers-reduced-motion: reduce) { .breath { animation: none; } }
    button { font: inherit; cursor: pointer; border-radius: 10px; padding: 10px 24px; font-weight: 600; font-size: 16px;
      background: transparent; color: #E8F1F3; border: 1.5px solid #8FB0B9; }
    button:focus-visible { outline: 3px solid #4FA3A9; outline-offset: 3px; }
    .toast {
      position: fixed; bottom: 20px; inset-inline-end: 20px; z-index: 2147483647; max-width: 340px;
      background: #10303A; color: #E8F1F3; border-radius: 14px; padding: 16px 18px;
      box-shadow: 0 8px 30px rgba(0,0,0,.35); border-inline-start: 5px solid #E0495B;
    }
    .toast .t { font-size: 16px; line-height: 1.6; margin-bottom: 12px; }
    .toast .row { display: flex; gap: 10px; }
    .toast .go { background: #E0495B; border-color: #E0495B; color: #fff; }
  `;

  let host = null, shadow = null, timer = null, toastTimer = null;

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = 'red-eye-root';
    shadow = host.attachShadow({ mode: 'closed' });
    const st = document.createElement('style');
    st.textContent = STYLE;
    shadow.appendChild(st);
    (document.documentElement || document.body).appendChild(host);
  }

  function clear(cls) {
    if (!shadow) return;
    shadow.querySelectorAll('.' + cls).forEach(n => n.remove());
  }

  function hideRest() {
    if (timer) { clearInterval(timer); timer = null; }
    clear('rest');
  }

  function showRest({ endAt, total, reason }) {
    ensureHost();
    hideRest();
    const text = reason === 'fatigue' ? 'عينك شكلها تعبانة، علشان كده قدّمنا الراحة.'
      : reason === 'manual' ? 'خد راحة صغيرة لعينك.'
      : 'عدّت فترة الشغل قدام الشاشة.';
    const el = document.createElement('div');
    el.className = 'root rest';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'وقت راحة العين');
    el.innerHTML = `
      <h2>ريّح عينك</h2>
      <p>بص على حاجة بعيدة، وسيب الشاشة لحد ما العدّ يخلص.</p>
      <div class="ring">
        <svg viewBox="0 0 220 220" aria-hidden="true">
          <circle class="breath" cx="110" cy="110" r="84" fill="none" stroke="#8FB0B9" stroke-opacity=".25" stroke-width="2"/>
          <circle cx="110" cy="110" r="100" fill="none" stroke="#8FB0B9" stroke-opacity=".3" stroke-width="6"/>
          <circle class="arc" cx="110" cy="110" r="100" fill="none" stroke="#E0495B" stroke-width="6"
                  stroke-linecap="round" stroke-dasharray="628.3" stroke-dashoffset="0"/>
        </svg>
        <div class="num">${Math.max(0, Math.ceil((endAt - Date.now()) / 1000))}</div>
      </div>
      <p class="why">${text}</p>
      <button type="button">كمّل شغل</button>`;
    shadow.appendChild(el);
    const num = el.querySelector('.num');
    const arc = el.querySelector('.arc');
    const btn = el.querySelector('button');
    btn.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'SKIP_REST' }).catch(() => {}));
    const tick = () => {
      const left = Math.max(0, endAt - Date.now());
      num.textContent = String(Math.ceil(left / 1000));
      arc.setAttribute('stroke-dashoffset', String(628.3 * (1 - Math.min(1, left / (total * 1000)))));
      if (left <= 0) hideRest();    // the service worker also sends REST_HIDE; this is just a safety net
    };
    tick();
    timer = setInterval(tick, 200);
    btn.focus();
  }

  function showToast({ text, action }) {
    ensureHost();
    clear('toast');
    if (toastTimer) clearTimeout(toastTimer);
    const el = document.createElement('div');
    el.className = 'root toast';
    el.setAttribute('role', 'alert');
    el.innerHTML = `<div class="t"></div><div class="row"><button class="go" type="button"></button><button class="no" type="button">مش دلوقتي</button></div>`;
    el.querySelector('.t').textContent = text;
    el.querySelector('.go').textContent = action;
    el.querySelector('.go').addEventListener('click', () => {
      el.remove(); chrome.runtime.sendMessage({ type: 'REST_NOW' }).catch(() => {});
    });
    el.querySelector('.no').addEventListener('click', () => el.remove());
    shadow.appendChild(el);
    toastTimer = setTimeout(() => el.remove(), 25000);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'REST_SHOW') showRest(msg);
    else if (msg.type === 'REST_HIDE') hideRest();
    else if (msg.type === 'TOAST') showToast(msg);
  });

  // A page that loads (or a tab that was opened) during a rest must show the overlay too.
  chrome.runtime.sendMessage({ type: 'GET_REST' }).then((r) => { if (r) showRest(r); }).catch(() => {});
})();
