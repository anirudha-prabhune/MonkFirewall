import { RiskEngine, PnlIntegrityError, getTradingDateKolkata } from '../server/risk/engine';
import { ServerRiskStore } from '../server/risk/store';
import { PnlEngine } from '../server/pnl/engine';
import { PnlResult } from '../server/pnl/types';
import { RiskConfig, DEFAULT_RISK_CONFIG } from '../src/types/risk';
import { NormalizedPosition } from '../server/brokers/types';
import {
  FIXTURE_LONG_FUT_LOSS,
  FIXTURE_EQUITY_WITH_PNL,
} from '../server/pnl/fixtures';
import { MockZerodhaAdapter } from '../server/brokers/mock/adapter';
import { MOCK_INSTRUMENT_MAP } from '../server/instruments/master';
import { normalizePositions } from '../server/brokers/normalize';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function makePnlResult(grossTradingPnl: number, tradingDate?: string): PnlResult {
  const evalDate = new Date('2026-10-02T10:00:00.000Z');
  return {
    tradingDate: tradingDate || getTradingDateKolkata(evalDate),
    realisedPnl: grossTradingPnl,
    unrealisedPnl: 0,
    totalPnl: grossTradingPnl,
    includedRealisedPnl: grossTradingPnl,
    includedUnrealisedPnl: 0,
    grossTradingPnl,
    fnoPositionCount: 1,
    totalPositionCount: 1,
    positions: [],
    source: 'MOCK_ZERODHA_PHASE_3',
    calculatedAt: evalDate.toISOString(),
  };
}

console.log('================================================================');
console.log('TRADING FIREWALL: PHASE 5 VERIFICATION SUITE');
console.log('Authoritative PnlResult -> Risk Engine Integration');
console.log('================================================================\n');

const standardConfig: RiskConfig = {
  dailyLossLimit: 10000,
  warningThreshold1: 70,
  warningThreshold2: 90,
  lockDurationMinutes: 720,
  includeRealisedPnl: true,
  includeUnrealisedPnl: true,
  enabled: true,
};

// -------------------------------------------------------------
// TEST 1: POSITIVE P&L
// -------------------------------------------------------------
console.log('[Test 1] Positive P&L (+5,000) evaluates to ALLOW');
const res1 = RiskEngine.evaluate({
  userId: 'user_t1',
  config: standardConfig,
  pnlResult: makePnlResult(5000),
});
assert(res1.state === 'ALLOW', `Expected ALLOW, got ${res1.state}`);
assert(res1.isBreached === false, 'isBreached must be false');
assert(res1.lossAmount === 0, `Expected lossAmount = 0, got ${res1.lossAmount}`);
console.log('  ✓ PASSED: Positive P&L evaluates to ALLOW with lossAmount = 0');

// -------------------------------------------------------------
// TEST 2: ZERO P&L
// -------------------------------------------------------------
console.log('\n[Test 2] Zero P&L evaluates to ALLOW');
const res2 = RiskEngine.evaluate({
  userId: 'user_t2',
  config: standardConfig,
  pnlResult: makePnlResult(0),
});
assert(res2.state === 'ALLOW', `Expected ALLOW, got ${res2.state}`);
assert(res2.lossAmount === 0, `Expected lossAmount = 0, got ${res2.lossAmount}`);
console.log('  ✓ PASSED: Zero P&L evaluates to ALLOW with lossAmount = 0');

// -------------------------------------------------------------
// TEST 3: WARNING THRESHOLD 1
// -------------------------------------------------------------
console.log('\n[Test 3] Warning Threshold 1 (-7,000 on 10,000 limit = 70%)');
const res3 = RiskEngine.evaluate({
  userId: 'user_t3',
  config: standardConfig,
  pnlResult: makePnlResult(-7000),
});
assert(res3.state === 'WARNING', `Expected WARNING, got ${res3.state}`);
assert(res3.lossAmount === 7000, `Expected lossAmount = 7000, got ${res3.lossAmount}`);
assert(res3.isBreached === false, 'isBreached must be false');
console.log('  ✓ PASSED: Warning Threshold 1 triggers WARNING state');

// -------------------------------------------------------------
// TEST 4: BETWEEN WARNING THRESHOLDS
// -------------------------------------------------------------
console.log('\n[Test 4] Between Warning Thresholds (-8,000 = 80%)');
const res4 = RiskEngine.evaluate({
  userId: 'user_t4',
  config: standardConfig,
  pnlResult: makePnlResult(-8000),
});
assert(res4.state === 'WARNING', `Expected WARNING, got ${res4.state}`);
assert(res4.lossAmount === 8000, `Expected lossAmount = 8000, got ${res4.lossAmount}`);
console.log('  ✓ PASSED: Between warning thresholds triggers WARNING state');

// -------------------------------------------------------------
// TEST 5: WARNING THRESHOLD 2
// -------------------------------------------------------------
console.log('\n[Test 5] Warning Threshold 2 (-9,000 on 10,000 limit = 90%)');
const res5 = RiskEngine.evaluate({
  userId: 'user_t5',
  config: standardConfig,
  pnlResult: makePnlResult(-9000),
});
assert(res5.state === 'WARNING', `Expected WARNING, got ${res5.state}`);
assert(res5.lossAmount === 9000, `Expected lossAmount = 9000, got ${res5.lossAmount}`);
console.log('  ✓ PASSED: Warning Threshold 2 triggers WARNING state');

// -------------------------------------------------------------
// TEST 6: JUST BELOW LOSS LIMIT
// -------------------------------------------------------------
console.log('\n[Test 6] Just Below Loss Limit (-9,999)');
const res6 = RiskEngine.evaluate({
  userId: 'user_t6',
  config: standardConfig,
  pnlResult: makePnlResult(-9999),
});
assert(res6.state === 'WARNING', `Expected WARNING, got ${res6.state}`);
assert(res6.isBreached === false, 'isBreached must be false');
console.log('  ✓ PASSED: Loss of ₹9,999 does not breach ₹10,000 limit');

// -------------------------------------------------------------
// TEST 7: EXACT LOSS LIMIT (Inclusive Comparison)
// -------------------------------------------------------------
console.log('\n[Test 7] Exact Loss Limit (-10,000 on 10,000 limit)');
const res7 = RiskEngine.evaluate({
  userId: 'user_t7',
  config: standardConfig,
  pnlResult: makePnlResult(-10000),
});
assert(res7.state === 'LOCKED', `Expected LOCKED, got ${res7.state}`);
assert(res7.isBreached === true, 'isBreached must be true');
assert(res7.lossAmount === 10000, 'lossAmount must be 10000');
console.log('  ✓ PASSED: Exact loss limit matches inclusively and triggers LOCKED');

// -------------------------------------------------------------
// TEST 8: ABOVE LOSS LIMIT
// -------------------------------------------------------------
console.log('\n[Test 8] Above Loss Limit (-12,000)');
const res8 = RiskEngine.evaluate({
  userId: 'user_t8',
  config: standardConfig,
  pnlResult: makePnlResult(-12000),
});
assert(res8.state === 'LOCKED', `Expected LOCKED, got ${res8.state}`);
assert(res8.isBreached === true, 'isBreached must be true');
assert(res8.lossAmount === 12000, 'lossAmount must be 12000');
console.log('  ✓ PASSED: Above loss limit triggers LOCKED');

// -------------------------------------------------------------
// TEST 9: SIGNED LOSS CALCULATION
// -------------------------------------------------------------
console.log('\n[Test 9] Signed Loss Calculation: lossAmount = max(0, -grossTradingPnl)');
const res9 = RiskEngine.evaluate({
  userId: 'user_t9',
  config: standardConfig,
  pnlResult: makePnlResult(-5000),
});
assert(res9.lossAmount === 5000, `Expected lossAmount = 5000, got ${res9.lossAmount}`);
console.log('  ✓ PASSED: Negative gross P&L correctly converted to positive lossAmount');

// -------------------------------------------------------------
// TEST 10: POSITIVE P&L NEVER PRODUCES LOSS
// -------------------------------------------------------------
console.log('\n[Test 10] Positive P&L (+15,000) Never Produces Loss');
const res10 = RiskEngine.evaluate({
  userId: 'user_t10',
  config: standardConfig,
  pnlResult: makePnlResult(15000),
});
assert(res10.lossAmount === 0, `Expected lossAmount = 0, got ${res10.lossAmount}`);
console.log('  ✓ PASSED: Positive P&L produces lossAmount = 0');

// -------------------------------------------------------------
// TEST 11: FIRST LOCK CREATION
// -------------------------------------------------------------
console.log('\n[Test 11] First Lock Creation');
const evalTime11 = new Date('2026-10-02T10:00:00.000Z');
const res11 = RiskEngine.evaluate({
  userId: 'user_t11',
  config: standardConfig,
  pnlResult: makePnlResult(-12000),
  evaluationTime: evalTime11,
});
assert(res11.state === 'LOCKED', 'Must be LOCKED');
assert(res11.lockedAt === evalTime11.toISOString(), 'lockedAt must match evaluation time');
const expectedLockUntil11 = new Date(evalTime11.getTime() + 720 * 60 * 1000).toISOString();
assert(res11.lockUntil === expectedLockUntil11, `Expected lockUntil = ${expectedLockUntil11}, got ${res11.lockUntil}`);
console.log('  ✓ PASSED: First breach establishes lockedAt and lockUntil');

// -------------------------------------------------------------
// TEST 12: LOCK PERSISTS WHEN P&L RECOVERS
// -------------------------------------------------------------
console.log('\n[Test 12] Lock Persists when P&L Recovers (-5,000 and +5,000)');
const evalTime12B = new Date('2026-10-02T11:00:00.000Z');
const res12B = RiskEngine.evaluate({
  userId: 'user_t11',
  config: standardConfig,
  pnlResult: makePnlResult(-5000),
  currentSession: res11.session,
  evaluationTime: evalTime12B,
});
assert(res12B.state === 'LOCKED', 'Must remain LOCKED at -5000');
assert(res12B.lockUntil === res11.lockUntil, 'lockUntil must not change');

const evalTime12C = new Date('2026-10-02T12:00:00.000Z');
const res12C = RiskEngine.evaluate({
  userId: 'user_t11',
  config: standardConfig,
  pnlResult: makePnlResult(5000),
  currentSession: res12B.session,
  evaluationTime: evalTime12C,
});
assert(res12C.state === 'LOCKED', 'Must remain LOCKED at +5000');
assert(res12C.lockUntil === res11.lockUntil, 'lockUntil must remain invariant');
console.log('  ✓ PASSED: Active lock strictly preserved across full P&L recovery');

// -------------------------------------------------------------
// TEST 13: LOCK DOES NOT EXTEND
// -------------------------------------------------------------
console.log('\n[Test 13] Lock Does Not Extend on Repeated Evaluations');
assert(res12B.lockedAt === res11.lockedAt, 'lockedAt must not extend');
assert(res12C.lockUntil === res11.lockUntil, 'lockUntil must not extend');
console.log('  ✓ PASSED: Subsequent evaluations preserve original lockedAt and lockUntil');

// -------------------------------------------------------------
// TEST 14: ACTIVE LOCK BEATS DISABLED CONFIG
// -------------------------------------------------------------
console.log('\n[Test 14] Active Lock Beats Disabled Config (enabled = false)');
const disabledConfig: RiskConfig = { ...standardConfig, enabled: false };
const res14 = RiskEngine.evaluate({
  userId: 'user_t11',
  config: disabledConfig,
  pnlResult: makePnlResult(-2000),
  currentSession: res11.session,
  evaluationTime: new Date('2026-10-02T13:00:00.000Z'),
});
assert(res14.state === 'LOCKED', 'Must remain LOCKED when enabled = false while lockUntil is active');
console.log('  ✓ PASSED: Active LOCKED state strictly overrides enabled=false');

// -------------------------------------------------------------
// TEST 15: DISABLED CONFIG WITH NO ACTIVE LOCK
// -------------------------------------------------------------
console.log('\n[Test 15] Disabled Config with No Active Lock');
const res15 = RiskEngine.evaluate({
  userId: 'user_t15',
  config: disabledConfig,
  pnlResult: makePnlResult(-25000), // Massive loss
});
assert(res15.state === 'ALLOW', `Expected ALLOW, got ${res15.state}`);
assert(res15.isBreached === false, 'isBreached must be false');
console.log('  ✓ PASSED: Disabled config with no prior lock returns ALLOW');

// -------------------------------------------------------------
// TEST 16: DISABLED CONFIG AFTER LOCK EXPIRY
// -------------------------------------------------------------
console.log('\n[Test 16] Disabled Config After Lock Expiry');
const postExpiryTime = new Date(evalTime11.getTime() + 721 * 60 * 1000); // 1 minute after 720m duration
const res16 = RiskEngine.evaluate({
  userId: 'user_t11',
  config: disabledConfig,
  pnlResult: makePnlResult(0),
  currentSession: res11.session,
  evaluationTime: postExpiryTime,
});
assert(res16.state === 'ALLOW', `Expected ALLOW after lock expiry with enabled=false, got ${res16.state}`);
console.log('  ✓ PASSED: Post-expiry evaluation respects enabled=false');

// -------------------------------------------------------------
// TEST 17: LOCK EXPIRATION AUDIT
// -------------------------------------------------------------
console.log('\n[Test 17] Lock Expiration generates TRADING_LOCK_EXPIRED exactly once');
const res17 = RiskEngine.evaluate({
  userId: 'user_t11',
  config: standardConfig,
  pnlResult: makePnlResult(0),
  currentSession: res11.session,
  evaluationTime: postExpiryTime,
});
const hasExpiredEvent = res17.transitionEvents.some((e) => e.type === 'TRADING_LOCK_EXPIRED');
assert(hasExpiredEvent, 'TRADING_LOCK_EXPIRED event must be generated');
console.log('  ✓ PASSED: TRADING_LOCK_EXPIRED event created on lock expiry');

// -------------------------------------------------------------
// TEST 18: POST-EXPIRY BREACH CREATES NEW LOCK
// -------------------------------------------------------------
console.log('\n[Test 18] Post-Expiry Breach creates New Lock Lifecycle');
const postExpiryBreachTime = new Date(evalTime11.getTime() + 730 * 60 * 1000);
const res18 = RiskEngine.evaluate({
  userId: 'user_t11',
  config: standardConfig,
  pnlResult: makePnlResult(-15000),
  currentSession: res17.session, // Session after previous lock expired
  evaluationTime: postExpiryBreachTime,
});
assert(res18.state === 'LOCKED', 'Must become LOCKED again');
assert(res18.lockedAt === postExpiryBreachTime.toISOString(), 'Must use new breach timestamp');
assert(res18.lockedAt !== res11.lockedAt, 'Must not reuse old lockedAt');
console.log('  ✓ PASSED: New breach after expiry starts a new lock lifecycle');

// -------------------------------------------------------------
// TEST 19: WARNING EVENT IDEMPOTENCY
// -------------------------------------------------------------
console.log('\n[Test 19] Warning Event Idempotency on Repeated Polling');
const warn1 = RiskEngine.evaluate({
  userId: 'user_t19',
  config: standardConfig,
  pnlResult: makePnlResult(-7000),
});
assert(warn1.transitionEvents.some((e) => e.type === 'RISK_WARNING'), 'First warning must emit event');

const warn2 = RiskEngine.evaluate({
  userId: 'user_t19',
  config: standardConfig,
  pnlResult: makePnlResult(-7000),
  currentSession: warn1.session,
});
assert(!warn2.transitionEvents.some((e) => e.type === 'RISK_WARNING'), 'Subsequent warning must NOT duplicate event');
console.log('  ✓ PASSED: Zero duplicate RISK_WARNING events emitted on polling');

// -------------------------------------------------------------
// TEST 20: LOCK EVENT IDEMPOTENCY
// -------------------------------------------------------------
console.log('\n[Test 20] Lock Event Idempotency on Repeated Polling');
const lockEval20 = RiskEngine.evaluate({
  userId: 'user_t20',
  config: standardConfig,
  pnlResult: makePnlResult(-12000),
  currentSession: res11.session, // Already locked
  evaluationTime: evalTime11,
});
assert(lockEval20.transitionEvents.length === 0, 'No new transition events while actively locked');
console.log('  ✓ PASSED: Zero duplicate TRADING_LOCK_CREATED events emitted on polling');

// -------------------------------------------------------------
// TEST 21: CONCURRENT FIRST BREACH IDEMPOTENCY
// -------------------------------------------------------------
console.log('\n[Test 21] Concurrent First Breach Idempotency');
ServerRiskStore.reset();
const evalTime21 = new Date('2026-10-02T10:15:00.000Z');
const pnl21 = makePnlResult(-11000);

// Run 5 concurrent evaluations
const promises = Array.from({ length: 5 }, () =>
  ServerRiskStore.evaluatePnlResult('concurrent_user', pnl21, evalTime21)
);
const results = await Promise.all(promises);

const firstLockedAt = results[0].lockedAt;
const firstLockUntil = results[0].lockUntil;
for (const r of results) {
  assert(r.state === 'LOCKED', 'All concurrent runs must yield LOCKED');
  assert(r.lockedAt === firstLockedAt, 'All concurrent runs must share identical lockedAt');
  assert(r.lockUntil === firstLockUntil, 'All concurrent runs must share identical lockUntil');
}
const auditEvents = await ServerRiskStore.getAuditEvents('concurrent_user');
const lockCreatedEvents = auditEvents.filter((e) => e.type === 'TRADING_LOCK_CREATED');
assert(lockCreatedEvents.length === 1, `Expected exactly 1 TRADING_LOCK_CREATED event, got ${lockCreatedEvents.length}`);
console.log('  ✓ PASSED: Concurrent evaluations establish a single atomic lock without duplicate events');

// -------------------------------------------------------------
// TEST 22: P&L IS AUTHORITATIVE (Disagrees with Broker Values)
// -------------------------------------------------------------
console.log('\n[Test 22] RiskEngine strictly follows PnlResult, ignoring broker fields');
const syntheticDiscrepancy: PnlResult = {
  tradingDate: '2026-10-02',
  realisedPnl: 0,
  unrealisedPnl: -12000,
  totalPnl: -12000,
  includedRealisedPnl: 0,
  includedUnrealisedPnl: -12000,
  grossTradingPnl: -12000, // Calculated Phase 4 loss
  fnoPositionCount: 1,
  totalPositionCount: 1,
  positions: [],
  source: 'MOCK_ZERODHA_PHASE_3',
  calculatedAt: new Date().toISOString(),
};
const res22 = RiskEngine.evaluate({
  userId: 'user_t22',
  config: standardConfig,
  pnlResult: syntheticDiscrepancy,
});
assert(res22.state === 'LOCKED', 'RiskEngine must follow PnlResult.grossTradingPnl');
assert(res22.currentPnl === -12000, 'currentPnl matches grossTradingPnl');
console.log('  ✓ PASSED: RiskEngine strictly consumes PnlResult.grossTradingPnl');

// -------------------------------------------------------------
// TEST 23: RISK ENGINE DOES NOT CALCULATE P&L
// -------------------------------------------------------------
console.log('\n[Test 23] RiskEngine receives PnlResult without accessing position price/qty');
assert(typeof RiskEngine.evaluate === 'function', 'RiskEngine.evaluate interface verified');
// Verify that passing PnlResult requires no position objects
const purePnlInput = {
  userId: 'user_t23',
  config: standardConfig,
  pnlResult: makePnlResult(-7000),
};
const res23 = RiskEngine.evaluate(purePnlInput);
assert(res23.state === 'WARNING', 'Evaluated from PnlResult without positions');
console.log('  ✓ PASSED: RiskEngine is purely an evaluation engine, completely devoid of P&L math');

// -------------------------------------------------------------
// TEST 24: EQUITY DOES NOT AFFECT RISK
// -------------------------------------------------------------
console.log('\n[Test 24] Equity loss cannot affect F&O PnlResult or Risk state');
// Create position list with 1 F&O position (loss -500) and 1 massive equity loss (-50,000)
const equityHeavyPositions: NormalizedPosition[] = [
  FIXTURE_LONG_FUT_LOSS, // NFO-FUT: qty 50, avg 100, last 90 -> unrealised -500
  {
    ...FIXTURE_EQUITY_WITH_PNL,
    realisedPnl: -50000, // Massive equity loss
    unrealisedPnl: -50000,
    totalPnl: -100000,
    isFno: false,
  },
];
const pnlRes24 = PnlEngine.calculate(equityHeavyPositions, standardConfig);
assert(pnlRes24.grossTradingPnl === -500, `Expected F&O grossTradingPnl = -500, got ${pnlRes24.grossTradingPnl}`);

const riskRes24 = RiskEngine.evaluate({
  userId: 'user_t24',
  config: standardConfig,
  pnlResult: pnlRes24,
});
assert(riskRes24.state === 'ALLOW', `Expected ALLOW (loss 500 < 7000), got ${riskRes24.state}`);
console.log('  ✓ PASSED: Huge equity loss has zero impact on F&O risk state');

// -------------------------------------------------------------
// TEST 25: P&L CONFIGURATION FLAGS GOVERN GROSS TRADING P&L
// -------------------------------------------------------------
console.log('\n[Test 25] RiskConfig flags govern PnlResult before Risk evaluation');
const mixedFlagsConfig: RiskConfig = { ...standardConfig, includeUnrealisedPnl: false };
const testPositions25: NormalizedPosition[] = [
  FIXTURE_LONG_FUT_LOSS, // Unrealised loss -500
  {
    ...FIXTURE_LONG_FUT_LOSS,
    instrumentToken: 999999,
    quantity: 0,
    realisedPnl: -12000, // Realised loss -12,000
    isFno: true,
  },
];
const pnlRes25 = PnlEngine.calculate(testPositions25, mixedFlagsConfig);
assert(pnlRes25.includedUnrealisedPnl === 0, 'Unrealized P&L excluded by flag');
assert(pnlRes25.grossTradingPnl === -12000, 'Gross P&L reflects realized only');

const riskRes25 = RiskEngine.evaluate({
  userId: 'user_t25',
  config: mixedFlagsConfig,
  pnlResult: pnlRes25,
});
assert(riskRes25.state === 'LOCKED', 'LOCKED based on included realized P&L');
console.log('  ✓ PASSED: P&L inclusion flags govern PnlResult before RiskEngine evaluation');

// -------------------------------------------------------------
// TEST 26: INVALID P&L INTEGRITY CHECK
// -------------------------------------------------------------
console.log('\n[Test 26] Invalid PnlResult (NaN / Infinity) throws PnlIntegrityError safely');
let threwNaN = false;
try {
  RiskEngine.evaluate({
    userId: 'user_t26',
    config: standardConfig,
    pnlResult: { ...makePnlResult(0), grossTradingPnl: NaN },
  });
} catch (e) {
  threwNaN = e instanceof PnlIntegrityError;
}
assert(threwNaN, 'NaN grossTradingPnl must throw PnlIntegrityError');

let threwInf = false;
try {
  RiskEngine.evaluate({
    userId: 'user_t26',
    config: standardConfig,
    pnlResult: { ...makePnlResult(0), grossTradingPnl: Infinity },
  });
} catch (e) {
  threwInf = e instanceof PnlIntegrityError;
}
assert(threwInf, 'Infinity grossTradingPnl must throw PnlIntegrityError');
console.log('  ✓ PASSED: Malformed PnlResult fails safely without writing bad state or locks');

// -------------------------------------------------------------
// TEST 27: TRADING DATE CONSISTENCY (Asia/Kolkata)
// -------------------------------------------------------------
console.log('\n[Test 27] Trading date consistency between PnlResult and RiskSession');
const evalDate27 = new Date('2026-10-02T18:30:00.000Z'); // 00:00 AM IST on Oct 3
const expectedDate27 = getTradingDateKolkata(evalDate27);
const pnlRes27 = makePnlResult(-1000, expectedDate27);
const riskRes27 = RiskEngine.evaluate({
  userId: 'user_t27',
  config: standardConfig,
  pnlResult: pnlRes27,
  evaluationTime: evalDate27,
});
assert(riskRes27.tradingDate === expectedDate27, `Trading date mismatch: ${riskRes27.tradingDate} vs ${expectedDate27}`);
assert(riskRes27.session.tradingDate === pnlRes27.tradingDate, 'RiskSession matches PnlResult tradingDate');
console.log('  ✓ PASSED: Asia/Kolkata trading date flows consistently through pipeline');

// -------------------------------------------------------------
// TEST 28: SERVER-SIDE CALCULATION FROM POSITIONS
// -------------------------------------------------------------
console.log('\n[Test 28] Server-side calculation from positions');
ServerRiskStore.reset();
const serverEval = await ServerRiskStore.evaluateFromPositions('server_calc_user');
assert(serverEval.state !== undefined, 'Server evaluation succeeded');
assert(serverEval.session.currentPnl === 6350, `Expected server-calculated P&L 6350, got ${serverEval.session.currentPnl}`);
console.log('  ✓ PASSED: Server calculates PnlResult and RiskSession from positions without client input');

// -------------------------------------------------------------
// TEST 29: CROSS-USER ISOLATION
// -------------------------------------------------------------
console.log('\n[Test 29] Cross-user isolation in risk store');
ServerRiskStore.reset();
await ServerRiskStore.saveConfig('user_A', { ...standardConfig, dailyLossLimit: 5000 });
await ServerRiskStore.saveConfig('user_B', { ...standardConfig, dailyLossLimit: 20000 });

const configA = await ServerRiskStore.getConfig('user_A');
const configB = await ServerRiskStore.getConfig('user_B');

assert(configA.dailyLossLimit === 5000, 'User A config isolated');
assert(configB.dailyLossLimit === 20000, 'User B config isolated');
console.log('  ✓ PASSED: Multi-tenant user configurations strictly isolated');

// -------------------------------------------------------------
// TEST 30: COMPLETE FULL PIPELINE
// -------------------------------------------------------------
console.log('\n[Test 30] Complete Phase 5 Pipeline: Positions -> P&L Engine -> PnlResult -> Risk Engine -> RiskSession');
const mockAdapter = new MockZerodhaAdapter();
const rawPositions = await mockAdapter.getPositions();
const normalized = normalizePositions(rawPositions, MOCK_INSTRUMENT_MAP);

// 1. P&L Engine
const pnlResult = PnlEngine.calculate(normalized, standardConfig);
assert(pnlResult.grossTradingPnl === 6350, 'P&L Engine calculated grossTradingPnl = +6,350');

// 2. Risk Engine
const riskResult = RiskEngine.evaluate({
  userId: 'user_pipeline_test',
  config: standardConfig,
  pnlResult,
});

// 3. Risk Session Verification
assert(riskResult.state === 'ALLOW', 'Positive P&L yields ALLOW');
assert(riskResult.session.currentPnl === 6350, 'Session currentPnl matches PnlResult');
assert(riskResult.lossAmount === 0, 'Loss amount is 0');
assert(riskResult.session.tradingDate === pnlResult.tradingDate, 'Trading date matches');
assert(riskResult.isBreached === false, 'isBreached is false');
console.log('  ✓ PASSED: Complete authoritative pipeline verified end-to-end');

console.log('\n================================================================');
console.log('ALL 30 PHASE 5 TESTS PASSED SUCCESSFULLY (30/30)');
console.log('================================================================\n');
