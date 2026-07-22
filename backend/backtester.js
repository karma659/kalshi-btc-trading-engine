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
 * The exit TRIGGERS on net-of-fees PnL (matching bot.js — a configured TP/SL means real
 * achievable dollars, not gross price movement), and also suppresses stop-loss while BTC
 * is within NEAR_STRIKE_USD of the strike (also matching bot.js).
 *
 * Reads past_trades/real_data_15m.jsonl by default (built by fetch-history-15m.js from
 * the current KXBTC15M series) — override with DATA_FILE=<name> for any other recording.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { kalshiFee } = require('./fees');

// Evaluation must not silently overwrite the live learner. Explicitly pass
// V15_PERSIST=true when the replay is intended as an offline training run.
if (process.env.V15_PERSIST === undefined) process.env.V15_PERSIST = 'false';

const strategy1 = require('./strategy');
const strategy2 = require('./strategy2');
const strategy3 = require('./strategy3');
const strategy4 = require('./strategy4');
const strategy5 = require('./strategy5');
const strategy6 = require('./strategy6');
const strategy7 = require('./strategy7');
const strategy8 = require('./strategy8');
const strategy9 = require('./strategy9');
const strategy10 = require('./strategy10');
const strategy12 = require('./strategy12');
const strategy13 = require('./strategy13');
const strategy15 = require('./strategy15');

// All strategies by default; set ONLY=V7 (substring match) to isolate one, or ONLY=V7,V10
// (comma-separated) to isolate the exact set bot.js runs live — the realistic deployment
// test, since the live engine only guards ticker contention between its own strategies.
const allStrategies = [strategy1, strategy2, strategy3, strategy4, strategy5, strategy6, strategy7, strategy8, strategy9, strategy10, strategy12, strategy13, strategy15];
const strategies = process.env.ONLY
  ? allStrategies.filter(s => process.env.ONLY.toLowerCase().split(',').some(tok => s.name.toLowerCase().includes(tok.trim())))
  : allStrategies;

// --- Configuration (shared with the live engine; env overrides for sweeping) ---
let fileCfg = {};
try { fileCfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'past_trades', 'bot-config.json'), 'utf8')); } catch (_) {}
const TARGET_BET  = Number(process.env.TARGET ?? fileCfg.targetBet  ?? 15.50);
const TAKE_PROFIT = Number(process.env.TP     ?? fileCfg.takeProfit ?? 2.00);
const STOP_LOSS   = Number(process.env.SL     ?? fileCfg.stopLoss   ?? -6.80);
const NEAR_STRIKE_USD = Number(process.env.NEAR_STRIKE ?? fileCfg.nearStrikeUsd ?? 35); // matches bot.js's SL suppression

// Same fallback as bot.js/strategy5.js/strategy10.js: prefer the numeric `floor_strike`
// field; recorded data only has `subtitle` ("Target Price: $62,059.76").
function strikeOf(market) {
  if (Number.isFinite(market?.floor_strike)) return market.floor_strike;
  const sub = String(market?.subtitle || '');
  const sm = sub.match(/([0-9][0-9,]*(?:\.[0-9]+)?)/);
  return sm ? parseFloat(sm[1].replace(/,/g, '')) : null;
}

// --- State & Tracking ---
const state = { strategies: {} };
const cooldowns = {};
// Last seen bid per ticker. fetch-history-15m appends a synthetic settled tick (bid 1/0)
// at each contract's close, so the LAST bid we saw for a ticker is its true settlement
// value. We resolve held positions against this instead of assuming "YES always wins".
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
    history: [],     // per-trade detail — dump with TRADES=<name substring>
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

// Book a closed trade onto a strategy's tally (net of fees), updating win/loss counts,
// and record the full per-trade detail for later inspection (TRADES=<name> dumps it).
function book(st, grossPnl, fees, detail) {
  const net = grossPnl - fees;
  st.grossProfit += grossPnl;
  st.fees += fees;
  st.totalProfit += net;
  st.trades++;
  if (net > 0) st.wins++; else st.losses++;
  st.history.push({ ...detail, grossPnl, fees, net, win: net > 0 });
  return { ...detail, pnl: net };
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
        // Per-position exit overrides (e.g. V10: scalp TP vs hold-to-settlement)
        takeProfit: entry.takeProfit,
        holdToSettle: !!entry.holdToSettle,
        enteredAt: simulatedTime,
      };
      if (typeof strategy.onPositionOpened === 'function') strategy.onPositionOpened(stratState.position, market);
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
        const closedTrade = book(stratState, gross, fees, {
          ticker: pos.ticker, side: pos.side, entryPrice: pos.entryPrice, exitPrice: settledBid,
          contracts: pos.numContracts, exitType: 'SETTLED', enteredAt: pos.enteredAt, exitedAt: simulatedTime,
        });
        if (typeof strategy.onTradeClosed === 'function') strategy.onTradeClosed(closedTrade);
        stratState.position = null;
        // settling at the top of the hour effectively resets; small cooldown either way
        cooldowns[strategy.name] = simulatedTime + (gross - fees > 0 ? 5000 : 30000);
        continue;
      }

      const bid = parseFloat(
        pos.side === 'yes' ? (myMarket.yes_bid_dollars || 0) : (myMarket.no_bid_dollars || 0)
      );

      const grossPnl = (pos.numContracts * bid) - pos.cost;
      // Trigger on NET pnl — matching bot.js's fixed accounting. Kalshi's fee is deducted
      // the instant a trade fills (entry AND any pre-settlement exit; settlement itself is
      // fee-free), not tallied separately afterward, so the TP/SL thresholds must compare
      // against what would actually be booked if closed right now, not gross price movement.
      const fees  = kalshiFee(pos.entryPrice, pos.numContracts) + kalshiFee(bid, pos.numContracts);
      const netPnl = grossPnl - fees;

      // holdToSettle positions never take profit early (settlement pays the full $1
      // with no exit fee); the stop-loss still applies as a disaster brake.
      const tpLimit = pos.takeProfit ?? TAKE_PROFIT;

      // Suppress stop-loss while BTC is still within NEAR_STRIKE_USD of the strike — the
      // outcome is still genuinely undecided this close (matches bot.js).
      const strike = strikeOf(myMarket);
      const nearStrike = Number.isFinite(strike) && Number.isFinite(btcPrice)
        && Math.abs(btcPrice - strike) <= NEAR_STRIKE_USD;

      let exitResult = null;
      const maxProfit = (1 - pos.entryPrice) * pos.numContracts - kalshiFee(pos.entryPrice, pos.numContracts);
      const learnedExit = typeof strategy.chooseExit === 'function'
        ? strategy.chooseExit({ position: pos, market: myMarket, btcPrice, bid, grossPnl, netPnl, maxProfit })
        : null;
      if (learnedExit?.exit) exitResult = learnedExit.result || 'RL_EXIT';
      else if (!pos.holdToSettle && netPnl >= tpLimit) exitResult = 'TP';
      else if (netPnl <= STOP_LOSS && !nearStrike) exitResult = 'SL';

      if (exitResult) {
        const closedTrade = book(stratState, grossPnl, fees, {
          ticker: pos.ticker, side: pos.side, entryPrice: pos.entryPrice, exitPrice: bid,
          contracts: pos.numContracts, exitType: exitResult, enteredAt: pos.enteredAt, exitedAt: simulatedTime,
        });
        if (typeof strategy.onTradeClosed === 'function') strategy.onTradeClosed(closedTrade);
        stratState.position = null;
        cooldowns[strategy.name] = simulatedTime + (exitResult === 'SL' ? 30000 : 5000);
      }
    }
  }
}

// --- Load Recorded Data & Run Backtest ---
async function runRealBacktest() {
  const dataFile = path.join(__dirname, 'past_trades', process.env.DATA_FILE || 'real_data_15m.jsonl');
  if (!fs.existsSync(dataFile)) {
    console.log("⚠️  No real data found! Run `DAYS=7 node fetch-history-15m.js` to build it first.");
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

  // TRADES=<name substring> dumps every individual trade for matching strategies.
  if (process.env.TRADES) {
    const wanted = strategies.filter(s => s.name.toLowerCase().includes(process.env.TRADES.toLowerCase()));
    wanted.forEach(s => {
      const st = state.strategies[s.name];
      console.log(`\n=== ${s.name} — ${st.history.length} trade(s) ===`);
      if (st.history.length === 0) return;
      console.table(st.history.map((h, i) => ({
        '#': i + 1,
        Ticker: h.ticker,
        Side: h.side.toUpperCase(),
        Entry: '$' + h.entryPrice.toFixed(2),
        Exit: '$' + h.exitPrice.toFixed(2),
        Contracts: h.contracts,
        Type: h.exitType,
        Gross: (h.grossPnl >= 0 ? '+' : '') + '$' + h.grossPnl.toFixed(2),
        Fees: '$' + h.fees.toFixed(2),
        Net: (h.net >= 0 ? '+' : '') + '$' + h.net.toFixed(2),
        Result: h.win ? 'WIN' : 'LOSS',
        EnteredAt: new Date(h.enteredAt).toISOString(),
        ExitedAt: new Date(h.exitedAt).toISOString(),
      })));
    });
  }
}

runRealBacktest();
