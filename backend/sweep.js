/**
 * Grid search over (TARGET_BET, TAKE_PROFIT, STOP_LOSS) for V2 and V3.
 * Reuses the same exit-on-PnL logic the backtester uses, replayed against the
 * 7-day past_trades/real_data.jsonl. Reports top settings per strategy.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// MockDate so strategy timing helpers (V3 rolling window) see simulated time.
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

function freshStrategy(modPath) {
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}

function runOne(ticks, strategy, { TARGET, TP, SL, COOL_SL = 30000, COOL_TP = 5000 }) {
  const state = { profit: 0, position: null, wins: 0, losses: 0, settled: 0 };
  let cooldown = 0;

  for (const tick of ticks) {
    simulatedTime = tick.timestamp;
    if (typeof strategy.recordPrice === 'function' && Number.isFinite(tick.btcPrice)) {
      strategy.recordPrice(tick.btcPrice);
    }
    const markets = tick.markets;
    if (!markets || markets.length === 0) continue;

    if (!state.position && simulatedTime >= cooldown) {
      const entry = strategy.chooseEntry(markets);
      if (entry) {
        const { market, ask, side } = entry;
        const n = Math.floor(TARGET / ask);
        if (n >= 1) {
          state.position = { ticker: market.ticker, side, entryPrice: ask, numContracts: n, cost: n * ask };
        }
      }
    }

    if (state.position) {
      const m = markets.find(x => x.ticker === state.position.ticker);
      if (!m) {
        // Last-resort fallback — backtester's old assumption; with our settled tick this rarely fires
        const bidFallback = state.position.side === 'yes' ? 1.00 : 0.00;
        state.profit += (state.position.numContracts * bidFallback) - state.position.cost;
        state.settled++; state.position = null; continue;
      }
      const bid = parseFloat(state.position.side === 'yes' ? m.yes_bid_dollars : m.no_bid_dollars);
      const pnl = (state.position.numContracts * bid) - state.position.cost;
      let result = null;
      if (pnl >= TP) result = 'TP';
      else if (pnl <= SL) result = 'SL';
      if (result) {
        state.profit += pnl;
        if (result === 'TP') { state.wins++; cooldown = simulatedTime + COOL_TP; }
        else { state.losses++; cooldown = simulatedTime + COOL_SL; }
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

  const TARGETS = [4, 8.5, 17, 25];
  const TPS     = [0.50, 0.75, 1.00, 1.50, 2.00, 3.00, 5.00];
  const SLS     = [-0.50, -1.00, -1.50, -2.00, -3.00, -5.00, -8.00];

  const stratFiles = { V2: './strategy2', V3: './strategy3' };

  for (const [name, modPath] of Object.entries(stratFiles)) {
    console.log(`\n========== ${name} ==========`);
    const rows = [];
    for (const TARGET of TARGETS) {
      for (const TP of TPS) {
        for (const SL of SLS) {
          const strat = freshStrategy(modPath);
          const r = runOne(ticks, strat, { TARGET, TP, SL });
          const trades = r.wins + r.losses + r.settled;
          rows.push({
            Target: TARGET,
            TP, SL,
            Trades: trades,
            WR: trades ? +(r.wins / trades * 100).toFixed(1) : 0,
            PnL: +r.profit.toFixed(2),
          });
        }
      }
    }
    rows.sort((a, b) => b.PnL - a.PnL);
    console.log('Top 10 by PnL:');
    console.table(rows.slice(0, 10));
    console.log('Worst 3:');
    console.table(rows.slice(-3));
    const positive = rows.filter(r => r.PnL > 0).length;
    console.log(`Positive-PnL configs: ${positive}/${rows.length}`);
  }
})();
