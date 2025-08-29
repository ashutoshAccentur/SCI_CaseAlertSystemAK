import express from 'express';
import compression from 'compression';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(compression());
app.use(express.static('public', { maxAge: '1h', etag: true }));

// --- Basic Auth gate (set AUTH_USER + AUTH_PASS in env) ---
app.use((req, res, next) => {
  const u = process.env.AUTH_USER;
  const p = process.env.AUTH_PASS;
  if (!u || !p) return next(); // if not set, app is open

  const hdr = req.headers.authorization || '';
  const [type, token] = hdr.split(' ');
  if (type === 'Basic' && token) {
    const [user, pass] = Buffer.from(token, 'base64').toString().split(':');
    if (user === u && pass === p) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="SC Alerts"');
  return res.status(401).send('Auth required');
});




const PORT = process.env.PORT || 3000;
const COURTS_CSV = process.env.COURTS_CSV || '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,21,22';
const CACHE_TTL = Number(process.env.CACHE_TTL_SECONDS || 8);
const UPSTREAM = `https://cdb.sci.gov.in/index.php?courtListCsv=${COURTS_CSV}&request=display_full&requestType=ajax`;

let cache = { data: null, ts: 0 };

// --- utils ---
const cleanCourtName = (raw = '') => raw.replace(/<[^>]*>/g, '').trim();
const parseCurrentItem = (val) => {
  if (val == null) return null;
  const n = parseInt(String(val).trim(), 10);
  return Number.isFinite(n) ? n : null;
};

// robust sequence parser: handles "5 TO 15", single numbers, ignores phrases
function parseSequence(message = '') {
  const upper = message
    .toUpperCase()
    .replace(/COURT WILL SIT AT[^\n]*/g, ' ')
    .replace(/SEQUENCE|WOULD BE|ITEM NOS?\.?|ITEMS?\.?|PASS ?OVER IF ANY|THEREAFTER|THEN|AND|FRESH ?PASSOVER|FRESH/g, ' ')
    .replace(/[,:.;@()\[\]{}|/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!upper) return [];
  const tokens = upper.split(' ');
  const out = [];
  const isNum = (x) => !!x && /^\d+$/.test(x);

  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i], b = tokens[i + 1], c = tokens[i + 2];

    // NEW: "20 ONWARDS" → expand a generous tail (cap at 5000 to be safe)
    if (isNum(a) && b === 'ONWARDS') {
      const start = +a;
      const cap = 5000;
      for (let v = start; v <= cap; v++) out.push(v);
      i += 1;
      continue;
    }

    if (isNum(a) && b === 'TO' && isNum(c)) {
      const start = +a, end = +c, step = start <= end ? 1 : -1;
      for (let v = start; v !== end + step; v += step) out.push(v);
      i += 2;
    } else if (isNum(a)) {
      out.push(+a);
    }
  }
  const seen = new Set();
  return out.filter(n => (seen.has(n) ? false : (seen.add(n), true)));
}


// Normalize upstream payload to compact, client-friendly shape
function normalize(upstream) {
  const courts = {};
  const list = upstream?.listedItemDetails || [];
  for (const row of list) {
    const rawNo = String(row.court_no);
    const id = rawNo === '21' ? 'RC1' : rawNo === '22' ? 'RC2' : rawNo;
    const current = parseCurrentItem(row.item_no);
    const seq = parseSequence(row.court_message || '');
    courts[id] = {
      courtId: id,
      name: cleanCourtName(row.court_name || ''),
      current,
      status: row.item_status || '',
      sequenceText: row.court_message || '',
      sequence: seq,
      registration: row.registration_number_display || '',
      petitioner: (row.petitioner_name || '').trim(),
      respondent: (row.respondent_name || '').trim()
    };
  }

    const tickerText = buildTicker(upstream, courts); // <-- add this


  return {
    updatedAt: upstream?.now || new Date().toISOString(),
    tickerText,
    courts
  };
}

function buildTicker(upstream, courtsMap) {
  // Try to show something like: "Sequence — 29 Aug @ 12:55 | Court C1: ... | Court C2: ... | ..."
  const ts = upstream?.now_2 || upstream?.now || '';
  const parts = [`Sequence — ${ts}`];
  for (const id of Object.keys(courtsMap)) {
    const row = courtsMap[id];
    if (!row) continue;
    const msg = (row.sequenceText || row.status || '').trim();
    if (msg) parts.push(`Court C${id}: ${msg}`);
  }
  return parts.join('  |  ');
}


// Simple in-memory cache fetch
async function fetchBoard() {
  const now = Date.now();
  if (cache.data && (now - cache.ts) < CACHE_TTL * 1000) {
    return cache.data;
  }
  const res = await fetch(UPSTREAM, {
    headers: { 'User-Agent': 'SC-Noticeboard-Simple/1.0' }
  });
  if (!res.ok) {
    throw new Error(`Upstream error: ${res.status}`);
  }
  const json = await res.json();
  const normalized = normalize(json);
  cache = { data: normalized, ts: Date.now() };
  return normalized;
}

// health
app.get('/healthz', (req, res) => res.json({ ok: true }));

// API: board (normalized + cached)
app.get('/api/board', async (req, res) => {
  try {
    const data = await fetchBoard();
    res.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'Failed to fetch board' });
  }
});

// Serve app
app.listen(PORT, () => {
  console.log(`SC Noticeboard running on http://localhost:${PORT}`);
});
