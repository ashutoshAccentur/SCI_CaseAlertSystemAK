// public/app.js
const $ = (sel) => document.querySelector(sel);
const mattersEl = $('#matters');
const thresholdEl = $('#threshold');
const alertsEl = $('#alerts');
const courtsEl = $('#courts');
const updatedEl = $('#updated');
const saveBtn = $('#save');
const clearBtn = $('#clear');
const testBtn = document.getElementById('test');

const fired = new Set(); // dedupe notifications per court-item
let pollTimer = null;
let lastBoard = null;    // keep the latest board for testing

// --- Audio (tone) ---
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(()=>{});
}
function beep(durationMs = 450, freq = 880) {
  try {
    if (!audioCtx) return;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    o.connect(g);
    g.connect(audioCtx.destination);
    const now = audioCtx.currentTime;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.08, now + 0.02);
    o.start(now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);
    o.stop(now + durationMs / 1000);
  } catch {}
}
function vibrate(pattern = [180, 90, 180]) {
  if (navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch {}
  }
}

// --- Notifications ---
async function ensurePermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  const p = await Notification.requestPermission();
  return p === 'granted';
}

// Prefer service worker notifications (more native options: vibrate, badge)
async function showNativeNotification(title, body) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title, {
      body,
      tag: title,               // merges repeats
      renotify: true,
      requireInteraction: false,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      vibrate: [120, 60, 120]
    });
  } catch {
    // fallback to window Notification
    try { new Notification(title, { body }); } catch {}
  }
}

async function notify(title, body) {
  const ok = await ensurePermission();
  if (!ok) return;
  // play tone + vibration in page (works even if notification shows)
  ensureAudio(); beep(); vibrate();
  // trigger native OS notification
  showNativeNotification(title, body);
}

// --- Storage & parsing ---
function getStored() {
  try {
    return {
      matters: localStorage.getItem('matters') || '',
      threshold: Number(localStorage.getItem('threshold') || '5')
    };
  } catch { return { matters: '', threshold: 5 }; }
}

function setStored({ matters, threshold }) {
  localStorage.setItem('matters', matters);
  localStorage.setItem('threshold', String(threshold));
}

function parseMatters(input) {
  return input
    .split(/[,\n]/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const [c, it] = s.split('/').map(x => x.trim());
      const court = c.replace(/^C/i, '').toUpperCase(); // C1 -> 1
      if (court === 'RC1' || court === 'RC2') return { court, item: Number(it) };
      return { court: String(parseInt(court, 10)), item: Number(it) };
    })
    .filter(m => Number.isFinite(m.item));
}

function preAlertWindow(seq, target, nBefore) {
  const idx = seq.indexOf(target);
  if (idx >= 0) {
    const start = Math.max(0, idx - nBefore);
    return seq.slice(start, idx + 1);
  }
  // fallback if target not in declared sequence
  const start = Math.max(1, target - nBefore);
  const arr = [];
  for (let v = start; v <= target; v++) arr.push(v);
  return arr;
}

// --- Fetch & render ---
async function fetchBoard() {
  const res = await fetch('/api/board', { cache: 'no-store' });
  if (!res.ok) throw new Error('board fetch failed');
  return res.json();
}

function renderCourts(data) {
  courtsEl.innerHTML = '';
  const entries = Object.entries(data.courts);
  entries.forEach(([id, row]) => {
    const idx = row.sequence.indexOf(row.current);
    const nextFew = idx >= 0 ? row.sequence.slice(idx + 1, idx + 6) : [];
    const div = document.createElement('div');
    div.className = 'tile';
    div.innerHTML = `
      <div class="head">
        <div>Court ${id}</div>
        <div class="meta">${row.name || ''}</div>
      </div>
      <div>Current: <strong>${row.current ?? '—'}</strong></div>
      <div class="meta">Status: ${row.status || '—'}</div>
      <div class="meta">Next: ${nextFew.length ? nextFew.join(', ') : '—'}</div>
      <details>
        <summary>Details</summary>
        <div>${row.registration || '—'}</div>
        <div>${(row.petitioner || '—')} vs ${(row.respondent || '—')}</div>
        <div style="white-space:pre-wrap">${row.sequenceText || '—'}</div>
      </details>
    `;
    courtsEl.appendChild(div);
  });
}

function renderAlerts(matters, data, threshold) {
  alertsEl.innerHTML = '';
  matters.forEach(m => {
    const row = data.courts[m.court];
    const current = row ? row.current : null;
    const seq = row ? row.sequence : [];
    const windowList = preAlertWindow(seq, m.item, threshold);

    let status = 'Waiting for session';
    let distance;

    if (current != null) {
      const idxInWindow = windowList.indexOf(current);
      if (idxInWindow >= 0) {
        distance = windowList.length - idxInWindow - 1;
        status = distance === 0 ? 'Now' : `${distance} away`;
        const key = `${m.court}-${current}`;
        if (!fired.has(key)) {
          fired.add(key);
          const detail = row?.registration ? ` · ${row.registration}` : '';
          notify(`Court ${m.court}: Item ${current}`, `Approaching ${m.item}${detail}`);
        }
      } else {
        const idxTarget = seq.indexOf(m.item);
        const idxCurrent = seq.indexOf(current);
        if (idxTarget >= 0 && idxCurrent >= 0) {
          distance = Math.max(0, idxTarget - idxCurrent);
          status = distance === 0 ? 'Now' : `${distance} away`;
        } else if (idxTarget < 0) {
          status = 'Target not in declared sequence';
        } else {
          status = 'In session (outside window)';
        }
      }
    }

    const div = document.createElement('div');
    div.className = 'tile';
    div.innerHTML = `
      <div class="head">
        <div>C${m.court}/${m.item}</div>
        <div class="meta">${status}</div>
      </div>
      <div class="meta">Current: ${current ?? '—'}</div>
    `;
    alertsEl.appendChild(div);
  });
}

async function loop() {
  try {
    const data = await fetchBoard();
    lastBoard = data;
    updatedEl.textContent = data.updatedAt || new Date().toLocaleString();

    // Update ticker if present
    const tickerEl = document.getElementById('ticker');
    if (tickerEl) tickerEl.textContent = data.tickerText || '—';

    const matters = parseMatters(mattersEl.value);
    const threshold = Math.max(1, Number(thresholdEl.value) || 5);
    renderCourts(data);
    renderAlerts(matters, data, threshold);
  } catch (e) {
    console.error(e);
  } finally {
    pollTimer = setTimeout(loop, 10000); // ~10s
  }
}

// --- UI events & init ---
saveBtn.addEventListener('click', async () => {
  ensureAudio();
  setStored({ matters: mattersEl.value, threshold: thresholdEl.value });
  fired.clear(); // reset dedupe when user changes list
});

clearBtn.addEventListener('click', () => {
  mattersEl.value = '';
  setStored({ matters: '', threshold: thresholdEl.value });
  alertsEl.innerHTML = '';
});

// Robust test: uses the latest real sequence; if not ready, fetch once
testBtn.addEventListener('click', async () => {
  ensureAudio();
  const ok = await ensurePermission();
  if (!ok) {
    alert('Please allow notifications to test.');
    return;
  }

  try {
    if (!lastBoard) lastBoard = await fetchBoard();
    const matters = parseMatters(mattersEl.value);
    
    if (!matters.length) {
      alert('Enter at least one matter in the textbox (e.g., 1/12) and press Save, then try Test again.');
      return;
    }
    const threshold = Math.max(1, Number(thresholdEl.value) || 5);

    // simulate stepwise notifications at 1s intervals
    let delay = 0;
    matters.forEach(m => {
      const row = lastBoard.courts[m.court];
      const seq = row ? row.sequence : [];
      const windowList = preAlertWindow(seq, m.item, threshold);
      const detail = row?.registration ? ` · ${row.registration}` : '';

      windowList.forEach((num, idx) => {
        setTimeout(() => {
          notify(`TEST • Court ${m.court}: Item ${num}`, `Approaching ${m.item}${detail}`);
        }, delay + idx * 1000);
      });
      delay += windowList.length * 1000 + 600;
    });
  } catch (e) {
    console.error(e);
    alert('Test failed. Try again after the page loads once.');
  }
});

(function init() {
  const { matters, threshold } = getStored();
  mattersEl.value = matters;
  thresholdEl.value = threshold;

  // Prime audio on first user interaction for iOS/Android policies
  document.addEventListener('click', ensureAudio, { once: true });

  // Ask permission early so notifications can appear
  ensurePermission();

  // start polling
  loop();
})();
