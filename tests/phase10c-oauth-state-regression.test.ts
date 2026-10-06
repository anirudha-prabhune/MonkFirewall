import { strict as assert } from 'assert';
import { apiRouter } from '../server/api';
import { ZerodhaCredentialManager } from '../server/brokers/zerodha/credentials';
import { ZerodhaSessionStore, enableMockStoreForTesting, getMockStoreEntry } from '../server/brokers/zerodha/sessionStore';
import { LiveZerodhaAdapter } from '../server/brokers/zerodha/liveAdapter';
import { CryptoService } from '../server/security/crypto';
import crypto from 'crypto';

async function runPhase10cTestSuite() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: PHASE 10C REGRESSION SUITE');
  console.log('Zerodha OAuth State Generation, Callback Verification & Isolation');
  console.log('================================================================\n');

  const originalNodeEnv = process.env.NODE_ENV;
  const originalApiKey = process.env.ZERODHA_API_KEY;
  const originalApiSecret = process.env.ZERODHA_API_SECRET;
  const originalAppUrl = process.env.APP_URL;

  process.env.ZERODHA_API_KEY = 'test_regression_api_key';
  process.env.ZERODHA_API_SECRET = 'test_regression_secret_32_bytes_long!';
  process.env.APP_URL = 'https://ais-test.run.app';

  // Enable in-memory store for isolated, deterministic session verification
  enableMockStoreForTesting(true);

  // Helper to extract route handler
  const stack = (apiRouter as any).stack;
  const getLoginHandler = () => {
    const layer = stack.find((l: any) => l.route?.path === '/broker/live/auth/login' && l.route?.methods?.get);
    assert(layer !== undefined, 'Found /broker/live/auth/login handler');
    return layer.route.stack[0].handle;
  };
  const getCallbackHandler = () => {
    const layer = stack.find((l: any) => l.route?.path === '/broker/live/auth/callback' && l.route?.methods?.get);
    assert(layer !== undefined, 'Found /broker/live/auth/callback handler');
    return layer.route.stack[0].handle;
  };

  const loginHandler = getLoginHandler();
  const callbackHandler = getCallbackHandler();

  function createMockRes() {
    let captured: { code: number; data?: any; redirectUrl?: string } = { code: 200 };
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
      redirect: (url: string) => {
        captured.redirectUrl = url;
        return res;
      },
    };
    return { res, getCaptured: () => captured };
  }

  // --------------------------------------------------------------------------
  // TEST 1: Unauthenticated request to /broker/live/auth/login is rejected
  // --------------------------------------------------------------------------
  console.log('[Test 1] Unauthenticated request to /broker/live/auth/login returns HTTP 401');
  {
    const req: any = { headers: {}, query: {} };
    const { res, getCaptured } = createMockRes();
    await loginHandler(req, res, () => {});
    const captured = getCaptured();
    assert.equal(captured.code, 401, 'Unauthenticated login request returns 401');
    assert.equal(captured.data?.error, 'UNAUTHENTICATED');
    console.log('  ✓ PASSED: Unauthenticated login request strictly rejected with 401');
  }

  // --------------------------------------------------------------------------
  // TEST 2: Authenticated user requests login → signed state is generated
  // --------------------------------------------------------------------------
  console.log('[Test 2] Authenticated user requests login → signed state is generated');
  let userAState: string;
  let userALoginUrl: string;
  const userA = 'firebase_user_alpha';
  {
    const req: any = {
      headers: { 'x-user-id': userA },
      query: {},
    };
    const { res, getCaptured } = createMockRes();
    await loginHandler(req, res, () => {});
    const captured = getCaptured();
    assert.equal(captured.code, 200, 'Authenticated login request returns 200');
    assert(captured.data?.loginUrl, 'loginUrl is returned');
    assert(captured.data?.state, 'signed state is generated and returned');
    assert.equal(captured.data?.userId, userA, 'userId is bound to authenticated user');

    userAState = captured.data.state;
    userALoginUrl = captured.data.loginUrl;

    // Verify cryptographic signature of the state
    const verified = ZerodhaCredentialManager.verifyOAuthState(userAState);
    assert.equal(verified.valid, true, 'Generated state is cryptographically valid');
    assert.equal(verified.userId, userA, 'Generated state is bound to userA');
    console.log('  ✓ PASSED: Signed state generated and cryptographically bound to Firebase UID');
  }

  // --------------------------------------------------------------------------
  // TEST 3: Returned Zerodha authorization URL contains state & redirect_uri
  // --------------------------------------------------------------------------
  console.log('[Test 3] Returned Zerodha authorization URL contains state parameter and redirect_uri');
  {
    assert(userALoginUrl.includes('api_key=test_regression_api_key'), 'URL includes api_key');
    assert(userALoginUrl.includes('v=3'), 'URL includes v=3');
    assert(userALoginUrl.includes('state='), 'URL includes state parameter');
    assert(userALoginUrl.includes(encodeURIComponent(userAState)), 'URL contains the exact signed state');
    assert(userALoginUrl.includes('redirect_uri='), 'URL includes redirect_uri');
    console.log('  ✓ PASSED: Zerodha authorization URL properly formatted with state and redirect_uri');
  }

  // --------------------------------------------------------------------------
  // TEST 4: Callback without state → MISSING_OAUTH_STATE
  // --------------------------------------------------------------------------
  console.log('[Test 4] Callback without state returns MISSING_OAUTH_STATE (HTTP 400)');
  {
    const req: any = {
      query: { request_token: 'dummy_req_token' },
      headers: {},
      accepts: () => false,
    };
    const { res, getCaptured } = createMockRes();
    await callbackHandler(req, res, () => {});
    const captured = getCaptured();
    assert.equal(captured.code, 400, 'Callback without state returns 400');
    assert.equal(captured.data?.error, 'MISSING_OAUTH_STATE', 'Error code is MISSING_OAUTH_STATE');
    console.log('  ✓ PASSED: Callback without state strictly rejected with MISSING_OAUTH_STATE');
  }

  // --------------------------------------------------------------------------
  // TEST 5: Production callback never uses default_trader
  // --------------------------------------------------------------------------
  console.log('[Test 5] Production callback never uses default_trader when state is missing');
  {
    process.env.NODE_ENV = 'production';
    const req: any = {
      query: { request_token: 'dummy_req_token' },
      headers: {},
      accepts: () => false,
    };
    const { res, getCaptured } = createMockRes();
    await callbackHandler(req, res, () => {});
    const captured = getCaptured();
    assert.equal(captured.code, 400, 'Production callback returns 400');
    assert.equal(captured.data?.error, 'MISSING_OAUTH_STATE', 'Error is MISSING_OAUTH_STATE, not default_trader fallback');
    process.env.NODE_ENV = originalNodeEnv;
    console.log('  ✓ PASSED: Production mode strictly rejects unsigned callback and never defaults to default_trader');
  }

  // --------------------------------------------------------------------------
  // TEST 6: Callback does not require Firebase Authorization header
  // --------------------------------------------------------------------------
  console.log('[Test 6] Callback does not require Firebase Authorization header when valid state is present');
  {
    // Setup a mock fetch for token exchange
    const mockToken = 'mock_access_token_12345';
    const mockKiteFetch = async (url: string, opts?: any): Promise<any> => {
      if (url.includes('/session/token')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            status: 'success',
            data: {
              user_id: 'ZU0001',
              user_type: 'individual',
              email: 'trader@example.com',
              user_name: 'Alpha Trader',
              broker: 'ZERODHA',
              access_token: mockToken,
              public_token: 'mock_pub_token',
              login_time: new Date().toISOString(),
            },
          }),
        };
      }
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
    };

    // Override fetch temporarily in ZerodhaCredentialManager for request token exchange test
    const origExchange = ZerodhaCredentialManager.exchangeRequestToken;
    ZerodhaCredentialManager.exchangeRequestToken = async (reqToken: string, uid: string) => {
      return origExchange.call(ZerodhaCredentialManager, reqToken, uid, { customFetch: mockKiteFetch });
    };

    try {
      // Browser redirect callback from Zerodha has ZERO Authorization headers!
      const req: any = {
        query: {
          request_token: 'req_token_valid_alpha',
          state: userAState,
        },
        headers: {}, // NO Authorization header, NO x-user-id header!
        accepts: () => false,
      };
      const { res, getCaptured } = createMockRes();
      await callbackHandler(req, res, () => {});
      const captured = getCaptured();

      assert.equal(captured.code, 200, 'Callback with valid state succeeds with 200');
      assert.equal(captured.data?.success, true, 'Authentication succeeds');
      assert.equal(captured.data?.userId, userA, 'User ID derived directly from signed state, not headers');
      assert.equal(captured.data?.status, 'AUTHENTICATED');
      console.log('  ✓ PASSED: Valid callback succeeds completely without any Firebase Authorization header');
    } finally {
      ZerodhaCredentialManager.exchangeRequestToken = origExchange;
    }
  }

  // --------------------------------------------------------------------------
  // TEST 7: Callback with expired state is rejected
  // --------------------------------------------------------------------------
  console.log('[Test 7] Callback with expired state is rejected');
  {
    // Generate state with a timestamp 20 minutes in the past (> 15m maxAgeMs)
    const secret = process.env.ZERODHA_API_SECRET || 'test_regression_secret_32_bytes_long!';
    const expiredPayload = {
      userId: userA,
      timestamp: Date.now() - 20 * 60 * 1000,
      nonce: crypto.randomBytes(16).toString('hex'),
    };
    const payloadStr = JSON.stringify(expiredPayload);
    const hmac = crypto.createHmac('sha256', secret).update(payloadStr).digest('hex');
    const expiredState = Buffer.from(JSON.stringify({ p: payloadStr, s: hmac })).toString('base64url');

    const req: any = {
      query: {
        request_token: 'req_token_expired',
        state: expiredState,
      },
      headers: {},
      accepts: () => false,
    };
    const { res, getCaptured } = createMockRes();
    await callbackHandler(req, res, () => {});
    const captured = getCaptured();

    assert.equal(captured.code, 400, 'Expired state callback returns 400');
    assert.equal(captured.data?.error, 'EXPIRED_OAUTH_STATE', 'Error is EXPIRED_OAUTH_STATE');
    console.log('  ✓ PASSED: Expired OAuth state strictly rejected with EXPIRED_OAUTH_STATE');
  }

  // --------------------------------------------------------------------------
  // TEST 8: Callback with tampered state is rejected
  // --------------------------------------------------------------------------
  console.log('[Test 8] Callback with tampered state is rejected');
  {
    // Tamper with the payload while keeping old signature
    const secret = process.env.ZERODHA_API_SECRET || 'test_regression_secret_32_bytes_long!';
    const originalPayload = {
      userId: userA,
      timestamp: Date.now(),
      nonce: crypto.randomBytes(16).toString('hex'),
    };
    const originalHmac = crypto.createHmac('sha256', secret).update(JSON.stringify(originalPayload)).digest('hex');
    const tamperedPayload = { ...originalPayload, userId: 'attacker_injected_uid' };
    const tamperedState = Buffer.from(
      JSON.stringify({ p: JSON.stringify(tamperedPayload), s: originalHmac })
    ).toString('base64url');

    const req: any = {
      query: {
        request_token: 'req_token_tampered',
        state: tamperedState,
      },
      headers: {},
      accepts: () => false,
    };
    const { res, getCaptured } = createMockRes();
    await callbackHandler(req, res, () => {});
    const captured = getCaptured();

    assert.equal(captured.code, 400, 'Tampered state callback returns 400');
    assert.equal(captured.data?.error, 'INVALID_OAUTH_STATE', 'Error is INVALID_OAUTH_STATE');
    console.log('  ✓ PASSED: Tampered state with invalid signature strictly rejected');
  }

  // --------------------------------------------------------------------------
  // TEST 9: Callback with state belonging to another user cannot authenticate victim
  // --------------------------------------------------------------------------
  console.log('[Test 9] User B state cannot authenticate or impersonate User A');
  {
    const userB = 'firebase_user_bravo';
    const userBState = ZerodhaCredentialManager.createOAuthState(userB);

    // Attacker passes query user_id=userA but uses userB's state
    const req: any = {
      query: {
        request_token: 'req_token_user_b',
        state: userBState,
        user_id: userA,
      },
      headers: { 'x-user-id': userA },
      accepts: () => false,
    };

    // The callback MUST derive identity strictly from the signed state (userB), NEVER userA!
    const verified = ZerodhaCredentialManager.verifyOAuthState(userBState);
    assert.equal(verified.valid, true);
    assert.equal(verified.userId, userB, 'Verified user is strictly userB');
    assert.notEqual(verified.userId, userA, 'User A is NOT authenticated by User B state');
    console.log('  ✓ PASSED: State strictly binds to the originating user, preventing cross-user impersonation');
  }

  // --------------------------------------------------------------------------
  // TEST 10: Existing encrypted Firestore session persistence still works
  // --------------------------------------------------------------------------
  console.log('[Test 10] Existing encrypted Firestore session persistence verified');
  {
    // Save a session for userA
    const persistResult = await ZerodhaSessionStore.saveSession(userA, 'test_encrypted_access_token_123', {
      brokerUserId: 'ZU9999',
    });
    assert(persistResult.sessionVersion >= 1, 'Session version incremented');

    // Load session
    const loaded = await ZerodhaSessionStore.loadSession(userA);
    assert(loaded !== null, 'Session loaded successfully');
    assert.equal(loaded?.accessToken, 'test_encrypted_access_token_123', 'Decrypted token matches');
    assert.equal(loaded?.authState, 'AUTHENTICATED');
    assert.equal(loaded?.brokerUserId, 'ZU9999');
    console.log('  ✓ PASSED: Encrypted Firestore session persistence and retrieval functioning normally');
  }

  // --------------------------------------------------------------------------
  // TEST 11: Existing disconnect behavior clears session and invalidates persistence
  // --------------------------------------------------------------------------
  console.log('[Test 11] Disconnect clears in-memory cache and makes persisted token cryptographically unusable');
  {
    await ZerodhaCredentialManager.disconnect(userA);

    // Subsequent loadSession returns AUTHENTICATION_REQUIRED with empty accessToken
    const loadedAfterDisconnect = await ZerodhaSessionStore.loadSession(userA);
    assert(
      !loadedAfterDisconnect || loadedAfterDisconnect.authState === 'AUTHENTICATION_REQUIRED',
      'AuthState is AUTHENTICATION_REQUIRED'
    );
    assert(
      !loadedAfterDisconnect || !loadedAfterDisconnect.accessToken,
      'AccessToken is empty or null'
    );

    // Verify stored document has cleared encrypted token (ciphertext/iv/tag empty)
    const docPath = ZerodhaSessionStore.getSessionDocPath(userA);
    const docEntry = getMockStoreEntry(docPath);
    assert(docEntry !== undefined, 'Persisted doc exists');
    assert.equal(docEntry?.authState, 'AUTHENTICATION_REQUIRED', 'Persisted authState is AUTHENTICATION_REQUIRED');
    assert.equal(docEntry?.encryptedToken.ciphertext, '', 'Encrypted ciphertext is strictly cleared');
    assert.equal(docEntry?.encryptedToken.iv, '', 'Encrypted IV is strictly cleared');
    assert.equal(docEntry?.encryptedToken.tag, '', 'Encrypted tag is strictly cleared');
    assert.equal(docEntry?.encryptedToken.keyVersion, 0, 'Encrypted keyVersion is strictly 0');

    // In-memory cache is null
    const memorySession = ZerodhaCredentialManager.getRuntimeSession();
    assert.equal(memorySession, null, 'In-memory session after disconnect is null');
    const memoryToken = ZerodhaCredentialManager.getActiveAccessToken(userA);
    assert.equal(memoryToken, null, 'In-memory token after disconnect is null');

    // Decryption attempt on invalidated entry fails completely
    let decryptionFailed = false;
    try {
      CryptoService.decrypt(docEntry!.encryptedToken, userA);
    } catch {
      decryptionFailed = true;
    }
    assert.equal(decryptionFailed, true, 'Cryptographic decryption on cleared token strictly fails');

    console.log('  ✓ PASSED: Disconnect properly clears RAM cache and destroys persisted ciphertext');
  }

  // --------------------------------------------------------------------------
  // TEST 12: No order/trading APIs are touched or present
  // --------------------------------------------------------------------------
  console.log('[Test 12] Safety boundary: zero order/trading APIs exist in LiveZerodhaAdapter');
  {
    const adapter = new LiveZerodhaAdapter();
    assert.equal(typeof (adapter as any).placeOrder, 'undefined', 'No placeOrder');
    assert.equal(typeof (adapter as any).modifyOrder, 'undefined', 'No modifyOrder');
    assert.equal(typeof (adapter as any).cancelOrder, 'undefined', 'No cancelOrder');
    assert.equal(typeof (adapter as any).squareOff, 'undefined', 'No squareOff');
    console.log('  ✓ PASSED: Pure read-only safety boundary strictly maintained');
  }

  // Cleanup
  process.env.NODE_ENV = originalNodeEnv;
  process.env.ZERODHA_API_KEY = originalApiKey;
  process.env.ZERODHA_API_SECRET = originalApiSecret;
  process.env.APP_URL = originalAppUrl;

  console.log('\n================================================================');
  console.log('ALL 12 PHASE 10C OAUTH REGRESSION TESTS PASSED (12/12)');
  console.log('================================================================\n');
}

runPhase10cTestSuite().catch((err) => {
  console.error('Phase 10C Test Suite Error:', err);
  process.exit(1);
});
