/**
 * Pulls the last N days of KXBTCD hourly events from Kalshi + BTC candles from Coinbase
 * and writes a per-minute snapshot stream to past_trades/real_data.jsonl, in the exact
 * shape the backtester expects: { timestamp, btcPrice, markets:[{ticker,subtitle,
 * yes_ask_dollars, yes_bid_dollars, no_ask_dollars, no_bid_dollars}] }.
 *
 * Granularity is 1 minute (Kalshi's tightest candlestick interval). Each event ends with
 * a synthetic "settled" tick at close_time whose bids reflect the actual outcome — so
 * positions held to expiry close at truth ($1 if right, $0 if wrong) instead of the
 * backtester's wrong default fallback.
 *
 * Optimizations:
 *   • BTC candles fetched ONCE in 5-hour chunks for the whole window (≤300 candles/req).
 *   • Per-event Kalshi candles fetched with bounded concurrency.
 *   • Output written per-event so we never lose progress on crash/timeout.
 */

const fs = require('fs');
const path = require('path');

const DAYS    = parseInt(process.env.DAYS || '7', 10);
const SERIES  = 'KXBTCD';
const OUT_DIR = path.join(__dirname, 'past_trades');
const OUT     = path.join(OUT_DIR, 'real_data.jsonl');
const CONCURRENCY = 8;

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url, retries = 4) {
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'kalshi-backtest' } });
      if (r.status === 429) { last = new Error(`HTTP 429 (rate limited)`); await sleep(1500 * (i + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { last = e; await sleep(300 * (i + 1)); }
  }
  throw last || new Error(`exhausted retries for ${url}`);
}

async function pMapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try { out[idx] = await fn(items[idx]); } catch (e) { out[idx] = { __error: e?.message || String(e) || 'unknown' }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function listEvents(daysBack) {
  const cutoffMs = Date.now() - daysBack * 86400e3;
  const out = [];
  let cursor = '', done = false;
  while (!done) {
    const url = `https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=${SERIES}&limit=200&status=settled${cursor ? `&cursor=${cursor}` : ''}`;
    const j = await fetchJSON(url);
    for (const e of (j.events || [])) {
      if (Date.parse(e.strike_date) < cutoffMs) { done = true; break; }
      out.push(e);
    }
    if (done || !j.cursor) break;
    cursor = j.cursor;
  }
  return out;
}

const fetchEvent = t =>
  fetchJSON(`https://api.elections.kalshi.com/trade-api/v2/events/${t}?with_nested_markets=true`).then(j => j.event);

const fetchKalshiCandles = (ticker, startTs, endTs) =>
  fetchJSON(`https://api.elections.kalshi.com/trade-api/v2/series/${SERIES}/markets/${ticker}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=1`)
    .then(j => j.candlesticks || []);

// Coinbase: max 300 candles per request, granularity 60s → 5-hour chunks.
async function fetchBtcAllCandles(startTs, endTs) {
  const map = new Map();
  const CHUNK = 5 * 3600;
  for (let s = startTs; s < endTs; s += CHUNK) {
    const e = Math.min(s + CHUNK, endTs);
    const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?start=${new Date(s * 1000).toISOString()}&end=${new Date(e * 1000).toISOString()}&granularity=60`;
    let got = false;
    for (let i = 0; i < 5 && !got; i++) {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'kalshi-backtest' } });
        if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
        if (!r.ok) throw new Error(`Coinbase HTTP ${r.status}`);
        const cs = await r.json();
        for (const c of cs) map.set(c[0] + 60, c[4]);
        got = true;
      } catch (e) { await sleep(400 * (i + 1)); }
    }
    if (!got) console.warn(`  BTC chunk failed at ${new Date(s*1000).toISOString()}`);
    await sleep(120);
  }
  return map;
}

(async () => {
  console.log(`Listing settled ${SERIES} events from the last ${DAYS} days…`);
  const events = await listEvents(DAYS);
  events.sort((a, b) => Date.parse(a.strike_date) - Date.parse(b.strike_date));
  if (!events.length) { console.log('No events found.'); return; }
  console.log(`Found ${events.length} events — oldest ${events[0].event_ticker}, newest ${events[events.length - 1].event_ticker}`);

  const globalStart = Math.floor(Date.parse(events[0].strike_date) / 1000) - 3600;
  const globalEnd   = Math.floor(Date.parse(events[events.length - 1].strike_date) / 1000);
  console.log(`Fetching BTC candles for ${new Date(globalStart*1000).toISOString()} → ${new Date(globalEnd*1000).toISOString()}…`);
  const btcMap = await fetchBtcAllCandles(globalStart, globalEnd);
  console.log(`  ${btcMap.size} BTC candles cached`);

  const stream = fs.createWriteStream(OUT);
  let totalTicks = 0;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    let event;
    try { event = await fetchEvent(ev.event_ticker); }
    catch (e) { console.warn(`  ${ev.event_ticker} fetchEvent: ${e.message}`); continue; }
    if (!event?.markets?.length) continue;

    const sample   = event.markets[0];
    const open_ts  = Math.floor(Date.parse(sample.open_time)  / 1000);
    const close_ts = Math.floor(Date.parse(sample.close_time) / 1000);
    const expValue = parseFloat(sample.expiration_value);

    const active = event.markets.filter(m => parseFloat(m.volume_fp || 0) > 0);
    if (!active.length) continue;

    const candleResults = await pMapLimit(active, CONCURRENCY, async (m) => {
      const cs = await fetchKalshiCandles(m.ticker, open_ts, close_ts);
      return { m, cs };
    });

    const tickMap = new Map(); // ts(sec) -> Map<ticker, marketObj>
    for (const r of candleResults) {
      if (!r || r.__error) continue;
      const { m, cs } = r;
      for (const c of cs) {
        const ts = c.end_period_ts;
        const yesAsk = parseFloat(c.yes_ask?.close_dollars);
        const yesBid = parseFloat(c.yes_bid?.close_dollars);
        if (!Number.isFinite(yesAsk) || !Number.isFinite(yesBid)) continue;
        if (!tickMap.has(ts)) tickMap.set(ts, new Map());
        tickMap.get(ts).set(m.ticker, {
          ticker: m.ticker,
          subtitle: m.subtitle,
          yes_ask_dollars: yesAsk.toFixed(4),
          yes_bid_dollars: yesBid.toFixed(4),
          no_ask_dollars: (1 - yesBid).toFixed(4),
          no_bid_dollars: (1 - yesAsk).toFixed(4),
        });
      }
    }

    if (Number.isFinite(expValue)) {
      const ts = close_ts;
      if (!tickMap.has(ts)) tickMap.set(ts, new Map());
      for (const m of active) {
        if (tickMap.get(ts).has(m.ticker)) continue;
        const yesWins = expValue > parseFloat(m.floor_strike);
        tickMap.get(ts).set(m.ticker, {
          ticker: m.ticker,
          subtitle: m.subtitle,
          yes_ask_dollars: yesWins ? '1.0000' : '0.0000',
          yes_bid_dollars: yesWins ? '1.0000' : '0.0000',
          no_ask_dollars:  yesWins ? '0.0000' : '1.0000',
          no_bid_dollars:  yesWins ? '0.0000' : '1.0000',
        });
      }
    }

    const sortedTs = [...tickMap.keys()].sort((a, b) => a - b);
    for (const ts of sortedTs) {
      const markets = [...tickMap.get(ts).values()];
      const btc = btcMap.get(ts) ?? btcMap.get(ts - 60) ?? btcMap.get(ts + 60) ?? null;
      stream.write(JSON.stringify({ timestamp: ts * 1000, btcPrice: btc, markets }) + '\n');
      totalTicks++;
    }

    if ((i + 1) % 5 === 0 || i === events.length - 1) {
      console.log(`  [${i+1}/${events.length}] ${ev.event_ticker} (${active.length} mkts, total ticks=${totalTicks})`);
    }
  }

  stream.end();
  console.log(`\nWrote ${totalTicks} ticks to ${OUT}`);
})().catch(e => { console.error(e); process.exit(1); });
