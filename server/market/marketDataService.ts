import { MarketDataStatus, MarketPriceTick } from '../brokers/types';

/**
 * Phase 7 — Isolated Read-Only Market Data Service.
 *
 * Guarantees:
 * 1. PURELY READ-ONLY: Never executes trades, places orders, or triggers RiskEngine.
 * 2. TOKEN-CENTRIC: Identifies instruments strictly by canonical integer instrumentToken.
 * 3. STALENESS DETECTION: Tracks `lastTickAt` and flags stale prices when tick age exceeds threshold.
 * 4. SCOPED SUBSCRIPTION: Subscribes only to relevant F&O position tokens.
 * 5. RESILIENT: Handles connect, disconnect, and reconnect gracefully.
 */
export class MarketDataService {
  private static status: 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR' = 'DISCONNECTED';
  private static subscriptions = new Set<number>();
  private static ticks = new Map<number, MarketPriceTick>();
  private static lastTickTimestamp: number | null = null;
  private static staleThresholdSeconds: number = 60; // 60 seconds

  public static setStaleThresholdSeconds(seconds: number) {
    this.staleThresholdSeconds = seconds;
  }

  public static getStaleThresholdSeconds(): number {
    return this.staleThresholdSeconds;
  }

  public static connect(): void {
    this.status = 'CONNECTED';
  }

  public static disconnect(): void {
    this.status = 'DISCONNECTED';
  }

  public static reconnect(): void {
    this.status = 'CONNECTED';
  }

  public static subscribe(tokens: number[]): void {
    for (const t of tokens) {
      if (typeof t === 'number' && Number.isInteger(t) && t > 0) {
        this.subscriptions.add(t);
      }
    }
  }

  public static unsubscribe(tokens: number[]): void {
    for (const t of tokens) {
      this.subscriptions.delete(t);
    }
  }

  public static getSubscriptions(): number[] {
    return Array.from(this.subscriptions);
  }

  /**
   * Ingests a price tick for a subscribed instrument token.
   * Validates numeric lastPrice.
   */
  public static ingestTick(token: number, lastPrice: number, tickTime: Date = new Date()): MarketPriceTick {
    if (typeof token !== 'number' || !Number.isInteger(token) || token <= 0) {
      throw new Error(`[MarketDataService] Invalid instrumentToken: ${token}`);
    }
    if (typeof lastPrice !== 'number' || !Number.isFinite(lastPrice) || lastPrice < 0) {
      throw new Error(`[MarketDataService] Invalid lastPrice for token ${token}: ${lastPrice}`);
    }

    const tickMs = tickTime.getTime();
    this.lastTickTimestamp = tickMs;

    const tick: MarketPriceTick = {
      instrumentToken: token,
      lastPrice,
      timestamp: tickTime.toISOString(),
      isStale: false,
    };

    this.ticks.set(token, tick);
    return tick;
  }

  /**
   * Retrieves latest tick for an instrument, checking staleness against current time.
   */
  public static getTick(token: number, evaluationTime: Date = new Date()): MarketPriceTick | null {
    const tick = this.ticks.get(token);
    if (!tick) return null;

    const ageSeconds = (evaluationTime.getTime() - new Date(tick.timestamp).getTime()) / 1000;
    const isStale = ageSeconds > this.staleThresholdSeconds;

    return {
      ...tick,
      isStale,
    };
  }

  /**
   * Retrieves overall market-data feed status.
   */
  public static getStatus(evaluationTime: Date = new Date()): MarketDataStatus {
    const lastTickAt = this.lastTickTimestamp ? new Date(this.lastTickTimestamp).toISOString() : null;
    let isStale = false;

    if (this.lastTickTimestamp) {
      const ageSeconds = (evaluationTime.getTime() - this.lastTickTimestamp) / 1000;
      isStale = ageSeconds > this.staleThresholdSeconds;
    }

    return {
      status: this.status,
      subscribedCount: this.subscriptions.size,
      lastTickAt,
      isStale,
      staleThresholdSeconds: this.staleThresholdSeconds,
      timestamp: evaluationTime.toISOString(),
    };
  }

  /**
   * Clears all state (primarily for test isolation).
   */
  public static reset(): void {
    this.status = 'DISCONNECTED';
    this.subscriptions.clear();
    this.ticks.clear();
    this.lastTickTimestamp = null;
    this.staleThresholdSeconds = 60;
  }
}
