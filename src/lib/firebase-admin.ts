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
  runTransaction,
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

export enum ServerOperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface ServerFirestoreErrorInfo {
  error: string;
  operationType: ServerOperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

function handleServerFirestoreError(
  error: unknown,
  operationType: ServerOperationType,
  sanitizedPath: string | null
): never {
  const errInfo: ServerFirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    operationType,
    path: sanitizedPath,
    authInfo: {
      userId: 'server-vault',
      email: null,
      emailVerified: null,
      isAnonymous: false,
      tenantId: null,
      providerInfo: [],
    },
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

function vaultDocRef(colName: string, docId: string) {
  return doc(rawDb, 'server_vault', SERVER_VAULT_KEY, colName, docId);
}

function vaultColRef(colName: string) {
  return collection(rawDb, 'server_vault', SERVER_VAULT_KEY, colName);
}

class DocWrapper {
  constructor(private colName: string, public id: string) {}

  private sanitizedPath() {
    return `${this.colName}/${this.id}`;
  }

  async get() {
    try {
      const snap = await getDoc(vaultDocRef(this.colName, this.id));
      return {
        id: snap.id,
        exists: snap.exists(),
        data: () => snap.data(),
      };
    } catch (error) {
      handleServerFirestoreError(error, ServerOperationType.GET, this.sanitizedPath());
    }
  }

  /**
   * Atomically creates the document ONLY if it does not already exist.
   * Prevents concurrent requests or multi-instance cold starts from racing and
   * triggering an unauthorized `update` on immutable fields (`createdAtIso`).
   */
  async createIfAbsent(data: Record<string, any>): Promise<boolean> {
    const ref = vaultDocRef(this.colName, this.id);
    try {
      return await runTransaction(rawDb, async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists()) {
          return false;
        }
        tx.set(ref, data);
        return true;
      });
    } catch (error) {
      // If another concurrent transaction created the document simultaneously, confirm existence
      try {
        const check = await getDoc(ref);
        if (check.exists()) {
          return false;
        }
      } catch {
        // fall through to structured error
      }
      handleServerFirestoreError(error, ServerOperationType.CREATE, this.sanitizedPath());
    }
  }

  async set(data: Record<string, any>, options?: { merge?: boolean }) {
    try {
      if (options?.merge) {
        await setDoc(vaultDocRef(this.colName, this.id), data, { merge: true });
      } else {
        await setDoc(vaultDocRef(this.colName, this.id), data);
      }
    } catch (error) {
      handleServerFirestoreError(error, ServerOperationType.WRITE, this.sanitizedPath());
    }
  }

  async update(updates: Record<string, any>) {
    try {
      await updateDoc(vaultDocRef(this.colName, this.id), updates);
    } catch (error) {
      handleServerFirestoreError(error, ServerOperationType.UPDATE, this.sanitizedPath());
    }
  }

  async delete() {
    try {
      await deleteDoc(vaultDocRef(this.colName, this.id));
    } catch (error) {
      handleServerFirestoreError(error, ServerOperationType.DELETE, this.sanitizedPath());
    }
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
    try {
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
    } catch (error) {
      handleServerFirestoreError(error, ServerOperationType.LIST, this.colName);
    }
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
    const paths: string[] = [];
    return {
      set(docWrapper: DocWrapper, data: Record<string, any>) {
        paths.push(`${docWrapper.id}`);
        b.set(docWrapper.rawRef(), data);
      },
      async commit() {
        try {
          await b.commit();
        } catch (error) {
          handleServerFirestoreError(
            error,
            ServerOperationType.WRITE,
            paths.join(',') || 'batch'
          );
        }
      },
    };
  },
};
