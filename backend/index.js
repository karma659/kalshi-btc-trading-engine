/**
 * Kalshi single-process server + trading engine.
 *
 * ONE 50ms poll fetches Kalshi market data (every cycle) and Coinbase BTC (throttled).
 * That same data drives BOTH the trading engine (./bot) and the dashboard (REST + WS),
 * so each external API is hit exactly once per cycle instead of once per process.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const engine = require('./bot'); // trading engine module — fed by the poller below
const { monitorDataQuality } = require('./anomaly-detection');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Tuning ────────────────────────────────────────────────────────────────────
const BASE_POLL_MS        = 50;     // Kalshi poll cadence (the "once with 50ms")
const MAX_POLL_MS         = 1000;  // backoff ceiling on errors
const COINBASE_THROTTLE_MS = 100;  // Coinbase rate-limits harder; 2/s is plenty for trend + UI
const BROADCAST_THROTTLE_MS = 250; // WS push cadence to browsers (data still refreshes at 50ms)

/**
 * Generates the Kalshi ticker for the upcoming hour (e.g. 'kxbtcd-23may2306').
 */
function getDynamicTicker() {
  const now = new Date();
  now.setMinutes(0, 0, 0, 0);
  const targetTime = new Date(now.getTime() + 60 * 60 * 1000);

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: '2-digit', month: 'short', day: '2-digit', hour: '2-digit', hour12: false
  }).formatToParts(targetTime);
  const t = Object.fromEntries(parts.map(p => [p.type, p.value]));

  const hh = t.hour === '24' ? '00' : t.hour; // JS returns '24' for midnight
  return `kxbtcd-${t.year}${t.month.toLowerCase()}${t.day}${hh}`;
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
  const markets = event.markets || [];

  const contracts = markets.map(m => ({
    subtitle: m.subtitle || m.ticker,
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

// Serve frontend static files
app.use(express.static(path.join(__dirname, '..', 'frontend')));

const port = process.env.PORT || 4000;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─── The single poller ───────────────────────────────────────────────────────────

let lastFetched   = null;
let pollInterval  = BASE_POLL_MS;
let lastBtc       = null;
let lastBtcFetchAt = 0;
let lastBroadcastAt = 0;

// Current minute in America/New_York (handles EDT/EST).
function currentMinuteET() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const m = parts.find(p => p.type === 'minute');
  return m ? parseInt(m.value, 10) : new Date().getMinutes();
}

async function runPoller() {
  // Hourly shutdown: exit in the last minute of every hour (XX:59 ET). run.sh relaunches.
  if (currentMinuteET() === 59) {
    console.log(`[${new Date().toISOString()}] Last minute of the hour — shutting down. run.sh will relaunch.`);
    process.exit(0);
  }

  try {
    const ticker = getDynamicTicker();
    const now = Date.now();
    const doCoinbase = now - lastBtcFetchAt >= COINBASE_THROTTLE_MS;

    // Kalshi every cycle, Coinbase throttled — both in parallel.
    const [kalshiData, btc] = await Promise.all([
      fetchKalshiApi(ticker),
      doCoinbase ? fetchCoinbaseBtcPrice() : Promise.resolve(null)
    ]);

    const prevBtc = lastBtc;                       // last known-good price BEFORE this cycle
    if (btc != null) { lastBtc = btc; lastBtcFetchAt = now; }
    const currentBtc = lastBtc;                    // last known-good price AFTER this cycle

    // Run data quality anomaly checks before feeding data to the trading engine.
    // freshBtc (this cycle's raw fetch) is intentionally null on throttled cycles — drift
    // uses it so it only measures genuine new readings; coverage/staleness use currentBtc.
    const isDataAnomalous = monitorDataQuality({
      freshBtc:   btc,
      prevBtc,
      currentBtc,
      btcIsStale: lastBtcFetchAt !== 0 && (now - lastBtcFetchAt > 2000),
      kalshiData
    });

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
      if (isDataAnomalous) {
        console.log('[ENGINE] 🛑 Skipping trading tick due to data anomaly.');
      } else {
        await engine.tick(kalshiData?._rawMarkets ?? [], currentBtc);
      }
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
  runPoller();
  server.listen(port, () => console.log(`Server listening on http://localhost:${port}`));
})();
