// Regression tests for the risk model, the benchmark series and the shared
// valuation anchor (template.html), on synthetic fixtures. The functions are
// taken from the template source, so this tests the shipped code.
//
//   node scripts/risk_model.test.mjs           (exit 0 on pass, 1 on failure)
//
// Covers: one book volatility under every pivot; Euler contributions summing
// to 100%; a common observation window with no zero padding, shortened by a
// late listing and annualised from elapsed time; incomplete coverage
// withholding the whole-book figure; identical weekly and daily endpoints;
// held and unheld benchmark routes giving the same series; the daily-
// rebalanced 50/50 sampled at the weekly endpoints; genuine spikes kept and
// flagged, named exclusions applied to holdings and benchmarks alike; the
// book and benchmark anchor; month arithmetic for window starts; null-last
// sorting; HTML escaping; the heatmap text threshold. Expected calendar
// results were checked with Python dateutil.
import { loadTemplate, fn, region, line, harness } from './template_extract.mjs';

const src = loadTemplate();
const code = [
  region(src, '// ─── Exchange-local session dates', '// Period return on the adjclose series'),
  region(src, 'const RISK_WINDOW_WEEKS', '// Short label for a risk window'),
  region(src, '// ─── Benchmarks ───', 'window.setPerfBenchmark'),
  fn(src, '_bookAnchorIndex'), fn(src, '_perfWindowStart'),
  region(src, '// HTML-escape a data-derived string', '// Sort column and the Show-all toggle'),
  line(src, 'const RISK_HEATMAP_TEXT_MIN'), line(src, 'const _riskHeatmapShowsText'),
].join('\n');

// Stubs for the page globals the extracted code reads. USD/SGD drifts so a
// wrong currency would show; every other currency is SGD.
const env = { state: { liveData: {} }, PRELOADED_HISTORY: {}, ver: 1 };
const usdAt = ds => 1.30 + 0.0001 * ((Date.parse(ds + 'T00:00:00Z') / 86400000) % 50);
const make = () => new Function('env', 'usdAt', `
  let _dataVersion = env.ver; const state = env.state; const PRELOADED_HISTORY = env.PRELOADED_HISTORY;
  const TRADES_YTD = [];
  const fxAtDate = (ccy, ds) => ccy === 'USD' ? usdAt(ds) : 1;
  const _quoteIsPostBoundary = () => false, _usCloseBoundary = () => 0;
  const buildDailyBook = () => { throw new Error('no book in tests'); };
  const _bucketKeyFor = (p, pivot) => p[pivot];
  ${code}
  return { calcRiskModel, riskByBucket, _riskInputs, _benchmarkSeriesSGD, _blendSeriesSGD, _legSeriesSGD, getBenchmarkCurve,
           _bookAnchorIndex, _perfWindowStart, _riskSecCompare, _escHtml, _riskHeatmapShowsText, historyToFull,
           RISK_PRINT_EXCLUSIONS, RISK_MIN_WEEKS, RISK_WINDOW_WEEKS };`)(env, usdAt);
let T = make();
const { check, close, done } = harness();

// ── Synthetic feed ──────────────────────────────────────────────────
// Weekday sessions, stamped like Yahoo (SGX 01:00 UTC, US 14:30 UTC), with
// seeded log-normal returns plus a common factor so the names correlate.
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const gauss = r => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
const sessions = (from, to, skip = []) => {
  const out = [], d = new Date(from + 'T00:00:00Z'), end = new Date(to + 'T00:00:00Z');
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const ds = d.toISOString().slice(0, 10), wd = d.getUTCDay();   // 0 = Sunday, 6 = Saturday
    if (wd !== 0 && wd !== 6 && !skip.includes(ds)) out.push(ds);
  }
  return out;
};
const factor = (() => { const r = rng(7), m = {}; for (const ds of sessions('2024-06-03', '2026-10-02')) m[ds] = gauss(r) * 0.009; return m; })();
function feed(sym, from, seed, opts = {}) {
  const r = rng(seed), hourZ = opts.us ? 14.5 : 1;
  let px = opts.start || 100;
  return sessions(from, '2026-10-02', opts.skip || []).map(ds => {
    px *= Math.exp((opts.beta ?? 1) * (factor[ds] || 0) + gauss(r) * (opts.vol ?? 0.012));
    if (opts.set && opts.set[ds] != null) px = opts.set[ds];
    const d = Date.parse(ds + 'T00:00:00Z') / 1000 + hourZ * 3600;
    return { d, c: +px.toFixed(4), ac: +px.toFixed(4), o: px, h: px, l: px };
  });
}
const pos = (ticker, yf, ccy, compact, extra = {}) => ({
  ticker, yf, ccy, type: 'ETF', theme: extra.theme || 'T1', region: extra.region || 'R1',
  mktValueSGD: extra.mv || 100000, history: compact ? T.historyToFull(compact, yf) : null, mktPrice: compact ? compact[compact.length - 1].c : null, ...extra,
});
const ES3 = feed('ES3.SI', '2024-06-03', 11, { beta: 0.8, skip: ['2026-08-10'] });
const S27 = feed('S27.SI', '2024-06-03', 12, { beta: 1.1, start: 600 });
const setFeeds = () => {
  env.PRELOADED_HISTORY['ES3.SI'] = { history: ES3, price: ES3[ES3.length - 1].c, quoteTime: null };
  env.PRELOADED_HISTORY['S27.SI'] = { history: S27, price: S27[S27.length - 1].c, quoteTime: null };
};
setFeeds();
const A = feed('A.SI', '2024-06-03', 1, { skip: ['2026-08-10'] });
const B = feed('B', '2024-06-03', 2, { us: true, beta: 1.3 });
const C = feed('C.SI', '2026-04-01', 3, { vol: 0.02 });            // listed inside the 52-week window
const D = feed('D.SI', '2026-07-01', 4);                           // too short for the minimum window
const bond = { ticker: 'SSB', yf: null, ccy: 'SGD', type: 'Bond', theme: 'Bonds', region: 'R2', mktValueSGD: 50000, history: null };
const basePs = () => [
  pos('A', 'A.SI', 'SGD', A, { mv: 200000, theme: 'T1', region: 'R1' }),
  pos('B', 'B', 'USD', B, { mv: 150000, theme: 'T2', region: 'R1' }),
  pos('C', 'C.SI', 'SGD', C, { mv: 30000, theme: 'T2', region: 'R2' }),
  pos('S27', 'S27.SI', 'USD', S27, { mv: 80000, theme: 'T3', region: 'R2' }),
  bond,
];

// ── 1. Common window, coverage, annualisation, reconciliation ───────
const ps = basePs();
const w = T.calcRiskModel(ps, 'weekly'), dly = T.calcRiskModel(ps, 'daily');
check(w.complete === true && w.portVol != null, 'complete coverage gives a whole-book figure');
check(w.shortened === true && w.binding.length === 1 && w.binding[0].ticker === 'C', 'window shortened by the late listing', JSON.stringify(w.binding));
// Independent count: Saturdays from the first Saturday on or after C's first
// session to the Saturday of the last close.
const sat = ds => { const d = new Date(ds + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + (6 - d.getUTCDay())); return d.toISOString().slice(0, 10); };
let weeksWant = 0; for (let d = new Date(sat(T.historyToFull(C, 'C.SI')[0].ds) + 'T00:00:00Z'); d.toISOString().slice(0, 10) < sat('2026-10-02'); d.setUTCDate(d.getUTCDate() + 7)) weeksWant++;
check(w.periods === weeksWant && w.weeks === weeksWant, `weekly intervals = ${weeksWant}`, `got ${w.periods}`);
check(w.periods >= T.RISK_MIN_WEEKS && w.periods < T.RISK_WINDOW_WEEKS, 'window between the minimum and the cap');
check(w.first === dly.first && w.lastClose === dly.lastClose, 'weekly and daily share first and last sessions', `${w.first}..${w.lastClose}`);
const years = (Date.parse(w.lastClose) - Date.parse(w.first)) / 86400000 / 365.25;
close(w.perYear, w.periods / years, 1e-9, 'weekly periods per year from elapsed time');
close(dly.perYear, dly.periods / years, 1e-9, 'daily periods per year from elapsed time');
check(Math.abs(w.perYear - 52.18) < 0.6, 'weekly annualisation near 52 a year, not the interval count', w.perYear.toFixed(3));
for (const [rm, label] of [[w, 'weekly'], [dly, 'daily']]) {
  const s = rm.rows.reduce((a, r) => a + (r.contrib || 0), 0);
  close(s, 100, 1e-9, `${label} contributions sum to 100%`);
}
// No zero padding: C's volatility is the volatility of its own observed returns.
const cRow = w.rows.find(r => r.ticker === 'C');
check(cRow.obs === w.periods && cRow.rets.every(x => x !== 0), 'late listing observed at every endpoint, no zero returns');
const sd = a => { const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
close(cRow.vol, sd(cRow.rets) * Math.sqrt(w.perYear) * 100, 1e-9, 'C volatility from its observed returns only');
// Same endpoints: compounded weekly and daily returns agree for every name.
for (const r of w.rows.filter(x => x.priced)) {
  const gw = r.rets.reduce((g, x) => g * (1 + x), 1), gd = dly.rows.find(x => x.ticker === r.ticker).rets.reduce((g, x) => g * (1 + x), 1);
  close(gw, gd, 1e-12, `${r.ticker} weekly and daily compound to the same window return`);
}
// One book figure under every pivot; bucket contributions sum to 100%.
for (const pivot of ['theme', 'region']) {
  const b = T.riskByBucket(w, pivot);
  close(Object.values(b).reduce((s, x) => s + x.contrib, 0), 100, 1e-9, `${pivot} buckets sum to 100%`);
}
check(w.rows.find(r => r.ticker === 'SSB').contrib === 0, 'bond carries weight and zero risk');

// ── 2. Incomplete coverage withholds the whole-book figure ──────────
const psD = [...basePs(), pos('D', 'D.SI', 'SGD', D, { mv: 20000 })];
const wD = T.calcRiskModel(psD, 'weekly');
check(wD.complete === false && wD.portVol === null && isFinite(wD.coveredVol), 'short holding: whole-book volatility withheld, covered figure kept');
const exD = wD.coverage.excluded.find(x => x.ticker === 'D');
check(exD && exD.status === 'short' && exD.available < T.RISK_MIN_WEEKS, 'short holding named with its available history', JSON.stringify(exD));
check(wD.periods === w.periods, 'an excluded holding does not shorten the window');

// ── 3. Benchmarks independent of holdings ───────────────────────────
const psHeld = basePs(), psUnheld = basePs().filter(p => p.ticker !== 'S27');
env.ver++; T = make();
const heldS = T._benchmarkSeriesSGD(psHeld, 'SPX', false), unheldS = T._benchmarkSeriesSGD(psUnheld, 'SPX', false);
check(JSON.stringify(heldS) === JSON.stringify(unheldS) && heldS.length > 400, 'S&P 500 leg identical held and unheld', `${heldS.length} points`);
check(JSON.stringify(T._benchmarkSeriesSGD(psHeld, 'BLEND', false)) === JSON.stringify(T._benchmarkSeriesSGD(psUnheld, 'BLEND', false)), '50/50 identical held and unheld');
const pt = heldS.find(x => x.ds === '2026-09-01');
close(pt.px, pt.loc * usdAt('2026-09-01'), 1e-9, 'S27 converted from USD at same-date FX');
const psWrongCcy = basePs().map(p => p.ticker === 'S27' ? { ...p, ccy: 'SGD' } : p);
const origWarn = console.warn; console.warn = () => {};
check(JSON.stringify(T._benchmarkSeriesSGD(psWrongCcy, 'SPX', false)) === JSON.stringify(heldS), 'defined USD currency used even if the holding says SGD');
console.warn = origWarn;
const cHeld = T.getBenchmarkCurve(psHeld, 'BLEND', '2026-07-03', '2026-07-02'), cUnheld = T.getBenchmarkCurve(psUnheld, 'BLEND', '2026-07-03', '2026-07-02');
check(JSON.stringify(cHeld.cumReturn) === JSON.stringify(cUnheld.cumReturn), 'Performance 50/50 curve identical held and unheld');
const env0 = env.PRELOADED_HISTORY; delete env0['S27.SI']; env.ver++; T = make();
check(T.getBenchmarkCurve(psUnheld, 'BLEND', '2026-07-03', '2026-07-02') === null, 'no S27 feed and not held: no 50/50, never a guessed series');
setFeeds(); env.ver++; T = make();

// ── 4. Canonical 50/50: rebalanced daily, sampled at weekly endpoints ─
const blend = T._blendSeriesSGD(ps, false), sti = T._benchmarkSeriesSGD(ps, 'STI', false), spx = T._benchmarkSeriesSGD(ps, 'SPX', false);
const at = (s, d) => { let v = null; for (const x of s) { if (x.ds <= d) v = x.px; else break; } return v; };
const dd = blend.slice(-30);
let dailyOk = true;
for (let i = 1; i < dd.length; i++) {
  const d0 = dd[i - 1].ds, d1 = dd[i].ds;
  const want = 0.5 * (at(sti, d1) / at(sti, d0) - 1) + 0.5 * (at(spx, d1) / at(spx, d0) - 1);
  if (Math.abs(dd[i].px / dd[i - 1].px - 1 - want) > 1e-12) dailyOk = false;
}
check(dailyOk, '50/50 daily return is the mean of the two legs\' daily returns');
const w2 = T.calcRiskModel(basePs(), 'weekly');
const keysW = w2._inp.keysW;
const blendW = keysW.slice(1).map((k, i) => at(blend, k) / at(blend, keysW[i]) - 1);
const avgW = keysW.slice(1).map((k, i) => 0.5 * (at(sti, k) / at(sti, keysW[i]) - 1) + 0.5 * (at(spx, k) / at(spx, keysW[i]) - 1));
const rp = w2.portRets, cov = (a, b) => { const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length; return a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0) / (a.length - 1); };
close(w2.betaBlend, cov(rp, blendW) / cov(blendW, blendW), 1e-12, 'Allocation beta uses the daily-rebalanced 50/50 sampled weekly');
check(Math.max(...blendW.map((x, i) => Math.abs(x - avgW[i]))) > 1e-6, 'and not the weekly average of the legs (weekly rebalancing)');

// ── 5. Unusual moves: kept and flagged; named exclusions applied ────
const spikes = { '2026-07-14': 160, '2026-07-15': 100, '2026-08-04': 10, '2026-08-05': 10, '2026-08-06': 100, '2026-10-02': 190 };
const E = feed('E.SI', '2024-06-03', 5, { vol: 0, beta: 0, set: { ...spikes, '2026-07-13': 100, '2026-08-03': 100, '2026-10-01': 100 } });
const psE = [...basePs(), pos('E', 'E.SI', 'SGD', E, { mv: 1000 })];
env.ver++; T = make();
const dE = T.calcRiskModel(psE, 'daily');
const eRow = dE.rows.find(r => r.ticker === 'E');
const flagged = dE.flags.filter(f => f.ticker === 'E').map(f => f.date);
check(eRow.rets.some(x => Math.abs(x - 0.6) < 1e-9) && eRow.rets.some(x => Math.abs(x - (100 / 160 - 1)) < 1e-9), 'genuine 100 → 160 → 100 round trip kept in the returns');
check(['2026-07-14', '2026-07-15', '2026-08-04', '2026-08-06', '2026-10-02'].every(d => flagged.includes(d)), 'spike, two-session error and final-bar jump all flagged', flagged.join(','));
check(!flagged.includes('2026-08-05'), 'a flat session between two bad prints is not flagged');
T.RISK_PRINT_EXCLUSIONS.push({ yf: 'E.SI', ticker: 'E', date: '2026-07-14', basis: 'test' }, { yf: 'ES3.SI', ticker: 'ES3', date: '2026-09-01', basis: 'test' });
env.ver++;
const dE2 = T.calcRiskModel([...psE], 'daily');
check(!dE2.rows.find(r => r.ticker === 'E').rets.some(x => Math.abs(x - 0.6) < 1e-9), 'named exclusion removes the print from the holding');
check(dE2.exclusions.some(x => x.ticker === 'E') && dE2.exclusions.some(x => x.ticker === 'ES3'), 'named exclusions inside the window are disclosed, benchmark included');
check(!T._benchmarkSeriesSGD(psE, 'STI', false).some(x => x.ds === '2026-09-01'), 'exclusion applies on the benchmark path');
check(!T.getBenchmarkCurve(psE, 'STI', '2026-08-03', '2026-07-31').dates.includes('2026-09-01'), 'and on the Performance benchmark curve');
T.RISK_PRINT_EXCLUSIONS.splice(-2, 2);
const reg = T.RISK_PRINT_EXCLUSIONS.find(x => x.yf === '3010.HK');
check(reg && reg.date === '2025-10-24' && /70\.78/.test(reg.basis) && /9\.1617/.test(reg.basis) && /72\.36/.test(reg.basis) && /not verified/.test(reg.basis), '3010.HK 2025-10-24 kept as a named exclusion with its basis');
env.ver++; T = make();

// ── 6. Valuation anchor ─────────────────────────────────────────────
const axis = ['2025-12-31', '2026-01-02', '2026-01-05'];
check(axis[T._bookAnchorIndex(axis, '2026-01-01')] === '2025-12-31', 'YTD anchors on the 31 December close');
check(axis[T._bookAnchorIndex(axis, '2026-01-03')] === '2026-01-02', 'a Saturday start anchors on the Friday');
check(axis[T._bookAnchorIndex(axis, '2026-01-05')] === '2026-01-02', 'a Monday start anchors on the previous Friday, so Monday counts');
check(T._bookAnchorIndex(axis, '2025-06-01') === 0, 'a start before the axis anchors on its first date');
const hol = T.getBenchmarkCurve(ps, 'STI', '2026-08-11', '2026-08-10');   // ES3 has no 10 Aug session
const es3Full = T._benchmarkSeriesSGD(ps, 'STI', false);
check(hol.dates[0] === '2026-08-10' && hol.cumReturn[0] === 0, 'benchmark rebased at the book anchor, not its own next session');
close(1 + hol.cumReturn[1] / 100, at(es3Full, '2026-08-11') / at(es3Full, '2026-08-07'), 1e-12, 'holiday anchor values the benchmark at its preceding close');
check(T.getBenchmarkCurve(ps, 'STI', '2010-01-04', '2010-01-01') === null, 'a benchmark with no close on or before the anchor is withheld');

// ── 7. Window start dates (expected values from Python dateutil) ────
const ws = (iso, k) => T._perfWindowStart(k, new Date(iso));
check(ws('2026-10-31T05:00:00Z', '1M') === '2026-09-30', '31 Oct less 1M = 30 Sep (month-end clamp)');
check(ws('2026-03-31T05:00:00Z', '1M') === '2026-02-28', '31 Mar less 1M = 28 Feb');
check(ws('2024-03-31T05:00:00Z', '1M') === '2024-02-29', '31 Mar 2024 less 1M = 29 Feb (leap year)');
check(ws('2026-01-15T05:00:00Z', '3M') === '2025-10-15', '15 Jan 2026 less 3M = 15 Oct 2025 (year boundary)');
check(ws('2026-02-15T05:00:00Z', '6M') === '2025-08-15', '15 Feb 2026 less 6M = 15 Aug 2025');
check(ws('2026-10-03T05:00:00Z', '3M') === '2026-07-03' && ws('2026-10-03T05:00:00Z', 'YTD') === '2026-01-01', '3 Oct 2026: 3M from 3 Jul, YTD from 1 Jan');

// ── 8. Sorting, escaping, heatmap threshold ─────────────────────────
const vals = [3, null, -1, 0, NaN, 2, undefined].map((v, i) => ({ v, i }));
const asc = [...vals].sort(T._riskSecCompare('v', 'asc')).map(x => x.v);
const desc = [...vals].sort(T._riskSecCompare('v', 'desc')).map(x => x.v);
check(JSON.stringify(asc.slice(0, 4)) === '[-1,0,2,3]' && asc.slice(4).every(v => v == null || Number.isNaN(v)), 'ascending: numbers in order, missing last', JSON.stringify(asc));
check(JSON.stringify(desc.slice(0, 4)) === '[3,2,0,-1]' && desc.slice(4).every(v => v == null || Number.isNaN(v)), 'descending: numbers in order, missing last', JSON.stringify(desc));
const payload = `<img src=x onerror="window.__pwned=1">'`;
const escd = T._escHtml(payload);
check(!/[<>"']/.test(escd) && escd.includes('&lt;img'), 'escaping leaves no markup characters', escd);
check(T._riskHeatmapShowsText(600) === true && T._riskHeatmapShowsText(599) === false, 'heatmap prints values from 600px');

done();
