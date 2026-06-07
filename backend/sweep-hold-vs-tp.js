/**
 * Test: at Target=$20 with TP=$3.75 the bid has already moved ~83% of the way to $1.
 * Is it better to hold for full payout, or take the bounce and cycle capital faster?
 * Sweep TP from "tight" to "no TP" while holding SL constant.
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

function pickFav(markets, minAsk, maxAsk) {
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
  const { minAsk, maxAsk, TARGET, TP, SL, skipFirst = 10 } = cfg;
  const lastBid = new Map();
  const state = { profit: 0, position: null, wins: 0, losses: 0, tpExits: 0, slExits: 0, expirySettled: 0 };
  let cooldown = 0;
  for (const tick of ticks) {
    simulatedTime = tick.timestamp;
    const markets = tick.markets;
    if (!markets || markets.length === 0) continue;
    for (const m of markets) lastBid.set(m.ticker, { yes: parseFloat(m.yes_bid_dollars), no: parseFloat(m.no_bid_dollars) });
    const min = new OriginalDate(simulatedTime).getUTCMinutes();
    const timeOk = min >= skipFirst;
    if (!state.position && simulatedTime >= cooldown && timeOk) {
      const e = pickFav(markets, minAsk, maxAsk);
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
        state.expirySettled++;
        state.profit += p;
        cooldown = simulatedTime + (p > 0 ? 5000 : 30000);
        state.position = null;
        continue;
      }
      const p = state.position.numContracts * bid - state.position.cost;
      let r = null;
      if (p >= TP) r = 'TP';
      else if (p <= SL) r = 'SL';
      if (r) {
        state.profit += p;
        if (r === 'TP') { state.wins++; state.tpExits++; cooldown = simulatedTime + 5000; }
        else { state.losses++; state.slExits++; cooldown = simulatedTime + 30000; }
        state.position = null;
      }
    }
  }
  return state;
}

(async () => {
  console.log(`Loading ${DATA}…`);
  const ticks = await loadTicks();
  console.log(`Loaded ${ticks.length} ticks. V2-like (band 0.65-0.78), Target=$20, skip first 10 min, vary TP and SL\n`);

  const BAND = { minAsk: 0.65, maxAsk: 0.78 };
  const configs = [
    { label: 'TP=$3.75 SL=-$10 (current 5×)',          ...BAND, TARGET: 20, TP: 3.75, SL: -10 },
    { label: 'TP=$5.00 SL=-$10',                       ...BAND, TARGET: 20, TP: 5.00, SL: -10 },
    { label: 'TP=$7.00 SL=-$10',                       ...BAND, TARGET: 20, TP: 7.00, SL: -10 },
    { label: 'TP=$8.00 SL=-$10  (≈max upside)',        ...BAND, TARGET: 20, TP: 8.00, SL: -10 },
    { label: 'NO TP (TP=$999) SL=-$10',                ...BAND, TARGET: 20, TP: 999, SL: -10 },
    { label: 'NO TP, NO SL — pure hold-to-expiry',     ...BAND, TARGET: 20, TP: 999, SL: -999 },
    { label: 'TP=$3.75 NO SL — partial exit on bounce', ...BAND, TARGET: 20, TP: 3.75, SL: -999 },
    { label: 'TP=$2.00 NO SL — fast exit on bounce',    ...BAND, TARGET: 20, TP: 2.00, SL: -999 },
  ];

  const rows = configs.map(cfg => {
    const r = runOne(ticks, cfg);
    const total = r.wins + r.losses;
    return {
      Config: cfg.label,
      Trades: total,
      WR: total ? +(r.wins / total * 100).toFixed(1) : 0,
      'TP exits': r.tpExits,
      'SL exits': r.slExits,
      Expiry: r.expirySettled,
      'PnL (7d)': +r.profit.toFixed(2),
      '$/Trade': total ? +(r.profit / total).toFixed(3) : 0,
    };
  });
  rows.sort((a, b) => b['PnL (7d)'] - a['PnL (7d)']);
  console.table(rows);
})();

(async () => {})(); // no-op
