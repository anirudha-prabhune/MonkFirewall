import fs from 'fs';
import { initializeApp, getApps, getApp, cert } from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import { CryptoService, EncryptedPayload } from '../../security/crypto';
import firebaseConfig from '../../../firebase-applet-config.json';

/**
 * Phase 8A — Authoritative Zerodha Daily Session Persistence
 *
 * Requirements:
 * - Document path: users/{userId}/brokerConnections/{connectionId}/runtimeSession/current
 * - Server-only document: client Firebase SDK rules deny all read/write/delete.
 * - Stores encryptedToken with AES-256-GCM (IV, ciphertext, tag, keyVersion).
 * - Never stores plaintext access_token, api_secret, or checksum.
 * - sessionVersion is an optimistic concurrency control mechanism.
 * - APPLICATION_SESSION_EXPIRY: Next 06:00:00 AM Asia/Kolkata boundary.
 * - Conditional invalidation: TokenException invalidates ONLY if stored sessionVersion === failedSessionVersion.
 */

export const APPLICATION_SESSION_EXPIRY_HOUR_IST = 6;
export const DEFAULT_CONNECTION_ID = 'zerodha';

export interface EncryptedToken {
  iv: string;
  ciphertext: string;
  tag: string;
  keyVersion: number;
}

export interface PersistedZerodhaSessionDoc {
  provider: 'zerodha';
  userId: string;
  brokerUserId?: string;
  encryptedToken: EncryptedToken;
  authState: 'AUTHENTICATED' | 'AUTHENTICATION_REQUIRED';
  issuedAt: string;
  expiresAt: string;
  tradingDateKolkata: string;
  updatedAt: string;
  sessionVersion: number;
}

export interface DecryptedRuntimeSession {
  accessToken: string;
  sessionVersion: number;
  issuedAt: string;
  expiresAt: string;
  tradingDateKolkata: string;
  brokerUserId?: string;
  authState: 'AUTHENTICATED' | 'AUTHENTICATION_REQUIRED';
  isExpired: boolean;
}

/**
 * Calculates the next 06:00:00 AM Asia/Kolkata boundary for the application session.
 * Asia/Kolkata is UTC+5:30.
 * 06:00:00 AM IST corresponds to 00:30:00 AM UTC.
 */
export function getApplicationSessionExpiry(now: Date = new Date()): {
  expiryUtc: Date;
  tradingDateKolkata: string;
} {
  const KOLKATA_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const kolkataNow = new Date(now.getTime() + KOLKATA_OFFSET_MS);

  const kYear = kolkataNow.getUTCFullYear();
  const kMonth = kolkataNow.getUTCMonth();
  const kDate = kolkataNow.getUTCDate();
  const kHour = kolkataNow.getUTCHours();

  let targetDate = kDate;
  if (kHour >= APPLICATION_SESSION_EXPIRY_HOUR_IST) {
    targetDate = kDate + 1;
  }

  const expiryUtc = new Date(Date.UTC(kYear, kMonth, targetDate, 0, 30, 0, 0));
  const tradingDateKolkata = `${kYear}-${String(kMonth + 1).padStart(2, '0')}-${String(kDate).padStart(2, '0')}`;

  return { expiryUtc, tradingDateKolkata };
}

let cachedAdminDb: Firestore | null = null;
let useMockStoreForTesting = false;

export class SessionPersistenceError extends Error {
  public readonly code = 'SESSION_PERSISTENCE_ERROR';
  constructor(message: string, public readonly cause?: unknown) {
    const formatted = message.startsWith('SESSION_PERSISTENCE_ERROR')
      ? message
      : `SESSION_PERSISTENCE_ERROR: ${message}`;
    super(formatted);
    this.name = 'SessionPersistenceError';
  }
}

// In-memory test store used STRICTLY for unit tests when enableMockStoreForTesting(true) is invoked
const inMemoryTestStore = new Map<string, PersistedZerodhaSessionDoc>();

export function enableMockStoreForTesting(enable = true): void {
  useMockStoreForTesting = enable;
}

export function setAdminFirestoreForTesting(db: Firestore | null): void {
  cachedAdminDb = db;
}

export function clearMockStore(): void {
  inMemoryTestStore.clear();
}

export function getMockStoreEntry(path: string): PersistedZerodhaSessionDoc | undefined {
  return inMemoryTestStore.get(path);
}

function getAdminFirestore(): Firestore | null {
  if (useMockStoreForTesting) {
    return null;
  }
  if (cachedAdminDb) {
    return cachedAdminDb;
  }

  try {
    // Configure server execution identity and project alignment
    if (!process.env.GOOGLE_CLOUD_PROJECT) {
      process.env.GOOGLE_CLOUD_PROJECT = firebaseConfig.projectId;
    }
    if (!process.env.GCLOUD_PROJECT) {
      process.env.GCLOUD_PROJECT = firebaseConfig.projectId;
    }

    if (getApps().length === 0) {
      const appOptions: any = {
        projectId: firebaseConfig.projectId,
      };
      if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
        try {
          const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY.trim();
          if (raw.startsWith('{')) {
            appOptions.credential = cert(JSON.parse(raw));
          } else if (fs.existsSync(raw)) {
            appOptions.credential = cert(JSON.parse(fs.readFileSync(raw, 'utf8')));
          }
        } catch {}
      } else if (
        process.env.GOOGLE_APPLICATION_CREDENTIALS &&
        fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)
      ) {
        try {
          appOptions.credential = cert(
            JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'))
          );
        } catch {}
      }
      if (process.env.AUTHORIZED_SERVICE_ACCOUNT_EMAIL) {
        appOptions.serviceAccountId = process.env.AUTHORIZED_SERVICE_ACCOUNT_EMAIL;
      }
      initializeApp(appOptions);
    }
    const dbId = (firebaseConfig as any).firestoreDatabaseId || '(default)';
    cachedAdminDb = getFirestore(getApp(), dbId);
    return cachedAdminDb;
  } catch (err) {
    // If Admin SDK fails to authenticate, do not throw during getAdminFirestore; saveSession/loadSession will fail closed
    return null;
  }
}

export class ZerodhaSessionStore {
  /**
   * Helper to construct the document path:
   * users/{userId}/brokerConnections/{connectionId}/runtimeSession/current
   */
  public static getSessionDocPath(userId: string, connectionId = DEFAULT_CONNECTION_ID): string {
    return `users/${userId}/brokerConnections/${connectionId}/runtimeSession/current`;
  }

  /**
   * Saves a newly authenticated Zerodha session to Firestore.
   *
   * Responsibilities:
   * - Encrypts the access_token with AES-256-GCM.
   * - Increments sessionVersion atomically (optimistic concurrency control).
   * - Sets authState = 'AUTHENTICATED'.
   * - Sets expiresAt = next 06:00:00 AM IST (APPLICATION_SESSION_EXPIRY).
   * - Sets tradingDateKolkata.
   * - NEVER stores plaintext access_token or secrets.
   */
  public static async saveSession(
    userId: string,
    accessToken: string,
    options: {
      brokerUserId?: string;
      connectionId?: string;
      evaluationTime?: Date;
    } = {}
  ): Promise<{
    sessionVersion: number;
    expiresAt: string;
    tradingDateKolkata: string;
  }> {
    if (!userId || !userId.trim()) {
      throw new Error('ZerodhaSessionStore: userId is required.');
    }
    if (!accessToken || !accessToken.trim()) {
      throw new Error('ZerodhaSessionStore: accessToken is required.');
    }

    const connectionId = options.connectionId || DEFAULT_CONNECTION_ID;
    const now = options.evaluationTime || new Date();
    const { expiryUtc, tradingDateKolkata } = getApplicationSessionExpiry(now);

    // Encrypt the access_token with AAD binding ${userId}:zerodha:1
    const encrypted: EncryptedPayload = CryptoService.encrypt(accessToken.trim(), userId.trim());

    const docPath = this.getSessionDocPath(userId, connectionId);

    if (!useMockStoreForTesting) {
      const db = getAdminFirestore();
      if (!db) {
        throw new SessionPersistenceError('Authoritative Firestore instance is unavailable or unconfigured.');
      }

      try {
        const docRef = db.doc(docPath);
        const result = await db.runTransaction(async (tx) => {
          const snap = await tx.get(docRef);
          let sessionVersion = 1;
          if (snap.exists) {
            const data = snap.data() as PersistedZerodhaSessionDoc;
            if (typeof data.sessionVersion === 'number' && Number.isInteger(data.sessionVersion)) {
              sessionVersion = data.sessionVersion + 1;
            }
          }

          const docData: PersistedZerodhaSessionDoc = {
            provider: 'zerodha',
            userId: userId.trim(),
            ...(options.brokerUserId ? { brokerUserId: options.brokerUserId.trim() } : {}),
            encryptedToken: {
              iv: encrypted.iv,
              ciphertext: encrypted.ciphertext,
              tag: encrypted.tag,
              keyVersion: encrypted.keyVersion,
            },
            authState: 'AUTHENTICATED',
            issuedAt: now.toISOString(),
            expiresAt: expiryUtc.toISOString(),
            tradingDateKolkata,
            updatedAt: now.toISOString(),
            sessionVersion,
          };

          tx.set(docRef, docData);
          return { sessionVersion, expiresAt: docData.expiresAt, tradingDateKolkata };
        });

        return result;
      } catch (err: any) {
        // FAIL-CLOSED: A production Firestore write failure must surface as a persistence error,
        // NEVER as successful authentication and NEVER silently falling back to RAM!
        throw new SessionPersistenceError(
          `Failed to persist session to authoritative Firestore store at ${docPath}: ${err?.message || String(err)}`,
          err
        );
      }
    }

    // Mock store path (STRICTLY when enableMockStoreForTesting(true) is explicitly invoked by unit tests)
    const existing = inMemoryTestStore.get(docPath);
    let sessionVersion = 1;
    if (existing && typeof existing.sessionVersion === 'number') {
      sessionVersion = existing.sessionVersion + 1;
    }

    const docData: PersistedZerodhaSessionDoc = {
      provider: 'zerodha',
      userId: userId.trim(),
      ...(options.brokerUserId ? { brokerUserId: options.brokerUserId.trim() } : {}),
      encryptedToken: {
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext,
        tag: encrypted.tag,
        keyVersion: encrypted.keyVersion,
      },
      authState: 'AUTHENTICATED',
      issuedAt: now.toISOString(),
      expiresAt: expiryUtc.toISOString(),
      tradingDateKolkata,
      updatedAt: now.toISOString(),
      sessionVersion,
    };

    inMemoryTestStore.set(docPath, docData);
    return {
      sessionVersion,
      expiresAt: docData.expiresAt,
      tradingDateKolkata,
    };
  }

  /**
   * Loads and decrypts the current runtime session from Firestore.
   *
   * Responsibilities:
   * - Reads users/{userId}/brokerConnections/{connectionId}/runtimeSession/current.
   * - Checks authState === 'AUTHENTICATED'.
   * - Checks application expiry boundary (06:00:00 AM IST). If expired, transitions to AUTHENTICATION_REQUIRED.
   * - Decrypts ciphertext with CryptoService.
   * - Returns decrypted access_token with sessionVersion.
   * - Never returns ciphertext, keys, or raw Firestore docs to callers.
   */
  public static async loadSession(
    userId: string,
    options: {
      connectionId?: string;
      evaluationTime?: Date;
    } = {}
  ): Promise<DecryptedRuntimeSession | null> {
    if (!userId || !userId.trim()) {
      return null;
    }

    const connectionId = options.connectionId || DEFAULT_CONNECTION_ID;
    const now = options.evaluationTime || new Date();
    const docPath = this.getSessionDocPath(userId, connectionId);

    let docData: PersistedZerodhaSessionDoc | null = null;

    if (!useMockStoreForTesting) {
      const db = getAdminFirestore();
      if (!db) {
        return null;
      }
      try {
        const snap = await db.doc(docPath).get();
        if (snap.exists) {
          docData = snap.data() as PersistedZerodhaSessionDoc;
        }
      } catch {
        // In production, if Firestore read fails, fail closed (never consult inMemoryTestStore)
        return null;
      }
    } else {
      docData = inMemoryTestStore.get(docPath) || null;
    }

    if (!docData) {
      return null;
    }

    // Check authState
    if (docData.authState !== 'AUTHENTICATED') {
      return {
        accessToken: '',
        sessionVersion: docData.sessionVersion,
        issuedAt: docData.issuedAt,
        expiresAt: docData.expiresAt,
        tradingDateKolkata: docData.tradingDateKolkata,
        brokerUserId: docData.brokerUserId,
        authState: docData.authState,
        isExpired: false,
      };
    }

    // Check application session expiry (next 06:00:00 AM IST)
    const expiresAtDate = new Date(docData.expiresAt);
    if (isNaN(expiresAtDate.getTime()) || now.getTime() >= expiresAtDate.getTime()) {
      // Session has expired: transition to AUTHENTICATION_REQUIRED
      await this.invalidateSession(userId, docData.sessionVersion, connectionId);

      return {
        accessToken: '',
        sessionVersion: docData.sessionVersion,
        issuedAt: docData.issuedAt,
        expiresAt: docData.expiresAt,
        tradingDateKolkata: docData.tradingDateKolkata,
        brokerUserId: docData.brokerUserId,
        authState: 'AUTHENTICATION_REQUIRED',
        isExpired: true,
      };
    }

    // Decrypt the access_token
    try {
      const accessToken = CryptoService.decrypt(docData.encryptedToken, userId.trim());
      return {
        accessToken,
        sessionVersion: docData.sessionVersion,
        issuedAt: docData.issuedAt,
        expiresAt: docData.expiresAt,
        tradingDateKolkata: docData.tradingDateKolkata,
        brokerUserId: docData.brokerUserId,
        authState: 'AUTHENTICATED',
        isExpired: false,
      };
    } catch (decryptErr) {
      // If decryption fails (e.g. key tampered or invalid keyVersion): fail closed
      await this.invalidateSession(userId, docData.sessionVersion, connectionId);
      return null;
    }
  }

  /**
   * Concurrency-Guarded Invalidation:
   *
   * If failedSessionVersion is provided:
   * - Atomically checks if stored sessionVersion === failedSessionVersion.
   * - If equal: invalidates the session (sets authState = 'AUTHENTICATION_REQUIRED').
   * - If not equal (a newer session was created by another Cloud Run instance or OAuth login):
   *   PRESERVES the newer session without modifying Firestore!
   *
   * If failedSessionVersion is undefined (explicit user disconnect/logout):
   * - Invalidates unconditionally.
   */
  public static async invalidateSession(
    userId: string,
    failedSessionVersion?: number,
    connectionId = DEFAULT_CONNECTION_ID
  ): Promise<{
    invalidated: boolean;
    currentVersion?: number;
    preservedNewerVersion?: number;
  }> {
    if (!userId || !userId.trim()) {
      return { invalidated: false };
    }

    const docPath = this.getSessionDocPath(userId, connectionId);
    const db = getAdminFirestore();
    const now = new Date().toISOString();

    if (!useMockStoreForTesting) {
      const db = getAdminFirestore();
      if (!db) {
        return { invalidated: false };
      }
      try {
        const docRef = db.doc(docPath);
        const result = await db.runTransaction(async (tx) => {
          const snap = await tx.get(docRef);
          if (!snap.exists) {
            return { invalidated: false };
          }

          const current = snap.data() as PersistedZerodhaSessionDoc;
          const currentVersion = current.sessionVersion;

          // Optimistic Concurrency Guard:
          // If a failedSessionVersion is specified and differs from current, preserve the newer session!
          if (failedSessionVersion !== undefined && currentVersion !== failedSessionVersion) {
            return {
              invalidated: false,
              currentVersion,
              preservedNewerVersion: currentVersion,
            };
          }

          tx.update(docRef, {
            authState: 'AUTHENTICATION_REQUIRED',
            encryptedToken: {
              iv: '',
              ciphertext: '',
              tag: '',
              keyVersion: 0,
            },
            updatedAt: now,
          });

          return { invalidated: true, currentVersion };
        });

        return result;
      } catch {
        return { invalidated: false };
      }
    }

    // Mock store path (STRICTLY when enableMockStoreForTesting(true) is invoked)
    const memCurrent = inMemoryTestStore.get(docPath);
    if (!memCurrent) {
      return { invalidated: false };
    }

    const currentVersion = memCurrent.sessionVersion;

    if (failedSessionVersion !== undefined && currentVersion !== failedSessionVersion) {
      return {
        invalidated: false,
        currentVersion,
        preservedNewerVersion: currentVersion,
      };
    }

    memCurrent.authState = 'AUTHENTICATION_REQUIRED';
    memCurrent.encryptedToken = {
      iv: '',
      ciphertext: '',
      tag: '',
      keyVersion: 0,
    };
    memCurrent.updatedAt = now;
    return { invalidated: true, currentVersion };
  }
}
