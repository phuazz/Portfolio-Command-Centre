#!/usr/bin/env node
/**
 * build.js — Fetch historical price data and write it out for the dashboard.
 *
 * This script:
 *   1. Reads template.html and extracts all Yahoo Finance ticker symbols
 *   2. Fetches 10-year daily OHLC history for each ticker
 *   3. Fetches FX rates (HKDSGD, JPYSGD, USDSGD)
 *   4. Writes docs/data/history.json (stock OHLC), docs/data/fx.json (FX
 *      rates) and docs/data/meta.json (build date, ticker list) for the
 *      client to fetch
 *   5. Writes docs/index.html as a straight copy of template.html
 *   6. Ensures docs/.nojekyll exists so GitHub Pages skips Jekyll processing
 *
 * The client bootstraps by fetching the three data/*.json files on page load.
 * GitHub Pages is configured to serve from the docs/ directory on main, set
 * in repository Settings → Pages as part of the Phase 4 cutover. That
 * setting lives outside git — reverting the cutover commit alone will not
 * restore the previous serving state.
 *
 * Usage:
 *   node build.js              # Rebuild docs/index.html and docs/data/*.json
 *   node build.js --dry-run    # Fetch data but don't write anything
 *
 * Requirements: Node.js 18+ (uses native fetch)
 */

const fs = require('fs');
const path = require('path');

const TEMPLATE_FILE = path.join(__dirname, 'template.html');
// Phase 4: single-write into docs/. GitHub Pages serves from docs/ on main,
// configured via repository Settings → Pages (UI-side, not captured in git).
const DOCS_DIR = path.join(__dirname, 'docs');
const DATA_DIR = path.join(DOCS_DIR, 'data');
const OUTPUT_FILE = path.join(DOCS_DIR, 'index.html');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const FX_FILE = path.join(DATA_DIR, 'fx.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');
const NOJEKYLL_FILE = path.join(DOCS_DIR, '.nojekyll');
const CONCURRENCY = 5;
const DELAY_MS = 150;       // Polite delay between requests
const RANGE = '10y';        // 10 years for full backtest support
// JPYSGD=X is illiquid/erratic on Yahoo (frequently a single, imprecise bar),
// so we fetch the liquid SGDJPY=X cross instead and invert it to JPYSGD=X after
// the fetch (see deriveJpySgd below).
const FX_SYMBOLS = ['HKDSGD=X', 'SGDJPY=X', 'USDSGD=X', 'AUDSGD=X', 'EURSGD=X'];

// ── Ledger-first universe (REFACTOR_PLAN_V2 Phase A) ──
// The ticker universe is read from book.json metadata plus every trade row in
// trades.json, replacing the old regex scan of the HTML. Closed-out tickers
// stay in the universe via their trade rows, so attribution keeps its history.
const TRADES_SRC = path.join(__dirname, 'trades.json');
const BOOK_SRC = path.join(__dirname, 'book.json');

function readLedger() {
  const trades = JSON.parse(fs.readFileSync(TRADES_SRC, 'utf-8'));
  const book = JSON.parse(fs.readFileSync(BOOK_SRC, 'utf-8'));
  const symbols = new Set();
  // Symbols carrying a noQuote note are held out of the fetch universe: the
  // price source has no data for them and never will, so fetching only
  // manufactures a permanent failure line that trains the reader to ignore a
  // real break. Each exclusion states its reason and verification date in
  // book.json and is priced from mktPriceSnap instead. The skipped names are
  // logged on every bake — a silent exclusion would be worse than the noise
  // it replaces.
  const noQuote = [], noQuoteYf = new Set();
  for (const [tk, m] of Object.entries(book.meta || {})) {
    if (m.yf && m.noQuote) { noQuote.push(`${tk} (${m.yf})`); noQuoteYf.add(m.yf); }
  }
  for (const m of Object.values(book.meta || {})) if (m.yf) symbols.add(m.yf);
  for (const t of trades) if (t.yf) symbols.add(t.yf);
  // Applied after both loops so a trade row cannot re-admit an excluded symbol.
  for (const yf of noQuoteYf) symbols.delete(yf);
  return { trades, book, symbols: [...symbols], noQuote };
}

// Yahoo symbols currently held in non-zero size, by replaying the ledger the
// same way validateLedger does. The session audit polices only these: a
// closed-out ticker stays in the universe for attribution history but cannot
// move a P&L card, so a feed gap on one is not worth stopping a bake for.
function heldYahooSymbols(book, trades) {
  const qty = {};
  for (const op of book.positions || []) qty[op.ticker] = op.qty;
  for (const t of trades) if (t.a === 'B' || t.a === 'S') qty[t.t] = (qty[t.t] || 0) + (t.a === 'B' ? t.q : -t.q);
  const held = new Set();
  for (const [tk, m] of Object.entries(book.meta || {})) {
    if (m.yf && Math.abs(qty[tk] || 0) > 1e-9) held.add(m.yf);
  }
  return held;
}

// Replay validation: the ledger must never sell more than is held (opening
// quantity plus prior buys), unless a named ledgerOverride covers the gap.
// A hard failure here stops the bake — a red Actions run beats silently
// publishing a dashboard built on inconsistent books.
function validateLedger(book, trades) {
  const sorted = [...trades].filter(t => t.a === 'B' || t.a === 'S').sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
  const qty = {};
  for (const op of book.positions || []) qty[op.ticker] = op.qty;
  const overrides = book.ledgerOverrides || {};
  const errors = [];
  for (const t of sorted) {
    qty[t.t] = (qty[t.t] || 0) + (t.a === 'B' ? t.q : -t.q);
    if (qty[t.t] < -1e-9 && !overrides[t.t]) errors.push(`${t.d} ${t.t}: sell of ${t.q} exceeds holdings (running qty ${qty[t.t]})`);
  }
  for (const [tk, ov] of Object.entries(overrides)) console.log(`  ⚠️  ledger override active: ${tk} → qty ${ov.qty}`);
  if (errors.length) {
    console.error('❌ Ledger validation failed:\n  ' + errors.join('\n  '));
    process.exit(1);
  }
}

// ── Fetch one ticker from Yahoo Finance ──
// directOnly skips the CORS proxies. The proxies are a availability fallback,
// not an equivalence: they have been observed returning a series with recent
// sessions missing, which the session audit cannot tell apart from a genuine
// feed gap. Verification re-fetches must therefore come from Yahoo itself.
async function fetchTicker(symbol, range = '10y', directOnly = false) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;

  // Try direct first, then CORS proxies
  const urls = directOnly ? [url] : [
    url,
    `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  ];

  for (const u of urls) {
    try {
      const resp = await fetch(u, { 
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(15000)
      });
      if (!resp.ok) continue;
      const json = await resp.json();
      const result = json?.chart?.result?.[0];
      if (!result) continue;

      const meta = result.meta;
      const quotes = result.indicators?.quote?.[0];
      // adjclose carries the dividend- and split-adjusted close. Baking it
      // into history.json lets the dashboard compute proper total returns
      // (YTD, 1M, etc.) for dividend payers without a per-page refetch.
      const adjQuotes = result.indicators?.adjclose?.[0];
      const adjcloses = adjQuotes?.adjclose || [];
      const timestamps = result.timestamp || [];
      const closes = quotes?.close || [];
      const opens = quotes?.open || [];
      const highs = quotes?.high || [];
      const lows = quotes?.low || [];
      // Volume is carried on each bar for the session audit only and is stripped
      // before history.json is written — it is the sole reliable discriminator
      // between a real session and a fabricated one, but the client never needs
      // it and the file is already ~11 MB.
      const volumes = quotes?.volume || [];

      const price = meta.regularMarketPrice || closes.filter(c => c != null).pop();

      const history = [];
      const lastIdx = timestamps.length - 1;
      for (let i = 0; i < timestamps.length; i++) {
        if (closes[i] != null && !isNaN(closes[i])) {
          const ac = (adjcloses[i] != null && !isNaN(adjcloses[i])) ? adjcloses[i] : closes[i];
          history.push({
            d: timestamps[i],
            c: +closes[i].toFixed(4),
            ac: +ac.toFixed(4),
            o: +(opens[i] || closes[i]).toFixed(4),
            h: +(highs[i] || closes[i]).toFixed(4),
            l: +(lows[i] || closes[i]).toFixed(4),
            v: (volumes[i] == null || isNaN(volumes[i])) ? 0 : volumes[i]
          });
        }
      }

      // Provisional last bar — if the latest timestamp has close=null but
      // Yahoo gave us a regularMarketPrice (market still open), append the
      // live price as a provisional bar tagged p:true. The merge logic in
      // template.html replaces provisional bars with finalised closes on
      // the next bake. Without this substitution the daily history ends at
      // yesterday during trading hours and the dashboard's snapshot-aware
      // fallback has to paper over the gap.
      if (lastIdx >= 0 && timestamps[lastIdx] != null && (closes[lastIdx] == null || isNaN(closes[lastIdx])) && meta.regularMarketPrice != null) {
        const px = meta.regularMarketPrice;
        const lastBarDate = new Date(timestamps[lastIdx] * 1000).toISOString().slice(0, 10);
        // Skip if a finalised bar for the same calendar date is already in history.
        const alreadyFinalised = history.some(b => new Date(b.d * 1000).toISOString().slice(0, 10) === lastBarDate);
        if (!alreadyFinalised) {
          history.push({
            d: timestamps[lastIdx],
            c: +px.toFixed(4),
            ac: +px.toFixed(4),
            o: +(opens[lastIdx] || px).toFixed(4),
            h: +(highs[lastIdx] || px).toFixed(4),
            l: +(lows[lastIdx] || px).toFixed(4),
            v: (volumes[lastIdx] == null || isNaN(volumes[lastIdx])) ? 0 : volumes[lastIdx],
            p: true,
          });
        }
      }

      // prevClose: prefer the LAST FINALISED close in our history over
      // Yahoo's regularMarketPreviousClose, which sometimes lags by one
      // session when Yahoo has not yet finalised yesterday's bar (we
      // observed this on ES3.SI returning Friday's close on Tuesday).
      let prevClose = meta.regularMarketPreviousClose || meta.previousClose;
      const finalisedBars = history.filter(b => !b.p);
      if (finalisedBars.length >= 1) {
        // If the most recent bar in history is a provisional (today's live)
        // bar, use the bar before that as prevClose.
        const lastBar = history[history.length - 1];
        if (lastBar.p && finalisedBars.length >= 1) {
          prevClose = finalisedBars[finalisedBars.length - 1].c;
        } else if (finalisedBars.length >= 2) {
          // Both bars are finalised — use the second-to-last as prevClose.
          prevClose = finalisedBars[finalisedBars.length - 2].c;
        }
      }
      if (prevClose == null) {
        prevClose = closes.filter(c => c != null).slice(-2)[0] || price;
      }

      // quoteTime: epoch seconds of the last actual trade (regularMarketTime).
      // The dashboard's intraday engines gate on it — a print at or before the
      // prior US close is not a live tick, however much it differs from the
      // marked close (thinly traded SGX names routinely differ for days).
      // exchangeTz groups tickers by trading calendar for the session audit and,
      // like volume, is stripped before the file is written.
      // name: the feed's security name, kept in history.json so the client can
      // label tickers that have no book.json meta entry (names closed during
      // the year). longName reads better than shortName ("WisdomTree Physical
      // Silver" against "WISDOMTREE METAL SECURITIES LIM").
      return { price: +price.toFixed(4), prevClose: +prevClose.toFixed(4), quoteTime: meta.regularMarketTime || null, exchangeTz: meta.exchangeTimezoneName || null, name: meta.longName || meta.shortName || null, history };
    } catch (e) {
      // Try next proxy
    }
  }
  return null;
}

// ── Session audit ───────────────────────────────────────────────────────
// Yahoo's daily series is not trustworthy around exchange holidays. Two
// distinct defects have been observed, both silent:
//
//   1. A FABRICATED bar on a day the exchange was shut — zero volume, with
//      open = high = low = close repeating the previous session. Observed on
//      SGX for 2026-08-10 (National Day, 9 August 2026 falling on a Sunday)
//      across ES3.SI, G3B.SI, GAB.SI, YYY.SI, S27.SI, D07.SI and ICU.SI.
//   2. A DROPPED real session — the timestamp is present but every field is
//      null. Observed on the same names for 2026-08-11, a full SGX session in
//      which ES3.SI alone traded 1.9 m shares. The gap persists across every
//      range and both Yahoo hosts, so it does not heal on a re-fetch.
//
// Together these move the day boundary: calcSplitDayPnL anchors the 1-Day
// window on the fabricated bar, reads it as flat, and sweeps the lost session
// into the Intraday card. On 2026-08-12 that misplaced S$4,169 between the two
// headline cards and turned ES3 from the day's largest contributor into an
// apparent one, with nothing on the page to signal it.
//
// Neither defect is detectable from a single ticker's series — a ticker cannot
// tell you whether its own exchange was open. It is detectable across tickers:
// if any name on the same trading calendar printed real volume that day, the
// exchange was open. That cross-sectional vote is what both rules below rest
// on, so a calendar group needs enough members to carry one.
const MIN_CALENDAR_GROUP = 3;   // below this, one bad ticker outvotes the truth
const AUDIT_WINDOW = 10;        // sessions back to police for missing bars
const GAPS_FILE = path.join(__dirname, 'data_gaps.json');

const barDateISO = b => new Date(b.d * 1000).toISOString().slice(0, 10);

function auditSessions(stockData, heldSymbols) {
  // Group by trading calendar. Symbols whose exchange never reported a
  // timezone fall into their own bucket and simply go unguarded.
  const groups = {};
  for (const [sym, data] of Object.entries(stockData)) {
    const tz = data.exchangeTz || `unknown:${sym}`;
    (groups[tz] = groups[tz] || []).push(sym);
  }

  const dropped = [];      // fabricated bars removed
  const gaps = [];         // real sessions missing from a held ticker
  const unguarded = [];

  for (const [tz, members] of Object.entries(groups)) {
    if (members.length < MIN_CALENDAR_GROUP) { unguarded.push(`${tz} (${members.join(', ')})`); continue; }

    // A date is a session if ANY member printed real volume on it.
    const sessions = new Set();
    for (const sym of members) {
      for (const b of stockData[sym].history) if (b.v > 0) sessions.add(barDateISO(b));
    }

    // Rule 1 — remove fabricated holiday bars. All three conditions must hold:
    // the exchange was shut, nothing traded, and the bar is a flat repeat.
    // Provisional bars are never dropped; they stand in for a session that is
    // still in progress, before any print has landed.
    for (const sym of members) {
      const h = stockData[sym].history;
      const keep = [];
      for (const b of h) {
        const flat = b.o === b.h && b.h === b.l && b.l === b.c;
        if (!b.p && b.v === 0 && flat && !sessions.has(barDateISO(b))) {
          dropped.push({ sym, date: barDateISO(b), close: b.c });
        } else {
          keep.push(b);
        }
      }
      if (keep.length !== h.length) stockData[sym].history = keep;
    }

    // Rule 2 — a held ticker with no bar on a date its exchange traded. The
    // most recent session is excluded: it may still be in progress, and a name
    // that has not printed yet today is not a gap. Only held names are policed
    // — a closed-out ticker cannot move a P&L card, and its history is kept
    // solely so attribution can look backwards.
    const recent = [...sessions].sort().slice(-(AUDIT_WINDOW + 1)).slice(0, -1);
    for (const sym of members) {
      if (!heldSymbols.has(sym)) continue;
      const h = stockData[sym].history;
      if (!h.length) continue;
      const have = new Set(h.map(barDateISO));
      const first = barDateISO(h[0]), last = barDateISO(h[h.length - 1]);
      for (const d of recent) {
        if (d < first || d > last) continue;      // outside this ticker's listed life
        if (!have.has(d)) gaps.push({ sym, date: d, tz });
      }
    }
  }

  return { dropped, gaps, unguarded };
}

// Re-fetch every ticker the audit suspects, direct from Yahoo, and keep the
// better series. A degraded fetch and a genuine feed gap look identical in the
// data — both are a ticker missing one recent session — so the audit cannot
// distinguish them by inspection, and guessing wrong is expensive in both
// directions: a false stop jams the pipeline, and acknowledging a false gap
// writes a fiction into the record that later sessions would trust. The first
// CI run of this guard flagged eight US ETFs for 2026-07-31 whose bars were
// present and healthy on a direct fetch moments later, which is what this
// exists to catch. Verifying the claim costs one request per suspect.
async function verifySuspectGaps(stockData, gaps) {
  const suspects = [...new Set(gaps.map(g => g.sym))];
  if (!suspects.length) return { repaired: [], failedRefetch: [] };
  const repaired = [], failedRefetch = [];
  for (const sym of suspects) {
    const wanted = gaps.filter(g => g.sym === sym).map(g => g.date);
    const fresh = await fetchTicker(sym, RANGE, true);
    await new Promise(r => setTimeout(r, DELAY_MS));
    if (!fresh || !fresh.history || !fresh.history.length) { failedRefetch.push(sym); continue; }
    const have = new Set(fresh.history.map(barDateISO));
    const recovered = wanted.filter(d => have.has(d));
    if (recovered.length) {
      // The re-fetch carries sessions the first one lost: the first fetch was
      // degraded, so replace the series wholesale rather than patch it — the
      // rest of that payload is equally suspect.
      stockData[sym] = fresh;
      repaired.push({ sym, dates: recovered });
    }
  }
  return { repaired, failedRefetch };
}

// ── Session recovery from intraday bars ─────────────────────────────────
// A session Yahoo dropped from the daily series is usually still present in
// the intraday series, which is built by a different pipeline. Reconstructing
// the bar from 5-minute prints restores the day boundary immediately instead
// of leaving the two day cards withdrawn for the fortnight it takes the bad
// date to age out of the windows.
//
// The reconstruction is NOT an official close and is never presented as one.
// It is tagged r:true on the bar and published in meta.json so the client can
// mark anything resting on it. Measured against 90 sessions across SGX, HKEX
// and US names where the official daily bar was known: median close error
// 0.000%, p90 0.333%, max 1.235%; 89% inside 0.25%. The error is the closing
// auction, which the intraday series stops short of, so the tail is entirely
// low-priced counters where one tick is already half a per cent. The
// reconstructed high never exceeded the true high and the low never fell below
// the true low, so the bar is a strict subset of the real session.
async function fetchIntradaySeries(symbol, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
    + `?range=1mo&interval=${interval}&includePrePost=false`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    return (res && (res.timestamp || []).length) ? res : null;
  } catch (e) { return null; }
}

// Reconstruct one session's OHLC from intraday prints. Returns null when the
// date carries no prints at all — which is itself information, handled by the
// caller as "the counter did not trade" rather than "the data is missing".
function reconstructSession(res, date) {
  const ts = res.timestamp || [], q = res.indicators?.quote?.[0] || {};
  const idx = [];
  for (let i = 0; i < ts.length; i++) {
    if (new Date(ts[i] * 1000).toISOString().slice(0, 10) !== date) continue;
    if (q.close?.[i] == null || isNaN(q.close[i])) continue;
    idx.push(i);
  }
  if (idx.length < 2) return null;
  const vol = idx.reduce((s, i) => s + (q.volume?.[i] || 0), 0);
  if (vol <= 0) return null;
  const o = q.open?.[idx[0]] != null ? q.open[idx[0]] : q.close[idx[0]];
  const c = q.close[idx[idx.length - 1]];
  const highs = idx.map(i => q.high?.[i]).filter(v => v != null);
  const lows = idx.map(i => q.low?.[i]).filter(v => v != null);
  const h = Math.max(...highs, o, c), l = Math.min(...lows, o, c);
  if (![o, h, l, c].every(v => isFinite(v) && v > 0)) return null;
  return { o, h, l, c, v: vol, prints: idx.length };
}

// Does the intraday series actually span this date? A series that begins after
// the date in question cannot testify that nothing traded on it. Without this
// check a short intraday window would be read as evidence of a quiet session.
function intradaySpans(res, date) {
  const ts = res.timestamp || [];
  if (!ts.length) return false;
  const days = ts.map(t => new Date(t * 1000).toISOString().slice(0, 10));
  return days.some(d => d < date) && days.some(d => d > date);
}

async function recoverMissingSessions(stockData, gaps) {
  const bySym = {};
  gaps.forEach(g => { (bySym[g.sym] = bySym[g.sym] || []).push(g.date); });
  const recovered = [], untraded = [], unavailable = [];

  // A counter that traded nothing on the sessions running into the missing one
  // did not trade on it either. This settles names too illiquid to hold an
  // intraday series at all: Yahoo returns nothing for them, which proves
  // nothing on its own, while their own daily record is unambiguous.
  //
  // Only bars BEFORE the date count, and only finalised ones. Looking forward
  // would read today's provisional bar — zero volume by construction — as
  // evidence of a quiet market, and a wider backward window reaches past the
  // name's last real trade: ICU.SI traded 11,000 shares on 2026-08-03 and
  // nothing after, so a five-bar window straddling that print reported the name
  // as active and left a settled case unresolved.
  const QUIET_RUN = 3;
  const quietIntoDate = (data, date) => {
    const prior = data.history.filter(b => !b.p && barDateISO(b) < date).slice(-QUIET_RUN);
    return prior.length === QUIET_RUN && prior.every(b => (b.v || 0) === 0);
  };

  for (const [sym, dates] of Object.entries(bySym)) {
    const data = stockData[sym];
    if (!data || !data.history || data.history.length < 2) { dates.forEach(d => unavailable.push({ sym, date: d })); continue; }
    let res = await fetchIntradaySeries(sym, '5m');
    if (!res) res = await fetchIntradaySeries(sym, '1h');
    await new Promise(r => setTimeout(r, DELAY_MS));
    if (!res) {
      dates.forEach(d => (quietIntoDate(data, d) ? untraded : unavailable).push({ sym, date: d }));
      continue;
    }

    for (const date of dates) {
      const bar = reconstructSession(res, date);
      if (!bar) {
        // No prints on the day. If the intraday series demonstrably spans the
        // date, the counter simply did not trade — the daily bar is missing
        // because there was nothing to record, the carried-forward close is
        // right, and the flat reading the engines produce is correct. Nothing
        // to recover and nothing to withdraw.
        if (intradaySpans(res, date) || quietIntoDate(data, date)) untraded.push({ sym, date });
        else unavailable.push({ sym, date });
        continue;
      }
      // Timestamp convention: reuse the time-of-day the ticker's own bars carry
      // (SGX opens 01:00Z, HKEX 01:30Z, US 13:30Z), so the synthesised bar sits
      // on the same grid and resolves to the intended UTC calendar date.
      const ref = data.history[data.history.length - 1];
      const offset = ref.d - Math.floor(ref.d / 86400) * 86400;
      const d = Math.floor(Date.parse(date + 'T00:00:00Z') / 1000) + offset;
      // adjclose: a dividend adjustment restates every bar before its ex-date by
      // the same factor, so the bar immediately preceding the gap carries the
      // factor this one needs. Where no adjustment is in force the ratio is 1.
      const prior = [...data.history].filter(b => b.d < d).pop();
      const factor = (prior && prior.c > 0 && prior.ac != null) ? prior.ac / prior.c : 1;
      data.history.push({
        d,
        c: +bar.c.toFixed(4),
        ac: +(bar.c * factor).toFixed(4),
        o: +bar.o.toFixed(4),
        h: +bar.h.toFixed(4),
        l: +bar.l.toFixed(4),
        v: bar.v,
        r: true,                       // reconstructed, not an official close
      });
      data.history.sort((a, b) => a.d - b.d);
      recovered.push({ sym, date, close: +bar.c.toFixed(4), prints: bar.prints, volume: bar.v });
    }
  }
  return { recovered, untraded, unavailable };
}

// Acknowledged gaps. A missing session is a hard stop the first time it is
// seen — publishing a dashboard whose day boundary is known to be wrong is
// worse than publishing nothing. But Yahoo never backfills these, so an
// unconditional failure would jam every subsequent bake for a fortnight until
// the bad date aged out of the window. The latch resolves that: the bake fails
// once, loudly, and proceeds after the gap is recorded in data_gaps.json with a
// note. Acknowledging is a deliberate act that leaves a reviewable record.
function readAcknowledgedGaps() {
  if (!fs.existsSync(GAPS_FILE)) return new Set();
  try {
    const j = JSON.parse(fs.readFileSync(GAPS_FILE, 'utf-8'));
    return new Set((j.acknowledged || []).map(g => `${g.yf}|${g.date}`));
  } catch (e) {
    console.error(`❌ data_gaps.json is present but unreadable (${e.message}) — refusing to bake on an unknown gap state.`);
    process.exit(1);
  }
}

// ── Concurrent fetcher with progress ──
async function fetchAll(symbols, range) {
  const results = {};
  const queue = [...symbols];
  let done = 0;
  const total = symbols.length;

  async function worker() {
    while (queue.length > 0) {
      const sym = queue.shift();
      done++;
      process.stdout.write(`\r  [${done}/${total}] Fetching ${sym}...`.padEnd(60));
      
      const data = await fetchTicker(sym, range);
      if (data) {
        results[sym] = data;
      } else {
        process.stdout.write(` FAILED`);
      }
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);
  process.stdout.write('\r' + ' '.repeat(70) + '\r');
  return results;
}

// ── Derive JPYSGD=X from the liquid SGDJPY=X cross by inverting it bar by bar.
// JPYSGD is ~0.008, so we keep 7 decimals (the usual 4-dp rounding would round
// it to ~2 significant figures). On inversion high and low swap (1/low > 1/high).
function deriveJpySgd(sgdjpy) {
  if (!sgdjpy || !sgdjpy.history || sgdjpy.history.length < 2) return null;
  const inv = v => (v != null && isFinite(v) && v !== 0) ? +(1 / v).toFixed(7) : null;
  const history = sgdjpy.history.map(b => {
    const o = { d: b.d, c: inv(b.c), ac: inv(b.ac), o: inv(b.o), h: inv(b.l), l: inv(b.h) };
    if (b.p) o.p = true;
    return o;
  }).filter(b => b.c != null);
  if (history.length < 2) return null;
  return { price: inv(sgdjpy.price), prevClose: inv(sgdjpy.prevClose), history };
}

// ── Main ──
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  
  console.log('╔════════════════════════════════════════════╗');
  console.log('║  Portfolio Command Centre — Build Script   ║');
  console.log('╚════════════════════════════════════════════╝\n');

  // Read template
  if (!fs.existsSync(TEMPLATE_FILE)) {
    console.error(`❌ ${TEMPLATE_FILE} not found. Run this script from the project directory.`);
    process.exit(1);
  }
  const html = fs.readFileSync(TEMPLATE_FILE, 'utf-8');

  // Ledger-first universe + integrity gate
  const { trades, book, symbols, noQuote } = readLedger();
  validateLedger(book, trades);
  console.log(`📋 Universe from ledger: ${symbols.length} tickers (${trades.length} trades, ${(book.positions || []).length} opening positions)`);
  if (noQuote.length) console.log(`🚫 Held out of the fetch (no quote source, priced from mktPriceSnap): ${noQuote.join(', ')}`);
  console.log(`💱 Plus ${FX_SYMBOLS.length} FX rates\n`);

  // Fetch stock data
  console.log(`📥 Fetching ${RANGE} history for ${symbols.length} tickers (concurrency: ${CONCURRENCY})...`);
  const stockData = await fetchAll(symbols, RANGE);
  const stockCount = Object.keys(stockData).length;
  console.log(`  ✅ ${stockCount}/${symbols.length} tickers fetched\n`);

  // ── Session audit (see auditSessions above) ──
  // Three passes, escalating. Pass 1 proposes gaps. Every suspect is re-fetched
  // direct from Yahoo, because a degraded payload is indistinguishable from a
  // real gap. Pass 2 rules on the repaired data, and whatever still looks
  // missing is put to the intraday series — which either reconstructs the
  // session, shows the counter did not trade, or cannot say. Pass 3 is the
  // final word, so only a gap that survives all three can stop the bake.
  console.log('🔍 Auditing exchange sessions...');
  const held = heldYahooSymbols(book, trades);
  const passes = [];
  const pass1 = auditSessions(stockData, held);
  passes.push(pass1);
  if (pass1.gaps.length) {
    console.log(`  🔁 verifying ${new Set(pass1.gaps.map(g => g.sym)).size} suspect ticker(s) with a direct re-fetch...`);
    const { repaired, failedRefetch } = await verifySuspectGaps(stockData, pass1.gaps);
    repaired.forEach(r => console.log(`       ${r.sym.padEnd(10)} recovered ${r.dates.join(', ')} on re-fetch — first fetch was degraded, series replaced`));
    if (failedRefetch.length) console.log(`       re-fetch failed for ${failedRefetch.join(', ')} — their gaps stand on the original payload`);
    if (!repaired.length) console.log('       nothing recovered on re-fetch — every suspect gap is real');
  }
  const pass2 = auditSessions(stockData, held);
  passes.push(pass2);

  let recoveredBars = [], untradedSessions = [];
  if (pass2.gaps.length) {
    console.log(`  🩹 reconstructing ${pass2.gaps.length} missing session(s) from intraday prints...`);
    const out = await recoverMissingSessions(stockData, pass2.gaps);
    recoveredBars = out.recovered; untradedSessions = out.untraded;
    out.recovered.forEach(r => console.log(`       ${r.sym.padEnd(10)} ${r.date}  rebuilt close ${r.close} from ${r.prints} prints, ${r.volume.toLocaleString()} shares — tagged, not an official close`));
    out.untraded.forEach(u => console.log(`       ${u.sym.padEnd(10)} ${u.date}  no prints while the exchange was open — the counter did not trade, carried-forward close is correct`));
    out.unavailable.forEach(u => console.log(`       ${u.sym.padEnd(10)} ${u.date}  intraday series could not settle it — gap stands`));
  }
  const pass3 = auditSessions(stockData, held);
  passes.push(pass3);

  // auditSessions strips bars as it goes, so each pass only sees what the last
  // one left plus anything a re-fetch or reconstruction brought back. Union all
  // three, deduped, for an honest drop total; the gap verdict is pass 3's alone.
  const seenDrop = new Set();
  const dropped = passes.flatMap(p => p.dropped).filter(d => {
    const k = `${d.sym}|${d.date}`;
    if (seenDrop.has(k)) return false;
    seenDrop.add(k); return true;
  });
  // A session confirmed as genuinely untraded is not a gap: the missing bar is
  // correct, so the name stays in the day cards on its carried-forward close.
  const untradedKeys = new Set(untradedSessions.map(u => `${u.sym}|${u.date}`));
  const gaps = pass3.gaps.filter(g => !untradedKeys.has(`${g.sym}|${g.date}`));
  const unguarded = pass3.unguarded;
  if (unguarded.length) {
    console.log(`  ℹ️  unguarded calendars (fewer than ${MIN_CALENDAR_GROUP} tickers, no cross-sectional vote possible):`);
    unguarded.forEach(u => console.log(`       ${u}`));
  }
  if (dropped.length) {
    const byDate = {};
    dropped.forEach(d => { (byDate[d.date] = byDate[d.date] || []).push(d.sym); });
    console.log(`  🧹 dropped ${dropped.length} fabricated bars on ${Object.keys(byDate).length} non-session dates:`);
    Object.entries(byDate).sort().forEach(([d, syms]) => console.log(`       ${d}  ${syms.length} bars  (${syms.slice(0, 6).join(', ')}${syms.length > 6 ? ', …' : ''})`));
  } else {
    console.log('  ✅ no fabricated holiday bars found');
  }

  if (recoveredBars.length) console.log(`  🩹 ${recoveredBars.length} session(s) rebuilt from intraday prints and tagged`);
  if (untradedSessions.length) console.log(`  ✅ ${untradedSessions.length} session(s) confirmed as genuine non-trading days — not gaps`);

  const acknowledged = readAcknowledgedGaps();
  const fresh = gaps.filter(g => !acknowledged.has(`${g.sym}|${g.date}`));
  if (gaps.length) {
    console.log(`  ⚠️  ${gaps.length} unresolved missing session(s) on held tickers within the last ${AUDIT_WINDOW} sessions:`);
    gaps.forEach(g => console.log(`       ${g.sym.padEnd(10)} ${g.date}  ${acknowledged.has(`${g.sym}|${g.date}`) ? '(acknowledged)' : '<< NEW'}`));
  } else {
    console.log('  ✅ no unresolved missing sessions on held tickers');
  }
  if (fresh.length) {
    console.error('\n❌ Bake stopped: a held position is missing a real trading session that could not be');
    console.error('   resolved. The re-fetch did not supply it, and the intraday series could neither');
    console.error('   reconstruct it nor confirm the counter was untraded. The day boundary would be');
    console.error('   anchored on the wrong bar, so the Intraday and 1-Day cards would report a wrong');
    console.error('   split without saying so. Establish by hand what happened on each date, then');
    console.error('   record it in data_gaps.json to acknowledge it and allow the bake to proceed:\n');
    fresh.forEach(g => console.error(`     { "yf": "${g.sym}", "date": "${g.date}", "note": "" }`));
    process.exit(1);
  }
  console.log('');

  const totalBars = Object.values(stockData).reduce((s, d) => s + d.history.length, 0);
  console.log(`  📊 ${totalBars.toLocaleString()} bars after audit\n`);

  // Fetch FX
  console.log(`💱 Fetching FX rates...`);
  const fxData = await fetchAll(FX_SYMBOLS, '1y');
  // Convert the SGDJPY=X cross into a proper JPYSGD=X series (full history,
  // accurate level) and drop the raw cross so the output keys are unchanged.
  const jpy = deriveJpySgd(fxData['SGDJPY=X']);
  if (jpy) {
    fxData['JPYSGD=X'] = jpy;
    console.log(`  ↳ derived JPYSGD=X from SGDJPY=X (${jpy.history.length} bars, level ${jpy.price})`);
  } else {
    console.log(`  ⚠️  could not derive JPYSGD=X from SGDJPY=X — JPY FX history will be unavailable`);
  }
  delete fxData['SGDJPY=X'];
  const fxCount = Object.keys(fxData).length;
  console.log(`  ✅ ${fxCount} FX rates ready\n`);

  // Merge
  const allData = { ...stockData, ...fxData };

  // Audit-only fields never reach the client: volume exists solely to tell a
  // real session from a fabricated one, and exchangeTz solely to group tickers
  // by trading calendar. Stripping at serialisation avoids copying an 11 MB
  // structure just to delete two keys.
  const stripAudit = (k, val) => (k === 'v' || k === 'exchangeTz') ? undefined : val;

  // Size estimate
  const jsonStr = JSON.stringify(allData, stripAudit);
  const sizeMB = (jsonStr.length / 1024 / 1024).toFixed(1);
  console.log(`📦 Data size: ${sizeMB} MB uncompressed (gzipped ~${(jsonStr.length / 1024 / 1024 * 0.2).toFixed(1)} MB)`);

  if (dryRun) {
    console.log('\n🏁 Dry run complete — no files modified.');
    // Print summary per ticker
    for (const [sym, data] of Object.entries(allData)) {
      if (!sym.includes('=')) {
        console.log(`  ${sym}: ${data.history.length} bars, price=${data.price}`);
      }
    }
    return;
  }

  // Build date string
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const isoDate = now.toISOString();

  // Ensure docs/ and docs/data/ exist
  if (!fs.existsSync(DOCS_DIR)) {
    fs.mkdirSync(DOCS_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Write docs/data/history.json (stock OHLC only — FX goes to fx.json)
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(stockData, stripAudit), 'utf-8');

  // Write docs/data/fx.json (FX rates only)
  fs.writeFileSync(FX_FILE, JSON.stringify(fxData, stripAudit), 'utf-8');

  // Copy the user-authored ledger files into docs/data/ so the client can
  // fetch them alongside history.json. The root copies remain the source of
  // truth; the docs/ copies are pipeline-owned output like everything else
  // under docs/.
  fs.copyFileSync(TRADES_SRC, path.join(DATA_DIR, 'trades.json'));
  fs.copyFileSync(BOOK_SRC, path.join(DATA_DIR, 'book.json'));
  // theses.json (per-holding investment theses for the Thesis tab) — user-owned
  // input copied into docs/data/ for the client to fetch, like the ledger files.
  const THESES_SRC = path.join(__dirname, 'theses.json');
  if (fs.existsSync(THESES_SRC)) fs.copyFileSync(THESES_SRC, path.join(DATA_DIR, 'theses.json'));

  // Write docs/data/meta.json (date, ticker list, generation timestamp)
  const meta = {
    date: dateStr,
    generatedAt: isoDate,
    tickers: Object.keys(stockData),
    fxSymbols: Object.keys(fxData),
    tickerCount: stockCount,
    fxCount,
    totalBars,
    // Unresolved feed gaps: the client withdraws these names from the day cards
    // rather than anchor them on the wrong bar. Each has been acknowledged in
    // data_gaps.json.
    dataGaps: gaps.map(g => ({ yf: g.sym, date: g.date })),
    // Sessions rebuilt from intraday prints. The bar is in history and the day
    // boundary is sound, but the close is a reconstruction that stops short of
    // the closing auction — so the client marks anything resting on it rather
    // than passing it off as an official close.
    recoveredBars: recoveredBars.map(r => ({ yf: r.sym, date: r.date, close: r.close, prints: r.prints })),
  };
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf-8');

  // Copy template.html → docs/index.html. The client fetches data/*.json on
  // page load; no injection happens here.
  fs.writeFileSync(OUTPUT_FILE, html, 'utf-8');

  // Ensure docs/.nojekyll so GitHub Pages skips Jekyll processing.
  if (!fs.existsSync(NOJEKYLL_FILE)) {
    fs.writeFileSync(NOJEKYLL_FILE, '', 'utf-8');
  }

  const histSizeKB = (fs.statSync(HISTORY_FILE).size / 1024).toFixed(0);
  const fxSizeKB = (fs.statSync(FX_FILE).size / 1024).toFixed(1);
  const htmlSizeKB = (html.length / 1024).toFixed(0);
  console.log(`\n✅ Wrote docs/data/history.json (${histSizeKB} KB), docs/data/fx.json (${fxSizeKB} KB), docs/data/meta.json`);
  console.log(`   ${stockCount} tickers with ${totalBars.toLocaleString()} bars of history`);
  console.log(`   ${fxCount} FX rates`);
  console.log(`   Data as of: ${dateStr}`);
  console.log(`✅ Wrote docs/index.html (${htmlSizeKB} KB, straight copy of template.html)`);
  console.log(`\n🚀 Ready to deploy: git add docs/ && git commit -m "Bake ${dateStr}" && git push`);

  // Report failures
  const failed = symbols.filter(s => !stockData[s]);
  if (failed.length > 0) {
    console.log(`\n⚠️  Failed tickers (${failed.length}): ${failed.join(', ')}`);
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
