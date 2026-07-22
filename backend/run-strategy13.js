/**
 * V13 Standalone Runner — completely independent from bot.js.
 *
 * Paper mode only. Runs in its own process, maintains its own state, logs to
 * strategy13-trades.txt. No interference with V1's live trading in bot.js.
 *
 * V13 (see strategy13.js) always holds to settlement — no early exit. Every open
 * position closes exactly one way: the real Kalshi settlement result, polled from the
 * public /markets/{ticker} endpoint. That's the only exit path in this file; there is
 * no live-quote-based "should I bail" check to get wrong.
 *
 * strategy13.js's own recordPrice() hook independently tracks positions, polls
 * settlement, logs training rows to strategy13-live-data.jsonl, and periodically
 * retrains+hot-reloads the model (retrain13.py) — fully automatic, nothing here
 * duplicates it.
 *
 * Usage: node run-strategy13.js
 * Or in parallel with `npm start`:
 *   Terminal 1: npm start               (bot.js + V1 live)
 *   Terminal 2: node run-strategy13.js  (V13 paper, self-retraining)
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');

const coinbaseWs = require('./coinbase-ws');
const strategy13 = require('./strategy13');

const pastTradesDir = path.join(__dirname, 'past_trades');
const v13LogFile = path.join(pastTradesDir, 'strategy13-trades.txt');
const v13StateFile = path.join(pastTradesDir, 'strategy13-state.json');

const V13_TARGET_BET = Number(process.env.V13_TARGET_BET ?? 1.80); // matches train-strategy13.py
const V13_POLL_MS = Number(process.env.V13_POLL_MS ?? 2000);

let cachedBalance = 10000;  // paper mode starting balance
let state = { position: null, totalProfit: 0, trades: [] };

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[V13] ${ts} | ${msg}`);
}

function logTrade(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(v13LogFile, line + '\n');
  } catch (e) {
    console.error('[V13] failed to write log:', e.message);
  }
}

function loadState() {
  try {
    if (fs.existsSync(v13StateFile)) {
      state = JSON.parse(fs.readFileSync(v13StateFile, 'utf8'));
      cachedBalance = state.balance || 10000;
    }
  } catch (e) {
    log(`state load error: ${e.message}`);
  }
}

function saveState() {
  try {
    fs.writeFileSync(v13StateFile, JSON.stringify({ ...state, balance: cachedBalance }, null, 2));
  } catch (e) {
    log(`state save error: ${e.message}`);
  }
}

function kalshiFee(p, c) {
  if (p <= 0 || p >= 1 || c <= 0) return 0;
  return Math.ceil(0.07 * c * p * (1 - p) * 100) / 100;
}

// Settlement can lag close_time by a few minutes on Kalshi's side — this is just a log
// threshold for visibility, not a timeout; we keep polling indefinitely either way since
// hold-to-settlement means there is no other way for a position to close.
const SLOW_SETTLEMENT_WARN_MS = 20 * 60 * 1000;

async function fetchSettlement(ticker) {
  const data = await fetchKalshi(`/markets/${ticker}`);
  const result = data?.market?.result;
  return (result === 'yes' || result === 'no') ? result : null;
}

// Settlement payout is fee-free: $1/contract if the held side won, $0 if it lost.
function settlePosition(resultSide) {
  const won = state.position.side === resultSide;
  const payout = won ? state.position.contracts : 0;
  const pnl = payout - state.position.cost;

  cachedBalance += payout;
  state.totalProfit += pnl;
  state.trades.push({
    ...state.position,
    exitPrice: won ? 1 : 0,
    pnl,
    holdSeconds: Math.floor((Date.now() - state.position.enteredAt) / 1000),
    exitReason: 'settlement'
  });

  logTrade(`[V13] SETTLED | ${state.position.side.toUpperCase()} | ${won ? 'WON' : 'LOST'} | P&L ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | balance $${cachedBalance.toFixed(2)}`);
  state.position = null;
}

async function fetchKalshi(endpoint) {
  return new Promise((resolve) => {
    const url = `https://api.elections.kalshi.com/trade-api/v2${endpoint}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', (d) => data += d);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    }).on('error', (e) => {
      log(`fetchKalshi error: ${e.message}`);
      resolve(null);
    });
  });
}

async function runLoop() {
  loadState();
  strategy13.reloadModel();

  coinbaseWs.start();
  log(`starting (paper, bet=$${V13_TARGET_BET}, balance=$${cachedBalance.toFixed(2)})`);

  while (true) {
    try {
      const btcPrice = coinbaseWs.getPrice();
      if (!btcPrice) {
        log('BTC price unavailable, waiting...');
        await new Promise(r => setTimeout(r, V13_POLL_MS));
        continue;
      }

      strategy13.recordPrice(btcPrice);

      const markets = await fetchKalshi(`/markets?series_ticker=KXBTC15M&limit=50`);
      if (!markets || !markets.markets || markets.markets.length === 0) {
        log(`no active markets`);
        await new Promise(r => setTimeout(r, V13_POLL_MS));
        continue;
      }

      // ── SETTLEMENT CHECK (if holding) — the only exit path; V13 always holds to
      // settlement (see strategy13.js header for why: every exit-model attempt in this
      // project has cost money vs just holding, since settlement itself is fee-free).
      if (state.position) {
        const heldMs = Date.now() - state.position.enteredAt;
        const result = await fetchSettlement(state.position.ticker);
        if (result) {
          settlePosition(result);
        } else {
          const mins = Math.floor(heldMs / 60000);
          if (heldMs > SLOW_SETTLEMENT_WARN_MS) {
            log(`${state.position.ticker} still not settled after ${mins}min — unusual, will keep polling`);
          } else {
            log(`holding ${state.position.side.toUpperCase()} ${mins}m, awaiting settlement`);
          }
        }
      }

      // ── ENTRY DECISION (if not holding) — pass every live market so the model can
      // pick its best candidate, exactly like V12/bot.js do; a single hardcoded market
      // would silently miss better opportunities on other open windows.
      if (!state.position) {
        const entry = await strategy13.chooseEntry(markets.markets);

        if (entry && cachedBalance > V13_TARGET_BET) {
          const contracts = Math.floor(V13_TARGET_BET / entry.ask);
          if (contracts >= 1) {
            const entryFee = kalshiFee(entry.ask, contracts);
            const entryCost = contracts * entry.ask + entryFee;

            cachedBalance -= entryCost;
            state.position = {
              ticker: entry.market.ticker,
              side: entry.side,
              entryPrice: entry.ask,
              contracts,
              cost: entryCost,
              entryFee,
              enteredAt: Date.now(),
              enteredAtISO: new Date().toISOString()
            };

            const subtitle = entry.market.subtitle || entry.market.yes_sub_title || entry.market.ticker;
            logTrade(`[V13] ENTRY | ${entry.side.toUpperCase()} | ${subtitle} | ask $${entry.ask.toFixed(2)} | x${contracts} | cost $${entryCost.toFixed(2)} | balance $${cachedBalance.toFixed(2)}`);
          }
        }
      }

      saveState();
      await new Promise(r => setTimeout(r, V13_POLL_MS));

    } catch (e) {
      log(`loop error: ${e.message}`);
      await new Promise(r => setTimeout(r, V13_POLL_MS));
    }
  }
}

process.on('SIGINT', () => {
  log('shutting down...');
  saveState();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('shutting down (SIGTERM)...');
  saveState();
  process.exit(0);
});

// ── Simple HTTP API for dashboard ──
const app = express();
const PORT = 4001;  // V13 on 4001, V1 on 4000

app.get('/api/v13-state', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.json(state);
});

app.use(express.static('.'));

http.createServer(app).listen(PORT, () => {
  log(`API server listening on http://localhost:${PORT}`);
  log(`dashboard: http://localhost:${PORT}/v13-dashboard.html`);
});

runLoop().catch(e => {
  log(`fatal error: ${e.message}`);
  process.exit(1);
});
