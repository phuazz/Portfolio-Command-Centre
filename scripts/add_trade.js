#!/usr/bin/env node
/**
 * add_trade.js — append one fill to trades.json with zero hand-editing.
 *
 * Usage:
 *   node scripts/add_trade.js <YYYY-MM-DD> <B|S> <qty> <TICKER> <price> [--dry-run]
 *
 * Existing tickers only: currency, Yahoo symbol and theme are looked up
 * from book.json meta (falling back to the ticker's most recent trade
 * row). A brand-new ticker needs a meta entry first — use the assisted
 * workflow in CLAUDE.md for that case. No fee field is written; the
 * monthly statement reconciliation backfills fees.
 *
 * The append is a text splice at the end of the array, so existing rows
 * are byte-untouched. Run scripts/validate_ledger.js afterwards (the
 * wrapper does) before committing.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TRADES = path.join(ROOT, 'trades.json');

const args = process.argv.slice(2).filter(a => a !== '--dry-run');
const dryRun = process.argv.includes('--dry-run');
if (args.length !== 5) {
  console.error('Usage: node scripts/add_trade.js <YYYY-MM-DD> <B|S> <qty> <TICKER> <price> [--dry-run]');
  process.exit(1);
}
const [d, a, qStr, t, pStr] = args;

// ── Validate arguments ──
if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(Date.parse(d + 'T00:00:00Z'))) {
  console.error(`Invalid date: ${d} (expected YYYY-MM-DD)`); process.exit(1);
}
if (a !== 'B' && a !== 'S') { console.error(`Invalid action: ${a} (expected B or S)`); process.exit(1); }
const q = Number(qStr), p = Number(pStr);
if (!(q > 0) || !(p > 0)) { console.error(`Invalid qty/price: ${qStr} / ${pStr}`); process.exit(1); }

// ── Resolve ccy / yf / theme from book meta, else the latest trade row ──
const book = JSON.parse(fs.readFileSync(path.join(ROOT, 'book.json'), 'utf8'));
const tradesText = fs.readFileSync(TRADES, 'utf8');
const trades = JSON.parse(tradesText);

let ccy, yf, th;
const m = (book.meta || {})[t];
if (m) { ccy = m.ccy; yf = m.yf; th = m.theme; }
else {
  const prior = trades.filter(r => r.t === t).pop();
  if (prior) { ccy = prior.ccy; yf = prior.yf; th = prior.th; }
}
if (!ccy) {
  console.error(`${t} is not in book.json meta and has no prior trade row.`);
  console.error('New tickers need a meta entry first — use the assisted trade-entry workflow in CLAUDE.md.');
  process.exit(1);
}

// ── Duplicate guard: identical row already present ──
if (trades.some(r => r.d === d && r.t === t && r.a === a && r.q === q && r.p === p)) {
  console.error(`Duplicate: an identical row (${d} ${t} ${a} ${q} @ ${p}) already exists. Nothing written.`);
  process.exit(1);
}

// ── Cost-basis note: a fill on an opening lot that carries no cost ──
// The dashboard measures P&L on the shares with a recorded cost only, so a
// fill here produces a mixed position. Said once at entry, where the user
// can still decide to enter the opening cost in book.json instead.
const op = (book.positions || []).find(r => r.ticker === t);
if (op && op.invested == null) {
  console.log(`note  ${t}: the opening lot of ${op.qty} carries no cost in book.json (avgPrice/invested null).`);
  console.log(`      P&L will be reported on the shares with a recorded cost only; enter the opening cost in book.json if it is known.`);
}

// ── Build the row in the file's established key order and style ──
const row = `  {"d": "${d}", "t": "${t}", "a": "${a}", "q": ${q}, "p": ${p}, "ccy": "${ccy}", "yf": ${yf == null ? 'null' : `"${yf}"`}, "th": "${th}"}`;

// ── Text splice: existing rows stay byte-identical ──
const trimmed = tradesText.replace(/\s+$/, '');
if (!trimmed.endsWith('}\n]') && !trimmed.endsWith('}\r\n]')) {
  console.error('trades.json does not end with the expected }\\n] — refusing to splice. Append manually.');
  process.exit(1);
}
const eol = trimmed.endsWith('}\r\n]') ? '\r\n' : '\n';
const out = trimmed.slice(0, trimmed.length - 1).replace(/\}\s*$/, '},') + eol + row + eol + ']' + eol;

// Sanity: the spliced text must still parse and grow by exactly one row.
const reparsed = JSON.parse(out);
if (reparsed.length !== trades.length + 1) {
  console.error('Splice sanity check failed — nothing written.'); process.exit(1);
}

console.log('Row: ' + row.trim());
if (dryRun) { console.log('(dry run — nothing written)'); process.exit(0); }
fs.writeFileSync(TRADES, out, 'utf8');
console.log(`Appended to trades.json (${reparsed.length} rows). Next: node scripts/validate_ledger.js`);
