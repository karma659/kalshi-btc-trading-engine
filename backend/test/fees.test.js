const test = require('node:test');
const assert = require('node:assert/strict');

const { FEE_RATE, kalshiFee, roundTripFeePerContract } = require('../fees');

test('uses the documented default fee rate', () => {
  assert.equal(FEE_RATE, 0.07);
});

test('rounds the whole-order fee up to the next cent', () => {
  // 0.07 * 10 * 0.50 * 0.50 = 0.175, which rounds up to $0.18.
  assert.equal(kalshiFee(0.5, 10), 0.18);
});

test('returns zero for invalid or degenerate orders', () => {
  assert.equal(kalshiFee(0, 10), 0);
  assert.equal(kalshiFee(1, 10), 0);
  assert.equal(kalshiFee(0.5, 0), 0);
  assert.equal(kalshiFee('not-a-price', 10), 0);
});

test('computes the unrounded per-contract round-trip hurdle', () => {
  assert.equal(roundTripFeePerContract(0.5), 0.035);
});
