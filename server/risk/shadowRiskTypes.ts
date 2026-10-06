/**
 * PHASE 9 — LIVE P&L → RISK ENGINE SHADOW INTEGRATION TYPES
 *
 * NON-NEGOTIABLE ARCHITECTURAL INVARIANTS:
 * 1. LIVE_PNL_VALIDATION_GATE remains CLOSED.
 * 2. riskIntegrationEnabled remains false.
 * 3. Shadow mode MUST NOT mutate RiskSession.
 * 4. MUST NOT create/update riskEvents.
 * 5. MUST NOT create/expire locks.
 * 6. MUST NOT invoke Enforcement.
 * 7. ZERO order/place/modify/cancel/square-off operations.
 * 8. Consumes validated PnlResult.grossTradingPnl; no duplicated P&L calculations.
 */

export interface ShadowRiskResult {
  shadow: true;
  dataSource: 'ZERODHA_LIVE';
  evaluatedAt: string;
  tradingDate: string;

  grossTradingPnl: number;
  lossAmount: number; // max(0, -grossTradingPnl)
  dailyLossLimit: number;
  warningThreshold1: number; // percentage, e.g. 70
  warningThreshold2: number; // percentage, e.g. 85
  warning1Amount: number;    // currency amount, e.g. ₹3,500
  warning2Amount: number;    // currency amount, e.g. ₹4,250
  lossUtilizedPercent: number;

  expectedState: 'ALLOW' | 'WARNING' | 'LOCKED';
  isBreached: boolean;
  reason: string;

  validationState: string;
  validationGate: 'CLOSED';
  riskIntegrationEnabled: false;

  pnlResult: {
    grossTradingPnl: number;
    realisedPnl: number;
    unrealisedPnl: number;
    dailyRealisedPnl: number;
    dailyUnrealisedPnl: number;
    fnoPositionCount: number;
  };

  reconciliation?: {
    comparisonStatus: string;
    comparisonReason?: string;
    realisedDifference: number;
    unrealisedDifference: number;
    grossDifference: number;
    tolerance: number;
    withinTolerance: boolean;
  };

  brokerReported?: {
    realisedPnl: number;
    unrealisedPnl: number;
    pnl: number;
    m2m?: number;
    grossTradingPnl?: number;
  };
}
