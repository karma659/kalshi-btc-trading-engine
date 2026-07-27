# Operations Guide

The main [README](README.md) contains setup, architecture, backtesting, and safety documentation. This guide is the short operational reference.

## Start the default engine

```bash
cd backend
npm ci
cp .env.example .env
npm start
```

This starts:

- the shared Kalshi/BTC data pipeline;
- the V1 strategy engine in paper mode;
- the REST and WebSocket API;
- the local dashboard at `http://127.0.0.1:4000`.

Without credentials, authenticated order actions remain simulated.

## Start the V13 paper learner

In a separate terminal:

```bash
cd backend
npm run v13
```

The V13 process is intentionally separate from the default engine. It keeps its own paper state, observations, logs, and retraining lifecycle under `backend/past_trades/`.

## Health check

```bash
curl --fail http://127.0.0.1:4000/healthz
```

The response reports process health, paper/live mode, and data readiness without returning positions or account details.

## Runtime files

The engine creates `backend/past_trades/` automatically. Important files include:

| File | Purpose |
| --- | --- |
| `bot-config.json` | Mode and operator-tunable thresholds |
| `bot-state.json` | Persisted engine results and state |
| `trades.txt` | Successful trade events |
| `strategy13-state.json` | V13 paper learner state |
| `strategy13-trades.txt` | V13 paper trade log |
| `*.jsonl` | Recorded market or learner observations |

All runtime files are ignored by Git.

## Enable live mode deliberately

Live mode requires both a process-level opt-in and credentials:

```dotenv
ALLOW_LIVE_MODE=true
KALSHI_API_KEY_ID=your-key-id
KALSHI_PRIVATE_KEY_PATH=/absolute/path/outside-the-repository/kalshi-private-key.pem
```

Restart the process after editing `.env`. Validate in paper mode first, keep the service local, and read [Risk and Safety](docs/RISK_AND_SAFETY.md).

## Stop

Use `Ctrl+C`. The engine persists state during normal operation; always confirm actual exchange positions independently before assuming the account is flat.
