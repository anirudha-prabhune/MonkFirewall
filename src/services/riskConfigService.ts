import { doc, getDoc, setDoc, onSnapshot, collection, addDoc } from 'firebase/firestore';
import { db } from './firebase';
import { RiskConfig, DEFAULT_RISK_CONFIG } from '../types/risk';
import { handleFirestoreError, OperationType } from './firestoreErrors';
import { validateRiskConfig } from '../../server/risk/validation';

const LOCAL_STORAGE_KEY_PREFIX = 'trading_firewall_risk_config_';

export async function getRiskConfig(userId: string): Promise<RiskConfig> {
  if (userId.startsWith('mock-')) {
    const raw = localStorage.getItem(`${LOCAL_STORAGE_KEY_PREFIX}${userId}`);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const val = validateRiskConfig(parsed);
        if (val.valid && val.sanitized) return val.sanitized;
      } catch {
        // fallback
      }
    }
    const initialConfig: RiskConfig = {
      ...DEFAULT_RISK_CONFIG,
      updatedAt: new Date().toISOString(),
    };
    localStorage.setItem(`${LOCAL_STORAGE_KEY_PREFIX}${userId}`, JSON.stringify(initialConfig));
    return initialConfig;
  }

  const path = `users/${userId}/riskConfig/config`;
  try {
    const configDocRef = doc(db, 'users', userId, 'riskConfig', 'config');
    const snapshot = await getDoc(configDocRef);

    if (snapshot.exists()) {
      const data = snapshot.data() as RiskConfig;
      const validation = validateRiskConfig(data);
      if (validation.valid && validation.sanitized) {
        return validation.sanitized;
      }
    }

    // Seed default configuration if none exists
    const initialConfig: RiskConfig = {
      ...DEFAULT_RISK_CONFIG,
      updatedAt: new Date().toISOString(),
    };
    await setDoc(configDocRef, initialConfig);
    return initialConfig;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export async function saveRiskConfig(
  userId: string,
  newConfig: Partial<RiskConfig>
): Promise<RiskConfig> {
  const current = await getRiskConfig(userId);
  const combined = {
    ...current,
    ...newConfig,
  };

  // Enforce server-side validation rules
  const validation = validateRiskConfig(combined);
  if (!validation.valid || !validation.sanitized) {
    throw new Error(validation.errors.join(', '));
  }

  const sanitized = validation.sanitized;

  // Also sync to server API
  try {
    await fetch('/api/risk/config', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userId,
      },
      body: JSON.stringify(sanitized),
    });
  } catch {
    // Non-fatal
  }

  if (userId.startsWith('mock-')) {
    localStorage.setItem(`${LOCAL_STORAGE_KEY_PREFIX}${userId}`, JSON.stringify(sanitized));
    window.dispatchEvent(new CustomEvent('sandbox-risk-config-updated', { detail: sanitized }));
    return sanitized;
  }

  const path = `users/${userId}/riskConfig/config`;
  try {
    const configDocRef = doc(db, 'users', userId, 'riskConfig', 'config');
    await setDoc(configDocRef, sanitized);

    // Record audit event
    try {
      await addDoc(collection(db, 'users', userId, 'riskEvents'), {
        userId,
        type: 'CONFIG_UPDATED',
        message: `Risk config updated: Daily Loss Limit ₹${sanitized.dailyLossLimit.toLocaleString(
          'en-IN'
        )}, Warning 1: ${sanitized.warningThreshold1}%, Warning 2: ${
          sanitized.warningThreshold2
        }%, Lock: ${sanitized.lockDurationMinutes}m, Enabled: ${sanitized.enabled}`,
        timestamp: new Date().toISOString(),
      });
    } catch (auditErr) {
      console.warn('Non-fatal: could not log risk event audit:', auditErr);
    }

    return sanitized;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export function subscribeRiskConfig(
  userId: string,
  onUpdate: (config: RiskConfig) => void,
  onError?: (err: Error) => void
): () => void {
  if (userId.startsWith('mock-')) {
    getRiskConfig(userId).then(onUpdate);
    const listener = (e: Event) => {
      const detail = (e as CustomEvent).detail as RiskConfig;
      if (detail) onUpdate(detail);
    };
    window.addEventListener('sandbox-risk-config-updated', listener);
    return () => window.removeEventListener('sandbox-risk-config-updated', listener);
  }

  const path = `users/${userId}/riskConfig/config`;
  const configDocRef = doc(db, 'users', userId, 'riskConfig', 'config');

  return onSnapshot(
    configDocRef,
    (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data() as RiskConfig;
        const val = validateRiskConfig(data);
        if (val.valid && val.sanitized) {
          onUpdate(val.sanitized);
        } else {
          onUpdate(DEFAULT_RISK_CONFIG);
        }
      } else {
        onUpdate(DEFAULT_RISK_CONFIG);
      }
    },
    (error) => {
      if (onError) {
        onError(error);
      }
      handleFirestoreError(error, OperationType.GET, path);
    }
  );
}
