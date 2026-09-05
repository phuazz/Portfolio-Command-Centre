#!/usr/bin/env node
/**
 * validate_ledger.js — standing validation gate for the ledger-first book.
 *
 * Mirrors the client's replayLedger() (average-cost, fee-inclusive buys,
 * zero-crossing lot reset, costAdjustments) and build.js validateLedger()
 * (no oversells), then derives the cash buckets from cashAnchor plus
 * strictly-later trades. Two modes:
 *
 *   node scripts/validate_ledger.js
 *     Structural gate: oversells, replay, derived buckets (with SGD values
 *     from docs/data/fx.json when available). Run before pushing any
 *     trade-entry commit — it catches locally what would otherwise fail
 *     the scheduled bake.
 *
 *   node scripts/validate_ledger.js --expect <path/to/expectations.json>
 *     Statement tie-out gate for the monthly reconciliation. The
 *     expectations file is statement-derived and lives OUTSIDE the
 *     repository. Format:
 *       {
 *         "asOf": "YYYY-MM-DD",
 *         "holdings": { "TICKER": [qty, feeInclusiveAvg], ... },
 *         "closedOnStatement": ["TICKER", ...],
 *         "balances": { "USD": 0, "HKD": 0, ... }
 *       }
 *     Gates: quantity exact; average within broker rounding
 *     (max(0.005, avg x 5e-6)); every expected ticker present; every
 *     derived open brokerage position present in expectations; buckets
 *     equal the expected balances exactly.
 *
 * Exit code 0 on pass, 1 on any failure. Nothing personal is read or
 * written: the repository ledger carries only tickers, quantities, prices,
 * fees and anchor balances.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const trades = JSON.parse(fs.readFileSync(path.join(ROOT, 'trades.json'), 'utf8'));
const book = JSON.parse(fs.readFileSync(path.join(ROOT, 'book.json'), 'utf8'));

let failures = 0;
const fail = m => { failures++; console.log('FAIL  ' + m); };
const pass = m => console.log('pass  ' + m);

// ── Oversell gate (mirrors build.js validateLedger) ──
{
  const sorted = [...trades].filter(t => t.a === 'B' || t.a === 'S').sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
  const qty = {};
  for (const op of book.positions || []) qty[op.ticker] = op.qty;
  const overrides = book.ledgerOverrides || {};
  let ok = true;
  for (const t of sorted) {
    qty[t.t] = (qty[t.t] || 0) + (t.a === 'B' ? t.q : -t.q);
    if (qty[t.t] < -1e-9 && !overrides[t.t]) { fail(`oversell ${t.d} ${t.t} (running qty ${qty[t.t]})`); ok = false; }
  }
  for (const [tk, ov] of Object.entries(overrides)) console.log(`note  ledger override active: ${tk} -> qty ${ov.qty}`);
  if (ok) pass('no oversells');
}

// ── Replay (mirrors template.html replayLedger) ──
function replay() {
  const sorted = [...trades].filter(t => t.a === 'B' || t.a === 'S').sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
  const byTicker = {};
  for (const t of sorted) (byTicker[t.t] = byTicker[t.t] || []).push(t);
  const adj = book.costAdjustments || {};
  const out = [];
  const seen = new Set();
  // costedQty mirrors the client: the part of a position with a recorded
  // cost. A null opening cost (CDP legacy holding) is unknown, not zero, so a
  // top-up on such a name yields a mixed position whose P&L the dashboard
  // measures on the costed lot alone. Sells come out of both lots pro rata.
  const replayOne = (openQty, openInv, openCostedQty, tr) => {
    let q = openQty, inv = openInv, costedQty = openCostedQty;
    for (const t of tr) {
      if (t.a === 'B') { q += t.q; costedQty += t.q; inv += t.q * t.p + (t.fee || 0); }
      else {
        const avg = q > 0 ? inv / q : 0;
        const costedFrac = q > 0 ? costedQty / q : 0;
        inv -= t.q * avg;
        costedQty -= t.q * costedFrac;
        q -= t.q;
      }
      if (q <= 1e-9) { q = 0; costedQty = 0; inv = 0; }   // zero-crossing resets the lot
    }
    return { q, costedQty, inv };
  };
  for (const op of book.positions) {
    seen.add(op.ticker);
    const tr = byTicker[op.ticker] || [];
    const costed = op.invested != null;
    if (tr.length === 0) {
      out.push({ ticker: op.ticker, qty: op.qty, costedQty: costed ? op.qty : 0, avg: op.avgPrice, inv: op.invested });
      continue;
    }
    const r = replayOne(op.qty, costed ? op.invested : 0, costed ? op.qty : 0, tr);
    const inv = r.inv + (r.q > 0 ? (adj[op.ticker] || 0) : 0);
    if (r.q > 0) out.push({ ticker: op.ticker, qty: r.q, costedQty: r.costedQty,
      avg: r.costedQty > 0 ? inv / r.costedQty : null, inv: r.costedQty > 0 ? inv : null });
  }
  for (const tk of Object.keys(byTicker)) {
    if (seen.has(tk)) continue;
    const r = replayOne(0, 0, 0, byTicker[tk]);
    const inv = r.q > 0 ? r.inv + (adj[tk] || 0) : 0;
    if (r.q > 0) out.push({ ticker: tk, qty: r.q, costedQty: r.costedQty, avg: inv / r.q, inv });
  }
  return out;
}
const derived = replay();
pass(`replay produced ${derived.length} open positions`);
// Surface every mixed position so the partial basis is visible at each gate
// run rather than only on the dashboard.
for (const p of derived) {
  if (p.inv != null && p.costedQty > 1e-9 && p.costedQty < p.qty - 1e-9) {
    console.log(`note  ${p.ticker}: ${p.qty} held, cost recorded for ${Number(p.costedQty.toFixed(4))} (avg ${p.avg.toFixed(4)}); the opening lot carries no cost, so P&L is reported on the costed shares only`);
  }
}

// ── Cash buckets: anchor plus strictly-later trades, floored at zero ──
const sortedT = [...trades].filter(t => t.a === 'B' || t.a === 'S').sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
let fxRates = {};
try {
  const fx = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/data/fx.json'), 'utf8'));
  for (const ccy of Object.keys(book.cashAnchor.balances)) {
    const s = fx[ccy + 'SGD=X'];
    if (s && s.price) fxRates[ccy] = s.price;
  }
} catch (e) { /* fx.json unavailable — print native amounts only */ }

const buckets = {};
console.log(`\nDerived cash buckets (anchor ${book.cashAnchor.date} + later trades):`);
for (const ccy of Object.keys(book.cashAnchor.balances)) {
  let cash = book.cashAnchor.balances[ccy];
  for (const t of sortedT) if (t.ccy === ccy && t.d > book.cashAnchor.date) cash += (t.a === 'S' ? t.q * t.p : -(t.q * t.p));
  if (cash < 0) { console.log(`note  ${ccy} floored at zero (externally funded buy since anchor)`); cash = 0; }
  buckets[ccy] = cash;
  const sgd = fxRates[ccy] != null ? `  (~S$${(cash * fxRates[ccy]).toFixed(0)})` : '';
  console.log(`  ${ccy}: ${cash.toFixed(2)}${sgd}`);
}
console.log('');

// ── Statement tie-out (only with --expect) ──
const expectIdx = process.argv.indexOf('--expect');
if (expectIdx !== -1) {
  const expectPath = process.argv[expectIdx + 1];
  if (!expectPath) { fail('--expect given without a file path'); }
  else {
    const exp = JSON.parse(fs.readFileSync(expectPath, 'utf8'));
    const byTk = Object.fromEntries(derived.map(p => [p.ticker, p]));
    console.log(`Statement tie-out as of ${exp.asOf || '(no date given)'}:`);

    for (const [tk, [q, avg]] of Object.entries(exp.holdings || {})) {
      const d = byTk[tk];
      if (!d) { fail(`${tk}: on statement but not in derived open positions`); continue; }
      if (Math.abs(d.qty - q) > 1e-9) { fail(`${tk}: qty ${d.qty} vs statement ${q}`); continue; }
      const diff = d.avg - avg;
      const tol = Math.max(0.005, avg * 5e-6);   // broker rounding tolerance
      if (Math.abs(diff) > tol) fail(`${tk}: avg ${d.avg.toFixed(4)} vs statement ${avg} (diff ${diff.toFixed(4)}, tol ${tol.toFixed(4)})`);
      else pass(`${tk}: qty ${q} exact, avg diff ${(diff >= 0 ? '+' : '') + diff.toFixed(4)}`);
    }

    for (const tk of exp.closedOnStatement || []) {
      if (byTk[tk]) fail(`${tk}: statement shows zero holding but replay has an open position`);
      else pass(`${tk}: closed in replay, zero on statement`);
    }

    // Reverse check: every derived open brokerage-sleeve position must be expected.
    const meta = book.meta || {};
    let reverseOk = true;
    for (const p of derived) {
      const m = meta[p.ticker] || {};
      if (m.account === 'CDP' || m.type === 'Cash' || m.type === 'Bond') continue;
      if (p.ticker.endsWith('.CASH')) continue;
      if (!(exp.holdings && p.ticker in exp.holdings)) { fail(`${p.ticker}: derived open brokerage position not on statement`); reverseOk = false; }
    }
    if (reverseOk) pass('reverse check: no derived brokerage position missing from statement');

    for (const [ccy, bal] of Object.entries(exp.balances || {})) {
      if (!(ccy in buckets)) { fail(`${ccy}: expected balance given but no such anchor currency`); continue; }
      if (Math.abs(buckets[ccy] - bal) > 1e-6) fail(`${ccy} bucket ${buckets[ccy].toFixed(2)} vs expected ${bal}`);
      else pass(`${ccy} bucket ties (${bal})`);
    }
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL GATES PASS');
process.exit(failures ? 1 : 0);
