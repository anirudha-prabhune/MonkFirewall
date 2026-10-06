/**
 * Phase 8 — Live Zerodha P&L Validation & Shadow Mode Types.
 *
 * CRITICAL ARCHITECTURAL CONSTRAINTS:
 * 1. SHADOW MODE ONLY: Live P&L is for reconciliation and diagnostic comparison only.
 * 2. ZERO RISK INTEGRATION: Does NOT feed RiskEngine, RiskSession, or Enforcement.
 * 3. VALIDATION GATE CLOSED: Integration remains disabled until explicit human authorization.
 */

export const LIVE_PNL_VALIDATION_GATE: 'CLOSED' | 'OPEN' = 'CLOSED';
export const DEFAULT_RECONCILIATION_TOLERANCE = 1.00; // ₹1.00 absolute tolerance

export type ValidationState =
  | 'VALID'
  | 'DISCREPANCY'
  | 'STALE_DATA'
  | 'MISSING_DATA'
  | 'UNKNOWN_INSTRUMENTS'
  | 'AUTHENTICATION_REQUIRED'
  | 'ERROR';

export type ComparisonStatus = 'COMPARABLE' | 'NOT_COMPARABLE' | 'PARTIALLY_COMPARABLE';

export type MarketDataFreshness = 'FRESH' | 'STALE' | 'MISSING';

export interface LivePnlValidationResult {
  timestamp: string;
  tradingDate: string; // YYYY-MM-DD (Asia/Kolkata)
  source: 'ZERODHA_LIVE';

  marketDataStatus: MarketDataFreshness;

  calculated: {
    dailyRealisedPnl: number;
    dailyUnrealisedPnl: number;
    grossTradingPnl: number;
    fnoPositionCount: number;
    realisedPnl: number;
    unrealisedPnl: number;
  };

  positions?: import('../brokers/types').NormalizedPosition[];

  brokerReported?: {
    realisedPnl: number;
    unrealisedPnl: number;
    pnl: number;
    m2m?: number;
    grossTradingPnl?: number;
  };

  reconciliation?: {
    comparisonStatus: ComparisonStatus;
    comparisonReason?: string;
    realisedDifference: number;
    unrealisedDifference: number;
    grossDifference: number;
    tolerance: number;
    withinTolerance: boolean;
  };

  unknownInstruments: Array<{
    instrumentToken: number;
    tradingsymbol: string;
    exchange: string;
    reason: string;
  }>;

  validationState: ValidationState;

  validationGate: 'CLOSED';
  riskIntegrationEnabled: false; // Must ALWAYS be false in Phase 8
  notes?: string;
}
