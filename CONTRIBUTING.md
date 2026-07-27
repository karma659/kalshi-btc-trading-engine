# Contributing

Thanks for improving the project. Changes should preserve paper-first operation, reproducibility, and the separation between strategy decisions and authenticated execution.

## Development setup

```bash
git clone https://github.com/karma659/kalshi-btc-trading-engine.git
cd kalshi-btc-trading-engine/backend
npm ci
cp .env.example .env
npm run validate
```

Python is optional unless the change touches model training:

```bash
python3 -m venv .venv-ml
source .venv-ml/bin/activate
python -m pip install -r requirements-ml.txt
python -m compileall -q .
```

## Pull requests

Keep each pull request focused. Include:

- the problem and intended behavior;
- the affected runtime path;
- validation commands and results;
- paper-mode or replay evidence for strategy/execution changes;
- screenshots for dashboard changes;
- any new environment variables or persistence changes;
- explicit discussion of failure behavior.

## High-risk changes

Changes to these areas require regression tests and paper-mode evidence:

- order mapping or signing;
- paper/live mode transitions;
- position reconciliation or fill confirmation;
- fee calculation;
- settlement behavior;
- state migration and persistence;
- model loading or automated retraining;
- dashboard controls that mutate engine state.

Do not merge a high-risk change based only on a successful syntax check.

## Style

- Use clear names and comments that explain why a safety check exists.
- Prefer small functions with explicit inputs and outputs.
- Keep strategy modules free of direct exchange calls.
- Avoid silent fallbacks between materially different data sources.
- Keep generated data and credentials out of commits.
- Update documentation when commands, defaults, or architecture change.

## Commit hygiene

- Never commit `.env`, PEM files, runtime state, logs, or recorded account data.
- Do not commit generated binaries or editor metadata.
- Use an imperative commit subject, such as `Add fill-confirmation regression test`.

## Reporting security issues

Follow [SECURITY.md](SECURITY.md). Do not open a public issue containing credentials, account details, or an exploitable vulnerability.
