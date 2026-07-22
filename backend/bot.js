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
const { kalshiFee } = require('./fees');
require('dotenv').config();

// V7 (Favorite-Longshot Harvest) is the main deployed strategy — the only one that
// backtested net-positive after fees held to settlement over a full 7-day run.
// V10 (RSI-3 Sell Signal, gated) runs alongside it: its gated "settle play" backtested
// +$20.46 on just 6 trades — not enough to trust yet, so it's here to accumulate a real
// paper track record (mode defaults to 'paper' — see bot-config.json) rather than as a
// vetted strategy. Both run concurrently; the engine's activeTickers guard (below)
// stops them from ever buying the same contract twice.
const strategy1 = require('./strategy');
const strategy7 = require('./strategy7');
const strategy10 = require('./strategy10');
const strategy13 = require('./strategy13');
const strategy14 = require('./strategy14');
const strategy15 = require('./strategy15');
// V13 runs in a separate process: node run-strategy13.js
// This keeps live trading (V1) isolated from V13's paper-mode learning

// V15 is the active strategy and starts automatically with `npm start`. It restores its
// saved Q-table, observes BTC, chooses entries/exits, learns from completed trades, and
// persists its policy without requiring any environment flags or separate commands.
const strategies = [strategy1];

const pastTradesDir = path.join(__dirname, 'past_trades');
if (!fs.existsSync(pastTradesDir)) fs.mkdirSync(pastTradesDir);

const tradesFile  = path.join(pastTradesDir, 'trades.txt');
const stateFile   = path.join(pastTradesDir, 'bot-state.json');
const configFile  = path.join(pastTradesDir, 'bot-config.json');

// In-memory config. The single source of truth is bot-config.json (hot-reloaded on
// change); these values are only the fallback used if that file is missing/corrupt.
// mode defaults to 'paper' so live trading is always a deliberate, explicit choice.



let config = {
  targetBet: 3.50,
  takeProfit: 1.50,
  stopLoss: -1.20,
  hardExitPct: 1, // 90% of max profit is good enough to take — avoids leaving money on the table when the price swings back after a big move
  mode: 'paper'
};




// let config = {
//   targetBet: 2.20,
//   takeProfit: 2.30,
//   stopLoss: -1.00,
//   hardExitPct: 1.0, // 90% of max profit is good enough to take — avoids leaving money on the table when the price swings back after a big move
//   mode: 'paper'
// };


// let config = {
//   targetBet: 8.50,
//   takeProfit: 5.50,
//   stopLoss: -4.0,
//   hardExitPct: 1.0, // 90% of max profit is good enough to take — avoids leaving money on the table when the price swings back after a big move
//   mode: 'paper'
// };



// let config = {
//   targetBet: 3.50,
//   takeProfit: 1.50,
//   stopLoss: -1.80,
//   hardExitPct: 1.0, // 90% of max profit is good enough to take — avoids leaving money on the table when the price swings back after a big move
//   mode: 'paper'
// };





















// let config = {
//   targetBet: 8.50,
//   takeProfit: 5.50,
//   stopLoss: -4.80,
//   hardExitPct: 1.0, // 90% of max profit is good enough to take — avoids leaving money on the table when the price swings back after a big move
//   mode: 'paper'
// };


const ENTRY_COOLDOWN_MS = 3000;  // Pause new entries this long after a failed order.
const NEAR_STRIKE_USD   = 25;    // Suppress stop-loss while BTC is within this $ of the strike.

// State persisted across restarts. We now track state independently per strategy.
let state = {
  strategies: {}
};
strategies.forEach(s => {
  state.strategies[s.name] = { totalProfit: 0, position: null, tradeHistory: [] };
});

let lastTickAt = 0;          // when tick() last ran — drives the dashboard's "live" indicator
let entryCooldowns = {};     // suppress entries until this timestamp after an order error (per strategy)
let reconcileDone = false;   // have we adopted any pre-existing LIVE position yet? (once per live session)
let lastMarkets = [];        // most recent market list from tick() — reused by manualClosePosition,
                              // which runs off an HTTP request, not a poll cycle, so it has no
                              // markets of its own to look up the live bid from.

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

// ─── Config & mode (paper | live) ──────────────────────────────────────────────
// Single source of truth is bot-config.json. We hot-reload it on change (mtime poll,
// throttled so the 50ms loop doesn't stat disk every tick) and write it back on changes
// made in-process (e.g. a dashboard mode toggle), so config survives restarts.
let lastConfigReadAt = 0;
const CONFIG_CACHE_MS = 1000;
let lastConfigMtimeMs = 0;

// Persist the current in-memory config to disk (used by setMode and to seed the file).
function writeConfig() {
  try {
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
    try { lastConfigMtimeMs = fs.statSync(configFile).mtimeMs; } catch (_) {}
  } catch (err) {
    console.warn('[ENGINE] Could not write bot-config.json:', err.message);
  }
}

function loadConfig() {
  const now = Date.now();
  if (now - lastConfigReadAt < CONFIG_CACHE_MS) return config;
  lastConfigReadAt = now;

  try {
    if (!fs.existsSync(configFile)) { writeConfig(); return config; } // seed from defaults

    const mtime = fs.statSync(configFile).mtimeMs;
    if (mtime === lastConfigMtimeMs) return config; // unchanged since last read
    lastConfigMtimeMs = mtime;

    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    let updated = false;
    const setNum = (k) => {
      if (parsed[k] !== undefined && Number.isFinite(Number(parsed[k])) && config[k] !== Number(parsed[k])) {
        config[k] = Number(parsed[k]); updated = true;
      }
    };
    setNum('targetBet'); setNum('takeProfit'); setNum('stopLoss');
    setNum('hardExitPct');
    if (parsed.mode !== undefined) {
      const m = parsed.mode === 'live' ? 'live' : 'paper';
      if (config.mode !== m) { config.mode = m; updated = true; }
    }

    if (updated) {
      console.log(`\n[ENGINE] ⚙️ Config Hot-Reloaded! Mode=${config.mode.toUpperCase()} | Bet=$${config.targetBet.toFixed(2)} | TP=+$${config.takeProfit.toFixed(2)} | SL=-$${Math.abs(config.stopLoss).toFixed(2)}\n`);
    }
  } catch (err) {
    console.error('\n[ENGINE] ⚠️ Config load error (keeping current values):', err.message, '\n');
  }
  return config;
}

// ─── Auto-sync bot.js's hardcoded config into bot-config.json ─────────────────────
// Editing the `config` literal above only ever took effect the very first time
// bot-config.json didn't exist yet — after that the JSON file always won, silently.
// Instead of just documenting that, push any edited numeric value from bot.js's source
// straight into bot-config.json automatically, so editing bot.js actually works. This
// runs in two places: (1) once at startup in init(), covering edits made while the bot
// was stopped, and (2) via fs.watch while running, covering live edits. Net effect:
// `npm start` always runs with the numbers currently written in bot.js.
// 'mode' is deliberately excluded — bot.js always defaults to 'paper' for
// safety, and an unrelated bot.js edit should never silently flip a live session back to
// paper (or vice versa); only the dashboard/setMode() should ever change mode.
// NOTE: this only syncs these four numbers — it does NOT hot-reload the rest of bot.js
// (strategy wiring, logic changes, etc. still need a real process restart).
const AUTO_SYNC_KEYS = ['targetBet', 'takeProfit', 'stopLoss', 'hardExitPct'];

function extractConfigLiteral(source) {
  // Anchor to line start (m flag) so commented-out `// let config = {` blocks
  // higher up in the file can never be picked instead of the active literal.
  const match = source.match(/^let\s+config\s*=\s*\{([\s\S]*?)\};/m);
  if (!match) return null;
  const body = match[1];
  const extracted = {};
  for (const key of AUTO_SYNC_KEYS) {
    const kMatch = body.match(new RegExp(`\\b${key}\\s*:\\s*(-?[0-9.]+)`));
    if (kMatch) extracted[key] = Number(kMatch[1]);
  }
  return extracted;
}

function syncHardcodedConfigToFile() {
  let source;
  try { source = fs.readFileSync(__filename, 'utf8'); } catch (_) { return; }

  const extracted = extractConfigLiteral(source);
  if (!extracted) return; // bot.js mid-edit / unparseable right now — try again next change

  let changed = false;
  for (const key of AUTO_SYNC_KEYS) {
    if (extracted[key] !== undefined && Number.isFinite(extracted[key]) && config[key] !== extracted[key]) {
      config[key] = extracted[key];
      changed = true;
    }
  }
  if (changed) {
    writeConfig();
    console.log(`[ENGINE] 🔄 Auto-synced bot.js edit → bot-config.json: Bet=$${config.targetBet.toFixed(2)} | TP=+$${config.takeProfit.toFixed(2)} | SL=-$${Math.abs(config.stopLoss).toFixed(2)} | HardExit=${config.hardExitPct}`);
  }
}

let syncDebounceTimer = null;
try {
  fs.watch(__filename, (eventType) => {
    if (eventType !== 'change') return;
    // Editors/save-tools often fire several change events per save — debounce to one sync.
    clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(syncHardcodedConfigToFile, 300);
  });
} catch (err) {
  console.warn('[ENGINE] Could not watch bot.js for config auto-sync:', err.message);
}

function getMode() {
  return loadConfig().mode;
}

function setMode(mode) {
  const next = mode === 'live' ? 'live' : 'paper';
  config.mode = next;
  writeConfig(); // persist so the toggle survives restarts and isn't clobbered by reload
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

// Kalshi's V2 order API dropped the yes/no + buy/sell split in favor of a single
// YES-leg book: side='bid' buys YES, side='ask' sells YES. Selling YES at price P is
// economically identical to buying NO at (1-P), and buying YES at P is identical to
// selling NO at (1-P) — so any (side, action) pair maps onto a (bookSide, yesPrice) pair.
function toV2Order(side, action, priceDollars) {
  const isYes = side.toLowerCase() === 'yes';
  const bookSide = (isYes === (action === 'buy')) ? 'bid' : 'ask';
  const yesPrice = isYes ? priceDollars : (1 - priceDollars);
  return { bookSide, yesPrice };
}

async function placeOrder(ticker, side, quantity, priceDollars) {
  if (!TRADING_ENABLED || getMode() === 'paper') {
    log(`[PAPER] Would BUY ${quantity}x ${ticker} ${side.toUpperCase()} @ $${priceDollars}`);
    return { order_id: 'paper-' + Date.now(), status: 'paper' };
  }

  const { bookSide, yesPrice } = toV2Order(side, 'buy', priceDollars);
  const body = {
    ticker,
    client_order_id: `bot-${Date.now()}`,
    side: bookSide,
    count: quantity.toFixed(2),
    price: yesPrice.toFixed(4),
    time_in_force: 'immediate_or_cancel', // fill what's available now, cancel the rest
    self_trade_prevention_type: 'taker_at_cross'
  };

  try {
    return await kalshiAuthFetch('POST', '/portfolio/events/orders', body);
  } catch (err) {
    log(`ERROR placing buy order: ${err.message}`);
    throw err;
  }
}

async function sellPosition(ticker, side, quantity, bidDollars) {
  if (!TRADING_ENABLED || getMode() === 'paper') {
    log(`[PAPER] Would SELL ${quantity}x ${ticker} ${side.toUpperCase()} @ $${bidDollars}`);
    return { order_id: 'paper-' + Date.now(), status: 'paper' };
  }

  const { bookSide, yesPrice } = toV2Order(side, 'sell', bidDollars);
  const body = {
    ticker,
    client_order_id: `bot-sell-${Date.now()}`,
    side: bookSide,
    count: quantity.toFixed(2),
    price: yesPrice.toFixed(4),
    time_in_force: 'immediate_or_cancel',
    self_trade_prevention_type: 'taker_at_cross'
  };

  try {
    return await kalshiAuthFetch('POST', '/portfolio/events/orders', body);
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

// ─── Cached balance (keeps the network round trip off the entry critical path) ──────
// A live GET /portfolio/balance measured ~50ms RTT — sitting that in front of every
// entry doubled the latency between signal and order. Balance only moves on fills, so
// we track it locally (adjusted synchronously the instant we know a fill's cost/proceeds)
// and resync from Kalshi in the background on a timer to correct for fee drift or any
// other account activity. The entry path below reads this cache directly — no await.
let cachedBalanceDollars = null;
let lastBalanceRefreshAt = 0;
const BALANCE_REFRESH_MS = 60000;

async function refreshBalance() {
  const bal = await getBalance();
  if (bal) cachedBalanceDollars = bal.balance / 100;
  lastBalanceRefreshAt = Date.now();
  return cachedBalanceDollars;
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
    await kalshiAuthFetch('DELETE', `/portfolio/events/orders/${orderId}`);
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
  const orderId = result?.order_id;

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
// via the position dropping. Returns contracts STILL held (0 = fully exited), or null if
// we can't confirm real holdings and therefore refuse to place any order at all.
//
// SAFETY: always reads actual held contracts BEFORE selling. Selling a side you don't
// hold doesn't error on Kalshi — it OPENS THE OPPOSITE POSITION instead. If you close a
// position manually (e.g. from the phone app) between ticks, the bot's local state is
// stale; without this check it would try to "exit" a position that's already gone and
// accidentally open a brand new one. This must never place an order it can't confirm is
// backed by a real holding.
async function exitConfirmed(ticker, side, count, displayBid) {
  if (!TRADING_ENABLED || getMode() === 'paper') {
    await sellPosition(ticker, side, count, displayBid); // paper: log at the real bid
    return 0;
  }

  const before = await heldContracts(ticker);
  if (before === 0) return 0;      // already flat (e.g. closed manually) — nothing to do
  if (before == null) return null; // can't confirm holdings — refuse to guess, caller stops

  const sellCount = Math.min(count, before);
  const result = await sellPosition(ticker, side, sellCount, 0.01); // cross the book
  const orderId = result?.order_id;

  const after = await awaitPosition(ticker, h => h <= 0.0001);
  if (after == null) return sellCount; // fill unconfirmed — caller stops, no retry
  const remaining = Math.max(0, Math.round(after));
  if (remaining > 0 && orderId) await cancelOrder(orderId);
  return remaining;
}

// Close (or partially close) the current position with a CONFIRMED exit. Books realized
// PnL for whatever actually filled. Exactly ONE attempt — no retries. If it can't fully
// close, it logs "CANNOT CLOSE" and marks the position `closeFailed` so the tick loop
// never tries again automatically; it needs a human to look at it. (A prior version kept
// retrying every tick, which under a stale/mismatched local position size compounded into
// repeatedly opening new positions instead of closing — never doing that again.)
async function closeCurrent(strategyName, result, bid) {
  const stratState = state.strategies[strategyName];
  const strategy = strategies.find(s => s.name === strategyName);
  const pos = stratState.position;
  let remaining;
  try {
    remaining = await exitConfirmed(pos.ticker, pos.side, pos.numContracts, bid);
  } catch (err) {
    log(`❌ CANNOT CLOSE POSITION [${strategyName}]: ${pos.subtitle} — ${err.message}. Not retrying — needs manual review.`);
    pos.closeFailed = true;
    return;
  }

  if (remaining === null) {
    log(`❌ CANNOT CLOSE POSITION [${strategyName}]: ${pos.subtitle} — could not confirm real holdings, refused to guess. Not retrying — needs manual review.`);
    pos.closeFailed = true;
    return;
  }

  const exited = pos.numContracts - remaining;
  if (exited > 0) {
    // Net of Kalshi fees on BOTH legs (entry + this pre-settlement sell). Note the live
    // exit crosses the book at a 1¢ limit (exitConfirmed), so on a thin book the true fill
    // can sit below this top-of-book `bid` — reported PnL is a best case, not guaranteed.
    const fees = kalshiFee(pos.entryPrice, exited) + kalshiFee(bid, exited);
    const pnl = exited * (bid - pos.entryPrice) - fees;
    stratState.totalProfit += pnl;
    const label = result === 'TP' ? 'TAKE PROFIT'
      : result === 'SL' ? 'STOP LOSS'
      : result === 'RL_EXIT' ? 'LEARNED EXIT'
      : 'MANUAL CLOSE';
    logTrade(`[${strategyName}] ${label} | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | x${exited} | ${pos.subtitle} | ${pos.side.toUpperCase()}`);
    const closedTrade = { ...pos, numContracts: exited, exitBid: bid, pnl, result, closedAt: new Date().toISOString() };
    stratState.tradeHistory.push(closedTrade);
    if (typeof strategy?.onTradeClosed === 'function') strategy.onTradeClosed(closedTrade);

    // Optimistic local credit (proceeds minus fees) — same reasoning as the entry debit.
    if (TRADING_ENABLED && getMode() === 'live' && cachedBalanceDollars != null) {
      cachedBalanceDollars += exited * bid - fees;
    }
  }

  if (remaining > 0) {
    log(`❌ CANNOT CLOSE POSITION [${strategyName}]: ${remaining}/${pos.numContracts} of ${pos.subtitle} still held. Not retrying — needs manual review.`);
    pos.cost         = remaining * pos.entryPrice;
    pos.numContracts = remaining;
    pos.closeFailed  = true;
  } else {
    stratState.position = null;
    // Prevent rapid close/re-entry loops. Strategy-level one-ticker guards are the main
    // protection; this engine cooldown also protects every future strategy implementation.
    entryCooldowns[strategyName] = Date.now() + (result === 'TP' ? 5000 : 30000);
  }
}

// User-initiated exit from the dashboard's Close Position button. Reuses the same
// confirmed-exit path as TP/SL (closeCurrent/exitConfirmed) — exactly one attempt, no
// retries — so a manual close can never leave the bot's local state out of sync with
// what Kalshi actually filled. Overrides holdToSettle on purpose: that flag only stops
// the *automatic* TP/SL logic in tick() from exiting early, it was never meant to block
// a human who explicitly asked to get out now.
async function manualClosePosition(ticker) {
  if (!ticker) return { ok: false, error: 'No ticker provided.' };

  const strategyName = Object.keys(state.strategies)
    .find(name => state.strategies[name].position?.ticker === ticker);
  if (!strategyName) return { ok: false, error: 'No open position with that ticker.' };

  const pos = state.strategies[strategyName].position;
  if (pos.closeFailed) return { ok: false, error: 'Previous close attempt on this position needs manual review before retrying — check the logs.' };

  const myMarket = lastMarkets.find(m => m.ticker === ticker);
  if (!myMarket) return { ok: false, error: 'Market not currently listed (likely settling right now) — wait a moment and retry.' };

  const bid = parseFloat(pos.side === 'yes' ? (myMarket.yes_bid_dollars || 0) : (myMarket.no_bid_dollars || 0));

  await closeCurrent(strategyName, 'MANUAL', bid);
  saveState();

  const stillOpen = state.strategies[strategyName].position;
  if (stillOpen) {
    return stillOpen.closeFailed
      ? { ok: false, error: 'Could not confirm the close — needs manual review, see server logs.' }
      : { ok: false, error: 'Only partially closed — remaining contracts still open.' };
  }
  return { ok: true };
}

// ─── Startup position reconciliation ───────────────────────────────────────────
// loadState() deliberately never restores an open position across restarts, and the
// poller hard-exits at XX:59 ([index.js]). Together that means a real Kalshi position
// held across a restart would be invisible to the engine — unmanaged and unstopped.
// On the first LIVE tick we read /portfolio/positions and adopt any untracked holding
// into a free strategy slot so it gets the normal TP/SL/trailing management (and exit).
async function reconcilePositions(markets) {
  try {
    const res = await kalshiAuthFetch('GET', '/portfolio/positions');
    const mps = (res.market_positions || []).filter(
      p => (Math.abs(parseFloat(p.position_fp ?? p.position ?? 0)) || 0) >= 1
    );
    if (mps.length === 0) return;

    const tracked = new Set();
    for (const name in state.strategies) {
      const p = state.strategies[name].position;
      if (p) tracked.add(p.ticker);
    }

    for (const mp of mps) {
      if (tracked.has(mp.ticker)) continue;

      const raw = parseFloat(mp.position_fp ?? mp.position ?? 0);
      const qty = Math.abs(Math.round(raw));
      const side = raw >= 0 ? 'yes' : 'no';
      const myMarket = markets.find(m => m.ticker === mp.ticker);

      // Entry-price basis: prefer the API cost basis if it implies a sane per-contract
      // price; otherwise re-base at the current ask so the orphan at least gains a stop
      // from now on. (Re-basing makes PnL start ~0 — protective, not historically exact.)
      let entryPrice = null;
      const exposureCents = parseFloat(mp.market_exposure ?? mp.cost_basis ?? NaN);
      if (Number.isFinite(exposureCents) && qty > 0) {
        const per = (exposureCents / 100) / qty;
        if (per > 0.01 && per < 1) entryPrice = per;
      }
      if (entryPrice == null && myMarket) {
        entryPrice = parseFloat(side === 'yes' ? (myMarket.yes_ask_dollars || 0) : (myMarket.no_ask_dollars || 0)) || null;
      }
      if (entryPrice == null) {
        log(`⚠️ Untracked LIVE position ${mp.ticker} x${qty} — no usable price; leaving it, manage manually.`);
        continue;
      }

      const freeStrat = strategies.find(s => !state.strategies[s.name].position);
      if (!freeStrat) {
        log(`⚠️ Untracked LIVE position ${mp.ticker} x${qty} — no free strategy slot to manage it.`);
        continue;
      }

      state.strategies[freeStrat.name].position = {
        ticker:       mp.ticker,
        subtitle:     myMarket?.subtitle || mp.ticker,
        side,
        entryPrice,
        numContracts: qty,
        cost:         qty * entryPrice,
        currentBid:   entryPrice,
        pnl:          0,
        enteredAt:    new Date().toISOString(),
        strategy:     freeStrat.name,
        reconciled:   true
      };
      tracked.add(mp.ticker);
      logTrade(`RECONCILED untracked LIVE position | ${myMarket?.subtitle || mp.ticker} | ${side.toUpperCase()} | x${qty} | basis $${entryPrice.toFixed(2)} | now managed by ${freeStrat.name}`);
    }
  } catch (err) {
    log(`reconcilePositions error: ${err.message}`);
  }
}

// The live Kalshi API carries the strike as a plain numeric `floor_strike` field; recorded/
// legacy data may only have it in `subtitle` ("Target Price: $62,059.76") — same fallback
// used in strategy5.js/strategy10.js.
function strikeOf(market) {
  if (Number.isFinite(market?.floor_strike)) return market.floor_strike;
  const sub = String(market?.subtitle || '');
  const sm = sub.match(/([0-9][0-9,]*(?:\.[0-9]+)?)/);
  return sm ? parseFloat(sm[1].replace(/,/g, '')) : null;
}

// Public, unauthenticated — the real settlement result for a market that's rolled off
// the polled event list. Used by tick()'s expiry branch instead of ever guessing which
// side won. Returns 'yes' | 'no' | null (not finalized yet / unreachable).
async function fetchMarketResult(ticker) {
  try {
    const resp = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${ticker}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.market?.result || null;
  } catch (_) {
    return null;
  }
}

// ─── Trading tick ─────────────────────────────────────────────────────────────
// Called once per poll cycle by index.js with the already-fetched market list and
// BTC price. Performs entry or position management. Does NOT fetch or schedule.

async function tick(markets, btcPrice) {
  lastTickAt = Date.now();
  lastMarkets = markets || [];
  const currentConfig = loadConfig();

  // Feed the centralized BTC price to strategies that rely on it
  strategies.forEach(strategy => {
    if (typeof strategy.recordPrice === 'function' && Number.isFinite(btcPrice)) {
      strategy.recordPrice(btcPrice);
    }
    if (typeof strategy.observeMarkets === 'function') {
      strategy.observeMarkets(markets || [], btcPrice);
    }
  });

  if (!markets || markets.length === 0) {
    logStatus('No markets, waiting...');
    saveState();
    return;
  }

  // One-time adoption of any pre-existing LIVE position so it's managed, not abandoned.
  if (!reconcileDone && TRADING_ENABLED && getMode() === 'live') {
    reconcileDone = true; // set before awaiting so a hiccup can't loop this every tick
    await reconcilePositions(markets);
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
      // Reads the local cache — no network call here, so this doesn't sit in front of
      // the order like a fresh getBalance() would. Refreshed on a timer, in the
      // background, so it can't block this tick.
      let budget = currentConfig.targetBet;
      if (TRADING_ENABLED && getMode() === 'live') {
        if (Date.now() - lastBalanceRefreshAt > BALANCE_REFRESH_MS) refreshBalance().catch(() => {});
        const availDollars = cachedBalanceDollars ?? 0;
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

      // Optimistic local debit (fees excluded) so the NEXT entry's sizing reflects this
      // fill instantly; the timer-based refreshBalance() reconciles the exact figure.
      if (TRADING_ENABLED && getMode() === 'live' && cachedBalanceDollars != null) {
        cachedBalanceDollars -= filled * ask;
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
        enteredAt:    new Date().toISOString(),
        strategy:     strategy.name,
        // Per-position exit overrides (optional; e.g. V10 scalp TP vs hold-to-settlement)
        takeProfit:   entry.takeProfit,
        holdToSettle: !!entry.holdToSettle
      };
      if (typeof strategy.onPositionOpened === 'function') {
        strategy.onPositionOpened(stratState.position, market);
      }

      const tag = getMode() === 'live' ? 'LIVE' : 'PAPER';
      const partial = filled < numContracts ? ` of ${numContracts}` : '';
      logTrade(`BUY (${tag}) | ${stratState.position.subtitle} | ${side.toUpperCase()} | Entry $${ask.toFixed(2)} | x${filled}${partial} | Cost $${stratState.position.cost.toFixed(2)} | Strategy: ${strategy.name}`);
    }

    if (stratState.position) {
      // ── MANAGE POSITION ────────────────────────────────────────────────────────
      activeCount++;
      const myMarket = markets.find(m => m.ticker === stratState.position.ticker);

      if (!myMarket) {
        // Market rolled off the polled event — getDynamicTicker() advances to the NEXT
        // window the instant the current one's boundary passes, so this fires immediately
        // at expiry, before Kalshi has necessarily finalized a result. It does NOT tell us
        // which side won. (A previous version assumed "yes always wins, no always loses"
        // here — that fabricated a full win on every yes-side LOSS and vice versa, silently
        // corrupting totalProfit/tradeHistory/balance. Never guess a settlement outcome.)
        let result = null;
        try { result = await fetchMarketResult(stratState.position.ticker); } catch (_) {}

        if (result !== 'yes' && result !== 'no') {
          trackingLogs.push(`[${strategy.name.split(' ')[0]}] awaiting settlement confirmation…`);
          continue; // not confirmed yet — re-check next tick, don't touch the position
        }

        const won = result === stratState.position.side;
        const exitValue = won ? stratState.position.numContracts : 0;
        const entryFee = kalshiFee(stratState.position.entryPrice, stratState.position.numContracts);
        const pnl = exitValue - stratState.position.cost - entryFee;

        logTrade(`SETTLED | ${stratState.position.subtitle} | ${stratState.position.side.toUpperCase()} | ${won ? 'WON' : 'LOST'} | PnL ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | Strategy: ${strategy.name}`);
        stratState.totalProfit += pnl;
        const closedTrade = { ...stratState.position, exitBid: won ? 1 : 0, pnl, result: 'SETTLED', closedAt: new Date().toISOString() };
        stratState.tradeHistory.push(closedTrade);
        if (typeof strategy.onTradeClosed === 'function') strategy.onTradeClosed(closedTrade);

        // Optimistic local credit for the settlement payout (see cachedBalanceDollars above).
        if (TRADING_ENABLED && getMode() === 'live' && cachedBalanceDollars != null) {
          cachedBalanceDollars += exitValue;
        }

        stratState.position = null;
        continue;
      }

      const bid = parseFloat(
        stratState.position.side === 'yes'
          ? (myMarket.yes_bid_dollars || 0)
          : (myMarket.no_bid_dollars  || 0)
      );

      // Two PnL figures, deliberately different:
      //  - grossPnl: plain mark-to-market (current bid × contracts − cost), matching what
      //    Kalshi's own app shows for an open position. This is what we DISPLAY.
      //  - pnl: net of the entry fee (already paid) and the exit fee you'd pay if you sold
      //    RIGHT NOW — "what I'd actually book if I closed this instant." This is what
      //    DECIDES exits below, so a configured TP/SL means real achievable dollars, not
      //    gross price movement. It will always run a bit behind grossPnl while open — that
      //    gap is exactly the fees, not a bug (see the mismatch it was built to eliminate:
      //    closeCurrent()'s actual booked amount is net, so the trigger has to be too).
      const entryFee      = kalshiFee(stratState.position.entryPrice, stratState.position.numContracts);
      const exitFeeIfSold = kalshiFee(bid, stratState.position.numContracts);
      const currentValue  = stratState.position.numContracts * bid;
      const grossPnl       = currentValue - stratState.position.cost;
      const pnl           = grossPnl - entryFee - exitFeeIfSold;

      stratState.position.currentBid = bid;
      stratState.position.pnl        = grossPnl;

      trackingLogs.push(`[${strategy.name.split(' ')[0]}] PnL: ${grossPnl >= 0 ? '+' : ''}$${grossPnl.toFixed(2)}`);

      // Net max profit if held all the way to settlement (that exit is fee-free — only the
      // entry fee was ever paid on this path), so hardExitPct is a % of a real number.
      const maxProfit = (1.00 - stratState.position.entryPrice) * stratState.position.numContracts - entryFee;

      // Per-position overrides: holdToSettle skips all profit-taking (settlement pays
      // the full $1 with no exit fee; stop-loss stays on as a disaster brake), and a
      // position-level takeProfit (e.g. V10's $1 scalp) beats the global config value.
      const tpTarget = stratState.position.takeProfit ?? currentConfig.takeProfit;
      const holdToSettle = !!stratState.position.holdToSettle;

      // Don't stop out while BTC is still within $NEAR_STRIKE_USD of the strike — the
      // outcome is still genuinely undecided this close, so a stop-loss here is cutting a
      // coin-flip rather than a real loser; give it room to resolve instead.
      const strike = strikeOf(myMarket);
      const nearStrike = Number.isFinite(strike) && Number.isFinite(btcPrice)
        && Math.abs(btcPrice - strike) <= NEAR_STRIKE_USD;

      const learnedExit = typeof strategy.chooseExit === 'function'
        ? strategy.chooseExit({
            position: stratState.position,
            market: myMarket,
            btcPrice,
            bid,
            grossPnl,
            netPnl: pnl,
            maxProfit,
          })
        : null;

      if (stratState.position.closeFailed) {
        // A previous close attempt couldn't confirm it fully exited — do NOT retry
        // automatically (see closeCurrent). Just keep surfacing it until a human clears it.
        trackingLogs.push(`[${strategy.name.split(' ')[0]}] ❌ CANNOT CLOSE — manual review needed`);
      } else if (learnedExit?.exit) {
        await closeCurrent(strategy.name, learnedExit.result || 'RL_EXIT', bid);
      } else if (!holdToSettle && pnl >= currentConfig.hardExitPct * maxProfit) {
        await closeCurrent(strategy.name, 'TP', bid); // Hard exit: lock it in if we capture the target % of maximum possible profit
      } else if (!holdToSettle && pnl >= tpTarget) {
        await closeCurrent(strategy.name, 'TP', bid);
      } else if (pnl <= currentConfig.stopLoss && !nearStrike) {
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
  console.log(`[ENGINE] Starting with ${strategies.length} ${strategies.length === 1 ? 'strategy' : 'parallel strategies'}: ${strategies.map(s => s.name).join(', ')}`);

  // Load bot-config.json first (it carries mode and any dashboard-made changes), THEN
  // sync bot.js's config literal over it. fs.watch only catches edits made while the
  // process is running — this startup pass covers edits made while the bot was stopped,
  // so `npm start` always runs with the numbers currently written in bot.js. Mode is
  // never synced (see AUTO_SYNC_KEYS) so a live session stays live across restarts.
  loadConfig();
  syncHardcodedConfigToFile();

  const currentConfig = config;
  console.log(`[ENGINE] Initial mode: ${getMode().toUpperCase()} (toggle from the dashboard)`);
  console.log(`[ENGINE] Active Config: Bet=$${currentConfig.targetBet.toFixed(2)} | TP=+$${currentConfig.takeProfit.toFixed(2)} | SL=-$${Math.abs(currentConfig.stopLoss).toFixed(2)}`);

  strategies.forEach(s => {
    const p = state.strategies[s.name].totalProfit;
    console.log(`  - ${s.name} Lifetime profit: ${p >= 0 ? '+' : ''}$${p.toFixed(2)}`);
  });

  if (TRADING_ENABLED) {
    await refreshBalance(); // seeds cachedBalanceDollars so the first entry never blocks on a fetch
    if (cachedBalanceDollars != null) {
      console.log(`[ENGINE] ✅ Connected to Kalshi. Account balance: $${cachedBalanceDollars.toFixed(2)}`);
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
  manualClosePosition,
  strategyName: 'Parallel Engine (4 Strategies)'
};

// Guard: this is a module now. Running it directly is a mistake post-merge.
if (require.main === module) {
  console.error('[ENGINE] bot.js is now a module driven by index.js. Run `node index.js` instead.');
  process.exit(1);
}
