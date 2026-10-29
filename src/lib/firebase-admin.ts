import { initializeApp as initAdminApp, getApps as getAdminApps } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { initializeApp as initClientApp, getApps as getClientApps } from 'firebase/app';
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  writeBatch,
} from 'firebase/firestore';
import crypto from 'crypto';
import firebaseConfig from '../../firebase-applet-config.json';

// Firebase Admin Auth for Google ID Token signature verification (uses public Google JWKS, no IAM service account needed)
const adminApp = getAdminApps().length
  ? getAdminApps()[0]
  : initAdminApp({
      projectId: firebaseConfig.projectId,
    });
export const adminAuth = getAdminAuth(adminApp);

// Firebase Firestore connected to the provisioned named database
const clientApp = getClientApps().length
  ? getClientApps()[0]
  : initClientApp(firebaseConfig, 'server-firestore-bridge');
const rawDb = getFirestore(clientApp, firebaseConfig.firestoreDatabaseId);

// Deterministic 256-bit cryptographic server vault key (never exposed to browser or APK)
const VAULT_SEED =
  process.env.SERVER_VAULT_SECRET ||
  `absensi-vault-256bit-${firebaseConfig.projectId}-${firebaseConfig.appId}-v1`;
const SERVER_VAULT_KEY = crypto
  .createHash('sha256')
  .update(VAULT_SEED)
  .digest('hex'); // 64 lowercase hex chars matching `isValidSecretKey` in firestore.rules

function vaultDocRef(colName: string, docId: string) {
  return doc(rawDb, 'server_vault', SERVER_VAULT_KEY, colName, docId);
}

function vaultColRef(colName: string) {
  return collection(rawDb, 'server_vault', SERVER_VAULT_KEY, colName);
}

class DocWrapper {
  constructor(private colName: string, public id: string) {}

  async get() {
    const snap = await getDoc(vaultDocRef(this.colName, this.id));
    return {
      id: snap.id,
      exists: snap.exists(),
      data: () => snap.data(),
    };
  }

  async set(data: Record<string, any>, options?: { merge?: boolean }) {
    if (options?.merge) {
      await setDoc(vaultDocRef(this.colName, this.id), data, { merge: true });
    } else {
      await setDoc(vaultDocRef(this.colName, this.id), data);
    }
  }

  async update(updates: Record<string, any>) {
    await updateDoc(vaultDocRef(this.colName, this.id), updates);
  }

  async delete() {
    await deleteDoc(vaultDocRef(this.colName, this.id));
  }

  rawRef() {
    return vaultDocRef(this.colName, this.id);
  }
}

class QueryWrapper {
  constructor(
    private colName: string,
    private filters: { field: string; op: any; val: any }[] = []
  ) {}

  where(field: string, op: any, val: any) {
    return new QueryWrapper(this.colName, [...this.filters, { field, op, val }]);
  }

  async get() {
    const col = vaultColRef(this.colName);
    const q =
      this.filters.length > 0
        ? query(
            col,
            ...this.filters.map((f) => where(f.field, f.op, f.val))
          )
        : col;
    const snap = await getDocs(q);
    const docs = snap.docs.map((d) => ({
      id: d.id,
      exists: true,
      data: () => d.data(),
    }));
    return {
      docs,
      forEach: (cb: (d: { id: string; data: () => any }) => void) =>
        docs.forEach(cb),
    };
  }
}

class CollectionWrapper extends QueryWrapper {
  constructor(private name: string) {
    super(name, []);
  }

  doc(docId: string) {
    return new DocWrapper(this.name, docId);
  }
}

export const adminDb = {
  collection(colName: string) {
    return new CollectionWrapper(colName);
  },
  batch() {
    const b = writeBatch(rawDb);
    return {
      set(docWrapper: DocWrapper, data: Record<string, any>) {
        b.set(docWrapper.rawRef(), data);
      },
      commit() {
        return b.commit();
      },
    };
  },
};
