/**
 * V10 (RSI-3 Sell Signal) — on a bearish RSI-3 signal, buy NO on a KXBTC15M contract
 * whose strike is within $30 above BTC in the contract's last 150s (hold to settlement),
 * or scalp a far-OTM NO mid-contract for a small TP (SCALP_ON=1, off by default).
 * Unvalidated on 15-min data — needs a fresh backtest before trusting it.
 */

const RSI_LEN     = 3;
const OVERBOUGHT  = Number(process.env.RSI_OB ?? 70);
// Timeframes (minutes) to scan, comma-separated: SELL_TFS=1,5,15
const TF_MINUTES  = String(process.env.SELL_TFS ?? '5,15').split(',').map(Number).filter(n => n > 0);
const SIGNAL_TTL_MS = 2 * 60 * 1000; // a bar-close signal stays actionable this long
const MAX_CANDLES = 200;             // per-TF history cap (plenty for RSI-3)

// ── Strike/time gating (per the user's spec) ─────────────────────────────────
// KXBTC15M resolves every 15 min (900s) — was 3600s for hourly KXBTCD. A sell signal can
// only ever appear at a moment aligned to its candle's own grid (a 5-min-TF signal fires
// at secondsToExpiry ∈ {900,600,300,0}, minus up to SIGNAL_TTL_MS of staleness tolerance) —
// so LATE_WINDOW_SEC/SCALP_FROM_SEC/SCALP_TO_SEC MUST be multiples of 300 (the finest TF
// below) or a signal can never land inside them at all, regardless of how "correct" the
// fraction-of-contract math looks on paper.
const CYCLE_SECONDS = 900;
// Settle play: last third of the contract, uniform across every signal timeframe, and BTC
// must sit no more than $30 above the strike for the dip to plausibly cross it.
const LATE_WINDOW_SEC   = Number(process.env.LATE_WINDOW_SEC ?? 300); // last 5 min, all TFs
const NEAR_MAX          = Number(process.env.NEAR_MAX ?? 30);         // max $ above strike, all TFs
const MIN_SEC_TO_EXPIRY = 30;  // skip the final 30s — books thin, can't react
// Scalp play: BTC this far above the strike = deep-OTM NO, cheap enough to scalp.
// DEFAULT OFF — backtested −$169.60 over 52 trades on the old hourly series (see header).
// SCALP_ON=1 to re-enable for research.
const SCALP_ON = process.env.SCALP_ON === '1';
const FAR_LO   = Number(process.env.FAR_LO ?? 250);
const FAR_HI   = Number(process.env.FAR_HI ?? 1000);
const SCALP_FROM_SEC = 300;   // scalp window: middle third of the contract
const SCALP_TO_SEC   = 600;
const SCALP_TP = Number(process.env.SCALP_TP ?? 1.00); // per-position take-profit ($)

// Ask sanity bands (price of the NO we buy)
const SETTLE_ASK_MIN = 0.10, SETTLE_ASK_MAX = 0.85;
const SCALP_ASK_MIN  = 0.03, SCALP_ASK_MAX  = 0.60;

// Per-timeframe candle series: tfMin -> { candles: [{start,open,high,low,close}], forming }
const series = new Map();
TF_MINUTES.forEach(tf => series.set(tf, { candles: [], forming: null }));

const signals = new Map(); // tfMin -> ts of the latest bar-close sell signal
let lastPrice = null;      // most recent BTC price (the "current price" of the spec)

// Wilder's RSI (what Pine's ta.rsi uses: RMA smoothing) over a value series.
// Returns the RSI of the LAST value, or null if not enough data.
function wilderRsi(values, len) {
  if (values.length < len + 1) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= len; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= len; avgLoss /= len;
  for (let i = len + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (len - 1) + Math.max(d, 0)) / len;
    avgLoss = (avgLoss * (len - 1) + Math.max(-d, 0)) / len;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// Evaluate the Pine sellcond on a completed candle series (index n-1 = "current bar").
function sellcond(candles) {
  const n = candles.length;
  if (n < RSI_LEN + 3) return false; // need RSI warmup + a previous bar

  const cur = candles[n - 1], prev = candles[n - 2];

  // bearishEC = close < open[1] and close[1] > open[1]
  const bearishEC = cur.close < prev.open && prev.close > prev.open;
  if (!bearishEC) return false;

  const opens  = candles.map(c => c.open);
  const closes = candles.map(c => c.close);

  const rsio  = wilderRsi(opens, RSI_LEN);                 // ta.rsi(open, 3)
  const rsic  = wilderRsi(closes, RSI_LEN);                // ta.rsi(close, 3)
  const rsipo = wilderRsi(opens.slice(0, -1), RSI_LEN);    // ta.rsi(open[1], 3)
  const rsipc = wilderRsi(closes.slice(0, -1), RSI_LEN);   // ta.rsi(close[1], 3)
  if (rsio === null || rsic === null || rsipo === null || rsipc === null) return false;

  return rsio > OVERBOUGHT && rsio > rsipo && rsic < rsipc;
}

// Fold each price tick into every timeframe's forming candle; when a bucket rolls
// over, the forming candle is complete → append it and evaluate the signal on close.
function recordPrice(price) {
  if (!Number.isFinite(price)) return;
  lastPrice = price;
  const now = Date.now();

  for (const tf of TF_MINUTES) {
    const s = series.get(tf);
    const tfMs = tf * 60 * 1000;
    const bucket = Math.floor(now / tfMs) * tfMs;

    if (!s.forming || s.forming.start !== bucket) {
      if (s.forming) {
        s.candles.push(s.forming);
        if (s.candles.length > MAX_CANDLES) s.candles.shift();
        if (sellcond(s.candles)) signals.set(tf, now);
      }
      s.forming = { start: bucket, open: price, high: price, low: price, close: price };
    } else {
      s.forming.high = Math.max(s.forming.high, price);
      s.forming.low  = Math.min(s.forming.low, price);
      s.forming.close = price;
    }
  }
}

// Seconds until the next quarter-hour resolution (KXBTC15M). Tracks the backtester's
// MockDate, so live and backtest behave identically (as in V7).
function secondsToExpiry() {
  const now = new Date();
  const secondsIntoCycle = (now.getUTCMinutes() * 60 + now.getUTCSeconds()) % CYCLE_SECONDS;
  return CYCLE_SECONDS - secondsIntoCycle;
}

// The live Kalshi API carries the strike as a plain numeric `floor_strike` field, but
// recorded backtest data (fetch-history-15m.js) doesn't capture that field — only
// `subtitle`/`ticker`. KXBTC15M's ticker has no embedded "-T<strike>" suffix at all (unlike
// the old hourly KXBTCD's "$71,750 or above" style), so parse the strike out of `subtitle`
// instead ("Target Price: $62,224.68") — same approach V5 uses, and it works for both live
// and recorded data since both populate subtitle identically (see index.js/fetch-history-15m.js).
function strikeOf(market) {
  if (Number.isFinite(market.floor_strike)) return market.floor_strike;

  const sub = String(market.subtitle || '');
  const sm = sub.match(/([0-9][0-9,]*(?:\.[0-9]+)?)/);
  if (sm) return parseFloat(sm[1].replace(/,/g, ''));

  const m = /-T([\d.]+)$/.exec(market.ticker || ''); // legacy KXBTCD ticker suffix
  return m ? parseFloat(m[1]) : null;
}

function chooseEntry(markets) {
  if (!markets || markets.length === 0 || !Number.isFinite(lastPrice)) return null;

  const now = Date.now();
  const sec = secondsToExpiry();
  if (sec < MIN_SEC_TO_EXPIRY) return null;

  for (const [tf, ts] of signals) {
    if (now - ts > SIGNAL_TTL_MS) continue; // stale bar-close signal

    // ── SETTLE PLAY: late in the hour, BTC barely above a strike ────────────────
    if (sec <= LATE_WINDOW_SEC) {
      let best = null; // strike closest UNDER the current price (most likely to flip)
      for (const m of markets) {
        const strike = strikeOf(m);
        if (strike === null) continue;
        const dist = lastPrice - strike;             // how far BTC is ABOVE the strike
        if (dist <= 0 || dist > NEAR_MAX) continue;  // below strike or too far to flip
        const noAsk = parseFloat(m.no_ask_dollars || 0);
        if (noAsk < SETTLE_ASK_MIN || noAsk > SETTLE_ASK_MAX) continue;
        if (!best || dist < best.dist) best = { market: m, ask: noAsk, dist };
      }
      if (best) {
        signals.delete(tf); // consume — one entry per bar-close signal
        return { market: best.market, side: 'no', ask: best.ask, holdToSettle: true };
      }
      // BTC too far above every strike this late → the dip can't cross in time. No trade.
      continue;
    }

    // ── SCALP PLAY: mid-hour, BTC far above the strike → cheap NO, +$SCALP_TP exit ──
    if (SCALP_ON && sec >= SCALP_FROM_SEC && sec <= SCALP_TO_SEC) {
      let best = null; // smallest distance inside the far band = most dip-sensitive NO
      for (const m of markets) {
        const strike = strikeOf(m);
        if (strike === null) continue;
        const dist = lastPrice - strike;
        if (dist < FAR_LO || dist > FAR_HI) continue;
        const noAsk = parseFloat(m.no_ask_dollars || 0);
        if (noAsk < SCALP_ASK_MIN || noAsk > SCALP_ASK_MAX) continue;
        if (!best || dist < best.dist) best = { market: m, ask: noAsk, dist };
      }
      if (best) {
        signals.delete(tf);
        return { market: best.market, side: 'no', ask: best.ask, takeProfit: SCALP_TP };
      }
    }
  }

  return null;
}

module.exports = {
  name: 'V10 (RSI-3 Sell Signal)',
  chooseEntry,
  recordPrice,
  MIN_PROB: SCALP_ASK_MIN,
  MAX_PROB: SETTLE_ASK_MAX
};
