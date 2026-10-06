import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from './firebase';
import { UserProfile, AppUser } from '../types/user';
import { handleFirestoreError, OperationType } from './firestoreErrors';

export async function syncUserProfile(user: AppUser | { uid: string; email?: string | null; displayName?: string | null; photoURL?: string | null }): Promise<UserProfile> {
  const now = new Date().toISOString();

  if (user.uid.startsWith('mock-')) {
    return {
      uid: user.uid,
      email: user.email || 'anirudha.prabhune@gmail.com',
      displayName: user.displayName || 'Sandbox Trader',
      photoURL: user.photoURL || '',
      createdAt: now,
      lastLoginAt: now,
      isSandbox: true,
    };
  }

  const path = `users/${user.uid}`;
  try {
    const userDocRef = doc(db, 'users', user.uid);
    const snapshot = await getDoc(userDocRef);
    let profileData: UserProfile;

    if (snapshot.exists()) {
      const existing = snapshot.data() as UserProfile;
      profileData = {
        uid: user.uid,
        email: user.email || '',
        displayName: user.displayName || existing.displayName || '',
        photoURL: user.photoURL || existing.photoURL || '',
        createdAt: existing.createdAt || now,
        lastLoginAt: now,
      };
      await setDoc(userDocRef, profileData, { merge: true });
    } else {
      profileData = {
        uid: user.uid,
        email: user.email || '',
        displayName: user.displayName || '',
        photoURL: user.photoURL || '',
        createdAt: now,
        lastLoginAt: now,
      };
      await setDoc(userDocRef, profileData);
    }

    return profileData;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  if (userId.startsWith('mock-')) {
    return {
      uid: userId,
      email: 'anirudha.prabhune@gmail.com',
      displayName: 'Sandbox Trader',
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
      isSandbox: true,
    };
  }

  const path = `users/${userId}`;
  try {
    const userDocRef = doc(db, 'users', userId);
    const snapshot = await getDoc(userDocRef);
    if (snapshot.exists()) {
      return snapshot.data() as UserProfile;
    }
    return null;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}
