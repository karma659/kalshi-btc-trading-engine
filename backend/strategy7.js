/**
 * Trading Strategy Module - V7 (Favorite-Longshot Harvest)
 *
 * Evidence-based, built FROM the data — not theorised. A calibration study over 11,633
 * recorded ticks revealed a strong, monotonic FAVORITE-LONGSHOT BIAS in Kalshi's hourly
 * BTC contracts:
 *
 *     ask 0.05–0.10  → settles ITM only  1.6% of the time   (implied 8%)   ← longshots overpriced
 *     ask 0.85–0.90  → settles ITM      ~95% of the time     (implied 88%)  ← favorites underpriced
 *
 * Retail overpays for cheap lottery-ticket longshots, so the favorite side is left
 * systematically CHEAP. We harvest that by buying the favorite and HOLDING to settlement —
 * no BTC model, no direction. A pure structural/behavioural edge.
 *
 * ⚠️ HOW BIG IS THE EDGE — HONESTLY? Small but real, in-sample. Favorites in 0.85–0.93
 * entered with ~8 min left win ≈94% per trade at an average price ~0.89 — so a ~5% edge
 * (win rate minus price), which IS the favorite-longshot bias. Over ~7 days: +$88 net /
 * +$0.68/trade in a clean one-trade-per-hour test, +$10.65 / +$0.11/trade under realistic
 * continuous entry. The per-trade edge is thin, NEGATIVELY SKEWED (the ~6% of losers each
 * cost a full stake ≈ −$15), and it's ONE 7-day window. A higher band does NOT help:
 * breakeven win rate = price, so buying at 0.97 needs 97% just to break even.
 *
 * Other approaches were built and BACKTESTED WORSE, all for the same reason — a BTC
 * fair-value or technical model can't beat the market's price (when the model disagrees
 * enough to trade, the model is the thing that's wrong): a ladder-implied relative-value
 * variant, an expiry-judgment Normal-CDF variant (−$191), momentum scalping (V3/V4/V8,
 * ≈−$2,000), and SMI mean-reversion (V9). This price-band harvest is the only thing that
 * held up — because it exploits a structural mispricing, not a price prediction.
 *
 * Rules:
 *   1. Trade only the last ~8 min (MIN..MAX_SEC_TO_EXPIRY): favorites reverse less with
 *      little time left; entering earlier was net-negative in-sample.
 *   2. Buy the CHEAPEST contract whose ask sits in [FAV_LO, FAV_HI] — a favorite, but the
 *      one with the most upside still inside the underpriced band. YES or NO qualifies.
 *   3. HOLD to settlement (bot-config.json's hold profile: TP disabled, wide stop). Scalping
 *      forfeits the edge and pays the exit spread + a 2nd fee.
 *
 * Keep it in PAPER and do walk-forward / out-of-sample validation before trusting capital.
 */

// Band is env-overridable for research sweeps (FAV_LO=/FAV_HI=). Higher band = higher win
// rate but smaller wins vs the same rare full-stake losses — win rate alone is not profit.
const FAV_LO = Number(process.env.FAV_LO ?? 0.85); // underpriced-favorite band
const FAV_HI = Number(process.env.FAV_HI ?? 0.93); // best net + highest win rate in the band sweep
const MIN_SEC_TO_EXPIRY = 120;   // skip the final 2 min — can't react, books thin
const MAX_SEC_TO_EXPIRY = 480;   // last ~8 min, the sweet spot (earlier entries reverse more)

// Seconds until the next top-of-the-hour (resolution time). Under the backtester's MockDate
// this tracks simulated time, so live and backtest behave identically.
function secondsToExpiry() {
  const now = new Date();
  return 3600 - (now.getUTCMinutes() * 60 + now.getUTCSeconds());
}

function chooseEntry(markets) {
  if (!markets || markets.length === 0) return null;

  const sec = secondsToExpiry();
  if (sec < MIN_SEC_TO_EXPIRY || sec > MAX_SEC_TO_EXPIRY) return null;

  // Cheapest favorite whose ask is inside the underpriced band, either side.
  let best = null;
  for (const m of markets) {
    const yesAsk = parseFloat(m.yes_ask_dollars || 0);
    const noAsk  = parseFloat(m.no_ask_dollars  || 0);
    if (yesAsk >= FAV_LO && yesAsk <= FAV_HI && (!best || yesAsk < best.ask)) {
      best = { market: m, side: 'yes', ask: yesAsk };
    }
    if (noAsk >= FAV_LO && noAsk <= FAV_HI && (!best || noAsk < best.ask)) {
      best = { market: m, side: 'no', ask: noAsk };
    }
  }
  if (!best) return null;

  return { market: best.market, side: best.side, ask: best.ask };
}

module.exports = {
  name: 'V7 (Favorite-Longshot Harvest)',
  chooseEntry,
  FAV_LO,
  FAV_HI,
  MIN_PROB: FAV_LO,
  MAX_PROB: FAV_HI
};
