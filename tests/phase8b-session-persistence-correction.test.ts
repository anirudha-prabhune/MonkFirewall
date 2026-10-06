/**
 * TRADING FIREWALL — PHASE 8B VERIFICATION SUITE
 * Session Persistence Correction, OAuth User Binding & Fail-Closed Guard Verification
 *
 * All 10 Required Test Dimensions:
 * 1. Firestore persistence success
 * 2. Firestore permission/persistence failure => SESSION_PERSISTENCE_ERROR
 * 3. No successful AUTHENTICATED state when persistence fails
 * 4. Process restart does not lose persisted session
 * 5. Signed OAuth state binds callback to initiating user
 * 6. Invalid/tampered state rejected
 * 7. Callback cannot choose arbitrary userId
 * 8. Production callback does not use default_trader
 * 9. runtimeSession remains client-inaccessible
 * 10. Existing sessionVersion invalidation guard remains intact
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  ZerodhaSessionStore,
  SessionPersistenceError,
  enableMockStoreForTesting,
  setAdminFirestoreForTesting,
  clearMockStore,
} from '../server/brokers/zerodha/sessionStore';
import { ZerodhaCredentialManager, HttpFetchFn } from '../server/brokers/zerodha/credentials';
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

async function runPhase8bTestSuite() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: PHASE 8B VERIFICATION SUITE');
  console.log('Session Persistence Correction, OAuth Binding & Fail-Closed Auth');
  console.log('================================================================\n');

  // Preserve initial environment
  const originalNodeEnv = process.env.NODE_ENV;
  const originalApiKey = process.env.ZERODHA_API_KEY;
  const originalApiSecret = process.env.ZERODHA_API_SECRET;

  process.env.ZERODHA_API_KEY = 'test_api_key_16char';
  process.env.ZERODHA_API_SECRET = 'test_api_secret_32chars_long___';

  const testUser = 'user_trader_test_8b';
  const testToken = 'live_kite_access_token_8b_secure_xyz';

  try {
    // --------------------------------------------------------------------------
    // TEST 1: FIRESTORE PERSISTENCE SUCCESS
    // --------------------------------------------------------------------------
    console.log('[Test 1] Firestore persistence success with mocked Firestore instance');
    enableMockStoreForTesting(false);

    // Mock Firestore backing store
    const firestoreStorage = new Map<string, any>();
    const mockDbSuccess: any = {
      doc: (docPath: string) => ({
        get: async () => ({
          exists: firestoreStorage.has(docPath),
          data: () => firestoreStorage.get(docPath),
        }),
      }),
      runTransaction: async (updateFn: (tx: any) => Promise<any>) => {
        const txMock = {
          get: async (docRef: any) => {
            const p = docRef;
            return {
              exists: firestoreStorage.has(docRef._path || 'test'),
              data: () => firestoreStorage.get(docRef._path || 'test'),
            };
          },
          set: (docRef: any, data: any) => {
            firestoreStorage.set(docRef._path || 'test', data);
          },
          update: (docRef: any, data: any) => {
            const existing = firestoreStorage.get(docRef._path || 'test') || {};
            firestoreStorage.set(docRef._path || 'test', { ...existing, ...data });
          },
        };

        // Create wrapped doc ref that tracks path
        return await updateFn({
          get: async (ref: any) => ({
            exists: firestoreStorage.has(ref.path),
            data: () => firestoreStorage.get(ref.path),
          }),
          set: (ref: any, data: any) => {
            firestoreStorage.set(ref.path, data);
          },
          update: (ref: any, data: any) => {
            const cur = firestoreStorage.get(ref.path) || {};
            firestoreStorage.set(ref.path, { ...cur, ...data });
          },
        });
      },
    };

    // Enhance mockDb to include path in doc()
    mockDbSuccess.doc = (docPath: string) => ({
      path: docPath,
      get: async () => ({
        exists: firestoreStorage.has(docPath),
        data: () => firestoreStorage.get(docPath),
      }),
    });

    setAdminFirestoreForTesting(mockDbSuccess);

    const saveResult = await ZerodhaSessionStore.saveSession(testUser, testToken, {
      brokerUserId: 'ZR8B01',
    });

    assert(saveResult.sessionVersion === 1, 'Initial sessionVersion is 1');
    assert(typeof saveResult.expiresAt === 'string', 'expiresAt is returned');
    assert(firestoreStorage.size === 1, 'Document written to authoritative Firestore');

    const expectedDocPath = ZerodhaSessionStore.getSessionDocPath(testUser);
    const storedDoc = firestoreStorage.get(expectedDocPath);
    assert(storedDoc !== undefined, 'Stored document exists in Firestore map');
    assert(storedDoc.authState === 'AUTHENTICATED', 'Document authState is AUTHENTICATED');
    assert(storedDoc.encryptedToken.ciphertext !== undefined, 'Token is encrypted');
    assert((storedDoc as any).accessToken === undefined, 'Plaintext accessToken is NEVER stored');

    // --------------------------------------------------------------------------
    // TEST 2: FIRESTORE PERMISSION/PERSISTENCE FAILURE => SESSION_PERSISTENCE_ERROR
    // --------------------------------------------------------------------------
    console.log('\n[Test 2] Firestore permission/persistence failure throws SessionPersistenceError');
    const mockDbPermissionDenied: any = {
      doc: (docPath: string) => ({
        path: docPath,
        get: async () => {
          throw new Error('7 PERMISSION_DENIED: Missing or insufficient permissions.');
        },
      }),
      runTransaction: async () => {
        throw new Error('7 PERMISSION_DENIED: Missing or insufficient permissions.');
      },
    };

    setAdminFirestoreForTesting(mockDbPermissionDenied);

    let threwPersistenceError = false;
    try {
      await ZerodhaSessionStore.saveSession('user_failing_write', 'token_xyz');
    } catch (err) {
      if (err instanceof SessionPersistenceError && err.code === 'SESSION_PERSISTENCE_ERROR') {
        threwPersistenceError = true;
      }
    }
    assert(threwPersistenceError, 'saveSession throws SessionPersistenceError on Firestore write failure');

    // --------------------------------------------------------------------------
    // TEST 3: NO SUCCESSFUL AUTHENTICATED STATE WHEN PERSISTENCE FAILS
    // --------------------------------------------------------------------------
    console.log('\n[Test 3] No successful AUTHENTICATED state when persistence fails (Fail-Closed Auth)');
    const mockKiteFetchSuccess = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'success',
        data: {
          user_id: 'ZR8B01',
          access_token: 'live_kite_test_token_fail_closed',
        },
      }),
    });

    // Reset auth state
    ZerodhaCredentialManager.invalidateSession('user_failing_write');
    assert(ZerodhaCredentialManager.getAuthState() === 'AUTHENTICATION_REQUIRED', 'Initial state is AUTHENTICATION_REQUIRED');

    // Attempt token exchange while Firestore write fails
    const failClosedResult = await ZerodhaCredentialManager.exchangeRequestToken(
      'req_token_valid',
      'user_failing_write',
      mockKiteFetchSuccess as any
    );

    assert(failClosedResult.success === false, 'exchangeRequestToken returns success: false');
    assert(
      (failClosedResult.error || '').includes('SESSION_PERSISTENCE_ERROR'),
      'Error explicitly specifies SESSION_PERSISTENCE_ERROR'
    );
    assert(ZerodhaCredentialManager.getActiveAccessToken('user_failing_write') === null, 'No token in RAM cache');
    assert(ZerodhaCredentialManager.getAuthState() === 'AUTHENTICATION_REQUIRED', 'Auth state strictly remains AUTHENTICATION_REQUIRED');

    // --------------------------------------------------------------------------
    // TEST 4: PROCESS RESTART DOES NOT LOSE PERSISTED SESSION
    // --------------------------------------------------------------------------
    console.log('\n[Test 4] Process restart / memory eviction does not lose persisted session');
    setAdminFirestoreForTesting(mockDbSuccess);

    // Persist a valid session in Firestore
    const saveResult4 = await ZerodhaSessionStore.saveSession(testUser, testToken, { brokerUserId: 'ZR8B01' });

    // Simulate process restart: wipe RAM cache and in-memory store completely
    (ZerodhaCredentialManager as any).cachedSession = null; // Clears RAM cache without invalidating Firestore
    clearMockStore();

    // Query session through authoritative loader
    const loadedAfterRestart = await ZerodhaSessionStore.loadSession(testUser);
    assert(loadedAfterRestart !== null, 'Session successfully loaded from Firestore after process restart');
    assert(loadedAfterRestart?.accessToken === testToken, 'Decrypted access_token matches original token');
    assert(loadedAfterRestart?.sessionVersion === saveResult4.sessionVersion, 'sessionVersion matches stored version');
    assert(loadedAfterRestart?.isExpired === false, 'Session is not expired');

    // --------------------------------------------------------------------------
    // TEST 5: SIGNED OAUTH STATE BINDS CALLBACK TO INITIATING USER
    // --------------------------------------------------------------------------
    console.log('\n[Test 5] Signed OAuth state binds callback to initiating user');
    const initiatingUser = 'anirudha.prabhune@gmail.com';
    const signedState = ZerodhaCredentialManager.createOAuthState(initiatingUser);
    assert(typeof signedState === 'string' && signedState.length > 20, 'Generated signed state string');

    const verifyResult = ZerodhaCredentialManager.verifyOAuthState(signedState);
    assert(verifyResult.valid === true, 'Signed state is valid');
    assert(verifyResult.userId === initiatingUser, 'Verified userId matches initiating user');

    const loginRes = ZerodhaCredentialManager.getLoginUrlWithState('https://example.com/callback', initiatingUser);
    assert(loginRes.state !== undefined, 'getLoginUrlWithState generates signed state');
    assert(loginRes.url.includes(`state=${encodeURIComponent(loginRes.state!)}`), 'Kite login URL contains state parameter');
    assert(loginRes.url.includes(`redirect_url=`), 'Login URL includes redirect_url with state');

    // --------------------------------------------------------------------------
    // TEST 6: INVALID / TAMPERED STATE REJECTED
    // --------------------------------------------------------------------------
    console.log('\n[Test 6] Invalid and tampered OAuth state is rejected');
    // Tampered state
    const tamperedState = signedState.slice(0, -6) + 'xxxxxx';
    const tamperedResult = ZerodhaCredentialManager.verifyOAuthState(tamperedState);
    assert(tamperedResult.valid === false, 'Tampered state is rejected');
    assert(
      tamperedResult.error === 'INVALID_STATE_SIGNATURE' || tamperedResult.error === 'MALFORMED_OAUTH_STATE',
      'Tampered state returns signature or malformed error'
    );

    // Empty/missing state
    assert(ZerodhaCredentialManager.verifyOAuthState('').valid === false, 'Empty state is rejected');
    assert(ZerodhaCredentialManager.verifyOAuthState('not-base64-json').valid === false, 'Garbage state is rejected');

    // Expired state test: maxAgeMs = 1 ms
    const expiredState = ZerodhaCredentialManager.createOAuthState(initiatingUser);
    await new Promise((r) => setTimeout(r, 10));
    const expiredResult = ZerodhaCredentialManager.verifyOAuthState(expiredState, 5);
    assert(expiredResult.valid === false, 'Expired state is rejected');
    assert(expiredResult.error === 'EXPIRED_OAUTH_STATE', 'Expired state error code is EXPIRED_OAUTH_STATE');

    // --------------------------------------------------------------------------
    // TEST 7: CALLBACK CANNOT CHOOSE ARBITRARY USERID
    // --------------------------------------------------------------------------
    console.log('\n[Test 7] Callback cannot choose arbitrary userId');
    // Test express route handler behavior
    const mockReqArbitrary: any = {
      query: {
        request_token: 'valid_token_123',
        user_id: 'attacker_chosen_user', // Unsigned arbitrary userId attempt
      },
      headers: {},
      accepts: () => false,
    };
    let capturedResponse: any = null;
    const mockResArbitrary: any = {
      status: (code: number) => {
        capturedResponse = { code };
        return mockResArbitrary;
      },
      json: (data: any) => {
        capturedResponse = { ...capturedResponse, data };
        return mockResArbitrary;
      },
      setHeader: () => mockResArbitrary,
    };

    // Find handleAuthCallback from router
    const stack = (apiRouter as any).stack;
    const callbackLayer = stack.find((l: any) => l.route?.path === '/broker/live/auth/callback' && l.route?.methods?.get);
    assert(callbackLayer !== undefined, 'Found /broker/live/auth/callback route handler in router');
    const routeFn = callbackLayer.route.stack[0].handle;

    await routeFn(mockReqArbitrary, mockResArbitrary, () => {});
    assert(capturedResponse?.code === 400, 'Arbitrary user_id request returns HTTP 400');
    assert(capturedResponse?.data?.error === 'INVALID_OAUTH_STATE', 'Error is INVALID_OAUTH_STATE');

    // --------------------------------------------------------------------------
    // TEST 8: PRODUCTION CALLBACK DOES NOT USE default_trader
    // --------------------------------------------------------------------------
    console.log('\n[Test 8] Production callback strictly requires signed state and rejects default_trader fallback');
    process.env.NODE_ENV = 'production';

    const mockReqProdUnsigned: any = {
      query: {
        request_token: 'valid_token_123',
      },
      headers: {},
      accepts: () => false,
    };
    let capturedProdRes: any = null;
    const mockResProd: any = {
      status: (code: number) => {
        capturedProdRes = { code };
        return mockResProd;
      },
      json: (data: any) => {
        capturedProdRes = { ...capturedProdRes, data };
        return mockResProd;
      },
      setHeader: () => mockResProd,
    };

    await routeFn(mockReqProdUnsigned, mockResProd, () => {});
    assert(capturedProdRes?.code === 400, 'Unsigned production callback returns HTTP 400');
    assert(capturedProdRes?.data?.error === 'MISSING_OAUTH_STATE', 'Error is MISSING_OAUTH_STATE');

    // Reset NODE_ENV
    process.env.NODE_ENV = originalNodeEnv;

    // --------------------------------------------------------------------------
    // TEST 9: runtimeSession REMAINS CLIENT-INACCESSIBLE
    // --------------------------------------------------------------------------
    console.log('\n[Test 9] runtimeSession remains client-inaccessible in firestore.rules');
    const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
    const rulesContent = fs.readFileSync(rulesPath, 'utf8');

    assert(
      rulesContent.includes('match /runtimeSession/{sessionId}'),
      'firestore.rules contains runtimeSession match block'
    );
    assert(
      rulesContent.includes('allow read, write: if false;'),
      'runtimeSession subcollection explicitly has allow read, write: if false'
    );

    // --------------------------------------------------------------------------
    // TEST 10: EXISTING sessionVersion INVALIDATION GUARD REMAINS INTACT
    // --------------------------------------------------------------------------
    console.log('\n[Test 10] Concurrency-guarded sessionVersion invalidation remains intact');
    setAdminFirestoreForTesting(mockDbSuccess);

    const userTest10 = 'user_trader_test_10_versioning';

    // Setup stored session with sessionVersion = 1, then sessionVersion = 2
    const firstSave = await ZerodhaSessionStore.saveSession(userTest10, testToken, { brokerUserId: 'ZR8B01' });
    assert(firstSave.sessionVersion === 1, 'First save is sessionVersion 1');
    const secondSave = await ZerodhaSessionStore.saveSession(userTest10, testToken + '_v2', { brokerUserId: 'ZR8B01' });
    assert(secondSave.sessionVersion === 2, 'Session advanced to sessionVersion 2');

    // Attempt invalidation with outdated version 1
    const staleInvalidation = await ZerodhaSessionStore.invalidateSession(userTest10, 1);
    assert(staleInvalidation.invalidated === false, 'Stale invalidation (v1 vs current v2) is rejected');
    assert(staleInvalidation.preservedNewerVersion === 2, 'Newer version 2 is preserved');

    // Session remains AUTHENTICATED
    const sessionStillValid = await ZerodhaSessionStore.loadSession(userTest10);
    assert(sessionStillValid?.authState === 'AUTHENTICATED', 'Session remains AUTHENTICATED after stale invalidation');

    // Valid invalidation matching version 2
    const matchingInvalidation = await ZerodhaSessionStore.invalidateSession(userTest10, 2);
    assert(matchingInvalidation.invalidated === true, 'Matching version 2 invalidation succeeds');

    const sessionNowInvalid = await ZerodhaSessionStore.loadSession(userTest10);
    assert(sessionNowInvalid?.authState === 'AUTHENTICATION_REQUIRED', 'Session is now AUTHENTICATION_REQUIRED');

    console.log('\n================================================================');
    console.log(`PHASE 8B VERIFICATION COMPLETE: ${passedTests}/${totalTests} tests passed`);
    console.log('================================================================\n');
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.ZERODHA_API_KEY = originalApiKey;
    process.env.ZERODHA_API_SECRET = originalApiSecret;
    enableMockStoreForTesting(true);
    setAdminFirestoreForTesting(null);
  }
}

runPhase8bTestSuite().catch((err) => {
  console.error('Fatal error in Phase 8B test suite:', err);
  process.exit(1);
});
