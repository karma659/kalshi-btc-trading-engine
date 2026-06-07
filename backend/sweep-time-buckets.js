/**
 * Split V2's trades by time-into-event (early / middle / late) to find the best window.
 * Uses the best config: Target=$4, TP=$0.75, SL=-$2, band 0.65-0.78.
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

// V2-style: pick strongest favorite in [minAsk, maxAsk]
function chooseFavorite(markets, minAsk, maxAsk) {
  let best = null;
  for (const m of markets) {
    const ya = parseFloat(m.yes_ask_dollars || 0);
    const na = parseFloat(m.no_ask_dollars  || 0);
    if (ya >= minAsk && ya <= maxAsk && (!best || ya > best.ask)) best = { market: m, side: 'yes', ask: ya };
    if (na >= minAsk && na <= maxAsk && (!best || na > best.ask)) best = { market: m, side: 'no',  ask: na };
  }
  return best;
}

function utcMin(ms) { return new OriginalDate(ms).getUTCMinutes(); }

function runBucket(ticks, { minMin, maxMin, label, minAsk = 0.65, maxAsk = 0.78, TARGET = 4, TP = 0.75, SL = -2 }) {
  const lastBid = new Map();
  const state = { profit: 0, position: null, wins: 0, losses: 0 };
  let cooldown = 0;
  for (const tick of ticks) {
    simulatedTime = tick.timestamp;
    const markets = tick.markets;
    if (!markets || markets.length === 0) continue;
    for (const m of markets) lastBid.set(m.ticker, { yes: parseFloat(m.yes_bid_dollars), no: parseFloat(m.no_bid_dollars) });

    const min = utcMin(simulatedTime);
    const inWindow = min >= minMin && min <= maxMin;

    if (!state.position && simulatedTime >= cooldown && inWindow) {
      const e = chooseFavorite(markets, minAsk, maxAsk);
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
  const total = state.wins + state.losses;
  return {
    Window: label,
    Trades: total,
    WR: total ? +(state.wins / total * 100).toFixed(1) : 0,
    PnL: +state.profit.toFixed(2),
    '$/Trade': total ? +(state.profit / total).toFixed(3) : 0,
  };
}

(async () => {
  console.log(`Loading ${DATA}…`);
  const ticks = await loadTicks();
  console.log(`Loaded ${ticks.length} ticks. Using best V2 config: band 0.65-0.78, Target=$4, TP=$0.75, SL=-$2\n`);

  const buckets = [
    { minMin: 0,  maxMin: 9,  label: 'first 10 min (00–09)' },
    { minMin: 10, maxMin: 19, label: 'min 10–19' },
    { minMin: 20, maxMin: 29, label: 'min 20–29' },
    { minMin: 30, maxMin: 39, label: 'min 30–39' },
    { minMin: 40, maxMin: 49, label: 'min 40–49' },
    { minMin: 50, maxMin: 59, label: 'min 50–59 (last 10 — incl settlement)' },
    { minMin: 0,  maxMin: 19, label: 'first 20 min' },
    { minMin: 20, maxMin: 39, label: 'middle 20 min' },
    { minMin: 40, maxMin: 59, label: 'last 20 min' },
    { minMin: 0,  maxMin: 39, label: 'first 40 min' },
    { minMin: 0,  maxMin: 59, label: 'WHOLE HOUR (baseline)' },
  ];

  const rows = buckets.map(b => runBucket(ticks, b));
  console.table(rows);
})();
