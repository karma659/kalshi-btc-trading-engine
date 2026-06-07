/**
 * Data Quality & Anomaly Detection Module
 * 
 * Monitors inbound financial data feeds for coverage gaps and statistical 
 * time-series drift using a rolling window Z-score calculation.
 */

const DRIFT_WINDOW_SIZE = 60; // Keep last 60 ticks (approx past 3 seconds of data)
const driftHistory = [];      // Rolling window of recent price changes (deltas)

function monitorDataQuality({ freshBtc, prevBtc, currentBtc, btcIsStale, kalshiData }) {
  let hasAnomaly = false;

  // 1. Anomaly Detection on Coverage Gaps
  // NB: a single null fetch is NORMAL (Coinbase is throttled, so most cycles skip it).
  // A real gap is "no usable price at all" — currentBtc still null (startup), or the last
  // good fetch has gone stale (sustained outage). We check those, not the raw fetch.
  if (currentBtc === null) {
    console.warn('[DATA QUALITY] Coverage Gap Detected: no Coinbase BTC price available yet.');
    hasAnomaly = true;
  } else if (btcIsStale) {
    console.warn('[DATA QUALITY] Coverage Gap Detected: Coinbase BTC price is stale (no fresh tick in >2s).');
    hasAnomaly = true;
  }
  if (!kalshiData || !kalshiData._rawMarkets || kalshiData._rawMarkets.length === 0) {
    console.warn('[DATA QUALITY] Coverage Gap Detected: Kalshi market data is empty or missing.');
    hasAnomaly = true;
  }

  // 2. Kalshi Rollover / Liquidity Anomaly (Start of the hour empty books)
  if (kalshiData && kalshiData._rawMarkets && kalshiData._rawMarkets.length > 0) {
    const currentMinute = new Date().getMinutes();
    
    // Check if it's the beginning of a new hour (e.g., xx:00 to xx:02)
    if (currentMinute <= 2) {
      let hasValidLiquidContract = false;
      
      for (const m of kalshiData._rawMarkets) {
        const yesAsk = parseFloat(m.yes_ask_dollars || 0);
        const noAsk = parseFloat(m.no_ask_dollars || 0);
        
        // A healthy, active market has at least one valid ask from market makers
        if ((yesAsk > 0 && yesAsk < 1.0) || (noAsk > 0 && noAsk < 1.0)) {
          hasValidLiquidContract = true;
          break; // We found at least one valid price, the market is populated
        }
      }
      
      if (!hasValidLiquidContract) {
        console.warn(`[DATA QUALITY] Rollover Anomaly: No valid prices found at minute ${currentMinute}. Waiting for market makers.`);
        hasAnomaly = true;
      }
    }
  }

  // 3. Statistical Anomaly Detection on Time Series Drift (Z-Score)
  // Only runs when a genuinely NEW price arrived this cycle (freshBtc non-null and actually
  // different from the prior reading). This keeps the rolling window full of real ~500ms
  // price moves — feeding it zero-deltas from throttled cycles would crush the std dev and
  // make the z-score meaningless.
  if (freshBtc !== null && prevBtc !== null && freshBtc !== prevBtc) {
    const delta = freshBtc - prevBtc;

    if (driftHistory.length >= 10) {
      const mean = driftHistory.reduce((a, b) => a + b, 0) / driftHistory.length;
      const variance = driftHistory.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / driftHistory.length;
      const stdDev = Math.sqrt(variance) || 1; 
      
      const zScore = Math.abs((delta - mean) / stdDev);
      if (zScore > 3.0) {
        console.warn(`[DATA QUALITY] Time Series Drift Anomaly: BTC tick delta ($${delta.toFixed(2)}) exceeded 3-sigma (Z=${zScore.toFixed(2)}). Possible bad tick.`);
        hasAnomaly = true;
      }
    }
    driftHistory.push(delta);
    if (driftHistory.length > DRIFT_WINDOW_SIZE) driftHistory.shift();
  }

  return hasAnomaly;
}

module.exports = { monitorDataQuality };