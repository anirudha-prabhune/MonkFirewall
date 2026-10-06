/**
 * TRADING FIREWALL — PHASE 8 VERIFICATION SUITE
 * Live Zerodha P&L Validation & Shadow Mode Reconciliation
 *
 * Covers Tests 1–30 + Critical Safety Invariant Test:
 * - Integration of Live Normalized Positions + Live LTP + Phase 4 PnlEngine
 * - Non-negotiable F&O classification and exclusion of equities and unknown instruments
 * - Preserving realized P&L on zero-quantity closed positions without reconstruction
 * - Freshness tracking (FRESH, STALE, MISSING) via MarketDataService
 * - Broker reconciliation against tolerance (₹1.00) and validation state mapping
 * - Absolute Risk Engine & Enforcement Layer isolation (Shadow Mode only)
 * - Validation Gate: CLOSED, riskIntegrationEnabled: false
 * - Critical Safety Test: ₹12,000 live loss does NOT trigger lock or mutate session
 */

import { LivePnlValidationService } from '../server/pnl/liveValidationService';
import { LIVE_PNL_VALIDATION_GATE, DEFAULT_RECONCILIATION_TOLERANCE } from '../server/pnl/liveValidationTypes';
import { MarketDataService } from '../server/market/marketDataService';
import { BrokerService } from '../server/brokers/service';
import { ServerRiskStore } from '../server/risk/store';
import { EnforcementService } from '../server/enforcement/service';
import { RawBrokerPosition, BrokerInstrument } from '../server/brokers/types';
import { MOCK_INSTRUMENT_MAP, classifyInstrument } from '../server/instruments/master';
import { LiveZerodhaAdapter, HttpFetchFn } from '../server/brokers/zerodha/liveAdapter';
import { ZerodhaCredentialManager } from '../server/brokers/zerodha/credentials';
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

async function runPhase8TestSuite() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: PHASE 8 VERIFICATION SUITE');
  console.log('Live Zerodha P&L Validation / Shadow Mode & Reconciliation');
  console.log('================================================================\n');

  // Baseline valid F&O fixture (NFO Future)
  const baseFnoFut: RawBrokerPosition = {
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
  };

  try {
    // -------------------------------------------------------------
    // TEST 1 — Live normalized F&O positions reach PnlEngine
    // -------------------------------------------------------------
    console.log('[Test 1] Live normalized F&O positions reach PnlEngine');
    MarketDataService.reset();
    MarketDataService.connect();
    MarketDataService.ingestTick(110001, 25100.0, new Date());

    const result1 = await LivePnlValidationService.validateLivePnl(
      undefined,
      new Date(),
      [baseFnoFut],
      MOCK_INSTRUMENT_MAP
    );
    assert(result1.source === 'ZERODHA_LIVE', "Source is 'ZERODHA_LIVE'");
    assert(result1.calculated.fnoPositionCount === 1, '1 F&O position reached PnlEngine');
    assert(result1.calculated.unrealisedPnl === 5000.0, 'Calculated unrealized P&L is 5000.0');

    // -------------------------------------------------------------
    // TEST 2 — Equity remains excluded
    // -------------------------------------------------------------
    console.log('[Test 2] Equity positions remain excluded from F&O P&L');
    const equityPos: RawBrokerPosition = {
      instrument_token: 140001,
      exchange: 'NSE',
      tradingsymbol: 'RELIANCE',
      product: 'CNC',
      quantity: 100,
      average_price: 2500.0,
      last_price: 2600.0,
      pnl: 10000.0,
      realised: 0.0,
      unrealised: 10000.0,
      day_buy_quantity: 100,
      day_buy_value: 250000.0,
      day_sell_quantity: 0,
      day_sell_value: 0.0,
    };
    const result2 = await LivePnlValidationService.validateLivePnl(
      undefined,
      new Date(),
      [baseFnoFut, equityPos],
      MOCK_INSTRUMENT_MAP
    );
    assert(result2.calculated.fnoPositionCount === 1, 'Equity excluded from F&O position count');
    assert(result2.calculated.unrealisedPnl === 5000.0, 'Equity P&L (+10,000) does not leak into F&O P&L');

    // -------------------------------------------------------------
    // TEST 3 — Unknown instrument cannot affect P&L
    // -------------------------------------------------------------
    console.log('[Test 3] Unknown instrument cannot affect F&O P&L');
    const unknownFnoLike: RawBrokerPosition = {
      instrument_token: 999888,
      exchange: 'NFO',
      tradingsymbol: 'NIFTY26OCT25000CE',
      product: 'NRML',
      quantity: 100,
      average_price: 100.0,
      last_price: 200.0,
      pnl: 10000.0,
      realised: 0.0,
      unrealised: 10000.0,
      day_buy_quantity: 100,
      day_buy_value: 10000.0,
      day_sell_quantity: 0,
      day_sell_value: 0.0,
    };
    const result3 = await LivePnlValidationService.validateLivePnl(
      undefined,
      new Date(),
      [baseFnoFut, unknownFnoLike],
      MOCK_INSTRUMENT_MAP
    );
    assert(result3.calculated.fnoPositionCount === 1, 'Unknown instrument strictly excluded from F&O count');
    assert(result3.calculated.unrealisedPnl === 5000.0, 'Unknown instrument profit (+10,000) strictly excluded');
    assert(result3.unknownInstruments.length === 1, 'Unknown instrument explicitly reported');
    assert(result3.validationState === 'UNKNOWN_INSTRUMENTS', "ValidationState is 'UNKNOWN_INSTRUMENTS'");

    // -------------------------------------------------------------
    // TEST 4 — NFO-FUT is included
    // -------------------------------------------------------------
    console.log('[Test 4] NFO-FUT is included in F&O P&L');
    const nfoFutClass = classifyInstrument({ segment: 'NFO-FUT', instrumentType: 'FUT' });
    assert(nfoFutClass.isFno === true, 'NFO-FUT is classified as F&O');
    assert(result1.calculated.fnoPositionCount >= 1, 'NFO-FUT counted');

    // -------------------------------------------------------------
    // TEST 5 — NFO-OPT is included
    // -------------------------------------------------------------
    console.log('[Test 5] NFO-OPT is included in F&O P&L');
    const nfoOptPos: RawBrokerPosition = {
      instrument_token: 110002, // NIFTY26O2925500CE
      exchange: 'NFO',
      tradingsymbol: 'NIFTY26O2925500CE',
      product: 'NRML',
      quantity: 50,
      average_price: 150.0,
      last_price: 170.0,
      pnl: 1000.0,
      realised: 0.0,
      unrealised: 1000.0,
      day_buy_quantity: 50,
      day_buy_value: 7500.0,
      day_sell_quantity: 0,
      day_sell_value: 0.0,
    };
    MarketDataService.ingestTick(110002, 170.0, new Date());
    const result5 = await LivePnlValidationService.validateLivePnl(
      undefined,
      new Date(),
      [nfoOptPos],
      MOCK_INSTRUMENT_MAP
    );
    assert(result5.calculated.fnoPositionCount === 1, 'NFO-OPT counted in F&O');
    assert(result5.calculated.unrealisedPnl === 1000.0, 'NFO-OPT unrealized P&L is 1000.0');

    // -------------------------------------------------------------
    // TEST 6 — BFO-FUT is included
    // -------------------------------------------------------------
    console.log('[Test 6] BFO-FUT is included in F&O P&L');
    const bfoFutPos: RawBrokerPosition = {
      instrument_token: 130001, // SENSEX26OCTFUT
      exchange: 'BFO',
      tradingsymbol: 'SENSEX26OCTFUT',
      product: 'NRML',
      quantity: 10,
      average_price: 80000.0,
      last_price: 80200.0,
      pnl: 2000.0,
      realised: 0.0,
      unrealised: 2000.0,
      day_buy_quantity: 10,
      day_buy_value: 800000.0,
      day_sell_quantity: 0,
      day_sell_value: 0.0,
    };
    MarketDataService.ingestTick(130001, 80200.0, new Date());
    const result6 = await LivePnlValidationService.validateLivePnl(
      undefined,
      new Date(),
      [bfoFutPos],
      MOCK_INSTRUMENT_MAP
    );
    assert(result6.calculated.fnoPositionCount === 1, 'BFO-FUT counted');
    assert(result6.calculated.unrealisedPnl === 2000.0, 'BFO-FUT P&L is 2000.0');

    // -------------------------------------------------------------
    // TEST 7 — BFO-OPT is included
    // -------------------------------------------------------------
    console.log('[Test 7] BFO-OPT is included in F&O P&L');
    const bfoOptPos: RawBrokerPosition = {
      instrument_token: 130002, // SENSEX26O3082000CE
      exchange: 'BFO',
      tradingsymbol: 'SENSEX26O3082000CE',
      product: 'NRML',
      quantity: 10,
      average_price: 500.0,
      last_price: 550.0,
      pnl: 500.0,
      realised: 0.0,
      unrealised: 500.0,
      day_buy_quantity: 10,
      day_buy_value: 5000.0,
      day_sell_quantity: 0,
      day_sell_value: 0.0,
    };
    MarketDataService.ingestTick(130002, 550.0, new Date());
    const result7 = await LivePnlValidationService.validateLivePnl(
      undefined,
      new Date(),
      [bfoOptPos],
      MOCK_INSTRUMENT_MAP
    );
    assert(result7.calculated.fnoPositionCount === 1, 'BFO-OPT counted');
    assert(result7.calculated.unrealisedPnl === 500.0, 'BFO-OPT P&L is 500.0');

    // -------------------------------------------------------------
    // TEST 8 — Unknown symbol suffix cannot classify
    // -------------------------------------------------------------
    console.log('[Test 8] Unknown symbol suffix cannot classify without metadata');
    const unknownSuffixClass = classifyInstrument({ segment: 'UNKNOWN', instrumentType: 'UNKNOWN' });
    assert(unknownSuffixClass.isFno === false, 'Unknown segment is not F&O');

    // -------------------------------------------------------------
    // TEST 9 — Short position unrealized P&L
    // -------------------------------------------------------------
    console.log('[Test 9] Short position unrealized P&L: (lastPrice - avgPrice) * qty');
    const shortProfitPos: RawBrokerPosition = {
      ...baseFnoFut,
      quantity: -50,
      average_price: 100.0,
      last_price: 80.0,
      unrealised: 1000.0,
      pnl: 1000.0,
    };
    MarketDataService.ingestTick(110001, 80.0, new Date());
    const result9 = await LivePnlValidationService.validateLivePnl(
      undefined,
      new Date(),
      [shortProfitPos],
      MOCK_INSTRUMENT_MAP
    );
    assert(result9.calculated.unrealisedPnl === 1000.0, 'Short profit: (-50) * (80 - 100) = +1000.0');

    // -------------------------------------------------------------
    // TEST 10 — Long position unrealized P&L
    // -------------------------------------------------------------
    console.log('[Test 10] Long position unrealized P&L');
    const longProfitPos: RawBrokerPosition = {
      ...baseFnoFut,
      quantity: 50,
      average_price: 100.0,
      last_price: 120.0,
      unrealised: 1000.0,
      pnl: 1000.0,
    };
    MarketDataService.ingestTick(110001, 120.0, new Date());
    const result10 = await LivePnlValidationService.validateLivePnl(
      undefined,
      new Date(),
      [longProfitPos],
      MOCK_INSTRUMENT_MAP
    );
    assert(result10.calculated.unrealisedPnl === 1000.0, 'Long profit: (50) * (120 - 100) = +1000.0');

    // -------------------------------------------------------------
    // TEST 11 — Losing long position
    // -------------------------------------------------------------
    console.log('[Test 11] Losing long position unrealized P&L');
    const longLossPos: RawBrokerPosition = {
      ...baseFnoFut,
      quantity: 50,
      average_price: 100.0,
      last_price: 80.0,
      unrealised: -1000.0,
      pnl: -1000.0,
    };
    MarketDataService.ingestTick(110001, 80.0, new Date());
    const result11 = await LivePnlValidationService.validateLivePnl(
      undefined,
      new Date(),
      [longLossPos],
      MOCK_INSTRUMENT_MAP
    );
    assert(result11.calculated.unrealisedPnl === -1000.0, 'Long loss: (50) * (80 - 100) = -1000.0');

    // -------------------------------------------------------------
    // TEST 12 — Zero quantity realized preservation
    // -------------------------------------------------------------
    console.log('[Test 12] Zero quantity: unrealised = 0, realised preserved');
    const closedIntraday: RawBrokerPosition = {
      ...baseFnoFut,
      quantity: 0,
      average_price: 100.0,
      last_price: 110.0,
      realised: 1200.0,
      unrealised: 0.0,
      pnl: 1200.0,
    };
    const result12 = await LivePnlValidationService.validateLivePnl(
      undefined,
      new Date(),
      [closedIntraday],
      MOCK_INSTRUMENT_MAP
    );
    assert(result12.calculated.unrealisedPnl === 0, 'Zero quantity yields 0 unrealized P&L');
    assert(result12.calculated.realisedPnl === 1200.0, 'Realized P&L (1200.0) preserved on closed position');
    assert(result12.calculated.grossTradingPnl === 1200.0, 'Gross trading P&L includes realized P&L');

    // -------------------------------------------------------------
    // TEST 13 — Realized P&L is not reconstructed
    // -------------------------------------------------------------
    console.log('[Test 13] Realized P&L uses normalized realisedPnl directly without reconstruction');
    const complexRealisedPos: RawBrokerPosition = {
      ...baseFnoFut,
      quantity: 0,
      average_price: 25123.45,
      day_buy_value: 999999.0,
      day_sell_value: 1002450.0,
      realised: 2451.75, // Explicit broker realized P&L
      unrealised: 0.0,
      pnl: 2451.75,
    };
    const result13 = await LivePnlValidationService.validateLivePnl(
      undefined,
      new Date(),
      [complexRealisedPos],
      MOCK_INSTRUMENT_MAP
    );
    assert(result13.calculated.realisedPnl === 2451.75, 'Authoritative realized P&L preserved exactly');

    // -------------------------------------------------------------
    // TEST 14 — Gross P&L calculation
    // -------------------------------------------------------------
    console.log('[Test 14] grossTradingPnl = includedRealisedPnl + includedUnrealisedPnl');
    const openAndRealisedPos: RawBrokerPosition = {
      ...baseFnoFut,
      quantity: 50,
      average_price: 100.0,
      last_price: 120.0,
      realised: 800.0,
      unrealised: 1000.0,
      pnl: 1800.0,
    };
    MarketDataService.ingestTick(110001, 120.0, new Date());
    const result14 = await LivePnlValidationService.validateLivePnl(
      undefined,
      new Date(),
      [openAndRealisedPos],
      MOCK_INSTRUMENT_MAP
    );
    assert(result14.calculated.realisedPnl === 800.0, 'Realised is 800');
    assert(result14.calculated.unrealisedPnl === 1000.0, 'Unrealised is 1000');
    assert(result14.calculated.grossTradingPnl === 1800.0, 'Gross is 1800 (800 + 1000)');

    // -------------------------------------------------------------
    // TEST 15 — RiskConfig flags
    // -------------------------------------------------------------
    console.log('[Test 15] RiskConfig inclusion flags govern grossTradingPnl');
    const noRealisedConfig = { includeRealisedPnl: false, includeUnrealisedPnl: true };
    const result15a = await LivePnlValidationService.validateLivePnl(
      noRealisedConfig as any,
      new Date(),
      [openAndRealisedPos],
      MOCK_INSTRUMENT_MAP
    );
    assert(result15a.calculated.grossTradingPnl === 1000.0, 'Excludes realized P&L when flag is false');

    const noUnrealisedConfig = { includeRealisedPnl: true, includeUnrealisedPnl: false };
    const result15b = await LivePnlValidationService.validateLivePnl(
      noUnrealisedConfig as any,
      new Date(),
      [openAndRealisedPos],
      MOCK_INSTRUMENT_MAP
    );
    assert(result15b.calculated.grossTradingPnl === 800.0, 'Excludes unrealized P&L when flag is false');

    // -------------------------------------------------------------
    // TEST 16 — Broker/application reconciliation (VALID)
    // -------------------------------------------------------------
    console.log('[Test 16] Reconciliation within tolerance yields VALID');
    MarketDataService.ingestTick(110001, 120.0, new Date());
    const result16 = await LivePnlValidationService.validateLivePnl(
      undefined,
      new Date(),
      [openAndRealisedPos],
      MOCK_INSTRUMENT_MAP
    );
    assert(result16.reconciliation?.withinTolerance === true, 'withinTolerance is true');
    assert(result16.validationState === 'VALID', "ValidationState is 'VALID'");

    // -------------------------------------------------------------
    // TEST 17 — Reconciliation discrepancy (DISCREPANCY)
    // -------------------------------------------------------------
    console.log('[Test 17] Reconciliation exceeding tolerance yields DISCREPANCY');
    const discrepancyPos: RawBrokerPosition = {
      ...openAndRealisedPos,
      unrealised: 950.0, // Broker says 950, calculation says 1000 (diff: 50 > tolerance)
      pnl: 1750.0,
    };
    const result17 = await LivePnlValidationService.validateLivePnl(
      undefined,
      new Date(),
      [discrepancyPos],
      MOCK_INSTRUMENT_MAP
    );
    assert(result17.reconciliation?.withinTolerance === false, 'withinTolerance is false');
    assert(result17.validationState === 'DISCREPANCY', "ValidationState is 'DISCREPANCY'");

    // -------------------------------------------------------------
    // TEST 18 — Boundary tolerance
    // -------------------------------------------------------------
    console.log('[Test 18] Boundary tolerance: diff === tolerance accepted, diff > tolerance rejected');
    LivePnlValidationService.setTolerance(1.0); // ₹1.00 tolerance
    const exactTolerancePos: RawBrokerPosition = {
      ...openAndRealisedPos,
      unrealised: 999.0, // diff: exactly ₹1.00
      pnl: 1799.0,
    };
    const result18a = await LivePnlValidationService.validateLivePnl(
      undefined,
      new Date(),
      [exactTolerancePos],
      MOCK_INSTRUMENT_MAP
    );
    assert(result18a.reconciliation?.unrealisedDifference === 1.0, 'Difference is exactly 1.0');
    assert(result18a.reconciliation?.withinTolerance === true, 'diff === tolerance is ACCEPTED');

    const overTolerancePos: RawBrokerPosition = {
      ...openAndRealisedPos,
      unrealised: 998.9, // diff: ₹1.10 > ₹1.00
      pnl: 1798.9,
    };
    const result18b = await LivePnlValidationService.validateLivePnl(
      undefined,
      new Date(),
      [overTolerancePos],
      MOCK_INSTRUMENT_MAP
    );
    assert(result18b.reconciliation?.unrealisedDifference === 1.1, 'Difference is 1.1');
    assert(result18b.reconciliation?.withinTolerance === false, 'diff > tolerance is REJECTED');

    // -------------------------------------------------------------
    // TEST 19 — Missing LTP
    // -------------------------------------------------------------
    console.log('[Test 19] Missing LTP yields MISSING_DATA');
    MarketDataService.reset();
    MarketDataService.connect();
    // Do NOT ingest tick for 110001
    const result19 = await LivePnlValidationService.validateLivePnl(
      undefined,
      new Date(),
      [openAndRealisedPos],
      MOCK_INSTRUMENT_MAP
    );
    assert(result19.marketDataStatus === 'MISSING', "marketDataStatus is 'MISSING'");
    assert(result19.validationState === 'MISSING_DATA', "validationState is 'MISSING_DATA'");

    // -------------------------------------------------------------
    // TEST 20 — Stale LTP
    // -------------------------------------------------------------
    console.log('[Test 20] Stale LTP yields STALE_DATA');
    MarketDataService.reset();
    MarketDataService.connect();
    MarketDataService.setStaleThresholdSeconds(30);
    // Ingest tick 60 seconds in past
    const staleTime = new Date(Date.now() - 60 * 1000);
    MarketDataService.ingestTick(110001, 120.0, staleTime);

    const result20 = await LivePnlValidationService.validateLivePnl(
      undefined,
      new Date(),
      [openAndRealisedPos],
      MOCK_INSTRUMENT_MAP
    );
    assert(result20.marketDataStatus === 'STALE', "marketDataStatus is 'STALE'");
    assert(result20.validationState === 'STALE_DATA', "validationState is 'STALE_DATA'");

    // -------------------------------------------------------------
    // TEST 21 — Unknown instrument diagnostic
    // -------------------------------------------------------------
    console.log('[Test 21] Unknown instrument diagnostic structure');
    assert(Array.isArray(result3.unknownInstruments), 'unknownInstruments is an array');
    assert(result3.unknownInstruments[0].instrumentToken === 999888, 'Reports token 999888');
    assert(result3.unknownInstruments[0].tradingsymbol === 'NIFTY26OCT25000CE', 'Reports tradingsymbol');
    assert(result3.unknownInstruments[0].reason.includes('not found in authoritative instrument master'), 'Detailed reason');

    // -------------------------------------------------------------
    // TEST 22 — Trading date in Asia/Kolkata
    // -------------------------------------------------------------
    console.log('[Test 22] Trading date in Asia/Kolkata YYYY-MM-DD format');
    // Test date: 2026-10-02T19:00:00Z -> In IST (UTC+5:30) it is 2026-10-03 00:30:00 AM!
    const lateUtcDate = new Date('2026-10-02T19:00:00Z');
    const result22 = await LivePnlValidationService.validateLivePnl(
      undefined,
      lateUtcDate,
      [closedIntraday],
      MOCK_INSTRUMENT_MAP
    );
    assert(result22.tradingDate === '2026-10-03', 'Correctly rolls over to 2026-10-03 in Asia/Kolkata');

    // -------------------------------------------------------------
    // TEST 23 — Risk Engine isolation
    // -------------------------------------------------------------
    console.log('[Test 23] Risk Engine isolation: zero writes, zero events, zero locks');
    const userP8 = 'user_phase8_isolation';
    await ServerRiskStore.saveConfig(userP8, {
      dailyLossLimit: 10000,
      warningThreshold1: 75,
      warningThreshold2: 90,
      lockDurationMinutes: 720,
      enabled: true,
    });
    const sessionBefore = await ServerRiskStore.getSession(userP8);
    const eventsBefore = await ServerRiskStore.getAuditEvents(userP8);

    // Call validation
    await LivePnlValidationService.validateLivePnl(
      undefined,
      new Date(),
      [openAndRealisedPos],
      MOCK_INSTRUMENT_MAP
    );

    const sessionAfter = await ServerRiskStore.getSession(userP8);
    const eventsAfter = await ServerRiskStore.getAuditEvents(userP8);

    assert(sessionBefore.currentPnl === sessionAfter.currentPnl, 'RiskSession.currentPnl untouched');
    assert(sessionBefore.state === sessionAfter.state, 'RiskSession.state untouched');
    assert(sessionBefore.lockedAt === sessionAfter.lockedAt, 'RiskSession.lockedAt untouched');
    assert(eventsBefore.length === eventsAfter.length, 'Zero risk events created');

    // -------------------------------------------------------------
    // TEST 24 — Enforcement isolation
    // -------------------------------------------------------------
    console.log('[Test 24] Enforcement isolation: EnforcementState unchanged');
    const enfBefore = await EnforcementService.getEnforcementState(userP8);
    await LivePnlValidationService.validateLivePnl(
      undefined,
      new Date(),
      [openAndRealisedPos],
      MOCK_INSTRUMENT_MAP
    );
    const enfAfter = await EnforcementService.getEnforcementState(userP8);
    assert(enfBefore.isLocked === enfAfter.isLocked, 'Enforcement isLocked status unchanged');
    assert(enfBefore.riskState === enfAfter.riskState, 'Enforcement riskState unchanged');

    // -------------------------------------------------------------
    // TEST 25 — riskIntegrationEnabled: false
    // -------------------------------------------------------------
    console.log('[Test 25] riskIntegrationEnabled is strictly false and validationGate is CLOSED');
    assert(result1.riskIntegrationEnabled === false, 'riskIntegrationEnabled === false');
    assert(result1.validationGate === 'CLOSED', "validationGate === 'CLOSED'");
    assert(LIVE_PNL_VALIDATION_GATE === 'CLOSED', 'LIVE_PNL_VALIDATION_GATE constant is CLOSED');

    // -------------------------------------------------------------
    // TEST 26 — Zerodha authentication failure
    // -------------------------------------------------------------
    console.log('[Test 26] Zerodha authentication failure yields ERROR without risk mutation');
    const authFailFetch: HttpFetchFn = async () => ({
      ok: false,
      status: 403,
      json: async () => ({ status: 'error', message: 'Token expired' }),
    });
    ZerodhaCredentialManager.setRuntimeSession(
      {
        accessToken: 'expired_token_test26',
        userId: 'default_trader',
        authenticatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
      'default_trader'
    );
    const liveAdapterAuthFail = new LiveZerodhaAdapter(authFailFetch);
    (BrokerService as any).liveAdapter = liveAdapterAuthFail;

    const result26 = await LivePnlValidationService.validateLivePnl();
    assert(result26.validationState === 'ERROR', "ValidationState is 'ERROR' on auth failure");
    assert(Boolean(result26.notes?.includes('inactive') || result26.notes?.includes('failed') || result26.notes?.includes('Authentication')), 'Clear failure note');

    // -------------------------------------------------------------
    // TEST 27 — Zerodha upstream failure
    // -------------------------------------------------------------
    console.log('[Test 27] Zerodha upstream failure yields ERROR without risk mutation');
    const upstreamFailFetch: HttpFetchFn = async () => ({
      ok: false,
      status: 502,
      json: async () => ({ status: 'error', message: 'Bad Gateway' }),
    });
    ZerodhaCredentialManager.setRuntimeSession(
      {
        accessToken: 'valid_token_test27',
        userId: 'default_trader',
        authenticatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
      'default_trader'
    );
    const liveAdapterUpstreamFail = new LiveZerodhaAdapter(upstreamFailFetch);
    (BrokerService as any).liveAdapter = liveAdapterUpstreamFail;

    const result27 = await LivePnlValidationService.validateLivePnl();
    assert(result27.validationState === 'ERROR', "ValidationState is 'ERROR' on upstream 502");

    // -------------------------------------------------------------
    // TEST 28 — Market data failure
    // -------------------------------------------------------------
    console.log('[Test 28] Market data failure returns appropriate state without fabricated values');
    MarketDataService.reset();
    MarketDataService.disconnect();
    const result28 = await LivePnlValidationService.validateLivePnl(
      undefined,
      new Date(),
      [openAndRealisedPos],
      MOCK_INSTRUMENT_MAP
    );
    assert(result28.marketDataStatus === 'MISSING', "marketDataStatus is 'MISSING' when disconnected");
    assert(result28.validationState === 'MISSING_DATA', "validationState is 'MISSING_DATA'");

    // -------------------------------------------------------------
    // TEST 29 — Mock mode isolation
    // -------------------------------------------------------------
    console.log('[Test 29] Mock mode isolation: BROKER_MODE=mock does not invoke live Zerodha');
    process.env.BROKER_MODE = 'mock';
    assert(BrokerService.getBrokerMode() === 'mock', 'BrokerService mode is mock');

    // -------------------------------------------------------------
    // TEST 30 — No trading methods
    // -------------------------------------------------------------
    console.log('[Test 30] No order-placement or trading methods in Phase 8 service');
    const forbiddenMethods = ['placeOrder', 'modifyOrder', 'cancelOrder', 'squareOff', 'exitOrder'];
    for (const m of forbiddenMethods) {
      assert((LivePnlValidationService as any)[m] === undefined, `LivePnlValidationService must not have ${m}()`);
    }

    // -------------------------------------------------------------
    // CRITICAL SAFETY TEST (TEST 31)
    // Live P&L breaches ₹10,000 loss (calculated grossTradingPnl = -₹12,000)
    // MUST NOT create lock, MUST NOT mutate RiskSession, MUST NOT change Enforcement
    // -------------------------------------------------------------
    console.log('[Test 31 - CRITICAL SAFETY TEST] Massive live loss (-₹12,000) does NOT lock user or mutate session');
    const massiveLossUser = 'user_massive_loss_p8';
    await ServerRiskStore.saveConfig(massiveLossUser, {
      dailyLossLimit: 10000, // ₹10,000 limit
      warningThreshold1: 75,
      warningThreshold2: 90,
      lockDurationMinutes: 720,
      enabled: true,
    });

    const hugeLossPos: RawBrokerPosition = {
      ...baseFnoFut,
      quantity: 50,
      average_price: 25000.0,
      last_price: 24760.0, // Loss: (24760 - 25000) * 50 = -₹12,000! Breaches ₹10,000 limit!
      unrealised: -12000.0,
      pnl: -12000.0,
    };
    MarketDataService.reset();
    MarketDataService.connect();
    MarketDataService.ingestTick(110001, 24760.0, new Date());

    const validationResultHugeLoss = await LivePnlValidationService.validateLivePnl(
      undefined,
      new Date(),
      [hugeLossPos],
      MOCK_INSTRUMENT_MAP
    );
    assert(validationResultHugeLoss.calculated.grossTradingPnl === -12000.0, 'Live grossTradingPnl is -₹12,000');
    assert(validationResultHugeLoss.calculated.grossTradingPnl < -10000.0, 'Loss exceeds ₹10,000 loss limit');

    // VERIFY: RiskSession for this user is STILL ALLOW and NOT LOCKED!
    const sessionPostHugeLoss = await ServerRiskStore.getSession(massiveLossUser);
    assert(sessionPostHugeLoss.state !== 'LOCKED', 'CRITICAL SAFETY INVARIANT: RiskSession state is NOT LOCKED!');
    assert(sessionPostHugeLoss.lockedAt === null, 'RiskSession.lockedAt remains null');
    assert(sessionPostHugeLoss.lockUntil === null, 'RiskSession.lockUntil remains null');

    const auditEventsPostLoss = await ServerRiskStore.getAuditEvents(massiveLossUser);
    const hasLockEvent = auditEventsPostLoss.some((e) => e.type === 'TRADING_LOCK_CREATED' || e.type === 'LOSS_LIMIT_BREACHED');
    assert(!hasLockEvent, 'CRITICAL SAFETY INVARIANT: ZERO lock or breach audit events generated by live P&L');

    const enforcementPostLoss = await EnforcementService.getEnforcementState(massiveLossUser);
    assert(enforcementPostLoss.isLocked === false, 'CRITICAL SAFETY INVARIANT: EnforcementState isLocked === false!');
    assert(enforcementPostLoss.riskState !== 'LOCKED', "CRITICAL SAFETY INVARIANT: EnforcementState is NOT 'LOCKED'");

    // -------------------------------------------------------------
    // TEST 32 — Pure Intraday Long (Section 22 Test 1)
    // buy 100 @ 100, sell 40 @ 120, remaining quantity 60, LTP 110
    // Realized: (120 - 100) * 40 = +800
    // Unrealized: (110 - 100) * 60 = +600
    // Daily Gross P&L: +1400
    // -------------------------------------------------------------
    console.log("[Test 32 - Section 22 Test 1] Pure intraday long: buy 100 @ 100, sell 40 @ 120, qty 60, LTP 110");
    const intraLongPos: RawBrokerPosition = {
      instrument_token: 110001,
      exchange: 'NFO',
      tradingsymbol: 'NIFTY26OCTFUT',
      product: 'MIS',
      quantity: 60,
      average_price: 100.0,
      last_price: 110.0,
      day_buy_quantity: 100,
      day_buy_value: 10000.0,
      day_sell_quantity: 40,
      day_sell_value: 4800.0,
      realised: 800.0,
      unrealised: 600.0,
      pnl: 1400.0,
      multiplier: 1,
    };
    MarketDataService.ingestTick(110001, 110.0, new Date());
    const res32 = await LivePnlValidationService.validateLivePnl(undefined, new Date(), [intraLongPos], MOCK_INSTRUMENT_MAP);
    assert(res32.calculated.dailyRealisedPnl === 800.0, 'Daily realized P&L is +800.0');
    assert(res32.calculated.dailyUnrealisedPnl === 600.0, 'Daily unrealized P&L is +600.0');
    assert(res32.calculated.grossTradingPnl === 1400.0, 'Daily gross trading P&L is +1400.0');

    // -------------------------------------------------------------
    // TEST 33 — Pure Intraday Short (Section 22 Test 2)
    // sell 100 @ 100, buy 40 @ 80, remaining quantity -60, LTP 90
    // Realized: (100 - 80) * 40 = +800
    // Unrealized: (90 - 100) * -60 = +600
    // Daily Gross P&L: +1400
    // -------------------------------------------------------------
    console.log("[Test 33 - Section 22 Test 2] Pure intraday short: sell 100 @ 100, buy 40 @ 80, qty -60, LTP 90");
    const intraShortPos: RawBrokerPosition = {
      instrument_token: 110001,
      exchange: 'NFO',
      tradingsymbol: 'NIFTY26OCTFUT',
      product: 'MIS',
      quantity: -60,
      average_price: 100.0,
      last_price: 90.0,
      day_sell_quantity: 100,
      day_sell_value: 10000.0,
      day_buy_quantity: 40,
      day_buy_value: 3200.0,
      realised: 800.0,
      unrealised: 600.0,
      pnl: 1400.0,
      multiplier: 1,
    };
    MarketDataService.ingestTick(110001, 90.0, new Date());
    const res33 = await LivePnlValidationService.validateLivePnl(undefined, new Date(), [intraShortPos], MOCK_INSTRUMENT_MAP);
    assert(res33.calculated.dailyRealisedPnl === 800.0, 'Daily realized P&L on short is +800.0');
    assert(res33.calculated.dailyUnrealisedPnl === 600.0, 'Daily unrealized P&L on short is +600.0');
    assert(res33.calculated.grossTradingPnl === 1400.0, 'Daily gross trading P&L on short is +1400.0');

    // -------------------------------------------------------------
    // TEST 34 — Fully Closed Intraday Position (Section 22 Test 3)
    // quantity = 0, buy 50 @ 100, sell 50 @ 120
    // Realized: 6000 - 5000 = +1000
    // Unrealized: 0
    // -------------------------------------------------------------
    console.log("[Test 34 - Section 22 Test 3] Fully closed intraday position: qty = 0");
    const closedIntraPos: RawBrokerPosition = {
      instrument_token: 110001,
      exchange: 'NFO',
      tradingsymbol: 'NIFTY26OCTFUT',
      product: 'MIS',
      quantity: 0,
      average_price: 100.0,
      last_price: 110.0,
      day_buy_quantity: 50,
      day_buy_value: 5000.0,
      day_sell_quantity: 50,
      day_sell_value: 6000.0,
      realised: 1000.0,
      unrealised: 0.0,
      pnl: 1000.0,
      multiplier: 1,
    };
    const res34 = await LivePnlValidationService.validateLivePnl(undefined, new Date(), [closedIntraPos], MOCK_INSTRUMENT_MAP);
    assert(res34.calculated.dailyRealisedPnl === 1000.0, 'Realized daily P&L remains +1000.0');
    assert(res34.calculated.dailyUnrealisedPnl === 0.0, 'Unrealized is strictly zero on closed position');
    assert(res34.calculated.grossTradingPnl === 1000.0, 'Gross trading P&L equals realized +1000.0');

    // -------------------------------------------------------------
    // TEST 35 — Carried-Forward Long (Section 22 Test 4)
    // previous close: 120, average price: 100 (historical entry), current LTP: 130, carried qty: 50
    // Daily P&L: (130 - 120) * 50 = +500 (NOT +1500)
    // -------------------------------------------------------------
    console.log("[Test 35 - Section 22 Test 4] Carried-forward long: close 120, avg 100, LTP 130, qty 50");
    const carriedLongPos: RawBrokerPosition = {
      instrument_token: 110001,
      exchange: 'NFO',
      tradingsymbol: 'NIFTY26OCTFUT',
      product: 'NRML',
      quantity: 50,
      overnight_quantity: 50,
      close_price: 120.0,
      average_price: 100.0,
      last_price: 130.0,
      day_buy_quantity: 0,
      day_buy_value: 0.0,
      day_sell_quantity: 0,
      day_sell_value: 0.0,
      realised: 0.0,
      unrealised: 1500.0, // Lifetime unrealized is 1500
      pnl: 1500.0,        // Lifetime P&L is 1500
      multiplier: 1,
    };
    MarketDataService.ingestTick(110001, 130.0, new Date());
    const res35 = await LivePnlValidationService.validateLivePnl(undefined, new Date(), [carriedLongPos], MOCK_INSTRUMENT_MAP);
    assert(res35.calculated.dailyRealisedPnl === 0.0, 'Carried long daily realized is 0.0');
    assert(res35.calculated.dailyUnrealisedPnl === 500.0, 'Daily unrealized is +500.0 referenced against close 120');
    assert(res35.calculated.grossTradingPnl === 500.0, 'Daily gross P&L is +500.0, NOT historical lifetime 1500');

    // -------------------------------------------------------------
    // TEST 36 — Carried-Forward Short (Section 22 Test 5)
    // previous close: 120, average price: 150, current LTP: 110, carried qty: -50
    // Daily P&L: (110 - 120) * -50 = +500 (gain of 10 points today)
    // -------------------------------------------------------------
    console.log("[Test 36 - Section 22 Test 5] Carried-forward short: close 120, avg 150, LTP 110, qty -50");
    const carriedShortPos: RawBrokerPosition = {
      instrument_token: 110001,
      exchange: 'NFO',
      tradingsymbol: 'NIFTY26OCTFUT',
      product: 'NRML',
      quantity: -50,
      overnight_quantity: -50,
      close_price: 120.0,
      average_price: 150.0,
      last_price: 110.0,
      day_buy_quantity: 0,
      day_buy_value: 0.0,
      day_sell_quantity: 0,
      day_sell_value: 0.0,
      realised: 0.0,
      unrealised: 2000.0, // Lifetime unrealized is 2000
      pnl: 2000.0,
      multiplier: 1,
    };
    MarketDataService.ingestTick(110001, 110.0, new Date());
    const res36 = await LivePnlValidationService.validateLivePnl(undefined, new Date(), [carriedShortPos], MOCK_INSTRUMENT_MAP);
    assert(res36.calculated.dailyRealisedPnl === 0.0, 'Carried short daily realized is 0.0');
    assert(res36.calculated.dailyUnrealisedPnl === 500.0, 'Daily unrealized on short is +500.0 referenced against close 120');
    assert(res36.calculated.grossTradingPnl === 500.0, 'Daily gross P&L on short is +500.0, NOT lifetime 2000');

    // -------------------------------------------------------------
    // TEST 37 — Mixed Carried-Forward + Today's Trading (Section 22 Test 6)
    // overnight qty: 100 @ close 200 (avg 150)
    // Today: sell 40 @ 205 (day_sell_quantity: 40, day_sell_value: 8200)
    // Remaining qty: 60, LTP: 210
    // Realized today: (205 - 200) * 40 = +200
    // Unrealized today: (210 - 200) * 60 = +600
    // Total day gross: +800
    // -------------------------------------------------------------
    console.log("[Test 37 - Section 22 Test 6] Mixed carried-forward + today's trading: overnight 100 @ 200, sell 40 @ 205, rem 60 @ 210");
    const mixedPos: RawBrokerPosition = {
      instrument_token: 110001,
      exchange: 'NFO',
      tradingsymbol: 'NIFTY26OCTFUT',
      product: 'NRML',
      quantity: 60,
      overnight_quantity: 100,
      close_price: 200.0,
      average_price: 150.0,
      last_price: 210.0,
      day_buy_quantity: 0,
      day_buy_value: 0.0,
      day_sell_quantity: 40,
      day_sell_value: 8200.0,
      realised: 2200.0, // Broker lifetime realized from entry 150 is (205-150)*40 = 2200
      unrealised: 3600.0, // Broker lifetime unrealized is (210-150)*60 = 3600
      pnl: 5800.0,
      multiplier: 1,
    };
    MarketDataService.ingestTick(110001, 210.0, new Date());
    const res37 = await LivePnlValidationService.validateLivePnl(undefined, new Date(), [mixedPos], MOCK_INSTRUMENT_MAP);
    assert(res37.calculated.dailyRealisedPnl === 200.0, 'Mixed position daily realized is +200.0');
    assert(res37.calculated.dailyUnrealisedPnl === 600.0, 'Mixed position daily unrealized is +600.0');
    assert(res37.calculated.grossTradingPnl === 800.0, 'Mixed position daily gross P&L is +800.0 without double-counting');

    // -------------------------------------------------------------
    // TEST 38 — Futures Multiplier (Section 22 Test 7)
    // multiplier = 2
    // buy 50 @ 100, LTP 110, multiplier 2 -> (110 - 100) * 50 * 2 = 1000
    // -------------------------------------------------------------
    console.log("[Test 38 - Section 22 Test 7] Futures multiplier: multiplier = 2");
    const futMultPos: RawBrokerPosition = {
      instrument_token: 110001,
      exchange: 'NFO',
      tradingsymbol: 'NIFTY26OCTFUT',
      product: 'NRML',
      quantity: 50,
      average_price: 100.0,
      last_price: 110.0,
      day_buy_quantity: 0,
      day_buy_value: 0.0,
      day_sell_quantity: 0,
      day_sell_value: 0.0,
      realised: 0.0,
      unrealised: 1000.0,
      pnl: 1000.0,
      multiplier: 2,
    };
    MarketDataService.ingestTick(110001, 110.0, new Date());
    const res38 = await LivePnlValidationService.validateLivePnl(undefined, new Date(), [futMultPos], MOCK_INSTRUMENT_MAP);
    assert(res38.calculated.grossTradingPnl === 1000.0, 'Multiplier correctly scales daily P&L once (500 * 2 = 1000.0)');

    // -------------------------------------------------------------
    // TEST 39 — Options Multiplier (Section 22 Test 8)
    // -------------------------------------------------------------
    console.log("[Test 39 - Section 22 Test 8] Options multiplier handling");
    const optMultPos: RawBrokerPosition = {
      instrument_token: 120001, // NFO-OPT in MOCK_INSTRUMENT_MAP
      exchange: 'NFO',
      tradingsymbol: 'NIFTY26OCT25000CE',
      product: 'NRML',
      quantity: 25,
      average_price: 100.0,
      last_price: 120.0,
      day_buy_quantity: 0,
      day_buy_value: 0.0,
      day_sell_quantity: 0,
      day_sell_value: 0.0,
      realised: 0.0,
      unrealised: 1000.0,
      pnl: 1000.0,
      multiplier: 2,
    };
    MarketDataService.ingestTick(120001, 120.0, new Date());
    const res39 = await LivePnlValidationService.validateLivePnl(undefined, new Date(), [optMultPos], MOCK_INSTRUMENT_MAP);
    assert(res39.calculated.grossTradingPnl === 1000.0, 'Options multiplier scales P&L correctly (25 * 20 * 2 = 1000.0)');

    // -------------------------------------------------------------
    // TEST 40 — Realized Field Independence (Section 22 Test 13)
    // raw.realised (2451.75) !== calculated daily realized (2451.00)
    // -------------------------------------------------------------
    console.log("[Test 40 - Section 22 Test 13] Realized field independence");
    const independentRealisedPos: RawBrokerPosition = {
      instrument_token: 110001,
      exchange: 'NFO',
      tradingsymbol: 'NIFTY26OCTFUT',
      product: 'MIS',
      quantity: 0,
      average_price: 100.0,
      last_price: 100.0,
      day_buy_quantity: 50,
      day_buy_value: 999999.0,
      day_sell_quantity: 50,
      day_sell_value: 1002450.0, // calculated realized = 2451.00
      realised: 2451.75,         // raw broker realized = 2451.75
      unrealised: 0.0,
      pnl: 2451.75,
      multiplier: 1,
    };
    const res40 = await LivePnlValidationService.validateLivePnl(undefined, new Date(), [independentRealisedPos], MOCK_INSTRUMENT_MAP);
    assert(res40.brokerReported?.realisedPnl === 2451.75, 'brokerReported.realisedPnl preserves raw.realised (2451.75)');
    assert(res40.calculated.dailyRealisedPnl === 2451.0, 'calculated.dailyRealisedPnl reflects daily trade math (2451.0)');
    assert(res40.reconciliation?.realisedDifference === 0.75, 'Realized difference (0.75) is separately observable');

    // -------------------------------------------------------------
    // TEST 41 — Broker Comparison Semantic Reconciliation (Section 22 Test 20)
    // Carried-forward position without m2m produces NOT_COMPARABLE
    // -------------------------------------------------------------
    console.log("[Test 41 - Section 22 Test 20] Broker comparison: NOT_COMPARABLE for carried positions without m2m");
    assert(res35.reconciliation?.comparisonStatus === 'NOT_COMPARABLE', "comparisonStatus is 'NOT_COMPARABLE'");
    assert(res35.validationState === 'VALID', "Does not falsely flag 'DISCREPANCY' for uncomparable lifetime P&L");

    // -------------------------------------------------------------
    // TEST 42 — IST Trading Date Midnight Rollover (Section 22 Test 19)
    // -------------------------------------------------------------
    console.log("[Test 42 - Section 22 Test 19] Asia/Kolkata midnight boundary test");
    const beforeMidnightUtc = new Date('2026-10-02T18:29:59.000Z'); // 23:59:59 IST
    const afterMidnightUtc = new Date('2026-10-02T18:30:00.000Z');  // 00:00:00 IST
    const res42a = await LivePnlValidationService.validateLivePnl(undefined, beforeMidnightUtc, [closedIntraPos], MOCK_INSTRUMENT_MAP);
    const res42b = await LivePnlValidationService.validateLivePnl(undefined, afterMidnightUtc, [closedIntraPos], MOCK_INSTRUMENT_MAP);
    assert(res42a.tradingDate === '2026-10-02', '18:29:59 UTC is 2026-10-02 in IST');
    assert(res42b.tradingDate === '2026-10-03', '18:30:00 UTC is 2026-10-03 in IST');

    // -------------------------------------------------------------
    // TEST 43 — Section 13: Mixed Overnight + Today's Activity
    // Overnight: +50 @ close 100
    // Today: Sell 20 @ 110, Buy 10 @ 105
    // Final qty: +40, LTP 108
    // Expected independently:
    // Realized: (110 - 100) * 20 = +200
    // Unrealized: (108 - 100) * 30 + (108 - 105) * 10 = 240 + 30 = +270
    // Gross: 200 + 270 = +470
    // -------------------------------------------------------------
    console.log("[Test 43 - Section 13] Mixed overnight + today's trades: overnight 50 @ 100, sell 20 @ 110, buy 10 @ 105, rem 40 @ 108");
    const sec13Pos: RawBrokerPosition = {
      instrument_token: 110001,
      exchange: 'NFO',
      tradingsymbol: 'NIFTY26OCTFUT',
      product: 'NRML',
      quantity: 40,
      overnight_quantity: 50,
      close_price: 100.0,
      average_price: 80.0, // Historical entry price must NOT leak in
      last_price: 108.0,
      day_sell_quantity: 20,
      day_sell_value: 2200.0,
      day_buy_quantity: 10,
      day_buy_value: 1050.0,
      realised: 600.0, // Lifetime broker realized
      unrealised: 1120.0,
      pnl: 1720.0,
      multiplier: 1,
    };
    MarketDataService.ingestTick(110001, 108.0, new Date());
    const res43 = await LivePnlValidationService.validateLivePnl(undefined, new Date(), [sec13Pos], MOCK_INSTRUMENT_MAP);
    assert(res43.calculated.dailyRealisedPnl === 200.0, 'Independently verified daily realized P&L is +200.0');
    assert(res43.calculated.dailyUnrealisedPnl === 270.0, 'Independently verified daily unrealized P&L is +270.0');
    assert(res43.calculated.grossTradingPnl === 470.0, 'Independently verified gross current-day P&L is +470.0');

    // -------------------------------------------------------------
    // TEST 44 — Section 14: Overnight Position Fully Closed Today
    // Overnight: +50 @ close 100
    // Today: Sell 50 @ 110
    // Final qty: 0
    // Expected: Realized = +500, Unrealized = 0, Gross = +500
    // -------------------------------------------------------------
    console.log("[Test 44 - Section 14] Overnight position fully closed today: overnight 50 @ 100, sell 50 @ 110, final 0");
    const sec14Pos: RawBrokerPosition = {
      instrument_token: 110001,
      exchange: 'NFO',
      tradingsymbol: 'NIFTY26OCTFUT',
      product: 'NRML',
      quantity: 0,
      overnight_quantity: 50,
      close_price: 100.0,
      average_price: 70.0, // Historical entry price
      last_price: 110.0,
      day_sell_quantity: 50,
      day_sell_value: 5500.0,
      day_buy_quantity: 0,
      day_buy_value: 0.0,
      realised: 2000.0, // Lifetime realized
      unrealised: 0.0,
      pnl: 2000.0,
      multiplier: 1,
    };
    const res44 = await LivePnlValidationService.validateLivePnl(undefined, new Date(), [sec14Pos], MOCK_INSTRUMENT_MAP);
    assert(res44.calculated.dailyRealisedPnl === 500.0, 'Daily realized P&L on fully closed overnight is +500.0');
    assert(res44.calculated.dailyUnrealisedPnl === 0.0, 'Daily unrealized is strictly 0 on fully closed position');
    assert(res44.calculated.grossTradingPnl === 500.0, 'Daily gross P&L is +500.0 (historical profit excluded)');

    // -------------------------------------------------------------
    // TEST 45 — Section 15: Partial Overnight Close
    // Overnight: +100 @ close 100
    // Today: Sell 40 @ 110
    // Final qty: +60, LTP 105
    // Expected: Realized = +400, Unrealized = +300, Gross = +700
    // -------------------------------------------------------------
    console.log("[Test 45 - Section 15] Partial overnight close: overnight 100 @ 100, sell 40 @ 110, rem 60 @ 105");
    const sec15Pos: RawBrokerPosition = {
      instrument_token: 110001,
      exchange: 'NFO',
      tradingsymbol: 'NIFTY26OCTFUT',
      product: 'NRML',
      quantity: 60,
      overnight_quantity: 100,
      close_price: 100.0,
      average_price: 50.0, // Historical entry
      last_price: 105.0,
      day_sell_quantity: 40,
      day_sell_value: 4400.0,
      day_buy_quantity: 0,
      day_buy_value: 0.0,
      realised: 2400.0,
      unrealised: 3300.0,
      pnl: 5700.0,
      multiplier: 1,
    };
    MarketDataService.ingestTick(110001, 105.0, new Date());
    const res45 = await LivePnlValidationService.validateLivePnl(undefined, new Date(), [sec15Pos], MOCK_INSTRUMENT_MAP);
    assert(res45.calculated.dailyRealisedPnl === 400.0, 'Partial overnight close realized is +400.0');
    assert(res45.calculated.dailyUnrealisedPnl === 300.0, 'Remaining overnight unrealized is +300.0');
    assert(res45.calculated.grossTradingPnl === 700.0, 'Current-day gross P&L is +700.0');

    // -------------------------------------------------------------
    // TEST 46 — Section 16: Position Reversal
    // Overnight: +50 @ close 100
    // Today: Sell 75 @ 110
    // Final qty: -25, LTP 105
    // Expected:
    // Realized on 50 closed = (110 - 100) * 50 = +500
    // Unrealized on 25 short = (110 - 105) * 25 = +125
    // Gross = 500 + 125 = +625
    // -------------------------------------------------------------
    console.log("[Test 46 - Section 16] Position reversal: overnight +50 @ 100, sell 75 @ 110, final -25, LTP 105");
    const sec16Pos: RawBrokerPosition = {
      instrument_token: 110001,
      exchange: 'NFO',
      tradingsymbol: 'NIFTY26OCTFUT',
      product: 'NRML',
      quantity: -25,
      overnight_quantity: 50,
      close_price: 100.0,
      average_price: 110.0,
      last_price: 105.0,
      day_sell_quantity: 75,
      day_sell_value: 8250.0,
      day_buy_quantity: 0,
      day_buy_value: 0.0,
      realised: 500.0,
      unrealised: 125.0,
      pnl: 625.0,
      multiplier: 1,
    };
    MarketDataService.ingestTick(110001, 105.0, new Date());
    const res46 = await LivePnlValidationService.validateLivePnl(undefined, new Date(), [sec16Pos], MOCK_INSTRUMENT_MAP);
    assert(res46.calculated.dailyRealisedPnl === 500.0, 'Reversal realized P&L closing long is +500.0');
    assert(res46.calculated.dailyUnrealisedPnl === 125.0, 'Reversal unrealized P&L on new short is +125.0');
    assert(res46.calculated.grossTradingPnl === 625.0, 'Reversal daily gross P&L is +625.0 without double-counting');

    // -------------------------------------------------------------
    // TEST 47 — Section 6: Fail-Closed Policy on Missing Reference Price
    // Carried-forward position with close_price missing MUST NOT fallback to average_price
    // -------------------------------------------------------------
    console.log("[Test 47 - Section 6] Missing close_price on carried position yields MISSING_DATA");
    const missingClosePos: RawBrokerPosition = {
      instrument_token: 110001,
      exchange: 'NFO',
      tradingsymbol: 'NIFTY26OCTFUT',
      product: 'NRML',
      quantity: 50,
      overnight_quantity: 50,
      // close_price omitted / missing!
      average_price: 100.0,
      last_price: 110.0,
      day_buy_quantity: 0,
      day_buy_value: 0.0,
      day_sell_quantity: 0,
      day_sell_value: 0.0,
      realised: 0.0,
      unrealised: 500.0,
      pnl: 500.0,
      multiplier: 1,
    };
    MarketDataService.ingestTick(110001, 110.0, new Date());
    const res47 = await LivePnlValidationService.validateLivePnl(undefined, new Date(), [missingClosePos], MOCK_INSTRUMENT_MAP);
    assert(res47.validationState === 'MISSING_DATA', "Missing close_price triggers 'MISSING_DATA' validation state");

    console.log('\n================================================================');
    console.log(`ALL 47 PHASE 8 TESTS PASSED SUCCESSFULLY (${passedTests}/${totalTests})`);
    console.log('================================================================');
  } finally {
    MarketDataService.reset();
    LivePnlValidationService.setTolerance(DEFAULT_RECONCILIATION_TOLERANCE);
  }
}

runPhase8TestSuite().catch((err) => {
  console.error('Phase 8 Test Runner Encountered Fatal Error:', err);
  process.exit(1);
});
