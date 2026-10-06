export type RiskState = 'ALLOW' | 'WARNING' | 'LOCKED';
export type LockDurationType = 'FIXED' | 'UNTIL_4PM';

export interface RiskConfig {
  dailyLossLimit: number;
  warningThreshold1: number; // e.g. 70 (%)
  warningThreshold2: number; // e.g. 90 (%)
  lockDurationMinutes: number; // e.g. 720 (12 hours)
  lockDurationType?: LockDurationType; // 'FIXED' | 'UNTIL_4PM'
  includeRealisedPnl: boolean;
  includeUnrealisedPnl: boolean;
  enabled: boolean;
  updatedAt?: string;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  dailyLossLimit: 10000,
  warningThreshold1: 70,
  warningThreshold2: 90,
  lockDurationMinutes: 720,
  lockDurationType: 'FIXED',
  includeRealisedPnl: true,
  includeUnrealisedPnl: true,
  enabled: true,
};

export interface RiskSession {
  tradingDate: string; // YYYY-MM-DD in Asia/Kolkata
  userId: string;
  state: RiskState;
  isBreached: boolean;
  lockedAt: string | null;
  lockUntil: string | null; // Authoritative explicit expiry timestamp
  currentPnl?: number;
  totalPnl?: number;
  realisedPnl?: number;
  unrealisedPnl?: number;
  lossLimit?: number;
  warningThreshold1?: number;
  warningThreshold2?: number;
  lastEvaluatedAt?: string;
  lockExpiresAt?: string | null; // Alias for backward compatibility
  reason?: string | null;
  updatedAt?: string;
}

export interface RiskSessionSnapshot {
  tradingDate: string;
  state: RiskState;
  isBreached: boolean;
  lockedAt: string | null;
  lockUntil: string | null;
  reason?: string | null;
}
