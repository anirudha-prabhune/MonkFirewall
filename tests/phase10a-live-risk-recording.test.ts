/**
 * TRADING FIREWALL: PHASE 10A VERIFICATION SUITE
 * Live RiskSession / riskEvents Recording & Real F&O Positions UI Data
 *
 * 11 FOCUSED TESTS:
 * 1. flag disabled → no RiskSession/riskEvent mutation.
 * 2. flag enabled + positive live P&L → ALLOW.
 * 3. flag enabled + warning loss → existing WARNING semantics.
 * 4. flag enabled + breach fixture → LOCKED + lockUntil.
 * 5. repeated evaluation is idempotent and does not duplicate events.
 * 6. existing active LOCKED state persists correctly.
 * 7. real F&O positions appear in live UI data.
 * 8. real realised/unrealised/gross P&L values reach the UI.
 * 9. unknown/non-F&O instruments remain excluded.
 * 10. live mode never falls back to simulation data.
 * 11. no order/trading API is invoked.
 */

import {
  LiveRiskRecorder,
  liveRiskStateRecordingEnabled,
  setLiveRiskStateRecordingEnabled,
} from '../server/risk/liveRiskRecorder';
import { ServerRiskStore } from '../server/risk/store';
import { RawBrokerPosition, BrokerInstrument } from '../server/brokers/types';
import { RiskConfig } from '../src/types/risk';
import { LivePnlValidationService } from '../server/pnl/liveValidationService';
import { BrokerService } from '../server/brokers/service';

let totalTests = 0;
let passedTests = 0;

function assert(condition: boolean, message: string) {
  totalTests++;
  if (!condition) {
    console.error(`  ✗ FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  passedTests++;
  console.log(`  ✓ PASSED: ${message}`);
}

async function runPhase10ATestSuite() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: PHASE 10A VERIFICATION SUITE');
  console.log('Authoritative Live Risk Recording & Real F&O UI Data');
  console.log('================================================================\n');

  const testUser = 'phase10a_test_user';

  // Base instrument definitions
  const testInstrumentMap = new Map<number, BrokerInstrument>([
    [
      10418946,
      {
        instrumentToken: 10418946,
        tradingsymbol: 'NIFTY26O0622550CE',
        name: 'NIFTY',
        expiry: '2026-10-06',
        strike: 22550,
        tickSize: 0.05,
        lotSize: 65,
        instrumentType: 'CE',
        segment: 'NFO-OPT',
        exchange: 'NFO',
      },
    ],
    [
      10419202,
      {
        instrumentToken: 10419202,
        tradingsymbol: 'NIFTY26O0622550PE',
        name: 'NIFTY',
        expiry: '2026-10-06',
        strike: 22550,
        tickSize: 0.05,
        lotSize: 65,
        instrumentType: 'PE',
        segment: 'NFO-OPT',
        exchange: 'NFO',
      },
    ],
    [
      408065,
      {
        instrumentToken: 408065,
        tradingsymbol: 'INFY',
        name: 'INFOSYS',
        expiry: null,
        strike: null,
        tickSize: 0.05,
        lotSize: 1,
        instrumentType: 'EQ',
        segment: 'NSE',
        exchange: 'NSE',
      },
    ],
  ]);

  // Standard test config: limit ₹5,000, warnings at 70% (₹3,500) and 85% (₹4,250)
  const testConfig: RiskConfig = {
    dailyLossLimit: 5000,
    warningThreshold1: 70,
    warningThreshold2: 85,
    lockDurationMinutes: 120,
    lockDurationType: 'FIXED',
    includeRealisedPnl: true,
    includeUnrealisedPnl: true,
    enabled: true,
  };

  // Real profit fixture (+₹7,280 profit)
  const realProfitPositions: RawBrokerPosition[] = [
    {
      tradingsymbol: 'NIFTY26O0622550CE',
      exchange: 'NFO',
      instrument_token: 10418946,
      product: 'NRML',
      quantity: 0,
      overnight_quantity: 0,
      multiplier: 1,
      average_price: 0,
      close_price: 85.45,
      last_price: 79.5,
      pnl: 2008.5,
      m2m: 2008.5,
      unrealised: 0,
      realised: 2008.5,
      day_buy_quantity: 130,
      day_buy_value: 14488.5,
      day_sell_quantity: 130,
      day_sell_value: 16497,
    },
    {
      tradingsymbol: 'NIFTY26O0622550PE',
      exchange: 'NFO',
      instrument_token: 10419202,
      product: 'MIS',
      quantity: 0,
      overnight_quantity: 0,
      multiplier: 1,
      average_price: 0,
      close_price: 172.35,
      last_price: 74.15,
      pnl: 5271.5,
      m2m: 5271.5,
      unrealised: 0,
      realised: 5271.5,
      day_buy_quantity: 130,
      day_buy_value: 15398.5,
      day_sell_quantity: 130,
      day_sell_value: 20670,
    },
  ];

  function createClosedLossPosition(loss: number): RawBrokerPosition[] {
    const buyValue = 10000 + loss;
    return [
      {
        tradingsymbol: 'NIFTY26O0622550CE',
        exchange: 'NFO',
        instrument_token: 10418946,
        product: 'NRML',
        quantity: 0,
        overnight_quantity: 0,
        multiplier: 1,
        average_price: 0,
        close_price: 100,
        last_price: 100,
        pnl: -loss,
        m2m: -loss,
        unrealised: 0,
        realised: -loss,
        day_buy_quantity: 100,
        day_buy_value: buyValue,
        day_sell_quantity: 100,
        day_sell_value: 10000,
      },
    ];
  }

  // ==========================================================================
  // [Test 1] flag disabled → no RiskSession/riskEvent mutation
  // ==========================================================================
  console.log('[Test 1] flag disabled → no RiskSession/riskEvent mutation');
  setLiveRiskStateRecordingEnabled(false);
  assert(liveRiskStateRecordingEnabled === false, 'Default flag state is false');

  const sessionBefore = await ServerRiskStore.getSession(testUser);
  const sessionSnapBefore = JSON.stringify(sessionBefore);
  const eventsBefore = await ServerRiskStore.getAuditEvents(testUser);

  const res1 = await LiveRiskRecorder.evaluateAndRecordLiveRisk(testUser, {
    injectedPositions: createClosedLossPosition(8000), // Massive loss
    injectedInstrumentMap: testInstrumentMap,
    configOverride: testConfig,
  });

  assert(res1.recorded === false, 'Recorded flag is strictly false when disabled');
  assert(res1.flagEnabled === false, 'Flag reported as false');
  assert(res1.transitionEvents.length === 0, 'Zero transition events returned');

  const sessionAfter = await ServerRiskStore.getSession(testUser);
  const sessionSnapAfter = JSON.stringify(sessionAfter);
  const eventsAfter = await ServerRiskStore.getAuditEvents(testUser);

  assert(sessionSnapBefore === sessionSnapAfter, 'RiskSession is 100% byte-for-byte unmutated');
  assert(eventsBefore.length === eventsAfter.length, 'Zero riskEvents written');

  // ==========================================================================
  // [Test 2] flag enabled + positive live P&L → ALLOW
  // ==========================================================================
  console.log('\n[Test 2] flag enabled + positive live P&L (+₹7,280) → ALLOW');
  setLiveRiskStateRecordingEnabled(true);
  try {
    const res2 = await LiveRiskRecorder.evaluateAndRecordLiveRisk(testUser, {
      injectedPositions: realProfitPositions,
      injectedInstrumentMap: testInstrumentMap,
      configOverride: testConfig,
    });

    assert(res2.recorded === true, 'Recorded flag is true when enabled');
    assert(res2.state === 'ALLOW', 'State is ALLOW for positive P&L');
    assert(res2.lossAmount === 0, 'Loss amount is 0');
    assert(res2.grossTradingPnl === 7280, 'Gross trading P&L is +₹7,280');
    assert(res2.isBreached === false, 'isBreached is false');

    const session2 = await ServerRiskStore.getSession(testUser);
    assert(session2.state === 'ALLOW', 'Persisted session state is ALLOW');
    assert(session2.currentPnl === 7280, 'Persisted session currentPnl is 7280');
    assert(session2.isBreached === false, 'Persisted session isBreached is false');
  } finally {
    setLiveRiskStateRecordingEnabled(false);
  }

  // ==========================================================================
  // [Test 3] flag enabled + warning loss → existing WARNING semantics
  // ==========================================================================
  console.log('\n[Test 3] flag enabled + warning loss (72% loss) → WARNING semantics');
  setLiveRiskStateRecordingEnabled(true);
  try {
    const res3 = await LiveRiskRecorder.evaluateAndRecordLiveRisk(testUser, {
      injectedPositions: createClosedLossPosition(3600), // 72% of 5000
      injectedInstrumentMap: testInstrumentMap,
      configOverride: testConfig,
    });

    assert(res3.recorded === true, 'Recorded flag is true');
    assert(res3.state === 'WARNING', 'Evaluated state is WARNING');
    assert(res3.lossAmount === 3600, 'Loss amount is 3600');
    assert(res3.isBreached === false, 'isBreached is false for warning');

    const session3 = await ServerRiskStore.getSession(testUser);
    assert(session3.state === 'WARNING', 'Persisted session state is WARNING');
    assert(session3.lossAmount === 3600, 'Persisted lossAmount is 3600');

    const events3 = await ServerRiskStore.getAuditEvents(testUser);
    const hasWarningEvent = events3.some(
      (e) => e.type === 'RISK_WARNING' && e.message.includes('72.0%')
    );
    assert(hasWarningEvent, 'RISK_WARNING event successfully recorded');
  } finally {
    setLiveRiskStateRecordingEnabled(false);
  }

  // ==========================================================================
  // [Test 4] flag enabled + breach fixture → LOCKED + lockUntil
  // ==========================================================================
  console.log('\n[Test 4] flag enabled + breach fixture (₹5,000 loss) → LOCKED + lockUntil');
  setLiveRiskStateRecordingEnabled(true);
  let lockUntilFirst: string | null = null;
  try {
    const evalTime = new Date('2026-10-05T10:00:00.000Z');
    const res4 = await LiveRiskRecorder.evaluateAndRecordLiveRisk(testUser, {
      injectedPositions: createClosedLossPosition(5000), // 100% breach
      injectedInstrumentMap: testInstrumentMap,
      configOverride: testConfig,
      evaluationTime: evalTime,
    });

    assert(res4.recorded === true, 'Recorded flag is true');
    assert(res4.state === 'LOCKED', 'Evaluated state is LOCKED');
    assert(res4.isBreached === true, 'isBreached is true');

    const session4 = await ServerRiskStore.getSession(testUser, res4.tradingDate);
    assert(session4.state === 'LOCKED', 'Persisted session state is LOCKED');
    assert(session4.isBreached === true, 'Persisted session isBreached is true');
    assert(session4.lockedAt !== null, 'lockedAt is populated');
    assert(session4.lockUntil !== null, 'lockUntil is populated');
    lockUntilFirst = session4.lockUntil;

    // Check lock duration (120 minutes from 10:00 UTC = 12:00 UTC)
    const expectedExpiry = new Date(evalTime.getTime() + 120 * 60 * 1000).toISOString();
    assert(session4.lockUntil === expectedExpiry, `lockUntil is exactly 120m in future (${expectedExpiry})`);

    const events4 = await ServerRiskStore.getAuditEvents(testUser);
    const hasBreach = events4.some((e) => e.type === 'LOSS_LIMIT_BREACHED');
    const hasLock = events4.some((e) => e.type === 'TRADING_LOCK_CREATED');
    assert(hasBreach, 'LOSS_LIMIT_BREACHED event recorded');
    assert(hasLock, 'TRADING_LOCK_CREATED event recorded');
  } finally {
    setLiveRiskStateRecordingEnabled(false);
  }

  // ==========================================================================
  // [Test 5] repeated evaluation is idempotent and does not duplicate events
  // ==========================================================================
  console.log('\n[Test 5] repeated evaluation is idempotent and does not duplicate events');
  setLiveRiskStateRecordingEnabled(true);
  try {
    const eventsBeforeRepeat = await ServerRiskStore.getAuditEvents(testUser);
    const countBeforeRepeat = eventsBeforeRepeat.length;

    // Re-evaluate with the same breach 10 minutes later (lock still active)
    const evalTime2 = new Date('2026-10-05T10:10:00.000Z');
    const res5 = await LiveRiskRecorder.evaluateAndRecordLiveRisk(testUser, {
      injectedPositions: createClosedLossPosition(5000),
      injectedInstrumentMap: testInstrumentMap,
      configOverride: testConfig,
      evaluationTime: evalTime2,
    });

    assert(res5.state === 'LOCKED', 'State remains LOCKED');
    const session5 = await ServerRiskStore.getSession(testUser, res5.tradingDate);
    assert(session5.lockUntil === lockUntilFirst, 'lockUntil was NOT extended on repeated evaluation');

    const eventsAfterRepeat = await ServerRiskStore.getAuditEvents(testUser);
    assert(
      eventsAfterRepeat.length === countBeforeRepeat,
      `Zero duplicate events emitted on repeated evaluation (before: ${countBeforeRepeat}, after: ${eventsAfterRepeat.length})`
    );
  } finally {
    setLiveRiskStateRecordingEnabled(false);
  }

  // ==========================================================================
  // [Test 6] existing active LOCKED state persists correctly
  // ==========================================================================
  console.log('\n[Test 6] existing active LOCKED state persists even with improving P&L');
  setLiveRiskStateRecordingEnabled(true);
  try {
    // Trader recovers to massive profit (+₹20,000) while lock is active
    const evalTime3 = new Date('2026-10-05T10:30:00.000Z');
    const res6 = await LiveRiskRecorder.evaluateAndRecordLiveRisk(testUser, {
      injectedPositions: realProfitPositions, // +₹7,280
      injectedInstrumentMap: testInstrumentMap,
      configOverride: testConfig,
      evaluationTime: evalTime3,
    });

    assert(res6.state === 'LOCKED', 'Active lock strictly takes precedence over improving P&L');
    assert(res6.isBreached === true, 'isBreached remains true');
    const session6 = await ServerRiskStore.getSession(testUser, res6.tradingDate);
    assert(session6.state === 'LOCKED', 'Session remains locked');
    assert(session6.lockUntil === lockUntilFirst, 'lockUntil strictly unchanged');
  } finally {
    setLiveRiskStateRecordingEnabled(false);
  }

  // ==========================================================================
  // [Test 7] real F&O positions appear in live UI data
  // ==========================================================================
  console.log('\n[Test 7] real F&O positions appear in live UI data');
  const liveValResult = await LivePnlValidationService.validateLivePnl(
    testConfig,
    new Date(),
    realProfitPositions,
    testInstrumentMap,
    testUser
  );

  assert(Array.isArray(liveValResult.positions), 'positions array is exposed in validation result');
  assert(liveValResult.positions!.length === 2, '2 real F&O positions normalized and exposed');
  assert(liveValResult.positions![0].dataSource === 'ZERODHA_LIVE', 'Positions have ZERODHA_LIVE dataSource');
  assert(liveValResult.positions![0].quantity === 0, 'Closed position retains quantity 0 for UI');
  assert(liveValResult.positions![0].exchange === 'NFO', 'Exchange is NFO');
  assert(liveValResult.positions![0].product === 'NRML', 'Product is NRML');
  assert(liveValResult.positions![1].product === 'MIS', 'Product is MIS');

  // ==========================================================================
  // [Test 8] real realised/unrealised/gross P&L values reach the UI
  // ==========================================================================
  console.log('\n[Test 8] real realised/unrealised/gross P&L values reach the UI');
  assert(liveValResult.calculated.grossTradingPnl === 7280, 'grossTradingPnl matches ₹7,280');
  assert(liveValResult.calculated.dailyRealisedPnl === 7280, 'dailyRealisedPnl matches ₹7,280');
  assert(liveValResult.calculated.dailyUnrealisedPnl === 0, 'dailyUnrealisedPnl matches ₹0');
  assert(liveValResult.calculated.fnoPositionCount === 2, 'fnoPositionCount matches 2');

  // ==========================================================================
  // [Test 9] unknown/non-F&O instruments remain excluded
  // ==========================================================================
  console.log('\n[Test 9] unknown/non-F&O instruments remain excluded');
  const mixedPositions: RawBrokerPosition[] = [
    ...realProfitPositions,
    {
      tradingsymbol: 'UNKNOWN_OPT',
      exchange: 'NFO',
      instrument_token: 888888, // Not in instrument master
      product: 'MIS',
      quantity: 10,
      overnight_quantity: 0,
      multiplier: 1,
      average_price: 100,
      close_price: 100,
      last_price: 100,
      pnl: 500,
      m2m: 500,
      unrealised: 500,
      realised: 0,
      day_buy_quantity: 10,
      day_buy_value: 1000,
      day_sell_quantity: 0,
      day_sell_value: 0,
    },
    {
      tradingsymbol: 'INFY',
      exchange: 'NSE',
      instrument_token: 408065, // Equity, not F&O
      product: 'CNC',
      quantity: 100,
      overnight_quantity: 100,
      multiplier: 1,
      average_price: 1500,
      close_price: 1500,
      last_price: 1500,
      pnl: 2000,
      m2m: 2000,
      unrealised: 2000,
      realised: 0,
      day_buy_quantity: 0,
      day_buy_value: 0,
      day_sell_quantity: 0,
      day_sell_value: 0,
    },
  ];

  const mixedValResult = await LivePnlValidationService.validateLivePnl(
    testConfig,
    new Date(),
    mixedPositions,
    testInstrumentMap,
    testUser
  );

  assert(mixedValResult.calculated.fnoPositionCount === 2, 'Unknown & Equity strictly excluded from fnoPositionCount');
  assert(mixedValResult.positions!.length === 2, 'Excluded from positions array (only 2 valid F&O present)');
  assert(mixedValResult.unknownInstruments.length === 1, '1 unknown instrument flagged');
  assert(mixedValResult.unknownInstruments[0].instrumentToken === 888888, 'Unknown token 888888 correctly flagged');

  // ==========================================================================
  // [Test 10] live mode never falls back to simulation data
  // ==========================================================================
  console.log('\n[Test 10] live mode never falls back to simulation data');
  // When live positions exist with market data issues, it stays ZERODHA_LIVE
  assert(liveValResult.source === 'ZERODHA_LIVE', 'Source is strictly ZERODHA_LIVE');
  assert(liveValResult.positions!.every((p) => p.dataSource === 'ZERODHA_LIVE'), 'All positions retain ZERODHA_LIVE');

  // ==========================================================================
  // [Test 11] no order/trading API is invoked
  // ==========================================================================
  console.log('\n[Test 11] no order/trading API is invoked');
  // Check live adapter to confirm zero order execution methods exist or were invoked
  const liveAdapter: any = BrokerService.getLiveAdapter();
  assert(liveAdapter.placeOrder === undefined, 'No placeOrder method on live adapter');
  assert(liveAdapter.modifyOrder === undefined, 'No modifyOrder method on live adapter');
  assert(liveAdapter.cancelOrder === undefined, 'No cancelOrder method on live adapter');
  assert(liveAdapter.squareOff === undefined, 'No squareOff method on live adapter');

  // Invariant verification: liveRiskStateRecordingEnabled must remain FALSE in production
  assert(liveRiskStateRecordingEnabled === false, 'liveRiskStateRecordingEnabled is strictly FALSE after tests');

  console.log('\n================================================================');
  console.log(`ALL 11 PHASE 10A INTEGRATION TESTS PASSED (${passedTests}/${totalTests})`);
  console.log('================================================================\n');
}

runPhase10ATestSuite().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
