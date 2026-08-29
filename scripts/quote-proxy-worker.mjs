// ═══════════════════════════════════════════════════════════════════════════
//  PCC quote proxy — Cloudflare Worker
// ═══════════════════════════════════════════════════════════════════════════
//
// WHY THIS EXISTS
//
// The dashboard is a static page on GitHub Pages. Yahoo's chart endpoint sends
// no Access-Control-Allow-Origin header, so the browser cannot call it directly
// and the page has always reached it through a public CORS proxy. On 2026-08-28
// that transport failed completely, measured from https://phuazz.github.io:
//
//   corsproxy.io        HTTP 401  {"error":"A valid API key is required."}
//   api.allorigins.win  TypeError: Failed to fetch (no ACAO header)
//   query1.yahoo direct TypeError: Failed to fetch (no ACAO header, as always)
//
// Six further public proxies were probed in the same pass — codetabs,
// thingproxy, cors.lol, cors.workers.dev, allorigins /get and whateverorigin —
// and not one returned the Yahoo payload. The free public-proxy market has
// closed. Buying a corsproxy.io key does not solve it either: this repository is
// public and the page is entirely client-side, so any key shipped in it is a
// published key.
//
// The consequence was not a cosmetic one. Every live fetch failed, the page fell
// back to the baked close for all 54 quoted names, and the header pill still
// read "54 LIVE" because it counted history-derived trend signals rather than
// arriving quotes. The Intraday card, which measures the prior New York close to
// now, had nothing to measure and printed a confident +S$0. A self-hosted
// transport removes the third-party dependency; the freshness guard in
// template.html makes the next outage visible whatever the cause.
//
// ───────────────────────────────────────────────────────────────────────────
//  DEPLOYMENT
// ───────────────────────────────────────────────────────────────────────────
//
// The Cloudflare free tier covers this comfortably: 100,000 requests per day
// against roughly 56 symbols per poll. Deploy through the dashboard — it is the
// shortest path and needs no local tooling.
//
//   1. Sign in at https://dash.cloudflare.com and open Workers & Pages.
//   2. Create > Workers > Create Worker. Name it pcc-quote-proxy. Deploy the
//      placeholder, then Edit code.
//   3. Replace the editor contents with this file in full. Deploy.
//   4. Copy the deployed URL — https://pcc-quote-proxy.<subdomain>.workers.dev
//   5. Set QUOTE_PROXY in template.html to that URL, with no trailing slash and
//      no path. Rebuild (node build.js) and push.
//
// To deploy from the command line instead: npx wrangler deploy on a directory
// containing this file plus a wrangler.toml naming it as `main`. The dashboard
// route is fine and avoids adding tooling to this repository, which is why no
// wrangler.toml is committed here.
//
// The .mjs extension is for the benefit of the local test only — this repository
// is CommonJS by default, and Node must be told the file is an ES module before
// quote-proxy-worker.test.mjs can import it. Cloudflare is indifferent to the
// extension. Run the test after any edit to either allowlist below:
//
//   node scripts/quote-proxy-worker.test.mjs
//
// VERIFYING IT WORKS, from the browser console on the live page:
//
//   await (await fetch('https://pcc-quote-proxy.<subdomain>.workers.dev/?url='
//     + encodeURIComponent('https://query1.finance.yahoo.com/v8/finance/chart/NVDA?range=7d&interval=1d')
//   )).json()
//
// A populated chart.result[0].meta.regularMarketTime within the current session
// is the pass condition. The header pill should then read "● N LIVE" with N
// equal to the fetch count, not a smaller number and never during an outage.
//
// ───────────────────────────────────────────────────────────────────────────
//  SECURITY NOTE — read before widening anything below
// ───────────────────────────────────────────────────────────────────────────
//
// Two allowlists keep this from becoming an open relay, and both matter.
//
// UPSTREAM_HOSTS bounds what the Worker will fetch. Without it, anyone who finds
// the URL has a free anonymous proxy running on the account, able to reach
// arbitrary hosts — including internal addresses — with the account's quota and
// the account's reputation attached to the traffic.
//
// ALLOWED_ORIGINS bounds who may read the response. It is defence in depth
// rather than access control: a browser enforces it, a script does not. Its real
// job is to stop another site embedding this Worker as its own free transport.
//
// Widen neither casually. Adding a host to UPSTREAM_HOSTS is the more dangerous
// of the two by a wide margin.

const UPSTREAM_HOSTS = new Set([
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
]);

// Exact origins, plus any localhost port for local development (npx serve).
const ALLOWED_ORIGINS = new Set([
  'https://phuazz.github.io',
]);
const LOCALHOST = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function originAllowed(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGINS.has(origin) || LOCALHOST.test(origin);
}

// A permitted origin is echoed back; anything else receives the canonical
// production origin, which a foreign page's browser will reject. Vary: Origin
// keeps Cloudflare's edge cache from serving one origin's header to another.
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': originAllowed(origin) ? origin : 'https://phuazz.github.io',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function fail(status, message, origin) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'GET') {
      return fail(405, 'Method not allowed', origin);
    }

    const target = new URL(request.url).searchParams.get('url');
    if (!target) {
      return fail(400, 'Missing url parameter', origin);
    }

    let upstream;
    try {
      upstream = new URL(target);
    } catch (e) {
      return fail(400, 'Malformed url parameter', origin);
    }
    if (upstream.protocol !== 'https:' || !UPSTREAM_HOSTS.has(upstream.hostname)) {
      return fail(403, `Upstream host not permitted: ${upstream.hostname}`, origin);
    }

    // Yahoo rejects requests without a browser User-Agent. The client already
    // appends a _cb cache-buster per poll; no-store here stops the edge holding
    // a quote past its usefulness, which is what made an earlier proxy return
    // the same price for minutes at a time while the page believed it was live.
    let resp;
    try {
      resp = await fetch(upstream.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept': 'application/json',
        },
        cf: { cacheTtl: 0, cacheEverything: false },
      });
    } catch (e) {
      return fail(502, `Upstream fetch failed: ${String(e).slice(0, 200)}`, origin);
    }

    // Status is passed through unchanged. A 404 for a delisted symbol must reach
    // the client as a 404 — the page treats any non-ok response as a failed
    // fetch and falls back to last-good, which is the correct handling, but only
    // if it is told. Rewriting upstream failures into 200s would defeat the
    // freshness guard this Worker exists to feed.
    return new Response(resp.body, {
      status: resp.status,
      headers: {
        ...corsHeaders(origin),
        'Content-Type': resp.headers.get('Content-Type') || 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  },
};
