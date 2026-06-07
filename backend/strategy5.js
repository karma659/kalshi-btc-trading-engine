/**
 * Trading Strategy Module - V5 (Fair-Value / Statistical Edge)
 *
 * The honest "Renaissance-style" approach: not riskless arbitrage (that barely exists
 * and fees eat it), but a positive-expected-value edge from MISPRICING.
 *
 * A Kalshi "BTC ≥ $X at the top of the hour" contract is a binary option. Its fair
 * probability is computable from three things we already have or can estimate:
 *   • spot  — the live BTC price (fed in via recordPrice)
 *   • strike — parsed from each market's ticker / subtitle
 *   • σ_T   — BTC's volatility over the time remaining, estimated from realized vol
 *
 * Modelling BTC at expiry as Normal(spot, σ_T²) with no drift (sane over < 1 hour):
 *   fairYes = P(end ≥ strike) = Φ((spot − strike) / σ_T)
 *   fairNo  = 1 − fairYes
 *
 * EDGE of buying a side = fairProb − ask  (this IS the per-contract expected profit in $,
 * since the contract pays $1 if right, $0 if wrong). We only enter when that edge clears
 * a threshold big enough to cover the spread + Kalshi fees. We buy whichever side is most
 * underpriced — YES or NO — so we profit from the market being wrong, not from predicting
 * direction. It does NOT win every trade; it's positive-EV if σ is estimated well.
 *
 * NOTE: the edge fully realises at expiry. Paired with the engine's scalp exit, it captures
 * the profit when the market *converges* toward fair value (bid rises → TP); the risk is BTC
 * moving against us first (stop-loss). Positive-EV, not riskless.
 */

const MIN_PROB = 0.02; // display only (engine logs this); real filtering is the edge test below
const MAX_PROB = 0.75;

const VOL_WINDOW_MS    = 15 * 60 * 1000; // history kept for the volatility estimate
const MIN_SAMPLES      = 30;             // need this many price points before trusting σ
const MIN_SPAN_MS      = 60 * 1000;      // ...spanning at least this long
const EDGE_THRESHOLD   = 0.05;           // require ≥5¢ expected profit/contract (covers spread + fees)
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

// Seconds until the next top-of-the-hour (the contract's resolution time). Minutes and
// seconds are timezone-invariant, so any clock works.
function secondsToExpiry() {
  const now = new Date();
  return 3600 - (now.getUTCMinutes() * 60 + now.getUTCSeconds());
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
