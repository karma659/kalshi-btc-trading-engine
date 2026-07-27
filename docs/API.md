# Local API Reference

The API exists for the bundled single-operator dashboard. It is not authenticated and must remain bound to loopback or be placed behind an authenticated reverse proxy.

Default base URL: `http://127.0.0.1:4000`

## HTTP endpoints

### `GET /healthz`

Returns process liveness and public-data readiness without account or position details.

```json
{
  "status": "ok",
  "mode": "paper",
  "marketDataReady": true,
  "btcPriceReady": true,
  "lastMarketFetchAt": "2026-07-27T16:18:17.137Z",
  "engineUpdatedAt": "2026-07-27T16:18:17.137Z"
}
```

### `GET /api/kalshi`

Returns the normalized current event, visible contract quotes, selected BTC price, and source link. An optional `ticker` query parameter requests a specific event.

### `GET /api/trades`

Returns the local successful-trade log as plain text. This can contain operational details and is one reason the service must remain private.

### `GET /api/bot-mode`

Returns the effective mode:

```json
{ "mode": "paper" }
```

The effective mode remains `paper` unless live mode was allowed at process start and credentials loaded successfully.

### `POST /api/bot-mode`

Requests a mode transition:

```json
{ "mode": "live" }
```

The response contains the effective mode. A live request is rejected to paper unless all live gates are satisfied.

### `GET /api/bot-state`

Returns the dashboard snapshot: aggregate realized result, one active position if present, recent trade history, effective mode, configuration, and last engine update.

### `POST /api/close-position`

Requests a manual close for the supplied ticker:

```json
{ "ticker": "KXBTC15M-..." }
```

In live mode, the engine first reads actual holdings and refuses to guess if they cannot be confirmed.

## WebSocket

Connect to the same host and port used by HTTP.

Server messages:

| Type | Purpose |
| --- | --- |
| `welcome` | Connection acknowledgement |
| `snapshot` | Complete current public-market snapshot |
| `tick` | Throttled BTC price and contract quote update |

Client heartbeat:

```json
{ "type": "ping" }
```

Response:

```json
{ "type": "pong", "ts": "2026-07-27T16:18:17.137Z" }
```

## Trust boundary

There is intentionally no public API deployment configuration. Mode changes and manual closes mutate engine state, while trade and bot-state endpoints expose operational information. Do not publish this port directly.
