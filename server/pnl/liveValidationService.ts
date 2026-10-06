import {
  LivePnlValidationResult,
  ValidationState,
  MarketDataFreshness,
  ComparisonStatus,
  LIVE_PNL_VALIDATION_GATE,
  DEFAULT_RECONCILIATION_TOLERANCE,
} from './liveValidationTypes';
import { BrokerService } from '../brokers/service';
import { normalizePositions } from '../brokers/normalize';
import { PnlEngine } from './engine';
import { PnlResult } from './types';
import { PnlValidationError } from './calculator';
import { MarketDataService } from '../market/marketDataService';
import { getTradingDateKolkata } from '../risk/engine';
import { RiskConfig, DEFAULT_RISK_CONFIG } from '../../src/types/risk';
import { BrokerInstrument, RawBrokerPosition, NormalizedPosition } from '../brokers/types';
import { MOCK_INSTRUMENT_MAP } from '../instruments/master';
import { ZerodhaCredentialManager } from '../brokers/zerodha/credentials';

/**
 * Phase 8 — Live Zerodha P&L Validation & Shadow Mode Service.
 *
 * CRITICAL ARCHITECTURAL CONSTRAINTS:
 * 1. SHADOW MODE ONLY: Live P&L is for reconciliation and diagnostic comparison only.
 * 2. ZERO RISK INTEGRATION: Does NOT invoke RiskEngine, modify RiskSession, or write risk events.
 * 3. VALIDATION GATE CLOSED: Integration remains disabled until explicit human authorization.
 * 4. PURE READ-ONLY: Never executes orders, modifications, or square-offs.
 */
export class LivePnlValidationService {
  private static tolerance: number = DEFAULT_RECONCILIATION_TOLERANCE;

  public static setTolerance(tolerance: number): void {
    this.tolerance = tolerance;
  }

  public static getTolerance(): number {
    return this.tolerance;
  }

  /**
   * Orchestrates live P&L calculation and reconciliation against broker-reported figures.
   *
   * Flow:
   * Live Zerodha raw positions
   *   ↓
   * Normalization + Metadata F&O classification
   *   ↓
   * MarketDataService LTP enrichment
   *   ↓
   * Phase 4 PnlEngine.calculate()
   *   ↓
   * Reconciliation & ValidationState determination
   */
  public static async validateLivePnl(
    config?: Partial<RiskConfig>,
    evaluationTime: Date = new Date(),
    injectedRawPositions?: RawBrokerPosition[],
    injectedInstrumentMap?: Map<number, BrokerInstrument>,
    userId?: string
  ): Promise<LivePnlValidationResult> {
    const tradingDate = getTradingDateKolkata(evaluationTime);
    const effectiveConfig = config || DEFAULT_RISK_CONFIG;

    try {
      // 1. Obtain raw live positions & instrument map
      let rawPositions: RawBrokerPosition[];
      let instrumentMap: Map<number, BrokerInstrument>;

      if (injectedRawPositions) {
        rawPositions = injectedRawPositions;
        instrumentMap = injectedInstrumentMap || MOCK_INSTRUMENT_MAP;
      } else {
        const liveAdapter = BrokerService.getLiveAdapter();
        const effectiveUserId = (userId && userId.trim().length > 0) ? userId.trim() : 'default_trader';

        const connStatus = await liveAdapter.getConnectionStatus(effectiveUserId);

        if (connStatus.status === 'AUTHENTICATION_REQUIRED') {
          return this.createAuthRequiredResult(
            connStatus.message || 'Zerodha authentication required. Please authenticate via Kite Connect login.',
            tradingDate,
            evaluationTime
          );
        }

        if (connStatus.status !== 'CONNECTED') {
          return this.createErrorResult(
            `Live Zerodha connection inactive: ${connStatus.message}`,
            tradingDate,
            evaluationTime
          );
        }

        rawPositions = await liveAdapter.getPositions(effectiveUserId);

        // DEFECT 3: Authoritative instrument metadata resolution.
        // NEVER fall back to MOCK_INSTRUMENT_MAP for live Zerodha data!
        try {
          const liveInstruments = await liveAdapter.getInstruments(effectiveUserId);
          if (liveInstruments && liveInstruments.length > 0) {
            instrumentMap = new Map(liveInstruments.map((i) => [i.instrumentToken, i]));
          } else {
            instrumentMap = new Map();
          }
        } catch {
          instrumentMap = new Map();
        }
      }

      // 2. Normalize positions using authoritative Phase 3/7 normalizer
      const normalizedPositions = normalizePositions(rawPositions, instrumentMap, 'ZERODHA_LIVE');

      // DEFECT 2: Preserve both net and day sources with explicit provenance.
      // Net = current net/open-position state.
      // Day = today's execution/activity state.
      // Closed intraday positions in data.day (quantity === 0 && (realisedPnl !== 0 || dayBuyQuantity > 0))
      // MUST NOT be discarded and must be accessible even when no open net position exists.
      // Avoid double-counting net and day quantities/P&L.
      const netPositions = normalizedPositions.filter((p) => (p.provenance || 'net') === 'net');
      const dayPositions = normalizedPositions.filter((p) => p.provenance === 'day');

      const netKeys = new Set(netPositions.map((p) => `${p.instrumentToken}_${p.product}`));
      const standaloneClosedDayPositions = dayPositions.filter(
        (p) =>
          p.quantity === 0 &&
          (p.realisedPnl !== 0 || p.dayBuyQuantity > 0) &&
          !netKeys.has(`${p.instrumentToken}_${p.product}`)
      );

      const effectivePositions = [...netPositions, ...standaloneClosedDayPositions];

      // 3. Track unknown instruments from effective positions
      const unknownInstruments: Array<{
        instrumentToken: number;
        tradingsymbol: string;
        exchange: string;
        reason: string;
      }> = [];

      for (const pos of effectivePositions) {
        if (pos.unknownInstrument || pos.segment === 'UNKNOWN') {
          unknownInstruments.push({
            instrumentToken: pos.instrumentToken,
            tradingsymbol: pos.tradingsymbol,
            exchange: pos.exchange,
            reason: `Instrument token ${pos.instrumentToken} (${pos.tradingsymbol}) not found in authoritative instrument master. F&O classification denied.`,
          });
        }
      }

      // 4. Inspect Market Data Freshness & enrich F&O positions with live LTP
      let hasMissingLtp = false;
      let hasStaleLtp = false;
      const fnoPositions = effectivePositions.filter((p) => p.isFno && !p.unknownInstrument);

      const enrichedPositions: NormalizedPosition[] = effectivePositions.map((pos) => {
        // Equities and unknown instruments do not require live F&O market LTP
        if (!pos.isFno || pos.unknownInstrument) {
          return { ...pos };
        }

        // Closed positions (quantity === 0) do not require live LTP (unrealized P&L is 0)
        if (pos.quantity === 0) {
          return { ...pos };
        }

        // For open F&O positions, check MarketDataService
        const tick = MarketDataService.getTick(pos.instrumentToken, evaluationTime);
        if (!tick) {
          hasMissingLtp = true;
          return { ...pos };
        }

        if (tick.isStale) {
          hasStaleLtp = true;
        }

        // Update position lastPrice with authoritative live market data
        return {
          ...pos,
          lastPrice: tick.lastPrice,
        };
      });

      let marketDataStatus: MarketDataFreshness = 'FRESH';
      if (hasMissingLtp) {
        marketDataStatus = 'MISSING';
      } else if (hasStaleLtp) {
        marketDataStatus = 'STALE';
      }

      // Check if any carried-forward position lacks authoritative closePrice
      let hasMissingReferencePrice = false;
      for (const pos of fnoPositions) {
        if (pos.overnightQuantity && pos.overnightQuantity !== 0) {
          if (!pos.closePrice || pos.closePrice <= 0) {
            hasMissingReferencePrice = true;
          }
        }
      }

      if (hasMissingReferencePrice) {
        marketDataStatus = 'MISSING';
      }

      // 5. Invoke existing Phase 4 PnlEngine (or safe placeholder if missing reference price)
      let pnlResult: PnlResult;
      if (hasMissingReferencePrice) {
        pnlResult = {
          tradingDate,
          realisedPnl: 0,
          unrealisedPnl: 0,
          totalPnl: 0,
          grossTradingPnl: 0,
          dailyRealisedPnl: 0,
          dailyUnrealisedPnl: 0,
          fnoPositionCount: fnoPositions.length,
          totalPositionCount: normalizedPositions.length,
          positions: [],
          includedRealisedPnl: 0,
          includedUnrealisedPnl: 0,
          source: 'ZERODHA_LIVE',
          calculatedAt: evaluationTime.toISOString(),
        };
      } else {
        try {
          pnlResult = PnlEngine.calculate(enrichedPositions, effectiveConfig, evaluationTime);
        } catch (calcErr) {
          if (calcErr instanceof PnlValidationError && calcErr.message.includes('closePrice')) {
            hasMissingReferencePrice = true;
            marketDataStatus = 'MISSING';
            pnlResult = {
              tradingDate,
              realisedPnl: 0,
              unrealisedPnl: 0,
              totalPnl: 0,
              grossTradingPnl: 0,
              dailyRealisedPnl: 0,
              dailyUnrealisedPnl: 0,
              fnoPositionCount: fnoPositions.length,
              totalPositionCount: normalizedPositions.length,
              positions: [],
              includedRealisedPnl: 0,
              includedUnrealisedPnl: 0,
              source: 'ZERODHA_LIVE',
              calculatedAt: evaluationTime.toISOString(),
            };
          } else {
            throw calcErr;
          }
        }
      }

      // 6. Aggregate broker-reported figures for F&O positions
      // DEFECT 2: Use effective raw positions to avoid double-counting net and day
      let brokerRealised = 0;
      let brokerUnrealised = 0;
      let brokerPnl = 0;
      let brokerM2m = 0;
      let hasBrokerM2m = false;
      let hasCarriedForward = false;

      const netRaw = rawPositions.filter((r) => (r.provenance || 'net') === 'net');
      const dayRaw = rawPositions.filter((r) => r.provenance === 'day');
      const netRawKeys = new Set(netRaw.map((r) => `${r.instrument_token}_${r.product}`));
      const standaloneClosedDayRaw = dayRaw.filter(
        (r) =>
          r.quantity === 0 &&
          (r.realised !== 0 || r.day_buy_quantity > 0) &&
          !netRawKeys.has(`${r.instrument_token}_${r.product}`)
      );
      const effectiveRaw = [...netRaw, ...standaloneClosedDayRaw];

      for (const raw of effectiveRaw) {
        const normMatch = fnoPositions.find(
          (p) => p.instrumentToken === raw.instrument_token && p.product === raw.product
        );
        if (normMatch) {
          brokerRealised += raw.realised || 0;
          brokerUnrealised += raw.unrealised || 0;
          brokerPnl += raw.pnl || 0;
          if (typeof raw.m2m === 'number' && Number.isFinite(raw.m2m)) {
            brokerM2m += raw.m2m;
            hasBrokerM2m = true;
          }
          if (normMatch.overnightQuantity && normMatch.overnightQuantity !== 0) {
            hasCarriedForward = true;
          }
        }
      }
      brokerRealised = Math.round(brokerRealised * 100) / 100;
      brokerUnrealised = Math.round(brokerUnrealised * 100) / 100;
      brokerPnl = Math.round(brokerPnl * 100) / 100;
      brokerM2m = Math.round(brokerM2m * 100) / 100;

      // 7. Determine Semantic Comparability
      let comparisonStatus: ComparisonStatus;
      let comparisonReason: string;
      let comparableBrokerValue: number;

      if (hasBrokerM2m) {
        comparisonStatus = 'COMPARABLE';
        comparableBrokerValue = brokerM2m;
        comparisonReason = 'Reconciled against Zerodha authoritative daily mark-to-market (m2m).';
      } else if (!hasCarriedForward) {
        comparisonStatus = 'COMPARABLE';
        comparableBrokerValue = brokerPnl;
        comparisonReason = 'All F&O positions are intraday; broker total P&L is semantically equivalent to current-day gross P&L.';
      } else {
        comparisonStatus = 'NOT_COMPARABLE';
        comparableBrokerValue = brokerPnl;
        comparisonReason = 'Carried-forward positions present without broker m2m. Broker raw.pnl represents total position P&L since inception and is not semantically comparable to current-day gross P&L.';
      }

      // 8. Calculate Reconciliation Differences
      const calcRealised = pnlResult.dailyRealisedPnl ?? pnlResult.realisedPnl;
      const calcUnrealised = pnlResult.dailyUnrealisedPnl ?? pnlResult.unrealisedPnl;

      const realisedDiff = Math.round(Math.abs(calcRealised - brokerRealised) * 100) / 100;
      const unrealisedDiff = Math.round(Math.abs(calcUnrealised - brokerUnrealised) * 100) / 100;
      const grossDiff = Math.round(Math.abs(pnlResult.grossTradingPnl - comparableBrokerValue) * 100) / 100;

      let withinTolerance: boolean;
      if (comparisonStatus === 'NOT_COMPARABLE') {
        withinTolerance = true; // Not comparable definitionally; not a numerical tolerance discrepancy
      } else {
        withinTolerance = grossDiff <= this.tolerance;
      }

      // 9. Deterministic Validation State assignment
      let validationState: ValidationState;
      if (hasMissingLtp || hasMissingReferencePrice) {
        validationState = 'MISSING_DATA';
      } else if (hasStaleLtp) {
        validationState = 'STALE_DATA';
      } else if (unknownInstruments.length > 0) {
        validationState = 'UNKNOWN_INSTRUMENTS';
      } else if (!withinTolerance) {
        validationState = 'DISCREPANCY';
      } else {
        validationState = 'VALID';
      }

      return {
        timestamp: evaluationTime.toISOString(),
        tradingDate,
        source: 'ZERODHA_LIVE',
        marketDataStatus,
        calculated: {
          dailyRealisedPnl: calcRealised,
          dailyUnrealisedPnl: calcUnrealised,
          grossTradingPnl: pnlResult.grossTradingPnl,
          fnoPositionCount: pnlResult.fnoPositionCount,
          realisedPnl: calcRealised,
          unrealisedPnl: calcUnrealised,
        },
        positions: enrichedPositions.filter((p) => p.isFno && !p.unknownInstrument),
        brokerReported: {
          realisedPnl: brokerRealised,
          unrealisedPnl: brokerUnrealised,
          pnl: brokerPnl,
          m2m: hasBrokerM2m ? brokerM2m : undefined,
          grossTradingPnl: brokerPnl,
        },
        reconciliation: {
          comparisonStatus,
          comparisonReason,
          realisedDifference: realisedDiff,
          unrealisedDifference: unrealisedDiff,
          grossDifference: grossDiff,
          tolerance: this.tolerance,
          withinTolerance,
        },
        unknownInstruments,
        validationState,
        validationGate: 'CLOSED',
        riskIntegrationEnabled: false,
        notes: 'Phase 8 Shadow Mode — Live P&L is for reconciliation only and does NOT drive the Risk Engine or Trading Lock.',
      };
    } catch (err) {
      return this.createErrorResult(
        err instanceof Error ? err.message : 'Unknown live validation error',
        tradingDate,
        evaluationTime
      );
    }
  }

  private static createAuthRequiredResult(
    errorMessage: string,
    tradingDate: string,
    evaluationTime: Date
  ): LivePnlValidationResult {
    return {
      timestamp: evaluationTime.toISOString(),
      tradingDate,
      source: 'ZERODHA_LIVE',
      marketDataStatus: 'MISSING',
      calculated: {
        dailyRealisedPnl: 0,
        dailyUnrealisedPnl: 0,
        grossTradingPnl: 0,
        fnoPositionCount: 0,
        realisedPnl: 0,
        unrealisedPnl: 0,
      },
      unknownInstruments: [],
      validationState: 'AUTHENTICATION_REQUIRED',
      validationGate: 'CLOSED',
      riskIntegrationEnabled: false,
      notes: `Validation failed: ${errorMessage}`,
    };
  }

  private static createErrorResult(
    errorMessage: string,
    tradingDate: string,
    evaluationTime: Date
  ): LivePnlValidationResult {
    return {
      timestamp: evaluationTime.toISOString(),
      tradingDate,
      source: 'ZERODHA_LIVE',
      marketDataStatus: 'MISSING',
      calculated: {
        dailyRealisedPnl: 0,
        dailyUnrealisedPnl: 0,
        grossTradingPnl: 0,
        fnoPositionCount: 0,
        realisedPnl: 0,
        unrealisedPnl: 0,
      },
      unknownInstruments: [],
      validationState: 'ERROR',
      validationGate: 'CLOSED',
      riskIntegrationEnabled: false,
      notes: `Validation failed: ${errorMessage}`,
    };
  }
}
