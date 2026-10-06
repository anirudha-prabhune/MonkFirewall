import {
  BrokerAdapter,
  BrokerConnectionStatus,
  RawBrokerPosition,
  BrokerInstrument,
  LtpSnapshotResult,
} from '../types';
import { ZerodhaCredentialManager } from './credentials';
import { classifyInstrument } from '../../instruments/master';

export class InstrumentValidationError extends Error {
  constructor(message: string) {
    super(`[InstrumentValidationError] ${message}`);
    this.name = 'InstrumentValidationError';
  }
}

export type HttpFetchFn = (url: string, options?: any) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: any;
  json: () => Promise<any>;
  text?: () => Promise<string>;
}>;

/**
 * Phase 7 & 8A — Live Zerodha Read-Only Broker Adapter with Authoritative Session Persistence.
 *
 * CRITICAL ARCHITECTURAL CONSTRAINTS:
 * 1. READ-ONLY CONTRACT: Contains ZERO order, trading, square-off, or execution methods.
 * 2. SERVER-ONLY SECRETS: Never exposes api_key, api_secret, or access_token to responses, logs, or errors.
 * 3. AUTHORITATIVE SESSION (PHASE 8A): All calls resolve the active session via ZerodhaCredentialManager.
 * 4. TOKENEXCEPTION CONCURRENCY SAFETY: 401/403 invalidates only the failed sessionVersion without destroying newer sessions.
 */
export class LiveZerodhaAdapter implements BrokerAdapter {
  private customFetch?: HttpFetchFn;
  private cachedInstruments: BrokerInstrument[] | null = null;
  private instrumentCacheTimestamp: number = 0;
  private readonly INSTRUMENT_CACHE_TTL_MS = 3600 * 1000; // 1 hour

  constructor(customFetch?: HttpFetchFn) {
    this.customFetch = customFetch;
  }

  /**
   * Allows injecting a custom HTTP fetch handler (primarily for unit/integration testing).
   */
  public setFetchHandler(fn?: HttpFetchFn) {
    this.customFetch = fn;
    this.cachedInstruments = null;
  }

  private async fetch(url: string, options: any = {}) {
    if (this.customFetch) {
      return this.customFetch(url, options);
    }
    return fetch(url, options);
  }

  /**
   * Retrieves live connection status using server-side credentials and persisted daily session.
   */
  public async getConnectionStatus(userId = 'default_trader'): Promise<BrokerConnectionStatus> {
    const presence = ZerodhaCredentialManager.getPresenceDiagnostic(userId);
    const { apiKey } = ZerodhaCredentialManager.getCredentials(userId);

    if (!apiKey || apiKey.trim().length === 0) {
      return {
        broker: 'zerodha',
        status: 'CONFIGURATION_ERROR',
        isMock: false,
        configured: false,
        authenticated: false,
        authenticationRequired: true,
        credentials: presence,
        message: 'Missing required Zerodha credentials: ZERODHA_API_KEY',
        timestamp: new Date().toISOString(),
      };
    }

    const authSession = await ZerodhaCredentialManager.getAuthenticatedSession(userId);
    if (!authSession) {
      const persistentCheck = ZerodhaCredentialManager.validatePersistentConfig();
      if (!persistentCheck.configured) {
        return {
          broker: 'zerodha',
          status: 'CONFIGURATION_ERROR',
          isMock: false,
          configured: false,
          authenticated: false,
          authenticationRequired: true,
          credentials: presence,
          message: persistentCheck.error || 'Missing required Zerodha credentials: ZERODHA_API_SECRET',
          timestamp: new Date().toISOString(),
        };
      }
      return {
        broker: 'zerodha',
        status: 'AUTHENTICATION_REQUIRED',
        isMock: false,
        configured: true,
        authenticated: false,
        authenticationRequired: true,
        credentials: presence,
        message: 'Zerodha authentication required. Please authenticate via Kite Connect login.',
        timestamp: new Date().toISOString(),
      };
    }

    try {
      const response = await this.fetch('https://api.kite.trade/user/profile', {
        method: 'GET',
        headers: {
          'X-Kite-Version': '3',
          Authorization: `token ${apiKey}:${authSession.accessToken}`,
        },
      });

      if (response.status === 401 || response.status === 403) {
        await ZerodhaCredentialManager.handleTokenException(userId, authSession.sessionVersion);
        return {
          broker: 'zerodha',
          status: 'AUTHENTICATION_ERROR',
          isMock: false,
          configured: true,
          authenticated: false,
          authenticationRequired: true,
          credentials: ZerodhaCredentialManager.getPresenceDiagnostic(userId),
          message: 'Authentication failed: Invalid or expired Zerodha access token. Please re-authenticate.',
          timestamp: new Date().toISOString(),
        };
      }

      if (!response.ok) {
        return {
          broker: 'zerodha',
          status: 'UPSTREAM_ERROR',
          isMock: false,
          configured: true,
          authenticated: false,
          authenticationRequired: false,
          credentials: presence,
          message: `Zerodha profile endpoint returned HTTP ${response.status}`,
          timestamp: new Date().toISOString(),
        };
      }

      const body = await response.json();
      if (body.status === 'success') {
        ZerodhaCredentialManager.setAuthState('AUTHENTICATED');
        return {
          broker: 'zerodha',
          status: 'CONNECTED',
          isMock: false,
          configured: true,
          authenticated: true,
          authenticationRequired: false,
          authenticatedAt: new Date().toISOString(),
          expiresAt: authSession.expiresAt,
          credentials: ZerodhaCredentialManager.getPresenceDiagnostic(userId),
          message: 'Connected and authenticated with Live Zerodha Kite Connect API (Read-Only).',
          timestamp: new Date().toISOString(),
        };
      }

      await ZerodhaCredentialManager.handleTokenException(userId, authSession.sessionVersion);
      return {
        broker: 'zerodha',
        status: 'AUTHENTICATION_ERROR',
        isMock: false,
        configured: true,
        authenticated: false,
        authenticationRequired: true,
        credentials: ZerodhaCredentialManager.getPresenceDiagnostic(userId),
        message: ZerodhaCredentialManager.sanitizeErrorString(body.message || 'Zerodha session validation failed.'),
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : 'Unknown error';
      return {
        broker: 'zerodha',
        status: 'UPSTREAM_ERROR',
        isMock: false,
        configured: true,
        authenticated: false,
        authenticationRequired: false,
        credentials: presence,
        message: ZerodhaCredentialManager.sanitizeErrorString(`Network failure connecting to Zerodha API: ${rawMsg}`),
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Retrieves current positions via Kite Connect /portfolio/positions (READ-ONLY).
   */
  public async getPositions(userId = 'default_trader'): Promise<RawBrokerPosition[]> {
    const credCheck = ZerodhaCredentialManager.validatePersistentConfig();
    if (!credCheck.configured) {
      throw new Error(`[LiveZerodhaAdapter] Cannot fetch positions: ${credCheck.error}`);
    }

    const authSession = await ZerodhaCredentialManager.getAuthenticatedSession(userId);
    if (!authSession) {
      throw new Error('[LiveZerodhaAdapter] Authentication failure: No active Zerodha access token. Please authenticate via Kite Connect.');
    }

    const { apiKey } = ZerodhaCredentialManager.getCredentials(userId);

    try {
      const response = await this.fetch('https://api.kite.trade/portfolio/positions', {
        method: 'GET',
        headers: {
          'X-Kite-Version': '3',
          Authorization: `token ${apiKey}:${authSession.accessToken}`,
        },
      });

      if (response.status === 401 || response.status === 403) {
        await ZerodhaCredentialManager.handleTokenException(userId, authSession.sessionVersion);
        throw new Error('[LiveZerodhaAdapter] Authentication failure: Invalid or expired access token (TokenException). Please re-authenticate.');
      }

      if (!response.ok) {
        throw new Error(`[LiveZerodhaAdapter] Upstream positions API returned HTTP ${response.status}`);
      }

      const body = await response.json();
      if (body.status !== 'success' || !body.data) {
        throw new Error(`[LiveZerodhaAdapter] Malformed positions response: ${body.message || 'Missing data'}`);
      }

      const netPositions: RawBrokerPosition[] = (body.data.net || []).map((p: any) => ({
        ...p,
        provenance: 'net' as const,
      }));
      const dayPositions: RawBrokerPosition[] = (body.data.day || []).map((p: any) => ({
        ...p,
        provenance: 'day' as const,
      }));

      return [...netPositions, ...dayPositions];
    } catch (err) {
      if (err instanceof Error) throw err;
      throw new Error('[LiveZerodhaAdapter] Failed to fetch live positions from Zerodha');
    }
  }

  /**
   * Validates a single instrument record from Zerodha.
   */
  public validateInstrumentRecord(raw: any): BrokerInstrument {
    if (!raw || typeof raw !== 'object') {
      throw new InstrumentValidationError('Instrument record must be a non-null object');
    }

    const token = raw.instrument_token ?? raw.instrumentToken;
    if (typeof token !== 'number' || !Number.isInteger(token) || token <= 0) {
      throw new InstrumentValidationError(`Invalid instrument_token: ${token}`);
    }

    const exchange = raw.exchange;
    if (typeof exchange !== 'string' || exchange.trim().length === 0) {
      throw new InstrumentValidationError(`Invalid exchange for token ${token}: ${exchange}`);
    }

    const tradingsymbol = raw.tradingsymbol;
    if (typeof tradingsymbol !== 'string' || tradingsymbol.trim().length === 0) {
      throw new InstrumentValidationError(`Invalid tradingsymbol for token ${token}: ${tradingsymbol}`);
    }

    const segment = raw.segment;
    if (typeof segment !== 'string' || segment.trim().length === 0) {
      throw new InstrumentValidationError(`Invalid segment for token ${token}: ${segment}`);
    }

    const instrumentType = raw.instrument_type ?? raw.instrumentType ?? 'UNKNOWN';

    classifyInstrument({ segment, instrumentType });

    return {
      instrumentToken: token,
      exchange: exchange.trim().toUpperCase(),
      tradingsymbol: tradingsymbol.trim(),
      name: (raw.name || tradingsymbol).trim(),
      segment: segment.trim().toUpperCase(),
      instrumentType: String(instrumentType).trim().toUpperCase(),
      expiry: raw.expiry ? String(raw.expiry).trim() : null,
      strike: typeof raw.strike === 'number' && Number.isFinite(raw.strike) ? raw.strike : null,
      tickSize: typeof raw.tick_size === 'number' ? raw.tick_size : typeof raw.tickSize === 'number' ? raw.tickSize : 0.05,
      lotSize: typeof raw.lot_size === 'number' ? raw.lot_size : typeof raw.lotSize === 'number' ? raw.lotSize : 1,
    };
  }

  /**
   * Retrieves and validates live instrument master records.
   */
  public async getInstruments(userId = 'default_trader'): Promise<BrokerInstrument[]> {
    const now = Date.now();
    if (this.cachedInstruments && now - this.instrumentCacheTimestamp < this.INSTRUMENT_CACHE_TTL_MS) {
      return this.cachedInstruments;
    }

    const credCheck = ZerodhaCredentialManager.validatePersistentConfig();
    if (!credCheck.configured) {
      throw new Error(`[LiveZerodhaAdapter] Cannot fetch instruments: ${credCheck.error}`);
    }

    const authSession = await ZerodhaCredentialManager.getAuthenticatedSession(userId);
    if (!authSession) {
      throw new Error('[LiveZerodhaAdapter] Authentication failure: No active Zerodha access token. Please authenticate via Kite Connect.');
    }

    const { apiKey } = ZerodhaCredentialManager.getCredentials(userId);

    try {
      const response = await this.fetch('https://api.kite.trade/instruments', {
        method: 'GET',
        headers: {
          'X-Kite-Version': '3',
          Authorization: `token ${apiKey}:${authSession.accessToken}`,
        },
      });

      if (response.status === 401 || response.status === 403) {
        await ZerodhaCredentialManager.handleTokenException(userId, authSession.sessionVersion);
        throw new Error('[LiveZerodhaAdapter] Authentication failure: Invalid or expired access token. Please re-authenticate.');
      }

      if (!response.ok) {
        throw new Error(`[LiveZerodhaAdapter] Upstream instruments API returned HTTP ${response.status}`);
      }

      let rawRecords: any[] = [];
      const contentType = response.headers?.get ? response.headers.get('content-type') : '';
      if (contentType && contentType.includes('application/json')) {
        const body = await response.json();
        rawRecords = Array.isArray(body) ? body : body.data || [];
      } else {
        const text = response.text ? await response.text() : await (response as any).json();
        if (typeof text === 'string') {
          rawRecords = this.parseInstrumentsCsv(text);
        } else if (Array.isArray(text)) {
          rawRecords = text;
        } else if (text && Array.isArray(text.data)) {
          rawRecords = text.data;
        }
      }

      const validated: BrokerInstrument[] = [];
      for (const rec of rawRecords) {
        try {
          validated.push(this.validateInstrumentRecord(rec));
        } catch (err) {
          if (err instanceof InstrumentValidationError) {
            console.warn(`[LiveZerodhaAdapter] Skipping malformed instrument: ${err.message}`);
          }
        }
      }

      if (validated.length > 0) {
        this.cachedInstruments = validated;
        this.instrumentCacheTimestamp = now;
      }
      return validated;
    } catch (err) {
      if (err instanceof Error) throw err;
      throw new Error('[LiveZerodhaAdapter] Failed to fetch instruments from Zerodha');
    }
  }

  /**
   * Simple CSV parser for Zerodha instruments CSV dump.
   */
  private parseInstrumentsCsv(csv: string): any[] {
    const lines = csv.trim().split('\n');
    if (lines.length < 2) return [];

    const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
    const records: any[] = [];

    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(',').map((cell) => cell.trim().replace(/^"|"$/g, ''));
      if (row.length !== headers.length) continue;

      const obj: any = {};
      headers.forEach((h, idx) => {
        obj[h] = row[idx];
      });

      if (obj.instrument_token) obj.instrument_token = parseInt(obj.instrument_token, 10);
      if (obj.strike) obj.strike = parseFloat(obj.strike);
      if (obj.tick_size) obj.tick_size = parseFloat(obj.tick_size);
      if (obj.lot_size) obj.lot_size = parseInt(obj.lot_size, 10);

      records.push(obj);
    }

    return records;
  }

  /**
   * Retrieves instantaneous read-only LTP snapshot for a single F&O instrument (Phase 8A).
   * Strictly read-only: No orders, no risk mutation, no credentials exposed.
   */
  public async getLtpSnapshot(instrumentToken: number, userId = 'default_trader'): Promise<LtpSnapshotResult> {
    const instruments = await this.getInstruments(userId);
    const instrument = instruments.find((i) => i.instrumentToken === instrumentToken);

    if (!instrument) {
      throw new Error(`[LiveZerodhaAdapter] Unknown instrument token: ${instrumentToken}`);
    }

    const classification = classifyInstrument(instrument);
    if (!classification.isFno) {
      throw new Error(`[LiveZerodhaAdapter] Non-F&O instrument rejected: ${instrument.tradingsymbol} (${instrument.segment})`);
    }

    const credCheck = ZerodhaCredentialManager.validatePersistentConfig();
    if (!credCheck.configured) {
      throw new Error(`[LiveZerodhaAdapter] Cannot fetch LTP snapshot: ${credCheck.error}`);
    }

    const authSession = await ZerodhaCredentialManager.getAuthenticatedSession(userId);
    if (!authSession) {
      throw new Error('[LiveZerodhaAdapter] Authentication failure: Missing or expired Zerodha session token.');
    }

    const { apiKey } = ZerodhaCredentialManager.getCredentials(userId);
    const queryParam = `${instrument.exchange}:${instrument.tradingsymbol}`;

    try {
      const url = `https://api.kite.trade/quote/ltp?i=${encodeURIComponent(queryParam)}`;
      const response = await this.fetch(url, {
        method: 'GET',
        headers: {
          'X-Kite-Version': '3',
          Authorization: `token ${apiKey}:${authSession.accessToken}`,
        },
      });

      if (response.status === 401 || response.status === 403) {
        await ZerodhaCredentialManager.handleTokenException(userId, authSession.sessionVersion);
        throw new Error('[LiveZerodhaAdapter] Authentication failure: Invalid or expired access token (HTTP 403 TokenException).');
      }

      if (!response.ok) {
        throw new Error(`[LiveZerodhaAdapter] Upstream quote/ltp returned HTTP ${response.status}`);
      }

      const body = await response.json();
      if (body.status !== 'success' || !body.data) {
        return {
          dataSource: 'ZERODHA_LIVE',
          instrumentToken,
          exchange: instrument.exchange,
          segment: instrument.segment,
          instrumentType: instrument.instrumentType,
          tradingSymbol: instrument.tradingsymbol,
          lastPrice: null,
          receivedAt: new Date().toISOString(),
          status: 'UNAVAILABLE',
          diagnosticMessage: ZerodhaCredentialManager.sanitizeErrorString(body?.message || 'No quote data returned'),
        };
      }

      const quoteData =
        body.data[queryParam] ||
        body.data[String(instrumentToken)] ||
        Object.values(body.data).find(
          (v: any) => (v?.instrument_token ?? v?.instrumentToken) === instrumentToken
        );
      const ltp = quoteData?.last_price ?? quoteData?.lastPrice;

      if (typeof ltp === 'number' && Number.isFinite(ltp) && ltp >= 0) {
        return {
          dataSource: 'ZERODHA_LIVE',
          instrumentToken,
          exchange: instrument.exchange,
          segment: instrument.segment,
          instrumentType: instrument.instrumentType,
          tradingSymbol: instrument.tradingsymbol,
          lastPrice: ltp,
          receivedAt: new Date().toISOString(),
          status: 'VALID',
        };
      }

      return {
        dataSource: 'ZERODHA_LIVE',
        instrumentToken,
        exchange: instrument.exchange,
        segment: instrument.segment,
        instrumentType: instrument.instrumentType,
        tradingSymbol: instrument.tradingsymbol,
        lastPrice: null,
        receivedAt: new Date().toISOString(),
        status: 'UNAVAILABLE',
        diagnosticMessage: 'Upstream returned valid quote structure but last_price is null or invalid',
      };
    } catch (err) {
      if (err instanceof Error) throw err;
      throw new Error('[LiveZerodhaAdapter] Failed to fetch LTP snapshot from Zerodha');
    }
  }
}

export const liveZerodhaAdapter = new LiveZerodhaAdapter();
