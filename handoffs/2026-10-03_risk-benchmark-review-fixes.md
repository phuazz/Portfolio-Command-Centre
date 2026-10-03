# Risk model and benchmark review fixes — handoff, 3 October 2026

Working directory `C:\dev\Portfolio-Command-Centre`, branch `main` at `bd67db6` (identical template to `b5e333c`; nothing upstream since). Model Claude Opus 5.5 (`claude-opus-5-5`), reasoning effort as set for the session. Reviewed base: `58eb32a` (security-level risk model), `d61226f` (50/50 benchmark), `b5e333c` (headline clause). **No commit, push, deployment or workflow run was made.** The untracked `reviews/`, `RESEARCH_MEMO.md` and `.claude/settings.local.json` were not touched; `.claude/launch.json` was edited temporarily for the test server and restored.

## Changed files

- `template.html` (source) and `docs/index.html` (straight copy, byte-identical, sha256 `331ad536…`; no bake, no market data refreshed).
- `build.js`: publishes each symbol's exchange timezone as `tz` (volume still stripped); adds `ES3.SI` and `S27.SI` to the fetch universe whether or not they are held. Not run (a run fetches market data); checked by syntax check, a serialisation test on a sample and an extracted `readLedger` run with both trackers removed from the book.
- `HANDOVER.md`: Known-items bullets for the risk model, benchmarks, the valuation anchor and session dates.
- New tests: `scripts/risk_model.test.mjs` (56 checks), `scripts/session_dates.test.mjs` (37 checks), helper `scripts/template_extract.mjs`.

## Input snapshot

Public bake downloaded to the session scratchpad (outside the repository): `meta.json` generatedAt 2026-10-03T06:20:49Z; all 94 tickers end on the 2026-10-02 session (12 SGX/European names on a provisional `p` bar struck from the Saturday quote); FX ends with 2026-10-03 Saturday ticks. sha256: history `be75f2c1…08af`, fx `e9011b15…6e72`, book `69fd8c08…57d9`, trades `cc15a5c4…1215`, meta `7b24ddb1…5df`. Local `docs/data/history.json` ends 2026-09-04 (89 tickers) although `meta.json` describes the October bake, as the reviewer found; it was not used. Live polling pinned off (`pccAutoRefresh=off`; `_lastFetch` 0 of 0). The HEAD build on this snapshot reproduces every reviewer reference figure to the printed precision.

## Figures, same snapshot

| | HEAD (b5e333c) | Patched |
|---|---|---|
| Weekly book vol | 9.7595105% (52, zero-padded) | 10.2222343% (26 weeks, 3 Apr–2 Oct 2026) |
| Daily book vol | 9.8080850% (285) | 10.4183136% (130, same endpoints) |
| Annualisation (weekly) | √52 assumed | 52.18 a year from elapsed time |
| Pivot invariance | identical ×4 | identical ×4 (10.2222343%) |
| Contributions sum | 100% | 100% (±1e-13) both bases |
| Beta to STI, weekly / daily | 0.5503 / 0.4688 | 0.4170 / 0.51 |
| Beta to S&P 500, weekly / daily | 0.5723 / 0.3839 | 0.6014 / 0.5298 |
| Beta to 50/50 / R² | 0.8372 / 0.5696 (weekly-rebalanced) | 0.8567 / 0.4793 (daily blend sampled weekly) |
| GLS annualised vol | 13.0153% (26 real of 52) | 18.5169% (26 observed) |
| Precious Metals YTD | +0.1315486% | +0.0943846% |
| Book TWRR YTD | +20.3390372% | +20.3398116% |
| 50/50 YTD (daily-rebalanced) | +18.6832787% | +18.6685374% |
| Headline / Performance excess YTD | +1.6557585pp (+1.66) | +1.6712742pp (+1.67) |
| Relative 6M / 3M / 1M vs 50/50 | −1.4495 / −1.1499 / −0.8301pp | −1.3882 / −0.9037 / −0.1167pp |
| Daily-book axis | 209 dates from 2026-01-01, 12 Sundays | 197 dates from 2025-12-31, none on a weekend |

Buy-and-hold 50/50 YTD is +18.6995615% on both builds (legs unchanged at YTD). Attribution of the YTD excess change (+0.0155pp): anchor plus ASX dates +0.0004pp; FX dating −0.0147pp on the 50/50 (S27's USD conversion), +0.0003pp on the book. At 1M the anchor dominates: the HEAD book dropped the 3 September session (+0.70%). Window effect: with GLS given no feed, the 52-week model covers the other holdings at 9.7120% weekly (9.9070% daily, 259 intervals) with the whole-book figure withheld. Reviewer's diagnostic (benchmark moved to the HEAD book anchor) reproduced exactly: 3M −1.149850 → −0.755846, 1M −0.830075 → −0.604470; the fix instead moves both sides to the preceding close.

## What was done, by item

1. **Anchor.** The book, the cash-drag bridge and every benchmark are valued from the last daily-book date before the window (`_bookAnchorIndex`); the axis opens on 2025-12-31 for YTD. A benchmark without a session on the anchor takes its preceding close; one with no close on or before it returns null. `_perfWindowStart` clamps to month end (31 Oct less 1M was 1 Oct).
2. **Short history.** One common window; no zero padding; minimum 26 weekly intervals (`RISK_MIN_WEEKS`); excluded holdings are named and the whole-book vol and diversification ratio are withheld; window and coverage printed beside the figures; titles, footnotes and scatter labels driven by the actual window.
3. **Session dates.** Bars dated in exchange time (`ds`, `_sessionDater`); feed `tz`, else suffix inference, else UTC. Fixed for the daily book, FX history (also a BST one-day look-ahead), risk, benchmarks and the live merge.
4. **One 50/50.** `_blendSeriesSGD` (daily-rebalanced, SGD) feeds both tabs; scope and residual-variance wording corrected.
5. **Benchmarks independent of holdings.** `BENCHMARK_DEFS` with explicit currencies; held, live or baked route; bake retains both symbols.
6. **Bad prints.** Generic deletion removed; |log| > 0.4 moves flagged and kept; named exclusions with basis applied to holdings and benchmark paths; 3010.HK 2025-10-24 retained as a suspected vendor anomaly (not exchange-verified), outside the current window.
7. **Escaping.** `_escHtml` on every data string in the risk card and Allocation tables; Plotly labels escaped.
8. **UI.** Nulls sort last both ways (HEAD put them first ascending). Sort and Show-all state already persisted at HEAD; verified again, no change needed. Heatmap value text is recomputed on a container crossing 600px by one `ResizeObserver`, replaced on each render.

## Tests and checks

- `node scripts/risk_model.test.mjs` 56/56; `node scripts/session_dates.test.mjs` 37/37, including the fast path against Intl on all 187,134 locally baked bars; `node scripts/risk_week_key.test.mjs` pass; `node scripts/quote-proxy-worker.test.mjs` 33/33; `node scripts/validate_ledger.js` all gates pass. Mutation check: the old sort, old anchor and zero padding each fail the suite (1, 3 and 12 checks).
- Browser, same snapshot: explicit-`tz` payload gives identical figures to the inferred route; held and unheld routes give identical STI, S&P 500 and 50/50 series and curves (YTD, 3M, 1M); every 2026 fill lands on an axis date; injected `<img onerror>`, `<svg onload>` and attribute-breaking payloads render as text with no element, no handler attribute and no execution, including heatmap and scatter labels; sort and toggle survive a poll redraw, pivot change and tab switch; `ResizeObserver` count stays 1 after five redraws.
- `python C:/dev/scripts/check_page.py template.html`: exit 1, one FAIL for sub-11px fonts, identical to HEAD (165 declarations both; the one new 10px line was raised to 11px). Two WARNs, also as HEAD.
- Emulated viewports (clientWidth read back; it excludes a 5px scrollbar at the wider sizes): 390 → 390; 844×390 → 839; 768 → 763; 1280 → 1275. Document horizontal overflow 0 on all seven tabs at every width (`body` overflow visible, so the reading is real). Unclipped overflowing elements at 390: Positions 33, Signals 8, the same as HEAD; 0 elsewhere. Risk table scrolls inside its container (332 of 955px at 390; fits at 1280). Heatmap prints 144 values at 705–1209px and none at 332px. Risk notes and the Performance scope note, capped at 52ch: 59–66 characters a line at 390 (11px), 69–71 at 844, 768 and 1280. Allocation buttons 32–40px high, unchanged.
- Limit: the browser pane was hidden, so `ResizeObserver` callbacks are not delivered there; the crossing was verified by calling the observer's handler (`_riskHeatmapSync`) after each resize and counting rendered cell text.

## Remaining limitations and decisions for the owner

- `RISK_MIN_WEEKS = 26` is a judgement; GLS clears it exactly (26 intervals), so a listing one week younger would withhold the whole-book figure. The window is set by the youngest holding: today one 0.63% position halves the sample.
- The per-ticker engines (day split, period P&L, FIFO attribution, charts) still date bars by UTC; only ASX (SGM.AX) differs there.
- FX re-dating shifts every historical SGD conversion by one session for the BST half-year; effects measured above are small (≤0.13pp on any window shown).
- The 12 provisional `p` bars of 2 October in the bake are Saturday quotes for Friday's session; a later bake replaces them.
- Notes at 11px exceed the 40–50 characters-a-line phone guideline (as HEAD's footnotes did); sub-11px type elsewhere on the page and the Positions/Signals overflow at 390 predate this work.
- MRNA.US +177% on 2026-08-19 is flagged on the card. It is consistent with the statement-reconciled buy at 151.70 on 21 August, so it is treated as genuine; if a "verified genuine" list is wanted to silence such flags, that is a separate decision.
- Not implemented, as instructed: the GDX.GB → GDX.L remap.

Dates for owner confirmation: snapshot 3 October 2026 (Saturday), last session 2 October 2026 (Friday), window 3 April (Friday) to 2 October 2026, YTD anchor 31 December 2025 (Wednesday), 3M and 1M anchors 2 July (Thursday) and 2 September 2026 (Wednesday), 3010.HK print 24 October 2025 (Friday), MRNA move 19 August 2026 (Wednesday), GLS first priced 30 March 2026 (Monday). Weekdays checked with Python datetime.
