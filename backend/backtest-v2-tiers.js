/**
 * V2 (using the actual strategy2.js file, band 0.65-0.78) across 4 capital tiers
 * with proportional TP and SL. Includes "skip first 10 min" filter via a wrapper.
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

function freshStrategy(p) { delete require.cache[require.resolve(p)]; return require(p); }

function runOne(ticks, strategy, { TARGET, TP, SL, skipFirst = 10 }) {
  const lastBid = new Map();
  const state = { profit: 0, position: null, wins: 0, losses: 0, biggestWin: 0, biggestLoss: 0 };
  let cooldown = 0;

  for (const tick of ticks) {
    simulatedTime = tick.timestamp;
    const markets = tick.markets;
    if (!markets || markets.length === 0) continue;
    for (const m of markets) lastBid.set(m.ticker, { yes: parseFloat(m.yes_bid_dollars), no: parseFloat(m.no_bid_dollars) });

    const min = new OriginalDate(simulatedTime).getUTCMinutes();
    const timeOk = skipFirst === 0 || min >= skipFirst;

    if (!state.position && simulatedTime >= cooldown && timeOk) {
      const e = strategy.chooseEntry(markets);
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
        if (p > 0) { state.wins++; if (p > state.biggestWin) state.biggestWin = p; }
        else       { state.losses++; if (p < state.biggestLoss) state.biggestLoss = p; }
        state.profit += p;
        cooldown = simulatedTime + (p > 0 ? 5000 : 30000);
        state.position = null;
        continue;
      }
      const pnl = state.position.numContracts * bid - state.position.cost;
      let res = null;
      if (pnl >= TP) res = 'TP';
      else if (pnl <= SL) res = 'SL';
      if (res) {
        state.profit += pnl;
        if (res === 'TP') { state.wins++; if (pnl > state.biggestWin) state.biggestWin = pnl; cooldown = simulatedTime + 5000; }
        else { state.losses++; if (pnl < state.biggestLoss) state.biggestLoss = pnl; cooldown = simulatedTime + 30000; }
        state.position = null;
      }
    }
  }
  return state;
}

(async () => {
  const ticks = await loadTicks();
  console.log(`Loaded ${ticks.length} ticks. V2 strategy (band already 0.65-0.78), skip first 10 min.\n`);

  const tiers = [
    { label: 'Tiny     ($2 bankroll)',  TARGET: 2,  TP: 0.55, SL: -1.00 },
    { label: 'Safe     ($4 bankroll)',  TARGET: 4,  TP: 1.10, SL: -2.00 },
    { label: 'Moderate ($8 bankroll)',  TARGET: 8,  TP: 2.20, SL: -4.00 },
    { label: '3×       ($12 bankroll)', TARGET: 12, TP: 3.30, SL: -6.00 },
    { label: '5×       ($20 bankroll)', TARGET: 20, TP: 5.00, SL: -10.00 },
    { label: '10×      ($40 bankroll)', TARGET: 40, TP: 10.00, SL: -20.00 },
  ];

  const rows = [];
  for (const t of tiers) {
    const s = freshStrategy('./strategy2');
    const r = runOne(ticks, s, t);
    const total = r.wins + r.losses;
    rows.push({
      Tier: t.label,
      Target: t.TARGET, TP: t.TP, SL: t.SL,
      Trades: total,
      WR: total ? +(r.wins / total * 100).toFixed(1) : 0,
      'PnL (7d)': +r.profit.toFixed(2),
      '$/Day': +(r.profit / 7).toFixed(2),
      'Biggest Win': +r.biggestWin.toFixed(2),
      'Worst Loss': +r.biggestLoss.toFixed(2),
    });
  }
  console.table(rows);
})();
