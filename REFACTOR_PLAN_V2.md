# Portfolio Command Centre — Refactor Plan v2 (Ledger-First Domain Model)

## 1. Context and goals

`REFACTOR_PLAN.md` (v1) is complete: Phases 0–4 moved PCC from a single 4.6 MB
`index.html` to a `template.html` + `docs/data/*.json` + pipeline architecture,
served from `docs/` with a thrice-daily bake. The delivery layer is healthy and
freshly debugged: the baked EOD data is the reliable floor, a corsproxy-based
live feed polls every 10 seconds with tweened value updates, and the UI needs
no structural change.

The remaining weaknesses are in the domain layer — the data model and the
calculation engines — and this plan addresses them. The owner's goals, in his
words: provide regular trades as the only manual input and have the portfolio
update at every point; focus on YTD attribution now and longer-term attribution
over time; make FX impact and temporary cash holdings (USD.CASH, HKD.CASH and
similar) first-class components of attribution and risk analytics.

This is not a rewrite. Each phase is a single session with one clean commit,
the live dashboard stays green after every commit, and every phase has an
explicit parity gate against the current numbers.

## 2. Current state and diagnosis

`template.html` is ~5,480 lines. Trades, positions and derived balances are
hand-maintained constants inside it:

- `POSITIONS` (line ~362, 62 entries) — current holdings with hand-computed
  `qty`, `avgPrice`, `invested` after every trade batch.
- `TRADES_YTD` (line ~448, 96 trades) — year-scoped ledger, hand-appended.
- `PRE_YTD_BASIS` (line ~1443) — Dec-31-2025 closes for closed-out positions
  whose pre-year basis the FIFO engine cannot otherwise infer.
- Four cash buckets (`USD.CASH` etc.) inside `POSITIONS` — running balances
  hand-recomputed after every trade.

Three structural problems follow.

**Derived state is hand-maintained.** A single trade batch requires three to
four coordinated edits (ledger append, position arithmetic, cash arithmetic,
sometimes a basis entry). Every edit is an opportunity for silent drift; the
FIFO engine ships a "trade ledger may be incomplete" warning flag precisely
because drift between `POSITIONS` and `TRADES_YTD` is anticipated.

**Six engines re-derive the same primitives.** `calcPortfolioPeriodPnL`,
`calcAttribution`, `calcYtdAttribution`, `calcTwrr`, `getEquityCurve` and
`calcAllocationRisk` each carry their own quantity-walk, close-matrix and FX
application. The June 2026 sessions spent most of their time reconciling
divergences between them (three different YTD figures, a phantom Jan-1 cash
balance, a priced-subset denominator, a shared-date-axis bug that collapsed the
1-Day P&L). Each bug was two engines disagreeing about the same primitive.

**The ledger is year-scoped.** `TRADES_YTD` stops at 1 January 2026; the Jan-1
quantity inference and `PRE_YTD_BASIS` exist only to paper over the missing
earlier history. Longer-term attribution (since-inception, calendar-year
tables, rolling windows) cannot be built on a year-scoped ledger.

## 3. Target domain model

```
Repository root (user-authored, the only files touched on a trade entry)
├── trades.json            ← Append-only full ledger. One object per fill.
├── book.json              ← Opening book at the epoch (2026-01-01) plus
│                            static per-ticker metadata.
│
build.js                   ← Adds: read universe from trades+book (not HTML
│                            regex); validate ledger replay; copy both files
│                            into docs/data/ for serving.
│
docs/data/                 ← Pipeline-owned, regenerable. Gains copies of
│                            trades.json and book.json alongside history.json.
│
template.html              ← Derives POSITIONS, cash buckets and PRE_YTD_BASIS
                             at boot by replaying the ledger over the book.
                             One valuation core feeds every analytic.
```

`trades.json` schema (one object per fill, matching today's in-memory shape):

```json
{ "d": "2026-06-11", "t": "DELL.US", "a": "B", "q": 25, "p": 387.885,
  "ccy": "USD", "yf": "DELL", "th": "US Tech" }
```

`book.json` schema (sketch — finalised during Phase A):

```json
{
  "epoch": "2026-01-01",
  "openingCash": { "USD": 0, "HKD": 0, "JPY": 0, "EUR": 0, "SGD": 0 },
  "positions": [
    { "ticker": "MSFT.US", "yf": "MSFT", "qty": 30, "avgPrice": 249.6421,
      "invested": 7489.26, "epochClose": 251.10 }
  ],
  "meta": {
    "MSFT.US": { "name": "Microsoft", "exchange": "NMS", "ccy": "USD",
                  "theme": "US Tech", "sector": "Technology",
                  "assetClass": "Equity", "account": "Brokerage",
                  "availLTV": 70, "type": "Stock" }
  }
}
```

`epochClose` is recorded per opening position (and per ticker now living in
`PRE_YTD_BASIS`) so attribution has a fixed market-value anchor even where the
baked history lacks the epoch bar. Engines prefer the history bar and fall back
to the recorded value, matching current behaviour.

Positions and cash are derived by replay: weighted-average cost on buys (the
current hand-maintained convention), sells reduce quantity, cash per currency
is opening cash plus sale proceeds minus purchase costs, floored at zero with
detected external deposits logged (the same forward-walk model already proven
in `getEquityCurve`).

## 4. Migration principles

Unchanged from v1: the live dashboard must remain green after every commit;
each phase is one session and one commit; each phase is reversible via `git
revert` or a snapshot branch; no phase begins until the previous one is
deployed and verified. Two additions: every phase carries a numeric parity
gate (golden numbers captured before the change must reproduce after it), and
the Performance-tab reconciliation strip (equity-sleeve TWRR − cash drag =
whole-portfolio TWRR; FIFO shown alongside) acts as the standing regression
test for any engine change.

## 5. Phased sequence

### Phase A — Ledger-first data model (one session)

Scope. Move trades and the opening book out of `template.html` into
`trades.json` and `book.json` at the repository root; derive `POSITIONS`, the
cash buckets and the pre-YTD bases at boot; teach `build.js` to read its
ticker universe from the two files, validate the replay and copy both into
`docs/data/`.

Deliverables. The two new files (ledger migrated verbatim from `TRADES_YTD`;
book reconstructed as current positions minus YTD net flows, bases folded in
from `PRE_YTD_BASIS`). A `replayLedger(book, trades)` loader in the template
producing the exact structures the renderers already consume — the `POSITIONS`
variable name survives so render code is untouched. `build.js` universe from
trades+book instead of the `yf:'...'` HTML regex; hard validation failure on
negative lots or unknown tickers; both files copied into `docs/data/` so the
served site fetches them alongside `history.json`. `CLAUDE.md` and
`HANDOVER.md` refreshed to describe the new model and the new trade-entry
workflow.

After this phase a trade entry is: append one line to `trades.json`, commit.
Positions, average costs, invested amounts, cash balances and closed-position
bases are all computed.

Verification. Parity gate: the derived positions must match the current
hand-maintained `POSITIONS` exactly — quantity, average price and invested
within rounding for all 62 entries, and all four cash balances to the cent.
Reconciliation strip unchanged. All six tabs render. Pipeline dry-run prints
the same universe as today. Live deploy smoke-tested.

Rollback. Snapshot branch `snapshot/pre-v2-phase-a`.

Dependencies. None. Entry point of v2.

Post-flight note (2026-06-12). Completed. A one-off migration script (not
committed; the outputs and this note are the durable artefacts) extracted
`POSITIONS` (62 entries), `TRADES_YTD` (96 trades) and `PRE_YTD_BASIS` from
the template, emitted `trades.json` and `book.json`, and self-verified the
replay. Parity gate passed in full: all 62 positions reproduce (quantity
exact, invested to the cent, average price within 0.005 — the hand-maintained
`avgPrice` figures were independently cent-rounded and internally inconsistent
with `invested` by up to 11 cents, so the derived figures are the more
consistent ones), all four cash balances to the cent, and every engine number
identical to four decimal places against the pre-change golden capture
(Total MV 1,375,163.25; 1-Day, YTD FIFO, TWRR, equity curve, attribution all
exact). Universe from ledger = 75 tickers, identical set to the old HTML
regex scan. All six tabs render; the only console output is the expected
override warning.

Decisions taken during execution, per section 6. Cash reconciliation uses a
`cashAnchor` (last verified brokerage balances, 2026-06-11) plus the net of
strictly-later trades, rather than opening-cash inference — exact today and
forward-correct, with periodic re-anchoring absorbing fees. Broker-fee
residues baked into the old hand-maintained cost figures surfaced on nine
tickers (S$9–220) and are carried as named `costAdjustments`. The replay also
caught a genuine ledger gap: PHAG.GB was bought 100 @ 82.70 on 2026-02-25,
the position was closed, but the sale was never recorded and the ticker never
appeared in POSITIONS in any commit; it is carried as a documented
`ledgerOverrides` entry pending broker records, after which the override
should be replaced by the real sell row. Average-cost accounting (not FIFO)
is the replay convention for position cost, matching the hand-maintained
figures; FIFO remains the attribution engine's lot convention, unchanged.

Follow-ups. First: supply the PHAG.GB sale details and delete the override.
Second: the engines still consume the derived `TRADES_YTD`/`POSITIONS`
globals exactly as before — Phase B replaces their internals, not their
inputs. Third: future deposit/withdrawal rows (`"a": "D"`/`"W"`) are filtered
out before the engines see them, so the row type can be introduced in
Phase C without engine changes.

### Phase B — Unified valuation core (one to two sessions)

Scope. One `buildDailyBook(book, trades, history, fxHistory)` producing the
memoised daily matrix — per-date holdings, cash by currency, and NAV per
position in local currency and SGD — from which every analytic derives.

Deliverables. The core function, memoised on the data version so the 10-second
live poll recomputes once per price change rather than once per engine. The
six engines refactored one at a time into projections of the matrix, in this
order: `getEquityCurve` and `calcTwrr` (already closest in shape), then
`calcPortfolioPeriodPnL`, then `calcAttribution`/`calcYtdAttribution`, then
`calcAllocationRisk`. Five bespoke quantity-walks retired.

Verification. Golden numbers captured before the refactor (hero cards, all
attribution horizons, TWRR, curve KPIs, allocation risk strip) must reproduce
after each engine swap. The reconciliation strip must tie throughout. This
phase must not be blended with Phase A or C.

Rollback. Snapshot branch `snapshot/pre-v2-phase-b`. If a single engine swap
fails parity, revert that engine only — the projections are independent.

Dependencies. Phase A deployed and stable.

### Phase C — Attribution v2 (one to two sessions)

Scope. The analytics the owner has asked for, built on the unified core.

Deliverables. Window-flexible attribution: the FIFO engine generalised from
its hard-coded Jan-1 anchor to any window start at or after the epoch, with a
Since-Inception horizon added to the Attribution tab (identical to YTD until
the ledger ages past one year, then they diverge). Explicit FX decomposition:
per position and per theme, r_SGD = (1 + r_local)(1 + r_FX) − 1, surfaced as
Local / FX / Total columns in the attribution table and a portfolio-level FX
contribution tile; `FX_HISTORY` is already wired, so this is presentation over
existing data. Cash impact panel: the temporary cash buckets as an explicit
attribution row and a small card — average tactical balance per currency over
the window, drag in percentage points versus fully-invested, and FX gain or
loss on the cash itself (all three already computed inside the engines, none
currently surfaced as a dedicated view). Calendar-year and rolling-12M tables,
feature-gated on ledger age.

Verification. FX decomposition must satisfy the identity per position (local
plus FX compounds to the SGD total within rounding); the cash row plus equity
rows must sum to the book return shown on the hero cards; Since-Inception
equals YTD while the epoch is 1 January 2026.

Rollback. `git revert` per feature; lower risk than Phase B because the core
is untouched.

Dependencies. Phase B deployed and stable.

### Phase D — Real-time hardening (optional, one short session)

Scope. Only needed if the free corsproxy tier degrades under the 10-second
polling regime. A Cloudflare Worker on the free tier (Yahoo-only allowlist)
gives a private, unthrottled endpoint; the proxy list becomes one reliable
line with corsproxy demoted to fallback. Optional refinements behind the same
endpoint: batched quotes via the spark endpoint (collapses 44 requests to two
or three), and market-hours-aware polling cadence.

Verification. Time-to-live and poll success rate measured before and after;
fallback path exercised by pointing the Worker URL at a dead host.

Dependencies. None — can run any time; triggered by observed throttling
rather than by schedule.

## 6. Open questions (decide during execution, not before)

External cash flows: deposits and withdrawals are currently inferred by the
floor-at-zero forward walk. An explicit ledger row type (`"a": "D"` / `"W"`)
would make them exact. Default: keep inference in Phase A, add the row type in
Phase C if the inferred deposits ever disagree with reality.

Dividends: currently implied via adjusted closes (total-return). Explicit
dividend rows would reconcile cash balances exactly and allow an income view.
Default: defer; adjclose treatment is sound for attribution.

Corporate actions: splits are detected on live fetch (`detectSplit`) but a
historical split between bakes would corrupt a raw ledger. Default: note the
risk; add a split row type only when a holding actually splits.

Fees: the ledger schema carries a `fee` field, all zeros today. Default:
populate from broker confirmations whenever convenient; engines treat it as a
reduction of proceeds / addition to cost when present.

## 7. Risk map

Phase A is medium risk: it touches the boot path (a broken replay means no
positions render), but the parity gate is mechanical and complete, and the
blast radius is caught locally before push. Phase B is the highest-risk phase
of v2 — it replaces the numerical heart of the dashboard — which is why it is
sequenced engine-by-engine with golden-number gates and an engine-level revert
path. Phase C is low-to-medium risk: presentation and one engine
generalisation over a stable core. Phase D is low risk and isolated from the
domain model entirely.

## 8. Session template

Identical to v1 section 8, with one addition: before any engine work, capture
the golden numbers (hero cards, attribution horizons, TWRR, curve KPIs) into
the session notes first, and compare after every engine swap — not only at the
end of the session.
