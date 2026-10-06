/**
 * PHASE 10A — AUTHORITATIVE LIVE RISK STATE RECORDER
 *
 * Connects validated live Zerodha F&O P&L to authoritative RiskSession & riskEvents persistence
 * under the strict control of `liveRiskStateRecordingEnabled`.
 *
 * SAFETY INVARIANTS:
 * 1. Default: liveRiskStateRecordingEnabled = false (production safe; shadow-only by default).
 * 2. When disabled: NEVER mutates RiskSession, emits riskEvents, or triggers lockouts.
 * 3. When enabled: Feeds validated PnlResult directly into ServerRiskStore.evaluatePnlResult
 *    reusing ACID Firestore transactions and existing RiskEngine idempotency.
 * 4. Active locks are strictly preserved; lockUntil is never extended on repeated evaluation.
 * 5. ZERO order placement, modification, cancel, or square-off APIs are ever invoked.
 */

import { LivePnlValidationService } from '../pnl/liveValidationService';
import { ServerRiskStore } from './store';
import { RiskEngine, RiskSession, RiskEvent, RiskEvaluationResult } from './engine';
import { PnlResult } from '../pnl/types';
import { RawBrokerPosition, BrokerInstrument } from '../brokers/types';
import { RiskConfig } from '../../src/types/risk';
import { LivePnlValidationResult } from '../pnl/liveValidationTypes';

/**
 * Feature flag controlling authoritative live RiskSession & riskEvents recording.
 * STRICTLY FALSE by default.
 */
export let liveRiskStateRecordingEnabled = false;

export function getLiveRiskStateRecordingEnabled(): boolean {
  return liveRiskStateRecordingEnabled;
}

export function setLiveRiskStateRecordingEnabled(enabled: boolean): void {
  liveRiskStateRecordingEnabled = enabled;
}

export interface LiveRiskEvaluationOptions {
  injectedPositions?: RawBrokerPosition[];
  injectedInstrumentMap?: Map<number, BrokerInstrument>;
  configOverride?: Partial<RiskConfig>;
  evaluationTime?: Date;
  forceRecord?: boolean; // Used strictly for tests or explicit execution
}

export interface LiveRiskRecordingResult {
  recorded: boolean;
  flagEnabled: boolean;
  state: string;
  isBreached: boolean;
  lossAmount: number;
  grossTradingPnl: number;
  tradingDate: string;
  evaluatedAt: string;
  dataSource: 'ZERODHA_LIVE';
  session?: RiskSession;
  transitionEvents: RiskEvent[];
  pnlResult: PnlResult;
  validationResult: LivePnlValidationResult;
  reason?: string | null;
}

export class LiveRiskRecorder {
  /**
   * Authoritative Live Risk Evaluation & Recording:
   * Real Zerodha P&L → LivePnlValidationService → PnlResult → RiskEngine.evaluate() → RiskSession / riskEvents
   */
  public static async evaluateAndRecordLiveRisk(
    userId: string,
    options?: LiveRiskEvaluationOptions
  ): Promise<LiveRiskRecordingResult> {
    const evaluationTime = options?.evaluationTime || new Date();
    const shouldRecord = options?.forceRecord ?? liveRiskStateRecordingEnabled;

    // 1. Retrieve applicable RiskConfig
    let config: RiskConfig;
    if (options?.configOverride) {
      const userConfig = await ServerRiskStore.getConfig(userId);
      config = { ...userConfig, ...options.configOverride };
    } else {
      config = await ServerRiskStore.getConfig(userId);
    }

    // 2. Obtain validated live P&L through the frozen Phase 8 pipeline
    const validationResult = await LivePnlValidationService.validateLivePnl(
      config,
      evaluationTime,
      options?.injectedPositions,
      options?.injectedInstrumentMap,
      userId
    );

    // 3. Construct canonical PnlResult from validated pipeline output
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
      positions: validationResult.positions || [],
      includedRealisedPnl: validationResult.calculated.dailyRealisedPnl,
      includedUnrealisedPnl: validationResult.calculated.dailyUnrealisedPnl,
      source: 'ZERODHA_LIVE',
      calculatedAt: validationResult.timestamp,
    };

    const lossAmount = Math.max(0, -pnlResult.grossTradingPnl);

    // 4. BRANCH: If recording is disabled, evaluate in read-only mode (Zero persistence)
    if (!shouldRecord) {
      const existingSession = await ServerRiskStore.getSession(userId);
      const readOnlyEval = RiskEngine.evaluate({
        userId,
        config,
        pnlResult,
        currentSession: existingSession,
        evaluationTime,
      });

      return {
        recorded: false,
        flagEnabled: false,
        state: readOnlyEval.state,
        isBreached: readOnlyEval.isBreached,
        lossAmount,
        grossTradingPnl: pnlResult.grossTradingPnl,
        tradingDate: validationResult.tradingDate,
        evaluatedAt: evaluationTime.toISOString(),
        dataSource: 'ZERODHA_LIVE',
        transitionEvents: [], // Zero events persisted
        pnlResult,
        validationResult,
        reason: readOnlyEval.reason,
      };
    }

    // 5. BRANCH: If recording is enabled, perform authoritative persistence via ServerRiskStore
    const evalResult: RiskEvaluationResult = await ServerRiskStore.evaluatePnlResult(
      userId,
      pnlResult,
      evaluationTime,
      options?.configOverride ? config : undefined
    );

    return {
      recorded: true,
      flagEnabled: true,
      state: evalResult.state,
      isBreached: evalResult.isBreached,
      lossAmount,
      grossTradingPnl: pnlResult.grossTradingPnl,
      tradingDate: evalResult.tradingDate,
      evaluatedAt: evaluationTime.toISOString(),
      dataSource: 'ZERODHA_LIVE',
      session: evalResult.session,
      transitionEvents: evalResult.transitionEvents,
      pnlResult,
      validationResult,
      reason: evalResult.reason,
    };
  }
}
