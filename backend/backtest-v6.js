/**
 * Backtest V6 — uses proper settled-tick accounting (counts wins/losses at expiry)
 * and the same exit logic the other sweeps used so results are directly comparable.
 * Reports both the default Target=$8.50 (the current backtester baseline) and the
 * optimal Target=$4 + tight TP/SL combo discovered for V2.
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

function runOne(ticks, strategy, { TARGET, TP, SL }) {
  const lastBid = new Map();
  const state = { profit: 0, position: null, wins: 0, losses: 0 };
  let cooldown = 0;

  for (const tick of ticks) {
    simulatedTime = tick.timestamp;
    if (typeof strategy.recordPrice === 'function' && Number.isFinite(tick.btcPrice)) {
      strategy.recordPrice(tick.btcPrice);
    }
    const markets = tick.markets;
    if (!markets || markets.length === 0) continue;
    for (const m of markets) lastBid.set(m.ticker, { yes: parseFloat(m.yes_bid_dollars), no: parseFloat(m.no_bid_dollars) });

    if (!state.position && simulatedTime >= cooldown) {
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
        const lb = lastBid.get(state.position.ticker);
        if (!lb) continue;
        bid = state.position.side === 'yes' ? lb.yes : lb.no;
        const p = state.position.numContracts * bid - state.position.cost;
        if (p > 0) state.wins++; else state.losses++;
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

  const configs = [
    { label: 'V6 default (Target=$8.50, TP=$1, SL=-$2)', TARGET: 8.5, TP: 1.0, SL: -2.0 },
    { label: 'V6 optimized (Target=$4, TP=$0.75, SL=-$2)', TARGET: 4, TP: 0.75, SL: -2 },
    { label: 'V6 hold-to-expiry (Target=$4, TP=$0.75, SL=-$5)', TARGET: 4, TP: 0.75, SL: -5 },
  ];

  // Also re-run V1 (which uses same 40-60 band, different selection) for direct comparison
  const stratList = [
    ['V1 (Vol Scalp, 40-60, closest-to-50)', './strategy'],
    ['V6 (High-Band 40-60, highest ask)',    './strategy6'],
  ];

  for (const cfg of configs) {
    console.log(`\n=== ${cfg.label} ===`);
    const rows = [];
    for (const [name, mod] of stratList) {
      const s = freshStrategy(mod);
      const r = runOne(ticks, s, cfg);
      const total = r.wins + r.losses;
      rows.push({
        Strategy: name,
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
