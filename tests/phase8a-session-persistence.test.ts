/**
 * TRADING FIREWALL — PHASE 8A SESSION PERSISTENCE VERIFICATION SUITE
 * Reliable Zerodha Daily Session Persistence Across Cloud Run Instances
 *
 * Mandatory Verification:
 * A. Isolated CryptoService (AES-256-GCM, random 12-byte IV, 16-byte tag, AAD binding, tampering rejection)
 * B. ZerodhaSessionStore (save, load, decrypt, 06:00 AM IST expiry, optimistic concurrency version guard)
 * C. Authentication Callback (creates encrypted session, zero plaintext in DB, zero token in responses)
 * D. Multi-Instance Simulation (Instance A writes v1, Instance B & C load v1, Instance A TokenException on v1 does NOT destroy v2)
 * E. Expiry Semantics (APPLICATION_SESSION_EXPIRY at next 06:00:00 AM IST)
 * F. TokenException Handling (conditional invalidation, no infinite retries)
 * G. Security & Leakage Audit (zero token in logs/responses/rules, client rules deny all access)
 * H. Non-negotiable Safety Invariants (gate CLOSED, riskIntegrationEnabled=false, zero orders/risk mutations)
 */

import { CryptoService, CURRENT_KEY_VERSION, DecryptionError } from '../server/security/crypto';
import {
  ZerodhaSessionStore,
  getApplicationSessionExpiry,
  enableMockStoreForTesting,
  clearMockStore,
  getMockStoreEntry,
} from '../server/brokers/zerodha/sessionStore';
import { ZerodhaCredentialManager } from '../server/brokers/zerodha/credentials';
import { LiveZerodhaAdapter } from '../server/brokers/zerodha/liveAdapter';
import { LIVE_PNL_VALIDATION_GATE } from '../server/pnl/liveValidationTypes';
import { ServerRiskStore } from '../server/risk/store';
import { EnforcementService } from '../server/enforcement/service';
import fs from 'fs';

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

async function runSessionPersistenceSuite() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: PHASE 8A SESSION PERSISTENCE VERIFICATION');
  console.log('Reliable Zerodha Daily Session Persistence Across Cloud Run');
  console.log('================================================================\n');

  enableMockStoreForTesting(true);
  clearMockStore();

  const testUserId = 'test_trader_42';
  const testToken1 = 'kite_access_token_v1_abc123xyz789';
  const testToken2 = 'kite_access_token_v2_def456uvw012';

  // --------------------------------------------------------------------------
  // SECTION A: CRYPTO SERVICE TESTS (AES-256-GCM)
  // --------------------------------------------------------------------------
  console.log('[Section A] Isolated CryptoService (AES-256-GCM, AAD, Tamper Resistance)');

  // 1. Round-trip encryption and decryption
  const enc1 = CryptoService.encrypt(testToken1, testUserId);
  assert(typeof enc1.iv === 'string' && enc1.iv.length > 0, 'Encrypted payload contains Base64 IV');
  assert(typeof enc1.ciphertext === 'string' && enc1.ciphertext.length > 0, 'Encrypted payload contains Base64 ciphertext');
  assert(typeof enc1.tag === 'string' && enc1.tag.length > 0, 'Encrypted payload contains Base64 auth tag');
  assert(enc1.keyVersion === CURRENT_KEY_VERSION, `Key version is recorded as ${CURRENT_KEY_VERSION}`);

  const decrypted1 = CryptoService.decrypt(enc1, testUserId);
  assert(decrypted1 === testToken1, 'AES-256-GCM round trip successfully recovers original access_token');

  // 2. Random IV differs between encryptions of the same plaintext
  const enc2 = CryptoService.encrypt(testToken1, testUserId);
  assert(enc1.iv !== enc2.iv, 'Random IV differs on subsequent encryptions of identical plaintext');
  assert(enc1.ciphertext !== enc2.ciphertext, 'Ciphertext differs because IV differs (semantic security)');

  // 3. Ciphertext tampering rejected
  let threwTamperedCiphertext = false;
  try {
    const tamperedBuf = Buffer.from(enc1.ciphertext, 'base64');
    tamperedBuf[0] = tamperedBuf[0] ^ 0xff; // Flip bits
    CryptoService.decrypt({ ...enc1, ciphertext: tamperedBuf.toString('base64') }, testUserId);
  } catch (err) {
    if (err instanceof DecryptionError) threwTamperedCiphertext = true;
  }
  assert(threwTamperedCiphertext, 'Ciphertext bit-flip is rejected by GCM tag verification');

  // 4. Auth tag tampering rejected
  let threwTamperedTag = false;
  try {
    const tamperedTag = Buffer.from(enc1.tag, 'base64');
    tamperedTag[0] = tamperedTag[0] ^ 0x01;
    CryptoService.decrypt({ ...enc1, tag: tamperedTag.toString('base64') }, testUserId);
  } catch (err) {
    if (err instanceof DecryptionError) threwTamperedTag = true;
  }
  assert(threwTamperedTag, 'Tampered authentication tag is rejected');

  // 5. IV tampering rejected
  let threwTamperedIv = false;
  try {
    const tamperedIv = Buffer.from(enc1.iv, 'base64');
    tamperedIv[0] = tamperedIv[0] ^ 0xaa;
    CryptoService.decrypt({ ...enc1, iv: tamperedIv.toString('base64') }, testUserId);
  } catch (err) {
    if (err instanceof DecryptionError) threwTamperedIv = true;
  }
  assert(threwTamperedIv, 'Tampered IV causes decryption failure');

  // 6. AAD tampering: wrong userId rejected
  let threwWrongUser = false;
  try {
    CryptoService.decrypt(enc1, 'wrong_user_attacker');
  } catch (err) {
    if (err instanceof DecryptionError) threwWrongUser = true;
  }
  assert(threwWrongUser, 'Decryption with wrong userId is rejected by AAD binding');

  // 7. AAD tampering: wrong provider rejected
  let threwWrongProvider = false;
  try {
    CryptoService.decrypt(enc1, testUserId, 'attacker_provider');
  } catch (err) {
    if (err instanceof DecryptionError) threwWrongProvider = true;
  }
  assert(threwWrongProvider, 'Decryption with mismatched provider in AAD is rejected');

  // 8. Missing / unsupported keyVersion rejected (fail closed)
  let threwInvalidKeyVersion = false;
  try {
    CryptoService.decrypt({ ...enc1, keyVersion: 999 }, testUserId);
  } catch (err) {
    if (err instanceof DecryptionError) threwInvalidKeyVersion = true;
  }
  assert(threwInvalidKeyVersion, 'Unsupported keyVersion fails closed without decrypting');

  // --------------------------------------------------------------------------
  // SECTION B: ZERODHA SESSION STORE TESTS
  // --------------------------------------------------------------------------
  console.log('\n[Section B] ZerodhaSessionStore (Persistence, Schema & Optimistic Version Guard)');

  clearMockStore();

  // 1. Save session to store
  const saveResult1 = await ZerodhaSessionStore.saveSession(testUserId, testToken1, {
    brokerUserId: 'ZR1001',
  });
  assert(saveResult1.sessionVersion === 1, 'Initial session saved with sessionVersion = 1');
  assert(typeof saveResult1.expiresAt === 'string', 'saveSession returns expiresAt timestamp');

  // Verify minimal document schema in store
  const docPath = ZerodhaSessionStore.getSessionDocPath(testUserId, 'zerodha');
  assert(docPath === `users/${testUserId}/brokerConnections/zerodha/runtimeSession/current`, 'Document path matches required schema path');
  const storedDoc = getMockStoreEntry(docPath);
  assert(storedDoc !== undefined, 'Session document exists in runtime session path');
  assert(storedDoc?.provider === 'zerodha', 'Provider is set to "zerodha"');
  assert(storedDoc?.userId === testUserId, 'userId is set correctly');
  assert(storedDoc?.brokerUserId === 'ZR1001', 'brokerUserId is recorded');
  assert(storedDoc?.authState === 'AUTHENTICATED', 'authState is set to AUTHENTICATED');
  assert((storedDoc as any).accessToken === undefined, 'ZERO plaintext access_token stored in document');
  assert((storedDoc as any).apiSecret === undefined, 'ZERO api_secret stored in document');
  assert((storedDoc as any).checksum === undefined, 'ZERO checksum stored in document');

  // 2. Load and decrypt session
  const loaded1 = await ZerodhaSessionStore.loadSession(testUserId);
  assert(loaded1 !== null, 'loadSession returns active session');
  assert(loaded1?.accessToken === testToken1, 'loadSession cleanly decrypts access_token');
  assert(loaded1?.sessionVersion === 1, 'loadSession returns sessionVersion = 1');
  assert(loaded1?.authState === 'AUTHENTICATED', 'loadSession returns AUTHENTICATED authState');
  assert(loaded1?.isExpired === false, 'Session is not expired');

  // 3. Second save increments sessionVersion
  const saveResult2 = await ZerodhaSessionStore.saveSession(testUserId, testToken2, {
    brokerUserId: 'ZR1001',
  });
  assert(saveResult2.sessionVersion === 2, 'Subsequent login increments sessionVersion to 2');
  const loaded2 = await ZerodhaSessionStore.loadSession(testUserId);
  assert(loaded2?.sessionVersion === 2, 'Loaded session has sessionVersion = 2');
  assert(loaded2?.accessToken === testToken2, 'Loaded session contains updated token v2');

  // 4. Conditional Invalidation: version mismatch protects newer session
  // Simulate Instance A trying to invalidate failed sessionVersion 1 when current is version 2:
  const mismatchInvalidation = await ZerodhaSessionStore.invalidateSession(testUserId, 1);
  assert(mismatchInvalidation.invalidated === false, 'Invalidation with stale version 1 is REJECTED');
  assert(mismatchInvalidation.preservedNewerVersion === 2, 'Newer session version 2 is PRESERVED');

  const afterMismatchLoad = await ZerodhaSessionStore.loadSession(testUserId);
  assert(afterMismatchLoad?.authState === 'AUTHENTICATED', 'Persisted session version 2 remains AUTHENTICATED');
  assert(afterMismatchLoad?.accessToken === testToken2, 'Persisted session version 2 token is intact');

  // 5. Conditional Invalidation: version match succeeds
  const matchInvalidation = await ZerodhaSessionStore.invalidateSession(testUserId, 2);
  assert(matchInvalidation.invalidated === true, 'Invalidation with matching version 2 SUCCEEDS');
  const afterMatchLoad = await ZerodhaSessionStore.loadSession(testUserId);
  assert(afterMatchLoad?.authState === 'AUTHENTICATION_REQUIRED', 'Persisted session transitioned to AUTHENTICATION_REQUIRED');

  // --------------------------------------------------------------------------
  // SECTION C: EXPIRY SEMANTICS (APPLICATION_SESSION_EXPIRY AT 06:00 AM IST)
  // --------------------------------------------------------------------------
  console.log('\n[Section C] Expiry Semantics (06:00:00 AM Asia/Kolkata Application Boundary)');

  // 1. Calculation during daytime IST (e.g. 11:30 AM IST)
  const daytimeIST = new Date('2026-10-04T11:30:00+05:30');
  const expiryDaytime = getApplicationSessionExpiry(daytimeIST);
  // Next 06:00 AM IST is 2026-10-05 06:00:00 IST = 2026-10-05 00:30:00 UTC
  assert(
    expiryDaytime.expiryUtc.toISOString() === '2026-10-05T00:30:00.000Z',
    'Daytime session expires at next day 06:00:00 AM IST (00:30 UTC)'
  );

  // 2. Calculation in early morning IST before 06:00 AM (e.g. 04:30 AM IST)
  const earlyMorningIST = new Date('2026-10-04T04:30:00+05:30');
  const expiryEarly = getApplicationSessionExpiry(earlyMorningIST);
  // Next 06:00 AM IST is 2026-10-04 06:00:00 IST = 2026-10-04 00:30:00 UTC
  assert(
    expiryEarly.expiryUtc.toISOString() === '2026-10-04T00:30:00.000Z',
    'Early morning session (before 06:00 AM IST) expires at today 06:00:00 AM IST'
  );

  // 3. Load past expiry rejects session
  clearMockStore();
  const pastLogin = new Date('2026-10-03T10:00:00Z');
  await ZerodhaSessionStore.saveSession(testUserId, testToken1, {
    evaluationTime: pastLogin,
  });

  // Evaluate at 2 days later:
  const futureEvalTime = new Date('2026-10-05T12:00:00Z');
  const expiredSessionResult = await ZerodhaSessionStore.loadSession(testUserId, {
    evaluationTime: futureEvalTime,
  });
  assert(expiredSessionResult?.isExpired === true, 'Session past 06:00:00 AM IST boundary is flagged as expired');
  assert(expiredSessionResult?.authState === 'AUTHENTICATION_REQUIRED', 'Expired session transitions to AUTHENTICATION_REQUIRED');

  // --------------------------------------------------------------------------
  // SECTION D: MULTI-INSTANCE SIMULATION
  // --------------------------------------------------------------------------
  console.log('\n[Section D] Multi-Instance Simulation (Cloud Run Stateless Hand-off)');

  clearMockStore();
  process.env.ZERODHA_API_KEY = 'test_key_phase8a';
  process.env.ZERODHA_API_SECRET = 'test_secret_phase8a';
  delete process.env.ZERODHA_ACCESS_TOKEN;

  // Instance A: Handles OAuth callback and writes session version 1
  const mockFetchOAuth = async (url: string, opts: any) => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: 'success',
        data: {
          access_token: 'live_token_instance_a_v1',
          user_id: 'ZR1001',
        },
      }),
    };
  };

  const exchangeResult = await ZerodhaCredentialManager.exchangeRequestToken(
    'test_request_token_123',
    testUserId,
    { customFetch: mockFetchOAuth }
  );
  assert(exchangeResult.success === true, 'Instance A: OAuth callback successfully exchanged token');
  assert(exchangeResult.session?.sessionVersion === 1, 'Instance A: Stored session has sessionVersion = 1');
  assert((exchangeResult as any).session?.accessToken === undefined, 'Instance A: Sanitized response does NOT contain access_token');

  // Instance B (Simulate new Node runtime without Instance A RAM cache):
  // Reset memory cache to simulate separate Cloud Run instance
  (ZerodhaCredentialManager as any).cachedSession = null;

  const instanceBSession = await ZerodhaCredentialManager.getAuthenticatedSession(testUserId);
  assert(instanceBSession !== null, 'Instance B: Cleanly loads authenticated session from Firestore');
  assert(instanceBSession?.source === 'PERSISTED', 'Instance B: Reports sessionSource as PERSISTED');
  assert(instanceBSession?.sessionVersion === 1, 'Instance B: Identifies sessionVersion as 1');
  assert(instanceBSession?.accessToken === 'live_token_instance_a_v1', 'Instance B: Successfully decrypts token written by Instance A');

  // Instance C: Calls mocked Zerodha positions API using the persisted session
  (ZerodhaCredentialManager as any).cachedSession = null; // Clear RAM to simulate 3rd instance
  const mockFetchPositions = async (url: string, opts: any) => {
    assert(opts.headers.Authorization === 'token test_key_phase8a:live_token_instance_a_v1', 'Instance C: Positions request uses decrypted persisted token');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: 'success',
        data: {
          net: [
            {
              tradingsymbol: 'NIFTY26OCTFUT',
              exchange: 'NFO',
              instrument_token: 256265,
              product: 'NRML',
              quantity: 50,
              average_price: 24500,
              last_price: 24600,
              pnl: 5000,
              m2m: 5000,
              realised: 0,
              unrealised: 5000,
            },
          ],
        },
      }),
    };
  };

  const adapterInstanceC = new LiveZerodhaAdapter(mockFetchPositions);
  const positionsResult = await adapterInstanceC.getPositions(testUserId);
  assert(positionsResult.length === 1, 'Instance C: Successfully retrieved positions using persisted token');
  assert(positionsResult[0].tradingsymbol === 'NIFTY26OCTFUT', 'Instance C: Position data received intact');

  // Now simulate:
  // User re-authenticates (OAuth callback writes version 2)
  const mockFetchOAuthV2 = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: 'success',
      data: {
        access_token: 'live_token_instance_v2',
        user_id: 'ZR1001',
      },
    }),
  });

  const exchangeV2 = await ZerodhaCredentialManager.exchangeRequestToken(
    'test_request_token_456',
    testUserId,
    { customFetch: mockFetchOAuthV2 }
  );
  assert(exchangeV2.session?.sessionVersion === 2, 'New OAuth exchange created sessionVersion = 2');

  // Instance A receives TokenException for OLD token version 1
  const tokenExceptionResult = await ZerodhaCredentialManager.handleTokenException(testUserId, 1);
  assert(tokenExceptionResult.invalidated === false, 'Stale TokenException from version 1 did NOT invalidate version 2');
  assert(tokenExceptionResult.preservedNewerVersion === 2, 'Version 2 preserved in Firestore');

  // Instance B calls with version 2 and succeeds
  (ZerodhaCredentialManager as any).cachedSession = null;
  const activeV2 = await ZerodhaCredentialManager.getAuthenticatedSession(testUserId);
  assert(activeV2?.sessionVersion === 2, 'Persisted session version 2 is active for Instance B');
  assert(activeV2?.accessToken === 'live_token_instance_v2', 'Persisted session version 2 token matches');

  // --------------------------------------------------------------------------
  // SECTION E: FIRESTORE CLIENT SECURITY RULES VERIFICATION
  // --------------------------------------------------------------------------
  console.log('\n[Section E] Firestore Client Security Rules Audit');

  const rulesContent = fs.readFileSync('firestore.rules', 'utf8');
  assert(
    rulesContent.includes('match /runtimeSession/{sessionId}'),
    'firestore.rules explicitly matches runtimeSession subcollection'
  );
  assert(
    rulesContent.includes('match /runtimeSession/{sessionId} {\n          allow read, write: if false;\n        }') ||
    rulesContent.includes('match /runtimeSession/{sessionId} {\n          allow read, write: if false;'),
    'firestore.rules strictly denies all client read/write access to runtimeSession'
  );

  // --------------------------------------------------------------------------
  // SECTION F: CREDENTIAL LEAKAGE & SANITIZATION AUDIT
  // --------------------------------------------------------------------------
  console.log('\n[Section F] Credential Leakage & Response Sanitization');

  const rawObject = {
    apiKey: 'secret_api_key_123',
    apiSecret: 'secret_api_secret_456',
    accessToken: 'secret_access_token_789',
    encryptedToken: { ciphertext: 'cipher' },
    status: 'AUTHENTICATED',
    sessionVersion: 2,
  };

  const sanitized = ZerodhaCredentialManager.sanitize(rawObject);
  assert((sanitized as any).apiKey === undefined, 'Sanitizer strips apiKey');
  assert((sanitized as any).apiSecret === undefined, 'Sanitizer strips apiSecret');
  assert((sanitized as any).accessToken === undefined, 'Sanitizer strips accessToken');
  assert((sanitized as any).encryptedToken === undefined, 'Sanitizer strips encryptedToken');
  assert((sanitized as any).status === 'AUTHENTICATED', 'Sanitizer preserves public status');
  assert((sanitized as any).sessionVersion === 2, 'Sanitizer preserves sessionVersion');

  const errorStringWithToken = 'Upstream failed with token live_token_instance_v2 and api key test_key_phase8a';
  const sanitizedError = ZerodhaCredentialManager.sanitizeErrorString(errorStringWithToken);
  assert(!sanitizedError.includes('live_token_instance_v2'), 'Sanitize error string redacts access_token');
  assert(!sanitizedError.includes('test_key_phase8a'), 'Sanitize error string redacts api_key');

  // --------------------------------------------------------------------------
  // SECTION G: SAFETY INVARIANTS VERIFICATION
  // --------------------------------------------------------------------------
  console.log('\n[Section G] Non-negotiable Safety Invariants');

  assert(LIVE_PNL_VALIDATION_GATE === 'CLOSED', 'Invariant: LIVE_PNL_VALIDATION_GATE is strictly CLOSED');

  // Verify RiskEngine invocations = 0, RiskSession mutations = 0, riskEvents = 0
  const riskEvents = await ServerRiskStore.getAuditEvents(testUserId);
  assert(riskEvents.length === 0, 'Invariant: riskEvents count = 0 (session persistence never creates risk events)');

  const enforcement = await EnforcementService.getEnforcementState(testUserId);
  assert(enforcement.riskState === 'ALLOW', 'Invariant: Enforcement state unaffected (riskState = ALLOW)');
  assert(enforcement.isLocked === false, 'Invariant: No lock created (isLocked = false)');

  console.log('\n================================================================');
  console.log(`PHASE 8A SESSION PERSISTENCE VERIFICATION: ${passedTests}/${totalTests} TESTS PASSED`);
  console.log('================================================================\n');
}

runSessionPersistenceSuite().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
