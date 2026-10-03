#!/usr/bin/env python3
"""Fill-timing study engine. Portfolio Command Centre, registered 2026-10-03.

Question: do the owner's 2026 fills sit at the adverse end of the price range
of the seven sessions centred on the fill (three either side), beyond what a
random nearby session at a random intraday price would give?

Modes
  extract    write results/bars_used.json and results/fx_used.json from the
             live Pages artefacts, with provenance; nothing is recomputed.
  coverage   outcome-blind: eligibility, date-alignment convention, ex-dates,
             window widths, the blocked placebo null and the power at the
             floors. Never computes the actual statistic on any fill.
  run        the registered run, once, after the freeze. Refuses to start if
             the spec, the engine, the bars or the FX extract differ from the
             hashes the coverage record carries, if the fill count differs, or
             if any placebo or actual score is missing.

Charts are rendered by charts.py from results/results.json, so a change to a
chart title never changes the engine hash the run is bound to.

Dates: Python datetime, months 1-indexed. A bar's session date is the calendar
date of its timestamp in the exchange's own time zone, never the UTC date.
Prices: unadjusted o/h/l/c throughout; ac enters only through the adjustment
factor f = ac / c used to put the bars of one window on one dividend basis.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path
from statistics import NormalDist
from zoneinfo import ZoneInfo

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SPEC_PATH = HERE / "prereg_spec.json"
ENGINE_PATH = Path(__file__).resolve()
RESULTS_DIR = HERE / "results"
ND = NormalDist()

TZ_BY_EXCHANGE = {
    "ARCA": "America/New_York", "BATS": "America/New_York", "NMS": "America/New_York",
    "NYS": "America/New_York", "NYQ": "America/New_York", "NGM": "America/New_York",
    "ASX": "Australia/Sydney", "HKG": "Asia/Hong_Kong", "LSE": "Europe/London",
    "PAR": "Europe/Paris", "SGX": "Asia/Singapore", "TSE": "Asia/Tokyo", "XETR": "Europe/Berlin",
}
TZ_BY_SUFFIX = {
    ".SI": "Asia/Singapore", ".HK": "Asia/Hong_Kong", ".T": "Asia/Tokyo", ".AX": "Australia/Sydney",
    ".L": "Europe/London", ".PA": "Europe/Paris", ".DE": "Europe/Berlin",
}
FX_PAIR = {"USD": "USDSGD=X", "HKD": "HKDSGD=X", "EUR": "EURSGD=X", "JPY": "JPYSGD=X", "AUD": "AUDSGD=X"}
# which market a Yahoo symbol's suffix denotes, and which market a book exchange code belongs to
SUFFIX_EXCHANGE = {".SI": "SGX", ".HK": "HKG", ".T": "TSE", ".AX": "ASX", ".L": "LSE", ".PA": "PAR", ".DE": "XETR"}
EXCHANGE_GROUP = {"ARCA": "US", "BATS": "US", "NMS": "US", "NYS": "US", "NYQ": "US", "NGM": "US",
                  "SGX": "SGX", "HKG": "HKG", "TSE": "TSE", "ASX": "ASX", "LSE": "LSE", "PAR": "PAR", "XETR": "XETR"}


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_json(path: Path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def stop(msg: str):
    sys.exit("STOP: " + msg)


# ----------------------------------------------------------------------------
# Bars
# ----------------------------------------------------------------------------
class Series:
    """One symbol's daily bars with session dates, defect flags, range repair
    and the dividend adjustment factor."""

    def __init__(self, yf: str, entry: dict, tz: str, spec: dict):
        bars = entry["history"]
        self.yf = yf
        self.tz = tz
        self.name = entry.get("name")
        zone = ZoneInfo(tz)
        self.dates = [dt.datetime.fromtimestamp(b["d"], dt.timezone.utc).astimezone(zone).date() for b in bars]
        self.utc_hours = Counter(dt.datetime.fromtimestamp(b["d"], dt.timezone.utc).strftime("%H:%M") for b in bars[-60:])
        n = len(bars)
        get = lambda key: np.array([b.get(key) if b.get(key) is not None else np.nan for b in bars], dtype=float)
        self.o, self.h, self.l, self.c, self.ac = get("o"), get("h"), get("l"), get("c"), get("ac")
        self.prov = np.array([bool(b.get("p")) for b in bars])
        with np.errstate(invalid="ignore", divide="ignore"):
            self.f = self.ac / self.c          # a provisional bar hard-sets ac = c, so f = 1 there
        self.bad = np.zeros(n, dtype=bool)
        self.bad_reason = [""] * n
        self.range_repaired = np.zeros(n, dtype=bool)
        defects = spec["bar_defects"]
        jump = defects["bad_print_relative_jump"]
        explicit = {(e["yf"], e["date"]) for e in defects["explicit_exclusions"]}
        last_good_c = float("nan")               # the jump test compares against the last bar not already flagged
        for i in range(n):
            o, h, l, c, ac = self.o[i], self.h[i], self.l[i], self.c[i], self.ac[i]
            reason = ""
            if any(math.isnan(x) for x in (o, h, l, c, ac)):
                reason = "null field"
            elif (yf, self.dates[i].isoformat()) in explicit:
                reason = "explicit exclusion"
            elif h < l * (1 - 1e-9):
                reason = "high below low"
            elif o == h == l == c and not math.isnan(last_good_c) and c == last_good_c:
                reason = "fabricated bar"
            elif (not math.isnan(last_good_c) and last_good_c > 0 and abs(c / last_good_c - 1) > jump
                  and i + 1 < n and not math.isnan(self.c[i + 1]) and abs(self.c[i + 1] / last_good_c - 1) <= jump / 2):
                # a one-bar spike that the next bar reverts: a print, not a move (3010.HK 2025-10-24 pattern)
                reason = "bad print (jump and revert)"
            if reason:
                self.bad[i] = True
                self.bad_reason[i] = reason
                continue
            # a session's range must contain its own open and close; Yahoo's London lines
            # print highs below the open, so the range is widened to the prints it reports
            hh, ll = max(h, o, c), min(l, o, c)
            if hh != h or ll != l:
                self.range_repaired[i] = True
                self.h[i], self.l[i] = hh, ll
            last_good_c = c
        # ex-date flags: a relative change in f between consecutive finalised, good bars
        tol = spec["dividend_handling"]["ex_date_tolerance_relative_change_in_f"]
        self.ex = np.zeros(n, dtype=bool)
        self.ex_size = np.zeros(n, dtype=float)  # implied distribution as a share of the prior close
        for i in range(1, n):
            if self.prov[i] or self.prov[i - 1] or self.bad[i] or self.bad[i - 1]:
                continue
            f0, f1 = self.f[i - 1], self.f[i]
            if math.isnan(f0) or math.isnan(f1) or f0 <= 0:
                continue
            rel = f1 / f0 - 1
            if abs(rel) > tol:
                self.ex[i] = True
                self.ex_size[i] = 1 - f0 / f1   # f0 = f1 (1 - D / c_{i-1})
        self.index_by_date = {d: i for i, d in enumerate(self.dates)}
        # clean-window mask for every centre index, for the window half-width k
        k = spec["window_sessions_each_side"]
        flag = self.bad | self.prov
        self.clean_centre = np.zeros(n, dtype=bool)
        for i in range(k, n - k):
            self.clean_centre[i] = not flag[i - k:i + k + 1].any()

    def clean_window(self, i: int, k: int) -> bool:
        return 0 <= i < len(self.dates) and bool(self.clean_centre[i])

    def window(self, i: int, k: int):
        """Bars i-k..i+k rebased to bar i's adjustment factor."""
        sl = slice(i - k, i + k + 1)
        scale = self.f[sl] / self.f[i]
        return self.o[sl] * scale, self.h[sl] * scale, self.l[sl] * scale, self.c[sl] * scale

    def ex_in_window(self, i: int, k: int) -> bool:
        # an ex-date at bar j shifts the basis between j-1 and j; bars i-k..i+k
        # are affected by flags at j in i-k+1..i+k
        return bool(self.ex[i - k + 1:i + k + 1].any())


# ----------------------------------------------------------------------------
# Metric
# ----------------------------------------------------------------------------
def adverse_rank(price: float, side: int, H: float, L: float) -> float:
    """u in [0, 1]; 1 is the worst possible placement for the side. NaN in, NaN out."""
    if any(math.isnan(x) for x in (price, H, L)) or H <= L:
        return float("nan")
    u = (price - L) / (H - L) if side > 0 else (H - price) / (H - L)
    return min(1.0, max(0.0, u))


def score(price: float, side: int, o, h, l, c, k: int) -> dict:
    """Score one fill at `price` on the centre bar of a 2k+1 window."""
    H, L = float(np.max(h)), float(np.min(l))
    u = adverse_rank(price, side, H, L)
    neighbours = np.concatenate([c[:k], c[k + 1:]])
    worse6 = bool(price > neighbours.max()) if side > 0 else bool(price < neighbours.min())
    pre = side * (price / c[0] - 1)            # positive: bought after a rise, sold after a fall
    post = -side * (c[-1] / price - 1)         # positive: fell after a buy, rose after a sell
    u_close = adverse_rank(c[k], side, H, L)
    return {"u": u, "worse6": worse6, "pre": pre, "post": post, "u_close": u_close, "H": H, "L": L}


def score_many(s: Series, j: np.ndarray, unif: np.ndarray, side: int, k: int) -> dict:
    """Vectorised placebo scoring: one placebo per element of j, priced at
    l_j + unif (h_j - l_j) on the placebo session's own basis, the window
    rebased to bar j. Same arithmetic as score()."""
    idx = j[:, None] + np.arange(-k, k + 1)[None, :]
    scale = s.f[idx] / s.f[j][:, None]
    h = s.h[idx] * scale; l = s.l[idx] * scale; c = s.c[idx] * scale
    H = h.max(axis=1); L = l.min(axis=1)
    price = s.l[j] + unif * (s.h[j] - s.l[j])
    u = (price - L) / (H - L) if side > 0 else (H - price) / (H - L)
    u = np.clip(u, 0.0, 1.0)
    nb = np.delete(c, k, axis=1)
    worse6 = (price > nb.max(axis=1)) if side > 0 else (price < nb.min(axis=1))
    pre = side * (price / c[:, 0] - 1)
    post = -side * (c[:, -1] / price - 1)
    uc = (c[:, k] - L) / (H - L) if side > 0 else (H - c[:, k]) / (H - L)
    uc = np.clip(uc, 0.0, 1.0)
    ex = np.array([s.ex_in_window(int(x), k) for x in j])
    return {"u": u, "worse6": worse6.astype(float), "pre": pre, "post": post, "u_close": uc, "H": H, "L": L, "price": price, "ex": ex.astype(float)}


# ----------------------------------------------------------------------------
# Inputs
# ----------------------------------------------------------------------------
def tz_for(yf: str, exchange: str | None) -> str:
    if exchange in TZ_BY_EXCHANGE:
        return TZ_BY_EXCHANGE[exchange]
    for suf, tz in TZ_BY_SUFFIX.items():
        if yf.endswith(suf):
            return tz
    return "America/New_York"


def fx_lookup(fx: dict):
    """(ccy, date) -> SGD per unit, using the latest FX day at or before the
    date. Yahoo stamps an FX day at about 23:00 UTC of the previous calendar
    day, so the FX date is taken two hours after the stamp."""
    tables = {}
    for ccy, pair in FX_PAIR.items():
        entry = fx.get(pair)
        if not entry:
            continue
        rows = []
        for b in entry["history"]:
            d = (dt.datetime.fromtimestamp(b["d"], dt.timezone.utc) + dt.timedelta(hours=2)).date()
            if b.get("c") is not None:
                rows.append((d, float(b["c"])))
        rows.sort()
        tables[ccy] = rows

    def get(ccy: str, date: dt.date):
        if ccy == "SGD":
            return 1.0, "SGD"
        rows = tables.get(ccy)
        if not rows:
            return None, "no FX series"
        best = None
        for d, v in rows:
            if d <= date:
                best = (d, v)
            else:
                break
        if best is None:
            return None, "FX series starts after the fill"
        return best[1], best[0].isoformat()

    return get


def load_fills(spec: dict, trades: list, book: dict, history: dict) -> tuple[list, list]:
    """Aggregate rows to ticker x date x side units and apply the feed and type
    exclusions. Returns (units, excluded)."""
    meta = book["meta"]
    meta_by_yf = {m["yf"]: dict(m, ticker=t) for t, m in meta.items() if m.get("yf")}
    noquote = {m["yf"] for m in meta.values() if m.get("noQuote") and m.get("yf")}
    groups = defaultdict(list)
    for r in trades:
        groups[(r.get("yf"), r["d"], r["a"])].append(r)
    units, excluded = [], []
    for (yf, d, a), rows in sorted(groups.items(), key=lambda kv: (kv[0][1], str(kv[0][0]), kv[0][2])):
        q = sum(r["q"] for r in rows)
        vwap = sum(r["q"] * r["p"] for r in rows) / q
        fees = [r.get("fee") for r in rows]
        fee = sum(f for f in fees if f is not None) if any(f is not None for f in fees) else None
        unit = {
            "yf": yf, "ticker": rows[0]["t"], "date": d, "side": 1 if a == "B" else -1, "side_label": a,
            "qty": q, "price": vwap, "ccy": rows[0]["ccy"], "theme": rows[0].get("th"), "rows": len(rows),
            "fee": fee, "ref": any(bool(r.get("ref")) for r in rows),
        }
        # the book is keyed by the trade's own ticker (GDX.US and GDX.GB share one feed symbol)
        m = meta.get(rows[0]["t"]) or (meta_by_yf.get(yf) if yf else None)
        if not yf:
            excluded.append(dict(unit, reason="no feed symbol"))
            continue
        if yf not in history:
            excluded.append(dict(unit, reason="symbol absent from history.json"))
            continue
        if m and m.get("type") in ("Bond", "Cash"):
            excluded.append(dict(unit, reason=f"book type {m['type']}"))
            continue
        if yf in noquote:
            excluded.append(dict(unit, reason="noQuote in book meta"))
            continue
        feed_exchange = next((ex for suf, ex in SUFFIX_EXCHANGE.items() if yf.endswith(suf)), "US")
        book_exchange = (m or {}).get("exchange")
        book_group = EXCHANGE_GROUP.get(book_exchange) if book_exchange else None
        if book_group and book_group != feed_exchange:
            excluded.append(dict(unit, reason=f"proxy feed: book exchange {book_exchange}, feed symbol {yf}"))
            continue
        unit["name"] = (m or {}).get("name") or history[yf].get("name")
        unit["exchange"] = book_exchange
        units.append(unit)
    return units, excluded


def align(units: list, series: dict, spec: dict) -> tuple[list, list, dict]:
    """Place each fill on a session of its own exchange and check the price
    against that session's range. Mechanical rule from the spec."""
    tol = spec["alignment"]["own_range_tolerance_relative"]
    kept, dropped = [], []
    tally = Counter()

    def inside(s: Series, i: int, p: float) -> bool:
        return (s.l[i] * (1 - tol) <= p <= s.h[i] * (1 + tol)) and not s.bad[i] and not s.prov[i]

    for u in units:
        s = series[u["yf"]]
        d = dt.date.fromisoformat(u["date"])
        p = u["price"]
        i = s.index_by_date.get(d)
        u["dated_session_exists"] = i is not None
        if i is None:
            prev = [j for j, sd in enumerate(s.dates) if sd < d]
            cand_prev = prev[-1] if prev else None
            nxt = [j for j, sd in enumerate(s.dates) if sd > d]
            cand_next = nxt[0] if nxt else None
            if cand_prev is not None and inside(s, cand_prev, p):
                u["session_index"], u["alignment"] = cand_prev, "non-session date; previous session holds the price"
            elif cand_next is not None and inside(s, cand_next, p):
                u["session_index"], u["alignment"] = cand_next, "non-session date; next session holds the price"
            else:
                u["alignment"] = "non-session date; no adjacent session holds the price"
                tally[u["alignment"]] += 1
                dropped.append(dict(u, reason="alignment: " + u["alignment"]))
                continue
        elif s.prov[i]:
            u["session_index"], u["alignment"] = i, "dated session is a provisional bar (not finalised)"
        else:
            own = inside(s, i, p)
            prev_ok = i - 1 >= 0 and inside(s, i - 1, p)
            next_ok = i + 1 < len(s.dates) and inside(s, i + 1, p)
            u["inside_own_range"] = own
            u["inside_prev_range"] = prev_ok
            u["inside_next_range"] = next_ok
            if own:
                u["session_index"], u["alignment"] = i, "inside own session range"
            elif prev_ok:
                u["session_index"], u["alignment"] = i - 1, "outside own range; previous session holds the price (re-dated)"
            elif next_ok:
                u["session_index"], u["alignment"] = i + 1, "outside own range; next session holds the price (re-dated)"
            else:
                u["alignment"] = "outside own range; no adjacent session holds the price"
                tally[u["alignment"]] += 1
                dropped.append(dict(u, reason="alignment: " + u["alignment"]))
                continue
        tally[u["alignment"]] += 1
        u["session_date"] = s.dates[u["session_index"]].isoformat()
        kept.append(u)
    return kept, dropped, dict(tally)


def complete_windows(units: list, series: dict, spec: dict) -> tuple[list, list]:
    k = spec["window_sessions_each_side"]
    kept, dropped = [], []
    for u in units:
        s = series[u["yf"]]
        i = u["session_index"]
        if not s.clean_window(i, k):
            lo, hi = i - k, i + k
            why = "edge of history" if (lo < 0 or hi >= len(s.dates)) else (
                "provisional bar in window" if s.prov[max(0, lo):hi + 1].any() else "defective bar in window")
            dropped.append(dict(u, reason="incomplete window: " + why))
            continue
        u["ex_in_window"] = s.ex_in_window(i, k)
        if u["ex_in_window"]:
            js = [j for j in range(i - k + 1, i + k + 1) if s.ex[j]]
            u["ex_dates"] = [{"date": s.dates[j].isoformat(), "implied_distribution_share": round(float(s.ex_size[j]), 6)} for j in js]
        kept.append(u)
    return kept, dropped


def placebo_offsets(s: Series, i: int, spec: dict) -> np.ndarray:
    k = spec["window_sessions_each_side"]
    lo, hi = spec["placebo"]["offset_min_sessions"], spec["placebo"]["offset_max_sessions"]
    offs = [o for o in list(range(-hi, -lo + 1)) + list(range(lo, hi + 1)) if s.clean_window(i + o, k)]
    return np.array(offs, dtype=int)


def make_blocks(fills: list, k: int) -> np.ndarray:
    """Cluster id per fill: fills on one session date share a block, and so do
    fills on one name whose seven-session windows overlap (centres within 2k
    bars). Union-find over both relations."""
    n = len(fills)
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    by_date = defaultdict(list)
    for r, f in enumerate(fills):
        by_date[f["session_date"]].append(r)
    for rs in by_date.values():
        for r in rs[1:]:
            union(rs[0], r)
    by_sym = defaultdict(list)
    for r, f in enumerate(fills):
        by_sym[f["yf"]].append(r)
    for rs in by_sym.values():
        for a in rs:
            for b in rs:
                if a < b and abs(fills[a]["session_index"] - fills[b]["session_index"]) <= 2 * k:
                    union(a, b)
    roots = [find(r) for r in range(n)]
    ids = {root: i for i, root in enumerate(sorted(set(roots)))}
    return np.array([ids[r] for r in roots], dtype=int)


# ----------------------------------------------------------------------------
# Build
# ----------------------------------------------------------------------------
def build(spec: dict, args) -> dict:
    trades = load_json(ROOT / "trades.json")
    book = load_json(ROOT / "book.json")
    history_path, fx_path = Path(args.history), Path(args.fx)
    history = load_json(history_path)
    extract_provenance = history.pop("_provenance", None)
    fx = load_json(fx_path)
    fx_provenance = fx.pop("_provenance", None)
    units, excluded = load_fills(spec, trades, book, history)
    series = {}
    for u in units:
        if u["yf"] not in series:
            series[u["yf"]] = Series(u["yf"], history[u["yf"]], tz_for(u["yf"], u.get("exchange")), spec)
    aligned, drop_align, align_tally = align(units, series, spec)
    complete, drop_window = complete_windows(aligned, series, spec)
    get_fx = fx_lookup(fx)
    for u in complete:
        rate, src = get_fx(u["ccy"], dt.date.fromisoformat(u["session_date"]))
        u["fx_sgd"], u["fx_source_date"] = rate, src
        u["notional_sgd"] = u["qty"] * u["price"] * rate if rate else None
    if any(u["notional_sgd"] is None for u in complete):
        stop("a complete fill has no FX rate")
    k = spec["window_sessions_each_side"]
    blocks = make_blocks(complete, k)
    last_bar = max(s.dates[-1] for s in series.values()).isoformat()
    provenance = {
        "trades_json_sha256": sha256_of(ROOT / "trades.json"),
        "book_json_sha256": sha256_of(ROOT / "book.json"),
        "history_json_path": str(history_path.relative_to(HERE)) if history_path.is_relative_to(HERE) else str(history_path),
        "history_json_sha256": sha256_of(history_path),
        "history_extract_provenance": extract_provenance,
        "history_last_session": last_bar,
        "fx_json_path": str(fx_path.relative_to(HERE)) if fx_path.is_relative_to(HERE) else str(fx_path),
        "fx_json_sha256": sha256_of(fx_path),
        "fx_extract_provenance": fx_provenance,
        "spec_sha256": sha256_of(SPEC_PATH),
        "engine_sha256": sha256_of(ENGINE_PATH),
        "rows_in_trades_json": len(trades),
    }
    return {
        "spec": spec, "trades": trades, "book": book, "series": series, "units": units, "excluded": excluded,
        "aligned": aligned, "drop_align": drop_align, "align_tally": align_tally, "complete": complete,
        "drop_window": drop_window, "get_fx": get_fx, "provenance": provenance, "blocks": blocks,
    }


def simulate_placebo(ctx: dict, rng: np.random.Generator, draws: int, blocked: bool) -> dict:
    """Draw `draws` placebo sessions and prices for every complete fill and
    score them. Blocked: every fill in a cluster takes the same offset in each
    draw, from the offsets eligible for every member, so fills that share a
    session date or overlapping windows keep their common market move under
    the null; the intraday uniform is independent per fill. Uses dates and
    sides only; the actual price enters nowhere here."""
    spec = ctx["spec"]
    k = spec["window_sessions_each_side"]
    fills = ctx["complete"]
    n = len(fills)
    keys = ("u", "worse6", "pre", "post", "u_close", "H", "L", "price", "ex")
    out = {key: np.full((n, draws), np.nan) for key in keys}
    offsets_count = np.zeros(n, dtype=int)
    one_sided = np.zeros(n, dtype=bool)
    fallback_blocks = 0
    blocks = ctx["blocks"] if blocked else np.arange(n)
    for b in sorted(set(blocks.tolist())):
        members = np.where(blocks == b)[0]
        per = []
        for r in members:
            s = ctx["series"][fills[r]["yf"]]
            offs = placebo_offsets(s, fills[r]["session_index"], spec)
            per.append(set(offs.tolist()))
            offsets_count[r] = len(offs)
            one_sided[r] = bool(len(offs) and (min(offs) > 0 or max(offs) < 0))
        common = set.intersection(*per) if per else set()
        if common and blocked and len(members) > 1:
            pick_block = rng.choice(np.array(sorted(common), dtype=int), size=draws, replace=True)
        else:
            if blocked and len(members) > 1:
                fallback_blocks += 1
            pick_block = None
        for r_idx, r in enumerate(members):
            s = ctx["series"][fills[r]["yf"]]
            i = fills[r]["session_index"]
            if pick_block is None:
                offs = np.array(sorted(per[r_idx]), dtype=int)
                if len(offs) == 0:
                    continue
                pick = rng.choice(offs, size=draws, replace=True)
            else:
                pick = pick_block
            unif = rng.random(draws)
            sc = score_many(s, i + pick, unif, fills[r]["side"], k)
            for key in keys:
                out[key][r, :] = sc[key]
    out["offsets_count"] = offsets_count
    out["one_sided"] = one_sided
    out["fallback_blocks"] = fallback_blocks
    out["blocked"] = blocked
    out["draws"] = draws
    return out


def power_normal(delta: float, sd_null: float, alpha: float) -> float:
    if sd_null <= 0:
        return float("nan")
    return ND.cdf(delta / sd_null - ND.inv_cdf(1 - alpha))


def mde(sd_null: float, alpha: float, power: float = 0.8) -> float:
    return sd_null * (ND.inv_cdf(1 - alpha) + ND.inv_cdf(power))


def n_for(sd_null: float, n: int, delta: float, alpha: float, power: float) -> int:
    """Approximate fill count for the given power at delta, scaling the null sd
    by 1/sqrt(n); assumes the clustering ratio holds as the ledger grows."""
    target_sd = delta / (ND.inv_cdf(1 - alpha) + ND.inv_cdf(power))
    return int(math.ceil(n * (sd_null / target_sd) ** 2))


# ----------------------------------------------------------------------------
# Coverage (outcome-blind)
# ----------------------------------------------------------------------------
def coverage(ctx: dict, placebo: dict, placebo_indep: dict) -> dict:
    spec = ctx["spec"]
    alpha = spec["alpha_one_sided"]
    fills = ctx["complete"]
    n = len(fills)
    if np.isnan(placebo["u"]).any():
        stop("a placebo matrix has a missing value")
    U = placebo["u"]
    means = U.mean(axis=0)
    tail = (U > spec["floors"]["tail_threshold_u"]).mean(axis=0)
    w = np.array([f["notional_sgd"] for f in fills])
    wmeans = (U * w[:, None]).sum(axis=0) / w.sum()
    sd_mean, sd_tail = float(means.std(ddof=1)), float(tail.std(ddof=1))
    Ui = placebo_indep["u"]
    means_i = Ui.mean(axis=0); tail_i = (Ui > spec["floors"]["tail_threshold_u"]).mean(axis=0)
    delta_u = spec["floors"]["H1_delta_mean_u"]
    mde_tail = mde(sd_tail, alpha)
    delta_tail = math.ceil(mde_tail * 100) / 100
    widths = []
    k = spec["window_sessions_each_side"]
    for f in fills:
        s = ctx["series"][f["yf"]]
        o, h, l, c = s.window(f["session_index"], k)
        widths.append((h.max() - l.min()) / c[k])
    widths = np.array(widths)
    by_side = Counter(f["side_label"] for f in fills)
    by_ccy = Counter(f["ccy"] for f in fills)
    by_sym = Counter(f["yf"] for f in fills)
    blocks = ctx["blocks"]
    block_sizes = Counter(Counter(blocks.tolist()).values())
    bad_bars = [{"yf": yf, "date": s.dates[i].isoformat(), "reason": s.bad_reason[i], "c": float(s.c[i])}
                for yf, s in ctx["series"].items() for i in np.where(s.bad)[0] if s.dates[i].year >= 2025]
    prov_bars = [{"yf": yf, "date": s.dates[i].isoformat()} for yf, s in ctx["series"].items() for i in np.where(s.prov)[0]]
    ex_2026 = [{"yf": yf, "date": s.dates[i].isoformat(), "implied_distribution_share": round(float(s.ex_size[i]), 5)}
               for yf, s in ctx["series"].items() for i in np.where(s.ex)[0] if s.dates[i].year == 2026]
    aligned_all = ctx["aligned"] + ctx["drop_align"]
    return {
        "registered": spec["registered"],
        "provenance": ctx["provenance"],
        "counts": {
            "rows": len(ctx["trades"]), "units": len(ctx["units"]) + len(ctx["excluded"]),
            "excluded_feed_or_type": len(ctx["excluded"]), "dropped_alignment": len(ctx["drop_align"]),
            "dropped_window": len(ctx["drop_window"]), "complete": n,
            "by_side": dict(by_side), "by_ccy": dict(by_ccy), "symbols": len(by_sym),
            "largest_symbol_shares": [{"yf": s, "fills": c} for s, c in by_sym.most_common(5)],
            "ex_date_in_window": int(sum(1 for f in fills if f.get("ex_in_window"))),
            "with_ref": int(sum(1 for f in fills if f.get("ref"))),
            "fee_recorded": int(sum(1 for f in fills if f.get("fee") is not None)),
            "session_dates": len(set(f["session_date"] for f in fills)),
            "blocks": int(blocks.max()) + 1, "block_size_distribution": {str(k_): v for k_, v in sorted(block_sizes.items())},
            "fills_sharing_a_date": int(sum(1 for f in fills if sum(1 for g in fills if g["session_date"] == f["session_date"]) > 1)),
            "sgd_notional": {"total": round(float(w.sum())), "buys": round(float(sum(f["notional_sgd"] for f in fills if f["side"] > 0))),
                             "sells": round(float(sum(f["notional_sgd"] for f in fills if f["side"] < 0)))},
        },
        "exclusions_feed_or_type": [{k_: e[k_] for k_ in ("ticker", "date", "side_label", "reason")} for e in ctx["excluded"]],
        "alignment": {
            "tally": ctx["align_tally"],
            "share_outside_own_range": round(sum(1 for u in aligned_all if u.get("dated_session_exists") and not u.get("inside_own_range", True)) / max(1, len(aligned_all)), 4),
            "decisive_inside_own_not_previous": int(sum(1 for u in ctx["aligned"] if u.get("inside_own_range") and not u.get("inside_prev_range"))),
            "inside_own_and_previous": int(sum(1 for u in ctx["aligned"] if u.get("inside_own_range") and u.get("inside_prev_range"))),
            "inside_own_and_next": int(sum(1 for u in ctx["aligned"] if u.get("inside_own_range") and u.get("inside_next_range"))),
            "decisive_inside_own_not_either_neighbour": int(sum(1 for u in ctx["aligned"] if u.get("inside_own_range") and not u.get("inside_prev_range") and not u.get("inside_next_range"))),
            "dated_on_non_session": [{k_: u[k_] for k_ in ("ticker", "date", "side_label", "alignment")} for u in aligned_all if not u.get("dated_session_exists")],
            "outside_own_range": [{k_: u.get(k_) for k_ in ("ticker", "date", "side_label", "price", "alignment")} for u in aligned_all if u.get("dated_session_exists") and not u.get("inside_own_range", True)],
            "dropped": [{k_: u[k_] for k_ in ("ticker", "date", "side_label", "price", "reason")} for u in ctx["drop_align"]],
        },
        "dropped_window": [{k_: u[k_] for k_ in ("ticker", "date", "side_label", "reason")} for u in ctx["drop_window"]],
        "ex_dates_in_windows": [{"ticker": f["ticker"], "date": f["session_date"], "side": f["side_label"], "ex": f["ex_dates"]} for f in fills if f.get("ex_in_window")],
        "ex_dates_2026_all_series": ex_2026,
        "defective_bars_2025_on": bad_bars,
        "provisional_bars": prov_bars,
        "range_repaired_bars_2026": [{"yf": yf, "date": s.dates[i].isoformat()} for yf, s in ctx["series"].items() for i in np.where(s.range_repaired)[0] if s.dates[i].year == 2026],
        "bar_timestamps_utc": {yf: s.utc_hours.most_common(2) for yf, s in ctx["series"].items()},
        "window_width": {
            "median_range_over_close": round(float(np.median(widths)), 4),
            "p25": round(float(np.percentile(widths, 25)), 4), "p75": round(float(np.percentile(widths, 75)), 4),
            "delta_in_bps_at_median_width": round(float(delta_u * np.median(widths) * 1e4), 1),
            "u_0_05_in_bps_at_median_width": round(float(0.05 * np.median(widths) * 1e4), 1),
        },
        "null": {
            "structure": "blocked: one offset per cluster per draw; intraday uniform independent per fill",
            "draws_per_fill": int(placebo["draws"]), "seed": spec["seed"],
            "blocks": int(blocks.max()) + 1, "fallback_blocks_without_a_common_offset": int(placebo["fallback_blocks"]),
            "placebo_offsets_per_fill_min": int(placebo["offsets_count"].min()), "median": int(np.median(placebo["offsets_count"])),
            "one_sided_pools": [{"ticker": fills[r]["ticker"], "date": fills[r]["session_date"]} for r in np.where(placebo["one_sided"])[0]],
            "mean_u": round(float(means.mean()), 4), "sd_mean_u": round(sd_mean, 4),
            "mean_u_weighted": round(float(wmeans.mean()), 4), "sd_mean_u_weighted": round(float(wmeans.std(ddof=1)), 4),
            "tail_share": round(float(tail.mean()), 4), "sd_tail_share": round(sd_tail, 4),
            "p95_mean_u": round(float(np.percentile(means, 95)), 4), "p95_tail_share": round(float(np.percentile(tail, 95)), 4),
            "worse6_share": round(float(np.nanmean(placebo["worse6"])), 4),
            "u_close_mean": round(float(np.nanmean(placebo["u_close"])), 4),
            "pre_mean_pct": round(float(np.nanmean(placebo["pre"]) * 100), 3),
            "post_mean_pct": round(float(np.nanmean(placebo["post"]) * 100), 3),
            "share_of_placebo_windows_with_ex_date": round(float(np.nanmean(placebo["ex"])), 4),
            "independent_null_for_comparison": {
                "draws_per_fill": int(placebo_indep["draws"]), "mean_u": round(float(means_i.mean()), 4), "sd_mean_u": round(float(means_i.std(ddof=1)), 4),
                "tail_share": round(float(tail_i.mean()), 4), "sd_tail_share": round(float(tail_i.std(ddof=1)), 4),
            },
        },
        "power": {
            "alpha_one_sided": alpha,
            "H1": {"delta": delta_u, "power_at_delta": round(power_normal(delta_u, sd_mean, alpha), 3),
                   "mde_at_0_80": round(mde(sd_mean, alpha), 4),
                   "power_at_0_05": round(power_normal(0.05, sd_mean, alpha), 3),
                   "power_at_0_02": round(power_normal(0.02, sd_mean, alpha), 3),
                   "power_at_delta_independent_null": round(power_normal(delta_u, float(means_i.std(ddof=1)), alpha), 3),
                   "power_at_0_05_independent_null": round(power_normal(0.05, float(means_i.std(ddof=1)), alpha), 3),
                   "n_for_power_0_90_at_delta": n_for(sd_mean, n, delta_u, alpha, 0.90),
                   "n_for_power_0_80_at_0_05": n_for(sd_mean, n, 0.05, alpha, 0.80),
                   "n_for_power_0_80_at_0_02": n_for(sd_mean, n, 0.02, alpha, 0.80)},
            "H2": {"mde_at_0_80": round(mde_tail, 4), "delta_fixed": delta_tail,
                   "power_at_delta_fixed": round(power_normal(delta_tail, sd_tail, alpha), 3),
                   "note": "the floor is the null's own minimum detectable effect rounded up, so power at the floor is at least 0.80 by construction and the demotion rule cannot fire on H2"},
        },
    }


# ----------------------------------------------------------------------------
# Run
# ----------------------------------------------------------------------------
def pvalue_ge(null: np.ndarray, actual: float) -> float:
    return float((np.sum(null >= actual) + 1) / (len(null) + 1))


def run(ctx: dict, placebo: dict, cov: dict, args) -> dict:
    spec = ctx["spec"]
    alpha = spec["alpha_one_sided"]
    k = spec["window_sessions_each_side"]
    fills = ctx["complete"]
    blocks = ctx["blocks"]
    n = len(fills)
    # registered stop conditions, mechanical
    for key in ("spec_sha256", "engine_sha256", "history_json_sha256", "fx_json_sha256", "trades_json_sha256", "book_json_sha256"):
        if cov["provenance"][key] != ctx["provenance"][key]:
            stop(f"{key} differs from the frozen coverage record")
    if n != cov["counts"]["complete"]:
        stop(f"fill count {n} differs from the frozen {cov['counts']['complete']}")
    for key in ("u", "worse6", "pre", "post", "u_close"):
        if np.isnan(placebo[key]).any():
            stop(f"placebo matrix {key} has a missing value")
    rng = np.random.default_rng(spec["seed"] + 1)
    # actual scores, with a parity check against the vectorised path
    for f in fills:
        s = ctx["series"][f["yf"]]
        i = f["session_index"]
        o, h, l, c = s.window(i, k)
        sc = score(f["price"], f["side"], o, h, l, c, k)
        unif = (f["price"] - s.l[i]) / (s.h[i] - s.l[i])
        vec = score_many(s, np.array([i]), np.array([unif]), f["side"], k)
        for key in ("u", "pre", "post", "u_close", "H", "L"):
            if abs(float(vec[key][0]) - float(sc[key])) > 1e-9:
                stop(f"parity failure on {key} for {f['ticker']} {f['session_date']}")
        f.update({key: (bool(sc[key]) if key == "worse6" else float(sc[key])) for key in sc})
        f["v_intraday"] = adverse_rank(f["price"], f["side"], float(s.h[i]), float(s.l[i]))
        if any(math.isnan(f[key]) for key in ("u", "pre", "post", "u_close", "v_intraday")):
            stop(f"actual score missing for {f['ticker']} {f['session_date']}")
    F = fills
    au = np.array([f["u"] for f in F]); aw6 = np.array([f["worse6"] for f in F], dtype=float)
    apre = np.array([f["pre"] for f in F]); apost = np.array([f["post"] for f in F])
    auc = np.array([f["u_close"] for f in F]); av = np.array([f["v_intraday"] for f in F])
    w = np.array([f["notional_sgd"] for f in F]); side = np.array([f["side"] for f in F])
    U = placebo["u"]; W6 = placebo["worse6"]; PRE = placebo["pre"]; POST = placebo["post"]; UC = placebo["u_close"]
    D = U.shape[1]
    block_ids = sorted(set(blocks.tolist()))
    members = {b: np.where(blocks == b)[0] for b in block_ids}

    def block_boot(idx_mask, draws):
        """Resample clusters with replacement among the fills in idx_mask."""
        bs = [b for b in block_ids if idx_mask[members[b]].any()]
        out = []
        for _ in range(draws):
            pick = rng.choice(bs, size=len(bs), replace=True)
            out.append(np.concatenate([members[b][idx_mask[members[b]]] for b in pick]))
        return out

    def cell(actual_vec, null_mat, mask=None, weights=None, label=""):
        mask = np.ones(len(actual_vec), dtype=bool) if mask is None else mask
        a_vec, nm_mat = actual_vec[mask], null_mat[mask]
        if weights is None:
            a = float(a_vec.mean()); nm = nm_mat.mean(axis=0)
        else:
            wv = weights[mask]
            a = float((a_vec * wv).sum() / wv.sum()); nm = (nm_mat * wv[:, None]).sum(axis=0) / wv.sum()
        boots = []
        for sel in block_boot(mask, spec["bootstrap_draws"]):
            if weights is None:
                boots.append(actual_vec[sel].mean())
            else:
                boots.append((actual_vec[sel] * weights[sel]).sum() / weights[sel].sum())
        boots = np.array(boots)
        return {
            "label": label, "n": int(mask.sum()), "actual": round(a, 4),
            "null_mean": round(float(nm.mean()), 4), "null_sd": round(float(nm.std(ddof=1)), 4),
            "effect": round(a - float(nm.mean()), 4),
            "effect_ci95_block_bootstrap": [round(float(np.percentile(boots, 2.5) - nm.mean()), 4), round(float(np.percentile(boots, 97.5) - nm.mean()), 4)],
            "p_one_sided_worse": round(pvalue_ge(nm, a), 4),
            "p_one_sided_better": round(pvalue_ge(-nm, -a), 4),
            "null_p95": round(float(np.percentile(nm, 95)), 4),
        }

    tail_thr = spec["floors"]["tail_threshold_u"]
    H1 = cell(au, U, label="H1 mean u, equal-weighted")
    H2 = cell((au > tail_thr).astype(float), (U > tail_thr).astype(float), label=f"H2 share of fills with u > {tail_thr}")
    S1 = cell(au, U, weights=w, label="S1 mean u, SGD-notional-weighted")
    S2 = cell(aw6, W6, label="S2 share worse than all six neighbouring closes")
    S3_pre = cell(apre * 100, PRE * 100, label="S3 pre leg, adverse-oriented, per cent")
    S3_post = cell(apost * 100, POST * 100, label="S3 post leg, adverse-oriented, per cent")
    S6 = cell(auc, UC, label="S6 u at the session close (day choice alone)")
    buys = side > 0
    S7 = {"buys": cell(au, U, mask=buys, label="S7 buys"), "sells": cell(au, U, mask=~buys, label="S7 sells"),
          "buys_pre_pct": cell(apre * 100, PRE * 100, mask=buys, label="buys pre leg"), "sells_pre_pct": cell(apre * 100, PRE * 100, mask=~buys, label="sells pre leg"),
          "buys_post_pct": cell(apost * 100, POST * 100, mask=buys, label="buys post leg"), "sells_post_pct": cell(apost * 100, POST * 100, mask=~buys, label="sells post leg"),
          "buys_tail": cell((au > tail_thr).astype(float), (U > tail_thr).astype(float), mask=buys, label="buys tail share"),
          "sells_tail": cell((au > tail_thr).astype(float), (U > tail_thr).astype(float), mask=~buys, label="sells tail share"),
          "raw_signed_price_change_pct": {
              "buys_pre_mean": round(float(np.mean([f["pre"] for f in F if f["side"] > 0]) * 100), 3),
              "sells_pre_mean": round(float(np.mean([-f["pre"] for f in F if f["side"] < 0]) * 100), 3),
              "buys_post_mean": round(float(np.mean([-f["post"] for f in F if f["side"] > 0]) * 100), 3),
              "sells_post_mean": round(float(np.mean([f["post"] for f in F if f["side"] < 0]) * 100), 3),
              "note": "signed price changes: pre = t-3 close to fill, post = fill to t+3 close; positive means the price rose"}}
    noex = np.array([not f.get("ex_in_window") for f in F])
    S8 = cell(au, U, mask=noex, label="S8 H1 with ex-date windows excluded (actual side only; placebo windows keep their rebased ex-dates)")
    se_v = math.sqrt(1 / (12 * n))
    S5 = {"n": n, "mean_v": round(float(av.mean()), 4), "null_mean": 0.5, "se_uniform": round(se_v, 4),
          "z": round(float((av.mean() - 0.5) / se_v), 3), "p_one_sided_worse": round(1 - ND.cdf((av.mean() - 0.5) / se_v), 4),
          "share_in_worst_quartile": round(float((av > 0.75).mean()), 4), "share_in_best_quartile": round(float((av < 0.25).mean()), 4),
          "buys_mean_v": round(float(av[buys].mean()), 4), "sells_mean_v": round(float(av[~buys].mean()), 4)}
    # S4 matched placebo post leg (pre-leg tercile matching per fill)
    matched_means, matched_null = [], np.zeros(D)
    for r in range(n):
        pre_r = PRE[r]; post_r = POST[r]
        t1, t2 = np.percentile(pre_r, [100 / 3, 200 / 3])
        a_pre = apre[r]
        mask = (pre_r <= t1) if a_pre <= t1 else ((pre_r > t2) if a_pre > t2 else ((pre_r > t1) & (pre_r <= t2)))
        pool = post_r[mask] if mask.any() else post_r
        matched_means.append(pool.mean())
        matched_null += rng.choice(pool, size=D, replace=True)
    matched_null /= n
    a_post = float(apost.mean())
    S4 = {"n": n, "actual_post_pct": round(a_post * 100, 3), "matched_placebo_post_pct": round(float(np.mean(matched_means)) * 100, 3),
          "unmatched_placebo_post_pct": round(float(POST.mean()) * 100, 3),
          "excess_over_matched_pct": round((a_post - float(np.mean(matched_means))) * 100, 3),
          "p_one_sided_worse_matched": round(pvalue_ge(matched_null, a_post), 4),
          "null_sd_matched_pct": round(float(matched_null.std(ddof=1)) * 100, 3),
          "note": "the matched null draws independently per fill within the matched tercile; it is a reversal check, not the verdict comparator"}
    # S9 thinness: leave-one-ticker-out
    null_mean_by_fill = U.mean(axis=1)
    effects = []
    for yf in sorted(set(f["yf"] for f in F)):
        keep = np.array([f["yf"] != yf for f in F])
        effects.append({"dropped": yf, "n": int(keep.sum()), "effect": round(float(au[keep].mean() - null_mean_by_fill[keep].mean()), 4)})
    eff_vals = [e["effect"] for e in effects]
    total_effect = float(au.sum() - null_mean_by_fill.sum())
    S9 = {"effect_full": H1["effect"], "min_effect_loto": round(min(eff_vals), 4), "max_effect_loto": round(max(eff_vals), 4),
          "sign_flips": bool(min(eff_vals) < 0 < max(eff_vals)),
          "largest_single_fill_share_of_effect": round(float(np.max(np.abs(au - null_mean_by_fill)) / abs(total_effect)), 3) if abs(H1["effect"]) >= 0.01 else None,
          "largest_single_fill_share_note": "reported only when the pooled effect is at least 0.01 in u; a share of a near-zero effect is not meaningful",
          "detail": effects}
    # C1 cost anchor
    u_med = np.median(U, axis=1)
    rng_width = np.array([f["H"] - f["L"] for f in F])
    qty = np.array([f["qty"] for f in F]); fxv = np.array([f["fx_sgd"] for f in F])
    cost_i = (au - u_med) * rng_width * qty * fxv
    null_cost = ((U - u_med[:, None]) * (rng_width * qty * fxv)[:, None]).sum(axis=0)
    notional = float(w.sum())
    pnl = spec["cost_anchor"]["pnl_2026_sgd"]
    fee_rows = [f for f in F if f.get("fee") is not None]
    fee_bps_sgd = 1e4 * sum(f["fee"] * f["fx_sgd"] for f in fee_rows) / sum(f["qty"] * f["price"] * f["fx_sgd"] for f in fee_rows)
    fee_by_ccy = {}
    for ccy in sorted(set(f["ccy"] for f in fee_rows)):
        rows = [f for f in fee_rows if f["ccy"] == ccy]
        fee_by_ccy[ccy] = {"n": len(rows), "bps_one_way": round(1e4 * sum(f["fee"] for f in rows) / sum(f["qty"] * f["price"] for f in rows), 1)}
    C1 = {
        "n": n, "traded_notional_sgd": round(notional),
        "excess_cost_sgd": round(float(cost_i.sum())), "null_mean_sgd": round(float(null_cost.mean())), "null_sd_sgd": round(float(null_cost.std(ddof=1))),
        "null_p95_sgd": round(float(np.percentile(null_cost, 95))), "null_p05_sgd": round(float(np.percentile(null_cost, 5))),
        "p_one_sided_worse": round(pvalue_ge(null_cost, float(cost_i.sum())), 4), "p_one_sided_better": round(pvalue_ge(-null_cost, -float(cost_i.sum())), 4),
        "excess_cost_bps_of_notional": round(1e4 * float(cost_i.sum()) / notional, 1),
        "null_sd_bps_of_notional": round(1e4 * float(null_cost.std(ddof=1)) / notional, 1),
        "buys_cost_sgd": round(float(cost_i[buys].sum())), "sells_cost_sgd": round(float(cost_i[~buys].sum())),
        "commission_measured_bps_one_way_sgd_terms": round(fee_bps_sgd, 1), "commission_measured_by_ccy": fee_by_ccy,
        "commission_rate_card_bps_one_way_usd": spec["cost_anchor"]["rate_card_bps_one_way_usd"],
        "commission_on_the_151_fills_sgd": round(float(sum(f["fee"] * f["fx_sgd"] for f in fee_rows))),
        "pnl_2026_sgd": pnl, "pnl_source": spec["cost_anchor"]["pnl_source"],
        "excess_cost_share_of_pnl": round(float(cost_i.sum()) / pnl, 4),
        "per_fill": [{"ticker": f["ticker"], "date": f["session_date"], "side": f["side_label"], "u": round(f["u"], 3), "u_med_placebo": round(float(u_med[r]), 3),
                      "cost_sgd": round(float(cost_i[r])), "notional_sgd": round(f["notional_sgd"])} for r, f in enumerate(F)],
    }
    X1 = sell_regret(ctx, F, spec)
    # verdict: H1 is the single verdict-bearing clause; H2 is a floored secondary that can add a suffix
    powered_H1 = cov["power"]["H1"]["power_at_delta"] >= 0.80
    powered_H2 = cov["power"]["H2"]["power_at_delta_fixed"] >= 0.80
    d1 = spec["floors"]["H1_delta_mean_u"]; d2 = cov["power"]["H2"]["delta_fixed"]

    def status(cellv, delta, powered):
        passed = cellv["p_one_sided_worse"] <= alpha
        if passed and cellv["effect"] >= delta:
            return "PASS" if powered else "SUGGESTIVE"
        if passed and cellv["effect"] < delta:
            return "DETECTED-BELOW-FLOOR" if powered else "SUGGESTIVE-BELOW-FLOOR"
        return "FAIL" if powered else "UNRESOLVED"

    st1 = status(H1, d1, powered_H1)
    st2 = status(H2, d2, powered_H2)
    # Verdict mapping, fixed at the freeze (RESEARCH_MEMO.md section 1.7):
    #   CONFIRMED                 H1 p <= alpha, effect at or above the floor, powered
    #   DETECTED-BELOW-FLOOR      H1 p <= alpha, powered, effect below the floor
    #   REJECTED                  H1 p > alpha, powered
    #   SUGGESTIVE                H1 p <= alpha but demoted by power
    #   UNRESOLVED                H1 p > alpha but demoted by power
    #   suffix TAIL-ELEVATED      H2 PASS at its floor, whatever H1 does (never confirms on its own)
    #   suffix (THIN)             a passing H1 whose effect changes sign when any one ticker is dropped
    if st1 == "PASS":
        verdict = "CONFIRMED"
    elif st1 == "DETECTED-BELOW-FLOOR":
        verdict = "DETECTED-BELOW-FLOOR"
    elif st1 == "FAIL":
        verdict = "REJECTED"
    elif st1.startswith("SUGGESTIVE"):
        verdict = "SUGGESTIVE"
    else:
        verdict = "UNRESOLVED"
    if st2 == "PASS":
        verdict += "; TAIL-ELEVATED"
    if S9["sign_flips"] and st1 in ("PASS", "DETECTED-BELOW-FLOOR", "SUGGESTIVE", "SUGGESTIVE-BELOW-FLOOR"):
        verdict += " (THIN)"
    return {
        "registered": spec["registered"], "run_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "provenance": ctx["provenance"], "n": n, "counts": cov["counts"],
        "verdict": verdict, "clause_status": {"H1": st1, "H2": st2}, "powered": {"H1": powered_H1, "H2": powered_H2},
        "floors": {"H1_delta": d1, "H2_delta": d2}, "alpha_one_sided": alpha,
        "better_than_placebo_H1_at_alpha": bool(H1["p_one_sided_better"] <= alpha),
        "H1": H1, "H2": H2, "S1": S1, "S2": S2, "S3_pre": S3_pre, "S3_post": S3_post, "S4": S4, "S5": S5, "S6": S6, "S7": S7, "S8": S8, "S9": S9, "C1": C1, "X1": X1,
        "distribution": {"actual_u_hist_edges": [round(x, 2) for x in np.linspace(0, 1, 11)],
                         "actual_u_hist": np.histogram(au, bins=np.linspace(0, 1, 11))[0].tolist(),
                         "placebo_pooled_quantiles": {str(q): round(float(np.percentile(U.ravel(), q)), 4) for q in (5, 25, 50, 75, 95)},
                         "placebo_pooled_quantiles_buys": {str(q): round(float(np.percentile(U[buys].ravel(), q)), 4) for q in (5, 25, 50, 75, 95)},
                         "placebo_pooled_quantiles_sells": {str(q): round(float(np.percentile(U[~buys].ravel(), q)), 4) for q in (5, 25, 50, 75, 95)},
                         "null_mean_u_draws": np.round(U.mean(axis=0), 4).tolist()},
        "fills": [{key: f.get(key) for key in ("ticker", "yf", "name", "session_date", "date", "side_label", "qty", "price", "ccy", "notional_sgd", "alignment", "ex_in_window", "u", "worse6", "pre", "post", "u_close", "v_intraday", "H", "L")} for f in F],
        "blocks": blocks.tolist(),
        "trial_register": {"declared_cells": spec["declared_cells"], "verdict_bearing": ["H1"], "suffix_bearing": ["H2"],
                           "configurations_evaluated": len(spec["declared_cells"]), "undeclared_cells_run": 0},
    }


def sell_regret(ctx: dict, F: list, spec: dict) -> dict:
    excluded = {e["yf"] for e in spec["sell_regret"]["excluded"]}
    get_fx = ctx["get_fx"]
    horizons = spec["sell_regret"]["horizons_sessions"]
    buys = [f for f in F if f["side"] > 0]

    def fwd_tr(f, hzn):
        s = ctx["series"][f["yf"]]
        i = f["session_index"]; j = i + hzn
        if j >= len(s.dates) or s.prov[j] or s.bad[j]:
            return None
        local = float(s.ac[j] / (f["price"] * s.f[i]) - 1)
        fx0, _ = get_fx(f["ccy"], dt.date.fromisoformat(f["session_date"])); fx1, _ = get_fx(f["ccy"], s.dates[j])
        if fx0 is None or fx1 is None:
            return None
        return (1 + local) * fx1 / fx0 - 1

    rows = []
    for f in F:
        if f["side"] > 0:
            continue
        rec = {"ticker": f["ticker"], "date": f["session_date"], "notional_sgd": round(f["notional_sgd"]), "excluded": f["yf"] in excluded}
        d0 = dt.date.fromisoformat(f["session_date"])
        dest = [b for b in buys if b["ccy"] == f["ccy"] and d0 < dt.date.fromisoformat(b["session_date"]) <= d0 + dt.timedelta(days=7)]
        rec["destination"] = [b["ticker"] for b in dest] if dest else ["cash " + f["ccy"]]
        for hz in horizons:
            r_sold = fwd_tr(f, hz)
            if dest:
                parts = [(fwd_tr(b, hz), b["notional_sgd"]) for b in dest]
                parts = [(r, wgt) for r, wgt in parts if r is not None]
                r_dest = sum(r * wgt for r, wgt in parts) / sum(wgt for _, wgt in parts) if parts else None
            else:
                s = ctx["series"][f["yf"]]; j = f["session_index"] + hz
                if j < len(s.dates):
                    fx0, _ = get_fx(f["ccy"], d0); fx1, _ = get_fx(f["ccy"], s.dates[j])
                    r_dest = fx1 / fx0 - 1 if fx0 and fx1 else None
                else:
                    r_dest = None
            rec[f"sold_tr_sgd_{hz}"] = None if r_sold is None else round(r_sold * 100, 2)
            rec[f"dest_tr_sgd_{hz}"] = None if r_dest is None else round(r_dest * 100, 2)
            rec[f"regret_{hz}"] = None if (r_sold is None or r_dest is None) else round((r_sold - r_dest) * 100, 2)
        rows.append(rec)
    summary = {}
    for hz in horizons:
        vals = np.array([r[f"regret_{hz}"] for r in rows if r[f"regret_{hz}"] is not None and not r["excluded"]])
        sold = np.array([r[f"sold_tr_sgd_{hz}"] for r in rows if r[f"sold_tr_sgd_{hz}"] is not None and not r["excluded"]])
        dest = np.array([r[f"dest_tr_sgd_{hz}"] for r in rows if r[f"regret_{hz}"] is not None and not r["excluded"]])
        summary[str(hz)] = {"n": int(len(vals)), "median_regret_pct": round(float(np.median(vals)), 2) if len(vals) else None,
                            "mean_regret_pct": round(float(vals.mean()), 2) if len(vals) else None,
                            "share_regret_positive": round(float((vals > 0).mean()), 3) if len(vals) else None,
                            "median_sold_name_tr_pct": round(float(np.median(sold)), 2) if len(sold) else None,
                            "mean_sold_name_tr_pct": round(float(sold.mean()), 2) if len(sold) else None,
                            "mean_destination_tr_pct": round(float(dest.mean()), 2) if len(dest) else None,
                            "n_with_traced_buy": int(sum(1 for r in rows if r[f"regret_{hz}"] is not None and not r["excluded"] and not r["destination"][0].startswith("cash")))}
    return {"status": "exploratory", "summary": summary, "rows": rows, "excluded_symbols": sorted(excluded)}


# ----------------------------------------------------------------------------
def extract(args, spec: dict):
    """Write the committed extracts: every symbol that carries a 2026 fill, bars
    from 2025-09-01 onward (the placebo range of the earliest fill plus its
    window); and the five SGD FX pairs. Values are copied as served."""
    trades = load_json(ROOT / "trades.json")
    live = Path(args.history)
    history = load_json(live)
    syms = sorted({r["yf"] for r in trades if r.get("yf") and r["yf"] in history})
    cutoff = dt.datetime(2025, 9, 1, tzinfo=dt.timezone.utc).timestamp()   # months 1-indexed
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    out = {"_provenance": {"source": "live Pages artefact docs/data/history.json", "fetched_from": "https://phuazz.github.io/Portfolio-Command-Centre/data/history.json",
                           "source_sha256": sha256_of(live), "source_bytes": live.stat().st_size, "extracted_at_utc": now,
                           "symbols": len(syms), "bars_from": "2025-09-01"}}
    for s in syms:
        e = history[s]
        out[s] = {"name": e.get("name"), "history": [b for b in e["history"] if b["d"] >= cutoff]}
    RESULTS_DIR.mkdir(exist_ok=True)
    path = RESULTS_DIR / "bars_used.json"
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"), ensure_ascii=False)
    print("bars extract:", path, path.stat().st_size, "bytes;", len(syms), "symbols;", sum(len(out[s]["history"]) for s in syms), "bars")
    fx_src = Path(args.fx_source)
    fx = load_json(fx_src)
    fx_out = {"_provenance": {"source": "docs/data/fx.json as committed in the repository at extraction", "source_sha256": sha256_of(fx_src),
                              "extracted_at_utc": now, "pairs": sorted(fx.keys())}}
    for pair, e in fx.items():
        fx_out[pair] = {"name": e.get("name"), "history": e["history"]}
    fx_path = RESULTS_DIR / "fx_used.json"
    with open(fx_path, "w", encoding="utf-8") as fh:
        json.dump(fx_out, fh, separators=(",", ":"), ensure_ascii=False)
    print("fx extract:", fx_path, fx_path.stat().st_size, "bytes;", len(fx), "pairs")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["extract", "coverage", "run"])
    ap.add_argument("--history", default=str(RESULTS_DIR / "bars_used.json"))
    ap.add_argument("--fx", default=str(RESULTS_DIR / "fx_used.json"))
    ap.add_argument("--fx-source", default=str(ROOT / "docs" / "data" / "fx.json"), dest="fx_source")
    args = ap.parse_args()
    spec = load_json(SPEC_PATH)
    RESULTS_DIR.mkdir(exist_ok=True)
    if args.mode == "extract":
        extract(args, spec)
        return
    ctx = build(spec, args)
    rng = np.random.default_rng(spec["seed"])
    placebo = simulate_placebo(ctx, rng, spec["placebo"]["draws_per_fill"], blocked=True)
    if args.mode == "coverage":
        placebo_indep = simulate_placebo(ctx, np.random.default_rng(spec["seed"] + 2), spec["placebo"]["independent_null_draws_for_comparison"], blocked=False)
        cov = coverage(ctx, placebo, placebo_indep)
        with open(RESULTS_DIR / "coverage.json", "w", encoding="utf-8") as fh:
            json.dump(cov, fh, indent=1, ensure_ascii=False)
        print(json.dumps({k: cov[k] for k in ("counts", "alignment", "window_width", "null", "power")}, indent=1, ensure_ascii=False))
        print("dropped (window):", json.dumps(cov["dropped_window"], ensure_ascii=False))
        print("outcome-blind: no actual statistic computed; coverage.json written; engine sha256", cov["provenance"]["engine_sha256"])
        return
    frozen = load_json(RESULTS_DIR / "coverage.json")
    res = run(ctx, placebo, frozen, args)
    with open(RESULTS_DIR / "results.json", "w", encoding="utf-8") as fh:
        json.dump(res, fh, indent=1, ensure_ascii=False, default=float)
    summary = {k: res[k] for k in ("verdict", "clause_status", "powered", "floors", "n", "H1", "H2", "S1", "S2", "S3_pre", "S3_post", "S4", "S5", "S6", "S8") if k in res}
    summary["S7"] = {k: v for k, v in res["S7"].items()}
    summary["S9"] = {k: v for k, v in res["S9"].items() if k != "detail"}
    summary["C1"] = {k: v for k, v in res["C1"].items() if k != "per_fill"}
    summary["X1_summary"] = res["X1"]["summary"]
    print(json.dumps(summary, indent=1, ensure_ascii=False, default=float))


if __name__ == "__main__":
    main()
