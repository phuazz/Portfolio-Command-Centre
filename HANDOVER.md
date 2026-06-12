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
  history — full history is never re-pulled by the client.
- CI on `checkout@v5` / `setup-node@v5` (Node 24 ready). Three crons plus
  `workflow_dispatch` in `.github/workflows/update.yml`.

## Known items

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
  FIFO) keep per-ticker windowing by design. Phase C (FX-decomposed and
  since-inception attribution plus a cash-impact panel) is next. See
  `REFACTOR_PLAN_V2.md`.
- If corsproxy.io degrades under polling, Phase D (own Cloudflare Worker) is
  the designed fallback.

## Session rituals

Start: `git pull --rebase origin main`. End: `git checkout -- docs/` to drop
locally-staged pipeline outputs. One commit per phase. After any push that
changes source, trigger `update.yml` (`gh workflow run update.yml`) and
smoke-test the live URL — the live site only changes when the pipeline bakes.
