/**
 * Phase 4 — Authoritative Gross P&L Engine Types.
 *
 * Guarantees:
 * - Realized P&L extracted from broker-normalized position.
 * - Unrealized P&L independently calculated via decimal-safe (lastPrice - averagePrice) * quantity.
 * - F&O filtering preserves metadata-driven classification (isFno === true).
 * - Equities excluded from aggregate F&O Gross Trading P&L.
 * - Separate calculated totals from risk-configured contribution totals.
 */

export interface PositionPnl {
  instrumentToken: number;
  tradingsymbol: string;
  exchange: string;
  segment: string;
  instrumentType: string;
  product: string;
  quantity: number;
  averagePrice: number;
  lastPrice: number;
  closePrice?: number;
  multiplier?: number;
  overnightQuantity?: number;
  dailyRealisedPnl?: number;
  dailyUnrealisedPnl?: number;
  dailyGrossPnl?: number;
  realisedPnl: number;
  unrealisedPnl: number;
  totalPnl: number;
  isFno: boolean;
}

export interface PnlCalculationOptions {
  includeRealisedPnl?: boolean;
  includeUnrealisedPnl?: boolean;
  evaluationTime?: Date;
  tradingDate?: string;
}

export interface PnlResult {
  tradingDate: string;

  // Daily calculated values (Unfiltered F&O sums)
  dailyRealisedPnl?: number;
  dailyUnrealisedPnl?: number;
  dailyGrossPnl?: number;

  // Backward-compatible properties (aliases for daily values)
  realisedPnl: number;
  unrealisedPnl: number;
  totalPnl: number;

  // Configured contribution values (subject to includeRealisedPnl / includeUnrealisedPnl)
  includedRealisedPnl: number;
  includedUnrealisedPnl: number;
  grossTradingPnl: number;

  fnoPositionCount: number;
  totalPositionCount: number;

  positions: PositionPnl[];

  source: string;
  dataSource?: string;
  calculatedAt: string;
  validationState?: string;
  marketDataStatus?: string;
  riskSession?: any;
  shadowSession?: any;
  shadowRisk?: any;
  liveRiskStateRecordingEnabled?: boolean;
  recordingStatus?: string;
}
