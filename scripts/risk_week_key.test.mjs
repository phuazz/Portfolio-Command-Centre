// Date test for _riskWeekKey in template.html, the week bucketing behind the
// weekly risk model on the Allocation tab. The function is extracted from the
// template source, so this tests the shipped code, not a copy.
//
//   node scripts/risk_week_key.test.mjs        (exit 0 on pass, 1 on failure)
//
// Each key is the Saturday ending the calendar week. Expected weekdays were
// checked with Python datetime, not computed by hand. Cases cover the month
// boundary and the year boundary, where a hand-rolled day offset would fail.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../template.html', import.meta.url), 'utf8');
const m = src.match(/function _riskWeekKey\(ds\) \{[\s\S]*?\n\}/);
if (!m) { console.error('FAIL: _riskWeekKey not found in template.html'); process.exit(1); }
const _riskWeekKey = new Function(`${m[0]}; return _riskWeekKey;`)();

const cases = [
  // [session date, expected week key, note]
  ['2026-01-30', '2026-01-31', 'Friday, week ends on the last day of January'],
  ['2026-02-02', '2026-02-07', 'Monday after a month boundary'],
  ['2026-02-27', '2026-02-28', 'Friday, week ends on the last day of February'],
  ['2026-03-02', '2026-03-07', 'Monday, the previous week straddled February to March'],
  ['2025-12-29', '2026-01-03', 'Monday, week crosses the year boundary'],
  ['2025-12-31', '2026-01-03', 'Wednesday, New Year\'s Eve maps into the next year'],
  ['2026-01-02', '2026-01-03', 'Friday, same week as 2025-12-29'],
  ['2026-10-03', '2026-10-03', 'Saturday maps to itself'],
  ['2026-10-04', '2026-10-10', 'Sunday starts the next week'],
];

let fail = 0;
for (const [ds, want, note] of cases) {
  const got = _riskWeekKey(ds);
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${ds} -> ${got}  (want ${want}; ${note})`);
}
// Every key must be a Saturday (getUTCDay() === 6; 0 = Sunday).
for (const [ds] of cases) {
  const k = _riskWeekKey(ds);
  if (new Date(k + 'T00:00:00Z').getUTCDay() !== 6) { fail++; console.log(`FAIL  ${ds} -> ${k} is not a Saturday`); }
}
console.log(fail ? `${fail} failure(s)` : 'all passed');
process.exit(fail ? 1 : 0);
