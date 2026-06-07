/**
 * Sweep entry-ask band for V2 (favorite) and V3 (trend-aligned favorite).
 *
 * Two fixes vs. the previous run:
 *   1. Doesn't call strategy.js — its MIN/MAX_PROB caps at 0.70 and silently kills
 *      bands above that. Instead reimplements "pick strongest favorite in [minAsk,maxAsk]"
 *      (and V3-style trend gate) inline so high bands actually run.
 *   2. Tracks settled trades as wins/losses based on the last seen bid (the synthetic
 *      settled tick I wrote at each event's close_ts already encodes truth — bid=1 or 0).
 *      The backtester's old "settled = ignored in win rate" misreports.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const OriginalDate = global.Date;
let simulatedTime = 0;
class MockDate extends OriginalDate {
  constructor(...args) {
    if (args.length === 0) return new OriginalDate(simulatedTime);
    super(...args);
  }
  static now() { return simulatedTime; }
}
global.Date = MockDate;

const DATA = path.join(__dirname, 'past_trades', 'real_data.jsonl');

async function loadTicks() {
  const ticks = [];
  const rl = readline.createInterface({ input: fs.createReadStream(DATA) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { ticks.push(JSON.parse(line)); } catch (e) {}
  }
  return ticks;
}

// V3-style trend on a 5-min rolling window. Returns 'UP' | 'DOWN' | 'FLAT'.
function makeTrendTracker(windowMs = 5 * 60 * 1000, threshold = 15) {
  let hist = [];
  return {
    record(price) {
      if (!Number.isFinite(price)) return;
      const now = simulatedTime;
      hist.push({ ts: now, price });
      hist = hist.filter(p => now - p.ts <= windowMs);
    },
    trend() {
      if (hist.length < 4) return 'FLAT';
      const midTs = (hist[0].ts + hist[hist.length - 1].ts) / 2;
      const older  = hist.filter(p => p.ts <  midTs);
      const recent = hist.filter(p => p.ts >= midTs);
      if (older.length < 2 || recent.length < 2) return 'FLAT';
      const mean = arr => arr.reduce((a, p) => a + p.price, 0) / arr.length;
      const diff = mean(recent) - mean(older);
      if (diff >  threshold) return 'UP';
      if (diff < -threshold) return 'DOWN';
      return 'FLAT';
    },
  };
}

// Pick the strongest favorite (highest eligible ask) on the side we're allowed to play.
// trendGate='any' lets either side win; 'yes'/'no' restricts.
function chooseFavorite(markets, minAsk, maxAsk, trendGate = 'any') {
  let best = null;
  for (const m of markets) {
    const ya = parseFloat(m.yes_ask_dollars || 0);
    const na = parseFloat(m.no_ask_dollars  || 0);
    if (trendGate !== 'no' && ya >= minAsk && ya <= maxAsk) {
      if (!best || ya > best.ask) best = { market: m, side: 'yes', ask: ya };
    }
    if (trendGate !== 'yes' && na >= minAsk && na <= maxAsk) {
      if (!best || na > best.ask) best = { market: m, side: 'no', ask: na };
    }
  }
  return best;
}

function runOne(ticks, { mode, minAsk, maxAsk, TARGET, TP, SL }) {
  // mode: 'V2-like' (favorite, any side) or 'V3-like' (trend-aligned favorite)
  const trend = mode === 'V3-like' ? makeTrendTracker() : null;
  const lastBid = new Map(); // ticker -> last seen bid object {yesBid, noBid}
  const state = { profit: 0, position: null, wins: 0, losses: 0 };
  let cooldown = 0;

  for (const tick of ticks) {
    simulatedTime = tick.timestamp;
    if (trend) trend.record(tick.btcPrice);
    const markets = tick.markets;
    if (!markets || markets.length === 0) continue;

    // Update last-bid map for any market we currently care about (and prune memory occasionally).
    for (const m of markets) {
      lastBid.set(m.ticker, { yes: parseFloat(m.yes_bid_dollars), no: parseFloat(m.no_bid_dollars) });
    }

    // ENTRY
    if (!state.position && simulatedTime >= cooldown) {
      let gate = 'any';
      if (trend) {
        const t = trend.trend();
        if (t === 'FLAT') gate = null;
        else gate = t === 'UP' ? 'yes' : 'no';
      }
      if (gate !== null) {
        const entry = chooseFavorite(markets, minAsk, maxAsk, gate);
        if (entry) {
          const n = Math.floor(TARGET / entry.ask);
          if (n >= 1) {
            state.position = { ticker: entry.market.ticker, side: entry.side, numContracts: n, cost: n * entry.ask };
          }
        }
      }
    }

    // POSITION MGMT
    if (state.position) {
      const m = markets.find(x => x.ticker === state.position.ticker);
      let bid;
      if (m) {
        bid = parseFloat(state.position.side === 'yes' ? m.yes_bid_dollars : m.no_bid_dollars);
      } else {
        // Ticker disappeared (event rolled over). Use last seen bid — that's the synthetic
        // settled tick I wrote, which already encodes the true outcome (bid=1 or 0).
        const last = lastBid.get(state.position.ticker);
        if (!last) continue;
        bid = state.position.side === 'yes' ? last.yes : last.no;
        // Force-close at last bid.
        const pnl = (state.position.numContracts * bid) - state.position.cost;
        if (pnl > 0) state.wins++; else state.losses++;
        state.profit += pnl;
        cooldown = simulatedTime + (pnl > 0 ? 5000 : 30000);
        state.position = null;
        continue;
      }
      const pnl = (state.position.numContracts * bid) - state.position.cost;
      let res = null;
      if (pnl >= TP) res = 'TP';
      else if (pnl <= SL) res = 'SL';
      if (res) {
        state.profit += pnl;
        if (res === 'TP') { state.wins++; cooldown = simulatedTime + 5000; }
        else { state.losses++; cooldown = simulatedTime + 30000; }
        state.position = null;
      }
    }
  }
  return state;
}

(async () => {
  console.log(`Loading ${DATA}…`);
  const ticks = await loadTicks();
  console.log(`Loaded ${ticks.length} ticks.\n`);

  const bands = [
    [0.50, 0.70], [0.55, 0.70], [0.60, 0.75], [0.65, 0.80],
    [0.70, 0.85], [0.75, 0.90], [0.80, 0.95], [0.85, 0.97], [0.90, 0.97],
  ];

  for (const mode of ['V2-like', 'V3-like']) {
    console.log(`\n========== ${mode}  (Target=$4, TP=$0.75, SL=-$3.99) ==========`);
    const rows = [];
    for (const [minAsk, maxAsk] of bands) {
      const r = runOne(ticks, { mode, minAsk, maxAsk, TARGET: 4, TP: 0.75, SL: -3.99 });
      const total = r.wins + r.losses;
      rows.push({
        Band: `${minAsk.toFixed(2)}–${maxAsk.toFixed(2)}`,
        Trades: total,
        Wins: r.wins, Losses: r.losses,
        WR: total ? +(r.wins / total * 100).toFixed(1) : 0,
        PnL: +r.profit.toFixed(2),
        '$/Trade': total ? +(r.profit / total).toFixed(3) : 0,
      });
    }
    console.table(rows);
  }
})();
