/**
 * V14 (Coin Toss Baseline) — identical to V1 (strategy.js) in every respect except the
 * actual decision: same market eligibility filter (both YES and NO asks must sit in the
 * 0.40-0.60 band), same "one KXBTC15M market at a time" handling, same return shape for
 * bot.js's engine (TP/SL/fees/position-sizing all inherited unchanged from bot.js). The
 * only difference is WHICH side it picks: a literal 50/50 coin flip, not any market or
 * price logic.
 *
 * Purpose: a genuine, live-traded random baseline to compare every other strategy
 * against, instead of assuming "50% win rate" as a theoretical stand-in. Everything
 * this project has measured against a coinflip assumption can now be measured against
 * an actual coinflip, trading identically to V1 in every other mechanical respect.
 */

const MIN_PROB = 0.38;
const MAX_PROB = 0.72;

function evaluateMarket(m) {
  const yesAsk = parseFloat(m.yes_ask_dollars || 0);
  const noAsk  = parseFloat(m.no_ask_dollars  || 0);

  const yesEligible = yesAsk >= MIN_PROB && yesAsk <= MAX_PROB;
  const noEligible  = noAsk  >= MIN_PROB && noAsk  <= MAX_PROB;

  // Same eligibility gate as V1 — both sides must be in the band to qualify.
  if (!yesEligible || !noEligible) return null;

  // The only difference from V1: no market logic decides the side, a coin flip does.
  const side = Math.random() < 0.5 ? 'yes' : 'no';
  const ask = side === 'yes' ? yesAsk : noAsk;
  return { side, ask };
}

function chooseEntry(markets) {
  if (!markets || markets.length === 0) return null;

  const evaluation = evaluateMarket(markets[0]);
  if (!evaluation) return null;

  return { market: markets[0], side: evaluation.side, ask: evaluation.ask };
}

module.exports = {
  name: 'V14 (Coin Toss Baseline)',
  chooseEntry,
  MIN_PROB,
  MAX_PROB
};
