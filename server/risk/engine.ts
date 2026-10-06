/**
 * Authoritative Server-side Risk Engine (Phase 5).
 *
 * Core Guarantees:
 * 1. PnlResult is the SOLE input for P&L evaluation. The Risk Engine NEVER calculates P&L.
 * 2. Loss Amount Semantics: lossAmount = max(0, -grossTradingPnl).
 * 3. Daily Loss Limit: Breach occurs when lossAmount >= dailyLossLimit (inclusive).
 * 4. Warning Thresholds: Evaluated against lossAmount (warning1Amount <= lossAmount < warning2Amount, etc.).
 * 5. Active Lock Precedence: An active LOCKED state takes precedence over enabled=false and improving P&L.
 * 6. Lock Lifecycle: lockedAt is created on the first breach; lockUntil = lockedAt + lockDurationMinutes.
 *    Repeated evaluations do NOT extend lockUntil.
 * 7. Lock Expiration: Occurs strictly when evaluationTime >= lockUntil, emitting TRADING_LOCK_EXPIRED once.
 * 8. Timezone: tradingDate is always Asia/Kolkata (IST).
 * 9. Concurrency & Idempotency: Duplicate warning/lock events are strictly suppressed on polling.
 */

import { RiskConfig, DEFAULT_RISK_CONFIG } from '../../src/types/risk';
import { PnlResult } from '../pnl/types';

export type RiskState = 'ALLOW' | 'WARNING' | 'LOCKED';

export class PnlIntegrityError extends Error {
  constructor(message: string) {
    super(`[PnlIntegrityError] ${message}`);
    this.name = 'PnlIntegrityError';
  }
}

export interface RiskSession {
  tradingDate: string; // YYYY-MM-DD in Asia/Kolkata
  userId: string;
  state: RiskState;
  isBreached: boolean;
  lockedAt: string | null;
  lockUntil: string | null;
  currentPnl: number;
  lossAmount?: number;
  realisedPnl: number;
  unrealisedPnl: number;
  lossLimit: number;
  warningThreshold1: number;
  warningThreshold2: number;
  lastEvaluatedAt: string;
  reason: string | null;
}

export type RiskSessionSnapshot = RiskSession;

export type RiskEventType =
  | 'CONFIG_UPDATED'
  | 'RISK_WARNING'
  | 'LOSS_LIMIT_BREACHED'
  | 'TRADING_LOCK_CREATED'
  | 'TRADING_LOCK_EXPIRED';

export interface RiskEvent {
  userId: string;
  type: RiskEventType;
  message: string;
  timestamp: string;
}

export interface RiskEvaluationInput {
  userId?: string;
  config?: RiskConfig;
  pnlResult?: PnlResult;

  // Backward-compatibility support for Phase 1 / Phase 2 direct calls:
  pnl?: number;
  realisedPnl?: number;
  unrealisedPnl?: number;
  dailyLossLimit?: number;
  warningThreshold1?: number;
  warningThreshold2?: number;
  lockDurationMinutes?: number;
  lockDurationType?: 'FIXED' | 'UNTIL_4PM';
  includeRealised?: boolean;
  includeUnrealised?: boolean;
  currentSession?: any;
  evaluationTime?: Date;
}

export interface RiskEvaluationResult {
  state: RiskState;
  totalPnl: number;
  grossTradingPnl: number;
  currentPnl: number;
  lossAmount: number;
  lossUtilizedPercent: number;
  isBreached: boolean;
  tradingDate: string;
  lockedAt: string | null;
  lockUntil: string | null;
  reason: string | null;

  session: RiskSession;
  transitionEvents: RiskEvent[];
  isIdempotent: boolean;
}

/**
 * Returns trading calendar date in Asia/Kolkata (IST) YYYY-MM-DD
 */
export function getTradingDateKolkata(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;

  return `${year}-${month}-${day}`;
}

export class RiskEngine {
  public static evaluate(input: RiskEvaluationInput): RiskEvaluationResult {
    const evaluationTime = input.evaluationTime || new Date();
    const nowIso = evaluationTime.toISOString();
    const tradingDate = getTradingDateKolkata(evaluationTime);
    const userId = input.userId || 'default_trader';

    // Resolve configuration
    const config: RiskConfig = input.config || {
      dailyLossLimit: input.dailyLossLimit ?? DEFAULT_RISK_CONFIG.dailyLossLimit,
      warningThreshold1: input.warningThreshold1 ?? DEFAULT_RISK_CONFIG.warningThreshold1,
      warningThreshold2: input.warningThreshold2 ?? DEFAULT_RISK_CONFIG.warningThreshold2,
      lockDurationMinutes: input.lockDurationMinutes ?? DEFAULT_RISK_CONFIG.lockDurationMinutes,
      lockDurationType: input.lockDurationType ?? DEFAULT_RISK_CONFIG.lockDurationType ?? 'FIXED',
      includeRealisedPnl: input.includeRealised ?? DEFAULT_RISK_CONFIG.includeRealisedPnl,
      includeUnrealisedPnl: input.includeUnrealised ?? DEFAULT_RISK_CONFIG.includeUnrealisedPnl,
      enabled: true,
    };

    // -------------------------------------------------------------
    // 1. EXTRACT & VALIDATE AUTHORITATIVE P&L
    // -------------------------------------------------------------
    let grossTradingPnl: number;
    let realised = 0;
    let unrealised = 0;
    let effectiveTradingDate = tradingDate;

    if (input.pnlResult !== undefined) {
      const pnlRes = input.pnlResult;
      // Integrity check
      if (
        !pnlRes ||
        typeof pnlRes !== 'object' ||
        typeof pnlRes.grossTradingPnl !== 'number' ||
        !Number.isFinite(pnlRes.grossTradingPnl)
      ) {
        throw new PnlIntegrityError(
          `Invalid PnlResult: grossTradingPnl must be a finite number, received ${pnlRes?.grossTradingPnl}`
        );
      }
      grossTradingPnl = pnlRes.grossTradingPnl;
      realised = pnlRes.realisedPnl;
      unrealised = pnlRes.unrealisedPnl;
      if (pnlRes.tradingDate) {
        effectiveTradingDate = pnlRes.tradingDate;
      }
    } else if (input.pnl !== undefined) {
      if (typeof input.pnl !== 'number' || !Number.isFinite(input.pnl)) {
        throw new PnlIntegrityError(`Invalid pnl: must be a finite number, received ${input.pnl}`);
      }
      grossTradingPnl = input.pnl;
      realised = input.realisedPnl ?? grossTradingPnl;
      unrealised = input.unrealisedPnl ?? 0;
    } else {
      realised = input.realisedPnl ?? 0;
      unrealised = input.unrealisedPnl ?? 0;
      grossTradingPnl =
        (config.includeRealisedPnl ? realised : 0) +
        (config.includeUnrealisedPnl ? unrealised : 0);
    }

    // -------------------------------------------------------------
    // 2. LOSS SEMANTICS
    // lossAmount = max(0, -grossTradingPnl)
    // -------------------------------------------------------------
    const lossAmount = Math.max(0, -grossTradingPnl);

    const lossUtilizedPercent =
      config.dailyLossLimit > 0 ? (lossAmount / config.dailyLossLimit) * 100 : 0;

    const previousSession = input.currentSession;
    const transitionEvents: RiskEvent[] = [];

    // Check if the previous session was locked
    const wasLocked =
      previousSession?.state === 'LOCKED' || previousSession?.isBreached === true;

    // Check if lock is still active
    let isLockActive = false;
    if (wasLocked && previousSession?.lockUntil) {
      const lockUntilDate = new Date(previousSession.lockUntil);
      isLockActive = evaluationTime.getTime() < lockUntilDate.getTime();
    }

    // -------------------------------------------------------------
    // CASE 1: ACTIVE LOCK PERSISTENCE
    // Active lock strictly takes precedence over improving P&L and enabled=false
    // -------------------------------------------------------------
    if (wasLocked && isLockActive) {
      const lockedSession: RiskSession = {
        tradingDate: previousSession?.tradingDate || effectiveTradingDate,
        userId,
        state: 'LOCKED',
        isBreached: true,
        lockedAt: previousSession?.lockedAt || nowIso,
        lockUntil: previousSession?.lockUntil || nowIso,
        currentPnl: grossTradingPnl,
        lossAmount,
        realisedPnl: realised,
        unrealisedPnl: unrealised,
        lossLimit: config.dailyLossLimit,
        warningThreshold1: config.warningThreshold1,
        warningThreshold2: config.warningThreshold2,
        lastEvaluatedAt: nowIso,
        reason: previousSession?.reason || 'Daily loss limit breached (Active Lock)',
      };

      return {
        state: 'LOCKED',
        totalPnl: grossTradingPnl,
        grossTradingPnl,
        currentPnl: grossTradingPnl,
        lossAmount,
        lossUtilizedPercent,
        isBreached: true,
        tradingDate: lockedSession.tradingDate,
        lockedAt: lockedSession.lockedAt,
        lockUntil: lockedSession.lockUntil,
        reason: lockedSession.reason,
        session: lockedSession,
        transitionEvents: [],
        isIdempotent: true,
      };
    }

    // -------------------------------------------------------------
    // CASE 2: LOCK EXPIRATION
    // Lock expired at evaluationTime >= lockUntil
    // -------------------------------------------------------------
    let lockJustExpired = false;
    if (wasLocked && !isLockActive) {
      lockJustExpired = true;
      transitionEvents.push({
        userId,
        type: 'TRADING_LOCK_EXPIRED',
        message: `Trading lock expired at ${nowIso} after completing ${config.lockDurationMinutes}m lock duration.`,
        timestamp: nowIso,
      });
    }

    // -------------------------------------------------------------
    // CASE 3: DISABLED CONFIGURATION
    // Only applies if no active lock exists
    // -------------------------------------------------------------
    if (!config.enabled) {
      const session: RiskSession = {
        tradingDate: effectiveTradingDate,
        userId,
        state: 'ALLOW',
        isBreached: false,
        lockedAt: null,
        lockUntil: null,
        currentPnl: grossTradingPnl,
        lossAmount,
        realisedPnl: realised,
        unrealisedPnl: unrealised,
        lossLimit: config.dailyLossLimit,
        warningThreshold1: config.warningThreshold1,
        warningThreshold2: config.warningThreshold2,
        lastEvaluatedAt: nowIso,
        reason: 'Risk protection disabled by user configuration',
      };

      return {
        state: 'ALLOW',
        totalPnl: grossTradingPnl,
        grossTradingPnl,
        currentPnl: grossTradingPnl,
        lossAmount,
        lossUtilizedPercent,
        isBreached: false,
        tradingDate: effectiveTradingDate,
        lockedAt: null,
        lockUntil: null,
        reason: session.reason,
        session,
        transitionEvents,
        isIdempotent: previousSession?.state === 'ALLOW' && !lockJustExpired,
      };
    }

    // -------------------------------------------------------------
    // CASE 4: NEW LOSS LIMIT BREACH -> LOCKED
    // lossAmount >= dailyLossLimit (inclusive comparison)
    // -------------------------------------------------------------
    const isNewlyBreached = lossAmount >= config.dailyLossLimit;

    if (isNewlyBreached) {
      const lockedAt = nowIso;
      let lockUntil: string;
      let durationDesc: string;

      if (config.lockDurationType === 'UNTIL_4PM') {
        // "Until 4:00 PM" must use Asia/Kolkata and the current trading date.
        // 4:00 PM in Asia/Kolkata is 16:00:00.000+05:30 (10:30 UTC)
        const fourPmDate = new Date(`${effectiveTradingDate}T16:00:00.000+05:30`);
        lockUntil = fourPmDate.toISOString();
        durationDesc = 'Until 4:00 PM IST';
      } else {
        const durationMinutes = config.lockDurationMinutes || DEFAULT_RISK_CONFIG.lockDurationMinutes;
        lockUntil = new Date(
          evaluationTime.getTime() + durationMinutes * 60 * 1000
        ).toISOString();
        durationDesc = `${durationMinutes} minutes`;
      }

      transitionEvents.push({
        userId,
        type: 'LOSS_LIMIT_BREACHED',
        message: `Daily loss limit of ₹${config.dailyLossLimit.toLocaleString(
          'en-IN'
        )} breached with loss ₹${lossAmount.toLocaleString('en-IN')}.`,
        timestamp: nowIso,
      });

      transitionEvents.push({
        userId,
        type: 'TRADING_LOCK_CREATED',
        message: `Trading lock established until ${lockUntil} (${durationDesc}).`,
        timestamp: nowIso,
      });

      const session: RiskSession = {
        tradingDate: effectiveTradingDate,
        userId,
        state: 'LOCKED',
        isBreached: true,
        lockedAt,
        lockUntil,
        currentPnl: grossTradingPnl,
        lossAmount,
        realisedPnl: realised,
        unrealisedPnl: unrealised,
        lossLimit: config.dailyLossLimit,
        warningThreshold1: config.warningThreshold1,
        warningThreshold2: config.warningThreshold2,
        lastEvaluatedAt: nowIso,
        reason: `Daily loss limit of ₹${config.dailyLossLimit.toLocaleString('en-IN')} breached`,
      };

      return {
        state: 'LOCKED',
        totalPnl: grossTradingPnl,
        grossTradingPnl,
        currentPnl: grossTradingPnl,
        lossAmount,
        lossUtilizedPercent,
        isBreached: true,
        tradingDate: effectiveTradingDate,
        lockedAt,
        lockUntil,
        reason: session.reason,
        session,
        transitionEvents,
        isIdempotent: false,
      };
    }

    // -------------------------------------------------------------
    // CASE 5: WARNING OR ALLOW
    // warning1Amount <= lossAmount < warning2Amount -> WARNING
    // warning2Amount <= lossAmount < dailyLossLimit -> WARNING
    // -------------------------------------------------------------
    let state: RiskState = 'ALLOW';
    let reason: string | null = null;

    const warning1Amount = (config.dailyLossLimit * config.warningThreshold1) / 100;
    const warning2Amount = (config.dailyLossLimit * config.warningThreshold2) / 100;

    if (lossAmount >= warning2Amount) {
      state = 'WARNING';
      reason = `Loss utilized ${lossUtilizedPercent.toFixed(1)}% (Threshold 2: ${
        config.warningThreshold2
      }%)`;
    } else if (lossAmount >= warning1Amount) {
      state = 'WARNING';
      reason = `Loss utilized ${lossUtilizedPercent.toFixed(1)}% (Threshold 1: ${
        config.warningThreshold1
      }%)`;
    }

    // Idempotency: Emit RISK_WARNING only when entering WARNING state
    if (state === 'WARNING' && (!previousSession || previousSession.state !== 'WARNING')) {
      transitionEvents.push({
        userId,
        type: 'RISK_WARNING',
        message: `Risk warning: Daily loss reached ${lossUtilizedPercent.toFixed(1)}% of limit.`,
        timestamp: nowIso,
      });
    }

    const session: RiskSession = {
      tradingDate: effectiveTradingDate,
      userId,
      state,
      isBreached: false,
      lockedAt: null,
      lockUntil: null,
      currentPnl: grossTradingPnl,
      lossAmount,
      realisedPnl: realised,
      unrealisedPnl: unrealised,
      lossLimit: config.dailyLossLimit,
      warningThreshold1: config.warningThreshold1,
      warningThreshold2: config.warningThreshold2,
      lastEvaluatedAt: nowIso,
      reason,
    };

    return {
      state,
      totalPnl: grossTradingPnl,
      grossTradingPnl,
      currentPnl: grossTradingPnl,
      lossAmount,
      lossUtilizedPercent,
      isBreached: false,
      tradingDate: effectiveTradingDate,
      lockedAt: null,
      lockUntil: null,
      reason,
      session,
      transitionEvents,
      isIdempotent: previousSession?.state === state && !lockJustExpired,
    };
  }
}
