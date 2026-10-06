import { LivePnlValidationResult } from '../../server/pnl/liveValidationTypes';

export async function fetchLivePnlValidation(
  userId?: string
): Promise<LivePnlValidationResult | null> {
  try {
    const headers: Record<string, string> = {};
    if (userId) headers['x-user-id'] = userId;

    const res = await fetch('/api/pnl/live-validation', { headers });
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn('Failed to fetch live P&L validation:', err);
  }
  return null;
}
