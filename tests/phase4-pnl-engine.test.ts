import {
  calculatePositionPnl,
  calculateAggregatePnl,
  PnlValidationError,
} from '../server/pnl/calculator';
import { PnlEngine } from '../server/pnl/engine';
import {
  FIXTURE_LONG_FUT_PROFIT,
  FIXTURE_LONG_FUT_LOSS,
  FIXTURE_SHORT_FUT_PROFIT,
  FIXTURE_SHORT_FUT_LOSS,
  FIXTURE_LONG_OPT_PROFIT,
  FIXTURE_SHORT_OPT_PROFIT,
  FIXTURE_ZERO_QTY_CLOSED,
  FIXTURE_EQUITY_WITH_PNL,
  FIXTURE_EQUITY_MISLEADING_SYMBOL,
} from '../server/pnl/fixtures';
import { MockZerodhaAdapter } from '../server/brokers/mock/adapter';
import { MOCK_INSTRUMENT_MAP } from '../server/instruments/master';
import { normalizePositions } from '../server/brokers/normalize';
import { ServerRiskStore } from '../server/risk/store';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

console.log('================================================================');
console.log('TRADING FIREWALL: PHASE 4 VERIFICATION SUITE');
console.log('Authoritative Gross P&L Engine, Precision & Invariants');
console.log('================================================================\n');

// -------------------------------------------------------------
// TEST 1: LONG FUTURE PROFIT
// quantity = +50, averagePrice = 100, lastPrice = 110 -> unrealised = +500
// -------------------------------------------------------------
console.log('[Test 1] Long Future Profit: (110 - 100) * 50 = +500');
const res1 = calculatePositionPnl(FIXTURE_LONG_FUT_PROFIT);
assert(res1.unrealisedPnl === 500, `Expected unrealisedPnl = 500, got ${res1.unrealisedPnl}`);
assert(res1.totalPnl === 500, `Expected totalPnl = 500, got ${res1.totalPnl}`);
console.log('  ✓ PASSED: Long future profit calculated correctly (+₹500.00)');

// -------------------------------------------------------------
// TEST 2: LONG FUTURE LOSS
// quantity = +50, averagePrice = 100, lastPrice = 90 -> unrealised = -500
// -------------------------------------------------------------
console.log('\n[Test 2] Long Future Loss: (90 - 100) * 50 = -500');
const res2 = calculatePositionPnl(FIXTURE_LONG_FUT_LOSS);
assert(res2.unrealisedPnl === -500, `Expected unrealisedPnl = -500, got ${res2.unrealisedPnl}`);
assert(res2.totalPnl === -500, `Expected totalPnl = -500, got ${res2.totalPnl}`);
console.log('  ✓ PASSED: Long future loss calculated correctly (-₹500.00)');

// -------------------------------------------------------------
// TEST 3: SHORT FUTURE PROFIT
// quantity = -50, averagePrice = 100, lastPrice = 90 -> unrealised = +500
// -------------------------------------------------------------
console.log('\n[Test 3] Short Future Profit: (90 - 100) * -50 = +500');
const res3 = calculatePositionPnl(FIXTURE_SHORT_FUT_PROFIT);
assert(res3.unrealisedPnl === 500, `Expected unrealisedPnl = 500, got ${res3.unrealisedPnl}`);
assert(res3.totalPnl === 500, `Expected totalPnl = 500, got ${res3.totalPnl}`);
console.log('  ✓ PASSED: Short future profit calculated correctly via signed formula (+₹500.00)');

// -------------------------------------------------------------
// TEST 4: SHORT FUTURE LOSS
// quantity = -50, averagePrice = 100, lastPrice = 110 -> unrealised = -500
// -------------------------------------------------------------
console.log('\n[Test 4] Short Future Loss: (110 - 100) * -50 = -500');
const res4 = calculatePositionPnl(FIXTURE_SHORT_FUT_LOSS);
assert(res4.unrealisedPnl === -500, `Expected unrealisedPnl = -500, got ${res4.unrealisedPnl}`);
assert(res4.totalPnl === -500, `Expected totalPnl = -500, got ${res4.totalPnl}`);
console.log('  ✓ PASSED: Short future loss calculated correctly via signed formula (-₹500.00)');

// -------------------------------------------------------------
// TEST 5: LONG OPTION PROFIT
// quantity = +25, averagePrice = 80, lastPrice = 120 -> unrealised = +1000
// -------------------------------------------------------------
console.log('\n[Test 5] Long Option Profit: (120 - 80) * 25 = +1000');
const res5 = calculatePositionPnl(FIXTURE_LONG_OPT_PROFIT);
assert(res5.unrealisedPnl === 1000, `Expected unrealisedPnl = 1000, got ${res5.unrealisedPnl}`);
assert(res5.totalPnl === 1000, `Expected totalPnl = 1000, got ${res5.totalPnl}`);
console.log('  ✓ PASSED: Long option profit calculated accurately (+₹1,000.00)');

// -------------------------------------------------------------
// TEST 6: SHORT OPTION PROFIT
// quantity = -25, averagePrice = 120, lastPrice = 80 -> unrealised = +1000
// -------------------------------------------------------------
console.log('\n[Test 6] Short Option Profit: (80 - 120) * -25 = +1000');
const res6 = calculatePositionPnl(FIXTURE_SHORT_OPT_PROFIT);
assert(res6.unrealisedPnl === 1000, `Expected unrealisedPnl = 1000, got ${res6.unrealisedPnl}`);
assert(res6.totalPnl === 1000, `Expected totalPnl = 1000, got ${res6.totalPnl}`);
console.log('  ✓ PASSED: Short option profit calculated accurately (+₹1,000.00)');

// -------------------------------------------------------------
// TEST 7: ZERO-QUANTITY CLOSED POSITION
// quantity = 0, realisedPnl = 1200 -> realisedPnl = 1200, unrealisedPnl = 0, totalPnl = 1200
// -------------------------------------------------------------
console.log('\n[Test 7] Zero-Quantity Closed Position');
const res7 = calculatePositionPnl(FIXTURE_ZERO_QTY_CLOSED);
assert(res7.quantity === 0, 'Quantity must be 0');
assert(res7.realisedPnl === 1200, `Expected realisedPnl = 1200, got ${res7.realisedPnl}`);
assert(res7.unrealisedPnl === 0, `Expected unrealisedPnl = 0 for zero quantity, got ${res7.unrealisedPnl}`);
assert(res7.totalPnl === 1200, `Expected totalPnl = 1200, got ${res7.totalPnl}`);
console.log('  ✓ PASSED: Zero-quantity squared-off position retains realized P&L with zero unrealized');

// -------------------------------------------------------------
// TEST 8: EQUITY EXCLUDED FROM AGGREGATE
// -------------------------------------------------------------
console.log('\n[Test 8] Equity Excluded from Aggregate F&O P&L');
const equityPosPnl = calculatePositionPnl(FIXTURE_EQUITY_WITH_PNL);
assert(equityPosPnl.totalPnl === 4000, 'Position-level calculation for equity exists');

// Aggregate containing 1 F&O future and 1 equity
const mixedPositions = [FIXTURE_LONG_FUT_PROFIT, FIXTURE_EQUITY_WITH_PNL];
const aggMixed = calculateAggregatePnl(mixedPositions);

// F&O aggregate must ONLY reflect the long future (+500), ignoring equity's +4000
assert(aggMixed.totalPnl === 500, `Expected F&O totalPnl = 500, got ${aggMixed.totalPnl}`);
assert(aggMixed.grossTradingPnl === 500, `Expected grossTradingPnl = 500, got ${aggMixed.grossTradingPnl}`);
assert(aggMixed.fnoPositionCount === 1, `Expected fnoPositionCount = 1, got ${aggMixed.fnoPositionCount}`);
assert(aggMixed.totalPositionCount === 2, `Expected totalPositionCount = 2, got ${aggMixed.totalPositionCount}`);
console.log('  ✓ PASSED: Equities strictly excluded from F&O aggregate P&L calculation');

// -------------------------------------------------------------
// TEST 9: METADATA-DRIVEN F&O (Misleading symbol name)
// -------------------------------------------------------------
console.log('\n[Test 9] Metadata-Driven F&O (Symbol ending with FUT on NSE-EQ)');
const misleadingPositions = [FIXTURE_LONG_FUT_PROFIT, FIXTURE_EQUITY_MISLEADING_SYMBOL];
const aggMisleading = calculateAggregatePnl(misleadingPositions);

assert(aggMisleading.fnoPositionCount === 1, 'Only genuine F&O contract included');
assert(aggMisleading.totalPnl === 500, 'FUT-named equity must not contribute to F&O P&L');
console.log('  ✓ PASSED: Symbol name heuristics bypassed; metadata strictly enforced');

// -------------------------------------------------------------
// TEST 10: INCLUDE REALIZED = TRUE
// -------------------------------------------------------------
console.log('\n[Test 10] RiskConfig includeRealisedPnl = true');
const testPositions = [FIXTURE_LONG_FUT_PROFIT, FIXTURE_ZERO_QTY_CLOSED]; // Unrealised: +500, Realised: +1200
const res10 = calculateAggregatePnl(testPositions, { includeRealisedPnl: true, includeUnrealisedPnl: true });
assert(res10.realisedPnl === 1200, 'Calculated realisedPnl must be 1200');
assert(res10.includedRealisedPnl === 1200, 'includedRealisedPnl must be 1200');
assert(res10.grossTradingPnl === 1700, `Expected grossTradingPnl = 1700, got ${res10.grossTradingPnl}`);
console.log('  ✓ PASSED: Realized P&L contributes when includeRealisedPnl = true');

// -------------------------------------------------------------
// TEST 11: INCLUDE REALIZED = FALSE
// -------------------------------------------------------------
console.log('\n[Test 11] RiskConfig includeRealisedPnl = false');
const res11 = calculateAggregatePnl(testPositions, { includeRealisedPnl: false, includeUnrealisedPnl: true });
assert(res11.realisedPnl === 1200, 'Calculated realisedPnl must still show 1200');
assert(res11.includedRealisedPnl === 0, 'includedRealisedPnl must be 0');
assert(res11.grossTradingPnl === 500, `Expected grossTradingPnl = 500 (unrealized only), got ${res11.grossTradingPnl}`);
console.log('  ✓ PASSED: Realized P&L excluded from gross trading P&L when includeRealisedPnl = false');

// -------------------------------------------------------------
// TEST 12: INCLUDE UNREALIZED = TRUE
// -------------------------------------------------------------
console.log('\n[Test 12] RiskConfig includeUnrealisedPnl = true');
const res12 = calculateAggregatePnl(testPositions, { includeRealisedPnl: true, includeUnrealisedPnl: true });
assert(res12.unrealisedPnl === 500, 'Calculated unrealisedPnl must be 500');
assert(res12.includedUnrealisedPnl === 500, 'includedUnrealisedPnl must be 500');
assert(res12.grossTradingPnl === 1700, 'grossTradingPnl reflects both');
console.log('  ✓ PASSED: Unrealized P&L contributes when includeUnrealisedPnl = true');

// -------------------------------------------------------------
// TEST 13: INCLUDE UNREALIZED = FALSE
// -------------------------------------------------------------
console.log('\n[Test 13] RiskConfig includeUnrealisedPnl = false');
const res13 = calculateAggregatePnl(testPositions, { includeRealisedPnl: true, includeUnrealisedPnl: false });
assert(res13.unrealisedPnl === 500, 'Calculated unrealisedPnl must still be 500');
assert(res13.includedUnrealisedPnl === 0, 'includedUnrealisedPnl must be 0');
assert(res13.grossTradingPnl === 1200, `Expected grossTradingPnl = 1200 (realized only), got ${res13.grossTradingPnl}`);
console.log('  ✓ PASSED: Unrealized P&L excluded from gross trading P&L when includeUnrealisedPnl = false');

// -------------------------------------------------------------
// TEST 14: BOTH REALIZED AND UNREALIZED EXCLUDED
// -------------------------------------------------------------
console.log('\n[Test 14] Both includeRealisedPnl and includeUnrealisedPnl = false');
const res14 = calculateAggregatePnl(testPositions, { includeRealisedPnl: false, includeUnrealisedPnl: false });
assert(res14.realisedPnl === 1200, 'Calculated realisedPnl preserved');
assert(res14.unrealisedPnl === 500, 'Calculated unrealisedPnl preserved');
assert(res14.totalPnl === 1700, 'Calculated totalPnl preserved');
assert(res14.includedRealisedPnl === 0, 'includedRealisedPnl is 0');
assert(res14.includedUnrealisedPnl === 0, 'includedUnrealisedPnl is 0');
assert(res14.grossTradingPnl === 0, 'grossTradingPnl must be 0 when both excluded');
console.log('  ✓ PASSED: Both excluded yields grossTradingPnl = 0 while preserving calculated totals');

// -------------------------------------------------------------
// TEST 15: TOTAL P&L INVARIANT
// totalPnl = realisedPnl + unrealisedPnl
// -------------------------------------------------------------
console.log('\n[Test 15] Total P&L Invariant: totalPnl = realisedPnl + unrealisedPnl');
const testArray = [
  FIXTURE_LONG_FUT_PROFIT,
  FIXTURE_LONG_FUT_LOSS,
  FIXTURE_SHORT_FUT_PROFIT,
  FIXTURE_SHORT_OPT_PROFIT,
  FIXTURE_ZERO_QTY_CLOSED,
];
const res15 = calculateAggregatePnl(testArray);
assert(
  res15.totalPnl === Number((res15.realisedPnl + res15.unrealisedPnl).toFixed(2)),
  'totalPnl must strictly equal realisedPnl + unrealisedPnl'
);
console.log('  ✓ PASSED: Total P&L invariant strictly maintained across aggregate positions');

// -------------------------------------------------------------
// TEST 16: AGGREGATE ACROSS ENTIRE PHASE 3 FIXTURE SET
// -------------------------------------------------------------
console.log('\n[Test 16] Aggregate across Entire Phase 3 Fixture Set');
const mockAdapter = new MockZerodhaAdapter();
const rawPhase3 = await mockAdapter.getPositions();
const normalizedPhase3 = normalizePositions(rawPhase3, MOCK_INSTRUMENT_MAP);

const pnlPhase3 = PnlEngine.calculate(normalizedPhase3);

// In Phase 3:
// 1. NIFTY FUT: qty 50, avg 25120.5, last 25160.0 -> (25160 - 25120.5)*50 = 39.5 * 50 = +1975.00
// 2. NIFTY CE: qty -50, avg 185.0, last 142.5 -> (142.5 - 185.0)*-50 = -42.5 * -50 = +2125.00
// 3. NIFTY PE: qty 25, avg 92.0, last 74.0 -> (74 - 92)*25 = -18 * 25 = -450.00
// 4. SENSEX FUT: qty 10, avg 82150.0, last 82300.0 -> (82300 - 82150)*10 = 150 * 10 = +1500.00
// 5. BANKNIFTY FUT (closed): qty 0, avg 52100, last 52180, realised = +1200.00, unrealised = 0
// Equities: RELIANCE & TCS excluded!
// Expected:
// Realised: 1200.00
// Unrealised: 1975 + 2125 - 450 + 1500 = 5150.00
// Gross Trading P&L: 1200 + 5150 = 6350.00
assert(pnlPhase3.fnoPositionCount === 5, `Expected 5 F&O positions, got ${pnlPhase3.fnoPositionCount}`);
assert(pnlPhase3.realisedPnl === 1200, `Expected realisedPnl = 1200, got ${pnlPhase3.realisedPnl}`);
assert(pnlPhase3.unrealisedPnl === 5150, `Expected unrealisedPnl = 5150, got ${pnlPhase3.unrealisedPnl}`);
assert(pnlPhase3.grossTradingPnl === 6350, `Expected grossTradingPnl = 6350, got ${pnlPhase3.grossTradingPnl}`);
assert(pnlPhase3.source === 'MOCK_ZERODHA_PHASE_3', 'Source identifier must be MOCK_ZERODHA_PHASE_3');
console.log('  ✓ PASSED: Full Phase 3 fixture set produces exact expected F&O gross P&L (₹6,350.00)');

// -------------------------------------------------------------
// TEST 17: DETERMINISM
// -------------------------------------------------------------
console.log('\n[Test 17] Calculation Determinism');
const fixedTime = new Date('2026-10-02T10:30:00.000Z');
const runA = PnlEngine.calculate(normalizedPhase3, undefined, fixedTime);
const runB = PnlEngine.calculate(normalizedPhase3, undefined, fixedTime);

assert(JSON.stringify(runA) === JSON.stringify(runB), 'Repeated execution must produce identical results');
console.log('  ✓ PASSED: P&L Engine is 100% deterministic');

// -------------------------------------------------------------
// TEST 18: FINANCIAL PRECISION & NO FLOATING POINT DRIFT
// -------------------------------------------------------------
console.log('\n[Test 18] Decimal Precision (No binary floating point artifacts)');
// Using fractional prices that usually cause 0.00000000000004 in IEEE 754 float
const fractionalPos = {
  ...FIXTURE_LONG_FUT_PROFIT,
  quantity: 33,
  averagePrice: 100.1,
  lastPrice: 100.2, // diff 0.1, 0.1 * 33 = 3.3
  realisedPnl: 0.15,
};
const fracPnl = calculatePositionPnl(fractionalPos);
assert(fracPnl.unrealisedPnl === 3.3, `Expected exact 3.3, got ${fracPnl.unrealisedPnl}`);
assert(fracPnl.totalPnl === 3.45, `Expected exact 3.45, got ${fracPnl.totalPnl}`);
console.log('  ✓ PASSED: Decimal arithmetic prevents floating-point inaccuracies');

// -------------------------------------------------------------
// TEST 19: VALIDATION REJECTS MALFORMED INPUTS
// -------------------------------------------------------------
console.log('\n[Test 19] Validation Rejects Malformed Inputs');
let threwNaN = false;
try {
  calculatePositionPnl({ ...FIXTURE_LONG_FUT_PROFIT, quantity: NaN });
} catch (e) {
  threwNaN = e instanceof PnlValidationError;
}
assert(threwNaN, 'NaN quantity must throw PnlValidationError');

let threwInf = false;
try {
  calculatePositionPnl({ ...FIXTURE_LONG_FUT_PROFIT, lastPrice: Infinity });
} catch (e) {
  threwInf = e instanceof PnlValidationError;
}
assert(threwInf, 'Infinity lastPrice must throw PnlValidationError');

let threwNeg = false;
try {
  calculatePositionPnl({ ...FIXTURE_LONG_FUT_PROFIT, averagePrice: -10 });
} catch (e) {
  threwNeg = e instanceof PnlValidationError;
}
assert(threwNeg, 'Negative price must throw PnlValidationError');
console.log('  ✓ PASSED: Malformed financial inputs rejected without silent coercion');

// -------------------------------------------------------------
// TEST 20: DECOUPLING FROM RISK ENGINE
// -------------------------------------------------------------
console.log('\n[Test 20] Decoupling from Risk Engine');
// Ensure running PnlEngine does NOT touch ServerRiskStore or alter user session
const sessionBefore = await ServerRiskStore.getSession('test_user_pnl_check');
const pnlRun = PnlEngine.calculate(normalizedPhase3);
const sessionAfter = await ServerRiskStore.getSession('test_user_pnl_check');

assert(pnlRun !== null, 'P&L result generated');
assert(sessionBefore.state === sessionAfter.state, 'RiskSession state must not be altered');
assert(sessionBefore.currentPnl === sessionAfter.currentPnl, 'RiskSession currentPnl must not be altered');
assert(sessionBefore.lockedAt === sessionAfter.lockedAt, 'lockedAt must not be created');
console.log('  ✓ PASSED: P&L Engine is completely decoupled from RiskEngine and RiskSession');

console.log('\n================================================================');
console.log('ALL 20 PHASE 4 TESTS PASSED SUCCESSFULLY (20/20)');
console.log('================================================================\n');
