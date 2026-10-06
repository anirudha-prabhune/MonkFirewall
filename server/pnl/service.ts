import { doc, setDoc } from 'firebase/firestore';
import { db } from '../../src/services/firebase';
import { BrokerService } from '../brokers/service';
import { ServerRiskStore } from '../risk/store';
import { PnlEngine } from './engine';
import { PnlResult, PnlCalculationOptions } from './types';

/**
 * P&L Calculation & Cache Service (Phase 4).
 *
 * Coordinates:
 * NormalizedPosition[] (from Phase 3) -> PnlEngine -> PnlResult -> API/UI & Firestore Cache.
 *
 * STRICT PHASE 4 BOUNDARY:
 * NO RISK ENGINE, NO RISK SESSION, NO LOCK.
 */
export class PnlService {
  private static cachedResults = new Map<string, PnlResult>();

  public static async calculateForUser(
    userId: string,
    overrides?: Partial<PnlCalculationOptions>
  ): Promise<PnlResult> {
    const [positions, config] = await Promise.all([
      BrokerService.getNormalizedPositions(),
      ServerRiskStore.getConfig(userId),
    ]);

    const includeRealised = overrides?.includeRealisedPnl ?? config.includeRealisedPnl;
    const includeUnrealised = overrides?.includeUnrealisedPnl ?? config.includeUnrealisedPnl;

    const result = PnlEngine.calculate(positions, {
      includeRealisedPnl: includeRealised,
      includeUnrealisedPnl: includeUnrealised,
    });

    // In-memory cache
    this.cachedResults.set(userId, result);

    // Optional Firestore snapshot persistence
    try {
      const pnlDocRef = doc(db, 'users', userId, 'pnl', 'latest');
      await setDoc(pnlDocRef, {
        userId,
        ...result,
        persistedAt: new Date().toISOString(),
      });
    } catch {
      // Graceful offline/test fallback
    }

    return result;
  }

  public static getCachedPnl(userId: string): PnlResult | null {
    return this.cachedResults.get(userId) || null;
  }
}
