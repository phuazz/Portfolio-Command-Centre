#!/usr/bin/env node
/**
 * build.js — Fetch historical price data and bake it into index.html
 * 
 * This script:
 *   1. Reads index.html and extracts all Yahoo Finance ticker symbols
 *   2. Fetches 3-year daily OHLC history for each ticker
 *   3. Fetches FX rates (HKDSGD, JPYSGD, USDSGD)
 *   4. Embeds the data as PRELOADED_HISTORY in the HTML
 *   5. Writes the baked file — loads instantly with zero network fetch
 *
 * Usage:
 *   node build.js              # Bake data into index.html
 *   node build.js --dry-run    # Fetch data but don't modify HTML
 *
 * Requirements: Node.js 18+ (uses native fetch)
 */

const fs = require('fs');
const path = require('path');

const HTML_FILE = path.join(__dirname, 'index.html');
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

  // Read HTML
  if (!fs.existsSync(HTML_FILE)) {
    console.error(`❌ ${HTML_FILE} not found. Run this script from the project directory.`);
    process.exit(1);
  }
  let html = fs.readFileSync(HTML_FILE, 'utf-8');

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

  // Inject into HTML
  // Replace PRELOADED_HISTORY
  html = html.replace(
    /const PRELOADED_HISTORY = \{[^}]*\};/,
    `const PRELOADED_HISTORY = ${jsonStr};`
  );
  
  // Replace PRELOADED_DATE
  html = html.replace(
    /const PRELOADED_DATE = [^;]+;/,
    `const PRELOADED_DATE = '${dateStr}';`
  );

  // Update SNAPSHOT prices from fetched data (keep them in sync)
  for (const [sym, data] of Object.entries(allData)) {
    if (!sym.includes('=') && data.price) {
      // Update SNAPSHOT object values
      const snapRegex = new RegExp(`'${sym.replace(/\./g, '\\.')}':([\\d.]+)`);
      if (html.match(snapRegex)) {
        html = html.replace(snapRegex, `'${sym}':${data.price}`);
      }
    }
  }

  // Write
  fs.writeFileSync(HTML_FILE, html, 'utf-8');
  const finalSize = (html.length / 1024).toFixed(0);
  console.log(`\n✅ Baked into ${HTML_FILE} (${finalSize} KB)`);
  console.log(`   ${stockCount} tickers with ${totalBars.toLocaleString()} bars of history`);
  console.log(`   ${fxCount} FX rates`);
  console.log(`   Data as of: ${dateStr}`);
  console.log(`\n🚀 Ready to deploy: git add . && git commit -m "Bake ${dateStr}" && git push`);

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
