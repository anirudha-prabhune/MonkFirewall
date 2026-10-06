import { RiskConfig, DEFAULT_RISK_CONFIG } from '../../src/types/risk';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  sanitized?: RiskConfig;
}

/**
 * Deterministic Server-side Risk Configuration Validator (Phase 2).
 *
 * Enforces all 14 mandatory constraints:
 * 1. dailyLossLimit > 0 (finite, not NaN, not negative, not 0)
 * 2. warningThreshold1 > 0 (finite, not NaN, not negative, not 0)
 * 3. warningThreshold2 > warningThreshold1
 * 4. warningThreshold2 <= 100
 * 5. warningThreshold1 < 100
 * 6. lockDurationMinutes > 0 (finite, integer/number, not 0, not negative)
 * 7. Boolean fields (includeRealisedPnl, includeUnrealisedPnl, enabled) must be actual booleans
 * 8. Strips/rejects unexpected fields (state, isBreached, lockedAt, lockUntil, timestamps)
 * 9. Rejects NaN, Infinity, null, and non-numeric numbers
 * 10. Monetary values handled safely and deterministically
 * 11. Prevents negative daily loss limits
 * 12. Prevents zero-minute locks
 * 13. Prevents nonsensical threshold ordering
 * 14. Forbids client from directly manufacturing risk state or timestamps
 */
export function validateRiskConfig(input: any): ValidationResult {
  const errors: string[] = [];

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['Configuration payload must be an object'] };
  }

  // Check for forbidden server-authoritative fields in client payload
  const forbiddenFields = [
    'state',
    'isBreached',
    'lockedAt',
    'lockUntil',
    'lockExpiresAt',
    'breachReason',
    'reason',
    'currentPnl',
    'lossUtilizedPercent',
    'tradingDate',
    'lastEvaluatedAt',
  ];

  for (const field of forbiddenFields) {
    if (field in input) {
      errors.push(`Client cannot supply server-authoritative field: '${field}'`);
    }
  }

  // 1. dailyLossLimit: minimum ₹500, increments of ₹500, no negative, no ₹0
  const rawLimit = input.dailyLossLimit;
  if (rawLimit === undefined || rawLimit === null) {
    errors.push('dailyLossLimit is required');
  } else if (typeof rawLimit !== 'number' || isNaN(rawLimit) || !isFinite(rawLimit)) {
    errors.push('dailyLossLimit must be a finite valid number');
  } else if (rawLimit <= 0) {
    errors.push('dailyLossLimit must be greater than 0 (minimum ₹500, ₹0 is not allowed)');
  } else if (rawLimit < 500) {
    errors.push('dailyLossLimit must be at least ₹500');
  } else if (rawLimit % 500 !== 0) {
    errors.push('dailyLossLimit must be in increments of ₹500');
  }

  // 2. warningThreshold1
  const rawT1 = input.warningThreshold1;
  if (rawT1 === undefined || rawT1 === null) {
    errors.push('warningThreshold1 is required');
  } else if (typeof rawT1 !== 'number' || isNaN(rawT1) || !isFinite(rawT1)) {
    errors.push('warningThreshold1 must be a finite valid percentage number');
  } else if (rawT1 <= 0) {
    errors.push('warningThreshold1 must be greater than 0%');
  } else if (rawT1 >= 100) {
    errors.push('warningThreshold1 must be strictly less than 100%');
  }

  // 3. warningThreshold2
  const rawT2 = input.warningThreshold2;
  if (rawT2 === undefined || rawT2 === null) {
    errors.push('warningThreshold2 is required');
  } else if (typeof rawT2 !== 'number' || isNaN(rawT2) || !isFinite(rawT2)) {
    errors.push('warningThreshold2 must be a finite valid percentage number');
  } else if (rawT2 <= 0) {
    errors.push('warningThreshold2 must be greater than 0%');
  } else if (rawT2 > 100) {
    errors.push('warningThreshold2 cannot exceed 100%');
  }

  // Ordering check: warningThreshold2 must be greater than warningThreshold1
  if (typeof rawT1 === 'number' && typeof rawT2 === 'number' && !isNaN(rawT1) && !isNaN(rawT2)) {
    if (rawT2 <= rawT1) {
      errors.push(`warningThreshold2 (${rawT2}%) must be strictly greater than warningThreshold1 (${rawT1}%)`);
    }
  }

  // 4. lockDurationType & lockDurationMinutes
  const rawDurationType = input.lockDurationType;
  if (rawDurationType !== undefined && rawDurationType !== 'FIXED' && rawDurationType !== 'UNTIL_4PM') {
    errors.push("lockDurationType must be either 'FIXED' or 'UNTIL_4PM'");
  }

  const isUntil4PM = rawDurationType === 'UNTIL_4PM';
  const rawDuration = input.lockDurationMinutes;

  if (isUntil4PM) {
    // For Until 4:00 PM, duration in minutes is optional (calculated dynamically to 16:00 IST on trading date)
    if (rawDuration !== undefined && rawDuration !== null) {
      if (typeof rawDuration !== 'number' || isNaN(rawDuration) || !isFinite(rawDuration)) {
        errors.push('lockDurationMinutes must be a finite number if supplied');
      }
    }
  } else {
    // For Fixed Duration (default): minimum 60 minutes, increments of 60 minutes
    if (rawDuration === undefined || rawDuration === null) {
      errors.push('lockDurationMinutes is required for Fixed Duration');
    } else if (typeof rawDuration !== 'number' || isNaN(rawDuration) || !isFinite(rawDuration)) {
      errors.push('lockDurationMinutes must be a finite valid number');
    } else if (rawDuration <= 0) {
      errors.push('lockDurationMinutes must be greater than 0 (minimum 60 minutes)');
    } else if (rawDuration < 60) {
      errors.push('lockDurationMinutes must be at least 60 minutes');
    } else if (rawDuration % 60 !== 0) {
      errors.push('lockDurationMinutes must be in increments of 60 minutes');
    }
  }

  // 5. Booleans
  const rawRealised = input.includeRealisedPnl;
  if (rawRealised !== undefined && typeof rawRealised !== 'boolean') {
    errors.push('includeRealisedPnl must be a boolean (true or false)');
  }

  const rawUnrealised = input.includeUnrealisedPnl;
  if (rawUnrealised !== undefined && typeof rawUnrealised !== 'boolean') {
    errors.push('includeUnrealisedPnl must be a boolean (true or false)');
  }

  const rawEnabled = input.enabled;
  if (rawEnabled !== undefined && typeof rawEnabled !== 'boolean') {
    errors.push('enabled must be a boolean (true or false)');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Construct pristine sanitized RiskConfig stripping any extraneous keys
  const sanitized: RiskConfig = {
    dailyLossLimit: Math.round(Number(rawLimit) * 100) / 100, // Round to 2 decimal places for INR
    warningThreshold1: Math.round(Number(rawT1) * 100) / 100,
    warningThreshold2: Math.round(Number(rawT2) * 100) / 100,
    lockDurationMinutes: typeof rawDuration === 'number' && !isNaN(rawDuration) ? Math.round(Number(rawDuration)) : 720,
    lockDurationType: isUntil4PM ? 'UNTIL_4PM' : 'FIXED',
    includeRealisedPnl: typeof rawRealised === 'boolean' ? rawRealised : true,
    includeUnrealisedPnl: typeof rawUnrealised === 'boolean' ? rawUnrealised : true,
    enabled: typeof rawEnabled === 'boolean' ? rawEnabled : true,
    updatedAt: new Date().toISOString(),
  };

  return { valid: true, errors: [], sanitized };
}
