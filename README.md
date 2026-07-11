# Portfolio Command Centre

A single-page, client-side portfolio dashboard for multi-asset investors. Live prices, trend signals, FX-aware attribution and systematic risk overlays — served as static files from GitHub Pages, with an append-only trade ledger as the only manual input.

**[→ Live Demo](https://your-username.github.io/portfolio-command-centre/)**

---

## What It Does

**Positions** — full position table with live prices (Yahoo Finance via CORS proxy), P&L tracking, vote signals, and expandable per-stock price charts with SMA and Supertrend overlays. Tap any row to drill in.

**Attribution** — FX-aware return attribution by theme and position. Every horizon decomposes into Local / FX / Total; a Return Drivers card bridges Price + Income + FX = Total return; the YTD headline is money-weighted (Modified Dietz average capital employed).

**Trend Signals** — monthly three-factor vote system per stock (Close > SMA200, golden cross, 12-month momentum) with symmetric "Exit 2/3, Enter 2/3" rules and action cards. Includes a four-strategy portfolio backtest (Combined, Vote Only, Crisis Only, Buy & Hold) and a macro crisis overlay whose live status renders as a header KPI strip.

**Allocation** — allocation pivots by theme, type, currency and account, with volatility decomposition of the current book.

**Performance** — daily equity curve with TWRR, drawdown, Sharpe/Sortino/Calmar and an MWRR cross-check; benchmark comparison; a reconciliation strip that ties the equity-sleeve return minus cash drag to the whole-portfolio return; and a tactical cash impact card showing the FX exposure and drag of idle cash.

**Risk Analysis** — concentration analysis, margin facility mapping, geographic and thematic exposure breakdowns.

**Thesis** — one card per holding, pairing a durable, user-written investment thesis (what it is, why it may do well, what to watch) with the live quantitative read the dashboard computes (YTD return, contribution, trend signal).

## Architecture

No framework, no server. A template plus a bake script produce a static site served from `docs/`:

```
template.html        ← The whole app: HTML + CSS + JS (~5,800 lines). Source of truth.
build.js             ← Bake script: fetches history and FX, validates the ledger,
                        writes docs/data/*.json, copies the template to docs/index.html.
trades.json          ← Append-only trade ledger, one row per fill.   USER-AUTHORED
book.json            ← Opening book at the epoch + ticker metadata.  USER-AUTHORED
theses.json          ← One investment thesis per holding.            USER-AUTHORED
docs/                ← GitHub Pages serves this directory. Pipeline-owned output.
├── index.html       ← Straight copy of template.html
└── data/            ← history.json (10-year OHLC), fx.json, meta.json, plus baked
                        copies of trades.json, book.json and theses.json
.github/workflows/
└── update.yml       ← Scheduled bake: three crons per weekday + manual dispatch
```

**Data flow:** `build.js` reads its ticker universe from the ledger files (closed positions stay in the universe via their trade rows, so attribution keeps its history), fetches 10-year daily OHLC plus FX series from Yahoo Finance, validates the ledger replay — a violation fails the bake rather than publishing an inconsistent book — and writes everything under `docs/`. On page load the client fetches the baked JSON, derives positions, average costs, cash buckets and closed-position bases by replaying the ledger over the opening book (`replayLedger()`), then starts live polling on top of the baked floor.

**Scheduled bake and deploy:** GitHub Actions runs the bake three times each weekday around exchange closes (after the SGX close, after the US close, and a mid-Asia finalisation pass), plus on manual dispatch. Each run bakes `docs/`, commits the changed data, then publishes `docs/` through `actions/deploy-pages`. The largest file, `docs/data/history.json`, is gitignored and served straight from the Pages artifact rather than committed, so the daily commit stays small.

## Ledger-First Data Model

The only files a user ever edits are `trades.json`, `book.json` and `theses.json`. Everything derived — current positions, average costs, invested amounts, cash balances, closed-position bases — is computed at boot by replaying the ledger. Derived state is never hand-edited.

A trade is one appended row:

```json
{ "d": "2026-06-11", "t": "DELL.US", "a": "B", "q": 25, "p": 387.885,
  "ccy": "USD", "yf": "DELL", "th": "US Tech" }
```

(`d` date, `t` display ticker, `a` action `B`/`S`, `q` quantity, `p` fill price, `ccy` currency, `yf` Yahoo Finance symbol, `th` theme; an optional `fee` field is treated as part of cost.)

`book.json` carries the opening book at a fixed epoch date (per-position quantity, average price, invested amount and epoch close), static per-ticker metadata (name, exchange, currency, theme, type, margin LTV), cash reconciliation anchors, and named cost adjustments and ledger overrides for documented data gaps.

**Trade entry workflow:** append one row to `trades.json`, commit, push, run the workflow. For a brand-new ticker, also add one `meta` entry to `book.json`. Nothing else.

## Live Prices

The baked end-of-day data is the reliable floor; a live layer polls Yahoo Finance every 10 seconds while the tab is visible:

- **CORS proxy chain** — corsproxy.io primary with a fallback proxy, fastest-first.
- **Cache-buster** — the proxy caches upstream responses for minutes, so every poll carries a throwaway timestamp parameter to force a genuinely fresh quote.
- **Last-good sticky** — a failed per-ticker fetch keeps that ticker's previous live price instead of reverting to the baked close, so headline values move only on genuine ticks, never on transient proxy errors.
- **Incremental refresh** — polls fetch short recent windows and merge them into the baked history; the client never re-pulls the full 10-year history.
- **localStorage cache** — supports standalone use without a bake.

## Signal System

The vote-based exit/entry engine evaluates three monthly signals per stock:

| Signal | Logic | What It Measures |
|--------|-------|-----------------|
| Vote A | Close > SMA200 | Price above long-term trend |
| Vote B | SMA50 > SMA200 | Golden cross (trend structure) |
| Vote C | 12-month return > 0 | Calendar momentum |

**Rules (symmetric):** hold while votes ≥ 2/3 at month-end; exit when votes < 2/3; re-enter when votes ≥ 2/3 at a subsequent month-end. The symmetry prevents oscillation at the boundary.

## Crisis Overlay

A macro hedge layer that sits on top of stock selection:

| Indicator | Threshold |
|-----------|-----------|
| Breadth below SMA200 | > 60% of stocks |
| 3-month market return | < −10% |
| Bearish Supertrend | > 50% of stocks |

**All three must trigger simultaneously** to enter crisis mode (exposure → 25%). Recovery requires any one indicator to clear its threshold.

## Deployment

### GitHub Pages

The site deploys through GitHub Actions, not the legacy branch-based build. The **Update Prices** workflow bakes `docs/`, uploads it as a Pages artifact and publishes it with `actions/deploy-pages`. To set this up on a fresh fork:

1. Settings → Pages → Build and deployment → Source → **GitHub Actions**. Equivalently, `gh api --method PUT repos/OWNER/REPO/pages -f build_type=workflow`. This setting lives outside git.
2. Replace the ledger files (`trades.json`, `book.json`, optionally `theses.json`) with your own portfolio.
3. Run the **Update Prices** workflow from the Actions tab, or `gh workflow run update.yml`. The bake and the deploy run together in that one workflow.

The three daily crons keep the site fresh thereafter; each run re-bakes and re-deploys. To bake locally without deploying:

```bash
node build.js        # Node 18+, fetches ~10 years of history for the universe
```

### Local

```bash
node build.js        # bake data into docs/
npx serve docs       # serve the baked site
```

For source-only development, serve the repository root and open `template.html` — on localhost, missing baked data falls back to a live fetch with a progress bar.

## Mobile Support

Responsive across desktop, tablet and phone: scrollable tab bar, collapsing grid layouts, iOS safe-area insets, touch-friendly tap targets and horizontally scrollable tables on narrow viewports.

## Illustrative Data

This version uses **illustrative portfolio data** with rounded quantities and anonymised account references. The portfolio shape, sector allocation and signal behaviour are representative of a real multi-asset portfolio. All tickers are real and publicly traded.

---

Built with vanilla HTML/CSS/JS, [Plotly.js](https://plotly.com/javascript/), and [DM Sans](https://fonts.google.com/specimen/DM+Sans).
