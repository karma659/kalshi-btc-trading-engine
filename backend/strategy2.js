/**
 * Trading Strategy Module - V2 (Favorite)
 *
 * Decides which contract to enter and which side (YES/NO) based on configurable rules.
 * Returns { market, side, ask } or null if no good entry found.
 *
 * Strategy V2 — buy the favorite:
 *   1. Consider only sides the market prices as a *favorite*: ask in the 50–60% band
 *      (implied probability > 50%, but not so steep that a +12¢ TP is out of reach).
 *   2. For each market, take the stronger favorite side (higher ask).
 *   3. Across markets, pick the STRONGEST favorite (highest ask), betting a side the
 *      market already favors keeps drifting toward resolution.
 *   4. Tie-break by lower ask (more contracts for the same budget).
 *
 * NOTE: this replaces the old "Farthest/Closest" version, whose per-market sort
 * (farthest from 50%) and cross-market sort (closest to 50%) contradicted each other.
 * It also avoids the trap of ranking by |ask−0.50|, which can't tell a 42% underdog
 * from a 58% favorite. Here "favorite" means ask > 0.50, full stop. This is the
 * directional-favorite counterpart to V1's coin-flip volatility play.
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
