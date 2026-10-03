#!/usr/bin/env node
/**
 * add_decision.js — the decision log for the cooling-off rule
 * (PREREG_cooling-off-rule.md, registered 2026-10-03, not adopted until the
 * `adopt` command is run on the owner's instruction).
 *
 * Usage:
 *   node scripts/add_decision.js <YYYY-MM-DD> <B|S> <qty> <TICKER> "<ref>" [--price <px>] [--dry-run]
 *       Log an intended trade at the moment of decision. Fetches the name's
 *       last month of daily bars and the live quote from Yahoo (direct, no
 *       proxies), computes the three-session move in the trade's direction
 *       from the close three sessions before the decision session to the
 *       price now, and records fired (above the threshold) or clear.
 *   node scripts/add_decision.js check <id> [--date YYYY-MM-DD]
 *       Re-read a fired decision on a later session: the close-to-close move
 *       over the three sessions completed before that session, and whether
 *       the wait has expired. Writes cleared_on or expired_on on the row.
 *   node scripts/add_decision.js drop <id> "<reason>"
 *       Record that the trade was abandoned after the wait.
 *   node scripts/add_decision.js adopt <YYYY-MM-DD>
 *       Set the adoption date (once). From that date add_trade.js requires
 *       --decision <id> and validate_ledger.js refuses a fill without one.
 *   node scripts/add_decision.js report
 *       Reconcile the log against trades.json and list open decisions.
 *
 * The decision date is the session date on the name's own exchange. The ref
 * carries the same rule as add_trade.js: it names the decision record, never
 * a broker, account or statement reference. Nothing personal is written.
 */
const fs = require('fs');
const path = require('path');
const D = require('./decisions');
const { isFillRow } = require('./ledger_actions');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const opt = (name) => { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : undefined; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && argv[i - 1] !== '--dry-run'));

function die(msg) { console.error(msg); process.exit(1); }
function isoDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')); }
function todayInTz(tz) { return D.sessionDate(Math.floor(Date.now() / 1000), tz); }

function checkRef(refRaw) {
  const ref = String(refRaw).trim();
  if (!ref || ref.length > 160 || /[\r\n"]/.test(ref)) die(`Invalid ref: ${JSON.stringify(refRaw)} (non-empty, one line, up to 160 characters, no double quotes)`);
  if (/\b(account|acct|a\/c|statement|broker)\b/i.test(ref) || /\d{6,}/.test(ref)) die('Invalid ref: it looks like an account, statement or broker reference. The ref names a DECISION record, never an account.');
  return ref;
}

async function fetchChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`Yahoo returned ${resp.status} for ${symbol}`);
  const json = await resp.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo returned no chart result for ${symbol}`);
  const q = result.indicators?.quote?.[0] || {};
  const ts = result.timestamp || [];
  const history = [];
  for (let i = 0; i < ts.length; i++) {
    const c = (q.close || [])[i];
    if (c == null || isNaN(c)) continue;
    history.push({ d: ts[i], c: +c.toFixed(4) });
  }
  const meta = result.meta || {};
  return { history, tz: meta.exchangeTimezoneName || null, price: meta.regularMarketPrice ?? null, quoteTime: meta.regularMarketTime ?? null, name: meta.longName || meta.shortName || null };
}

function resolveMeta(t) {
  const book = JSON.parse(fs.readFileSync(path.join(ROOT, 'book.json'), 'utf8'));
  const m = (book.meta || {})[t];
  if (m) return { ccy: m.ccy, yf: m.yf, name: m.name };
  const trades = JSON.parse(fs.readFileSync(path.join(ROOT, 'trades.json'), 'utf8'));
  const prior = trades.filter(r => r.t === t).pop();
  if (prior) return { ccy: prior.ccy, yf: prior.yf, name: null };
  return null;
}

async function cmdNew() {
  if (positional.length !== 5) die('Usage: node scripts/add_decision.js <YYYY-MM-DD> <B|S> <qty> <TICKER> "<ref>" [--price <px>] [--dry-run]');
  const [d, a, qStr, t, refRaw] = positional;
  if (!isoDate(d)) die(`Invalid date: ${d} (expected YYYY-MM-DD, the session date on the name's exchange)`);
  if (a !== 'B' && a !== 'S') die(`Invalid action: ${a} (expected B or S)`);
  const q = Number(qStr);
  if (!(q > 0)) die(`Invalid qty: ${qStr}`);
  const ref = checkRef(refRaw);
  const meta = resolveMeta(t);
  if (!meta) die(`${t} is not in book.json meta and has no prior trade row; add the meta entry first.`);
  if (!meta.yf) die(`${t} has no feed symbol (yf), so the three-session move cannot be read; a decision on a name without a feed is logged by hand in the memo, not here.`);
  const { data } = D.loadDecisions(ROOT);
  const open = data.rows.find(r => r.t === t && r.a === a && !r.outcome);
  if (open) die(`An open decision already exists for ${t} ${a}: ${open.id} (${open.state}, ${open.d}). Resolve it (check, drop, or a fill via add_trade.js --decision) before logging another.`);

  const chart = await fetchChart(meta.yf);
  const tz = chart.tz || 'UTC';
  const base = D.closeThreeBefore(chart.history, d, tz);
  if (!base) die(`Fewer than three finalised sessions before ${d} in the feed for ${meta.yf}; cannot compute the three-session move.`);
  const pxOpt = opt('--price');
  const px = pxOpt != null ? Number(pxOpt) : chart.price;
  if (!(px > 0)) die(`No usable price: pass --price <px> (Yahoo gave ${chart.price}).`);
  const pxSource = pxOpt != null ? 'owner' : `yahoo regularMarketPrice at ${chart.quoteTime ? new Date(chart.quoteTime * 1000).toISOString() : 'unknown time'}`;
  const move3 = +D.move3Pct(a, px, base.close).toFixed(3);
  const state = D.decisionState(move3, data.rule.T_pct);
  const row = { id: D.newId(data, d, t, a), d, t, a, q, yf: meta.yf, ccy: meta.ccy, px, px_source: pxSource,
    close_t3: base.close, close_t3_date: base.date, last_close: base.lastClose, last_close_date: base.lastDate,
    move3, state, outcome: null, fill: null, cleared_on: null, expired_on: null, wait_sessions: null, override_reason: null, ref,
    logged_at: new Date().toISOString() };
  console.log('Decision: ' + JSON.stringify(row));
  console.log(`three-session move in the trade's direction: ${move3 >= 0 ? '+' : ''}${move3}% (close ${base.close} on ${base.date} to ${px} now; threshold ${data.rule.T_pct}%)`);
  if (state === 'fired') {
    console.log(`FIRED: do not place the order on ${d}. From the next session run "node scripts/add_decision.js check ${row.id}" before placing it; the order may go on the first session the check reads clear, or on about ${D.weekdaysAfter(d, data.rule.K_sessions)} (the ${data.rule.K_sessions}th session after, weekday estimate) regardless.`);
  } else {
    console.log(`CLEAR: the order may be placed on ${d}. Enter the fill with: node scripts/add_trade.js ${d} ${a} ${q} ${t} <price> "<ref>" --decision ${row.id}`);
  }
  if (!data.adopted) console.log('note  the rule is not yet adopted (no adoption date in decisions.json); the log accrues and the guard stays inert until "adopt" is run.');
  if (dryRun) { console.log('(dry run, nothing written)'); return; }
  data.rows.push(row);
  D.saveDecisions(ROOT, data);
  console.log(`Logged ${row.id} (${data.rows.length} rows in decisions.json).`);
}

async function cmdCheck() {
  const id = positional[1];
  if (!id) die('Usage: node scripts/add_decision.js check <id> [--date YYYY-MM-DD]');
  const { data } = D.loadDecisions(ROOT);
  const row = data.rows.find(r => r.id === id);
  if (!row) die(`No decision ${id}`);
  if (row.outcome) die(`Decision ${id} is already resolved as ${row.outcome}`);
  const chart = await fetchChart(row.yf);
  const tz = chart.tz || 'UTC';
  const checkDate = opt('--date') || todayInTz(tz);
  if (!isoDate(checkDate)) die(`Invalid --date ${checkDate}`);
  if (checkDate <= row.d) die(`The check session ${checkDate} must be after the decision session ${row.d}`);
  if (row.state === 'clear') { console.log(`Decision ${id} was clear on ${row.d}; no wait applies. Enter the fill with add_trade.js --decision ${id}.`); return; }
  const rr = D.reread(chart.history, row.d, checkDate, row.a, tz, data.rule);
  if (!rr) die('Fewer than four completed sessions in the feed; cannot re-read.');
  const m = `${rr.move3 >= 0 ? '+' : ''}${rr.move3.toFixed(3)}%`;
  console.log(`${id}: close-to-close three-session move ${m} (${rr.baseClose} on ${rr.baseDate} to ${rr.lastClose} on ${rr.lastDate}); ${rr.sessionsSince} session(s) completed since the decision; threshold ${data.rule.T_pct}%, wait ${data.rule.K_sessions}`);
  if (rr.clear || rr.expired) {
    const key = rr.clear ? 'cleared_on' : 'expired_on';
    console.log(rr.clear ? `CLEAR on ${checkDate}: the order may be placed this session.` : `EXPIRED on ${checkDate}: the wait of ${data.rule.K_sessions} sessions is over; the order may be placed this session.`);
    if (!row[key] || row[key] > checkDate) {
      row[key] = checkDate;
      if (!dryRun) { D.saveDecisions(ROOT, data); console.log(`Recorded ${key} = ${checkDate}.`); }
    }
  } else {
    console.log(`STILL FIRED on ${checkDate}: do not place the order; check again next session (${data.rule.K_sessions - rr.sessionsSince} session(s) of wait remain).`);
  }
}

function cmdDrop() {
  const [, id, reasonRaw] = positional;
  if (!id || !reasonRaw) die('Usage: node scripts/add_decision.js drop <id> "<reason>"');
  const reason = checkRef(reasonRaw);
  const { data } = D.loadDecisions(ROOT);
  const row = data.rows.find(r => r.id === id);
  if (!row) die(`No decision ${id}`);
  if (row.outcome) die(`Decision ${id} is already resolved as ${row.outcome}`);
  row.outcome = 'dropped'; row.note = reason; row.resolved_at = new Date().toISOString();
  if (!dryRun) D.saveDecisions(ROOT, data);
  console.log(`Decision ${id} dropped: ${reason}${dryRun ? ' (dry run, nothing written)' : ''}`);
}

function cmdAdopt() {
  const date = positional[1];
  if (!date || !isoDate(date)) die('Usage: node scripts/add_decision.js adopt <YYYY-MM-DD>');
  const { data } = D.loadDecisions(ROOT);
  if (data.adopted) die(`Already adopted on ${data.adopted}; a change of adoption date is a new registration, not an edit.`);
  data.adopted = date;
  if (!dryRun) D.saveDecisions(ROOT, data);
  console.log(`Adopted from ${date}. From that date add_trade.js requires --decision <id> and validate_ledger.js refuses a fill without one.`);
  console.log(`Record in PREREG_cooling-off-rule.md, Amendments: "(a) Adoption date: ${date}, threshold ${data.rule.T_pct} per cent, wait ${data.rule.K_sessions} sessions."`);
}

function cmdReport() {
  const { data, exists } = D.loadDecisions(ROOT);
  if (!exists) { console.log('No decisions.json yet; the first decision creates it.'); return; }
  const trades = JSON.parse(fs.readFileSync(path.join(ROOT, 'trades.json'), 'utf8'));
  const g = D.guardFills(trades, data, isFillRow);
  for (const m of g.failures) console.log('FAIL  ' + m);
  for (const m of g.passes) console.log('pass  ' + m);
  for (const m of g.notes) console.log('note  ' + m);
  const today = new Date().toISOString().slice(0, 10);
  for (const r of data.rows.filter(r => !r.outcome)) {
    const stale = D.daysBetween(r.d, today) > D.RULE.STALE_DAYS ? ' (stale: resolve or drop)' : '';
    console.log(`open  ${r.id} ${r.state} move3 ${r.move3}% cleared_on ${r.cleared_on || '-'} expired_on ${r.expired_on || '-'}${stale}`);
  }
  if (g.failures.length) process.exit(1);
}

(async () => {
  const cmd = positional[0];
  if (cmd === 'check') await cmdCheck();
  else if (cmd === 'drop') cmdDrop();
  else if (cmd === 'adopt') cmdAdopt();
  else if (cmd === 'report') cmdReport();
  else await cmdNew();
})().catch(e => die(e.message || String(e)));
