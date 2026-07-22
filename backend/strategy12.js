/**
 * V12 (Random Forest Omni) — successor to the deleted V11. A regularized
 * RandomForestClassifier (300 trees, depth<=4, min_samples_leaf=30, trained by
 * train-strategy12.py on the settled KXBTC15M windows in past_trades/real_data_15m.jsonl)
 * predicting the true settlement probability of the 15-minute window from EVERYTHING the
 * live tick actually carries:
 *
 *   Kalshi orderbook state:  yes_mid, spread, mid_chg_3m (the market's own 3-min drift)
 *   BTC vs the strike:       distance_pct, seconds_to_expiry
 *   BTC price momentum:      ret_1m / ret_3m / ret_5m / ret_10m
 *   BTC price patterns:      vol_5m, vol_15m, range_5m (5-min high-low span),
 *                            streak_1m (signed run of consecutive same-direction minutes)
 *   Chart-pattern features (added 2026-07-10, walk-forward validated on the unrestricted
 *   entry rule: total OOS net $87.50 -> $100-108 across 4 k-means seeds):
 *     trend_slope_10m (normalized LS slope), range_pos_10m (where price sits in the
 *     10-min high-low range), accel_1m (momentum acceleration), vol_ratio (5m/15m vol),
 *     pattern_dist + pattern_yes_rate (motif match: z-normalized last-8-minute price
 *     shape vs the k-means centroids stored in the model JSON's `patterns` block)
 *
 * ENTRY RULE (user spec 2026-07-10): ALWAYS enter when the ask lies in the 0.40-0.60
 * band, anywhere in the whole 15-minute window, as early as possible — the model only
 * picks WHICH side (the one it says is more mispriced), not whether to trade. Holds to
 * settlement (settlement pays $1/$0 with no exit fee). Earliest practical entry is
 * ~minute 3-4 (mid_chg_3m warmup). See train-strategy12.py's walk-forward report for
 * the current out-of-sample numbers; the previous fee-hurdle/minutes-6-13 rule with no
 * band scored +$100-108 on the same folds — set RF_BAND_LO/RF_BAND_HI to widen back out.
 *
 * SELF-RETRAINING: tracks every position it opens, independently polls Kalshi's public
 * /markets/{ticker} for the real settlement result, appends a labeled row to
 * past_trades/strategy12-live-data.jsonl, and periodically (V12_RETRAIN_INTERVAL_MS,
 * default 24h) spawns retrain12.py to retrain on historical+live data and hot-reloads the
 * result — fully automatic, no manual step. All from inside recordPrice(), so it works
 * identically under bot.js or any standalone runner. train-strategy12.py (with its
 * walk-forward diagnostic report) is still there for a manual, reviewed retrain any time.
 *
 * UNVALIDATED LIVE — walk-forward numbers come from train-strategy12.py's holdout folds.
 * Accumulate a real paper track record before trusting it with money.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MODEL_PATH = path.join(__dirname, 'strategy12-model.json');
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
// Whole window is tradable (user spec 2026-07-10: "enter as soon as you can, 0 to 15
// min") — no minutes-6-13 slice anymore. In practice the earliest possible entry is
// ~minute 3-4: mid_chg_3m needs 3 minutes of that market's own quote history first
// (training data has the same NaN warmup, so model and live agree).
const ENTRY_MIN_SEC = 0;
const ENTRY_MAX_SEC = 900;
// Entry price band (user spec 2026-07-10): only take positions whose ask is inside
// [BAND_LO, BAND_HI], and take one whenever such a market exists — no edge hurdle.
// This superseded the old RF_EDGE_BUFFER/RF_MIN_ASK fee-hurdle rule (see header).
const BAND_LO = Number(process.env.RF_BAND_LO ?? 0.40);
const BAND_HI = Number(process.env.RF_BAND_HI ?? 0.60);

const BUCKET_MS = 60 * 1000;        // 1-minute buckets — the resolution the model trained on
const MAX_CLOSES = 30;              // longest lookback needed is 16 (vol_15m)

const closes = [];                  // completed 1-minute close prices, oldest..newest
let forming = null;                 // { bucket, price } — the in-progress minute
let lastPrice = null;
// No startup backfill (removed per instruction) — closes[] fills purely from live
// recordPrice() ticks, so ret_10m/vol_15m aren't available until ~16-24 minutes of real
// uptime have accumulated, same as V11's original pre-backfill behavior.

// ── Self-retraining: tracked open positions, settlement polling, live-data log, retrain ──
const openTracked = new Map(); // ticker -> { side, subtitle, featureMap }
const LIVE_DATA_FILE = path.join(__dirname, 'past_trades', 'strategy12-live-data.jsonl');
const RETRAIN_SCRIPT = path.join(__dirname, 'retrain12.py');
const VENV_PYTHON = path.join(__dirname, '.venv-ml', 'bin', 'python');

const SETTLEMENT_CHECK_MS = Number(process.env.V12_SETTLEMENT_CHECK_MS ?? 30000); // 30s
const RETRAIN_INTERVAL_MS = Number(process.env.V12_RETRAIN_INTERVAL_MS ?? 24 * 60 * 60 * 1000); // 24h
const MIN_NEW_ROWS_TO_RETRAIN = Number(process.env.V12_MIN_NEW_ROWS ?? 10);

let lastSettlementCheckAt = 0;
let lastRetrainAt = 0;
let rowsAtLastRetrain = 0;
let retrainInFlight = false;

function appendLiveRow(pos, resultYes) {
  const rec = { ticker: pos.ticker, subtitle: pos.subtitle, features: pos.featureMap, y_yes: resultYes ? 1 : 0, loggedAt: new Date().toISOString() };
  try { fs.appendFileSync(LIVE_DATA_FILE, JSON.stringify(rec) + '\n'); } catch (e) { console.error('[V12] live-data write error:', e.message); }
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
    console.error('[V12] retrain spawn error (is .venv-ml set up?):', e.message);
  });
  proc.on('close', (code) => {
    retrainInFlight = false;
    if (code === 0) {
      try {
        reloadModel();
        console.log(`[V12] auto-retrain complete: ${out.trim()}`);
      } catch (e) {
        console.error('[V12] retrain produced an unloadable model, kept the previous one:', e.message);
      }
    } else {
      console.error(`[V12] retrain FAILED (exit ${code}), kept the previous model:`, (err || out).trim());
    }
  });
}

// Polls the real settlement result for every position we've tracked, logs a labeled
// training row once it's known, then (throttled, and only once there's enough new data)
// kicks off a retrain. Fire-and-forget from recordPrice — never blocks the trading tick.
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
  // Skip the new-rows gate on the very first attempt so a fresh deploy still retrains once.
  if (lastRetrainAt !== 0 && rows - rowsAtLastRetrain < MIN_NEW_ROWS_TO_RETRAIN) return;
  rowsAtLastRetrain = rows;
  triggerRetrain();
}

// One attempt per window, ever — win or lose. The engine's stop-loss can close a position
// early on noise; without this guard the strategy would just re-enter the same window.
const triedTickers = new Set();
const MAX_TRIED = 500;
function markTried(ticker) {
  triedTickers.add(ticker);
  if (triedTickers.size > MAX_TRIED) {
    triedTickers.delete(triedTickers.values().next().value);
  }
}

// Per-ticker Kalshi mid-price history at 1-minute resolution, fed from chooseEntry (the
// engine calls it every poll cycle while flat, which covers the whole pre-entry stretch
// of each window). mid_chg_3m = current mid − the mid recorded 3 minute-buckets ago; if
// that bucket wasn't seen (strategy started mid-window), the feature is unavailable and
// the market is skipped this tick — same as train-strategy12.py dropping NaN rows.
const midHistory = new Map(); // ticker -> Map(minuteBucket -> mid)
const MID_KEEP_BUCKETS = 20;
const MID_MAX_TICKERS = 8;

function recordMid(ticker, mid) {
  let h = midHistory.get(ticker);
  if (!h) {
    if (midHistory.size >= MID_MAX_TICKERS) {
      midHistory.delete(midHistory.keys().next().value); // evict oldest ticker
    }
    h = new Map();
    midHistory.set(ticker, h);
  }
  const bucket = Math.floor(Date.now() / BUCKET_MS);
  h.set(bucket, mid); // overwrite within the minute — ends up as that minute's last mid
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
  checkSettlementsAndMaybeRetrain().catch(e => console.error('[V12] settlement check error:', e.message));
}

// Sample std (ddof=1, matching pandas' default) of the last `n` one-minute pct changes.
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

// (max − min) / last over the 5 values ending at the current price — pandas rolling(5)
// inclusive of the current row, so 4 completed closes + the live price.
function range5m() {
  if (closes.length < 4 || !Number.isFinite(lastPrice)) return null;
  const vals = [...closes.slice(-4), lastPrice];
  return (Math.max(...vals) - Math.min(...vals)) / lastPrice;
}

// Signed run length of consecutive same-direction 1-minute moves, over the 5 diffs of the
// 6 values ending at the current price. +3 = last three minutes all up; −2 = last two down;
// 0 = latest minute flat. Must match train-strategy12.py's streak() exactly.
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

// Normalized least-squares slope over the 10 values ending at the current price
// (9 completed closes + live price) — mirrors train-strategy12.py's rolling(10) polyfit.
function trendSlope10m() {
  if (closes.length < 9 || !Number.isFinite(lastPrice)) return null;
  const vals = [...closes.slice(-9), lastPrice];
  let num = 0, den = 0;
  for (let i = 0; i < 10; i++) {
    const xc = i - 4.5; // x = 0..9 centered
    num += xc * vals[i];
    den += xc * xc;
  }
  return (num / den) / lastPrice;
}

// Where the current price sits inside the 10-minute high-low range: 0 = at the low,
// 1 = at the high, 0.5 when the range is degenerate (flat 10 minutes).
function rangePos10m() {
  if (closes.length < 9 || !Number.isFinite(lastPrice)) return null;
  const vals = [...closes.slice(-9), lastPrice];
  const hi = Math.max(...vals), lo = Math.min(...vals);
  return hi > lo ? (lastPrice - lo) / (hi - lo) : 0.5;
}

// Motif match: z-normalize the last 8 minutes of price (7 closes + live price,
// population std like numpy's w.std()) and find the nearest k-means centroid in the
// model's pattern bank. Returns { dist, yesRate } or null while warming up / no bank.
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

// Same subtitle-parsing convention as V5/V10 — live and recorded data both populate it.
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

  // Keep the per-ticker mid history fed on every call, even outside the entry window,
  // so mid_chg_3m has real lookback by the time the window opens.
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
    if (!built) continue; // some feature not warmed up yet
    const { x, featureMap } = built;

    const pYes = predictProbaYes(x);
    const yesAsk = parseFloat(m.yes_ask_dollars || 0);
    const noAsk  = parseFloat(m.no_ask_dollars  || 0);
    const yesEdge = pYes - yesAsk;
    const noEdge  = (1 - pYes) - noAsk;
    const [side, ask, edge] = yesEdge >= noEdge ? ['yes', yesAsk, yesEdge] : ['no', noAsk, noEdge];
    // ALWAYS enter when the ask is inside the band (user spec) — no edge hurdle; the
    // model only chooses the side and breaks ties between candidate markets by edge.
    if (ask < BAND_LO || ask > BAND_HI) continue;

    if (!best || edge > best.edge) {
      best = { market: m, side, ask, edge, featureMap };
    }
  }
  if (!best) return null;
  markTried(best.market.ticker);
  openTracked.set(best.market.ticker, { side: best.side, subtitle: best.market.subtitle, featureMap: best.featureMap });
  // Buy the underpriced side and hold to settlement — the fee-free settlement exit is
  // what the training labels and the walk-forward PnL both assume.
  return { market: best.market, side: best.side, ask: best.ask, holdToSettle: true };
}

module.exports = {
  name: 'V12 (Random Forest Omni)',
  chooseEntry,
  recordPrice,
  reloadModel,
  MIN_PROB: 0,
  MAX_PROB: 1
};
