import { PnlResult } from '../../server/pnl/types';

export async function fetchGrossPnl(userId?: string): Promise<PnlResult | null> {
  try {
    const headers: Record<string, string> = {};
    if (userId) headers['x-user-id'] = userId;

    const res = await fetch('/api/pnl', { headers });
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn('Failed to fetch gross P&L from server:', err);
  }
  return null;
}
