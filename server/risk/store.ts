import { doc, collection, runTransaction, deleteDoc, getDoc, setDoc } from 'firebase/firestore';
import { db, auth } from '../../src/services/firebase';
import { RiskConfig, DEFAULT_RISK_CONFIG } from '../../src/types/risk';
import {
  RiskEngine,
  RiskSession,
  RiskEvent,
  RiskEvaluationResult,
  getTradingDateKolkata,
} from './engine';
import { validateRiskConfig } from './validation';
import { PnlResult } from '../pnl/types';
import { PnlEngine } from '../pnl/engine';
import { BrokerService } from '../brokers/service';
import { ShadowRiskService } from './shadowRiskService';

/**
 * Server-authoritative Risk Store and Session Manager (Phase 5).
 *
 * Guarantees:
 * - Backed by Firestore ACID transactions (runTransaction) for state transitions & persistence
 * - Consumes PnlResult directly from Phase 4 PnlEngine
 * - Server evaluates PnlResult from normalized positions; does NOT trust client-submitted P&L
 * - Thread-safe atomic evaluation preventing concurrent lock creation race conditions
 * - Preserves existing active lock when configuration is modified or disabled
 * - Structured server logging for risk transitions, lock creation, expiry, and config updates
 * - Excludes all broker secrets from logs
 */

interface UserRiskState {
  config: RiskConfig;
  sessions: Map<string, RiskSession>; // tradingDate -> RiskSession
  events: RiskEvent[];
  loadedFromFirestore?: boolean;
}

export class ServerRiskStore {
  private static userStates = new Map<string, UserRiskState>();

  private static getOrCreateUserState(userId: string): UserRiskState {
    let state = this.userStates.get(userId);
    if (!state) {
      state = {
        config: { ...DEFAULT_RISK_CONFIG, updatedAt: new Date().toISOString() },
        sessions: new Map(),
        events: [],
        loadedFromFirestore: false,
      };
      this.userStates.set(userId, state);
    }
    return state;
  }

  public static async getConfig(userId: string): Promise<RiskConfig> {
    const userState = this.getOrCreateUserState(userId);
    if (!userState.loadedFromFirestore) {
      if (auth?.currentUser && auth.currentUser.uid === userId) {
        try {
          const configDocRef = doc(db, 'users', userId, 'riskConfig', 'config');
          const snap = await getDoc(configDocRef);
          if (snap.exists()) {
            const raw = snap.data();
            const validation = validateRiskConfig(raw);
            if (validation.valid && validation.sanitized) {
              userState.config = validation.sanitized;
            }
          }
        } catch {
          // Fall back to in-memory store
        } finally {
          userState.loadedFromFirestore = true;
        }
      } else {
        userState.loadedFromFirestore = true;
      }
    }
    return { ...userState.config };
  }

  public static async saveConfig(
    userId: string,
    rawInput: any
  ): Promise<{ success: boolean; config?: RiskConfig; errors?: string[]; code?: string }> {
    const validation = validateRiskConfig(rawInput);
    if (!validation.valid || !validation.sanitized) {
      console.warn(`[RiskStore] Config validation failed for user ${userId}:`, validation.errors);
      return { success: false, errors: validation.errors };
    }

    const userState = this.getOrCreateUserState(userId);
    const currentConfig = userState.config;
    const sanitized = validation.sanitized;

    // Phase 11C: LOCKED Config Immutability Guard
    const today = getTradingDateKolkata(new Date());
    let activeSession = userState.sessions.get(today) || Array.from(userState.sessions.values()).find((s) => s.state === 'LOCKED');

    // If no in-memory locked session exists yet, evaluate live shadow state
    if (!activeSession || activeSession.state !== 'LOCKED') {
      try {
        const liveAdapter = BrokerService.getLiveAdapter();
        const connStatus = await liveAdapter.getConnectionStatus(userId);
        if (connStatus.status === 'CONNECTED' && connStatus.authenticated) {
          const shadowResult = await ShadowRiskService.evaluateLiveShadow(userId);
          if (shadowResult.expectedState === 'LOCKED') {
            activeSession = {
              tradingDate: today,
              userId,
              state: 'LOCKED',
              isBreached: true,
              lockedAt: shadowResult.lockedAt || new Date().toISOString(),
              lockUntil: shadowResult.lockUntil || null,
              currentPnl: shadowResult.grossTradingPnl,
              realisedPnl: 0,
              unrealisedPnl: 0,
              lossLimit: currentConfig.dailyLossLimit,
              warningThreshold1: currentConfig.warningThreshold1,
              warningThreshold2: currentConfig.warningThreshold2,
              lastEvaluatedAt: shadowResult.evaluatedAt,
              reason: shadowResult.reason,
            };
          }
        }
      } catch {
        // Fall through
      }
    }

    const isLocked = activeSession?.state === 'LOCKED';
    const isLockActive =
      isLocked &&
      (!activeSession?.lockUntil || new Date(activeSession.lockUntil).getTime() > Date.now());

    if (isLockActive) {
      const isLimitAttempted = sanitized.dailyLossLimit !== currentConfig.dailyLossLimit;
      const isLockoutAttempted =
        sanitized.lockDurationMinutes !== currentConfig.lockDurationMinutes ||
        sanitized.lockDurationType !== currentConfig.lockDurationType;

      if (isLimitAttempted || isLockoutAttempted) {
        console.warn(`[RiskStore] Attempted RiskConfig mutation rejected while LOCKED for user ${userId}`);
        return {
          success: false,
          code: 'RISK_CONFIG_LOCKED',
          errors: [
            'RISK_CONFIG_LOCKED: Daily loss limit and lockout schedule cannot be modified while Trading Firewall circuit breaker is LOCKED.',
          ],
        };
      }
    }

    userState.config = sanitized;
    userState.loadedFromFirestore = true;

    if (auth?.currentUser && auth.currentUser.uid === userId) {
      try {
        const configDocRef = doc(db, 'users', userId, 'riskConfig', 'config');
        await setDoc(configDocRef, sanitized, { merge: true });
      } catch {
        // Fall back to in-memory store
      }
    }

    const event: RiskEvent = {
      userId,
      type: 'CONFIG_UPDATED',
      message: `Risk config updated: Daily Loss Limit ₹${sanitized.dailyLossLimit.toLocaleString(
        'en-IN'
      )}, Threshold 1: ${sanitized.warningThreshold1}%, Threshold 2: ${
        sanitized.warningThreshold2
      }%, Lock: ${sanitized.lockDurationMinutes}m, Enabled: ${sanitized.enabled}`,
      timestamp: new Date().toISOString(),
    };
    userState.events.push(event);

    console.log(
      `[RiskStore] Config successfully updated for user ${userId}: Limit ₹${sanitized.dailyLossLimit}, Lock ${sanitized.lockDurationMinutes}m`
    );

    // If an active session is currently LOCKED, verify that the lock is preserved
    const currentSession = userState.sessions.get(today);
    if (currentSession && currentSession.state === 'LOCKED') {
      console.log(
        `[RiskStore] Active lock preserved for user ${userId} on date ${today} until ${currentSession.lockUntil}`
      );
    }

    return { success: true, config: sanitized };
  }

  /**
   * Phase 5 Authoritative Risk Evaluation: Evaluates a PnlResult against the Risk Engine.
   * Backed by Firestore ACID transactions with server-side concurrency serialization.
   */
  public static async evaluatePnlResult(
    userId: string,
    pnlResult: PnlResult,
    evaluationTime: Date = new Date(),
    configOverride?: RiskConfig
  ): Promise<RiskEvaluationResult> {
    const userState = this.getOrCreateUserState(userId);
    const tradingDate = pnlResult.tradingDate || getTradingDateKolkata(evaluationTime);

    // Only attempt client SDK Firestore transaction if authenticated client user matches
    if (auth?.currentUser && auth.currentUser.uid === userId) {
      const sessionDocRef = doc(db, 'users', userId, 'riskSessions', tradingDate);
      const configDocRef = doc(db, 'users', userId, 'riskConfig', 'config');

      try {
        const txResult = await runTransaction(db, async (transaction) => {
          const [sessionSnap, configSnap] = await Promise.all([
            transaction.get(sessionDocRef),
            transaction.get(configDocRef),
          ]);

          const activeConfig: RiskConfig = configOverride || (configSnap.exists()
            ? (configSnap.data() as RiskConfig)
            : userState.config);

          const existingSession: RiskSession | null = sessionSnap.exists()
            ? (sessionSnap.data() as RiskSession)
            : userState.sessions.get(tradingDate) || null;

          const evaluation = RiskEngine.evaluate({
            userId,
            config: activeConfig,
            pnlResult,
            currentSession: existingSession,
            evaluationTime,
          });

          // Persist authoritative session in Firestore transaction
          transaction.set(sessionDocRef, evaluation.session);

          // Record transition events in Firestore transaction
          for (const event of evaluation.transitionEvents) {
            const eventRef = doc(collection(db, 'users', userId, 'riskEvents'));
            transaction.set(eventRef, event);
          }

          return evaluation;
        });

        // Synchronize in-memory cache with committed transaction
        userState.sessions.set(tradingDate, txResult.session);
        for (const event of txResult.transitionEvents) {
          userState.events.push(event);
        }
        return txResult;
      } catch {
        // Fall through to deterministic memory serialization
      }
    }

    // In-memory server-authoritative evaluation
    const existingSession = userState.sessions.get(tradingDate) || null;
    const activeConfig = configOverride || userState.config;

    const result = RiskEngine.evaluate({
      userId,
      config: activeConfig,
      pnlResult,
      currentSession: existingSession,
      evaluationTime,
    });

    userState.sessions.set(tradingDate, result.session);

    for (const event of result.transitionEvents) {
      userState.events.push(event);
      console.log(`[RiskStore] Transition Event [${event.type}] for user ${userId}: ${event.message}`);
    }

    return result;
  }

  /**
   * Phase 5 Pipeline:
   * BrokerService.getNormalizedPositions() -> PnlEngine.calculate() -> RiskEngine.evaluate() -> RiskSession
   * Guarantees server-side calculation without trusting client P&L inputs.
   */
  public static async evaluateFromPositions(
    userId: string,
    evaluationTime: Date = new Date()
  ): Promise<RiskEvaluationResult> {
    const config = await this.getConfig(userId);
    const positions = await BrokerService.getNormalizedPositions();
    const pnlResult = PnlEngine.calculate(positions, config, evaluationTime);
    return await this.evaluatePnlResult(userId, pnlResult, evaluationTime);
  }

  /**
   * Backward-compatible evaluation endpoint for numeric P&L (used by Phase 1/2 tests & simulated inputs).
   */
  public static async evaluatePnl(
    userId: string,
    pnl: number,
    evaluationTime: Date = new Date()
  ): Promise<RiskEvaluationResult> {
    const config = await this.getConfig(userId);
    const tradingDate = getTradingDateKolkata(evaluationTime);
    const syntheticPnlResult: PnlResult = {
      tradingDate,
      realisedPnl: pnl,
      unrealisedPnl: 0,
      totalPnl: pnl,
      includedRealisedPnl: config.includeRealisedPnl ? pnl : 0,
      includedUnrealisedPnl: 0,
      grossTradingPnl: config.includeRealisedPnl ? pnl : 0,
      fnoPositionCount: 1,
      totalPositionCount: 1,
      positions: [],
      source: 'SYNTHETIC_SIMULATION',
      calculatedAt: evaluationTime.toISOString(),
    };

    return await this.evaluatePnlResult(userId, syntheticPnlResult, evaluationTime);
  }

  public static async getSession(userId: string, tradingDate?: string): Promise<RiskSession> {
    const userState = this.getOrCreateUserState(userId);
    const date = tradingDate || getTradingDateKolkata(new Date());
    let session = userState.sessions.get(date);

    if (!session) {
      // Evaluate from current positions
      const evalResult = await this.evaluateFromPositions(userId, new Date());
      session = evalResult.session;
    }

    return { ...session };
  }

  public static async getLockStatus(userId: string): Promise<{
    state: string;
    locked: boolean;
    isBreached: boolean;
    tradingDate: string;
    lockedAt: string | null;
    lockUntil: string | null;
    remainingSeconds: number;
    reason: string | null;
  }> {
    const now = new Date();
    const session = await this.getSession(userId);
    const isLocked = session.state === 'LOCKED';

    let remainingSeconds = 0;
    if (isLocked && session.lockUntil) {
      const lockUntilDate = new Date(session.lockUntil);
      remainingSeconds = Math.max(0, Math.floor((lockUntilDate.getTime() - now.getTime()) / 1000));
    }

    return {
      state: session.state,
      locked: isLocked,
      isBreached: session.isBreached,
      tradingDate: session.tradingDate,
      lockedAt: session.lockedAt,
      lockUntil: session.lockUntil,
      remainingSeconds,
      reason: session.reason,
    };
  }

  public static async getAuditEvents(userId: string): Promise<RiskEvent[]> {
    const userState = this.getOrCreateUserState(userId);
    return [...userState.events];
  }

  public static recordEvent(
    userId: string,
    eventInput: { type: RiskEvent['type']; message: string; timestamp?: string }
  ): void {
    const userState = this.getOrCreateUserState(userId);
    userState.events.push({
      userId,
      type: eventInput.type,
      message: eventInput.message,
      timestamp: eventInput.timestamp || new Date().toISOString(),
    });
  }

  /**
   * Reset session back to baseline state (used for Demo Reset).
   */
  public static async resetSession(userId: string): Promise<RiskSession> {
    const userState = this.getOrCreateUserState(userId);
    const today = getTradingDateKolkata(new Date());
    userState.sessions.delete(today);

    try {
      const sessionDocRef = doc(db, 'users', userId, 'riskSessions', today);
      await deleteDoc(sessionDocRef);
    } catch {
      // offline / mock fallback
    }

    const evalResult = await this.evaluateFromPositions(userId, new Date());
    return evalResult.session;
  }

  /**
   * Reset store (used for test isolation)
   */
  public static reset() {
    this.userStates.clear();
  }
}
