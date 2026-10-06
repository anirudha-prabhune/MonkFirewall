import { doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore';
import { db } from './firebase';
import { BrokerConnection } from '../types/broker';
import { handleFirestoreError, OperationType } from './firestoreErrors';

export async function getBrokerConnection(userId: string): Promise<BrokerConnection | null> {
  const path = `users/${userId}/brokerConnections/primary`;
  try {
    const docRef = doc(db, 'users', userId, 'brokerConnections', 'primary');
    const snapshot = await getDoc(docRef);
    if (snapshot.exists()) {
      return snapshot.data() as BrokerConnection;
    }
    return null;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export function subscribeBrokerConnection(
  userId: string,
  onUpdate: (conn: BrokerConnection | null) => void,
  onError?: (err: Error) => void
): () => void {
  const path = `users/${userId}/brokerConnections/primary`;
  const docRef = doc(db, 'users', userId, 'brokerConnections', 'primary');

  return onSnapshot(
    docRef,
    (snapshot) => {
      if (snapshot.exists()) {
        onUpdate(snapshot.data() as BrokerConnection);
      } else {
        onUpdate(null);
      }
    },
    (error) => {
      if (onError) onError(error);
      handleFirestoreError(error, OperationType.GET, path);
    }
  );
}

export async function setInitialBrokerStatus(userId: string, broker: 'zerodha' | 'mock', status: 'DISCONNECTED' | 'CONNECTED'): Promise<BrokerConnection> {
  const path = `users/${userId}/brokerConnections/primary`;
  try {
    const docRef = doc(db, 'users', userId, 'brokerConnections', 'primary');
    const connectionData: BrokerConnection = {
      broker,
      status,
      userId,
      connectedAt: new Date().toISOString(),
      lastSyncAt: new Date().toISOString(),
    };
    await setDoc(docRef, connectionData, { merge: true });
    return connectionData;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}
