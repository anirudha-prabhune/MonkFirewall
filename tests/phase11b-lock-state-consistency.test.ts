import { strict as assert } from 'assert';
import { RiskEngine } from '../server/risk/engine';
import { ShadowRiskService } from '../server/risk/shadowRiskService';
import { ServerRiskStore } from '../server/risk/store';
import { apiRouter } from '../server/api';
import { DEFAULT_RISK_CONFIG, RiskConfig } from '../src/types/risk';
import { RawBrokerPosition } from '../server/brokers/types';
import { MOCK_INSTRUMENT_MAP } from '../server/instruments/master';
import { PnlResult } from '../server/pnl/types';

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

async function runLockStateConsistencyTests() {
  console.log('================================================================');
  console.log('TRADING FIREWALL: PHASE 11B LOCK STATE CONSISTENCY SUITE');
  console.log('Authoritative Lock Objects, Timestamps, & Data Contract Guarantees');
  console.log('================================================================\n');

  const testUser = 'phase11b_lock_contract_user';
  const evalTime = new Date('2026-10-06T10:00:00.000Z'); // 3:30 PM IST

  // Configure user with ₹500 limit
  const config: RiskConfig = {
    ...DEFAULT_RISK_CONFIG,
    dailyLossLimit: 500,
    lockDurationMinutes: 120,
    lockDurationType: 'FIXED',
    enabled: true,
  };
  await ServerRiskStore.saveConfig(testUser, config);

  // ------------------------------------------------------------------
  // TEST 1 — ALLOW state contract: lockedAt = null, lockUntil = null
  // ------------------------------------------------------------------
  console.log('[Test 1] ALLOW state data contract: lockedAt = null, lockUntil = null');
  const allowPnl: PnlResult = {
    tradingDate: '2026-10-06',
    grossTradingPnl: -234.0,
    realisedPnl: -234.0,
    unrealisedPnl: 0,
    dailyRealisedPnl: -234.0,
    dailyUnrealisedPnl: 0,
    totalPnl: -234.0,
    includedRealisedPnl: -234.0,
    includedUnrealisedPnl: 0,
    fnoPositionCount: 1,
    totalPositionCount: 1,
    positions: [],
    source: 'ZERODHA_LIVE',
    calculatedAt: evalTime.toISOString(),
  };

  const allowEval = RiskEngine.evaluate({
    userId: testUser,
    config,
    pnlResult: allowPnl,
    evaluationTime: evalTime,
  });

  assert.equal(allowEval.state, 'ALLOW', 'State is ALLOW for -₹234 loss');
  assert.equal(allowEval.lockedAt, null, 'lockedAt is null in ALLOW state');
  assert.equal(allowEval.lockUntil, null, 'lockUntil is null in ALLOW state');
  assert.equal(allowEval.session.lockedAt, null, 'session.lockedAt is null in ALLOW state');
  assert.equal(allowEval.session.lockUntil, null, 'session.lockUntil is null in ALLOW state');
  console.log('  ✓ PASSED: ALLOW state has null lock timestamps');

  // ------------------------------------------------------------------
  // TEST 2 — WARNING state contract: lockedAt = null, lockUntil = null
  // ------------------------------------------------------------------
  console.log('[Test 2] WARNING state data contract: lockedAt = null, lockUntil = null');
  const warningPnl: PnlResult = {
    ...allowPnl,
    grossTradingPnl: -383.5,
    realisedPnl: -383.5,
    dailyRealisedPnl: -383.5,
    totalPnl: -383.5,
  };

  const warningEval = RiskEngine.evaluate({
    userId: testUser,
    config,
    pnlResult: warningPnl,
    evaluationTime: evalTime,
  });

  assert.equal(warningEval.state, 'WARNING', 'State is WARNING for -₹383.50 loss');
  assert.equal(warningEval.lockedAt, null, 'lockedAt is null in WARNING state');
  assert.equal(warningEval.lockUntil, null, 'lockUntil is null in WARNING state');
  assert.equal(warningEval.session.lockedAt, null, 'session.lockedAt is null in WARNING state');
  assert.equal(warningEval.session.lockUntil, null, 'session.lockUntil is null in WARNING state');
  console.log('  ✓ PASSED: WARNING state has null lock timestamps');

  // ------------------------------------------------------------------
  // TEST 3 — LOCKED state contract: lockedAt != null, lockUntil != null, lockUntil > lockedAt
  // ------------------------------------------------------------------
  console.log('[Test 3] LOCKED state contract: lockedAt != null, lockUntil != null, lockUntil > lockedAt');
  const lockedPnl: PnlResult = {
    ...allowPnl,
    grossTradingPnl: -507.0,
    realisedPnl: -507.0,
    dailyRealisedPnl: -507.0,
    totalPnl: -507.0,
  };

  const lockedEval = RiskEngine.evaluate({
    userId: testUser,
    config,
    pnlResult: lockedPnl,
    evaluationTime: evalTime,
  });

  assert.equal(lockedEval.state, 'LOCKED', 'State is LOCKED for -₹507 loss');
  assert.ok(lockedEval.lockedAt !== null, 'lockedAt is NOT null in LOCKED state');
  assert.ok(lockedEval.lockUntil !== null, 'lockUntil is NOT null in LOCKED state');

  const lockedAtMs = new Date(lockedEval.lockedAt!).getTime();
  const lockUntilMs = new Date(lockedEval.lockUntil!).getTime();
  assert.ok(lockUntilMs > lockedAtMs, 'lockUntil is strictly later than lockedAt');

  // Remaining lock duration derived from lockUntil - evalTime
  const expectedDiffMinutes = (lockUntilMs - evalTime.getTime()) / (1000 * 60);
  assert.equal(expectedDiffMinutes, 120, 'Derived remaining duration equals 120m');
  console.log('  ✓ PASSED: LOCKED state contract satisfied');

  // ------------------------------------------------------------------
  // TEST 4 — ShadowRiskService attaches lockedAt and lockUntil in ShadowResult
  // ------------------------------------------------------------------
  console.log('[Test 4] ShadowRiskService propagates lockedAt and lockUntil in ShadowRiskResult');
  const mockLossPos: RawBrokerPosition = {
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
  };

  const shadowResult = await ShadowRiskService.evaluateLiveShadow(testUser, {
    configOverride: config,
    evaluationTime: evalTime,
    injectedPositions: [mockLossPos],
    injectedInstrumentMap: MOCK_INSTRUMENT_MAP,
  });

  assert.equal(shadowResult.expectedState, 'LOCKED', 'Shadow result expectedState is LOCKED');
  assert.ok(shadowResult.lockedAt !== undefined && shadowResult.lockedAt !== null, 'shadowResult contains lockedAt');
  assert.ok(shadowResult.lockUntil !== undefined && shadowResult.lockUntil !== null, 'shadowResult contains lockUntil');
  console.log('  ✓ PASSED: ShadowRiskResult contains valid lockedAt and lockUntil');

  // ------------------------------------------------------------------
  // TEST 5 — Config Consistency: UNTIL_4PM lock duration policy
  // ------------------------------------------------------------------
  console.log('[Test 5] Configuration Consistency: UNTIL_4PM lock policy sets lockUntil to 16:00 IST');
  const config4pm: RiskConfig = {
    ...config,
    lockDurationType: 'UNTIL_4PM',
  };

  const eval4pm = RiskEngine.evaluate({
    userId: testUser,
    config: config4pm,
    pnlResult: lockedPnl,
    evaluationTime: evalTime, // 10:00 UTC = 15:30 IST
  });

  assert.equal(eval4pm.state, 'LOCKED', 'State is LOCKED');
  assert.ok(eval4pm.lockUntil !== null, 'lockUntil is set');

  const lockUntilDate = new Date(eval4pm.lockUntil!);
  // 4:00 PM IST on 2026-10-06 is 2026-10-06T10:30:00.000Z
  assert.equal(lockUntilDate.toISOString(), '2026-10-06T10:30:00.000Z', 'lockUntil is 4:00 PM IST (10:30 UTC)');

  // Remaining duration from 15:30 IST to 16:00 IST is 30 minutes
  const remaining4pmMs = lockUntilDate.getTime() - evalTime.getTime();
  assert.equal(remaining4pmMs / (1000 * 60), 30, 'Remaining duration for UNTIL_4PM is 30 minutes');
  console.log('  ✓ PASSED: UNTIL_4PM lock policy consistently evaluated');

  console.log('\n================================================================');
  console.log('ALL PHASE 11B LOCK STATE CONSISTENCY TESTS PASSED');
  console.log('================================================================\n');
}

runLockStateConsistencyTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
