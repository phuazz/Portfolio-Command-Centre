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
  for (const m of Object.values(book.meta || {})) if (m.yf) symbols.add(m.yf);
  for (const t of trades) if (t.yf) symbols.add(t.yf);
  return { trades, book, symbols: [...symbols] };
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
async function fetchTicker(symbol, range = '10y') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  
  // Try direct first, then CORS proxies
  const urls = [
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
            l: +(lows[i] || closes[i]).toFixed(4)
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

      return { price: +price.toFixed(4), prevClose: +prevClose.toFixed(4), history };
    } catch (e) {
      // Try next proxy
    }
  }
  return null;
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
  const { trades, book, symbols } = readLedger();
  validateLedger(book, trades);
  console.log(`📋 Universe from ledger: ${symbols.length} tickers (${trades.length} trades, ${(book.positions || []).length} opening positions)`);
  console.log(`💱 Plus ${FX_SYMBOLS.length} FX rates\n`);

  // Fetch stock data
  console.log(`📥 Fetching ${RANGE} history for ${symbols.length} tickers (concurrency: ${CONCURRENCY})...`);
  const stockData = await fetchAll(symbols, RANGE);
  const stockCount = Object.keys(stockData).length;
  const totalBars = Object.values(stockData).reduce((s, d) => s + d.history.length, 0);
  console.log(`  ✅ ${stockCount}/${symbols.length} tickers fetched (${totalBars.toLocaleString()} total bars)\n`);

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

  // Size estimate
  const jsonStr = JSON.stringify(allData);
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
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(stockData), 'utf-8');

  // Write docs/data/fx.json (FX rates only)
  fs.writeFileSync(FX_FILE, JSON.stringify(fxData), 'utf-8');

  // Copy the user-authored ledger files into docs/data/ so the client can
  // fetch them alongside history.json. The root copies remain the source of
  // truth; the docs/ copies are pipeline-owned output like everything else
  // under docs/.
  fs.copyFileSync(TRADES_SRC, path.join(DATA_DIR, 'trades.json'));
  fs.copyFileSync(BOOK_SRC, path.join(DATA_DIR, 'book.json'));

  // Write docs/data/meta.json (date, ticker list, generation timestamp)
  const meta = {
    date: dateStr,
    generatedAt: isoDate,
    tickers: Object.keys(stockData),
    fxSymbols: Object.keys(fxData),
    tickerCount: stockCount,
    fxCount,
    totalBars,
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
