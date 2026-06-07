/**
 * Kalshi Parallel Backtester
 * 
 * Evaluates multiple strategies over a historical (or simulated) dataset.
 * Uses "Time-Traveling" by mocking the global Date object so that rolling 
 * windows and expiry calculations in the strategies function normally.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const strategy1 = require('./strategy');
const strategy2 = require('./strategy2');
const strategy3 = require('./strategy3');
const strategy4 = require('./strategy4');
const strategy5 = require('./strategy5');

const strategies = [strategy1, strategy2, strategy3, strategy4, strategy5];

// --- Configuration ---
const TARGET_BET  = 8.50;
const TAKE_PROFIT = 1.00;
const STOP_LOSS   = -2.00;

// --- State & Tracking ---
const state = { strategies: {} };
const cooldowns = {};

strategies.forEach(s => {
  state.strategies[s.name] = { 
    totalProfit: 0, 
    position: null, 
    wins: 0, 
    losses: 0,
    settled: 0,
    trades: [] 
  };
  cooldowns[s.name] = 0;
});

// --- Time-Traveling Setup ---
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

// --- Backtesting Engine ---
function tick(markets, btcPrice, currentTimestamp) {
  simulatedTime = currentTimestamp; // Advance the mock clock

  // Feed price to strategies
  strategies.forEach(strategy => {
    if (typeof strategy.recordPrice === 'function' && Number.isFinite(btcPrice)) {
      strategy.recordPrice(btcPrice);
    }
  });

  if (!markets || markets.length === 0) return;

  let activeTickers = new Set();
  for (const s of strategies) {
    const pos = state.strategies[s.name].position;
    if (pos) activeTickers.add(pos.ticker);
  }

  for (const strategy of strategies) {
    const stratState = state.strategies[strategy.name];
    const cooldown = cooldowns[strategy.name] || 0;

    // 1. ENTRY LOGIC
    if (!stratState.position) {
      if (simulatedTime < cooldown) continue;

      const entry = strategy.chooseEntry(markets);
      if (!entry || activeTickers.has(entry.market.ticker)) continue;

      const { market, ask, side } = entry;

      const numContracts = Math.floor(TARGET_BET / ask);
      if (numContracts < 1) continue;

      activeTickers.add(market.ticker);

      stratState.position = {
        ticker: market.ticker,
        side,
        entryPrice: ask,
        numContracts,
        cost: numContracts * ask,
      };
    }

    // 2. POSITION MANAGEMENT
    if (stratState.position) {
      const myMarket = markets.find(m => m.ticker === stratState.position.ticker);

      // Market settled (expired)
      if (!myMarket) {
        const bidFallback = stratState.position.side === 'yes' ? 1.00 : 0.00;
        const pnl = (stratState.position.numContracts * bidFallback) - stratState.position.cost;
        
        stratState.totalProfit += pnl;
        stratState.settled++;
        stratState.position = null;
        continue;
      }

      const bid = parseFloat(
        stratState.position.side === 'yes' ? (myMarket.yes_bid_dollars || 0) : (myMarket.no_bid_dollars || 0)
      );

      const pnl = (stratState.position.numContracts * bid) - stratState.position.cost;

      let exitResult = null;
      if (pnl >= TAKE_PROFIT) exitResult = 'TP';
      else if (pnl <= STOP_LOSS) exitResult = 'SL';

      if (exitResult) {
        stratState.totalProfit += pnl;
        if (exitResult === 'TP') stratState.wins++;
        if (exitResult === 'SL') stratState.losses++;
        
        stratState.position = null;
        
        // Apply Cooldowns to prevent death loops
        if (exitResult === 'SL') cooldowns[strategy.name] = simulatedTime + 30000;
        if (exitResult === 'TP') cooldowns[strategy.name] = simulatedTime + 5000;
      }
    }
  }
}

// --- Load Recorded Data & Run Backtest ---
async function runRealBacktest() {
  const dataFile = path.join(__dirname, 'past_trades', 'real_data.jsonl');
  if (!fs.existsSync(dataFile)) {
    console.log("⚠️  No real data found! Please let your bot run for a few hours so index.js can populate real_data.jsonl");
    return;
  }
  
  console.log("Loading real recorded Kalshi order books and BTC prices...");
  const fileStream = fs.createReadStream(dataFile);
  const rl = readline.createInterface({ input: fileStream });
  
  let ticks = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const { timestamp, btcPrice, markets } = JSON.parse(line);
      tick(markets, btcPrice, timestamp);
      ticks++;
    } catch (e) {}
  }

  console.log(`\n=== REAL-DATA BACKTEST SUMMARY (${ticks.toLocaleString()} Ticks Analyzed) ===`);
  console.table(
    strategies.map(s => {
      const st = state.strategies[s.name];
      const totalTrades = st.wins + st.losses + st.settled;
      const winRate = totalTrades > 0 ? ((st.wins / totalTrades) * 100).toFixed(1) + '%' : '0%';
      return { Strategy: s.name, Trades: totalTrades, Wins: st.wins, Losses: st.losses, Settled: st.settled, 'Win Rate': winRate, PnL: '$' + st.totalProfit.toFixed(2) };
    })
  );
}

runRealBacktest();