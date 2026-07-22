/**
 * V9 (SMI Mean-Reversion) — fades stochastic %K extremes on BTC's price (oversold turning
 * up → buy YES; overbought turning down → buy NO), near 50/50 for max sensitivity.
 * Backtested net-negative — the signal is anti-predictive, not just fee-eaten. Do not deploy.
 */

const WINDOW_MS   = 10 * 60 * 1000; // 10-min lookback (SMI-10 in spirit), testable on 1-min data
const OVERSOLD    = 20;
const OVERBOUGHT  = 80;
const MIN_PROB    = 0.35;
const MAX_PROB    = 0.65;

let priceHistory = []; // { ts, price }

function recordPrice(price) {
  if (!Number.isFinite(price)) return;
  const now = Date.now();
  priceHistory.push({ ts: now, price });
  priceHistory = priceHistory.filter(p => now - p.ts <= WINDOW_MS);
}

// Stochastic %K of the latest price within the window's range.
function stochK(historyTail) {
  const prices = historyTail.map(p => p.price);
  const lo = Math.min(...prices), hi = Math.max(...prices);
  if (hi - lo < 1e-9) return 50;
  return 100 * (prices[prices.length - 1] - lo) / (hi - lo);
}

// Returns 'UP' (oversold turning up), 'DOWN' (overbought turning down), or 'NONE'.
function reversalSignal() {
  if (priceHistory.length < 6) return 'NONE';
  const prev = priceHistory.slice(0, -1);
  const kNow  = stochK(priceHistory);
  const kPrev = stochK(prev);
  if (kPrev <= OVERSOLD   && kNow > kPrev) return 'UP';   // bounced off the low
  if (kPrev >= OVERBOUGHT && kNow < kPrev) return 'DOWN'; // rolled over from the high
  return 'NONE';
}

function chooseEntry(markets) {
  if (!markets || markets.length === 0) return null;
  if (priceHistory.length === 0) return null;

  const sig = reversalSignal();
  if (sig === 'NONE') return null;

  const candidates = [];
  for (const m of markets) {
    const yesAsk = parseFloat(m.yes_ask_dollars || 0);
    const noAsk  = parseFloat(m.no_ask_dollars  || 0);
    if (sig === 'UP'   && yesAsk >= MIN_PROB && yesAsk <= MAX_PROB) {
      candidates.push({ market: m, side: 'yes', ask: yesAsk, dist: Math.abs(yesAsk - 0.50) });
    }
    if (sig === 'DOWN' && noAsk >= MIN_PROB && noAsk <= MAX_PROB) {
      candidates.push({ market: m, side: 'no', ask: noAsk, dist: Math.abs(noAsk - 0.50) });
    }
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.dist - b.dist || a.ask - b.ask);
  const best = candidates[0];
  return { market: best.market, side: best.side, ask: best.ask };
}

module.exports = {
  name: 'V9 (SMI Mean-Reversion)',
  chooseEntry,
  recordPrice,
  MIN_PROB,
  MAX_PROB
};
