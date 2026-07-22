/**
 * V15 — persistent, fee-aware contextual Q-learning strategy.
 *
 * This is deliberately a small tabular learner instead of an untrained neural network.
 * It turns the recent BTC chart, strike distance, contract price and time remaining into
 * a discrete state, chooses SKIP/YES/NO with epsilon-greedy exploration, and learns from
 * the net P&L of trades the engine actually closed. While in a position it separately
 * learns HOLD/EXIT decisions. It also journals every eligible one-minute market state,
 * including skipped markets, then polls confirmed settlements and learns both YES and NO
 * counterfactual rewards. Policy and pending settlements survive process restarts.
 *
 * Start in paper mode. An online learner needs a substantial, representative sample;
 * no amount of implementation detail makes an initially empty policy profitable.
 */

const fs = require('fs');
const path = require('path');
const { kalshiFee } = require('./fees');

const MODEL_FILE = path.join(__dirname, 'past_trades', 'strategy15-q.json');
const MARKET_DATA_FILE = path.join(__dirname, 'past_trades', 'strategy15-market-data.jsonl');
const PENDING_FILE = path.join(__dirname, 'past_trades', 'strategy15-pending.json');
const MIN_HISTORY = Number(process.env.V15_MIN_HISTORY ?? 15);
const ALPHA = Number(process.env.V15_ALPHA ?? 0.12);
const GAMMA = Number(process.env.V15_GAMMA ?? 0.92);
const MIN_EPSILON = Number(process.env.V15_MIN_EPSILON ?? 0.04);
const START_EPSILON = Number(process.env.V15_EPSILON ?? 0.22);
const EXPLORE = process.env.V15_EXPLORE === 'true'; // training only; npm start is greedy
// One confirmed matching settlement unlocks a state. The positive expected-reward gate,
// fee-aware rewards, no-exploration policy and one-trade-per-ticker guard still apply.
// Raise V15_MIN_ENTRY_VISITS to 2+ when enough live history has accumulated.
const MIN_ENTRY_VISITS = Number(process.env.V15_MIN_ENTRY_VISITS ?? 1);
const MIN_EXPECTED_REWARD = Number(process.env.V15_MIN_EXPECTED_REWARD ?? 0.10);
const MIN_HOLD_MS = Number(process.env.V15_MIN_HOLD_MS ?? 60000);
const LEARNED_EXITS = process.env.V15_ENABLE_LEARNED_EXITS !== 'false';
const FORCE_ONE_PER_TICKER = process.env.V15_FORCE_ONE_PER_TICKER !== 'false';
// The user-selected trading universe: only genuinely balanced markets where BOTH sides
// are quoted from 40% through 60%. There is intentionally no time-of-window entry gate;
// seconds-to-expiry remains in the learned state, so the policy learns whether a given
// point in the 15-minute window is worth trading instead of being forbidden to trade.
const MIN_ASK = Number(process.env.V15_MIN_ASK ?? 0.40);
const MAX_ASK = Number(process.env.V15_MAX_ASK ?? 0.60);
// Persist every completed live/paper episode. saveModel() uses atomic replacement, so
// the policy cannot be left half-written if the process stops during a save.
const SAVE_EVERY = 1;
const PERSIST = process.env.V15_PERSIST !== 'false';
const LEARN = process.env.V15_LEARN !== 'false';
const EVALUATE = process.env.V15_EVAL === 'true';

const closes = [];
let forming = null;
let lastPrice = null;
let completedUpdates = 0;
const pending = new Map();
const episodes = new Map();
const observedMarkets = new Map(); // ticker -> { subtitle, observations: { stateKey -> quote } }
let lastObservedMinute = -1;
let lastEntryDecisionKey = '';
let lastSettlementCheck = 0;
let settlementCheckInFlight = false;
const lastExitDecisionMinute = new Map();
const triedTickers = new Set();

const MODEL_VERSION = 3; // v3: visit/confidence gates and poll-rate-safe decisions
let model = { version: MODEL_VERSION, episodes: 0, entryQ: {}, entryN: {}, exitQ: {}, exitN: {}, flipSide: {} };
try {
  const parsed = JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8'));
  if (parsed && parsed.version === MODEL_VERSION) model = { ...model, ...parsed };
} catch (_) {}

try {
  const saved = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
  for (const [ticker, item] of Object.entries(saved || {})) observedMarkets.set(ticker, item);
} catch (_) {}

function saveModel() {
  if (!PERSIST) return;
  try {
    fs.mkdirSync(path.dirname(MODEL_FILE), { recursive: true });
    const tmp = `${MODEL_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(model, null, 2) + '\n');
    fs.renameSync(tmp, MODEL_FILE);
  } catch (err) {
    console.error('[V15] could not persist Q table:', err.message);
  }
}

function savePending() {
  if (!PERSIST) return;
  try {
    fs.mkdirSync(path.dirname(PENDING_FILE), { recursive: true });
    const tmp = `${PENDING_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(observedMarkets), null, 2) + '\n');
    fs.renameSync(tmp, PENDING_FILE);
  } catch (err) {
    console.error('[V15] could not persist pending markets:', err.message);
  }
}

function recordPrice(price) {
  if (!Number.isFinite(price) || price <= 0) return;
  lastPrice = price;
  const bucket = Math.floor(Date.now() / 60000) * 60000;
  if (!forming || forming.bucket !== bucket) {
    if (forming) closes.push(forming.price);
    if (closes.length > 60) closes.shift();
    forming = { bucket, price };
  } else forming.price = price;
}

function secondsToExpiry() {
  const d = new Date();
  return 900 - ((d.getUTCMinutes() * 60 + d.getUTCSeconds()) % 900);
}

function strikeOf(m) {
  if (Number.isFinite(m?.floor_strike)) return m.floor_strike;
  const match = String(m?.subtitle || '').match(/([0-9][0-9,]*(?:\.[0-9]+)?)/);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

function ret(minutes) {
  if (closes.length < minutes || !lastPrice) return 0;
  return lastPrice / closes[closes.length - minutes] - 1;
}

function volatility(minutes) {
  if (closes.length < minutes + 1) return 0;
  const rs = [];
  for (let i = closes.length - minutes; i < closes.length; i++) rs.push(closes[i] / closes[i - 1] - 1);
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  return Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rs.length - 1));
}

function bin(v, cuts) {
  let i = 0;
  while (i < cuts.length && v > cuts[i]) i++;
  return i;
}

function chartState(market, sec) {
  const strike = strikeOf(market);
  if (!strike || !lastPrice || closes.length < MIN_HISTORY) return null;
  const yesAsk = Number(market.yes_ask_dollars || 0);
  const yesBid = Number(market.yes_bid_dollars || 0);
  const r1 = ret(1), r3 = ret(3), r10 = ret(10);
  const recent = [...closes.slice(-9), lastPrice];
  const lo = Math.min(...recent), hi = Math.max(...recent);
  const rangePos = hi === lo ? 0.5 : (lastPrice - lo) / (hi - lo);
  const key = [
    bin((lastPrice - strike) / strike, [-0.0015, -0.0004, 0.0004, 0.0015]),
    bin(r1, [-0.0008, -0.00015, 0.00015, 0.0008]),
    bin(r3, [-0.0015, -0.0003, 0.0003, 0.0015]),
    bin(r10, [-0.003, -0.0007, 0.0007, 0.003]),
    bin(r1 - r3 / 3, [-0.0005, 0.0005]),
    bin(volatility(5), [0.00025, 0.0007, 0.0015]),
    bin(rangePos, [0.2, 0.4, 0.6, 0.8]),
    bin((yesAsk + yesBid) / 2, [0.25, 0.4, 0.6, 0.75]),
    bin(sec, [150, 300, 480, 660]),
  ].join(':');
  // Positive means BTC/short-term momentum favors YES; negative favors NO. This is used
  // only when one-trade-per-contract mode encounters a state without enough learned data.
  const directionalScore = (lastPrice - strike) / strike + 1.5 * r1 + 0.5 * r3 + 0.15 * r10;
  return { key, sec, directionalScore };
}

function row(table, key, actions) {
  if (!table[key]) table[key] = Object.fromEntries(actions.map(a => [a, 0]));
  return table[key];
}

function epsilon() {
  if (EVALUATE || !EXPLORE) return 0;
  return Math.max(MIN_EPSILON, START_EPSILON / Math.sqrt(1 + model.episodes / 40));
}

function choose(q, actions) {
  if (Math.random() < epsilon()) return actions[Math.floor(Math.random() * actions.length)];
  return actions.reduce((best, a) => q[a] > q[best] ? a : best, actions[0]);
}

function chooseEntry(markets) {
  if (!Array.isArray(markets) || !markets.length) return null;
  const minute = Math.floor(Date.now() / 60000);
  // A new 15-minute ticker is evaluated immediately even when it lists in the same
  // wall-clock minute as the final evaluation of the previous ticker.
  const decisionKey = `${markets.map(m => m.ticker).sort().join(',')}|${minute}`;
  if (decisionKey === lastEntryDecisionKey) return null;
  lastEntryDecisionKey = decisionKey;
  const sec = secondsToExpiry();
  let best = null;
  for (const market of markets) {
    if (triedTickers.has(market.ticker)) continue;
    const yesAsk = Number(market.yes_ask_dollars || 0);
    const noAsk = Number(market.no_ask_dollars || 0);
    // Require both legs to be balanced. Checking only the selected side would allow a
    // stale or unusually wide opposing quote into a state distribution never intended.
    if (yesAsk < MIN_ASK || yesAsk > MAX_ASK || noAsk < MIN_ASK || noAsk > MAX_ASK) continue;
    const state = chartState(market, sec);
    if (!state) continue;
    const q = row(model.entryQ, state.key, ['skip', 'yes', 'no']);
    const n = row(model.entryN, state.key, ['skip', 'yes', 'no']);
    let action = choose(q, ['skip', 'yes', 'no']);
    if (!EXPLORE) {
      const qualified = ['yes', 'no'].filter(side => n[side] >= MIN_ENTRY_VISITS
        && q[side] >= MIN_EXPECTED_REWARD && q[side] > q.skip);
      const reversal = model.flipSide?.[state.key];
      if (reversal === 'yes' || reversal === 'no') {
        // A stop-loss in this same chart state explicitly tests the opposite side next.
        // This is state-local; a YES loss never flips every unrelated market to NO.
        action = reversal;
      } else if (qualified.length) {
        action = qualified.reduce((bestSide, side) => q[side] > q[bestSide] ? side : bestSide, qualified[0]);
      } else if (FORCE_ONE_PER_TICKER) {
        action = state.directionalScore >= 0 ? 'yes' : 'no';
      } else {
        continue;
      }
    }
    if (action === 'skip') continue;
    const ask = action === 'yes' ? yesAsk : noAsk;
    const score = q[action] - q.skip;
    if (!best || score > best.score) best = { market, side: action, ask, score, stateKey: state.key };
  }
  if (!best) return null;
  pending.set(best.market.ticker, { entryState: best.stateKey, entryAction: best.side });
  return { market: best.market, side: best.side, ask: best.ask, learnedExit: true };
}

function onPositionOpened(position) {
  const seed = pending.get(position.ticker);
  pending.delete(position.ticker);
  if (seed) episodes.set(position.ticker, { ...seed, exitSteps: [] });
  triedTickers.add(position.ticker);
  if (triedTickers.size > 500) triedTickers.delete(triedTickers.values().next().value);
}

function chooseExit(ctx) {
  if (!LEARNED_EXITS) return null;
  const ep = episodes.get(ctx.position.ticker);
  const base = chartState(ctx.market, secondsToExpiry());
  if (!ep || !base) return null;
  const enteredAt = typeof ctx.position.enteredAt === 'number'
    ? ctx.position.enteredAt
    : Date.parse(ctx.position.enteredAt);
  if (!Number.isFinite(enteredAt) || Date.now() - enteredAt < MIN_HOLD_MS) return null;
  const minute = Math.floor(Date.now() / 60000);
  if (lastExitDecisionMinute.get(ctx.position.ticker) === minute) return null;
  lastExitDecisionMinute.set(ctx.position.ticker, minute);
  const priceMove = ctx.bid - ctx.position.entryPrice;
  const stateKey = `${base.key}|${bin(priceMove, [-0.15, -0.06, -0.02, 0.02, 0.06, 0.15])}|${bin(ctx.netPnl, [-1, -0.25, 0.25, 1])}`;
  const q = row(model.exitQ, stateKey, ['hold', 'exit']);
  const n = row(model.exitN, stateKey, ['hold', 'exit']);
  const action = choose(q, ['hold', 'exit']);
  ep.exitSteps.push({ stateKey, action });
  if (ep.exitSteps.length > 240) ep.exitSteps.shift();
  // Never pay an extra exit fee to lock in a loss. An RL exit also requires repeated
  // evidence and must beat HOLD; global TP/SL remains the safety fallback in bot.js.
  const safeExit = action === 'exit' && ctx.netPnl > 0 && n.exit >= MIN_ENTRY_VISITS
    && q.exit >= MIN_EXPECTED_REWARD && q.exit > q.hold;
  return safeExit ? { exit: true, result: 'TP' } : null;
}

function update(q, action, target) {
  q[action] += ALPHA * (target - q[action]);
}

function increment(table, key, action) {
  const n = row(table, key, ['skip', 'yes', 'no']);
  n[action]++;
}

function settlementReward(side, ask, resultYes) {
  const contracts = Math.floor(2.20 / ask);
  if (contracts < 1) return 0;
  const won = side === 'yes' ? resultYes : !resultYes;
  return (won ? contracts : 0) - contracts * ask - kalshiFee(ask, contracts);
}

async function learnSettlements() {
  if (settlementCheckInFlight || !LEARN || observedMarkets.size === 0) return;
  settlementCheckInFlight = true;
  try {
    for (const [ticker, item] of observedMarkets) {
      let result = null;
      try {
        const response = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${ticker}`);
        if (response.ok) result = (await response.json())?.market?.result || null;
      } catch (_) {}
      if (result !== 'yes' && result !== 'no') continue;

      const resultYes = result === 'yes';
      for (const observation of Object.values(item.observations || {})) {
        const q = row(model.entryQ, observation.stateKey, ['skip', 'yes', 'no']);
        // Full-information update: after settlement we know the counterfactual result of
        // both sides, including the entry fee. SKIP has exactly zero realized reward.
        update(q, 'skip', 0);
        update(q, 'yes', settlementReward('yes', observation.yesAsk, resultYes));
        update(q, 'no', settlementReward('no', observation.noAsk, resultYes));
        const n = row(model.entryN, observation.stateKey, ['skip', 'yes', 'no']);
        n.skip++; n.yes++; n.no++;
        model.episodes++;
      }
      observedMarkets.delete(ticker);
      console.log(`[V15] learned ${Object.keys(item.observations || {}).length} skipped/traded chart states from ${ticker} settlement=${result}`);
      saveModel();
      savePending();
    }
  } finally {
    settlementCheckInFlight = false;
  }
}

/** Record one snapshot per minute, including markets V15 skips. Pending observations
 * survive restarts and are labeled only after Kalshi publishes a confirmed settlement. */
function observeMarkets(markets, btcPrice) {
  if (!Array.isArray(markets) || !Number.isFinite(btcPrice)) return;
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  if (minute !== lastObservedMinute) {
    lastObservedMinute = minute;
    const sec = secondsToExpiry();
    for (const market of markets) {
      const yesAsk = Number(market.yes_ask_dollars || 0);
      const noAsk = Number(market.no_ask_dollars || 0);
      if (yesAsk < MIN_ASK || yesAsk > MAX_ASK || noAsk < MIN_ASK || noAsk > MAX_ASK) continue;
      const state = chartState(market, sec);
      if (!state) continue;
      let item = observedMarkets.get(market.ticker);
      if (!item) item = { subtitle: market.subtitle || market.ticker, observations: {} };
      // One quote per distinct chart state per contract prevents a high-frequency poller
      // from multiplying an identical training example thousands of times.
      item.observations[state.key] = { stateKey: state.key, yesAsk, noAsk, timestamp: now };
      observedMarkets.set(market.ticker, item);
      try {
        fs.appendFileSync(MARKET_DATA_FILE, JSON.stringify({ timestamp: now, btcPrice, markets: [market], stateKey: state.key }) + '\n');
      } catch (err) {
        console.error('[V15] market journal write failed:', err.message);
      }
    }
    savePending();
  }
  if (now - lastSettlementCheck >= 30000) {
    lastSettlementCheck = now;
    learnSettlements().catch(err => console.error('[V15] settlement learning failed:', err.message));
  }
}

function onTradeClosed(trade) {
  const ep = episodes.get(trade.ticker);
  if (!ep) return;
  if (!LEARN) {
    episodes.delete(trade.ticker);
    return;
  }
  const reward = Number(trade.pnl) || 0; // engine P&L is already fee-aware
  update(row(model.entryQ, ep.entryState, ['skip', 'yes', 'no']), ep.entryAction, reward);
  increment(model.entryN, ep.entryState, ep.entryAction);
  if (!model.flipSide) model.flipSide = {};
  if (trade.result === 'SL' && reward < 0) {
    model.flipSide[ep.entryState] = ep.entryAction === 'yes' ? 'no' : 'yes';
    console.log(`[V15] ${ep.entryAction.toUpperCase()} stopped out; next matching state will test ${model.flipSide[ep.entryState].toUpperCase()}`);
  } else if (reward > 0 && model.flipSide[ep.entryState] === ep.entryAction) {
    // The requested opposite-side test worked; normal learned ranking resumes afterward.
    delete model.flipSide[ep.entryState];
  }
  let discounted = reward;
  for (let i = ep.exitSteps.length - 1; i >= 0; i--) {
    const step = ep.exitSteps[i];
    update(row(model.exitQ, step.stateKey, ['hold', 'exit']), step.action, discounted);
    const exitCounts = row(model.exitN, step.stateKey, ['hold', 'exit']);
    exitCounts[step.action]++;
    discounted *= GAMMA;
  }
  episodes.delete(trade.ticker);
  lastExitDecisionMinute.delete(trade.ticker);
  model.episodes++;
  completedUpdates++;
  if (completedUpdates % SAVE_EVERY === 0) saveModel();
}

module.exports = {
  name: 'V15 (Chart Q-Learner)',
  chooseEntry,
  chooseExit,
  onPositionOpened,
  onTradeClosed,
  recordPrice,
  observeMarkets,
  saveModel,
  MIN_PROB: MIN_ASK,
  MAX_PROB: MAX_ASK,
};
