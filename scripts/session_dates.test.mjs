// Exchange-local session dates (template.html, _sessionDater / historyToFull /
// mergeHistory) and the FX history built on them.
//
//   node scripts/session_dates.test.mjs        (exit 0 on pass, 1 on failure)
//
// Every stamp below is a real Yahoo daily-bar timestamp taken from the baked
// feed of 3 October 2026. The expected session date and weekday of each were
// checked with Python datetime and zoneinfo, not computed by hand. Coverage:
// ASX either side of both daylight-saving transitions (AEDT began Sunday
// 5 October 2025 and ended Sunday 5 April 2026), Monday sessions stamped on a
// UTC Sunday, month and year boundaries, FX across both British Summer Time
// transitions, and Tokyo / HKEX / SGX / Paris / Frankfurt / New York, whose
// dates must not change. If docs/data/history.json and fx.json are present,
// every bar in them is also dated by the fast path and by Intl directly, and
// the two must agree.
import { existsSync, readFileSync } from 'node:fs';
import { loadTemplate, fn, region, harness } from './template_extract.mjs';

const src = loadTemplate();
const code = region(src, '// ─── Exchange-local session dates', '// Period return on the adjclose series')
  + '\n' + fn(src, 'mergeHistory') + '\n' + fn(src, '_buildFxHistory') + '\n' + fn(src, 'fxAtDate');
const T = new Function('FX', 'FX_HISTORY', `${code}; return { _inferExchangeTz, _sessionDater, _barDate, historyToFull, mergeHistory, _buildFxHistory, fxAtDate };`)({ USD: 1.3 }, {});
const { check, done } = harness();

// [stamp (epoch s), symbol, expected session date, note]
const cases = [
  [1759449600, 'SGM.AX', '2025-10-03', 'ASX Fri, last AEST session before daylight saving'],
  [1759705200, 'SGM.AX', '2025-10-06', 'ASX Mon, first AEDT session, stamped UTC Sunday 23:00'],
  [1767135600, 'SGM.AX', '2025-12-31', 'ASX Wed, year end, stamped UTC 30 Dec'],
  [1767308400, 'SGM.AX', '2026-01-02', 'ASX Fri, first 2026 session, stamped UTC 1 Jan'],
  [1772406000, 'SGM.AX', '2026-03-02', 'ASX Mon, month boundary, stamped UTC Sunday 1 Mar'],
  [1775084400, 'SGM.AX', '2026-04-02', 'ASX Thu, last AEDT session before daylight saving ends'],
  [1775520000, 'SGM.AX', '2026-04-07', 'ASX Tue, first AEST session after daylight saving ends'],
  [1790899200, 'SGM.AX', '2026-10-02', 'ASX Fri, AEST'],
  [1761260400, 'USDSGD=X', '2025-10-24', 'FX Fri, BST, stamped UTC Thursday 23:00'],
  [1761523200, 'USDSGD=X', '2025-10-27', 'FX Mon, GMT after BST ended 26 Oct'],
  [1774569600, 'USDSGD=X', '2026-03-27', 'FX Fri, GMT'],
  [1774825200, 'USDSGD=X', '2026-03-30', 'FX Mon, first BST session, stamped UTC Sunday 23:00'],
  [1767139200, 'USDSGD=X', '2025-12-31', 'FX Wed, year end, GMT'],
  [1767312000, 'USDSGD=X', '2026-01-02', 'FX Fri, first 2026 session'],
  [1767571200, '4004.T', '2026-01-05', 'Tokyo Mon, unchanged'],
  [1772409600, '4004.T', '2026-03-02', 'Tokyo Mon, month boundary, unchanged'],
  [1767144600, '0992.HK', '2025-12-31', 'HKEX Wed, year end, unchanged'],
  [1772415000, '0992.HK', '2026-03-02', 'HKEX Mon, unchanged'],
  [1767142800, 'ES3.SI', '2025-12-31', 'SGX Wed, year end, unchanged'],
  [1772413200, 'ES3.SI', '2026-03-02', 'SGX Mon, unchanged'],
  [1772438400, 'SOI.PA', '2026-03-02', 'Paris Mon, CET, unchanged'],
  [1782889200, 'SOI.PA', '2026-07-01', 'Paris Wed, CEST, unchanged'],
  [1767078000, 'EXV3.DE', '2025-12-30', 'Frankfurt Tue, unchanged'],
  [1767191400, 'META', '2025-12-31', 'New York Wed, EST, unchanged'],
  [1772461800, 'META', '2026-03-02', 'New York Mon, EST, unchanged'],
  [1782912600, 'META', '2026-07-01', 'New York Wed, EDT, unchanged'],
];
for (const [sec, sym, want, note] of cases) {
  const inferred = T._sessionDater(T._inferExchangeTz(sym))(sec);
  check(inferred === want, `${sym} ${sec} -> ${inferred}`, `want ${want}; ${note}`);
}

// Explicit feed timezone and suffix inference must agree.
const feedTz = { 'SGM.AX': 'Australia/Sydney', 'USDSGD=X': 'Europe/London', '4004.T': 'Asia/Tokyo', '0992.HK': 'Asia/Hong_Kong', 'ES3.SI': 'Asia/Singapore', 'SOI.PA': 'Europe/Paris', 'EXV3.DE': 'Europe/Berlin', META: 'America/New_York' };
let agree = true;
for (const [sec, sym] of cases) if (T._sessionDater(feedTz[sym])(sec) !== T._sessionDater(T._inferExchangeTz(sym))(sec)) agree = false;
check(agree, 'feed timezone and suffix inference give the same dates');

// historyToFull attaches ds; with neither symbol nor timezone it keeps the
// UTC date (compatibility fallback for payloads without metadata).
const bar = { d: 1772406000, c: 1, ac: 1, o: 1, h: 1, l: 1 };
check(T.historyToFull([bar], 'SGM.AX')[0].ds === '2026-03-02', 'historyToFull dates an ASX bar to its session');
check(T.historyToFull([bar], null, 'Australia/Sydney')[0].ds === '2026-03-02', 'historyToFull honours an explicit tz');
check(T.historyToFull([bar])[0].ds === '2026-03-01', 'historyToFull without metadata keeps the UTC date');
check(T._inferExchangeTz('XYZ.ZZ') === null, 'unknown suffix falls back to UTC');
check(T._barDate({ date: new Date(1772406000 * 1000) }) === '2026-03-01', '_barDate without ds is the UTC date');

// mergeHistory dedups on the session date: an ASX finalised bar stamped at
// the 10:00 open (23:00 UTC the day before) and a live print later in the
// same session collapse to one bar, the finalised one winning.
const fin = { d: 1772406000, c: 10 }, live = { d: 1772406000 + 5 * 3600, c: 11, p: true };
const merged = T.mergeHistory([fin], [live], 'SGM.AX');
check(merged.length === 1 && merged[0].c === 10, 'mergeHistory collapses one ASX session to one bar');

// FX history is filed on the London session date, so fxAtDate for a Monday
// returns the Monday rate, not Tuesday's.
const FX_HISTORY = {};
const B = new Function('FX', 'FX_HISTORY', `${code}; return { _buildFxHistory, fxAtDate, historyToFull };`)({ USD: 1.3 }, FX_HISTORY);
const fxBars = [{ d: 1774569600, c: 1.27 }, { d: 1774825200, c: 1.28 }, { d: 1774911600, c: 1.29 }];   // Fri 27 Mar, Mon 30 Mar, Tue 31 Mar
B._buildFxHistory({ 'USDSGD=X': { history: B.historyToFull(fxBars, 'USDSGD=X') } });
check(FX_HISTORY.USD.map(x => x.date).join(',') === '2026-03-27,2026-03-30,2026-03-31', 'FX history dated by London session', FX_HISTORY.USD.map(x => x.date).join(','));
check(B.fxAtDate('USD', '2026-03-30') === 1.28, 'fxAtDate(Monday 30 Mar) is the Monday rate');
check(B.fxAtDate('USD', '2026-03-28') === 1.27, 'fxAtDate(Saturday) carries Friday');

// Full cross-check of the fast path against Intl on the local bake, if any.
const histPath = new URL('../docs/data/history.json', import.meta.url);
const fxPath = new URL('../docs/data/fx.json', import.meta.url);
if (existsSync(histPath) && existsSync(fxPath)) {
  const data = { ...JSON.parse(readFileSync(histPath, 'utf8')), ...JSON.parse(readFileSync(fxPath, 'utf8')) };
  let n = 0, bad = 0, firstBad = '';
  const fmtCache = {};
  for (const [sym, entry] of Object.entries(data)) {
    const tz = entry.tz || T._inferExchangeTz(sym);
    if (!tz) continue;
    const f = fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }));
    const dater = T._sessionDater(tz);
    for (const b of entry.history || []) {
      n++;
      const p = {}; for (const x of f.formatToParts(new Date(b.d * 1000))) p[x.type] = x.value;
      const want = `${p.year}-${p.month}-${p.day}`;
      if (dater(b.d) !== want) { bad++; if (!firstBad) firstBad = `${sym} ${b.d} ${dater(b.d)} vs ${want}`; }
    }
  }
  check(bad === 0, `fast path agrees with Intl on all ${n} local baked bars`, firstBad);
} else {
  console.log('SKIP  local bake not present; full Intl cross-check not run');
}
done();
