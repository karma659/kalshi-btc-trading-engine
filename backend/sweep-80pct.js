/**
 * Targeted sweep aimed at 80% win rate with positive PnL.
 * Hypotheses being tested:
 *   1. Tighter "favorite" band — narrower entry window concentrates on a sweet spot.
 *   2. Real SL (e.g. -$1.50) protects from full-loss settlements that drag PnL.
 *   3. "2nd-strongest" pick instead of "strongest" — avoids the most-overpriced contract.
 *   4. V2+V3 hybrid: favorite AND trend-aligned (extra signal).
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

function makeTrendTracker(windowMs = 5 * 60 * 1000, threshold = 15) {
  let hist = [];
  return {
    record(price) {
      if (!Number.isFinite(price)) return;
      const now = simulatedTime;
      hist.push({ ts: now, price });
      hist = hist.filter(p => now - p.ts <= windowMs);
    },
    trend() {
      if (hist.length < 4) return 'FLAT';
      const midTs = (hist[0].ts + hist[hist.length - 1].ts) / 2;
      const older  = hist.filter(p => p.ts <  midTs);
      const recent = hist.filter(p => p.ts >= midTs);
      if (older.length < 2 || recent.length < 2) return 'FLAT';
      const mean = arr => arr.reduce((a, p) => a + p.price, 0) / arr.length;
      const diff = mean(recent) - mean(older);
      if (diff >  threshold) return 'UP';
      if (diff < -threshold) return 'DOWN';
      return 'FLAT';
    },
  };
}

// Pick: 'strongest' (highest ask) | '2nd' (second-highest) | 'closest-mid' (closest to (min+max)/2)
function pickFavorite(markets, minAsk, maxAsk, trendGate, pick) {
  const cands = [];
  for (const m of markets) {
    const ya = parseFloat(m.yes_ask_dollars || 0);
    const na = parseFloat(m.no_ask_dollars  || 0);
    if (trendGate !== 'no' && ya >= minAsk && ya <= maxAsk) cands.push({ market: m, side: 'yes', ask: ya });
    if (trendGate !== 'yes' && na >= minAsk && na <= maxAsk) cands.push({ market: m, side: 'no', ask: na });
  }
  if (!cands.length) return null;
  if (pick === 'strongest') {
    cands.sort((a, b) => b.ask - a.ask); return cands[0];
  }
  if (pick === '2nd') {
    cands.sort((a, b) => b.ask - a.ask); return cands[1] || cands[0];
  }
  if (pick === 'closest-mid') {
    const mid = (minAsk + maxAsk) / 2;
    cands.sort((a, b) => Math.abs(a.ask - mid) - Math.abs(b.ask - mid)); return cands[0];
  }
  return cands[0];
}

function runOne(ticks, cfg) {
  const { mode, minAsk, maxAsk, TARGET, TP, SL, pick = 'strongest' } = cfg;
  const trend = mode === 'V3-like' || mode === 'hybrid' ? makeTrendTracker() : null;
  const lastBid = new Map();
  const state = { profit: 0, position: null, wins: 0, losses: 0 };
  let cooldown = 0;

  for (const tick of ticks) {
    simulatedTime = tick.timestamp;
    if (trend) trend.record(tick.btcPrice);
    const markets = tick.markets;
    if (!markets || markets.length === 0) continue;
    for (const m of markets) lastBid.set(m.ticker, { yes: parseFloat(m.yes_bid_dollars), no: parseFloat(m.no_bid_dollars) });

    if (!state.position && simulatedTime >= cooldown) {
      let gate = 'any';
      if (trend) {
        const t = trend.trend();
        if (t === 'FLAT') gate = null;
        else gate = t === 'UP' ? 'yes' : 'no';
      }
      if (gate !== null) {
        const entry = pickFavorite(markets, minAsk, maxAsk, gate, pick);
        if (entry) {
          const n = Math.floor(TARGET / entry.ask);
          if (n >= 1) state.position = { ticker: entry.market.ticker, side: entry.side, numContracts: n, cost: n * entry.ask };
        }
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
  console.log(`Loaded ${ticks.length} ticks.\n`);

  const configs = [];
  // Tighter bands, varying SL, V2-like
  for (const [minA, maxA] of [[0.58, 0.72], [0.62, 0.75], [0.65, 0.78], [0.68, 0.80], [0.72, 0.83], [0.78, 0.88]]) {
    for (const SL of [-3.99, -2.00, -1.50, -1.00]) {
      configs.push({ label: `V2 ${minA.toFixed(2)}-${maxA.toFixed(2)} SL=${SL}`, mode: 'V2-like', minAsk: minA, maxAsk: maxA, TARGET: 4, TP: 0.75, SL });
    }
  }
  // V2-like with closest-mid pick (avoid selection bias)
  for (const [minA, maxA] of [[0.60, 0.80], [0.65, 0.85], [0.70, 0.90]]) {
    configs.push({ label: `V2 ${minA.toFixed(2)}-${maxA.toFixed(2)} pick=closest-mid`, mode: 'V2-like', minAsk: minA, maxAsk: maxA, TARGET: 4, TP: 0.75, SL: -3.99, pick: 'closest-mid' });
  }
  // Hybrid (favorite + trend)
  for (const [minA, maxA] of [[0.55, 0.75], [0.60, 0.80], [0.65, 0.85]]) {
    for (const SL of [-3.99, -1.50]) {
      configs.push({ label: `Hybrid ${minA.toFixed(2)}-${maxA.toFixed(2)} SL=${SL}`, mode: 'hybrid', minAsk: minA, maxAsk: maxA, TARGET: 4, TP: 0.75, SL });
    }
  }

  const rows = [];
  for (const cfg of configs) {
    const r = runOne(ticks, cfg);
    const total = r.wins + r.losses;
    rows.push({
      Config: cfg.label,
      Trades: total,
      WR: total ? +(r.wins / total * 100).toFixed(1) : 0,
      PnL: +r.profit.toFixed(2),
      '$/Trade': total ? +(r.profit / total).toFixed(3) : 0,
    });
  }
  rows.sort((a, b) => b.WR - a.WR);
  console.log('Sorted by WR:');
  console.table(rows);
})();
