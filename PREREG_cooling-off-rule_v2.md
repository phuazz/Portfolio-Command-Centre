# PREREG v2 — Does a cooling-off delay on buys remove the adverse placement of the owner's buy fills? (Portfolio Command Centre)

**Registered and adopted:** Thursday 2026-10-15 (weekday verified with the Python `datetime` library); text revised on Friday 2026-10-16 after two red-team passes at the spec-freeze gate, before any freeze and before any read. **Context:** Personal. **Tier of the registration session:** Opus 5.5 (the vault ladder puts research design on Fable; the predecessor was registered on Fable 5.1; this successor changes the rule's scope, carries the predecessor's statistics over, and was reviewed twice by the red-team agent: eight S2 findings, all addressed below, one of them by owner decision on the verdict mapping). **Supersedes:** `PREREG_cooling-off-rule.md` (registered 2026-10-03, adopted 2026-10-05), void from 2026-10-15 by its amendment (d). **Status:** REGISTERED, ADOPTED 2026-10-15, NOT RUN. **Freeze:** the commit that adds this file; no threshold, wait, floor, read point, scope, exemption date or mapping changes after it, and a change is a new registration.

**What has been read before this registration (all SEEN):**
- the filed 2026 fill-timing study in full;
- three exploratory looks in `RESEARCH_MEMO.md` section 6: the one-session delay, the cooling-off counterfactual at 3, 4 and 5 per cent, and the volatility-scaled trigger look of 2026-10-14 (script `reviews/2026-10-03_fill-timing/2026-10-14_vol-scaled-trigger_look.py`, sha256 `9f771470266465ffb638dd43a4b531d2aca646bb63556a748bab77da18b6416b`; its memo paragraph was uncommitted work of another session when this file was written);
- the predecessor's adopted record from 2026-10-05 to 2026-10-14 (section 9);
- the moves after two cancelled sells, NBIS.US and KOID.US, whose orders of 2026-10-12 were cancelled while their reads were fired and whose prices then fell about 23 and 7 per cent from the limits by 2026-10-15 (live Yahoo marks during the US session, single source, approximate). That episode prompted the change of scope. It is n = 2 in one correlated move and is not evidence.

---

## 0. Objective

The predecessor's question, restricted to buys: once the owner stops placing a buy in the sessions straight after a sharp rise, do buy fills stop sitting at the adverse end of their week? The verdict-bearing statistic is the filed study's, on post-adoption buy fills alone, against the same placebo null. Sells are logged and never delayed; whether exempting them costs anything is a descriptive secondary.

## 1. Why the scope changes

The evidence for a delay sits on buys. In the filed study, buys made after three-session rises gave back about 2.4 points over the next five sessions against a random-day placebo; against a placebo matched on the size of the prior move the excess is about 1.2 points, which the memo treats as an upper bound. In the second exploratory look, the 3 per cent cooling-off counterfactual saved S$10,384, of which S$8,662 (83 per cent) came from buys; the sells' share was S$1,722 at 3 per cent and minus S$1,284 at 4 per cent, so its sign is not stable. Sells after a fall kept falling about 1.9 per cent over the next five sessions, and the third look found no pattern in sells by volatility tercile. A delay on a sell therefore holds a falling position for up to five sessions with no stable expected saving. These readings chose this design; none of them is evidence for it.

## 2. The rule (R2, a delay on buys, never a veto)

**Buys:** the predecessor's R1, with the read tied to the session. At the moment of decision the three-session move is the change from the close three sessions before the decision session to the current price, upwards. A buy read **holds for its own session only**:
- a **clear** buy is placed on its decision session; a buy placed on a later session needs a fresh decision;
- a **fired** buy (move above **T = 3.0 per cent**) is not placed that session. It is re-read on later sessions with the move close-to-close over the three sessions completed before the session (predecessor amendment (c)). It may be placed only on a session whose re-read cleared it (`cleared_on` is that session), or on or after the **fifth session after the decision (K = 5)** regardless.
An order placed in breach is allowed and logged as an override with one line of reason.

**Sells:** never delayed. Every sell is still logged at decision with its three-session move (downwards) and its fired or clear state, so the cost of the exemption can be measured. A sell placed on or after 2026-10-15 links to its decision as filled whatever the state, is never an override, and does not count in the adoption gate. The exemption keys on the date the sell is placed, and the `exempt` flag is written on the decision row when the fill is linked.

**Provenance of the read:** where the owner supplies the price (`--price`), the feed's live price and its time are recorded beside it (`px_feed`, `px_feed_time`). A decision logged after the order was placed is marked `logged_after_fill` (`--after-fill`).

## 3. The decision log and its guard

`decisions.json`, unchanged in shape apart from the fields above, written only by `scripts/add_decision.js` and `scripts/add_trade.js`. It gains one top-level field, `sells_exempt_from: "2026-10-15"`, set once by `node scripts/add_decision.js exempt-sells 2026-10-15` and never edited. The guard in `validate_ledger.js` refuses any fill dated on or after 2026-10-05 without a decision link, on either side. It also refuses a buy dated on or after 2026-10-15 whose timing breaks section 2 unless it is recorded as an override.

## 4. Data and statistics

Exactly the predecessor's section 3, on buy fills dated on or after 2026-10-15 that are linked to a decision row. The engine is the filed study's `reviews/2026-10-03_fill-timing/fill_timing.py` with its `prereg_spec.json`, unchanged except for:
- a `--since <date>` filter;
- a `--side B|S` filter;
- the decision-level cells.
These are built before the first read, and the engine's hash is recorded here as an amendment.

Everything else carries over: the unit, the window, dividend rebasing, the adverse rank u, the blocked placebo null (10,000 sets, one offset per cluster, seed 20261003), the exclusions, the alignment and bar-defect rules, and a committed bars extract with its hash at each read.

## 5. Hypotheses and floors

- **H1 (the cure on buys; verdict-bearing).** Write E for the excess of the post-adoption buy mean u over the placebo mean, and σ for the placebo null's standard deviation of the mean at the read. The test is one-sided, in the adverse direction, against the blocked null.
  - **CURED-AT-SIZE:** p > 0.05 at power at least 0.80 for E = 0.06.
  - **NOT CURED:** p ≤ 0.05 and the estimated E at or above δ = 0.06.
  - **IMPROVED-BELOW-SIZE:** p ≤ 0.05 and the estimated E below 0.06.
  This is the predecessor's point-estimate split, kept by owner decision on 2026-10-16. An upper-bound split was drafted and rejected: at the design σ it leaves IMPROVED-BELOW-SIZE unreachable below about 205 scored buys. Chance of each verdict at the 150-buy read, at the design σ of 0.0213 (normal approximation; p ≤ 0.05 needs an estimate of at least 0.035):

  | True E | CURED-AT-SIZE | IMPROVED-BELOW-SIZE | NOT CURED |
  |---|---|---|---|
  | 0.00 | 0.95 | 0.05 | 0.00 |
  | 0.03 | 0.59 | 0.33 | 0.08 |
  | 0.06 | 0.12 | 0.38 | 0.50 |

  The cost accepted: at a true effect exactly at the floor, NOT CURED fires half the time. The benefit: a rule that removes most of the 2026 excess (about 0.14 before the rule) is rarely retired, about 8 per cent of the time at E = 0.03.
- **D1 (descriptive).** The post-adoption buy mean u beside the 2026 buy before-set: 84 buys, mean u 0.650 (recomputed by the red-team agent from the frozen `results.json`; confirmed at the read before use). The difference is reported with its cluster-bootstrap interval. The before-set is SEEN and describes only.
- **S1 (wait economics on buys; floored secondary, underpowered).** As the predecessor's S1, on fired buy decisions later filled. Saving = side × (decision price − fill price) × quantity at fill-date FX, with side +1 for a buy and −1 for a sell. It is set against a zero-drift null and the placebo-wait comparator (the same wait from a random session in the name's prior sixty). Floor: 0.5 per cent of notional per fired decision. Reported with its interval and demoted by the power rule.
- **S2 (forgone moves on buys; descriptive).** As the predecessor's S2, on dropped buy decisions and on fired buys filled late.
- **S3 (adoption gate).** Two conditions, both counted on fills dated on or after 2026-10-15; either one above 20 per cent reads NOT ADOPTED and no verdict is read:
  - (i) buy fills recorded as overrides ÷ all buy fills;
  - (ii) fills on either side with no decision row ÷ all fills.
  Disclosed beside the gate, never part of it: the share of filled decisions logged after the fill, and the number of decisions whose fired or clear state would differ if read on `px_feed` rather than the owner's price. An `--override` on a buy that complies with section 2 is refused, so gate (i) counts real breaches only.
- **S4 (fired against clear, buys; descriptive).** As the predecessor's S4, on buys.
- **S5 (the cost of the exemption; descriptive, never verdict-bearing).** On every **fired** sell placed on or after 2026-10-15, the counterfactual is that R1's wait was applied. The release session R is the first session after the decision whose re-read (amendment (c)) is at or below 3 per cent, or the fifth session after it.
  - Wait saving = side × (actual fill price − close of R) × quantity at fill-date FX, with side −1 for a sell, which is S1's formula with the actual fill in the place of the decision price and R's close in the place of the delayed fill.
  - Same zero-drift null and placebo-wait comparator as S1.
  - **Sign, by example:** a sell filled at 100 whose release close is 95 gives −1 × (100 − 95) = −5 per share. Waiting would have cost 5 per share, so a negative S5 means the exemption saved money.
  - Also reported: the mean u of all post-adoption sells against the placebo (the engine with `--side S`), beside the buys' figure.
  - A persistently **positive** S5 at the 150-buy read (waiting would have saved money on fired sells) is grounds for a successor registration, never for a change to this one.

## 6. Null, power, read points

The predecessor's null and design power, applied to buy fills: the null sd of the mean was 0.0212 at 151 fills in 47 clusters, scaled by the square root of 151 over n.

| Post-adoption buy fills n | Null sd of the mean (design) | Power at δ = 0.06 | Role |
|---|---|---|---|
| 75 | 0.030 | 0.64 | interim read, descriptive only, demoted |
| **150** | **0.021** | **0.88** | **verdict read** |
| 200 | 0.018 | 0.95 | second read if the first is demoted or THIN |

The red-team agent found that on the 2026 record buys clustered less tightly than all fills, so the scaling is conservative; its rough bound puts power at 150 between 0.88 and about 0.96. That bound is an estimate and has not been recomputed here. The run computes the real figure, and the demotion rule binds on it.

**Accrual (estimates from one year's record).** Buys were 87 of the 162 fills of 2026 to 2026-10-14 (54 per cent), about 111 a year. The study scored 151 of 159 fills, so about 5 per cent drop out, and 150 scored buys need about 158 buy fills. The 75th scored buy then falls about July 2027 and the 150th about March 2028. The rule may itself change how often the owner buys.

Reads are by accrual, each run once: the interim on Opus from a written run prompt, the verdict on Fable from the declared cells only. The NOT ADOPTED deadline moves to **Friday 2028-06-30**: fewer than 150 scored post-adoption buy fills by then, with the owner declining a demoted read, reads NOT ADOPTED.

## 7. Consequences and prohibited claims

The predecessor's section 7 applies with "fills" read as "buy fills" and the verdicts of section 5 above.
- CURED-AT-SIZE keeps R2 as a standing operator rule in `CLAUDE.md`.
- NOT CURED retires the buy delay.
- IMPROVED-BELOW-SIZE keeps R2, and a successor may test a tighter design.
- S5 is weighed by the owner beside the verdict and never changes it.

One addition to the prohibited claims: no claim that the NBIS.US and KOID.US episode, the predecessor's record or any S5 figure shows the sell exemption to be right or wrong.

## 8. Predictions, registered so they can be wrong

- P1 (55 per cent): at the 150-buy read H1 reads CURED-AT-SIZE, with the post-adoption buy mean u between 0.52 and 0.58.
- P2 (60 per cent): S1's wait saving on buys is positive in sign and its interval includes zero.
- P3 (65 per cent): buy overrides are below 10 per cent of post-adoption buy fills.
- P4 (60 per cent): S5 is negative in sign over the fired sells (the exemption saved money), consistent with sells continuing in the direction of the move.

## 9. The predecessor's adopted record (closed, never read) and the first R2 fills

R1 ran from 2026-10-05 to 2026-10-14 inclusive. Its record:
- IGV.US buy 2026-10-12: clear, filled;
- REMX.US sell 2026-10-12 and T6I sell 2026-10-14: both fired, both overrides, both logged after the fill;
- KOID.US and NBIS.US sells of 2026-10-12: fired, orders cancelled, dropped.
None of these enters any cell of this registration.

The open sell decision `2026-10-14-NBIS.US-S`, if filled on or after 2026-10-15, is exempt under section 2 and enters S5 only.

The first R2 fill is G3B, a buy of 1,200 on 2026-10-16 (decision `2026-10-16-G3B-B`, clear, filled the same session). It was logged after the order was filled, before the `logged_after_fill` flag existed, so its row carries no flag and the validator's count omits it. It is disclosed here instead, and the read adds it by hand to the logged-after-fill disclosure.

The wait's expiry follows section 2: the fifth session after the decision. The R1 code expired one session late (at five completed sessions, the sixth session). It was corrected on 2026-10-16 before this freeze, and no R1 decision reached expiry.

## 10. Stop and gate conditions

- A fill on or after 2026-10-05 with no decision row is refused by the guard; one that reaches the ledger by any other route is excluded and counted in S3 (ii).
- A read before 75 complete post-adoption buy fills is not a read.
- A changed engine hash, spec hash or extract hash at a read is a stop.
- A change of threshold, wait, scope, exemption date or mapping after the freeze voids this registration from that date and needs a new one.

## 11. Build at adoption (this session)

1. `scripts/decisions.js`:
   - `sells_exempt_from` in the log's head;
   - `isExemptSell` and `r2BuyTiming`;
   - `assessLink` links an exempt sell as filled whatever its state, refuses an override on it or on a complying buy, and enforces the session-bound buy read;
   - `guardFills` mirrors both and reports the R2 gate on buys from 2026-10-15, with the logged-after-fill disclosure.
2. `scripts/add_decision.js`:
   - `exempt-sells <date>`, set once;
   - `--after-fill`;
   - `px_feed` beside an owner price;
   - `check` refuses a stale clear buy read and a session later than today, and records the latest clearing session for a fired buy;
   - expiry on the fifth session after the decision.
3. `scripts/add_trade.js`: writes `exempt` on the decision row at link time.
4. `scripts/decisions.test.mjs`: the exemption, link, timing and gate tests, each failing first on a broken fixture, with one month-boundary and one year-boundary test of the exemption date.
5. `CLAUDE.md` trade-entry workflow: the rule, buys only.

Before the first read, not at adoption: the engine's `--since` and `--side` filters and the decision-level cells, with its hash recorded here.

## 12. Ledger check

The predecessor's section 10 stands: the vault holds no test of a buy-only or side-asymmetric cooling-off rule. Adjacent work:
- the predecessor (`Portfolio-Command-Centre/PREREG_cooling-off-rule.md`, ledger row 2026-10-03);
- the filed fill-timing study (`2026-10-03-Portfolio-Command-Centre-1` to `-4`), whose sell findings motivate the scope.

## Amendments

(none)
