/**
 * V5 (Fair-Value / Statistical Edge) — models BTC at a KXBTC15M contract's expiry as
 * Normal(spot, σ_T²) to get a fair probability (fairYes = Φ((spot−strike)/σ_T)), then buys
 * whichever side (YES/NO) is most underpriced vs. that fair value, if the edge clears fees.
 * MIN_SAMPLES=30 within a 15-min window needs a price tick every ~30s — recorded backtest
 * data (1 tick/min) can't satisfy this, so it's effectively live-only right now.
 */

const MIN_PROB = 0.02; // display only (engine logs this); real filtering is the edge test below
const MAX_PROB = 0.75;

const VOL_WINDOW_MS    = 15 * 60 * 1000; // history kept for the volatility estimate
const MIN_SAMPLES      = 30;             // need this many price points before trusting σ
const MIN_SPAN_MS      = 60 * 1000;      // ...spanning at least this long
const EDGE_THRESHOLD   = 0.05;           // require ≥5¢ expected profit/contract (covers spread + fees)
const CYCLE_SECONDS    = 900;            // KXBTC15M resolves every 15 min (was 3600 for hourly KXBTCD)
const MIN_SEC_TO_EXPIRY = 120;           // don't trade the final 2 min (σ_T→0 ⇒ overconfident)
const ASK_FLOOR = 0.20;                  // MUST BE >= 0.20 to prevent spread from instantly hitting Stop Loss
const ASK_CEIL  = 0.98;

let priceHistory = []; // { ts, price }

// Fed by the poller once per cycle. Same centralized-price contract as V3/V4.
function recordPrice(price) {
  if (!Number.isFinite(price)) return;
  const now = Date.now();
  priceHistory.push({ ts: now, price });
  priceHistory = priceHistory.filter(p => now - p.ts <= VOL_WINDOW_MS);
}

// ── Math helpers ───────────────────────────────────────────────────────────────

// Error function (Abramowitz & Stegun 7.1.26) → standard normal CDF.
function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function normCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// Seconds until the next quarter-hour resolution. Minutes and seconds are
// timezone-invariant, so any clock works. Tracks the backtester's MockDate, as in V7.
function secondsToExpiry() {
  const now = new Date();
  const secondsIntoCycle = (now.getUTCMinutes() * 60 + now.getUTCSeconds()) % CYCLE_SECONDS;
  return CYCLE_SECONDS - secondsIntoCycle;
}

// Realized-vol estimate of BTC's std-dev over the remaining time, in dollars.
// Sum of squared price increments / elapsed time = diffusion rate; scale to the horizon.
function estimateSigmaToExpiry(secToExp) {
  if (priceHistory.length < MIN_SAMPLES) return null;

  let sumSq = 0, spanMs = 0;
  for (let i = 1; i < priceHistory.length; i++) {
    const dP = priceHistory[i].price - priceHistory[i - 1].price;
    const dt = priceHistory[i].ts   - priceHistory[i - 1].ts;
    if (dt <= 0) continue;
    sumSq  += dP * dP;
    spanMs += dt;
  }
  if (spanMs < MIN_SPAN_MS) return null;

  const varPerMs = sumSq / spanMs;                  // $²/ms
  const sigmaT   = Math.sqrt(varPerMs * secToExp * 1000); // $ over the remaining horizon
  return sigmaT > 0 ? sigmaT : null;
}

// Strike threshold for a market. Prefer the ticker's "-T<number>" suffix; fall back to
// the first number in the subtitle (e.g. "$75,500 or above").
function parseStrike(m) {
  const tk = String(m.ticker || '');
  const tm = tk.match(/-T([0-9]+(?:\.[0-9]+)?)/i);
  if (tm) return parseFloat(tm[1]);

  const sub = String(m.subtitle || '');
  const sm = sub.match(/([0-9][0-9,]*(?:\.[0-9]+)?)/);
  if (sm) return parseFloat(sm[1].replace(/,/g, ''));

  return null;
}

// ── Entry selection ──────────────────────────────────────────────────────────────

function chooseEntry(markets) {
  if (!markets || markets.length === 0) return null;
  if (priceHistory.length === 0) return null;

  const secToExp = secondsToExpiry();
  if (secToExp < MIN_SEC_TO_EXPIRY) return null; // too close to resolution to model safely

  const spot = priceHistory[priceHistory.length - 1].price;
  const sigmaT = estimateSigmaToExpiry(secToExp);
  if (!sigmaT) return null; // not enough history to trust the model yet

  const candidates = [];

  for (const m of markets) {
    const strike = parseStrike(m);
    if (!Number.isFinite(strike)) continue;

    const fairYes = normCdf((spot - strike) / sigmaT);
    const fairNo  = 1 - fairYes;

    const yesAsk = parseFloat(m.yes_ask_dollars || 0);
    const noAsk  = parseFloat(m.no_ask_dollars  || 0);

    if (yesAsk >= ASK_FLOOR && yesAsk <= ASK_CEIL) {
      const edge = fairYes - yesAsk; // expected $ profit per contract
      if (edge >= EDGE_THRESHOLD) candidates.push({ market: m, side: 'yes', ask: yesAsk, edge });
    }
    if (noAsk >= ASK_FLOOR && noAsk <= ASK_CEIL) {
      const edge = fairNo - noAsk;
      if (edge >= EDGE_THRESHOLD) candidates.push({ market: m, side: 'no', ask: noAsk, edge });
    }
  }

  if (candidates.length === 0) return null;

  // Take the single biggest mispricing.
  candidates.sort((a, b) => b.edge - a.edge);
  const best = candidates[0];
  return { market: best.market, side: best.side, ask: best.ask };
}

module.exports = {
  name: 'V5 (Fair-Value / Statistical Edge)',
  chooseEntry,
  recordPrice,
  MIN_PROB,
  MAX_PROB
};
