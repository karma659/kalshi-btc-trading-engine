"""
Automatic retrainer for V12 — spawned periodically by strategy12.js (not run by hand;
for the manual/diagnostic trainer with walk-forward reporting, use train-strategy12.py).

Retrains on past_trades/real_data_15m.jsonl (historical) PLUS every real settlement
strategy12.js has logged live to past_trades/strategy12-live-data.jsonl, using the exact
same 13 features and hyperparameters as train-strategy12.py. Feature formulas for the
historical half are duplicated from train-strategy12.py's load_dataset()/streak() — keep
both in sync if either changes.

Usage:  .venv-ml/bin/python retrain12.py
Writes: strategy12-model.json (atomically; only replaced if the export parses back)
"""

import json
import math
import os
import re

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier

HERE = os.path.dirname(os.path.abspath(__file__))
HIST_FILE = os.path.join(HERE, "past_trades", "real_data_15m.jsonl")
LIVE_FILE = os.path.join(HERE, "past_trades", "strategy12-live-data.jsonl")
MODEL_FILE = os.path.join(HERE, "strategy12-model.json")
MODEL_TMP = MODEL_FILE + ".tmp"

FEATURES = ["yes_mid", "spread", "mid_chg_3m", "distance_pct", "seconds_to_expiry",
            "ret_1m", "ret_3m", "ret_5m", "ret_10m", "vol_5m", "vol_15m",
            "range_5m", "streak_1m",
            "trend_slope_10m", "range_pos_10m", "accel_1m", "vol_ratio",
            "pattern_dist", "pattern_yes_rate"]

# Motif pattern bank (centroids + per-centroid yes rates) is FROZEN here: it is loaded
# from the existing model JSON, never refit. Refitting would shift the centroids and
# silently invalidate every pattern_dist/pattern_yes_rate value already logged in
# strategy12-live-data.jsonl. Only the manual train-strategy12.py refits the bank.
SHAPE_LEN = 8
SHAPE_COLS = [f"shape_{j}" for j in range(SHAPE_LEN)]


def streak(diffs):
    """Must match strategy12.js's streak1m() and train-strategy12.py's streak() exactly."""
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


def load_pattern_bank():
    """Frozen motif centroids/rates from the current model JSON (see note above)."""
    with open(MODEL_FILE) as f:
        model = json.load(f)
    pats = model.get("patterns")
    if not pats:
        raise RuntimeError("existing model has no pattern bank — run train-strategy12.py once first")
    return np.array(pats["centroids"], dtype=float), np.array(pats["yes_rates"], dtype=float)


def load_historical(centroids, rates):
    if not os.path.exists(HIST_FILE):
        return pd.DataFrame(columns=FEATURES + ["y_yes"])

    rows = []
    with open(HIST_FILE) as f:
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

    df["minute_in_window"] = df.groupby("ticker").cumcount()
    df["distance_pct"] = (df["btcPrice"] - df["strike"]) / df["strike"] * 100
    df["seconds_to_expiry"] = (14 - df["minute_in_window"]) * 60
    df["yes_mid"] = (df["yes_ask"] + df["yes_bid"]) / 2
    df["spread"] = df["yes_ask"] - df["yes_bid"]
    df["mid_chg_3m"] = df.groupby("ticker")["yes_mid"].diff(3)

    # Chart-pattern structural features — duplicated from train-strategy12.py, keep in sync.
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

    shapes = np.full((len(df), SHAPE_LEN), np.nan)
    v = p.values
    for i in range(SHAPE_LEN - 1, len(df)):
        w = v[i - SHAPE_LEN + 1:i + 1]
        sd = w.std()
        if sd > 0:
            shapes[i] = (w - w.mean()) / sd
    for j in range(SHAPE_LEN):
        df[SHAPE_COLS[j]] = shapes[:, j]

    last = df[df["minute_in_window"] == 14][["ticker", "yes_bid"]].rename(columns={"yes_bid": "settle_yes_bid"})
    df = df.merge(last, on="ticker", how="left")
    df = df.dropna(subset=["settle_yes_bid"])
    df["y_yes"] = (df["settle_yes_bid"] >= 0.5).astype(int)

    base_feats = [f for f in FEATURES if f not in ("pattern_dist", "pattern_yes_rate")]
    df = df.dropna(subset=base_feats + SHAPE_COLS).reset_index(drop=True)

    # Motif features against the FROZEN pattern bank
    shp = df[SHAPE_COLS].values
    dist = np.sqrt(((shp[:, None, :] - centroids[None, :, :]) ** 2).sum(axis=2))
    lab = dist.argmin(axis=1)
    df["pattern_dist"] = dist.min(axis=1)
    df["pattern_yes_rate"] = rates[lab]
    return df[FEATURES + ["y_yes"]]


def load_live():
    """Real settled outcomes logged by strategy12.js — already has precomputed features
    (built with the identical formulas, see strategy12.js's buildFeatures)."""
    if not os.path.exists(LIVE_FILE):
        return pd.DataFrame(columns=FEATURES + ["y_yes"])
    rows = []
    with open(LIVE_FILE) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
                row = {k: d["features"][k] for k in FEATURES}
                row["y_yes"] = int(d["y_yes"])
                rows.append(row)
            except (KeyError, ValueError, json.JSONDecodeError):
                continue
    return pd.DataFrame(rows, columns=FEATURES + ["y_yes"])


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


def main():
    centroids, rates = load_pattern_bank()
    hist = load_historical(centroids, rates)
    live = load_live()
    df = pd.concat([hist, live], ignore_index=True)
    df[FEATURES] = df[FEATURES].astype(float)
    df["y_yes"] = df["y_yes"].astype(int)

    if len(df) < 100 or df["y_yes"].nunique() < 2:
        print(f"SKIP: not enough usable data yet (n={len(df)}) — keeping existing model")
        return 0

    rf = RandomForestClassifier(n_estimators=300, max_depth=4, min_samples_leaf=30,
                                 random_state=42, n_jobs=-1)
    rf.fit(df[FEATURES], df["y_yes"])

    model = {
        "features": FEATURES,
        "n_estimators": len(rf.estimators_),
        "trained_on_rows": int(len(df)),
        "trained_on_live_rows": int(len(live)),
        "patterns": {  # frozen bank, passed through unchanged
            "centroids": centroids.tolist(),
            "yes_rates": rates.tolist(),
        },
        "trees": [export_tree(e) for e in rf.estimators_],
    }

    with open(MODEL_TMP, "w") as f:
        json.dump(model, f)
    with open(MODEL_TMP) as f:
        check = json.load(f)
    assert len(check["trees"]) == model["n_estimators"]

    os.replace(MODEL_TMP, MODEL_FILE)
    print(f"OK: retrained on {len(df)} rows ({len(hist)} historical + {len(live)} live), "
          f"{model['n_estimators']} trees exported to {MODEL_FILE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
