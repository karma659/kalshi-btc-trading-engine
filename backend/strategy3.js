/**
 * Trading Strategy Module - V3 (Momentum / Predictive)
 *
 * Strategy V3:
 *   1. Tracks the live Coinbase BTC price over a short rolling window (5 mins).
 *   2. Calculates price momentum (is BTC trending UP or DOWN?).
 *   3. If trending UP, only looks to buy YES contracts.
 *   4. If trending DOWN, only looks to buy NO contracts.
 *   5. Finds an eligible contract (40%-60% odds) that aligns with the trend.
 */

const MIN_PROB = 0.30;
const MAX_PROB = 0.70;
const WINDOW_MS = 5 * 60 * 1000;   // 5-minute rolling window
const TREND_THRESHOLD_USD = 15.00; // Require the window's two halves to differ by $15+

let priceHistory = []; // stores { ts: number, price: number }

// The poller (index.js) fetches BTC once per cycle and feeds it here — strategies
// no longer make their own network calls, so each API is hit exactly once. Trims
// to the rolling window on every insert.
function recordPrice(price) {
  if (!Number.isFinite(price)) return;
  const now = Date.now();
  priceHistory.push({ ts: now, price });
  priceHistory = priceHistory.filter(p => now - p.ts <= WINDOW_MS);
}

// Trend = drift of the window, measured as (mean of the recent half) − (mean of the
// older half). This reads the actual slope over the window instead of comparing one
// noisy current tick against the whole-window average (which lags and whipsaws).
function getTrend() {
  if (priceHistory.length < 4) return 'FLAT'; // need enough points to split into halves

  const midTs = (priceHistory[0].ts + priceHistory[priceHistory.length - 1].ts) / 2;
  const older  = priceHistory.filter(p => p.ts <  midTs);
  const recent = priceHistory.filter(p => p.ts >= midTs);
  if (older.length < 2 || recent.length < 2) return 'FLAT';

  const mean = arr => arr.reduce((a, p) => a + p.price, 0) / arr.length;
  const diff = mean(recent) - mean(older);

  const latestPrice = priceHistory[priceHistory.length - 1].price;

  // Require both the window averages to show a trend AND the latest price to agree
  if (diff >  TREND_THRESHOLD_USD && latestPrice >= mean(recent)) return 'UP';
  if (diff < -TREND_THRESHOLD_USD && latestPrice <= mean(recent)) return 'DOWN';
  return 'FLAT';
}

function chooseEntry(markets) {
  if (!markets || markets.length === 0) return null;
  if (priceHistory.length === 0) return null; // No BTC price fed yet

  const trend = getTrend();
  if (trend === 'FLAT') return null; // No strong momentum, stay out of the market

  const candidates = [];

  for (const m of markets) {
    const yesAsk = parseFloat(m.yes_ask_dollars || 0);
    const noAsk  = parseFloat(m.no_ask_dollars  || 0);

    const yesEligible = yesAsk >= MIN_PROB && yesAsk <= MAX_PROB;
    const noEligible  = noAsk  >= MIN_PROB && noAsk  <= MAX_PROB;

    // If trend is UP, only consider buying YES
    if (trend === 'UP' && yesEligible) {
      candidates.push({ market: m, side: 'yes', ask: yesAsk, dist: Math.abs(yesAsk - MAX_PROB) });
    }
    // If trend is DOWN, only consider buying NO
    if (trend === 'DOWN' && noEligible) {
      candidates.push({ market: m, side: 'no', ask: noAsk, dist: Math.abs(noAsk - MAX_PROB) });
    }
  }

  if (candidates.length === 0) return null;

  // Sort to find the contract closest to MAX_PROB (60%) for higher win rate
  // Tie break with cheapest price
  candidates.sort((a, b) => {
    if (a.dist !== b.dist) return a.dist - b.dist;
    return a.ask - b.ask;
  });

  const best = candidates[0];
  return { market: best.market, side: best.side, ask: best.ask };
}

module.exports = {
  name: 'V3 (Momentum)',
  chooseEntry,
  recordPrice, // poller feeds the centralized BTC price in here each cycle
  MIN_PROB,
  MAX_PROB
};