/**
 * TRADING FIREWALL: PHASE 9 VERIFICATION SUITE
 * Live P&L → Risk Engine Shadow Integration Tests
 *
 * 13 STRICT TESTS:
 * 1. Positive real P&L → expected ALLOW.
 * 2. P&L approaching warning threshold → expected WARNING.
 * 3. Loss at warning threshold → WARNING.
 * 4. Loss at daily limit → expected LOCKED.
 * 5. Loss beyond daily limit → expected LOCKED.
 * 6. Inclusive daily-loss boundary remains unchanged.
 * 7. Existing warning percentage semantics unchanged.
 * 8. RiskEngine receives PnlResult.grossTradingPnl.
 * 9. Shadow evaluation causes zero RiskSession mutations.
 * 10. Shadow evaluation causes zero riskEvents.
 * 11. Shadow evaluation causes zero Enforcement mutations.
 * 12. Live data source remains ZERODHA_LIVE.
 * 13. No mock data enters the live shadow path.
 */

import { ShadowRiskService } from '../server/risk/shadowRiskService';
import { ServerRiskStore } from '../server/risk/store';
import { EnforcementService } from '../server/enforcement/service';
import { LIVE_PNL_VALIDATION_GATE } from '../server/pnl/liveValidationTypes';
import { RawBrokerPosition, BrokerInstrument } from '../server/brokers/types';
import { RiskConfig } from '../src/types/risk';

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

async function runPhase9TestSuite() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: PHASE 9 VERIFICATION SUITE');
  console.log('Live P&L → Risk Engine Shadow Integration (Strict Shadow Mode)');
  console.log('================================================================\n');

  const testUser = 'phase9_test_trader';

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

  // Real positions fixture (+₹7,280 profit)
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
  // [Test 1] Positive real P&L → expected ALLOW
  // ==========================================================================
  console.log('[Test 1] Positive real P&L (+₹7,280) → expected ALLOW');
  const res1 = await ShadowRiskService.evaluateLiveShadow(testUser, {
    injectedPositions: realProfitPositions,
    injectedInstrumentMap: testInstrumentMap,
    configOverride: testConfig,
  });

  assert(res1.shadow === true, 'Shadow mode flag is strictly true');
  assert(res1.grossTradingPnl === 7280, 'Gross trading P&L matches +₹7,280');
  assert(res1.lossAmount === 0, 'Loss amount is 0 for profit');
  assert(res1.lossUtilizedPercent === 0, 'Loss utilization is 0%');
  assert(res1.expectedState === 'ALLOW', 'Expected state is ALLOW');
  assert(res1.isBreached === false, 'isBreached is false');
  assert(res1.validationGate === 'CLOSED', 'Validation gate remains CLOSED');
  assert(res1.riskIntegrationEnabled === false, 'riskIntegrationEnabled remains false');

  // ==========================================================================
  // [Test 2] P&L approaching warning threshold → expected WARNING
  // ==========================================================================
  console.log('\n[Test 2] P&L approaching warning threshold (72% loss) → expected WARNING');
  const res2 = await ShadowRiskService.evaluateLiveShadow(testUser, {
    injectedPositions: createClosedLossPosition(3600),
    injectedInstrumentMap: testInstrumentMap,
    configOverride: testConfig,
  });

  assert(res2.grossTradingPnl === -3600, 'Gross trading P&L is -₹3,600');
  assert(res2.lossAmount === 3600, 'Loss amount is ₹3,600');
  assert(res2.lossUtilizedPercent === 72, 'Loss utilization is 72.0%');
  assert(res2.expectedState === 'WARNING', 'Expected state is WARNING (Threshold 1 exceeded)');
  assert(res2.isBreached === false, 'isBreached is false at warning level');
  assert(res2.reason.includes('Threshold 1'), 'Reason mentions Threshold 1');

  // ==========================================================================
  // [Test 3] Loss at warning threshold → WARNING
  // ==========================================================================
  console.log('\n[Test 3] Loss at exact warning thresholds → WARNING');
  const res3a = await ShadowRiskService.evaluateLiveShadow(testUser, {
    injectedPositions: createClosedLossPosition(3500),
    injectedInstrumentMap: testInstrumentMap,
    configOverride: testConfig,
  });
  assert(res3a.lossAmount === 3500, 'Loss is exact warning1Amount ₹3,500');
  assert(res3a.expectedState === 'WARNING', 'Exact 70% threshold produces WARNING');

  // Exact 85% = ₹4,250 loss (Warning 2)
  const res3b = await ShadowRiskService.evaluateLiveShadow(testUser, {
    injectedPositions: createClosedLossPosition(4250),
    injectedInstrumentMap: testInstrumentMap,
    configOverride: testConfig,
  });
  assert(res3b.lossAmount === 4250, 'Loss is exact warning2Amount ₹4,250');
  assert(res3b.expectedState === 'WARNING', 'Exact 85% threshold produces WARNING');
  assert(res3b.reason.includes('Threshold 2'), 'Reason mentions Threshold 2');

  // ==========================================================================
  // [Test 4] Loss at daily limit → expected LOCKED
  // ==========================================================================
  console.log('\n[Test 4] Loss at exact daily limit (₹5,000) → expected LOCKED');
  const res4 = await ShadowRiskService.evaluateLiveShadow(testUser, {
    injectedPositions: createClosedLossPosition(5000),
    injectedInstrumentMap: testInstrumentMap,
    configOverride: testConfig,
  });
  assert(res4.lossAmount === 5000, 'Loss amount equals exact daily loss limit ₹5,000');
  assert(res4.lossUtilizedPercent === 100, 'Loss utilization is 100%');
  assert(res4.isBreached === true, 'isBreached is true');
  assert(res4.expectedState === 'LOCKED', 'Expected state is LOCKED');
  assert(res4.reason.includes('breached'), 'Reason identifies daily loss limit breach');

  // ==========================================================================
  // [Test 5] Loss beyond daily limit → expected LOCKED
  // ==========================================================================
  console.log('\n[Test 5] Loss beyond daily limit (-₹8,500) → expected LOCKED');
  const res5 = await ShadowRiskService.evaluateLiveShadow(testUser, {
    injectedPositions: createClosedLossPosition(8500),
    injectedInstrumentMap: testInstrumentMap,
    configOverride: testConfig,
  });
  assert(res5.lossAmount === 8500, 'Loss amount is ₹8,500');
  assert(res5.lossUtilizedPercent === 170, 'Loss utilization is 170%');
  assert(res5.isBreached === true, 'isBreached is true');
  assert(res5.expectedState === 'LOCKED', 'Expected state is LOCKED');

  // ==========================================================================
  // [Test 6] Inclusive daily-loss boundary remains unchanged
  // ==========================================================================
  console.log('\n[Test 6] Inclusive daily-loss boundary (₹4,999 vs ₹5,000)');
  const res6a = await ShadowRiskService.evaluateLiveShadow(testUser, {
    injectedPositions: createClosedLossPosition(4999),
    injectedInstrumentMap: testInstrumentMap,
    configOverride: testConfig,
  });
  assert(res6a.isBreached === false, '₹4,999 loss is NOT breached');
  assert(res6a.expectedState === 'WARNING', '₹4,999 loss remains in WARNING state');

  const res6b = await ShadowRiskService.evaluateLiveShadow(testUser, {
    injectedPositions: createClosedLossPosition(5000),
    injectedInstrumentMap: testInstrumentMap,
    configOverride: testConfig,
  });
  assert(res6b.isBreached === true, '₹5,000 loss IS breached (inclusive >= boundary)');
  assert(res6b.expectedState === 'LOCKED', '₹5,000 loss is LOCKED');

  // ==========================================================================
  // [Test 7] Existing warning percentage semantics unchanged
  // ==========================================================================
  console.log('\n[Test 7] Warning percentage amounts match formula');
  assert(res1.warning1Amount === 3500, 'Warning 1 amount is exactly 70% of ₹5,000 = ₹3,500');
  assert(res1.warning2Amount === 4250, 'Warning 2 amount is exactly 85% of ₹5,000 = ₹4,250');
  assert(res1.warningThreshold1 === 70, 'Warning threshold 1 is 70%');
  assert(res1.warningThreshold2 === 85, 'Warning threshold 2 is 85%');

  // ==========================================================================
  // [Test 8] RiskEngine receives PnlResult.grossTradingPnl
  // ==========================================================================
  console.log('\n[Test 8] RiskEngine consumes PnlResult.grossTradingPnl directly');
  assert(res1.grossTradingPnl === res1.pnlResult.grossTradingPnl, 'grossTradingPnl matches pnlResult');
  assert(res5.grossTradingPnl === res5.pnlResult.grossTradingPnl, 'grossTradingPnl matches pnlResult on loss');
  assert(res5.pnlResult.realisedPnl === -8500, 'Realised P&L preserved in pnlResult');

  // ==========================================================================
  // [Test 9] Shadow evaluation causes zero RiskSession mutations
  // ==========================================================================
  console.log('\n[Test 9] Shadow evaluation causes zero RiskSession mutations');
  const sessionBefore = await ServerRiskStore.getSession(testUser);
  const sessionSnapshotBefore = JSON.stringify(sessionBefore);

  // Run shadow evaluation with massive breach (-₹25,000)
  const shadowBreachRes = await ShadowRiskService.evaluateLiveShadow(testUser, {
    injectedPositions: createClosedLossPosition(25000),
    injectedInstrumentMap: testInstrumentMap,
    configOverride: testConfig,
  });

  assert(shadowBreachRes.expectedState === 'LOCKED', 'Shadow evaluates massive loss as LOCKED');

  const sessionAfter = await ServerRiskStore.getSession(testUser);
  const sessionSnapshotAfter = JSON.stringify(sessionAfter);

  assert(sessionSnapshotBefore === sessionSnapshotAfter, 'RiskSession is 100% byte-for-byte identical before & after');
  assert(sessionAfter.state === sessionBefore.state, 'RiskSession state remains unchanged');
  assert(sessionAfter.lockedAt === sessionBefore.lockedAt, 'RiskSession lockedAt remains unchanged');
  assert(sessionAfter.isBreached === sessionBefore.isBreached, 'RiskSession isBreached remains unchanged');

  // ==========================================================================
  // [Test 10] Shadow evaluation causes zero riskEvents
  // ==========================================================================
  console.log('\n[Test 10] Shadow evaluation causes zero riskEvents');
  const eventsBefore = await ServerRiskStore.getAuditEvents(testUser);
  const countBefore = eventsBefore.length;

  // Run multiple shadow evaluations
  await ShadowRiskService.evaluateLiveShadow(testUser, {
    injectedPositions: createClosedLossPosition(3600),
    injectedInstrumentMap: testInstrumentMap,
    configOverride: testConfig,
  });
  await ShadowRiskService.evaluateLiveShadow(testUser, {
    injectedPositions: createClosedLossPosition(8500),
    injectedInstrumentMap: testInstrumentMap,
    configOverride: testConfig,
  });

  const eventsAfter = await ServerRiskStore.getAuditEvents(testUser);
  const countAfter = eventsAfter.length;

  assert(countBefore === countAfter, `Zero riskEvents emitted (before: ${countBefore}, after: ${countAfter})`);

  // ==========================================================================
  // [Test 11] Shadow evaluation causes zero Enforcement mutations
  // ==========================================================================
  console.log('\n[Test 11] Shadow evaluation causes zero Enforcement mutations');
  const enforceBefore = await EnforcementService.getEnforcementState(testUser);

  await ShadowRiskService.evaluateLiveShadow(testUser, {
    injectedPositions: createClosedLossPosition(25000),
    injectedInstrumentMap: testInstrumentMap,
    configOverride: testConfig,
  });

  const enforceAfter = await EnforcementService.getEnforcementState(testUser);

  assert(enforceBefore.isLocked === enforceAfter.isLocked, 'Enforcement isLocked is completely unmutated');
  assert(enforceBefore.riskState === enforceAfter.riskState, 'Enforcement riskState is completely unmutated');
  assert(enforceBefore.reason === enforceAfter.reason, 'Enforcement reason is completely unmutated');

  // ==========================================================================
  // [Test 12] Live data source remains ZERODHA_LIVE
  // ==========================================================================
  console.log('\n[Test 12] Live data source remains ZERODHA_LIVE & gate CLOSED');
  assert(res1.dataSource === 'ZERODHA_LIVE', 'Data source is ZERODHA_LIVE');
  assert(LIVE_PNL_VALIDATION_GATE === 'CLOSED', 'LIVE_PNL_VALIDATION_GATE is strictly CLOSED');
  assert(res1.validationGate === 'CLOSED', 'Validation result gate is CLOSED');
  assert(res1.riskIntegrationEnabled === false, 'riskIntegrationEnabled is strictly false');

  // ==========================================================================
  // [Test 13] No mock data enters the live shadow path
  // ==========================================================================
  console.log('\n[Test 13] No mock data enters live shadow path (fail-closed on unknown)');
  // Position with unknown token not in instrument map
  const unknownTokenPos: RawBrokerPosition[] = [
    {
      tradingsymbol: 'UNKNOWN_OPT',
      exchange: 'NFO',
      instrument_token: 999999,
      product: 'MIS',
      quantity: 10,
      overnight_quantity: 0,
      multiplier: 1,
      average_price: 100,
      close_price: 100,
      last_price: 100,
      pnl: 0,
      m2m: 0,
      unrealised: 0,
      realised: 0,
      day_buy_quantity: 10,
      day_buy_value: 1000,
      day_sell_quantity: 0,
      day_sell_value: 0,
    },
  ];

  const unknownRes = await ShadowRiskService.evaluateLiveShadow(testUser, {
    injectedPositions: unknownTokenPos,
    injectedInstrumentMap: testInstrumentMap, // 999999 is NOT in this map
    configOverride: testConfig,
  });

  assert(unknownRes.validationState === 'UNKNOWN_INSTRUMENTS', 'Unknown token produces UNKNOWN_INSTRUMENTS validation state');
  assert(unknownRes.dataSource === 'ZERODHA_LIVE', 'Source remains ZERODHA_LIVE');
  assert(unknownRes.pnlResult.fnoPositionCount === 0, 'Unknown instrument is strictly excluded from F&O position count');

  console.log('\n================================================================');
  console.log(`ALL 13 PHASE 9 SHADOW INTEGRATION TESTS PASSED (${passedTests}/${totalTests})`);
  console.log('================================================================\n');
}

runPhase9TestSuite().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
