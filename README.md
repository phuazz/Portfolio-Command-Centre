# Portfolio Command Centre

A single-page, client-side portfolio dashboard for multi-asset investors. Designed for monitoring trend signals, portfolio allocation, and systematic risk overlays — all from one self-contained HTML file.

**[→ Live Demo](https://your-username.github.io/portfolio-command-centre/)**

---

## What It Does

**Positions** — Full position table with live prices (via Yahoo Finance CORS proxy), P&L tracking, vote signals, and expandable per-stock price charts with SMA200 overlays. Tap any row to drill in.

**Trend Signals** — Monthly 3-factor vote system per stock (Close > SMA200, Golden Cross, 12-month momentum). Symmetric "Exit 2/3, Enter 2/3" rules. Action cards with reasoning for every position.

**Crisis Overlay** — Macro stress detection using three breadth indicators (% below SMA200, 3-month market return, % bearish Supertrend). Semicircle speed-dial gauges. When all three trigger, portfolio exposure reduces to 25%.

**Performance** — Portfolio-level backtest comparing four strategies: Combined (Vote + Crisis), Vote Only, Crisis Only, and Buy & Hold. Includes return heatmaps, P&L waterfall, and theme attribution.

**Risk Analysis** — Concentration analysis, margin facility mapping, geographic and thematic exposure breakdowns.

## Architecture

The entire dashboard is a **single `index.html` file** with no build step, no framework, and no server. It loads two external CDN resources (Google Fonts and Plotly.js) and fetches live prices from Yahoo Finance via a public CORS proxy.

```
index.html          ← Everything: HTML + CSS + JS (~2,800 lines)
.nojekyll           ← Tells GitHub Pages to skip Jekyll processing
README.md           ← This file
```

**Data flow:** Static position data (tickers, quantities) is embedded in the file → on load, live prices are fetched via Yahoo Finance CORS proxy → enrichment computes P&L, signals, votes → tabs render from enriched state.

**Tab caching:** Each tab has a persistent DOM pane. Switching tabs is instant (show/hide). Panes only re-render when underlying data changes (tracked via a version counter), so navigating between tabs never re-fetches data.

## Customization

To use with your own portfolio, edit the `POSITIONS` array near the top of the `<script>` block. Each position follows this schema:

```javascript
{
  ticker: '9988.HK',        // Display ticker
  yf: '9988.HK',            // Yahoo Finance symbol (for live fetch)
  name: 'Alibaba',          // Display name
  exchange: 'HKG',          // HKG | TSE | ARCA | NMS | NYS | LSE | SGX
  ccy: 'HKD',               // Position currency
  avgPrice: 108.00,          // Average cost (null if not tracked)
  qty: 500,                  // Shares held
  invested: 54000,           // Total cost basis (null if not tracked)
  fee: 0,                    // Transaction fees
  availLTV: 60,              // Margin LTV % (0 if none)
  theme: 'China Tech',       // Thematic label
  type: 'Stock',             // Stock | ETF | REIT | Bond
  // Optional for CDP/custodian positions without live feeds:
  account: 'CDP',            // Account label
  mktPriceSnap: 155.40       // Fallback snapshot price
}
```

Also update the `SNAPSHOT` object and `FX_SNAP` rates as fallbacks.

## Signal System

The vote-based exit/entry engine evaluates three monthly signals per stock:

| Signal | Logic | What It Measures |
|--------|-------|-----------------|
| Vote A | Close > SMA200 | Price above long-term trend |
| Vote B | SMA50 > SMA200 | Golden cross (trend strength) |
| Vote C | 12-month return > 0 | Calendar momentum |

**Rules (symmetric):**
- **Hold:** votes ≥ 2/3 at month-end
- **Exit:** votes < 2/3 at month-end
- **Re-enter:** votes ≥ 2/3 at subsequent month-end

This prevents oscillation at the 1/3 vote boundary.

## Crisis Overlay

A macro hedge layer that sits on top of stock selection:

| Indicator | Threshold | Source |
|-----------|-----------|--------|
| Breadth < SMA200 | > 60% of stocks | S&P 500 constituents |
| 3-month market return | < −10% | S&P 500 index |
| Bearish Supertrend | > 50% of stocks | S&P 500 constituents |

**All three must trigger simultaneously** to enter crisis mode (exposure → 25%). Recovery requires **any one** indicator to clear its threshold.

## Deployment

### GitHub Pages (recommended)

The dashboard supports two modes:

**Instant mode (recommended for public sharing):**  
Pre-bake all historical data into the HTML so the page loads with full charts, signals, and backtests in under 1 second — zero network fetch required.

```bash
# 1. Clone the repo
git clone https://github.com/your-username/portfolio-command-centre.git
cd portfolio-command-centre

# 2. Fetch data and bake into HTML (~2 minutes)
node build.js

# 3. Push to GitHub Pages
git add . && git commit -m "Bake data" && git push
```

The build script fetches 10-year daily OHLC history for all tickers plus FX rates, then embeds it directly in `index.html`. Visitors see a fully interactive dashboard instantly. A "Refresh Prices" button lets them optionally pull the latest data.

**Re-bake periodically** (e.g. weekly or before sharing) to keep prices current:
```bash
node build.js && git add . && git commit -m "Update prices" && git push
```

**Live-fetch mode (fallback):**  
If no data is baked in, the dashboard automatically fetches from Yahoo Finance on load with a progress bar. This is slower (~30–60s on first visit) but requires no build step. Subsequent visits use localStorage cache.

### Local

Just open `index.html` in any modern browser. Without baked data, live price fetching requires internet access.

## Mobile Support

Responsive across desktop, tablet, and phone:
- Scrollable tab bar on small screens
- Collapsing grid layouts at tablet/phone breakpoints
- iOS safe area insets for notch devices
- Touch-optimized tap targets (48px minimum)
- Horizontal table scrolling on narrow viewports

## Illustrative Data

This version uses **illustrative portfolio data** with rounded quantities and anonymized account references. The portfolio shape, sector allocation, and signal behavior are representative of a real multi-asset portfolio. All tickers are real and publicly traded.

---

Built with vanilla HTML/CSS/JS, [Plotly.js](https://plotly.com/javascript/), and [DM Sans](https://fonts.google.com/specimen/DM+Sans).
