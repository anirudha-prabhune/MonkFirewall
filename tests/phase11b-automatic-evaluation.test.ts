import { strict as assert } from 'assert';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../src/services/firebase';
import { ServerRiskStore } from '../server/risk/store';
import { apiRouter } from '../server/api';
import { BrokerService } from '../server/brokers/service';
import { MarketDataService } from '../server/market/marketDataService';
import { ZerodhaCredentialManager } from '../server/brokers/zerodha/credentials';
import { enableMockStoreForTesting } from '../server/brokers/zerodha/sessionStore';
import { DEFAULT_RISK_CONFIG, RiskConfig } from '../src/types/risk';
import { RawBrokerPosition } from '../server/brokers/types';
import { MOCK_INSTRUMENT_MAP } from '../server/instruments/master';
import { liveRiskStateRecordingEnabled } from '../server/risk/liveRiskRecorder';

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

function findRouteHandler(router: any, method: string, path: string) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method.toLowerCase()]) {
      return layer.route.stack[0].handle;
    }
  }
  throw new Error(`Route handler not found for ${method.toUpperCase()} ${path}`);
}

async function runAutomaticEvaluationTests() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: PHASE 11B AUTOMATIC EVALUATION SUITE');
  console.log('Automatic Real Account Shadow Risk Evaluation & Reconnect Flow');
  console.log('================================================================\n');

  enableMockStoreForTesting(true);

  const testUser = 'phase11b_auto_eval_user';
  const getPnlHandler = findRouteHandler(apiRouter, 'get', '/pnl');
  const getRiskHandler = findRouteHandler(apiRouter, 'get', '/risk');

  // 1. Setup persisted config directly in Firestore (Limit ₹500, Lock 120m)
  const savedConfig: RiskConfig = {
    ...DEFAULT_RISK_CONFIG,
    dailyLossLimit: 500,
    warningThreshold1: 70,
    warningThreshold2: 90,
    lockDurationMinutes: 120,
    enabled: true,
  };

  await ServerRiskStore.saveConfig(testUser, savedConfig);

  process.env.ZERODHA_API_KEY = 'test_api_key';
  process.env.ZERODHA_API_SECRET = 'test_api_secret';
  process.env.ZERODHA_ACCESS_TOKEN = 'test_auto_eval_token';

  // Helper to wrap mock data in standard fetch Response format
  const mockFetchResponse = (data: any, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  });

  // Setup mock Zerodha live adapter connection
  const liveAdapter = BrokerService.getLiveAdapter();
  const mockInstrumentsCsv = `instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange\n110001,110001,NIFTY26OCTFUT,NIFTY,0,2026-10-29,0,0.05,50,FUT,NFO-FUT,NFO`;

  liveAdapter.setFetchHandler(async (url: string) => {
    if (url.includes('/instruments')) {
      return {
        ok: true,
        status: 200,
        json: async () => [],
        text: async () => mockInstrumentsCsv,
      };
    }
    if (url.includes('/user/profile')) {
      return mockFetchResponse({ status: 'success', data: { user_id: 'AB1234', user_name: 'Auto Eval Trader' } });
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
    return mockFetchResponse({ status: 'success', data: [] });
  });

  // Authenticate Zerodha runtime session
  ZerodhaCredentialManager.setRuntimeSession(
    { accessToken: 'test_auto_eval_token', sessionVersion: 1 },
    testUser
  );

  MarketDataService.connect();
  MarketDataService.ingestTick(110001, 24989.86);

  // ------------------------------------------------------------------
  // TEST 1 — Automatic evaluation on Dashboard load without saving Risk Config
  // ------------------------------------------------------------------
  console.log('[Test 1] Zerodha authenticated → Dashboard load automatically loads config and evaluates shadow risk without Config Save');
  const req1: any = { headers: { 'x-user-id': testUser } };
  const { res: res1, getCaptured: getCaptured1 } = createMockRes();
  await getPnlHandler(req1, res1, () => {});

  const data1 = getCaptured1().data;
  assert.equal(data1.source, 'ZERODHA_LIVE', 'P&L sourced from ZERODHA_LIVE');
  assert.equal(data1.grossTradingPnl, -507, 'Gross trading P&L is -507');
  assert.equal(data1.dailyLossLimit, 500, 'Daily loss limit loaded from persisted config = 500');
  assert.equal(data1.state, 'LOCKED', 'Firewall state automatically evaluated to LOCKED');
  assert.equal(data1.riskSession.state, 'LOCKED', 'riskSession state is LOCKED');
  console.log('  ✓ PASSED: Automatic evaluation on Dashboard load succeeded without requiring Risk Config Save');

  // ------------------------------------------------------------------
  // TEST 2 — Automatic evaluation across P&L levels: -₹234 (ALLOW), -₹383.50 (WARNING), -₹507 (LOCKED)
  // ------------------------------------------------------------------
  console.log('[Test 2] Automatic evaluation across P&L levels: -₹234 → ALLOW, -₹383.50 → WARNING, -₹507 → LOCKED');

  // Level 1: -₹234
  MarketDataService.ingestTick(110001, 24995.32); // last_price = 24995.32 -> P&L = (24995.32 - 25000) * 50 = -234
  liveAdapter.setFetchHandler(async (url: string) => {
    if (url.includes('/instruments')) {
      return { ok: true, status: 200, json: async () => [], text: async () => mockInstrumentsCsv };
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
              last_price: 24995.32,
              pnl: -234,
              realised: 0,
              unrealised: -234,
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
    return mockFetchResponse({ status: 'success', data: { user_id: 'AB1234' } });
  });

  const { res: resAllow, getCaptured: getCapturedAllow } = createMockRes();
  await getPnlHandler(req1, resAllow, () => {});
  const dataAllow = getCapturedAllow().data;
  assert.equal(dataAllow.grossTradingPnl, -234, 'P&L = -234');
  assert.equal(dataAllow.state, 'ALLOW', '-₹234.00 evaluates to ALLOW');

  // Level 2: -₹383.50
  MarketDataService.ingestTick(110001, 24992.33); // P&L = (24992.33 - 25000) * 50 = -383.50
  liveAdapter.setFetchHandler(async (url: string) => {
    if (url.includes('/instruments')) {
      return { ok: true, status: 200, json: async () => [], text: async () => mockInstrumentsCsv };
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
              last_price: 24992.33,
              pnl: -383.5,
              realised: 0,
              unrealised: -383.5,
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
    return mockFetchResponse({ status: 'success', data: { user_id: 'AB1234' } });
  });

  const { res: resWarn, getCaptured: getCapturedWarn } = createMockRes();
  await getPnlHandler(req1, resWarn, () => {});
  const dataWarn = getCapturedWarn().data;
  assert.equal(dataWarn.grossTradingPnl, -383.5, 'P&L = -383.50');
  assert.equal(dataWarn.state, 'WARNING', '-₹383.50 evaluates to WARNING');

  // Level 3: -₹507
  MarketDataService.ingestTick(110001, 24989.86);
  liveAdapter.setFetchHandler(async (url: string) => {
    if (url.includes('/instruments')) {
      return { ok: true, status: 200, json: async () => [], text: async () => mockInstrumentsCsv };
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
              last_price: 24989.86,
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
    return mockFetchResponse({ status: 'success', data: { user_id: 'AB1234' } });
  });

  const { res: resLock, getCaptured: getCapturedLock } = createMockRes();
  await getPnlHandler(req1, resLock, () => {});
  const dataLock = getCapturedLock().data;
  assert.equal(dataLock.grossTradingPnl, -507, 'P&L = -507');
  assert.equal(dataLock.state, 'LOCKED', '-₹507.00 evaluates to LOCKED');
  console.log('  ✓ PASSED: Automatic evaluation correctly transitioned ALLOW -> WARNING -> LOCKED');

  // ------------------------------------------------------------------
  // TEST 3 — Polling GET /api/risk returns updated shadow state automatically
  // ------------------------------------------------------------------
  console.log('[Test 3] Polling GET /api/risk returns updated shadow state automatically');
  const { res: resRisk, getCaptured: getCapturedRisk } = createMockRes();
  await getRiskHandler(req1, resRisk, () => {});
  const dataRisk = getCapturedRisk().data;
  assert.equal(dataRisk.state, 'LOCKED', 'Polled /api/risk automatically returns LOCKED shadow state');
  assert.equal(dataRisk.currentPnl, -507, 'Polled /api/risk currentPnl = -507');
  assert.equal(dataRisk.lossAmount, 507, 'Polled /api/risk lossAmount = 507');
  console.log('  ✓ PASSED: Polling GET /api/risk returns updated shadow state');

  // ------------------------------------------------------------------
  // TEST 4 — Disconnect stops live evaluation; Reconnect resumes automatic evaluation
  // ------------------------------------------------------------------
  console.log('[Test 4] Disconnect stops live evaluation; Reconnect automatically resumes shadow evaluation');

  // Disconnect
  delete process.env.ZERODHA_ACCESS_TOKEN;
  await ZerodhaCredentialManager.disconnect(testUser);
  const { res: resDisc, getCaptured: getCapturedDisc } = createMockRes();
  await getPnlHandler(req1, resDisc, () => {});
  const dataDisc = getCapturedDisc().data;
  assert.equal(dataDisc.source, 'MOCK_ZERODHA_PHASE_3', 'P&L falls back to MOCK_ZERODHA when disconnected');

  // Reconnect
  process.env.ZERODHA_ACCESS_TOKEN = 'test_reconnect_token';
  ZerodhaCredentialManager.setRuntimeSession(
    { accessToken: 'test_reconnect_token', sessionVersion: 2 },
    testUser
  );

  const { res: resReconn, getCaptured: getCapturedReconn } = createMockRes();
  await getPnlHandler(req1, resReconn, () => {});
  const dataReconn = getCapturedReconn().data;
  assert.equal(dataReconn.source, 'ZERODHA_LIVE', 'P&L automatically resumes ZERODHA_LIVE after reconnect');
  assert.equal(dataReconn.state, 'LOCKED', 'Shadow risk evaluation automatically resumes LOCKED state after reconnect');
  console.log('  ✓ PASSED: Disconnect stops live evaluation; Reconnect automatically resumes shadow evaluation');

  // ------------------------------------------------------------------
  // TEST 5 — Invariant Safety Checks
  // ------------------------------------------------------------------
  console.log('[Test 5] Safety Invariants: Shadow mode maintained, zero mutations, zero order APIs');
  assert.equal(liveRiskStateRecordingEnabled, false, 'Shadow mode remains enabled (liveRiskStateRecordingEnabled = false)');
  assert.equal(typeof (liveAdapter as any).placeOrder, 'undefined', 'Zero order placement APIs exist');
  assert.equal(typeof (liveAdapter as any).cancelOrder, 'undefined', 'Zero order cancellation APIs exist');
  console.log('  ✓ PASSED: All safety invariants strictly satisfied');

  console.log('\n================================================================');
  console.log('ALL PHASE 11B AUTOMATIC EVALUATION TESTS PASSED');
  console.log('================================================================\n');
}

runAutomaticEvaluationTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
