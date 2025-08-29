const tickerEl = document.getElementById('ticker');

const $ = (sel) => document.querySelector(sel);
const mattersEl = $('#matters');
const thresholdEl = $('#threshold');
const alertsEl = $('#alerts');
const courtsEl = $('#courts');
const updatedEl = $('#updated');
const saveBtn = $('#save');
const clearBtn = $('#clear');
let lastBoard = null;


const fired = new Set(); // dedupe notifications per court-item
let pollTimer = null;

function getStored() {
  try {
    return {
      matters: localStorage.getItem('matters') || '1/12, 8/34, 14/19',
      threshold: Number(localStorage.getItem('threshold') || '5')
    };
  } catch { return { matters: '1/12, 8/34, 14/19', threshold: 5 }; }
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

function notify(title, body) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  try { new Notification(title, { body }); } catch {}
}

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
    let current = row ? row.current : null;
    const seq = row ? row.sequence : [];
    const windowList = preAlertWindow(seq, m.item, threshold);
    let status = 'Waiting for session';
    let distance = undefined;

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
    tickerEl.textContent = data.tickerText || '—';
    updatedEl.textContent = data.updatedAt || new Date().toLocaleString();
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

// Simulate alerts quickly using the latest fetched sequence + threshold
document.getElementById('test').addEventListener('click', async () => {
  if (!lastBoard) { console.warn('No board yet; wait for first poll.'); return; }
  const matters = parseMatters(mattersEl.value);
  const threshold = Math.max(1, Number(thresholdEl.value) || 5);

  if ('Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    alert('Enable notifications in your browser to see test alerts.');
  }

  // For each matter, find the pre-alert window and fire stepwise notifications (1s apart)
  let delay = 0;
  matters.forEach(m => {
    const row = lastBoard.courts[m.court];
    const seq = row ? row.sequence : [];
    const windowList = preAlertWindow(seq, m.item, threshold);
    windowList.forEach((itemNum, idx) => {
      setTimeout(() => {
        notify(`TEST • Court ${m.court}: Item ${itemNum}`,
               `Approaching ${m.item}${row?.registration ? ' · ' + row.registration : ''}`);
      }, delay + idx * 1000);
    });
    delay += windowList.length * 1000 + 500; // small gap before next matter’s test
  });
});


// UI events & init
saveBtn.addEventListener('click', () => {
  setStored({ matters: mattersEl.value, threshold: thresholdEl.value });
  fired.clear(); // reset dedupe when user changes list
});

clearBtn.addEventListener('click', () => {
  mattersEl.value = '';
  setStored({ matters: '', threshold: thresholdEl.value });
  alertsEl.innerHTML = '';
});

(function init() {
  const { matters, threshold } = getStored();
  mattersEl.value = matters;
  thresholdEl.value = threshold;

  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  loop();
})();
