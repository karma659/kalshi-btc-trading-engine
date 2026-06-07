/**
 * Trading Strategy Module
 *
 * Decides which contract to enter and which side (YES/NO) based on configurable rules.
 * Returns { market, side, ask } or null if no good entry found.
 *
 * Current Strategy:
 *   1. Filter contracts where YES or NO ask is in the 40–60% probability range.
 *   2. For each candidate, pick the side closer to 50% (most balanced odds).
 *   3. Among all candidates, pick the one closest to 50% (highest uncertainty
 *      = best chance of a quick price swing for TP).
 *   4. Tie-break by lower ask (more contracts purchasable with the same budget).
 */

const MIN_PROB = 0.37;
const MAX_PROB = 0.64;

function distFromFifty(price) {
  return Math.abs(price - 0.50);
}

/**
 * Evaluate one market and return its best eligible side, or null.
 * Returns { side: 'yes'|'no', ask: number, distFromFifty: number }
 */
function evaluateMarket(m) {
  const yesAsk = parseFloat(m.yes_ask_dollars || 0);
  const noAsk  = parseFloat(m.no_ask_dollars  || 0);

  const yesEligible = yesAsk >= MIN_PROB && yesAsk <= MAX_PROB;
  const noEligible  = noAsk  >= MIN_PROB && noAsk  <= MAX_PROB;

  // Both YES and NO must be within the band to qualify
  if (!yesEligible || !noEligible) return null;

  // Pick the side closer to 50% (most balanced = most uncertain)
  const candidates = [];
  candidates.push({ side: 'yes', ask: yesAsk, distFromFifty: distFromFifty(yesAsk) });
  candidates.push({ side: 'no',  ask: noAsk,  distFromFifty: distFromFifty(noAsk)  });

  candidates.sort((a, b) => {
    // Primary: closer to 50% first
    if (a.distFromFifty !== b.distFromFifty) return a.distFromFifty - b.distFromFifty;
    // Tie-break: cheaper ask first (more contracts)
    return a.ask - b.ask;
  });

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
    if (evaluation) {
      candidates.push({ market: m, ...evaluation });
    }
  }

  if (candidates.length === 0) return null;

  // Among all eligible markets, pick the one closest to 50%
  // Tie-break: lower ask (more contracts for our fixed budget)
  candidates.sort((a, b) => {
    if (a.distFromFifty !== b.distFromFifty) return a.distFromFifty - b.distFromFifty;
    return a.ask - b.ask;
  });

  const best = candidates[0];
  return { market: best.market, side: best.side, ask: best.ask };
}

module.exports = {
  name: 'V1 (Volatility Scalping)',
  chooseEntry,
  MIN_PROB,
  MAX_PROB
};
