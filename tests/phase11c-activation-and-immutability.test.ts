import { strict as assert } from 'assert';
import { RiskEngine } from '../server/risk/engine';
import { ShadowRiskService } from '../server/risk/shadowRiskService';
import { ServerRiskStore } from '../server/risk/store';
import { LiveRiskRecorder, setLiveRiskStateRecordingEnabled, getLiveRiskStateRecordingEnabled } from '../server/risk/liveRiskRecorder';
import { ActivationGuardService } from '../server/risk/activationGuard';
import { apiRouter } from '../server/api';
import { DEFAULT_RISK_CONFIG, RiskConfig } from '../src/types/risk';
import { BrokerService } from '../server/brokers/service';
import { ZerodhaCredentialManager } from '../server/brokers/zerodha/credentials';
import { ZerodhaSessionStore, enableMockStoreForTesting } from '../server/brokers/zerodha/sessionStore';
import { MarketDataService } from '../server/market/marketDataService';

function createMockRes() {
  let statusCode = 200;
  let headers: Record<string, string> = {};
  let body: any = null;

  const res: any = {
    statusCode: 200,
    status(code: number) {
      statusCode = code;
      res.statusCode = code;
      return res;
    },
    setHeader(name: string, val: string) {
      headers[name] = val;
    },
    json(data: any) {
      body = data;
      return res;
    },
    end(data?: any) {
      if (data && !body) {
        try {
          body = JSON.parse(data);
        } catch {
          body = data;
        }
      }
      return res;
    },
    accepts() {
      return false;
    },
  };

  return {
    res,
    getCaptured: () => ({ statusCode: res.statusCode || statusCode, headers, data: body }),
  };
}

async function runPhase11cTests() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: PHASE 11C INTEGRATION & IMMUTABILITY SUITE');
  console.log('Explicit Production Activation & Locked Risk Config Immutability');
  console.log('================================================================\n');

  const testUser = 'phase11c_trader_user';
  const evalTime = new Date('2026-10-06T10:00:00.000Z'); // 3:30 PM IST

  // Helper mock response
  const mockFetchResponse = (data: any, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  });

  const mockInstrumentsCsv = `instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange\n110001,110001,NIFTY26OCTFUT,NIFTY,0,2026-10-29,0,0.05,50,FUT,NFO-FUT,NFO`;

  // Setup initial config
  const initialConfig: RiskConfig = {
    ...DEFAULT_RISK_CONFIG,
    dailyLossLimit: 500,
    lockDurationMinutes: 120,
    lockDurationType: 'FIXED',
    enabled: true,
  };
  await ServerRiskStore.saveConfig(testUser, initialConfig);

  // Setup mock Zerodha live adapter
  const liveAdapter = BrokerService.getLiveAdapter();
  liveAdapter.setFetchHandler(async (url: string) => {
    if (url.includes('/instruments')) {
      return { ok: true, status: 200, json: async () => [], text: async () => mockInstrumentsCsv };
    }
    if (url.includes('/user/profile')) {
      return mockFetchResponse({ status: 'success', data: { user_id: 'AB1234', user_name: 'Phase 11C Trader' } });
    }
    if (url.includes('/portfolio/positions')) {
      return mockFetchResponse({
        status: 'success',
        data: {
          net: [
            {
              instrument_token: 110001,
              exchange: 'NFO',
              tradingsymbol: 'NIFTY26OCTFUT',
              product: 'NRML',
              quantity: 50,
              average_price: 25000,
              last_price: 24989.86, // P&L = -507
              pnl: -507,
              realised: 0,
              unrealised: -507,
              day_buy_quantity: 50,
              day_buy_value: 1250000,
              day_sell_quantity: 0,
              day_sell_value: 0,
            },
          ],
          day: [],
        },
      });
    }
    return mockFetchResponse({ status: 'success', data: {} });
  });

  process.env.ZERODHA_API_KEY = 'test_api_key';
  process.env.ZERODHA_API_SECRET = 'test_api_secret';
  process.env.ZERODHA_ACCESS_TOKEN = 'test_p11c_token';

  enableMockStoreForTesting(true);
  ZerodhaCredentialManager.setRuntimeSession(
    { accessToken: 'test_p11c_token', sessionVersion: 1 },
    testUser
  );
  await ZerodhaSessionStore.saveSession(
    testUser,
    'test_p11c_token',
    { brokerUserId: 'AB1234' }
  );

  MarketDataService.connect();
  MarketDataService.ingestTick(110001, 24989.86);

  // ------------------------------------------------------------------
  // TEST 1 — Preflight evaluation & explicit production activation
  // ------------------------------------------------------------------
  console.log('[Test 1] Preflight check PASS & explicit production activation via POST /api/risk/recording/control');
  const preflight = await ActivationGuardService.evaluatePreflight(testUser);
  assert.equal(preflight.ready, true, 'Preflight check passes');
  assert.equal(preflight.blockers.length, 0, 'Zero preflight blockers');

  // Trigger explicit activation
  const reqActivate: any = {
    headers: { 'x-user-id': testUser },
    body: { enabled: true },
  };
  const { res: resAct, getCaptured: getCapturedAct } = createMockRes();
  const getControlHandler = (apiRouter as any).stack.find((r: any) => r.route?.path === '/risk/recording/control')?.route?.stack[0]?.handle;
  assert.ok(getControlHandler, 'Recording control handler exists');

  await getControlHandler(reqActivate, resAct, () => {});
  const dataAct = getCapturedAct().data;

  assert.equal(dataAct.success, true, 'Activation response success = true');
  assert.equal(dataAct.liveRiskStateRecordingEnabled, true, 'liveRiskStateRecordingEnabled = true');
  assert.equal(dataAct.activationState, 'ACTIVE', 'activationState = ACTIVE');
  assert.equal(dataAct.currentRiskState, 'LOCKED', 'Real account evaluated current P&L (-507) to LOCKED');
  assert.equal(dataAct.grossTradingPnl, -507, 'Current real P&L = -507');
  assert.equal(dataAct.dataSource, 'ZERODHA_LIVE', 'Data source is ZERODHA_LIVE');
  console.log('  ✓ PASSED: Explicit production activation succeeded & entered authoritative LOCKED state');

  // ------------------------------------------------------------------
  // TEST 2 — LOCKED Config Immutability: Daily Loss Limit mutation REJECTED
  // ------------------------------------------------------------------
  console.log('[Test 2] LOCKED Config Immutability: Attempted Daily Loss Limit edit rejected with RISK_CONFIG_LOCKED');
  const reqMutateLimit: any = {
    headers: { 'x-user-id': testUser },
    body: {
      ...initialConfig,
      dailyLossLimit: 2000, // Attempted weakening from 500 to 2000
    },
  };
  const { res: resMut1, getCaptured: getCapturedMut1 } = createMockRes();
  const putConfigLayer = (apiRouter as any).stack.find((r: any) => r.route?.path === '/risk/config' && r.route?.methods?.put);
  const putConfigHandler = putConfigLayer?.route?.stack[0]?.handle;
  assert.ok(putConfigHandler, 'PUT /api/risk/config handler exists');

  await putConfigHandler(reqMutateLimit, resMut1, () => {});
  const capMut1 = getCapturedMut1();

  assert.equal(capMut1.statusCode, 403, 'Attempted limit mutation returns HTTP 403');
  assert.equal(capMut1.data.success, false, 'Mutation response success = false');
  assert.equal(capMut1.data.code, 'RISK_CONFIG_LOCKED', 'Error code is RISK_CONFIG_LOCKED');
  assert.ok(capMut1.data.errors[0].includes('RISK_CONFIG_LOCKED'), 'Error message specifies RISK_CONFIG_LOCKED');

  // Verify RiskConfig in ServerRiskStore remains strictly unchanged
  const currentStoreConfig = await ServerRiskStore.getConfig(testUser);
  assert.equal(currentStoreConfig.dailyLossLimit, 500, 'Server RiskConfig dailyLossLimit remains strictly unchanged at 500');
  console.log('  ✓ PASSED: Daily Loss Limit mutation rejected & config preserved');

  // ------------------------------------------------------------------
  // TEST 3 — LOCKED Config Immutability: Lockout Schedule mutation REJECTED
  // ------------------------------------------------------------------
  console.log('[Test 3] LOCKED Config Immutability: Attempted Lockout Schedule edit rejected');
  const reqMutateSchedule: any = {
    headers: { 'x-user-id': testUser },
    body: {
      ...initialConfig,
      lockDurationMinutes: 180, // Attempted alteration from 120 to 180
    },
  };
  const { res: resMut2, getCaptured: getCapturedMut2 } = createMockRes();
  await putConfigHandler(reqMutateSchedule, resMut2, () => {});
  const capMut2 = getCapturedMut2();

  assert.equal(capMut2.statusCode, 403, 'Attempted lockout schedule mutation returns HTTP 403');
  assert.equal(capMut2.data.code, 'RISK_CONFIG_LOCKED', 'Error code is RISK_CONFIG_LOCKED');

  const currentStoreConfig2 = await ServerRiskStore.getConfig(testUser);
  assert.equal(currentStoreConfig2.lockDurationMinutes, 120, 'Server lockDurationMinutes remains strictly 120');
  console.log('  ✓ PASSED: Lockout schedule mutation rejected');

  // ------------------------------------------------------------------
  // TEST 4 — Normal/non-immutability config attributes remain editable or allowed
  // ------------------------------------------------------------------
  console.log('[Test 4] Normal config attributes (e.g. warning thresholds) update while locked');
  const reqMutateThreshold: any = {
    headers: { 'x-user-id': testUser },
    body: {
      ...initialConfig,
      warningThreshold1: 65, // Updating threshold 1 from 70 to 65
    },
  };
  const { res: resMut3, getCaptured: getCapturedMut3 } = createMockRes();
  await putConfigHandler(reqMutateThreshold, resMut3, () => {});
  const capMut3 = getCapturedMut3();

  assert.equal(capMut3.statusCode, 200, 'Threshold edit returns HTTP 200');
  assert.equal(capMut3.data.success, true, 'Threshold edit succeeds');
  assert.equal(capMut3.data.config.warningThreshold1, 65, 'warningThreshold1 updated to 65');

  // Daily Loss Limit remains strictly 500
  assert.equal(capMut3.data.config.dailyLossLimit, 500, 'dailyLossLimit strictly preserved at 500');
  console.log('  ✓ PASSED: Allowed attributes update while daily loss limit & schedule remain protected');

  // ------------------------------------------------------------------
  // TEST 5 — Lock expiry unlocks configuration editing
  // ------------------------------------------------------------------
  console.log('[Test 5] Lock expiry unlocks configuration editing');
  const unlockedUser = 'phase11c_unlocked_user';
  const pastEvalTime = new Date('2026-10-06T08:00:00.000Z'); // Expired lock
  const expiredSession = {
    tradingDate: '2026-10-06',
    userId: unlockedUser,
    state: 'LOCKED' as const,
    isBreached: true,
    lockedAt: '2026-10-06T06:00:00.000Z',
    lockUntil: pastEvalTime.toISOString(), // Expired 2 hours ago
    currentPnl: -507,
    lossAmount: 507,
    realisedPnl: -507,
    unrealisedPnl: 0,
    lossLimit: 500,
    warningThreshold1: 70,
    warningThreshold2: 90,
    lastEvaluatedAt: pastEvalTime.toISOString(),
    reason: 'Expired lock',
  };

  await ServerRiskStore.saveConfig(unlockedUser, initialConfig);
  // Set expired session in user state
  (ServerRiskStore as any).getOrCreateUserState(unlockedUser).sessions.set('2026-10-06', expiredSession);

  const reqExpiredEdit: any = {
    headers: { 'x-user-id': unlockedUser },
    body: {
      ...initialConfig,
      dailyLossLimit: 1000, // Allowed because lock is expired
    },
  };
  const { res: resExp, getCaptured: getCapturedExp } = createMockRes();
  await putConfigHandler(reqExpiredEdit, resExp, () => {});
  const capExp = getCapturedExp();

  assert.equal(capExp.statusCode, 200, 'Expired lock permits dailyLossLimit update');
  assert.equal(capExp.data.config.dailyLossLimit, 1000, 'dailyLossLimit successfully updated to 1000 after lock expiry');
  console.log('  ✓ PASSED: Settings become editable again after lock expiry');

  // ------------------------------------------------------------------
  // TEST 6 — Pure read-only safety invariants
  // ------------------------------------------------------------------
  console.log('[Test 6] Pure read-only safety invariants strictly maintained');
  assert.equal(typeof (liveAdapter as any).placeOrder, 'undefined', 'Zero placeOrder API');
  assert.equal(typeof (liveAdapter as any).modifyOrder, 'undefined', 'Zero modifyOrder API');
  assert.equal(typeof (liveAdapter as any).cancelOrder, 'undefined', 'Zero cancelOrder API');
  assert.equal(typeof (liveAdapter as any).squareOff, 'undefined', 'Zero squareOff API');
  console.log('  ✓ PASSED: Read-only safety boundary strictly maintained');

  console.log('\n================================================================');
  console.log('ALL PHASE 11C EXPLICIT ACTIVATION & IMMUTABILITY TESTS PASSED');
  console.log('================================================================\n');

  // Restore recording flag for remaining dev environment operations
  setLiveRiskStateRecordingEnabled(true);
}

runPhase11cTests().catch((err) => {
  console.error('Phase 11C test suite failed:', err);
  process.exit(1);
});
