/**
 * Try to push V2 past +$32/7d using single-position, single-strategy tweaks:
 *   • Skip first 10 minutes (proven bad window)
 *   • Fine-tune band (small steps around 0.65-0.78)
 *   • Scale Target with proportional TP/SL
 *   • Compound simulation: bankroll-relative sizing each week
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

function pickFavorite(markets, minAsk, maxAsk) {
  let best = null;
  for (const m of markets) {
    const ya = parseFloat(m.yes_ask_dollars || 0);
    const na = parseFloat(m.no_ask_dollars  || 0);
    if (ya >= minAsk && ya <= maxAsk && (!best || ya > best.ask)) best = { market: m, side: 'yes', ask: ya };
    if (na >= minAsk && na <= maxAsk && (!best || na > best.ask)) best = { market: m, side: 'no', ask: na };
  }
  return best;
}

function runOne(ticks, cfg) {
  const { minAsk, maxAsk, TARGET, TP, SL, skipFirst = 0, skipLast = 0 } = cfg;
  const lastBid = new Map();
  const state = { profit: 0, position: null, wins: 0, losses: 0 };
  let cooldown = 0;

  for (const tick of ticks) {
    simulatedTime = tick.timestamp;
    const markets = tick.markets;
    if (!markets || markets.length === 0) continue;
    for (const m of markets) lastBid.set(m.ticker, { yes: parseFloat(m.yes_bid_dollars), no: parseFloat(m.no_bid_dollars) });

    const min = new OriginalDate(simulatedTime).getUTCMinutes();
    const timeOk = min >= skipFirst && min < (60 - skipLast);

    if (!state.position && simulatedTime >= cooldown && timeOk) {
      const e = pickFavorite(markets, minAsk, maxAsk);
      if (e) {
        const n = Math.floor(TARGET / e.ask);
        if (n >= 1) state.position = { ticker: e.market.ticker, side: e.side, numContracts: n, cost: n * e.ask };
      }
    }
    if (state.position) {
      const m = markets.find(x => x.ticker === state.position.ticker);
      let bid;
      if (m) bid = parseFloat(state.position.side === 'yes' ? m.yes_bid_dollars : m.no_bid_dollars);
      else {
        const lb = lastBid.get(state.position.ticker); if (!lb) continue;
        bid = state.position.side === 'yes' ? lb.yes : lb.no;
        const p = state.position.numContracts * bid - state.position.cost;
        if (p > 0) state.wins++; else state.losses++;
        state.profit += p; cooldown = simulatedTime + (p > 0 ? 5000 : 30000); state.position = null; continue;
      }
      const p = state.position.numContracts * bid - state.position.cost;
      let r = null; if (p >= TP) r = 'TP'; else if (p <= SL) r = 'SL';
      if (r) {
        state.profit += p;
        if (r === 'TP') { state.wins++; cooldown = simulatedTime + 5000; }
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

  const configs = [
    // baseline
    { label: 'baseline V2 0.65-0.78 T=$4 TP=$0.75 SL=-$2',                    minAsk: 0.65, maxAsk: 0.78, TARGET: 4,  TP: 0.75, SL: -2 },
    // skip first 10 min
    { label: '+skip first 10 min',                                            minAsk: 0.65, maxAsk: 0.78, TARGET: 4,  TP: 0.75, SL: -2, skipFirst: 10 },
    // skip first 10 + last 5 (skip vol spike)
    { label: '+skip first 10 + last 5 min',                                   minAsk: 0.65, maxAsk: 0.78, TARGET: 4,  TP: 0.75, SL: -2, skipFirst: 10, skipLast: 5 },
    // Wider band (more trades)
    { label: '+wider band 0.60-0.80 +skip first 10',                          minAsk: 0.60, maxAsk: 0.80, TARGET: 4,  TP: 0.75, SL: -2, skipFirst: 10 },
    { label: '+narrower band 0.68-0.76 +skip first 10',                       minAsk: 0.68, maxAsk: 0.76, TARGET: 4,  TP: 0.75, SL: -2, skipFirst: 10 },
    // Scaled target — proportional TP and SL
    { label: '*2× scale (T=$8 TP=$1.50 SL=-$4) +skip 10',                     minAsk: 0.65, maxAsk: 0.78, TARGET: 8,  TP: 1.50, SL: -4, skipFirst: 10 },
    { label: '*3× scale (T=$12 TP=$2.25 SL=-$6) +skip 10',                    minAsk: 0.65, maxAsk: 0.78, TARGET: 12, TP: 2.25, SL: -6, skipFirst: 10 },
    { label: '*5× scale (T=$20 TP=$3.75 SL=-$10) +skip 10',                   minAsk: 0.65, maxAsk: 0.78, TARGET: 20, TP: 3.75, SL: -10, skipFirst: 10 },
    // Hold-to-expiry with bigger target
    { label: '*2× scale, hold-to-expiry (T=$8 TP=$1.50 SL=-$10) +skip 10',    minAsk: 0.65, maxAsk: 0.78, TARGET: 8,  TP: 1.50, SL: -10, skipFirst: 10 },
    { label: '*3× scale, hold-to-expiry (T=$12 TP=$2.25 SL=-$15) +skip 10',   minAsk: 0.65, maxAsk: 0.78, TARGET: 12, TP: 2.25, SL: -15, skipFirst: 10 },
  ];

  const rows = [];
  for (const cfg of configs) {
    const r = runOne(ticks, cfg);
    const total = r.wins + r.losses;
    rows.push({
      Config: cfg.label,
      Trades: total,
      WR: total ? +(r.wins / total * 100).toFixed(1) : 0,
      'PnL (7d)': +r.profit.toFixed(2),
      '$/Day': +(r.profit / 7).toFixed(2),
      Capital: cfg.TARGET,
    });
  }
  rows.sort((a, b) => b['PnL (7d)'] - a['PnL (7d)']);
  console.table(rows);
})();
