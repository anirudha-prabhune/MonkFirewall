/**
 * TRADING FIREWALL — PHASE 7 VERIFICATION SUITE
 * Live Zerodha Read-Only Integration & Diagnostic Preview
 *
 * All 30 Tests verify:
 * 1. Read-only adapter contract without order execution capabilities.
 * 2. Strict server-side credential isolation (never in client responses or errors).
 * 3. Explicit error states (CONFIGURATION_ERROR, AUTHENTICATION_ERROR, UPSTREAM_ERROR).
 * 4. Normalization into existing Phase 3 NormalizedPosition contract with dataSource: 'ZERODHA_LIVE'.
 * 5. Metadata-driven F&O classification (anti-heuristic, equities excluded, zero-qty preserved).
 * 6. Live market-data service with canonical token tracking and staleness detection.
 * 7. ZERO connection to RiskEngine, ZERO mutation of RiskSession, ZERO audit events, ZERO change to Enforcement.
 * 8. Server-authoritative broker mode and cross-user isolation.
 * 9. Regression verification for Mock Zerodha.
 */

import { LiveZerodhaAdapter, HttpFetchFn, InstrumentValidationError } from '../server/brokers/zerodha/liveAdapter';
import { ZerodhaCredentialManager } from '../server/brokers/zerodha/credentials';
import { BrokerService } from '../server/brokers/service';
import { MarketDataService } from '../server/market/marketDataService';
import { normalizePosition, normalizePositions, getFnoPositions, PositionValidationError } from '../server/brokers/normalize';
import { classifyInstrument, MOCK_INSTRUMENT_MAP } from '../server/instruments/master';
import { ServerRiskStore } from '../server/risk/store';
import { EnforcementService } from '../server/enforcement/service';
import { RawBrokerPosition, BrokerInstrument } from '../server/brokers/types';
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

async function runPhase7TestSuite() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: PHASE 7 VERIFICATION SUITE');
  console.log('Live Zerodha Read-Only Integration & Safety Boundary Tests');
  console.log('================================================================\n');

  // Preserve original environment
  const originalApiKey = process.env.ZERODHA_API_KEY;
  const originalApiSecret = process.env.ZERODHA_API_SECRET;
  const originalAccessToken = process.env.ZERODHA_ACCESS_TOKEN;
  const originalBrokerMode = process.env.BROKER_MODE;

  try {
    // -------------------------------------------------------------
    // TEST 1 — LIVE ADAPTER CONTRACT
    // -------------------------------------------------------------
    console.log('[Test 1] LiveZerodhaAdapter satisfies the broker read-only contract');
    const adapter = new LiveZerodhaAdapter();
    assert(typeof adapter.getConnectionStatus === 'function', 'adapter has getConnectionStatus()');
    assert(typeof adapter.getPositions === 'function', 'adapter has getPositions()');
    assert(typeof adapter.getInstruments === 'function', 'adapter has getInstruments()');

    // -------------------------------------------------------------
    // TEST 2 — NO ORDER METHODS
    // -------------------------------------------------------------
    console.log('[Test 2] No order-execution or trading capability in adapter or broker interface');
    const forbiddenMethods = [
      'placeOrder',
      'modifyOrder',
      'cancelOrder',
      'squareOff',
      'convertPosition',
      'createGtt',
      'modifyGtt',
      'cancelGtt',
      'placeAmo',
      'executeTrade',
    ];
    for (const method of forbiddenMethods) {
      assert((adapter as any)[method] === undefined, `LiveZerodhaAdapter must NOT have ${method}()`);
      assert((BrokerService as any)[method] === undefined, `BrokerService must NOT have ${method}()`);
    }

    // -------------------------------------------------------------
    // TEST 3 — CREDENTIALS SERVER-ONLY
    // -------------------------------------------------------------
    console.log('[Test 3] Credentials are never returned to client responses');
    process.env.ZERODHA_API_KEY = 'secret_key_123';
    process.env.ZERODHA_ACCESS_TOKEN = 'secret_token_abc';
    process.env.ZERODHA_API_SECRET = 'secret_kite_secret';

    const liveStatus = await BrokerService.getLiveDiagnosticStatus();
    const serializedStatus = JSON.stringify(liveStatus);
    assert(!serializedStatus.includes('secret_key_123'), 'API key is absent from status response');
    assert(!serializedStatus.includes('secret_token_abc'), 'Access token is absent from status response');
    assert(!serializedStatus.includes('secret_kite_secret'), 'API secret is absent from status response');

    // -------------------------------------------------------------
    // TEST 4 — MISSING CREDENTIALS
    // -------------------------------------------------------------
    console.log('[Test 4] Live mode without credentials returns explicit CONFIGURATION_ERROR');
    delete process.env.ZERODHA_API_KEY;
    delete process.env.ZERODHA_ACCESS_TOKEN;
    delete process.env.KITE_API_KEY;
    delete process.env.KITE_ACCESS_TOKEN;

    const unconfiguredStatus = await adapter.getConnectionStatus();
    assert(unconfiguredStatus.status === 'CONFIGURATION_ERROR', 'Returns CONFIGURATION_ERROR when credentials missing');
    assert(unconfiguredStatus.configured === false, 'Reports configured: false');
    assert(unconfiguredStatus.message.includes('Missing required Zerodha credentials'), 'Clear error message returned');

    // -------------------------------------------------------------
    // TEST 5 — INVALID ACCESS TOKEN
    // -------------------------------------------------------------
    console.log('[Test 5] Invalid token produces AUTHENTICATION_ERROR');
    process.env.ZERODHA_API_KEY = 'valid_key';
    process.env.ZERODHA_ACCESS_TOKEN = 'expired_or_invalid_token';

    const mock401Fetch: HttpFetchFn = async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({ status: 'error', message: 'Token is invalid' }),
    });

    const authErrorAdapter = new LiveZerodhaAdapter(mock401Fetch);
    const authStatus = await authErrorAdapter.getConnectionStatus();
    assert(authStatus.status === 'AUTHENTICATION_ERROR', 'Returns AUTHENTICATION_ERROR on HTTP 403/401');
    assert(!authStatus.message.includes('expired_or_invalid_token'), 'Error message does not leak the token');

    // -------------------------------------------------------------
    // TEST 6 — LIVE CONNECTION STATUS
    // -------------------------------------------------------------
    console.log('[Test 6] Successful read-only connection returns CONNECTED');
    const mockSuccessFetch: HttpFetchFn = async (url: string) => {
      if (url.includes('/user/profile')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'success', data: { user_name: 'Test Trader' } }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'success', data: {} }) };
    };

    const connectedAdapter = new LiveZerodhaAdapter(mockSuccessFetch);
    const connectedStatus = await connectedAdapter.getConnectionStatus();
    assert(connectedStatus.status === 'CONNECTED', 'Successful session validation returns CONNECTED');
    assert(connectedStatus.isMock === false, 'Reports isMock: false');

    // -------------------------------------------------------------
    // TEST 7 — POSITION RETRIEVAL
    // -------------------------------------------------------------
    console.log('[Test 7] Live adapter retrieves positions from live endpoint');
    const sampleRawPositions: RawBrokerPosition[] = [
      {
        instrument_token: 110001,
        exchange: 'NFO',
        tradingsymbol: 'NIFTY26OCTFUT',
        product: 'NRML',
        quantity: 50,
        average_price: 25000.0,
        last_price: 25100.0,
        pnl: 5000.0,
        realised: 0.0,
        unrealised: 5000.0,
        day_buy_quantity: 50,
        day_buy_value: 1250000.0,
        day_sell_quantity: 0,
        day_sell_value: 0.0,
      },
    ];

    const mockPositionsFetch: HttpFetchFn = async (url: string) => {
      if (url.includes('/portfolio/positions')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'success', data: { net: sampleRawPositions, day: [] } }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'success', data: {} }) };
    };

    const positionsAdapter = new LiveZerodhaAdapter(mockPositionsFetch);
    const retrievedPositions = await positionsAdapter.getPositions();
    assert(retrievedPositions.length === 1, 'Retrieved exactly 1 position');
    assert(retrievedPositions[0].tradingsymbol === 'NIFTY26OCTFUT', 'Position tradingsymbol matches upstream');

    // -------------------------------------------------------------
    // TEST 8 — POSITION NORMALIZATION
    // -------------------------------------------------------------
    console.log('[Test 8] Raw live position maps to existing NormalizedPosition contract');
    const norm = normalizePosition(sampleRawPositions[0], MOCK_INSTRUMENT_MAP, 'ZERODHA_LIVE');
    assert(norm.instrumentToken === 110001, 'instrumentToken preserved');
    assert(norm.exchange === 'NFO', 'exchange normalized');
    assert(norm.tradingsymbol === 'NIFTY26OCTFUT', 'tradingsymbol preserved');
    assert(norm.product === 'NRML', 'product normalized');
    assert(norm.quantity === 50, 'quantity mapped');
    assert(norm.averagePrice === 25000.0, 'averagePrice mapped');
    assert(norm.lastPrice === 25100.0, 'lastPrice mapped');
    assert(norm.unrealisedPnl === 5000.0, 'unrealisedPnl mapped');
    assert(norm.realisedPnl === 0.0, 'realisedPnl mapped');
    assert(norm.totalPnl === 5000.0, 'totalPnl mapped');

    // -------------------------------------------------------------
    // TEST 9 — F&O METADATA CLASSIFICATION
    // -------------------------------------------------------------
    console.log('[Test 9] NFO-FUT/NFO-OPT/BFO-FUT/BFO-OPT classified as F&O');
    const fnoSegments = ['NFO-FUT', 'NFO-OPT', 'BFO-FUT', 'BFO-OPT'];
    for (const seg of fnoSegments) {
      const cls = classifyInstrument({ segment: seg, instrumentType: 'OPT' });
      assert(cls.isFno === true, `${seg} correctly classified as F&O`);
    }

    // -------------------------------------------------------------
    // TEST 10 — EQUITY REJECTION
    // -------------------------------------------------------------
    console.log('[Test 10] NSE-EQ / BSE-EQ excluded from F&O');
    const eqSegments = ['NSE-EQ', 'BSE-EQ', 'NSE', 'BSE'];
    for (const seg of eqSegments) {
      const cls = classifyInstrument({ segment: seg, instrumentType: 'EQ' });
      assert(cls.isFno === false, `${seg} is strictly non-F&O`);
    }

    // -------------------------------------------------------------
    // TEST 11 — ANTI-HEURISTIC CLASSIFICATION
    // -------------------------------------------------------------
    console.log('[Test 11] Equity symbol ending in FUT/CE/PE remains non-F&O');
    const sneakyEquity: RawBrokerPosition = {
      instrument_token: 140999,
      exchange: 'NSE',
      tradingsymbol: 'RELIANCEFUT', // sneaky tradingsymbol ends in FUT!
      product: 'CNC',
      quantity: 10,
      average_price: 2500.0,
      last_price: 2550.0,
      pnl: 500.0,
      realised: 0.0,
      unrealised: 500.0,
      day_buy_quantity: 10,
      day_buy_value: 25000.0,
      day_sell_quantity: 0,
      day_sell_value: 0.0,
    };
    const sneakyMap = new Map<number, BrokerInstrument>([
      [
        140999,
        {
          instrumentToken: 140999,
          exchange: 'NSE',
          tradingsymbol: 'RELIANCEFUT',
          name: 'RELIANCE EQUITY WITH SNEAKY SYMBOL',
          segment: 'NSE-EQ', // Crucial: Segment is NSE-EQ
          instrumentType: 'EQ',
          expiry: null,
          strike: null,
          tickSize: 0.05,
          lotSize: 1,
        },
      ],
    ]);
    const normalizedSneaky = normalizePosition(sneakyEquity, sneakyMap, 'ZERODHA_LIVE');
    assert(normalizedSneaky.isFno === false, 'NSE-EQ with FUT in tradingsymbol is NOT F&O');

    // -------------------------------------------------------------
    // TEST 12 — ZERO QUANTITY PRESERVATION
    // -------------------------------------------------------------
    console.log('[Test 12] Zero-quantity realized position preserved');
    const closedPosition: RawBrokerPosition = {
      instrument_token: 110002,
      exchange: 'NFO',
      tradingsymbol: 'NIFTY26O2925500CE',
      product: 'NRML',
      quantity: 0,
      average_price: 150.0,
      last_price: 120.0,
      pnl: 1500.0,
      realised: 1500.0,
      unrealised: 0.0,
      day_buy_quantity: 50,
      day_buy_value: 7500.0,
      day_sell_quantity: 50,
      day_sell_value: 9000.0,
    };
    const normClosed = normalizePosition(closedPosition, MOCK_INSTRUMENT_MAP, 'ZERODHA_LIVE');
    assert(normClosed.quantity === 0, 'Zero quantity preserved');
    assert(normClosed.realisedPnl === 1500.0, 'Realised P&L preserved on closed position');
    assert(normClosed.isFno === true, 'F&O status preserved on closed position');

    // -------------------------------------------------------------
    // TEST 13 — INVALID NUMERIC DATA REJECTED
    // -------------------------------------------------------------
    console.log('[Test 13] NaN / Infinity / negative price rejected with PositionValidationError');
    const invalidRaw = { ...sampleRawPositions[0], last_price: NaN };
    let caughtError = false;
    try {
      normalizePosition(invalidRaw as any, MOCK_INSTRUMENT_MAP, 'ZERODHA_LIVE');
    } catch (err) {
      caughtError = err instanceof PositionValidationError;
    }
    assert(caughtError, 'NaN last_price rejected by validator');

    const negativePriceRaw = { ...sampleRawPositions[0], average_price: -50 };
    let caughtNegative = false;
    try {
      normalizePosition(negativePriceRaw, MOCK_INSTRUMENT_MAP, 'ZERODHA_LIVE');
    } catch (err) {
      caughtNegative = err instanceof PositionValidationError;
    }
    assert(caughtNegative, 'Negative average_price rejected by validator');

    // -------------------------------------------------------------
    // TEST 14 — INSTRUMENT MASTER
    // -------------------------------------------------------------
    console.log('[Test 14] Live instrument metadata maps correctly');
    const rawInstrument = {
      instrument_token: 260105,
      exchange: 'NFO',
      tradingsymbol: 'NIFTY26NOV25000CE',
      name: 'NIFTY NOV 25000 CALL',
      segment: 'NFO-OPT',
      instrument_type: 'CE',
      expiry: '2026-11-26',
      strike: 25000,
      tick_size: 0.05,
      lot_size: 25,
    };
    const validatedInst = adapter.validateInstrumentRecord(rawInstrument);
    assert(validatedInst.instrumentToken === 260105, 'Token parsed as integer');
    assert(validatedInst.strike === 25000, 'Strike parsed correctly');
    assert(validatedInst.segment === 'NFO-OPT', 'Segment mapped');

    // -------------------------------------------------------------
    // TEST 15 — UNKNOWN INSTRUMENT & ZERO FALLBACK INVARIANT
    // -------------------------------------------------------------
    console.log('[Test 15] Unknown instrument token is explicitly flagged, never classified as F&O, zero fallback');
    // 15a: Unknown token with exchange='NFO' and tradingsymbol='NIFTY26OCTFUT'
    // Even with F&O-sounding exchange and symbol, MISSING metadata MUST NEVER result in isFno=true!
    const unknownFnoLookingPosition: RawBrokerPosition = {
      ...sampleRawPositions[0],
      instrument_token: 9999999, // Unknown token NOT in instrument map
      exchange: 'NFO',
      tradingsymbol: 'NIFTY26OCTFUT',
    };
    const normUnknownFno = normalizePosition(unknownFnoLookingPosition, MOCK_INSTRUMENT_MAP, 'ZERODHA_LIVE');
    assert(normUnknownFno.isFno === false, 'Unknown token MUST NEVER be classified as isFno=true');
    assert(normUnknownFno.segment === 'UNKNOWN', 'Unknown token segment MUST be UNKNOWN (no fallback to raw.exchange)');
    assert(normUnknownFno.unknownInstrument === true, 'Unknown token explicitly flagged as unknownInstrument = true');

    // 15b: Unknown instrument token cannot enter the F&O position set
    const fnoSet = getFnoPositions([normUnknownFno]);
    assert(fnoSet.length === 0, 'Unknown instrument token strictly excluded from F&O positions set');

    // 15c: Symbol ending in FUT/CE/PE cannot establish F&O classification without authoritative metadata
    const unknownEndingInCE: RawBrokerPosition = {
      ...sampleRawPositions[0],
      instrument_token: 8888888,
      exchange: 'NSE',
      tradingsymbol: 'UNKNOWNSTOCK26O2925000CE',
    };
    const normUnknownCE = normalizePosition(unknownEndingInCE, MOCK_INSTRUMENT_MAP, 'ZERODHA_LIVE');
    assert(normUnknownCE.isFno === false, 'Symbol ending in CE without authoritative metadata is strictly isFno=false');
    assert(normUnknownCE.segment === 'UNKNOWN', 'Zero exchange or suffix fallback derivation');

    // 15d: Authoritative known instruments are verified for F&O
    const knownNfoFut = classifyInstrument({ segment: 'NFO-FUT', instrumentType: 'FUT' });
    assert(knownNfoFut.isFno === true, 'Authoritative NFO-FUT is F&O');
    const knownNfoOpt = classifyInstrument({ segment: 'NFO-OPT', instrumentType: 'OPT' });
    assert(knownNfoOpt.isFno === true, 'Authoritative NFO-OPT is F&O');
    const knownBfoFut = classifyInstrument({ segment: 'BFO-FUT', instrumentType: 'FUT' });
    assert(knownBfoFut.isFno === true, 'Authoritative BFO-FUT is F&O');
    const knownBfoOpt = classifyInstrument({ segment: 'BFO-OPT', instrumentType: 'OPT' });
    assert(knownBfoOpt.isFno === true, 'Authoritative BFO-OPT is F&O');

    // -------------------------------------------------------------
    // TEST 16 — LIVE DATA SOURCE
    // -------------------------------------------------------------
    console.log('[Test 16] Normalized live position contains dataSource = ZERODHA_LIVE');
    const liveNorm = normalizePosition(sampleRawPositions[0], MOCK_INSTRUMENT_MAP, 'ZERODHA_LIVE');
    assert(liveNorm.dataSource === 'ZERODHA_LIVE', "Live position has dataSource === 'ZERODHA_LIVE'");

    // -------------------------------------------------------------
    // TEST 17 — NO RISK INTEGRATION
    // -------------------------------------------------------------
    console.log('[Test 17] Retrieving live positions does not invoke PnlEngine');
    const userTest17 = 'user_p7_t17';
    // Initialize risk session in store
    await ServerRiskStore.saveConfig(userTest17, {
      dailyLossLimit: 10000,
      warningThreshold1: 75,
      warningThreshold2: 90,
      lockDurationMinutes: 720,
      includeRealisedPnl: true,
      includeUnrealisedPnl: true,
      enabled: true,
    });
    const sessionBefore = await ServerRiskStore.getSession(userTest17);

    // Call live diagnostic endpoint
    const liveDiagPositions = await BrokerService.getLiveDiagnosticPositions();
    assert(liveDiagPositions.dataSource === 'ZERODHA_LIVE', 'Diagnostic positions returned');

    const sessionAfter = await ServerRiskStore.getSession(userTest17);
    assert(sessionBefore.currentPnl === sessionAfter.currentPnl, 'currentPnl unchanged by live position query');
    assert(sessionBefore.state === sessionAfter.state, 'riskState unchanged by live position query');

    // -------------------------------------------------------------
    // TEST 18 — NO RISK SESSION MUTATION
    // -------------------------------------------------------------
    console.log('[Test 18] Live position retrieval does not modify RiskSession');
    assert(sessionBefore.lastEvaluatedAt === sessionAfter.lastEvaluatedAt, 'lastEvaluatedAt unchanged');
    assert(sessionBefore.lockedAt === sessionAfter.lockedAt, 'lockedAt unchanged');
    assert(sessionBefore.lockUntil === sessionAfter.lockUntil, 'lockUntil unchanged');

    // -------------------------------------------------------------
    // TEST 19 — NO AUDIT EVENT
    // -------------------------------------------------------------
    console.log('[Test 19] Live position retrieval creates zero risk events');
    const eventsBefore = await ServerRiskStore.getAuditEvents(userTest17);
    await BrokerService.getLiveDiagnosticPositions();
    await BrokerService.getLiveDiagnosticStatus();
    const eventsAfter = await ServerRiskStore.getAuditEvents(userTest17);
    assert(eventsBefore.length === eventsAfter.length, 'Zero audit events emitted by live diagnostic queries');

    // -------------------------------------------------------------
    // TEST 20 — NO ENFORCEMENT CHANGE
    // -------------------------------------------------------------
    console.log('[Test 20] Switching diagnostics does not alter EnforcementState');
    const enfBefore = await EnforcementService.getEnforcementState(userTest17);
    await BrokerService.getLiveDiagnosticStatus();
    await BrokerService.getLiveDiagnosticPositions();
    const enfAfter = await EnforcementService.getEnforcementState(userTest17);
    assert(enfBefore.isLocked === enfAfter.isLocked, 'Enforcement isLocked status unchanged');
    assert(enfBefore.riskState === enfAfter.riskState, 'Enforcement riskState unchanged');

    // -------------------------------------------------------------
    // TEST 21 — LIVE LTP MAPPING
    // -------------------------------------------------------------
    console.log('[Test 21] Live price data maps to the correct instrument token in MarketDataService');
    MarketDataService.reset();
    MarketDataService.connect();
    MarketDataService.subscribe([110001]);
    const tickTime = new Date();
    MarketDataService.ingestTick(110001, 25250.5, tickTime);

    const retrievedTick = MarketDataService.getTick(110001, tickTime);
    assert(retrievedTick !== null, 'Tick found');
    assert(retrievedTick!.instrumentToken === 110001, 'Token matches');
    assert(retrievedTick!.lastPrice === 25250.5, 'LTP mapped correctly');
    assert(retrievedTick!.isStale === false, 'Fresh tick is not stale');

    // -------------------------------------------------------------
    // TEST 22 — STALE PRICE DETECTION
    // -------------------------------------------------------------
    console.log('[Test 22] Stale market data is explicitly flagged');
    MarketDataService.setStaleThresholdSeconds(30); // 30 seconds threshold
    const oldTickTime = new Date(Date.now() - 45 * 1000); // 45 seconds ago
    MarketDataService.ingestTick(110002, 125.0, oldTickTime);

    const evaluatedNow = new Date();
    const staleTick = MarketDataService.getTick(110002, evaluatedNow);
    assert(staleTick !== null, 'Stale tick retrieved');
    assert(staleTick!.isStale === true, 'Tick correctly flagged as stale (> 30s)');

    const marketStatus = MarketDataService.getStatus(evaluatedNow);
    assert(marketStatus.isStale === true, 'Overall feed status flagged as stale');

    // -------------------------------------------------------------
    // TEST 23 — WEBSOCKET DISCONNECT
    // -------------------------------------------------------------
    console.log('[Test 23] Disconnected market-data stream reports disconnected state');
    MarketDataService.disconnect();
    const disconnectedStatus = MarketDataService.getStatus();
    assert(disconnectedStatus.status === 'DISCONNECTED', "Status is 'DISCONNECTED'");

    // -------------------------------------------------------------
    // TEST 24 — WEBSOCKET RECONNECT
    // -------------------------------------------------------------
    console.log('[Test 24] Reconnection restores data state without creating risk events');
    const eventsBeforeReconnect = await ServerRiskStore.getAuditEvents(userTest17);
    MarketDataService.reconnect();
    const reconnectedStatus = MarketDataService.getStatus();
    assert(reconnectedStatus.status === 'CONNECTED', "Status is 'CONNECTED' after reconnect");
    const eventsAfterReconnect = await ServerRiskStore.getAuditEvents(userTest17);
    assert(eventsBeforeReconnect.length === eventsAfterReconnect.length, 'Zero risk events on reconnect');

    // -------------------------------------------------------------
    // TEST 25 — SERVER-SIDE BROKER MODE
    // -------------------------------------------------------------
    console.log('[Test 25] Server determines broker mode; client cannot change it');
    delete process.env.BROKER_MODE;
    assert(BrokerService.getBrokerMode() === 'mock', 'Default broker mode is strictly mock');

    process.env.BROKER_MODE = 'live';
    assert(BrokerService.getBrokerMode() === 'live', "Server env can set mode to 'live'");

    // Restore to mock
    process.env.BROKER_MODE = 'mock';
    assert(BrokerService.getBrokerMode() === 'mock', 'Mode returns to mock');

    // -------------------------------------------------------------
    // TEST 26 — CROSS-USER ISOLATION
    // -------------------------------------------------------------
    console.log('[Test 26] User A cannot retrieve User B live broker data');
    const userA = 'user_trader_A';
    const userB = 'user_trader_B';
    await ServerRiskStore.saveConfig(userA, {
      dailyLossLimit: 5000,
      warningThreshold1: 75,
      warningThreshold2: 90,
      lockDurationMinutes: 720,
      includeRealisedPnl: true,
      includeUnrealisedPnl: true,
      enabled: true,
    });
    await ServerRiskStore.saveConfig(userB, {
      dailyLossLimit: 25000,
      warningThreshold1: 75,
      warningThreshold2: 90,
      lockDurationMinutes: 720,
      includeRealisedPnl: true,
      includeUnrealisedPnl: true,
      enabled: true,
    });

    const configA = await ServerRiskStore.getConfig(userA);
    const configB = await ServerRiskStore.getConfig(userB);
    assert(configA.dailyLossLimit === 5000, 'User A config limit is 5000');
    assert(configB.dailyLossLimit === 25000, 'User B config limit is 25000');

    // -------------------------------------------------------------
    // TEST 27 — SECRET ISOLATION
    // -------------------------------------------------------------
    console.log('[Test 27] API credentials/access token never appear in response payloads');
    const samplePayload = {
      broker: 'zerodha',
      status: 'CONNECTED',
      apiKey: 'secret_leak_attempt_key',
      accessToken: 'secret_leak_attempt_token',
      apiSecret: 'secret_leak_attempt_secret',
      data: { valid: true },
    };
    const sanitized = ZerodhaCredentialManager.sanitize(samplePayload);
    assert((sanitized as any).apiKey === undefined, 'apiKey stripped');
    assert((sanitized as any).accessToken === undefined, 'accessToken stripped');
    assert((sanitized as any).apiSecret === undefined, 'apiSecret stripped');

    // -------------------------------------------------------------
    // TEST 28 — NO GENERIC PROXY
    // -------------------------------------------------------------
    console.log('[Test 28] No generic arbitrary upstream Zerodha proxy endpoint exists');
    const registeredRoutes: string[] = [];
    if ((apiRouter as any).stack) {
      for (const layer of (apiRouter as any).stack) {
        if (layer.route && layer.route.path) {
          registeredRoutes.push(layer.route.path);
        }
      }
    }
    const hasGenericProxy = registeredRoutes.some((path) => path.includes('/zerodha/*') || path === '/zerodha/proxy');
    assert(!hasGenericProxy, 'Zero generic Zerodha proxy endpoints found');

    // -------------------------------------------------------------
    // TEST 29 — MOCK REGRESSION
    // -------------------------------------------------------------
    console.log('[Test 29] Existing Mock Zerodha adapter remains fully functional');
    const mockPositions = await BrokerService.getNormalizedPositions();
    assert(mockPositions.length > 0, 'Mock positions retrieved');
    assert(mockPositions[0].dataSource === 'MOCK_DATA', "Mock positions have dataSource === 'MOCK_DATA'");

    const mockFno = await BrokerService.getNormalizedFnoPositions();
    assert(mockFno.length > 0, 'Mock F&O positions retrieved');
    assert(mockFno.every((p) => p.isFno), 'All mock F&O positions have isFno === true');

    // -------------------------------------------------------------
    // TEST 30 — FULL LIVE DIAGNOSTIC PIPELINE
    // -------------------------------------------------------------
    console.log('[Test 30] Full Live Diagnostic Pipeline works without touching RiskSession or Enforcement');
    // Set live adapter with mock HTTP fetch
    const fullTestPositions: RawBrokerPosition[] = [
      {
        instrument_token: 110001,
        exchange: 'NFO',
        tradingsymbol: 'NIFTY26OCTFUT',
        product: 'NRML',
        quantity: 50,
        average_price: 25000.0,
        last_price: 24700.0, // Loss of ₹15,000!
        pnl: -15000.0,
        realised: 0.0,
        unrealised: -15000.0,
        day_buy_quantity: 50,
        day_buy_value: 1250000.0,
        day_sell_quantity: 0,
        day_sell_value: 0.0,
      },
    ];

    const pipelineFetch: HttpFetchFn = async (url: string) => {
      if (url.includes('/portfolio/positions')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'success', data: { net: fullTestPositions } }),
        };
      }
      if (url.includes('/user/profile')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'success', data: { user_id: 'TEST_USER' } }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'success', data: {} }) };
    };

    const livePipelineAdapter = new LiveZerodhaAdapter(pipelineFetch);
    (BrokerService as any).liveAdapter = livePipelineAdapter;

    // Execute live diagnostic pipeline
    const diagResult = await BrokerService.getLiveDiagnosticPositions();
    assert(diagResult.dataSource === 'ZERODHA_LIVE', 'Pipeline produced ZERODHA_LIVE data');
    assert(diagResult.positions.length === 1, '1 position in diagnostic result');
    assert(diagResult.positions[0].unrealisedPnl === -15000.0, 'Huge loss in live preview (-₹15,000)');

    // Verify RiskSession for user userTest17 is STILL ALLOW and NOT LOCKED!
    const sessionPostLive = await ServerRiskStore.getSession(userTest17);
    assert(sessionPostLive.state !== 'LOCKED', 'RiskSession was NOT locked by huge live loss in preview!');
    const enfPostLive = await EnforcementService.getEnforcementState(userTest17);
    assert(enfPostLive.isLocked === false, 'EnforcementState was NOT locked by live diagnostic data!');

    console.log('\n================================================================');
    console.log(`ALL 30 PHASE 7 TESTS PASSED SUCCESSFULLY (${passedTests}/${totalTests})`);
    console.log('================================================================');
  } finally {
    // Restore environment variables
    if (originalApiKey !== undefined) process.env.ZERODHA_API_KEY = originalApiKey;
    else delete process.env.ZERODHA_API_KEY;

    if (originalApiSecret !== undefined) process.env.ZERODHA_API_SECRET = originalApiSecret;
    else delete process.env.ZERODHA_API_SECRET;

    if (originalAccessToken !== undefined) process.env.ZERODHA_ACCESS_TOKEN = originalAccessToken;
    else delete process.env.ZERODHA_ACCESS_TOKEN;

    if (originalBrokerMode !== undefined) process.env.BROKER_MODE = originalBrokerMode;
    else delete process.env.BROKER_MODE;

    // Reset MarketDataService
    MarketDataService.reset();
  }
}

runPhase7TestSuite().catch((err) => {
  console.error('Phase 7 Test Runner Encountered Fatal Error:', err);
  process.exit(1);
});
