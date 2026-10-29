import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  MapPin,
  Wifi,
  WifiOff,
  ScanFace,
  LogIn,
  LogOut,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Download,
  Upload,
  ShieldCheck,
  FileText,
  Send,
  Camera,
} from 'lucide-react';
import type {
  AppealScope,
  AttendanceAppeal,
  AttendanceRecord,
  AttendanceType,
  AuthSessionUser,
  DailyAttendanceEntry,
  GpsReading,
  LocalPendingRecord,
  OfficeSettings,
} from '../types/attendance';
import { acquireFreshGpsLocation } from '../services/gpsValidator';
import {
  calculateGeodesicDistanceMeters,
  formatWibDateLong,
  formatWibDateTime,
  getWibParts,
} from '../utils/geoAndTime';
import { buildDailyAttendanceEntries } from '../utils/attendanceSyncView';
import {
  appendLocalSyncEvent,
  cacheAttendanceHistoryLocally,
  cacheFaceProfileLocally,
  exportPendingRecordsJson,
  getAllLocalPendingAttendance,
  getCachedAttendanceHistory,
  getCachedFaceProfile,
  getCachedOfficeSettings,
  importPendingRecordsJson,
  saveLocalPendingAttendance,
  updateLocalPendingStatus,
} from '../services/offlineStore';
import { FaceCameraModal, BiometricCaptureResult } from './FaceCameraModal';
import { apiFetch } from '../utils/apiFetchBridge';

interface EmployeeDashboardProps {
  user: AuthSessionUser;
  token: string;
  officeSettings: OfficeSettings | null;
  isOnline: boolean;
  onConsentAccepted: () => void;
  onFaceRegistered: () => void;
}

type EmployeeTab = 'ABSEN' | 'SANGGAH' | 'RIWAYAT';

const APPEAL_CATEGORIES = [
  'Kegiatan di Luar Kantor',
  'Tugas Lapangan',
  'Dinas Luar',
  'Kunjungan Klien',
  'Kendala Teknis / Darurat',
];

function getDailyBadgeClasses(status: DailyAttendanceEntry['overallStatus']): string {
  switch (status) {
    case 'HADIR_LENGKAP':
    case 'SUDAH_MASUK':
      return 'border-emerald-200 bg-emerald-50 text-emerald-800';
    case 'HADIR_SANGGAH':
      return 'border-sky-200 bg-sky-50 text-sky-900';
    case 'TERLAMBAT':
    case 'PULANG_CEPAT':
    case 'MENUNGGU_SANGGAH':
    case 'MENUNGGU_REVIEW':
      return 'border-amber-200 bg-amber-50 text-amber-900';
    case 'DITOLAK':
      return 'border-red-200 bg-red-50 text-red-800';
    default:
      return 'border-slate-200 bg-slate-100 text-slate-700';
  }
}

export const EmployeeDashboard: React.FC<EmployeeDashboardProps> = ({
  user,
  token,
  officeSettings: propSettings,
  isOnline,
  onConsentAccepted,
  onFaceRegistered,
}) => {
  const [activeTab, setActiveTab] = useState<EmployeeTab>('ABSEN');
  const [wibClock, setWibClock] = useState<string>(() =>
    formatWibDateTime(new Date())
  );
  const [settings, setSettings] = useState<OfficeSettings | null>(propSettings);
  const [gpsReading, setGpsReading] = useState<GpsReading | null>(null);
  const [gpsLoading, setGpsLoading] = useState<boolean>(false);
  const [gpsError, setGpsError] = useState<string | null>(null);

  const [history, setHistory] = useState<AttendanceRecord[]>([]);
  const [appeals, setAppeals] = useState<AttendanceAppeal[]>([]);
  const [pendingLocal, setPendingLocal] = useState<LocalPendingRecord[]>([]);
  const [localFaceVector, setLocalFaceVector] = useState<number[] | null>(null);

  const [activeAttendanceType, setActiveAttendanceType] =
    useState<AttendanceType | null>(null);
  const [selfEnrollingFace, setSelfEnrollingFace] = useState<boolean>(false);
  const [savingFace, setSavingFace] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);

  const [feedbackBanner, setFeedbackBanner] = useState<{
    kind: 'success' | 'warning' | 'error';
    title: string;
    detail: string;
    appealAction?: {
      label: string;
      workDateWib: string;
      scope: AppealScope;
      category: string;
      contextHint: string;
    };
    enrollFaceAction?: boolean;
  } | null>(null);

  // Sanggah Absen form state
  const [appealDate, setAppealDate] = useState<string>(
    () => getWibParts(new Date()).dateStr
  );
  const [appealScope, setAppealScope] = useState<AppealScope>('FULL_DAY');
  const [appealCategory, setAppealCategory] = useState<string>(
    'Kegiatan di Luar Kantor'
  );
  const [appealReason, setAppealReason] = useState<string>('');
  const [appealContextHint, setAppealContextHint] = useState<string | null>(null);
  const [submittingAppeal, setSubmittingAppeal] = useState<boolean>(false);

  const [syncingNow, setSyncingNow] = useState<boolean>(false);
  const [consentSubmitting, setConsentSubmitting] = useState<boolean>(false);
  const syncLockRef = useRef<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const reasonTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      setWibClock(formatWibDateTime(new Date()));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (propSettings) {
      setSettings(propSettings);
    } else {
      getCachedOfficeSettings().then((cached) => {
        if (cached) setSettings(cached);
      });
    }
    getCachedFaceProfile(user.employeeId).then((fp) => {
      if (fp?.descriptorVector?.length === 128) {
        setLocalFaceVector(fp.descriptorVector);
      }
    });
  }, [propSettings, user.employeeId]);

  const loadAttendanceData = useCallback(async () => {
    const localList = await getAllLocalPendingAttendance(user.employeeId);
    setPendingLocal(localList);

    if (isOnline) {
      try {
        const [histResp, aplResp] = await Promise.all([
          apiFetch('/api/attendance/my-history', {
            headers: { Authorization: `Bearer ${token}` },
          }),
          apiFetch('/api/appeals/my', {
            headers: { Authorization: `Bearer ${token}` },
          }),
        ]);

        if (aplResp.ok) {
          const aplData = await aplResp.json();
          setAppeals(aplData.appeals || []);
        }

        if (histResp.ok) {
          const data = await histResp.json();
          const recs: AttendanceRecord[] = data.records || [];
          setHistory(recs);
          if (Array.isArray(data.appeals)) {
            setAppeals(data.appeals);
          }
          await cacheAttendanceHistoryLocally(recs);
          return;
        }
      } catch {
        // Fallback to cached history below
      }
    }
    const cachedHist = await getCachedAttendanceHistory(user.employeeId);
    setHistory(cachedHist);
  }, [isOnline, token, user.employeeId]);

  useEffect(() => {
    loadAttendanceData();
  }, [loadAttendanceData]);

  const refreshGps = useCallback(async () => {
    setGpsLoading(true);
    setGpsError(null);
    try {
      const reading = await acquireFreshGpsLocation(14000);
      setGpsReading(reading);
    } catch (err: any) {
      setGpsError(err?.message || 'Gagal membaca lokasi GPS.');
    } finally {
      setGpsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshGps();
  }, [refreshGps]);

  const openContextualAppeal = useCallback(
    (
      workDateWib: string,
      scope: AppealScope,
      category: string = 'Kegiatan di Luar Kantor',
      hintText?: string
    ) => {
      setAppealDate(workDateWib);
      setAppealScope(scope);
      setAppealCategory(category);
      setAppealContextHint(hintText || null);
      setActiveTab('SANGGAH');
      setTimeout(() => {
        reasonTextareaRef.current?.focus();
      }, 80);
    },
    []
  );

  const handleSelfFaceEnrollSuccess = async (bio: BiometricCaptureResult) => {
    setSelfEnrollingFace(false);
    if (!isOnline) {
      setFeedbackBanner({
        kind: 'error',
        title: 'Perlu Koneksi Internet',
        detail: 'Perekaman referensi wajah harus dilakukan saat perangkat terhubung ke internet.',
      });
      return;
    }

    setSavingFace(true);
    setFeedbackBanner(null);
    try {
      const resp = await apiFetch('/api/employee/face-profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          descriptorVector: bio.descriptorVector,
          sampleCount: bio.sampleCount,
          qualityScore: bio.qualityScore,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setFeedbackBanner({
          kind: 'error',
          title: 'Gagal Menyimpan Wajah',
          detail: data.error || 'Silakan ulangi perekaman wajah di tempat terang.',
        });
        return;
      }

      const threshold = data.threshold || settings?.faceMatchThreshold || 0.84;
      await cacheFaceProfileLocally(user.employeeId, bio.descriptorVector, threshold);
      setLocalFaceVector(bio.descriptorVector);
      onFaceRegistered();

      setFeedbackBanner({
        kind: 'success',
        title: 'Wajah Berhasil Direkam',
        detail: `Referensi wajah akun ${user.fullName} sudah aktif dan siap digunakan untuk Absen Masuk & Pulang.`,
      });
    } catch {
      setFeedbackBanner({
        kind: 'error',
        title: 'Gagal Menyimpan Wajah',
        detail: 'Periksa koneksi internet Anda lalu coba kembali.',
      });
    } finally {
      setSavingFace(false);
    }
  };

  const syncPendingRecords = useCallback(async () => {
    if (!isOnline || syncLockRef.current) return;
    const allLocal = await getAllLocalPendingAttendance(user.employeeId);
    const waiting = allLocal.filter((r) => r.syncStatus === 'WAITING_SYNC');
    if (waiting.length === 0) return;

    syncLockRef.current = true;
    setSyncingNow(true);
    try {
      for (const item of waiting) {
        await updateLocalPendingStatus(item.transactionId, {
          syncStatus: 'SENDING',
          lastSyncAttemptIso: new Date().toISOString(),
        });
        setPendingLocal(await getAllLocalPendingAttendance(user.employeeId));

        try {
          const resp = await apiFetch('/api/attendance/submit', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              transactionId: item.transactionId,
              type: item.type,
              deviceTimestampIso: item.deviceTimestampIso,
              gpsTimestampIso: item.gpsTimestampIso,
              latitude: item.latitude,
              longitude: item.longitude,
              gpsAccuracyMeters: item.gpsAccuracyMeters,
              suspiciousLocationFlags: item.suspiciousLocationFlags,
              descriptorVector: item.descriptorVector,
              livenessVerified: item.livenessVerified,
              livenessDetail: item.livenessDetail,
              thumbnailDataUrl: item.thumbnailDataUrl,
              wasCapturedOffline: true,
            }),
          });

          const data = await resp.json();
          const nowIso = new Date().toISOString();

          if (resp.ok) {
            const finalSyncStatus =
              data.syncStatus === 'NEEDS_ADMIN_REVIEW'
                ? 'NEEDS_ADMIN_REVIEW'
                : 'SYNCED';
            await updateLocalPendingStatus(item.transactionId, {
              syncStatus: finalSyncStatus,
              attendanceStatus: data.record?.attendanceStatus || 'NEEDS_REVIEW',
              serverTimestampIso: data.record?.serverTimestampIso || nowIso,
              syncAttempts: (item.syncAttempts || 0) + 1,
              lastSyncAttemptIso: nowIso,
              lastSyncError: undefined,
            });
            await appendLocalSyncEvent({
              eventId: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              transactionId: item.transactionId,
              employeeId: user.employeeId,
              attemptTimestampIso: nowIso,
              outcome: finalSyncStatus,
              detail: data.message || 'Tersinkronisasi',
            });
          } else if (resp.status >= 400 && resp.status < 500) {
            await updateLocalPendingStatus(item.transactionId, {
              syncStatus: 'REJECTED_SERVER',
              attendanceStatus: 'REJECTED',
              rejectionReason: data.error || 'Ditolak server',
              syncAttempts: (item.syncAttempts || 0) + 1,
              lastSyncAttemptIso: nowIso,
              lastSyncError: data.error,
            });
          } else {
            await updateLocalPendingStatus(item.transactionId, {
              syncStatus: 'WAITING_SYNC',
              syncAttempts: (item.syncAttempts || 0) + 1,
              lastSyncAttemptIso: nowIso,
              lastSyncError: data.error || 'Gangguan sementara',
            });
          }
        } catch (netErr: any) {
          await updateLocalPendingStatus(item.transactionId, {
            syncStatus: 'WAITING_SYNC',
            syncAttempts: (item.syncAttempts || 0) + 1,
            lastSyncAttemptIso: new Date().toISOString(),
            lastSyncError: netErr?.message || 'Koneksi terputus',
          });
        }
      }
      await loadAttendanceData();
    } finally {
      syncLockRef.current = false;
      setSyncingNow(false);
    }
  }, [isOnline, loadAttendanceData, token, user.employeeId]);

  useEffect(() => {
    if (isOnline) {
      syncPendingRecords();
    }
  }, [isOnline, syncPendingRecords]);

  const handleAcceptConsent = async () => {
    setConsentSubmitting(true);
    try {
      const resp = await apiFetch('/api/employee/consent', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) {
        onConsentAccepted();
      }
    } finally {
      setConsentSubmitting(false);
    }
  };

  const initiateAttendance = async (type: AttendanceType) => {
    if (submitting) return;
    setFeedbackBanner(null);

    if (!user.hasFaceProfile && !localFaceVector) {
      setFeedbackBanner({
        kind: 'warning',
        title: 'Wajah Belum Direkam',
        detail: 'Silakan rekam wajah Anda terlebih dahulu langsung dari akun ini sebelum melakukan absensi.',
        enrollFaceAction: true,
      });
      return;
    }

    if (!isOnline && !localFaceVector) {
      setFeedbackBanner({
        kind: 'error',
        title: 'Perlu Koneksi Internet',
        detail: 'Sambungkan internet satu kali untuk memuat data wajah Anda.',
      });
      return;
    }

    setGpsLoading(true);
    const todayDate = getWibParts(new Date()).dateStr;
    try {
      const freshGps = await acquireFreshGpsLocation(14000);
      setGpsReading(freshGps);
      setGpsError(null);

      if (settings) {
        if (freshGps.accuracyMeters > settings.maxGpsAccuracyMeters) {
          setFeedbackBanner({
            kind: 'warning',
            title: 'Akurasi GPS Rendah',
            detail: `Akurasi ±${freshGps.accuracyMeters}m (maksimal ±${settings.maxGpsAccuracyMeters}m). Pindah ke area terbuka lalu coba lagi.`,
          });
          return;
        }
        const dist = calculateGeodesicDistanceMeters(
          freshGps.latitude,
          freshGps.longitude,
          settings.latitude,
          settings.longitude
        );
        if (dist > settings.radiusMeters) {
          const targetScope: AppealScope = type === 'CHECK_IN' ? 'CHECK_IN' : 'CHECK_OUT';
          setFeedbackBanner({
            kind: 'error',
            title: 'Di Luar Radius Kantor',
            detail: `Jarak Anda ${dist}m dari kantor (batas ${settings.radiusMeters}m). Bila sedang ada kegiatan di luar kantor, silakan klik Sanggah.`,
            appealAction: {
              label:
                type === 'CHECK_IN'
                  ? 'Klik Sanggah Absen Masuk'
                  : 'Klik Sanggah Absen Pulang',
              workDateWib: todayDate,
              scope: targetScope,
              category: 'Kegiatan di Luar Kantor',
              contextHint: `Sanggah ${
                type === 'CHECK_IN' ? 'Absen Masuk' : 'Absen Pulang'
              } karena sedang bertugas di luar radius kantor (${formatWibDateLong(todayDate)})`,
            },
          });
          return;
        }
      }

      setActiveAttendanceType(type);
    } catch (err: any) {
      setGpsError(err?.message || 'Gagal membaca lokasi GPS.');
      setFeedbackBanner({
        kind: 'error',
        title: 'GPS Tidak Tersedia',
        detail: err?.message || 'Aktifkan GPS dan izin lokasi pada browser Android.',
      });
    } finally {
      setGpsLoading(false);
    }
  };

  const handleFaceVerified = async (bio: BiometricCaptureResult) => {
    const type = activeAttendanceType;
    setActiveAttendanceType(null);
    if (!type || !gpsReading || !settings) return;

    setSubmitting(true);
    const txId = `att_${user.employeeId}_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 7)}`;
    const deviceNow = new Date();
    const deviceTimestampIso = deviceNow.toISOString();
    const workDateWib = getWibParts(deviceNow).dateStr;

    const distance = calculateGeodesicDistanceMeters(
      gpsReading.latitude,
      gpsReading.longitude,
      settings.latitude,
      settings.longitude
    );
    const localScore = bio.faceMatchScore ?? 0;

    if (localFaceVector && localScore < settings.faceMatchThreshold - 0.05) {
      setSubmitting(false);
      setFeedbackBanner({
        kind: 'error',
        title: 'Wajah Tidak Cocok',
        detail: `Skor kecocokan ${(localScore * 100).toFixed(1)}% (minimal ${(
          settings.faceMatchThreshold * 100
        ).toFixed(0)}%). Pastikan pencahayaan terang atau rekam ulang wajah.`,
      });
      return;
    }

    const storeOfflineFallback = async (reasonNote: string) => {
      const offlineRec: LocalPendingRecord = {
        transactionId: txId,
        employeeId: user.employeeId,
        employeeName: user.fullName,
        type,
        workDateWib,
        deviceTimestampIso,
        gpsTimestampIso: gpsReading.timestampIso,
        latitude: gpsReading.latitude,
        longitude: gpsReading.longitude,
        gpsAccuracyMeters: gpsReading.accuracyMeters,
        distanceToOfficeMeters: distance,
        geofenceValid:
          distance <= settings.radiusMeters &&
          gpsReading.accuracyMeters <= settings.maxGpsAccuracyMeters,
        suspiciousLocationFlags: gpsReading.suspiciousFlags,
        faceMatchScore: Math.round(localScore * 10000) / 10000,
        faceVerified: localScore >= settings.faceMatchThreshold,
        livenessVerified: bio.livenessVerified,
        livenessDetail: bio.livenessDetail,
        attendanceStatus: 'PENDING_OFFLINE',
        syncStatus: 'WAITING_SYNC',
        wasCapturedOffline: true,
        descriptorVector: bio.descriptorVector,
        thumbnailDataUrl: bio.thumbnailDataUrl,
        syncAttempts: 0,
      };

      await saveLocalPendingAttendance(offlineRec);
      await appendLocalSyncEvent({
        eventId: `ev_${Date.now()}`,
        transactionId: txId,
        employeeId: user.employeeId,
        attemptTimestampIso: deviceTimestampIso,
        outcome: 'QUEUED_OFFLINE',
        detail: reasonNote,
      });
      await loadAttendanceData();

      setFeedbackBanner({
        kind: 'warning',
        title: 'Disimpan Offline',
        detail: `${
          type === 'CHECK_IN' ? 'Absen Masuk' : 'Absen Pulang'
        } akan disinkronkan otomatis saat internet aktif.`,
      });
    };

    if (!isOnline) {
      await storeOfflineFallback('Offline');
      setSubmitting(false);
      return;
    }

    try {
      const resp = await apiFetch('/api/attendance/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          transactionId: txId,
          type,
          deviceTimestampIso,
          gpsTimestampIso: gpsReading.timestampIso,
          latitude: gpsReading.latitude,
          longitude: gpsReading.longitude,
          gpsAccuracyMeters: gpsReading.accuracyMeters,
          suspiciousLocationFlags: gpsReading.suspiciousFlags,
          descriptorVector: bio.descriptorVector,
          livenessVerified: bio.livenessVerified,
          livenessDetail: bio.livenessDetail,
          thumbnailDataUrl: bio.thumbnailDataUrl,
          wasCapturedOffline: false,
        }),
      });

      const data = await resp.json();
      if (!resp.ok) {
        setFeedbackBanner({
          kind: 'error',
          title: 'Absensi Ditolak',
          detail: data.error || 'Ditolak server.',
        });
      } else {
        const rec: AttendanceRecord = data.record;
        if (rec.attendanceStatus === 'NEEDS_REVIEW') {
          setFeedbackBanner({
            kind: 'warning',
            title: 'Menunggu Pemeriksaan Admin',
            detail: rec.rejectionReason || 'Sedang diperiksa Admin.',
          });
        } else if (rec.attendanceStatus === 'LATE') {
          setFeedbackBanner({
            kind: 'warning',
            title: 'Absen Masuk Tercatat (Terlambat)',
            detail: `${formatWibDateTime(
              rec.serverTimestampIso || deviceTimestampIso
            )} — Apabila keterlambatan karena kegiatan di luar kantor, langsung klik Sanggah di bawah ini.`,
            appealAction: {
              label: 'Ada Kegiatan di Luar? Klik Sanggah Masuk',
              workDateWib: rec.workDateWib,
              scope: 'CHECK_IN',
              category: 'Kegiatan di Luar Kantor',
              contextHint: `Sanggah keterlambatan Absen Masuk pada ${formatWibDateLong(
                rec.workDateWib
              )} karena kegiatan di luar kantor`,
            },
          });
        } else if (rec.attendanceStatus === 'EARLY_LEAVE') {
          setFeedbackBanner({
            kind: 'warning',
            title: 'Absen Pulang Cepat Tercatat',
            detail: `${formatWibDateTime(
              rec.serverTimestampIso || deviceTimestampIso
            )} — Sebelum jam pulang (${settings.workEndTime} WIB). Bila lanjut tugas di luar kantor, silakan klik Sanggah Pulang.`,
            appealAction: {
              label: 'Ada Kegiatan di Luar? Klik Sanggah Pulang',
              workDateWib: rec.workDateWib,
              scope: 'CHECK_OUT',
              category: 'Kegiatan di Luar Kantor',
              contextHint: `Sanggah Absen Pulang Cepat pada ${formatWibDateLong(
                rec.workDateWib
              )} karena lanjutan tugas/kegiatan di luar kantor`,
            },
          });
        } else {
          setFeedbackBanner({
            kind: 'success',
            title: `Absen ${type === 'CHECK_IN' ? 'Masuk' : 'Pulang'} Berhasil`,
            detail: `${formatWibDateTime(
              rec.serverTimestampIso || deviceTimestampIso
            )} · Tepat Waktu`,
          });
        }
        await loadAttendanceData();
      }
    } catch {
      await storeOfflineFallback('Koneksi terputus');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitAppeal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isOnline) {
      setFeedbackBanner({
        kind: 'error',
        title: 'Perlu Koneksi Internet',
        detail: 'Pengajuan sanggah membutuhkan koneksi internet.',
      });
      return;
    }
    setSubmittingAppeal(true);
    setFeedbackBanner(null);
    try {
      const body: Record<string, any> = {
        workDateWib: appealDate,
        scope: appealScope,
        category: appealCategory,
        reason: appealReason.trim(),
      };
      if (gpsReading) {
        body.latitude = gpsReading.latitude;
        body.longitude = gpsReading.longitude;
      }

      const resp = await apiFetch('/api/appeals', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setFeedbackBanner({
          kind: 'error',
          title: 'Gagal Mengirim Sanggah',
          detail: data.error || 'Periksa kembali isian.',
        });
      } else {
        setAppealReason('');
        setAppealContextHint(null);
        await loadAttendanceData();
        setFeedbackBanner({
          kind: 'success',
          title: 'Sanggah Tersinkron ke Absensi',
          detail:
            'Pengajuan sanggah berhasil dikirim dan otomatis tercatat pada Riwayat Absensi sambil menunggu persetujuan Admin.',
        });
      }
    } catch {
      setFeedbackBanner({
        kind: 'error',
        title: 'Gagal Mengirim',
        detail: 'Periksa koneksi internet.',
      });
    } finally {
      setSubmittingAppeal(false);
    }
  };

  const handleExportPending = async () => {
    const jsonStr = await exportPendingRecordsJson();
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pending-${user.employeeId}-${getWibParts().dateStr}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImportPending = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const raw = await file.text();
      const count = await importPendingRecordsJson(raw);
      await loadAttendanceData();
      setFeedbackBanner({
        kind: 'success',
        title: 'Pemulihan Berhasil',
        detail: `${count} catatan dipulihkan.`,
      });
      if (isOnline) {
        syncPendingRecords();
      }
    } catch (err: any) {
      setFeedbackBanner({
        kind: 'error',
        title: 'File Tidak Valid',
        detail: err?.message || 'Format JSON tidak sesuai.',
      });
    } finally {
      e.target.value = '';
    }
  };

  const todayWib = getWibParts(new Date()).dateStr;
  const hasFaceReady = Boolean(user.hasFaceProfile || localFaceVector);

  // Build synchronized daily entries combining history + pendingLocal + appeals
  const dailyEntries = useMemo(() => {
    const combinedRecords: AttendanceRecord[] = [
      ...pendingLocal.filter((p) => p.syncStatus === 'WAITING_SYNC'),
      ...history,
    ];
    return buildDailyAttendanceEntries({
      records: combinedRecords,
      appeals,
      employees: [
        {
          employeeId: user.employeeId,
          fullName: user.fullName,
          username: user.username,
          position: user.position,
          hasFaceProfile: hasFaceReady,
          consentAccepted: user.consentAccepted,
          isActive: true,
          createdAtIso: '',
        },
      ],
      officeSettings: settings,
      includeAbsentEmployeesForDate: todayWib,
    });
  }, [appeals, hasFaceReady, history, pendingLocal, settings, todayWib, user]);

  const todayEntry = useMemo(
    () => dailyEntries.find((d) => d.workDateWib === todayWib),
    [dailyEntries, todayWib]
  );

  // Real camera scan checks for disabling scan buttons
  const todayCameraCheckIn = history.find(
    (r) =>
      r.workDateWib === todayWib &&
      r.type === 'CHECK_IN' &&
      !r.appealId &&
      r.attendanceStatus !== 'REJECTED'
  );
  const todayCameraCheckOut = history.find(
    (r) =>
      r.workDateWib === todayWib &&
      r.type === 'CHECK_OUT' &&
      !r.appealId &&
      r.attendanceStatus !== 'REJECTED'
  );

  const hasApprovedCheckInToday =
    Boolean(todayCameraCheckIn) ||
    appeals.some(
      (a) =>
        a.workDateWib === todayWib &&
        (a.scope === 'CHECK_IN' || a.scope === 'FULL_DAY') &&
        a.status === 'APPROVED'
    );

  const hasApprovedCheckOutToday =
    Boolean(todayCameraCheckOut) ||
    appeals.some(
      (a) =>
        a.workDateWib === todayWib &&
        (a.scope === 'CHECK_OUT' || a.scope === 'FULL_DAY') &&
        a.status === 'APPROVED'
    );

  const hasActiveInAppealToday = appeals.some(
    (a) =>
      a.workDateWib === todayWib &&
      (a.scope === 'CHECK_IN' || a.scope === 'FULL_DAY') &&
      (a.status === 'PENDING' || a.status === 'APPROVED')
  );

  const hasActiveOutAppealToday = appeals.some(
    (a) =>
      a.workDateWib === todayWib &&
      (a.scope === 'CHECK_OUT' || a.scope === 'FULL_DAY') &&
      (a.status === 'PENDING' || a.status === 'APPROVED')
  );

  const isTodayCheckInLate =
    todayCameraCheckIn?.attendanceStatus === 'LATE' && !hasActiveInAppealToday;
  const isTodayCheckOutEarly =
    todayCameraCheckOut?.attendanceStatus === 'EARLY_LEAVE' &&
    !hasActiveOutAppealToday;
  const canAppealMissingCheckOutToday =
    hasApprovedCheckInToday &&
    !todayCameraCheckOut &&
    !hasActiveOutAppealToday;

  const currentDistance =
    gpsReading && settings
      ? calculateGeodesicDistanceMeters(
          gpsReading.latitude,
          gpsReading.longitude,
          settings.latitude,
          settings.longitude
        )
      : null;

  const isInsideRadius =
    currentDistance !== null && settings
      ? currentDistance <= settings.radiusMeters
      : false;
  const isAccuracyGood =
    gpsReading && settings
      ? gpsReading.accuracyMeters <= settings.maxGpsAccuracyMeters
      : false;

  const pendingAppealsCount = appeals.filter((a) => a.status === 'PENDING').length;

  const formatScopeLabel = (scope: AppealScope) => {
    if (scope === 'CHECK_IN') return 'Absen Masuk';
    if (scope === 'CHECK_OUT') return 'Absen Pulang';
    return 'Masuk & Pulang';
  };

  if (!user.consentAccepted) {
    return (
      <div className="max-w-md mx-auto py-8 px-4">
        <div className="rounded-2xl bg-white border border-slate-200 p-5 sm:p-6 space-y-4">
          <div className="flex items-center gap-2.5 text-[#0F2942]">
            <ShieldCheck className="w-6 h-6 shrink-0" />
            <h2 className="text-base font-bold">Izin Kamera &amp; Lokasi</h2>
          </div>
          <p className="text-sm text-slate-600">
            Kamera depan dan lokasi GPS digunakan khusus saat perekaman dan verifikasi absensi.
          </p>
          <button
            type="button"
            disabled={consentSubmitting || !isOnline}
            onClick={handleAcceptConsent}
            className="w-full min-h-[48px] rounded-xl bg-[#0F2942] px-5 py-3 text-sm font-semibold text-white hover:bg-[#163A5C] active:scale-[0.98] disabled:opacity-50 transition-all"
          >
            {consentSubmitting ? 'Menyimpan...' : 'Lanjutkan'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-3.5 sm:px-6 py-4 sm:py-6 space-y-4">
      {!isOnline && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 flex items-center gap-2.5 text-xs sm:text-sm text-amber-950">
          <WifiOff className="w-4 h-4 text-amber-700 shrink-0" />
          <span>Mode Offline — Absensi disimpan sementara di HP.</span>
        </div>
      )}

      {/* Self-service face enrollment prompt if employee hasn't recorded face yet */}
      {!hasFaceReady && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3.5 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-0.5">
            <p className="text-sm font-bold text-amber-950">
              Wajah Anda Belum Direkam
            </p>
            <p className="text-xs text-amber-900">
              Rekam wajah langsung dari akun Anda (3 sampel otomatis) sebelum mulai absen.
            </p>
          </div>
          <button
            type="button"
            disabled={!isOnline || savingFace}
            onClick={() => setSelfEnrollingFace(true)}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-[#0F2942] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#163A5C] min-h-[44px] whitespace-nowrap shrink-0"
          >
            <ScanFace className="w-4 h-4 shrink-0" />
            <span>{savingFace ? 'Menyimpan...' : 'Rekam Wajah Sekarang'}</span>
          </button>
        </div>
      )}

      {feedbackBanner && (
        <div
          className={`rounded-xl border p-3.5 space-y-2.5 ${
            feedbackBanner.kind === 'success'
              ? 'border-emerald-300 bg-emerald-50 text-emerald-950'
              : feedbackBanner.kind === 'warning'
              ? 'border-amber-300 bg-amber-50 text-amber-950'
              : 'border-red-300 bg-red-50 text-red-950'
          }`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-0.5 min-w-0">
              <p className="text-sm font-bold break-words">
                {feedbackBanner.title}
              </p>
              <p className="text-xs sm:text-sm break-words">
                {feedbackBanner.detail}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setFeedbackBanner(null)}
              className="min-h-[36px] px-2 text-xs font-semibold underline shrink-0"
            >
              Tutup
            </button>
          </div>

          {feedbackBanner.appealAction && (
            <button
              type="button"
              onClick={() => {
                const act = feedbackBanner.appealAction!;
                setFeedbackBanner(null);
                openContextualAppeal(
                  act.workDateWib,
                  act.scope,
                  act.category,
                  act.contextHint
                );
              }}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-[#0F2942] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#163A5C] min-h-[42px]"
            >
              <FileText className="w-4 h-4 shrink-0" />
              <span>{feedbackBanner.appealAction.label}</span>
            </button>
          )}

          {feedbackBanner.enrollFaceAction && (
            <button
              type="button"
              disabled={!isOnline || savingFace}
              onClick={() => {
                setFeedbackBanner(null);
                setSelfEnrollingFace(true);
              }}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-[#0F2942] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#163A5C] min-h-[42px]"
            >
              <ScanFace className="w-4 h-4 shrink-0" />
              <span>Rekam Wajah Sekarang</span>
            </button>
          )}
        </div>
      )}

      {/* Employee Navigation Tabs */}
      <div className="grid grid-cols-3 gap-1.5 rounded-xl bg-slate-200/70 p-1">
        <button
          type="button"
          onClick={() => setActiveTab('ABSEN')}
          className={`min-h-[44px] rounded-lg text-xs sm:text-sm font-bold transition-all ${
            activeTab === 'ABSEN'
              ? 'bg-white text-[#0F2942] shadow-sm'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Absen
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('SANGGAH')}
          className={`min-h-[44px] rounded-lg text-xs sm:text-sm font-bold transition-all flex items-center justify-center gap-1.5 ${
            activeTab === 'SANGGAH'
              ? 'bg-white text-[#0F2942] shadow-sm'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <span>Sanggah</span>
          {pendingAppealsCount > 0 && (
            <span className="px-1.5 py-0.5 text-[10px] rounded bg-amber-600 text-white font-mono tabular-nums">
              {pendingAppealsCount}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('RIWAYAT')}
          className={`min-h-[44px] rounded-lg text-xs sm:text-sm font-bold transition-all ${
            activeTab === 'RIWAYAT'
              ? 'bg-white text-[#0F2942] shadow-sm'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Riwayat
        </button>
      </div>

      {/* TAB 1: ABSEN */}
      {activeTab === 'ABSEN' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
            <div className="lg:col-span-7 rounded-2xl bg-white border border-slate-200 p-4 sm:p-6 flex flex-col justify-between space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2 border-b border-slate-100 pb-3.5">
                <div className="min-w-0">
                  <p className="text-xs text-slate-500 truncate">
                    {user.employeeId} · {user.position}
                  </p>
                  <h1 className="text-lg sm:text-2xl font-bold text-slate-900 truncate mt-0.5">
                    {user.fullName}
                  </h1>
                </div>
                <div className="sm:text-right shrink-0">
                  <p className="text-xs sm:text-sm font-mono font-semibold text-[#0F2942] tabular-nums">
                    {wibClock}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  disabled={submitting || gpsLoading || hasApprovedCheckInToday}
                  onClick={() => initiateAttendance('CHECK_IN')}
                  className="w-full min-h-[56px] rounded-xl bg-[#0F2942] px-4 py-3.5 text-sm font-bold text-white hover:bg-[#163A5C] active:scale-[0.98] disabled:opacity-45 disabled:cursor-not-allowed flex items-center justify-center gap-2.5 transition-all"
                >
                  <LogIn className="w-5 h-5 shrink-0" />
                  <span className="truncate">
                    {gpsLoading
                      ? 'Cek GPS...'
                      : hasApprovedCheckInToday
                      ? 'SUDAH MASUK'
                      : 'ABSEN MASUK'}
                  </span>
                </button>

                <button
                  type="button"
                  disabled={
                    submitting ||
                    gpsLoading ||
                    !hasApprovedCheckInToday ||
                    hasApprovedCheckOutToday
                  }
                  onClick={() => initiateAttendance('CHECK_OUT')}
                  className="w-full min-h-[56px] rounded-xl border-2 border-[#0F2942] bg-white px-4 py-3.5 text-sm font-bold text-[#0F2942] hover:bg-slate-50 active:scale-[0.98] disabled:opacity-45 disabled:cursor-not-allowed flex items-center justify-center gap-2.5 transition-all"
                >
                  <LogOut className="w-5 h-5 shrink-0" />
                  <span className="truncate">
                    {hasApprovedCheckOutToday ? 'SUDAH PULANG' : 'ABSEN PULANG'}
                  </span>
                </button>
              </div>

              {/* Synchronized Masuk & Pulang Status Boxes + Contextual 1-Tap Sanggah */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 flex flex-col justify-between gap-2.5">
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500 font-semibold">
                        Absen Masuk
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded-md border text-[11px] font-bold ${
                          todayEntry?.checkInStatusLabel.includes('Terlambat') ||
                          todayEntry?.checkInStatusLabel.includes('Menunggu')
                            ? 'border-amber-200 bg-amber-50 text-amber-800'
                            : todayEntry?.checkInStatusLabel.includes('Sanggah Disetujui')
                            ? 'border-sky-200 bg-sky-50 text-sky-900'
                            : todayEntry?.checkInStatusLabel === 'Tepat Waktu'
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                            : 'border-slate-200 bg-white text-slate-600'
                        }`}
                      >
                        {todayEntry?.checkInStatusLabel || 'Belum Masuk'}
                      </span>
                    </div>
                    <span className="font-mono font-bold text-base text-slate-900 tabular-nums mt-1.5 block">
                      {todayEntry?.checkInTimeWib || '--:--'}
                    </span>
                  </div>

                  {isTodayCheckInLate && (
                    <button
                      type="button"
                      onClick={() =>
                        openContextualAppeal(
                          todayWib,
                          'CHECK_IN',
                          'Kegiatan di Luar Kantor',
                          `Sanggah Masuk Terlambat (${todayEntry?.checkInTimeWib}) karena ada kegiatan di luar kantor`
                        )
                      }
                      className="w-full min-h-[38px] rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-amber-800 flex items-center justify-center gap-1.5"
                    >
                      <FileText className="w-3.5 h-3.5 shrink-0" />
                      <span>Kegiatan Luar? Klik Sanggah</span>
                    </button>
                  )}

                  {!hasApprovedCheckInToday && !hasActiveInAppealToday && (
                    <button
                      type="button"
                      onClick={() =>
                        openContextualAppeal(
                          todayWib,
                          'CHECK_IN',
                          'Kegiatan di Luar Kantor',
                          `Sanggah Absen Masuk (${formatWibDateLong(todayWib)}) karena kegiatan di luar kantor`
                        )
                      }
                      className="w-full min-h-[38px] rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-[#0F2942] hover:bg-slate-100 flex items-center justify-center gap-1.5"
                    >
                      <FileText className="w-3.5 h-3.5 shrink-0" />
                      <span>Sanggah Masuk</span>
                    </button>
                  )}
                </div>

                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 flex flex-col justify-between gap-2.5">
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500 font-semibold">
                        Absen Pulang
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded-md border text-[11px] font-bold ${
                          todayEntry?.checkOutStatusLabel.includes('Cepat') ||
                          todayEntry?.checkOutStatusLabel.includes('Menunggu')
                            ? 'border-amber-200 bg-amber-50 text-amber-800'
                            : todayEntry?.checkOutStatusLabel.includes('Sanggah Disetujui')
                            ? 'border-sky-200 bg-sky-50 text-sky-900'
                            : todayEntry?.checkOutStatusLabel === 'Sudah Pulang'
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                            : 'border-slate-200 bg-white text-slate-600'
                        }`}
                      >
                        {todayEntry?.checkOutStatusLabel || 'Belum Pulang'}
                      </span>
                    </div>
                    <span className="font-mono font-bold text-base text-slate-900 tabular-nums mt-1.5 block">
                      {todayEntry?.checkOutTimeWib || '--:--'}
                    </span>
                  </div>

                  {isTodayCheckOutEarly && (
                    <button
                      type="button"
                      onClick={() =>
                        openContextualAppeal(
                          todayWib,
                          'CHECK_OUT',
                          'Kegiatan di Luar Kantor',
                          `Sanggah Pulang Cepat (${todayEntry?.checkOutTimeWib}) karena ada kegiatan di luar kantor`
                        )
                      }
                      className="w-full min-h-[38px] rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-amber-800 flex items-center justify-center gap-1.5"
                    >
                      <FileText className="w-3.5 h-3.5 shrink-0" />
                      <span>Pulang Cepat? Klik Sanggah</span>
                    </button>
                  )}

                  {canAppealMissingCheckOutToday && (
                    <button
                      type="button"
                      onClick={() =>
                        openContextualAppeal(
                          todayWib,
                          'CHECK_OUT',
                          'Kegiatan di Luar Kantor',
                          `Sanggah Tidak Bisa Absen Pulang di kantor (${formatWibDateLong(
                            todayWib
                          )}) karena kegiatan di luar`
                        )
                      }
                      className="w-full min-h-[38px] rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-[#0F2942] hover:bg-slate-100 flex items-center justify-center gap-1.5"
                    >
                      <FileText className="w-3.5 h-3.5 shrink-0" />
                      <span>Tidak Absen Pulang? Sanggah</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Status & Self Face Enrollment Action Bar */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100 text-xs">
                <div className="flex flex-wrap items-center gap-4">
                  <div className="flex items-center gap-1.5 font-semibold text-slate-900">
                    {isOnline ? (
                      <>
                        <Wifi className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                        <span>Online</span>
                      </>
                    ) : (
                      <>
                        <WifiOff className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                        <span>Offline</span>
                      </>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 font-mono font-semibold text-slate-900 tabular-nums">
                    <Clock className="w-3.5 h-3.5 text-[#0F2942] shrink-0" />
                    <span>
                      {settings
                        ? `${settings.workStartTime}–${settings.workEndTime} WIB`
                        : '--:--'}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={!isOnline || savingFace}
                  onClick={() => setSelfEnrollingFace(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-[#0F2942] hover:bg-slate-50 active:scale-[0.98] disabled:opacity-50 min-h-[40px] whitespace-nowrap"
                >
                  <Camera className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    {savingFace
                      ? 'Menyimpan...'
                      : hasFaceReady
                      ? 'Rekam Ulang Wajah'
                      : 'Rekam Wajah'}
                  </span>
                </button>
              </div>
            </div>

            {/* GPS & Full-Day Field Duty Card */}
            <div className="lg:col-span-5 rounded-2xl bg-white border border-slate-200 p-4 sm:p-6 flex flex-col justify-between space-y-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <MapPin className="w-4 h-4 text-[#0F2942] shrink-0" />
                    <h2 className="text-sm font-bold text-slate-900 truncate">
                      Lokasi GPS
                    </h2>
                  </div>
                  <button
                    type="button"
                    disabled={gpsLoading}
                    onClick={refreshGps}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-[#0F2942] hover:bg-slate-50 active:scale-[0.98] min-h-[44px] shrink-0 whitespace-nowrap"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 ${gpsLoading ? 'animate-spin' : ''}`}
                    />
                    <span>Perbarui</span>
                  </button>
                </div>

                {gpsError ? (
                  <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-xs text-red-800 break-words">
                    {gpsError}
                  </div>
                ) : gpsReading && settings ? (
                  <div className="space-y-2 text-xs text-slate-700 font-mono tabular-nums">
                    <div className="flex items-center justify-between gap-2 py-1.5 border-b border-slate-100 font-sans">
                      <span className="text-slate-500 shrink-0">Kantor</span>
                      <span className="font-semibold text-slate-900 text-right truncate">
                        {settings.officeName}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 py-1.5 border-b border-slate-100">
                      <span className="text-slate-500 font-sans shrink-0">
                        Jarak ke Kantor
                      </span>
                      <span
                        className={`text-right font-semibold ${
                          isInsideRadius ? 'text-emerald-700' : 'text-red-700'
                        }`}
                      >
                        {currentDistance}m / {settings.radiusMeters}m
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 py-1.5">
                      <span className="text-slate-500 font-sans shrink-0">
                        Akurasi Sinyal
                      </span>
                      <span
                        className={`text-right font-semibold ${
                          isAccuracyGood ? 'text-emerald-700' : 'text-amber-700'
                        }`}
                      >
                        ±{gpsReading.accuracyMeters}m
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-slate-500 py-4">Memuat GPS...</p>
                )}
              </div>

              <button
                type="button"
                onClick={() =>
                  openContextualAppeal(
                    todayWib,
                    'FULL_DAY',
                    'Tugas Lapangan',
                    `Sanggah Tugas Lapangan Sehari Penuh (${formatWibDateLong(todayWib)})`
                  )
                }
                className="w-full min-h-[46px] rounded-xl border border-slate-300 bg-slate-50 px-3.5 py-2.5 text-xs font-bold text-[#0F2942] hover:bg-slate-100 active:scale-[0.98] flex items-center justify-center gap-2 transition-all"
              >
                <FileText className="w-4 h-4 shrink-0" />
                <span>Tugas Lapangan Sehari? Ajukan Sanggah</span>
              </button>
            </div>
          </div>

          {pendingLocal.length > 0 && (
            <div className="rounded-2xl bg-white border border-slate-200 p-4 sm:p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-bold text-slate-900">
                  Antrean Offline ({pendingLocal.length})
                </h2>
                {isOnline &&
                  pendingLocal.some((p) => p.syncStatus === 'WAITING_SYNC') && (
                    <button
                      type="button"
                      disabled={syncingNow}
                      onClick={syncPendingRecords}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-[#0F2942] px-3.5 py-2 text-xs font-semibold text-white min-h-[40px] whitespace-nowrap"
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 ${syncingNow ? 'animate-spin' : ''}`}
                      />
                      <span>{syncingNow ? 'Mengirim...' : 'Kirim Sekarang'}</span>
                    </button>
                  )}
              </div>
              <div className="divide-y divide-slate-100 text-xs">
                {pendingLocal.slice(0, 5).map((item) => (
                  <div
                    key={item.transactionId}
                    className="py-2.5 flex items-center justify-between gap-2"
                  >
                    <div>
                      <span className="font-semibold text-slate-900 block">
                        {item.type === 'CHECK_IN' ? 'Absen Masuk' : 'Absen Pulang'}
                      </span>
                      <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                        {formatWibDateTime(item.deviceTimestampIso)}
                      </span>
                    </div>
                    <span className="font-semibold text-amber-700 shrink-0">
                      {item.syncStatus === 'WAITING_SYNC'
                        ? 'Menunggu'
                        : item.syncStatus === 'SYNCED'
                        ? 'Terkirim'
                        : item.syncStatus === 'REJECTED_SERVER'
                        ? 'Ditolak'
                        : 'Diproses'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 2: SANGGAH ABSEN */}
      {activeTab === 'SANGGAH' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
          <form
            onSubmit={handleSubmitAppeal}
            className="lg:col-span-5 rounded-2xl bg-white border border-slate-200 p-4 sm:p-6 space-y-4"
          >
            <div className="flex items-center gap-2 text-[#0F2942]">
              <FileText className="w-5 h-5 shrink-0" />
              <h2 className="text-base font-bold text-slate-900">
                Form Sanggah Absen
              </h2>
            </div>

            {appealContextHint && (
              <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs text-sky-950 flex items-start justify-between gap-2">
                <span>{appealContextHint}</span>
                <button
                  type="button"
                  onClick={() => setAppealContextHint(null)}
                  className="font-semibold underline shrink-0"
                >
                  Tutup
                </button>
              </div>
            )}

            <div className="space-y-3 text-xs">
              <div>
                <label className="font-semibold text-slate-700 block mb-1">
                  Tanggal Kerja
                </label>
                <input
                  type="date"
                  required
                  value={appealDate}
                  onChange={(e) => setAppealDate(e.target.value)}
                  className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 py-2 font-mono text-base sm:text-sm focus:outline-none focus:border-[#0F2942]"
                />
              </div>

              <div>
                <label className="font-semibold text-slate-700 block mb-1">
                  Jenis Sanggah Absensi
                </label>
                <div className="grid grid-cols-3 gap-1.5">
                  {(
                    [
                      ['CHECK_IN', 'Masuk / Telat'],
                      ['CHECK_OUT', 'Pulang / Cepat'],
                      ['FULL_DAY', 'Sehari Penuh'],
                    ] as [AppealScope, string][]
                  ).map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setAppealScope(val)}
                      className={`min-h-[42px] px-2 py-2 rounded-xl border text-xs font-semibold transition-all ${
                        appealScope === val
                          ? 'bg-[#0F2942] border-[#0F2942] text-white'
                          : 'border-slate-300 text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="font-semibold text-slate-700 block mb-1">
                  Kategori Kegiatan
                </label>
                <select
                  value={appealCategory}
                  onChange={(e) => setAppealCategory(e.target.value)}
                  className="w-full min-h-[44px] rounded-xl border border-slate-300 bg-white px-3 py-2 text-base sm:text-sm focus:outline-none focus:border-[#0F2942]"
                >
                  {APPEAL_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="font-semibold text-slate-700 block mb-1">
                  Keterangan Kegiatan / Lokasi Luar
                </label>
                <textarea
                  ref={reasonTextareaRef}
                  required
                  minLength={3}
                  rows={3}
                  value={appealReason}
                  onChange={(e) => setAppealReason(e.target.value)}
                  placeholder="Contoh: Kunjungan klien di Bekasi pagi hari / Lanjut tugas lapangan sore..."
                  className="w-full rounded-xl border border-slate-300 p-3 text-base sm:text-sm focus:outline-none focus:border-[#0F2942]"
                />
              </div>

              {gpsReading && (
                <p className="text-[11px] font-mono text-slate-500 tabular-nums">
                  Koordinat saat ini: {gpsReading.latitude.toFixed(5)},{' '}
                  {gpsReading.longitude.toFixed(5)}
                </p>
              )}
            </div>

            <button
              type="submit"
              disabled={submittingAppeal || !isOnline}
              className="w-full min-h-[48px] rounded-xl bg-[#0F2942] px-4 py-3 text-xs sm:text-sm font-bold text-white hover:bg-[#163A5C] active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2 transition-all"
            >
              <Send className="w-4 h-4 shrink-0" />
              <span>{submittingAppeal ? 'Mengirim...' : 'Kirim Sanggah'}</span>
            </button>
          </form>

          <div className="lg:col-span-7 rounded-2xl bg-white border border-slate-200 p-4 sm:p-6 space-y-4">
            <h2 className="text-base font-bold text-slate-900">
              Riwayat Sanggah &amp; Status Sinkron ({appeals.length})
            </h2>

            {appeals.length === 0 ? (
              <p className="text-sm text-slate-500 py-8 text-center border border-dashed border-slate-200 rounded-xl">
                Belum ada pengajuan sanggah.
              </p>
            ) : (
              <div className="divide-y divide-slate-100">
                {appeals.map((apl) => (
                  <div key={apl.appealId} className="py-3.5 space-y-1.5 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <span className="font-bold text-slate-900 block">
                          {apl.category} · {formatScopeLabel(apl.scope)}
                        </span>
                        <span className="font-mono text-[11px] text-slate-600 tabular-nums">
                          {formatWibDateLong(apl.workDateWib)} ({apl.workDateWib})
                        </span>
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded-md border text-[11px] font-bold shrink-0 ${
                          apl.status === 'APPROVED'
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                            : apl.status === 'REJECTED'
                            ? 'border-red-200 bg-red-50 text-red-800'
                            : 'border-amber-200 bg-amber-50 text-amber-800'
                        }`}
                      >
                        {apl.status === 'APPROVED'
                          ? 'Disetujui · Hadir'
                          : apl.status === 'REJECTED'
                          ? 'Ditolak'
                          : 'Menunggu Admin'}
                      </span>
                    </div>
                    <p className="text-slate-700 break-words">{apl.reason}</p>
                    {apl.reviewNote && (
                      <p className="text-[11px] text-slate-600 break-words">
                        Catatan Admin: {apl.reviewNote}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: RIWAYAT (Paired Daily View + Contextual Sanggah Buttons) */}
      {activeTab === 'RIWAYAT' && (
        <div className="rounded-2xl bg-white border border-slate-200 p-4 sm:p-6 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-bold text-slate-900">
                Riwayat Kehadiran Harian
              </h2>
              <p className="text-xs text-slate-500">
                Tersinkron otomatis antara Absen Kamera &amp; Sanggah Absen
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleExportPending}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 min-h-[38px] whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Backup Lokal</span>
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 min-h-[38px] whitespace-nowrap"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Pulihkan</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json"
                onChange={handleImportPending}
                className="hidden"
              />
            </div>
          </div>

          {dailyEntries.length === 0 ? (
            <p className="text-sm text-slate-500 py-8 text-center border border-dashed border-slate-200 rounded-xl">
              Belum ada riwayat absensi.
            </p>
          ) : (
            <div className="divide-y divide-slate-200">
              {dailyEntries.map((entry) => {
                const hasPendingOrApprovedIn = appeals.some(
                  (a) =>
                    a.workDateWib === entry.workDateWib &&
                    (a.scope === 'CHECK_IN' || a.scope === 'FULL_DAY') &&
                    (a.status === 'PENDING' || a.status === 'APPROVED')
                );
                const hasPendingOrApprovedOut = appeals.some(
                  (a) =>
                    a.workDateWib === entry.workDateWib &&
                    (a.scope === 'CHECK_OUT' || a.scope === 'FULL_DAY') &&
                    (a.status === 'PENDING' || a.status === 'APPROVED')
                );

                const showAppealLateBtn =
                  entry.checkInRecord?.attendanceStatus === 'LATE' &&
                  !hasPendingOrApprovedIn;

                const showAppealOutBtn =
                  !hasPendingOrApprovedOut &&
                  (entry.checkOutRecord?.attendanceStatus === 'EARLY_LEAVE' ||
                    (entry.checkInTimeWib !== '-' &&
                      entry.checkOutStatusLabel === 'Belum Pulang'));

                return (
                  <div
                    key={entry.key}
                    className="py-4 space-y-3 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span className="font-bold text-sm text-slate-900 block">
                          {formatWibDateLong(entry.workDateWib)}
                        </span>
                        <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                          {entry.workDateWib} · Sumber: {entry.sourceLabel}
                          {entry.durationLabel !== '-'
                            ? ` · Durasi: ${entry.durationLabel}`
                            : ''}
                        </span>
                      </div>
                      <span
                        className={`px-2.5 py-1 rounded-md border text-xs font-bold ${getDailyBadgeClasses(
                          entry.overallStatus
                        )}`}
                      >
                        {entry.overallLabel}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5">
                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                        <span className="text-[11px] text-slate-500 block">
                          Jam Masuk
                        </span>
                        <span className="font-mono font-bold text-sm text-slate-900 tabular-nums mt-0.5 block">
                          {entry.checkInTimeWib}
                        </span>
                        <span className="text-[11px] font-semibold text-slate-700 mt-0.5 block">
                          {entry.checkInStatusLabel}
                        </span>
                      </div>

                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                        <span className="text-[11px] text-slate-500 block">
                          Jam Pulang
                        </span>
                        <span className="font-mono font-bold text-sm text-slate-900 tabular-nums mt-0.5 block">
                          {entry.checkOutTimeWib}
                        </span>
                        <span className="text-[11px] font-semibold text-slate-700 mt-0.5 block">
                          {entry.checkOutStatusLabel}
                        </span>
                      </div>
                    </div>

                    {entry.notes !== '-' && (
                      <p className="text-slate-700 bg-slate-50 border border-slate-200/80 rounded-lg px-3 py-2 break-words">
                        {entry.notes}
                      </p>
                    )}

                    {(showAppealLateBtn || showAppealOutBtn) && (
                      <div className="flex flex-wrap gap-2 pt-0.5">
                        {showAppealLateBtn && (
                          <button
                            type="button"
                            onClick={() =>
                              openContextualAppeal(
                                entry.workDateWib,
                                'CHECK_IN',
                                'Kegiatan di Luar Kantor',
                                `Sanggah Masuk Terlambat pada ${formatWibDateLong(
                                  entry.workDateWib
                                )}`
                              )
                            }
                            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900 hover:bg-amber-100 min-h-[38px]"
                          >
                            <FileText className="w-3.5 h-3.5 shrink-0" />
                            <span>Klik Sanggah Terlambat</span>
                          </button>
                        )}
                        {showAppealOutBtn && (
                          <button
                            type="button"
                            onClick={() =>
                              openContextualAppeal(
                                entry.workDateWib,
                                'CHECK_OUT',
                                'Kegiatan di Luar Kantor',
                                `Sanggah ${
                                  entry.checkOutRecord?.attendanceStatus ===
                                  'EARLY_LEAVE'
                                    ? 'Pulang Cepat'
                                    : 'Tidak Absen Pulang'
                                } pada ${formatWibDateLong(entry.workDateWib)}`
                              )
                            }
                            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900 hover:bg-amber-100 min-h-[38px]"
                          >
                            <FileText className="w-3.5 h-3.5 shrink-0" />
                            <span>
                              {entry.checkOutRecord?.attendanceStatus ===
                              'EARLY_LEAVE'
                                ? 'Klik Sanggah Pulang Cepat'
                                : 'Klik Sanggah Pulang'}
                            </span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Self-service Face Enrollment Modal */}
      {selfEnrollingFace && (
        <FaceCameraModal
          mode="ENROLL"
          employeeName={`${user.fullName} (${user.employeeId})`}
          onSuccess={handleSelfFaceEnrollSuccess}
          onCancel={() => setSelfEnrollingFace(false)}
        />
      )}

      {/* Attendance Verification Modal */}
      {activeAttendanceType && settings && (
        <FaceCameraModal
          mode="VERIFY"
          employeeName={`${user.fullName} — ${
            activeAttendanceType === 'CHECK_IN' ? 'Masuk' : 'Pulang'
          }`}
          referenceDescriptor={localFaceVector || undefined}
          matchThreshold={settings.faceMatchThreshold}
          onSuccess={handleFaceVerified}
          onCancel={() => setActiveAttendanceType(null)}
        />
      )}
    </div>
  );
};
