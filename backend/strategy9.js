/**
 * Trading Strategy Module - V9 (SMI / Stochastic Mean-Reversion)
 *
 * Built from a chart annotated with SMI (Stochastic Momentum Index) swing lows/highs — the
 * classic "fade the extreme" idea: when the oscillator is OVERSOLD and turns up, BTC has
 * pushed too far down and should bounce → bet up; when OVERBOUGHT and turns down → bet down.
 *
 * Implementation note: the SMI/MACD on the chart are pure functions of past price, so this
 * is a mean-reversion rule on the BTC series. We only have one price/min (no OHLC), so we use
 * a Stochastic %K over the window's min/max as the oscillator — equivalent in spirit to SMI.
 *
 *   %K = 100 · (price − min_N) / (max_N − min_N)
 *   BUY-UP   signal: %K was ≤ OVERSOLD and is now turning up   → buy YES near 50% (rises with BTC)
 *   BUY-DOWN signal: %K was ≥ OVERBOUGHT and is now turning down → buy NO  near 50%
 *
 * Near-50% contracts are chosen for max sensitivity (a small BTC bounce moves them most).
 *
 * ⚠️ BACKTEST RESULT: LOSES every config (scalp ≈ −$1,440 to −$1,615; HELD TO SETTLEMENT
 * −$274 at a 37% win rate). The held-to-settlement loss with near-zero fees is the tell: the
 * SMI signal isn't just eaten by costs — it's ANTI-predictive. "Oversold, bounce up" was
 * followed by BTC continuing DOWN more often than not, so fading the extreme buys the losing
 * side. Trading WITH the oscillator instead is just momentum (V8), which also loses. Both
 * directions of the signal lose. Do NOT deploy — kept as a documented negative result.
 *
 * Mean-reversion is the OPPOSITE of the momentum continuation already shown to lose here, so
 * it was a fresh hypothesis — but it still BUYS at the ask, so a scalp exit pays the spread
 * twice. This module only picks the entry; the engine's TP/SL (bot-config.json) handles exit.
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
