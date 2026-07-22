/**
 * V2 (Favorite) — buys the strongest favorite (ask 0.65–0.78) across all open KXBTC15M
 * markets, betting the side the market already favors keeps drifting toward resolution.
 * No time-to-expiry gate — can enter at any point in the 15-min contract.
 */

const MIN_PROB = 0.65; // favorites only — the side the market prices above 50%
const MAX_PROB = 0.78;

/**
 * Evaluate one market and return its favorite eligible side, or null.
 * Returns { side: 'yes'|'no', ask: number }
 */
function evaluateMarket(m) {
  const yesAsk = parseFloat(m.yes_ask_dollars || 0);
  const noAsk  = parseFloat(m.no_ask_dollars  || 0);

  const yesEligible = yesAsk >= MIN_PROB && yesAsk <= MAX_PROB;
  const noEligible  = noAsk  >= MIN_PROB && noAsk  <= MAX_PROB;

  if (!yesEligible && !noEligible) return null;

  const candidates = [];
  if (yesEligible) candidates.push({ side: 'yes', ask: yesAsk });
  if (noEligible)  candidates.push({ side: 'no',  ask: noAsk  });

  // Stronger favorite = higher ask (rarely both sides sit above 50%; only on a wide
  // spread, which the bot's spread filter rejects anyway).
  candidates.sort((a, b) => b.ask - a.ask);
  return candidates[0];
}

/**
 * Choose the best entry across all markets.
 * Returns { market, side, ask } or null if nothing qualifies.
 */
function chooseEntry(markets) {
  if (!markets || markets.length === 0) return null;

  const candidates = [];
  for (const m of markets) {
    const evaluation = evaluateMarket(m);
    if (evaluation) candidates.push({ market: m, ...evaluation });
  }

  if (candidates.length === 0) return null;

  // Strongest favorite across markets = highest ask.
  candidates.sort((a, b) => b.ask - a.ask);

  const best = candidates[0];
  return { market: best.market, side: best.side, ask: best.ask };
}

module.exports = {
  name: 'V2 (Favorite)',
  chooseEntry,
  MIN_PROB,
  MAX_PROB
};
