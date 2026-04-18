#!/usr/bin/env node
/**
 * build.js — Fetch historical price data and write it out for the dashboard.
 *
 * This script:
 *   1. Reads template.html and extracts all Yahoo Finance ticker symbols
 *   2. Fetches 10-year daily OHLC history for each ticker
 *   3. Fetches FX rates (HKDSGD, JPYSGD, USDSGD)
 *   4. Writes data/history.json (stock OHLC), data/fx.json (FX rates)
 *      and data/meta.json (build date, ticker list) for the client to fetch
 *   5. Writes index.html as a straight copy of template.html at the repo root
 *   6. Phase 3 dual-write: mirrors the full output into docs/ as well —
 *      docs/index.html, docs/data/*.json, and docs/.nojekyll. Both locations
 *      are self-contained static sites, differing only in where they sit on
 *      disk. Phase 4 will collapse this back down to docs/ only once GitHub
 *      Pages is switched to serve from docs/.
 *
 * The client bootstraps by fetching the three data/*.json files on page load.
 *
 * Usage:
 *   node build.js              # Write data/*.json and rebuild both locations
 *   node build.js --dry-run    # Fetch data but don't write anything
 *
 * Requirements: Node.js 18+ (uses native fetch)
 */

const fs = require('fs');
const path = require('path');

const TEMPLATE_FILE = path.join(__dirname, 'template.html');
const OUTPUT_FILE = path.join(__dirname, 'index.html');
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const FX_FILE = path.join(DATA_DIR, 'fx.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');
// Phase 3: dual-write transitional state. The pipeline mirrors the full
// output (index.html + data/) into docs/ as well, so GitHub Pages can be
// switched from root → docs/ in Phase 4 without any pipeline change.
const DOCS_DIR = path.join(__dirname, 'docs');
const DOCS_DATA_DIR = path.join(DOCS_DIR, 'data');
const DOCS_OUTPUT_FILE = path.join(DOCS_DIR, 'index.html');
const DOCS_NOJEKYLL = path.join(DOCS_DIR, '.nojekyll');
const CONCURRENCY = 5;
const DELAY_MS = 150;       // Polite delay between requests
const RANGE = '10y';        // 10 years for full backtest support
const FX_SYMBOLS = ['HKDSGD=X', 'JPYSGD=X', 'USDSGD=X'];

// ── Extract YF symbols from HTML ──
function extractSymbols(html) {
  const matches = html.matchAll(/yf:'([^']+)'/g);
  const symbols = new Set();
  for (const m of matches) {
    if (m[1] && m[1] !== 'null') symbols.add(m[1]);
  }
  return [...symbols];
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
      const timestamps = result.timestamp || [];
      const closes = quotes?.close || [];
      const opens = quotes?.open || [];
      const highs = quotes?.high || [];
      const lows = quotes?.low || [];

      const price = meta.regularMarketPrice || closes.filter(c => c != null).pop();
      const prevClose = meta.chartPreviousClose || closes.filter(c => c != null).slice(-2)[0];
      
      const history = [];
      for (let i = 0; i < timestamps.length; i++) {
        if (closes[i] != null && !isNaN(closes[i])) {
          history.push({
            d: timestamps[i],
            c: +closes[i].toFixed(4),
            o: +(opens[i] || closes[i]).toFixed(4),
            h: +(highs[i] || closes[i]).toFixed(4),
            l: +(lows[i] || closes[i]).toFixed(4)
          });
        }
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

  // Extract symbols
  const symbols = extractSymbols(html);
  console.log(`📋 Found ${symbols.length} tickers: ${symbols.slice(0, 8).join(', ')}${symbols.length > 8 ? '...' : ''}`);
  console.log(`💱 Plus ${FX_SYMBOLS.length} FX rates\n`);

  // Fetch stock data
  console.log(`📥 Fetching ${RANGE} history for ${symbols.length} tickers (concurrency: ${CONCURRENCY})...`);
  const stockData = await fetchAll(symbols, RANGE);
  const stockCount = Object.keys(stockData).length;
  const totalBars = Object.values(stockData).reduce((s, d) => s + d.history.length, 0);
  console.log(`  ✅ ${stockCount}/${symbols.length} tickers fetched (${totalBars.toLocaleString()} total bars)\n`);

  // Fetch FX
  console.log(`💱 Fetching FX rates...`);
  const fxData = await fetchAll(FX_SYMBOLS, '5d');
  const fxCount = Object.keys(fxData).length;
  console.log(`  ✅ ${fxCount}/${FX_SYMBOLS.length} FX rates fetched\n`);

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

  // Ensure data/ exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Write data/history.json (stock OHLC only — FX goes to data/fx.json)
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(stockData), 'utf-8');

  // Write data/fx.json (FX rates only)
  fs.writeFileSync(FX_FILE, JSON.stringify(fxData), 'utf-8');

  // Write data/meta.json (date, ticker list, generation timestamp)
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

  // Copy template.html → index.html at the repo root. The client fetches
  // data/*.json on page load; no injection happens here in Phase 2.
  fs.writeFileSync(OUTPUT_FILE, html, 'utf-8');

  // Phase 3 dual-write: mirror the root output into docs/ so GitHub Pages
  // can be switched from root → docs/ in Phase 4 without any pipeline
  // change. docs/index.html must stay byte-identical to root index.html.
  if (!fs.existsSync(DOCS_DIR)) {
    fs.mkdirSync(DOCS_DIR, { recursive: true });
  }
  if (!fs.existsSync(DOCS_DATA_DIR)) {
    fs.mkdirSync(DOCS_DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(DOCS_OUTPUT_FILE, html, 'utf-8');
  fs.copyFileSync(HISTORY_FILE, path.join(DOCS_DATA_DIR, 'history.json'));
  fs.copyFileSync(FX_FILE, path.join(DOCS_DATA_DIR, 'fx.json'));
  fs.copyFileSync(META_FILE, path.join(DOCS_DATA_DIR, 'meta.json'));
  if (!fs.existsSync(DOCS_NOJEKYLL)) {
    fs.writeFileSync(DOCS_NOJEKYLL, '', 'utf-8');
  }

  const histSizeKB = (fs.statSync(HISTORY_FILE).size / 1024).toFixed(0);
  const fxSizeKB = (fs.statSync(FX_FILE).size / 1024).toFixed(1);
  const htmlSizeKB = (html.length / 1024).toFixed(0);
  console.log(`\n✅ Wrote data/history.json (${histSizeKB} KB), data/fx.json (${fxSizeKB} KB), data/meta.json`);
  console.log(`   ${stockCount} tickers with ${totalBars.toLocaleString()} bars of history`);
  console.log(`   ${fxCount} FX rates`);
  console.log(`   Data as of: ${dateStr}`);
  console.log(`✅ Wrote ${OUTPUT_FILE} (${htmlSizeKB} KB, straight copy of template.html)`);
  console.log(`✅ Mirrored to docs/: docs/index.html + docs/data/*.json (+ docs/.nojekyll)`);
  console.log(`\n🚀 Ready to deploy: git add index.html data/ docs/ && git commit -m "Bake ${dateStr}" && git push`);

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
