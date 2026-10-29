import 'dotenv/config';
import http from 'http';
import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { adminAuth, adminDb } from './src/lib/firebase-admin.ts';
import {
  buildScheduledWibIso,
  calculateGeodesicDistanceMeters,
  cosineSimilarity,
  getWibParts,
  parseHhMmToMinutes,
  resolveWorkDateWib,
  formatWibDateTime,
} from './src/utils/geoAndTime.ts';
import { buildDailyAttendanceEntries } from './src/utils/attendanceSyncView.ts';
import {
  buildAttendanceExcelBuffer,
  computeSummaryRows,
} from './src/services/excelReportBuilder.ts';
import type {
  AppealScope,
  AttendanceAppeal,
  AttendanceRecord,
  AuditLogRecord,
  EmployeeProfile,
  OfficeSettings,
  UserRole,
} from './src/types/attendance.ts';

const PORT = 3000;
const JWT_SECRET =
  process.env.JWT_SECRET || 'absensi-wajah-gps-jwt-secret-key-2026-secure';
const RAW_ENV_ADMIN_USERNAME = String(process.env.DEFAULT_ADMIN_USERNAME || '').trim();
const NORMALIZED_ENV_ADMIN_USERNAME = RAW_ENV_ADMIN_USERNAME.toLowerCase();
const DEFAULT_ADMIN_USERNAME = /^[a-z0-9_.\-]{3,64}$/.test(NORMALIZED_ENV_ADMIN_USERNAME)
  ? NORMALIZED_ENV_ADMIN_USERNAME
  : 'admin';
const DEFAULT_ADMIN_PASSWORD =
  process.env.DEFAULT_ADMIN_PASSWORD || 'Admin123!';
const BOOTSTRAP_ADMIN_EMAIL = 'mull.jhamur@gmail.com';

interface SessionClaims {
  username: string;
  role: UserRole;
  employeeId: string;
  fullName: string;
  email?: string;
}

interface AuthenticatedRequest extends Request {
  sessionUser?: SessionClaims;
}

const DEFAULT_OFFICE_SETTINGS: OfficeSettings = {
  officeName: 'Kantor Pusat Operasional',
  latitude: -6.2087634, // Monas / Jakarta Pusat default; dapat langsung diubah ke lokasi GPS saat ini oleh Admin
  longitude: 106.845599,
  radiusMeters: 100,
  maxGpsAccuracyMeters: 30,
  workStartTime: '08:00',
  workEndTime: '17:00',
  lateToleranceMinutes: 15,
  faceMatchThreshold: 0.84,
  enableNightShift: false,
  adminReportEmail: BOOTSTRAP_ADMIN_EMAIL,
  autoMonthlyReportEnabled: true,
  lastMonthlyReportPeriod: '',
  dataRetentionDays: 365,
  updatedAtIso: new Date().toISOString(),
};

let initializedBootstrap = false;
let bootstrapPromise: Promise<void> | null = null;

async function ensureBootstrapData(): Promise<void> {
  if (initializedBootstrap) return;
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    try {
      // 1. Ensure office_settings/main exists atomically without overwriting existing settings
      const settingsRef = adminDb.collection('office_settings').doc('main');
      const settingsSnap = await settingsRef.get();
      if (!settingsSnap.exists) {
        await settingsRef.createIfAbsent({
          ...DEFAULT_OFFICE_SETTINGS,
          updatedAtIso: new Date().toISOString(),
        });
      }

      // 2. Ensure default admin username/password account exists (normalized lowercase)
      const adminCandidates = Array.from(new Set(['admin', DEFAULT_ADMIN_USERNAME]));
      for (const candidateUsername of adminCandidates) {
        const adminUserRef = adminDb.collection('users').doc(candidateUsername);
        const adminSnap = await adminUserRef.get();
        if (!adminSnap.exists) {
          const passwordHash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);
          await adminUserRef.createIfAbsent({
            username: candidateUsername,
            passwordHash,
            role: 'ADMIN',
            employeeId: 'ADM-001',
            fullName: 'Administrator Utama',
            position: 'HR & Operations Admin',
            failedAttempts: 0,
            lockedUntilMs: 0,
            isActive: true,
            createdAtIso: new Date().toISOString(),
          });
        }
      }

      // Clean up legacy mixed-case admin document if env var had uppercase characters
      if (
        RAW_ENV_ADMIN_USERNAME &&
        RAW_ENV_ADMIN_USERNAME !== DEFAULT_ADMIN_USERNAME &&
        /^[a-zA-Z0-9_.\-]{1,128}$/.test(RAW_ENV_ADMIN_USERNAME)
      ) {
        const legacyRef = adminDb.collection('users').doc(RAW_ENV_ADMIN_USERNAME);
        const legacySnap = await legacyRef.get();
        if (legacySnap.exists && legacySnap.data()?.role === 'ADMIN') {
          await legacyRef.delete();
        }
      }

      initializedBootstrap = true;
    } catch (err) {
      console.error('Bootstrap initialization warning:', err);
    } finally {
      bootstrapPromise = null;
    }
  })();

  return bootstrapPromise;
}

async function writeAuditLog(entry: Omit<AuditLogRecord, 'logId' | 'timestampIso'>) {
  const logId = `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const record: AuditLogRecord = {
    ...entry,
    logId,
    timestampIso: new Date().toISOString(),
  };
  await adminDb.collection('audit_logs').doc(logId).set(record);
}

/**
 * Bidirectionally synchronizes an AttendanceAppeal (PENDING / APPROVED / REJECTED)
 * with attendance_records on workDateWib so Sanggah and Absensi are always 100% consistent.
 */
async function syncAppealToAttendanceRecords(
  appeal: AttendanceAppeal,
  settings: OfficeSettings
): Promise<void> {
  const daySnap = await adminDb
    .collection('attendance_records')
    .where('employeeId', '==', appeal.employeeId)
    .where('workDateWib', '==', appeal.workDateWib)
    .get();

  const docsOnDay: { id: string; data: AttendanceRecord }[] = [];
  daySnap.forEach((d) => {
    docsOnDay.push({ id: d.id, data: d.data() as AttendanceRecord });
  });

  const targetTypes: ('CHECK_IN' | 'CHECK_OUT')[] =
    appeal.scope === 'CHECK_IN'
      ? ['CHECK_IN']
      : appeal.scope === 'CHECK_OUT'
      ? ['CHECK_OUT']
      : ['CHECK_IN', 'CHECK_OUT'];

  const lat =
    typeof appeal.latitude === 'number' ? appeal.latitude : settings.latitude;
  const lng =
    typeof appeal.longitude === 'number' ? appeal.longitude : settings.longitude;
  const dist =
    typeof appeal.latitude === 'number' && typeof appeal.longitude === 'number'
      ? calculateGeodesicDistanceMeters(
          appeal.latitude,
          appeal.longitude,
          settings.latitude,
          settings.longitude
        )
      : 0;

  const detailText = `Sanggah (${appeal.category}): ${appeal.reason}`.slice(0, 190);
  const reviewer = (appeal.reviewedBy || 'admin').slice(0, 80);
  const revNote = (
    appeal.reviewNote ||
    (appeal.status === 'APPROVED'
      ? 'Sanggah disetujui Admin'
      : appeal.status === 'REJECTED'
      ? 'Sanggah ditolak Admin'
      : '')
  ).slice(0, 280);
  const revAtIso = appeal.reviewedAtIso || new Date().toISOString();

  for (const t of targetTypes) {
    const scheduledIso = buildScheduledWibIso(
      appeal.workDateWib,
      t === 'CHECK_IN' ? settings.workStartTime : settings.workEndTime
    );
    const txIdForAppeal = `att_${appeal.appealId}_${t === 'CHECK_IN' ? 'IN' : 'OUT'}`;

    const ofType = docsOnDay.filter((x) => x.data.type === t);
    const appealSpecific = ofType.find(
      (x) => x.id === txIdForAppeal || x.data.appealId === appeal.appealId
    );
    const biometricDoc = ofType.find(
      (x) =>
        !x.data.appealId &&
        !x.id.startsWith('att_apl_') &&
        !x.data.livenessDetail.startsWith('Sanggah') &&
        (x.data.attendanceStatus === 'VALID' ||
          x.data.attendanceStatus === 'LATE' ||
          x.data.attendanceStatus === 'EARLY_LEAVE')
    );
    const fallbackDoc = ofType.find(
      (x) =>
        x.data.attendanceStatus === 'NEEDS_REVIEW' ||
        x.data.attendanceStatus === 'REJECTED'
    );

    if (appeal.status === 'PENDING') {
      if (biometricDoc) {
        if (
          biometricDoc.data.attendanceStatus === 'LATE' ||
          biometricDoc.data.attendanceStatus === 'EARLY_LEAVE'
        ) {
          await adminDb.collection('attendance_records').doc(biometricDoc.id).update({
            appealId: appeal.appealId,
            appealStatus: 'PENDING',
            appealCategory: appeal.category.slice(0, 80),
          });
        }
      } else if (appealSpecific || fallbackDoc) {
        const target = (appealSpecific || fallbackDoc)!;
        await adminDb.collection('attendance_records').doc(target.id).update({
          attendanceStatus: 'NEEDS_REVIEW',
          syncStatus: 'NEEDS_ADMIN_REVIEW',
          livenessDetail: detailText,
          rejectionReason: `Menunggu persetujuan sanggah (${appeal.category})`.slice(0, 280),
          appealId: appeal.appealId,
          appealStatus: 'PENDING',
          appealCategory: appeal.category.slice(0, 80),
        });
      } else {
        const pendingRec: AttendanceRecord = {
          transactionId: txIdForAppeal,
          employeeId: appeal.employeeId,
          employeeName: appeal.employeeName,
          type: t,
          workDateWib: appeal.workDateWib,
          serverTimestampIso: scheduledIso,
          deviceTimestampIso: appeal.createdAtIso,
          gpsTimestampIso: appeal.createdAtIso,
          latitude: lat,
          longitude: lng,
          gpsAccuracyMeters: 0,
          distanceToOfficeMeters: dist,
          geofenceValid: true,
          suspiciousLocationFlags: [],
          faceMatchScore: 1,
          faceVerified: true,
          livenessVerified: true,
          livenessDetail: detailText,
          attendanceStatus: 'NEEDS_REVIEW',
          syncStatus: 'NEEDS_ADMIN_REVIEW',
          wasCapturedOffline: false,
          clockSkewSeconds: 0,
          rejectionReason: `Menunggu persetujuan sanggah (${appeal.category})`.slice(0, 280),
          hasEvidence: false,
          appealId: appeal.appealId,
          appealStatus: 'PENDING',
          appealCategory: appeal.category.slice(0, 80),
        };
        await adminDb.collection('attendance_records').doc(txIdForAppeal).createIfAbsent(pendingRec);
      }
    } else if (appeal.status === 'APPROVED') {
      if (biometricDoc) {
        if (biometricDoc.data.attendanceStatus !== 'VALID' || biometricDoc.data.appealStatus !== 'APPROVED') {
          await adminDb.collection('attendance_records').doc(biometricDoc.id).update({
            attendanceStatus: 'VALID',
            syncStatus: 'SYNCED',
            geofenceValid: true,
            faceVerified: true,
            livenessVerified: true,
            livenessDetail: detailText,
            reviewedBy: reviewer,
            reviewNote: revNote,
            reviewedAtIso: revAtIso,
            rejectionReason: '',
            appealId: appeal.appealId,
            appealStatus: 'APPROVED',
            appealCategory: appeal.category.slice(0, 80),
          });
        }
      } else if (appealSpecific || fallbackDoc) {
        const target = (appealSpecific || fallbackDoc)!;
        await adminDb.collection('attendance_records').doc(target.id).update({
          attendanceStatus: 'VALID',
          syncStatus: 'SYNCED',
          geofenceValid: true,
          faceVerified: true,
          livenessVerified: true,
          livenessDetail: detailText,
          reviewedBy: reviewer,
          reviewNote: revNote,
          reviewedAtIso: revAtIso,
          rejectionReason: '',
          serverTimestampIso: scheduledIso,
          appealId: appeal.appealId,
          appealStatus: 'APPROVED',
          appealCategory: appeal.category.slice(0, 80),
        });
      } else {
        const validRec: AttendanceRecord = {
          transactionId: txIdForAppeal,
          employeeId: appeal.employeeId,
          employeeName: appeal.employeeName,
          type: t,
          workDateWib: appeal.workDateWib,
          serverTimestampIso: scheduledIso,
          deviceTimestampIso: appeal.createdAtIso,
          gpsTimestampIso: appeal.createdAtIso,
          latitude: lat,
          longitude: lng,
          gpsAccuracyMeters: 0,
          distanceToOfficeMeters: dist,
          geofenceValid: true,
          suspiciousLocationFlags: [],
          faceMatchScore: 1,
          faceVerified: true,
          livenessVerified: true,
          livenessDetail: detailText,
          attendanceStatus: 'VALID',
          syncStatus: 'SYNCED',
          wasCapturedOffline: false,
          clockSkewSeconds: 0,
          rejectionReason: '',
          reviewedBy: reviewer,
          reviewNote: revNote,
          reviewedAtIso: revAtIso,
          hasEvidence: false,
          appealId: appeal.appealId,
          appealStatus: 'APPROVED',
          appealCategory: appeal.category.slice(0, 80),
        };
        await adminDb.collection('attendance_records').doc(txIdForAppeal).createIfAbsent(validRec);
      }
    } else if (appeal.status === 'REJECTED') {
      if (biometricDoc) {
        await adminDb.collection('attendance_records').doc(biometricDoc.id).update({
          reviewedBy: reviewer,
          reviewNote: revNote,
          reviewedAtIso: revAtIso,
          appealId: appeal.appealId,
          appealStatus: 'REJECTED',
          appealCategory: appeal.category.slice(0, 80),
        });
      } else if (appealSpecific) {
        await adminDb.collection('attendance_records').doc(appealSpecific.id).update({
          attendanceStatus: 'REJECTED',
          syncStatus: 'REJECTED_SERVER',
          reviewedBy: reviewer,
          reviewNote: revNote,
          reviewedAtIso: revAtIso,
          rejectionReason: `Sanggah ditolak: ${revNote}`.slice(0, 280),
          appealId: appeal.appealId,
          appealStatus: 'REJECTED',
          appealCategory: appeal.category.slice(0, 80),
        });
      }
    }
  }
}

async function reconcileUnsyncedAppeals(
  appeals: AttendanceAppeal[],
  records: AttendanceRecord[],
  settings: OfficeSettings
): Promise<boolean> {
  let didMutate = false;
  for (const apl of appeals) {
    const linked = records.filter(
      (r) =>
        r.appealId === apl.appealId ||
        r.transactionId.startsWith(`att_${apl.appealId}_`)
    );
    const expectedCount = apl.scope === 'FULL_DAY' ? 2 : 1;
    const statusMismatch = linked.some((r) => r.appealStatus !== apl.status);
    if (
      (apl.status === 'PENDING' || apl.status === 'APPROVED') &&
      (linked.length < expectedCount || statusMismatch)
    ) {
      await syncAppealToAttendanceRecords(apl, settings);
      didMutate = true;
    } else if (apl.status === 'REJECTED' && statusMismatch) {
      await syncAppealToAttendanceRecords(apl, settings);
      didMutate = true;
    }
  }
  return didMutate;
}

// Middleware supporting both JWT (username/password) and Firebase ID Token (Google Admin)
async function requireSession(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  await ensureBootstrapData();
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Sesi tidak ditemukan. Silakan login kembali.' });
    return;
  }

  const token = authHeader.slice(7).trim();
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as SessionClaims;
    req.sessionUser = decoded;
    next();
    return;
  } catch {
    // Fallback: check if it's a Firebase ID token from Google Sign-In
    try {
      const fbUser = await adminAuth.verifyIdToken(token);
      if (fbUser.email && fbUser.email_verified) {
        const settingsSnap = await adminDb.collection('office_settings').doc('main').get();
        const configuredEmail = settingsSnap.exists
          ? String(settingsSnap.data()?.adminReportEmail || BOOTSTRAP_ADMIN_EMAIL)
          : BOOTSTRAP_ADMIN_EMAIL;
        const isAllowedAdmin =
          fbUser.email.toLowerCase() === BOOTSTRAP_ADMIN_EMAIL.toLowerCase() ||
          fbUser.email.toLowerCase() === configuredEmail.toLowerCase();
        if (isAllowedAdmin) {
          req.sessionUser = {
            username: fbUser.email.split('@')[0],
            role: 'ADMIN',
            employeeId: 'ADM-GOOGLE',
            fullName: fbUser.name || 'Administrator',
            email: fbUser.email,
          };
          next();
          return;
        }
      }
      res.status(403).json({ error: 'Akun Google ini tidak terdaftar sebagai Administrator.' });
      return;
    } catch {
      res.status(401).json({ error: 'Sesi telah berakhir atau tidak valid. Silakan login ulang.' });
      return;
    }
  }
}

function requireAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  if (req.sessionUser?.role !== 'ADMIN') {
    res.status(403).json({ error: 'Akses ditolak. Halaman ini khusus Administrator.' });
    return;
  }
  next();
}

// IP brute-force guard in addition to per-username lockout
const ipAttempts = new Map<string, { count: number; lockedUntil: number }>();

export function createApiApp(): express.Express {
  const app = express();

  // Enable CORS when frontend is hosted on a separate domain (e.g. Netlify + Cloud Run API)
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, PUT, PATCH, DELETE, OPTIONS'
    );
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Normalize Netlify Functions invocation path (/.netlify/functions/api/* -> /api/*)
  app.use((req, _res, next) => {
    if (req.url.startsWith('/.netlify/functions/api')) {
      const suffix = req.url.slice('/.netlify/functions/api'.length);
      req.url = `/api${suffix.startsWith('/') ? suffix : suffix ? `/${suffix}` : ''}`;
    }
    next();
  });

  app.use(express.json({ limit: '2mb' }));

  // Ensure Buffer/string JSON payloads in serverless environments are parsed
  app.use((req, _res, next) => {
    if (Buffer.isBuffer(req.body)) {
      try {
        req.body = JSON.parse(req.body.toString('utf-8'));
      } catch {
        // ignore non-JSON buffer
      }
    } else if (typeof req.body === 'string' && req.body.trim().startsWith('{')) {
      try {
        req.body = JSON.parse(req.body);
      } catch {
        // ignore invalid JSON string
      }
    }
    next();
  });

  // 1. Server time endpoint (prevents client clock spoofing)
  app.get('/api/time', async (_req, res) => {
    await ensureBootstrapData();
    const now = new Date();
    const wib = getWibParts(now);
    res.json({
      serverTimestampIso: now.toISOString(),
      serverEpochMs: now.getTime(),
      wibDate: wib.dateStr,
      wibFormatted: formatWibDateTime(now),
    });
  });

  // 2. Username & Password Login with bcrypt + Rate Limiting
  app.post('/api/auth/login', async (req: Request, res: Response) => {
    try {
      await ensureBootstrapData();
      const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'unknown';
      const nowMs = Date.now();
      const ipState = ipAttempts.get(ip);
      if (ipState && ipState.lockedUntil > nowMs) {
        const waitSec = Math.ceil((ipState.lockedUntil - nowMs) / 1000);
        res.status(429).json({
          error: `Terlalu banyak percobaan gagal dari perangkat ini. Coba lagi dalam ${waitSec} detik.`,
        });
        return;
      }

      const rawUsername = String(req.body?.username || '').trim().toLowerCase();
      const password = String(req.body?.password || '');

      if (!rawUsername || !password) {
        res.status(400).json({ error: 'Username dan password wajib diisi.' });
        return;
      }

      if (!/^[a-zA-Z0-9_.\-]{3,64}$/.test(rawUsername)) {
        res.status(400).json({ error: 'Format username tidak valid.' });
        return;
      }

      const userRef = adminDb.collection('users').doc(rawUsername);
      const userSnap = await userRef.get();

      if (!userSnap.exists) {
        const currentIp = ipAttempts.get(ip) || { count: 0, lockedUntil: 0 };
        currentIp.count += 1;
        if (currentIp.count >= 5) {
          currentIp.lockedUntil = nowMs + 5 * 60 * 1000;
        }
        ipAttempts.set(ip, currentIp);
        res.status(401).json({ error: 'Username atau password salah.' });
        return;
      }

      const userData = userSnap.data()!;
      if (userData.isActive === false) {
        res.status(403).json({ error: 'Akun karyawan ini telah dinonaktifkan oleh Admin.' });
        return;
      }

      if (userData.lockedUntilMs && userData.lockedUntilMs > nowMs) {
        const waitSec = Math.ceil((userData.lockedUntilMs - nowMs) / 1000);
        res.status(429).json({
          error: `Akun dikunci sementara karena percobaan gagal berulang. Tunggu ${waitSec} detik.`,
        });
        return;
      }

      const passwordValid = await bcrypt.compare(password, userData.passwordHash);
      if (!passwordValid) {
        const nextFailed = (userData.failedAttempts || 0) + 1;
        const lockMs = nextFailed >= 5 ? nowMs + 5 * 60 * 1000 : 0;
        await userRef.update({
          failedAttempts: nextFailed,
          lockedUntilMs: lockMs,
        });

        await writeAuditLog({
          actorUsername: rawUsername,
          actorRole: userData.role || 'UNKNOWN',
          action: 'LOGIN_FAILED',
          targetId: rawUsername,
          reason:
            lockMs > 0
              ? `Gagal login ke-${nextFailed} — akun dikunci 5 menit`
              : `Password salah (percobaan ke-${nextFailed})`,
        });

        const remaining = Math.max(0, 5 - nextFailed);
        res.status(401).json({
          error:
            remaining > 0
              ? `Username atau password salah. Sisa percobaan sebelum kunci sementara: ${remaining}x.`
              : 'Percobaan gagal mencapai batas 5x. Akun dikunci selama 5 menit.',
        });
        return;
      }

      // Reset failed counters on success
      await userRef.update({ failedAttempts: 0, lockedUntilMs: 0 });
      ipAttempts.delete(ip);

      let hasFaceProfile = false;
      let consentAccepted = true;
      let fullName = userData.fullName || rawUsername;
      let position = userData.position || 'Staf';

      if (userData.role === 'EMPLOYEE') {
        const empSnap = await adminDb.collection('employees').doc(userData.employeeId).get();
        if (empSnap.exists) {
          const emp = empSnap.data()!;
          hasFaceProfile = Boolean(emp.hasFaceProfile);
          consentAccepted = Boolean(emp.consentAccepted);
          fullName = emp.fullName || fullName;
          position = emp.position || position;
        }
      }

      const claims: SessionClaims = {
        username: rawUsername,
        role: userData.role,
        employeeId: userData.employeeId,
        fullName,
      };

      const token = jwt.sign(claims, JWT_SECRET, { expiresIn: '12h' });

      await writeAuditLog({
        actorUsername: rawUsername,
        actorRole: userData.role,
        action: 'LOGIN_SUCCESS',
        targetId: userData.employeeId,
        reason: 'Login berhasil dengan username dan password',
      });

      res.json({
        token,
        user: {
          username: rawUsername,
          role: userData.role,
          employeeId: userData.employeeId,
          fullName,
          position,
          hasFaceProfile,
          consentAccepted,
        },
      });
    } catch (err: any) {
      console.error('Login error:', err);
      res.status(500).json({ error: 'Terjadi kesalahan pada server saat memproses login.' });
    }
  });

  // 2b. Google Admin binding endpoint (registers verified admin UID in /admins/{uid} and returns session)
  app.post('/api/auth/google-admin', async (req: Request, res: Response) => {
    try {
      await ensureBootstrapData();
      const idToken = String(req.body?.idToken || '');
      if (!idToken) {
        res.status(400).json({ error: 'ID Token Google diperlukan.' });
        return;
      }
      const decoded = await adminAuth.verifyIdToken(idToken);
      if (!decoded.email || !decoded.email_verified) {
        res.status(403).json({ error: 'Email Google harus terverifikasi.' });
        return;
      }
      const settingsSnap = await adminDb.collection('office_settings').doc('main').get();
      const configuredAdminEmail = settingsSnap.exists
        ? String(settingsSnap.data()?.adminReportEmail || BOOTSTRAP_ADMIN_EMAIL)
        : BOOTSTRAP_ADMIN_EMAIL;

      const isAllowed =
        decoded.email.toLowerCase() === BOOTSTRAP_ADMIN_EMAIL.toLowerCase() ||
        decoded.email.toLowerCase() === configuredAdminEmail.toLowerCase();

      if (!isAllowed) {
        res.status(403).json({
          error: `Akun ${decoded.email} tidak terdaftar sebagai Administrator.`,
        });
        return;
      }

      const claims: SessionClaims = {
        username: decoded.email.split('@')[0],
        role: 'ADMIN',
        employeeId: 'ADM-001',
        fullName: decoded.name || 'Administrator Utama',
        email: decoded.email,
      };
      const token = jwt.sign(claims, JWT_SECRET, { expiresIn: '12h' });

      res.json({
        token,
        user: {
          username: claims.username,
          role: 'ADMIN',
          employeeId: 'ADM-001',
          fullName: claims.fullName,
          position: 'Administrator',
          hasFaceProfile: true,
          consentAccepted: true,
          email: decoded.email,
        },
      });
    } catch (err) {
      console.error('Google admin auth error:', err);
      res.status(401).json({ error: 'Gagal memverifikasi akun Google Admin.' });
    }
  });

  // 3. Session Profile + Local Offline Sync Bootstrap
  app.get('/api/auth/me', requireSession, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const s = req.sessionUser!;
      const settingsSnap = await adminDb.collection('office_settings').doc('main').get();
      const officeSettings = (settingsSnap.data() as OfficeSettings) || DEFAULT_OFFICE_SETTINGS;

      let userPayload: any = {
        username: s.username,
        role: s.role,
        employeeId: s.employeeId,
        fullName: s.fullName,
        position: s.role === 'ADMIN' ? 'HR & Operations Admin' : 'Karyawan',
        hasFaceProfile: false,
        consentAccepted: true,
        email: s.email,
      };

      let ownFaceProfile: { descriptorVector: number[]; threshold: number } | null = null;

      if (s.role === 'EMPLOYEE') {
        const empSnap = await adminDb.collection('employees').doc(s.employeeId).get();
        if (empSnap.exists) {
          const emp = empSnap.data()!;
          userPayload = {
            ...userPayload,
            fullName: emp.fullName,
            position: emp.position,
            hasFaceProfile: Boolean(emp.hasFaceProfile),
            consentAccepted: Boolean(emp.consentAccepted),
          };
        }
        const faceSnap = await adminDb.collection('face_profiles').doc(s.employeeId).get();
        if (faceSnap.exists) {
          const fp = faceSnap.data()!;
          ownFaceProfile = {
            descriptorVector: fp.descriptorVector || [],
            threshold: officeSettings.faceMatchThreshold,
          };
        }
      }

      res.json({
        user: userPayload,
        officeSettings,
        ownFaceProfile,
        serverTimestampIso: new Date().toISOString(),
      });
    } catch (err) {
      console.error('Me endpoint error:', err);
      res.status(500).json({ error: 'Gagal memuat sesi pengguna.' });
    }
  });

  // 4. Employee Privacy Consent Acceptance
  app.post('/api/employee/consent', requireSession, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const s = req.sessionUser!;
      if (s.role !== 'EMPLOYEE') {
        res.json({ ok: true });
        return;
      }
      const nowIso = new Date().toISOString();
      const empRef = adminDb.collection('employees').doc(s.employeeId);
      const empSnap = await empRef.get();
      if (!empSnap.exists) {
        res.status(404).json({ error: 'Profil karyawan tidak ditemukan.' });
        return;
      }
      await empRef.update({
        consentAccepted: true,
        consentTimestampIso: nowIso,
      });
      await writeAuditLog({
        actorUsername: s.username,
        actorRole: s.role,
        action: 'PRIVACY_CONSENT_ACCEPTED',
        targetId: s.employeeId,
        reason: 'Karyawan menyetujui pemberitahuan privasi data biometrik wajah & lokasi GPS',
      });
      res.json({ ok: true, consentTimestampIso: nowIso });
    } catch (err) {
      console.error('Consent update error:', err);
      res.status(500).json({ error: 'Gagal menyimpan persetujuan privasi.' });
    }
  });

  // 5. Admin: Change Own Password
  app.post('/api/auth/change-password', requireSession, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const s = req.sessionUser!;
      const currentPassword = String(req.body?.currentPassword || '');
      const newPassword = String(req.body?.newPassword || '');
      if (newPassword.length < 8) {
        res.status(400).json({ error: 'Password baru minimal 8 karakter.' });
        return;
      }
      const userRef = adminDb.collection('users').doc(s.username);
      const snap = await userRef.get();
      if (!snap.exists) {
        res.status(404).json({ error: 'Akun username lokal tidak ditemukan.' });
        return;
      }
      const valid = await bcrypt.compare(currentPassword, snap.data()!.passwordHash);
      if (!valid) {
        res.status(401).json({ error: 'Password saat ini tidak sesuai.' });
        return;
      }
      const newHash = await bcrypt.hash(newPassword, 10);
      await userRef.update({ passwordHash: newHash });
      await writeAuditLog({
        actorUsername: s.username,
        actorRole: s.role,
        action: 'PASSWORD_CHANGED',
        targetId: s.username,
        reason: 'Pengguna memperbarui password akun',
      });
      res.json({ ok: true });
    } catch (err) {
      console.error('Change password error:', err);
      res.status(500).json({ error: 'Gagal mengubah password.' });
    }
  });

  // 6. Admin: Office Settings Read & Update (with Audit Log)
  app.put(
    '/api/admin/office-settings',
    requireSession,
    requireAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const s = req.sessionUser!;
        const body = req.body || {};
        const reason = String(body.reason || 'Pembaruan konfigurasi kantor oleh Admin').slice(0, 300);

        const settingsRef = adminDb.collection('office_settings').doc('main');
        const prevSnap = await settingsRef.get();
        const prev = (prevSnap.data() as OfficeSettings) || DEFAULT_OFFICE_SETTINGS;

        const nextSettings: OfficeSettings = {
          officeName: String(body.officeName ?? prev.officeName).trim().slice(0, 120),
          latitude: Number(body.latitude ?? prev.latitude),
          longitude: Number(body.longitude ?? prev.longitude),
          radiusMeters: Math.max(10, Math.min(5000, Number(body.radiusMeters ?? prev.radiusMeters))),
          maxGpsAccuracyMeters: Math.max(
            5,
            Math.min(500, Number(body.maxGpsAccuracyMeters ?? prev.maxGpsAccuracyMeters))
          ),
          workStartTime: String(body.workStartTime ?? prev.workStartTime).slice(0, 5),
          workEndTime: String(body.workEndTime ?? prev.workEndTime).slice(0, 5),
          lateToleranceMinutes: Math.max(
            0,
            Math.min(240, Number(body.lateToleranceMinutes ?? prev.lateToleranceMinutes))
          ),
          faceMatchThreshold: Math.max(
            0.65,
            Math.min(0.98, Number(body.faceMatchThreshold ?? prev.faceMatchThreshold))
          ),
          enableNightShift: Boolean(body.enableNightShift ?? prev.enableNightShift),
          adminReportEmail: String(body.adminReportEmail ?? prev.adminReportEmail).trim().slice(0, 160),
          autoMonthlyReportEnabled: Boolean(
            body.autoMonthlyReportEnabled ?? prev.autoMonthlyReportEnabled
          ),
          lastMonthlyReportPeriod: prev.lastMonthlyReportPeriod || '',
          dataRetentionDays: Math.max(
            30,
            Math.min(3650, Number(body.dataRetentionDays ?? prev.dataRetentionDays))
          ),
          updatedAtIso: new Date().toISOString(),
        };

        if (
          Number.isNaN(nextSettings.latitude) ||
          nextSettings.latitude < -90 ||
          nextSettings.latitude > 90 ||
          Number.isNaN(nextSettings.longitude) ||
          nextSettings.longitude < -180 ||
          nextSettings.longitude > 180
        ) {
          res.status(400).json({ error: 'Koordinat latitude/longitude kantor tidak valid.' });
          return;
        }

        await settingsRef.set(nextSettings);

        await writeAuditLog({
          actorUsername: s.username,
          actorRole: s.role,
          action: 'UPDATE_OFFICE_SETTINGS',
          targetId: 'office_settings/main',
          previousValueSummary: `${prev.officeName} (${prev.latitude}, ${prev.longitude}) R=${prev.radiusMeters}m Jam=${prev.workStartTime}-${prev.workEndTime}`,
          newValueSummary: `${nextSettings.officeName} (${nextSettings.latitude}, ${nextSettings.longitude}) R=${nextSettings.radiusMeters}m Jam=${nextSettings.workStartTime}-${nextSettings.workEndTime}`,
          reason,
        });

        res.json({ officeSettings: nextSettings });
      } catch (err) {
        console.error('Update office settings error:', err);
        res.status(500).json({ error: 'Gagal memperbarui pengaturan lokasi kantor.' });
      }
    }
  );

  // 7. Admin: List, Create, Update, Reset Password Employees (Enforcing 1-10 employees company scope)
  app.get(
    '/api/admin/employees',
    requireSession,
    requireAdmin,
    async (_req: AuthenticatedRequest, res: Response) => {
      try {
        const empSnaps = await adminDb.collection('employees').get();
        const faceSnaps = await adminDb.collection('face_profiles').get();
        const faceMap = new Map<string, any>();
        faceSnaps.forEach((doc) => faceMap.set(doc.id, doc.data()));

        const employees: EmployeeProfile[] = [];
        empSnaps.forEach((doc) => {
          const d = doc.data();
          const fp = faceMap.get(doc.id);
          employees.push({
            employeeId: d.employeeId,
            fullName: d.fullName,
            username: d.username,
            position: d.position || 'Staf',
            hasFaceProfile: Boolean(d.hasFaceProfile && fp),
            consentAccepted: Boolean(d.consentAccepted),
            consentTimestampIso: d.consentTimestampIso,
            isActive: d.isActive !== false,
            createdAtIso: d.createdAtIso,
            faceSampleCount: fp?.sampleCount,
            faceQualityScore: fp?.qualityScore,
            faceUpdatedAtIso: fp?.updatedAtIso,
          });
        });

        employees.sort((a, b) => a.employeeId.localeCompare(b.employeeId));
        res.json({ employees });
      } catch (err) {
        console.error('List employees error:', err);
        res.status(500).json({ error: 'Gagal memuat daftar karyawan.' });
      }
    }
  );

  app.post(
    '/api/admin/employees',
    requireSession,
    requireAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const s = req.sessionUser!;
        const employeeId = String(req.body?.employeeId || '').trim().toUpperCase();
        const fullName = String(req.body?.fullName || '').trim();
        const username = String(req.body?.username || '').trim().toLowerCase();
        const password = String(req.body?.password || '');
        const position = String(req.body?.position || 'Karyawan').trim().slice(0, 80);

        if (!/^[A-Z0-9_\-]{2,32}$/.test(employeeId)) {
          res.status(400).json({
            error: 'ID Karyawan hanya boleh huruf kapital, angka, tanda hubung (contoh: EMP-001).',
          });
          return;
        }
        if (fullName.length < 2 || fullName.length > 120) {
          res.status(400).json({ error: 'Nama lengkap harus antara 2–120 karakter.' });
          return;
        }
        if (!/^[a-z0-9_.\-]{3,64}$/.test(username)) {
          res.status(400).json({
            error: 'Username harus 3–64 karakter (huruf kecil, angka, titik, garis bawah).',
          });
          return;
        }
        if (password.length < 6) {
          res.status(400).json({ error: 'Password awal minimal 6 karakter.' });
          return;
        }

        // Check active count <= 10 (company capacity 1-10 employees)
        const allEmps = await adminDb.collection('employees').get();
        const activeCount = allEmps.docs.filter((d) => d.data().isActive !== false).length;
        if (activeCount >= 10) {
          res.status(400).json({
            error: 'Kapasitas maksimum perusahaan (10 karyawan aktif) telah tercapai.',
          });
          return;
        }

        const existingEmp = await adminDb.collection('employees').doc(employeeId).get();
        if (existingEmp.exists) {
          res.status(409).json({ error: `ID Karyawan ${employeeId} sudah terdaftar.` });
          return;
        }

        const existingUser = await adminDb.collection('users').doc(username).get();
        if (existingUser.exists) {
          res.status(409).json({ error: `Username "${username}" sudah digunakan.` });
          return;
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const nowIso = new Date().toISOString();

        const batch = adminDb.batch();
        batch.set(adminDb.collection('employees').doc(employeeId), {
          employeeId,
          fullName,
          username,
          position,
          hasFaceProfile: false,
          consentAccepted: false,
          isActive: true,
          createdAtIso: nowIso,
        });
        batch.set(adminDb.collection('users').doc(username), {
          username,
          passwordHash,
          role: 'EMPLOYEE', // Karyawan tidak pernah bisa dibuat sebagai ADMIN dari form karyawan
          employeeId,
          fullName,
          position,
          failedAttempts: 0,
          lockedUntilMs: 0,
          isActive: true,
          createdAtIso: nowIso,
        });
        await batch.commit();

        await writeAuditLog({
          actorUsername: s.username,
          actorRole: s.role,
          action: 'CREATE_EMPLOYEE',
          targetId: employeeId,
          newValueSummary: `${fullName} (@${username}) - ${position}`,
          reason: 'Pendaftaran akun karyawan baru oleh Admin',
        });

        res.status(201).json({
          employee: {
            employeeId,
            fullName,
            username,
            position,
            hasFaceProfile: false,
            consentAccepted: false,
            isActive: true,
            createdAtIso: nowIso,
          },
        });
      } catch (err) {
        console.error('Create employee error:', err);
        res.status(500).json({ error: 'Gagal menambahkan karyawan baru.' });
      }
    }
  );

  // Admin: Toggle employee active state or reset password
  app.patch(
    '/api/admin/employees/:employeeId',
    requireSession,
    requireAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const s = req.sessionUser!;
        const employeeId = String(req.params.employeeId);
        const empRef = adminDb.collection('employees').doc(employeeId);
        const empSnap = await empRef.get();
        if (!empSnap.exists) {
          res.status(404).json({ error: 'Data karyawan tidak ditemukan.' });
          return;
        }
        const empData = empSnap.data()!;
        const userRef = adminDb.collection('users').doc(empData.username);

        const updatesEmp: Record<string, any> = {};
        const updatesUser: Record<string, any> = {};
        const reason = String(req.body?.reason || 'Pembaruan akun karyawan oleh Admin').slice(0, 300);

        if (typeof req.body?.isActive === 'boolean') {
          updatesEmp.isActive = req.body.isActive;
          updatesUser.isActive = req.body.isActive;
        }
        if (typeof req.body?.position === 'string' && req.body.position.trim()) {
          updatesEmp.position = req.body.position.trim().slice(0, 80);
          updatesUser.position = updatesEmp.position;
        }
        if (typeof req.body?.newPassword === 'string' && req.body.newPassword.length >= 6) {
          updatesUser.passwordHash = await bcrypt.hash(req.body.newPassword, 10);
          updatesUser.failedAttempts = 0;
          updatesUser.lockedUntilMs = 0;
        }

        if (Object.keys(updatesEmp).length > 0) {
          await empRef.update(updatesEmp);
        }
        if (Object.keys(updatesUser).length > 0) {
          await userRef.update(updatesUser);
        }

        await writeAuditLog({
          actorUsername: s.username,
          actorRole: s.role,
          action: 'UPDATE_EMPLOYEE',
          targetId: employeeId,
          previousValueSummary: `isActive=${empData.isActive}, position=${empData.position}`,
          newValueSummary: JSON.stringify({
            isActive: updatesEmp.isActive ?? empData.isActive,
            position: updatesEmp.position ?? empData.position,
            passwordReset: Boolean(updatesUser.passwordHash),
          }),
          reason,
        });

        res.json({ ok: true });
      } catch (err) {
        console.error('Update employee error:', err);
        res.status(500).json({ error: 'Gagal memperbarui akun karyawan.' });
      }
    }
  );

  // Admin: Delete employee biometric data (Privacy / Right to Erasure compliance)
  app.delete(
    '/api/admin/employees/:employeeId/biometrics',
    requireSession,
    requireAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const s = req.sessionUser!;
        const employeeId = String(req.params.employeeId);
        const reason = String(req.body?.reason || 'Penghapusan template biometrik sesuai kebijakan privasi');

        await adminDb.collection('face_profiles').doc(employeeId).delete();
        await adminDb.collection('employees').doc(employeeId).update({
          hasFaceProfile: false,
        });

        await writeAuditLog({
          actorUsername: s.username,
          actorRole: s.role,
          action: 'DELETE_FACE_PROFILE',
          targetId: employeeId,
          previousValueSummary: 'hasFaceProfile=true',
          newValueSummary: 'hasFaceProfile=false',
          reason,
        });

        res.json({ ok: true });
      } catch (err) {
        console.error('Delete biometrics error:', err);
        res.status(500).json({ error: 'Gagal menghapus data biometrik wajah.' });
      }
    }
  );

  // Admin: Delete employee account completely
  app.delete(
    '/api/admin/employees/:employeeId',
    requireSession,
    requireAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const s = req.sessionUser!;
        const employeeId = String(req.params.employeeId);
        const empRef = adminDb.collection('employees').doc(employeeId);
        const empSnap = await empRef.get();
        if (!empSnap.exists) {
          res.status(404).json({ error: 'Karyawan tidak ditemukan.' });
          return;
        }
        const empData = empSnap.data()!;
        const deletions: Promise<any>[] = [
          empRef.delete(),
          adminDb.collection('face_profiles').doc(employeeId).delete(),
        ];
        if (empData.username) {
          deletions.push(
            adminDb.collection('users').doc(String(empData.username)).delete()
          );
        }
        await Promise.all(deletions);

        await writeAuditLog({
          actorUsername: s.username,
          actorRole: s.role,
          action: 'DELETE_EMPLOYEE',
          targetId: employeeId,
          previousValueSummary: `${empData.fullName} (@${empData.username})`,
          reason: 'Penghapusan akun karyawan oleh Admin',
        });

        res.json({ ok: true });
      } catch (err) {
        console.error('Delete employee error:', err);
        res.status(500).json({ error: 'Gagal menghapus akun karyawan.' });
      }
    }
  );

  // 8. Admin: Register Employee Face Reference Profile (Multi-sample averaged 128D descriptor)
  app.post(
    '/api/admin/employees/:employeeId/face-profile',
    requireSession,
    requireAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const s = req.sessionUser!;
        const employeeId = String(req.params.employeeId);
        const descriptorVector = req.body?.descriptorVector;
        const sampleCount = Number(req.body?.sampleCount || 0);
        const qualityScore = Number(req.body?.qualityScore || 0);

        if (
          !Array.isArray(descriptorVector) ||
          descriptorVector.length !== 128 ||
          !descriptorVector.every((v) => typeof v === 'number' && Number.isFinite(v))
        ) {
          res.status(400).json({
            error: 'Template biometrik wajah tidak valid (wajib vektor ternormalisasi 128 dimensi).',
          });
          return;
        }
        if (sampleCount < 3) {
          res.status(400).json({
            error: 'Registrasi wajah wajib mengambil minimal 3 sampel pencahayaan langsung.',
          });
          return;
        }

        const empRef = adminDb.collection('employees').doc(employeeId);
        const empSnap = await empRef.get();
        if (!empSnap.exists) {
          res.status(404).json({ error: 'ID Karyawan tidak ditemukan.' });
          return;
        }

        const nowIso = new Date().toISOString();
        const faceRef = adminDb.collection('face_profiles').doc(employeeId);
        const existingFace = await faceRef.get();
        if (existingFace.exists) {
          await faceRef.update({
            descriptorVector,
            sampleCount,
            qualityScore,
            encryptionVersion: 'L2-NORM-128D-V1',
            updatedAtIso: nowIso,
            registeredBy: s.username,
          });
        } else {
          await faceRef.set({
            employeeId,
            descriptorVector,
            sampleCount,
            qualityScore,
            encryptionVersion: 'L2-NORM-128D-V1',
            updatedAtIso: nowIso,
            registeredBy: s.username,
          });
        }

        await empRef.update({
          hasFaceProfile: true,
        });

        await writeAuditLog({
          actorUsername: s.username,
          actorRole: s.role,
          action: 'REGISTER_FACE_PROFILE',
          targetId: employeeId,
          newValueSummary: `${sampleCount} sampel wajah langsung, skor kualitas ${qualityScore}/100`,
          reason: 'Pendaftaran referensi wajah biometrik karyawan oleh Admin',
        });

        res.json({ ok: true, updatedAtIso: nowIso });
      } catch (err) {
        console.error('Register face error:', err);
        res.status(500).json({ error: 'Gagal menyimpan data referensi wajah karyawan.' });
      }
    }
  );

  // 8b. Employee Self-Service: Record / Update Own Face Reference Profile from Employee Account
  app.post(
    '/api/employee/face-profile',
    requireSession,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const s = req.sessionUser!;
        if (s.role !== 'EMPLOYEE') {
          res.status(403).json({ error: 'Khusus akun Karyawan.' });
          return;
        }

        const descriptorVector = req.body?.descriptorVector;
        const sampleCount = Number(req.body?.sampleCount || 0);
        const qualityScore = Number(req.body?.qualityScore || 0);

        if (
          !Array.isArray(descriptorVector) ||
          descriptorVector.length !== 128 ||
          !descriptorVector.every((v) => typeof v === 'number' && Number.isFinite(v))
        ) {
          res.status(400).json({
            error: 'Data rekam wajah tidak valid. Ulangi pemindaian wajah.',
          });
          return;
        }
        if (sampleCount < 3) {
          res.status(400).json({
            error: 'Rekam wajah memerlukan minimal 3 sampel wajah yang jelas.',
          });
          return;
        }

        const empRef = adminDb.collection('employees').doc(s.employeeId);
        const empSnap = await empRef.get();
        if (!empSnap.exists || empSnap.data()?.isActive === false) {
          res.status(403).json({ error: 'Akun karyawan tidak aktif.' });
          return;
        }

        const settingsSnap = await adminDb.collection('office_settings').doc('main').get();
        const settings = (settingsSnap.data() as OfficeSettings) || DEFAULT_OFFICE_SETTINGS;

        const nowIso = new Date().toISOString();
        const faceRef = adminDb.collection('face_profiles').doc(s.employeeId);
        const existingFace = await faceRef.get();

        if (existingFace.exists) {
          await faceRef.update({
            descriptorVector,
            sampleCount,
            qualityScore,
            encryptionVersion: 'L2-NORM-128D-V1',
            updatedAtIso: nowIso,
            registeredBy: s.username,
          });
        } else {
          await faceRef.set({
            employeeId: s.employeeId,
            descriptorVector,
            sampleCount,
            qualityScore,
            encryptionVersion: 'L2-NORM-128D-V1',
            updatedAtIso: nowIso,
            registeredBy: s.username,
          });
        }

        await empRef.update({
          hasFaceProfile: true,
        });

        await writeAuditLog({
          actorUsername: s.username,
          actorRole: s.role,
          action: 'SELF_REGISTER_FACE_PROFILE',
          targetId: s.employeeId,
          newValueSummary: `${sampleCount} sampel wajah mandiri, skor kualitas ${qualityScore}/100`,
          reason: 'Perekaman referensi wajah mandiri dari akun karyawan',
        });

        res.json({
          ok: true,
          updatedAtIso: nowIso,
          threshold: settings.faceMatchThreshold,
        });
      } catch (err) {
        console.error('Employee self face enroll error:', err);
        res.status(500).json({ error: 'Gagal menyimpan rekaman wajah Anda.' });
      }
    }
  );

  // 9. Submit Attendance (Online Real-Time OR Offline Sync Replay with Idempotency)
  app.post(
    '/api/attendance/submit',
    requireSession,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const s = req.sessionUser!;
        if (s.role !== 'EMPLOYEE') {
          res.status(403).json({
            error: 'Hanya akun Karyawan yang dapat melakukan absensi masuk/pulang.',
          });
          return;
        }

        const transactionId = String(req.body?.transactionId || '').trim();
        if (!/^[a-zA-Z0-9_\-]{8,100}$/.test(transactionId)) {
          res.status(400).json({ error: 'ID Transaksi absensi tidak valid.' });
          return;
        }

        // Idempotency Check: prevent duplicate writes if button tapped repeatedly or retried by sync worker
        const existingTxRef = adminDb.collection('attendance_records').doc(transactionId);
        const existingTxSnap = await existingTxRef.get();
        if (existingTxSnap.exists) {
          const existingRecord = existingTxSnap.data() as AttendanceRecord;
          res.json({
            idempotentReplay: true,
            record: existingRecord,
            syncStatus: existingRecord.syncStatus,
            message: 'Catatan absensi sudah tersimpan sebelumnya di server (idempoten).',
          });
          return;
        }

        const empSnap = await adminDb.collection('employees').doc(s.employeeId).get();
        if (!empSnap.exists || empSnap.data()?.isActive === false) {
          res.status(403).json({ error: 'Profil karyawan tidak aktif atau tidak ditemukan.' });
          return;
        }
        const empData = empSnap.data()!;

        const faceSnap = await adminDb.collection('face_profiles').doc(s.employeeId).get();
        if (!faceSnap.exists) {
          res.status(400).json({
            error: 'Wajah Anda belum direkam. Silakan klik tombol Rekam Wajah pada halaman Absen terlebih dahulu.',
          });
          return;
        }
        const faceProfile = faceSnap.data()!;

        const settingsSnap = await adminDb.collection('office_settings').doc('main').get();
        const settings = (settingsSnap.data() as OfficeSettings) || DEFAULT_OFFICE_SETTINGS;

        const type = req.body?.type === 'CHECK_OUT' ? 'CHECK_OUT' : 'CHECK_IN';
        const wasCapturedOffline = Boolean(req.body?.wasCapturedOffline);
        const nowServer = new Date();
        const serverTimestampIso = nowServer.toISOString();

        const deviceTimestampIso = String(req.body?.deviceTimestampIso || serverTimestampIso);
        const gpsTimestampIso = String(req.body?.gpsTimestampIso || deviceTimestampIso);
        const deviceDate = new Date(deviceTimestampIso);
        const gpsDate = new Date(gpsTimestampIso);

        if (Number.isNaN(deviceDate.getTime()) || Number.isNaN(gpsDate.getTime())) {
          res.status(400).json({ error: 'Format waktu perangkat/GPS tidak valid.' });
          return;
        }

        // Clock manipulation check
        const clockSkewSeconds = Math.round(
          Math.abs(nowServer.getTime() - deviceDate.getTime()) / 1000
        );
        const gpsVsDeviceSkewSec = Math.round(
          Math.abs(deviceDate.getTime() - gpsDate.getTime()) / 1000
        );

        const latitude = Number(req.body?.latitude);
        const longitude = Number(req.body?.longitude);
        const gpsAccuracyMeters = Number(req.body?.gpsAccuracyMeters);
        const clientSuspiciousFlags: string[] = Array.isArray(req.body?.suspiciousLocationFlags)
          ? req.body.suspiciousLocationFlags.map((f: any) => String(f).slice(0, 120)).slice(0, 8)
          : [];

        if (
          Number.isNaN(latitude) ||
          Number.isNaN(longitude) ||
          Number.isNaN(gpsAccuracyMeters) ||
          latitude < -90 ||
          latitude > 90 ||
          longitude < -180 ||
          longitude > 180
        ) {
          res.status(400).json({ error: 'Data koordinat GPS tidak lengkap atau tidak valid.' });
          return;
        }

        // Server-side geodesic distance verification
        const distanceToOfficeMeters = calculateGeodesicDistanceMeters(
          latitude,
          longitude,
          settings.latitude,
          settings.longitude
        );
        const accuracyOk = gpsAccuracyMeters <= settings.maxGpsAccuracyMeters;
        const withinRadius = distanceToOfficeMeters <= settings.radiusMeters;
        const geofenceValid = accuracyOk && withinRadius;

        const suspiciousFlags = [...clientSuspiciousFlags];
        if (gpsVsDeviceSkewSec > 120) {
          suspiciousFlags.push(
            `Selisih jam perangkat vs GPS ${gpsVsDeviceSkewSec} detik`
          );
        }
        if (!wasCapturedOffline && clockSkewSeconds > 180) {
          suspiciousFlags.push(
            `Manipulasi jam perangkat terdeteksi (selisih ${clockSkewSeconds} detik dari jam server)`
          );
        }

        // Server-side Face Descriptor Comparison against stored reference
        const incomingDescriptor: number[] = Array.isArray(req.body?.descriptorVector)
          ? req.body.descriptorVector
          : [];
        let faceMatchScore = 0;
        if (
          incomingDescriptor.length === 128 &&
          Array.isArray(faceProfile.descriptorVector) &&
          faceProfile.descriptorVector.length === 128
        ) {
          faceMatchScore =
            Math.round(
              cosineSimilarity(incomingDescriptor, faceProfile.descriptorVector) * 10000
            ) / 10000;
        }

        const livenessVerified = Boolean(req.body?.livenessVerified);
        const livenessDetail = String(req.body?.livenessDetail || '').slice(0, 200);
        const faceVerified = faceMatchScore >= settings.faceMatchThreshold;
        const borderlineMatch =
          !faceVerified && faceMatchScore >= settings.faceMatchThreshold - 0.05;

        // Effective work date in WIB (uses trusted server time when online; uses device time for offline pending review)
        const effectiveRefDate = wasCapturedOffline ? deviceDate : nowServer;
        const workDateWib = resolveWorkDateWib(
          effectiveRefDate,
          settings.enableNightShift,
          type
        );

        // Check existing attendance records for this employee on workDateWib
        const dayRecordsSnap = await adminDb
          .collection('attendance_records')
          .where('employeeId', '==', s.employeeId)
          .where('workDateWib', '==', workDateWib)
          .get();

        const dayRecords = dayRecordsSnap.docs.map((d) => d.data() as AttendanceRecord);
        const existingValidCheckIn = dayRecords.find(
          (r) =>
            r.type === 'CHECK_IN' &&
            (r.attendanceStatus === 'VALID' ||
              r.attendanceStatus === 'LATE' ||
              (r.attendanceStatus === 'NEEDS_REVIEW' && !r.appealId))
        );
        const existingValidCheckOut = dayRecords.find(
          (r) =>
            r.type === 'CHECK_OUT' &&
            (r.attendanceStatus === 'VALID' ||
              r.attendanceStatus === 'EARLY_LEAVE' ||
              (r.attendanceStatus === 'NEEDS_REVIEW' && !r.appealId))
        );

        let attendanceStatus: AttendanceRecord['attendanceStatus'] = 'VALID';
        let syncStatus: AttendanceRecord['syncStatus'] = 'SYNCED';
        let rejectionReason = '';

        // Strict server-side business rules evaluation
        if (!wasCapturedOffline && clockSkewSeconds > 180) {
          attendanceStatus = 'REJECTED';
          syncStatus = 'REJECTED_SERVER';
          rejectionReason = `Jam perangkat tidak sesuai dengan waktu server (selisih ${Math.round(
            clockSkewSeconds / 60
          )} menit). Aktifkan tanggal & waktu otomatis.`;
        } else if (!livenessVerified) {
          attendanceStatus = 'REJECTED';
          syncStatus = 'REJECTED_SERVER';
          rejectionReason =
            'Deteksi keaslian wajah (Liveness Detection) gagal. Pastikan wajah asli terlihat jelas, bukan foto/layar.';
        } else if (!accuracyOk) {
          attendanceStatus = 'REJECTED';
          syncStatus = 'REJECTED_SERVER';
          rejectionReason = `Akurasi sinyal GPS buruk (±${gpsAccuracyMeters}m, batas maksimal ±${settings.maxGpsAccuracyMeters}m). Tunggu sinyal stabil dan ulangi.`;
        } else if (!withinRadius) {
          attendanceStatus = 'REJECTED';
          syncStatus = 'REJECTED_SERVER';
          rejectionReason = `Lokasi berada di luar radius kantor (${distanceToOfficeMeters}m dari ${settings.officeName}, batas radius ${settings.radiusMeters}m).`;
        } else if (!faceVerified && !borderlineMatch) {
          attendanceStatus = 'REJECTED';
          syncStatus = 'REJECTED_SERVER';
          rejectionReason = `Wajah tidak cocok dengan identitas ${empData.fullName} (skor ${(
            faceMatchScore * 100
          ).toFixed(1)}%, ambang ${(settings.faceMatchThreshold * 100).toFixed(0)}%).`;
        } else if (type === 'CHECK_IN' && existingValidCheckIn) {
          attendanceStatus = 'REJECTED';
          syncStatus = 'REJECTED_SERVER';
          rejectionReason = `Anda sudah tercatat melakukan Absen Masuk pada tanggal kerja ${workDateWib}.`;
        } else if (type === 'CHECK_OUT' && !existingValidCheckIn) {
          attendanceStatus = 'REJECTED';
          syncStatus = 'REJECTED_SERVER';
          rejectionReason = `Tidak dapat Absen Pulang karena belum ada Absen Masuk yang valid pada tanggal kerja ${workDateWib}.`;
        } else if (type === 'CHECK_OUT' && existingValidCheckOut) {
          attendanceStatus = 'REJECTED';
          syncStatus = 'REJECTED_SERVER';
          rejectionReason = `Anda sudah melakukan Absen Pulang pada tanggal kerja ${workDateWib}.`;
        } else if (wasCapturedOffline || borderlineMatch || suspiciousFlags.length > 0) {
          attendanceStatus = 'NEEDS_REVIEW';
          syncStatus = 'NEEDS_ADMIN_REVIEW';
          const reasons: string[] = [];
          if (wasCapturedOffline) {
            reasons.push('Direkam saat perangkat offline — memerlukan pemeriksaan waktu & bukti oleh Admin');
          }
          if (borderlineMatch) {
            reasons.push(
              `Skor kemiripan wajah di batas ambang (${(faceMatchScore * 100).toFixed(1)}%)`
            );
          }
          if (suspiciousFlags.length > 0) {
            reasons.push(`Indikasi anomali lokasi/waktu: ${suspiciousFlags.join('; ')}`);
          }
          rejectionReason = reasons.join(' | ');
        } else {
          // Valid online attendance: evaluate LATE for CHECK_IN and EARLY_LEAVE for CHECK_OUT
          const wibNow = getWibParts(nowServer);
          const nowMins = wibNow.hour * 60 + wibNow.minute;
          const startMins = parseHhMmToMinutes(settings.workStartTime);
          const endMins = parseHhMmToMinutes(settings.workEndTime);

          if (type === 'CHECK_IN') {
            if (nowMins > startMins + settings.lateToleranceMinutes) {
              attendanceStatus = 'LATE';
            } else {
              attendanceStatus = 'VALID';
            }
          } else {
            const isEarlyLeave =
              settings.enableNightShift && endMins < startMins
                ? nowMins >= startMins
                  ? true
                  : nowMins < endMins
                : nowMins < endMins;
            attendanceStatus = isEarlyLeave ? 'EARLY_LEAVE' : 'VALID';
          }
          syncStatus = 'SYNCED';
        }

        const thumbnailDataUrl =
          typeof req.body?.thumbnailDataUrl === 'string' &&
          req.body.thumbnailDataUrl.startsWith('data:image/jpeg;base64,') &&
          req.body.thumbnailDataUrl.length <= 65000
            ? req.body.thumbnailDataUrl
            : '';

        const record: AttendanceRecord = {
          transactionId,
          employeeId: s.employeeId,
          employeeName: empData.fullName,
          type,
          workDateWib,
          serverTimestampIso,
          deviceTimestampIso,
          gpsTimestampIso,
          latitude,
          longitude,
          gpsAccuracyMeters,
          distanceToOfficeMeters,
          geofenceValid,
          suspiciousLocationFlags: suspiciousFlags,
          faceMatchScore,
          faceVerified,
          livenessVerified,
          livenessDetail,
          attendanceStatus,
          syncStatus,
          wasCapturedOffline,
          clockSkewSeconds,
          rejectionReason: rejectionReason || '',
          hasEvidence: Boolean(thumbnailDataUrl),
        };

        await existingTxRef.set(record);

        if (thumbnailDataUrl) {
          const expiresDate = new Date(
            nowServer.getTime() + settings.dataRetentionDays * 24 * 3600 * 1000
          );
          await adminDb.collection('attendance_evidence').doc(transactionId).set({
            transactionId,
            employeeId: s.employeeId,
            thumbnailDataUrl,
            expiresAtIso: expiresDate.toISOString(),
            purpose: 'Bukti audit verifikasi kehadiran karyawan',
            createdAtIso: serverTimestampIso,
          });
        }

        // Record sync event in cloud sync_events table
        const syncEventId = `sync_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        await adminDb.collection('sync_events').doc(syncEventId).set({
          eventId: syncEventId,
          transactionId,
          employeeId: s.employeeId,
          attemptTimestampIso: serverTimestampIso,
          outcome: syncStatus,
          detail:
            rejectionReason ||
            `Absensi ${type === 'CHECK_IN' ? 'Masuk' : 'Pulang'} tersimpan (${attendanceStatus})`,
        });

        if (attendanceStatus === 'REJECTED') {
          res.status(422).json({
            error: rejectionReason,
            record,
            syncStatus,
          });
          return;
        }

        res.status(201).json({
          record,
          syncStatus,
          message:
            attendanceStatus === 'NEEDS_REVIEW'
              ? 'Catatan diterima server dengan status MENUNGGU PEMERIKSAAN ADMIN.'
              : `Absensi ${type === 'CHECK_IN' ? 'Masuk' : 'Pulang'} berhasil divalidasi dan disimpan di server.`,
        });
      } catch (err) {
        console.error('Submit attendance error:', err);
        res.status(500).json({ error: 'Gagal memvalidasi absensi di server.' });
      }
    }
  );

  // 10. Employee: Get ONLY Own Synchronized Attendance & Sanggah History
  app.get(
    '/api/attendance/my-history',
    requireSession,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const s = req.sessionUser!;
        const [attSnap, aplSnap, empSnap, settingsSnap] = await Promise.all([
          adminDb
            .collection('attendance_records')
            .where('employeeId', '==', s.employeeId)
            .get(),
          adminDb
            .collection('attendance_appeals')
            .where('employeeId', '==', s.employeeId)
            .get(),
          adminDb.collection('employees').doc(s.employeeId).get(),
          adminDb.collection('office_settings').doc('main').get(),
        ]);

        const settings =
          (settingsSnap.data() as OfficeSettings) || DEFAULT_OFFICE_SETTINGS;
        let records: AttendanceRecord[] = [];
        attSnap.forEach((doc) => records.push(doc.data() as AttendanceRecord));

        const appeals: AttendanceAppeal[] = [];
        aplSnap.forEach((doc) => appeals.push(doc.data() as AttendanceAppeal));

        const didReconcile = await reconcileUnsyncedAppeals(appeals, records, settings);
        if (didReconcile) {
          const refreshedSnap = await adminDb
            .collection('attendance_records')
            .where('employeeId', '==', s.employeeId)
            .get();
          records = [];
          refreshedSnap.forEach((doc) => records.push(doc.data() as AttendanceRecord));
        }

        records.sort((a, b) =>
          (b.serverTimestampIso || b.deviceTimestampIso).localeCompare(
            a.serverTimestampIso || a.deviceTimestampIso
          )
        );
        appeals.sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso));

        const empList = empSnap.exists ? [empSnap.data() as EmployeeProfile] : [];
        const dailyEntries = buildDailyAttendanceEntries({
          records,
          appeals,
          employees: empList,
          officeSettings: settings,
        });

        res.json({
          records: records.slice(0, 120),
          appeals: appeals.slice(0, 60),
          dailyEntries: dailyEntries.slice(0, 60),
        });
      } catch (err) {
        console.error('My history error:', err);
        res.status(500).json({ error: 'Gagal memuat riwayat absensi Anda.' });
      }
    }
  );

  // 10b. Employee: Submit Sanggah Absen (Field Duty / Late / Early Leave / Missing Checkout)
  app.post(
    '/api/appeals',
    requireSession,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const s = req.sessionUser!;
        if (s.role !== 'EMPLOYEE') {
          res.status(403).json({ error: 'Khusus akun Karyawan.' });
          return;
        }

        const empSnap = await adminDb.collection('employees').doc(s.employeeId).get();
        if (!empSnap.exists || empSnap.data()?.isActive === false) {
          res.status(403).json({ error: 'Akun karyawan tidak aktif.' });
          return;
        }
        const empData = empSnap.data()!;

        const workDateWib = String(req.body?.workDateWib || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(workDateWib)) {
          res.status(400).json({ error: 'Tanggal wajib dipilih.' });
          return;
        }

        const rawScope = String(req.body?.scope || 'FULL_DAY');
        const scope: AppealScope =
          rawScope === 'CHECK_IN' || rawScope === 'CHECK_OUT' ? rawScope : 'FULL_DAY';

        const category = String(req.body?.category || 'Tugas Lapangan')
          .trim()
          .slice(0, 80);
        const reason = String(req.body?.reason || '')
          .trim()
          .slice(0, 500);

        if (category.length < 2 || reason.length < 3) {
          res.status(400).json({ error: 'Isi keterangan sanggah minimal 3 karakter.' });
          return;
        }

        const [existingSnap, settingsSnap] = await Promise.all([
          adminDb
            .collection('attendance_appeals')
            .where('employeeId', '==', s.employeeId)
            .get(),
          adminDb.collection('office_settings').doc('main').get(),
        ]);
        const settings =
          (settingsSnap.data() as OfficeSettings) || DEFAULT_OFFICE_SETTINGS;

        const duplicatePending = existingSnap.docs.some((d) => {
          const a = d.data() as AttendanceAppeal;
          return (
            a.workDateWib === workDateWib &&
            a.status === 'PENDING' &&
            (a.scope === scope || a.scope === 'FULL_DAY' || scope === 'FULL_DAY')
          );
        });
        if (duplicatePending) {
          res.status(409).json({
            error: `Masih ada pengajuan sanggah menunggu persetujuan pada tanggal ${workDateWib}.`,
          });
          return;
        }

        const appealId = `apl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const createdAtIso = new Date().toISOString();

        const appealDoc: AttendanceAppeal = {
          appealId,
          employeeId: s.employeeId,
          employeeName: empData.fullName || s.fullName,
          workDateWib,
          scope,
          category,
          reason,
          status: 'PENDING',
          createdAtIso,
        };

        const lat = Number(req.body?.latitude);
        const lng = Number(req.body?.longitude);
        if (
          Number.isFinite(lat) &&
          Number.isFinite(lng) &&
          lat >= -90 &&
          lat <= 90 &&
          lng >= -180 &&
          lng <= 180
        ) {
          appealDoc.latitude = Math.round(lat * 1000000) / 1000000;
          appealDoc.longitude = Math.round(lng * 1000000) / 1000000;
        }

        await adminDb.collection('attendance_appeals').doc(appealId).set(appealDoc);

        // Immediately synchronize pending Sanggah into attendance_records!
        await syncAppealToAttendanceRecords(appealDoc, settings);

        await writeAuditLog({
          actorUsername: s.username,
          actorRole: s.role,
          action: 'CREATE_APPEAL',
          targetId: appealId,
          newValueSummary: `${workDateWib} (${scope}) - ${category}`,
          reason: reason.slice(0, 280),
        });

        res.status(201).json({ appeal: appealDoc });
      } catch (err) {
        console.error('Create appeal error:', err);
        res.status(500).json({ error: 'Gagal mengirim sanggah absen.' });
      }
    }
  );

  // 10c. Employee: Get Own Sanggah Absen List
  app.get(
    '/api/appeals/my',
    requireSession,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const s = req.sessionUser!;
        const snap = await adminDb
          .collection('attendance_appeals')
          .where('employeeId', '==', s.employeeId)
          .get();

        const appeals: AttendanceAppeal[] = [];
        snap.forEach((doc) => appeals.push(doc.data() as AttendanceAppeal));
        appeals.sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso));

        res.json({ appeals: appeals.slice(0, 60) });
      } catch (err) {
        console.error('My appeals error:', err);
        res.status(500).json({ error: 'Gagal memuat daftar sanggah.' });
      }
    }
  );

  // 10d. Admin: List All Sanggah Absen
  app.get(
    '/api/admin/appeals',
    requireSession,
    requireAdmin,
    async (_req: AuthenticatedRequest, res: Response) => {
      try {
        const snap = await adminDb.collection('attendance_appeals').get();
        const appeals: AttendanceAppeal[] = [];
        snap.forEach((doc) => appeals.push(doc.data() as AttendanceAppeal));
        appeals.sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso));

        res.json({ appeals: appeals.slice(0, 200) });
      } catch (err) {
        console.error('Admin appeals error:', err);
        res.status(500).json({ error: 'Gagal memuat daftar sanggah absen.' });
      }
    }
  );

  // 10e. Admin: Approve or Reject Sanggah Absen (Synchronizes attendance_records in both cases)
  app.post(
    '/api/admin/appeals/:appealId/review',
    requireSession,
    requireAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const s = req.sessionUser!;
        const appealId = String(req.params.appealId);
        const decision = String(req.body?.decision || ''); // 'APPROVE' | 'REJECT'
        if (decision !== 'APPROVE' && decision !== 'REJECT') {
          res.status(400).json({ error: 'Keputusan tidak valid.' });
          return;
        }

        const [appealSnap, settingsSnap] = await Promise.all([
          adminDb.collection('attendance_appeals').doc(appealId).get(),
          adminDb.collection('office_settings').doc('main').get(),
        ]);

        if (!appealSnap.exists) {
          res.status(404).json({ error: 'Data sanggah tidak ditemukan.' });
          return;
        }

        const settings =
          (settingsSnap.data() as OfficeSettings) || DEFAULT_OFFICE_SETTINGS;
        const appeal = appealSnap.data() as AttendanceAppeal;
        const nowIso = new Date().toISOString();
        const rawNote = String(req.body?.reviewNote || '').trim();
        const reviewNote = (
          rawNote || (decision === 'APPROVE' ? 'Disetujui Admin' : 'Ditolak Admin')
        ).slice(0, 280);
        const nextStatus: AttendanceAppeal['status'] =
          decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';

        await adminDb.collection('attendance_appeals').doc(appealId).update({
          status: nextStatus,
          reviewedBy: s.username,
          reviewNote,
          reviewedAtIso: nowIso,
        });

        const updatedAppeal: AttendanceAppeal = {
          ...appeal,
          status: nextStatus,
          reviewedBy: s.username,
          reviewNote,
          reviewedAtIso: nowIso,
        };

        await syncAppealToAttendanceRecords(updatedAppeal, settings);

        await writeAuditLog({
          actorUsername: s.username,
          actorRole: s.role,
          action: 'REVIEW_APPEAL',
          targetId: appealId,
          previousValueSummary: `status=${appeal.status}`,
          newValueSummary: `status=${nextStatus} (${appeal.employeeName} · ${appeal.workDateWib})`,
          reason: reviewNote,
        });

        res.json({ ok: true, status: nextStatus });
      } catch (err) {
        console.error('Review appeal error:', err);
        res.status(500).json({ error: 'Gagal memproses keputusan sanggah.' });
      }
    }
  );

  // 11. Admin: Synchronized Dashboard Summary, Daily Attendance Entries & Raw Records
  app.get(
    '/api/admin/attendance',
    requireSession,
    requireAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const dateFilter = String(req.query.date || '').trim();
        const search = String(req.query.search || '').trim().toLowerCase();

        const [attSnap, empSnap, settingsSnap, appealSnap] = await Promise.all([
          adminDb.collection('attendance_records').get(),
          adminDb.collection('employees').get(),
          adminDb.collection('office_settings').doc('main').get(),
          adminDb.collection('attendance_appeals').get(),
        ]);

        const settings =
          (settingsSnap.data() as OfficeSettings) || DEFAULT_OFFICE_SETTINGS;

        let allRecords: AttendanceRecord[] = [];
        attSnap.forEach((d) => allRecords.push(d.data() as AttendanceRecord));

        const allAppeals: AttendanceAppeal[] = [];
        appealSnap.forEach((d) => allAppeals.push(d.data() as AttendanceAppeal));

        const didReconcile = await reconcileUnsyncedAppeals(
          allAppeals,
          allRecords,
          settings
        );
        if (didReconcile) {
          const refreshed = await adminDb.collection('attendance_records').get();
          allRecords = [];
          refreshed.forEach((d) => allRecords.push(d.data() as AttendanceRecord));
        }

        allRecords.sort((a, b) =>
          (b.serverTimestampIso || b.deviceTimestampIso).localeCompare(
            a.serverTimestampIso || a.deviceTimestampIso
          )
        );
        allAppeals.sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso));

        const allEmployees = empSnap.docs.map((d) => d.data() as EmployeeProfile);
        const activeEmployees = allEmployees.filter((e) => e.isActive !== false);

        const todayWib = getWibParts(new Date()).dateStr;
        const targetSummaryDate =
          dateFilter && dateFilter !== 'ALL' ? dateFilter : todayWib;

        // Build daily entries for summary date to compute 100% synced KPI counters
        const summaryDailyEntries = buildDailyAttendanceEntries({
          records: allRecords.filter((r) => r.workDateWib === targetSummaryDate),
          appeals: allAppeals.filter((a) => a.workDateWib === targetSummaryDate),
          employees: activeEmployees,
          officeSettings: settings,
          includeAbsentEmployeesForDate: targetSummaryDate,
        });

        const presentCount = summaryDailyEntries.filter(
          (d) =>
            d.overallStatus === 'HADIR_LENGKAP' ||
            d.overallStatus === 'SUDAH_MASUK' ||
            d.overallStatus === 'HADIR_SANGGAH' ||
            d.overallStatus === 'TERLAMBAT' ||
            d.overallStatus === 'PULANG_CEPAT'
        ).length;
        const lateCount = summaryDailyEntries.filter(
          (d) => d.overallStatus === 'TERLAMBAT'
        ).length;
        const approvedAppealTodayCount = summaryDailyEntries.filter(
          (d) =>
            d.overallStatus === 'HADIR_SANGGAH' ||
            d.linkedAppeal?.status === 'APPROVED'
        ).length;

        const pendingAppealCount = allAppeals.filter(
          (a) => a.status === 'PENDING'
        ).length;
        const pendingReviewCount = allRecords.filter(
          (r) => r.attendanceStatus === 'NEEDS_REVIEW' && !r.appealId
        ).length;

        // Build displayed daily entries & records based on dateFilter
        const isSingleDate = Boolean(dateFilter && dateFilter !== 'ALL');
        const recordsForView = isSingleDate
          ? allRecords.filter((r) => r.workDateWib === dateFilter)
          : allRecords;
        const appealsForView = isSingleDate
          ? allAppeals.filter((a) => a.workDateWib === dateFilter)
          : allAppeals;

        let dailyEntries = buildDailyAttendanceEntries({
          records: recordsForView,
          appeals: appealsForView,
          employees: activeEmployees,
          officeSettings: settings,
          includeAbsentEmployeesForDate: isSingleDate ? dateFilter : undefined,
        });

        if (search) {
          dailyEntries = dailyEntries.filter(
            (d) =>
              d.employeeName.toLowerCase().includes(search) ||
              d.employeeId.toLowerCase().includes(search) ||
              d.notes.toLowerCase().includes(search)
          );
        }

        const filteredRecords = recordsForView.filter((r) => {
          if (!search) return true;
          return (
            r.employeeName.toLowerCase().includes(search) ||
            r.employeeId.toLowerCase().includes(search)
          );
        });

        res.json({
          summary: {
            dateWib: targetSummaryDate,
            totalEmployees: activeEmployees.length,
            presentCount,
            lateCount,
            approvedAppealTodayCount,
            absentCount: Math.max(0, activeEmployees.length - presentCount),
            pendingReviewCount,
            pendingAppealCount,
          },
          officeSettings: settings,
          dailyEntries: dailyEntries.slice(0, 300),
          records: filteredRecords.slice(0, 300),
          appeals: allAppeals.slice(0, 200),
        });
      } catch (err) {
        console.error('Admin attendance list error:', err);
        res.status(500).json({ error: 'Gagal memuat rekap absensi admin.' });
      }
    }
  );

  // 11b. Admin: Export Synchronized Attendance Recap to Real Excel (.xlsx)
  app.get(
    '/api/admin/attendance/export-excel',
    requireSession,
    requireAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const s = req.sessionUser!;
        const dateFilter = String(req.query.date || '').trim();
        const search = String(req.query.search || '').trim().toLowerCase();
        const format = String(req.query.format || '').trim().toLowerCase();

        const [attSnap, empSnap, settingsSnap, appealSnap] = await Promise.all([
          adminDb.collection('attendance_records').get(),
          adminDb.collection('employees').get(),
          adminDb.collection('office_settings').doc('main').get(),
          adminDb.collection('attendance_appeals').get(),
        ]);

        const settings =
          (settingsSnap.data() as OfficeSettings) || DEFAULT_OFFICE_SETTINGS;
        const employees = empSnap.docs
          .map((d) => d.data() as EmployeeProfile)
          .filter((e) => e.isActive !== false);

        const allRecords = attSnap.docs.map((d) => d.data() as AttendanceRecord);
        const allAppeals = appealSnap.docs.map((d) => d.data() as AttendanceAppeal);

        const isSingleDate = Boolean(dateFilter && dateFilter !== 'ALL');
        const records = isSingleDate
          ? allRecords.filter((r) => r.workDateWib === dateFilter)
          : allRecords;
        const appeals = isSingleDate
          ? allAppeals.filter((a) => a.workDateWib === dateFilter)
          : allAppeals;

        let dailyEntries = buildDailyAttendanceEntries({
          records,
          appeals,
          employees,
          officeSettings: settings,
          includeAbsentEmployeesForDate: isSingleDate ? dateFilter : undefined,
        });

        if (search) {
          dailyEntries = dailyEntries.filter(
            (d) =>
              d.employeeName.toLowerCase().includes(search) ||
              d.employeeId.toLowerCase().includes(search)
          );
        }

        const summaryRows = computeSummaryRows(employees, dailyEntries);
        const periodLabel = isSingleDate ? `Tanggal ${dateFilter}` : 'Semua Riwayat Absensi';
        const fileName = `Rekap-Absensi-${isSingleDate ? dateFilter : getWibParts().dateStr}.xlsx`;

        const xlsxBuffer = await buildAttendanceExcelBuffer({
          reportTitle: 'Rekapitulasi Absensi & Sanggah Karyawan',
          periodLabel,
          officeSettings: settings,
          employees,
          summaryRows,
          dailyEntries,
          appeals,
          records,
        });

        await writeAuditLog({
          actorUsername: s.username,
          actorRole: s.role,
          action: 'EXPORT_ATTENDANCE_EXCEL',
          targetId: isSingleDate ? dateFilter : 'ALL',
          reason: `Unduh rekap absensi format Excel (${fileName})`,
        });

        if (format === 'json') {
          res.json({
            fileName,
            mimeType:
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            base64: xlsxBuffer.toString('base64'),
          });
          return;
        }

        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${fileName}"`
        );
        res.send(xlsxBuffer);
      } catch (err) {
        console.error('Export attendance excel error:', err);
        res.status(500).json({ error: 'Gagal membuat file Excel rekap absensi.' });
      }
    }
  );

  // Admin: Inspect specific attendance evidence thumbnail
  app.get(
    '/api/admin/attendance/:transactionId/evidence',
    requireSession,
    requireAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const s = req.sessionUser!;
        const txId = String(req.params.transactionId);
        const evSnap = await adminDb.collection('attendance_evidence').doc(txId).get();
        if (!evSnap.exists) {
          res.status(404).json({ error: 'Bukti foto tidak tersedia untuk catatan ini.' });
          return;
        }
        await writeAuditLog({
          actorUsername: s.username,
          actorRole: s.role,
          action: 'VIEW_ATTENDANCE_EVIDENCE',
          targetId: txId,
          reason: 'Pemeriksaan bukti verifikasi wajah oleh Admin',
        });
        res.json({ evidence: evSnap.data() });
      } catch (err) {
        console.error('Evidence fetch error:', err);
        res.status(500).json({ error: 'Gagal mengambil bukti absensi.' });
      }
    }
  );

  // Admin: Approve or Reject NEEDS_REVIEW attendance record (Bidirectionally syncs linked Sanggah if present!)
  app.post(
    '/api/admin/attendance/:transactionId/review',
    requireSession,
    requireAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const s = req.sessionUser!;
        const txId = String(req.params.transactionId);
        const decision = req.body?.decision; // 'APPROVE_VALID' | 'APPROVE_LATE' | 'REJECT'
        const rawReason = String(req.body?.reason || '').trim();
        const reason = (
          rawReason || (decision === 'REJECT' ? 'Ditolak Admin' : 'Disetujui Admin')
        ).slice(0, 280);

        if (!['APPROVE_VALID', 'APPROVE_LATE', 'REJECT'].includes(decision)) {
          res.status(400).json({ error: 'Keputusan review tidak valid.' });
          return;
        }

        const txRef = adminDb.collection('attendance_records').doc(txId);
        const txSnap = await txRef.get();
        if (!txSnap.exists) {
          res.status(404).json({ error: 'Catatan absensi tidak ditemukan.' });
          return;
        }

        const prev = txSnap.data() as AttendanceRecord;
        const nowIso = new Date().toISOString();

        // If this attendance record is linked to an AttendanceAppeal, keep both synchronized!
        if (prev.appealId) {
          const aplRef = adminDb.collection('attendance_appeals').doc(prev.appealId);
          const aplSnap = await aplRef.get();
          if (aplSnap.exists) {
            const settingsSnap = await adminDb.collection('office_settings').doc('main').get();
            const settings =
              (settingsSnap.data() as OfficeSettings) || DEFAULT_OFFICE_SETTINGS;
            const apl = aplSnap.data() as AttendanceAppeal;
            const nextAplStatus: AttendanceAppeal['status'] =
              decision === 'REJECT' ? 'REJECTED' : 'APPROVED';
            await aplRef.update({
              status: nextAplStatus,
              reviewedBy: s.username,
              reviewNote: reason,
              reviewedAtIso: nowIso,
            });
            await syncAppealToAttendanceRecords(
              {
                ...apl,
                status: nextAplStatus,
                reviewedBy: s.username,
                reviewNote: reason,
                reviewedAtIso: nowIso,
              },
              settings
            );
          }
        }

        const nextStatus: AttendanceRecord['attendanceStatus'] =
          decision === 'APPROVE_VALID'
            ? 'VALID'
            : decision === 'APPROVE_LATE'
            ? 'LATE'
            : 'REJECTED';
        const nextSyncStatus: AttendanceRecord['syncStatus'] =
          decision === 'REJECT' ? 'REJECTED_SERVER' : 'SYNCED';

        if (!prev.appealId) {
          await txRef.update({
            attendanceStatus: nextStatus,
            syncStatus: nextSyncStatus,
            reviewedBy: s.username,
            reviewNote: reason,
            reviewedAtIso: nowIso,
          });
        }

        await writeAuditLog({
          actorUsername: s.username,
          actorRole: s.role,
          action: 'REVIEW_ATTENDANCE_RECORD',
          targetId: txId,
          previousValueSummary: `status=${prev.attendanceStatus}, sync=${prev.syncStatus}`,
          newValueSummary: `status=${nextStatus}, sync=${nextSyncStatus}`,
          reason,
        });

        res.json({
          ok: true,
          attendanceStatus: nextStatus,
          syncStatus: nextSyncStatus,
          reviewedBy: s.username,
          reviewedAtIso: nowIso,
        });
      } catch (err) {
        console.error('Review record error:', err);
        res.status(500).json({ error: 'Gagal menyimpan keputusan pemeriksaan.' });
      }
    }
  );

  // Admin: Fetch Audit Logs & Sync Events
  app.get(
    '/api/admin/audit-logs',
    requireSession,
    requireAdmin,
    async (_req: AuthenticatedRequest, res: Response) => {
      try {
        const [auditSnap, syncSnap] = await Promise.all([
          adminDb.collection('audit_logs').get(),
          adminDb.collection('sync_events').get(),
        ]);
        const auditLogs: AuditLogRecord[] = [];
        auditSnap.forEach((d) => auditLogs.push(d.data() as AuditLogRecord));
        auditLogs.sort((a, b) => b.timestampIso.localeCompare(a.timestampIso));

        const syncEvents: any[] = [];
        syncSnap.forEach((d) => syncEvents.push(d.data()));
        syncEvents.sort((a, b) => b.attemptTimestampIso.localeCompare(a.attemptTimestampIso));

        res.json({
          auditLogs: auditLogs.slice(0, 150),
          syncEvents: syncEvents.slice(0, 150),
        });
      } catch (err) {
        console.error('Audit logs error:', err);
        res.status(500).json({ error: 'Gagal memuat riwayat aktivitas audit.' });
      }
    }
  );

  // Admin: Cloud Backup Export & Validated Restore + Data Retention Cleanup
  app.get(
    '/api/admin/backup/export',
    requireSession,
    requireAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const s = req.sessionUser!;
        const [empSnap, settingsSnap, attSnap, appealSnap, syncSnap, auditSnap] =
          await Promise.all([
            adminDb.collection('employees').get(),
            adminDb.collection('office_settings').get(),
            adminDb.collection('attendance_records').get(),
            adminDb.collection('attendance_appeals').get(),
            adminDb.collection('sync_events').get(),
            adminDb.collection('audit_logs').get(),
          ]);

        await writeAuditLog({
          actorUsername: s.username,
          actorRole: s.role,
          action: 'EXPORT_CLOUD_BACKUP',
          targetId: 'firestore_full_snapshot',
          reason: 'Unduh cadangan data cloud oleh Admin',
        });

        res.json({
          backupVersion: '1.1',
          exportedAtIso: new Date().toISOString(),
          projectId: 'instant-run-404214',
          employees: empSnap.docs.map((d) => d.data()),
          officeSettings: settingsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
          attendanceRecords: attSnap.docs.map((d) => d.data()),
          attendanceAppeals: appealSnap.docs.map((d) => d.data()),
          syncEvents: syncSnap.docs.map((d) => d.data()),
          auditLogs: auditSnap.docs.map((d) => d.data()),
        });
      } catch (err) {
        console.error('Export backup error:', err);
        res.status(500).json({ error: 'Gagal mengekspor cadangan database cloud.' });
      }
    }
  );

  app.post(
    '/api/admin/backup/restore',
    requireSession,
    requireAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const s = req.sessionUser!;
        const payload = req.body;
        if (!payload || !Array.isArray(payload.attendanceRecords)) {
          res.status(400).json({ error: 'Format file cadangan tidak valid.' });
          return;
        }

        let restoredCount = 0;
        for (const rec of payload.attendanceRecords) {
          if (rec && typeof rec.transactionId === 'string') {
            const created = await adminDb
              .collection('attendance_records')
              .doc(rec.transactionId)
              .createIfAbsent(rec);
            if (created) restoredCount++;
          }
        }
        if (Array.isArray(payload.attendanceAppeals)) {
          for (const apl of payload.attendanceAppeals) {
            if (apl && typeof apl.appealId === 'string') {
              await adminDb
                .collection('attendance_appeals')
                .doc(apl.appealId)
                .createIfAbsent(apl);
            }
          }
        }
        if (Array.isArray(payload.employees)) {
          for (const emp of payload.employees) {
            if (emp && typeof emp.employeeId === 'string') {
              await adminDb
                .collection('employees')
                .doc(emp.employeeId)
                .createIfAbsent(emp);
            }
          }
        }

        await writeAuditLog({
          actorUsername: s.username,
          actorRole: s.role,
          action: 'RESTORE_CLOUD_BACKUP',
          targetId: 'firestore_restore',
          newValueSummary: `Memulihkan ${restoredCount} catatan absensi`,
          reason: 'Pemulihan (restore) data cadangan cloud oleh Admin',
        });

        res.json({ ok: true, restoredCount });
      } catch (err) {
        console.error('Restore backup error:', err);
        res.status(500).json({ error: 'Gagal memulihkan cadangan database.' });
      }
    }
  );

  // Admin: Monthly Recap Report Data (Synchronized Attendance + Sanggah)
  app.get(
    '/api/admin/monthly-report',
    requireSession,
    requireAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const wibNow = getWibParts(new Date());
        const period = String(req.query.period || wibNow.monthPeriod); // YYYY-MM
        if (!/^\d{4}-\d{2}$/.test(period)) {
          res.status(400).json({ error: 'Format periode bulan harus YYYY-MM.' });
          return;
        }

        const [empSnap, attSnap, appealSnap, settingsSnap] = await Promise.all([
          adminDb.collection('employees').get(),
          adminDb.collection('attendance_records').get(),
          adminDb.collection('attendance_appeals').get(),
          adminDb.collection('office_settings').doc('main').get(),
        ]);

        const settings = (settingsSnap.data() as OfficeSettings) || DEFAULT_OFFICE_SETTINGS;
        const employees = empSnap.docs.map((d) => d.data() as EmployeeProfile);

        let monthRecords = attSnap.docs
          .map((d) => d.data() as AttendanceRecord)
          .filter((r) => r.workDateWib.startsWith(period));
        const monthAppeals = appealSnap.docs
          .map((d) => d.data() as AttendanceAppeal)
          .filter((a) => a.workDateWib.startsWith(period));

        const didReconcile = await reconcileUnsyncedAppeals(
          monthAppeals,
          monthRecords,
          settings
        );
        if (didReconcile) {
          const refreshed = await adminDb.collection('attendance_records').get();
          monthRecords = refreshed.docs
            .map((d) => d.data() as AttendanceRecord)
            .filter((r) => r.workDateWib.startsWith(period));
        }

        const dailyEntries = buildDailyAttendanceEntries({
          records: monthRecords,
          appeals: monthAppeals,
          employees,
          officeSettings: settings,
        });

        const rows = computeSummaryRows(employees, dailyEntries);

        const [yr, mo] = period.split('-').map(Number);
        const lastDayOfMonth = new Date(yr, mo, 0).getDate();
        const isEndOfMonthWindow =
          period === wibNow.monthPeriod && Number(wibNow.day) >= lastDayOfMonth - 2;
        const alreadySentForPeriod = settings.lastMonthlyReportPeriod === period;

        res.json({
          period,
          officeName: settings.officeName,
          adminReportEmail: settings.adminReportEmail,
          autoMonthlyReportEnabled: settings.autoMonthlyReportEnabled,
          alreadySentForPeriod,
          isEndOfMonthWindow,
          lastDayOfMonth,
          rows,
          dailyEntries,
          totalRecordsInMonth: monthRecords.length,
          totalAppealsInMonth: monthAppeals.length,
        });
      } catch (err) {
        console.error('Monthly report error:', err);
        res.status(500).json({ error: 'Gagal menyusun laporan rekapitulasi bulanan.' });
      }
    }
  );

  // Admin: Download Monthly Recap as Real Excel (.xlsx)
  app.get(
    '/api/admin/monthly-report/export-excel',
    requireSession,
    requireAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const s = req.sessionUser!;
        const wibNow = getWibParts(new Date());
        const period = String(req.query.period || wibNow.monthPeriod);
        const format = String(req.query.format || '').trim().toLowerCase();

        if (!/^\d{4}-\d{2}$/.test(period)) {
          res.status(400).json({ error: 'Format periode bulan harus YYYY-MM.' });
          return;
        }

        const [empSnap, attSnap, appealSnap, settingsSnap] = await Promise.all([
          adminDb.collection('employees').get(),
          adminDb.collection('attendance_records').get(),
          adminDb.collection('attendance_appeals').get(),
          adminDb.collection('office_settings').doc('main').get(),
        ]);

        const settings = (settingsSnap.data() as OfficeSettings) || DEFAULT_OFFICE_SETTINGS;
        const employees = empSnap.docs.map((d) => d.data() as EmployeeProfile);
        const monthRecords = attSnap.docs
          .map((d) => d.data() as AttendanceRecord)
          .filter((r) => r.workDateWib.startsWith(period));
        const monthAppeals = appealSnap.docs
          .map((d) => d.data() as AttendanceAppeal)
          .filter((a) => a.workDateWib.startsWith(period));

        const dailyEntries = buildDailyAttendanceEntries({
          records: monthRecords,
          appeals: monthAppeals,
          employees,
          officeSettings: settings,
        });
        const summaryRows = computeSummaryRows(employees, dailyEntries);
        const fileName = `Rekap-Absensi-Bulanan-${period}.xlsx`;

        const xlsxBuffer = await buildAttendanceExcelBuffer({
          reportTitle: `Rekapitulasi Absensi Bulanan (${period})`,
          periodLabel: `Bulan ${period}`,
          officeSettings: settings,
          employees,
          summaryRows,
          dailyEntries,
          appeals: monthAppeals,
          records: monthRecords,
        });

        await writeAuditLog({
          actorUsername: s.username,
          actorRole: s.role,
          action: 'EXPORT_MONTHLY_EXCEL',
          targetId: period,
          reason: `Unduh rekap bulanan Excel (${fileName})`,
        });

        if (format === 'json') {
          res.json({
            fileName,
            mimeType:
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            base64: xlsxBuffer.toString('base64'),
          });
          return;
        }

        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${fileName}"`
        );
        res.send(xlsxBuffer);
      } catch (err) {
        console.error('Monthly excel export error:', err);
        res.status(500).json({ error: 'Gagal mengunduh file Excel bulanan.' });
      }
    }
  );

  // Admin: Send Monthly Recap Email with Excel (.xlsx) Attachment via Gmail API
  app.post(
    '/api/admin/monthly-report/send-email',
    requireSession,
    requireAdmin,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const s = req.sessionUser!;
        const gmailAccessToken = String(req.body?.gmailAccessToken || '').trim();
        const period = String(req.body?.period || '').trim();
        const recipientEmail = String(req.body?.recipientEmail || '').trim();
        const triggerMode = String(req.body?.triggerMode || 'MANUAL');

        if (!gmailAccessToken) {
          res.status(400).json({
            error: 'Token akses Gmail belum aktif. Hubungkan akun Google Admin terlebih dahulu.',
          });
          return;
        }
        if (!/^\d{4}-\d{2}$/.test(period) || !recipientEmail.includes('@')) {
          res.status(400).json({ error: 'Periode laporan atau alamat email tujuan tidak valid.' });
          return;
        }

        const [empSnap, attSnap, appealSnap, settingsSnap] = await Promise.all([
          adminDb.collection('employees').get(),
          adminDb.collection('attendance_records').get(),
          adminDb.collection('attendance_appeals').get(),
          adminDb.collection('office_settings').doc('main').get(),
        ]);

        const settings = (settingsSnap.data() as OfficeSettings) || DEFAULT_OFFICE_SETTINGS;
        const employees = empSnap.docs.map((d) => d.data() as EmployeeProfile);
        const monthRecords = attSnap.docs
          .map((d) => d.data() as AttendanceRecord)
          .filter((r) => r.workDateWib.startsWith(period));
        const monthAppeals = appealSnap.docs
          .map((d) => d.data() as AttendanceAppeal)
          .filter((a) => a.workDateWib.startsWith(period));

        const dailyEntries = buildDailyAttendanceEntries({
          records: monthRecords,
          appeals: monthAppeals,
          employees,
          officeSettings: settings,
        });
        const summaryRows = computeSummaryRows(employees, dailyEntries);

        const xlsxBuffer = await buildAttendanceExcelBuffer({
          reportTitle: `Rekapitulasi Absensi Bulanan (${period})`,
          periodLabel: `Bulan ${period}`,
          officeSettings: settings,
          employees,
          summaryRows,
          dailyEntries,
          appeals: monthAppeals,
          records: monthRecords,
        });

        const fileName = `Rekap-Absensi-${period}.xlsx`;
        const rawBase64 = xlsxBuffer.toString('base64');
        const wrappedXlsxBase64 = rawBase64.match(/.{1,76}/g)?.join('\r\n') || rawBase64;

        const htmlRows = summaryRows.map(
          (row) => `
            <tr>
              <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-family:monospace;">${row.employeeId}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-weight:600;">${row.fullName}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:700;">${row.totalPresentDays}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:right;color:#15803d;">${row.onTimeDays}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:right;color:#b45309;">${row.lateDays}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:right;color:#0369a1;">${row.approvedAppealDays}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:right;">${row.completedCheckOuts}</td>
            </tr>
          `
        );

        const subject = `[ABSENSI WAJAH & GPS] Rekap Excel Absensi Bulanan ${period} — ${settings.officeName}`;
        const boundary = `absensi_boundary_${Date.now()}`;

        const htmlBody = `
          <div style="font-family:Arial,sans-serif;color:#0f172a;max-width:740px;margin:0 auto;">
            <div style="background:#0F2942;color:#ffffff;padding:20px 24px;border-radius:8px 8px 0 0;">
              <h2 style="margin:0;font-size:18px;">Laporan Rekapitulasi Absensi Bulanan (${period})</h2>
              <p style="margin:6px 0 0;font-size:13px;color:#bae6fd;">${settings.officeName} · Dicetak: ${formatWibDateTime(new Date())}</p>
            </div>
            <div style="border:1px solid #cbd5e1;border-top:none;padding:20px 24px;border-radius:0 0 8px 8px;">
              <p style="font-size:14px;line-height:1.5;">Berikut ringkasan kehadiran karyawan periode <strong>${period}</strong> beserta lampiran <strong>Excel (${fileName})</strong> yang sudah sinkron dengan data Sanggah Absen:</p>
              <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px;">
                <thead>
                  <tr style="background:#f1f5f9;text-align:left;">
                    <th style="padding:8px 12px;border-bottom:2px solid #cbd5e1;">ID</th>
                    <th style="padding:8px 12px;border-bottom:2px solid #cbd5e1;">Nama</th>
                    <th style="padding:8px 12px;border-bottom:2px solid #cbd5e1;text-align:right;">Total Hadir</th>
                    <th style="padding:8px 12px;border-bottom:2px solid #cbd5e1;text-align:right;">Tepat</th>
                    <th style="padding:8px 12px;border-bottom:2px solid #cbd5e1;text-align:right;">Telat</th>
                    <th style="padding:8px 12px;border-bottom:2px solid #cbd5e1;text-align:right;">Sanggah</th>
                    <th style="padding:8px 12px;border-bottom:2px solid #cbd5e1;text-align:right;">Pulang</th>
                  </tr>
                </thead>
                <tbody>
                  ${htmlRows.join('') || '<tr><td colspan="7" style="padding:12px;">Belum ada data karyawan.</td></tr>'}
                </tbody>
              </table>
              <p style="margin-top:18px;font-size:12px;color:#64748b;">Lampiran Excel (.xlsx) mencakup 4 lembar: Rekap Harian Absensi, Ringkasan Karyawan, Data Sanggah Absen, dan Log Transaksi Detail.</p>
            </div>
          </div>
        `;

        const mimeMessage = [
          `To: ${recipientEmail}`,
          `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`,
          'MIME-Version: 1.0',
          `Content-Type: multipart/mixed; boundary="${boundary}"`,
          '',
          `--${boundary}`,
          'Content-Type: text/html; charset="UTF-8"',
          '',
          htmlBody,
          '',
          `--${boundary}`,
          `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; name="${fileName}"`,
          'Content-Transfer-Encoding: base64',
          `Content-Disposition: attachment; filename="${fileName}"`,
          '',
          wrappedXlsxBase64,
          `--${boundary}--`,
        ].join('\r\n');

        const encodedRaw = Buffer.from(mimeMessage, 'utf-8')
          .toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');

        const gmailResp = await fetch(
          'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${gmailAccessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ raw: encodedRaw }),
          }
        );

        const gmailData: any = await gmailResp.json();
        if (!gmailResp.ok) {
          res.status(gmailResp.status).json({
            error:
              gmailData?.error?.message ||
              'Gagal mengirim email melalui Gmail API. Pastikan izin Gmail aktif.',
          });
          return;
        }

        await adminDb.collection('office_settings').doc('main').update({
          lastMonthlyReportPeriod: period,
          updatedAtIso: new Date().toISOString(),
        });

        await writeAuditLog({
          actorUsername: s.username,
          actorRole: s.role,
          action: 'SEND_MONTHLY_REPORT_EMAIL',
          targetId: period,
          newValueSummary: `Excel ${fileName} terkirim ke ${recipientEmail} (Message ID: ${gmailData.id})`,
          reason:
            triggerMode === 'AUTO_EOM'
              ? `Pengiriman otomatis rekapitulasi Excel akhir bulan ${period}`
              : `Pengiriman laporan rekapitulasi Excel bulanan ${period} oleh Admin`,
        });

        res.json({
          ok: true,
          messageId: gmailData.id,
          sentTo: recipientEmail,
          period,
        });
      } catch (err) {
        console.error('Send monthly email error:', err);
        res.status(500).json({ error: 'Terjadi kesalahan saat mengirim laporan email.' });
      }
    }
  );

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Endpoint API tidak ditemukan.' });
  });

  return app;
}

async function startServer() {
  const app = createApiApp();
  const httpServer = http.createServer(app);

  // Vite middleware for dev OR static dist serving for production
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: { server: httpServer },
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`ABSENSI WAJAH & GPS server running on http://0.0.0.0:${PORT}`);
  });
}

const isServerlessRuntime = Boolean(
  process.env.NETLIFY ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.LAMBDA_TASK_ROOT
);

if (!isServerlessRuntime) {
  startServer();
}
