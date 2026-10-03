#!/usr/bin/env python3
"""Charts for the fill-timing study, rendered from results/results.json and
results/coverage.json. Kept apart from fill_timing.py so that a change to a
title never changes the engine hash the registered run is bound to.

Archetype: argument. Figure 1 carries the verdict; figures 2 to 4 are the
supporting exhibits. Every figure prints its as-at line and source."""
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

HERE = Path(__file__).resolve().parent
RESULTS_DIR = HERE / "results"
CHART_DIR = HERE / "charts"
NAVY, RED, TEAL, GREY = "#1e3a8a", "#dc2626", "#0891b2", "#6b7280"


def load(name):
    with open(RESULTS_DIR / name, encoding="utf-8") as fh:
        return json.load(fh)


def fmt_p(p):
    return "p < 0.001" if p < 0.001 else f"p = {p:.3f}"


def footer(fig, line1, line2):
    fig.text(0.01, 0.028, line1, fontsize=6.3, color=GREY)
    fig.text(0.01, 0.006, line2, fontsize=6.3, color=GREY)


def main():
    res, cov = load("results.json"), load("coverage.json")
    CHART_DIR.mkdir(exist_ok=True)
    first = min(f["session_date"] for f in res["fills"]); last = max(f["session_date"] for f in res["fills"])
    asof = f"Fills {first} to {last}; bars to {res['provenance']['history_last_session']}; n = {res['n']} fills in {cov['counts']['blocks']} clusters"
    H1 = res["H1"]; d1 = res["floors"]["H1_delta"]
    verdict_word = res["verdict"].split(";")[0].split(" (")[0]
    pw = fmt_p(H1["p_one_sided_worse"])
    if verdict_word == "REJECTED":
        finding = f"No adverse placement at the registered size: mean u {H1['actual']:.3f} against placebo {H1['null_mean']:.3f} ({pw})"
    elif verdict_word == "CONFIRMED":
        finding = f"Fills sit at the adverse end of their week: mean u {H1['actual']:.3f} against placebo {H1['null_mean']:.3f} ({pw})"
    elif verdict_word == "DETECTED-BELOW-FLOOR":
        finding = f"Adverse placement real but below the floor: mean u {H1['actual']:.3f} against placebo {H1['null_mean']:.3f} ({pw})"
    else:
        finding = f"Mean u {H1['actual']:.3f} against placebo {H1['null_mean']:.3f} ({pw}): {verdict_word}"

    # 1. the verdict chart: the blocked null distribution of the mean, the actual and the floor
    draws = np.array(res["distribution"]["null_mean_u_draws"])
    fig, ax = plt.subplots(figsize=(8, 3.9), dpi=150)
    ax.hist(draws, bins=50, color=GREY, alpha=0.85, label=f"{len(draws):,} placebo sets: mean u of {res['n']} same-side fills on random nearby sessions at random intraday prices")
    top = ax.get_ylim()[1]
    ax.axvline(H1["actual"], color=NAVY, lw=2.2)
    ax.text(H1["actual"], top * 0.95, f"  actual {H1['actual']:.3f}" if H1["actual"] <= H1["null_mean"] + d1 / 2 else f"actual {H1['actual']:.3f}  ",
            color=NAVY, fontsize=8.5, va="top", ha="left" if H1["actual"] <= H1["null_mean"] + d1 / 2 else "right")
    ax.axvline(H1["null_mean"] + d1, color=RED, ls="--", lw=1.4)
    ax.text(H1["null_mean"] + d1, top * 0.78, f"  floor {H1['null_mean'] + d1:.3f}\n  (placebo + {d1:.2f})", color=RED, fontsize=8, va="top")
    ax.set_xlabel("mean adverse rank u across the fills (1 = the worst price of the seven sessions for the side, 0 = the best)")
    ax.set_ylabel("placebo sets")
    ax.set_title(finding, fontsize=10)
    ax.legend(fontsize=7.5, frameon=False, loc="upper left"); ax.spines[["top", "right"]].set_visible(False)
    footer(fig, asof + ". Null: one placebo offset per cluster per set, seed 20261003, equal-weighted; one-sided p, adverse direction.",
           "Source: trades.json; Yahoo daily bars as baked for the dashboard on 2026-10-03 (unadjusted, windows rebased for dividends).")
    fig.tight_layout(rect=(0, 0.055, 1, 1)); fig.savefig(CHART_DIR / "fig1_verdict_null_mean_u.png"); plt.close(fig)

    # 2. every fill shown: strip of u by side over the placebo quantile bands
    rng_j = np.random.default_rng(7)
    fig, ax = plt.subplots(figsize=(8, 3.7), dpi=150)
    rows = [("buys", 1.0, [f["u"] for f in res["fills"] if f["side_label"] == "B"], res["distribution"]["placebo_pooled_quantiles_buys"]),
            ("sells", 0.0, [f["u"] for f in res["fills"] if f["side_label"] == "S"], res["distribution"]["placebo_pooled_quantiles_sells"])]
    for label, y, us, q in rows:
        ax.barh(y, q["95"] - q["5"], left=q["5"], height=0.62, color="#e5e7eb", zorder=1)
        ax.barh(y, q["75"] - q["25"], left=q["25"], height=0.62, color="#d1d5db", zorder=2)
        ax.plot([q["50"], q["50"]], [y - 0.31, y + 0.31], color="white", lw=2, zorder=3)
        jit = rng_j.uniform(-0.22, 0.22, len(us))
        ax.scatter(us, y + jit, s=16, color=NAVY, alpha=0.75, zorder=4, edgecolor="white", linewidth=0.4)
        ax.text(0.01, y + 0.42, f"{label}: n = {len(us)}, mean u {np.mean(us):.3f}", ha="left", va="center", fontsize=8.5, color=NAVY)
    ax.axvline(0.9, color=RED, ls=":", lw=1.2); ax.text(0.905, -0.5, "tail: u above 0.9", color=RED, fontsize=8, va="center")
    ax.set_xlim(-0.01, 1.01); ax.set_ylim(-0.6, 1.6); ax.set_yticks([])
    ax.set_xlabel("adverse rank u of each fill within its seven-session range (0 = best price available, 1 = worst)")
    tail_act = res["H2"]["actual"]; tail_null = res["H2"]["null_mean"]
    ax.set_title(f"One mark per fill: {tail_act * 100:.1f}% of fills within a tenth of the worst price, against {tail_null * 100:.1f}% under the placebo", fontsize=10)
    ax.spines[["top", "right", "left"]].set_visible(False)
    footer(fig, asof + ". Grey bands: placebo pooled 5th to 95th and 25th to 75th percentiles, white line the median.",
           "The placebo is the same trade, same side, on a random session 4 to 60 bars either side at a random intraday price.")
    fig.tight_layout(rect=(0, 0.055, 1, 1)); fig.savefig(CHART_DIR / "fig2_u_by_fill.png"); plt.close(fig)

    # 3. pre and post legs, actual against placebo, by side
    fig, ax = plt.subplots(figsize=(8, 4.3), dpi=150)
    keys = ["buys_pre_pct", "buys_post_pct", "sells_pre_pct", "sells_post_pct"]
    labels = ["buys: pre leg\n(bought after a rise)", "buys: post leg\n(fell after the buy)", "sells: pre leg\n(sold after a fall)", "sells: post leg\n(rose after the sale)"]
    a_vals = [res["S7"][k]["actual"] for k in keys]; n_vals = [res["S7"][k]["null_mean"] for k in keys]
    ci = [res["S7"][k]["effect_ci95_block_bootstrap"] for k in keys]
    xs = np.arange(4)
    ax.bar(xs - 0.18, a_vals, width=0.36, color=NAVY, label="actual fills")
    ax.bar(xs + 0.18, n_vals, width=0.36, color=GREY, alpha=0.85, label="placebo")
    for i, (a, c) in enumerate(zip(a_vals, ci)):
        ax.plot([xs[i] - 0.18, xs[i] - 0.18], [n_vals[i] + c[0], n_vals[i] + c[1]], color="black", lw=1)
    ax.axhline(0, color="black", lw=0.6)
    ax.set_xticks(xs); ax.set_xticklabels(labels, fontsize=8)
    ax.set_ylabel("adverse move, % of price (positive = against the owner)", fontsize=9)
    pre_p = res["S3_pre"]["p_one_sided_worse"]; post_p = res["S4"]["p_one_sided_worse_matched"]
    ax.set_title(f"The price ran before the fill ({fmt_p(pre_p)}); buys gave some back after it ({fmt_p(post_p)}, pre-matched placebo)", fontsize=10)
    ax.legend(fontsize=8, frameon=False); ax.spines[["top", "right"]].set_visible(False)
    footer(fig, asof + ". Pre: t-3 close to fill; post: fill to t+3 close; whiskers: 95% cluster-bootstrap interval.",
           "The post-leg p is against a pre-matched null drawn independently per fill (a reversal check, not the verdict comparator).")
    fig.tight_layout(rect=(0, 0.055, 1, 1)); fig.savefig(CHART_DIR / "fig3_pre_post_legs.png"); plt.close(fig)

    # 4. cost anchor: cumulative S$ against the null band
    pf = res["C1"]["per_fill"]
    cum = np.cumsum([p["cost_sgd"] for p in pf])
    fig, ax = plt.subplots(figsize=(8, 3.8), dpi=150)
    ax.plot(range(1, len(cum) + 1), cum, color=NAVY, lw=1.8, label="cumulative excess placement cost, S$ (actual u less placebo-median u, in price terms)")
    sd = res["C1"]["null_sd_sgd"]
    ax.axhspan(-1.96 * sd, 1.96 * sd, color="#dcfce7", label="within 1.96 sd of the placebo total (same within noise)")
    ax.axhline(0, color="black", lw=0.6)
    ax.set_xlabel("fills in date order"); ax.set_ylabel("S$")
    comm = res["C1"]["commission_measured_bps_one_way_sgd_terms"]
    ax.set_title(f"Excess placement S\\${res['C1']['excess_cost_sgd']:,.0f} on S\\${res['C1']['traded_notional_sgd']:,.0f} traded: {res['C1']['excess_cost_bps_of_notional']:.0f} bps, {res['C1']['excess_cost_bps_of_notional'] / comm:.1f}x one-way commission ({fmt_p(res['C1']['p_one_sided_worse'])})", fontsize=9.5)
    ax.legend(fontsize=7.5, frameon=False, loc="upper left"); ax.spines[["top", "right"]].set_visible(False)
    footer(fig, asof + ". SGD at fill-date FX; cost = (actual u less placebo-median u) x window range x quantity: a counterfactual placement, not realised P&L.",
           f"Commission measured from the ledger fees in SGD terms: {comm:.1f} bps one-way on these fills (rate card 21.8 bps USD, an unreviewed figure).")
    fig.tight_layout(rect=(0, 0.055, 1, 1)); fig.savefig(CHART_DIR / "fig4_cost_anchor.png"); plt.close(fig)
    print("charts written to", CHART_DIR, "- marks in fig 2:", sum(len(r[2]) for r in rows))


if __name__ == "__main__":
    main()
