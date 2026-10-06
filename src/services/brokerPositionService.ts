import { NormalizedPosition, BrokerConnectionStatus } from '../../server/brokers/types';

export interface PositionsResponse {
  dataSource: 'MOCK_DATA' | 'ZERODHA_LIVE';
  count: number;
  positions: NormalizedPosition[];
  validationState?: string;
  marketDataStatus?: string;
}

export async function fetchBrokerStatus(): Promise<BrokerConnectionStatus> {
  try {
    const res = await fetch('/api/broker/status');
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn('Failed to fetch broker status:', err);
  }

  return {
    broker: 'zerodha',
    status: 'CONNECTED',
    isMock: true,
    message: 'Mock Zerodha Adapter (Phase 3 Sandbox)',
    timestamp: new Date().toISOString(),
  };
}

export async function fetchFnoPositions(userId?: string): Promise<NormalizedPosition[]> {
  try {
    const headers: Record<string, string> = {};
    if (userId) headers['x-user-id'] = userId;

    const res = await fetch('/api/positions/fno', { headers });
    if (res.ok) {
      const data: PositionsResponse = await res.json();
      return data.positions || [];
    }
  } catch (err) {
    console.warn('Failed to fetch F&O positions:', err);
  }
  return [];
}
