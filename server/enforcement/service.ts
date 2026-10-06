import { ServerRiskStore } from '../risk/store';
import { EnforcementState, EnforcementDecision } from './types';
import { RiskSession, getTradingDateKolkata } from '../risk/engine';

/**
 * Phase 6 — Server-Authoritative Enforcement Service.
 *
 * Core Guarantees:
 * 1. Single source of truth: Consumes Phase 5 RiskSession. Never recalculates P&L.
 * 2. Active lock determination: Lock is active if state === 'LOCKED' AND currentTime < lockUntil.
 * 3. Server-authoritative time: Browser/client timestamps are completely ignored.
 * 4. Read-only: Polling enforcement status does NOT alter RiskSession or emit audit events.
 * 5. Fail-closed: Missing/unrecognized states never silently permit protected access.
 */
export class EnforcementService {
  /**
   * Retrieves the current enforcement state for an authenticated user.
   * Uses authoritative server time for lock expiration checks.
   */
  public static async getEnforcementState(
    userId: string,
    currentTime: Date = new Date()
  ): Promise<EnforcementState> {
    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      throw new Error('[EnforcementService] Valid userId is required');
    }

    const tradingDate = getTradingDateKolkata(currentTime);
    const session: RiskSession = await ServerRiskStore.getSession(userId, tradingDate);

    if (!session || typeof session !== 'object') {
      throw new Error('[EnforcementService] Failed to retrieve authoritative RiskSession');
    }

    // Fail-safe validation on unrecognized states
    if (session.state !== 'ALLOW' && session.state !== 'WARNING' && session.state !== 'LOCKED') {
      throw new Error(`[EnforcementService] Malformed or unrecognized riskState: ${session.state}`);
    }

    const nowMs = currentTime.getTime();
    const evaluatedAt = currentTime.toISOString();

    // Active lock determination
    let isLocked = false;
    let remainingSeconds = 0;
    let effectiveRiskState = session.state;

    if (session.state === 'LOCKED' && session.lockUntil) {
      const lockUntilMs = new Date(session.lockUntil).getTime();
      if (nowMs < lockUntilMs) {
        // Lock is actively in effect
        isLocked = true;
        effectiveRiskState = 'LOCKED';
        remainingSeconds = Math.max(0, Math.floor((lockUntilMs - nowMs) / 1000));
      } else {
        // Lock has elapsed under server-authoritative time
        isLocked = false;
        effectiveRiskState = 'ALLOW';
        remainingSeconds = 0;
      }
    } else if (session.state === 'WARNING') {
      isLocked = false;
      effectiveRiskState = 'WARNING';
    } else {
      isLocked = false;
      effectiveRiskState = 'ALLOW';
    }

    const reason = isLocked
      ? `Trading Firewall Locked: ${session.reason || 'Daily loss limit breached.'} Protected trading access is locked until ${session.lockUntil}.`
      : effectiveRiskState === 'WARNING'
      ? session.reason || 'Warning threshold reached. Trading access permitted with warning.'
      : session.reason || 'Trading authorized. Limits normal.';

    return {
      tradingDate: session.tradingDate,
      riskState: effectiveRiskState,
      isLocked,
      lockedAt: session.lockedAt,
      lockUntil: session.lockUntil,
      remainingSeconds,
      evaluatedAt,
      reason,
      authority: 'server',
    };
  }

  /**
   * Evaluates whether a request has authorization to execute a protected trading operation.
   * Returns an EnforcementDecision with standard HTTP status codes (200, 401, 423, 500).
   */
  public static async checkTradingAccess(
    userId?: string,
    currentTime: Date = new Date()
  ): Promise<EnforcementDecision> {
    // 1. Authentication check
    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      return {
        allowed: false,
        statusCode: 401,
        error: 'UNAUTHENTICATED',
        message: 'Authentication required. No user credentials supplied.',
        state: null,
      };
    }

    // 2. Fetch authoritative enforcement state
    try {
      const state = await this.getEnforcementState(userId, currentTime);

      if (state.isLocked) {
        return {
          allowed: false,
          statusCode: 423, // HTTP 423 Locked
          error: 'TRADING_LOCKED',
          message: 'Protected trading access is currently locked by Trading Firewall.',
          state,
        };
      }

      return {
        allowed: true,
        statusCode: 200,
        state,
      };
    } catch (err) {
      // Fail-closed: Any unexpected read or parsing failure blocks protected operations
      console.error(`[EnforcementService] Authorization check failed for user ${userId}:`, err);
      return {
        allowed: false,
        statusCode: 500,
        error: 'AUTHORIZATION_UNAVAILABLE',
        message: 'Unable to establish authoritative risk state. Protected operation denied.',
        state: null,
      };
    }
  }
}
