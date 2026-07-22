/**
 * Coinbase real-time BTC-USD price feed via WebSocket (public `ticker` channel — no auth).
 *
 * Pushes a new price on every trade print instead of index.js polling the REST ticker
 * endpoint every 100ms — lower latency and no polling-interval lag. Auto-reconnects with
 * backoff on drop/error. getPrice() returns null once the feed goes stale so the caller
 * (index.js) can fall back to the REST fetch it already has, instead of trading on an
 * old price silently.
 */

const WebSocket = require('ws');

const WS_URL = 'wss://ws-feed.exchange.coinbase.com';
const STALE_MS = 3000;            // no message in this long => treat the feed as down
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

let ws = null;
let connected = false;
let lastPrice = null;
let lastUpdateAt = 0;
let reconnectDelay = RECONNECT_BASE_MS;
let reconnectTimer = null;
let started = false;

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    connect();
  }, reconnectDelay);
}

function connect() {
  if (ws) return;
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    connected = true;
    reconnectDelay = RECONNECT_BASE_MS;
    ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['ticker'] }));
    console.log('[COINBASE-WS] connected, subscribed to BTC-USD ticker');
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'ticker' && msg.product_id === 'BTC-USD') {
        const price = parseFloat(msg.price);
        if (Number.isFinite(price)) {
          lastPrice = price;
          lastUpdateAt = Date.now();
        }
      }
    } catch (_) { /* ignore malformed frames */ }
  });

  ws.on('close', () => {
    connected = false;
    ws = null;
    if (started) scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.warn('[COINBASE-WS] error:', err.message);
    // 'close' fires right after and schedules the reconnect — nothing else to do here.
  });
}

function start() {
  if (started) return;
  started = true;
  connect();
}

// Returns the latest traded price, or null if we've never connected or the feed has
// gone stale (no message within STALE_MS) — the caller should fall back to REST.
function getPrice() {
  if (!connected || lastUpdateAt === 0 || Date.now() - lastUpdateAt > STALE_MS) return null;
  return lastPrice;
}

function isHealthy() {
  return getPrice() !== null;
}

module.exports = { start, getPrice, isHealthy };
