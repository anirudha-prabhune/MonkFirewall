import { EnforcementState, ProtectedTradingResponse } from '../../server/enforcement/types';

export async function fetchEnforcementStatus(userId?: string): Promise<EnforcementState | null> {
  try {
    const headers: Record<string, string> = {};
    if (userId) headers['x-user-id'] = userId;

    const res = await fetch('/api/enforcement/status', { headers });
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn('Failed to fetch enforcement status:', err);
  }
  return null;
}

export async function callProtectedTradingEndpoint(userId?: string): Promise<{
  success: boolean;
  statusCode: number;
  data?: ProtectedTradingResponse;
  error?: string;
}> {
  try {
    const headers: Record<string, string> = {};
    if (userId) headers['x-user-id'] = userId;

    const res = await fetch('/api/protected/trading', { headers });
    const data = await res.json();

    return {
      success: res.ok,
      statusCode: res.status,
      data: res.ok ? data : undefined,
      error: !res.ok ? data.message || data.error : undefined,
    };
  } catch (err) {
    return {
      success: false,
      statusCode: 500,
      error: err instanceof Error ? err.message : 'Network request failed',
    };
  }
}
