export type UserRole = 'ADMIN' | 'EMPLOYEE';

export interface AuthSessionUser {
  username: string;
  role: UserRole;
  employeeId: string;
  fullName: string;
  position: string;
  hasFaceProfile: boolean;
  consentAccepted: boolean;
  email?: string;
}

export interface OfficeSettings {
  officeName: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  maxGpsAccuracyMeters: number;
  workStartTime: string; // HH:mm WIB
  workEndTime: string;   // HH:mm WIB
  lateToleranceMinutes: number;
  faceMatchThreshold: number;
  enableNightShift: boolean;
  adminReportEmail: string;
  autoMonthlyReportEnabled: boolean;
  lastMonthlyReportPeriod?: string; // YYYY-MM
  dataRetentionDays: number;
  updatedAtIso: string;
}

export interface EmployeeProfile {
  employeeId: string;
  fullName: string;
  username: string;
  position: string;
  hasFaceProfile: boolean;
  consentAccepted: boolean;
  consentTimestampIso?: string;
  isActive: boolean;
  createdAtIso: string;
  faceSampleCount?: number;
  faceQualityScore?: number;
  faceUpdatedAtIso?: string;
}

export type AttendanceType = 'CHECK_IN' | 'CHECK_OUT';

export type AttendanceStatus =
  | 'VALID'
  | 'LATE'
  | 'EARLY_LEAVE'
  | 'REJECTED'
  | 'NEEDS_REVIEW'
  | 'PENDING_OFFLINE';

export type LocalSyncStatus =
  | 'WAITING_SYNC'
  | 'SENDING'
  | 'SYNCED'
  | 'REJECTED_SERVER'
  | 'NEEDS_ADMIN_REVIEW';

export interface AttendanceRecord {
  transactionId: string;
  employeeId: string;
  employeeName: string;
  type: AttendanceType;
  workDateWib: string; // YYYY-MM-DD
  serverTimestampIso?: string;
  deviceTimestampIso: string;
  gpsTimestampIso: string;
  latitude: number;
  longitude: number;
  gpsAccuracyMeters: number;
  distanceToOfficeMeters: number;
  geofenceValid: boolean;
  suspiciousLocationFlags: string[];
  faceMatchScore: number;
  faceVerified: boolean;
  livenessVerified: boolean;
  livenessDetail: string;
  attendanceStatus: AttendanceStatus;
  syncStatus: LocalSyncStatus;
  wasCapturedOffline: boolean;
  clockSkewSeconds?: number;
  rejectionReason?: string;
  reviewedBy?: string;
  reviewNote?: string;
  reviewedAtIso?: string;
  hasEvidence?: boolean;
  appealId?: string;
  appealStatus?: AppealStatus;
  appealCategory?: string;
}

export type AppealScope = 'FULL_DAY' | 'CHECK_IN' | 'CHECK_OUT';
export type AppealStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface AttendanceAppeal {
  appealId: string;
  employeeId: string;
  employeeName: string;
  workDateWib: string; // YYYY-MM-DD
  scope: AppealScope;
  category: string;
  reason: string;
  latitude?: number;
  longitude?: number;
  status: AppealStatus;
  createdAtIso: string;
  reviewedBy?: string;
  reviewNote?: string;
  reviewedAtIso?: string;
}

export type DailyOverallStatus =
  | 'HADIR_LENGKAP'
  | 'SUDAH_MASUK'
  | 'HADIR_SANGGAH'
  | 'TERLAMBAT'
  | 'PULANG_CEPAT'
  | 'MENUNGGU_SANGGAH'
  | 'MENUNGGU_REVIEW'
  | 'DITOLAK'
  | 'BELUM_HADIR';

export interface DailyAttendanceEntry {
  key: string;
  workDateWib: string;
  employeeId: string;
  employeeName: string;
  position: string;
  overallStatus: DailyOverallStatus;
  overallLabel: string;
  sourceLabel: 'Kamera & GPS' | 'Sanggah Absen' | 'Kamera & Sanggah' | '-';
  checkInTimeWib: string;
  checkInStatusLabel: string;
  checkInRecord?: AttendanceRecord;
  checkOutTimeWib: string;
  checkOutStatusLabel: string;
  checkOutRecord?: AttendanceRecord;
  durationLabel: string;
  locationOrFaceSummary: string;
  notes: string;
  linkedAppeal?: AttendanceAppeal;
}

export interface LocalPendingRecord extends AttendanceRecord {
  descriptorVector?: number[];
  thumbnailDataUrl?: string;
  syncAttempts: number;
  lastSyncAttemptIso?: string;
  lastSyncError?: string;
}

export interface SyncEventRecord {
  eventId: string;
  transactionId: string;
  employeeId: string;
  attemptTimestampIso: string;
  outcome: string;
  detail: string;
}

export interface AuditLogRecord {
  logId: string;
  actorUsername: string;
  actorRole: string;
  action: string;
  targetId: string;
  previousValueSummary?: string;
  newValueSummary?: string;
  reason: string;
  timestampIso: string;
}

export interface GpsReading {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  altitude: number | null;
  altitudeAccuracy: number | null;
  speed: number | null;
  heading: number | null;
  timestampMs: number;
  timestampIso: string;
  suspiciousFlags: string[];
}
