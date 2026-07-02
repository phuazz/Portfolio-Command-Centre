# Portfolio Command Centre — Handover Brief

Read `CLAUDE.md` first; it is load-bearing. `REFACTOR_PLAN.md` (delivery
architecture, complete) and `REFACTOR_PLAN_V2.md` (domain architecture,
complete; Phase D optional and parked) carry the design intent and
per-phase post-flight notes.

## State of play (2 July 2026)

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
- Live data is last-good sticky (25 Jun 2026). A per-ticker fetch failure keeps
  the ticker's previous LIVE entry (`state.liveData[sym]`) instead of reverting
  to the baked close, and `refreshPrices` merges each poll over the existing
  `state.liveData` rather than replacing it wholesale. Before this, a partial
  poll (some tickers 429/timeout) reverted the failed names to baked, so the
  headline — intraday, 1M, YTD, total market value — jumped between polls (e.g.
  49 live names then 27, total swinging ~S$6k); 1-Day was immune because it is
  anchored on baked bars, not the live price. Now the book only moves on genuine
  ticks. Minor cost: a repeatedly-failing ticker shows an ageing live price
  without a stale badge (`isStale` is false while any live price is held) —
  acceptable versus the jump.
- CI on `checkout@v5` / `setup-node@v5` (Node 24 ready). Three crons plus
  `workflow_dispatch` in `.github/workflows/update.yml`.

## Thesis tab (19 Jun 2026)

`theses.json` at the repo root is a user-owned input (like `trades.json`) holding
one concise investment thesis per holding — `desc` (what it is), `thesis` (why it
may do well), `risk` (what to watch), `conviction` (H/M/L). It was AI-seeded as
durable structural views at a Jan-2026 knowledge cutoff for PERSONAL use (not
advice, not live news) — edit freely. `build.js` copies it into `docs/data/`;
the client fetches it into the `THESES` global (tolerant — a missing file never
blanks the dashboard). The Thesis tab (`renderThesis`) shows one card per held
priced equity/ETF/REIT, sorted by weight, pairing the durable thesis with the
LIVE read the dashboard computes (YTD return, contribution, trend signal) — so
the qualitative "why" sits next to the quantitative "how it's actually doing".
Live news/catalyst refresh (Tier 2) was deliberately NOT built: it needs a news
source + an LLM call at bake time with sourcing/accuracy guardrails, and for
real decisions fabricated catalysts are a liability — keep any such layer clearly
labelled as unverified research, not fact.

## 1-Day window is calendar-weekday anchored (20 Jun 2026)

The 1-Day card and the 1-Day contributors/detractors panel anchor their START
leg on the calendar weekday BEFORE the boundary's reference weekday, not on each
ticker's immediately preceding bar. The helper `_prevWeekdayAnchor` computes that
date (UTC-ms arithmetic, weekend-skipping); `calcSplitDayPnL` and
`_effectiveReturnGlobalDay` then take the last bar on or before it as the start.
Consequence: a market that was closed on the most recent weekday — a US holiday
such as Juneteenth — reads FLAT for the 1-Day move (its start and end bars are the
same), instead of reaching back to its prior real session and showing a two-day-old
move mislabelled as "1-Day". Markets that did trade that weekday still show their
genuine move; foreign-cash FX (which trades on US equity holidays) still shows the
real weekday FX move. This is a no-op on ordinary days — it only bites on
holiday-adjacent days. Requested 20 Jun 2026 after Juneteenth (Fri) made every US
name show its Wed-to-Thu move as "1-Day" on the Saturday. Two honest caveats: (1)
the last real session's move drops out of the 1-Day view during the holiday gap
(by design — it is calendar-older than one day); (2) if a market traded but Yahoo
returned a null/missing bar for that weekday (the Asian-close lag below), the name
reads flat for that day rather than across the gap — a softer, self-correcting
failure than an inflated move. The intraday (ID) path is unchanged.

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
  four whole round-trips (9660.HK, MAR.US, XMED.GB, XCSI.GB). June fills were
  reconciled against the June statement on 2026-07-02: all sixteen statement
  fills matched the ledger 1:1 on date, quantity and price — no missing fills
  — and explicit fees were backfilled from the statement cash movements.
  Replayed holdings tie to the 30 June statement exactly on quantity and
  within broker rounding on average (largest residue JPY 0.03 per share on
  4004.JP; no new costAdjustments needed).
- `cashAnchor` re-anchored 2026-06-30 to the June statement balances: every
  currency (including AUD) swept to exactly zero at month-end — the pure
  swept-clearing pattern, and the first live crystallisation under the
  swept-cash decision. About S$49k of derived trading float since the
  11 June anchor left the book as a level step in Total Market Value and
  the allocation weights; the return engines are unaffected (they never
  read the buckets) and the Tactical Cash card honestly reads zero until
  the next sale. Dividends remain non-ledger per the Phase C
  contraindication; all five June dividend receipts (US$143 in total) were
  swept out within days of landing.
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
  (revisit in 2027). The swept-cash question was decided on 2026-07-02: the
  anchored cash buckets stay in the book, read as tactical trading float —
  the return engines never consume them (the equity curve and cash drag run
  on their own from-zero forward walk), so the question only ever concerned
  the balance-sheet views. Decision record and full consumer trace in
  `REFACTOR_PLAN_V2.md` section 6.
- If corsproxy.io degrades under polling, Phase D (own Cloudflare Worker) is
  the designed fallback. Assessed 2026-07-02 and deliberately kept parked —
  verdict and build triggers recorded under Phase D in `REFACTOR_PLAN_V2.md`.

## V2 closeout (2 July 2026)

The v2 plan is closed: Phases A, A.1, B and C are complete with post-flight
notes; Phase D is optional and deliberately parked (verdict recorded under
Phase D in `REFACTOR_PLAN_V2.md`). This session trued the documentation up
to the shipped architecture and decided the last open question:

- `README.md` rewritten from the pre-v1 single-file story to the shipped
  reality (ledger-first inputs, template + `build.js` bake into `docs/`,
  thrice-daily scheduled bake, corsproxy live feed with cache-buster and
  last-good sticky). Public anonymised framing preserved.
- Repo `CLAUDE.md` corrected: v2 phase status, `theses.json` recorded as the
  third user-authored input, template ~332 KB / ~5,800 lines (measured
  2026-07-02), `history.json` ~11 MB, end-of-session ritual
  `git checkout -- docs/` (there is no root `data/`).
- Swept-cash question decided — see the known-items entry above and the
  decision record in `REFACTOR_PLAN_V2.md` section 6.
- A stale `assume-unchanged` index bit on `README.md` was cleared; it had
  been masking a line-ending-only (CRLF) working-tree difference, not a
  content difference.

Known cosmetic drift, deliberately left: `build.js`'s header comment still
describes the pre-Phase-A regex universe scan; the code below it is
ledger-first. Fix it in the next session that touches pipeline source —
docs-only sessions do not modify it. Separately, the master `CLAUDE.md` at
`C:\dev` carries a stale ~325 KB template figure in its PCC paragraph and
needs the same size correction; it lives outside this repository and was
not edited from this session.

## Session rituals

Start: `git pull --rebase origin main`. End: `git checkout -- docs/` to drop
locally-staged pipeline outputs. One commit per phase. After any push that
changes source, trigger `update.yml` (`gh workflow run update.yml`) and
smoke-test the live URL — the live site only changes when the pipeline bakes.
