import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth';
import { initializeFirestore, doc, getDocFromServer } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);

// CRITICAL: The app will break without passing firestoreDatabaseId
// Using initializeFirestore with experimentalAutoDetectLongPolling prevents [code=unavailable] in sandboxed/iframe environments
export const db = initializeFirestore(
  app,
  {
    experimentalAutoDetectLongPolling: true,
  },
  firebaseConfig.firestoreDatabaseId
);
export const auth = getAuth(app);

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({
  prompt: 'select_account',
});

export async function signInWithGoogle() {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return result.user;
  } catch (error: any) {
    const errorMsg = error?.message || String(error);
    const isIdentityToolkitDisabled =
      errorMsg.includes('identity-toolkit-api-has-not-been-used') ||
      errorMsg.includes('identitytoolkit.googleapis.com');

    if (!isIdentityToolkitDisabled) {
      console.warn('Google sign-in attempt warning:', errorMsg);
    }
    throw error;
  }
}

export async function logOut() {
  try {
    await signOut(auth);
  } catch (error) {
    console.error('Error signing out:', error);
    throw error;
  }
}

/**
 * Tests connection to Firestore using getDocFromServer per AI Studio Firebase guidelines.
 */
export async function testFirestoreConnection(): Promise<{ success: boolean; message: string }> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return { success: true, message: 'Firestore connection verified' };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes('the client is offline') || errorMsg.includes('unavailable')) {
      console.warn('Firestore connection test: Client is offline or backend is initializing. Please check Firebase configuration.');
      return { success: false, message: 'Client is offline. Please check Firebase configuration.' };
    }
    // Note: If permissions deny or document doesn't exist, it still confirmed server reachability!
    return { success: true, message: 'Firestore server reached successfully' };
  }
}

// Initial connection verification on boot in browser environment per AI Studio guidelines
if (typeof window !== 'undefined') {
  testFirestoreConnection().catch((err) => {
    console.warn('Initial Firestore boot check:', err?.message || err);
  });
}

export default app;
