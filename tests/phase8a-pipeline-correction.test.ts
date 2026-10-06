/**
 * TRADING FIREWALL — PHASE 8A REGRESSION VERIFICATION SUITE
 * Live Position Data Pipeline Correction
 *
 * Verifies:
 * 1. Authenticated user session is explicitly loaded (userId server-side context)
 * 2. Missing session returns AUTHENTICATION_REQUIRED, never empty positions
 * 3. Net open F&O position survives
 * 4. Day closed F&O position survives
 * 5. Closed quantity=0 with realised!=0 survives
 * 6. Live instrument token cannot fall back to mock metadata
 * 7. Unresolved live metadata produces UNKNOWN_INSTRUMENTS / MISSING_DATA
 * 8. Net + Day do not double-count
 * 9. Live path never invokes RiskEngine or mutates risk state
 */

import { LivePnlValidationService } from '../server/pnl/liveValidationService';
import { LIVE_PNL_VALIDATION_GATE } from '../server/pnl/liveValidationTypes';
import { LiveZerodhaAdapter, HttpFetchFn } from '../server/brokers/zerodha/liveAdapter';
import { ZerodhaCredentialManager } from '../server/brokers/zerodha/credentials';
import { ZerodhaSessionStore } from '../server/brokers/zerodha/sessionStore';
import { BrokerService } from '../server/brokers/service';
import { ServerRiskStore } from '../server/risk/store';
import { EnforcementService } from '../server/enforcement/service';
import { RawBrokerPosition, BrokerInstrument } from '../server/brokers/types';
import { normalizePosition, normalizePositions, getFnoPositions } from '../server/brokers/normalize';

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

async function runPipelineCorrectionSuite() {
  console.log('================================================================');
  console.log('PHASE 8A: LIVE POSITION DATA PIPELINE CORRECTION TESTS');
  console.log('Session Context, Net/Day Provenance, Authoritative Metadata');
  console.log('================================================================\n');

  const testUserId = 'pipeline_test_user_777';

  // --------------------------------------------------------------------------
  // TEST 1: Authenticated user session is explicitly loaded
  // --------------------------------------------------------------------------
  console.log('[Test 1] Authenticated user session is explicitly loaded with userId');
  ZerodhaCredentialManager.setRuntimeSession(
    {
      accessToken: 'test_token_user_777',
      userId: testUserId,
      authenticatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      sessionVersion: 1,
    },
    testUserId
  );

  const loadedSession = await ZerodhaCredentialManager.getAuthenticatedSession(testUserId);
  assert(loadedSession !== null, 'Session loaded for explicit testUserId');
  assert(loadedSession?.accessToken === 'test_token_user_777', 'Session token is available server-side');

  // Verify non-existent user has NO session
  const nonExistent = await ZerodhaCredentialManager.getAuthenticatedSession('unauthenticated_user_999');
  assert(nonExistent === null, 'Non-authenticated user returns null session');

  // --------------------------------------------------------------------------
  // TEST 2: Missing session returns AUTHENTICATION_REQUIRED, never empty positions
  // --------------------------------------------------------------------------
  console.log('\n[Test 2] Missing session returns AUTHENTICATION_REQUIRED, never empty positions');
  const missingSessionResult = await LivePnlValidationService.validateLivePnl(
    undefined,
    new Date(),
    undefined,
    undefined,
    'user_without_session_123'
  );

  assert(
    missingSessionResult.validationState === 'AUTHENTICATION_REQUIRED',
    "validationState is strictly 'AUTHENTICATION_REQUIRED'"
  );
  assert(
    Boolean(missingSessionResult.notes?.includes('authentication required') || missingSessionResult.notes?.includes('No active session')),
    'Notes specify authentication required'
  );
  assert(missingSessionResult.calculated.fnoPositionCount === 0, 'fnoPositionCount is 0');
  assert(missingSessionResult.validationGate === 'CLOSED', 'Validation gate remains CLOSED');

  // --------------------------------------------------------------------------
  // TEST 3: Net open F&O position survives
  // --------------------------------------------------------------------------
  console.log('\n[Test 3] Net open F&O position survives with provenance');
  const mockOpenNetPos: RawBrokerPosition = {
    instrument_token: 110001,
    exchange: 'NFO',
    tradingsymbol: 'NIFTY26OCTFUT',
    product: 'NRML',
    quantity: 50,
    average_price: 25000.0,
    last_price: 25100.0,
    close_price: 24900.0,
    pnl: 5000.0,
    realised: 0.0,
    unrealised: 5000.0,
    day_buy_quantity: 50,
    day_buy_value: 1250000.0,
    day_sell_quantity: 0,
    day_sell_value: 0.0,
    provenance: 'net',
  };

  const liveInstrumentMap = new Map<number, BrokerInstrument>([
    [
      110001,
      {
        instrumentToken: 110001,
        exchange: 'NFO',
        tradingsymbol: 'NIFTY26OCTFUT',
        name: 'NIFTY',
        segment: 'NFO-FUT',
        instrumentType: 'FUT',
        expiry: '2026-10-29',
        strike: null,
        tickSize: 0.05,
        lotSize: 50,
      },
    ],
  ]);

  const normNetPos = normalizePosition(mockOpenNetPos, liveInstrumentMap, 'ZERODHA_LIVE');
  assert(normNetPos.isFno === true, 'Net position is classified as F&O');
  assert(normNetPos.provenance === 'net', "Provenance is 'net'");
  assert(normNetPos.quantity === 50, 'Quantity is 50');

  // --------------------------------------------------------------------------
  // TEST 4: Day closed F&O position survives
  // --------------------------------------------------------------------------
  console.log('\n[Test 4] Day closed F&O position survives with provenance');
  const mockClosedDayPos: RawBrokerPosition = {
    instrument_token: 120001,
    exchange: 'NFO',
    tradingsymbol: 'BANKNIFTY26OCTFUT',
    product: 'MIS',
    quantity: 0,
    average_price: 52000.0,
    last_price: 52100.0,
    close_price: 51950.0,
    pnl: 3000.0,
    realised: 3000.0,
    unrealised: 0.0,
    day_buy_quantity: 30,
    day_buy_value: 1560000.0,
    day_sell_quantity: 30,
    day_sell_value: 1563000.0,
    provenance: 'day',
  };

  liveInstrumentMap.set(120001, {
    instrumentToken: 120001,
    exchange: 'NFO',
    tradingsymbol: 'BANKNIFTY26OCTFUT',
    name: 'BANKNIFTY',
    segment: 'NFO-FUT',
    instrumentType: 'FUT',
    expiry: '2026-10-29',
    strike: null,
    tickSize: 0.05,
    lotSize: 30,
  });

  const normDayPos = normalizePosition(mockClosedDayPos, liveInstrumentMap, 'ZERODHA_LIVE');
  assert(normDayPos.isFno === true, 'Day closed position classified as F&O');
  assert(normDayPos.provenance === 'day', "Provenance is 'day'");
  assert(normDayPos.quantity === 0, 'Quantity is 0');
  assert(normDayPos.realisedPnl === 3000.0, 'Realised P&L is 3000.0');

  // --------------------------------------------------------------------------
  // TEST 5: Closed quantity=0 with realised!=0 survives in validation
  // --------------------------------------------------------------------------
  console.log('\n[Test 5] Closed quantity=0 with realised!=0 survives downstream validation');
  // Pass both positions where the closed position is only in day
  const combinedRawPositions = [mockOpenNetPos, mockClosedDayPos];
  const validationWithClosed = await LivePnlValidationService.validateLivePnl(
    undefined,
    new Date(),
    combinedRawPositions,
    liveInstrumentMap
  );

  assert(validationWithClosed.calculated.fnoPositionCount === 2, 'Both open and closed F&O positions counted (2)');
  assert(validationWithClosed.calculated.dailyRealisedPnl === 3000.0, 'Closed position realised P&L (3000) preserved');
  assert(validationWithClosed.calculated.dailyUnrealisedPnl === 5000.0, 'Open position unrealised P&L (5000) preserved');
  assert(validationWithClosed.calculated.grossTradingPnl === 8000.0, 'Total Gross P&L is 8000.0');

  // --------------------------------------------------------------------------
  // TEST 6: Live instrument token cannot fall back to mock metadata
  // --------------------------------------------------------------------------
  console.log('\n[Test 6] Live instrument token cannot fall back to mock metadata');
  // Position with a real live token not in mock metadata (token: 998877)
  const realLiveTokenPos: RawBrokerPosition = {
    instrument_token: 998877,
    exchange: 'NFO',
    tradingsymbol: 'NIFTY26NOV25000CE',
    product: 'NRML',
    quantity: 50,
    average_price: 150.0,
    last_price: 160.0,
    close_price: 140.0,
    pnl: 500.0,
    realised: 0.0,
    unrealised: 500.0,
    day_buy_quantity: 50,
    day_buy_value: 7500.0,
    day_sell_quantity: 0,
    day_sell_value: 0.0,
    provenance: 'net',
  };

  // Normalization with EMPTY instrument map (simulating live metadata fetch failure without mock fallback)
  const emptyMap = new Map<number, BrokerInstrument>();
  const normRealToken = normalizePosition(realLiveTokenPos, emptyMap, 'ZERODHA_LIVE');
  assert(normRealToken.unknownInstrument === true, 'Token 998877 marked as unknownInstrument');
  assert(normRealToken.isFno === false, 'Cannot be classified as F&O without authoritative metadata');
  assert(normRealToken.segment === 'UNKNOWN', "Segment is strictly 'UNKNOWN'");

  // --------------------------------------------------------------------------
  // TEST 7: Unresolved live metadata produces UNKNOWN_INSTRUMENTS / MISSING_DATA
  // --------------------------------------------------------------------------
  console.log('\n[Test 7] Unresolved live metadata produces UNKNOWN_INSTRUMENTS validationState');
  const unresolvedValidation = await LivePnlValidationService.validateLivePnl(
    undefined,
    new Date(),
    [realLiveTokenPos],
    emptyMap
  );

  assert(
    unresolvedValidation.validationState === 'UNKNOWN_INSTRUMENTS',
    "validationState is strictly 'UNKNOWN_INSTRUMENTS'"
  );
  assert(unresolvedValidation.unknownInstruments.length === 1, 'Unknown instruments array has 1 item');
  assert(unresolvedValidation.unknownInstruments[0].instrumentToken === 998877, 'Unknown token is 998877');
  assert(unresolvedValidation.calculated.fnoPositionCount === 0, 'Unknown instrument excluded from F&O position count');

  // --------------------------------------------------------------------------
  // TEST 8: Net + Day do not double-count
  // --------------------------------------------------------------------------
  console.log('\n[Test 8] Net + Day do not double-count open positions');
  // Suppose broker returns an open position in BOTH net and day arrays:
  const doubleReportedNet: RawBrokerPosition = {
    ...mockOpenNetPos,
    provenance: 'net',
  };
  const doubleReportedDay: RawBrokerPosition = {
    ...mockOpenNetPos,
    provenance: 'day',
    // In day array, Zerodha reports today's trades
    day_buy_quantity: 50,
    day_buy_value: 1250000.0,
  };

  const doubleCountTestRaw = [doubleReportedNet, doubleReportedDay];
  const doubleCountValidation = await LivePnlValidationService.validateLivePnl(
    undefined,
    new Date(),
    doubleCountTestRaw,
    liveInstrumentMap
  );

  assert(
    doubleCountValidation.calculated.fnoPositionCount === 1,
    'F&O Position count is 1 (net and day not double counted)'
  );
  assert(
    doubleCountValidation.calculated.dailyUnrealisedPnl === 5000.0,
    'Unrealized P&L is 5000.0 (not doubled to 10,000)'
  );
  assert(
    doubleCountValidation.calculated.grossTradingPnl === 5000.0,
    'Gross Trading P&L is 5000.0 (not doubled to 10,000)'
  );

  // --------------------------------------------------------------------------
  // TEST 9: Live path never invokes RiskEngine or mutates risk state
  // --------------------------------------------------------------------------
  console.log('\n[Test 9] Live path never invokes RiskEngine or mutates risk state');
  const riskSessionBefore = await ServerRiskStore.getSession(testUserId);
  const enforcementBefore = await EnforcementService.getEnforcementState(testUserId);
  const eventsBefore = await ServerRiskStore.getAuditEvents(testUserId);

  // Execute live validation with simulated huge loss
  const hugeLossPos: RawBrokerPosition = {
    instrument_token: 110001,
    exchange: 'NFO',
    tradingsymbol: 'NIFTY26OCTFUT',
    product: 'NRML',
    quantity: 50,
    average_price: 25000.0,
    last_price: 24000.0, // ₹50,000 loss
    close_price: 25000.0,
    pnl: -50000.0,
    realised: 0.0,
    unrealised: -50000.0,
    day_buy_quantity: 50,
    day_buy_value: 1250000.0,
    day_sell_quantity: 0,
    day_sell_value: 0.0,
    provenance: 'net',
  };

  await LivePnlValidationService.validateLivePnl(
    undefined,
    new Date(),
    [hugeLossPos],
    liveInstrumentMap
  );

  const riskSessionAfter = await ServerRiskStore.getSession(testUserId);
  const enforcementAfter = await EnforcementService.getEnforcementState(testUserId);
  const eventsAfter = await ServerRiskStore.getAuditEvents(testUserId);

  assert(riskSessionBefore.lockedAt === riskSessionAfter.lockedAt, 'RiskSession lockedAt unchanged');
  assert(riskSessionBefore.isBreached === riskSessionAfter.isBreached, 'RiskSession isBreached unchanged');
  assert(enforcementBefore.isLocked === enforcementAfter.isLocked, 'Enforcement isLocked unchanged');
  assert(eventsBefore.length === eventsAfter.length, 'Zero risk events created by live validation');
  assert(LIVE_PNL_VALIDATION_GATE === 'CLOSED', 'LIVE_PNL_VALIDATION_GATE remains CLOSED');

  console.log('\n================================================================');
  console.log(`ALL ${totalTests} PIPELINE CORRECTION REGRESSION TESTS PASSED (${passedTests}/${totalTests})`);
  console.log('================================================================\n');
}

runPipelineCorrectionSuite().catch((err) => {
  console.error('Pipeline correction test suite error:', err);
  process.exit(1);
});
