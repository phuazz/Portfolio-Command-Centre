// Behavioural test for the quote-proxy Worker. No deployment and no network:
// global fetch is stubbed, so every upstream response is scripted.
//
//   node scripts/quote-proxy-worker.test.mjs        (exit 0 on pass, 1 on failure)
//
// The Worker carries two allowlists and both are load-bearing. UPSTREAM_HOSTS is
// the one that matters most: without it the Worker is an anonymous open relay
// running on the account, reachable by anyone who finds the URL and able to
// reach internal addresses. The SSRF cases below are the ones a plain
// "does the hostname end in yahoo.com" check would wave through — a userinfo
// segment before an attacker host, a lookalike subdomain, plain http, the cloud
// metadata address. Run this after touching either list.
import { readFileSync } from 'node:fs';

const worker = (await import(new URL('./quote-proxy-worker.mjs', import.meta.url).href)).default;

const YAHOO_BODY = JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 178.42, regularMarketTime: 1787000000 } }] } });
const CHART = 'https://query1.finance.yahoo.com/v8/finance/chart/NVDA?range=7d&interval=1d';
const PROD = 'https://phuazz.github.io';

let upstream = 'ok';
let lastUpstreamUrl = null, lastUpstreamHeaders = null;
globalThis.fetch = async (url, opts) => {
  lastUpstreamUrl = String(url);
  lastUpstreamHeaders = (opts && opts.headers) || {};
  if (upstream === 'throw') throw new Error('socket hang up');
  if (upstream === 'notfound') return new Response('{"chart":{"error":"Not Found"}}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  return new Response(YAHOO_BODY, { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const call = (url, { method = 'GET', origin } = {}) => {
  const headers = new Headers();
  if (origin) headers.set('Origin', origin);
  return worker.fetch(new Request(url, { method, headers }));
};
const proxied = (target, origin) =>
  call('https://pcc-quote-proxy.example.workers.dev/?url=' + encodeURIComponent(target), { origin });

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
};

console.log('\n=== CORS contract ===');
let r = await call('https://w.example.workers.dev/', { method: 'OPTIONS', origin: PROD });
check('OPTIONS preflight returns 204', r.status === 204, `got ${r.status}`);
check('preflight echoes the allowed origin', r.headers.get('Access-Control-Allow-Origin') === PROD);
check('preflight sets Vary: Origin', r.headers.get('Vary') === 'Origin');

r = await proxied(CHART, PROD);
check('allowed origin is echoed back', r.headers.get('Access-Control-Allow-Origin') === PROD);
r = await proxied(CHART, 'http://localhost:4184');
check('localhost origin is echoed (dev)', r.headers.get('Access-Control-Allow-Origin') === 'http://localhost:4184');
r = await proxied(CHART, 'http://127.0.0.1:3030');
check('127.0.0.1 origin is echoed (dev)', r.headers.get('Access-Control-Allow-Origin') === 'http://127.0.0.1:3030');
r = await proxied(CHART, 'https://evil.example.com');
check('foreign origin is NOT echoed', r.headers.get('Access-Control-Allow-Origin') === PROD, r.headers.get('Access-Control-Allow-Origin'));
r = await proxied(CHART, 'https://phuazz.github.io.evil.com');
check('lookalike origin is NOT echoed', r.headers.get('Access-Control-Allow-Origin') === PROD, r.headers.get('Access-Control-Allow-Origin'));

console.log('\n=== Method and argument handling ===');
r = await call('https://w.example.workers.dev/?url=' + encodeURIComponent(CHART), { method: 'POST', origin: PROD });
check('POST is rejected 405', r.status === 405, `got ${r.status}`);
r = await call('https://w.example.workers.dev/', { origin: PROD });
check('missing url parameter is 400', r.status === 400, `got ${r.status}`);
r = await proxied('not a url at all', PROD);
check('malformed url parameter is 400', r.status === 400, `got ${r.status}`);

console.log('\n=== Upstream allowlist (open-relay prevention) ===');
for (const [label, target] of [
  ['arbitrary host', 'https://evil.example.com/steal'],
  ['userinfo trick', 'https://query1.finance.yahoo.com@evil.example.com/x'],
  ['internal metadata', 'http://169.254.169.254/latest/meta-data/'],
  ['loopback', 'http://127.0.0.1:8080/admin'],
  ['plain http yahoo', 'http://query1.finance.yahoo.com/v8/finance/chart/NVDA'],
  ['subdomain lookalike', 'https://query1.finance.yahoo.com.evil.example.com/x'],
  ['file scheme', 'file:///c:/windows/win.ini'],
]) {
  const resp = await proxied(target, PROD);
  check(`refuses ${label}`, resp.status === 403, `got ${resp.status}`);
}
for (const [label, target] of [
  ['query1', 'https://query1.finance.yahoo.com/v8/finance/chart/NVDA?range=7d'],
  ['query2', 'https://query2.finance.yahoo.com/v8/finance/chart/ES3.SI?range=7d'],
]) {
  const resp = await proxied(target, PROD);
  check(`permits ${label}`, resp.status === 200, `got ${resp.status}`);
}

console.log('\n=== Pass-through ===');
upstream = 'ok';
r = await proxied(CHART, PROD);
check('200 body reaches the client intact', (await r.clone().text()) === YAHOO_BODY);
check('query string is preserved upstream', lastUpstreamUrl.includes('range=7d') && lastUpstreamUrl.includes('interval=1d'), lastUpstreamUrl);
check('browser User-Agent is sent upstream', /Mozilla\/5\.0/.test(lastUpstreamHeaders['User-Agent'] || ''));
check('Cache-Control is no-store', r.headers.get('Cache-Control') === 'no-store');
// A failing upstream must reach the client as a failure. The page treats any
// non-ok response as a failed fetch and falls back to last-good, which is the
// correct handling — but only if it is told. Rewriting these into 200s would
// defeat the freshness guard the Worker exists to feed.
upstream = 'notfound';
r = await proxied(CHART, PROD);
check('upstream 404 passes through as 404', r.status === 404, `got ${r.status}`);
check('404 still carries CORS headers', r.headers.get('Access-Control-Allow-Origin') === PROD);
upstream = 'throw';
r = await proxied(CHART, PROD);
check('upstream throw becomes 502', r.status === 502, `got ${r.status}`);
check('502 still carries CORS headers', r.headers.get('Access-Control-Allow-Origin') === PROD);

console.log('\n=== Client-side QUOTE_PROXY wiring ===');
// The URL the page builds must be one this Worker actually serves. The
// expression is lifted from template.html rather than restated, so the two
// cannot drift apart silently: a trailing slash on the deployed URL must not
// produce a double-slash path.
const tpl = readFileSync(new URL('../template.html', import.meta.url), 'utf8');
const m = /\.\.\.\(QUOTE_PROXY \? \[url => `([^`]+)`\] : \[\]\)/.exec(tpl);
check('QUOTE_PROXY expression located in template.html', !!m, 'pattern not found — update this test if the wiring moved');
if (m) {
  const build = new Function('QUOTE_PROXY', 'url', 'return `' + m[1] + '`;');
  const expected = 'https://pcc-quote-proxy.acme.workers.dev/?url=' + encodeURIComponent(CHART);
  check('bare URL builds correctly', build('https://pcc-quote-proxy.acme.workers.dev', CHART) === expected, build('https://pcc-quote-proxy.acme.workers.dev', CHART));
  check('one trailing slash is tolerated', build('https://pcc-quote-proxy.acme.workers.dev/', CHART) === expected);
  check('several trailing slashes tolerated', build('https://pcc-quote-proxy.acme.workers.dev///', CHART) === expected);
  upstream = 'ok';
  r = await call(build('https://pcc-quote-proxy.acme.workers.dev/', CHART), { origin: PROD });
  check('a client-built URL is served by the Worker', r.status === 200, `got ${r.status}`);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES PRESENT'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
