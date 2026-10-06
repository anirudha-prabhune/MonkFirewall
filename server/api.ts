import express, { Request, Response } from 'express';
import { ServerRiskStore } from './risk/store';
import { BrokerService } from './brokers/service';
import { MOCK_INSTRUMENT_MASTER } from './instruments/master';
import { PnlEngine } from './pnl/engine';
import { EnforcementService } from './enforcement/service';
import { requireTradingAccess } from './enforcement/guard';
import { MarketDataService } from './market/marketDataService';
import { LivePnlValidationService } from './pnl/liveValidationService';
import { ValidationSessionManager } from './pnl/validationSession';
import { ZerodhaCredentialManager } from './brokers/zerodha/credentials';
import { ShadowRiskService } from './risk/shadowRiskService';
import {
  LiveRiskRecorder,
  liveRiskStateRecordingEnabled,
  getLiveRiskStateRecordingEnabled,
  setLiveRiskStateRecordingEnabled,
} from './risk/liveRiskRecorder';
import { getTradingDateKolkata } from './risk/engine';

export const apiRouter = express.Router();

apiRouter.use(express.json());

function sendJson(res: Response | any, data: any, status = 200) {
  if (typeof res.json === 'function') {
    return res.status(status).json(data);
  }
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

function resolveUserId(req: Request): string {
  const headerUser = req.headers['x-user-id'] || req.headers['authorization'];
  if (headerUser && typeof headerUser === 'string') {
    return headerUser.replace(/^Bearer\s+/, '').trim();
  }
  return 'default_trader';
}

// Health Check
apiRouter.get('/health', (req: Request, res: Response) => {
  sendJson(res, {
    status: 'ok',
    phase: 'PHASE_3',
    service: 'Trading Firewall authoritative risk gateway',
    timestamp: new Date().toISOString(),
    timezone: 'Asia/Kolkata',
    uptimeSeconds: Math.floor(process.uptime()),
    features: {
      firebaseAuth: true,
      firestore: true,
      riskEngine: 'PHASE_2_HARDENED',
      riskConfigValidation: 'ACTIVE',
      lockLifecycle: 'SERVER_AUTHORITATIVE',
      brokerAdapter: 'MOCK_ZERODHA_PHASE_3',
      positionNormalization: 'METADATA_DRIVEN_FNO',
    },
  });
});

// Broker Status (Phase 3 Mock Zerodha)
apiRouter.get('/broker/status', async (req: Request, res: Response) => {
  try {
    const status = await BrokerService.getConnectionStatus();
    sendJson(res, status);
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to fetch broker status' }, 500);
  }
});

// Legacy Account Status endpoint
apiRouter.get('/account/status', async (req: Request, res: Response) => {
  try {
    const status = await BrokerService.getConnectionStatus();
    sendJson(res, {
      status: status.status,
      broker: status.broker,
      connected: status.status === 'CONNECTED',
      mode: 'MOCK',
      isMock: true,
      message: 'Mock Zerodha Adapter connected (Phase 3 Normalized Positions).',
    });
  } catch (err) {
    sendJson(res, { error: 'Failed' }, 500);
  }
});

// GET /api/positions - All Normalized Positions (Mock Data)
apiRouter.get('/positions', async (req: Request, res: Response) => {
  try {
    const positions = await BrokerService.getNormalizedPositions();
    sendJson(res, {
      dataSource: 'MOCK_DATA',
      count: positions.length,
      positions,
    });
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to fetch positions' }, 500);
  }
});

// GET /api/positions/fno - Authoritative F&O Positions (Live Zerodha or Mock Fallback)
apiRouter.get('/positions/fno', async (req: Request, res: Response) => {
  try {
    const userId = resolveUserId(req);
    const liveAdapter = BrokerService.getLiveAdapter();
    const connStatus = await liveAdapter.getConnectionStatus(userId);

    // If Zerodha is authenticated and connected, return validated real live positions
    if (connStatus.status === 'CONNECTED' && connStatus.authenticated) {
      const config = await ServerRiskStore.getConfig(userId);
      const validationResult = await LivePnlValidationService.validateLivePnl(
        config,
        new Date(),
        undefined,
        undefined,
        userId
      );

      // Do not fall back to mock data if live connection is active
      if (
        validationResult.validationState !== 'AUTHENTICATION_REQUIRED' &&
        validationResult.validationState !== 'ERROR'
      ) {
        const livePositions = validationResult.positions || [];
        return sendJson(res, {
          dataSource: 'ZERODHA_LIVE',
          count: livePositions.length,
          positions: livePositions,
          validationState: validationResult.validationState,
          marketDataStatus: validationResult.marketDataStatus,
        });
      }
    }

    // Preserve existing simulation mode when live data is unavailable
    const fnoPositions = await BrokerService.getNormalizedFnoPositions();
    sendJson(res, {
      dataSource: 'MOCK_DATA',
      count: fnoPositions.length,
      positions: fnoPositions,
    });
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to fetch F&O positions' }, 500);
  }
});

// POST /api/positions/sync - Sync positions for current user
apiRouter.post('/positions/sync', async (req: Request, res: Response) => {
  try {
    const userId = resolveUserId(req);
    const result = await BrokerService.syncPositions(userId);
    sendJson(res, {
      success: true,
      dataSource: 'MOCK_DATA',
      fnoCount: result.fno.length,
      totalCount: result.all.length,
      positions: result.fno,
    });
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to sync positions' }, 500);
  }
});

// GET /api/instruments - Mock Instrument Master
apiRouter.get('/instruments', (req: Request, res: Response) => {
  sendJson(res, {
    count: MOCK_INSTRUMENT_MASTER.length,
    instruments: MOCK_INSTRUMENT_MASTER,
  });
});

// GET /api/broker/live/status - Phase 7 Live Zerodha Diagnostic Connection Status
apiRouter.get('/broker/live/status', async (req: Request, res: Response) => {
  try {
    const headerUser = req.headers['x-user-id'] || req.headers['authorization'];
    if (!headerUser) {
      return sendJson(res, { error: 'UNAUTHENTICATED', message: 'Authentication required' }, 401);
    }
    const userId = resolveUserId(req);
    const status = await BrokerService.getLiveDiagnosticStatus(userId);
    sendJson(res, status);
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to retrieve live broker status' }, 500);
  }
});

// GET /api/broker/live/auth/login - Daily Kite Connect Login Flow (Phase 8A)
apiRouter.get('/broker/live/auth/login', (req: Request, res: Response) => {
  try {
    const headerUser = req.headers['x-user-id'] || req.headers['authorization'];
    if (!headerUser) {
      return sendJson(res, { error: 'UNAUTHENTICATED', message: 'Authentication required' }, 401);
    }
    const userId = resolveUserId(req);
    const redirectUrl = req.query.redirect_url as string | undefined;
    const loginResult = ZerodhaCredentialManager.getLoginUrlWithState(redirectUrl, userId);
    sendJson(res, { loginUrl: loginResult.url, state: loginResult.state, userId });
  } catch (err) {
    sendJson(
      res,
      {
        error: 'CONFIGURATION_ERROR',
        message: err instanceof Error ? err.message : 'Failed to generate Kite login URL',
      },
      400
    );
  }
});

// Daily Kite Connect Redirect Callback (GET for browser redirect, POST for direct token submission)
const handleAuthCallback = async (req: Request, res: Response) => {
  try {
    const statusParam = (req.query.status || req.body?.status) as string | undefined;
    if (statusParam === 'error' || req.query.error || req.body?.error) {
      const errorMsg = (req.query.message || req.body?.message || req.query.error_description || req.query.error || 'Authentication denied or failed') as string;
      ZerodhaCredentialManager.setAuthState('AUTHENTICATION_ERROR');
      if (req.accepts('html') && req.method === 'GET') {
        return res.redirect(`/?zerodha_auth=error&error=${encodeURIComponent(ZerodhaCredentialManager.sanitizeErrorString(errorMsg))}`);
      }
      return sendJson(res, { success: false, error: ZerodhaCredentialManager.sanitizeErrorString(errorMsg) }, 400);
    }

    const requestToken = (req.query.request_token || req.query.token || req.body?.request_token || req.body?.token) as string | undefined;
    if (!requestToken || requestToken.trim().length === 0) {
      return sendJson(res, { error: 'INVALID_REQUEST', message: 'Missing request_token parameter from Zerodha redirect' }, 400);
    }

    // If arbitrary user_id query parameter is provided without signed state: REJECT
    if (req.query.user_id || req.query.userId) {
      const candidateState = (req.query.state || req.body?.state) as string | undefined;
      if (!candidateState) {
        return sendJson(
          res,
          {
            error: 'INVALID_OAUTH_STATE',
            message: 'Arbitrary userId via query parameters without a valid signed state parameter is forbidden.',
          },
          400
        );
      }
    }

    const stateParam = (req.query.state || req.body?.state) as string | undefined;
    if (!stateParam || typeof stateParam !== 'string' || !stateParam.trim()) {
      return sendJson(
        res,
        {
          error: 'MISSING_OAUTH_STATE',
          message: 'Production OAuth callbacks must provide a valid signed state parameter.',
        },
        400
      );
    }

    const stateResult = ZerodhaCredentialManager.verifyOAuthState(stateParam.trim());
    if (!stateResult.valid || !stateResult.userId) {
      const isExpired = stateResult.error === 'EXPIRED_OAUTH_STATE';
      return sendJson(
        res,
        {
          error: isExpired ? 'EXPIRED_OAUTH_STATE' : 'INVALID_OAUTH_STATE',
          message: `OAuth state verification failed: ${stateResult.error || 'tampered or expired state'}`,
        },
        400
      );
    }

    const verifiedUserId = stateResult.userId;

    const exchangeResult = await ZerodhaCredentialManager.exchangeRequestToken(requestToken.trim(), verifiedUserId);
    if (!exchangeResult.success) {
      if (req.accepts('html') && req.method === 'GET') {
        return res.redirect(`/?zerodha_auth=error&error=${encodeURIComponent(exchangeResult.error || 'Token exchange failed')}`);
      }
      const statusCode = exchangeResult.error?.includes('SESSION_PERSISTENCE_ERROR') ? 500 : 401;
      return sendJson(res, { success: false, error: exchangeResult.error }, statusCode);
    }

    if (req.accepts('html') && req.method === 'GET') {
      return res.redirect('/?zerodha_auth=success');
    }

    sendJson(res, {
      success: true,
      authenticated: true,
      status: 'AUTHENTICATED',
      userId: verifiedUserId,
      session: exchangeResult.session ? ZerodhaCredentialManager.sanitize(exchangeResult.session) : undefined,
    });
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : 'Unknown error during authentication callback';
    sendJson(res, { error: ZerodhaCredentialManager.sanitizeErrorString(rawMsg) }, 500);
  }
};

apiRouter.get('/broker/live/auth/callback', handleAuthCallback);
apiRouter.post('/broker/live/auth/callback', handleAuthCallback);
apiRouter.post('/brokers/zerodha/callback', handleAuthCallback);

// POST /api/broker/live/auth/disconnect - Invalidate Active Zerodha Session (Phase 8A)
apiRouter.post('/broker/live/auth/disconnect', async (req: Request, res: Response) => {
  try {
    const headerUser = req.headers['x-user-id'] || req.headers['authorization'];
    if (!headerUser) {
      return sendJson(res, { error: 'UNAUTHENTICATED', message: 'Authentication required' }, 401);
    }
    const userId = resolveUserId(req);
    await ZerodhaCredentialManager.disconnect(userId);
    sendJson(res, {
      success: true,
      status: 'AUTHENTICATION_REQUIRED',
      message: 'Active Zerodha session invalidated. Re-authentication required for live data.',
    });
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to disconnect session' }, 500);
  }
});

// POST /api/broker/live/auth/logout - Alias for disconnect
apiRouter.post('/broker/live/auth/logout', async (req: Request, res: Response) => {
  try {
    const headerUser = req.headers['x-user-id'] || req.headers['authorization'];
    if (!headerUser) {
      return sendJson(res, { error: 'UNAUTHENTICATED', message: 'Authentication required' }, 401);
    }
    const userId = resolveUserId(req);
    await ZerodhaCredentialManager.disconnect(userId);
    sendJson(res, {
      success: true,
      status: 'AUTHENTICATION_REQUIRED',
      message: 'Active Zerodha session invalidated. Re-authentication required for live data.',
    });
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to disconnect session' }, 500);
  }
});

// GET /api/broker/live/diagnostic/session - Phase 8A Sanitized Session Continuity Diagnostic
apiRouter.get('/broker/live/diagnostic/session', async (req: Request, res: Response) => {
  try {
    const userId = resolveUserId(req);
    const activeSession = await ZerodhaCredentialManager.getAuthenticatedSession(userId);
    const presence = ZerodhaCredentialManager.getPresenceDiagnostic(userId);

    sendJson(res, {
      broker: 'zerodha',
      authenticated: Boolean(activeSession && activeSession.accessToken),
      status: activeSession ? 'AUTHENTICATED' : 'AUTHENTICATION_REQUIRED',
      sessionSource: activeSession?.source || 'NONE',
      sessionVersion: activeSession?.sessionVersion ?? null,
      expiresAt: activeSession?.expiresAt || presence.expiresAt,
      tradingDate: activeSession?.tradingDateKolkata || null,
      runtimeInstance: `inst-${process.pid}-${process.platform}`,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to retrieve diagnostic' }, 500);
  }
});

// GET /api/broker/live/positions - Phase 7 Live Zerodha Read-Only Normalized Positions
apiRouter.get('/broker/live/positions', async (req: Request, res: Response) => {
  try {
    const headerUser = req.headers['x-user-id'] || req.headers['authorization'];
    if (!headerUser) {
      return sendJson(res, { error: 'UNAUTHENTICATED', message: 'Authentication required' }, 401);
    }
    const userId = resolveUserId(req);
    const livePositions = await BrokerService.getLiveDiagnosticPositions(userId);
    sendJson(res, livePositions);
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to fetch live positions' }, 500);
  }
});

// GET /api/broker/live/market-data/status - Phase 7 Read-Only Market Data Feed Status
apiRouter.get('/broker/live/market-data/status', async (req: Request, res: Response) => {
  try {
    const headerUser = req.headers['x-user-id'] || req.headers['authorization'];
    if (!headerUser) {
      return sendJson(res, { error: 'UNAUTHENTICATED', message: 'Authentication required' }, 401);
    }
    const status = MarketDataService.getStatus();
    sendJson(res, status);
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to fetch market data status' }, 500);
  }
});

// GET /api/broker/live/ltp - Phase 8A Read-Only Live Zerodha REST LTP Snapshot
apiRouter.get('/broker/live/ltp', async (req: Request, res: Response) => {
  try {
    const headerUser = req.headers['x-user-id'] || req.headers['authorization'];
    if (!headerUser) {
      return sendJson(res, { error: 'UNAUTHENTICATED', message: 'Authentication required' }, 401);
    }

    const tokenParam = (req.query.instrument_token || req.query.instrumentToken) as string;
    if (!tokenParam) {
      return sendJson(res, { error: 'INVALID_REQUEST', message: 'Missing instrument_token parameter' }, 400);
    }

    const instrumentToken = parseInt(tokenParam, 10);
    if (!Number.isInteger(instrumentToken) || instrumentToken <= 0) {
      return sendJson(res, { error: 'INVALID_REQUEST', message: 'Invalid instrument_token: must be positive integer' }, 400);
    }

    const userId = resolveUserId(req);
    const snapshot = await BrokerService.getLiveAdapter().getLtpSnapshot(instrumentToken, userId);
    sendJson(res, snapshot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch LTP snapshot';
    const isAuthErr = msg.includes('Authentication failure') || msg.includes('TokenException') || msg.includes('access token');
    const isValidationErr = msg.includes('Unknown instrument') || msg.includes('Non-F&O');
    const statusCode = isAuthErr ? 403 : isValidationErr ? 400 : 500;

    sendJson(
      res,
      {
        dataSource: 'ZERODHA_LIVE',
        status: 'ERROR',
        error: ZerodhaCredentialManager.sanitizeErrorString(msg),
      },
      statusCode
    );
  }
});

// GET /api/pnl - Authoritative Gross F&O P&L (Live Zerodha or Mock Fallback)
apiRouter.get('/pnl', async (req: Request, res: Response) => {
  try {
    const userId = resolveUserId(req);
    const config = await ServerRiskStore.getConfig(userId);
    const liveAdapter = BrokerService.getLiveAdapter();
    const connStatus = await liveAdapter.getConnectionStatus(userId);

    // If Zerodha is authenticated and connected, return validated real live P&L
    if (connStatus.status === 'CONNECTED' && connStatus.authenticated) {
      const validationResult = await LivePnlValidationService.validateLivePnl(
        config,
        new Date(),
        undefined,
        undefined,
        userId
      );

      // Do not fall back to mock data if live connection is active
      if (
        validationResult.validationState !== 'AUTHENTICATION_REQUIRED' &&
        validationResult.validationState !== 'ERROR'
      ) {
        const livePnlResult = {
          tradingDate: validationResult.tradingDate,
          realisedPnl: validationResult.calculated.realisedPnl,
          unrealisedPnl: validationResult.calculated.unrealisedPnl,
          totalPnl: validationResult.calculated.grossTradingPnl,
          grossTradingPnl: validationResult.calculated.grossTradingPnl,
          dailyRealisedPnl: validationResult.calculated.dailyRealisedPnl,
          dailyUnrealisedPnl: validationResult.calculated.dailyUnrealisedPnl,
          fnoPositionCount: validationResult.calculated.fnoPositionCount,
          totalPositionCount: validationResult.calculated.fnoPositionCount,
          positions: validationResult.positions || [],
          includedRealisedPnl: validationResult.calculated.dailyRealisedPnl,
          includedUnrealisedPnl: validationResult.calculated.dailyUnrealisedPnl,
          source: 'ZERODHA_LIVE' as const,
          calculatedAt: validationResult.timestamp,
          validationState: validationResult.validationState,
          marketDataStatus: validationResult.marketDataStatus,
        };

        // If authoritative live recording is enabled, record to RiskSession
        if (liveRiskStateRecordingEnabled) {
          await LiveRiskRecorder.evaluateAndRecordLiveRisk(userId, {
            evaluationTime: new Date(),
          });
        }

        return sendJson(res, livePnlResult);
      }
    }

    // Preserve existing simulation mode when live data is unavailable
    const positions = await BrokerService.getNormalizedPositions();
    const pnlResult = PnlEngine.calculate(positions, config);
    sendJson(res, pnlResult);
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to calculate P&L' }, 500);
  }
});

// GET /api/pnl/live-validation - Phase 8 Live Zerodha P&L Validation & Shadow Mode
apiRouter.get('/pnl/live-validation', async (req: Request, res: Response) => {
  try {
    const headerUser = req.headers['x-user-id'] || req.headers['authorization'];
    if (!headerUser) {
      return sendJson(res, { error: 'UNAUTHENTICATED', message: 'Authentication required' }, 401);
    }
    const userId = resolveUserId(req);
    const config = await ServerRiskStore.getConfig(userId);
    const validationResult = await LivePnlValidationService.validateLivePnl(
      config,
      new Date(),
      undefined,
      undefined,
      userId
    );
    sendJson(res, validationResult);
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Live P&L validation failed' }, 500);
  }
});

// GET /api/risk/shadow - Phase 9 Live P&L → Risk Engine Shadow Integration
apiRouter.get('/risk/shadow', async (req: Request, res: Response) => {
  try {
    const headerUser = req.headers['x-user-id'] || req.headers['authorization'];
    if (!headerUser) {
      return sendJson(res, { error: 'UNAUTHENTICATED', message: 'Authentication required' }, 401);
    }
    const userId = resolveUserId(req);
    const shadowResult = await ShadowRiskService.evaluateLiveShadow(userId);
    sendJson(res, shadowResult);
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Live risk shadow evaluation failed' }, 500);
  }
});

// GET /api/risk/recording-status - Phase 10B Controlled Live Risk Diagnostic & Status Information
const handleRecordingStatus = async (req: Request, res: Response) => {
  try {
    const userId = resolveUserId(req);
    const enabled = getLiveRiskStateRecordingEnabled();
    const session = await ServerRiskStore.getSession(userId);
    const liveAdapter = BrokerService.getLiveAdapter();
    const connStatus = await liveAdapter.getConnectionStatus(userId);
    const dataSource = (connStatus.status === 'CONNECTED' && connStatus.authenticated)
      ? 'ZERODHA_LIVE'
      : 'MOCK_DATA';
    const tradingDate = session?.tradingDate || getTradingDateKolkata();

    sendJson(res, {
      enabled,
      liveRiskStateRecordingEnabled: enabled,
      activationState: enabled ? 'ACTIVE' : 'SHADOW_ONLY',
      currentRiskState: session?.state || 'ALLOW',
      tradingDate,
      lockUntil: session?.lockUntil || null,
      dataSource,
      status: enabled ? 'RECORDING_ENABLED' : 'SHADOW_ONLY',
      message: enabled
        ? 'Authoritative live RiskSession/riskEvents recording is active.'
        : 'Authoritative live RiskSession/riskEvents recording is disabled (Strict Shadow Mode).',
    });
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to retrieve recording status' }, 500);
  }
};

apiRouter.get('/risk/recording-status', handleRecordingStatus);
apiRouter.get('/risk/live/recording', handleRecordingStatus);
apiRouter.get('/risk/live/recording/status', handleRecordingStatus);

// POST /api/risk/recording/control - Phase 10B Server-Authoritative Controlled Activation
const handleRecordingControl = async (req: Request, res: Response) => {
  try {
    const headerUser = req.headers['x-user-id'] || req.headers['authorization'];
    if (!headerUser) {
      return sendJson(res, { error: 'UNAUTHENTICATED', message: 'Authentication required' }, 401);
    }
    const userId = resolveUserId(req);
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return sendJson(res, { error: 'INVALID_REQUEST', message: '"enabled" boolean field is required' }, 400);
    }

    setLiveRiskStateRecordingEnabled(enabled);

    const session = await ServerRiskStore.getSession(userId);
    const liveAdapter = BrokerService.getLiveAdapter();
    const connStatus = await liveAdapter.getConnectionStatus(userId);
    const dataSource = (connStatus.status === 'CONNECTED' && connStatus.authenticated)
      ? 'ZERODHA_LIVE'
      : 'MOCK_DATA';
    const tradingDate = session?.tradingDate || getTradingDateKolkata();

    sendJson(res, {
      success: true,
      enabled,
      liveRiskStateRecordingEnabled: enabled,
      activationState: enabled ? 'ACTIVE' : 'SHADOW_ONLY',
      currentRiskState: session?.state || 'ALLOW',
      tradingDate,
      lockUntil: session?.lockUntil || null,
      dataSource,
      status: enabled ? 'RECORDING_ENABLED' : 'SHADOW_ONLY',
      message: enabled
        ? 'Authoritative live RiskSession/riskEvents recording activated.'
        : 'Authoritative live RiskSession/riskEvents recording deactivated (Shadow Mode).',
    });
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to update recording control' }, 500);
  }
};

apiRouter.post('/risk/recording/control', handleRecordingControl);
apiRouter.post('/risk/live/recording', handleRecordingControl);

// GET /api/risk - Authoritative Risk Session
apiRouter.get('/risk', async (req: Request, res: Response) => {
  try {
    const userId = resolveUserId(req);
    const session = await ServerRiskStore.getSession(userId);
    sendJson(res, session);
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to fetch risk session' }, 500);
  }
});

// GET /api/risk/config - Current Risk Configuration
apiRouter.get('/risk/config', async (req: Request, res: Response) => {
  try {
    const userId = resolveUserId(req);
    const config = await ServerRiskStore.getConfig(userId);
    sendJson(res, config);
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to fetch risk config' }, 500);
  }
});

// PUT /api/risk/config - Server-Validated Risk Configuration Update
apiRouter.put('/risk/config', async (req: Request, res: Response) => {
  try {
    const userId = resolveUserId(req);
    const body = req.body;
    const result = await ServerRiskStore.saveConfig(userId, body);

    if (!result.success) {
      return sendJson(res, { success: false, errors: result.errors }, 400);
    }

    sendJson(res, { success: true, config: result.config });
  } catch (err) {
    sendJson(res, { success: false, errors: [err instanceof Error ? err.message : 'Server error updating config'] }, 500);
  }
});

// GET /api/lock/status - Authoritative Lock State
apiRouter.get('/lock/status', async (req: Request, res: Response) => {
  try {
    const userId = resolveUserId(req);
    const status = await ServerRiskStore.getLockStatus(userId);
    sendJson(res, { ...status, authority: 'server' });
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to fetch lock status' }, 500);
  }
});

// GET /api/enforcement/status - Phase 6 Authoritative Enforcement State
apiRouter.get('/enforcement/status', async (req: Request, res: Response) => {
  try {
    const headerUser = req.headers['x-user-id'] || req.headers['authorization'];
    if (!headerUser) {
      return sendJson(res, { error: 'UNAUTHENTICATED', message: 'Authentication required' }, 401);
    }
    const userId = resolveUserId(req);
    const state = await EnforcementService.getEnforcementState(userId);
    sendJson(res, state);
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to retrieve enforcement state' }, 500);
  }
});

// GET /api/protected/trading - Phase 6 Protected Trading Endpoint Guarded by Trading Firewall
apiRouter.get('/protected/trading', requireTradingAccess, (req: Request, res: Response) => {
  const enforcementState = (req as any).enforcementState;
  sendJson(res, {
    status: 'AUTHORIZED',
    message: 'Protected trading operation authorized by Trading Firewall.',
    riskState: enforcementState?.riskState || 'ALLOW',
    authority: 'server',
    timestamp: new Date().toISOString(),
  });
});

// POST /api/risk/evaluate - Phase 5 Authoritative Risk Evaluation
apiRouter.post('/risk/evaluate', async (req: Request, res: Response) => {
  try {
    const userId = resolveUserId(req);
    const evalDate = req.body?.evaluationTime ? new Date(req.body.evaluationTime) : new Date();

    // If demo reset is requested:
    if (req.body?.reset === true) {
      const resetSession = await ServerRiskStore.resetSession(userId);
      return sendJson(res, {
        success: true,
        state: resetSession.state,
        currentPnl: resetSession.currentPnl,
        session: resetSession,
        message: 'Demo state reset to baseline',
      });
    }

    // If developer testing panel passes simulated pnl input:
    if (req.body?.pnl !== undefined) {
      if (typeof req.body.pnl !== 'number' || isNaN(req.body.pnl)) {
        return sendJson(res, { error: 'Valid numeric pnl is required for simulation' }, 400);
      }
      const result = await ServerRiskStore.evaluatePnl(userId, req.body.pnl, evalDate);
      return sendJson(res, result);
    }

    // Phase 5 Authoritative Pipeline: Server loads positions, runs PnlEngine, and evaluates RiskEngine
    const result = await ServerRiskStore.evaluateFromPositions(userId, evalDate);
    sendJson(res, result);
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Evaluation failed' }, 500);
  }
});

// GET /api/risk/events - Transition Audit Trail
apiRouter.get('/risk/events', async (req: Request, res: Response) => {
  try {
    const userId = resolveUserId(req);
    const events = await ServerRiskStore.getAuditEvents(userId);
    sendJson(res, { events });
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to fetch audit events' }, 500);
  }
});

// ============================================================================
// PHASE 8A — CONTROLLED REAL-ACCOUNT SHADOW VALIDATION SESSION ENDPOINTS
// ============================================================================

// POST /api/validation/session/start - Start validation session
apiRouter.post('/validation/session/start', (req: Request, res: Response) => {
  try {
    const notes = req.body?.notes;
    const session = ValidationSessionManager.startSession(notes);
    sendJson(res, { success: true, session });
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to start validation session' }, 500);
  }
});

// GET /api/validation/session/active - Get current active validation session
apiRouter.get('/validation/session/active', (req: Request, res: Response) => {
  const session = ValidationSessionManager.getActiveSession();
  sendJson(res, { active: !!session, session });
});

// POST /api/validation/session/capture - Capture raw positions snapshot and record observations
apiRouter.post('/validation/session/capture', async (req: Request, res: Response) => {
  try {
    let session = ValidationSessionManager.getActiveSession();
    if (!session) {
      session = ValidationSessionManager.startSession('Auto-started for capture');
    }

    const liveAdapter = BrokerService.getLiveAdapter();
    const conn = await liveAdapter.getConnectionStatus();

    if (conn.status !== 'CONNECTED') {
      return sendJson(res, {
        success: false,
        status: conn.status,
        message: `Live Zerodha connection inactive: ${conn.message}`,
        session,
        observations: [],
      });
    }

    const userId = resolveUserId(req);
    const rawPositions = await liveAdapter.getPositions(userId);
    let liveInstruments: any[] = [];
    try {
      liveInstruments = await liveAdapter.getInstruments(userId);
    } catch {
      liveInstruments = [];
    }
    const instrumentMap = new Map(liveInstruments.map((i) => [i.instrumentToken, i]));

    const config = await ServerRiskStore.getConfig(userId);
    const validationResult = await LivePnlValidationService.validateLivePnl(
      config,
      new Date(),
      undefined,
      undefined,
      userId
    );

    const observations = rawPositions.map((raw) => {
      const inst = instrumentMap.get(raw.instrument_token);
      const isFno = !!(inst && ['NFO-FUT', 'NFO-OPT', 'BFO-FUT', 'BFO-OPT'].includes(inst.segment));
      return ValidationSessionManager.recordObservation(
        session!.validationSessionId,
        raw,
        isFno,
        inst,
        validationResult.calculated ? {
          dailyRealised: validationResult.calculated.dailyRealisedPnl,
          dailyUnrealised: validationResult.calculated.dailyUnrealisedPnl,
          grossTradingPnl: validationResult.calculated.grossTradingPnl,
        } : undefined
      );
    });

    sendJson(res, {
      success: true,
      session,
      count: observations.length,
      observations,
      validationResult,
    });
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to capture observation' }, 500);
  }
});

// POST /api/validation/session/end - Conclude active validation session and generate report
apiRouter.post('/validation/session/end', async (req: Request, res: Response) => {
  try {
    const active = ValidationSessionManager.getActiveSession();
    if (!active) {
      return sendJson(res, { error: 'No active validation session to end' }, 400);
    }
    const ended = ValidationSessionManager.endSession(active.validationSessionId);
    const report = ValidationSessionManager.generateReport(active.validationSessionId);
    sendJson(res, { success: true, endedSession: ended, report });
  } catch (err) {
    sendJson(res, { error: err instanceof Error ? err.message : 'Failed to end session' }, 500);
  }
});

// GET /api/validation/session/report - Generate report for active or requested session
apiRouter.get('/api/validation/session/report', (req: Request, res: Response) => {
  const sessionId = (req.query.sessionId as string) || ValidationSessionManager.getActiveSession()?.validationSessionId;
  if (!sessionId) {
    return sendJson(res, { error: 'No active or requested sessionId' }, 404);
  }
  const report = ValidationSessionManager.generateReport(sessionId);
  sendJson(res, report);
});

export default apiRouter;
