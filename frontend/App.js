const { useState, useEffect, useRef } = React;

function calculatePayout(askPrice, betAmount = 10, notional = 1) {
  if (!askPrice || askPrice <= 0) return '';
  return `$${(betAmount * (notional / askPrice)).toFixed(2)}`;
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ color: '#f87171', padding: '2rem' }}>
          <h3>UI Error</h3><pre>{this.state.error?.toString()}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── PnL colour helper ────────────────────────────────────────────────────────
function pnlColor(val) {
  return val >= 0 ? '#4ade80' : '#f87171';
}

function pnlSign(val) {
  return val >= 0 ? '+' : '';
}

// ── Right Panel ──────────────────────────────────────────────────────────────
function BotPanel({ botState }) {
  const { totalProfit = 0, position = null, tradeHistory = [], config = {} } = botState || {};
  const isRunning = !!(botState && botState.lastUpdated);
  const mode = botState?.mode === 'live' ? 'live' : 'paper';
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState(null);

  // Determine if the last update is stale (> 5s old) — bot may not be running
  const stale = !botState?.lastUpdated || (Date.now() - new Date(botState.lastUpdated).getTime()) > 5000;

  const toggleMode = async () => {
    const next = mode === 'live' ? 'paper' : 'live';
    if (next === 'live' && !window.confirm('Switch to LIVE mode? Real money will be used on your Kalshi account.')) return;
    try {
      await fetch('/api/bot-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: next })
      });
    } catch (e) { console.error('Failed to set mode', e); }
  };

  const closePosition = async () => {
    if (!position) return;
    const warning = mode === 'live'
      ? `Close this position now? This sells x${position.numContracts} ${position.subtitle} (${position.side.toUpperCase()}) at the current bid — real money.`
      : `Close this paper position now?`;
    if (!window.confirm(warning)) return;
    setClosing(true);
    setCloseError(null);
    try {
      const resp = await fetch('/api/close-position', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: position.ticker })
      });
      const result = await resp.json();
      if (!result.ok) setCloseError(result.error || 'Failed to close position.');
    } catch (e) {
      setCloseError('Failed to reach the server.');
    } finally {
      setClosing(false);
    }
  };

  return (
    <div className="bot-panel">
      <div className="bot-panel-header" style={{ marginBottom: '0.25rem', paddingBottom: '0.25rem' }}>
        <h2 style={{ fontSize: '1.2rem', margin: 0 }}>Bot Dashboard</h2>
        <span className={`bot-status-dot ${stale ? 'stale' : 'active'}`}>
          {stale ? 'Bot Offline' : 'Bot Live'}
        </span>
      </div>

      {/* ── Mode Toggle (Paper / Live) ─────────────────────────── */}
      <div className="mode-toggle-row" style={{ margin: '0 0 0.5rem 0' }}>
        <span className="mode-label">Mode</span>
        <button
          type="button"
          className={`mode-switch ${mode === 'live' ? 'live' : 'paper'}`}
          onClick={toggleMode}
          title={mode === 'live' ? 'Click to switch to PAPER (no real trades)' : 'Click to switch to LIVE (real trades)'}
        >
          <span className="mode-track">
            <span className="mode-thumb" />
          </span>
          <span className="mode-text">{mode === 'live' ? 'LIVE' : 'PAPER'}</span>
        </button>
      </div>

      {/* ── Profit Cards ─────────────────────────────────────────── */}
      <div className="profit-group" style={{ display: 'flex', gap: '0.25rem', marginBottom: '0.25rem' }}>
        <div className="profit-card" style={{ flex: 1, margin: 0, padding: '0.4rem 0.5rem' }}>
          <div className="profit-label">Total Profit</div>
          <div className="profit-value" style={{ color: pnlColor(totalProfit), fontSize: '1.25rem', fontWeight: 'bold' }}>
            {pnlSign(totalProfit)}${Math.abs(totalProfit).toFixed(2)}
          </div>
          <div className="profit-meta">{tradeHistory.length} trades closed</div>
        </div>
        <div className="profit-card" style={{ flex: 1, margin: 0, padding: '0.4rem 0.5rem' }}>
          <div className="profit-label">Current Profit</div>
          <div className="profit-value" style={{ color: pnlColor(position?.pnl || 0), fontSize: '1.25rem', fontWeight: 'bold' }}>
            {position ? `${pnlSign(position.pnl)}$${Math.abs(Number(position.pnl)).toFixed(2)}` : '$0.00'}
          </div>
          <div className="profit-meta">{position ? 'Unrealised' : 'Flat'}</div>
        </div>
      </div>

      {/* ── Current Trade (Kalshi Portfolio Style) ──────────────── */}
      {position ? (
        <div className="position-card">
          <div className="position-header">
            <h3 style={{ fontSize: '1.1rem', margin: 0 }}>{position.subtitle}</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <span className="side-badge" style={{ backgroundColor: position.side === 'yes' ? '#10b981' : '#ef4444' }}>
                {position.side.toUpperCase()}
              </span>
              <button
                type="button"
                onClick={closePosition}
                disabled={closing || position.closeFailed}
                title={position.closeFailed ? 'Previous close attempt needs manual review' : 'Sell this position now at the current bid'}
                style={{
                  fontSize: '0.75rem', padding: '0.25rem 0.55rem', borderRadius: '5px',
                  border: '1px solid #f87171', background: 'transparent', color: '#f87171',
                  cursor: (closing || position.closeFailed) ? 'not-allowed' : 'pointer',
                  opacity: (closing || position.closeFailed) ? 0.5 : 1
                }}
              >
                {closing ? 'Closing…' : 'Close Position'}
              </button>
            </div>
          </div>
          {closeError && (
            <div style={{ fontSize: '0.75rem', color: '#f87171', marginTop: '0.25rem' }}>{closeError}</div>
          )}

          <div className="position-metrics" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.25rem', padding: '0.5rem', backgroundColor: 'rgba(0,0,0,0.15)', borderRadius: '6px', marginTop: '0.25rem' }}>
            <div>
              <div style={{ fontSize: '0.7rem', color: '#94a3b8', textTransform: 'uppercase' }}>Bought at</div>
              <div style={{ fontSize: '0.95rem', fontWeight: 'bold' }}>${Number(position.entryPrice).toFixed(2)} <span style={{ fontSize: '0.75rem', fontWeight: 'normal', color: '#94a3b8' }}>({Math.round(position.entryPrice * 100)}%)</span></div>
            </div>
            <div>
              <div style={{ fontSize: '0.7rem', color: '#94a3b8', textTransform: 'uppercase' }}>Now</div>
              <div style={{ fontSize: '0.95rem', fontWeight: 'bold' }}>${Number(position.currentBid).toFixed(2)} <span style={{ fontSize: '0.75rem', fontWeight: 'normal', color: '#94a3b8' }}>({Math.round(position.currentBid * 100)}%)</span></div>
            </div>
            <div>
              <div style={{ fontSize: '0.7rem', color: '#94a3b8', textTransform: 'uppercase' }}>Cost</div>
              <div style={{ fontSize: '0.95rem', fontWeight: 'bold' }}>${Number(position.cost).toFixed(2)} <span style={{ fontSize: '0.75rem', fontWeight: 'normal', color: '#94a3b8' }}>({position.numContracts}x)</span></div>
            </div>
            <div>
              <div style={{ fontSize: '0.7rem', color: '#94a3b8', textTransform: 'uppercase' }}>Value</div>
              <div style={{ fontSize: '0.95rem', fontWeight: 'bold' }}>${(position.numContracts * position.currentBid).toFixed(2)}</div>
            </div>
            <div style={{ gridColumn: 'span 2', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #334155', paddingTop: '0.25rem', marginTop: '0.1rem' }}>
              <div style={{ fontSize: '0.85rem' }}>
                <span style={{ color: '#94a3b8' }}>Payout if {position.side.toUpperCase()}: </span>
                <strong style={{ color: '#f8fafc' }}>${Number(position.numContracts).toFixed(2)}</strong>
              </div>
              <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                TP: +${(config.takeProfit !== undefined ? config.takeProfit : 1.20).toFixed(2)} | SL: -${Math.abs(config.stopLoss !== undefined ? config.stopLoss : 3.00).toFixed(2)}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="no-trade">
          {stale ? 'Start the server to activate' : 'Scanning for entry...'}
        </div>
      )}

      {/* ── Trade History ────────────────────────────────────────── */}
      {tradeHistory.length > 0 && (
        <div className="trade-history">
          <div className="trade-card-title" style={{ fontSize: '1rem', fontWeight: 'bold', marginBottom: '0.25rem', marginTop: '0.25rem' }}>Recent Trades</div>
          <div className="history-list">
            {[...tradeHistory].reverse().slice(0, 8).map((t, i) => (
              <div key={i} className="history-row">
                <span className={`history-result ${t.result === 'TP' ? 'tp' : t.result === 'SL' ? 'sl' : 'settled'}`}>
                  {t.result}
                </span>
                <span className="history-contract">
                  {t.subtitle} 
                  <span style={{ color: t.side === 'yes' ? '#10b981' : '#ef4444', fontWeight: 'bold', fontSize: '0.85em', marginLeft: '6px' }}>({t.side?.toUpperCase()})</span>
                  {(t.strategy || t.closedAt) && (
                    <span style={{ display: 'block', fontSize: '0.8em', color: '#94a3b8', marginTop: '2px' }}>
                      {[t.strategy ? `Strategy: ${t.strategy}` : null, t.closedAt ? new Date(t.closedAt).toLocaleTimeString('en-US', { timeZone: 'America/New_York' }) : null].filter(Boolean).join(' • ')}
                    </span>
                  )}
                </span>
                <span className="history-pnl" style={{ color: pnlColor(t.pnl) }}>
                  {pnlSign(t.pnl)}${Math.abs(t.pnl).toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main App ─────────────────────────────────────────────────────────────────
function App() {
  const [data,     setData]     = useState(null);
  const [status,   setStatus]   = useState('Connecting...');
  const [error,    setError]    = useState(null);
  const [botState, setBotState] = useState(null);

  // ── Market data via WebSocket ────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/kalshi')
      .then(r => r.json())
      .then(json => { if (json.error) throw new Error(json.error); setData(json); })
      .catch(() => setError('Failed to load market data.'));

    let ws, reconnectTimer;

    const connect = () => {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${window.location.host}`);
      ws.onopen  = () => setStatus('Live');
      ws.onclose = () => { setStatus('Reconnecting...'); reconnectTimer = setTimeout(connect, 2000); };
      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'tick') {
          setData(prev => prev ? { ...prev, btcPrice: msg.btcPrice, contracts: msg.contracts || prev.contracts } : null);
        } else if (msg.type === 'snapshot') {
          setData(msg.data);
        }
      };
    };

    connect();
    return () => { clearTimeout(reconnectTimer); if (ws) { ws.onclose = null; ws.close(); } };
  }, []);

  // ── Poll bot state every 1s ──────────────────────────────────────────────
  useEffect(() => {
    const poll = () =>
      fetch('/api/bot-state')
        .then(r => r.json())
        .then(setBotState)
        .catch(() => {});
    poll();
    const id = setInterval(poll, 1000);
    return () => clearInterval(id);
  }, []);

  if (error) return <div style={{ color: '#f87171', padding: '2rem' }}>{error}</div>;
  if (!data)  return <div style={{ padding: '2rem', color: '#94a3b8' }}>Loading market data...</div>;

  // Show only contracts within ±$300 of live BTC price
  const filteredContracts = (data.contracts || []).filter(c => {
    if (!data.btcPrice) return true;
    const m = c?.subtitle && String(c.subtitle).match(/[\d,]+(\.\d+)?/);
    if (m) {
      const strike = parseFloat(m[0].replace(/,/g, ''));
      return strike >= data.btcPrice - 300 && strike <= data.btcPrice + 300;
    }
    return true;
  });

  return (
    <div className="container">
      <header>
        <h1 style={{ fontSize: '1.5rem', margin: 0 }}>Kalshi BTC Tracker</h1>
        <div className={`status-badge ${status === 'Live' ? 'live' : 'disconnected'}`}>{status}</div>
      </header>

      <main className="dashboard">

        {/* ── LEFT PANEL ─────────────────────────────────────────── */}
        <div className="left-panel">
          <section className="live-price-card">
            <label>Live BTC Price</label>
            <div className="price-display" style={{ fontSize: '1.75rem', fontWeight: 'bold' }}>
              ${data.btcPrice ? data.btcPrice.toLocaleString(undefined, { minimumFractionDigits: 2 }) : '---.--'}
            </div>
          </section>

       

          <section className="price-list">
            <h3 style={{ fontSize: '1.1rem', marginTop: 0 }}>Contracts (±$300 of spot)</h3>
            <div className="contract-table">
              {filteredContracts.length > 0 ? filteredContracts.map((c, i) => (
                <div key={i} className="contract-row">
                  <span className="strike">{c.subtitle}</span>
                  <span className="yes-price">
                    Yes: {c.yesAsk ? `${Math.round(c.yesAsk * 100)}¢` : '--'}
                    {c.yesAsk > 0 && <span className="payout-hint">{calculatePayout(c.yesAsk)}</span>}
                  </span>
                  <span className="no-price">
                    No: {c.noAsk ? `${Math.round(c.noAsk * 100)}¢` : '--'}
                    {c.noAsk > 0 && <span className="payout-hint">{calculatePayout(c.noAsk)}</span>}
                  </span>
                </div>
              )) : <p style={{ color: '#94a3b8' }}>No contracts within ±$300 of current BTC price.</p>}
            </div>

            <div className="metadata" style={{ fontSize: '0.85em', marginTop: '1.5rem', borderTop: '1px solid #334155', paddingTop: '0.75rem' }}>
              <div className="meta-item">
                <strong>Source:</strong>
                {data.url ? <a href={data.url} target="_blank" rel="noopener noreferrer">View on Kalshi</a> : ' N/A'}
              </div>
              <div className="meta-item">
                <strong>Last Update:</strong>{' '}
                {data.fetchedAt ? new Date(data.fetchedAt).toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' }) : 'Waiting...'}
              </div>
           
            <h2 style={{ fontSize: '1.2rem', margin: '0.5rem 0' }}>{data.title || 'Loading Market...'}</h2>
            <p className="description" style={{ fontSize: '0.9rem' }}>{data.description || 'Waiting for Kalshi market data'}</p>
     
            </div>
          </section>
        </div>

        {/* ── RIGHT PANEL ────────────────────────────────────────── */}
        <div className="right-panel">
          <BotPanel botState={botState} />
        </div>
      </main>

      <footer>
        <p>Kalshi API &bull; Real-time WebSocket &bull; run <code>node backend/index.js</code></p>
      </footer>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<ErrorBoundary><App /></ErrorBoundary>);
