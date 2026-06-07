/**
 * V2 with N concurrent positions. Each tick, if we have <N open positions, pick the
 * next best eligible market that isn't already in our book and open a position.
 * Same per-trade exit logic (TP=$0.75 / SL=-$2) and band 0.65-0.78 as the best config.
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

// Returns up to `n` strongest favorites in the band that aren't already held.
function pickCandidates(markets, minAsk, maxAsk, held, n) {
  const cands = [];
  for (const m of markets) {
    if (held.has(m.ticker)) continue;
    const ya = parseFloat(m.yes_ask_dollars || 0);
    const na = parseFloat(m.no_ask_dollars  || 0);
    let best = null;
    if (ya >= minAsk && ya <= maxAsk) best = { market: m, side: 'yes', ask: ya };
    if (na >= minAsk && na <= maxAsk && (!best || na > best.ask)) best = { market: m, side: 'no', ask: na };
    if (best) cands.push(best);
  }
  cands.sort((a, b) => b.ask - a.ask);
  return cands.slice(0, n);
}

function runOne(ticks, { N, TARGET = 4, TP = 0.75, SL = -2, MIN_ASK = 0.65, MAX_ASK = 0.78 }) {
  const lastBid = new Map();
  const positions = new Map(); // ticker -> position
  const cooldownUntil = new Map(); // ticker -> ts (per-market cooldown)
  let profit = 0, wins = 0, losses = 0;
  let openedTotal = 0;

  for (const tick of ticks) {
    simulatedTime = tick.timestamp;
    const markets = tick.markets;
    if (!markets || markets.length === 0) continue;
    for (const m of markets) lastBid.set(m.ticker, { yes: parseFloat(m.yes_bid_dollars), no: parseFloat(m.no_bid_dollars) });

    // ENTRY — fill up to N positions
    if (positions.size < N) {
      const slotsOpen = N - positions.size;
      const held = new Set(positions.keys());
      const cands = pickCandidates(markets, MIN_ASK, MAX_ASK, held, slotsOpen * 3); // small overage in case cooldowns block some
      for (const c of cands) {
        if (positions.size >= N) break;
        if ((cooldownUntil.get(c.market.ticker) || 0) > simulatedTime) continue;
        const n = Math.floor(TARGET / c.ask);
        if (n < 1) continue;
        positions.set(c.market.ticker, { ticker: c.market.ticker, side: c.side, numContracts: n, cost: n * c.ask });
        openedTotal++;
      }
    }

    // MANAGE each open position
    for (const [ticker, pos] of [...positions]) {
      const m = markets.find(x => x.ticker === ticker);
      let bid;
      if (m) bid = parseFloat(pos.side === 'yes' ? m.yes_bid_dollars : m.no_bid_dollars);
      else {
        const lb = lastBid.get(ticker);
        if (!lb) continue;
        bid = pos.side === 'yes' ? lb.yes : lb.no;
        const p = pos.numContracts * bid - pos.cost;
        if (p > 0) wins++; else losses++;
        profit += p;
        cooldownUntil.set(ticker, simulatedTime + (p > 0 ? 5000 : 30000));
        positions.delete(ticker);
        continue;
      }
      const p = pos.numContracts * bid - pos.cost;
      let res = null;
      if (p >= TP) res = 'TP';
      else if (p <= SL) res = 'SL';
      if (res) {
        profit += p;
        if (res === 'TP') { wins++; cooldownUntil.set(ticker, simulatedTime + 5000); }
        else { losses++; cooldownUntil.set(ticker, simulatedTime + 30000); }
        positions.delete(ticker);
      }
    }
  }
  return { profit, wins, losses, openedTotal };
}

(async () => {
  console.log(`Loading ${DATA}…`);
  const ticks = await loadTicks();
  console.log(`Loaded ${ticks.length} ticks. V2-like (0.65-0.78 band, Target=$4, TP=$0.75, SL=-$2)\n`);

  const rows = [];
  for (const N of [1, 2, 3, 5, 8, 12, 20]) {
    const r = runOne(ticks, { N });
    const total = r.wins + r.losses;
    rows.push({
      'Max Concurrent': N,
      Trades: total,
      Wins: r.wins, Losses: r.losses,
      WR: total ? +(r.wins / total * 100).toFixed(1) : 0,
      'PnL (7d)': +r.profit.toFixed(2),
      '$/Day avg': +(r.profit / 7).toFixed(2),
      'Capital req.': +(N * 4).toFixed(2),
    });
  }
  console.table(rows);
})();
