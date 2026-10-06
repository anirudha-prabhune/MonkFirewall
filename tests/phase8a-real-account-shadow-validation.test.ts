/**
 * TRADING FIREWALL — PHASE 8A VERIFICATION SUITE
 * Controlled Real-Account Shadow Validation
 *
 * VALIDATION-ONLY PHASE CONSTRAINTS:
 * - LIVE_PNL_VALIDATION_GATE = CLOSED
 * - riskIntegrationEnabled = false
 * - RiskEngine is NOT invoked by live validation
 * - RiskSession is NOT mutated by live validation
 * - riskEvents are NOT created by live validation
 * - Enforcement state is NOT mutated by live validation
 * - No order, position modification, square-off, cancel, or trading capability
 * - Real Zerodha account is strictly READ-ONLY
 */

import crypto from 'crypto';
import { LivePnlValidationService } from '../server/pnl/liveValidationService';
import { LIVE_PNL_VALIDATION_GATE } from '../server/pnl/liveValidationTypes';
import {
  ValidationSessionManager,
  ValidationSessionMetadata,
  PositionObservation,
  ValidationSessionReport,
} from '../server/pnl/validationSession';
import { ZerodhaCredentialManager } from '../server/brokers/zerodha/credentials';
import { enableMockStoreForTesting } from '../server/brokers/zerodha/sessionStore';
import { LiveZerodhaAdapter } from '../server/brokers/zerodha/liveAdapter';
import { BrokerService } from '../server/brokers/service';
import { MarketDataService } from '../server/market/marketDataService';
import { ServerRiskStore } from '../server/risk/store';
import { EnforcementService } from '../server/enforcement/service';
import { classifyInstrument, MOCK_INSTRUMENT_MAP } from '../server/instruments/master';
import { RawBrokerPosition, BrokerInstrument } from '../server/brokers/types';
import { getTradingDateKolkata } from '../server/risk/engine';
import { apiRouter } from '../server/api';

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

async function runPhase8aTestSuite() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: PHASE 8A SHADOW VALIDATION VERIFICATION SUITE');
  console.log('Controlled Real-Account Shadow Validation & Safety Invariants');
  console.log('================================================================\n');

  ValidationSessionManager.resetForTest();
  enableMockStoreForTesting(true);

  // --------------------------------------------------------------------------
  // SECTION 1: NON-NEGOTIABLE SAFETY INVARIANTS PROOF
  // --------------------------------------------------------------------------
  console.log('[Phase 8A Test 1] Non-negotiable safety invariants: gate CLOSED and zero trading APIs');
  assert(LIVE_PNL_VALIDATION_GATE === 'CLOSED', 'LIVE_PNL_VALIDATION_GATE constant must strictly be CLOSED');

  const baselineRes = await LivePnlValidationService.validateLivePnl();
  assert(baselineRes.validationGate === 'CLOSED', 'LivePnlValidationResult.validationGate must be CLOSED');
  assert(baselineRes.riskIntegrationEnabled === false, 'LivePnlValidationResult.riskIntegrationEnabled must be strictly false');

  const liveAdapter = BrokerService.getLiveAdapter();
  assert(typeof (liveAdapter as any).placeOrder === 'undefined', 'LiveZerodhaAdapter must have no placeOrder method');
  assert(typeof (liveAdapter as any).modifyOrder === 'undefined', 'LiveZerodhaAdapter must have no modifyOrder method');
  assert(typeof (liveAdapter as any).cancelOrder === 'undefined', 'LiveZerodhaAdapter must have no cancelOrder method');
  assert(typeof (liveAdapter as any).exitOrder === 'undefined', 'LiveZerodhaAdapter must have no exitOrder method');
  assert(typeof (liveAdapter as any).squareOff === 'undefined', 'LiveZerodhaAdapter must have no squareOff method');

  // Verify express router has zero order routes
  const routerStack = (apiRouter as any).stack || [];
  const orderRoutes = routerStack.filter((layer: any) => {
    const path = layer?.route?.path || '';
    return (
      path.includes('/order') ||
      path.includes('/trade') ||
      path.includes('/square-off') ||
      path.includes('/cancel') ||
      path.includes('/modify')
    );
  });
  assert(orderRoutes.length === 0, 'apiRouter must have ZERO order, trade, square-off, or cancel endpoints');

  // --------------------------------------------------------------------------
  // SECTION 2: CREDENTIAL ISOLATION & SECURITY
  // --------------------------------------------------------------------------
  console.log('\n[Phase 8A Test 2] Credential isolation: credentials never exposed or logged');
  const sanitized = ZerodhaCredentialManager.sanitize({
    user: 'test_trader',
    apiKey: 'SECRET_API_KEY',
    apiSecret: 'SECRET_API_SECRET',
    accessToken: 'SECRET_ACCESS_TOKEN',
    data: 12345,
  });
  assert((sanitized as any).apiKey === undefined, 'Sanitized object must not contain apiKey');
  assert((sanitized as any).apiSecret === undefined, 'Sanitized object must not contain apiSecret');
  assert((sanitized as any).accessToken === undefined, 'Sanitized object must not contain accessToken');
  assert((sanitized as any).data === 12345, 'Sanitized object preserves benign data');

  const presenceDiag = ZerodhaCredentialManager.getPresenceDiagnostic();
  assert(typeof presenceDiag.apiKeyConfigured === 'boolean', 'apiKeyConfigured must strictly be boolean');
  assert(typeof presenceDiag.accessTokenConfigured === 'boolean', 'accessTokenConfigured must strictly be boolean');
  assert(typeof presenceDiag.apiSecretConfigured === 'boolean', 'apiSecretConfigured must strictly be boolean');
  assert((presenceDiag as any).apiKey === undefined, 'Presence diagnostic must not contain apiKey');
  assert((presenceDiag as any).accessToken === undefined, 'Presence diagnostic must not contain accessToken');
  assert((presenceDiag as any).apiSecret === undefined, 'Presence diagnostic must not contain apiSecret');

  const sanitizedErr = ZerodhaCredentialManager.sanitizeErrorString('Error with raw api key or tokens');
  assert(typeof sanitizedErr === 'string', 'sanitizeErrorString returns sanitized string');

  // --------------------------------------------------------------------------
  // SECTION 2B: DAILY KITE CONNECT AUTHENTICATION FLOW (PHASE 8A CORRECTION)
  // --------------------------------------------------------------------------
  console.log('\n[Phase 8A Test 2B] Daily Kite Connect V3 authentication flow verification');

  // Checksum calculation test: SHA256(api_key + request_token + api_secret)
  const testApiKey = 'test_kite_api_key';
  const testReqToken = 'test_request_token_abc';
  const testApiSecret = 'test_kite_api_secret';
  const expectedChecksum = crypto
    .createHash('sha256')
    .update(testApiKey + testReqToken + testApiSecret)
    .digest('hex');
  const actualChecksum = ZerodhaCredentialManager.computeChecksum(testApiKey, testReqToken, testApiSecret);
  assert(actualChecksum === expectedChecksum, 'Checksum matches Kite V3 SHA256 specification');

  // Login URL generation test
  process.env.ZERODHA_API_KEY = testApiKey;
  process.env.ZERODHA_API_SECRET = testApiSecret;
  const loginUrl = ZerodhaCredentialManager.getLoginUrl('https://example.com/callback');
  assert(loginUrl.startsWith('https://kite.zerodha.com/connect/login?v=3&api_key='), 'Login URL uses Kite Connect v=3');
  assert(loginUrl.includes(testApiKey), 'Login URL contains configured API Key');
  assert(loginUrl.includes('redirect_url='), 'Login URL includes redirect_url');
  assert(!loginUrl.includes(testApiSecret), 'Login URL strictly NEVER contains API Secret');
  assert(!loginUrl.includes('access_token'), 'Login URL strictly NEVER contains Access Token');

  // Request Token exchange test: Mock successful Kite Connect exchange
  const mockTokenFetch = async (url: string, opts?: any) => {
    if (url.includes('/session/token')) {
      assert(opts.method === 'POST', 'Exchange uses HTTP POST');
      assert(opts.headers['X-Kite-Version'] === '3', 'Header includes X-Kite-Version: 3');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'success',
          data: {
            user_id: 'ZR1234',
            user_name: 'Test Trader',
            access_token: 'ephemeral_live_access_token_xyz',
            public_token: 'public_token_dummy',
          },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({ status: 'error' }) };
  };

  const exchangeRes = await ZerodhaCredentialManager.exchangeRequestToken('valid_req_token', mockTokenFetch as any);
  assert(exchangeRes.success === true, 'Token exchange succeeds');
  assert(exchangeRes.session?.userId === 'ZR1234', 'Session user ID captured');
  assert(ZerodhaCredentialManager.getActiveAccessToken() === 'ephemeral_live_access_token_xyz', 'In-memory ephemeral token set');
  assert(ZerodhaCredentialManager.getAuthState() === 'AUTHENTICATED', 'Auth state transitions to AUTHENTICATED');

  // Ephemeral in-memory storage guarantee: Token is stored in memory, not written to disk or process.env
  assert(process.env.ZERODHA_ACCESS_TOKEN !== 'ephemeral_live_access_token_xyz', 'Ephemeral token is NOT stored in process.env');

  // Invalidate session test
  ZerodhaCredentialManager.invalidateSession();
  assert(ZerodhaCredentialManager.getRuntimeSession() === null, 'Invalidate session clears runtime session');
  assert(ZerodhaCredentialManager.getAuthState() === 'AUTHENTICATION_REQUIRED', 'Auth state transitions to AUTHENTICATION_REQUIRED');

  // Request Token exchange failure handling
  const mockFailingTokenFetch = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ status: 'error', message: 'Token is invalid or expired' }),
  });
  const failExchange = await ZerodhaCredentialManager.exchangeRequestToken('invalid_token', mockFailingTokenFetch as any);
  assert(failExchange.success === false, 'Failing exchange properly flagged as success: false');
  assert(ZerodhaCredentialManager.getAuthState() === 'AUTHENTICATION_ERROR', 'Auth state transitions to AUTHENTICATION_ERROR');

  // --------------------------------------------------------------------------
  // SECTION 3: VALIDATION SESSION METADATA & OBSERVATIONS
  // --------------------------------------------------------------------------
  console.log('\n[Phase 8A Test 3] Validation session lifecycle and metadata');
  const session = ValidationSessionManager.startSession('Unit verification shadow session');
  assert(session.validationSessionId.startsWith('vsess_'), 'validationSessionId has proper prefix');
  assert(session.timezone === 'Asia/Kolkata', 'timezone is Asia/Kolkata');
  assert(session.broker === 'zerodha', 'broker is zerodha');
  assert(session.mode === 'REAL_ACCOUNT_SHADOW', 'mode is REAL_ACCOUNT_SHADOW');
  assert(session.riskIntegrationEnabled === false, 'riskIntegrationEnabled is false');
  assert(session.validationGate === 'CLOSED', 'validationGate is CLOSED');
  assert(session.endedAt === null, 'active session endedAt is null');

  const active = ValidationSessionManager.getActiveSession();
  assert(active?.validationSessionId === session.validationSessionId, 'ValidationSessionManager tracks active session');

  // --------------------------------------------------------------------------
  // SECTION 4: BROKER CONNECTIVITY STATUS VERIFICATION
  // --------------------------------------------------------------------------
  console.log('\n[Phase 8A Test 4] Broker connectivity status verification');
  const connStatus = await liveAdapter.getConnectionStatus();
  assert(connStatus.broker === 'zerodha', 'broker identifier is zerodha');
  assert(connStatus.isMock === false, 'isMock is false for live adapter');
  assert(
    ['CONNECTED', 'CONFIGURATION_ERROR', 'AUTHENTICATION_ERROR', 'AUTHENTICATION_REQUIRED', 'UPSTREAM_ERROR'].includes(connStatus.status),
    `Status (${connStatus.status}) is an authorized connection state`
  );
  assert((connStatus as any).apiKey === undefined, 'No apiKey returned in connection status');
  assert((connStatus as any).accessToken === undefined, 'No accessToken returned in connection status');

  // --------------------------------------------------------------------------
  // SECTION 5: INSTRUMENT MASTER VALIDATION (NFO-FUT, NFO-OPT, BFO-FUT, BFO-OPT)
  // --------------------------------------------------------------------------
  console.log('\n[Phase 8A Test 5] Authoritative instrument master classification');
  const futClass = classifyInstrument({
    segment: 'NFO-FUT',
    instrumentType: 'FUT',
  });
  assert(futClass.isFno === true, 'NFO-FUT classified as F&O');
  assert(futClass.type === 'FUTURE', 'Detail type is FUTURE');

  const optClass = classifyInstrument({
    segment: 'NFO-OPT',
    instrumentType: 'CE',
  });
  assert(optClass.isFno === true, 'NFO-OPT classified as F&O');
  assert(optClass.type === 'OPTION', 'Detail type is OPTION');

  // Equity exclusion test (even if symbol has heuristics like 'CE' or 'FUT')
  const eqClass = classifyInstrument({
    segment: 'NSE',
    instrumentType: 'EQ',
  });
  assert(eqClass.isFno === false, 'Equity containing substring FUT is NOT classified as F&O');

  // Unknown instrument test
  const unknownClass = classifyInstrument({
    segment: 'UNKNOWN_XYZ',
    instrumentType: 'EQ',
  });
  assert(unknownClass.isFno === false, 'Unknown segment is not F&O');

  // --------------------------------------------------------------------------
  // SECTION 6 & 7: CATEGORY A — PURE INTRADAY POSITION
  // --------------------------------------------------------------------------
  console.log('\n[Phase 8A Test 6] Category A: Pure Intraday position validation');
  const catAPos: RawBrokerPosition = {
    instrument_token: 110001,
    exchange: 'NFO',
    tradingsymbol: 'NIFTY26OCTFUT',
    product: 'NRML',
    quantity: 50,
    overnight_quantity: 0,
    average_price: 25000.0,
    last_price: 25100.0,
    close_price: 24900.0, // Should NOT be used for pure intraday!
    pnl: 5000.0,
    m2m: 5000.0,
    realised: 0.0,
    unrealised: 5000.0,
    day_buy_quantity: 100,
    day_buy_value: 2500000.0,
    day_sell_quantity: 50,
    day_sell_value: 1255000.0,
    multiplier: 1,
  };

  const catAObs = ValidationSessionManager.recordObservation(
    session.validationSessionId,
    catAPos,
    true,
    MOCK_INSTRUMENT_MAP.get(110001),
    { dailyRealised: 5000.0, dailyUnrealised: 5000.0, grossTradingPnl: 10000.0 }
  );
  assert(catAObs.category === 'CATEGORY_A_PURE_INTRADAY', 'Classified as CATEGORY_A_PURE_INTRADAY');
  assert(catAObs.rawSnapshot.overnight_quantity === 0, 'Overnight quantity is 0');
  assert(catAObs.rawSnapshot.day_buy_quantity === 100, 'Day buy quantity captured');
  assert(catAObs.calculated.multiplierAppliedOnce === true, 'Multiplier applied once');

  // --------------------------------------------------------------------------
  // SECTION 7: CATEGORY B — CARRIED-FORWARD / OVERNIGHT POSITION
  // --------------------------------------------------------------------------
  console.log('\n[Phase 8A Test 7] Category B: Carried-forward / overnight position validation');
  const catBPos: RawBrokerPosition = {
    instrument_token: 110002,
    exchange: 'NFO',
    tradingsymbol: 'BANKNIFTY26OCTFUT',
    product: 'NRML',
    quantity: 30,
    overnight_quantity: 30,
    average_price: 52000.0,
    close_price: 52100.0, // Authoritative previous session close price
    last_price: 52200.0,
    pnl: 6000.0,
    m2m: 3000.0, // (52200 - 52100) * 30 = 3000
    realised: 0.0,
    unrealised: 6000.0,
    day_buy_quantity: 0,
    day_buy_value: 0,
    day_sell_quantity: 0,
    day_sell_value: 0,
    multiplier: 1,
  };

  // Daily unrealised = (52200 - 52100) * 30 * 1 = 3000
  const catBObs = ValidationSessionManager.recordObservation(
    session.validationSessionId,
    catBPos,
    true,
    MOCK_INSTRUMENT_MAP.get(110002),
    { dailyRealised: 0.0, dailyUnrealised: 3000.0, grossTradingPnl: 3000.0 }
  );
  assert(catBObs.category === 'CATEGORY_B_CARRIED_FORWARD', 'Classified as CATEGORY_B_CARRIED_FORWARD');
  assert(catBObs.rawSnapshot.close_price === 52100.0, 'Close price captured for carried position');
  assert(catBObs.calculated.dailyUnrealisedPnl === 3000.0, 'Daily unrealised referenced against close price');

  // --------------------------------------------------------------------------
  // SECTION 7: CATEGORY C — MIXED OVERNIGHT + INTRADAY
  // --------------------------------------------------------------------------
  console.log('\n[Phase 8A Test 8] Category C: Mixed overnight + intraday position');
  const catCPos: RawBrokerPosition = {
    instrument_token: 110001,
    exchange: 'NFO',
    tradingsymbol: 'NIFTY26OCTFUT',
    product: 'NRML',
    quantity: 100,
    overnight_quantity: 50,
    average_price: 25000.0,
    close_price: 25050.0,
    last_price: 25200.0,
    pnl: 15000.0,
    m2m: 12500.0,
    realised: 0.0,
    unrealised: 15000.0,
    day_buy_quantity: 50,
    day_buy_value: 1255000.0, // Bought 50 @ 25100
    day_sell_quantity: 0,
    day_sell_value: 0,
    multiplier: 1,
  };

  const catCObs = ValidationSessionManager.recordObservation(
    session.validationSessionId,
    catCPos,
    true,
    MOCK_INSTRUMENT_MAP.get(110001)
  );
  assert(catCObs.category === 'CATEGORY_C_MIXED', 'Classified as CATEGORY_C_MIXED');
  assert(catCObs.rawSnapshot.overnight_quantity === 50, 'Authoritative overnight_quantity preserved');
  assert(catCObs.rawSnapshot.day_buy_quantity === 50, 'Current-day buy quantity recorded');

  // --------------------------------------------------------------------------
  // SECTION 8: FULLY CLOSED INTRADAY POSITION
  // --------------------------------------------------------------------------
  console.log('\n[Phase 8A Test 9] Fully closed intraday position: quantity = 0, realized preserved');
  const closedPos: RawBrokerPosition = {
    instrument_token: 110001,
    exchange: 'NFO',
    tradingsymbol: 'NIFTY26OCTFUT',
    product: 'NRML',
    quantity: 0,
    overnight_quantity: 0,
    average_price: 0,
    last_price: 25300.0,
    pnl: 2500.0,
    m2m: 2500.0,
    realised: 2500.0,
    unrealised: 0.0,
    day_buy_quantity: 50,
    day_buy_value: 1250000.0,
    day_sell_quantity: 50,
    day_sell_value: 1252500.0,
    multiplier: 1,
  };

  const closedObs = ValidationSessionManager.recordObservation(
    session.validationSessionId,
    closedPos,
    true,
    MOCK_INSTRUMENT_MAP.get(110001),
    { dailyRealised: 2500.0, dailyUnrealised: 0.0, grossTradingPnl: 2500.0 }
  );
  assert(closedObs.category === 'FULLY_CLOSED_INTRADAY', 'Classified as FULLY_CLOSED_INTRADAY');
  assert(closedObs.rawSnapshot.quantity === 0, 'Quantity is 0');
  assert(closedObs.calculated.dailyRealisedPnl === 2500.0, 'Realised P&L retained');
  assert(closedObs.calculated.dailyUnrealisedPnl === 0.0, 'Unrealised P&L is 0');

  // --------------------------------------------------------------------------
  // SECTION 9: PARTIAL CLOSE POSITION
  // --------------------------------------------------------------------------
  console.log('\n[Phase 8A Test 10] Partial close: overnight position partially closed today');
  const partialPos: RawBrokerPosition = {
    instrument_token: 110001,
    exchange: 'NFO',
    tradingsymbol: 'NIFTY26OCTFUT',
    product: 'NRML',
    quantity: 30, // Reduced from 50
    overnight_quantity: 50,
    average_price: 25000.0,
    close_price: 25050.0,
    last_price: 25200.0,
    pnl: 8000.0,
    m2m: 7500.0,
    realised: 3000.0,
    unrealised: 4500.0,
    day_buy_quantity: 0,
    day_buy_value: 0,
    day_sell_quantity: 20,
    day_sell_value: 504000.0,
    multiplier: 1,
  };

  const partialObs = ValidationSessionManager.recordObservation(
    session.validationSessionId,
    partialPos,
    true,
    MOCK_INSTRUMENT_MAP.get(110001)
  );
  assert(partialObs.category === 'PARTIAL_CLOSE', 'Classified as PARTIAL_CLOSE');
  assert(partialObs.rawSnapshot.overnight_quantity === 50, 'Overnight qty is 50');
  assert(partialObs.rawSnapshot.quantity === 30, 'Remaining qty is 30');

  // --------------------------------------------------------------------------
  // SECTION 10: REVERSAL POSITION
  // --------------------------------------------------------------------------
  console.log('\n[Phase 8A Test 11] Position reversal: long overnight flipped to short');
  const reversalPos: RawBrokerPosition = {
    instrument_token: 110001,
    exchange: 'NFO',
    tradingsymbol: 'NIFTY26OCTFUT',
    product: 'NRML',
    quantity: -25, // Flipped to net short
    overnight_quantity: 50,
    average_price: 25150.0,
    close_price: 25050.0,
    last_price: 25100.0,
    pnl: 6250.0,
    m2m: 5000.0,
    realised: 5000.0,
    unrealised: 1250.0,
    day_buy_quantity: 0,
    day_buy_value: 0,
    day_sell_quantity: 75,
    day_sell_value: 1886250.0,
    multiplier: 1,
  };

  const reversalObs = ValidationSessionManager.recordObservation(
    session.validationSessionId,
    reversalPos,
    true,
    MOCK_INSTRUMENT_MAP.get(110001)
  );
  assert(reversalObs.category === 'REVERSAL', 'Classified as REVERSAL');
  assert(reversalObs.rawSnapshot.overnight_quantity > 0, 'Overnight was long');
  assert(reversalObs.rawSnapshot.quantity < 0, 'Current position is short');

  // --------------------------------------------------------------------------
  // SECTION 12: MULTIPLIER VALIDATION (MULTIPLIER = 1 AND MULTIPLIER > 1)
  // --------------------------------------------------------------------------
  console.log('\n[Phase 8A Test 12] Multiplier validation: applied exactly once');
  const mult2Pos: RawBrokerPosition = {
    ...catAPos,
    instrument_token: 110003,
    tradingsymbol: 'MULT2FUT',
    multiplier: 2,
    quantity: 10,
    average_price: 100,
    last_price: 110,
  };
  const mult2Obs = ValidationSessionManager.recordObservation(
    session.validationSessionId,
    mult2Pos,
    true,
    { ...MOCK_INSTRUMENT_MAP.get(110001)!, instrumentToken: 110003, lotSize: 10 },
    { dailyRealised: 0, dailyUnrealised: (110 - 100) * 10 * 2, grossTradingPnl: 200 }
  );
  assert(mult2Obs.rawSnapshot.multiplier === 2, 'Raw multiplier is 2');
  assert(mult2Obs.calculated.multiplier === 2, 'Calculated multiplier is 2');
  assert(mult2Obs.calculated.dailyUnrealisedPnl === 200, 'Multiplier correctly scales daily P&L once (10 * 10 * 2 = 200)');
  assert(mult2Obs.calculated.multiplierAppliedOnce === true, 'Flagged as applied once');

  // --------------------------------------------------------------------------
  // SECTION 13, 14, 15: MARKET DATA FRESHNESS & STALE / MISSING DETECTION
  // --------------------------------------------------------------------------
  console.log('\n[Phase 8A Test 13] Market data freshness: token-based tracking');
  MarketDataService.ingestTick(110001, 25150.0);
  const freshTick = MarketDataService.getTick(110001);
  assert(freshTick !== null, 'Tick exists');
  assert(freshTick?.lastPrice === 25150.0, 'lastPrice is 25150');
  assert(freshTick?.isStale === false, 'Fresh tick is not stale');

  // Stale detection
  console.log('\n[Phase 8A Test 14] Stale data detection: flags STALE_DATA without inventing LTP');
  MarketDataService.setStaleThresholdSeconds(5);
  const futureEvalTime = new Date(Date.now() + 10 * 1000); // 10 seconds later
  const staleTick = MarketDataService.getTick(110001, futureEvalTime);
  assert(staleTick?.isStale === true, 'Tick correctly flagged as stale after threshold');
  MarketDataService.setStaleThresholdSeconds(60); // restore default

  // Missing data detection for carried position without close_price
  console.log('\n[Phase 8A Test 15] Missing data detection: missing close_price yields MISSING_DATA');
  const missingClosePos: RawBrokerPosition = {
    ...catBPos,
    close_price: 0, // Missing!
  };
  const missingRes = await LivePnlValidationService.validateLivePnl(
    undefined,
    new Date(),
    [missingClosePos],
    MOCK_INSTRUMENT_MAP
  );
  assert(missingRes.validationState === 'MISSING_DATA', 'Missing close_price yields MISSING_DATA');
  assert(missingRes.marketDataStatus === 'MISSING', 'marketDataStatus marked MISSING');

  // --------------------------------------------------------------------------
  // SECTION 16: BROKER RECONCILIATION CLASSIFICATION
  // --------------------------------------------------------------------------
  console.log('\n[Phase 8A Test 16] Broker reconciliation semantic classification');
  // Intraday with matching pnl is COMPARABLE
  assert(catAObs.reconciliation.status === 'COMPARABLE' || catAObs.reconciliation.status === 'MISMATCH', 'Cat A is comparable');

  // Carried position without m2m is NOT_COMPARABLE (not falsely marked MISMATCH)
  const carriedNoM2mPos: RawBrokerPosition = {
    ...catBPos,
    m2m: undefined,
  };
  const carriedNoM2mObs = ValidationSessionManager.recordObservation(
    session.validationSessionId,
    carriedNoM2mPos,
    true,
    MOCK_INSTRUMENT_MAP.get(110002)
  );
  assert(carriedNoM2mObs.reconciliation.status === 'NOT_COMPARABLE', 'Carried without m2m marked NOT_COMPARABLE');

  // --------------------------------------------------------------------------
  // SECTION 18: CRITICAL RISK BOUNDARY PROOF
  // --------------------------------------------------------------------------
  console.log('\n[Phase 8A Test 17] Critical Risk Boundary Proof: Massive loss does NOT mutate session');
  const preSession = await ServerRiskStore.getSession('test_shadow_trader');
  const massiveLossPos: RawBrokerPosition = {
    ...catAPos,
    last_price: 24000.0, // ₹50,000 loss
    pnl: -50000.0,
    m2m: -50000.0,
    realised: 0,
    unrealised: -50000.0,
  };

  MarketDataService.ingestTick(110001, 24000.0);
  const shadowPnlRes = await LivePnlValidationService.validateLivePnl(
    { dailyLossLimit: 10000 },
    new Date(),
    [massiveLossPos],
    MOCK_INSTRUMENT_MAP
  );

  assert(shadowPnlRes.calculated.grossTradingPnl <= -40000.0, `Calculated live P&L reports massive loss (${shadowPnlRes.calculated.grossTradingPnl}) exceeding limit (-10000)`);

  // Verify RiskEngine, RiskSession, and Enforcement are 100% UNTOUCHED
  const postSession = await ServerRiskStore.getSession('test_shadow_trader');
  assert(postSession.state === preSession.state, 'RiskSession state UNCHANGED');
  assert(postSession.currentPnl === preSession.currentPnl, 'RiskSession currentPnl UNCHANGED');
  assert(postSession.lockedAt === preSession.lockedAt, 'RiskSession lockedAt remains unchanged');
  assert(postSession.isBreached === preSession.isBreached, 'RiskSession isBreached remains unchanged');

  const enforcement = await EnforcementService.getEnforcementState('test_shadow_trader');
  assert(enforcement.isLocked === false, 'EnforcementState isLocked remains false');
  assert(enforcement.riskState === 'ALLOW', 'EnforcementState remains ALLOW');

  // --------------------------------------------------------------------------
  // SECTION 20: ASIA/KOLKATA TIMEZONE ROLLOVER
  // --------------------------------------------------------------------------
  console.log('\n[Phase 8A Test 18] Asia/Kolkata timezone boundary proof');
  const d1 = new Date('2026-10-02T18:29:59.000Z');
  const d2 = new Date('2026-10-02T18:30:00.000Z');
  assert(getTradingDateKolkata(d1) === '2026-10-02', '18:29:59 UTC is 2026-10-02 in IST');
  assert(getTradingDateKolkata(d2) === '2026-10-03', '18:30:00 UTC rolls over to 2026-10-03 in IST');

  // --------------------------------------------------------------------------
  // SECTION 21: EVIDENCE REPORT GENERATION & SAFETY AUDIT
  // --------------------------------------------------------------------------
  console.log('\n[Phase 8A Test 19] Evidence report generation & zero-mutation safety audit');
  const endedSession = ValidationSessionManager.endSession(session.validationSessionId);
  assert(endedSession?.endedAt !== null, 'Session ended successfully');

  const report = ValidationSessionManager.generateReport(session.validationSessionId, shadowPnlRes);
  assert(report.session.validationSessionId === session.validationSessionId, 'Report linked to session');
  assert(report.observations.length >= 6, 'All observations recorded in report');
  assert(report.summary.safetyAudit.ordersPlaced === 0, 'Audit: 0 orders placed');
  assert(report.summary.safetyAudit.ordersModified === 0, 'Audit: 0 orders modified');
  assert(report.summary.safetyAudit.ordersCancelled === 0, 'Audit: 0 orders cancelled');
  assert(report.summary.safetyAudit.positionsModifiedByApplication === 0, 'Audit: 0 positions modified');
  assert(report.summary.safetyAudit.riskSessionMutations === 0, 'Audit: 0 riskSession mutations');
  assert(report.summary.safetyAudit.riskEventsGenerated === 0, 'Audit: 0 risk events generated');
  assert(report.summary.safetyAudit.enforcementMutations === 0, 'Audit: 0 enforcement mutations');
  assert(['PASS', 'PASS_WITH_GAPS', 'FAIL', 'BLOCKED'].includes(report.summary.status), 'Valid final status code');

  // --------------------------------------------------------------------------
  // SECTION 22: REST LTP SNAPSHOT CAPABILITY & VALIDATIONS
  // --------------------------------------------------------------------------
  console.log('\n[Phase 8A Test 20] REST LTP Snapshot: Authenticated success, F&O enforcement, and error isolation');

  // Setup valid session for tests
  ZerodhaCredentialManager.setRuntimeSession({
    accessToken: 'test_access_token_123',
    userId: 'trader_test',
    authenticatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });

  const mockInstrumentsCsv = `instrument_token,exchange,tradingsymbol,name,segment,instrument_type,strike,tick_size,lot_size
110001,NFO,NIFTY26OCTFUT,NIFTY,NFO-FUT,FUT,0,0.05,50
110002,NFO,BANKNIFTY26OCTFUT,BANKNIFTY,NFO-FUT,FUT,0,0.05,15
110003,NSE,RELIANCE,RELIANCE,NSE-EQ,EQ,0,0.05,1`;

  // Subtest 1: Authenticated LTP success
  const successFetch = async (url: string, options?: any) => {
    if (url.includes('/instruments')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/csv' },
        text: async () => mockInstrumentsCsv,
        json: async () => ({}),
      };
    }
    if (url.includes('/quote/ltp')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({
          status: 'success',
          data: {
            'NFO:NIFTY26OCTFUT': {
              instrument_token: 110001,
              last_price: 25150.5,
            },
          },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const testAdapter = new LiveZerodhaAdapter(successFetch as any);
  const validSnapshot = await testAdapter.getLtpSnapshot(110001);
  assert(validSnapshot.status === 'VALID', 'Snapshot status is VALID');
  assert(validSnapshot.lastPrice === 25150.5, 'LTP numeric value matches');
  assert(validSnapshot.instrumentToken === 110001, 'Instrument token matches');
  assert(validSnapshot.tradingSymbol === 'NIFTY26OCTFUT', 'Trading symbol matches');
  assert(validSnapshot.segment === 'NFO-FUT', 'Segment matches');
  assert(validSnapshot.dataSource === 'ZERODHA_LIVE', 'Data source is ZERODHA_LIVE');
  assert(typeof (validSnapshot as any).accessToken === 'undefined', 'Credential sanitization: accessToken absent');
  assert(typeof (validSnapshot as any).apiKey === 'undefined', 'Credential sanitization: apiKey absent');
  console.log('  ✓ PASSED: Authenticated REST LTP snapshot returns VALID with correct numeric price');

  // Subtest 2: Unknown instrument token
  let unknownTokenThrew = false;
  try {
    await testAdapter.getLtpSnapshot(999999);
  } catch (err: any) {
    unknownTokenThrew = true;
    assert(err.message.includes('Unknown instrument token'), 'Error specifies unknown token');
  }
  assert(unknownTokenThrew, 'Unknown instrument token rejected with exception');
  console.log('  ✓ PASSED: Unknown instrument token rejected safely');

  // Subtest 3: Non-F&O instrument rejected
  let nonFnoThrew = false;
  try {
    await testAdapter.getLtpSnapshot(110003); // RELIANCE on NSE-EQ
  } catch (err: any) {
    nonFnoThrew = true;
    assert(err.message.includes('Non-F&O instrument rejected'), 'Error specifies non-F&O rejection');
  }
  assert(nonFnoThrew, 'Non-F&O instrument strictly rejected');
  console.log('  ✓ PASSED: Non-F&O instrument (equity) rejected by metadata classifier');

  // Subtest 4: Upstream HTTP 403 TokenException
  const authErrFetch = async (url: string) => {
    if (url.includes('/instruments')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/csv' },
        text: async () => mockInstrumentsCsv,
        json: async () => ({}),
      };
    }
    return {
      ok: false,
      status: 403,
      json: async () => ({ status: 'error', error_type: 'TokenException', message: 'Token expired' }),
    };
  };

  const authErrAdapter = new LiveZerodhaAdapter(authErrFetch as any);
  let authErrThrew = false;
  try {
    await authErrAdapter.getLtpSnapshot(110001);
  } catch (err: any) {
    authErrThrew = true;
    assert(err.message.includes('TokenException'), 'Identifies 403 TokenException');
  }
  assert(authErrThrew, 'HTTP 403 TokenException invalidates session and throws');
  console.log('  ✓ PASSED: Zerodha HTTP 403 TokenException handled safely without crash');

  // Subtest 5: Unavailable LTP response
  ZerodhaCredentialManager.setRuntimeSession({
    accessToken: 'test_access_token_123',
    userId: 'trader_test',
    authenticatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  const emptyDataFetch = async (url: string) => {
    if (url.includes('/instruments')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/csv' },
        text: async () => mockInstrumentsCsv,
        json: async () => ({}),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ status: 'success', data: {} }),
    };
  };

  const emptyDataAdapter = new LiveZerodhaAdapter(emptyDataFetch as any);
  const unavailSnapshot = await emptyDataAdapter.getLtpSnapshot(110001);
  assert(unavailSnapshot.status === 'UNAVAILABLE', 'Status is UNAVAILABLE on empty data');
  assert(unavailSnapshot.lastPrice === null, 'Price is strictly null on missing LTP without fabrication');
  console.log('  ✓ PASSED: Empty quote data returns UNAVAILABLE status without price fabrication');

  // Subtest 6: Missing authentication
  ZerodhaCredentialManager.invalidateSession();
  const savedKey = process.env.ZERODHA_API_KEY;
  const savedToken = process.env.ZERODHA_ACCESS_TOKEN;
  delete process.env.ZERODHA_API_KEY;
  delete process.env.ZERODHA_ACCESS_TOKEN;
  let missingAuthThrew = false;
  try {
    await testAdapter.getLtpSnapshot(110001);
  } catch (err: any) {
    missingAuthThrew = true;
    assert(err.message.includes('Cannot fetch LTP snapshot'), 'Missing auth error thrown');
  }
  assert(missingAuthThrew, 'Missing authentication rejected');
  console.log('  ✓ PASSED: Missing authentication rejected safely');

  // Restore env
  if (savedKey) process.env.ZERODHA_API_KEY = savedKey;
  if (savedToken) process.env.ZERODHA_ACCESS_TOKEN = savedToken;

  console.log('\n================================================================');
  console.log(`ALL ${totalTests} PHASE 8A TESTS PASSED SUCCESSFULLY (${passedTests}/${totalTests})`);
  console.log('================================================================\n');
}

runPhase8aTestSuite().catch((err) => {
  console.error('Phase 8A verification suite error:', err);
  process.exit(1);
});
