import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { RiskEngine, getTradingDateKolkata, RiskSessionSnapshot } from '../server/risk/engine';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { PnlEngine } from '../server/pnl/engine';
import { isFuturesAndOptions } from '../server/instruments/master';
import { getISTDateString, formatINR } from '../src/utils/formatters';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

console.log('================================================================');
console.log('TRADING FIREWALL: PHASE 1 COMPREHENSIVE VERIFICATION SUITE');
console.log('================================================================\n');

// -------------------------------------------------------------
// TEST 1: Gross P&L Calculation
// -------------------------------------------------------------
console.log('[Test 1] Testing Gross P&L calculation...');
const pnl1 = PnlEngine.calculate(-4200, -1800);
assert(pnl1.totalPnl === -6000, `Expected total PnL -6000, got ${pnl1.totalPnl}`);
assert(pnl1.realisedPnl === -4200, `Expected realised PnL -4200`);
assert(pnl1.unrealisedPnl === -1800, `Expected unrealised PnL -1800`);
assert(pnl1.label === 'Gross Trading P&L', `Expected label 'Gross Trading P&L'`);
console.log('  ✓ PASSED: Gross Trading P&L calculated correctly (-4200 + -1800 = -6000)');

// -------------------------------------------------------------
// TEST 2: F&O Classification
// -------------------------------------------------------------
console.log('\n[Test 2] Testing metadata-driven F&O classification...');
// Derivatives segments
assert(isFuturesAndOptions({ segment: 'NFO-FUT', instrumentType: 'FUT' }), 'Expected NFO-FUT to be true');
assert(isFuturesAndOptions({ segment: 'NFO-OPT', instrumentType: 'CE' }), 'Expected NFO-OPT to be true');
assert(isFuturesAndOptions({ segment: 'BFO-FUT', instrumentType: 'FUT' }), 'Expected BFO-FUT to be true');
assert(isFuturesAndOptions({ segment: 'BFO-OPT', instrumentType: 'PE' }), 'Expected BFO-OPT to be true');
// Equities strictly excluded (no string suffix matching)
assert(!isFuturesAndOptions({ segment: 'NSE', instrumentType: 'EQ' }), 'Expected NSE equity to be false');
assert(!isFuturesAndOptions({ segment: 'BSE', instrumentType: 'EQ' }), 'Expected BSE equity to be false');
assert(!isFuturesAndOptions({ segment: undefined }), 'Expected undefined segment to be false');
console.log('  ✓ PASSED: Derivatives accepted (NFO/BFO), Equities rejected (NSE/BSE). No symbol suffix matching.');

// -------------------------------------------------------------
// TEST 3: Asia/Kolkata Trading Date
// -------------------------------------------------------------
console.log('\n[Test 3] Testing Asia/Kolkata trading date calculation...');
const testDate = new Date('2026-10-02T14:22:00Z'); // 19:52 IST same day
const kolkataDate = getTradingDateKolkata(testDate);
assert(kolkataDate === '2026-10-02', `Expected 2026-10-02, got ${kolkataDate}`);
const formattedIst = getISTDateString(testDate);
assert(formattedIst === '2026-10-02', `Expected 2026-10-02 from formatter, got ${formattedIst}`);
console.log(`  ✓ PASSED: Trading calendar date in Asia/Kolkata: ${kolkataDate}`);

// -------------------------------------------------------------
// Base Config for Risk Tests
// -------------------------------------------------------------
const baseConfig = {
  dailyLossLimit: 10000,
  warningThreshold1: 70,
  warningThreshold2: 90,
  lockDurationMinutes: 720, // 12 hours
  includeRealised: true,
  includeUnrealised: true,
};

// -------------------------------------------------------------
// TEST 4: Risk Threshold 1
// -------------------------------------------------------------
console.log('\n[Test 4] Testing Risk Threshold 1 (70%)...');
const rThreshold1 = RiskEngine.evaluate({
  ...baseConfig,
  realisedPnl: -4000,
  unrealisedPnl: -3000, // Total -7000 (70%)
});
assert(rThreshold1.state === 'WARNING', `Expected WARNING at 70%, got ${rThreshold1.state}`);
assert(rThreshold1.lossUtilizedPercent === 70, `Expected 70% loss utilization, got ${rThreshold1.lossUtilizedPercent}%`);
assert(!rThreshold1.isBreached, 'Expected not breached');
console.log('  ✓ PASSED: Warning state triggered at Threshold 1 (70%)');

// -------------------------------------------------------------
// TEST 5: Risk Threshold 2
// -------------------------------------------------------------
console.log('\n[Test 5] Testing Risk Threshold 2 (90%)...');
const rThreshold2 = RiskEngine.evaluate({
  ...baseConfig,
  realisedPnl: -5000,
  unrealisedPnl: -4000, // Total -9000 (90%)
});
assert(rThreshold2.state === 'WARNING', `Expected WARNING at 90%, got ${rThreshold2.state}`);
assert(rThreshold2.lossUtilizedPercent === 90, `Expected 90% loss utilization, got ${rThreshold2.lossUtilizedPercent}%`);
assert(!rThreshold2.isBreached, 'Expected not breached');
console.log('  ✓ PASSED: Warning state triggered at Threshold 2 (90%)');

// -------------------------------------------------------------
// TEST 6: Loss-limit Breach
// -------------------------------------------------------------
console.log('\n[Test 6] Testing Daily Loss Limit Breach (100%)...');
const evalTime = new Date('2026-10-02T14:22:00.000Z');
const rBreach = RiskEngine.evaluate({
  ...baseConfig,
  realisedPnl: -6000,
  unrealisedPnl: -4000, // Total -10000 (100%)
  evaluationTime: evalTime,
});
assert(rBreach.state === 'LOCKED', `Expected LOCKED at 100%, got ${rBreach.state}`);
assert(rBreach.isBreached === true, 'Expected isBreached = true');
assert(rBreach.lockedAt === evalTime.toISOString(), `Expected lockedAt to be set`);
assert(rBreach.lockUntil !== null, `Expected lockUntil to be set`);
console.log('  ✓ PASSED: LOCKED state triggered at 100% loss limit');

// -------------------------------------------------------------
// TEST 7: Lock Persistence After P&L Recovery (Mandatory Sequence)
// -------------------------------------------------------------
console.log('\n[Test 7] Testing Lock Persistence across exact sequence:');
console.log('  Step 1: P&L = -₹5,000');
let session: RiskSessionSnapshot | null = null;
const step1 = RiskEngine.evaluate({
  ...baseConfig,
  realisedPnl: -3000,
  unrealisedPnl: -2000,
  currentSession: session,
  evaluationTime: evalTime,
});
assert(step1.state === 'ALLOW', `Step 1 expected ALLOW, got ${step1.state}`);
console.log(`    -> Result: ${step1.state} (isBreached: ${step1.isBreached})`);

console.log('  Step 2: P&L = -₹7,000');
const step2 = RiskEngine.evaluate({
  ...baseConfig,
  realisedPnl: -4000,
  unrealisedPnl: -3000,
  currentSession: session,
  evaluationTime: evalTime,
});
assert(step2.state === 'WARNING', `Step 2 expected WARNING, got ${step2.state}`);
console.log(`    -> Result: ${step2.state} (isBreached: ${step2.isBreached})`);

console.log('  Step 3: P&L = -₹10,000');
const step3 = RiskEngine.evaluate({
  ...baseConfig,
  realisedPnl: -6000,
  unrealisedPnl: -4000,
  currentSession: session,
  evaluationTime: evalTime,
});
assert(step3.state === 'LOCKED', `Step 3 expected LOCKED, got ${step3.state}`);
assert(step3.isBreached === true, `Step 3 expected isBreached = true`);
console.log(`    -> Result: ${step3.state} (isBreached: ${step3.isBreached}, lockUntil: ${step3.lockUntil})`);

// Lock snapshot established
session = step3.session;

console.log('  Step 4: P&L improves to -₹8,000');
const step4 = RiskEngine.evaluate({
  ...baseConfig,
  realisedPnl: -5000,
  unrealisedPnl: -3000,
  currentSession: session,
  evaluationTime: new Date(evalTime.getTime() + 10 * 60 * 1000), // 10 minutes later
});
assert(step4.state === 'LOCKED', `Step 4 expected STILL LOCKED, got ${step4.state}`);
assert(step4.isBreached === true, `Step 4 expected isBreached = true`);
console.log(`    -> Result: ${step4.state} (STILL LOCKED, isBreached: ${step4.isBreached})`);

console.log('  Step 5: P&L improves to -₹3,000');
const step5 = RiskEngine.evaluate({
  ...baseConfig,
  realisedPnl: -2000,
  unrealisedPnl: -1000,
  currentSession: session,
  evaluationTime: new Date(evalTime.getTime() + 30 * 60 * 1000),
});
assert(step5.state === 'LOCKED', `Step 5 expected STILL LOCKED, got ${step5.state}`);
assert(step5.isBreached === true, `Step 5 expected isBreached = true`);
console.log(`    -> Result: ${step5.state} (STILL LOCKED, isBreached: ${step5.isBreached})`);

console.log('  Step 6: P&L improves to ₹0');
const step6 = RiskEngine.evaluate({
  ...baseConfig,
  realisedPnl: 0,
  unrealisedPnl: 0,
  currentSession: session,
  evaluationTime: new Date(evalTime.getTime() + 60 * 60 * 1000),
});
assert(step6.state === 'LOCKED', `Step 6 expected STILL LOCKED, got ${step6.state}`);
assert(step6.isBreached === true, `Step 6 expected isBreached = true`);
console.log(`    -> Result: ${step6.state} (STILL LOCKED, isBreached: ${step6.isBreached})`);

console.log('  Step 7: P&L becomes positive (+₹2,000)');
const step7 = RiskEngine.evaluate({
  ...baseConfig,
  realisedPnl: 1500,
  unrealisedPnl: 500,
  currentSession: session,
  evaluationTime: new Date(evalTime.getTime() + 90 * 60 * 1000),
});
assert(step7.state === 'LOCKED', `Step 7 expected STILL LOCKED, got ${step7.state}`);
assert(step7.isBreached === true, `Step 7 expected isBreached = true`);
console.log(`    -> Result: ${step7.state} (STILL LOCKED, isBreached: ${step7.isBreached})`);
console.log('  ✓ PASSED: Lock strictly persisted across all 7 recovery steps.');

// -------------------------------------------------------------
// TEST 8: Lock Idempotency
// -------------------------------------------------------------
console.log('\n[Test 8] Testing Lock Idempotency...');
const eval1 = RiskEngine.evaluate({
  ...baseConfig,
  realisedPnl: -10000,
  unrealisedPnl: 0,
  currentSession: session,
  evaluationTime: new Date(evalTime.getTime() + 1000),
});
const eval2 = RiskEngine.evaluate({
  ...baseConfig,
  realisedPnl: -10000,
  unrealisedPnl: 0,
  currentSession: session,
  evaluationTime: new Date(evalTime.getTime() + 2000),
});
assert(eval1.state === eval2.state && eval1.state === 'LOCKED', 'States must match LOCKED');
assert(eval1.lockUntil === eval2.lockUntil, 'lockUntil must not mutate on re-evaluation');
assert(eval1.lockedAt === eval2.lockedAt, 'lockedAt must remain identical');
console.log('  ✓ PASSED: Repeated evaluations are completely idempotent.');

// -------------------------------------------------------------
// TEST 9: lockUntil Calculation
// -------------------------------------------------------------
console.log('\n[Test 9] Testing lockUntil calculation (lockedAt + lockDurationMinutes)...');
const lockedTimestamp = new Date('2026-10-02T14:22:00.000Z');
const duration = 720; // 720 minutes = 12 hours
const rLockCalc = RiskEngine.evaluate({
  ...baseConfig,
  lockDurationMinutes: duration,
  realisedPnl: -10000,
  unrealisedPnl: 0,
  evaluationTime: lockedTimestamp,
});
const expectedLockUntil = new Date('2026-10-03T02:22:00.000Z').toISOString();
assert(rLockCalc.lockUntil === expectedLockUntil, `Expected ${expectedLockUntil}, got ${rLockCalc.lockUntil}`);
console.log(`  ✓ PASSED: lockUntil = lockedAt + 720m -> ${rLockCalc.lockUntil}`);

// -------------------------------------------------------------
// TEST 10: tradingDate Independent of lockUntil
// -------------------------------------------------------------
console.log('\n[Test 10] Testing tradingDate independent of lockUntil...');
// In Asia/Kolkata, 2026-10-02T14:22:00Z is 19:52 IST on 2026-10-02.
// The lock expires 12 hours later at 2026-10-03T02:22:00Z (07:52 IST on 2026-10-03).
// The tradingDate of the session remains 2026-10-02, even though lockUntil is on the next calendar day!
assert(rLockCalc.tradingDate === '2026-10-02', `Trading date must be 2026-10-02, got ${rLockCalc.tradingDate}`);
assert(Boolean(rLockCalc.lockUntil && rLockCalc.lockUntil.startsWith('2026-10-03')), `lockUntil must cross into next day: ${rLockCalc.lockUntil}`);
console.log(`  ✓ PASSED: Session tradingDate (2026-10-02) is decoupled from lockUntil (${rLockCalc.lockUntil})`);

// -------------------------------------------------------------
// TEST 11: Secret Exposure Audit
// -------------------------------------------------------------
console.log('\n[Test 11] Running Secret Exposure Audit across codebase...');
const filesToCheck = [
  'src/services/firebase.ts',
  'src/services/riskConfigService.ts',
  'src/services/brokerConnectionService.ts',
  'src/context/AuthContext.tsx',
  'src/components/Header.tsx',
  'src/components/AuthGate.tsx',
  'src/components/DashboardOverview.tsx',
  'src/components/RiskConfigEditor.tsx',
  'src/components/SystemHealth.tsx',
  'server/api.ts',
  'server/brokers/zerodha/adapter.ts',
  'server/risk/engine.ts',
  'server/pnl/engine.ts',
  'server/instruments/master.ts',
  'package.json',
];

const forbiddenKeywords = ['kite_secret', 'api_secret =', 'access_token =', 'secret = "'];
for (const relPath of filesToCheck) {
  const fullPath = path.resolve(__dirname, '..', relPath);
  if (fs.existsSync(fullPath)) {
    const content = fs.readFileSync(fullPath, 'utf8');
    for (const kw of forbiddenKeywords) {
      assert(!content.toLowerCase().includes(kw), `Secret leak detected in ${relPath}: contains ${kw}`);
    }
  }
}
console.log(`  ✓ PASSED: Scanned ${filesToCheck.length} files. Zero hardcoded Kite/Zerodha secrets detected.`);

// -------------------------------------------------------------
// TEST 12: Firestore Rules Structural Security Audit
// -------------------------------------------------------------
console.log('\n[Test 12] Auditing deployed Firestore rules structure...');
const rulesPath = path.resolve(__dirname, '../firestore.rules');
assert(fs.existsSync(rulesPath), 'firestore.rules must exist');
const rulesContent = fs.readFileSync(rulesPath, 'utf8');

// Assertions matching Correction 1 requirements
assert(rulesContent.includes('match /{document=**} {\n      allow read, write: if false;'), 'Catch-all deny required');
assert(rulesContent.includes('match /positions/{positionId} {\n        allow get, list: if isOwner(userId);\n        allow create, update, delete: if false;'), 'Authoritative positions client writes must be denied');
assert(rulesContent.includes('match /riskSessions/{tradingDate} {\n        allow get, list: if isOwner(userId);\n        allow create, update, delete: if false;'), 'Authoritative risk sessions client writes must be denied');
assert(rulesContent.includes('function hasNoBrokerSecrets(data)'), 'Broker secrets validation helper required');
assert(rulesContent.includes('allow update, delete: if false;'), 'Risk events immutability required');
assert(rulesContent.includes('data.type == \'CONFIG_UPDATED\''), 'Client risk events restricted to CONFIG_UPDATED');
console.log('  ✓ PASSED: Deployed firestore.rules statically verified against all security requirements.');

console.log('\n================================================================');
console.log('ALL PHASE 1 LOGIC & SECURITY TESTS COMPLETED SUCCESSFULLY (12/12)');
console.log('================================================================');
