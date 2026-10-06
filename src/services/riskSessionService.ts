import { doc, onSnapshot, getDoc } from 'firebase/firestore';
import { db } from './firebase';
import { RiskSession } from '../types/risk';
import { handleFirestoreError, OperationType } from './firestoreErrors';

/**
 * Client service to read authoritative RiskSession and Lock state.
 *
 * NOTE: The client is READ-ONLY for riskSessions. All writes and mutations
 * are server-authoritative and denied to the client by Firestore security rules.
 */

export async function getAuthoritativeRiskSession(userId: string): Promise<RiskSession> {
  // If in sandbox mode or offline
  if (userId.startsWith('mock-')) {
    try {
      const res = await fetch('/api/risk', {
        headers: { 'x-user-id': userId },
      });
      if (res.ok) {
        return await res.json();
      }
    } catch {
      // Fallback
    }

    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());

    return {
      tradingDate: today,
      userId,
      state: 'ALLOW',
      isBreached: false,
      lockedAt: null,
      lockUntil: null,
      currentPnl: 0,
      realisedPnl: 0,
      unrealisedPnl: 0,
      lossLimit: 10000,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lastEvaluatedAt: new Date().toISOString(),
      reason: 'Sandbox initial session',
    };
  }

  // Fetch via server authoritative API
  try {
    const res = await fetch('/api/risk', {
      headers: { 'x-user-id': userId },
    });
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    console.warn('Could not fetch risk session from server API, falling back to Firestore read:', err);
  }

  // Read from Firestore (Read-Only)
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const path = `users/${userId}/riskSessions/${today}`;
  try {
    const sessionDocRef = doc(db, 'users', userId, 'riskSessions', today);
    const snapshot = await getDoc(sessionDocRef);
    if (snapshot.exists()) {
      return snapshot.data() as RiskSession;
    }
    // Return baseline if no session generated yet today
    return {
      tradingDate: today,
      userId,
      state: 'ALLOW',
      isBreached: false,
      lockedAt: null,
      lockUntil: null,
      currentPnl: 0,
      realisedPnl: 0,
      unrealisedPnl: 0,
      lossLimit: 10000,
      warningThreshold1: 70,
      warningThreshold2: 90,
      lastEvaluatedAt: new Date().toISOString(),
      reason: null,
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export function subscribeRiskSession(
  userId: string,
  onUpdate: (session: RiskSession) => void
): () => void {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  // Poll server API every 3 seconds for live authoritative session updates
  let active = true;
  const poll = async () => {
    if (!active) return;
    try {
      const res = await fetch('/api/risk', {
        headers: { 'x-user-id': userId },
      });
      if (res.ok) {
        const data = await res.json();
        if (active) onUpdate(data);
      }
    } catch {
      // ignore transient poll errors
    }
  };

  poll();
  const interval = setInterval(poll, 3000);

  // Also listen to Firestore document if online and not sandbox
  let unsubFirestore: (() => void) | null = null;
  if (!userId.startsWith('mock-')) {
    try {
      const sessionDocRef = doc(db, 'users', userId, 'riskSessions', today);
      unsubFirestore = onSnapshot(sessionDocRef, (snap) => {
        if (snap.exists() && active) {
          const docData = snap.data() as RiskSession;
          if (docData && (docData.recordedAt || docData.isBreached || docData.state !== 'ALLOW')) {
            onUpdate(docData);
          }
        }
      });
    } catch {
      // ignore
    }
  }

  return () => {
    active = false;
    clearInterval(interval);
    if (unsubFirestore) unsubFirestore();
  };
}
