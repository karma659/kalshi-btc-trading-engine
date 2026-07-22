/**
 * V7 (Favorite-Longshot Harvest) — buys the cheapest KXBTC15M contract priced as an
 * underpriced favorite (ask in [FAV_LO, FAV_HI]) in the closing seconds of the 15-min
 * contract, and holds to settlement rather than scalping an early exit.
 */

const FAV_LO = Number(process.env.FAV_LO ?? 0.80); // underpriced-favorite band
const FAV_HI = Number(process.env.FAV_HI ?? 0.95);

const CYCLE_SECONDS = 900; // KXBTC15M resolves every 15 minutes
const MIN_SEC_TO_EXPIRY = 30;    // skip the final 30s — can't react, books thin
const MAX_SEC_TO_EXPIRY = 520;   // only trade in the last ~2 minutes

// Seconds until the next quarter-hour resolution. Under the backtester's MockDate this
// tracks simulated time, so live and backtest behave identically.
function secondsToExpiry() {
  const now = new Date();
  const secondsIntoCycle = (now.getUTCMinutes() * 60 + now.getUTCSeconds()) % CYCLE_SECONDS;
  return CYCLE_SECONDS - secondsIntoCycle;
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
