/**
 * V6 (High-Band 40-60) — among near-coinflip KXBTC15M contracts (ask 40-60%), buys the
 * most expensive side (closest to 60%).
 */

const MIN_PROB = 0.40;
const MAX_PROB = 0.60;

/**
 * Evaluate one market and return its best eligible side, or null.
 * Returns { side: 'yes'|'no', ask: number }
 */
function evaluateMarket(m) {
  const yesAsk = parseFloat(m.yes_ask_dollars || 0);
  const noAsk  = parseFloat(m.no_ask_dollars  || 0);

  const yesEligible = yesAsk >= MIN_PROB && yesAsk <= MAX_PROB;
  const noEligible  = noAsk  >= MIN_PROB && noAsk  <= MAX_PROB;

  // Both YES and NO must be within the 40% to 60% band to qualify
  if (!yesEligible || !noEligible) return null;

  const candidates = [];
  candidates.push({ side: 'yes', ask: yesAsk });
  candidates.push({ side: 'no',  ask: noAsk  });

  // Sort by highest ask (most expensive / "greater" probability)
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
    if (evaluation) {
      candidates.push({ market: m, ...evaluation });
    }
  }

  if (candidates.length === 0) return null;

  // Pick the most expensive contract among all eligible markets
  candidates.sort((a, b) => b.ask - a.ask);

  const best = candidates[0];
  return { market: best.market, side: best.side, ask: best.ask };
}

module.exports = {
  name: 'V6 (High-Band 40-60)',
  chooseEntry,
  MIN_PROB,
  MAX_PROB
};