import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
import { getFirestore, doc, getDocFromServer } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

export const WORKSPACE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
];

const googleProvider = new GoogleAuthProvider();
for (const scope of WORKSPACE_SCOPES) {
  googleProvider.addScope(scope);
}
googleProvider.setCustomParameters({ prompt: 'consent' });

// Strict in-memory caching for OAuth accessToken (NEVER stored in localStorage/sessionStorage)
let isSigningIn = false;
let cachedGmailAccessToken: string | null = null;

export function initWorkspaceAuth(
  onAuthSuccess?: (user: User, token: string | null) => void,
  onAuthClear?: () => void
) {
  return onAuthStateChanged(auth, (user: User | null) => {
    if (user) {
      if (onAuthSuccess) onAuthSuccess(user, cachedGmailAccessToken);
    } else if (!isSigningIn) {
      cachedGmailAccessToken = null;
      if (onAuthClear) onAuthClear();
    }
  });
}

export async function connectGoogleForGmail(): Promise<{
  user: User;
  idToken: string;
  gmailAccessToken: string;
}> {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, googleProvider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Token akses Gmail tidak ditemukan dari sesi Google.');
    }
    cachedGmailAccessToken = credential.accessToken;
    const idToken = await result.user.getIdToken();
    return {
      user: result.user,
      idToken,
      gmailAccessToken: cachedGmailAccessToken,
    };
  } catch (err: any) {
    const code = String(err?.code || '');
    const rawMsg = String(err?.message || '');
    if (
      code === 'auth/unauthorized-domain' ||
      rawMsg.includes('auth/unauthorized-domain')
    ) {
      const host =
        typeof window !== 'undefined' ? window.location.hostname : 'domain ini';
      throw new Error(
        `Domain "${host}" belum diizinkan di Firebase Auth. Tambahkan "${host}" di Firebase Console (Project: ${firebaseConfig.projectId} → Authentication → Settings → Authorized domains), atau login menggunakan Username & Password.`
      );
    }
    if (code === 'auth/popup-closed-by-user') {
      throw new Error('Jendela login Google ditutup sebelum selesai.');
    }
    if (code === 'auth/popup-blocked') {
      throw new Error(
        'Popup login Google diblokir browser. Izinkan popup lalu coba lagi.'
      );
    }
    throw err;
  } finally {
    isSigningIn = false;
  }
}

export function getGmailAccessToken(): string | null {
  return cachedGmailAccessToken;
}

export async function clearGoogleSession() {
  cachedGmailAccessToken = null;
  await auth.signOut();
}

// Mandatory Firestore connectivity check on boot
export async function validateFirestoreConnection(): Promise<boolean> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
      return false;
    }
    return true;
  }
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
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

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}
