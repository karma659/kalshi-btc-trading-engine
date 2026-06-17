/**
 * Trading Strategy Module - V8 (Momentum Capture, small-profit exit)
 *
 * Built on request: ride BTC momentum and scalp a small, quick profit.
 *   1. Track BTC over a short rolling window; read the slope (recent half vs older half).
 *   2. Trend UP  → buy YES;  trend DOWN → buy NO.
 *   3. Pick the contract CLOSEST to 50% in the trend direction — highest sensitivity, so a
 *      small BTC move produces the biggest contract-price move (fastest path to a small TP).
 *   4. Exit is handled by the engine's TP/SL (set in bot-config.json).
 *
 * ⚠️ BACKTEST RESULT: LOSES ~$1.50 PER TRADE, every exit config. Over ~7 days it ran
 * ~1,300–1,600 trades and netted −$2,000 to −$2,455, with ~$1,400–1,700 of that being pure
 * FEES. It is even negative BEFORE fees (no momentum edge). Do NOT deploy. Kept as a
 * documented negative result. The reason, in one line:
 *
 * ⚠️ A scalp BUYS at the ask and SELLS at the bid, so it pays the full bid-ask spread + a fee
 * on BOTH legs — ≈5.8¢/contract round-trip on these ~50% books. A "small profit" target
 * smaller than that loses on every round trip regardless of whether the momentum call was
 * right. Same reason V3/V4 (the existing momentum scalpers) backtested net-negative.
 */

const WINDOW_MS = 3 * 60 * 1000;    // 3-min window (testable on 1-min backtest data)
const TREND_THRESHOLD_USD = 12.00;  // recent-half vs older-half mean must differ by this
const MIN_PROB = 0.35;
const MAX_PROB = 0.65;              // near-coinflip = max price sensitivity to BTC moves

let priceHistory = []; // { ts, price }

function recordPrice(price) {
  if (!Number.isFinite(price)) return;
  const now = Date.now();
  priceHistory.push({ ts: now, price });
  priceHistory = priceHistory.filter(p => now - p.ts <= WINDOW_MS);
}

// Slope of the window: mean(recent half) − mean(older half).
function getTrend() {
  if (priceHistory.length < 4) return 'FLAT';
  const midTs = (priceHistory[0].ts + priceHistory[priceHistory.length - 1].ts) / 2;
  const older  = priceHistory.filter(p => p.ts <  midTs);
  const recent = priceHistory.filter(p => p.ts >= midTs);
  if (older.length < 2 || recent.length < 2) return 'FLAT';
  const mean = arr => arr.reduce((a, p) => a + p.price, 0) / arr.length;
  const diff = mean(recent) - mean(older);
  if (diff >  TREND_THRESHOLD_USD) return 'UP';
  if (diff < -TREND_THRESHOLD_USD) return 'DOWN';
  return 'FLAT';
}

function chooseEntry(markets) {
  if (!markets || markets.length === 0) return null;
  if (priceHistory.length === 0) return null;

  const trend = getTrend();
  if (trend === 'FLAT') return null;

  const candidates = [];
  for (const m of markets) {
    const yesAsk = parseFloat(m.yes_ask_dollars || 0);
    const noAsk  = parseFloat(m.no_ask_dollars  || 0);
    if (trend === 'UP' && yesAsk >= MIN_PROB && yesAsk <= MAX_PROB) {
      candidates.push({ market: m, side: 'yes', ask: yesAsk, dist: Math.abs(yesAsk - 0.50) });
    }
    if (trend === 'DOWN' && noAsk >= MIN_PROB && noAsk <= MAX_PROB) {
      candidates.push({ market: m, side: 'no', ask: noAsk, dist: Math.abs(noAsk - 0.50) });
    }
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.dist - b.dist || a.ask - b.ask);
  const best = candidates[0];
  return { market: best.market, side: best.side, ask: best.ask };
}

module.exports = {
  name: 'V8 (Momentum Capture)',
  chooseEntry,
  recordPrice,
  MIN_PROB,
  MAX_PROB
};
