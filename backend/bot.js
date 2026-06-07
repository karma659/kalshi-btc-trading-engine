/**
 * Kalshi Trading Engine (module)
 *
 * This is now a MODULE used by index.js — it no longer runs its own polling loop.
 * index.js owns the single Kalshi/Coinbase poll and feeds market + BTC data into
 * tick() on each cycle. This module owns: entry/exit decisions, order placement,
 * auth, mode, and state persistence. There is exactly one Kalshi poll in the system.
 *
 * Public API: init(), tick(markets, btcPrice), getMode(), setMode(), getDashboardState()
 *
 * 
 * Persists state to past_trades/bot-state.json. Requires KALSHI_API_KEY_ID + private key.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

// const strategy1 = require('./strategy6');
const strategy = require('./strategy4');
// const strategy3 = require('./strategy3');
// const strategy5 = require('./strategy5');
const strategies = [strategy];

const pastTradesDir = path.join(__dirname, 'past_trades');
if (!fs.existsSync(pastTradesDir)) fs.mkdirSync(pastTradesDir);

const tradesFile  = path.join(pastTradesDir, 'trades.txt');
const stateFile   = path.join(pastTradesDir, 'bot-state.json');

// Active Configuration (Hot-reloaded directly from this file)
let config = {
  targetBet: 10.50,
  takeProfit: 1.20, 
  stopLoss: -2.80,
  trailingDrop: 0.10,
  hardExitPct: 0.40, // 90% of max profit is good enough to take — avoids leaving money on the table when the price swings back after a big move
  mode: 'paper'
};

const ENTRY_COOLDOWN_MS = 3000;  // Pause new entries this long after a failed order.

// State persisted across restarts. We now track state independently per strategy.
let state = {
  strategies: {}
};
strategies.forEach(s => {
  state.strategies[s.name] = { totalProfit: 0, position: null, tradeHistory: [] };
});

let lastTickAt = 0;          // when tick() last ran — drives the dashboard's "live" indicator
let entryCooldowns = {};     // suppress entries until this timestamp after an order error (per strategy)

// ─── Persistence ────────────────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(stateFile)) {
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (saved.strategies) {
        for (const name in saved.strategies) {
          if (!state.strategies[name]) state.strategies[name] = { totalProfit: 0, position: null, tradeHistory: [] };
          state.strategies[name].totalProfit = saved.strategies[name].totalProfit || 0;
          state.strategies[name].tradeHistory = saved.strategies[name].tradeHistory || [];
        }
      } else if (saved.totalProfit !== undefined) {
        // Migrate legacy single-strategy state to the first strategy
        const fallback = strategies[0].name;
        state.strategies[fallback].totalProfit = saved.totalProfit || 0;
        state.strategies[fallback].tradeHistory = saved.tradeHistory || [];
      }
      // Never restore an open position across restarts — re-evaluate the market fresh
    }
  } catch (e) {
    console.warn('[ENGINE] Could not load persisted state:', e.message);
  }
}

let lastStateSignature = null;

function saveState() {
  try {
    const payload = {
      strategies:   state.strategies,
      mode:         getMode()
    };

    // Skip the write entirely when nothing meaningful changed. lastUpdated is excluded
    // from the signature so a pure timestamp bump never triggers a write on its own.
    const signature = JSON.stringify(payload);
    if (signature === lastStateSignature) return;
    lastStateSignature = signature;

    payload.lastUpdated = new Date().toISOString();
    fs.writeFileSync(stateFile, JSON.stringify(payload, null, 2));
  } catch (e) {
    console.warn('[ENGINE] Could not save state:', e.message);
  }
}

// ─── Mode (paper | live) ──────────────────────────────────────────────────────
// Cached so the hot path doesn't read disk repeatedly. setMode() updates the cache
// immediately so a dashboard toggle in the same process takes effect at once.
let lastConfigReadAt = 0;
const CONFIG_CACHE_MS = 1000;
let lastFileConfigStr = '';

function loadConfig() {
  const now = Date.now();
  if (now - lastConfigReadAt < CONFIG_CACHE_MS) return config;
  lastConfigReadAt = now;

  try {
    const code = fs.readFileSync(__filename, 'utf8');
    // Forgiving regex: ignores missing semicolons and formatting changes
    const match = code.match(/let\s+config\s*=\s*({[^}]+})/);
    
    if (match && match[1] !== lastFileConfigStr) {
      lastFileConfigStr = match[1];
      const parsed = new Function('return ' + match[1])();
      let updated = false;
      
      if (parsed.targetBet !== undefined && config.targetBet !== Number(parsed.targetBet)) { config.targetBet = Number(parsed.targetBet); updated = true; }
      if (parsed.takeProfit !== undefined && config.takeProfit !== Number(parsed.takeProfit)) { config.takeProfit = Number(parsed.takeProfit); updated = true; }
      if (parsed.stopLoss !== undefined && config.stopLoss !== Number(parsed.stopLoss)) { config.stopLoss = Number(parsed.stopLoss); updated = true; }
      if (parsed.trailingDrop !== undefined && config.trailingDrop !== Number(parsed.trailingDrop)) { config.trailingDrop = Number(parsed.trailingDrop); updated = true; }
      if (parsed.hardExitPct !== undefined && config.hardExitPct !== Number(parsed.hardExitPct)) { config.hardExitPct = Number(parsed.hardExitPct); updated = true; }
      if (parsed.mode !== undefined && config.mode !== parsed.mode) { config.mode = parsed.mode === 'live' ? 'live' : 'paper'; updated = true; }

      if (updated) {
        console.log(`\n[ENGINE] ⚙️ Config Hot-Reloaded! Bet=$${config.targetBet.toFixed(2)} | TP=+$${config.takeProfit.toFixed(2)} | SL=-$${Math.abs(config.stopLoss).toFixed(2)}\n`);
      }
    }
  } catch (err) {
    console.error('\n[ENGINE] ⚠️ Hot-reload parsing error:', err.message, '\n');
  }
  return config;
}

function getMode() {
  return loadConfig().mode;
}

function setMode(mode) {
  const next = mode === 'live' ? 'live' : 'paper';
  config.mode = next;
  return next;
}

// Snapshot for the dashboard endpoint — served from memory, no disk read.
// Aggregates multiple strategies into a shape the frontend still understands.
function getDashboardState() {
  let combinedProfit = 0;
  let combinedHistory = [];
  let firstPosition = null;

  for (const name in state.strategies) {
    const s = state.strategies[name];
    combinedProfit += s.totalProfit;
    combinedHistory = combinedHistory.concat(s.tradeHistory);
    if (s.position && !firstPosition) firstPosition = s.position;
  }

  combinedHistory.sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt));

  return {
    totalProfit:  combinedProfit,
    position:     firstPosition,
    tradeHistory: combinedHistory.slice(-50),
    strategies:   state.strategies, // The full multi-strategy payload is now attached too
    mode:         getMode(),
    config:       loadConfig(),
    lastUpdated:  lastTickAt ? new Date(lastTickAt).toISOString() : null
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

// Console-only status messages, throttled to ~1/sec so the 50ms loop doesn't flood.
let lastStatusLogAt = 0;
function logStatus(msg) {
  const now = Date.now();
  if (now - lastStatusLogAt < 1000) return;
  lastStatusLogAt = now;
  console.log(`[${ts()}] ${msg}`);
}

// Console-only: errors/debug (not throttled).
function log(msg) {
  console.log(`[${new Date().toLocaleString()}] ${msg}`);
}

// Console + trades.txt: only successful trade events (BUY/SELL/TP/SL/SETTLED).
function logTrade(msg) {
  const line = `[${new Date().toLocaleString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(tradesFile, line + '\n'); } catch (_) {}
}

// ─── Kalshi Authentication (RSA-PSS signed requests) ────────────────────────

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const API_KEY_ID = process.env.KALSHI_API_KEY_ID;
const PRIVATE_KEY_PATH = process.env.KALSHI_PRIVATE_KEY_PATH || './kalshi-private-key.pem';

let privateKey = null;
let TRADING_ENABLED = false;

try {
  if (API_KEY_ID && fs.existsSync(path.resolve(__dirname, PRIVATE_KEY_PATH))) {
    privateKey = fs.readFileSync(path.resolve(__dirname, PRIVATE_KEY_PATH), 'utf8');
    TRADING_ENABLED = true;
    console.log('[ENGINE] ✅ Kalshi credentials loaded — LIVE TRADING ENABLED');
  } else {
    console.log('[ENGINE] ⚠️  No credentials found — running in DEMO mode (no real trades)');
  }
} catch (e) {
  console.warn('[ENGINE] Could not load private key:', e.message);
}

function signRequest(method, requestPath) {
  const timestamp = Date.now().toString();
  const message = timestamp + method.toUpperCase() + requestPath;

  const signer = crypto.createSign('SHA256');
  signer.update(message);
  signer.end();

  const signature = signer.sign({
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
  }, 'base64');

  return {
    'KALSHI-ACCESS-KEY': API_KEY_ID,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'Content-Type': 'application/json'
  };
}

async function kalshiAuthFetch(method, requestPath, body = null) {
  const fullPath = '/trade-api/v2' + requestPath;
  const headers = signRequest(method, fullPath);

  const resp = await fetch(KALSHI_API_BASE + requestPath, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Kalshi ${method} ${requestPath} failed: ${resp.status} ${errText}`);
  }

  return resp.json();
}

async function placeOrder(ticker, side, quantity, priceDollars) {
  if (!TRADING_ENABLED || getMode() === 'paper') {
    log(`[PAPER] Would BUY ${quantity}x ${ticker} ${side.toUpperCase()} @ $${priceDollars}`);
    return { order: { order_id: 'paper-' + Date.now(), status: 'paper' } };
  }

  const priceCents = Math.round(priceDollars * 100);
  const body = {
    ticker,
    client_order_id: `bot-${Date.now()}`,
    side: side.toLowerCase(),
    action: 'buy',
    count: quantity,
    type: 'limit',
    [side.toLowerCase() === 'yes' ? 'yes_price' : 'no_price']: priceCents
  };

  try {
    return await kalshiAuthFetch('POST', '/portfolio/orders', body);
  } catch (err) {
    log(`ERROR placing buy order: ${err.message}`);
    throw err;
  }
}

async function sellPosition(ticker, side, quantity, bidDollars) {
  if (!TRADING_ENABLED || getMode() === 'paper') {
    log(`[PAPER] Would SELL ${quantity}x ${ticker} ${side.toUpperCase()} @ $${bidDollars}`);
    return { order: { order_id: 'paper-' + Date.now(), status: 'paper' } };
  }

  const priceCents = Math.round(bidDollars * 100);
  const body = {
    ticker,
    client_order_id: `bot-sell-${Date.now()}`,
    side: side.toLowerCase(),
    action: 'sell',
    count: quantity,
    type: 'limit',
    [side.toLowerCase() === 'yes' ? 'yes_price' : 'no_price']: priceCents
  };

  try {
    return await kalshiAuthFetch('POST', '/portfolio/orders', body);
  } catch (err) {
    log(`ERROR placing sell order: ${err.message}`);
    throw err;
  }
}

async function getBalance() {
  if (!TRADING_ENABLED) return null;
  try {
    return await kalshiAuthFetch('GET', '/portfolio/balance');
  } catch (err) {
    log(`ERROR fetching balance: ${err.message}`);
    return null;
  }
}

// ─── Order fill confirmation ──────────────────────────────────────────────────
// A limit order can rest unfilled (the touch moved, or there wasn't enough size) —
// so we must NOT assume an order filled just because Kalshi accepted it. These
// helpers verify the actual fill before we update the bot's position state.

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const FILL_TIMEOUT_MS = 2500; // wait this long for a fill before giving up
const FILL_POLL_MS    = 300;  // re-check holdings this often

async function cancelOrder(orderId) {
  try {
    await kalshiAuthFetch('DELETE', `/portfolio/orders/${orderId}`);
  } catch (err) {
    log(`cancelOrder error: ${err.message}`);
  }
}

// Contracts currently held for a ticker (absolute value), read from the POSITIONS
// endpoint — ground truth. The single-order endpoint 404s on these markets, so we
// confirm fills by watching the position change instead. Returns null if unreadable.
// NB: no query string — Kalshi signs the path without it — so we fetch all and filter.
async function heldContracts(ticker) {
  try {
    const res = await kalshiAuthFetch('GET', '/portfolio/positions');
    const mp = (res.market_positions || []).find(p => p.ticker === ticker);
    if (!mp) return 0;
    return Math.abs(parseFloat(mp.position_fp ?? mp.position ?? 0)) || 0;
  } catch (err) {
    log(`heldContracts error: ${err.message}`);
    return null;
  }
}

// Poll holdings until `predicate(held)` is true or we time out. Returns last reading.
async function awaitPosition(ticker, predicate) {
  const deadline = Date.now() + FILL_TIMEOUT_MS;
  let held = null;
  while (Date.now() < deadline) {
    held = await heldContracts(ticker);
    if (held != null && predicate(held)) return held;
    await sleep(FILL_POLL_MS);
  }
  return held;
}

// Live ENTRY: place the limit at the ask, then confirm via the position delta how many
// contracts we actually hold now. Cancels any resting remainder. Returns contracts bought.
async function enterConfirmed(ticker, side, count, askDollars) {
  if (!TRADING_ENABLED || getMode() === 'paper') {
    await placeOrder(ticker, side, count, askDollars);
    return count; // paper: assume full fill
  }
  const before = (await heldContracts(ticker)) ?? 0;
  const result = await placeOrder(ticker, side, count, askDollars);
  const orderId = result?.order?.order_id;

  const after = await awaitPosition(ticker, h => h > before);
  if (after == null) { // couldn't read positions — don't assume; cancel to be safe
    log(`⚠️  Could not confirm fill for ${ticker} via positions — canceling order to avoid desync`);
    if (orderId) await cancelOrder(orderId);
    return 0;
  }
  const filled = Math.min(count, Math.max(0, Math.round(after - before)));
  if (filled < count && orderId) await cancelOrder(orderId); // drop resting remainder
  return filled;
}

// Live EXIT: sell with an aggressive 1¢ limit so it CROSSES the book and fills at the
// best available bid (a passive limit at a stale bid is what rests unfilled). Confirms
// via the position dropping. Returns contracts STILL held (0 = fully exited).
async function exitConfirmed(ticker, side, count, displayBid) {
  if (!TRADING_ENABLED || getMode() === 'paper') {
    await sellPosition(ticker, side, count, displayBid); // paper: log at the real bid
    return 0;
  }
  const result = await sellPosition(ticker, side, count, 0.01); // cross the book
  const orderId = result?.order?.order_id;

  const after = await awaitPosition(ticker, h => h <= 0.0001);
  if (after == null) return count; // unknown — assume still held, retry next tick
  const remaining = Math.max(0, Math.round(after));
  if (remaining > 0 && orderId) await cancelOrder(orderId);
  return remaining;
}

// Close (or partially close) the current position with a CONFIRMED exit. Books realized
// PnL for whatever actually filled; keeps any unfilled remainder open to retry next tick
// so the bot never reports flat while the real position is still open.
async function closeCurrent(strategyName, result, bid) {
  const stratState = state.strategies[strategyName];
  const pos = stratState.position;
  let remaining;
  try {
    remaining = await exitConfirmed(pos.ticker, pos.side, pos.numContracts, bid);
  } catch (err) {
    log(`SELL ERROR at ${result}: ${err.message}`);
    return; // keep the position; retry next tick
  }

  const exited = pos.numContracts - remaining;
  if (exited > 0) {
    const pnl = exited * (bid - pos.entryPrice);
    stratState.totalProfit += pnl;
    const label = result === 'TP' ? 'TAKE PROFIT' : 'STOP LOSS';
    logTrade(`[${strategyName}] ${label} | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | x${exited} | ${pos.subtitle} | ${pos.side.toUpperCase()}`);
    stratState.tradeHistory.push({ ...pos, numContracts: exited, exitBid: bid, pnl, result, closedAt: new Date().toISOString() });
  }

  if (remaining > 0) {
    log(`EXIT INCOMPLETE [${strategyName}]: ${remaining}/${pos.numContracts} of ${pos.subtitle} still held — retrying next tick`);
    pos.peakPnl      = pos.peakPnl * (remaining / pos.numContracts); // scale to the smaller lot
    pos.cost         = remaining * pos.entryPrice;
    pos.numContracts = remaining;
  } else {
    stratState.position = null;
    
    // Prevent death loops: force a cooldown after exiting before re-entering
    if (result === 'SL') {
      entryCooldowns[strategyName] = Date.now() + 30000; // 30s timeout after Stop Loss
    } else if (result === 'TP') {
      entryCooldowns[strategyName] = Date.now() + 5000;  // 5s timeout after Take Profit
    }
  }
}

// ─── Trading tick ─────────────────────────────────────────────────────────────
// Called once per poll cycle by index.js with the already-fetched market list and
// BTC price. Performs entry or position management. Does NOT fetch or schedule.

async function tick(markets, btcPrice) {
  lastTickAt = Date.now();
  const currentConfig = loadConfig();

  // Feed the centralized BTC price to strategies that rely on it
  strategies.forEach(strategy => {
    if (typeof strategy.recordPrice === 'function' && Number.isFinite(btcPrice)) {
      strategy.recordPrice(btcPrice);
    }
  });

  if (!markets || markets.length === 0) {
    logStatus('No markets, waiting...');
    saveState();
    return;
  }

  // Guard to prevent strategies from buying the exact same contract or opposing sides
  let activeTickers = new Set();
  for (const s of strategies) {
    const pos = state.strategies[s.name].position;
    if (pos) activeTickers.add(pos.ticker);
  }

  let activeCount = 0;
  let trackingLogs = [];

  for (const strategy of strategies) {
    const stratState = state.strategies[strategy.name];
    const cooldown = entryCooldowns[strategy.name] || 0;

    if (!stratState.position) {
      // ── ENTRY ────────────────────────────────────────────────────────────────
      if (Date.now() < cooldown) continue;

      const entry = await strategy.chooseEntry(markets);
      if (!entry || activeTickers.has(entry.market.ticker)) {
        continue; 
      }

      activeTickers.add(entry.market.ticker);

      const { market, ask, side } = entry;

      // ── Size to what the balance can actually afford ──────────────────────────
      let budget = currentConfig.targetBet;
      if (TRADING_ENABLED && getMode() === 'live') {
        const bal = await getBalance();
        const availDollars = bal ? (bal.balance / 100) : 0;
        budget = Math.min(currentConfig.targetBet, availDollars * 0.95 - 0.10); // 5% + 10¢ fee headroom
      }

      const numContracts = Math.floor(budget / ask);
      if (numContracts < 1) {
        entryCooldowns[strategy.name] = Date.now() + 30000;
        continue;
      }

      let filled;
      try {
        filled = await enterConfirmed(market.ticker, side, numContracts, ask);
      } catch (err) {
        const insufficient = /insufficient_balance/.test(err.message);
        log(`ENTRY FAILED [${strategy.name}] | ${err.message}`);
        entryCooldowns[strategy.name] = Date.now() + (insufficient ? 60000 : ENTRY_COOLDOWN_MS);
        continue;
      }

      // Order rested / didn't fill — nothing bought, so do NOT open a position.
      if (filled < 1) {
        entryCooldowns[strategy.name] = Date.now() + ENTRY_COOLDOWN_MS;
        continue;
      }

      stratState.position = {
        ticker:       market.ticker,
        subtitle:     market.subtitle || market.ticker,
        side,
        entryPrice:   ask,
        numContracts: filled,
        cost:         filled * ask,
        currentBid:   ask,
        pnl:          0,
        peakPnl:      0,
        enteredAt:    new Date().toISOString(),
        strategy:     strategy.name
      };

      const tag = getMode() === 'live' ? 'LIVE' : 'PAPER';
      const partial = filled < numContracts ? ` of ${numContracts}` : '';
      logTrade(`BUY (${tag}) | ${stratState.position.subtitle} | ${side.toUpperCase()} | Entry $${ask.toFixed(2)} | x${filled}${partial} | Cost $${stratState.position.cost.toFixed(2)} | Strategy: ${strategy.name}`);
    }

    if (stratState.position) {
      // ── MANAGE POSITION ────────────────────────────────────────────────────────
      activeCount++;
      const myMarket = markets.find(m => m.ticker === stratState.position.ticker);

      if (!myMarket) {
        // Market disappeared (settlement between cycles) — treat as expiry
        const bidFallback = stratState.position.side === 'yes' ? 1.00 : 0.00;
        const exitValue = stratState.position.numContracts * bidFallback;
        const pnl = exitValue - stratState.position.cost;

        logTrade(`MARKET SETTLED | ${stratState.position.subtitle} | PnL ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | Strategy: ${strategy.name}`);
        stratState.totalProfit += pnl;
        stratState.tradeHistory.push({ ...stratState.position, exitBid: bidFallback, pnl, result: 'SETTLED', closedAt: new Date().toISOString() });
        stratState.position = null;
        continue;
      }

      const bid = parseFloat(
        stratState.position.side === 'yes'
          ? (myMarket.yes_bid_dollars || 0)
          : (myMarket.no_bid_dollars  || 0)
      );

      const currentValue = stratState.position.numContracts * bid;
      const pnl          = currentValue - stratState.position.cost;

      stratState.position.currentBid = bid;
      stratState.position.pnl        = pnl;
      stratState.position.peakPnl    = Math.max(stratState.position.peakPnl || 0, pnl);

      const peakStr = stratState.position.peakPnl >= currentConfig.takeProfit ? ` | Peak: +$${stratState.position.peakPnl.toFixed(2)}` : '';
      trackingLogs.push(`[${strategy.name.split(' ')[0]}] PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}${peakStr}`);

      const maxProfit = (1.00 - stratState.position.entryPrice) * stratState.position.numContracts;

      if (pnl >= currentConfig.hardExitPct * maxProfit) {
        await closeCurrent(strategy.name, 'TP', bid); // Hard exit: lock it in if we capture the target % of maximum possible profit
      } else if (stratState.position.peakPnl >= currentConfig.takeProfit && (stratState.position.peakPnl - pnl >= currentConfig.trailingDrop)) {
        await closeCurrent(strategy.name, 'TP', bid);
      } else if (pnl <= currentConfig.stopLoss) {
        await closeCurrent(strategy.name, 'SL', bid);
      }
    }
  }

  if (trackingLogs.length > 0) {
    logStatus(`Active (${activeCount}) [TP:+$${currentConfig.takeProfit.toFixed(2)} | SL:-$${Math.abs(currentConfig.stopLoss).toFixed(2)}] => ` + trackingLogs.join(' | '));
  } else {
    logStatus(`Scanning markets... [Bet:$${currentConfig.targetBet.toFixed(2)} | TP:+$${currentConfig.takeProfit.toFixed(2)} | SL:-$${Math.abs(currentConfig.stopLoss).toFixed(2)}]`);
  }

  saveState();
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────────

async function init() {
  loadState();
  console.log(`[ENGINE] Starting with 4 parallel strategies.`);
  console.log(`[ENGINE] Initial mode: ${getMode().toUpperCase()} (toggle from the dashboard)`);
  const currentConfig = loadConfig();
  console.log(`[ENGINE] Active Config: Bet=$${currentConfig.targetBet.toFixed(2)} | TP=+$${currentConfig.takeProfit.toFixed(2)} | SL=-$${Math.abs(currentConfig.stopLoss).toFixed(2)}`);
  strategies.forEach(s => {
    const p = state.strategies[s.name].totalProfit;
    console.log(`  - ${s.name} Lifetime profit: ${p >= 0 ? '+' : ''}$${p.toFixed(2)}`);
  });

  if (TRADING_ENABLED) {
    const balance = await getBalance();
    if (balance) {
      console.log(`[ENGINE] ✅ Connected to Kalshi. Account balance: $${(balance.balance / 100).toFixed(2)}`);
    } else {
      console.log('[ENGINE] ⚠️  Could not fetch balance — check your API key & private key');
    }
  }
}

module.exports = {
  init,
  tick,
  getMode,
  setMode,
  getDashboardState,
  strategyName: 'Parallel Engine (4 Strategies)'
};

// Guard: this is a module now. Running it directly is a mistake post-merge.
if (require.main === module) {
  console.error('[ENGINE] bot.js is now a module driven by index.js. Run `node index.js` instead.');
  process.exit(1);
}
