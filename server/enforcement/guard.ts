import { Request, Response, NextFunction } from 'express';
import { EnforcementService } from './service';

function resolveUserIdFromRequest(req: Request): string | undefined {
  const headerUser = req.headers['x-user-id'] || req.headers['authorization'];
  if (headerUser && typeof headerUser === 'string') {
    const cleaned = headerUser.replace(/^Bearer\s+/, '').trim();
    if (cleaned.length > 0) return cleaned;
  }
  return undefined;
}

/**
 * Express Middleware: requireTradingAccess
 *
 * Enforces server-authoritative Trading Firewall access before executing protected operations.
 * - HTTP 401: Unauthenticated request
 * - HTTP 423: Locked by Trading Firewall circuit breaker
 * - HTTP 500: Fail-closed on authorization errors
 */
export async function requireTradingAccess(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const userId = resolveUserIdFromRequest(req);

  const decision = await EnforcementService.checkTradingAccess(userId);

  if (!decision.allowed) {
    res.status(decision.statusCode).json({
      error: decision.error,
      message: decision.message,
      lockUntil: decision.state?.lockUntil || null,
      riskState: decision.state?.riskState || null,
      authority: 'server',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Attach verified enforcement state to request context
  (req as any).enforcementState = decision.state;
  next();
}
