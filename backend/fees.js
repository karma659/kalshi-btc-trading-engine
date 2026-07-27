/**
 * Kalshi trading-fee model.
 *
 * Kalshi charges a trading fee on each order, computed on the WHOLE order quantity and
 * rounded UP to the next cent (not per contract). The published general formula is:
 *
 *     fee = ceil( FEE_RATE · C · P · (1 − P) )      [in dollars]
 *
 *   • C = number of contracts in the order
 *   • P = price per contract in dollars (0..1)
 *   • FEE_RATE = 0.07 for the general schedule
 *
 * The fee is largest at P = 0.50 (P·(1−P) peaks there) and vanishes toward 0/1 — i.e. you
 * pay the most near a balanced 50% market, which is the band V1/V6 target. Fees are
 * charged on entry and again on any pre-settlement sell; contracts held to settlement
 * incur no exit fee.
 *
 * NB: this is a model, not a billing oracle. Specific markets can carry different rates,
 * and maker/taker schedules exist — adjust FEE_RATE if Kalshi's statements disagree.
 */

const FEE_RATE = 0.07;

/**
 * Fee in dollars for trading `contracts` at `priceDollars` (0..1), rounded up to the cent.
 * Returns 0 for degenerate inputs so callers can add it unconditionally.
 */
function kalshiFee(priceDollars, contracts, rate = FEE_RATE) {
  const p = Number(priceDollars);
  const c = Number(contracts);
  if (!Number.isFinite(p) || !Number.isFinite(c) || c <= 0 || p <= 0 || p >= 1) return 0;
  return Math.ceil(rate * c * p * (1 - p) * 100) / 100;
}

/**
 * Per-contract round-trip fee hurdle (entry + exit) at a given price, in dollars — the
 * AMORTIZED, un-rounded rate (`rate · P · (1−P)` per leg). We deliberately skip the
 * per-order ceil() here: that rounding is a fixed cost spread across the whole order, so
 * over a realistic lot it washes out. Strategies use this as the minimum edge their
 * mispricing must clear before an order is worth placing.
 */
function roundTripFeePerContract(priceDollars, rate = FEE_RATE) {
  const p = Number(priceDollars);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  return 2 * rate * p * (1 - p);
}

module.exports = { kalshiFee, roundTripFeePerContract, FEE_RATE };
