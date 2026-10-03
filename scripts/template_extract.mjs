// Helpers for tests that run code taken from template.html itself, so a test
// exercises the shipped source rather than a copy of it.
//
//   fn(src, name)            a top-level `function name(...) { ... }`, which
//                            in this file always closes with "\n}"
//   region(src, from, to)    the text from the first `from` marker up to
//                            (not including) the next `to` marker
//   line(src, startsWith)    one top-level line, such as a const declaration
import { readFileSync } from 'node:fs';

export function loadTemplate() {
  return readFileSync(new URL('../template.html', import.meta.url), 'utf8');
}

export function fn(src, name) {
  const re = new RegExp(`\\nfunction ${name.replace(/\$/g, '\\$')}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`);
  const m = src.match(re);
  if (!m) throw new Error(`function ${name} not found in template.html`);
  return m[0];
}

export function region(src, from, to) {
  const a = src.indexOf(from);
  if (a < 0) throw new Error(`marker not found: ${from}`);
  const b = src.indexOf(to, a + from.length);
  if (b < 0) throw new Error(`end marker not found: ${to}`);
  return src.slice(a, b);
}

export function line(src, startsWith) {
  const i = src.indexOf('\n' + startsWith);
  if (i < 0) throw new Error(`line not found: ${startsWith}`);
  return src.slice(i + 1, src.indexOf('\n', i + 1));
}

// Tiny assertion harness shared by the tests: prints one line per check and
// returns the failure count.
export function harness() {
  let fail = 0;
  const check = (ok, label, detail = '') => {
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`);
  };
  const close = (a, b, tol, label) => check(a != null && b != null && Math.abs(a - b) <= tol, label, `${a} vs ${b}, tol ${tol}`);
  const done = () => { console.log(fail ? `${fail} failure(s)` : 'all passed'); process.exit(fail ? 1 : 0); };
  return { check, close, done };
}
