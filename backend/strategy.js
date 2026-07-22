/**
 * V1 (Volatility Scalping) — buys the KXBTC15M contract closest to a 50/50 coin-flip
 * price, betting on a quick swing for a take-profit.
 */

const MIN_PROB = 0.40;
const MAX_PROB = 0.60;

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

  // Pick the side closer to 50% (most balanced = most uncertain); tie-break on cheaper ask.
  const yes = { side: 'yes', ask: yesAsk, distFromFifty: distFromFifty(yesAsk) };
  const no  = { side: 'no',  ask: noAsk,  distFromFifty: distFromFifty(noAsk)  };
  if (yes.distFromFifty !== no.distFromFifty) return yes.distFromFifty > no.distFromFifty ? yes : no;
  return yes.ask <= no.ask ? yes : no;
}


/**
 * KXBTC15M only ever has one open market at a time, so there's nothing to pick between —
 * just evaluate it. Returns { market, side, ask } or null if it doesn't qualify.
 */
function chooseEntry(markets) {
  if (!markets || markets.length === 0) return null;

  const evaluation = evaluateMarket(markets[0]);
  if (!evaluation) return null;

  return { market: markets[0], side: evaluation.side, ask: evaluation.ask };
}

module.exports = {
  name: 'V1 (Volatility Scalping)',
  chooseEntry,
  MIN_PROB,
  MAX_PROB
};
