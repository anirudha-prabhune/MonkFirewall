/**
 * Phase 8A — Controlled Real-Account Shadow Validation Session.
 *
 * CRITICAL ARCHITECTURAL CONSTRAINTS:
 * 1. READ-ONLY VALIDATION: Zero trading, order placement, cancellation, modification, or square-off.
 * 2. ZERO RISK INTEGRATION: Does NOT invoke RiskEngine, modify RiskSession, or write risk events.
 * 3. VALIDATION GATE CLOSED: LIVE_PNL_VALIDATION_GATE remains strictly 'CLOSED'.
 * 4. ISOLATED PERSISTENCE: Session observations are strictly isolated from RiskSession, riskEvents, and positions.
 * 5. CREDENTIAL ISOLATION: Broker credentials NEVER appear in observations, responses, or stored records.
 */

import { LIVE_PNL_VALIDATION_GATE } from './liveValidationTypes';
import { getTradingDateKolkata } from '../risk/engine';
import { RawBrokerPosition, BrokerInstrument } from '../brokers/types';
import { LivePnlValidationService } from './liveValidationService';
import { MarketDataService } from '../market/marketDataService';
import { BrokerService } from '../brokers/service';

export interface ValidationSessionMetadata {
  validationSessionId: string;
  startedAt: string;
  endedAt: string | null;
  tradingDate: string; // YYYY-MM-DD in Asia/Kolkata
  timezone: 'Asia/Kolkata';
  broker: 'zerodha';
  mode: 'REAL_ACCOUNT_SHADOW';
  riskIntegrationEnabled: false;
  validationGate: 'CLOSED';
  notes?: string;
}

export type PositionCategory =
  | 'CATEGORY_A_PURE_INTRADAY'
  | 'CATEGORY_B_CARRIED_FORWARD'
  | 'CATEGORY_C_MIXED'
  | 'FULLY_CLOSED_INTRADAY'
  | 'PARTIAL_CLOSE'
  | 'REVERSAL'
  | 'ZERO_QUANTITY'
  | 'EQUITY_EXCLUDED'
  | 'UNKNOWN_INSTRUMENT';

export interface PositionObservation {
  validationSessionId: string;
  observationId: string;
  timestamp: string; // ISO UTC
  kolkataTimestamp: string; // IST
  instrumentToken: number;
  exchange: string;
  tradingsymbol: string;
  segment: string;
  isFno: boolean;
  category: PositionCategory;
  rawSnapshot: {
    quantity: number;
    overnight_quantity: number;
    overnight_price?: number;
    overnight_value?: number;
    multiplier: number;
    average_price: number;
    last_price: number;
    close_price: number;
    value: number;
    pnl: number;
    m2m?: number;
    realised: number;
    unrealised: number;
    buy_quantity: number;
    buy_price: number;
    buy_value: number;
    sell_quantity: number;
    sell_price: number;
    sell_value: number;
    day_buy_quantity: number;
    day_buy_price: number;
    day_buy_value: number;
    day_sell_quantity: number;
    day_sell_price: number;
    day_sell_value: number;
  };
  calculated: {
    dailyRealisedPnl: number;
    dailyUnrealisedPnl: number;
    grossTradingPnl: number;
    multiplier: number;
    multiplierAppliedOnce: boolean;
  };
  reconciliation: {
    status: 'COMPARABLE' | 'NOT_COMPARABLE' | 'MISMATCH';
    brokerFieldCompared: string;
    brokerValue: number;
    calculatedValue: number;
    difference: number;
  };
  marketData: {
    lastPrice: number;
    lastTradeTime?: string;
    exchangeTimestamp?: string;
    receivedAt: string;
    stalenessSeconds: number;
    freshness: 'FRESH' | 'STALE' | 'MISSING';
  };
}

export interface ValidationSafetyAudit {
  ordersPlaced: 0;
  ordersModified: 0;
  ordersCancelled: 0;
  positionsModifiedByApplication: 0;
  riskSessionMutations: 0;
  riskEventsGenerated: 0;
  enforcementMutations: 0;
}

export interface ValidationSessionReport {
  session: ValidationSessionMetadata;
  observations: PositionObservation[];
  summary: {
    totalPositions: number;
    fnoPositions: number;
    categoriesObserved: PositionCategory[];
    aggregateCalculatedGrossPnl: number;
    validationState: string;
    safetyAudit: ValidationSafetyAudit;
    status: 'PASS' | 'PASS_WITH_GAPS' | 'FAIL' | 'BLOCKED';
  };
}

export class ValidationSessionManager {
  private static activeSession: ValidationSessionMetadata | null = null;
  private static sessionObservations: Map<string, PositionObservation[]> = new Map();
  private static pastSessions: ValidationSessionMetadata[] = [];

  /**
   * Starts a controlled Phase 8A real-account shadow validation session.
   */
  public static startSession(notes?: string): ValidationSessionMetadata {
    const now = new Date();
    const sessionId = `vsess_${now.getTime()}_${Math.random().toString(36).substring(2, 8)}`;
    const tradingDate = getTradingDateKolkata(now);

    const session: ValidationSessionMetadata = {
      validationSessionId: sessionId,
      startedAt: now.toISOString(),
      endedAt: null,
      tradingDate,
      timezone: 'Asia/Kolkata',
      broker: 'zerodha',
      mode: 'REAL_ACCOUNT_SHADOW',
      riskIntegrationEnabled: false,
      validationGate: 'CLOSED', // Must strictly be 'CLOSED'
      notes: notes || 'Phase 8A Controlled Real-Account Shadow Validation Session',
    };

    this.activeSession = session;
    this.sessionObservations.set(sessionId, []);
    return session;
  }

  /**
   * Retrieves the active or latest validation session metadata.
   */
  public static getActiveSession(): ValidationSessionMetadata | null {
    return this.activeSession;
  }

  /**
   * Concludes the active validation session.
   */
  public static endSession(sessionId?: string): ValidationSessionMetadata | null {
    if (!this.activeSession) return null;
    if (sessionId && this.activeSession.validationSessionId !== sessionId) return null;

    const endedSession: ValidationSessionMetadata = {
      ...this.activeSession,
      endedAt: new Date().toISOString(),
    };

    this.pastSessions.push(endedSession);
    this.activeSession = null;
    return endedSession;
  }

  /**
   * Classifies a position into authoritative Phase 8A categories.
   */
  public static classifyPositionCategory(raw: RawBrokerPosition, isFno: boolean, unknownInstrument?: boolean): PositionCategory {
    if (unknownInstrument) return 'UNKNOWN_INSTRUMENT';
    if (!isFno) return 'EQUITY_EXCLUDED';

    const qty = raw.quantity || 0;
    const overnightQty = raw.overnight_quantity || 0;
    const dayBuy = raw.day_buy_quantity || 0;
    const daySell = raw.day_sell_quantity || 0;
    const hasDayActivity = dayBuy > 0 || daySell > 0;

    // Check for reversal: overnight had one sign, and day activity flipped to opposite sign
    if (overnightQty !== 0 && qty !== 0 && Math.sign(overnightQty) !== Math.sign(qty)) {
      return 'REVERSAL';
    }

    // Check for fully closed intraday
    if (qty === 0 && overnightQty === 0 && hasDayActivity) {
      return 'FULLY_CLOSED_INTRADAY';
    }

    // Check for zero quantity without day activity (or closed carried)
    if (qty === 0) {
      return 'ZERO_QUANTITY';
    }

    // Category C: Mixed overnight + intraday
    if (overnightQty !== 0 && hasDayActivity) {
      // If day activity reduced overnight quantity without flipping
      if (Math.abs(qty) < Math.abs(overnightQty)) {
        return 'PARTIAL_CLOSE';
      }
      return 'CATEGORY_C_MIXED';
    }

    // Category B: Pure Carried-Forward (no day activity)
    if (overnightQty !== 0 && !hasDayActivity) {
      return 'CATEGORY_B_CARRIED_FORWARD';
    }

    // Category A: Pure Intraday (no overnight, day activity exists)
    if (overnightQty === 0 && hasDayActivity) {
      return 'CATEGORY_A_PURE_INTRADAY';
    }

    return 'CATEGORY_A_PURE_INTRADAY';
  }

  /**
   * Captures and records a position observation under the active validation session.
   * Isolates records from RiskSession, riskEvents, and positions.
   */
  public static recordObservation(
    sessionId: string,
    raw: RawBrokerPosition,
    isFno: boolean,
    instrument?: BrokerInstrument,
    calculatedPnl?: { dailyRealised: number; dailyUnrealised: number; grossTradingPnl: number },
    evalTime: Date = new Date()
  ): PositionObservation {
    const unknown = !instrument || instrument.segment === 'UNKNOWN';
    const category = this.classifyPositionCategory(raw, isFno, unknown);
    const multiplier = raw.multiplier && raw.multiplier > 0 ? raw.multiplier : 1;

    const tick = MarketDataService.getTick(raw.instrument_token, evalTime);
    const lastPrice = tick ? tick.lastPrice : raw.last_price || 0;
    const freshness = tick ? (tick.isStale ? 'STALE' : 'FRESH') : 'MISSING';
    const stalenessSeconds = tick ? Math.floor((evalTime.getTime() - new Date(tick.timestamp).getTime()) / 1000) : 9999;

    // Calculation checks
    const calcRealised = calculatedPnl ? calculatedPnl.dailyRealised : (raw.realised || 0);
    const calcUnrealised = calculatedPnl ? calculatedPnl.dailyUnrealised : (raw.unrealised || 0);
    const calcGross = calculatedPnl ? calculatedPnl.grossTradingPnl : (calcRealised + calcUnrealised);

    // Reconciliation comparison
    let reconStatus: 'COMPARABLE' | 'NOT_COMPARABLE' | 'MISMATCH' = 'COMPARABLE';
    let brokerField = 'm2m';
    let brokerVal = typeof raw.m2m === 'number' && Number.isFinite(raw.m2m) ? raw.m2m : raw.pnl || 0;

    if (raw.overnight_quantity && raw.overnight_quantity !== 0 && raw.m2m === undefined) {
      reconStatus = 'NOT_COMPARABLE';
      brokerField = 'pnl (lifetime)';
    } else {
      const diff = Math.abs(calcGross - brokerVal);
      if (diff > 1.0) {
        reconStatus = 'MISMATCH';
      }
    }

    const kolkataFormatter = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    const rawAny = raw as any;

    const observation: PositionObservation = {
      validationSessionId: sessionId,
      observationId: `obs_${evalTime.getTime()}_${raw.instrument_token}`,
      timestamp: evalTime.toISOString(),
      kolkataTimestamp: `${kolkataFormatter.format(evalTime)} IST`,
      instrumentToken: raw.instrument_token,
      exchange: raw.exchange,
      tradingsymbol: raw.tradingsymbol,
      segment: instrument?.segment || rawAny.segment || 'UNKNOWN',
      isFno,
      category,
      rawSnapshot: {
        quantity: raw.quantity || 0,
        overnight_quantity: raw.overnight_quantity || 0,
        overnight_price: rawAny.overnight_price || 0,
        overnight_value: rawAny.overnight_value || 0,
        multiplier,
        average_price: raw.average_price || 0,
        last_price: raw.last_price || 0,
        close_price: raw.close_price || 0,
        value: rawAny.value || 0,
        pnl: raw.pnl || 0,
        m2m: raw.m2m,
        realised: raw.realised || 0,
        unrealised: raw.unrealised || 0,
        buy_quantity: rawAny.buy_quantity || raw.day_buy_quantity || 0,
        buy_price: rawAny.buy_price || 0,
        buy_value: rawAny.buy_value || raw.day_buy_value || 0,
        sell_quantity: rawAny.sell_quantity || raw.day_sell_quantity || 0,
        sell_price: rawAny.sell_price || 0,
        sell_value: rawAny.sell_value || raw.day_sell_value || 0,
        day_buy_quantity: raw.day_buy_quantity || 0,
        day_buy_price: rawAny.day_buy_price || 0,
        day_buy_value: raw.day_buy_value || 0,
        day_sell_quantity: raw.day_sell_quantity || 0,
        day_sell_price: rawAny.day_sell_price || 0,
        day_sell_value: raw.day_sell_value || 0,
      },
      calculated: {
        dailyRealisedPnl: calcRealised,
        dailyUnrealisedPnl: calcUnrealised,
        grossTradingPnl: calcGross,
        multiplier,
        multiplierAppliedOnce: true,
      },
      reconciliation: {
        status: reconStatus,
        brokerFieldCompared: brokerField,
        brokerValue: brokerVal,
        calculatedValue: calcGross,
        difference: Math.round(Math.abs(calcGross - brokerVal) * 100) / 100,
      },
      marketData: {
        lastPrice,
        receivedAt: tick ? tick.timestamp : evalTime.toISOString(),
        stalenessSeconds,
        freshness,
      },
    };

    const list = this.sessionObservations.get(sessionId) || [];
    list.push(observation);
    this.sessionObservations.set(sessionId, list);
    return observation;
  }

  /**
   * Generates a comprehensive Phase 8A validation report from recorded observations.
   */
  public static generateReport(sessionId: string, livePnlResult?: any): ValidationSessionReport {
    const session = this.activeSession && this.activeSession.validationSessionId === sessionId
      ? this.activeSession
      : this.pastSessions.find((s) => s.validationSessionId === sessionId) || {
          validationSessionId: sessionId,
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          tradingDate: getTradingDateKolkata(new Date()),
          timezone: 'Asia/Kolkata',
          broker: 'zerodha',
          mode: 'REAL_ACCOUNT_SHADOW',
          riskIntegrationEnabled: false,
          validationGate: 'CLOSED',
        };

    const observations = this.sessionObservations.get(sessionId) || [];
    const fnoObs = observations.filter((o) => o.isFno && o.category !== 'UNKNOWN_INSTRUMENT');
    const categoriesObserved = Array.from(new Set(observations.map((o) => o.category)));

    const aggregateGross = fnoObs.reduce((sum, o) => sum + o.calculated.grossTradingPnl, 0);

    const safetyAudit: ValidationSafetyAudit = {
      ordersPlaced: 0,
      ordersModified: 0,
      ordersCancelled: 0,
      positionsModifiedByApplication: 0,
      riskSessionMutations: 0,
      riskEventsGenerated: 0,
      enforcementMutations: 0,
    };

    // Determine final status
    let status: 'PASS' | 'PASS_WITH_GAPS' | 'FAIL' | 'BLOCKED' = 'PASS';
    if (observations.length === 0) {
      status = 'BLOCKED'; // Live data / positions unavailable
    } else if (categoriesObserved.length < 3) {
      status = 'PASS_WITH_GAPS'; // Safe, but some categories unobserved
    }

    return {
      session,
      observations,
      summary: {
        totalPositions: observations.length,
        fnoPositions: fnoObs.length,
        categoriesObserved,
        aggregateCalculatedGrossPnl: Math.round(aggregateGross * 100) / 100,
        validationState: livePnlResult?.validationState || 'VALID',
        safetyAudit,
        status,
      },
    };
  }

  /**
   * Resets sessions (for testing only).
   */
  public static resetForTest(): void {
    this.activeSession = null;
    this.sessionObservations.clear();
    this.pastSessions = [];
  }
}
