import { doc, setDoc } from 'firebase/firestore';
import { db } from '../../src/services/firebase';
import {
  BrokerAdapter,
  BrokerConnectionStatus,
  NormalizedPosition,
  BrokerInstrument,
  LiveBrokerStatusResponse,
  LivePositionsResponse,
} from './types';
import { mockZerodhaAdapter } from './mock/adapter';
import { liveZerodhaAdapter, LiveZerodhaAdapter } from './zerodha/liveAdapter';
import { normalizePositions, getFnoPositions } from './normalize';
import { MOCK_INSTRUMENT_MAP } from '../instruments/master';

/**
 * Broker Gateway Service.
 *
 * Coordinates broker adapter retrieval, instrument metadata attachment,
 * position normalization, and F&O filtering.
 *
 * ARCHITECTURAL SAFETY GUARANTEES (PHASE 7):
 * 1. Default broker mode is ALWAYS 'mock'.
 * 2. Live Zerodha data is strictly for DIAGNOSTIC / PREVIEW / VALIDATION purposes.
 * 3. Live positions are NOT passed to Phase 4 PnlEngine or Phase 5 RiskEngine.
 * 4. Diagnostic endpoints do not mutate RiskSession, RiskConfig, or write audit events.
 * 5. Client cannot switch server broker mode.
 */
export class BrokerService {
  private static activeAdapter: BrokerAdapter = mockZerodhaAdapter;
  private static liveAdapter: LiveZerodhaAdapter = liveZerodhaAdapter;
  private static cachedInstruments: Map<number, BrokerInstrument> | null = null;
  private static inMemoryPositionsCache = new Map<string, NormalizedPosition[]>();

  /**
   * Retrieves server-configured broker mode ('mock' | 'live').
   * Server-authoritative: Defaults to 'mock'.
   */
  public static getBrokerMode(): 'mock' | 'live' {
    const mode = (process.env.BROKER_MODE || '').toLowerCase().trim();
    return mode === 'live' ? 'live' : 'mock';
  }

  public static setActiveAdapter(adapter: BrokerAdapter) {
    this.activeAdapter = adapter;
    this.cachedInstruments = null; // Invalidate instrument cache
  }

  public static getActiveAdapter(): BrokerAdapter {
    return this.activeAdapter;
  }

  public static getLiveAdapter(): LiveZerodhaAdapter {
    return this.liveAdapter;
  }

  public static async getConnectionStatus(): Promise<BrokerConnectionStatus> {
    return await this.activeAdapter.getConnectionStatus();
  }

  public static async getInstrumentMap(): Promise<Map<number, BrokerInstrument>> {
    if (!this.cachedInstruments) {
      try {
        const instruments = await this.activeAdapter.getInstruments();
        this.cachedInstruments = new Map(instruments.map((i) => [i.instrumentToken, i]));
      } catch {
        // Fallback to mock instrument master if active adapter fails to load
        this.cachedInstruments = MOCK_INSTRUMENT_MAP;
      }
    }
    return this.cachedInstruments;
  }

  public static async getNormalizedPositions(): Promise<NormalizedPosition[]> {
    const raw = await this.activeAdapter.getPositions();
    const instrumentMap = await this.getInstrumentMap();
    return normalizePositions(raw, instrumentMap, 'MOCK_DATA');
  }

  public static async getNormalizedFnoPositions(): Promise<NormalizedPosition[]> {
    const all = await this.getNormalizedPositions();
    return getFnoPositions(all);
  }

  /**
   * Phase 7 — Live Read-Only Diagnostic Status.
   * Read-only: Does not mutate risk state or create audit events.
   */
  public static async getLiveDiagnosticStatus(userId = 'default_trader'): Promise<LiveBrokerStatusResponse> {
    const status = await this.liveAdapter.getConnectionStatus(userId);
    return {
      broker: status.broker,
      status: status.status,
      isMock: false,
      configured: status.configured ?? false,
      authenticated: status.authenticated ?? (status.status === 'AUTHENTICATED' || status.status === 'CONNECTED'),
      authenticationRequired: status.authenticationRequired ?? (status.status === 'AUTHENTICATION_REQUIRED'),
      authenticatedAt: status.authenticatedAt || null,
      expiresAt: status.expiresAt || null,
      credentials: status.credentials,
      message: status.message,
      timestamp: status.timestamp,
      mode: this.getBrokerMode(),
    };
  }

  /**
   * Phase 7 — Live Read-Only Diagnostic Positions.
   *
   * CRITICAL GUARANTEE:
   * Retrieves, normalizes, and validates live positions without feeding them to RiskEngine.
   */
  public static async getLiveDiagnosticPositions(userId = 'default_trader'): Promise<LivePositionsResponse> {
    const status = await this.liveAdapter.getConnectionStatus(userId);
    if (status.status !== 'CONNECTED' && status.status !== 'AUTHENTICATED') {
      return {
        broker: 'zerodha',
        connectionStatus: status.status,
        dataSource: 'ZERODHA_LIVE',
        positionCount: 0,
        fnoPositionCount: 0,
        positions: [],
        timestamp: new Date().toISOString(),
        diagnosticNote: `Live positions unavailable: ${status.message}`,
      };
    }

    const raw = await this.liveAdapter.getPositions(userId);

    // Resolve instrument map from live adapter (DEFECT 3: never fall back to mock master for live data)
    let instrumentMap: Map<number, BrokerInstrument>;
    try {
      const liveInstruments = await this.liveAdapter.getInstruments(userId);
      instrumentMap = new Map(liveInstruments.map((i) => [i.instrumentToken, i]));
    } catch {
      instrumentMap = new Map();
    }

    // Normalize positions with dataSource: 'ZERODHA_LIVE'
    const normalized = normalizePositions(raw, instrumentMap, 'ZERODHA_LIVE');
    const fnoPositions = getFnoPositions(normalized);

    // Cross-check validation: broker-reported unrealised vs (lastPrice - averagePrice) * quantity
    const discrepancies: Array<{
      tradingsymbol: string;
      brokerUnrealisedPnl: number;
      calculatedUnrealisedPnl: number;
      difference: number;
    }> = [];

    const unknownInstruments: Array<{
      instrumentToken: number;
      tradingsymbol: string;
      exchange: string;
      reason: string;
    }> = [];

    for (const pos of normalized) {
      if (pos.unknownInstrument || pos.segment === 'UNKNOWN') {
        unknownInstruments.push({
          instrumentToken: pos.instrumentToken,
          tradingsymbol: pos.tradingsymbol,
          exchange: pos.exchange,
          reason: `Instrument token ${pos.instrumentToken} (${pos.tradingsymbol}) not found in authoritative instrument master. F&O classification denied.`,
        });
      }

      if (pos.quantity !== 0) {
        const calculated = Math.round((pos.lastPrice - pos.averagePrice) * pos.quantity * 100) / 100;
        const diff = Math.round(Math.abs(pos.unrealisedPnl - calculated) * 100) / 100;
        if (diff > 0.01) {
          discrepancies.push({
            tradingsymbol: pos.tradingsymbol,
            brokerUnrealisedPnl: pos.unrealisedPnl,
            calculatedUnrealisedPnl: calculated,
            difference: diff,
          });
        }
      }
    }

    return {
      broker: 'zerodha',
      connectionStatus: status.status,
      dataSource: 'ZERODHA_LIVE',
      positionCount: normalized.length,
      fnoPositionCount: fnoPositions.length,
      positions: normalized,
      timestamp: new Date().toISOString(),
      diagnosticNote: 'Phase 7 Live Preview — Strictly read-only; not connected to Risk Engine.',
      unknownInstruments,
      crossCheckValidation: {
        checkedCount: normalized.length,
        discrepancies,
      },
    };
  }

  /**
   * Retrieves and caches normalized positions for a given user.
   * Attempts Firestore cache write at /users/{userId}/positions/fno with graceful memory fallback.
   */
  public static async syncPositions(
    userId: string
  ): Promise<{ all: NormalizedPosition[]; fno: NormalizedPosition[] }> {
    const all = await this.getNormalizedPositions();
    const fno = getFnoPositions(all);

    // Save to memory cache
    this.inMemoryPositionsCache.set(userId, fno);

    // Attempt persistence to Firestore cache document
    try {
      const posDocRef = doc(db, 'users', userId, 'positions', 'fno');
      await setDoc(posDocRef, {
        userId,
        count: fno.length,
        positions: fno,
        syncedAt: new Date().toISOString(),
        dataSource: 'MOCK_DATA',
      });
    } catch {
      // Graceful fallback for offline/test environments
    }

    return { all, fno };
  }

  public static getCachedFnoPositions(userId: string): NormalizedPosition[] {
    return this.inMemoryPositionsCache.get(userId) || [];
  }
}
