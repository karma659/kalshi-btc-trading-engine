/**
 * V4 (Fast Momentum Scalp) — same idea as V3 but over a 6-second micro-window, for fast
 * breakouts. Can't be validated against recorded 1-tick/min history — live-only.
 */

const MIN_PROB = 0.30;
const MAX_PROB = 0.70;
const WINDOW_MS = 6 * 1000;       // 6-second micro window
const TREND_THRESHOLD_USD = 6.00; // Half-vs-half must differ by $6+. A $2/2s trigger was
                                  // pure jitter — BTC wiggles that much constantly.

let priceHistory = []; // stores { ts: number, price: number }

// Fed by the poller (index.js) once per cycle — no self-fetching, so each API is
// hit exactly once. Trims to the 6-second micro window on every insert.
function recordPrice(price) {
  if (!Number.isFinite(price)) return;
  const now = Date.now();
  priceHistory.push({ ts: now, price });
  priceHistory = priceHistory.filter(p => now - p.ts <= WINDOW_MS);
}

// Same slope read as V3 (recent half vs older half) but over a 6-second window for
// a fast — yet real, not noise — momentum signal.
function getTrend() {
  if (priceHistory.length < 6) return 'FLAT';

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
  if (priceHistory.length === 0) return null; // No BTC price fed yet

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

  // Sort closest to 50% for maximum leverage, tie-break with cheapest price
  candidates.sort((a, b) => {
    if (a.dist !== b.dist) return a.dist - b.dist;
    return a.ask - b.ask;
  });

  const best = candidates[0];
  return { market: best.market, side: best.side, ask: best.ask };
}

module.exports = {
  name: 'V4 (Fast Momentum Scalp)',
  chooseEntry,
  recordPrice, // poller feeds the centralized BTC price in here each cycle
  MIN_PROB,
  MAX_PROB
};