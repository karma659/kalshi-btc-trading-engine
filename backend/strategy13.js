/**
 * V13 (Random Forest Omni — Standalone) — rebuilt from scratch 2026-07-10 after the
 * original V13 was diagnosed as broken: a thin 7-feature entry model, an exit model
 * trained on an unlearnable label (its predicted "exit now" probability sat at 65-76%
 * confidence across the ENTIRE realistic input range, including exact breakeven with
 * zero price movement — because "does exiting now beat holding to settlement" carries
 * almost no real signal in a near-coinflip market), and no per-ticker dedup guard — so
 * it re-entered the same settled window every ~2 seconds, bleeding double fees on 212
 * live paper trades for a 1.4% win rate.
 *
 * This rebuild ports V12's proven design (strategy12.js / train-strategy12.py):
 *
 *   Kalshi orderbook state:  yes_mid, spread, mid_chg_3m (the market's own 3-min drift)
 *   BTC vs the strike:       distance_pct, seconds_to_expiry
 *   BTC price momentum:      ret_1m / ret_3m / ret_5m / ret_10m
 *   BTC price patterns:      vol_5m, vol_15m, range_5m, streak_1m
 *   Chart-pattern features:  trend_slope_10m, range_pos_10m, accel_1m, vol_ratio,
 *                            pattern_dist + pattern_yes_rate (motif match against the
 *                            k-means centroids in the model JSON's `patterns` block)
 *
 * ENTRY RULE: minutes 6-13 of the window (NOT the full 0-15 min — walk-forward tested
 * open, it goes NEGATIVE net despite a HIGHER raw win rate, because early-window
 * momentum features mostly describe the tail of the PREVIOUS window's noise, not this
 * one), gated by a real fee-beating edge — NOT a fixed price band; a band was tested
 * both for this feature set and V12's and consistently gave up most of the $ edge
 * (+$13.95/149 trades vs +$108.31/354 trades on the identical dataset/model). Holds to
 * settlement always (settlement is fee-free; every early exit pays an extra fee for no
 * proven benefit found in this project's exit-model experiments on this market).
 *
 * Walk-forward validated (train-strategy13.py, 2026-07-10): 354 trades, 46.0% win rate,
 * net +$108.31, profitable in 3/5 expanding folds — same dataset and methodology as V12.
 *
 * SELF-RETRAINING: tracks every position it opens, independently polls Kalshi's public
 * /markets/{ticker} for the real settlement result, appends a labeled row to
 * past_trades/strategy13-live-data.jsonl, and periodically spawns retrain13.py to
 * retrain on historical+live data and hot-reload the result.
 *
 * UNVALIDATED LIVE — walk-forward numbers come from train-strategy13.py's holdout
 * folds on one ~7-day BTC regime. Accumulate a real paper track record before trusting
 * it with money, same caveat as every other model in this project.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MODEL_PATH = path.join(__dirname, 'strategy13-model.json');
let MODEL = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));

function reloadModel() {
  const fresh = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
  if (!fresh || !Array.isArray(fresh.trees) || fresh.trees.length === 0 || !Array.isArray(fresh.features)
      || !fresh.patterns || !Array.isArray(fresh.patterns.centroids) || !Array.isArray(fresh.patterns.yes_rates)) {
    throw new Error('malformed model file (or missing pattern bank), refusing to swap in');
  }
  MODEL = fresh;
}

const CYCLE_SECONDS = 900;          // KXBTC15M resolves every 15 minutes
const ENTRY_MIN_SEC = 60;           // minutes 6..13 of the window — see header, load-bearing
const ENTRY_MAX_SEC = 480;
const EDGE_BUFFER = Number(process.env.RF13_EDGE_BUFFER ?? 0.01);
const MIN_ASK = Number(process.env.RF13_MIN_ASK ?? 0.03);

const BUCKET_MS = 60 * 1000;        // 1-minute buckets — the resolution the model trained on
const MAX_CLOSES = 30;

const closes = [];                  // completed 1-minute close prices, oldest..newest
let forming = null;                 // { bucket, price } — the in-progress minute
let lastPrice = null;

// ── Self-retraining: tracked open positions, settlement polling, live-data log, retrain ──
const openTracked = new Map(); // ticker -> { side, subtitle, featureMap }
const pendingTracked = new Map(); // proposed entry -> promoted only after a confirmed fill
const LIVE_DATA_FILE = path.join(__dirname, 'past_trades', 'strategy13-live-data.jsonl');
const RETRAIN_SCRIPT = path.join(__dirname, 'retrain13.py');
const VENV_PYTHON = path.join(__dirname, '.venv-ml', 'bin', 'python');

const SETTLEMENT_CHECK_MS = Number(process.env.V13_SETTLEMENT_CHECK_MS ?? 30000);
const RETRAIN_INTERVAL_MS = Number(process.env.V13_RETRAIN_INTERVAL_MS ?? 24 * 60 * 60 * 1000);
const MIN_NEW_ROWS_TO_RETRAIN = Number(process.env.V13_MIN_NEW_ROWS ?? 10);

let lastSettlementCheckAt = 0;
let lastRetrainAt = 0;
let rowsAtLastRetrain = 0;
let retrainInFlight = false;

function appendLiveRow(pos, resultYes) {
  const rec = { ticker: pos.ticker, subtitle: pos.subtitle, features: pos.featureMap, y_yes: resultYes ? 1 : 0, loggedAt: new Date().toISOString() };
  try { fs.appendFileSync(LIVE_DATA_FILE, JSON.stringify(rec) + '\n'); } catch (e) { console.error('[V13] live-data write error:', e.message); }
}

function countLiveRows() {
  try { return fs.readFileSync(LIVE_DATA_FILE, 'utf8').split('\n').filter(Boolean).length; }
  catch (_) { return 0; }
}

function triggerRetrain() {
  if (retrainInFlight) return;
  retrainInFlight = true;
  lastRetrainAt = Date.now();
  const proc = spawn(VENV_PYTHON, [RETRAIN_SCRIPT], { cwd: __dirname });
  let out = '', err = '';
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { err += d; });
  proc.on('error', (e) => {
    retrainInFlight = false;
    console.error('[V13] retrain spawn error (is .venv-ml set up?):', e.message);
  });
  proc.on('close', (code) => {
    retrainInFlight = false;
    if (code === 0) {
      try {
        reloadModel();
        console.log(`[V13] auto-retrain complete: ${out.trim()}`);
      } catch (e) {
        console.error('[V13] retrain produced an unloadable model, kept the previous one:', e.message);
      }
    } else {
      console.error(`[V13] retrain FAILED (exit ${code}), kept the previous model:`, (err || out).trim());
    }
  });
}

async function checkSettlementsAndMaybeRetrain() {
  const now = Date.now();
  if (now - lastSettlementCheckAt < SETTLEMENT_CHECK_MS) return;
  lastSettlementCheckAt = now;

  for (const [ticker, pos] of openTracked) {
    let result = null;
    try {
      const resp = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${ticker}`);
      if (resp.ok) {
        const data = await resp.json();
        result = data?.market?.result || null;
      }
    } catch (_) { /* network hiccup — try again next check */ }
    if (result !== 'yes' && result !== 'no') continue;

    appendLiveRow(pos, result === 'yes');
    openTracked.delete(ticker);
  }

  if (now - lastRetrainAt < RETRAIN_INTERVAL_MS) return;
  const rows = countLiveRows();
  if (lastRetrainAt !== 0 && rows - rowsAtLastRetrain < MIN_NEW_ROWS_TO_RETRAIN) return;
  rowsAtLastRetrain = rows;
  triggerRetrain();
}

// One attempt per window, ever — win or lose. Without this the strategy would re-enter
// the same settled window on every poll cycle (this exact bug bled 212 live paper trades
// in the original broken V13).
const triedTickers = new Set();
const MAX_TRIED = 500;
function markTried(ticker) {
  triedTickers.add(ticker);
  if (triedTickers.size > MAX_TRIED) {
    triedTickers.delete(triedTickers.values().next().value);
  }
}

const midHistory = new Map(); // ticker -> Map(minuteBucket -> mid)
const MID_KEEP_BUCKETS = 20;
const MID_MAX_TICKERS = 8;

function recordMid(ticker, mid) {
  let h = midHistory.get(ticker);
  if (!h) {
    if (midHistory.size >= MID_MAX_TICKERS) {
      midHistory.delete(midHistory.keys().next().value);
    }
    h = new Map();
    midHistory.set(ticker, h);
  }
  const bucket = Math.floor(Date.now() / BUCKET_MS);
  h.set(bucket, mid);
  for (const b of h.keys()) {
    if (b < bucket - MID_KEEP_BUCKETS) h.delete(b);
  }
}

function midChg3m(ticker, currentMid) {
  const h = midHistory.get(ticker);
  if (!h) return null;
  const bucket = Math.floor(Date.now() / BUCKET_MS);
  const past = h.get(bucket - 3);
  return past === undefined ? null : currentMid - past;
}

function recordPrice(price) {
  if (!Number.isFinite(price)) return;
  lastPrice = price;
  const bucket = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
  if (!forming || forming.bucket !== bucket) {
    if (forming) {
      closes.push(forming.price);
      if (closes.length > MAX_CLOSES) closes.shift();
    }
    forming = { bucket, price };
  } else {
    forming.price = price;
  }
  checkSettlementsAndMaybeRetrain().catch(e => console.error('[V13] settlement check error:', e.message));
}

function rollingVol(n) {
  if (closes.length < n + 1) return null;
  const rets = [];
  for (let i = closes.length - n; i < closes.length; i++) {
    rets.push(closes[i] / closes[i - 1] - 1);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance);
}

function ret(n) {
  if (closes.length < n || !Number.isFinite(lastPrice)) return null;
  const base = closes[closes.length - n];
  return base === 0 ? null : lastPrice / base - 1;
}

function range5m() {
  if (closes.length < 4 || !Number.isFinite(lastPrice)) return null;
  const vals = [...closes.slice(-4), lastPrice];
  return (Math.max(...vals) - Math.min(...vals)) / lastPrice;
}

function streak1m() {
  if (closes.length < 5 || !Number.isFinite(lastPrice)) return null;
  const vals = [...closes.slice(-5), lastPrice];
  const diffs = [];
  for (let i = 1; i < vals.length; i++) diffs.push(vals[i] - vals[i - 1]);
  const s = Math.sign(diffs[diffs.length - 1]);
  if (s === 0) return 0;
  let k = 0;
  for (let i = diffs.length - 1; i >= 0 && Math.sign(diffs[i]) === s; i--) k++;
  return s * k;
}

function trendSlope10m() {
  if (closes.length < 9 || !Number.isFinite(lastPrice)) return null;
  const vals = [...closes.slice(-9), lastPrice];
  let num = 0, den = 0;
  for (let i = 0; i < 10; i++) {
    const xc = i - 4.5;
    num += xc * vals[i];
    den += xc * xc;
  }
  return (num / den) / lastPrice;
}

function rangePos10m() {
  if (closes.length < 9 || !Number.isFinite(lastPrice)) return null;
  const vals = [...closes.slice(-9), lastPrice];
  const hi = Math.max(...vals), lo = Math.min(...vals);
  return hi > lo ? (lastPrice - lo) / (hi - lo) : 0.5;
}

function patternFeatures() {
  const pats = MODEL.patterns;
  if (!pats || !Array.isArray(pats.centroids) || pats.centroids.length === 0) return null;
  if (closes.length < 7 || !Number.isFinite(lastPrice)) return null;
  const vals = [...closes.slice(-7), lastPrice];
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  if (sd === 0) return null;
  const z = vals.map(v => (v - mean) / sd);
  let bestDist = Infinity, bestIdx = -1;
  for (let i = 0; i < pats.centroids.length; i++) {
    const c = pats.centroids[i];
    let d = 0;
    for (let j = 0; j < z.length; j++) d += (z[j] - c[j]) ** 2;
    d = Math.sqrt(d);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return { dist: bestDist, yesRate: pats.yes_rates[bestIdx] };
}

function secondsToExpiry() {
  const now = new Date();
  const secondsIntoCycle = (now.getUTCMinutes() * 60 + now.getUTCSeconds()) % CYCLE_SECONDS;
  return CYCLE_SECONDS - secondsIntoCycle;
}

function strikeOf(market) {
  if (Number.isFinite(market.floor_strike)) return market.floor_strike;
  const sub = String(market.subtitle || '');
  const sm = sub.match(/([0-9][0-9,]*(?:\.[0-9]+)?)/);
  if (sm) return parseFloat(sm[1].replace(/,/g, ''));
  const m = /-T([\d.]+)$/.exec(market.ticker || '');
  return m ? parseFloat(m[1]) : null;
}

function evalTree(tree, x) {
  let node = 0;
  while (tree.left[node] !== -1) {
    node = x[tree.feature[node]] <= tree.threshold[node] ? tree.left[node] : tree.right[node];
  }
  return tree.prob[node];
}

function predictProbaYes(x) {
  let sum = 0;
  for (const tree of MODEL.trees) sum += evalTree(tree, x);
  return sum / MODEL.trees.length;
}

function buildFeatures(market, btcPrice, strike, sec) {
  const yesAsk = parseFloat(market.yes_ask_dollars || 0);
  const yesBid = parseFloat(market.yes_bid_dollars || 0);
  const yesMid = (yesAsk + yesBid) / 2;
  const ret1 = ret(1), ret3 = ret(3);
  const vol5 = rollingVol(5), vol15 = rollingVol(15);
  const pat = patternFeatures();
  const featureMap = {
    yes_mid:           yesMid,
    spread:            yesAsk - yesBid,
    mid_chg_3m:        midChg3m(market.ticker, yesMid),
    distance_pct:      (btcPrice - strike) / strike * 100,
    seconds_to_expiry: sec,
    ret_1m:            ret1,
    ret_3m:            ret3,
    ret_5m:            ret(5),
    ret_10m:           ret(10),
    vol_5m:            vol5,
    vol_15m:           vol15,
    range_5m:          range5m(),
    streak_1m:         streak1m(),
    trend_slope_10m:   trendSlope10m(),
    range_pos_10m:     rangePos10m(),
    accel_1m:          (ret1 !== null && ret3 !== null) ? ret1 - ret3 / 3 : null,
    vol_ratio:         (vol5 !== null && vol15) ? vol5 / vol15 : null,
    pattern_dist:      pat ? pat.dist : null,
    pattern_yes_rate:  pat ? pat.yesRate : null,
  };
  if (Object.values(featureMap).some(v => v === null || !Number.isFinite(v))) return null;
  return { x: MODEL.features.map(f => featureMap[f]), featureMap };
}

function chooseEntry(markets) {
  if (!markets || markets.length === 0 || !Number.isFinite(lastPrice)) return null;

  for (const m of markets) {
    const a = parseFloat(m.yes_ask_dollars || 0);
    const b = parseFloat(m.yes_bid_dollars || 0);
    if (a > 0 || b > 0) recordMid(m.ticker, (a + b) / 2);
  }

  const sec = secondsToExpiry();
  if (sec < ENTRY_MIN_SEC || sec > ENTRY_MAX_SEC) return null;

  let best = null;
  for (const m of markets) {
    if (triedTickers.has(m.ticker)) continue; // one attempt per window, ever
    const strike = strikeOf(m);
    if (strike === null) continue;

    const built = buildFeatures(m, lastPrice, strike, sec);
    if (!built) continue;
    const { x, featureMap } = built;

    const pYes = predictProbaYes(x);
    const yesAsk = parseFloat(m.yes_ask_dollars || 0);
    const noAsk  = parseFloat(m.no_ask_dollars  || 0);
    const yesEdge = pYes - yesAsk;
    const noEdge  = (1 - pYes) - noAsk;
    const [side, ask, edge] = yesEdge >= noEdge ? ['yes', yesAsk, yesEdge] : ['no', noAsk, noEdge];
    if (ask < MIN_ASK || ask > 1 - MIN_ASK) continue;

    const hurdle = 0.07 * ask * (1 - ask) + EDGE_BUFFER;
    if (edge > hurdle && (!best || edge > best.edge)) {
      best = { market: m, side, ask, edge, featureMap };
    }
  }
  if (!best) return null;
  markTried(best.market.ticker);
  pendingTracked.set(best.market.ticker, { ticker: best.market.ticker, side: best.side, subtitle: best.market.subtitle, featureMap: best.featureMap });
  // Buy the underpriced side and hold to settlement — the fee-free settlement exit is
  // what the training labels and the walk-forward PnL both assume. No learned early exit:
  // this project's own exit-model experiments never found one that beat plain hold.
  return { market: best.market, side: best.side, ask: best.ask, holdToSettle: true };
}

function onPositionOpened(position) {
  const proposed = pendingTracked.get(position.ticker);
  pendingTracked.delete(position.ticker);
  if (proposed) openTracked.set(position.ticker, proposed);
}

function onTradeClosed(trade) {
  const tracked = openTracked.get(trade.ticker);
  if (!tracked || trade.result !== 'SETTLED') return;
  // Use the engine-confirmed outcome, never a proposed order or an inferred price move.
  const resultYes = trade.side === 'yes' ? trade.exitBid >= 0.5 : trade.exitBid < 0.5;
  appendLiveRow(tracked, resultYes);
  openTracked.delete(trade.ticker);
}

module.exports = {
  name: 'V13 (Random Forest Omni — Standalone)',
  chooseEntry,
  recordPrice,
  onPositionOpened,
  onTradeClosed,
  reloadModel,
  MIN_PROB: 0,
  MAX_PROB: 1
};
