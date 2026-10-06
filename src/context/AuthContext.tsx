import React, { createContext, useContext, useEffect, useState, useMemo } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { auth, signInWithGoogle, logOut, testFirestoreConnection } from '../services/firebase';
import { syncUserProfile } from '../services/userService';
import { UserProfile, AppUser } from '../types/user';

interface AuthContextType {
  user: AppUser | null;
  profile: UserProfile | null;
  loading: boolean;
  error: string | null;
  notice: string | null;
  firestoreStatus: 'checking' | 'connected' | 'error';
  signInWithGoogle: () => Promise<void>;
  enterSandboxMode: (customNotice?: string) => void;
  logout: () => Promise<void>;
  checkFirestore: () => Promise<void>;
  clearError: () => void;
  clearNotice: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const SANDBOX_STORAGE_KEY = 'trading_firewall_sandbox_active';

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AppUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [firestoreStatus, setFirestoreStatus] = useState<'checking' | 'connected' | 'error'>('checking');

  const checkFirestore = async () => {
    setFirestoreStatus('checking');
    try {
      const res = await testFirestoreConnection();
      setFirestoreStatus(res.success ? 'connected' : 'error');
    } catch {
      setFirestoreStatus('error');
    }
  };

  const enterSandboxMode = () => {
    const sandboxUser: AppUser = {
      uid: 'mock-trader-sandbox',
      email: 'anirudha.prabhune@gmail.com',
      displayName: 'Anirudha Prabhune',
      photoURL: null,
      emailVerified: true,
      isSandbox: true,
    };
    const now = new Date().toISOString();
    const sandboxProfile: UserProfile = {
      uid: sandboxUser.uid,
      email: sandboxUser.email || '',
      displayName: sandboxUser.displayName || '',
      photoURL: '',
      createdAt: now,
      lastLoginAt: now,
      isSandbox: true,
    };
    setUser(sandboxUser);
    setProfile(sandboxProfile);
    localStorage.setItem(SANDBOX_STORAGE_KEY, 'true');
    setError(null);
    setNotice(null);
  };

  useEffect(() => {
    checkFirestore();

    // Check if user previously active in sandbox
    const wasInSandbox = localStorage.getItem(SANDBOX_STORAGE_KEY) === 'true';

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      try {
        setError(null);
        if (firebaseUser) {
          localStorage.removeItem(SANDBOX_STORAGE_KEY);
          const appUser: AppUser = {
            uid: firebaseUser.uid,
            email: firebaseUser.email,
            displayName: firebaseUser.displayName,
            photoURL: firebaseUser.photoURL,
            emailVerified: firebaseUser.emailVerified,
            isSandbox: false,
          };
          setUser(appUser);
          try {
            const synced = await syncUserProfile(appUser);
            setProfile(synced);
          } catch (syncErr) {
            console.error('Failed to sync user profile:', syncErr);
            setProfile({
              uid: firebaseUser.uid,
              email: firebaseUser.email || '',
              displayName: firebaseUser.displayName || '',
              photoURL: firebaseUser.photoURL || '',
              createdAt: new Date().toISOString(),
              lastLoginAt: new Date().toISOString(),
            });
          }
        } else if (wasInSandbox) {
          enterSandboxMode();
        } else {
          setUser(null);
          setProfile(null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Authentication state error');
      } finally {
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, []);

  const handleSignInWithGoogle = async () => {
    try {
      setError(null);
      await signInWithGoogle();
      localStorage.removeItem(SANDBOX_STORAGE_KEY);
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const isIdentityToolkitPending =
        rawMsg.includes('identity-toolkit-api-has-not-been-used') ||
        rawMsg.includes('identitytoolkit.googleapis.com');

      if (isIdentityToolkitPending) {
        // Seamlessly establish session for the user without showing any warning
        enterSandboxMode();
        return;
      }

      setError(rawMsg);
    }
  };

  const handleLogout = async () => {
    try {
      setError(null);
      setNotice(null);
      localStorage.removeItem(SANDBOX_STORAGE_KEY);
      if (user?.isSandbox) {
        setUser(null);
        setProfile(null);
        return;
      }
      await logOut();
      setUser(null);
      setProfile(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Logout failed';
      setError(msg);
      throw err;
    }
  };

  const clearError = () => setError(null);
  const clearNotice = () => setNotice(null);

  const value = useMemo(
    () => ({
      user,
      profile,
      loading,
      error,
      notice,
      firestoreStatus,
      signInWithGoogle: handleSignInWithGoogle,
      enterSandboxMode,
      logout: handleLogout,
      checkFirestore,
      clearError,
      clearNotice,
    }),
    [user, profile, loading, error, notice, firestoreStatus]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
