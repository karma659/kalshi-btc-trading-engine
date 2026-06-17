/**
 * Kalshi Parallel Backtester (fee-aware)
 *
 * Replays recorded Kalshi order books + BTC prices through the real strategy modules,
 * "time-travelling" by mocking the global Date so each strategy's rolling windows and
 * expiry math behave exactly as they do live.
 *
 * Two things this version fixes so the numbers stop lying:
 *   1. KALSHI FEES are subtracted on both legs (entry + pre-settlement exit; entry-only
 *      when a contract is held to settlement). A >50% win rate means nothing until the
 *      spread + fees are paid — so we report gross, fees, and NET side by side.
 *   2. CONFIG is shared with the live engine: TP/SL/Target come from bot-config.json
 *      (override per-run with env vars TP, SL, TARGET) so backtest == live by default.
 *
 * The exit TRIGGERS on gross PnL (matching the live engine, which triggers on
 * currentValue−cost), then books PnL net of fees — identical accounting to bot.js.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { kalshiFee } = require('./fees');

const strategy1 = require('./strategy');
const strategy3 = require('./strategy3');
const strategy4 = require('./strategy4');
const strategy7 = require('./strategy7');
const strategy8 = require('./strategy8');
const strategy9 = require('./strategy9');

// All strategies by default; set ONLY=V7 (substring match) to isolate one — the realistic
// deployment test, since the live engine runs a single strategy without ticker contention.
// (V2/V5/V6 modules were removed from the repo; they're omitted here to keep it runnable.)
const allStrategies = [strategy1, strategy3, strategy4, strategy7, strategy8, strategy9];
const strategies = process.env.ONLY
  ? allStrategies.filter(s => s.name.toLowerCase().includes(process.env.ONLY.toLowerCase()))
  : allStrategies;

// --- Configuration (shared with the live engine; env overrides for sweeping) ---
let fileCfg = {};
try { fileCfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'past_trades', 'bot-config.json'), 'utf8')); } catch (_) {}
const TARGET_BET  = Number(process.env.TARGET ?? fileCfg.targetBet  ?? 15.50);
const TAKE_PROFIT = Number(process.env.TP     ?? fileCfg.takeProfit ?? 2.00);
const STOP_LOSS   = Number(process.env.SL     ?? fileCfg.stopLoss   ?? -6.80);

// --- State & Tracking ---
const state = { strategies: {} };
const cooldowns = {};
// Last seen bid per ticker. fetch-history appends a synthetic settled tick (bid 1/0) at each
// contract's close, so the LAST bid we saw for a ticker is its true settlement value. We
// resolve held positions against this instead of assuming "YES always wins" on rollover.
const lastSeenBid = new Map(); // ticker -> { yes, no }

strategies.forEach(s => {
  state.strategies[s.name] = {
    totalProfit: 0,   // net of fees
    grossProfit: 0,   // before fees
    fees: 0,
    position: null,
    wins: 0,
    losses: 0,
    trades: 0,
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

// Book a closed trade onto a strategy's tally (net of fees), updating win/loss counts.
function book(st, grossPnl, fees) {
  const net = grossPnl - fees;
  st.grossProfit += grossPnl;
  st.fees += fees;
  st.totalProfit += net;
  st.trades++;
  if (net > 0) st.wins++; else st.losses++;
}

// --- Backtesting Engine ---
function tick(markets, btcPrice, currentTimestamp) {
  simulatedTime = currentTimestamp; // Advance the mock clock

  strategies.forEach(strategy => {
    if (typeof strategy.recordPrice === 'function' && Number.isFinite(btcPrice)) {
      strategy.recordPrice(btcPrice);
    }
  });

  if (!markets || markets.length === 0) return;

  // Remember each ticker's latest bids so we can settle a held position at its true close.
  for (const m of markets) {
    lastSeenBid.set(m.ticker, {
      yes: parseFloat(m.yes_bid_dollars || 0),
      no:  parseFloat(m.no_bid_dollars  || 0),
    });
  }

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
      const pos = stratState.position;
      const myMarket = markets.find(m => m.ticker === pos.ticker);

      // Market settled (expired): pays its TRUE close (last seen bid), entry fee only.
      if (!myMarket) {
        const lb = lastSeenBid.get(pos.ticker);
        const settledBid = lb ? (pos.side === 'yes' ? lb.yes : lb.no)
                              : (pos.side === 'yes' ? 1.00 : 0.00); // last resort only
        const gross = (pos.numContracts * settledBid) - pos.cost;
        const fees = kalshiFee(pos.entryPrice, pos.numContracts);
        book(stratState, gross, fees);
        stratState.position = null;
        // settling at the top of the hour effectively resets; small cooldown either way
        cooldowns[strategy.name] = simulatedTime + (gross - fees > 0 ? 5000 : 30000);
        continue;
      }

      const bid = parseFloat(
        pos.side === 'yes' ? (myMarket.yes_bid_dollars || 0) : (myMarket.no_bid_dollars || 0)
      );

      const grossPnl = (pos.numContracts * bid) - pos.cost; // trigger on gross, like live

      let exitResult = null;
      if (grossPnl >= TAKE_PROFIT) exitResult = 'TP';
      else if (grossPnl <= STOP_LOSS) exitResult = 'SL';

      if (exitResult) {
        const fees = kalshiFee(pos.entryPrice, pos.numContracts) + kalshiFee(bid, pos.numContracts);
        book(stratState, grossPnl, fees);
        stratState.position = null;
        cooldowns[strategy.name] = simulatedTime + (exitResult === 'SL' ? 30000 : 5000);
      }
    }
  }
}

// --- Load Recorded Data & Run Backtest ---
async function runRealBacktest() {
  const dataFile = path.join(__dirname, 'past_trades', 'real_data.jsonl');
  if (!fs.existsSync(dataFile)) {
    console.log("⚠️  No real data found! Let the bot run for a few hours so real_data.jsonl is populated.");
    return;
  }

  console.log(`Config: Target=$${TARGET_BET.toFixed(2)} | TP=+$${TAKE_PROFIT.toFixed(2)} | SL=-$${Math.abs(STOP_LOSS).toFixed(2)}  (override via TP=/SL=/TARGET= env)`);
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

  console.log(`\n=== REAL-DATA BACKTEST SUMMARY (${ticks.toLocaleString()} Ticks, FEE-AWARE) ===`);
  console.table(
    strategies.map(s => {
      const st = state.strategies[s.name];
      const total = st.trades;
      const winRate = total > 0 ? ((st.wins / total) * 100).toFixed(1) + '%' : '0%';
      return {
        Strategy: s.name,
        Trades: total,
        Wins: st.wins,
        Losses: st.losses,
        'Win Rate': winRate,
        Gross: '$' + st.grossProfit.toFixed(2),
        Fees: '$' + st.fees.toFixed(2),
        Net: '$' + st.totalProfit.toFixed(2),
        '$/Trade': total ? '$' + (st.totalProfit / total).toFixed(3) : '$0',
      };
    })
  );
}

runRealBacktest();
