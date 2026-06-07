/**
 * Trailing-stop test: track peak bid since entry; when bid drops `trailCents` below peak,
 * close the position. Aim: capture more upside than fixed TP while exiting before reversal.
 *
 * Trail only ARMS after peak bid > entry ask + arm_cents (so initial spread doesn't trigger).
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
  const {
    minAsk, maxAsk, TARGET, SL,
    trailCents = null,    // null = no trailing
    armCents = 0.02,      // arm trailing only after bid moves armCents above entry ask
    fixedTP = null,       // fixed-TP alternative for comparison
    skipFirst = 10,
  } = cfg;

  const lastBid = new Map();
  const state = { profit: 0, position: null, wins: 0, losses: 0, trailExits: 0, slExits: 0, tpExits: 0, expirySettled: 0 };
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
        if (n >= 1) {
          state.position = {
            ticker: e.market.ticker, side: e.side, numContracts: n, cost: n * e.ask,
            entryAsk: e.ask, peakBid: e.ask, armed: false,
          };
        }
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
      if (bid > state.position.peakBid) state.position.peakBid = bid;
      if (!state.position.armed && state.position.peakBid >= state.position.entryAsk + armCents) state.position.armed = true;

      const pnl = state.position.numContracts * bid - state.position.cost;
      let exit = null;

      if (fixedTP != null && pnl >= fixedTP) exit = 'TP';
      else if (SL != null && pnl <= SL) exit = 'SL';
      else if (trailCents != null && state.position.armed && (state.position.peakBid - bid) >= trailCents) exit = 'TRAIL';

      if (exit) {
        state.profit += pnl;
        if (pnl > 0) state.wins++; else state.losses++;
        if (exit === 'TP') state.tpExits++;
        if (exit === 'SL') state.slExits++;
        if (exit === 'TRAIL') state.trailExits++;
        cooldown = simulatedTime + (pnl > 0 ? 5000 : 30000);
        state.position = null;
      }
    }
  }
  return state;
}

(async () => {
  console.log(`Loading ${DATA}…`);
  const ticks = await loadTicks();
  console.log(`Loaded ${ticks.length} ticks. V2-like band 0.65-0.78, skip first 10 min\n`);

  const tier = [
    { TARGET: 4,  SL: -2,  label: 'Safe T=$4' },
    { TARGET: 20, SL: -10, label: '5× T=$20' },
  ];
  const trails = [0.05, 0.07, 0.10, 0.15, 0.20];

  for (const t of tier) {
    console.log(`\n=== ${t.label} (band 0.65-0.78, SL=${t.SL}) ===`);
    const rows = [];
    // Baselines
    rows.push({
      Strategy: 'Baseline fixed TP',
      'TP/Trail': t.TARGET === 4 ? 'TP=$1.10' : 'TP=$5.00',
      ...stats(runOne(ticks, { minAsk: 0.65, maxAsk: 0.78, TARGET: t.TARGET, SL: t.SL, fixedTP: t.TARGET === 4 ? 1.10 : 5.00 })),
    });
    rows.push({ Strategy: 'Hold to expiry', 'TP/Trail': 'no TP', ...stats(runOne(ticks, { minAsk: 0.65, maxAsk: 0.78, TARGET: t.TARGET, SL: t.SL })) });
    for (const trail of trails) {
      rows.push({
        Strategy: `Trailing only`,
        'TP/Trail': `trail ${(trail*100).toFixed(0)}¢`,
        ...stats(runOne(ticks, { minAsk: 0.65, maxAsk: 0.78, TARGET: t.TARGET, SL: t.SL, trailCents: trail })),
      });
    }
    console.table(rows);
  }

  function stats(r) {
    const total = r.wins + r.losses;
    return {
      Trades: total,
      WR: total ? +(r.wins / total * 100).toFixed(1) : 0,
      TP: r.tpExits, Trail: r.trailExits, SL: r.slExits, Expiry: r.expirySettled,
      'PnL (7d)': +r.profit.toFixed(2),
      '$/Day': +(r.profit / 7).toFixed(2),
    };
  }
})();
