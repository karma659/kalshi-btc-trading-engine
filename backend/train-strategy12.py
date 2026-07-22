"""
Manual (run-by-hand ONLY — nothing in the bot ever invokes this) trainer for V12.

Trains a RandomForestClassifier on past_trades/real_data_15m.jsonl — the per-minute
KXBTC15M recording built by fetch-history-15m.js, whose last row per window is the REAL
Kalshi settlement result — using the exact same feature formulas strategy12.js computes
live (see buildFeatures there; any change here must be mirrored there and vice versa).

Before the final fit it runs an expanding walk-forward simulation: train on the first
k folds of windows, then paper-trade the next fold with V12's actual entry rule
(any minute of the window, ask inside the 0.40-0.60 band => always enter on the model's
preferred side at the first qualifying minute, one trade per window, hold to settlement,
fee-aware). Those out-of-sample fold PnLs are the honest numbers — the JS backtester
run against this same file afterwards is in-sample and will look better than reality.

Usage:  .venv-ml/bin/python train-strategy12.py
Writes: strategy12-model.json (atomically; only replaced if the export parses back)
"""

import json
import math
import os
import re

import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.ensemble import RandomForestClassifier

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(HERE, "past_trades", "real_data_15m.jsonl")
MODEL_FILE = os.path.join(HERE, "strategy12-model.json")
MODEL_TMP = MODEL_FILE + ".tmp"

FEATURES = ["yes_mid", "spread", "mid_chg_3m", "distance_pct", "seconds_to_expiry",
            "ret_1m", "ret_3m", "ret_5m", "ret_10m", "vol_5m", "vol_15m",
            "range_5m", "streak_1m",
            # chart-pattern features (walk-forward validated 2026-07-10: total OOS net
            # $87.50 -> $100-108 across 4 k-means seeds, most-recent fold up every time)
            "trend_slope_10m", "range_pos_10m", "accel_1m", "vol_ratio",
            "pattern_dist", "pattern_yes_rate"]

# Motif matching: the last SHAPE_LEN minutes of BTC price, z-normalized, matched against
# K_PATTERNS k-means centroids. pattern_dist = distance to the nearest centroid,
# pattern_yes_rate = that centroid's historical settle-yes rate. Centroids/rates are fit
# per-fold in the walk-forward (no leakage) and exported inside the model JSON for the
# final fit so strategy12.js can do the identical matching live.
SHAPE_LEN = 8
K_PATTERNS = 8
SHAPE_COLS = [f"shape_{j}" for j in range(SHAPE_LEN)]

# V12's live entry rule, mirrored for the walk-forward simulation (user spec 2026-07-10:
# ALWAYS enter when the ask is inside the band, as early in the window as possible — the
# whole 0-15 min window is tradable, no fee-hurdle; model only picks the side).
# ENTRY_MIN_SEC=60 here only excludes each window's minute-14 row, which is the synthetic
# settle tick (yes_bid pinned to 1/0) — never a real tradable quote. Live uses 0.
ENTRY_MIN_SEC, ENTRY_MAX_SEC = 60, 900
TARGET_BET = 1.80  # matches bot-config.json's targetBet
BAND_LO, BAND_HI = 0.40, 0.60  # keep in sync with strategy12.js RF_BAND_LO/RF_BAND_HI


def streak(diffs):
    """Signed run of consecutive same-direction moves over the last 5 diffs — must match
    strategy12.js's streak1m() exactly."""
    d = [x for x in diffs if not math.isnan(x)]
    if len(d) < 5:
        return np.nan
    d = d[-5:]
    s = np.sign(d[-1])
    if s == 0:
        return 0.0
    k = 0
    for x in reversed(d):
        if np.sign(x) == s:
            k += 1
        else:
            break
    return float(s * k)


def load_dataset():
    rows = []
    with open(DATA_FILE) as f:
        for line in f:
            d = json.loads(line)
            ts, price = d["timestamp"], d["btcPrice"]
            for m in d["markets"]:
                strike = float(re.sub(r"[^0-9.]", "", m["subtitle"]))
                rows.append({
                    "ticker": m["ticker"], "timestamp": ts, "btcPrice": price, "strike": strike,
                    "yes_ask": float(m["yes_ask_dollars"]), "yes_bid": float(m["yes_bid_dollars"]),
                })

    df = pd.DataFrame(rows).sort_values("timestamp").reset_index(drop=True)

    # BTC momentum / volatility / pattern features (global price series, minute rows)
    df["ret_1m"] = df["btcPrice"].pct_change(1)
    df["ret_3m"] = df["btcPrice"].pct_change(3)
    df["ret_5m"] = df["btcPrice"].pct_change(5)
    df["ret_10m"] = df["btcPrice"].pct_change(10)
    df["vol_5m"] = df["btcPrice"].pct_change().rolling(5).std()
    df["vol_15m"] = df["btcPrice"].pct_change().rolling(15).std()
    df["range_5m"] = (df["btcPrice"].rolling(5).max() - df["btcPrice"].rolling(5).min()) / df["btcPrice"]
    diffs = df["btcPrice"].diff().tolist()
    df["streak_1m"] = [streak(diffs[max(0, i - 4):i + 1]) if i >= 5 else np.nan
                       for i in range(len(diffs))]

    # Kalshi orderbook features
    df["minute_in_window"] = df.groupby("ticker").cumcount()
    df["distance_pct"] = (df["btcPrice"] - df["strike"]) / df["strike"] * 100
    df["seconds_to_expiry"] = (14 - df["minute_in_window"]) * 60
    df["yes_mid"] = (df["yes_ask"] + df["yes_bid"]) / 2
    df["spread"] = df["yes_ask"] - df["yes_bid"]
    df["mid_chg_3m"] = df.groupby("ticker")["yes_mid"].diff(3)

    # Chart-pattern structural features (all from the same global 1-minute price series,
    # windows include the current row — mirror strategy12.js's live formulas exactly).
    p = df["btcPrice"]
    x = np.arange(10, dtype=float)
    x -= x.mean()
    df["trend_slope_10m"] = p.rolling(10).apply(
        lambda w: float(np.dot(x, w.values) / np.dot(x, x)), raw=False) / p
    hi10, lo10 = p.rolling(10).max(), p.rolling(10).min()
    rng = hi10 - lo10
    df["range_pos_10m"] = np.where(rng > 0, (p - lo10) / rng, 0.5)
    df.loc[hi10.isna(), "range_pos_10m"] = np.nan
    df["accel_1m"] = df["ret_1m"] - df["ret_3m"] / 3
    df["vol_ratio"] = np.where(df["vol_15m"] > 0, df["vol_5m"] / df["vol_15m"], np.nan)

    # z-normalized last-SHAPE_LEN-minute price shape, for motif matching
    shapes = np.full((len(df), SHAPE_LEN), np.nan)
    v = p.values
    for i in range(SHAPE_LEN - 1, len(df)):
        w = v[i - SHAPE_LEN + 1:i + 1]
        sd = w.std()
        if sd > 0:
            shapes[i] = (w - w.mean()) / sd
    for j in range(SHAPE_LEN):
        df[SHAPE_COLS[j]] = shapes[:, j]

    # Label: the recording's final row per window is a synthetic settle tick carrying the
    # REAL Kalshi result (yes_bid = 1.0000 on yes, 0.0000 on no).
    last = df[df["minute_in_window"] == 14][["ticker", "yes_bid"]].rename(columns={"yes_bid": "settle_yes_bid"})
    df = df.merge(last, on="ticker", how="left")
    df = df.dropna(subset=["settle_yes_bid"])
    df["y_yes"] = (df["settle_yes_bid"] >= 0.5).astype(int)

    base_feats = [f for f in FEATURES if f not in ("pattern_dist", "pattern_yes_rate")]
    df = df.dropna(subset=base_feats + SHAPE_COLS).reset_index(drop=True)
    return df


def fit_patterns(train_df):
    """K-means the z-normalized price shapes; return (centroids, per-centroid yes rates)."""
    km = KMeans(n_clusters=K_PATTERNS, n_init=4, random_state=42).fit(train_df[SHAPE_COLS].values)
    rates = np.array([
        train_df["y_yes"][km.labels_ == c].mean() if (km.labels_ == c).any() else 0.5
        for c in range(K_PATTERNS)
    ])
    return km.cluster_centers_, rates


def apply_patterns(df, centroids, rates):
    """Add pattern_dist / pattern_yes_rate columns from a fitted pattern bank."""
    df = df.copy()
    shp = df[SHAPE_COLS].values
    dist = np.sqrt(((shp[:, None, :] - centroids[None, :, :]) ** 2).sum(axis=2))
    lab = dist.argmin(axis=1)
    df["pattern_dist"] = dist.min(axis=1)
    df["pattern_yes_rate"] = rates[lab]
    return df


def fit(df):
    rf = RandomForestClassifier(n_estimators=300, max_depth=4, min_samples_leaf=30,
                                 random_state=42, n_jobs=-1)
    rf.fit(df[FEATURES], df["y_yes"])
    return rf


def kalshi_fee(p, c):
    if not (0 < p < 1) or c <= 0:
        return 0.0
    return math.ceil(0.07 * c * p * (1 - p) * 100) / 100


def simulate_fold(rf, test_df):
    """Paper-trade each test window with V12's live entry rule; return (trades, wins, net)."""
    trades = wins = 0
    net = 0.0
    for ticker, g in test_df.groupby("ticker", sort=False):
        g = g.sort_values("timestamp")
        elig = g[(g["seconds_to_expiry"] >= ENTRY_MIN_SEC) & (g["seconds_to_expiry"] <= ENTRY_MAX_SEC)]
        if elig.empty:
            continue
        p_yes = rf.predict_proba(elig[FEATURES])[:, 1]
        for (_, row), p in zip(elig.iterrows(), p_yes):
            yes_ask, no_ask = row["yes_ask"], 1 - row["yes_bid"]
            yes_edge, no_edge = p - yes_ask, (1 - p) - no_ask
            side, ask, edge = ("yes", yes_ask, yes_edge) if yes_edge >= no_edge else ("no", no_ask, no_edge)
            if not (BAND_LO <= ask <= BAND_HI):
                continue
            contracts = int(TARGET_BET // ask)
            if contracts < 1:
                continue
            won = (row["y_yes"] == 1) == (side == "yes")
            pnl = (contracts if won else 0) - contracts * ask - kalshi_fee(ask, contracts)
            trades += 1
            wins += won
            net += pnl
            break  # first qualifying minute = the trade; one per window, like live
    return trades, wins, net


def main():
    df = load_dataset()
    tickers = df.drop_duplicates("ticker")["ticker"].tolist()  # chronological
    n = len(tickers)
    print(f"Dataset: {len(df)} rows across {n} settled windows "
          f"(base yes-rate {df['y_yes'].mean():.1%})")
    if len(df) < 100 or df["y_yes"].nunique() < 2:
        print("SKIP: not enough usable data")
        return 1

    # Expanding walk-forward: train on windows [0, cut), test on the next 10% slice.
    print("\nWalk-forward validation (train on past windows only, trade the next slice):")
    total_tr = total_w = 0
    total_net = 0.0
    for cut_pct in (50, 60, 70, 80, 90):
        cut = n * cut_pct // 100
        end = n * (cut_pct + 10) // 100
        train_t, test_t = set(tickers[:cut]), set(tickers[cut:end])
        train_df = df[df["ticker"].isin(train_t)]
        centroids, rates = fit_patterns(train_df)  # per-fold bank — no lookahead
        rf = fit(apply_patterns(train_df, centroids, rates))
        tr, w, netv = simulate_fold(rf, apply_patterns(df[df["ticker"].isin(test_t)], centroids, rates))
        total_tr += tr; total_w += w; total_net += netv
        wr = f"{w/tr:.0%}" if tr else "—"
        print(f"  fold {cut_pct}-{cut_pct+10}%: {tr:3d} trades, win rate {wr:>4}, net ${netv:+.2f}")
    twr = f"{total_w/total_tr:.1%}" if total_tr else "—"
    print(f"  TOTAL out-of-sample: {total_tr} trades, win rate {twr}, net ${total_net:+.2f}")

    # Final model on everything.
    centroids, rates = fit_patterns(df)
    df = apply_patterns(df, centroids, rates)
    rf = fit(df)

    def export_tree(est):
        t = est.tree_
        out = {"feature": [], "threshold": [], "left": [], "right": [], "prob": []}
        for i in range(t.node_count):
            leaf = t.children_left[i] == -1
            out["feature"].append(int(t.feature[i]) if not leaf else -1)
            out["threshold"].append(float(t.threshold[i]) if not leaf else 0.0)
            out["left"].append(int(t.children_left[i]))
            out["right"].append(int(t.children_right[i]))
            if leaf:
                c = t.value[i][0]
                out["prob"].append(float(c[1] / (c[0] + c[1])) if (c[0] + c[1]) > 0 else 0.5)
            else:
                out["prob"].append(0.0)
        return out

    model = {
        "features": FEATURES,
        "n_estimators": len(rf.estimators_),
        "trained_on_rows": int(len(df)),
        "trained_on_windows": n,
        "patterns": {  # motif bank — strategy12.js and retrain12.py both consume this
            "centroids": centroids.tolist(),
            "yes_rates": rates.tolist(),
        },
        "trees": [export_tree(e) for e in rf.estimators_],
    }
    with open(MODEL_TMP, "w") as f:
        json.dump(model, f)
    with open(MODEL_TMP) as f:
        assert len(json.load(f)["trees"]) == model["n_estimators"]
    os.replace(MODEL_TMP, MODEL_FILE)
    print(f"\nOK: final model trained on all {len(df)} rows -> {MODEL_FILE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
