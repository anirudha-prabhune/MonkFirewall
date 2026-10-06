import assert from 'node:assert';
import { validateRiskConfig } from '../server/risk/validation';
import { RiskEngine, getTradingDateKolkata } from '../server/risk/engine';
import { ServerRiskStore } from '../server/risk/store';
import { DEFAULT_RISK_CONFIG, RiskConfig } from '../src/types/risk';
import { ZerodhaCredentialManager } from '../server/brokers/zerodha/credentials';

console.log('================================================================');
console.log('TRADING FIREWALL: RISK CONFIG & DEMO CONTROLS TEST SUITE');
console.log('Focused verification for Daily Loss Limit, Lock Duration & Demo');
console.log('================================================================');

async function runTests() {
  // --------------------------------------------------------------------------
  // SUITE 1: Daily Loss Limit Validation
  // --------------------------------------------------------------------------
  console.log('\n[Suite 1] Daily Loss Limit Validation');

  // Test 1.1: Reject dailyLossLimit < 500
  const r1 = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, dailyLossLimit: 400 });
  assert.strictEqual(r1.valid, false, 'dailyLossLimit < 500 must be rejected');
  assert(r1.errors.some(e => e.includes('at least ₹500')), 'Error must mention minimum ₹500');
  console.log('  ✓ PASSED: dailyLossLimit < ₹500 rejected');

  // Test 1.2: Reject dailyLossLimit = 0
  const r2 = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, dailyLossLimit: 0 });
  assert.strictEqual(r2.valid, false, 'dailyLossLimit = 0 must be rejected');
  console.log('  ✓ PASSED: dailyLossLimit = 0 rejected');

  // Test 1.3: Reject negative dailyLossLimit
  const r3 = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, dailyLossLimit: -1000 });
  assert.strictEqual(r3.valid, false, 'Negative dailyLossLimit must be rejected');
  console.log('  ✓ PASSED: Negative dailyLossLimit rejected');

  // Test 1.4: Reject non-increments of 500
  const r4a = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, dailyLossLimit: 1250 });
  assert.strictEqual(r4a.valid, false, '₹1,250 (not multiple of 500) must be rejected');
  const r4b = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, dailyLossLimit: 600 });
  assert.strictEqual(r4b.valid, false, '₹600 (not multiple of 500) must be rejected');
  console.log('  ✓ PASSED: Non-increments of ₹500 rejected');

  // Test 1.5: Accept valid increments of ₹500
  for (const validAmount of [500, 1000, 2500, 5000, 10000, 25000, 50000]) {
    const res = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, dailyLossLimit: validAmount });
    assert.strictEqual(res.valid, true, `Valid amount ₹${validAmount} must pass`);
    assert.strictEqual(res.sanitized?.dailyLossLimit, validAmount);
  }
  console.log('  ✓ PASSED: Valid ₹500 increments accepted (₹500 to ₹50,000)');

  // Test 1.6: Enabled/Disabled control preserved
  const rDisabled = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, enabled: false });
  assert.strictEqual(rDisabled.valid, true);
  assert.strictEqual(rDisabled.sanitized?.enabled, false);
  const rEnabled = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, enabled: true });
  assert.strictEqual(rEnabled.valid, true);
  assert.strictEqual(rEnabled.sanitized?.enabled, true);
  console.log('  ✓ PASSED: Enabled / Disabled toggle preserved');

  // --------------------------------------------------------------------------
  // SUITE 2: Lock Duration Validation
  // --------------------------------------------------------------------------
  console.log('\n[Suite 2] Lock Duration Validation');

  // Test 2.1: Reject Fixed duration < 60 minutes
  const d1 = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, lockDurationType: 'FIXED', lockDurationMinutes: 45 });
  assert.strictEqual(d1.valid, false, 'Fixed duration < 60m must be rejected');
  assert(d1.errors.some(e => e.includes('at least 60 minutes')));
  console.log('  ✓ PASSED: Fixed duration < 60m rejected');

  // Test 2.2: Reject Fixed duration non-multiples of 60
  const d2 = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, lockDurationType: 'FIXED', lockDurationMinutes: 90 });
  assert.strictEqual(d2.valid, false, 'Fixed duration 90m (not multiple of 60) must be rejected');
  assert(d2.errors.some(e => e.includes('increments of 60 minutes')));
  console.log('  ✓ PASSED: Fixed duration non-multiples of 60m rejected');

  // Test 2.3: Reject Fixed duration <= 0
  const d3 = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, lockDurationType: 'FIXED', lockDurationMinutes: 0 });
  assert.strictEqual(d3.valid, false, 'Duration = 0 must be rejected');
  const d3b = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, lockDurationType: 'FIXED', lockDurationMinutes: -60 });
  assert.strictEqual(d3b.valid, false, 'Duration = -60 must be rejected');
  console.log('  ✓ PASSED: Fixed duration <= 0 rejected');

  // Test 2.4: Accept valid Fixed duration increments
  for (const validMin of [60, 120, 180, 360, 720, 1440]) {
    const res = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, lockDurationType: 'FIXED', lockDurationMinutes: validMin });
    assert.strictEqual(res.valid, true, `Duration ${validMin}m must be valid`);
    assert.strictEqual(res.sanitized?.lockDurationType, 'FIXED');
    assert.strictEqual(res.sanitized?.lockDurationMinutes, validMin);
  }
  console.log('  ✓ PASSED: Valid Fixed duration increments accepted (60m to 1440m)');

  // Test 2.5: Accept Until 4:00 PM mode
  const d4 = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, lockDurationType: 'UNTIL_4PM' });
  assert.strictEqual(d4.valid, true, 'UNTIL_4PM mode must be valid');
  assert.strictEqual(d4.sanitized?.lockDurationType, 'UNTIL_4PM');
  console.log('  ✓ PASSED: UNTIL_4PM mode validated');

  // Test 2.6: Reject unknown duration mode
  const d5 = validateRiskConfig({ ...DEFAULT_RISK_CONFIG, lockDurationType: 'INDEFINITE' as any });
  assert.strictEqual(d5.valid, false, 'Unknown duration type must be rejected');
  console.log('  ✓ PASSED: Unknown lockDurationType rejected');

  // --------------------------------------------------------------------------
  // SUITE 3: Fixed-Duration Expiry Semantics
  // --------------------------------------------------------------------------
  console.log('\n[Suite 3] Fixed-Duration Expiry Semantics');

  const breachTimeFixed = new Date('2026-10-04T10:00:00.000Z');
  const fixedConfig: RiskConfig = {
    ...DEFAULT_RISK_CONFIG,
    dailyLossLimit: 5000,
    lockDurationType: 'FIXED',
    lockDurationMinutes: 120, // 2 hours
  };

  // Initial breach at 10:00:00Z with loss of 5000
  const evalFixed1 = RiskEngine.evaluate({
    config: fixedConfig,
    realisedPnl: -5000,
    unrealisedPnl: 0,
    evaluationTime: breachTimeFixed,
  });

  assert.strictEqual(evalFixed1.state, 'LOCKED');
  assert.strictEqual(evalFixed1.isBreached, true);
  const expectedLockUntilFixed = new Date('2026-10-04T12:00:00.000Z').toISOString();
  assert.strictEqual(evalFixed1.lockUntil, expectedLockUntilFixed, `lockUntil must be 12:00:00Z (+120m)`);
  console.log(`  ✓ PASSED: Breach at 10:00Z with 120m lock establishes lockUntil = ${evalFixed1.lockUntil}`);

  // Evaluation at 11:30:00Z (before 12:00:00Z): Lock remains active
  const evalFixedActive = RiskEngine.evaluate({
    config: fixedConfig,
    currentSession: evalFixed1.session,
    realisedPnl: -5000,
    unrealisedPnl: 0,
    evaluationTime: new Date('2026-10-04T11:30:00.000Z'),
  });
  assert.strictEqual(evalFixedActive.state, 'LOCKED', 'Lock must remain active before 12:00Z');
  console.log('  ✓ PASSED: Session remains LOCKED during active lock duration');

  // Evaluation at 12:00:01Z (after lock duration elapsed): Lock expires
  const evalFixedExpired = RiskEngine.evaluate({
    config: fixedConfig,
    currentSession: evalFixed1.session,
    realisedPnl: 0,
    unrealisedPnl: 0,
    evaluationTime: new Date('2026-10-04T12:00:01.000Z'),
  });
  assert.strictEqual(evalFixedExpired.state, 'ALLOW', 'Lock must expire after 12:00Z');
  assert(evalFixedExpired.transitionEvents.some(e => e.type === 'TRADING_LOCK_EXPIRED'));
  console.log('  ✓ PASSED: Fixed lock cleanly expires once duration has elapsed');

  // --------------------------------------------------------------------------
  // SUITE 4: Until 4:00 PM Expiry Semantics (Asia/Kolkata)
  // --------------------------------------------------------------------------
  console.log('\n[Suite 4] Until 4:00 PM Expiry Semantics (Asia/Kolkata)');

  const until4pmConfig: RiskConfig = {
    ...DEFAULT_RISK_CONFIG,
    dailyLossLimit: 5000,
    lockDurationType: 'UNTIL_4PM',
  };

  // Breach occurs during morning market hours at 11:30 AM IST (06:00 UTC) on 2026-10-04
  const breachMorningIst = new Date('2026-10-04T06:00:00.000Z'); // 11:30 AM IST
  const eval4pm = RiskEngine.evaluate({
    config: until4pmConfig,
    realisedPnl: -6000,
    unrealisedPnl: 0,
    evaluationTime: breachMorningIst,
  });

  assert.strictEqual(eval4pm.state, 'LOCKED');
  assert.strictEqual(eval4pm.isBreached, true);

  // 4:00 PM IST on 2026-10-04 is 16:00:00+05:30 = 10:30:00.000Z
  const expected4pmUtc = new Date('2026-10-04T16:00:00.000+05:30').toISOString();
  assert.strictEqual(eval4pm.lockUntil, expected4pmUtc, `lockUntil must be 16:00:00 IST (10:30:00 UTC)`);
  console.log(`  ✓ PASSED: 4 PM mode establishes lockUntil at exact 16:00:00 IST (${eval4pm.lockUntil})`);

  // Evaluation at 14:30 IST (09:00 UTC): Lock is still active
  const eval4pmActive = RiskEngine.evaluate({
    config: until4pmConfig,
    currentSession: eval4pm.session,
    realisedPnl: -6000,
    unrealisedPnl: 0,
    evaluationTime: new Date('2026-10-04T09:00:00.000Z'), // 14:30 IST
  });
  assert.strictEqual(eval4pmActive.state, 'LOCKED');
  console.log('  ✓ PASSED: Lock remains active at 14:30 IST (before 16:00 IST)');

  // Evaluation at 16:00:00 IST (10:30:00.000Z): Lock expires
  const eval4pmExpired = RiskEngine.evaluate({
    config: until4pmConfig,
    currentSession: eval4pm.session,
    realisedPnl: 0,
    unrealisedPnl: 0,
    evaluationTime: new Date('2026-10-04T10:30:00.000Z'), // 16:00:00 IST
  });
  assert.strictEqual(eval4pmExpired.state, 'ALLOW');
  assert(eval4pmExpired.transitionEvents.some(e => e.type === 'TRADING_LOCK_EXPIRED'));
  console.log('  ✓ PASSED: Lock expires at 16:00:00 IST on the trading date');

  // --------------------------------------------------------------------------
  // SUITE 5: Demo / Simulation Controls
  // --------------------------------------------------------------------------
  console.log('\n[Suite 5] Demo / Simulation Controls');

  const demoUser = 'test_demo_user';
  ServerRiskStore.reset();
  await ServerRiskStore.saveConfig(demoUser, { ...DEFAULT_RISK_CONFIG, dailyLossLimit: 5000 });

  // Control 1: +₹2,000
  const simPlus = await ServerRiskStore.evaluatePnl(demoUser, 2000);
  assert.strictEqual(simPlus.currentPnl, 2000);
  assert.strictEqual(simPlus.state, 'ALLOW');
  console.log('  ✓ PASSED: +₹2,000 demo simulation evaluates to ALLOW');

  // Control 2: -₹2,000
  const simMinus2k = await ServerRiskStore.evaluatePnl(demoUser, -2000);
  assert.strictEqual(simMinus2k.currentPnl, -2000);
  assert.strictEqual(simMinus2k.lossAmount, 2000);
  console.log('  ✓ PASSED: -₹2,000 demo simulation evaluates correctly');

  // Control 3: -₹5,000 (Hits ₹5,000 dailyLossLimit)
  const simMinus5k = await ServerRiskStore.evaluatePnl(demoUser, -5000);
  assert.strictEqual(simMinus5k.state, 'LOCKED');
  assert.strictEqual(simMinus5k.isBreached, true);
  console.log('  ✓ PASSED: -₹5,000 demo simulation hits limit and triggers LOCKED state');

  // Control 4: Trigger Loss Limit Breach
  const simBreach = await ServerRiskStore.evaluatePnl(demoUser, -10000);
  assert.strictEqual(simBreach.state, 'LOCKED');
  assert.strictEqual(simBreach.isBreached, true);
  console.log('  ✓ PASSED: Trigger Loss Limit Breach forces LOCKED circuit breaker');

  // Control 5: Reset Demo
  const resetResult = await ServerRiskStore.resetSession(demoUser);
  assert.strictEqual(resetResult.state, 'ALLOW');
  assert.strictEqual(resetResult.isBreached, false);
  assert.strictEqual(resetResult.lockedAt, null);
  assert.strictEqual(resetResult.lockUntil, null);
  console.log('  ✓ PASSED: Reset Demo cleanly clears session and restores ALLOW state');

  // --------------------------------------------------------------------------
  // SUITE 6: Demo / Live Broker Isolation Audit
  // --------------------------------------------------------------------------
  console.log('\n[Suite 6] Demo / Live Broker Isolation Audit');

  // Assert that active Zerodha tokens are NOT modified by demo controls
  const activeTokenBefore = ZerodhaCredentialManager.getActiveAccessToken(demoUser);
  await ServerRiskStore.evaluatePnl(demoUser, 2000);
  await ServerRiskStore.evaluatePnl(demoUser, -5000);
  await ServerRiskStore.resetSession(demoUser);
  const activeTokenAfter = ZerodhaCredentialManager.getActiveAccessToken(demoUser);

  assert.strictEqual(activeTokenBefore, activeTokenAfter, 'Demo controls must never alter live broker session token');
  console.log('  ✓ PASSED: Demo controls operate strictly on synthetic mock data with zero live broker side-effects');

  console.log('\n================================================================');
  console.log('ALL RISK CONFIG & DEMO CONTROLS TESTS PASSED (6/6 SUITES)');
  console.log('================================================================');
}

runTests().catch((err) => {
  console.error('\n❌ Test Suite Failed:', err);
  process.exit(1);
});
