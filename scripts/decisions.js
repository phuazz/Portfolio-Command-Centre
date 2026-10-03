/**
 * decisions.js — the decision log behind the cooling-off rule registration
 * (PREREG_cooling-off-rule.md, registered 2026-10-03). Shared by
 * scripts/add_decision.js (writes rows), scripts/add_trade.js (links a fill to
 * its decision) and scripts/validate_ledger.js (the guard). No network here;
 * every function is pure or touches decisions.json only, so the guard can be
 * tested against fixtures.
 *
 * The rule, R1, is a delay and never a veto. At the moment of decision the
 * three-session move is the change from the close three sessions before the
 * decision session to the current price, in the direction of the intended
 * trade (up for a buy, down for a sell). Above T_PCT the order is not placed
 * that session. From the next session the decision is re-read with the move
 * now close-to-close over the three sessions completed before the session on
 * which the order would be placed; the order may go on the first session that
 * reads at or below T_PCT, or on the K_SESSIONS-th session after the decision
 * regardless. The parameters below are registration values: changing them
 * after adoption is an amendment and a new registration, never an edit.
 *
 * decisions.json shape:
 *   { "adopted": "YYYY-MM-DD" | null, "rule": { "T_pct", "K_sessions", "stale_days" },
 *     "rows": [ { id, d, t, a, q, yf, ccy, px, px_source, close_t3, close_t3_date,
 *                 move3, state, outcome, fill, cleared_on, expired_on, wait_sessions,
 *                 override_reason, ref, note } ] }
 * Dates are the session date on the name's own exchange, ISO YYYY-MM-DD.
 */
const fs = require('fs');
const path = require('path');

const RULE = Object.freeze({ T_PCT: 3.0, K_SESSIONS: 5, STALE_DAYS: 10, LINK_DAYS: 10 });

function decisionsPath(root) { return path.join(root, 'decisions.json'); }

function emptyLog() {
  return { adopted: null, rule: { T_pct: RULE.T_PCT, K_sessions: RULE.K_SESSIONS, stale_days: RULE.STALE_DAYS }, rows: [] };
}

function loadDecisions(root) {
  const p = decisionsPath(root);
  if (!fs.existsSync(p)) return { data: emptyLog(), exists: false };
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!data.rows) data.rows = [];
  if (!data.rule) data.rule = emptyLog().rule;
  return { data, exists: true };
}

// One row per line, so a diff shows exactly the row that changed.
function serialiseDecisions(data) {
  const head = { _comment: 'Decision log for the cooling-off rule (PREREG_cooling-off-rule.md). Written by scripts/add_decision.js and scripts/add_trade.js, never by hand. One row per intended trade at the moment of decision; outcome filled, dropped or override. Never a broker, account or statement reference.',
    adopted: data.adopted == null ? null : data.adopted, rule: data.rule };
  const headText = JSON.stringify(head, null, 2).replace(/\n}$/, '');
  const rows = data.rows.map(r => '    ' + JSON.stringify(r)).join(',\n');
  return headText + ',\n  "rows": [\n' + rows + (rows ? '\n' : '') + '  ]\n}\n';
}

function saveDecisions(root, data) {
  const text = serialiseDecisions(data);
  JSON.parse(text);   // never write what does not parse
  fs.writeFileSync(decisionsPath(root), text, 'utf8');
}

// ── Arithmetic ──
// Percentage move from the close three sessions before to the price now, in
// the direction of the trade: positive means the price has moved the way the
// owner is about to trade (a rise before a buy, a fall before a sell).
function move3Pct(side, pxNow, closeT3) {
  if (!(pxNow > 0) || !(closeT3 > 0)) throw new Error('move3Pct: prices must be positive');
  const sign = side === 'B' ? 1 : side === 'S' ? -1 : null;
  if (sign === null) throw new Error(`move3Pct: side must be B or S, got ${JSON.stringify(side)}`);
  return sign * (pxNow / closeT3 - 1) * 100;
}

function decisionState(move3, tPct = RULE.T_PCT) { return move3 > tPct ? 'fired' : 'clear'; }

// ── Session dates ──
// A bar's session date is the calendar date of its timestamp in the exchange's
// own time zone (Yahoo stamps bars at the session open), never the UTC date.
function sessionDate(unixSeconds, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date(unixSeconds * 1000));   // en-CA formats as YYYY-MM-DD
}

// Finalised bars (close present, not provisional) dated strictly before `dateISO`
// on the exchange calendar, oldest first.
function barsBefore(history, dateISO, tz) {
  return history
    .filter(b => b.c != null && !isNaN(b.c) && !b.p)
    .map(b => ({ date: sessionDate(b.d, tz), c: b.c }))
    .filter(b => b.date < dateISO)
    .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
}

// The close three sessions before the decision session: the third-last of the
// finalised bars dated before it. Returns null when fewer than three exist.
function closeThreeBefore(history, decisionDateISO, tz) {
  const prior = barsBefore(history, decisionDateISO, tz);
  if (prior.length < 3) return null;
  const b = prior[prior.length - 3];
  return { close: b.c, date: b.date, lastClose: prior[prior.length - 1].c, lastDate: prior[prior.length - 1].date };
}

// The re-read on session `checkDateISO`: the close-to-close move over the three
// sessions completed before that session, and the number of completed sessions
// since the decision session. `expired` when that count reaches K.
function reread(history, decisionDateISO, checkDateISO, side, tz, rule = RULE) {
  const done = barsBefore(history, checkDateISO, tz);
  if (done.length < 4) return null;
  const last = done[done.length - 1], base = done[done.length - 4];
  const move = move3Pct(side, last.c, base.c);
  const sessionsSince = done.filter(b => b.date > decisionDateISO).length;
  const expired = sessionsSince >= (rule.K_sessions || rule.K_SESSIONS);
  return { move3: move, lastClose: last.c, lastDate: last.date, baseClose: base.c, baseDate: base.date, sessionsSince, expired,
    clear: move <= (rule.T_pct ?? rule.T_PCT) };
}

// Weekday estimate of the date n sessions after dateISO: no holiday calendar,
// so it is an estimate and is labelled one wherever it is printed.
function weekdaysAfter(dateISO, n) {
  const [y, m, d] = dateISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));   // JavaScript months are 0-indexed
  let left = n;
  while (left > 0) {
    dt.setUTCDate(dt.getUTCDate() + 1);
    const wd = dt.getUTCDay();                   // 0 Sunday, 6 Saturday
    if (wd !== 0 && wd !== 6) left--;
  }
  return dt.toISOString().slice(0, 10);
}

function daysBetween(aISO, bISO) {
  const [ay, am, ad] = aISO.split('-').map(Number), [by, bm, bd] = bISO.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);   // months 0-indexed
}

function newId(data, d, t, a) {
  const base = `${d}-${t}-${a}`;
  let id = base, n = 2;
  while (data.rows.some(r => r.id === id)) id = `${base}-${n++}`;
  return id;
}

// ── Linking a fill to its decision (used by add_trade.js) ──
// Returns { ok, reason, outcome } without mutating; the caller mutates on ok.
function assessLink(data, id, fill, overrideReason) {
  const row = data.rows.find(r => r.id === id);
  if (!row) return { ok: false, reason: `no decision row with id ${id}` };
  if (row.t !== fill.t || row.a !== fill.a) return { ok: false, reason: `decision ${id} is ${row.t} ${row.a}, the fill is ${fill.t} ${fill.a}` };
  if (row.outcome) return { ok: false, reason: `decision ${id} already resolved as ${row.outcome}` };
  if (fill.d < row.d) return { ok: false, reason: `fill dated ${fill.d} precedes the decision dated ${row.d}` };
  if (daysBetween(row.d, fill.d) > RULE.LINK_DAYS) return { ok: false, reason: `fill dated ${fill.d} is more than ${RULE.LINK_DAYS} calendar days after the decision ${row.d}; log a new decision` };
  if (row.state === 'fired') {
    const clearedBy = row.cleared_on && fill.d >= row.cleared_on;
    const expiredBy = row.expired_on && fill.d >= row.expired_on;
    if (!clearedBy && !expiredBy) {
      if (overrideReason) return { ok: true, outcome: 'override' };
      return { ok: false, reason: `decision ${id} fired on ${row.d} and has not cleared or expired by ${fill.d}; run "node scripts/add_decision.js check ${id}" first, or pass --override "<reason>" to record a breach` };
    }
  }
  return { ok: true, outcome: overrideReason ? 'override' : 'filled' };
}

// ── The guard (used by validate_ledger.js) ──
// Pure: takes the trades array and the decision log, returns failures, passes
// and notes. Before adoption it reports and never fails; after adoption every
// fill dated on or after the adoption date must link to a matching decision,
// and a fired decision filled before it cleared or expired must be an override.
function guardFills(trades, data, isFillRow) {
  const failures = [], passes = [], notes = [];
  const fills = trades.filter(isFillRow);
  const byId = Object.fromEntries(data.rows.map(r => [r.id, r]));
  const counts = { rows: data.rows.length, fired: 0, clear: 0, open: 0, filled: 0, dropped: 0, override: 0, stale_open: 0 };
  for (const r of data.rows) {
    if (r.state === 'fired') counts.fired++; else counts.clear++;
    if (!r.outcome) counts.open++; else counts[r.outcome] = (counts[r.outcome] || 0) + 1;
  }
  if (!data.adopted) {
    notes.push(`decision log: ${counts.rows} rows (${counts.fired} fired, ${counts.clear} clear; ${counts.open} open, ${counts.filled} filled, ${counts.dropped} dropped, ${counts.override} override); rule not adopted, guard inert`);
    return { failures, passes, notes, counts };
  }
  const post = fills.filter(t => t.d >= data.adopted);
  let linked = 0;
  for (const t of post) {
    if (!t.dec) { failures.push(`post-adoption fill ${t.d} ${t.t} ${t.a} ${t.q} @ ${t.p} has no decision link (dec); every fill since ${data.adopted} is entered through add_trade.js --decision <id>`); continue; }
    const r = byId[t.dec];
    if (!r) { failures.push(`fill ${t.d} ${t.t} links to decision ${t.dec}, which does not exist`); continue; }
    if (r.t !== t.t || r.a !== t.a) { failures.push(`fill ${t.d} ${t.t} ${t.a} links to decision ${t.dec}, which is ${r.t} ${r.a}`); continue; }
    if (t.d < r.d || daysBetween(r.d, t.d) > RULE.LINK_DAYS) { failures.push(`fill ${t.d} ${t.t} is outside the ${RULE.LINK_DAYS}-day window after its decision ${r.d}`); continue; }
    if (r.state === 'fired' && r.outcome !== 'override') {
      const clearedBy = r.cleared_on && t.d >= r.cleared_on, expiredBy = r.expired_on && t.d >= r.expired_on;
      if (!clearedBy && !expiredBy) { failures.push(`fill ${t.d} ${t.t} was placed while decision ${r.id} (fired ${r.d}) had not cleared or expired, and is not recorded as an override`); continue; }
    }
    if (r.outcome === 'override' && !(typeof r.override_reason === 'string' && r.override_reason.trim())) failures.push(`decision ${r.id} is an override without a reason`);
    linked++;
  }
  const overrideShare = post.length ? counts.override / post.length : 0;
  if (!failures.length) passes.push(`cooling-off guard: ${post.length} post-adoption fills since ${data.adopted}, all linked to a decision (${counts.override} overrides, ${(overrideShare * 100).toFixed(0)}% of post-adoption fills; the adoption gate reads NOT ADOPTED above 20%)`);
  if (overrideShare > 0.2) notes.push(`override share ${(overrideShare * 100).toFixed(0)}% exceeds the 20% adoption gate; the study would read NOT ADOPTED at this rate`);
  for (const r of data.rows) {
    if (r.outcome === 'filled' || r.outcome === 'override') {
      const f = r.fill && fills.find(t => t.dec === r.id);
      if (!f) failures.push(`decision ${r.id} is resolved as ${r.outcome} but no trades.json row links to it`);
    }
  }
  return { failures, passes, notes, counts, linked };
}

// Open decisions older than STALE_DAYS calendar days as of `todayISO`.
function staleOpen(data, todayISO) {
  return data.rows.filter(r => !r.outcome && daysBetween(r.d, todayISO) > RULE.STALE_DAYS);
}

module.exports = { RULE, decisionsPath, emptyLog, loadDecisions, saveDecisions, serialiseDecisions, move3Pct, decisionState,
  sessionDate, barsBefore, closeThreeBefore, reread, weekdaysAfter, daysBetween, newId, assessLink, guardFills, staleOpen };
