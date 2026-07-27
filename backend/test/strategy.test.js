const test = require('node:test');
const assert = require('node:assert/strict');

const strategy = require('../strategy');

test('returns no entry for an empty market list', () => {
  assert.equal(strategy.chooseEntry([]), null);
});

test('requires both sides of the market to be inside the configured band', () => {
  const market = {
    ticker: 'KXBTC15M-TEST',
    yes_ask_dollars: '0.50',
    no_ask_dollars: '0.70'
  };
  assert.equal(strategy.chooseEntry([market]), null);
});

test('returns an eligible entry with a normalized side and numeric ask', () => {
  const market = {
    ticker: 'KXBTC15M-TEST',
    yes_ask_dollars: '0.49',
    no_ask_dollars: '0.51'
  };
  const entry = strategy.chooseEntry([market]);

  assert.equal(entry.market, market);
  assert.ok(entry.side === 'yes' || entry.side === 'no');
  assert.equal(typeof entry.ask, 'number');
  assert.ok(entry.ask >= strategy.MIN_PROB && entry.ask <= strategy.MAX_PROB);
});

test('selects the side closest to 50 percent implied probability', () => {
  const market = {
    ticker: 'KXBTC15M-TEST',
    yes_ask_dollars: '0.51',
    no_ask_dollars: '0.58'
  };
  const entry = strategy.chooseEntry([market]);

  assert.equal(entry.side, 'yes');
  assert.equal(entry.ask, 0.51);
});
