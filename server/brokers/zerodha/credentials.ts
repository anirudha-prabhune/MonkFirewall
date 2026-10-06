import crypto from 'crypto';
import { BrokerAuthState, CredentialPresenceDiagnostic } from '../types';
import { ZerodhaSessionStore, DecryptedRuntimeSession, SessionPersistenceError } from './sessionStore';

export interface OAuthStatePayload {
  userId: string;
  timestamp: number;
  nonce: string;
}

export interface VerifyOAuthStateResult {
  valid: boolean;
  userId?: string;
  error?: string;
}

/**
 * Phase 8A — Daily Zerodha Server-Side Authentication & Session Persistence.
 *
 * Guarantees:
 * 1. PERSISTENT CREDENTIALS:
 *    - ZERODHA_API_KEY and ZERODHA_API_SECRET are persistent server-side secrets.
 *    - Read strictly from server environment variables (never client code, never Firestore).
 * 2. AUTHORITATIVE SESSION PERSISTENCE (PHASE 8A):
 *    - Firestore is the authoritative source of truth for the daily Zerodha session.
 *    - Access token is encrypted with AES-256-GCM before storage.
 *    - RAM is strictly an optional short-lived cache, never the authoritative source.
 *    - Concurrency-guarded invalidation: TokenException invalidates ONLY if sessionVersion matches.
 *    - Application session expiry boundary: 06:00:00 AM Asia/Kolkata (APPLICATION_SESSION_EXPIRY).
 * 3. ZERO LEAKAGE:
 *    - Neither API Key, API Secret, Checksum, Request Token, nor Access Token are ever returned in API
 *      responses, logged, or exposed to the browser.
 */

export interface ZerodhaCredentials {
  apiKey?: string;
  apiSecret?: string;
  accessToken?: string;
}

export interface CachedRuntimeSession {
  accessToken: string;
  sessionVersion: number;
  issuedAt: string;
  expiresAt: string;
  tradingDateKolkata: string;
  brokerUserId?: string;
  userId: string;
  cachedAtMs: number;
}

export interface ActiveSessionResult {
  accessToken: string;
  sessionVersion: number;
  source: 'PERSISTED' | 'RAM_CACHE' | 'DEV_ENV';
  expiresAt: string;
  tradingDateKolkata?: string;
  brokerUserId?: string;
}

export type HttpFetchFn = (url: string, options?: any) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: any;
  json: () => Promise<any>;
  text?: () => Promise<string>;
}>;

export class ZerodhaCredentialManager {
  // In-memory optional short-lived cache (TTL: 30 seconds for Cloud Run performance optimization)
  private static cachedSession: CachedRuntimeSession | null = null;
  private static readonly RAM_CACHE_TTL_MS = 30 * 1000;
  private static authState: BrokerAuthState = 'DISCONNECTED';

  /**
   * Retrieves persistent server-side Zerodha configuration.
   * Internal server use only — NEVER expose to API responses or logs.
   */
  public static getCredentials(userId = 'default_trader'): ZerodhaCredentials {
    return {
      apiKey: process.env.ZERODHA_API_KEY || process.env.KITE_API_KEY,
      apiSecret: process.env.ZERODHA_API_SECRET || process.env.KITE_API_SECRET,
      accessToken: this.getActiveAccessToken(userId) || undefined,
    };
  }

  /**
   * Validates whether mandatory persistent credentials (API Key + API Secret) are present.
   */
  public static validatePersistentConfig(): {
    configured: boolean;
    missing: string[];
    error?: string;
  } {
    const apiKey = process.env.ZERODHA_API_KEY || process.env.KITE_API_KEY;
    const apiSecret = process.env.ZERODHA_API_SECRET || process.env.KITE_API_SECRET;
    const missing: string[] = [];

    if (!apiKey || apiKey.trim().length === 0) {
      missing.push('ZERODHA_API_KEY');
    }
    if (!apiSecret || apiSecret.trim().length === 0) {
      missing.push('ZERODHA_API_SECRET');
    }

    if (missing.length > 0) {
      return {
        configured: false,
        missing,
        error: `Missing required Zerodha credentials: ${missing.join(', ')}`,
      };
    }

    return {
      configured: true,
      missing: [],
    };
  }

  /**
   * Authoritative Resolution Order (Phase 8A):
   * 1. Valid persisted Firestore runtime session (or fresh non-expired RAM cache matching Firestore).
   * 2. Short-lived server RAM cache (if still valid and not expired).
   * 3. Legacy development/test environment token ONLY where explicitly supported in test/dev.
   *
   * ZERODHA_ACCESS_TOKEN never silently overrides a valid persisted production session.
   */
  public static async getAuthenticatedSession(
    userId = 'default_trader',
    connectionId = 'zerodha'
  ): Promise<ActiveSessionResult | null> {
    const now = Date.now();

    // 1. Check optional RAM cache
    if (
      this.cachedSession &&
      this.cachedSession.userId === userId &&
      now - this.cachedSession.cachedAtMs < this.RAM_CACHE_TTL_MS
    ) {
      const expiresAtMs = new Date(this.cachedSession.expiresAt).getTime();
      if (!isNaN(expiresAtMs) && now < expiresAtMs) {
        return {
          accessToken: this.cachedSession.accessToken,
          sessionVersion: this.cachedSession.sessionVersion,
          source: 'RAM_CACHE',
          expiresAt: this.cachedSession.expiresAt,
          tradingDateKolkata: this.cachedSession.tradingDateKolkata,
          brokerUserId: this.cachedSession.brokerUserId,
        };
      }
      // Expired cache -> evict
      this.cachedSession = null;
    }

    // 2. Load from authoritative Firestore session store
    try {
      let persisted: DecryptedRuntimeSession | null = await ZerodhaSessionStore.loadSession(userId, {
        connectionId,
      });

      // If user-specific session is not found, fall back to the primary account session ('default_trader')
      if ((!persisted || persisted.authState !== 'AUTHENTICATED') && userId !== 'default_trader') {
        persisted = await ZerodhaSessionStore.loadSession('default_trader', {
          connectionId,
        });
      }

      if (persisted && persisted.authState === 'AUTHENTICATED' && !persisted.isExpired && persisted.accessToken) {
        // Update short-lived RAM cache
        this.cachedSession = {
          accessToken: persisted.accessToken,
          sessionVersion: persisted.sessionVersion,
          issuedAt: persisted.issuedAt,
          expiresAt: persisted.expiresAt,
          tradingDateKolkata: persisted.tradingDateKolkata,
          brokerUserId: persisted.brokerUserId,
          userId,
          cachedAtMs: now,
        };
        this.authState = 'AUTHENTICATED';

        return {
          accessToken: persisted.accessToken,
          sessionVersion: persisted.sessionVersion,
          source: 'PERSISTED',
          expiresAt: persisted.expiresAt,
          tradingDateKolkata: persisted.tradingDateKolkata,
          brokerUserId: persisted.brokerUserId,
        };
      }
    } catch {
      // If Firestore read fails, fall through
    }

    // 3. Fallback: Dev/Test/Applet environment variable if no persisted session exists
    const envToken = process.env.ZERODHA_ACCESS_TOKEN || process.env.KITE_ACCESS_TOKEN;
    if (envToken && envToken.trim().length > 0) {
      return {
        accessToken: envToken.trim(),
        sessionVersion: 0,
        source: 'DEV_ENV',
        expiresAt: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
      };
    }

    return null;
  }

  /**
   * Synchronous accessor for backward-compatibility.
   * Checks RAM cache first, then dev/test environment override.
   */
  public static getActiveAccessToken(userId?: string): string | null {
    if (this.cachedSession?.accessToken) {
      if (!userId || this.cachedSession.userId === userId) {
        return this.cachedSession.accessToken;
      }
    }
    // Fall back to DEV_ENV token when available
    const envToken = process.env.ZERODHA_ACCESS_TOKEN || process.env.KITE_ACCESS_TOKEN;
    if (envToken && envToken.trim().length > 0) {
      return envToken.trim();
    }
    return null;
  }

  /**
   * Sets active server-side runtime session in memory cache.
   */
  public static setRuntimeSession(
    session: {
      accessToken: string;
      sessionVersion?: number;
      authenticatedAt?: string;
      expiresAt?: string;
      userId?: string;
      userName?: string;
    },
    userId = 'default_trader'
  ): void {
    const now = Date.now();
    this.cachedSession = {
      accessToken: session.accessToken,
      sessionVersion: session.sessionVersion ?? 1,
      issuedAt: session.authenticatedAt || new Date().toISOString(),
      expiresAt: session.expiresAt || new Date(now + 24 * 3600 * 1000).toISOString(),
      tradingDateKolkata: new Date().toISOString().split('T')[0],
      brokerUserId: session.userId,
      userId,
      cachedAtMs: now,
    };
    this.authState = 'AUTHENTICATED';
  }

  /**
   * Retrieves active runtime session metadata (sanitized).
   */
  public static getRuntimeSession(): {
    sessionVersion: number;
    authenticatedAt: string;
    expiresAt: string;
    userId?: string;
  } | null {
    if (!this.cachedSession) return null;
    return {
      sessionVersion: this.cachedSession.sessionVersion,
      authenticatedAt: this.cachedSession.issuedAt,
      expiresAt: this.cachedSession.expiresAt,
      userId: this.cachedSession.brokerUserId,
    };
  }

  /**
   * Invalidate session (concurrency-safe on TokenException).
   *
   * If failedSessionVersion is provided:
   * - Invalidate in Firestore ONLY IF stored sessionVersion === failedSessionVersion.
   * - If a newer session exists, Firestore is left unchanged!
   * - Clear local RAM cache.
   * - Set authState = 'AUTHENTICATION_REQUIRED'.
   */
  public static async handleTokenException(
    userId = 'default_trader',
    failedSessionVersion?: number,
    connectionId = 'zerodha'
  ): Promise<{ invalidated: boolean; preservedNewerVersion?: number }> {
    this.cachedSession = null;
    this.authState = 'AUTHENTICATION_REQUIRED';

    const result = await ZerodhaSessionStore.invalidateSession(userId, failedSessionVersion, connectionId);
    return result;
  }

  /**
   * Explicit user disconnect or logout.
   */
  public static async disconnect(
    userId = 'default_trader',
    connectionId = 'zerodha'
  ): Promise<void> {
    this.cachedSession = null;
    this.authState = 'AUTHENTICATION_REQUIRED';
    await ZerodhaSessionStore.invalidateSession(userId, undefined, connectionId);
    if (userId !== 'default_trader') {
      await ZerodhaSessionStore.invalidateSession('default_trader', undefined, connectionId);
    }
  }

  /**
   * Synchronous session invalidation for backward-compatibility.
   */
  public static invalidateSession(userId = 'default_trader'): void {
    this.cachedSession = null;
    this.authState = 'AUTHENTICATION_REQUIRED';
    ZerodhaSessionStore.invalidateSession(userId).catch(() => {});
    if (userId !== 'default_trader') {
      ZerodhaSessionStore.invalidateSession('default_trader').catch(() => {});
    }
  }

  /**
   * Retrieves server-authoritative authentication state.
   */
  public static getAuthState(): BrokerAuthState {
    const config = this.validatePersistentConfig();
    if (!config.configured) {
      return 'DISCONNECTED';
    }
    if (this.authState === 'AUTHENTICATION_ERROR') {
      return 'AUTHENTICATION_ERROR';
    }
    const token = this.getActiveAccessToken();
    if (!token) {
      return 'AUTHENTICATION_REQUIRED';
    }
    return this.authState === 'DISCONNECTED' ? 'AUTHENTICATION_REQUIRED' : this.authState;
  }

  public static setAuthState(state: BrokerAuthState): void {
    this.authState = state;
  }

  /**
   * Computes SHA-256 checksum for Kite Connect session exchange:
   * SHA-256(api_key + request_token + api_secret)
   */
  public static computeChecksum(apiKey: string, requestToken: string, apiSecret: string): string {
    return crypto
      .createHash('sha256')
      .update(apiKey + requestToken + apiSecret)
      .digest('hex');
  }

  /**
   * Generates a cryptographically signed OAuth state binding the authenticated Firebase user.
   */
  public static createOAuthState(userId: string): string {
    if (!userId || !userId.trim()) {
      throw new Error('createOAuthState requires a valid userId');
    }
    const trimmedUser = userId.trim();
    const secret = process.env.ZERODHA_API_SECRET || process.env.KITE_API_SECRET || 'tf_oauth_secret_fallback';
    const payload: OAuthStatePayload = {
      userId: trimmedUser,
      timestamp: Date.now(),
      nonce: crypto.randomBytes(16).toString('hex'),
    };
    const payloadStr = JSON.stringify(payload);
    const hmac = crypto.createHmac('sha256', secret).update(payloadStr).digest('hex');
    const stateObj = { p: payloadStr, s: hmac };
    return Buffer.from(JSON.stringify(stateObj)).toString('base64url');
  }

  /**
   * Verifies the cryptographically signed OAuth state and extracts the verified userId.
   */
  public static verifyOAuthState(state: string, maxAgeMs = 15 * 60 * 1000): VerifyOAuthStateResult {
    if (!state || typeof state !== 'string' || !state.trim()) {
      return { valid: false, error: 'MISSING_OAUTH_STATE' };
    }
    try {
      const raw = Buffer.from(state.trim(), 'base64url').toString('utf8');
      const parsed = JSON.parse(raw);
      if (!parsed.p || !parsed.s) {
        return { valid: false, error: 'MALFORMED_OAUTH_STATE' };
      }
      const secret = process.env.ZERODHA_API_SECRET || process.env.KITE_API_SECRET || 'tf_oauth_secret_fallback';
      const expectedHmac = crypto.createHmac('sha256', secret).update(parsed.p).digest('hex');
      if (parsed.s !== expectedHmac) {
        return { valid: false, error: 'INVALID_STATE_SIGNATURE' };
      }
      const payload: OAuthStatePayload = JSON.parse(parsed.p);
      if (!payload.userId || typeof payload.userId !== 'string') {
        return { valid: false, error: 'INVALID_STATE_USER' };
      }
      if (Date.now() - payload.timestamp > maxAgeMs) {
        return { valid: false, error: 'EXPIRED_OAUTH_STATE' };
      }
      return { valid: true, userId: payload.userId };
    } catch {
      return { valid: false, error: 'MALFORMED_OAUTH_STATE' };
    }
  }

  /**
   * Generates the Kite Connect login URL using the server-side API Key.
   * NEVER includes API Secret or Access Token.
   * Cryptographically binds the authenticated userId via signed state.
   */
  public static getLoginUrl(redirectUrl?: string, userId?: string, existingState?: string): string {
    const apiKey = process.env.ZERODHA_API_KEY || process.env.KITE_API_KEY;
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error('Cannot generate login URL: ZERODHA_API_KEY is not configured on server.');
    }
    const state = existingState || (userId && userId.trim() ? this.createOAuthState(userId.trim()) : undefined);

    const defaultRedirect =
      process.env.ZERODHA_REDIRECT_URI ||
      process.env.ZERODHA_REDIRECT_URL ||
      (process.env.APP_URL ? `${process.env.APP_URL.replace(/\/$/, '')}/api/broker/live/auth/callback` : undefined);

    let effectiveRedirect = redirectUrl || defaultRedirect;

    if (state && effectiveRedirect && !effectiveRedirect.includes('state=')) {
      const sep = effectiveRedirect.includes('?') ? '&' : '?';
      effectiveRedirect = `${effectiveRedirect}${sep}state=${encodeURIComponent(state)}`;
    }

    let url = `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(apiKey.trim())}`;
    if (effectiveRedirect) {
      url += `&redirect_url=${encodeURIComponent(effectiveRedirect.trim())}`;
      url += `&redirect_uri=${encodeURIComponent(effectiveRedirect.trim())}`;
    }
    if (state) {
      url += `&state=${encodeURIComponent(state)}`;
    }
    return url;
  }

  /**
   * Generates login URL and returns both URL and generated OAuth state.
   */
  public static getLoginUrlWithState(redirectUrl?: string, userId?: string): { url: string; state?: string } {
    let state: string | undefined;
    if (userId && userId.trim()) {
      state = this.createOAuthState(userId.trim());
    }
    const url = this.getLoginUrl(redirectUrl, undefined, state);
    return { url, state };
  }

  /**
   * Exchanges a one-time request_token for an active access_token via Kite Connect.
   *
   * Responsibilities:
   * 1. Calls POST https://api.kite.trade/session/token with checksum.
   * 2. Encrypts and persists access_token in authoritative Firestore.
   * 3. Sets sessionVersion atomically.
   * 4. Updates local RAM cache ONLY IF persistence succeeds.
   * 5. Sets authState = 'AUTHENTICATED' ONLY IF persistence succeeds.
   * 6. Returns sanitized metadata; NEVER returns access_token or ciphertext in result.
   */
  public static async exchangeRequestToken(
    requestToken: string,
    userIdOrFetch: string | HttpFetchFn = 'default_trader',
    options?: {
      connectionId?: string;
      customFetch?: HttpFetchFn;
    } | HttpFetchFn
  ): Promise<{
    success: boolean;
    error?: string;
    session?: {
      authenticatedAt: string;
      expiresAt: string;
      tradingDateKolkata: string;
      sessionVersion: number;
      brokerUserId?: string;
      userId?: string;
    };
  }> {
    let userId = 'default_trader';
    let connectionId = 'zerodha';
    let customFetch: HttpFetchFn = fetch;

    if (typeof userIdOrFetch === 'function') {
      customFetch = userIdOrFetch;
    } else if (typeof userIdOrFetch === 'string' && userIdOrFetch.trim().length > 0) {
      userId = userIdOrFetch.trim();
    }

    if (typeof options === 'function') {
      customFetch = options;
    } else if (options && typeof options === 'object') {
      if (options.customFetch) customFetch = options.customFetch;
      if (options.connectionId) connectionId = options.connectionId;
    }

    const apiKey = process.env.ZERODHA_API_KEY || process.env.KITE_API_KEY;
    const apiSecret = process.env.ZERODHA_API_SECRET || process.env.KITE_API_SECRET;

    if (!apiKey || !apiSecret) {
      return {
        success: false,
        error: 'Cannot exchange token: ZERODHA_API_KEY or ZERODHA_API_SECRET is missing.',
      };
    }

    if (!requestToken || requestToken.trim().length === 0) {
      return {
        success: false,
        error: 'Invalid request: request_token is missing or empty.',
      };
    }

    const cleanApiKey = apiKey.trim();
    const cleanSecret = apiSecret.trim();
    const cleanReqToken = requestToken.trim();
    const checksum = this.computeChecksum(cleanApiKey, cleanReqToken, cleanSecret);

    const bodyParams = new URLSearchParams();
    bodyParams.append('api_key', cleanApiKey);
    bodyParams.append('request_token', cleanReqToken);
    bodyParams.append('checksum', checksum);

    const fetchFn = customFetch;

    try {
      const response = await fetchFn('https://api.kite.trade/session/token', {
        method: 'POST',
        headers: {
          'X-Kite-Version': '3',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: bodyParams.toString(),
      });

      const body = await response.json();

      if (!response.ok || body.status !== 'success' || !body.data?.access_token) {
        this.setAuthState('AUTHENTICATION_ERROR');
        return {
          success: false,
          error: this.sanitizeErrorString(body.message || `Kite token exchange failed with HTTP ${response.status}`),
        };
      }

      const rawAccessToken = String(body.data.access_token).trim();
      const brokerUserId = body.data.user_id ? String(body.data.user_id).trim() : undefined;

      // Persist encrypted token to authoritative Firestore (FAIL-CLOSED)
      let persistenceResult;
      try {
        persistenceResult = await ZerodhaSessionStore.saveSession(userId, rawAccessToken, {
          brokerUserId,
          connectionId,
        });
      } catch (persistErr: any) {
        // FAIL-CLOSED: Authentication must NOT report AUTHENTICATED unless encrypted session is successfully persisted.
        this.cachedSession = null;
        this.setAuthState('AUTHENTICATION_REQUIRED');
        const persistMsg = persistErr instanceof SessionPersistenceError
          ? persistErr.message
          : `SESSION_PERSISTENCE_ERROR: ${persistErr?.message || 'Failed to securely persist session to authoritative store'}`;
        return {
          success: false,
          error: this.sanitizeErrorString(persistMsg),
        };
      }

      // Update short-lived local RAM cache ONLY upon successful persistence
      const now = Date.now();
      this.cachedSession = {
        accessToken: rawAccessToken,
        sessionVersion: persistenceResult.sessionVersion,
        issuedAt: new Date(now).toISOString(),
        expiresAt: persistenceResult.expiresAt,
        tradingDateKolkata: persistenceResult.tradingDateKolkata,
        brokerUserId,
        userId,
        cachedAtMs: now,
      };
      this.authState = 'AUTHENTICATED';

      // Return strictly sanitized status metadata (ZERO token, ZERO ciphertext, ZERO keys)
      return {
        success: true,
        session: {
          authenticatedAt: new Date(now).toISOString(),
          expiresAt: persistenceResult.expiresAt,
          tradingDateKolkata: persistenceResult.tradingDateKolkata,
          sessionVersion: persistenceResult.sessionVersion,
          brokerUserId,
          userId: brokerUserId || userId,
        },
      };
    } catch (err) {
      this.cachedSession = null;
      this.setAuthState('AUTHENTICATION_ERROR');
      const rawMsg = err instanceof Error ? err.message : 'Unknown network failure';
      return {
        success: false,
        error: this.sanitizeErrorString(`Failed to exchange token with Zerodha: ${rawMsg}`),
      };
    }
  }

  /**
   * Safe presence diagnostic reporting ONLY boolean presence flags and non-sensitive timestamps.
   * NEVER returns actual values, prefixes, suffixes, lengths, hashes, or environment dumps.
   */
  public static getPresenceDiagnostic(userId = 'default_trader'): CredentialPresenceDiagnostic & {
    sessionVersion?: number;
    sessionSource?: 'PERSISTED' | 'RAM_CACHE' | 'DEV_ENV' | 'NONE';
  } {
    const apiKey = process.env.ZERODHA_API_KEY || process.env.KITE_API_KEY;
    const apiSecret = process.env.ZERODHA_API_SECRET || process.env.KITE_API_SECRET;
    const activeToken = this.getActiveAccessToken(userId);

    const apiKeyConfigured = Boolean(apiKey && apiKey.trim().length > 0);
    const apiSecretConfigured = Boolean(apiSecret && apiSecret.trim().length > 0);
    const accessTokenConfigured = Boolean(activeToken && activeToken.trim().length > 0);

    const hasMatchingUserCache = Boolean(
      this.cachedSession && (!userId || this.cachedSession.userId === userId || this.cachedSession.userId === 'default_trader')
    );
    const isAuth = this.authState === 'AUTHENTICATED' && (accessTokenConfigured || hasMatchingUserCache);
    const isAuthRequired = !isAuth || this.authState === 'AUTHENTICATION_REQUIRED';

    const sessionSource: 'PERSISTED' | 'RAM_CACHE' | 'DEV_ENV' | 'NONE' = hasMatchingUserCache
      ? 'RAM_CACHE'
      : activeToken
      ? 'DEV_ENV'
      : 'NONE';

    return {
      apiKeyConfigured,
      apiSecretConfigured,
      accessTokenConfigured,
      authenticated: isAuth,
      authenticationRequired: isAuthRequired,
      authenticatedAt: hasMatchingUserCache ? this.cachedSession?.issuedAt || null : null,
      expiresAt: hasMatchingUserCache ? this.cachedSession?.expiresAt || null : null,
      sessionVersion: hasMatchingUserCache ? this.cachedSession?.sessionVersion : undefined,
      sessionSource,
    };
  }

  /**
   * Sanitizes any error message or string so credentials are never leaked.
   */
  public static sanitizeErrorString(text: string): string {
    const creds = this.getCredentials();
    let sanitized = text;
    if (creds.apiKey && creds.apiKey.length > 0) {
      sanitized = sanitized.split(creds.apiKey).join('[REDACTED_API_KEY]');
    }
    if (creds.apiSecret && creds.apiSecret.length > 0) {
      sanitized = sanitized.split(creds.apiSecret).join('[REDACTED_API_SECRET]');
    }
    if (this.cachedSession?.accessToken && this.cachedSession.accessToken.length > 0) {
      sanitized = sanitized.split(this.cachedSession.accessToken).join('[REDACTED_ACCESS_TOKEN]');
    }
    const token = this.getActiveAccessToken();
    if (token && token.length > 0 && token !== this.cachedSession?.accessToken) {
      sanitized = sanitized.split(token).join('[REDACTED_ACCESS_TOKEN]');
    }
    return sanitized;
  }

  /**
   * Strips all credential data from any object before sending to API responses.
   * Safety guard to ensure credentials never leak.
   */
  public static sanitize<T extends Record<string, any>>(
    obj: T
  ): Omit<
    T,
    | 'apiKey'
    | 'apiSecret'
    | 'accessToken'
    | 'api_key'
    | 'api_secret'
    | 'access_token'
    | 'checksum'
    | 'request_token'
    | 'requestToken'
    | 'encryptedToken'
    | 'ciphertext'
    | 'iv'
    | 'tag'
  > {
    const sanitized = { ...obj };
    delete (sanitized as any).apiKey;
    delete (sanitized as any).apiSecret;
    delete (sanitized as any).accessToken;
    delete (sanitized as any).api_key;
    delete (sanitized as any).api_secret;
    delete (sanitized as any).access_token;
    delete (sanitized as any).checksum;
    delete (sanitized as any).request_token;
    delete (sanitized as any).requestToken;
    delete (sanitized as any).encryptedToken;
    delete (sanitized as any).ciphertext;
    delete (sanitized as any).iv;
    delete (sanitized as any).tag;
    return sanitized;
  }
}
