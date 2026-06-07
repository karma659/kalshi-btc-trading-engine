/**
 * Compare all 5 strategies, but only trade in the LAST 20 MINUTES of each event.
 * Each hourly event closes at UTC :00 → "last 20 mins" = minutes 40-59 of the prior hour.
 * Reuses original strategy files; same TP/SL/Target across strategies for a fair compare.
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

// "Last 20 minutes" filter — only allow entries when UTC minute ≥ 40. We still feed
// price/position-mgmt every tick so trades opened in the window can exit anywhere.
function inLast20(tsMs) {
  return new OriginalDate(tsMs).getUTCMinutes() >= 40;
}

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

    // ENTRY — restricted to last 20 min of event window
    if (!state.position && simulatedTime >= cooldown && inLast20(simulatedTime)) {
      const entry = strategy.chooseEntry(markets);
      if (entry) {
        const n = Math.floor(TARGET / entry.ask);
        if (n >= 1) state.position = { ticker: entry.market.ticker, side: entry.side, numContracts: n, cost: n * entry.ask };
      }
    }

    if (state.position) {
      const m = markets.find(x => x.ticker === state.position.ticker);
      let bid;
      if (m) {
        bid = parseFloat(state.position.side === 'yes' ? m.yes_bid_dollars : m.no_bid_dollars);
      } else {
        const last = lastBid.get(state.position.ticker);
        if (!last) continue;
        bid = state.position.side === 'yes' ? last.yes : last.no;
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
  console.log(`Loaded ${ticks.length} ticks. Filtering entries to last 20 min of each event.\n`);

  const cfg = { TARGET: 4, TP: 0.75, SL: -2 };
  console.log(`Common settings: Target=$${cfg.TARGET}, TP=$${cfg.TP}, SL=$${cfg.SL}\n`);

  const strats = [
    ['V1 (Volatility Scalping)', './strategy'],
    ['V2 (Favorite)',            './strategy2'],
    ['V3 (Momentum)',            './strategy3'],
    ['V4 (Fast Momentum Scalp)', './strategy4'],
    ['V5 (Fair-Value)',          './strategy5'],
  ];
  const rows = [];
  for (const [name, mod] of strats) {
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
})();
