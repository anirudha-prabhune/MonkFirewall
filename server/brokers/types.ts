/**
 * Phase 3 — Broker Abstraction & Normalized Position Contracts.
 *
 * Guarantees:
 * - Broker-independent interface (application depends on BrokerAdapter, not directly on Zerodha).
 * - Snake_case for raw broker fields (Zerodha Kite representation).
 * - CamelCase for canonical application models.
 * - Strict metadata-driven F&O classification (segment based; never tradingsymbol suffix heuristics).
 */

export type BrokerAuthState =
  | 'DISCONNECTED'
  | 'AUTHENTICATION_REQUIRED'
  | 'AUTHENTICATED'
  | 'AUTHENTICATION_ERROR';

export type ConnectionState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'AUTHENTICATED'
  | 'AUTHENTICATION_REQUIRED'
  | 'AUTHENTICATION_ERROR'
  | 'CONFIGURATION_ERROR'
  | 'UPSTREAM_ERROR'
  | 'STALE'
  | 'UNKNOWN'
  | 'ERROR';

export interface CredentialPresenceDiagnostic {
  apiKeyConfigured: boolean;
  accessTokenConfigured: boolean;
  apiSecretConfigured: boolean;
  authenticated?: boolean;
  authenticationRequired?: boolean;
  authenticatedAt?: string | null;
  expiresAt?: string | null;
}

export interface BrokerConnectionStatus {
  broker: string;
  status: ConnectionState;
  isMock: boolean;
  message: string;
  timestamp: string;
  configured?: boolean;
  authenticated?: boolean;
  authenticationRequired?: boolean;
  authenticatedAt?: string | null;
  expiresAt?: string | null;
  credentials?: CredentialPresenceDiagnostic;
}

/**
 * Raw position structure matching Zerodha Kite Connect API response.
 */
export interface RawBrokerPosition {
  exchange: string;
  tradingsymbol: string;
  product: string;
  quantity: number;
  average_price: number;
  last_price: number;
  pnl: number;
  realised: number;
  unrealised: number;
  day_buy_quantity: number;
  day_buy_value: number;
  day_sell_quantity: number;
  day_sell_value: number;
  instrument_token: number;
  m2m?: number;
  multiplier?: number;
  buy_m2m?: number;
  sell_m2m?: number;
  close_price?: number;
  overnight_quantity?: number;
  provenance?: 'net' | 'day';
}

/**
 * Broker-independent instrument metadata model.
 */
export interface BrokerInstrument {
  instrumentToken: number;
  exchange: string;
  tradingsymbol: string;
  name: string;
  segment: string;
  instrumentType: string;
  expiry: string | null;
  strike: number | null;
  tickSize: number;
  lotSize: number;
}

export type InstrumentCategory = 'FNO' | 'EQUITY' | 'OTHER';
export type InstrumentDetailType = 'FUTURE' | 'OPTION' | 'EQUITY' | 'OTHER';

export interface InstrumentClassification {
  isFno: boolean;
  category: InstrumentCategory;
  type: InstrumentDetailType;
  segment: string;
}

/**
 * Canonical normalized position model across the Trading Firewall.
 */
export interface NormalizedPosition {
  instrumentToken: number;
  exchange: string;
  tradingsymbol: string;
  segment: string;
  instrumentType: string;
  product: string;
  quantity: number;
  averagePrice: number;
  lastPrice: number;
  closePrice?: number;
  multiplier?: number;
  overnightQuantity?: number;
  dayBuyQuantity: number;
  dayBuyValue: number;
  daySellQuantity: number;
  daySellValue: number;
  realisedPnl: number;
  unrealisedPnl: number;
  totalPnl: number;
  m2m?: number;
  isFno: boolean;
  dataSource: 'MOCK_DATA' | 'ZERODHA_LIVE';
  unknownInstrument?: boolean;
  provenance?: 'net' | 'day';
}

/**
 * Abstract Broker Adapter contract.
 * The application depends strictly on this interface.
 * GUARANTEE: Read-only contract! No order-placement or trading methods.
 */
export interface BrokerAdapter {
  getConnectionStatus(): Promise<BrokerConnectionStatus>;
  getPositions(): Promise<RawBrokerPosition[]>;
  getInstruments(): Promise<BrokerInstrument[]>;
}

/**
 * Phase 7 — Live Diagnostic & Market Data Types
 */
export interface LiveBrokerStatusResponse {
  broker: string;
  status: ConnectionState;
  isMock: boolean;
  configured: boolean;
  authenticated: boolean;
  authenticationRequired: boolean;
  authenticatedAt?: string | null;
  expiresAt?: string | null;
  message: string;
  timestamp: string;
  mode: 'mock' | 'live';
  credentials?: CredentialPresenceDiagnostic;
}

export interface LivePositionsResponse {
  broker: string;
  connectionStatus: ConnectionState;
  dataSource: 'ZERODHA_LIVE';
  positionCount: number;
  fnoPositionCount: number;
  positions: NormalizedPosition[];
  timestamp: string;
  diagnosticNote: string;
  unknownInstruments?: Array<{
    instrumentToken: number;
    tradingsymbol: string;
    exchange: string;
    reason: string;
  }>;
  crossCheckValidation?: {
    checkedCount: number;
    discrepancies: Array<{
      tradingsymbol: string;
      brokerUnrealisedPnl: number;
      calculatedUnrealisedPnl: number;
      difference: number;
    }>;
  };
}

export interface MarketDataStatus {
  status: 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR';
  subscribedCount: number;
  lastTickAt: string | null;
  isStale: boolean;
  staleThresholdSeconds: number;
  timestamp: string;
}

export interface MarketPriceTick {
  instrumentToken: number;
  lastPrice: number;
  timestamp: string;
  isStale: boolean;
}

export interface LtpSnapshotResult {
  dataSource: 'ZERODHA_LIVE';
  instrumentToken: number;
  exchange: string;
  segment: string;
  instrumentType: string;
  tradingSymbol: string;
  lastPrice: number | null;
  receivedAt: string | null;
  status: 'VALID' | 'UNAVAILABLE' | 'STALE' | 'ERROR';
  diagnosticMessage?: string;
}
