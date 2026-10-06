import { ServerRiskStore } from './store';
import { validateRiskConfig } from './validation';
import { LivePnlValidationService } from '../pnl/liveValidationService';
import { ZerodhaSessionStore } from '../brokers/zerodha/sessionStore';
import { getLiveRiskStateRecordingEnabled } from './liveRiskRecorder';
import { getTradingDateKolkata } from './engine';

export interface ActivationPreflightResult {
  ready: boolean;
  recordingEnabled: boolean;
  brokerAuthenticated: boolean;
  livePnlValidated: boolean;
  dataSource: 'ZERODHA_LIVE' | 'MOCK_DATA' | 'SIMULATION';
  riskConfigValid: boolean;
  riskSessionAvailable: boolean;
  currentRiskState: 'ALLOW' | 'WARNING' | 'LOCKED' | 'UNKNOWN';
  tradingDate: string;
  lockUntil: string | null;
  blockers: string[];
}

export class ActivationGuardService {
  /**
   * Evaluates server-authoritative production preflight check for controlled live risk activation.
   * STRICTLY READ-ONLY: Never mutates RiskSession, never writes riskEvents, never touches broker account/orders.
   */
  public static async evaluatePreflight(userId: string): Promise<ActivationPreflightResult> {
    const blockers: string[] = [];
    const now = new Date();
    const tradingDate = getTradingDateKolkata(now);

    // A. Authentication check
    const firebaseAuthenticated = Boolean(userId && userId.trim().length > 0 && userId.trim() !== 'default_trader');
    if (!firebaseAuthenticated) {
      blockers.push('Authenticated Firebase user is required.');
    }

    const effectiveUserId = (userId && userId.trim().length > 0) ? userId.trim() : 'default_trader';

    // B & C. Zerodha authentication & runtime session
    let brokerAuthenticated = false;
    try {
      const session = await ZerodhaSessionStore.loadSession(effectiveUserId, { evaluationTime: now });
      brokerAuthenticated = Boolean(session && session.authState === 'AUTHENTICATED' && session.accessToken && session.accessToken.trim().length > 0);
    } catch {
      brokerAuthenticated = false;
    }

    if (!brokerAuthenticated) {
      blockers.push('Zerodha broker authentication is required. Please log in via Kite Connect.');
    }

    // H & I. RiskConfig validation
    let riskConfigValid = false;
    let riskConfig: any = null;
    try {
      riskConfig = await ServerRiskStore.getConfig(effectiveUserId);
      const val = validateRiskConfig(riskConfig);
      riskConfigValid = Boolean(val.valid && riskConfig && riskConfig.dailyLossLimit > 0);
    } catch {
      riskConfigValid = false;
    }

    if (!riskConfigValid) {
      blockers.push('RiskConfig is invalid or dailyLossLimit <= 0.');
    }

    // D, E, F, G. Live P&L validation & reconciliation
    let livePnlValidated = false;
    let dataSource: 'ZERODHA_LIVE' | 'MOCK_DATA' | 'SIMULATION' = 'MOCK_DATA';
    try {
      const livePnlRes = await LivePnlValidationService.validateLivePnl(
        riskConfig || undefined,
        now,
        undefined,
        undefined,
        effectiveUserId
      );

      dataSource = livePnlRes.source;

      if (livePnlRes.source !== 'ZERODHA_LIVE') {
        blockers.push(`Live P&L data source must be ZERODHA_LIVE (current: ${livePnlRes.source}).`);
      }

      if (livePnlRes.validationState === 'AUTHENTICATION_REQUIRED') {
        blockers.push('Live P&L validation failed: Zerodha authentication required.');
      } else if (livePnlRes.validationState === 'UNKNOWN_INSTRUMENTS') {
        blockers.push('Live P&L validation failed: Contains unknown or unclassified F&O instruments.');
      } else if (livePnlRes.validationState === 'ERROR') {
        blockers.push('Live P&L validation failed with a calculation or connection error.');
      } else if (livePnlRes.validationState === 'VALID' || livePnlRes.validationState === 'STALE_DATA') {
        livePnlValidated = true;
      } else {
        blockers.push(`Live P&L validation state unacceptable: ${livePnlRes.validationState}.`);
      }
    } catch (err) {
      livePnlValidated = false;
      blockers.push(`Live P&L validation exception: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }

    // J & K. RiskEngine & RiskSession read/write availability
    let riskSessionAvailable = false;
    let currentRiskState: 'ALLOW' | 'WARNING' | 'LOCKED' | 'UNKNOWN' = 'UNKNOWN';
    let lockUntil: string | null = null;
    try {
      const riskSession = await ServerRiskStore.getSession(effectiveUserId, tradingDate);
      if (riskSession && riskSession.tradingDate) {
        riskSessionAvailable = true;
        currentRiskState = riskSession.state || 'ALLOW';
        lockUntil = riskSession.lockUntil || null;
      } else {
        blockers.push('Server-side RiskSession is unavailable.');
      }
    } catch {
      blockers.push('Failed to read server-side RiskSession.');
    }

    // L & M. Recording status check
    const recordingEnabled = getLiveRiskStateRecordingEnabled();
    if (recordingEnabled) {
      blockers.push('Live risk state recording is already enabled.');
    }

    const ready = blockers.length === 0;

    return {
      ready,
      recordingEnabled,
      brokerAuthenticated,
      livePnlValidated,
      dataSource,
      riskConfigValid,
      riskSessionAvailable,
      currentRiskState,
      tradingDate,
      lockUntil,
      blockers,
    };
  }
}
