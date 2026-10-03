#!/usr/bin/env node
/**
 * add_trade.js — append one fill to trades.json with zero hand-editing.
 *
 * Usage:
 *   node scripts/add_trade.js <YYYY-MM-DD> <B|S> <qty> <TICKER> <price> "<ref>" [--dry-run]
 *
 * Existing tickers only: currency, Yahoo symbol and theme are looked up
 * from book.json meta (falling back to the ticker's most recent trade
 * row). A brand-new ticker needs a meta entry first — use the assisted
 * workflow in CLAUDE.md for that case. No fee field is written; the
 * monthly statement reconciliation backfills fees.
 *
 * <ref> (required since 2026-09-19) names the decision the fill expresses,
 * so a trade can be traced back to the record that motivated it: a kickoff
 * or study path with its date ("command-centre/STATE_TABLE.md 2026-09-12"),
 * a ledger row ("ledger 2026-08-21 tradfi-thematic"), an escalation-queue
 * item, or "owner <date>: <one line>" for a named discretionary decision.
 * Never a broker, account or statement reference. validate_ledger.js
 * requires it on every row dated on or after 2026-09-19.
 *
 * The append is a text splice at the end of the array, so existing rows
 * are byte-untouched. Run scripts/validate_ledger.js afterwards (the
 * wrapper does) before committing.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TRADES = path.join(ROOT, 'trades.json');
const D = require('./decisions');

// --decision <id> links the fill to its row in decisions.json (the cooling-off
// rule, PREREG_cooling-off-rule.md); required on every fill dated on or after
// the adoption date. --override "<reason>" records a fill placed while a fired
// decision had not cleared or expired: allowed, never hidden.
const argvAll = process.argv.slice(2);
const takeOpt = (name) => { const i = argvAll.indexOf(name); if (i === -1) return undefined; const v = argvAll[i + 1]; argvAll.splice(i, 2); return v; };
const decisionId = takeOpt('--decision');
const overrideRaw = takeOpt('--override');
const dryRun = argvAll.includes('--dry-run');
const args = argvAll.filter(a => a !== '--dry-run');
if (args.length !== 6) {
  console.error('Usage: node scripts/add_trade.js <YYYY-MM-DD> <B|S> <qty> <TICKER> <price> "<ref>" [--decision <id>] [--override "<reason>"] [--dry-run]');
  console.error('<ref> names the decision the fill expresses (a kickoff or study path with its date, a ledger row, an escalation-queue item, or "owner <date>: <one line>"). Required since 2026-09-19.');
  console.error('--decision <id> links the fill to its decisions.json row (required once the cooling-off rule is adopted).');
  process.exit(1);
}
const [d, a, qStr, t, pStr, refRaw] = args;

// ── Decision reference: non-empty, one line, no quotes, never a broker/account reference ──
const ref = String(refRaw).trim();
if (!ref || ref.length > 160 || /[\r\n"]/.test(ref)) {
  console.error(`Invalid ref: ${JSON.stringify(refRaw)} (non-empty, one line, up to 160 characters, no double quotes)`); process.exit(1);
}
if (/\b(account|acct|a\/c|statement|broker)\b/i.test(ref) || /\d{6,}/.test(ref)) {
  console.error('Invalid ref: it looks like an account, statement or broker reference. The ref names a DECISION record, never an account.'); process.exit(1);
}

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

// ── Cooling-off decision link (PREREG_cooling-off-rule.md) ──
// After adoption every fill must link to a decision row; a fired decision that
// has not cleared or expired by the fill date needs --override with a reason.
const decLog = D.loadDecisions(ROOT);
let decOutcome = null;
const overrideReason = overrideRaw == null ? null : String(overrideRaw).trim();
if (overrideReason != null && (!overrideReason || overrideReason.length > 160 || /[\r\n"]/.test(overrideReason))) {
  console.error('Invalid --override reason: non-empty, one line, up to 160 characters, no double quotes'); process.exit(1);
}
if (decLog.data.adopted && d >= decLog.data.adopted && !decisionId) {
  console.error(`The cooling-off rule is adopted from ${decLog.data.adopted}: every fill needs --decision <id>. Log the decision first with scripts/add_decision.js, then re-run with --decision.`);
  process.exit(1);
}
if (decisionId) {
  const verdict = D.assessLink(decLog.data, decisionId, { d, t, a }, overrideReason);
  if (!verdict.ok) { console.error(`Decision link refused: ${verdict.reason}`); process.exit(1); }
  decOutcome = verdict.outcome;
  if (decOutcome === 'override') console.log(`note  recorded as an OVERRIDE of decision ${decisionId}: ${overrideReason}`);
} else if (overrideReason != null) {
  console.error('--override given without --decision'); process.exit(1);
}

// ── Build the row in the file's established key order and style ──
const row = `  {"d": "${d}", "t": "${t}", "a": "${a}", "q": ${q}, "p": ${p}, "ccy": "${ccy}", "yf": ${yf == null ? 'null' : `"${yf}"`}, "th": "${th}", "ref": "${ref}"${decisionId ? `, "dec": "${decisionId}"` : ''}}`;

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
if (decisionId) {
  const dr = decLog.data.rows.find(r => r.id === decisionId);
  dr.outcome = decOutcome; dr.fill = { d, p };
  if (decOutcome === 'override') dr.override_reason = overrideReason;
  dr.resolved_at = new Date().toISOString();
  D.saveDecisions(ROOT, decLog.data);
  console.log(`Decision ${decisionId} resolved as ${decOutcome} (fill ${d} @ ${p}).`);
}
console.log(`Appended to trades.json (${reparsed.length} rows). Next: node scripts/validate_ledger.js`);
