import {
  LiveBrokerStatusResponse,
  LivePositionsResponse,
  MarketDataStatus,
} from '../../server/brokers/types';

export async function fetchLiveBrokerStatus(userId?: string): Promise<LiveBrokerStatusResponse | null> {
  try {
    const headers: Record<string, string> = {};
    if (userId) headers['x-user-id'] = userId;

    const res = await fetch('/api/broker/live/status', { headers });
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn('Failed to fetch live broker status:', err);
  }
  return null;
}

export async function fetchLivePositions(userId?: string): Promise<LivePositionsResponse | null> {
  try {
    const headers: Record<string, string> = {};
    if (userId) headers['x-user-id'] = userId;

    const res = await fetch('/api/broker/live/positions', { headers });
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn('Failed to fetch live positions:', err);
  }
  return null;
}

export async function fetchMarketDataStatus(userId?: string): Promise<MarketDataStatus | null> {
  try {
    const headers: Record<string, string> = {};
    if (userId) headers['x-user-id'] = userId;

    const res = await fetch('/api/broker/live/market-data/status', { headers });
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn('Failed to fetch market data status:', err);
  }
  return null;
}

/**
 * Phase 8A: Fetches Kite Connect daily login URL from server.
 * The server securely creates the URL using the persistent ZERODHA_API_KEY.
 */
export async function fetchKiteLoginUrl(redirectUrl?: string, userId?: string): Promise<string | null> {
  try {
    const effectiveUserId = userId || (typeof window !== 'undefined' ? (window as any).__FIREBASE_CURRENT_USER_ID__ : undefined);
    const headers: Record<string, string> = {};
    if (effectiveUserId) headers['x-user-id'] = effectiveUserId;

    const defaultRedirect = typeof window !== 'undefined' && window.location?.origin
      ? `${window.location.origin}/api/broker/live/auth/callback`
      : undefined;
    const targetRedirect = redirectUrl || defaultRedirect;

    let url = '/api/broker/live/auth/login';
    if (targetRedirect) {
      url += `?redirect_url=${encodeURIComponent(targetRedirect)}`;
    }

    const res = await fetch(url, { headers });
    if (res.ok) {
      const data = await res.json();
      return data.loginUrl || null;
    }
  } catch (err) {
    console.warn('Failed to fetch Kite login URL:', err);
  }
  return null;
}

/**
 * Phase 8A: Invalidate active runtime session on the server.
 */
export async function disconnectZerodhaSession(userId?: string): Promise<boolean> {
  try {
    const headers: Record<string, string> = {};
    if (userId) headers['x-user-id'] = userId;

    const res = await fetch('/api/broker/live/auth/disconnect', {
      method: 'POST',
      headers,
    });
    return res.ok;
  } catch (err) {
    console.warn('Failed to disconnect Zerodha session:', err);
    return false;
  }
}

