/**
 * Phase 6 — Server-Authoritative Trading Firewall Enforcement Types.
 *
 * Core Guarantees:
 * - Application-level enforcement layer (NOT broker-level enforcement).
 * - Single source of truth: EnforcementState derives exclusively from Phase 5 RiskSession.
 * - HTTP 423 Locked for blocked protected operations.
 * - HTTP 401 Unauthorized for unauthenticated requests.
 * - Server-authoritative time governs lock expiration (client clocks are never trusted).
 * - Read-only: querying enforcement status does NOT mutate RiskSession or create audit events.
 */

import { RiskState } from '../risk/engine';

export interface EnforcementState {
  tradingDate: string;
  riskState: RiskState;
  isLocked: boolean;
  lockedAt: string | null;
  lockUntil: string | null;
  remainingSeconds: number;
  evaluatedAt: string;
  reason: string;
  authority: 'server';
}

export interface EnforcementDecision {
  allowed: boolean;
  statusCode: number; // 200, 401, 423, 500
  state: EnforcementState | null;
  error?: string;
  message?: string;
}

export interface ProtectedTradingResponse {
  status: 'AUTHORIZED' | 'LOCKED' | 'UNAUTHENTICATED' | 'ERROR';
  message: string;
  riskState?: RiskState;
  lockUntil?: string | null;
  authority: 'server';
  timestamp: string;
}
