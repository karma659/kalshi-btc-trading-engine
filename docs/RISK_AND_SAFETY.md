# Risk and Safety

This repository can submit real orders when deliberately configured to do so. Treat changes to execution, authentication, reconciliation, pricing, fees, persistence, and mode handling as safety-critical.

## Safe defaults

- The runtime starts in paper mode.
- `ALLOW_LIVE_MODE=true` is required before a live transition is accepted.
- Missing credentials keep the execution adapter in demo mode.
- The HTTP server binds to `127.0.0.1` unless explicitly overridden.
- Private keys, environment files, logs, generated datasets, and runtime state are ignored by Git.
- Live fills are confirmed against positions; accepted orders are not assumed filled.
- The engine refuses to guess when holdings cannot be read.
- Ambiguous closes stop automatic retry and require manual review.

## Before enabling live mode

1. Read the active strategy source and confirm which strategies are wired into `bot.js`.
2. Run `npm run validate`.
3. Replay the exact strategy and configuration on recent recorded data.
4. Review gross P&L, fees, spread assumptions, drawdown, sample size, and individual trades.
5. Run an extended paper session using the same data source and thresholds.
6. Confirm the API key is scoped appropriately and the private key lives outside the repository.
7. Confirm `HOST=127.0.0.1` or place the service behind authenticated, TLS-protected access.
8. Start with the smallest acceptable position limit.
9. Keep the Kalshi account UI available for independent position verification and manual intervention.
10. Record the configuration and commit SHA used for the session.

## Never do this

- Never commit an API key, private key, `.env`, position history, or raw account response.
- Never expose the dashboard directly to the internet.
- Never infer a fill from HTTP success alone.
- Never retry a close indefinitely when holdings are ambiguous.
- Never promote a strategy from replay to live solely because aggregate P&L is positive.
- Never treat a screenshot, backtest, or paper result as evidence of future returns.

## Incident response

If local and exchange state disagree:

1. Stop the process.
2. Inspect the actual exchange position and open orders.
3. Cancel resting orders from the exchange interface.
4. Resolve or close positions manually if appropriate.
5. Preserve logs and runtime state for analysis.
6. Rotate credentials if exposure is possible.
7. Reproduce the failure in paper mode.
8. Add a regression test before restoring live access.

If credentials are committed:

1. Revoke the key immediately.
2. Generate a new key pair.
3. Remove the secret from the complete Git history.
4. Review account and audit activity.
5. Do not assume deleting the current file removes the secret from prior commits.

## Model and data risks

- Recorded data may omit queue position, partial liquidity, latency, outages, or order rejection.
- Backtests are sensitive to data leakage, regime changes, sampling frequency, fee assumptions, and survivorship bias.
- Automatically retrained models can drift from the reviewed policy.
- The experimental TradingView feed uses an undocumented protocol and may change without notice.
- Exchange contracts, settlement rules, APIs, and fee schedules may change.

## Scope

This document is an engineering checklist, not financial, legal, tax, or compliance advice.
