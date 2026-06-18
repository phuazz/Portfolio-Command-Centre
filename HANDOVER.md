# Portfolio Command Centre — Handover Brief

Read `CLAUDE.md` first; it is load-bearing. `REFACTOR_PLAN.md` (delivery
architecture, complete) and `REFACTOR_PLAN_V2.md` (domain architecture, in
progress) carry the design intent and per-phase post-flight notes.

## State of play (12 June 2026)

The dashboard is ledger-first as of v2 Phase A. `trades.json` (full 2026
ledger) and `book.json` (opening book at the 2026-01-01 epoch, per-ticker
metadata, cash anchors, cost adjustments, ledger overrides) at the repository
root are the only user-maintained inputs. `replayLedger()` in `template.html`
derives positions, average costs, cash buckets and pre-YTD bases at boot.
`build.js` takes its universe from the two files, validates the ledger (a
violation fails the bake) and copies them into `docs/data/`.

A trade entry is one appended row in `trades.json`; a brand-new ticker also
needs one `meta` entry in `book.json`. See the workflow section in `CLAUDE.md`.

## What landed in the June 2026 sessions

- Returns reconciled across the dashboard: forward-cash equity curve (killed
  a phantom Jan-1 cash balance), total-return FIFO, trade-aware period P&L
  with per-ticker windows, equity+cash book basis on the hero cards and
  Attribution headline, and a reconciliation strip on the Performance tab
  that doubles as the standing regression gate.
- FX capture: the baked FX series is wired through (`fxAtDate`), foreign cash
  contributes its FX move, and JPYSGD is derived from the liquid SGDJPY cross
  in `build.js` because Yahoo's direct cross is broken.
- Live feed: corsproxy-first proxy list (`?url=` API), 10-second visible-tab
  polling with an in-flight guard, tweened headline values, pill-only status
  ("● N LIVE · HH:MM"). Refresh fetches 7-day windows merged into baked
  history — full history is never re-pulled by the client. `fetchLivePrice`
  appends a `_cb=<timestamp>` cache-buster to every Yahoo URL — load-bearing:
  corsproxy.io caches each upstream response for ~8-14 min, so without it every
  poll returns the SAME stale quote and intraday figures freeze for minutes
  (Yahoo itself updates in near-real-time). Trade-off: every poll is now a real
  upstream fetch; if corsproxy rate-limits under sustained 10s polling, relax
  `LIVE_POLL_MS` to ~30s (fresh-every-30s still beats stale-for-8-min).
- CI on `checkout@v5` / `setup-node@v5` (Node 24 ready). Three crons plus
  `workflow_dispatch` in `.github/workflows/update.yml`.

## Known items

- Intraday/1-Day "since prior close" can over-state for a market on a day when
  Yahoo's v8 chart feed returns a NULL recent daily bar. Seen 18 Jun 2026: the
  17-Jun SGX close came back null for every Asian name (in BOTH the daily bake
  and the live fetch — confirmed in docs/data/history.json, bars jump 16-Jun →
  18-Jun), so the global-day engine anchored the window on 16-Jun and the SGX
  names showed ~+1.4% "intraday" instead of ~+0.2% (e.g. ES3 16-Jun 5.206 →
  18-Jun 5.282 = +1.46% vs the true 17→18 ≈ +0.23%). Yahoo's website shows the
  right figure because it reads the v7 quote endpoint (regularMarketPreviousClose),
  which the CORS proxies cannot reach (needs a crumb). NOT a calc bug and NOT
  persistent — positions/YTD/cost basis are unaffected, and it self-corrects the
  next day when the window moves past the gapped bar. A heuristic guard was
  considered and rejected: it cannot distinguish a missing bar from a real
  holiday (where measuring across the gap is correct), so it would wrongly blank
  valid intraday on holiday-adjacent days. The durable fix is a quote-grade
  source (the Phase D Cloudflare Worker hitting v7) for an authoritative prior
  close. Do not re-investigate; if intraday looks inflated for one day, check
  whether a recent daily bar is null in the chart feed.
- The ledger is statement-reconciled (Phase A.1, 12 Jun 2026). All Jan–May
  fills are sourced from the six SCB monthly statements with explicit
  per-fill fees; the opening book and epoch closes come from the December
  2025 statement; cost basis is fee-inclusive, matching the broker average
  convention; replayed holdings tie to every month-end statement exactly on
  quantity (average within broker rounding, IGV pinned via a 3.06
  costAdjustment). Nine previously-missing fills were recovered, including
  four whole round-trips (9660.HK, MAR.US, XMED.GB, XCSI.GB). June fills are
  order-screen verified and carry no fee field; the next statement
  re-anchors them.
- `cashAnchor` re-anchored 2026-06-11 to actual SCB balances (incl. a small
  AUD bucket); the deltas absorbed accumulated dividends, interest and fees.
  Statement dividends are not yet ledger rows — a Phase C candidate.
- Engine architecture: the NAV-series engines (equity curve, TWRR,
  allocation risk) run as projections of the memoised `buildDailyBook()`
  core since v2 Phase B; the per-ticker engines (period P&L, attribution,
  FIFO) keep per-ticker windowing by design.
- Attribution carries an explicit Local / FX / Total decomposition on every
  horizon plus a portfolio FX-contribution tile (Phase C.1, 13 Jun 2026).
  The YTD FIFO engine is now FX-aware (proceeds at sell-date FX, marks at
  current, basis at epoch/per-buy FX); `localDollar` reproduces the old
  single-rate figure exactly and `fxDollar` is the intra-year currency
  effect. Headline YTD includes FX as of this change (was a single-rate
  approximation before).
- Tactical Cash Impact card on the Performance tab (Phase C.2, 13 Jun 2026):
  per foreign-currency bucket — balance, SGD value, % book, 1-week FX P&L,
  FX sensitivity (SGD per +1%) — plus total tactical cash and the YTD cash
  drag (ties to the reconciliation strip). Per-currency YTD average balance
  and FX gain are deliberately omitted: the intra-year cash path is
  underdetermined, so only rigorous figures are shown.
- Per-position FX columns added to the Top-Contributors / Detractors lists
  (Phase C.3). Dividend/income contribution tracker (Phase C.4): a "Return
  Drivers" card on the Attribution tab decomposes the SGD total return into
  Price + Income + FX = Total (Income = adjclose total return − close price
  return, from a parallel u=1 FIFO walk; ties per row to zero error). YTD
  income ~+1.13pp / S$9,817, from the CDP payers. The standalone FX header
  tile was folded into this card to keep the decomposition in one place.
  Phase C is now closed — C.1 FX decomposition, C.2 cash impact, C.3
  per-position FX, C.4 income tracker delivered. Deposit/dividend ledger rows were
  CONTRAINDICATED: the SCB securities account is a swept clearing account
  (buys funded by transfers in, sales swept out, month-end balance ~0), so a
  per-currency YTD average balance is meaningless, and brokerage cash
  dividends are negligible (MSFT US$19 YTD; dividends already in total-return
  via adjusted closes). Since-Inception and calendar tables are premature
  (revisit in 2027). Open data-model question for later: should swept
  settlement cash be treated as portfolio cash at all? See `REFACTOR_PLAN_V2.md`.
- If corsproxy.io degrades under polling, Phase D (own Cloudflare Worker) is
  the designed fallback.

## Session rituals

Start: `git pull --rebase origin main`. End: `git checkout -- docs/` to drop
locally-staged pipeline outputs. One commit per phase. After any push that
changes source, trigger `update.yml` (`gh workflow run update.yml`) and
smoke-test the live URL — the live site only changes when the pipeline bakes.
