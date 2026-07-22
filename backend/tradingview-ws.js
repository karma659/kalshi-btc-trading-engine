/**
 * TradingView real-time BTC price feed via their internal quote-session WebSocket
 * protocol (undocumented — reverse-engineered from what the tradingview.com web app
 * itself sends; no official public API exists for this). Symbol is CRYPTO:BTCUSD,
 * TradingView's own blended/aggregated feed across major venues — this tracks Kalshi's
 * actual settlement source (CF Benchmarks' BRTI, itself a multi-exchange composite)
 * more closely than a single-exchange print like Coinbase's ticker.
 *
 * This is not a documented, versioned API: the message shapes, auth scheme, and even
 * the endpoint can change without notice, and automated non-display consumption like
 * this is outside TradingView's normal ToS-sanctioned usage. Treat it as best-effort —
 * same staleness/fallback contract as coinbase-ws.js (getPrice() returns null once the
 * feed goes stale so the caller can fall back to another source).
 */

const WebSocket = require('ws');

const WS_URL = 'wss://data.tradingview.com/socket.io/websocket';
const SYMBOL = 'CRYPTO:BTCUSD';
const STALE_MS = 8000;            // no message in this long => treat the feed as down
                                   // (TV only pushes on price change, so gaps run longer
                                   // than Coinbase's per-trade ticker during calm periods)
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

let ws = null;
let connected = false;
let lastPrice = null;
let lastUpdateAt = 0;
let reconnectDelay = RECONNECT_BASE_MS;
let reconnectTimer = null;
let started = false;

function genSessionId(prefix) {
  return prefix + Math.random().toString(36).slice(2, 12);
}

// TradingView frames every message as ~m~<byteLength>~m~<payload>, possibly several
// concatenated in a single WS message (heartbeats + JSON payloads mixed together).
function buildFrame(obj) {
  const payload = JSON.stringify(obj);
  return `~m~${payload.length}~m~${payload}`;
}

function parseFrames(raw) {
  const frames = [];
  let rest = raw;
  const re = /~m~(\d+)~m~/;
  while (rest.length) {
    const m = rest.match(re);
    if (!m) break;
    const len = parseInt(m[1], 10);
    const start = m.index + m[0].length;
    frames.push(rest.slice(start, start + len));
    rest = rest.slice(start + len);
  }
  return frames;
}

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
  ws = new WebSocket(WS_URL, {
    headers: { 'Origin': 'https://www.tradingview.com', 'User-Agent': 'Mozilla/5.0' }
  });

  const qs = genSessionId('qs_');

  ws.on('open', () => {
    connected = true;
    reconnectDelay = RECONNECT_BASE_MS;
    ws.send(buildFrame({ m: 'set_auth_token', p: ['unauthorized_user_token'] }));
    ws.send(buildFrame({ m: 'quote_create_session', p: [qs] }));
    ws.send(buildFrame({ m: 'quote_set_fields', p: [qs, 'lp'] }));
    ws.send(buildFrame({ m: 'quote_add_symbols', p: [qs, SYMBOL] }));
    console.log('[TRADINGVIEW-WS] connected, subscribed to', SYMBOL);
  });

  ws.on('message', (raw) => {
    const str = raw.toString();
    for (const frame of parseFrames(str)) {
      if (frame.startsWith('~h~')) {
        ws.send(`~m~${frame.length}~m~${frame}`); // echo heartbeat verbatim to stay connected
        continue;
      }
      try {
        const msg = JSON.parse(frame);
        if (msg.m === 'qsd' && msg.p?.[1]?.n === SYMBOL) {
          const price = msg.p[1].v?.lp;
          if (Number.isFinite(price)) {
            lastPrice = price;
            lastUpdateAt = Date.now();
          }
        }
      } catch (_) { /* ignore non-JSON / partial frames */ }
    }
  });

  ws.on('close', () => {
    connected = false;
    ws = null;
    if (started) scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.warn('[TRADINGVIEW-WS] error:', err.message);
    // 'close' fires right after and schedules the reconnect — nothing else to do here.
  });
}

function start() {
  if (started) return;
  started = true;
  connect();
}

// Returns the latest streamed price, or null if we've never connected or the feed has
// gone stale (no message within STALE_MS) — the caller should fall back to another source.
function getPrice() {
  if (!connected || lastUpdateAt === 0 || Date.now() - lastUpdateAt > STALE_MS) return null;
  return lastPrice;
}

function isHealthy() {
  return getPrice() !== null;
}

module.exports = { start, getPrice, isHealthy };
