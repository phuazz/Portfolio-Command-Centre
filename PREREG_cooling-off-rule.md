# PREREG — Does a cooling-off delay remove the adverse placement of the owner's fills? (Portfolio Command Centre)

**Registered:** Saturday 2026-10-03 (weekday verified with the Python `datetime` library). **Context:** Personal. **Tier of the registration session:** Fable 5.1, effort max. **Successor to:** the fill-timing study filed 2026-10-03 (`RESEARCH_MEMO.md` study section; register `2026-10-03-Portfolio-Command-Centre-1` to `-4`), which found the 2026 fills at a mean adverse rank u of 0.639 against 0.498 for a zero-skill placebo, the cause being trades placed straight after a sharp three-session move, at a cost of S$34,027 (205 bps of notional).
**Status:** REGISTERED, NOT ADOPTED, NOT RUN. The rule takes effect on the adoption date, which is the first session after the decision-log helper (section 11) exists and the owner confirms adoption; the date is recorded here as amendment (a) and in the ledger. No fill made before the adoption date enters the confirmatory set. **Freeze:** the commit that adds this file; after adoption no threshold, wait, floor, read point or mapping changes, and a change is a new registration.
**What has been read before this registration:** the filed 2026 study in full (SEEN), and two exploratory looks on the same SEEN fills logged in `RESEARCH_MEMO.md` section 6 (a one-session delay; a cooling-off counterfactual at thresholds 3, 4 and 5 per cent). The threshold below was chosen with those looks in view, so the 2026 fills cannot carry any part of the verdict; they enter only as the before-set in a descriptive comparison and as the source of the design power estimate.

---

## 0. Objective

One question: once the owner stops placing a trade in the sessions straight after a sharp move in its direction, do the fills stop sitting at the adverse end of their week? The verdict-bearing statistic is the one the filed study used, on post-adoption fills alone, against the same placebo null. A second, economic question is carried as a secondary: what did the waits save or forgo, measured on the decisions the rule delayed.

## 1. The rule (R1, a delay, never a veto)

At the moment the owner decides to trade a name, the three-session move is the change from the close three sessions before to the current price, taken in the direction of the intended trade (up for a buy, down for a sell). If that move exceeds **T = 3.0 per cent**, the order is not placed that session. The decision is re-read at each following session; the order is placed on the first session on which the three-session move, now close-to-close, is at or below 3.0 per cent, and in any case on the **fifth session after the decision (K = 5)** if the move has not cooled by then. Whether to place the delayed order at market or at a limit is the owner's choice and is logged; whether to abandon the trade after the wait is the owner's choice and is logged as a drop. An order placed in breach of the rule is allowed and logged as an override with one line of reason; overrides count against adoption (section 9).

Why 3.0 per cent and five sessions. The 2026 fills followed a median three-session move of 3.8 per cent in the trade's direction against about 0.9 per cent on a random day; at 3.0 per cent the rule would have held back 56 per cent of them, and the exploratory counterfactual on those fills (a wait at most five sessions, mean 2.3) recovered about S$10,400 of the S$34,027, almost all on buys, with a 95 per cent cluster-bootstrap interval that includes zero at the 4 per cent threshold. The chased buys fell 2.2 per cent on average over the following five sessions, which is the mechanism the delay captures; over sixty sessions the same names rose 13 per cent on average, carried by a few large winners, which is why the rule delays and never vetoes. These are SEEN-data design inputs, not evidence.

## 2. The decision log (the guard layer; without it the study cannot run)

`decisions.json` at the repository root, one row per intended trade at the moment of decision, written by `scripts/add_decision.js` (section 11), never by hand: `id`, `date` (session date of the decision on the name's own exchange), `t` (ticker as in `trades.json`), `a` (B or S), `q` (intended quantity), `px_decision` (the live price at the decision), `move3` (the three-session move in the trade direction, per cent, computed by the helper from the bake's last three closes and the live price), `state` (`fired` if `move3` exceeds T, else `clear`), `outcome` (`filled` with the `trades.json` row's date and price; `dropped`; or `override` with a reason), `wait_sessions` (sessions from decision to fill), `ref` (carried into the fill's `ref` field). Guard: `validate_ledger.js` refuses any `trades.json` row dated on or after the adoption date that has no matching decision row on ticker and side within the preceding six sessions, so a fill cannot enter the ledger outside the log. A fill that reaches the ledger with no decision row (the guard overridden) is excluded from every cell and counted in the record.

## 3. Data and statistics

Post-adoption fills from `trades.json`, scored exactly as the filed study scores them: `reviews/2026-10-03_fill-timing/fill_timing.py` with its `prereg_spec.json` unchanged except for a `--since <adoption date>` filter and the decision-level cells of section 4 (the engine amendment is built before adoption, section 11, and its hash recorded here as amendment (b)). Unit ticker × session × side; seven-session window, dividend-rebased; adverse rank u, 1 the worst price for the side; the blocked placebo null, 10,000 sets, one offset per cluster, seed 20261003; the same exclusions, alignment rule and bar-defect rules; the same bars extract discipline (a committed extract with its hash at each read). Decision-level statistics from `decisions.json` joined to the fills.

## 4. Hypotheses and floors

- **H1 (the cure; verdict-bearing).** Post-adoption fills are not adversely placed at the registered size: the mean u of post-adoption fills does not exceed the placebo mean by δ = 0.06 or more (the filed study's floor, 82 bps at its median window). Read as the filed study reads it: one-sided p in the adverse direction from the blocked null; p > 0.05 at power at least 0.80 reads CURED-AT-SIZE, p ≤ 0.05 with effect ≥ 0.06 reads NOT CURED, p ≤ 0.05 with effect below 0.06 reads IMPROVED-BELOW-SIZE.
- **D1 (descriptive, never verdict-bearing).** The post-adoption mean u beside the 2026 before-set's 0.639, with the difference and its cluster-bootstrap interval; the before-set is SEEN and the threshold was chosen on it, so this comparison describes and does not test.
- **S1 (the economics of the wait; floored secondary).** On fired decisions that were later filled, the wait saving is side × (price at decision − fill price) × quantity at fill-date FX, summed and in per cent of the decisions' notional; the null is zero drift, with a placebo-wait comparator (the same wait applied from a random session in the name's prior sixty). Floor: a mean saving of 0.5 per cent of notional per fired decision. The per-decision noise in these names (a sd near 6 per cent over a two- to three-session wait) means S1 is underpowered at every read point below several hundred fired decisions; it is reported with its interval and demoted by the power rule, never carrying the verdict.
- **S2 (the forgone moves; descriptive).** On dropped decisions, the move from the decision price to the close twenty sessions later in the trade's direction, the return the owner did not take; on fired decisions filled late, the move during the wait. Reported in S$ and per cent, so the delay's cost is visible beside its saving.
- **S3 (adoption; a gate, not a hypothesis).** The share of post-adoption fills that are overrides or have no decision row. Above 20 per cent the rule is NOT ADOPTED and no verdict is read (section 9).
- **S4 (fired against clear; descriptive).** Mean u of fills whose decision fired against those whose decision was clear, with the placebo for each; separates the rule's own effect from any general change in the owner's timing.

## 5. Null, power, read points

The null is the filed study's: for each post-adoption fill, the same trade on a random session four to sixty bars either side at a uniform intraday price, one offset per cluster per set, 10,000 sets. Design power for H1 is taken from the filed study's null sd of 0.0212 at 151 fills in 47 clusters, scaled by the square root of 151 over n on the assumption that the clustering ratio holds (approximate; the run computes the real figure and the demotion rule binds on it):

| Post-adoption fills n | Null sd of the mean (design) | Power at δ = 0.06 | Role |
|---|---|---|---|
| 75 | 0.030 | 0.64 | interim read, descriptive only, demoted by the power rule |
| 100 | 0.026 | 0.75 | not a read point |
| **150** | **0.021** | **0.88** | **verdict read** |
| 200 | 0.018 | 0.95 | second read if the first is demoted or THIN |

At the 2026 rate of about 200 complete fills a year, 150 post-adoption fills accrue in about nine months. The reads are by accrual, not by date: the interim at 75 complete post-adoption fills, the verdict at 150, each run once, on Opus from a written run prompt, the verdict read on Fable from the declared cells only. Thinness and the (THIN) suffix as in the filed study. A clause below 0.80 power at its floor is demoted: a demoted H1 pass reads SUGGESTIVE-CURE and a demoted fail UNRESOLVED, neither carrying a verdict.

## 6. Verdict mapping (H1 only; S1 to S4 ride as disclosures)

| Verdict | Condition at the verdict read |
|---|---|
| CURED-AT-SIZE | H1 p > 0.05, power ≥ 0.80, S3 adoption gate passed |
| IMPROVED-BELOW-SIZE | H1 p ≤ 0.05 and effect below 0.06, powered |
| NOT CURED | H1 p ≤ 0.05 and effect at or above 0.06, powered |
| SUGGESTIVE-CURE / UNRESOLVED | H1 demoted by power, pass / fail |
| NOT ADOPTED | S3 above 20 per cent, or fewer than 150 post-adoption fills by 2027-12-31 with the owner declining a demoted read |
| INFEASIBLE | the decision log cannot be reconciled to the ledger at the read |

## 7. Consequences, fixed now, and prohibited claims

CURED-AT-SIZE: the rule stays, as a standing operator rule in `CLAUDE.md`'s trade-entry workflow, with the decision log kept as the record; no further registration. IMPROVED-BELOW-SIZE: the rule stays and a successor registration may test a tighter threshold or a limit-order rule, on fills after its own adoption. NOT CURED: the rule is retired, and the attribution question (is the cost in the trigger rather than the wait) goes to a new design. NOT ADOPTED: nothing is concluded about the rule; the owner decides whether to re-adopt with the guard enforced. In every case the S$ figures of S1 and S2 are descriptive and the owner weighs them.

Prohibited whatever the result: that the 2026 fills "confirm" or "refute" the rule (they chose its threshold); that a CURED verdict attributes the cure to the rule alone (S4 is the only within-rule evidence and is descriptive); that S1's S$ saving is realised profit; that the rule says anything about which names to trade or when a move will continue; that a demoted clause decided anything; that the rule applies to the systematic books (breadth-thrust-etf and the labs trade on their own registered calendars and are out of scope).

## 8. Predictions, registered so they can be wrong

- P1 (55 per cent): at the 150-fill read H1 reads CURED-AT-SIZE, with the post-adoption mean u between 0.52 and 0.56.
- P2 (60 per cent): S1's wait saving is positive in sign and its interval includes zero.
- P3 (70 per cent): overrides are below 10 per cent of post-adoption fills.
- P4 (60 per cent): fills whose decision was clear (S4) show a mean u within 0.03 of the placebo, so the rule's own sessions are where the adverse placement lived.

## 9. Stop and gate conditions after adoption

A `trades.json` row after the adoption date with no decision row is excluded and counted; above 20 per cent of fills in that state or in override, NOT ADOPTED. A read before 75 complete post-adoption fills is not a read. A changed engine hash, spec hash or extract hash at a read is a stop, as in the filed study. If the owner changes the threshold or the wait after adoption, the registration is void from that date and a new one is filed.

## 10. Ledger check

Run 2026-10-03 as part of the filed study (ADJACENT: entry-point-lab PREREG-1, stock-radar BT1/BT2, the WS12/WS13 execution-timing records, the commission rate card). Nothing in the vault tests a discretionary cooling-off rule; the nearest is stock-radar's S2 six-up-days veto on a mechanical book (`2026-09-03-stock-radar-6`, no effect), a veto rather than a delay and on single-stock momentum entries rather than the owner's fills.

## 11. Build before adoption (a separate session, Opus-tier, reviewable; nothing here runs unattended)

1. `scripts/add_decision.js`: writes a `decisions.json` row from the command line, computing `move3` from the last three closes in `docs/data/history.json` plus the live price, and printing `fired` or `clear` with the earliest session the order may be placed; refuses a row without a `ref`.
2. `scripts/validate_ledger.js`: the post-adoption guard of section 2, and a reconciliation report (decisions without fills, fills without decisions, overrides).
3. `fill_timing.py`: a `--since` filter and the S1, S2, S4 cells, with the parity and stop checks extended to `decisions.json`'s hash; recorded here as amendment (b) with the engine hash.
4. `CLAUDE.md` trade-entry workflow: the decision step before `add_trade.js`, and the rule in one sentence.
5. A monthly line in the statement-reconciliation recipe: run the engine on post-adoption fills and note n, the mean u and the placebo mean in `HANDOVER.md`, so the accrual is visible between reads.

## 12. Owner decisions open at registration

The threshold (3.0 per cent proposed; 4.0 per cent is the sensitivity and would hold back about half the 2026 fills instead of 56 per cent), the maximum wait (five sessions proposed), whether the delayed order defaults to a limit at the decision-day close, and the adoption date. Each is recorded as an amendment with its date when ruled; none may change after adoption.

## Amendments

- (a) Adoption date: pending.
- (b) Engine amendment hash: pending (built before adoption).
