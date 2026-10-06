/**
 * Server-side authentication and session token verification.
 * In Phase 1, verifies presence of Bearer auth tokens.
 */
export interface AuthSession {
  userId: string;
  email?: string;
  verified: boolean;
}

export function parseBearerToken(authHeader?: string): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.substring(7).trim();
}
