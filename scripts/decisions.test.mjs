// Guard tests for the decision log (scripts/decisions.js). Run: node --test scripts/
// Every guard test fails first against a broken fixture, then passes against a
// sound one, so a guard that only ever passes cannot slip through.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const D = require('./decisions.js');
const { isFillRow } = require('./ledger_actions.js');

const ts = (iso, hourUtc) => Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), hourUtc) / 1000);   // months 0-indexed

test('move3Pct is oriented in the trade direction', () => {
  assert.equal(+D.move3Pct('B', 106, 100).toFixed(6), 6);        // rose 6% before a buy: adverse
  assert.equal(+D.move3Pct('S', 94, 100).toFixed(6), 6);         // fell 6% before a sell: adverse
  assert.equal(+D.move3Pct('B', 94, 100).toFixed(6), -6);        // fell before a buy: favourable
  assert.throws(() => D.move3Pct('X', 1, 1));
});

test('state fires strictly above the threshold', () => {
  assert.equal(D.decisionState(3.0, 3.0), 'clear');
  assert.equal(D.decisionState(3.001, 3.0), 'fired');
  assert.equal(D.decisionState(-8, 3.0), 'clear');
});

test('bars are dated on the exchange calendar and the decision session is excluded', () => {
  // New York bars stamped 13:30 UTC; a Sydney bar stamped 23:00 UTC the day before its session
  const ny = [['2026-09-28', 100], ['2026-09-29', 101], ['2026-09-30', 102], ['2026-10-01', 103], ['2026-10-02', 104]]
    .map(([d, c]) => ({ d: ts(d, 13), c }));
  const base = D.closeThreeBefore(ny, '2026-10-02', 'America/New_York');
  assert.equal(base.date, '2026-09-29'); assert.equal(base.close, 101); assert.equal(base.lastDate, '2026-10-01');
  const syd = [{ d: ts('2026-10-01', 23), c: 10 }];                  // 23:00 UTC 1 Oct = 10:00 AEDT 2 Oct
  assert.equal(D.sessionDate(syd[0].d, 'Australia/Sydney'), '2026-10-02');
  assert.equal(D.sessionDate(syd[0].d, 'UTC'), '2026-10-01');
  const prov = ny.concat([{ d: ts('2026-10-05', 13), c: 110, p: true }]);
  assert.equal(D.closeThreeBefore(prov, '2026-10-06', 'America/New_York').lastDate, '2026-10-02', 'a provisional bar is not a finalised session');
});

test('the re-read uses the three sessions completed before the check session and expires at K', () => {
  const bars = [['2026-09-24', 100], ['2026-09-25', 100], ['2026-09-28', 100], ['2026-09-29', 100], ['2026-09-30', 108],
    ['2026-10-01', 108], ['2026-10-02', 108], ['2026-10-05', 108], ['2026-10-06', 108], ['2026-10-07', 108], ['2026-10-08', 108]]
    .map(([d, c]) => ({ d: ts(d, 13), c }));
  const rule = { T_pct: 3, K_sessions: 5 };
  // decision on 2026-09-30 (buy after the 8% jump). Check on 10-01: completed sessions end 09-30; move 108/100 = +8%: fired.
  let r = D.reread(bars, '2026-09-30', '2026-10-01', 'B', 'America/New_York', rule);
  assert.equal(r.clear, false); assert.equal(r.sessionsSince, 0); assert.equal(r.expired, false);
  // check on 10-05: completed sessions end 10-02; base is 09-29 (100): still +8%, two sessions since.
  r = D.reread(bars, '2026-09-30', '2026-10-05', 'B', 'America/New_York', rule);
  assert.equal(r.clear, false); assert.equal(r.sessionsSince, 2);
  // check on 10-06: base 09-30 (108) to 10-05 (108): 0%, clear.
  r = D.reread(bars, '2026-09-30', '2026-10-06', 'B', 'America/New_York', rule);
  assert.equal(r.clear, true); assert.equal(r.baseDate, '2026-09-30');
  // expiry: five completed sessions after the decision by the check on 10-08
  r = D.reread(bars, '2026-09-30', '2026-10-08', 'B', 'America/New_York', rule);
  assert.equal(r.sessionsSince, 5); assert.equal(r.expired, true);
});

test('weekday estimate skips weekends', () => {
  assert.equal(D.weekdaysAfter('2026-10-02', 5), '2026-10-09');   // Friday + 5 weekdays = next Friday
  assert.equal(D.weekdaysAfter('2026-12-31', 1), '2027-01-01');   // year boundary
  assert.equal(D.weekdaysAfter('2026-10-30', 1), '2026-11-02');   // month boundary over a weekend
});

const fixture = (adopted) => ({ adopted, rule: { T_pct: 3, K_sessions: 5 }, rows: [
  { id: 'A', d: '2026-11-02', t: 'XLE.US', a: 'B', state: 'clear', outcome: 'filled', fill: { d: '2026-11-02', p: 60 }, cleared_on: null, expired_on: null },
  { id: 'F', d: '2026-11-03', t: 'MU.US', a: 'B', state: 'fired', outcome: null, cleared_on: null, expired_on: null },
  { id: 'G', d: '2026-11-03', t: 'SLV.US', a: 'S', state: 'fired', outcome: 'filled', fill: { d: '2026-11-06', p: 80 }, cleared_on: '2026-11-06', expired_on: null },
] });
const T = (d, t, a, extra = {}) => ({ d, t, a, q: 1, p: 1, ccy: 'USD', yf: t.replace('.US', ''), ...extra });

test('guard is inert before adoption and reports', () => {
  const g = D.guardFills([T('2026-11-02', 'XLE.US', 'B')], fixture(null), isFillRow);
  assert.equal(g.failures.length, 0); assert.match(g.notes[0], /guard inert/);
});

test('guard fails first: a post-adoption fill without a decision link', () => {
  const g = D.guardFills([T('2026-11-02', 'XLE.US', 'B')], fixture('2026-11-01'), isFillRow);
  assert.ok(g.failures.some(m => /no decision link/.test(m)));
});

test('guard passes a linked clear decision and a fired decision filled after it cleared', () => {
  const trades = [T('2026-11-02', 'XLE.US', 'B', { dec: 'A' }), T('2026-11-06', 'SLV.US', 'S', { dec: 'G' })];
  const g = D.guardFills(trades, fixture('2026-11-01'), isFillRow);
  assert.deepEqual(g.failures, []); assert.equal(g.linked, 2);
});

test('guard fails first: a fired decision filled before it cleared, unless recorded as an override', () => {
  const fx = fixture('2026-11-01');
  fx.rows[2].cleared_on = '2026-11-09';                                  // G cleared later than the fill
  const trades = [T('2026-11-02', 'XLE.US', 'B', { dec: 'A' }), T('2026-11-06', 'SLV.US', 'S', { dec: 'G' })];
  let g = D.guardFills(trades, fx, isFillRow);
  assert.ok(g.failures.some(m => /had not cleared or expired/.test(m)));
  fx.rows[2].outcome = 'override'; fx.rows[2].override_reason = 'owner 2026-11-06: earnings tonight';
  g = D.guardFills(trades, fx, isFillRow);
  assert.deepEqual(g.failures, []);
  fx.rows[2].override_reason = '';
  g = D.guardFills(trades, fx, isFillRow);
  assert.ok(g.failures.some(m => /override without a reason/.test(m)));
});

test('guard fails first: a link to the wrong name, a fill outside the window, a resolved decision with no fill', () => {
  const fx = fixture('2026-11-01');
  let g = D.guardFills([T('2026-11-02', 'XLE.US', 'B', { dec: 'G' })], fx, isFillRow);
  assert.ok(g.failures.some(m => /which is SLV.US S/.test(m)));
  g = D.guardFills([T('2026-11-20', 'XLE.US', 'B', { dec: 'A' })], fx, isFillRow);
  assert.ok(g.failures.some(m => /outside the 10-day window/.test(m)));
  g = D.guardFills([T('2026-11-02', 'XLE.US', 'B', { dec: 'A' })], fx, isFillRow);
  assert.ok(g.failures.some(m => /decision G is resolved as filled but no trades.json row/.test(m)));
});

test('assessLink refuses a fired, uncleared decision without an override and accepts it with one', () => {
  const fx = fixture('2026-11-01');
  const fill = { d: '2026-11-04', t: 'MU.US', a: 'B' };
  assert.equal(D.assessLink(fx, 'F', fill).ok, false);
  const ok = D.assessLink(fx, 'F', fill, 'owner 2026-11-04: reason');
  assert.equal(ok.ok, true); assert.equal(ok.outcome, 'override');
  assert.equal(D.assessLink(fx, 'A', { d: '2026-11-03', t: 'XLE.US', a: 'B' }).ok, false, 'already resolved');
  assert.equal(D.assessLink(fx, 'F', { d: '2026-11-01', t: 'MU.US', a: 'B' }).ok, false, 'fill precedes the decision');
});

test('serialise then parse round-trips the log', () => {
  const fx = fixture('2026-11-01');
  const back = JSON.parse(D.serialiseDecisions(fx));
  assert.equal(back.adopted, '2026-11-01'); assert.equal(back.rows.length, 3); assert.equal(back.rows[2].cleared_on, '2026-11-06');
});
