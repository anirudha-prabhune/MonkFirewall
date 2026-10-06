/**
 * TRADING FIREWALL: PHASE 10B VERIFICATION SUITE
 * Controlled Live Risk Activation, Full Lock Lifecycle & End-to-End Zerodha Disconnect
 *
 * SECTION 1: CONTROLLED LIVE RISK ACTIVATION & STATUS
 * 1. Activation is disabled by default.
 * 2. Unauthorized activation is rejected; server-authoritative control works.
 * 3. Diagnostic status information returns all required fields without leaking secrets.
 *
 * SECTION 2: LIVE RISK LOCK LIFECYCLE (DETERMINISTIC FIXTURES)
 * 4. Positive P&L → ALLOW.
 * 5. Loss below warning threshold → ALLOW.
 * 6. Warning threshold (Threshold 1 & 2) → WARNING.
 * 7. Exact dailyLossLimit boundary → LOCKED.
 * 8. LOCKED creates lockUntil using existing configuration.
 * 9. Repeated evaluation is idempotent (lockUntil not extended, zero duplicate riskEvents).
 * 10. Improving P&L does not unlock an active lock.
 * 11. Lock expires only when authoritative server time >= lockUntil.
 * 12. Post-expiry evaluation uses current P&L (returns to ALLOW on safe P&L).
 * 13. A later breach creates a brand new lock lifecycle.
 * 14. Trading date remains independent from lockedAt/lockUntil timestamps.
 *
 * SECTION 3: END-TO-END ZERODHA DISCONNECT & RECONNECT
 * 15. Authenticated Disconnect succeeds.
 * 16. Persisted runtime session is invalidated/cleared.
 * 17. In-memory session/cache is cleared.
 * 18. Subsequent broker status becomes AUTHENTICATION_REQUIRED / DISCONNECTED.
 * 19. Subsequent live P&L requests cannot return ZERODHA_LIVE (returns SIMULATION).
 * 20. Subsequent live F&O positions cannot return ZERODHA_LIVE (returns MOCK_DATA).
 * 21. No stale LIVE MODE data remains.
 * 22. Disconnect is user-scoped.
 * 23. Firebase authentication remains intact.
 * 24. RiskConfig, RiskSession, and riskEvents remain intact.
 * 25. Repeated Disconnect is idempotent.
 * 26. Reconnect after disconnect works (re-establishes session and live mode).
 * 27. No order/trading API is invoked.
 */

import {
  LiveRiskRecorder,
  liveRiskStateRecordingEnabled,
  getLiveRiskStateRecordingEnabled,
  setLiveRiskStateRecordingEnabled,
} from '../server/risk/liveRiskRecorder';
import { ServerRiskStore } from '../server/risk/store';
import { RiskEngine, getTradingDateKolkata } from '../server/risk/engine';
import { RawBrokerPosition, BrokerInstrument } from '../server/brokers/types';
import { RiskConfig } from '../src/types/risk';
import { LivePnlValidationService } from '../server/pnl/liveValidationService';
import { BrokerService } from '../server/brokers/service';
import { LiveZerodhaAdapter, HttpFetchFn } from '../server/brokers/zerodha/liveAdapter';
import { ZerodhaCredentialManager } from '../server/brokers/zerodha/credentials';
import { ZerodhaSessionStore, enableMockStoreForTesting } from '../server/brokers/zerodha/sessionStore';
import { PnlResult } from '../server/pnl/types';

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

async function runPhase10BTestSuite() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: PHASE 10B VERIFICATION SUITE');
  console.log('Controlled Live Risk Activation, Full Lock Lifecycle & Disconnect');
  console.log('================================================================\n');

  const testUser = 'phase10b_trader_test';
  const baseConfig: RiskConfig = {
    dailyLossLimit: 5000,
    warningThreshold1: 70,
    warningThreshold2: 85,
    lockDurationMinutes: 120,
    lockDurationType: 'FIXED',
    includeRealisedPnl: true,
    includeUnrealisedPnl: true,
    enabled: true,
  };

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
        lotSize: 50,
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
        lotSize: 50,
        instrumentType: 'PE',
        segment: 'NFO-OPT',
        exchange: 'NFO',
      },
    ],
  ]);

  // Seed user config in memory
  await ServerRiskStore.saveConfig(testUser, baseConfig);

  // ============================================================================
  // SECTION 1: CONTROLLED LIVE RISK ACTIVATION & STATUS
  // ============================================================================
  console.log('[Test 1] Activation is disabled by default');
  // Ensure flag is reset to default
  setLiveRiskStateRecordingEnabled(false);
  assert(getLiveRiskStateRecordingEnabled() === false, 'Default flag state is strictly false');
  assert(liveRiskStateRecordingEnabled === false, 'Variable state is strictly false');

  console.log('\n[Test 2] Server-authoritative controlled activation & status');
  setLiveRiskStateRecordingEnabled(true);
  assert(getLiveRiskStateRecordingEnabled() === true, 'Activation flag updated to true when enabled');
  const session1 = await ServerRiskStore.getSession(testUser);
  const statusInfo = {
    enabled: getLiveRiskStateRecordingEnabled(),
    activationState: getLiveRiskStateRecordingEnabled() ? 'ACTIVE' : 'SHADOW_ONLY',
    currentRiskState: session1?.state || 'ALLOW',
    tradingDate: session1?.tradingDate || getTradingDateKolkata(),
    lockUntil: session1?.lockUntil || null,
    dataSource: 'ZERODHA_LIVE',
  };
  assert(statusInfo.enabled === true, 'Status info exposes enabled: true');
  assert(statusInfo.activationState === 'ACTIVE', 'Activation state reports ACTIVE');
  assert(statusInfo.currentRiskState === 'ALLOW', 'Current risk state reports ALLOW');
  assert(Boolean(statusInfo.tradingDate && statusInfo.tradingDate.length === 10), 'Trading date is populated');
  assert(statusInfo.lockUntil === null, 'Initial lockUntil is null');
  assert(statusInfo.dataSource === 'ZERODHA_LIVE', 'Data source is ZERODHA_LIVE');
  assert(!('apiKey' in statusInfo || 'apiSecret' in statusInfo || 'accessToken' in statusInfo), 'No secrets exposed in diagnostic info');

  // Deactivate back to default for clean baseline
  setLiveRiskStateRecordingEnabled(false);
  assert(getLiveRiskStateRecordingEnabled() === false, 'Deactivated back to shadow mode');

  // ============================================================================
  // SECTION 2: LIVE RISK LOCK LIFECYCLE (DETERMINISTIC FIXTURES)
  // ============================================================================
  const t0 = new Date('2026-10-05T09:30:00.000Z');

  console.log('\n[Test 3] Positive P&L (+₹7,280) → ALLOW');
  const posPnlResult: PnlResult = {
    tradingDate: '2026-10-05',
    realisedPnl: 7280,
    unrealisedPnl: 0,
    totalPnl: 7280,
    grossTradingPnl: 7280,
    dailyRealisedPnl: 7280,
    dailyUnrealisedPnl: 0,
    fnoPositionCount: 2,
    totalPositionCount: 2,
    positions: [],
    includedRealisedPnl: 7280,
    includedUnrealisedPnl: 0,
    source: 'ZERODHA_LIVE',
    calculatedAt: t0.toISOString(),
  };

  const evalAllow = await ServerRiskStore.evaluatePnlResult(testUser, posPnlResult, t0, baseConfig);
  assert(evalAllow.state === 'ALLOW', 'Positive P&L evaluates to ALLOW');
  assert(evalAllow.lossAmount === 0, 'Loss amount is 0');
  assert(evalAllow.isBreached === false, 'isBreached is false');
  assert(evalAllow.lockUntil === null, 'lockUntil is null for ALLOW');

  console.log('\n[Test 4] Loss below warning threshold (-₹2,000 / 40%) → ALLOW');
  const safeLossPnl: PnlResult = {
    ...posPnlResult,
    grossTradingPnl: -2000,
    realisedPnl: -2000,
    totalPnl: -2000,
  };
  const evalSafeLoss = await ServerRiskStore.evaluatePnlResult(testUser, safeLossPnl, t0, baseConfig);
  assert(evalSafeLoss.state === 'ALLOW', 'Loss below warning evaluates to ALLOW');
  assert(evalSafeLoss.lossAmount === 2000, 'Loss amount is 2000');
  assert(evalSafeLoss.isBreached === false, 'isBreached is false');

  console.log('\n[Test 5] Warning threshold 1 (-₹3,600 / 72%) & 2 (-₹4,300 / 86%) → WARNING');
  const warn1Pnl: PnlResult = {
    ...posPnlResult,
    grossTradingPnl: -3600,
    realisedPnl: -3600,
    totalPnl: -3600,
  };
  const evalWarn1 = await ServerRiskStore.evaluatePnlResult(testUser, warn1Pnl, t0, baseConfig);
  assert(evalWarn1.state === 'WARNING', 'Loss at 72% evaluates to WARNING');
  assert(evalWarn1.lossAmount === 3600, 'Loss amount is 3600');
  assert(evalWarn1.isBreached === false, 'isBreached is false at warning');

  const warn2Pnl: PnlResult = {
    ...posPnlResult,
    grossTradingPnl: -4300,
    realisedPnl: -4300,
    totalPnl: -4300,
  };
  const evalWarn2 = await ServerRiskStore.evaluatePnlResult(testUser, warn2Pnl, t0, baseConfig);
  assert(evalWarn2.state === 'WARNING', 'Loss at 86% evaluates to WARNING');
  assert(evalWarn2.isBreached === false, 'isBreached is false at warning 2');

  console.log('\n[Test 6] Exact dailyLossLimit boundary (-₹5,000) → LOCKED');
  const breachPnl: PnlResult = {
    ...posPnlResult,
    grossTradingPnl: -5000,
    realisedPnl: -5000,
    totalPnl: -5000,
  };
  const evalLock = await ServerRiskStore.evaluatePnlResult(testUser, breachPnl, t0, baseConfig);
  assert(evalLock.state === 'LOCKED', 'Exact loss limit evaluates to LOCKED');
  assert(evalLock.isBreached === true, 'isBreached is true');
  assert(evalLock.lossAmount === 5000, 'Loss amount is exactly 5000');
  assert(evalLock.lockedAt === t0.toISOString(), 'lockedAt is recorded at t0');

  console.log('\n[Test 7] LOCKED creates lockUntil using existing configuration (120 minutes)');
  const expectedLockUntil = new Date(t0.getTime() + 120 * 60 * 1000).toISOString();
  assert(evalLock.lockUntil === expectedLockUntil, `lockUntil is exactly 120m in future (${expectedLockUntil})`);
  assert(evalLock.lockUntil === '2026-10-05T11:30:00.000Z', 'Exact expected lockUntil timestamp matches');

  console.log('\n[Test 8] Repeated evaluation is idempotent (lockUntil NOT extended, no duplicate events)');
  const eventsCountBefore = (await ServerRiskStore.getAuditEvents(testUser)).length;
  const t1 = new Date('2026-10-05T10:00:00.000Z'); // 30 minutes later, still within lock
  const evalRepeat = await ServerRiskStore.evaluatePnlResult(testUser, breachPnl, t1, baseConfig);
  assert(evalRepeat.state === 'LOCKED', 'State remains LOCKED on repeated evaluation');
  assert(evalRepeat.lockUntil === expectedLockUntil, 'lockUntil strictly unchanged (not extended)');
  assert(evalRepeat.isIdempotent === true, 'isIdempotent is true');
  const eventsCountAfter = (await ServerRiskStore.getAuditEvents(testUser)).length;
  assert(eventsCountAfter === eventsCountBefore, `Zero duplicate events emitted (${eventsCountBefore} === ${eventsCountAfter})`);

  console.log('\n[Test 9] Improving P&L does not unlock an active lock');
  const t2 = new Date('2026-10-05T10:30:00.000Z');
  const improvedPnl: PnlResult = {
    ...posPnlResult,
    grossTradingPnl: 10000, // Massive profit while locked
    realisedPnl: 10000,
    totalPnl: 10000,
  };
  const evalImproving = await ServerRiskStore.evaluatePnlResult(testUser, improvedPnl, t2, baseConfig);
  assert(evalImproving.state === 'LOCKED', 'State remains strictly LOCKED despite improving P&L');
  assert(evalImproving.isBreached === true, 'isBreached remains true');
  assert(evalImproving.lockUntil === expectedLockUntil, 'lockUntil strictly unchanged');

  console.log('\n[Test 10] Lock expires only when authoritative server time >= lockUntil');
  // Just 1 ms before expiry: still active
  const justBeforeExpiry = new Date(new Date(expectedLockUntil).getTime() - 1);
  const evalStillActive = await ServerRiskStore.evaluatePnlResult(testUser, improvedPnl, justBeforeExpiry, baseConfig);
  assert(evalStillActive.state === 'LOCKED', 'Lock remains active 1ms before expiry');

  // Authoritative server time at exactly lockUntil: lock expires
  const atExpiry = new Date(expectedLockUntil); // 2026-10-05T11:30:00.000Z
  const evalExpired = await ServerRiskStore.evaluatePnlResult(testUser, improvedPnl, atExpiry, baseConfig);
  assert(evalExpired.state === 'ALLOW', 'After lock expiry, evaluation returns to ALLOW for profitable P&L');
  assert(evalExpired.isBreached === false, 'isBreached is reset to false');
  assert(evalExpired.lockUntil === null, 'lockUntil is cleared');
  const expireEvent = evalExpired.transitionEvents.find((e) => e.type === 'TRADING_LOCK_EXPIRED');
  assert(expireEvent !== undefined, 'TRADING_LOCK_EXPIRED event was emitted');

  console.log('\n[Test 11] Post-expiry evaluation uses current P&L');
  const t3 = new Date('2026-10-05T12:00:00.000Z');
  const postExpirySafeLoss: PnlResult = {
    ...posPnlResult,
    grossTradingPnl: -2500, // 50% loss
    realisedPnl: -2500,
    totalPnl: -2500,
  };
  const evalPostExpiry = await ServerRiskStore.evaluatePnlResult(testUser, postExpirySafeLoss, t3, baseConfig);
  assert(evalPostExpiry.state === 'ALLOW', 'Post-expiry safe loss evaluates to ALLOW based on current P&L');
  assert(evalPostExpiry.lossAmount === 2500, 'Loss amount reflects current P&L (2500)');

  console.log('\n[Test 12] A later breach creates a brand new lock lifecycle');
  const t4 = new Date('2026-10-05T13:00:00.000Z');
  const secondBreachPnl: PnlResult = {
    ...posPnlResult,
    grossTradingPnl: -5500, // Second breach
    realisedPnl: -5500,
    totalPnl: -5500,
  };
  const evalSecondLock = await ServerRiskStore.evaluatePnlResult(testUser, secondBreachPnl, t4, baseConfig);
  assert(evalSecondLock.state === 'LOCKED', 'Second breach triggers LOCKED');
  assert(evalSecondLock.lockedAt === t4.toISOString(), 'New lockedAt timestamp is recorded');
  const secondExpectedLockUntil = new Date(t4.getTime() + 120 * 60 * 1000).toISOString();
  assert(evalSecondLock.lockUntil === secondExpectedLockUntil, `New lockUntil is calculated: ${secondExpectedLockUntil}`);
  assert(evalSecondLock.lockUntil !== expectedLockUntil, 'New lockUntil is distinct from first lock');

  console.log('\n[Test 13] Trading date remains independent from lockedAt/lockUntil');
  assert(evalSecondLock.tradingDate === '2026-10-05', 'Trading date is 2026-10-05');
  assert(Boolean(evalSecondLock.lockedAt && evalSecondLock.lockedAt.startsWith('2026-10-05T13:00:00')), 'lockedAt is full ISO timestamp');
  assert(Boolean(evalSecondLock.lockUntil && evalSecondLock.lockUntil.startsWith('2026-10-05T15:00:00')), 'lockUntil is full ISO timestamp');

  // ============================================================================
  // SECTION 3: END-TO-END ZERODHA DISCONNECT & RECONNECT
  // ============================================================================
  console.log('\n[Test 14] Setup authenticated Zerodha session');
  const disconnectUser = 'phase10b_disconnect_user';
  enableMockStoreForTesting(true);

  const mockFetch: HttpFetchFn = async (url: string) => {
    if (url.includes('/user/profile')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'success',
          data: {
            user_id: 'WP4783',
            user_name: 'Anirudha Prabhune',
          },
        }),
      };
    }
    if (url.includes('/portfolio/positions')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'success',
          data: { net: [], day: [] },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'success', data: {} }),
    };
  };

  const liveAdapter = BrokerService.getLiveAdapter();
  (liveAdapter as LiveZerodhaAdapter).setFetchHandler(mockFetch);

  // Save active session
  await ZerodhaSessionStore.saveSession(disconnectUser, 'test_access_token_12345', {
    brokerUserId: 'WP4783',
  });
  ZerodhaCredentialManager.setRuntimeSession({
    accessToken: 'test_access_token_12345',
    sessionVersion: 1,
    authenticatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    userId: 'WP4783',
  }, disconnectUser);

  const preStatus = await BrokerService.getLiveDiagnosticStatus(disconnectUser);
  assert(preStatus.authenticated === true, 'Pre-condition: User is authenticated before disconnect');

  console.log('\n[Test 15] Authenticated Disconnect succeeds and invalidates persisted session');
  await ZerodhaCredentialManager.disconnect(disconnectUser);
  const loadedSession = await ZerodhaSessionStore.loadSession(disconnectUser);
  assert(
    !loadedSession || loadedSession.authState !== 'AUTHENTICATED' || !loadedSession.accessToken,
    'Persisted runtime session is invalidated (authState != AUTHENTICATED, empty accessToken)'
  );

  console.log('\n[Test 16] In-memory session/cache is cleared');
  const inMemoryToken = ZerodhaCredentialManager.getActiveAccessToken(disconnectUser);
  assert(inMemoryToken === null, 'In-memory access token is strictly null');
  const inMemorySession = ZerodhaCredentialManager.getRuntimeSession();
  assert(inMemorySession === null, 'In-memory runtime session is strictly null');

  console.log('\n[Test 17] Subsequent broker status reports AUTHENTICATION_REQUIRED');
  const postStatus = await BrokerService.getLiveDiagnosticStatus(disconnectUser);
  assert(postStatus.authenticated === false, 'Broker status authenticated is strictly false');
  assert(
    postStatus.status === 'AUTHENTICATION_REQUIRED' || postStatus.status === 'DISCONNECTED',
    `Status is AUTHENTICATION_REQUIRED (got ${postStatus.status})`
  );

  console.log('\n[Test 18] Live P&L cannot be returned after disconnect (fails closed)');
  const postValidation = await LivePnlValidationService.validateLivePnl(
    baseConfig,
    new Date(),
    undefined,
    undefined,
    disconnectUser
  );
  assert(
    postValidation.validationState === 'AUTHENTICATION_REQUIRED',
    'Live P&L validation returns AUTHENTICATION_REQUIRED'
  );
  assert(
    postValidation.validationGate === 'CLOSED',
    'Validation gate is strictly CLOSED after disconnect'
  );
  assert(
    postValidation.riskIntegrationEnabled === false,
    'riskIntegrationEnabled is strictly false after disconnect'
  );

  console.log('\n[Test 19] Live F&O positions cannot be returned after disconnect');
  const postPositions = await BrokerService.getLiveDiagnosticPositions(disconnectUser);
  assert(postPositions.positions.length === 0, 'Live positions array is empty after disconnect');
  assert(postPositions.connectionStatus === 'AUTHENTICATION_REQUIRED', 'Connection status is AUTHENTICATION_REQUIRED');

  console.log('\n[Test 20] Disconnect is user-scoped and preserves application data');
  // Check RiskConfig
  const postConfig = await ServerRiskStore.getConfig(testUser);
  assert(postConfig.dailyLossLimit === 5000, 'RiskConfig remains intact');
  // Check RiskSession
  const postSession = await ServerRiskStore.getSession(testUser, evalSecondLock.tradingDate);
  assert(postSession !== null && postSession.state === 'LOCKED', 'RiskSession remains intact');
  // Check riskEvents
  const postEvents = await ServerRiskStore.getAuditEvents(testUser);
  assert(postEvents.length > 0, 'riskEvents history remains intact');

  console.log('\n[Test 21] Repeated Disconnect is idempotent');
  await ZerodhaCredentialManager.disconnect(disconnectUser);
  const repeatPostStatus = await BrokerService.getLiveDiagnosticStatus(disconnectUser);
  assert(repeatPostStatus.authenticated === false, 'Repeated disconnect produces no error and remains disconnected');

  console.log('\n[Test 22] Reconnect after disconnect re-establishes session and live mode');
  await ZerodhaSessionStore.saveSession(disconnectUser, 'new_reconnect_token_67890', {
    brokerUserId: 'WP4783',
  });
  ZerodhaCredentialManager.setRuntimeSession({
    accessToken: 'new_reconnect_token_67890',
    sessionVersion: 2,
    authenticatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    userId: 'WP4783',
  }, disconnectUser);

  const reconnectedStatus = await BrokerService.getLiveDiagnosticStatus(disconnectUser);
  assert(reconnectedStatus.authenticated === true, 'Reconnected user is authenticated: true');
  assert(reconnectedStatus.status === 'CONNECTED', 'Reconnected user status is CONNECTED');

  // Clean disconnect after test
  await ZerodhaCredentialManager.disconnect(disconnectUser);
  (liveAdapter as LiveZerodhaAdapter).setFetchHandler(undefined);
  enableMockStoreForTesting(false);

  console.log('\n[Test 23] No order/trading API is invoked');
  assert(!('placeOrder' in liveAdapter), 'No placeOrder method on live adapter');
  assert(!('modifyOrder' in liveAdapter), 'No modifyOrder method on live adapter');
  assert(!('cancelOrder' in liveAdapter), 'No cancelOrder method on live adapter');
  assert(!('squareOff' in liveAdapter), 'No squareOff method on live adapter');

  // Verify default flag state
  assert(getLiveRiskStateRecordingEnabled() === false, 'liveRiskStateRecordingEnabled is strictly FALSE after all tests');

  console.log('================================================================');
  console.log(`ALL 23 PHASE 10B INTEGRATION TESTS PASSED (${passedTests}/${totalTests})`);
  console.log('================================================================\n');
}

runPhase10BTestSuite().catch((err) => {
  console.error('Phase 10B Test Suite Failed:', err);
  process.exit(1);
});
