import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  RiskEngine,
  getTradingDateKolkata,
  RiskSession,
  RiskEvent,
} from '../server/risk/engine';
import { validateRiskConfig } from '../server/risk/validation';
import { ServerRiskStore } from '../server/risk/store';
import { DEFAULT_RISK_CONFIG, RiskConfig } from '../src/types/risk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

console.log('================================================================');
console.log('TRADING FIREWALL: PHASE 2 COMPREHENSIVE VERIFICATION SUITE');
console.log('Testing Risk Configuration, Validation, Session State & Lock Lifecycle');
console.log('================================================================\n');

// -------------------------------------------------------------
// TEST 1: Valid default RiskConfig
// -------------------------------------------------------------
console.log('[Test 1] Valid default RiskConfig');
const v1 = validateRiskConfig(DEFAULT_RISK_CONFIG);
assert(v1.valid === true, 'Default config must be valid');
assert(v1.sanitized?.dailyLossLimit === 10000, 'dailyLossLimit must be 10000');
assert(v1.sanitized?.warningThreshold1 === 70, 'warningThreshold1 must be 70');
assert(v1.sanitized?.warningThreshold2 === 90, 'warningThreshold2 must be 90');
assert(v1.sanitized?.lockDurationMinutes === 720, 'lockDurationMinutes must be 720');
assert(v1.sanitized?.enabled === true, 'enabled must be true');
console.log('  ✓ PASSED: Default RiskConfig is fully valid');

// -------------------------------------------------------------
// TEST 2: Reject dailyLossLimit <= 0
// -------------------------------------------------------------
console.log('\n[Test 2] Reject dailyLossLimit <= 0');
const v2a = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, dailyLossLimit: 0 });
assert(v2a.valid === false, 'dailyLossLimit = 0 must be rejected');
const v2b = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, dailyLossLimit: -5000 });
assert(v2b.valid === false, 'dailyLossLimit = -5000 must be rejected');
const v2c = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, dailyLossLimit: NaN });
assert(v2c.valid === false, 'dailyLossLimit = NaN must be rejected');
console.log('  ✓ PASSED: Non-positive and NaN dailyLossLimit rejected');

// -------------------------------------------------------------
// TEST 3: Reject warningThreshold1 <= 0
// -------------------------------------------------------------
console.log('\n[Test 3] Reject warningThreshold1 <= 0');
const v3a = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, warningThreshold1: 0 });
assert(v3a.valid === false, 'warningThreshold1 = 0 must be rejected');
const v3b = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, warningThreshold1: -10 });
assert(v3b.valid === false, 'warningThreshold1 = -10 must be rejected');
console.log('  ✓ PASSED: Non-positive warningThreshold1 rejected');

// -------------------------------------------------------------
// TEST 4: Reject warningThreshold2 <= warningThreshold1
// -------------------------------------------------------------
console.log('\n[Test 4] Reject warningThreshold2 <= warningThreshold1');
const v4a = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, warningThreshold1: 80, warningThreshold2: 80 });
assert(v4a.valid === false, 'Equal thresholds must be rejected');
const v4b = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, warningThreshold1: 90, warningThreshold2: 70 });
assert(v4b.valid === false, 'warningThreshold2 < warningThreshold1 must be rejected');
console.log('  ✓ PASSED: Nonsensical threshold ordering rejected');

// -------------------------------------------------------------
// TEST 5: Reject warningThreshold2 > 100
// -------------------------------------------------------------
console.log('\n[Test 5] Reject warningThreshold2 > 100');
const v5 = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, warningThreshold2: 101 });
assert(v5.valid === false, 'warningThreshold2 > 100 must be rejected');
console.log('  ✓ PASSED: warningThreshold2 > 100 rejected');

// -------------------------------------------------------------
// TEST 6: Reject warningThreshold1 >= 100
// -------------------------------------------------------------
console.log('\n[Test 6] Reject warningThreshold1 >= 100');
const v6a = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, warningThreshold1: 100 });
assert(v6a.valid === false, 'warningThreshold1 = 100 must be rejected');
const v6b = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, warningThreshold1: 105 });
assert(v6b.valid === false, 'warningThreshold1 = 105 must be rejected');
console.log('  ✓ PASSED: warningThreshold1 >= 100 rejected');

// -------------------------------------------------------------
// TEST 7: Reject lockDurationMinutes <= 0
// -------------------------------------------------------------
console.log('\n[Test 7] Reject lockDurationMinutes <= 0');
const v7a = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, lockDurationMinutes: 0 });
assert(v7a.valid === false, 'lockDurationMinutes = 0 must be rejected');
const v7b = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, lockDurationMinutes: -60 });
assert(v7b.valid === false, 'lockDurationMinutes = -60 must be rejected');
console.log('  ✓ PASSED: Non-positive lockDurationMinutes rejected');

// -------------------------------------------------------------
// TEST 8: Reject invalid boolean fields
// -------------------------------------------------------------
console.log('\n[Test 8] Reject invalid boolean fields');
const v8a = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, enabled: 'yes' as any });
assert(v8a.valid === false, 'String enabled must be rejected');
const v8b = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, includeRealisedPnl: 1 as any });
assert(v8b.valid === false, 'Numeric includeRealisedPnl must be rejected');
console.log('  ✓ PASSED: Non-boolean types for boolean fields rejected');

// -------------------------------------------------------------
// TEST 9: ALLOW below warning threshold
// -------------------------------------------------------------
console.log('\n[Test 9] ALLOW below warning threshold');
const evalTime = new Date('2026-10-02T10:00:00.000Z');
const res9 = RiskEngine.evaluate({
  userId: 'user_test',
  config: DEFAULT_RISK_CONFIG,
  pnl: -5000, // 50% used (< 70%)
  evaluationTime: evalTime,
});
assert(res9.session.state === 'ALLOW', `Expected ALLOW, got ${res9.session.state}`);
assert(res9.session.isBreached === false, 'Expected isBreached = false');
console.log('  ✓ PASSED: Loss < 70% evaluates to ALLOW');

// -------------------------------------------------------------
// TEST 10: WARNING at threshold 1
// -------------------------------------------------------------
console.log('\n[Test 10] WARNING at threshold 1');
const res10 = RiskEngine.evaluate({
  userId: 'user_test',
  config: DEFAULT_RISK_CONFIG,
  pnl: -7000, // exactly 70% used
  evaluationTime: evalTime,
});
assert(res10.session.state === 'WARNING', `Expected WARNING, got ${res10.session.state}`);
assert(res10.session.isBreached === false, 'Expected isBreached = false');
assert(res10.transitionEvents.some((e) => e.type === 'RISK_WARNING'), 'Must emit RISK_WARNING event');
console.log('  ✓ PASSED: Loss = 70% evaluates to WARNING with RISK_WARNING event');

// -------------------------------------------------------------
// TEST 11: WARNING at threshold 2
// -------------------------------------------------------------
console.log('\n[Test 11] WARNING at threshold 2');
const res11 = RiskEngine.evaluate({
  userId: 'user_test',
  config: DEFAULT_RISK_CONFIG,
  pnl: -9000, // 90% used
  evaluationTime: evalTime,
});
assert(res11.session.state === 'WARNING', `Expected WARNING, got ${res11.session.state}`);
assert(res11.session.isBreached === false, 'Expected isBreached = false');
console.log('  ✓ PASSED: Loss = 90% evaluates to WARNING');

// -------------------------------------------------------------
// TEST 12: LOCKED at daily loss limit
// -------------------------------------------------------------
console.log('\n[Test 12] LOCKED at daily loss limit');
const res12 = RiskEngine.evaluate({
  userId: 'user_test',
  config: DEFAULT_RISK_CONFIG,
  pnl: -10000, // 100% loss limit
  evaluationTime: evalTime,
});
assert(res12.session.state === 'LOCKED', `Expected LOCKED, got ${res12.session.state}`);
assert(res12.session.isBreached === true, 'Expected isBreached = true');
assert(res12.session.lockedAt === evalTime.toISOString(), 'lockedAt must equal evaluationTime');
assert(res12.session.lockUntil !== null, 'lockUntil must be set');
assert(res12.transitionEvents.some((e) => e.type === 'LOSS_LIMIT_BREACHED'), 'Must emit LOSS_LIMIT_BREACHED');
assert(res12.transitionEvents.some((e) => e.type === 'TRADING_LOCK_CREATED'), 'Must emit TRADING_LOCK_CREATED');
console.log('  ✓ PASSED: Loss = ₹10,000 establishes LOCKED and creates lock events');

// -------------------------------------------------------------
// TEST 13: LOCKED beyond daily loss limit
// -------------------------------------------------------------
console.log('\n[Test 13] LOCKED beyond daily loss limit');
const res13 = RiskEngine.evaluate({
  userId: 'user_test',
  config: DEFAULT_RISK_CONFIG,
  pnl: -12500, // 125%
  evaluationTime: evalTime,
});
assert(res13.session.state === 'LOCKED', `Expected LOCKED, got ${res13.session.state}`);
assert(res13.session.isBreached === true, 'Expected isBreached = true');
console.log('  ✓ PASSED: Loss > ₹10,000 evaluates to LOCKED');

// -------------------------------------------------------------
// Establish active locked session for recovery & persistence tests
// -------------------------------------------------------------
const activeLockSession: RiskSession = { ...res12.session };

// -------------------------------------------------------------
// TEST 14: LOCKED remains LOCKED when P&L improves
// -------------------------------------------------------------
console.log('\n[Test 14] LOCKED remains LOCKED when P&L improves (-₹8,000 & -₹3,000)');
const res14a = RiskEngine.evaluate({
  userId: 'user_test',
  config: DEFAULT_RISK_CONFIG,
  pnl: -8000, // recovered from -10k to -8k
  currentSession: activeLockSession,
  evaluationTime: new Date(evalTime.getTime() + 15 * 60 * 1000),
});
assert(res14a.session.state === 'LOCKED', `P&L -8000 must remain LOCKED, got ${res14a.session.state}`);
assert(res14a.session.isBreached === true, 'Must remain isBreached = true');

const res14b = RiskEngine.evaluate({
  userId: 'user_test',
  config: DEFAULT_RISK_CONFIG,
  pnl: -3000, // recovered to -3k
  currentSession: activeLockSession,
  evaluationTime: new Date(evalTime.getTime() + 30 * 60 * 1000),
});
assert(res14b.session.state === 'LOCKED', `P&L -3000 must remain LOCKED, got ${res14b.session.state}`);
console.log('  ✓ PASSED: Improving P&L strictly does not unlock active lock');

// -------------------------------------------------------------
// TEST 15: LOCKED remains LOCKED when P&L becomes positive
// -------------------------------------------------------------
console.log('\n[Test 15] LOCKED remains LOCKED when P&L becomes positive (+₹2,000)');
const res15 = RiskEngine.evaluate({
  userId: 'user_test',
  config: DEFAULT_RISK_CONFIG,
  pnl: 2000, // in profit
  currentSession: activeLockSession,
  evaluationTime: new Date(evalTime.getTime() + 60 * 60 * 1000),
});
assert(res15.session.state === 'LOCKED', `Positive P&L must remain LOCKED, got ${res15.session.state}`);
assert(res15.session.isBreached === true, 'Must remain isBreached = true');
console.log('  ✓ PASSED: Positive P&L does not unlock session while lockUntil is active');

// -------------------------------------------------------------
// TEST 16: lockedAt is created only on first breach
// -------------------------------------------------------------
console.log('\n[Test 16] lockedAt is created only on first breach');
assert(res12.session.lockedAt === evalTime.toISOString(), 'First breach sets lockedAt');
assert(res14a.session.lockedAt === res12.session.lockedAt, 'Subsequent evaluation preserves original lockedAt');
console.log('  ✓ PASSED: lockedAt timestamp established exclusively on initial breach');

// -------------------------------------------------------------
// TEST 17: lockUntil = lockedAt + configured duration
// -------------------------------------------------------------
console.log('\n[Test 17] lockUntil = lockedAt + configured duration (720 min / 12 hr)');
const expectedUntil = new Date(evalTime.getTime() + 720 * 60 * 1000).toISOString();
assert(res12.session.lockUntil === expectedUntil, `Expected ${expectedUntil}, got ${res12.session.lockUntil}`);
console.log('  ✓ PASSED: lockUntil calculation matches lockedAt + 720 minutes');

// -------------------------------------------------------------
// TEST 18: Repeated evaluation preserves lockedAt
// -------------------------------------------------------------
console.log('\n[Test 18] Repeated evaluation preserves lockedAt');
const res18 = RiskEngine.evaluate({
  userId: 'user_test',
  config: DEFAULT_RISK_CONFIG,
  pnl: -10500,
  currentSession: activeLockSession,
  evaluationTime: new Date(evalTime.getTime() + 10 * 1000),
});
assert(res18.session.lockedAt === activeLockSession.lockedAt, 'lockedAt must not mutate on repeated evaluation');
console.log('  ✓ PASSED: lockedAt is strictly immutable');

// -------------------------------------------------------------
// TEST 19: Repeated evaluation preserves lockUntil
// -------------------------------------------------------------
console.log('\n[Test 19] Repeated evaluation preserves lockUntil');
assert(res18.session.lockUntil === activeLockSession.lockUntil, 'lockUntil must not extend on repeated evaluations');
console.log('  ✓ PASSED: lockUntil is strictly preserved across evaluations');

// -------------------------------------------------------------
// TEST 20: No duplicate lock creation
// -------------------------------------------------------------
console.log('\n[Test 20] No duplicate lock creation events');
assert(res18.transitionEvents.length === 0, 'Polling active lock must produce 0 transition events');
console.log('  ✓ PASSED: Repeated polling does not generate duplicate TRADING_LOCK_CREATED events');

// -------------------------------------------------------------
// TEST 21: Lock expires only when evaluationTime >= lockUntil
// -------------------------------------------------------------
console.log('\n[Test 21] Lock expires only when evaluationTime >= lockUntil');
const beforeExpiry = new Date(new Date(expectedUntil).getTime() - 1000); // 1 sec before
const res21Before = RiskEngine.evaluate({
  userId: 'user_test',
  config: DEFAULT_RISK_CONFIG,
  pnl: 0,
  currentSession: activeLockSession,
  evaluationTime: beforeExpiry,
});
assert(res21Before.session.state === 'LOCKED', 'Must remain LOCKED before lockUntil');

const atExpiry = new Date(new Date(expectedUntil).getTime() + 1000); // 1 sec after
const res21After = RiskEngine.evaluate({
  userId: 'user_test',
  config: DEFAULT_RISK_CONFIG,
  pnl: 0, // Recovered at expiry
  currentSession: activeLockSession,
  evaluationTime: atExpiry,
});
assert(res21After.session.state === 'ALLOW', 'Must transition to ALLOW after lockUntil with 0 loss');
assert(res21After.transitionEvents.some((e) => e.type === 'TRADING_LOCK_EXPIRED'), 'Must emit TRADING_LOCK_EXPIRED event');
console.log('  ✓ PASSED: Lock expires strictly when evaluationTime >= lockUntil');

// -------------------------------------------------------------
// TEST 22: Trading date uses Asia/Kolkata
// -------------------------------------------------------------
console.log('\n[Test 22] Trading date uses Asia/Kolkata');
const kolkataTestDate = new Date('2026-10-02T19:00:00.000Z'); // 00:30 IST on Oct 3rd!
const dateKolkata = getTradingDateKolkata(kolkataTestDate);
assert(dateKolkata === '2026-10-03', `Expected 2026-10-03 in Asia/Kolkata, got ${dateKolkata}`);
console.log('  ✓ PASSED: Trading calendar date correctly evaluated in Asia/Kolkata timezone');

// -------------------------------------------------------------
// TEST 23: Trading date does not control lock expiry
// -------------------------------------------------------------
console.log('\n[Test 23] Trading date does not control lock expiry');
// Breach established at 2026-10-02T14:22:00Z (19:52 IST on Oct 2)
// lockUntil is 2026-10-03T02:22:00Z (07:52 IST on Oct 3)
const breachTime = new Date('2026-10-02T14:22:00.000Z');
const crossMidnightBreach = RiskEngine.evaluate({
  userId: 'user_test',
  config: DEFAULT_RISK_CONFIG,
  pnl: -10000,
  evaluationTime: breachTime,
});
const crossMidnightSession = crossMidnightBreach.session;

// At 2026-10-02T19:00:00Z (00:30 IST next day), trading date has rolled over to 2026-10-03,
// but lockUntil (02:22 UTC) has NOT elapsed!
const midnightRollover = new Date('2026-10-02T19:00:00.000Z');
const res23 = RiskEngine.evaluate({
  userId: 'user_test',
  config: DEFAULT_RISK_CONFIG,
  pnl: 0,
  currentSession: crossMidnightSession,
  evaluationTime: midnightRollover,
});
assert(res23.session.state === 'LOCKED', 'Midnight rollover must NOT unlock active session');
console.log('  ✓ PASSED: Midnight rollover does not reset active lock');

// -------------------------------------------------------------
// TEST 24: Cross-midnight lock remains active
// -------------------------------------------------------------
console.log('\n[Test 24] Cross-midnight lock remains active until lockUntil');
const morningTime = new Date('2026-10-03T01:30:00.000Z'); // 07:00 IST on Oct 3 (< 07:52 IST lockUntil)
const res24 = RiskEngine.evaluate({
  userId: 'user_test',
  config: DEFAULT_RISK_CONFIG,
  pnl: -2000,
  currentSession: crossMidnightSession,
  evaluationTime: morningTime,
});
assert(res24.session.state === 'LOCKED', 'Lock must remain active in morning prior to lockUntil');
console.log('  ✓ PASSED: Cross-midnight lock persists prior to explicit lockUntil');

// -------------------------------------------------------------
// TEST 25: Configuration changes do not unlock an active lock
// -------------------------------------------------------------
console.log('\n[Test 25] Configuration changes do not unlock an active lock');
// User changes limit from 10k to 50k while locked
const newConfig: RiskConfig = { ...DEFAULT_RISK_CONFIG, dailyLossLimit: 50000 };
const res25 = RiskEngine.evaluate({
  userId: 'user_test',
  config: newConfig,
  pnl: -10000,
  currentSession: activeLockSession,
  evaluationTime: new Date(evalTime.getTime() + 10 * 60 * 1000),
});
assert(res25.session.state === 'LOCKED', 'Changing configuration must NOT dismiss active lock');
assert(res25.session.lockUntil === activeLockSession.lockUntil, 'Existing lockUntil must be preserved');
console.log('  ✓ PASSED: Config modification during active lock preserves LOCKED state and lockUntil');

// -------------------------------------------------------------
// TEST 26: Client cannot write RiskSession (Static Rules Verification)
// -------------------------------------------------------------
console.log('\n[Test 26] Client cannot write RiskSession');
const rulesContent = fs.readFileSync(path.resolve(__dirname, '../firestore.rules'), 'utf8');
assert(
  rulesContent.includes('match /riskSessions/{tradingDate} {\n        allow get, list: if isOwner(userId);\n        allow create, update, delete: if false;'),
  'Rules must strictly deny create, update, and delete on /riskSessions/*'
);
console.log('  ✓ PASSED: Firestore security rules deny all client writes to /riskSessions/*');

// -------------------------------------------------------------
// TEST 27: Client cannot directly set LOCKED
// -------------------------------------------------------------
console.log('\n[Test 27] Client cannot directly set LOCKED');
const v27 = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, state: 'LOCKED' });
assert(v27.valid === false, 'Client submitting state field must be rejected');
console.log('  ✓ PASSED: Client cannot supply state = LOCKED');

// -------------------------------------------------------------
// TEST 28: Client cannot set lockedAt
// -------------------------------------------------------------
console.log('\n[Test 28] Client cannot set lockedAt');
const v28 = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, lockedAt: new Date().toISOString() });
assert(v28.valid === false, 'Client submitting lockedAt must be rejected');
console.log('  ✓ PASSED: Client cannot supply lockedAt timestamp');

// -------------------------------------------------------------
// TEST 29: Client cannot set lockUntil
// -------------------------------------------------------------
console.log('\n[Test 29] Client cannot set lockUntil');
const v29 = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, lockUntil: new Date().toISOString() });
assert(v29.valid === false, 'Client submitting lockUntil must be rejected');
console.log('  ✓ PASSED: Client cannot supply lockUntil timestamp');

// -------------------------------------------------------------
// TEST 30: Authoritative server transitions generate appropriate audit events
// -------------------------------------------------------------
console.log('\n[Test 30] Authoritative transitions generate appropriate audit events');
assert(res12.transitionEvents.length === 2, 'Breach should produce 2 events (LOSS_LIMIT_BREACHED, TRADING_LOCK_CREATED)');
assert(res12.transitionEvents[0].type === 'LOSS_LIMIT_BREACHED', 'First event LOSS_LIMIT_BREACHED');
assert(res12.transitionEvents[1].type === 'TRADING_LOCK_CREATED', 'Second event TRADING_LOCK_CREATED');
console.log('  ✓ PASSED: Transitions produce LOSS_LIMIT_BREACHED and TRADING_LOCK_CREATED');

// -------------------------------------------------------------
// TEST 31: Repeated evaluation does not generate duplicate transition events
// -------------------------------------------------------------
console.log('\n[Test 31] Repeated evaluation does not generate duplicate transition events');
const res31 = RiskEngine.evaluate({
  userId: 'user_test',
  config: DEFAULT_RISK_CONFIG,
  pnl: -10000,
  currentSession: res12.session,
  evaluationTime: new Date(evalTime.getTime() + 1000),
});
assert(res31.transitionEvents.length === 0, 'No transition events on unchanged evaluation');
console.log('  ✓ PASSED: Zero duplicate events emitted on repeated evaluation');

// -------------------------------------------------------------
// TEST 32: CONFIG_UPDATED is generated correctly
// -------------------------------------------------------------
console.log('\n[Test 32] CONFIG_UPDATED is generated correctly on config update');
ServerRiskStore.reset();
const saveResult = await ServerRiskStore.saveConfig('user_audit', {
  ...DEFAULT_RISK_CONFIG,
  dailyLossLimit: 15000,
});
assert(saveResult.success === true, 'Save must succeed');
const events = await ServerRiskStore.getAuditEvents('user_audit');
assert(events.some((e) => e.type === 'CONFIG_UPDATED'), 'CONFIG_UPDATED event must be recorded');
console.log('  ✓ PASSED: CONFIG_UPDATED audit event created upon configuration update');

// -------------------------------------------------------------
// TEST 33: Invalid RiskConfig cannot be persisted
// -------------------------------------------------------------
console.log('\n[Test 33] Invalid RiskConfig cannot be persisted');
const invalidSave = await ServerRiskStore.saveConfig('user_audit', {
  ...DEFAULT_RISK_CONFIG,
  dailyLossLimit: -500,
});
assert(invalidSave.success === false, 'Invalid config must be rejected by store');
assert(Boolean(invalidSave.errors && invalidSave.errors.length > 0), 'Errors must be returned');
console.log('  ✓ PASSED: Server store rejects invalid configurations');

// -------------------------------------------------------------
// TEST 34: Disabled configuration behavior is deterministic
// -------------------------------------------------------------
console.log('\n[Test 34] Disabled configuration behavior is deterministic');
const disabledConfig: RiskConfig = { ...DEFAULT_RISK_CONFIG, enabled: false };
const res34 = RiskEngine.evaluate({
  userId: 'user_disabled',
  config: disabledConfig,
  pnl: -50000, // massive loss
  evaluationTime: evalTime,
});
assert(res34.session.state === 'ALLOW', 'Disabled config must yield state ALLOW');
assert(res34.session.isBreached === false, 'isBreached must be false');
assert(Boolean(res34.session.reason?.includes('disabled')), 'Reason must explicitly note risk protection is disabled');
console.log('  ✓ PASSED: Disabled config deterministically yields ALLOW with explicit status reason');

// -------------------------------------------------------------
// TEST 35: Active LOCKED session always takes precedence over enabled=false until lockUntil
// -------------------------------------------------------------
console.log('\n[Test 35] Active LOCKED session takes precedence over enabled=false until lockUntil');
const lockEvalTime = new Date('2026-10-02T11:00:00.000Z');
const breachSession = RiskEngine.evaluate({
  userId: 'user_lock_precedence',
  config: DEFAULT_RISK_CONFIG,
  pnl: -10000,
  evaluationTime: lockEvalTime,
});
assert(breachSession.session.state === 'LOCKED', 'Must be LOCKED upon breach');
assert(breachSession.session.isBreached === true, 'isBreached must be true');

// User sets enabled = false while locked
const disabledWhileLockedConfig: RiskConfig = { ...DEFAULT_RISK_CONFIG, enabled: false };
const testDuringActiveLock = RiskEngine.evaluate({
  userId: 'user_lock_precedence',
  config: disabledWhileLockedConfig,
  pnl: 0, // Even if P&L recovered
  currentSession: breachSession.session,
  evaluationTime: new Date(lockEvalTime.getTime() + 60 * 60 * 1000), // 1 hour into 12 hour lock
});
assert(testDuringActiveLock.session.state === 'LOCKED', 'LOCKED must take precedence over enabled=false');
assert(testDuringActiveLock.session.isBreached === true, 'Must remain isBreached = true');
assert(testDuringActiveLock.session.lockUntil === breachSession.session.lockUntil, 'lockUntil must be preserved');

// After lockUntil has expired, enabled=false is respected and returns ALLOW
const testAfterLockExpiry = RiskEngine.evaluate({
  userId: 'user_lock_precedence',
  config: disabledWhileLockedConfig,
  pnl: 0,
  currentSession: breachSession.session,
  evaluationTime: new Date(lockEvalTime.getTime() + 721 * 60 * 1000), // After 720m duration
});
assert(testAfterLockExpiry.session.state === 'ALLOW', 'Must transition to ALLOW after lock duration expires');
console.log('  ✓ PASSED: Active LOCKED state strictly overrides enabled=false until lockUntil elapses');

console.log('\n================================================================');
console.log('ALL 35 PHASE 2 COMPREHENSIVE TESTS PASSED SUCCESSFULLY (35/35)');
console.log('================================================================\n');
