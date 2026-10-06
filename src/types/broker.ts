export type BrokerType = 'zerodha' | 'mock';

export type BrokerStatus = 'CONNECTED' | 'DISCONNECTED' | 'EXPIRED' | 'ERROR';

export interface BrokerConnection {
  broker: BrokerType;
  status: BrokerStatus;
  userId: string;
  brokerUserId?: string;
  connectedAt?: string;
  lastSyncAt?: string;
}

export interface NormalizedPosition {
  instrumentToken: number;
  exchange: string;
  tradingsymbol: string;
  segment?: string;
  instrumentType?: string;
  product?: string;
  quantity: number;
  averagePrice: number;
  lastPrice: number;
  dayBuyQuantity?: number;
  dayBuyValue?: number;
  daySellQuantity?: number;
  daySellValue?: number;
  realisedPnl?: number;
  unrealisedPnl?: number;
  totalPnl?: number;
}
