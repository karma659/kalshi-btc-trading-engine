# Running Kalshi Trading Bot

Two separate processes: **V1 (live trading)** and **V13 (paper learning)** run independently.

## Quick Start

### Terminal 1: V1 Live Trading (with dashboard)
```bash
cd backend
npm start
```

This runs `index.js` → `bot.js` with V1 strategy only:
- **Mode**: determined by `bot-config.json` (`mode: "live"` or `"paper"`)
- **Strategy**: V1 (Volatility Scalping coin-flip)
- **Dashboard**: http://localhost:4000 (shows live positions, trades)
- **Logging**: `past_trades/trades.txt`

### Terminal 2: V13 Paper Learning (separate process)
```bash
cd backend
npm run v13
```

This runs `run-strategy13.js` — completely independent:
- **Mode**: paper only (no real money)
- **Strategy**: V13 (Learned Entry-Exit Model)
- **Auto-retrain**: learns from its own trades every 24h
- **Logging**: `past_trades/strategy13-trades.txt`
- **State**: `past_trades/strategy13-state.json`

Both processes run in parallel with **zero interference**.

## Configuration

### V1 (bot.js, via `bot-config.json`)
```json
{
  "targetBet": 5.5,
  "takeProfit": 2.8,
  "stopLoss": -2.5,
  "mode": "live"
}
```

### V13 (run-strategy13.js, via env vars)
```bash
V13_MODE=paper npm run v13                    # paper mode (default)
V13_TARGET_BET=2.5 npm run v13                # override bet size
V13_POLL_MS=2000 npm run v13                  # polling interval
V13_RETRAIN_INTERVAL_MS=86400000 npm run v13  # retrain every 24h
```

## Understanding the Split

| Component | V1 (Live) | V13 (Paper) |
|---|---|---|
| **Process** | index.js → bot.js | run-strategy13.js |
| **Mode** | Live or paper | Paper only |
| **Strategies** | V1 only | V13 only |
| **Logs** | trades.txt | strategy13-trades.txt |
| **State** | bot-state.json | strategy13-state.json |
| **Dashboard** | Yes (4000) | No |
| **Auto-retrain** | No | Yes (24h) |

## Monitoring

### V1 Trades
```bash
tail -f past_trades/trades.txt | grep "BUY\|TAKE PROFIT\|STOP LOSS"
```

### V13 Trades
```bash
tail -f past_trades/strategy13-trades.txt | grep "ENTRY\|EXIT"
```

### V13 Learning Progress
```bash
ls -la past_trades/strategy13-*.json
```

## Stopping

- **V1**: Ctrl+C in Terminal 1 (run.sh restarts it — run.sh is optional, you can also just run `node index.js`)
- **V13**: Ctrl+C in Terminal 2
- Both gracefully save state on exit

## Troubleshooting

### V13 says "BTC price unavailable"
- Check V1's Coinbase WS feed is up
- V13 doesn't fetch its own BTC — it waits for Kalshi markets to appear
- Retry after a moment

### V13 model won't load
- Check `strategy13-model.json` exists
- If missing: `cd backend && .venv-ml/bin/python train-strategy13.py`

### "insufficient_balance" errors in V13
- Paper balance resets in `strategy13-state.json` → edit if needed
- Default: $10,000 paper

## Development

### Retrain V13 manually
```bash
cd backend
.venv-ml/bin/python train-strategy13.py
```

### Live model update
- Auto-retrain fires every 24h (configurable via `V13_RETRAIN_INTERVAL_MS`)
- V13 learns from its own trades in `strategy13-live-data.jsonl` (auto-logged)
- Model reloads automatically after retrain completes
