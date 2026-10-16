"""Exploratory look (SEEN 2026 fills): is the cooling-off trigger better stated in
volatility units than in per cent? Reads the frozen study outputs only."""
import json, math, sys
from pathlib import Path
import numpy as np

HERE = Path(r"C:\dev\Portfolio-Command-Centre\reviews\2026-10-03_fill-timing")
sys.path.insert(0, str(HERE))
import fill_timing as FT

spec = json.load(open(HERE / "prereg_spec.json"))
R = json.load(open(HERE / "results/results.json"))
bars = json.load(open(HERE / "results/bars_used.json"))
bars.pop("_provenance", None)
book = json.load(open(HERE.parents[1] / "book.json"))
F = R["fills"]
blocks = np.array(R["blocks"])
assert len(blocks) == len(F) == 151

LOOK = 60      # trailing daily returns for volatility, ending the session before the fill
MINRET = 40
series = {}
rows = []
for n, f in enumerate(F):
    yf = f["yf"]
    if yf not in series:
        exch = (book.get("meta", {}).get(f["ticker"]) or {}).get("exchange")
        series[yf] = FT.Series(yf, bars[yf], FT.tz_for(yf, exch), spec)
    s = series[yf]
    import datetime as dt
    i = s.index_by_date[dt.date.fromisoformat(f["session_date"])]
    side = 1 if f["side_label"] == "B" else -1
    ac = s.ac
    # volatility from adjusted closes up to bar i-1 (known before the fill session)
    lo = max(1, i - LOOK)
    r = np.diff(np.log(ac[lo - 1:i]))
    r = r[~np.isnan(r)]
    sd1 = float(np.std(r, ddof=1)) if len(r) >= MINRET else float("nan")
    sig3 = sd1 * math.sqrt(3)
    # adjusted series rebased to bar i, so the fill price is comparable
    adj = ac / s.f[i]
    m_cc = side * (adj[i - 1] / adj[i - 4] - 1) if i >= 4 else float("nan")   # close-to-close, known at the prior close
    m_fill = f["pre"]
    m_close = side * (adj[i] / adj[i - 3] - 1)                                                         # c[i-3] to the fill price
    rows.append(dict(n=n, yf=yf, side=side, price=f["price"], u=f["u"], pre=m_fill, m_cc=m_cc, m_close=m_close,
                     sd1=sd1, sig3=sig3, notional=f["notional_sgd"], i=i, s=s, block=int(blocks[n])))

def fwd(row, h):
    s, i = row["s"], row["i"]
    if i + h >= len(s.c) or math.isnan(s.ac[i + h]):
        return float("nan")
    adj = s.ac / s.f[i]
    return row["side"] * (adj[i + h] / row["price"] - 1)   # positive = moved further in the trade's direction (adverse to waiting? no: continued)

def counterfactual(row, thr_fn, trig, K=5, conv="same"):
    """Saving in SGD of trading at the delayed close instead of the fill. thr_fn(row) gives the
    per cent threshold; trig is the trade-time move used to fire. conv 'same': re-read on the
    same-session close (the memo's convention)."""
    T = thr_fn(row)
    if not (trig > T):
        return None
    s, i, side = row["s"], row["i"], row["side"]
    adj = s.ac / s.f[i]
    for j in range(1, K + 1):
        if i + j >= len(adj) or math.isnan(adj[i + j]):
            return float("nan"), j
        mv = side * (adj[i + j] / adj[i + j - 3] - 1)
        if mv <= T or j == K:
            p = adj[i + j]
            return side * (row["price"] - p) / row["price"] * row["notional"], j
    return float("nan"), K

def run_cf(name, thr_fn, trig_key):
    res = []
    for r in rows:
        trig = r[trig_key]
        out = counterfactual(r, thr_fn, trig) if not math.isnan(thr_fn(r)) else None
        res.append(out)
    held = [(r, o) for r, o in zip(rows, res) if o is not None and not math.isnan(o[0])]
    sav = np.array([o[0] for _, o in held])
    buys = sum(o[0] for r, o in held if r["side"] > 0)
    sells = sum(o[0] for r, o in held if r["side"] < 0)
    # cluster bootstrap over blocks of the full set (non-held fills contribute zero)
    vec = np.zeros(len(rows))
    for (r, o) in held:
        vec[r["n"]] = o[0]
    ub = np.unique(blocks)
    rng = np.random.default_rng(20261014)
    tot = []
    for _ in range(4000):
        pick = rng.choice(ub, size=len(ub), replace=True)
        tot.append(sum(vec[blocks == b].sum() for b in pick))
    lo, hi = np.percentile(tot, [2.5, 97.5])
    print(f"{name:34s} held {len(held):3d} ({100*len(held)/151:4.0f}%)  total S${sav.sum():8,.0f}  buys {buys:8,.0f}  sells {sells:8,.0f}  "
          f"helped {100*np.mean(sav>0):3.0f}%  mean wait {np.mean([o[1] for _, o in held]):.1f}  CI [{lo:,.0f}, {hi:,.0f}]")
    return held

print("fills", len(rows), " vol missing", sum(math.isnan(r["sd1"]) for r in rows))
sig = np.array([r["sig3"] for r in rows])
print("three-session sd across fills: p10 %.1f%% median %.1f%% p90 %.1f%%" % tuple(100*np.nanpercentile(sig, [10, 50, 90])))
print()
print("Replication of the memo (target: 85 held, S$10,384; buys 8,662, sells 1,722)")
run_cf("T3 trigger=close-to-close prior", lambda r: 0.03, "m_cc")
run_cf("T3 trigger=to fill price", lambda r: 0.03, "pre")
run_cf("T3 trigger=close-to-close incl fill day", lambda r: 0.03, "m_close")
for T in (0.04,0.05):
    run_cf(f"T{int(T*100)} trigger=close fill day", lambda r,T=T: T, "m_close")

from scipy.stats import spearmanr
ok = [r for r in rows if not math.isnan(r["sig3"])]
for r in ok: r["z"] = r["m_close"] / r["sig3"]
print("\nA. Does placement u sort on the raw move or the scaled move? (n=%d)" % len(ok))
u = np.array([r["u"] for r in ok]); raw = np.array([r["m_close"] for r in ok]); z = np.array([r["z"] for r in ok])
print("  Spearman u~raw %.3f   u~z %.3f" % (spearmanr(u, raw)[0], spearmanr(u, z)[0]))
for lab, x in (("raw", raw), ("z", z)):
    q = np.quantile(x, [1/3, 2/3]); g = np.digitize(x, q)
    print("  mean u by tercile of %-3s:" % lab, " ".join("%.3f" % u[g == k].mean() for k in range(3)))
# volatility terciles
sg = np.array([r["sig3"] for r in ok]); qv = np.quantile(sg, [1/3, 2/3]); vt = np.digitize(sg, qv)
for r, t in zip(ok, vt): r["vt"] = int(t)
print("  vol terciles (three-session sd) cut at %.1f%% / %.1f%%" % (100*qv[0], 100*qv[1]))
for k in range(3):
    m = vt == k
    print("   tercile %d: n %d  mean u %.3f  median raw move %.1f%%  share raw>3%% %.0f%%  share z>1 %.0f%%" % (
        k, m.sum(), u[m].mean(), 100*np.median(raw[m]), 100*np.mean(raw[m] > .03), 100*np.mean(z[m] > 1)))

print("\nB. Five-session continuation after fills that fired at 3% (trade direction; negative = gave back)")
for side, nm in ((1, "buys"), (-1, "sells")):
    for k in range(3):
        sel = [r for r in ok if r["side"] == side and r["vt"] == k and r["m_close"] > .03]
        f5 = np.array([fwd(r, 5) for r in sel]); f5 = f5[~np.isnan(f5)]
        s5 = np.array([fwd(r, 5) / (r["sd1"] * math.sqrt(5)) for r in sel]); s5 = s5[~np.isnan(s5)]
        if len(f5):
            print("  %-5s vol tercile %d: n %2d  mean %+5.1f%%  median %+5.1f%%  in sd units %+.2f" % (nm, k, len(f5), 100*f5.mean(), 100*np.median(f5), s5.mean()))

print("\nC. Counterfactual, same convention as the memo (trigger and re-read on session closes, K 5)")
held3 = run_cf("fixed 3%", lambda r: 0.03, "m_close")
for k in range(3):
    s_ = sum(o[0] for r, o in held3 if not math.isnan(r["sig3"]) and r.get("vt") == k)
    n_ = sum(1 for r, o in held3 if not math.isnan(r["sig3"]) and r.get("vt") == k)
    print("    from vol tercile %d: %d held, S$" % (k, n_) + f"{s_:,.0f}")
for Z in (0.5, 0.6, 0.75, 1.0):
    run_cf(f"scaled {Z} x three-session sd", lambda r, Z=Z: Z * r["sig3"], "m_close")
for Z, fl in ((0.5, 0.02), (0.6, 0.02), (0.75, 0.02), (0.6, 0.03)):
    run_cf(f"scaled {Z} sd, floor {int(fl*100)}%", lambda r, Z=Z, fl=fl: max(fl, Z * r["sig3"]), "m_close")

print("\nD. Concentration: high-vol buys that fired at 3%")
sel = sorted([r for r in ok if r["side"] == 1 and r["vt"] == 2 and r["m_close"] > .03], key=lambda r: fwd(r, 5))
for r in sel:
    print("  %-10s %s  move %+5.1f%%  sd3 %4.1f%%  fwd5 %+6.1f%%" % (r["yf"], F[r["n"]]["session_date"], 100*r["m_close"], 100*r["sig3"], 100*fwd(r, 5)))
f5 = np.array([fwd(r, 5) for r in sel])
print("  mean ex the two worst %+.1f%%; ex the five worst %+.1f%%" % (100*np.sort(f5)[2:].mean(), 100*np.sort(f5)[5:].mean()))
held3 = [(r,o) for r,o in [(r, counterfactual(r, lambda r: 0.03, r["m_close"])) for r in ok] if o]
top = sorted(held3, key=lambda x: -x[1][0])[:5]
print("  top five savings at 3%:", ", ".join(f"{r['yf']} {F[r['n']]['session_date']} S${o[0]:,.0f}" for r,o in top), " sum", f"{sum(o[0] for r,o in top):,.0f}")
