/*
 * Technical findings record for the fill-timing study (Portfolio Command Centre).
 * Content spec for the research-review report builder; every figure traces to
 * results/results.json and results/coverage.json. Build with:
 *   node build_report.js
 */
const path = require("path");
const { buildReport } = require("C:/Users/phuaz/.claude/skills/research-review/assets/report_builder.js");

const HERE = __dirname;
const OUT = path.join(HERE, "..", "2026-10-03_fill-timing_adverse-placement.docx");

const spec = {
  meta: {
    title: "Fill timing against the market: do the 2026 fills land at the worst price within three sessions either side?",
    subtitle: "Technical findings record. Pre-registered, red-teamed at the freeze, run once at the frozen vintage.",
    dateISO: "2026-10-03",
    weekday: "Saturday",
    headerLeft: "Portfolio Command Centre: fill-timing study",
    metaLeftW: 2400,
    assetsDir: path.join(HERE, "charts"),
  },
  metaTable: [
    ["Project / context", "Portfolio-Command-Centre, Personal. Tier Fable 5.1."],
    ["Study", "The owner's prior that fills land at the worst price within three trading days either side, tested on the 2026 ledger against a simulated zero-skill null under the vault's symmetry guards."],
    ["Evaluation window", "159 fills dated 2026-01-05 to 2026-10-02; 151 complete after rule-based exclusions (84 buys, 67 sells, 70 symbols, 68 session dates, 47 clusters, S$1,662,184 of notional at fill-date FX). Bars to 2026-10-02."],
    ["Data basis", "trades.json and book.json at the frozen vintage; unadjusted Yahoo daily bars as baked for the dashboard on 2026-10-03, windows rebased to the fill session's ac/c factor; fx.json frozen as an extract. Hashes in results/coverage.json."],
    ["Method basis", "Adverse rank u of the fill inside the seven-session low-to-high range (1 = worst price for the side); blocked placebo null, 10,000 sets, one offset per cluster, uniform intraday price; floors fixed before the run (H1 +0.06, H2 +0.05); one-sided alpha 0.05; cluster bootstrap for intervals."],
    ["Repository commits", "Freeze b7ff146 on origin/main (engine e762808c, spec c0e06404). Run 2026-10-03 10:12 UTC at the frozen vintage after the first attempt was refused on a changed input (section 2)."],
    ["Running memo", "RESEARCH_MEMO.md, study section (registration 0 to 5, results 6)."],
    ["Outcome", "CONFIRMED; TAIL-ELEVATED. Mean u 0.639 against placebo 0.498, effect +0.140, p 0.0001; 11.9% of fills within a tenth of the worst price against 4.0%. Excess placement S$34,027, 205 bps of notional, 8.7 times one-way commission: material."],
  ],
  sections: [
    { type: "h1", text: "1. Executive summary" },
    { type: "numbers", items: [
      "The prior is confirmed at more than twice the registered size. The 151 fills sit at a mean adverse rank of 0.639 inside their seven-session range against 0.498 for the same trade on a random nearby session at a random intraday price: effect +0.140 (95% cluster-bootstrap interval +0.112 to +0.163), one-sided p 0.0001 on 10,000 blocked placebo sets, floor 0.06 cleared 2.3 times, power at the floor 0.883.",
      "The literal reading holds too: 18 of 151 fills (11.9%) sit within a tenth of the worst price of their window against 3.99% under the null (p 0.0005, floor 0.05 cleared), and 22.5% were worse than all six neighbouring closes against 9.2%.",
      "The mechanism is the day, not the time of day. The price moved 5.2% against the owner over the three sessions before the fill (placebo +0.2%): buys followed 6.5% three-session rises, sells 3.5% falls, on 82% of fills. The fill priced at the session close reproduces the whole effect (u 0.645). Buys then gave back 2.4 points against drift over the next three sessions (1.2 points beyond a pre-matched placebo, p 0.02); sells did not reverse. Intraday placement is adverse as well (0.575 of the day's range, p 0.0007) but adds nothing to u beyond the day choice.",
      "The three ways the result could have been silently wrong are closed in code: the ledger dates fills by exchange session (152 of 154 inside their own range, 90 decisive against a one-session-late dating, none re-dated); excluding the six ex-date windows leaves u at 0.633; mechanical reversal, netted out by matching on the pre move, leaves the pre leg untouched.",
      "The S$ anchor is material. Excess placement against each fill's placebo-median price sums to S$34,027 (null sd S$7,350, p 0.0001): 205 bps of S$1,662,184 traded, 8.7 times the 23.5 bps one-way commission measured from the ledger's own fees, and 17.5% of the dashboard's 2026 YTD P&L of S$194,578 (single-source). It is a counterfactual placement, not realised profit or loss, and it includes the price of entering after confirmation.",
      "Robust to every declared sensitivity: notional-weighted 0.637, buys 0.650, sells 0.624, ex-dates excluded 0.633; every month above 0.5; dropping any single ticker leaves the effect between +0.135 and +0.149; the largest fill carries 2.2% of it.",
      "Exploratory sell regret points the other way: the names sold did not beat what the proceeds went into (median regret −0.3% at 20 sessions, n 60; −3.4% at 60 sessions, n 48; 42% positive).",
      "Predictions scored 1 of 4. The analyst expected a null result and a sub-commission cost; the owner's prior was right. Consequences as fixed at the freeze: nothing changes in the dashboard or any engine; any order-placement or entry-trigger rule is a separate owner decision and a separate registration tested on fills made after adoption.",
    ] },

    { type: "h1", text: "2. What ran: registration, guards and the run record" },
    { type: "p", text: "The registration (memo sections 0 to 5) was written and frozen before any actual statistic was computed. The engine's coverage mode computes eligibility, the date-alignment convention, ex-date flags, window widths and the placebo null with its power, and cannot compute a score on an actual fill; the run mode is a separate path executed once. The spec-freeze red-team review returned one blocking finding (the placebo null drew offsets independently per fill when the 151 fills form 47 clusters sharing session dates or overlapping windows, which understated the null spread and took the power at the first-registered floor of 0.05 to about 0.75) and four must-fix findings (a coverage record written by an earlier engine, a live-baked FX input, prose-only stop conditions, a machine trial register contradicting the spec). All were fixed before the freeze and confirmed on a disposition check: the null is blocked per cluster, the floor is the blocked minimum detectable effect rounded up, the FX pairs are frozen as an extract, and the run refuses to start unless the spec, engine, both extracts, trades.json and book.json hash to the frozen values, the fill count equals 151, no score is missing, and the vectorised placebo path agrees with the scalar actual path to 1e-9 on every fill." },
    { type: "callout", text: "The guard fired. Between the freeze and the run a concurrent session committed a change to trades.json and book.json (GDX.GB re-pointed from the US GDX proxy to its own London line, the fix this study's alignment probe had surfaced). The first run attempt stopped on the trades.json hash. The run then executed in a scratch layout holding the frozen blobs of both files with the identical engine, spec, extracts and coverage record; the change could not alter the sample because GDX.GB was excluded by rule on either vintage." },
    { type: "table",
      headers: ["Exclusion rule (mechanical, fixed before any statistic)", "Fills", "Which"],
      rows: [
        ["No feed symbol", "2", "XMED.GB 2026-03-02 S, XCSI.GB 2026-03-03 S"],
        ["Proxy feed (book exchange is not the feed symbol's market)", "1", "GDX.GB 2026-03-13 S; the fill at 108.83 sat above the US GDX session high of 98.41"],
        ["Symbol absent from the bake", "2", "CPRX.US 2026-05-07 B, 2026-07-16 S"],
        ["Price outside its session's range and both neighbours'", "2", "2525.HK (Hesai) 2026-02-23 B at 220.6 and 2026-03-25 S at 164.0 against bars of 27.1 to 28.2 and 20.0 to 20.9: a feed in other units (ratio 7.82 and 7.85)"],
        ["Window incomplete", "1", "0981.HK 2026-10-02 S, no bars after the fill"],
        ["Complete", "151", "84 buys, 67 sells; USD 122, HKD 15, EUR 5, JPY 5, SGD 3, AUD 1"],
      ],
      widths: [3600, 800, 4626], numericFrom: 1 },

    { type: "h1", text: "3. Findings" },
    { type: "h2", text: "3.1 The verdict cell: mean adverse rank against the blocked null" },
    { type: "p", text: "Figure 1 is the pre-registered test. The grey distribution is the mean u of 151 same-side fills placed on random sessions 4 to 60 bars either side of the real one at random intraday prices, one offset per cluster per set so that fills sharing a date or overlapping windows keep their common market move; 10,000 sets. The actual mean sits 6.6 null standard deviations above the placebo mean and well beyond the floor." },
    { type: "chart", file: "fig1_verdict_null_mean_u.png", widthPx: 600,
      caption: "Figure 1. The null distribution of the mean adverse rank u (grey), the registered floor at placebo + 0.06 (red) and the actual mean (navy). No placebo set of 10,000 reached the actual value." },
    { type: "table",
      headers: ["Cell", "Actual", "Placebo", "Effect and 95% cluster-bootstrap interval", "p (adverse)"],
      rows: [
        ["H1 mean u, equal-weighted, n 151 (verdict-bearing)", "0.639", "0.498", "+0.140 [+0.112, +0.163]; floor 0.06", "0.0001"],
        ["H2 share with u above 0.9 (suffix-bearing)", "11.9%", "3.99%", "+0.079 [+0.029, +0.117]; floor 0.05", "0.0005"],
        ["S1 mean u, SGD-notional-weighted", "0.637", "0.498", "+0.139 [+0.107, +0.164]", "0.0001"],
        ["S2 worse than all six neighbouring closes", "22.5%", "9.2%", "+0.133 [+0.041, +0.200]", "0.0001"],
        ["S6 u at the session close (day choice alone)", "0.645", "0.500", "+0.145 [+0.110, +0.170]", "0.0001"],
        ["S7 buys, n 84", "0.650", "0.491", "+0.159 [+0.105, +0.204]", "0.0001"],
        ["S7 sells, n 67", "0.624", "0.508", "+0.116 [+0.056, +0.176]", "0.0002"],
        ["S8 ex-date windows excluded, n 145", "0.633", "0.498", "+0.135 [+0.108, +0.160]", "0.0001"],
      ],
      widths: [3400, 900, 1000, 2726, 1000], numericFrom: 1 },
    { type: "p", text: "Thinness (S9): dropping any one ticker leaves the effect between +0.135 (OXY) and +0.149 (MU), no sign change; the largest single fill carries 2.2% of it. By currency the mean u is 0.650 on the 122 USD fills and 0.660 on the 15 HKD fills, with the small EUR, JPY and SGD groups between 0.52 and 0.54; by month it runs from 0.58 (August) to 0.71 (February) and never below 0.5. The first-registered floor of 0.05, kept as a disclosure, is cleared 2.8 times." },

    { type: "h2", text: "3.2 Every fill: the strip and the tail" },
    { type: "p", text: "Figure 2 shows one mark per fill so that the shape of the result is visible, not only its mean: the lower quartile of the actual u is 0.49, the median 0.66, the upper quartile 0.80; 110 of 151 fills sit above 0.5, one below 0.1 and eighteen above 0.9. Under the null the middle session of a seven-session window is rarely its extreme, which is why 4.0% is the base rate for the tail and not the naive one in seven." },
    { type: "chart", file: "fig2_u_by_fill.png", widthPx: 600,
      caption: "Figure 2. Adverse rank of each of the 151 fills by side (navy marks) over the placebo's pooled 5th to 95th and 25th to 75th percentile bands (grey) with its median (white). The dotted line is the tail threshold." },

    { type: "h2", text: "3.3 Chased or reversed: the pre and post legs" },
    { type: "p", text: "The window is split at the fill. The pre leg is the move from the close three sessions before to the fill price; the post leg the move from the fill to the close three sessions after; both oriented so that positive is against the owner. Figure 3 and the table give the legs by side against the placebo, and S4 compares the post leg with placebo sessions whose own pre move sits in the same tercile as the fill's, so that reversal a random trader would have met after the same kind of run is netted out." },
    { type: "chart", file: "fig3_pre_post_legs.png", widthPx: 600,
      caption: "Figure 3. Adverse move before and after the fill by side, actual (navy) against placebo (grey), with the 95% cluster-bootstrap interval on the actual. The pre leg carries the effect; the post leg is a smaller buy-side give-back." },
    { type: "table",
      headers: ["Leg", "Actual", "Placebo", "Effect and interval", "p (adverse)"],
      rows: [
        ["S3 pre leg, all fills (per cent of price)", "+5.19", "+0.15", "+5.03 [+2.68, +7.64]", "0.0001"],
        ["Buys: price rose before the buy", "+6.50", "+0.88", "+5.62 [+2.14, +10.27]", "0.0001"],
        ["Sells: price fell before the sale", "+3.55", "−0.75", "+4.30 [+1.78, +6.61]", "0.0001"],
        ["S3 post leg, all fills", "+0.96", "−0.31", "+1.27 [−0.13, +2.99]", "0.039"],
        ["Buys: price fell after the buy", "+1.22", "−1.15", "+2.37 [+0.24, +4.65]", "0.010"],
        ["Sells: price rose after the sale", "+0.63", "+0.73", "−0.10 [−3.37, +3.96]", "0.529"],
        ["S4 post leg against the pre-tercile-matched placebo", "+0.96", "−0.23", "+1.19 (null sd 0.58)", "0.020"],
        ["S5 intraday placement v (share of the day's range)", "0.575", "0.500", "+0.075, z 3.2 (independence assumed)", "0.0007"],
      ],
      widths: [3400, 900, 1000, 2726, 1000], numericFrom: 1 },
    { type: "p", text: "Reading: 82% of fills on each side had an adverse pre leg (median +3.8%). The fill priced at the session close gives the same u as the fill itself (0.645 against 0.639), so the choice of day carries the effect; the intraday placement is adverse on its own terms (27% of fills in the worst quarter of their day, 9% in the best) but adds nothing to u beyond the day. The pre-matching is by tercile and the actual pre moves sit far inside the top tercile, so the +1.19 point reversal excess is an upper bound on what mechanical reversal leaves unexplained. The signature matches the vault's record for mechanical close-cross breakout entries on the S&P 900 (2026-08-06-stock-radar-1, a robust anti-edge) and for all-time-high entries (2026-09-03-stock-radar-1)." },

    { type: "h2", text: "3.4 The three ways this could have been silently wrong" },
    { type: "table",
      headers: ["Mechanism", "Check in code", "Outcome"],
      rows: [
        ["Date convention: a US fill placed in Singapore evening hours dated by its SGT date, one session late, would manufacture extremes by itself", "Every fill's price tested against its dated session's low-to-high range and both neighbours', before the freeze", "152 of 154 fills with a feed inside their own session's range; 90 of them outside the previous session's, so a late dating would have shown; none re-dated. The two outside are the Hesai feed in other units."],
        ["Dividends: an ex-date inside the window makes a pre-ex buy look like buying the top; adjusted closes would shift every pre-ex bar", "Unadjusted bars; windows rebased to the fill session's ac/c factor; ex-dates detected from the factor; S8 excludes the six windows that hold one", "u 0.633 with the six excluded against 0.639; 3.3% of placebo windows hold an ex-date, all small"],
        ["Mechanical reversal: buying after a three-session rally looks like bad timing in many markets without a timing deficit", "Pre and post legs split; the post leg compared with a placebo matched on the pre-move tercile (S4)", "The pre leg, +5.0 points beyond placebo, is untouched by reversal; the post leg, +1.3 points, is +1.2 beyond the matched placebo (p 0.02) and the smaller component"],
      ],
      widths: [3000, 3000, 3026] },

    { type: "h2", text: "3.5 The S$ anchor" },
    { type: "p", text: "For each fill the placebo-median price is the price inside the fill's own window at the median placebo u, so the cost is (actual u less median placebo u) times the window range times quantity, at fill-date FX. Figure 4 accumulates it in date order against the band inside which the placebo total lands 95% of the time." },
    { type: "chart", file: "fig4_cost_anchor.png", widthPx: 600,
      caption: "Figure 4. Cumulative excess placement cost in S$ over the 151 fills in date order (navy) against ±1.96 standard deviations of the placebo total (green). The line leaves the band after about seventy fills and never returns." },
    { type: "table",
      headers: ["Item", "Value", "Basis"],
      rows: [
        ["Excess placement cost", "S$34,027", "Sum over 151 fills; buys S$21,747, sells S$12,280; 110 fills positive; ten largest 46%"],
        ["Placebo total", "mean −S$124, sd S$7,350, p95 S$12,135", "10,000 blocked sets; p 0.0001"],
        ["Traded notional", "S$1,662,184", "Quantity × price × fill-date FX; buys S$923,673, sells S$738,511"],
        ["Cost in bps of notional", "205 bps (null sd 44)", "Same basis"],
        ["Commission on these fills", "S$3,858; 23.5 bps one-way", "Ledger fee field on 149 fills at fill-date FX; USD 21.9, HKD 33.7, EUR 32.8, JPY 21.8, AUD 21.8, SGD 41.2"],
        ["Rate card", "21.8 bps one-way USD", "Register 2026-08-02-Portfolio-Command-Centre-2, unreviewed extraction; agrees with the measured USD figure"],
        ["Excess placement over commission", "8.7 times one-way", "205 / 23.5"],
        ["Share of 2026 YTD P&L", "17.5%", "Dashboard YTD P&L card +S$194,578, read 2026-10-03 about 14:02 SGT; single-source"],
        ["Reading under the registered rule", "MATERIAL", "bps of notional above one-way commission in SGD terms"],
      ],
      widths: [2600, 2600, 3826] },
    { type: "p", text: "Two caveats travel with the figure. It is a counterfactual placement against a random nearby day, not realised profit or loss. And it includes the pre-leg chase, which is the price of entering after confirmation; whether that confirmation is worth about 200 bps is a question about the entry trigger, outside this registration." },

    { type: "h2", text: "3.6 Sell regret (exploratory, no registered bar)" },
    { type: "table",
      headers: ["Horizon", "n (traced)", "Median regret", "Share positive", "Mean regret", "Names sold, median TR", "Destination, mean TR"],
      rows: [
        ["20 sessions", "60 (41)", "−0.31%", "48%", "+4.3%", "−3.2%", "−4.6%"],
        ["60 sessions", "48 (36)", "−3.39%", "42%", "−5.5%", "−1.4%", "+5.1%"],
      ],
      widths: [1300, 1100, 1250, 1150, 1150, 1526, 1550], numericFrom: 1 },
    { type: "p", text: "Regret is the SGD total return of the name sold less that of what the proceeds went into (same-currency buys within seven calendar days, weighted by notional, else foreign cash earning the FX move). The sells were not regrettable on average; the tails are large on both sides (EWY sold 2026-03-20 rose 60% over sixty sessions while the proceeds in GDX and PLTR fell 8%; PHAG.GB sold 2026-03-03 fell 10.6% while the proceeds in IBIT, MRVL, SLV and INTC rose 71%). 4004.T excluded for the unbooked Crasus spin-off; ref exists on 10 fills only, so fills cannot be grouped by decision type; the destination rule is a tracing heuristic, not the cash ledger." },

    { type: "h2", text: "3.7 Predictions, scored" },
    { type: "table",
      headers: ["Prediction, registered before the run", "Stated probability", "Outcome"],
      rows: [
        ["P1: H1 fails, actual mean u within 0.03 of placebo", "60%", "Wrong: +0.140"],
        ["P2: buys chase, pre leg adverse beyond placebo", "65%", "Right: +5.6 points"],
        ["P3: no reversal beyond the pre-matched placebo", "55%", "Wrong at the margin: +1.2 points, p 0.02"],
        ["P4: excess cost below one-way commission", "70%", "Wrong by a factor of nine"],
      ],
      widths: [5026, 1600, 2400] },
    { type: "p", text: "The analyst's priors ran against the owner's and the owner's were right. The symmetry guards, applied because the prior was a negative self-assessment, cut the other way from the usual case: the self-assessment was under-stated, not over-stated. Source: evidenced, not a feeling. Attribution: the structural candidates are excluded; what remains is the entry and exit trigger reacting to a sharp three-session move. Anchor: zero-skill placebo on the same name and side, a floor fixed in advance, measured commission and a named single-source P&L figure." },

    { type: "h1", text: "4. Decisions" },
    { type: "table",
      headers: ["Component", "Decision", "Basis"],
      rows: [
        ["The owner's prior (fills land near the worst price of the surrounding week)", "CONFIRMED, TAIL-ELEVATED", "H1 effect +0.140, p 0.0001, floor cleared 2.3 times; H2 +0.079, p 0.0005"],
        ["Where the cost comes from", "The day, not the time of day", "Pre leg +5.0 points beyond placebo on 82% of fills; u at the close 0.645; buys give back 2.4 points; sells do not reverse"],
        ["Materiality", "Material", "205 bps of notional, 8.7 times one-way commission, 17.5% of 2026 YTD P&L"],
        ["Dashboard, ledger inputs, engines", "No change", "Fixed at the freeze; no study file touches a dashboard file"],
        ["Order placement or entry-trigger rule", "Owner decision, separate registration", "Any rule is tested on fills made after its adoption; the 151 fills are SEEN"],
        ["Accrual re-read", "Not before about 168 complete fills, new fills only", "Memo 1.8"],
        ["Feed defects found in passing", "Filed as separate tasks", "2525.HK bars in other units; GDX.GB proxy pricing (fixed by the task during this session)"],
      ],
      widths: [2800, 2600, 3626] },

    { type: "h1", text: "5. Trial register" },
    { type: "p", runs: [{ text: "Thirteen declared cells (H1, H2, S1 to S9, C1, X1), one verdict-bearing (H1), one suffix-bearing (H2); side splits of S5 and S7 declared in the memo; no undeclared cell was run. ", bold: false },
      { text: "Floors, null and verdict mapping were fixed before any actual statistic; the first-registered H1 floor of 0.05 is reported as a disclosure after the floor moved to 0.06 at the red-team's clustering finding. ", bold: false },
      { text: "Pre-freeze amendments (memo 1.12 (a) to (k)) were each made on counts or data facts; none on an outcome.", bold: false }] },

    { type: "h1", text: "6. Artefact register" },
    { type: "bullets", items: [
      "RESEARCH_MEMO.md, study section: registration (0 to 5), results (6), data notes (7).",
      "reviews/2026-10-03_fill-timing/fill_timing.py (engine; coverage and run modes; sha256 e762808c at the freeze), charts.py, build_report.js (this record).",
      "reviews/2026-10-03_fill-timing/prereg_spec.json (sha256 c0e06404).",
      "reviews/2026-10-03_fill-timing/results/: bars_used.json and fx_used.json (frozen extracts with provenance), coverage.json (outcome-blind record), results.json (the run), run_summary.txt.",
      "reviews/2026-10-03_fill-timing/charts/: fig1 to fig4.",
      "Freeze commit b7ff14609cfa36c561b872aa020747656308348b on origin/main; red-team review and disposition in the session transcript, dispositions in memo 1.12.",
      "Register records 2026-10-03-Portfolio-Command-Centre-1 to -4; ledger row 2026-10-03 Portfolio-Command-Centre.",
    ] },

    { type: "h1", text: "7. Next phase" },
    { type: "p", text: "None scheduled by this study. If the owner chooses to act, the natural successor is a registered test of a mechanical placement rule (a one- or two-session delay after a move of a stated size, or a limit at the prior close) scored on fills made after adoption against the same placebo null, with the 2026 fills as a before-set only. The accrual re-read of this statistic on new fills is not before about 168 complete fills." },
  ],
  signoff: [
    ["Prepared by", "Claude Code research session (Fable 5.1), under direction of Zhenghao Phua"],
    ["Reviewed and approved by", ""],
    ["Date", ""],
    ["Next review", "Accrual re-read on new fills, not before about 168 complete fills; any placement rule as its own registration"],
  ],
  disclaimer: "Personal research artefact on the owner's own ledger. Figures are counterfactual placements against a simulated zero-skill null, not realised profit or loss; the 2026 P&L figure is a single-source dashboard read; nothing here is investment advice.",
};

buildReport(spec, OUT).then((r) => console.log("wrote", r.outPath, r.bytes, "bytes"));
