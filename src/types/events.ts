export type RiskEventType =
  | 'RISK_WARNING'
  | 'LOSS_LIMIT_BREACHED'
  | 'TRADING_LOCK_CREATED'
  | 'TRADING_LOCK_EXPIRED'
  | 'BROKER_CONNECTED'
  | 'BROKER_DISCONNECTED'
  | 'MARKET_DATA_STALE'
  | 'CONFIG_UPDATED';

export interface RiskEvent {
  id?: string;
  userId: string;
  type: RiskEventType;
  message: string;
  timestamp: string;
}
