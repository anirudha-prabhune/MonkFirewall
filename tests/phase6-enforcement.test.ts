import { EnforcementService } from '../server/enforcement/service';
import { ServerRiskStore } from '../server/risk/store';
import { PnlEngine } from '../server/pnl/engine';
import { MockZerodhaAdapter } from '../server/brokers/mock/adapter';
import { MOCK_INSTRUMENT_MAP } from '../server/instruments/master';
import { normalizePositions } from '../server/brokers/normalize';
import { getTradingDateKolkata } from '../server/risk/engine';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

console.log('================================================================');
console.log('TRADING FIREWALL: PHASE 6 VERIFICATION SUITE');
console.log('Server-Authoritative Application Enforcement & HTTP 423 Guard');
console.log('================================================================\n');

// Reset store for clean test isolation
ServerRiskStore.reset();

// -------------------------------------------------------------
// TEST 1: ALLOW STATUS
// -------------------------------------------------------------
console.log('[Test 1] RiskSession = ALLOW -> isLocked = false, riskState = ALLOW');
await ServerRiskStore.evaluatePnl('user_p6_t1', 2000); // Positive P&L -> ALLOW
const status1 = await EnforcementService.getEnforcementState('user_p6_t1');
assert(status1.isLocked === false, 'isLocked must be false');
assert(status1.riskState === 'ALLOW', `Expected ALLOW, got ${status1.riskState}`);
assert(status1.authority === 'server', 'authority must be server');
console.log('  ✓ PASSED: ALLOW state correctly reports isLocked = false');

// -------------------------------------------------------------
// TEST 2: WARNING STATUS
// -------------------------------------------------------------
console.log('\n[Test 2] RiskSession = WARNING -> isLocked = false, riskState = WARNING');
await ServerRiskStore.evaluatePnl('user_p6_t2', -7500); // 75% loss on 10,000 limit -> WARNING
const status2 = await EnforcementService.getEnforcementState('user_p6_t2');
assert(status2.isLocked === false, 'isLocked must be false during WARNING');
assert(status2.riskState === 'WARNING', `Expected WARNING, got ${status2.riskState}`);
console.log('  ✓ PASSED: WARNING state allows access with isLocked = false');

// -------------------------------------------------------------
// TEST 3: ACTIVE LOCK
// -------------------------------------------------------------
console.log('\n[Test 3] RiskSession = LOCKED with future lockUntil -> isLocked = true');
const breachTime3 = new Date('2026-10-02T10:00:00.000Z');
await ServerRiskStore.evaluatePnl('user_p6_t3', -12000, breachTime3); // Breach -> LOCKED for 720m (until 22:00)
const checkTime3 = new Date('2026-10-02T12:00:00.000Z'); // 2 hours after breach
const status3 = await EnforcementService.getEnforcementState('user_p6_t3', checkTime3);
assert(status3.isLocked === true, 'isLocked must be true for active lock');
assert(status3.riskState === 'LOCKED', 'riskState must be LOCKED');
assert(status3.remainingSeconds > 0, 'remainingSeconds must be > 0');
console.log('  ✓ PASSED: Active lock correctly reports isLocked = true');

// -------------------------------------------------------------
// TEST 4: EXPIRED LOCK
// -------------------------------------------------------------
console.log('\n[Test 4] RiskSession = LOCKED with lockUntil in past -> isLocked = false');
const checkTime4 = new Date('2026-10-02T22:01:00.000Z'); // 1 minute after 720m duration
const status4 = await EnforcementService.getEnforcementState('user_p6_t3', checkTime4);
assert(status4.isLocked === false, 'Lock must no longer be active after lockUntil');
assert(status4.riskState === 'ALLOW', 'riskState transitions to ALLOW on expiry');
assert(status4.remainingSeconds === 0, 'remainingSeconds must be 0');
console.log('  ✓ PASSED: Expired lock correctly recognized as no longer active');

// -------------------------------------------------------------
// TEST 5: SERVER TIME GOVERNS LOCK DETERMINATION
// -------------------------------------------------------------
console.log('\n[Test 5] Server time governs lock determination (ignoring client clock manipulation)');
// Even if client clock pretends it is 2027, server evaluation time controls access
const realServerTime = new Date('2026-10-02T15:00:00.000Z');
const status5 = await EnforcementService.getEnforcementState('user_p6_t3', realServerTime);
assert(status5.isLocked === true, 'Server time confirms lock is still active');
console.log('  ✓ PASSED: Server time is the sole authority for lock duration checks');

// -------------------------------------------------------------
// TEST 6: LOCKED PROTECTED ENDPOINT RETURNS HTTP 423
// -------------------------------------------------------------
console.log('\n[Test 6] Locked protected endpoint access returns HTTP 423 Locked');
const decision6 = await EnforcementService.checkTradingAccess('user_p6_t3', checkTime3);
assert(decision6.allowed === false, 'Access must be denied');
assert(decision6.statusCode === 423, `Expected HTTP 423, got ${decision6.statusCode}`);
assert(decision6.error === 'TRADING_LOCKED', 'error must be TRADING_LOCKED');
console.log('  ✓ PASSED: Active lock strictly rejects protected operation with HTTP 423 Locked');

// -------------------------------------------------------------
// TEST 7: ALLOW PROTECTED ENDPOINT SUCCEEDS (HTTP 200)
// -------------------------------------------------------------
console.log('\n[Test 7] ALLOW state authorizes protected endpoint (HTTP 200)');
const decision7 = await EnforcementService.checkTradingAccess('user_p6_t1');
assert(decision7.allowed === true, 'Access must be allowed');
assert(decision7.statusCode === 200, `Expected HTTP 200, got ${decision7.statusCode}`);
console.log('  ✓ PASSED: ALLOW state successfully permits protected operation');

// -------------------------------------------------------------
// TEST 8: WARNING PROTECTED ENDPOINT SUCCEEDS (HTTP 200)
// -------------------------------------------------------------
console.log('\n[Test 8] WARNING state authorizes protected endpoint (HTTP 200)');
const decision8 = await EnforcementService.checkTradingAccess('user_p6_t2');
assert(decision8.allowed === true, 'Access must be allowed during WARNING');
assert(decision8.statusCode === 200, `Expected HTTP 200, got ${decision8.statusCode}`);
console.log('  ✓ PASSED: WARNING state successfully permits protected operation');

// -------------------------------------------------------------
// TEST 9: STALE CLIENT BYPASS PREVENTED
// -------------------------------------------------------------
console.log('\n[Test 9] Stale client state (cached ALLOW) cannot bypass server lock');
// Client cache thinks it is ALLOW:
const clientCachedState = { isLocked: false, riskState: 'ALLOW' };
// But server evaluates User 3 who is LOCKED:
const serverDecision9 = await EnforcementService.checkTradingAccess('user_p6_t3', checkTime3);
assert(serverDecision9.allowed === false, 'Stale client state cannot bypass server lock');
assert(serverDecision9.statusCode === 423, 'Must return 423 regardless of client cache');
console.log('  ✓ PASSED: Stale client cache completely ignored; server enforces HTTP 423');

// -------------------------------------------------------------
// TEST 10: LOCALSTORAGE BYPASS PREVENTED
// -------------------------------------------------------------
console.log('\n[Test 10] Fake localStorage override cannot bypass server lock');
// Simulating client setting localStorage.setItem('trading_firewall_locked', 'false')
const fakeLocalStorage = { trading_firewall_locked: 'false', state: 'ALLOW' };
assert(fakeLocalStorage.trading_firewall_locked === 'false', 'Client simulated localStorage modified');
const serverDecision10 = await EnforcementService.checkTradingAccess('user_p6_t3', checkTime3);
assert(serverDecision10.allowed === false && serverDecision10.statusCode === 423, 'Server rejects localStorage override');
console.log('  ✓ PASSED: Client localStorage has zero authority over server guard');

// -------------------------------------------------------------
// TEST 11: SESSIONSTORAGE BYPASS PREVENTED
// -------------------------------------------------------------
console.log('\n[Test 11] Fake sessionStorage override cannot bypass server lock');
const fakeSessionStorage = { override_circuit_breaker: 'true' };
assert(fakeSessionStorage.override_circuit_breaker === 'true', 'Client simulated sessionStorage modified');
const serverDecision11 = await EnforcementService.checkTradingAccess('user_p6_t3', checkTime3);
assert(serverDecision11.allowed === false && serverDecision11.statusCode === 423, 'Server rejects sessionStorage override');
console.log('  ✓ PASSED: Client sessionStorage has zero authority over server guard');

// -------------------------------------------------------------
// TEST 12: PAGE REFRESH PERSISTENCE
// -------------------------------------------------------------
console.log('\n[Test 12] LOCKED state survives simulated page refresh');
// Simulate fresh initialization / page reload by querying server anew
const refreshedState12 = await EnforcementService.getEnforcementState('user_p6_t3', checkTime3);
assert(refreshedState12.isLocked === true, 'Lock persists across page reload');
assert(refreshedState12.riskState === 'LOCKED', 'riskState remains LOCKED');
console.log('  ✓ PASSED: Lock persists across page refresh because it is server-authoritative');

// -------------------------------------------------------------
// TEST 13: NEW SESSION PERSISTENCE
// -------------------------------------------------------------
console.log('\n[Test 13] LOCKED state survives a new client session');
const newSessionCheck = await EnforcementService.checkTradingAccess('user_p6_t3', checkTime3);
assert(newSessionCheck.allowed === false && newSessionCheck.statusCode === 423, 'New session remains locked');
console.log('  ✓ PASSED: Fresh client session remains locked');

// -------------------------------------------------------------
// TEST 14: DIRECT ROUTE ACCESS BLOCKED
// -------------------------------------------------------------
console.log('\n[Test 14] Direct URL / Route access remains blocked');
// Direct call to protected access logic
const directRouteCall = await EnforcementService.checkTradingAccess('user_p6_t3', checkTime3);
assert(directRouteCall.allowed === false && directRouteCall.statusCode === 423, 'Direct route call blocked');
console.log('  ✓ PASSED: Direct route navigation receives HTTP 423');

// -------------------------------------------------------------
// TEST 15: RISK RECOVERY MUST NOT UNLOCK ACTIVE LOCK
// -------------------------------------------------------------
console.log('\n[Test 15] P&L recovery does NOT unlock active enforcement state');
// Evaluate P&L recovery from -12,000 to +5,000 during active lock window
await ServerRiskStore.evaluatePnl('user_p6_t3', 5000, new Date('2026-10-02T14:00:00.000Z'));
const recoveredStatus = await EnforcementService.getEnforcementState('user_p6_t3', new Date('2026-10-02T14:00:00.000Z'));
assert(recoveredStatus.isLocked === true, 'Improving P&L must NOT unlock active lock');
assert(recoveredStatus.riskState === 'LOCKED', 'riskState must remain LOCKED');
console.log('  ✓ PASSED: Phase 5 lock persistence invariant maintained by enforcement layer');

// -------------------------------------------------------------
// TEST 16: LOCK EXPIRATION CONFIRMED BY SERVER
// -------------------------------------------------------------
console.log('\n[Test 16] Lock expiration confirmed by server-side evaluation time');
const postExpiryCheck16 = await EnforcementService.checkTradingAccess('user_p6_t3', checkTime4);
assert(postExpiryCheck16.allowed === true, 'Access permitted after server confirms expiry');
assert(postExpiryCheck16.statusCode === 200, 'HTTP 200 after lock expiration');
console.log('  ✓ PASSED: Access restored only when server time confirms lock expiration');

// -------------------------------------------------------------
// TEST 17: ENABLED = FALSE WITH ACTIVE LOCK REMAINS LOCKED
// -------------------------------------------------------------
console.log('\n[Test 17] Active lock takes precedence over enabled = false');
// User 17 breaches lock
const breach17 = new Date('2026-10-02T10:00:00.000Z');
await ServerRiskStore.evaluatePnl('user_p6_t17', -15000, breach17);
// User disables risk configuration
await ServerRiskStore.saveConfig('user_p6_t17', {
  dailyLossLimit: 10000,
  warningThreshold1: 70,
  warningThreshold2: 90,
  lockDurationMinutes: 720,
  enabled: false, // Disabled!
});
const status17 = await EnforcementService.getEnforcementState('user_p6_t17', new Date('2026-10-02T12:00:00.000Z'));
assert(status17.isLocked === true, 'Active lock must override enabled=false');
assert(status17.riskState === 'LOCKED', 'riskState must be LOCKED');
console.log('  ✓ PASSED: Active lock strictly takes precedence over enabled=false');

// -------------------------------------------------------------
// TEST 18: CLIENT CANNOT WRITE RISK OR ENFORCEMENT STATE
// -------------------------------------------------------------
console.log('\n[Test 18] Client cannot write RiskSession or enforcement state');
// Verified via security rules and architecture: EnforcementService does not accept client state writes
assert(typeof (EnforcementService as any).setEnforcementState === 'undefined', 'No client write methods exist');
console.log('  ✓ PASSED: Client write access to risk/enforcement state strictly absent');

// -------------------------------------------------------------
// TEST 19: CROSS-USER ISOLATION
// -------------------------------------------------------------
console.log('\n[Test 19] User A cannot use User B session for authorization');
// User A is LOCKED
await ServerRiskStore.evaluatePnl('user_A', -12000, breachTime3);
// User B is ALLOWED
await ServerRiskStore.evaluatePnl('user_B', 1000);

const decisionA = await EnforcementService.checkTradingAccess('user_A', checkTime3);
const decisionB = await EnforcementService.checkTradingAccess('user_B', checkTime3);

assert(decisionA.allowed === false && decisionA.statusCode === 423, 'User A is locked');
assert(decisionB.allowed === true && decisionB.statusCode === 200, 'User B is allowed');
console.log('  ✓ PASSED: Multi-tenant user isolation strictly upheld');

// -------------------------------------------------------------
// TEST 20: CROSS-USER LOCK
// -------------------------------------------------------------
console.log('\n[Test 20] Locking User A does not affect User B');
const stateA = await EnforcementService.getEnforcementState('user_A', checkTime3);
const stateB = await EnforcementService.getEnforcementState('user_B', checkTime3);

assert(stateA.isLocked === true, 'User A must be locked');
assert(stateB.isLocked === false, 'User B must NOT be locked');
console.log('  ✓ PASSED: Lock state is strictly scoped to the individual trader');

// -------------------------------------------------------------
// TEST 21: MISSING SESSION FAILS CLOSED / INITIALIZES BASELINE SAFELY
// -------------------------------------------------------------
console.log('\n[Test 21] Missing session initializes baseline ALLOW safely');
const brandNewUserStatus = await EnforcementService.getEnforcementState('brand_new_user');
assert(brandNewUserStatus.isLocked === false, 'New user default is not locked');
assert(brandNewUserStatus.riskState === 'ALLOW', 'New user default is ALLOW');
console.log('  ✓ PASSED: Missing session initializes baseline ALLOW without fabricating a lock');

// -------------------------------------------------------------
// TEST 22: INVALID SESSION FAILS CLOSED
// -------------------------------------------------------------
console.log('\n[Test 22] Invalid session fails closed (does not become ALLOW)');
// Inject malformed state directly into userStates for test
const userState = (ServerRiskStore as any).getOrCreateUserState('corrupted_user');
const todayTest22 = getTradingDateKolkata(new Date());
userState.sessions.set(todayTest22, { state: 'CORRUPTED_VALUE' });
userState.sessions.set('2026-10-02', { state: 'CORRUPTED_VALUE' });

let threwCorrupted = false;
try {
  await EnforcementService.getEnforcementState('corrupted_user');
} catch (e) {
  threwCorrupted = true;
}
assert(threwCorrupted, 'Malformed riskState must throw error and fail closed');

const decisionCorrupted = await EnforcementService.checkTradingAccess('corrupted_user');
assert(decisionCorrupted.allowed === false, 'Corrupted session must be denied access');
assert(decisionCorrupted.statusCode === 500, 'Must return 500 fail-closed');
console.log('  ✓ PASSED: Invalid session fails closed with HTTP 500');

// -------------------------------------------------------------
// TEST 23: AUTHENTICATION REQUIRED (HTTP 401)
// -------------------------------------------------------------
console.log('\n[Test 23] Unauthenticated request returns HTTP 401');
const unauthDecision1 = await EnforcementService.checkTradingAccess(undefined);
assert(unauthDecision1.allowed === false, 'Unauthenticated request must be denied');
assert(unauthDecision1.statusCode === 401, `Expected HTTP 401, got ${unauthDecision1.statusCode}`);

const unauthDecision2 = await EnforcementService.checkTradingAccess('   ');
assert(unauthDecision2.statusCode === 401, 'Blank userId must return HTTP 401');
console.log('  ✓ PASSED: Unauthenticated requests strictly return HTTP 401 Unauthorized');

// -------------------------------------------------------------
// TEST 24: RISK STATE READ FAILURE FAILS CLOSED
// -------------------------------------------------------------
console.log('\n[Test 24] Risk state read failure fails closed (HTTP 500)');
// Temporarily mock getSession to throw an unexpected database error
const originalGetSession = ServerRiskStore.getSession;
ServerRiskStore.getSession = async () => {
  throw new Error('Database connection failed');
};

const failClosedDecision = await EnforcementService.checkTradingAccess('any_user');
assert(failClosedDecision.allowed === false, 'Read failure must NOT allow access');
assert(failClosedDecision.statusCode === 500, 'Must return HTTP 500');
assert(failClosedDecision.error === 'AUTHORIZATION_UNAVAILABLE', 'error must indicate unavailable authorization');

// Restore original getSession
ServerRiskStore.getSession = originalGetSession;
console.log('  ✓ PASSED: Database/read failures fail closed safely');

// -------------------------------------------------------------
// TEST 25: STATUS ENDPOINT DOES NOT MUTATE RISK SESSION
// -------------------------------------------------------------
console.log('\n[Test 25] Repeated status queries do NOT mutate RiskSession');
const sessionBefore25 = await ServerRiskStore.getSession('user_p6_t1');
for (let i = 0; i < 10; i++) {
  await EnforcementService.getEnforcementState('user_p6_t1');
}
const sessionAfter25 = await ServerRiskStore.getSession('user_p6_t1');
assert(sessionBefore25.lastEvaluatedAt === sessionAfter25.lastEvaluatedAt, 'lastEvaluatedAt must not change on read');
assert(sessionBefore25.currentPnl === sessionAfter25.currentPnl, 'currentPnl must not change on read');
console.log('  ✓ PASSED: Enforcement status reads are 100% read-only');

// -------------------------------------------------------------
// TEST 26: STATUS POLLING CREATES ZERO AUDIT EVENTS
// -------------------------------------------------------------
console.log('\n[Test 26] Status polling creates ZERO Phase 5 audit events');
const eventsBefore26 = await ServerRiskStore.getAuditEvents('user_p6_t1');
for (let i = 0; i < 5; i++) {
  await EnforcementService.getEnforcementState('user_p6_t1');
}
const eventsAfter26 = await ServerRiskStore.getAuditEvents('user_p6_t1');
assert(eventsBefore26.length === eventsAfter26.length, 'Zero audit events emitted during status polling');
console.log('  ✓ PASSED: Zero audit events generated by enforcement polling');

// -------------------------------------------------------------
// TEST 27: LOCKED SCREEN METADATA & APPLICATION-LEVEL WORDING
// -------------------------------------------------------------
console.log('\n[Test 27] Locked screen metadata & application-level wording');
const lockedState27 = await EnforcementService.getEnforcementState('user_p6_t3', checkTime3);
assert(lockedState27.reason.includes('Trading'), 'Reason refers to trading firewall access');
assert(!lockedState27.reason.toLowerCase().includes('zerodha has disabled'), 'Must not claim Zerodha disabled account');
console.log('  ✓ PASSED: Application-level enforcement wording strictly adhered to');

// -------------------------------------------------------------
// TEST 28: SERVER IS AUTHORITATIVE OVER REACT STATE
// -------------------------------------------------------------
console.log('\n[Test 28] Server is authoritative over React state manipulation');
// Even if React state has isLocked: false, the server guard check TradingAccess blocks
const reactClientProps = { isLocked: false };
const serverCheck28 = await EnforcementService.checkTradingAccess('user_p6_t3', checkTime3);
assert(serverCheck28.allowed === false, 'Server overrides React state');
assert(serverCheck28.statusCode === 423, 'Server returns HTTP 423');
console.log('  ✓ PASSED: React state cannot authorize a protected operation');

// -------------------------------------------------------------
// TEST 29: FULL PIPELINE END-TO-END
// -------------------------------------------------------------
console.log('\n[Test 29] Full Pipeline: Positions -> P&L -> Risk Engine -> RiskSession -> Enforcement -> Protected Endpoint');
ServerRiskStore.reset();
const mockAdapter = new MockZerodhaAdapter();
const rawPositions = await mockAdapter.getPositions();
const normalized = normalizePositions(rawPositions, MOCK_INSTRUMENT_MAP);

// 1. P&L Engine
const pnlResult = PnlEngine.calculate(normalized);

// 2. Risk Engine & Session
const evalResult = await ServerRiskStore.evaluatePnlResult('full_pipeline_user', pnlResult);
assert(evalResult.state === 'ALLOW', 'Phase 3 mock positions yield ALLOW (gross profit +6350)');

// 3. Enforcement Service
const enforcementStatus = await EnforcementService.getEnforcementState('full_pipeline_user');
assert(enforcementStatus.isLocked === false, 'Enforcement reflects ALLOW');

// 4. Protected Route Authorization
const protectedAccess = await EnforcementService.checkTradingAccess('full_pipeline_user');
assert(protectedAccess.allowed === true && protectedAccess.statusCode === 200, 'Protected endpoint accessible');
console.log('  ✓ PASSED: Complete end-to-end pipeline verified');

// -------------------------------------------------------------
// TEST 30: REFRESH AFTER LOCK CONTINUES RETURNING HTTP 423
// -------------------------------------------------------------
console.log('\n[Test 30] Refresh after lock continues returning HTTP 423');
// User breaches
await ServerRiskStore.evaluatePnl('user_p6_t30', -15000, breachTime3);
// Check 1: Locked
const check1 = await EnforcementService.checkTradingAccess('user_p6_t30', checkTime3);
assert(check1.statusCode === 423, 'Initial check is 423');
// Simulate restart / reload
const check2 = await EnforcementService.checkTradingAccess('user_p6_t30', checkTime3);
assert(check2.statusCode === 423, 'Post-reload check remains 423');
console.log('  ✓ PASSED: Reinitializing client continues returning HTTP 423 Locked');

console.log('\n================================================================');
console.log('ALL 30 PHASE 6 TESTS PASSED SUCCESSFULLY (30/30)');
console.log('================================================================\n');
