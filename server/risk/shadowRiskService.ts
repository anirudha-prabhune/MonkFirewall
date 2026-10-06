/**
 * PHASE 9 — LIVE P&L → RISK ENGINE SHADOW INTEGRATION SERVICE
 *
 * Consumes validated real Zerodha P&L, feeds into the existing server RiskEngine,
 * and produces a diagnostic SHADOW risk evaluation.
 *
 * NON-NEGOTIABLE ARCHITECTURAL INVARIANTS:
 * 1. LIVE_PNL_VALIDATION_GATE remains CLOSED.
 * 2. riskIntegrationEnabled remains false.
 * 3. Zero mutations to RiskSession.
 * 4. Zero mutations to riskEvents / transition events.
 * 5. Zero creation or expiration of real locks.
 * 6. Zero invocation of EnforcementService.
 * 7. ZERO order placement, modification, cancellation, or square-off APIs.
 * 8. Consumes validated PnlResult.grossTradingPnl without duplicating calculations.
 */

import { LivePnlValidationService } from '../pnl/liveValidationService';
import { RiskEngine } from './engine';
import { ServerRiskStore } from './store';
import { PnlResult } from '../pnl/types';
import { RawBrokerPosition, BrokerInstrument } from '../brokers/types';
import { RiskConfig, DEFAULT_RISK_CONFIG } from '../../src/types/risk';
import { ShadowRiskResult } from './shadowRiskTypes';

export interface ShadowEvaluationOptions {
  injectedPositions?: RawBrokerPosition[];
  injectedInstrumentMap?: Map<number, BrokerInstrument>;
  configOverride?: Partial<RiskConfig>;
  evaluationTime?: Date;
}

export class ShadowRiskService {
  /**
   * Performs an authoritative shadow evaluation of live Zerodha F&O P&L against the user's RiskConfig.
   * STRICTLY READ-ONLY: Never persists to RiskSession, emits riskEvents, or triggers Enforcement locks.
   */
  public static async evaluateLiveShadow(
    userId: string,
    options?: ShadowEvaluationOptions
  ): Promise<ShadowRiskResult> {
    const evaluationTime = options?.evaluationTime || new Date();

    // 1. Retrieve the authoritative RiskConfig for the user
    let config: RiskConfig;
    if (options?.configOverride) {
      const userConfig = await ServerRiskStore.getConfig(userId);
      config = { ...userConfig, ...options.configOverride };
    } else {
      config = await ServerRiskStore.getConfig(userId);
    }

    // 2. Execute authoritative Phase 8 live P&L validation
    const validationResult = await LivePnlValidationService.validateLivePnl(
      config,
      evaluationTime,
      options?.injectedPositions,
      options?.injectedInstrumentMap,
      userId
    );

    // 3. Construct authoritative PnlResult from the validated pipeline figures
    const pnlResult: PnlResult = {
      tradingDate: validationResult.tradingDate,
      realisedPnl: validationResult.calculated.realisedPnl,
      unrealisedPnl: validationResult.calculated.unrealisedPnl,
      totalPnl: validationResult.calculated.grossTradingPnl,
      grossTradingPnl: validationResult.calculated.grossTradingPnl,
      dailyRealisedPnl: validationResult.calculated.dailyRealisedPnl,
      dailyUnrealisedPnl: validationResult.calculated.dailyUnrealisedPnl,
      fnoPositionCount: validationResult.calculated.fnoPositionCount,
      totalPositionCount: validationResult.calculated.fnoPositionCount,
      positions: [],
      includedRealisedPnl: validationResult.calculated.dailyRealisedPnl,
      includedUnrealisedPnl: validationResult.calculated.dailyUnrealisedPnl,
      source: 'ZERODHA_LIVE',
      calculatedAt: validationResult.timestamp,
    };

    // 4. Feed PnlResult into existing RiskEngine.evaluate WITHOUT mutating session or emitting events
    const riskEval = RiskEngine.evaluate({
      userId,
      config,
      pnlResult,
      evaluationTime,
    });

    // 5. Calculate threshold amounts for clear operator visibility
    const warning1Amount = (config.dailyLossLimit * config.warningThreshold1) / 100;
    const warning2Amount = (config.dailyLossLimit * config.warningThreshold2) / 100;
    const lossAmount = Math.max(0, -pnlResult.grossTradingPnl);

    const defaultReason =
      riskEval.state === 'ALLOW'
        ? 'Trading allowed: P&L within daily loss parameters.'
        : riskEval.reason || `Risk state evaluated to ${riskEval.state}`;

    // 6. Return strictly immutable SHADOW result
    return {
      shadow: true,
      dataSource: 'ZERODHA_LIVE',
      evaluatedAt: evaluationTime.toISOString(),
      tradingDate: validationResult.tradingDate,

      grossTradingPnl: pnlResult.grossTradingPnl,
      lossAmount,
      dailyLossLimit: config.dailyLossLimit,
      warningThreshold1: config.warningThreshold1,
      warningThreshold2: config.warningThreshold2,
      warning1Amount,
      warning2Amount,
      lossUtilizedPercent: riskEval.lossUtilizedPercent,

      expectedState: riskEval.state,
      isBreached: riskEval.isBreached,
      reason: riskEval.reason || defaultReason,

      validationState: validationResult.validationState,
      validationGate: 'CLOSED',
      riskIntegrationEnabled: false,

      pnlResult: {
        grossTradingPnl: pnlResult.grossTradingPnl,
        realisedPnl: pnlResult.realisedPnl,
        unrealisedPnl: pnlResult.unrealisedPnl,
        dailyRealisedPnl: pnlResult.dailyRealisedPnl ?? pnlResult.realisedPnl,
        dailyUnrealisedPnl: pnlResult.dailyUnrealisedPnl ?? pnlResult.unrealisedPnl,
        fnoPositionCount: pnlResult.fnoPositionCount,
      },

      reconciliation: validationResult.reconciliation,
      brokerReported: validationResult.brokerReported,
    };
  }
}
