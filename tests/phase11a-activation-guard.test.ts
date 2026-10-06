import { strict as assert } from 'assert';
import { apiRouter } from '../server/api';
import { ActivationGuardService } from '../server/risk/activationGuard';
import { ServerRiskStore } from '../server/risk/store';
import { ZerodhaCredentialManager } from '../server/brokers/zerodha/credentials';
import { ZerodhaSessionStore, enableMockStoreForTesting } from '../server/brokers/zerodha/sessionStore';
import {
  getLiveRiskStateRecordingEnabled,
  setLiveRiskStateRecordingEnabled,
} from '../server/risk/liveRiskRecorder';
import { LiveZerodhaAdapter } from '../server/brokers/zerodha/liveAdapter';
import { BrokerService } from '../server/brokers/service';

async function runPhase11aTestSuite() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: PHASE 11A ACTIVATION GUARD SUITE');
  console.log('Server-Authoritative Production Preflight & Controlled Activation');
  console.log('================================================================\n');

  const originalNodeEnv = process.env.NODE_ENV;
  const originalApiKey = process.env.ZERODHA_API_KEY;
  const originalApiSecret = process.env.ZERODHA_API_SECRET;

  process.env.NODE_ENV = 'production';
  process.env.ZERODHA_API_KEY = 'test_phase11a_api_key';
  process.env.ZERODHA_API_SECRET = 'test_phase11a_api_secret_32_bytes!';

  // Enable isolated mock store for session verification
  enableMockStoreForTesting(true);
  setLiveRiskStateRecordingEnabled(false);

  // Helper to extract router handlers
  const stack = (apiRouter as any).stack;
  const getPreflightHandler = () => {
    const layer = stack.find((l: any) => l.route?.path === '/risk/live/activation/preflight' && l.route?.methods?.get);
    assert(layer !== undefined, 'Found /risk/live/activation/preflight route handler');
    return layer.route.stack[0].handle;
  };
  const getControlHandler = () => {
    const layer = stack.find((l: any) => l.route?.path === '/risk/recording/control' && l.route?.methods?.post);
    assert(layer !== undefined, 'Found /risk/recording/control route handler');
    return layer.route.stack[0].handle;
  };

  const preflightHandler = getPreflightHandler();
  const controlHandler = getControlHandler();

  function createMockRes() {
    let captured: { code: number; data?: any } = { code: 200 };
    const res: any = {
      status: (code: number) => {
        captured.code = code;
        return res;
      },
      json: (data: any) => {
        captured.data = data;
        return res;
      },
      setHeader: () => res,
      end: (payloadStr?: string) => {
        if (payloadStr) {
          try {
            captured.data = JSON.parse(payloadStr);
          } catch {
            captured.data = payloadStr;
          }
        }
        return res;
      },
    };
    return { res, getCaptured: () => captured };
  }

  const testUser = 'phase11a_firebase_user';

  // --------------------------------------------------------------------------
  // TEST 1: Unauthenticated preflight request returns 401
  // --------------------------------------------------------------------------
  console.log('[Test 1] Unauthenticated preflight request returns HTTP 401');
  {
    const req: any = { headers: {}, query: {} };
    const { res, getCaptured } = createMockRes();
    await preflightHandler(req, res, () => {});
    const captured = getCaptured();
    assert.equal(captured.code, 401, 'Unauthenticated preflight returns 401');
    assert.equal(captured.data?.error, 'UNAUTHENTICATED');
    console.log('  ✓ PASSED: Unauthenticated preflight strictly rejected with 401');
  }

  // --------------------------------------------------------------------------
  // TEST 2: Authenticated disconnected user → preflight not ready with blockers
  // --------------------------------------------------------------------------
  console.log('[Test 2] Authenticated disconnected user preflight reports not ready with blockers');
  {
    // Disconnect user
    await ZerodhaCredentialManager.disconnect(testUser);

    const req: any = {
      headers: { 'x-user-id': testUser },
      query: {},
    };
    const { res, getCaptured } = createMockRes();
    await preflightHandler(req, res, () => {});
    const captured = getCaptured();

    assert.equal(captured.code, 200, 'Preflight evaluation executes cleanly');
    assert.equal(captured.data?.ready, false, 'Preflight ready is false for disconnected user');
    assert.equal(captured.data?.brokerAuthenticated, false, 'brokerAuthenticated is false');
    assert(captured.data?.blockers?.length > 0, 'Blockers list is populated');
    assert(
      captured.data?.blockers.some((b: string) => b.includes('Zerodha broker authentication')),
      'Blockers identifies missing Zerodha authentication'
    );
    console.log('  ✓ PASSED: Disconnected user preflight accurately reports not ready with blockers');
  }

  // --------------------------------------------------------------------------
  // TEST 3: Config validation rejects invalid dailyLossLimit
  // --------------------------------------------------------------------------
  console.log('[Test 3] ServerRiskStore rejects invalid RiskConfig submit');
  {
    // Save valid Zerodha session
    await ZerodhaSessionStore.saveSession(testUser, 'test_access_token_123', {
      brokerUserId: 'ZU1111',
    });

    // Attempt to set invalid RiskConfig (dailyLossLimit <= 0)
    const saveRes = await ServerRiskStore.saveConfig(testUser, {
      dailyLossLimit: 0,
      warningThreshold1: 70,
      warningThreshold2: 85,
      lockDurationMinutes: 120,
      enabled: true,
    });

    assert.equal(saveRes.success, false, 'saveConfig rejects dailyLossLimit 0');
    assert(saveRes.errors?.length! > 0, 'saveConfig returns validation errors');
    console.log('  ✓ PASSED: Invalid RiskConfig submission strictly rejected by ServerRiskStore');
  }

  // --------------------------------------------------------------------------
  // TEST 3B: Fully valid authenticated account + valid RiskConfig → ready
  // --------------------------------------------------------------------------
  console.log('[Test 3B] Fully valid authenticated Zerodha account + valid RiskConfig → preflight ready');
  {
    // Attach mock fetch handler to LiveZerodhaAdapter
    const mockKiteFetch = async (url: string, opts?: any): Promise<any> => {
      if (url.includes('/user/profile')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            status: 'success',
            data: { user_id: 'ZU1111', user_name: 'Test Trader' },
          }),
        };
      }
      if (url.includes('/portfolio/positions')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            status: 'success',
            data: { net: [], day: [] },
          }),
        };
      }
      if (url.includes('/instruments')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => [],
        };
      }
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
    };

    BrokerService.getLiveAdapter().setFetchHandler(mockKiteFetch);

    // Restore valid RiskConfig
    await ServerRiskStore.saveConfig(testUser, {
      dailyLossLimit: 5000,
      warningThreshold1: 70,
      warningThreshold2: 85,
      lockDurationMinutes: 120,
      enabled: true,
    });

    const preflight = await ActivationGuardService.evaluatePreflight(testUser);
    if (!preflight.ready) {
      console.log('Test 3B blockers:', preflight.blockers);
    }
    assert.equal(preflight.ready, true, 'Preflight ready is true when all checks pass');
    assert.equal(preflight.brokerAuthenticated, true, 'brokerAuthenticated is true');
    assert.equal(preflight.livePnlValidated, true, 'livePnlValidated is true');
    assert.equal(preflight.riskConfigValid, true, 'riskConfigValid is true');
    assert.equal(preflight.riskSessionAvailable, true, 'riskSessionAvailable is true');
    assert.equal(preflight.blockers.length, 0, 'Blockers list is empty');
    console.log('  ✓ PASSED: Valid account and RiskConfig evaluates to ready with zero blockers');
  }

  // --------------------------------------------------------------------------
  // TEST 4: Preflight does NOT mutate RiskSession
  // --------------------------------------------------------------------------
  console.log('[Test 4] Preflight is strictly read-only and does NOT mutate RiskSession');
  {
    const sessionBefore = await ServerRiskStore.getSession(testUser);
    const sessionBeforeJson = JSON.stringify(sessionBefore);

    await ActivationGuardService.evaluatePreflight(testUser);

    const sessionAfter = await ServerRiskStore.getSession(testUser);
    const sessionAfterJson = JSON.stringify(sessionAfter);

    assert.equal(sessionAfterJson, sessionBeforeJson, 'RiskSession is 100% byte-for-byte unmutated by preflight');
    console.log('  ✓ PASSED: Preflight causes zero RiskSession mutations');
  }

  // --------------------------------------------------------------------------
  // TEST 5: Preflight does NOT create riskEvents
  // --------------------------------------------------------------------------
  console.log('[Test 5] Preflight causes zero riskEvents or audit log writes');
  {
    const eventsBefore = await ServerRiskStore.getAuditEvents(testUser);
    const countBefore = eventsBefore.length;

    await ActivationGuardService.evaluatePreflight(testUser);

    const eventsAfter = await ServerRiskStore.getAuditEvents(testUser);
    assert.equal(eventsAfter.length, countBefore, 'Zero riskEvents written during preflight');
    console.log('  ✓ PASSED: Preflight creates zero riskEvents');
  }

  // --------------------------------------------------------------------------
  // TEST 6: Preflight does NOT enable recording
  // --------------------------------------------------------------------------
  console.log('[Test 6] Preflight does NOT modify or enable liveRiskStateRecordingEnabled');
  {
    setLiveRiskStateRecordingEnabled(false);
    assert.equal(getLiveRiskStateRecordingEnabled(), false, 'Pre-condition: recording is false');

    await ActivationGuardService.evaluatePreflight(testUser);

    assert.equal(getLiveRiskStateRecordingEnabled(), false, 'Post-condition: recording remains strictly false');
    console.log('  ✓ PASSED: Preflight does not enable live risk state recording');
  }

  // --------------------------------------------------------------------------
  // TEST 7: Activation rejected when preflight has blockers
  // --------------------------------------------------------------------------
  console.log('[Test 7] Activation POST request rejected with PREFLIGHT_CHECK_FAILED when preflight has blockers');
  {
    setLiveRiskStateRecordingEnabled(false);
    // Disconnect Zerodha to ensure preflight has blockers
    await ZerodhaCredentialManager.disconnect(testUser);

    const req: any = {
      headers: { 'x-user-id': testUser },
      body: { enabled: true },
    };
    const { res, getCaptured } = createMockRes();
    await controlHandler(req, res, () => {});
    const captured = getCaptured();

    assert.equal(captured.code, 400, 'Activation with blockers returns 400');
    assert.equal(captured.data?.success, false, 'Success is false');
    assert.equal(captured.data?.error, 'PREFLIGHT_CHECK_FAILED', 'Error code is PREFLIGHT_CHECK_FAILED');
    assert(captured.data?.blockers?.length > 0, 'Blockers list returned in response');
    assert.equal(getLiveRiskStateRecordingEnabled(), false, 'Recording flag remains strictly false after rejected activation');
    console.log('  ✓ PASSED: Activation strictly rejected when preflight blockers exist');
  }

  // --------------------------------------------------------------------------
  // TEST 8: Activation requires explicit boolean enabled field
  // --------------------------------------------------------------------------
  console.log('[Test 8] Activation request without boolean enabled field is rejected');
  {
    const req: any = {
      headers: { 'x-user-id': testUser },
      body: {}, // missing enabled
    };
    const { res, getCaptured } = createMockRes();
    await controlHandler(req, res, () => {});
    const captured = getCaptured();

    assert.equal(captured.code, 400, 'Missing enabled returns 400');
    assert.equal(captured.data?.error, 'INVALID_REQUEST');
    console.log('  ✓ PASSED: Activation without explicit boolean enabled field rejected with INVALID_REQUEST');
  }

  // --------------------------------------------------------------------------
  // TEST 9: Activation is user-scoped and rejects default_trader in production
  // --------------------------------------------------------------------------
  console.log('[Test 9] Activation is user-scoped and rejects default_trader in production');
  {
    const req: any = {
      headers: {}, // no user header
      body: { enabled: true },
    };
    const { res, getCaptured } = createMockRes();
    await controlHandler(req, res, () => {});
    const captured = getCaptured();

    assert.equal(captured.code, 401, 'Unauthenticated control request returns 401');
    assert.equal(captured.data?.error, 'UNAUTHENTICATED');
    console.log('  ✓ PASSED: Unauthenticated control request strictly rejected');
  }

  // --------------------------------------------------------------------------
  // TEST 10: Pure read-only safety boundary: zero order/trading APIs
  // --------------------------------------------------------------------------
  console.log('[Test 10] Safety boundary: zero order/trading APIs exist in LiveZerodhaAdapter');
  {
    const adapter = new LiveZerodhaAdapter();
    assert.equal(typeof (adapter as any).placeOrder, 'undefined', 'No placeOrder');
    assert.equal(typeof (adapter as any).modifyOrder, 'undefined', 'No modifyOrder');
    assert.equal(typeof (adapter as any).cancelOrder, 'undefined', 'No cancelOrder');
    assert.equal(typeof (adapter as any).squareOff, 'undefined', 'No squareOff');
    console.log('  ✓ PASSED: Pure read-only safety boundary strictly maintained');
  }

  // --------------------------------------------------------------------------
  // TEST 11: Recording remains OFF after test suite
  // --------------------------------------------------------------------------
  console.log('[Test 11] Confirmation: liveRiskStateRecordingEnabled remains OFF after test suite');
  {
    assert.equal(getLiveRiskStateRecordingEnabled(), false, 'Recording flag is strictly false after test suite');
    console.log('  ✓ PASSED: liveRiskStateRecordingEnabled = false confirmed');
  }

  // Cleanup
  process.env.NODE_ENV = originalNodeEnv;
  process.env.ZERODHA_API_KEY = originalApiKey;
  process.env.ZERODHA_API_SECRET = originalApiSecret;

  console.log('\n================================================================');
  console.log('ALL 11 PHASE 11A ACTIVATION GUARD TESTS PASSED (11/11)');
  console.log('================================================================\n');
}

runPhase11aTestSuite().catch((err) => {
  console.error('Phase 11A Test Suite Error:', err);
  process.exit(1);
});
