/**
 * Kalshi single-process server + trading engine.
 *
 * One shared poll fetches Kalshi market data and the selected BTC source.
 * That same data drives BOTH the trading engine (./bot) and the dashboard (REST + WS),
 * so each external API is hit exactly once per cycle instead of once per process.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const engine = require('./bot'); // trading engine module — fed by the poller below
const coinbaseWs = require('./coinbase-ws');
const tradingviewWs = require('./tradingview-ws');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Tuning ────────────────────────────────────────────────────────────────────
const BASE_POLL_MS         = 100;  // Normal Kalshi poll cadence.
const MAX_POLL_MS          = 5000; // Exponential-backoff ceiling after public-data errors.
const COINBASE_THROTTLE_MS = 100;  // Applies when explicit REST pricing is selected.
const BROADCAST_THROTTLE_MS = 250; // Browser push cadence; engine ticks remain independent.

// BTC price source switch. 'websocket' (default): real-time Coinbase WS ticker, no
// polling-interval lag. If the feed hasn't connected yet or has gone stale, we do NOT
// fall back to REST — REST reads measured ~1s stale, so trading on one unannounced
// would be worse than not trading. We log an error and keep serving the last known-good
// price (see resolveBtcPrice) — V7's entries don't depend on btcPrice at all, only
// strategies with recordPrice() are affected by a stale/frozen reading.
// 'tradingview': TradingView's CRYPTO:BTCUSD blended feed (see tradingview-ws.js) —
// tracks Kalshi's actual settlement source (CF Benchmarks' BRTI, itself a multi-exchange
// composite) more closely than Coinbase's single-exchange print. Uses TradingView's
// undocumented internal quote-session protocol, not an official API — best-effort, same
// strict no-REST-fallback contract as 'websocket'.
// 'rest': force the Coinbase REST poll only. Set via env: BTC_SOURCE=websocket|tradingview|rest.
const BTC_SOURCE = (process.env.BTC_SOURCE || 'websocket').toLowerCase();
let lastBtcSourceLogged = null;

/**
 * Generates the Kalshi event ticker for the upcoming 15-minute window (e.g.
 * 'kxbtc15m-26jul080830'), quarter-hour aligned (:00/:15/:30/:45 ET). Series is
 * KXBTC15M — unlike the old hourly KXBTCD, each event has exactly ONE market
 * (single yes/no on whether BTC is above its trailing-15-min average), not a
 * ladder of strikes.
 */
function getDynamicTicker() {
  const now = new Date();
  const flooredMin = Math.floor(now.getMinutes() / 15) * 15;
  now.setMinutes(flooredMin, 0, 0);
  const targetTime = new Date(now.getTime() + 15 * 60 * 1000);

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: '2-digit', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(targetTime);
  const t = Object.fromEntries(parts.map(p => [p.type, p.value]));

  const hh = t.hour === '24' ? '00' : t.hour; // JS returns '24' for midnight
  return `kxbtc15m-${t.year}${t.month.toLowerCase()}${t.day}${hh}${t.minute}`;
}

/**
 * Fetches event data from Kalshi's Trade API (v2). Returns the dashboard shape plus
 * _rawMarkets (the untouched market objects the trading engine needs), or null on 404.
 */
async function fetchKalshiApi(ticker) {
  const targetTicker = ticker.toUpperCase(); // Kalshi's path is case-sensitive (uppercase)
  const url = `https://api.elections.kalshi.com/trade-api/v2/events/${targetTicker}?with_nested_markets=true`;
  const resp = await fetch(url);
  if (!resp.ok) {
    if (resp.status === 404) return null; // not listed yet
    throw new Error(`Kalshi API responded with status ${resp.status}`);
  }

  const data = await resp.json();
  const event = data.event;
  // KXBTCD (hourly) markets carry a plain `subtitle` (e.g. "$71,750 or above"). KXBTC15M
  // (15-min) markets don't — only `yes_sub_title` (e.g. "Target Price: $62,224.68"). Normalize
  // here, once, onto the raw objects so every downstream consumer (this contracts mapping,
  // and bot.js/_rawMarkets which reads market.subtitle for positions + trade history) gets a
  // readable name instead of falling back to the raw ticker string.
  const markets = (event.markets || []).map(m => ({
    ...m,
    subtitle: m.subtitle || m.yes_sub_title || m.ticker
  }));

  const contracts = markets.map(m => ({
    subtitle: m.subtitle,
    yesAsk: parseFloat(m.yes_ask_dollars || 0),
    yesBid: parseFloat(m.yes_bid_dollars || 0),
    noAsk: parseFloat(m.no_ask_dollars || 0),
    noBid: parseFloat(m.no_bid_dollars || 0),
    lastPrice: parseFloat(m.last_price_dollars || 0)
  }));

  return {
    url: `https://kalshi.com/events/${ticker}`,
    title: event.title,
    description: event.sub_title || event.ticker,
    ticker,
    contracts,
    fetchedAt: new Date().toISOString(),
    _rawMarkets: markets
  };
}

/**
 * Live BTC trade price from the Coinbase Exchange feed (real-time, unlike the cached
 * v2 /prices/spot). Feeds both the dashboard and the momentum strategies.
 */
async function fetchCoinbaseBtcPrice() {
  try {
    const resp = await fetch('https://api.exchange.coinbase.com/products/BTC-USD/ticker', {
      headers: { 'User-Agent': 'kalshi-bot' }
    });
    if (!resp.ok) throw new Error(`Status ${resp.status}`);
    const data = await resp.json();
    const price = parseFloat(data.price);
    return Number.isFinite(price) ? price : null;
  } catch (err) {
    console.error('Failed to fetch Coinbase BTC price:', err.message);
    return null;
  }
}

// ─── REST endpoints ──────────────────────────────────────────────────────────────

app.get('/api/kalshi', async (req, res) => {
  const ticker = req.query.ticker || getDynamicTicker();
  try {
    if (!req.query.ticker && lastFetched) return res.json(lastFetched);
    const data = await fetchKalshiApi(ticker);
    const btcPrice = lastFetched ? lastFetched.btcPrice : null;
    res.json({ ...(data || {
      title: 'Awaiting Market Listing',
      description: `Waiting for Kalshi to list ${ticker}`,
      ticker,
      contracts: [],
      fetchedAt: new Date().toISOString()
    }), btcPrice });
  } catch (err) {
    console.error('API Error:', err);
    res.status(502).json({ error: err.message });
  }
});

const fs = require('fs');
app.get('/api/trades', (req, res) => {
  const tradesFile = path.join(__dirname, 'past_trades', 'trades.txt');
  res.send(fs.existsSync(tradesFile) ? fs.readFileSync(tradesFile, 'utf8') : '');
});

// Bot mode (paper | live) — delegated to the engine, which owns the cached value.
app.get('/api/bot-mode', (req, res) => {
  res.json({ mode: engine.getMode() });
});
app.post('/api/bot-mode', (req, res) => {
  res.json({ mode: engine.setMode(req.body?.mode) });
});

// Live bot state — served straight from the engine's in-memory state (no disk read).
app.get('/api/bot-state', (req, res) => {
  res.json(engine.getDashboardState());
});

// Liveness and readiness details for local operators and container health checks.
// This endpoint intentionally contains no account or position information.
app.get('/healthz', (req, res) => {
  const dashboardState = engine.getDashboardState();
  res.json({
    status: 'ok',
    mode: engine.getMode(),
    marketDataReady: Boolean(lastFetched),
    btcPriceReady: Number.isFinite(lastFetched?.btcPrice),
    lastMarketFetchAt: lastFetched?.fetchedAt || null,
    engineUpdatedAt: dashboardState.lastUpdated || null
  });
});

// Manual exit, triggered by the dashboard's Close Position button.
app.post('/api/close-position', async (req, res) => {
  const ticker = req.body?.ticker;
  try {
    const result = await engine.manualClosePosition(ticker);
    res.json(result);
  } catch (err) {
    console.error('close-position error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Serve frontend static files
app.use(express.static(path.join(__dirname, '..', 'frontend')));

const host = process.env.HOST || '127.0.0.1';
const port = process.env.PORT || 4000;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─── The single poller ───────────────────────────────────────────────────────────

let lastFetched   = null;
let pollInterval  = BASE_POLL_MS;
let lastBtc       = null;
let lastBtcFetchAt = 0;
let lastBroadcastAt = 0;

// Resolves this cycle's BTC price per BTC_SOURCE. 'websocket' mode is strict: if the
// feed is down/stale we do NOT silently switch to REST (a REST read can be ~1s stale
// per measurement, so trading on it unannounced would be worse than not trading at
// all) — we log an error and return null, and the caller keeps serving the last
// known-good price until the feed recovers. Use BTC_SOURCE=rest to explicitly run on
// REST instead.
async function resolveBtcPrice(now, doCoinbase) {
  if (BTC_SOURCE === 'websocket' || BTC_SOURCE === 'tradingview') {
    const feed = BTC_SOURCE === 'tradingview' ? tradingviewWs : coinbaseWs;
    const wsPrice = feed.getPrice();
    if (wsPrice != null) {
      if (lastBtcSourceLogged !== BTC_SOURCE) {
        console.log(`[BTC] using ${BTC_SOURCE} feed`);
        lastBtcSourceLogged = BTC_SOURCE;
      }
      return wsPrice;
    }
    if (lastBtcSourceLogged !== 'ws-down') {
      console.error(`[BTC] ERROR: ${BTC_SOURCE} feed is down/stale — NOT falling back to REST. Serving the last known-good price until it reconnects.`);
      lastBtcSourceLogged = 'ws-down';
    }
    return null;
  }
  return doCoinbase ? fetchCoinbaseBtcPrice() : null;
}

async function runPoller() {
  try {
    const ticker = getDynamicTicker();
    const now = Date.now();
    const doCoinbase = now - lastBtcFetchAt >= COINBASE_THROTTLE_MS;

    // Kalshi every cycle, BTC price (websocket-first, REST fallback/mode) in parallel.
    const [kalshiData, btc] = await Promise.all([
      fetchKalshiApi(ticker),
      resolveBtcPrice(now, doCoinbase)
    ]);

    if (btc != null) { lastBtc = btc; lastBtcFetchAt = now; }
    const currentBtc = lastBtc;                    // last known-good price after this cycle

    lastFetched = {
      ...(kalshiData || {
        title: 'Awaiting Market Listing',
        description: `Waiting for Kalshi to list ${ticker}`,
        ticker,
        contracts: [],
        fetchedAt: new Date().toISOString()
      }),
      btcPrice: currentBtc
    };

    // Drive trading on the SAME data — no second Kalshi fetch. Isolate its errors so a
    // trading exception doesn't trigger the poller's network backoff.
    try {
      await engine.tick(kalshiData?._rawMarkets ?? [], currentBtc);
    } catch (e) {
      console.error('Engine tick error:', e.message);
    }

    pollInterval = BASE_POLL_MS; // reset backoff on success

    if (Date.now() - lastBroadcastAt >= BROADCAST_THROTTLE_MS) {
      lastBroadcastAt = Date.now();
      broadcastUpdate();
    }
  } catch (e) {
    console.error('Poller error:', e.message);
    pollInterval = Math.min(pollInterval * 2, MAX_POLL_MS); // backoff, max 5s
  } finally {
    setTimeout(runPoller, pollInterval);
  }
}

function broadcastUpdate() {
  if (!lastFetched) return;
  const msg = JSON.stringify({
    type: 'tick',
    btcPrice: lastFetched.btcPrice,
    contracts: lastFetched.contracts,
    ts: new Date().toISOString()
  });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'welcome', message: 'connected to kalshi websocket', ts: new Date().toISOString() }));
  if (lastFetched) ws.send(JSON.stringify({ type: 'snapshot', data: lastFetched }));
  ws.on('message', msg => {
    try {
      const obj = JSON.parse(msg.toString());
      if (obj && obj.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: new Date().toISOString() }));
    } catch (e) {}
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────────

(async () => {
  await engine.init();
  if (BTC_SOURCE === 'websocket') coinbaseWs.start();
  if (BTC_SOURCE === 'tradingview') tradingviewWs.start();
  console.log(`[BTC] source = ${BTC_SOURCE}${BTC_SOURCE !== 'rest' ? ' (no REST fallback — see resolveBtcPrice comment)' : ''}`);
  runPoller();
  server.listen(port, host, () => console.log(`Server listening on http://${host}:${port}`));
})();
