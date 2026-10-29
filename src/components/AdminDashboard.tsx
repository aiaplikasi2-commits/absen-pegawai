import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Users,
  ScanFace,
  MapPin,
  Download,
  Upload,
  CheckCircle2,
  XCircle,
  Search,
  Eye,
  Mail,
  FileSpreadsheet,
  ShieldCheck,
  AlertTriangle,
  KeyRound,
  Smartphone,
  Trash2,
  X,
  Clock,
} from 'lucide-react';
import type {
  AppealScope,
  AttendanceAppeal,
  AttendanceRecord,
  AuditLogRecord,
  AuthSessionUser,
  DailyAttendanceEntry,
  DailyOverallStatus,
  EmployeeProfile,
  OfficeSettings,
} from '../types/attendance';
import {
  formatWibDateLong,
  formatWibDateTime,
  formatWibHourMinute,
  getWibParts,
} from '../utils/geoAndTime';
import { acquireFreshGpsLocation } from '../services/gpsValidator';
import {
  connectGoogleForGmail,
  getGmailAccessToken,
} from '../lib/firebase';
import { downloadAndroidSourceZip } from '../utils/androidProjectBundle';
import { FaceCameraModal, BiometricCaptureResult } from './FaceCameraModal';
import { apiFetch } from '../utils/apiFetchBridge';

export type AdminSection =
  | 'OVERVIEW'
  | 'APPEALS'
  | 'EMPLOYEES'
  | 'MONTHLY_REPORT'
  | 'SETTINGS_AUDIT';

interface AdminDashboardProps {
  user: AuthSessionUser;
  token: string;
  activeSection: AdminSection;
  onChangeSection: (sec: AdminSection) => void;
  onSettingsUpdated: (s: OfficeSettings) => void;
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  token,
  activeSection,
  onChangeSection,
  onSettingsUpdated,
}) => {
  const [summary, setSummary] = useState({
    dateWib: getWibParts().dateStr,
    totalEmployees: 0,
    presentCount: 0,
    lateCount: 0,
    approvedAppealTodayCount: 0,
    absentCount: 0,
    pendingReviewCount: 0,
    pendingAppealCount: 0,
  });

  const [dailyEntries, setDailyEntries] = useState<DailyAttendanceEntry[]>([]);
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [attendanceViewMode, setAttendanceViewMode] = useState<'DAILY' | 'RAW'>(
    'DAILY'
  );
  const [appeals, setAppeals] = useState<AttendanceAppeal[]>([]);
  const [appealFilter, setAppealFilter] = useState<'PENDING' | 'ALL'>('PENDING');
  const [employees, setEmployees] = useState<EmployeeProfile[]>([]);
  const [settings, setSettings] = useState<OfficeSettings | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLogRecord[]>([]);

  const [dateFilter, setDateFilter] = useState<string>(
    () => getWibParts().dateStr
  );
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [exportingExcel, setExportingExcel] = useState<
    'daily' | 'monthly' | null
  >(null);
  const [banner, setBanner] = useState<{
    kind: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);

  const [newEmpId, setNewEmpId] = useState('EMP-001');
  const [newEmpName, setNewEmpName] = useState('');
  const [newEmpUsername, setNewEmpUsername] = useState('');
  const [newEmpPassword, setNewEmpPassword] = useState('');
  const [newEmpPosition, setNewEmpPosition] = useState('');
  const [creatingEmp, setCreatingEmp] = useState(false);

  const [enrollingEmployee, setEnrollingEmployee] =
    useState<EmployeeProfile | null>(null);
  const [resetTargetEmp, setResetTargetEmp] = useState<EmployeeProfile | null>(
    null
  );
  const [resetNewPass, setResetNewPass] = useState('');
  const [deleteBioTarget, setDeleteBioTarget] =
    useState<EmployeeProfile | null>(null);
  const [deleteEmpTarget, setDeleteEmpTarget] =
    useState<EmployeeProfile | null>(null);

  const [evidenceModal, setEvidenceModal] = useState<{
    record: AttendanceRecord;
    thumbnailDataUrl?: string;
    loading: boolean;
  } | null>(null);

  const [reviewModal, setReviewModal] = useState<{
    record: AttendanceRecord;
    decision: 'APPROVE_VALID' | 'APPROVE_LATE' | 'REJECT';
    reason: string;
  } | null>(null);

  const [appealReviewModal, setAppealReviewModal] = useState<{
    appeal: AttendanceAppeal;
    decision: 'APPROVE' | 'REJECT';
    note: string;
  } | null>(null);
  const [processingAppeal, setProcessingAppeal] = useState(false);

  const [settingsForm, setSettingsForm] = useState<OfficeSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  const [curAdminPass, setCurAdminPass] = useState('');
  const [newAdminPass, setNewAdminPass] = useState('');

  const [reportPeriod, setReportPeriod] = useState<string>(
    () => getWibParts().monthPeriod
  );
  const [monthlyReportData, setMonthlyReportData] = useState<any | null>(null);
  const [gmailConnectedEmail, setGmailConnectedEmail] = useState<string | null>(
    null
  );
  const [confirmEmailModal, setConfirmEmailModal] = useState<{
    period: string;
    recipientEmail: string;
    triggerMode: 'MANUAL' | 'AUTO_EOM';
  } | null>(null);
  const [sendingEmail, setSendingEmail] = useState(false);

  const restoreInputRef = useRef<HTMLInputElement | null>(null);
  const autoCheckedEomRef = useRef<boolean>(false);

  const fetchAttendanceAndSummary = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (dateFilter) qs.set('date', dateFilter);
      if (searchQuery) qs.set('search', searchQuery);
      const resp = await apiFetch(`/api/admin/attendance?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) {
        const data = await resp.json();
        setSummary((prev) => ({ ...prev, ...data.summary }));
        setDailyEntries(data.dailyEntries || []);
        setRecords(data.records || []);
        if (Array.isArray(data.appeals)) {
          setAppeals(data.appeals);
        }
        if (data.officeSettings) {
          setSettings(data.officeSettings);
          setSettingsForm((prev) => prev || data.officeSettings);
        }
      }
    } finally {
      setLoading(false);
    }
  }, [dateFilter, searchQuery, token]);

  const fetchAppeals = useCallback(async () => {
    const resp = await apiFetch('/api/admin/appeals', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.ok) {
      const data = await resp.json();
      setAppeals(data.appeals || []);
    }
  }, [token]);

  const fetchEmployees = useCallback(async () => {
    const resp = await apiFetch('/api/admin/employees', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.ok) {
      const data = await resp.json();
      const list: EmployeeProfile[] = data.employees || [];
      setEmployees(list);
      const usedNums = list
        .map((e) => Number(e.employeeId.replace(/\D/g, '')))
        .filter((n) => Number.isFinite(n));
      const nextNum = String(
        (usedNums.length ? Math.max(...usedNums) : 0) + 1
      ).padStart(3, '0');
      setNewEmpId(`EMP-${nextNum}`);
    }
  }, [token]);

  const fetchAuditLogs = useCallback(async () => {
    const resp = await apiFetch('/api/admin/audit-logs', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.ok) {
      const data = await resp.json();
      setAuditLogs(data.auditLogs || []);
    }
  }, [token]);

  const fetchMonthlyReport = useCallback(async () => {
    const resp = await apiFetch(
      `/api/admin/monthly-report?period=${encodeURIComponent(reportPeriod)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    if (resp.ok) {
      const data = await resp.json();
      setMonthlyReportData(data);

      if (
        !autoCheckedEomRef.current &&
        data.autoMonthlyReportEnabled &&
        data.isEndOfMonthWindow &&
        !data.alreadySentForPeriod &&
        data.adminReportEmail
      ) {
        autoCheckedEomRef.current = true;
        setConfirmEmailModal({
          period: data.period,
          recipientEmail: data.adminReportEmail,
          triggerMode: 'AUTO_EOM',
        });
      }
    }
  }, [reportPeriod, token]);

  useEffect(() => {
    fetchAttendanceAndSummary();
    fetchEmployees();
    fetchAppeals();
  }, [fetchAttendanceAndSummary, fetchEmployees, fetchAppeals]);

  useEffect(() => {
    if (activeSection === 'SETTINGS_AUDIT') {
      fetchAuditLogs();
    } else if (activeSection === 'MONTHLY_REPORT') {
      fetchMonthlyReport();
    } else if (activeSection === 'APPEALS') {
      fetchAppeals();
    }
  }, [activeSection, fetchAuditLogs, fetchMonthlyReport, fetchAppeals]);

  const downloadExcelFromApi = async (
    apiUrlWithJsonFormat: string,
    mode: 'daily' | 'monthly'
  ) => {
    setExportingExcel(mode);
    setBanner(null);
    try {
      const resp = await apiFetch(apiUrlWithJsonFormat, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await resp.json();
      if (!resp.ok || !data.base64) {
        setBanner({
          kind: 'error',
          text: data.error || 'Gagal mengunduh file Excel.',
        });
        return;
      }

      const binaryStr = window.atob(data.base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      const blob = new Blob([bytes], {
        type:
          data.mimeType ||
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = data.fileName || `Rekap-Absensi-${getWibParts().dateStr}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);

      setBanner({
        kind: 'success',
        text: `File Excel ${data.fileName} berhasil diunduh.`,
      });
    } catch (err: any) {
      setBanner({
        kind: 'error',
        text: err?.message || 'Gagal mengunduh file Excel.',
      });
    } finally {
      setExportingExcel(null);
    }
  };

  const handleExportAttendanceExcel = () => {
    const qs = new URLSearchParams();
    qs.set('format', 'json');
    if (dateFilter) qs.set('date', dateFilter);
    if (searchQuery) qs.set('search', searchQuery);
    downloadExcelFromApi(
      `/api/admin/attendance/export-excel?${qs.toString()}`,
      'daily'
    );
  };

  const handleExportMonthlyExcel = () => {
    const qs = new URLSearchParams();
    qs.set('format', 'json');
    qs.set('period', reportPeriod);
    downloadExcelFromApi(
      `/api/admin/monthly-report/export-excel?${qs.toString()}`,
      'monthly'
    );
  };

  const handleCreateEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreatingEmp(true);
    setBanner(null);
    try {
      const resp = await apiFetch('/api/admin/employees', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          employeeId: newEmpId,
          fullName: newEmpName,
          username: newEmpUsername,
          password: newEmpPassword,
          position: newEmpPosition.trim() || 'Karyawan',
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setBanner({
          kind: 'error',
          text: data.error || 'Gagal menambah karyawan.',
        });
      } else {
        setNewEmpName('');
        setNewEmpUsername('');
        setNewEmpPassword('');
        setNewEmpPosition('');
        await fetchEmployees();
        await fetchAttendanceAndSummary();
        setBanner({
          kind: 'success',
          text: `${data.employee.fullName} ditambahkan.`,
        });
      }
    } finally {
      setCreatingEmp(false);
    }
  };

  const handleFaceEnrollmentSuccess = async (bio: BiometricCaptureResult) => {
    const target = enrollingEmployee;
    setEnrollingEmployee(null);
    if (!target) return;

    const resp = await apiFetch(
      `/api/admin/employees/${encodeURIComponent(target.employeeId)}/face-profile`,
      {
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
      }
    );
    const data = await resp.json();
    if (!resp.ok) {
      setBanner({
        kind: 'error',
        text: data.error || 'Gagal menyimpan wajah.',
      });
    } else {
      await fetchEmployees();
      setBanner({
        kind: 'success',
        text: `Wajah ${target.fullName} terdaftar.`,
      });
    }
  };

  const handleToggleEmployeeActive = async (emp: EmployeeProfile) => {
    const resp = await apiFetch(
      `/api/admin/employees/${encodeURIComponent(emp.employeeId)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          isActive: !emp.isActive,
          reason: emp.isActive ? 'Nonaktifkan akun' : 'Aktifkan akun',
        }),
      }
    );
    if (resp.ok) {
      await fetchEmployees();
      await fetchAttendanceAndSummary();
    }
  };

  const handleConfirmResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetTargetEmp) return;
    const resp = await apiFetch(
      `/api/admin/employees/${encodeURIComponent(resetTargetEmp.employeeId)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          newPassword: resetNewPass,
          reason: 'Reset password karyawan',
        }),
      }
    );
    if (resp.ok) {
      setBanner({
        kind: 'success',
        text: `Password @${resetTargetEmp.username} diperbarui.`,
      });
      setResetTargetEmp(null);
      setResetNewPass('');
    }
  };

  const handleConfirmDeleteBiometrics = async () => {
    if (!deleteBioTarget) return;
    const resp = await apiFetch(
      `/api/admin/employees/${encodeURIComponent(deleteBioTarget.employeeId)}/biometrics`,
      {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reason: 'Hapus data wajah' }),
      }
    );
    if (resp.ok) {
      setBanner({
        kind: 'info',
        text: `Data wajah ${deleteBioTarget.fullName} dihapus.`,
      });
      setDeleteBioTarget(null);
      await fetchEmployees();
    }
  };

  const handleConfirmDeleteEmployee = async () => {
    if (!deleteEmpTarget) return;
    const resp = await apiFetch(
      `/api/admin/employees/${encodeURIComponent(deleteEmpTarget.employeeId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    if (resp.ok) {
      setBanner({
        kind: 'info',
        text: `Akun ${deleteEmpTarget.fullName} dihapus.`,
      });
      setDeleteEmpTarget(null);
      await fetchEmployees();
      await fetchAttendanceAndSummary();
    }
  };

  const handleConfirmAppealReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!appealReviewModal) return;
    setProcessingAppeal(true);
    try {
      const resp = await apiFetch(
        `/api/admin/appeals/${encodeURIComponent(
          appealReviewModal.appeal.appealId
        )}/review`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            decision: appealReviewModal.decision,
            reviewNote: appealReviewModal.note,
          }),
        }
      );
      const data = await resp.json();
      if (!resp.ok) {
        setBanner({
          kind: 'error',
          text: data.error || 'Gagal memproses sanggah.',
        });
      } else {
        const empName = appealReviewModal.appeal.employeeName;
        const approved = appealReviewModal.decision === 'APPROVE';
        setAppealReviewModal(null);
        await Promise.all([
          fetchAppeals(),
          fetchAttendanceAndSummary(),
          activeSection === 'MONTHLY_REPORT'
            ? fetchMonthlyReport()
            : Promise.resolve(),
        ]);
        setBanner({
          kind: 'success',
          text: `Sanggah ${empName} ${
            approved ? 'disetujui & tersinkron ke absensi' : 'ditolak'
          }.`,
        });
      }
    } finally {
      setProcessingAppeal(false);
    }
  };

  const openEvidenceModal = async (rec: AttendanceRecord) => {
    setEvidenceModal({ record: rec, loading: true });
    try {
      const resp = await apiFetch(
        `/api/admin/attendance/${encodeURIComponent(rec.transactionId)}/evidence`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      if (resp.ok) {
        const data = await resp.json();
        setEvidenceModal({
          record: rec,
          thumbnailDataUrl: data.evidence?.thumbnailDataUrl,
          loading: false,
        });
      } else {
        setEvidenceModal({ record: rec, loading: false });
      }
    } catch {
      setEvidenceModal({ record: rec, loading: false });
    }
  };

  const handleSubmitReviewDecision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reviewModal) return;
    const resp = await apiFetch(
      `/api/admin/attendance/${encodeURIComponent(
        reviewModal.record.transactionId
      )}/review`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          decision: reviewModal.decision,
          reason: reviewModal.reason,
        }),
      }
    );
    const data = await resp.json();
    if (!resp.ok) {
      setBanner({
        kind: 'error',
        text: data.error || 'Gagal menyimpan keputusan.',
      });
    } else {
      const empName = reviewModal.record.employeeName;
      setReviewModal(null);
      await Promise.all([fetchAttendanceAndSummary(), fetchAppeals()]);
      setBanner({
        kind: 'success',
        text: `Status absensi ${empName} diperbarui.`,
      });
    }
  };

  const handleUseCurrentGpsForOffice = async () => {
    try {
      const gps = await acquireFreshGpsLocation(12000);
      setSettingsForm((prev) =>
        prev
          ? {
              ...prev,
              latitude: gps.latitude,
              longitude: gps.longitude,
            }
          : null
      );
      setBanner({
        kind: 'info',
        text: `Koordinat (${gps.latitude}, ${gps.longitude}) diambil. Klik Simpan Pengaturan.`,
      });
    } catch (err: any) {
      setBanner({
        kind: 'error',
        text: err?.message || 'Gagal membaca GPS.',
      });
    }
  };

  const handleSaveOfficeSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settingsForm) return;
    setSavingSettings(true);
    try {
      const resp = await apiFetch('/api/admin/office-settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          ...settingsForm,
          reason: 'Pembaruan pengaturan kantor',
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setBanner({
          kind: 'error',
          text: data.error || 'Gagal menyimpan pengaturan.',
        });
      } else {
        setSettings(data.officeSettings);
        setSettingsForm(data.officeSettings);
        onSettingsUpdated(data.officeSettings);
        await fetchAuditLogs();
        setBanner({
          kind: 'success',
          text: 'Pengaturan disimpan.',
        });
      }
    } finally {
      setSavingSettings(false);
    }
  };

  const handleDownloadCloudBackup = async () => {
    const resp = await apiFetch('/api/admin/backup/export', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.ok) {
      const data = await resp.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Backup-Absensi-${getWibParts().dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      await fetchAuditLogs();
    }
  };

  const handleRestoreCloudBackup = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const resp = await apiFetch('/api/admin/backup/restore', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(parsed),
      });
      const data = await resp.json();
      if (resp.ok) {
        setBanner({
          kind: 'success',
          text: `Backup dipulihkan (${data.restoredCount} catatan).`,
        });
        await Promise.all([
          fetchAttendanceAndSummary(),
          fetchEmployees(),
          fetchAppeals(),
          fetchAuditLogs(),
        ]);
      } else {
        setBanner({
          kind: 'error',
          text: data.error || 'Gagal memulihkan backup.',
        });
      }
    } catch {
      setBanner({ kind: 'error', text: 'File JSON tidak valid.' });
    } finally {
      e.target.value = '';
    }
  };

  const handleChangeAdminPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    const resp = await apiFetch('/api/auth/change-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        currentPassword: curAdminPass,
        newPassword: newAdminPass,
      }),
    });
    const data = await resp.json();
    if (resp.ok) {
      setCurAdminPass('');
      setNewAdminPass('');
      setBanner({
        kind: 'success',
        text: 'Password Admin diperbarui.',
      });
    } else {
      setBanner({
        kind: 'error',
        text: data.error || 'Gagal mengubah password.',
      });
    }
  };

  const handleConnectGmail = async () => {
    try {
      const res = await connectGoogleForGmail();
      setGmailConnectedEmail(res.user.email || 'Terhubung');
      setBanner({
        kind: 'success',
        text: `Gmail ${res.user.email} terhubung.`,
      });
    } catch (err: any) {
      setBanner({
        kind: 'error',
        text: err?.message || 'Gagal menghubungkan Gmail.',
      });
    }
  };

  const handleConfirmSendMonthlyEmail = async () => {
    if (!confirmEmailModal) return;
    setSendingEmail(true);
    try {
      let gmailToken = getGmailAccessToken();
      if (!gmailToken) {
        const connected = await connectGoogleForGmail();
        gmailToken = connected.gmailAccessToken;
        setGmailConnectedEmail(connected.user.email || 'Terhubung');
      }

      const resp = await apiFetch('/api/admin/monthly-report/send-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          gmailAccessToken: gmailToken,
          period: confirmEmailModal.period,
          recipientEmail: confirmEmailModal.recipientEmail,
          triggerMode: confirmEmailModal.triggerMode,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setBanner({
          kind: 'error',
          text: data.error || 'Gagal mengirim email.',
        });
      } else {
        setConfirmEmailModal(null);
        await fetchMonthlyReport();
        setBanner({
          kind: 'success',
          text: `Rekap Excel (${data.period}) terkirim ke ${data.sentTo}.`,
        });
      }
    } catch (err: any) {
      setBanner({
        kind: 'error',
        text: err?.message || 'Pengiriman dibatalkan.',
      });
    } finally {
      setSendingEmail(false);
    }
  };

  const pendingRecords = records.filter(
    (r) => r.attendanceStatus === 'NEEDS_REVIEW' && !r.appealId
  );
  const pendingAppeals = appeals.filter((a) => a.status === 'PENDING');
  const displayedAppeals =
    appealFilter === 'PENDING' ? pendingAppeals : appeals;
  const totalNeedsAction =
    (summary.pendingAppealCount ?? pendingAppeals.length) +
    (summary.pendingReviewCount ?? pendingRecords.length);

  const formatScopeLabel = (scope: AppealScope) => {
    if (scope === 'CHECK_IN') return 'Absen Masuk';
    if (scope === 'CHECK_OUT') return 'Absen Pulang';
    return 'Masuk & Pulang';
  };

  const getDailyStatusBadgeClass = (status: DailyOverallStatus) => {
    switch (status) {
      case 'HADIR_LENGKAP':
      case 'SUDAH_MASUK':
        return 'bg-emerald-50 text-emerald-900 border-emerald-300';
      case 'HADIR_SANGGAH':
        return 'bg-sky-50 text-sky-900 border-sky-300';
      case 'TERLAMBAT':
      case 'PULANG_CEPAT':
        return 'bg-amber-50 text-amber-900 border-amber-300';
      case 'MENUNGGU_SANGGAH':
      case 'MENUNGGU_REVIEW':
        return 'bg-amber-100/80 text-amber-950 border-amber-400';
      case 'DITOLAK':
        return 'bg-red-50 text-red-900 border-red-300';
      case 'BELUM_HADIR':
      default:
        return 'bg-slate-100 text-slate-700 border-slate-300';
    }
  };

  const renderRecordStatusBadge = (rec: AttendanceRecord) => {
    if (rec.appealStatus === 'APPROVED' && rec.attendanceStatus === 'VALID') {
      return (
        <span className="inline-block rounded-md border border-sky-300 bg-sky-50 px-2 py-0.5 text-[11px] font-bold text-sky-900 whitespace-nowrap">
          Sanggah Disetujui
        </span>
      );
    }
    if (rec.appealStatus === 'PENDING') {
      return (
        <span className="inline-block rounded-md border border-amber-400 bg-amber-100/80 px-2 py-0.5 text-[11px] font-bold text-amber-950 whitespace-nowrap">
          Menunggu Sanggah
        </span>
      );
    }
    if (rec.attendanceStatus === 'VALID') {
      return (
        <span className="inline-block rounded-md border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-900 whitespace-nowrap">
          Tepat Waktu
        </span>
      );
    }
    if (rec.attendanceStatus === 'LATE') {
      return (
        <span className="inline-block rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-900 whitespace-nowrap">
          Terlambat
        </span>
      );
    }
    if (rec.attendanceStatus === 'EARLY_LEAVE') {
      return (
        <span className="inline-block rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-900 whitespace-nowrap">
          Pulang Cepat
        </span>
      );
    }
    if (rec.attendanceStatus === 'NEEDS_REVIEW') {
      return (
        <span className="inline-block rounded-md border border-amber-400 bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-950 whitespace-nowrap">
          Perlu Review
        </span>
      );
    }
    return (
      <span className="inline-block rounded-md border border-red-300 bg-red-50 px-2 py-0.5 text-[11px] font-bold text-red-900 whitespace-nowrap">
        Ditolak
      </span>
    );
  };

  const todayWibStr = getWibParts().dateStr;
  const isShowingAllDates = !dateFilter || dateFilter === 'ALL';

  return (
    <div className="max-w-7xl mx-auto px-3.5 sm:px-6 py-4 sm:py-6 space-y-4 sm:space-y-6">
      {banner && (
        <div
          className={`rounded-xl border p-3.5 flex items-center justify-between gap-3 text-xs sm:text-sm ${
            banner.kind === 'success'
              ? 'border-emerald-300 bg-emerald-50 text-emerald-950'
              : banner.kind === 'error'
              ? 'border-red-300 bg-red-50 text-red-950'
              : 'border-sky-300 bg-sky-50 text-sky-950'
          }`}
        >
          <span className="min-w-0 break-words font-medium">{banner.text}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="min-h-[36px] px-2 text-xs font-semibold underline shrink-0 whitespace-nowrap"
          >
            Tutup
          </button>
        </div>
      )}

      {/* SECTION 1: OVERVIEW (DATA ABSENSI TERPADU & SINKRON SANGGAH) */}
      {activeSection === 'OVERVIEW' && (
        <div className="space-y-4 sm:space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <div className="rounded-xl bg-white border border-slate-200 p-4">
              <span className="text-xs font-medium text-slate-600 block">
                Total Karyawan
              </span>
              <span className="text-2xl sm:text-3xl font-bold font-mono text-slate-900 tabular-nums mt-1 block">
                {summary.totalEmployees}
              </span>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-4">
              <span className="text-xs font-medium text-slate-600 block truncate">
                Hadir · {formatWibDateLong(summary.dateWib)}
              </span>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-2xl sm:text-3xl font-bold font-mono text-emerald-700 tabular-nums">
                  {summary.presentCount}
                </span>
                {summary.approvedAppealTodayCount > 0 && (
                  <span className="text-[11px] font-semibold text-sky-800 whitespace-nowrap">
                    ({summary.approvedAppealTodayCount} sanggah)
                  </span>
                )}
              </div>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-4">
              <span className="text-xs font-medium text-slate-600 block">
                Terlambat
              </span>
              <span className="text-2xl sm:text-3xl font-bold font-mono text-amber-700 tabular-nums mt-1 block">
                {summary.lateCount}
              </span>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-4">
              <span className="text-xs font-medium text-slate-600 block">
                Belum Hadir
              </span>
              <span className="text-2xl sm:text-3xl font-bold font-mono text-slate-700 tabular-nums mt-1 block">
                {summary.absentCount}
              </span>
            </div>
          </div>

          {totalNeedsAction > 0 && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-3.5 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 text-xs sm:text-sm text-amber-950">
                <AlertTriangle className="w-5 h-5 text-amber-700 shrink-0" />
                <span>
                  <strong>{totalNeedsAction} pengajuan sanggah / review</strong>{' '}
                  menunggu keputusan Admin.
                </span>
              </div>
              <button
                type="button"
                onClick={() => onChangeSection('APPEALS')}
                className="w-full sm:w-auto rounded-xl bg-[#0F2942] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#163A5C] min-h-[44px] whitespace-nowrap"
              >
                Periksa Sanggah ({totalNeedsAction})
              </button>
            </div>
          )}

          <div className="rounded-2xl bg-white border border-slate-200 p-4 sm:p-6 space-y-4">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
              <div className="space-y-1">
                <h2 className="text-base font-bold text-slate-900">
                  Daftar Kehadiran &amp; Sanggah Tersinkron
                </h2>
                <p className="text-xs text-slate-600">
                  {isShowingAllDates
                    ? 'Menampilkan seluruh tanggal kehadiran'
                    : `Tanggal kerja: ${formatWibDateLong(dateFilter)}`}
                </p>
              </div>

              <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2.5">
                <div className="relative w-full sm:w-52">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Cari nama / ID..."
                    className="w-full pl-9 pr-3 py-2 text-base sm:text-xs rounded-xl border border-slate-300 focus:outline-none focus:border-[#0F2942] min-h-[44px]"
                  />
                </div>

                <div className="flex items-center gap-1.5">
                  <input
                    type="date"
                    value={isShowingAllDates ? '' : dateFilter}
                    onChange={(e) => setDateFilter(e.target.value || 'ALL')}
                    className="flex-1 sm:w-auto px-3 py-2 text-base sm:text-xs font-mono rounded-xl border border-slate-300 focus:outline-none focus:border-[#0F2942] min-h-[44px]"
                  />
                  <button
                    type="button"
                    onClick={() => setDateFilter(todayWibStr)}
                    className={`rounded-xl border px-3 py-2 text-xs font-semibold min-h-[44px] whitespace-nowrap ${
                      dateFilter === todayWibStr
                        ? 'border-[#0F2942] bg-[#0F2942] text-white'
                        : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    Hari Ini
                  </button>
                  <button
                    type="button"
                    onClick={() => setDateFilter('ALL')}
                    className={`rounded-xl border px-3 py-2 text-xs font-semibold min-h-[44px] whitespace-nowrap ${
                      isShowingAllDates
                        ? 'border-[#0F2942] bg-[#0F2942] text-white'
                        : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    Semua
                  </button>
                </div>

                <button
                  type="button"
                  disabled={exportingExcel === 'daily'}
                  onClick={handleExportAttendanceExcel}
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-700 px-3.5 py-2.5 text-xs font-bold text-white hover:bg-emerald-800 disabled:opacity-50 min-h-[44px] whitespace-nowrap"
                >
                  <FileSpreadsheet className="w-4 h-4 shrink-0" />
                  <span>
                    {exportingExcel === 'daily'
                      ? 'Menyiapkan Excel...'
                      : 'Unduh Excel (.xlsx)'}
                  </span>
                </button>
              </div>
            </div>

            {/* Segmented Mode: Rekap Harian (paired Masuk/Pulang) vs Log Transaksi */}
            <div className="flex items-center justify-between gap-2 border-y border-slate-100 py-2.5">
              <div className="grid grid-cols-2 gap-1.5 rounded-xl bg-slate-100 p-1 w-full sm:w-72">
                <button
                  type="button"
                  onClick={() => setAttendanceViewMode('DAILY')}
                  className={`min-h-[38px] rounded-lg px-3 text-xs font-bold whitespace-nowrap ${
                    attendanceViewMode === 'DAILY'
                      ? 'bg-white text-[#0F2942] shadow-sm'
                      : 'text-slate-600'
                  }`}
                >
                  Rekap Harian ({dailyEntries.length})
                </button>
                <button
                  type="button"
                  onClick={() => setAttendanceViewMode('RAW')}
                  className={`min-h-[38px] rounded-lg px-3 text-xs font-bold whitespace-nowrap ${
                    attendanceViewMode === 'RAW'
                      ? 'bg-white text-[#0F2942] shadow-sm'
                      : 'text-slate-600'
                  }`}
                >
                  Log Transaksi ({records.length})
                </button>
              </div>
            </div>

            {loading ? (
              <p className="text-xs text-slate-500 py-8 text-center">
                Memuat data absensi...
              </p>
            ) : attendanceViewMode === 'DAILY' ? (
              dailyEntries.length === 0 ? (
                <p className="text-sm text-slate-500 py-8 text-center border border-dashed border-slate-200 rounded-xl">
                  Belum ada data kehadiran pada filter ini.
                </p>
              ) : (
                <>
                  {/* Mobile Android Cards — Paired Masuk & Pulang, High Legibility */}
                  <div className="md:hidden space-y-3">
                    {dailyEntries.map((entry) => (
                      <div
                        key={entry.key}
                        className="rounded-xl border border-slate-200 bg-white p-3.5 space-y-3 text-xs"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <span className="font-bold text-sm text-slate-900 block truncate">
                              {entry.employeeName}
                            </span>
                            <span className="font-mono text-[11px] text-slate-500 block">
                              {entry.employeeId} · {entry.position}
                            </span>
                            <span className="text-[11px] font-medium text-slate-600 block mt-0.5">
                              {formatWibDateLong(entry.workDateWib)}
                            </span>
                          </div>
                          <span
                            className={`inline-block rounded-md border px-2.5 py-1 text-[11px] font-bold shrink-0 whitespace-nowrap ${getDailyStatusBadgeClass(
                              entry.overallStatus
                            )}`}
                          >
                            {entry.overallLabel}
                          </span>
                        </div>

                        <div className="grid grid-cols-3 gap-2 rounded-lg bg-slate-50 border border-slate-200/80 p-2.5">
                          <div>
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 block">
                              Jam Masuk
                            </span>
                            <span className="font-mono text-sm font-bold text-slate-900 tabular-nums block mt-0.5">
                              {entry.checkInTimeWib}
                            </span>
                            <span className="text-[11px] text-slate-600 block truncate">
                              {entry.checkInStatusLabel}
                            </span>
                          </div>
                          <div className="border-x border-slate-200 px-2">
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 block">
                              Jam Pulang
                            </span>
                            <span className="font-mono text-sm font-bold text-slate-900 tabular-nums block mt-0.5">
                              {entry.checkOutTimeWib}
                            </span>
                            <span className="text-[11px] text-slate-600 block truncate">
                              {entry.checkOutStatusLabel}
                            </span>
                          </div>
                          <div>
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 block">
                              Durasi
                            </span>
                            <span className="font-mono text-sm font-bold text-slate-900 tabular-nums block mt-0.5">
                              {entry.durationLabel}
                            </span>
                            <span className="text-[11px] text-slate-600 block truncate">
                              {entry.sourceLabel}
                            </span>
                          </div>
                        </div>

                        {(entry.notes || entry.locationOrFaceSummary !== '-') && (
                          <div className="text-[11px] text-slate-700 space-y-0.5 bg-slate-50/70 rounded-lg px-2.5 py-2 border border-slate-100">
                            {entry.locationOrFaceSummary !== '-' && (
                              <p className="font-mono text-slate-600">
                                {entry.locationOrFaceSummary}
                              </p>
                            )}
                            {entry.notes && (
                              <p className="font-medium text-slate-800 break-words">
                                {entry.notes}
                              </p>
                            )}
                          </div>
                        )}

                        <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                          <div className="flex flex-wrap gap-1.5">
                            {entry.checkInRecord && (
                              <button
                                type="button"
                                onClick={() =>
                                  openEvidenceModal(entry.checkInRecord!)
                                }
                                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 min-h-[38px] whitespace-nowrap"
                              >
                                <Eye className="w-3.5 h-3.5 shrink-0" />
                                <span>Detail Masuk</span>
                              </button>
                            )}
                            {entry.checkOutRecord && (
                              <button
                                type="button"
                                onClick={() =>
                                  openEvidenceModal(entry.checkOutRecord!)
                                }
                                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 min-h-[38px] whitespace-nowrap"
                              >
                                <Eye className="w-3.5 h-3.5 shrink-0" />
                                <span>Detail Pulang</span>
                              </button>
                            )}
                          </div>

                          {entry.linkedAppeal?.status === 'PENDING' && (
                            <div className="flex items-center gap-1.5 ml-auto">
                              <button
                                type="button"
                                onClick={() =>
                                  setAppealReviewModal({
                                    appeal: entry.linkedAppeal!,
                                    decision: 'APPROVE',
                                    note: '',
                                  })
                                }
                                className="inline-flex items-center gap-1 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-800 min-h-[38px] whitespace-nowrap"
                              >
                                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                                <span>Setujui Sanggah</span>
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setAppealReviewModal({
                                    appeal: entry.linkedAppeal!,
                                    decision: 'REJECT',
                                    note: '',
                                  })
                                }
                                className="inline-flex items-center gap-1 rounded-lg bg-red-700 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-red-800 min-h-[38px] whitespace-nowrap"
                              >
                                <XCircle className="w-3.5 h-3.5 shrink-0" />
                                <span>Tolak</span>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Desktop Table — Paired Jam Masuk & Jam Pulang */}
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 text-slate-600">
                          <th className="py-2.5 pr-3 font-semibold">Tanggal</th>
                          <th className="py-2.5 pr-3 font-semibold">Karyawan</th>
                          <th className="py-2.5 pr-3 font-semibold">Jam Masuk</th>
                          <th className="py-2.5 pr-3 font-semibold">Jam Pulang</th>
                          <th className="py-2.5 pr-3 font-semibold">Durasi</th>
                          <th className="py-2.5 pr-3 font-semibold">Status</th>
                          <th className="py-2.5 pr-3 font-semibold">
                            Sumber &amp; Keterangan
                          </th>
                          <th className="py-2.5 font-semibold text-right">
                            Tindakan
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {dailyEntries.map((entry) => (
                          <tr
                            key={entry.key}
                            className="hover:bg-slate-50/80 align-top"
                          >
                            <td className="py-3 pr-3 whitespace-nowrap">
                              <span className="font-semibold text-slate-900 block">
                                {formatWibDateLong(entry.workDateWib)}
                              </span>
                              <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                                {entry.workDateWib}
                              </span>
                            </td>
                            <td className="py-3 pr-3">
                              <span className="font-bold text-slate-900 block">
                                {entry.employeeName}
                              </span>
                              <span className="font-mono text-[11px] text-slate-500">
                                {entry.employeeId} · {entry.position}
                              </span>
                            </td>
                            <td className="py-3 pr-3 whitespace-nowrap">
                              <span className="font-mono text-sm font-bold text-slate-900 tabular-nums block">
                                {entry.checkInTimeWib}
                              </span>
                              <span className="text-[11px] text-slate-600">
                                {entry.checkInStatusLabel}
                              </span>
                            </td>
                            <td className="py-3 pr-3 whitespace-nowrap">
                              <span className="font-mono text-sm font-bold text-slate-900 tabular-nums block">
                                {entry.checkOutTimeWib}
                              </span>
                              <span className="text-[11px] text-slate-600">
                                {entry.checkOutStatusLabel}
                              </span>
                            </td>
                            <td className="py-3 pr-3 font-mono text-slate-800 tabular-nums whitespace-nowrap">
                              {entry.durationLabel}
                            </td>
                            <td className="py-3 pr-3 whitespace-nowrap">
                              <span
                                className={`inline-block rounded-md border px-2.5 py-1 text-[11px] font-bold ${getDailyStatusBadgeClass(
                                  entry.overallStatus
                                )}`}
                              >
                                {entry.overallLabel}
                              </span>
                            </td>
                            <td className="py-3 pr-3 max-w-xs">
                              <span className="font-semibold text-slate-800 block">
                                {entry.sourceLabel}
                              </span>
                              {entry.locationOrFaceSummary !== '-' && (
                                <span className="font-mono text-[11px] text-slate-500 block">
                                  {entry.locationOrFaceSummary}
                                </span>
                              )}
                              {entry.notes && (
                                <span className="text-[11px] text-slate-700 block mt-0.5 break-words">
                                  {entry.notes}
                                </span>
                              )}
                            </td>
                            <td className="py-3 text-right whitespace-nowrap">
                              <div className="inline-flex flex-wrap justify-end gap-1.5">
                                {entry.linkedAppeal?.status === 'PENDING' && (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setAppealReviewModal({
                                          appeal: entry.linkedAppeal!,
                                          decision: 'APPROVE',
                                          note: '',
                                        })
                                      }
                                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-700 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-emerald-800 min-h-[36px]"
                                    >
                                      <CheckCircle2 className="w-3.5 h-3.5" />
                                      <span>Setujui</span>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setAppealReviewModal({
                                          appeal: entry.linkedAppeal!,
                                          decision: 'REJECT',
                                          note: '',
                                        })
                                      }
                                      className="inline-flex items-center gap-1 rounded-lg bg-red-700 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-red-800 min-h-[36px]"
                                    >
                                      <XCircle className="w-3.5 h-3.5" />
                                      <span>Tolak</span>
                                    </button>
                                  </>
                                )}
                                {entry.checkInRecord && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      openEvidenceModal(entry.checkInRecord!)
                                    }
                                    className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 min-h-[36px]"
                                  >
                                    <Eye className="w-3.5 h-3.5" />
                                    <span>Masuk</span>
                                  </button>
                                )}
                                {entry.checkOutRecord && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      openEvidenceModal(entry.checkOutRecord!)
                                    }
                                    className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 min-h-[36px]"
                                  >
                                    <Eye className="w-3.5 h-3.5" />
                                    <span>Pulang</span>
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )
            ) : records.length === 0 ? (
              <p className="text-sm text-slate-500 py-8 text-center border border-dashed border-slate-200 rounded-xl">
                Belum ada transaksi absensi pada filter ini.
              </p>
            ) : (
              <>
                <div className="md:hidden divide-y divide-slate-100">
                  {records.map((rec) => (
                    <div
                      key={rec.transactionId}
                      className="py-3.5 space-y-2 text-xs"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <span className="font-bold text-slate-900 block truncate">
                            {rec.employeeName}
                          </span>
                          <span className="font-mono text-[11px] text-slate-500">
                            {rec.employeeId} ·{' '}
                            {rec.type === 'CHECK_IN' ? 'Absen Masuk' : 'Absen Pulang'} ·{' '}
                            {formatWibDateLong(rec.workDateWib)}
                          </span>
                        </div>
                        {renderRecordStatusBadge(rec)}
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-slate-700 tabular-nums">
                        <span className="inline-flex items-center gap-1 font-bold text-slate-900">
                          <Clock className="w-3.5 h-3.5 text-slate-500" />
                          {formatWibHourMinute(
                            rec.serverTimestampIso || rec.deviceTimestampIso
                          )}
                        </span>
                        <span className="font-sans text-slate-600">
                          {rec.appealId || rec.livenessDetail.startsWith('Sanggah')
                            ? rec.reviewNote || rec.livenessDetail
                            : `${rec.distanceToOfficeMeters}m · Wajah ${(
                                rec.faceMatchScore * 100
                              ).toFixed(0)}%`}
                        </span>
                      </div>

                      <div className="flex justify-end pt-0.5">
                        <button
                          type="button"
                          onClick={() => openEvidenceModal(rec)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 min-h-[38px]"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>Detail</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-600">
                        <th className="py-2.5 pr-3 font-semibold">Tanggal</th>
                        <th className="py-2.5 pr-3 font-semibold">Karyawan</th>
                        <th className="py-2.5 pr-3 font-semibold">Jenis</th>
                        <th className="py-2.5 pr-3 font-semibold">Jam WIB</th>
                        <th className="py-2.5 pr-3 font-semibold">Keterangan</th>
                        <th className="py-2.5 pr-3 font-semibold">Status</th>
                        <th className="py-2.5 font-semibold text-right">Bukti</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {records.map((rec) => (
                        <tr
                          key={rec.transactionId}
                          className="hover:bg-slate-50/70"
                        >
                          <td className="py-3 pr-3 whitespace-nowrap">
                            <span className="font-semibold text-slate-900 block">
                              {formatWibDateLong(rec.workDateWib)}
                            </span>
                            <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                              {rec.workDateWib}
                            </span>
                          </td>
                          <td className="py-3 pr-3">
                            <span className="font-semibold text-slate-900 block">
                              {rec.employeeName}
                            </span>
                            <span className="text-[11px] font-mono text-slate-500">
                              {rec.employeeId}
                            </span>
                          </td>
                          <td className="py-3 pr-3 font-semibold text-slate-800 whitespace-nowrap">
                            {rec.type === 'CHECK_IN'
                              ? 'Absen Masuk'
                              : 'Absen Pulang'}
                          </td>
                          <td className="py-3 pr-3 font-mono font-bold text-slate-900 tabular-nums whitespace-nowrap">
                            {formatWibHourMinute(
                              rec.serverTimestampIso || rec.deviceTimestampIso
                            )}
                          </td>
                          <td className="py-3 pr-3 text-slate-700 max-w-xs break-words">
                            {rec.appealId ||
                            rec.livenessDetail.startsWith('Sanggah')
                              ? `${rec.livenessDetail}${
                                  rec.reviewNote ? ` — ${rec.reviewNote}` : ''
                                }`
                              : `${rec.distanceToOfficeMeters}m · ±${
                                  rec.gpsAccuracyMeters
                                }m · Wajah ${(rec.faceMatchScore * 100).toFixed(
                                  0
                                )}%`}
                          </td>
                          <td className="py-3 pr-3">
                            {renderRecordStatusBadge(rec)}
                          </td>
                          <td className="py-3 text-right whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => openEvidenceModal(rec)}
                              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 min-h-[36px]"
                            >
                              <Eye className="w-3.5 h-3.5" />
                              <span>Detail</span>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* SECTION 2: SANGGAH ABSEN & OFFLINE PENDING */}
      {activeSection === 'APPEALS' && (
        <div className="space-y-4 sm:space-y-6">
          <div className="rounded-2xl bg-white border border-slate-200 p-4 sm:p-6 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-slate-900">
                  Sanggah Absen ({pendingAppeals.length} Menunggu)
                </h2>
                <p className="text-xs text-slate-600 mt-0.5">
                  Keputusan sanggah otomatis memperbarui status hadir/terlambat/pulang di Data Absensi &amp; Rekap Excel.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-1.5 rounded-xl bg-slate-100 p-1 w-full sm:w-56">
                <button
                  type="button"
                  onClick={() => setAppealFilter('PENDING')}
                  className={`min-h-[38px] rounded-lg text-xs font-bold whitespace-nowrap ${
                    appealFilter === 'PENDING'
                      ? 'bg-white text-[#0F2942] shadow-sm'
                      : 'text-slate-600'
                  }`}
                >
                  Menunggu ({pendingAppeals.length})
                </button>
                <button
                  type="button"
                  onClick={() => setAppealFilter('ALL')}
                  className={`min-h-[38px] rounded-lg text-xs font-bold whitespace-nowrap ${
                    appealFilter === 'ALL'
                      ? 'bg-white text-[#0F2942] shadow-sm'
                      : 'text-slate-600'
                  }`}
                >
                  Semua ({appeals.length})
                </button>
              </div>
            </div>

            {displayedAppeals.length === 0 ? (
              <p className="text-sm text-slate-500 py-8 text-center border border-dashed border-slate-200 rounded-xl">
                Tidak ada pengajuan sanggah pada kategori ini.
              </p>
            ) : (
              <div className="divide-y divide-slate-100">
                {displayedAppeals.map((apl) => (
                  <div
                    key={apl.appealId}
                    className="py-4 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs"
                  >
                    <div className="space-y-1.5 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-sm text-slate-900">
                          {apl.employeeName}
                        </span>
                        <span className="font-mono text-[11px] text-slate-500">
                          ({apl.employeeId})
                        </span>
                        <span className="px-2 py-0.5 rounded-md border border-slate-200 bg-slate-100 text-slate-800 font-semibold">
                          {formatWibDateLong(apl.workDateWib)} ·{' '}
                          {formatScopeLabel(apl.scope)}
                        </span>
                        <span className="px-2 py-0.5 rounded-md border border-sky-200 bg-sky-50 font-semibold text-[#0F2942]">
                          {apl.category}
                        </span>
                      </div>
                      <p className="text-slate-800 font-medium break-words">
                        {apl.reason}
                      </p>
                      {typeof apl.latitude === 'number' &&
                        typeof apl.longitude === 'number' && (
                          <p className="font-mono text-[11px] text-slate-500 tabular-nums">
                            GPS Lapangan: {apl.latitude}, {apl.longitude}
                          </p>
                        )}
                      {apl.status !== 'PENDING' && (
                        <p className="text-[11px] text-slate-600">
                          {apl.status === 'APPROVED'
                            ? 'Disetujui & Tersinkron ke Absensi'
                            : 'Ditolak'}{' '}
                          oleh <strong>{apl.reviewedBy || 'Admin'}</strong>
                          {apl.reviewNote ? ` · Catatan: ${apl.reviewNote}` : ''}
                        </p>
                      )}
                    </div>

                    {apl.status === 'PENDING' ? (
                      <div className="grid grid-cols-2 gap-2 shrink-0 md:w-56">
                        <button
                          type="button"
                          onClick={() =>
                            setAppealReviewModal({
                              appeal: apl,
                              decision: 'APPROVE',
                              note: '',
                            })
                          }
                          className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-700 px-3 py-2.5 text-xs font-bold text-white hover:bg-emerald-800 min-h-[44px] whitespace-nowrap"
                        >
                          <CheckCircle2 className="w-4 h-4 shrink-0" />
                          <span>Setujui</span>
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setAppealReviewModal({
                              appeal: apl,
                              decision: 'REJECT',
                              note: '',
                            })
                          }
                          className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-red-700 px-3 py-2.5 text-xs font-bold text-white hover:bg-red-800 min-h-[44px] whitespace-nowrap"
                        >
                          <XCircle className="w-4 h-4 shrink-0" />
                          <span>Tolak</span>
                        </button>
                      </div>
                    ) : (
                      <span
                        className={`inline-block rounded-md border px-2.5 py-1 text-[11px] font-bold shrink-0 whitespace-nowrap ${
                          apl.status === 'APPROVED'
                            ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                            : 'border-red-300 bg-red-50 text-red-900'
                        }`}
                      >
                        {apl.status === 'APPROVED'
                          ? 'Disetujui · Sinkron'
                          : 'Ditolak'}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {pendingRecords.length > 0 && (
            <div className="rounded-2xl bg-white border border-slate-200 p-4 sm:p-6 space-y-4">
              <h2 className="text-base font-bold text-slate-900">
                Absensi Offline / Perlu Pemeriksaan ({pendingRecords.length})
              </h2>
              <div className="divide-y divide-slate-100">
                {pendingRecords.map((rec) => (
                  <div
                    key={rec.transactionId}
                    className="py-3.5 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs"
                  >
                    <div className="space-y-1">
                      <p className="font-bold text-sm text-slate-900">
                        {rec.employeeName} ({rec.employeeId}) ·{' '}
                        {rec.type === 'CHECK_IN' ? 'Masuk' : 'Pulang'} ·{' '}
                        {formatWibDateLong(rec.workDateWib)}
                      </p>
                      <p className="font-mono text-[11px] text-slate-600 tabular-nums">
                        {formatWibDateTime(rec.deviceTimestampIso)} ·{' '}
                        {rec.distanceToOfficeMeters}m · Wajah{' '}
                        {(rec.faceMatchScore * 100).toFixed(0)}%
                      </p>
                      {rec.rejectionReason && (
                        <p className="text-amber-800 font-medium">
                          {rec.rejectionReason}
                        </p>
                      )}
                    </div>
                    <div className="grid grid-cols-3 gap-2 shrink-0 md:w-64">
                      <button
                        type="button"
                        onClick={() => openEvidenceModal(rec)}
                        className="rounded-xl border border-slate-300 px-2.5 py-2 text-xs font-semibold text-slate-700 min-h-[42px]"
                      >
                        Bukti
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setReviewModal({
                            record: rec,
                            decision: 'APPROVE_VALID',
                            reason: '',
                          })
                        }
                        className="rounded-xl bg-emerald-700 px-2.5 py-2 text-xs font-bold text-white min-h-[42px]"
                      >
                        Setujui
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setReviewModal({
                            record: rec,
                            decision: 'REJECT',
                            reason: '',
                          })
                        }
                        className="rounded-xl bg-red-700 px-2.5 py-2 text-xs font-bold text-white min-h-[42px]"
                      >
                        Tolak
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* SECTION 3: EMPLOYEES */}
      {activeSection === 'EMPLOYEES' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-6 items-start">
          <form
            onSubmit={handleCreateEmployee}
            className="lg:col-span-4 rounded-2xl bg-white border border-slate-200 p-4 sm:p-6 space-y-4"
          >
            <div className="flex items-center gap-2 text-[#0F2942]">
              <Users className="w-5 h-5 shrink-0" />
              <h2 className="text-base font-bold text-slate-900">
                Tambah Karyawan
              </h2>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="font-semibold text-slate-700 block mb-1">
                  ID Karyawan
                </label>
                <input
                  type="text"
                  required
                  value={newEmpId}
                  onChange={(e) => setNewEmpId(e.target.value.toUpperCase())}
                  className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 py-2.5 font-mono text-base sm:text-sm focus:outline-none focus:border-[#0F2942]"
                />
              </div>
              <div>
                <label className="font-semibold text-slate-700 block mb-1">
                  Nama Lengkap
                </label>
                <input
                  type="text"
                  required
                  value={newEmpName}
                  onChange={(e) => setNewEmpName(e.target.value)}
                  placeholder="Nama karyawan"
                  className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 py-2.5 text-base sm:text-sm focus:outline-none focus:border-[#0F2942]"
                />
              </div>
              <div>
                <label className="font-semibold text-slate-700 block mb-1">
                  Jabatan
                </label>
                <input
                  type="text"
                  required
                  value={newEmpPosition}
                  onChange={(e) => setNewEmpPosition(e.target.value)}
                  placeholder="Jabatan"
                  className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 py-2.5 text-base sm:text-sm focus:outline-none focus:border-[#0F2942]"
                />
              </div>
              <div>
                <label className="font-semibold text-slate-700 block mb-1">
                  Username
                </label>
                <input
                  type="text"
                  required
                  autoCapitalize="none"
                  autoCorrect="off"
                  value={newEmpUsername}
                  onChange={(e) =>
                    setNewEmpUsername(e.target.value.toLowerCase().trim())
                  }
                  placeholder="Username login"
                  className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 py-2.5 font-mono text-base sm:text-sm focus:outline-none focus:border-[#0F2942]"
                />
              </div>
              <div>
                <label className="font-semibold text-slate-700 block mb-1">
                  Password
                </label>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={newEmpPassword}
                  onChange={(e) => setNewEmpPassword(e.target.value)}
                  placeholder="Minimal 6 karakter"
                  className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 py-2.5 text-base sm:text-sm focus:outline-none focus:border-[#0F2942]"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={creatingEmp}
              className="w-full min-h-[48px] rounded-xl bg-[#0F2942] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#163A5C] active:scale-[0.98] disabled:opacity-50 transition-all"
            >
              {creatingEmp ? 'Menyimpan...' : 'Simpan Karyawan'}
            </button>
          </form>

          <div className="lg:col-span-8 rounded-2xl bg-white border border-slate-200 p-4 sm:p-6 space-y-4">
            <div>
              <h2 className="text-base font-bold text-slate-900">
                Daftar Karyawan ({employees.length}/10)
              </h2>
              <p className="text-xs text-slate-600 mt-0.5">
                Rekam wajah dapat dilakukan oleh Admin di bawah ini atau langsung dari akun masing-masing karyawan.
              </p>
            </div>

            {employees.length === 0 ? (
              <p className="text-sm text-slate-500 py-8 text-center border border-dashed border-slate-200 rounded-xl">
                Belum ada karyawan terdaftar.
              </p>
            ) : (
              <div className="divide-y divide-slate-100">
                {employees.map((emp) => (
                  <div
                    key={emp.employeeId}
                    className="py-4 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-sm text-slate-900 truncate">
                          {emp.fullName}
                        </span>
                        <span
                          className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold ${
                            emp.isActive
                              ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                              : 'border-slate-300 bg-slate-100 text-slate-500'
                          }`}
                        >
                          {emp.isActive ? 'Aktif' : 'Nonaktif'}
                        </span>
                      </div>
                      <p className="text-slate-500 font-mono text-[11px] truncate">
                        {emp.employeeId} · @{emp.username} ·{' '}
                        <span className="font-sans">{emp.position}</span>
                      </p>
                      <p className="text-[11px]">
                        Biometrik Wajah:{' '}
                        <strong
                          className={
                            emp.hasFaceProfile
                              ? 'text-emerald-700'
                              : 'text-amber-700'
                          }
                        >
                          {emp.hasFaceProfile
                            ? 'Terdaftar'
                            : 'Belum Direkam (Bisa rekam dari akun karyawan / Admin)'}
                        </strong>
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => setEnrollingEmployee(emp)}
                        className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-[#0F2942] px-3 py-2 text-xs font-semibold text-white hover:bg-[#163A5C] min-h-[40px] whitespace-nowrap"
                      >
                        <ScanFace className="w-4 h-4 shrink-0" />
                        <span>
                          {emp.hasFaceProfile ? 'Ubah Wajah' : 'Rekam Wajah'}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setResetTargetEmp(emp);
                          setResetNewPass('');
                        }}
                        className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 min-h-[40px] whitespace-nowrap"
                      >
                        Password
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleEmployeeActive(emp)}
                        className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 min-h-[40px] whitespace-nowrap"
                      >
                        {emp.isActive ? 'Nonaktifkan' : 'Aktifkan'}
                      </button>
                      {emp.hasFaceProfile && (
                        <button
                          type="button"
                          onClick={() => setDeleteBioTarget(emp)}
                          className="rounded-xl border border-amber-300 px-3 py-2 text-xs font-semibold text-amber-800 hover:bg-amber-50 min-h-[40px] whitespace-nowrap"
                        >
                          Hapus Wajah
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setDeleteEmpTarget(emp)}
                        className="inline-flex items-center justify-center rounded-xl border border-red-200 px-2.5 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 min-h-[40px]"
                        aria-label="Hapus karyawan"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* SECTION 4: MONTHLY REPORT (EXCEL .XLSX + GMAIL) */}
      {activeSection === 'MONTHLY_REPORT' && (
        <div className="rounded-2xl bg-white border border-slate-200 p-4 sm:p-6 space-y-5">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2 text-[#0F2942]">
                <FileSpreadsheet className="w-5 h-5 shrink-0" />
                <h2 className="text-base font-bold text-slate-900">
                  Rekap Bulanan Excel &amp; Pengiriman Email
                </h2>
              </div>
              <p className="text-xs text-slate-600">
                File Excel (.xlsx) mencakup 4 lembar kerja yang sinkron dengan Sanggah Absen.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:flex sm:flex-wrap items-center gap-2.5">
              <input
                type="month"
                value={reportPeriod}
                onChange={(e) => setReportPeriod(e.target.value)}
                className="w-full sm:w-auto rounded-xl border border-slate-300 px-3 py-2 text-base sm:text-xs font-mono min-h-[44px]"
              />
              <button
                type="button"
                disabled={exportingExcel === 'monthly'}
                onClick={handleExportMonthlyExcel}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 py-2.5 text-xs font-bold text-white hover:bg-emerald-800 disabled:opacity-50 min-h-[44px] whitespace-nowrap"
              >
                <FileSpreadsheet className="w-4 h-4 shrink-0" />
                <span>
                  {exportingExcel === 'monthly'
                    ? 'Menyiapkan Excel...'
                    : 'Unduh Excel (.xlsx)'}
                </span>
              </button>
              <button
                type="button"
                onClick={handleConnectGmail}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 min-h-[44px] whitespace-nowrap"
              >
                <Mail className="w-4 h-4 text-[#0F2942] shrink-0" />
                <span className="truncate">
                  {gmailConnectedEmail
                    ? `Gmail (${gmailConnectedEmail})`
                    : 'Hubungkan Gmail'}
                </span>
              </button>
              <button
                type="button"
                onClick={() =>
                  setConfirmEmailModal({
                    period: reportPeriod,
                    recipientEmail:
                      monthlyReportData?.adminReportEmail ||
                      settings?.adminReportEmail ||
                      'mull.jhamur@gmail.com',
                    triggerMode: 'MANUAL',
                  })
                }
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-[#0F2942] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#163A5C] min-h-[44px] whitespace-nowrap"
              >
                <Mail className="w-4 h-4 shrink-0" />
                <span>Kirim Email (.xlsx)</span>
              </button>
            </div>
          </div>

          {monthlyReportData && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600 border-y border-slate-100 py-2.5">
                <span className="break-all">
                  Tujuan Email:{' '}
                  <strong className="text-slate-900">
                    {monthlyReportData.adminReportEmail}
                  </strong>
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  Status Email:{' '}
                  <strong
                    className={
                      monthlyReportData.alreadySentForPeriod
                        ? 'text-emerald-700'
                        : 'text-slate-700'
                    }
                  >
                    {monthlyReportData.alreadySentForPeriod
                      ? 'Sudah Terkirim'
                      : 'Belum Dikirim'}
                  </strong>
                </span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">
                  {monthlyReportData.totalRecordsInMonth || 0} log absensi &amp;{' '}
                  {monthlyReportData.totalAppealsInMonth || 0} sanggah
                </span>
              </div>

              <div className="md:hidden divide-y divide-slate-100">
                {(monthlyReportData.rows || []).map((row: any) => (
                  <div key={row.employeeId} className="py-3.5 space-y-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <span className="font-bold text-slate-900 block truncate">
                          {row.fullName}
                        </span>
                        <span className="text-[11px] text-slate-500">
                          {row.position}
                        </span>
                      </div>
                      <span className="font-mono text-slate-500 shrink-0">
                        {row.employeeId}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-center font-mono tabular-nums pt-1">
                      <div className="rounded-lg bg-slate-50 border border-slate-200/80 p-2">
                        <span className="block font-sans text-[10px] text-slate-500">
                          Total Hadir
                        </span>
                        <strong className="text-slate-900">
                          {row.totalPresentDays}
                        </strong>
                      </div>
                      <div className="rounded-lg bg-emerald-50/70 border border-emerald-200 p-2">
                        <span className="block font-sans text-[10px] text-emerald-800">
                          Tepat Waktu
                        </span>
                        <strong className="text-emerald-800">
                          {row.onTimeDays}
                        </strong>
                      </div>
                      <div className="rounded-lg bg-amber-50/70 border border-amber-200 p-2">
                        <span className="block font-sans text-[10px] text-amber-800">
                          Terlambat
                        </span>
                        <strong className="text-amber-800">
                          {row.lateDays}
                        </strong>
                      </div>
                      <div className="rounded-lg bg-amber-50/70 border border-amber-200 p-2">
                        <span className="block font-sans text-[10px] text-amber-800">
                          Pulang Cepat
                        </span>
                        <strong className="text-amber-800">
                          {row.earlyLeaveDays || 0}
                        </strong>
                      </div>
                      <div className="rounded-lg bg-sky-50/70 border border-sky-200 p-2">
                        <span className="block font-sans text-[10px] text-sky-800">
                          Via Sanggah
                        </span>
                        <strong className="text-sky-800">
                          {row.approvedAppealDays || 0}
                        </strong>
                      </div>
                      <div className="rounded-lg bg-slate-50 border border-slate-200/80 p-2">
                        <span className="block font-sans text-[10px] text-slate-500">
                          Pulang
                        </span>
                        <strong className="text-slate-800">
                          {row.completedCheckOuts}
                        </strong>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-600">
                      <th className="py-2.5 pr-3 font-semibold">ID</th>
                      <th className="py-2.5 pr-3 font-semibold">Nama</th>
                      <th className="py-2.5 pr-3 font-semibold">Jabatan</th>
                      <th className="py-2.5 pr-3 font-semibold text-right">
                        Total Hadir
                      </th>
                      <th className="py-2.5 pr-3 font-semibold text-right">
                        Tepat Waktu
                      </th>
                      <th className="py-2.5 pr-3 font-semibold text-right">
                        Terlambat
                      </th>
                      <th className="py-2.5 pr-3 font-semibold text-right">
                        Pulang Cepat
                      </th>
                      <th className="py-2.5 pr-3 font-semibold text-right">
                        Sanggah Disetujui
                      </th>
                      <th className="py-2.5 pr-3 font-semibold text-right">
                        Sudah Pulang
                      </th>
                      <th className="py-2.5 font-semibold text-right">
                        Menunggu
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono tabular-nums">
                    {(monthlyReportData.rows || []).map((row: any) => (
                      <tr key={row.employeeId} className="hover:bg-slate-50/70">
                        <td className="py-2.5 pr-3 text-slate-700">
                          {row.employeeId}
                        </td>
                        <td className="py-2.5 pr-3 font-sans font-semibold text-slate-900">
                          {row.fullName}
                        </td>
                        <td className="py-2.5 pr-3 font-sans text-slate-600">
                          {row.position}
                        </td>
                        <td className="py-2.5 pr-3 text-right font-bold text-slate-900">
                          {row.totalPresentDays}
                        </td>
                        <td className="py-2.5 pr-3 text-right text-emerald-700 font-semibold">
                          {row.onTimeDays}
                        </td>
                        <td className="py-2.5 pr-3 text-right text-amber-700 font-semibold">
                          {row.lateDays}
                        </td>
                        <td className="py-2.5 pr-3 text-right text-amber-700">
                          {row.earlyLeaveDays || 0}
                        </td>
                        <td className="py-2.5 pr-3 text-right text-sky-700 font-semibold">
                          {row.approvedAppealDays || 0}
                        </td>
                        <td className="py-2.5 pr-3 text-right text-slate-700">
                          {row.completedCheckOuts}
                        </td>
                        <td className="py-2.5 text-right text-slate-600">
                          {row.pendingDays || 0}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* SECTION 5: OFFICE SETTINGS, BACKUP & AUDIT */}
      {activeSection === 'SETTINGS_AUDIT' && settingsForm && (
        <div className="space-y-4 sm:space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-6 items-start">
            <form
              onSubmit={handleSaveOfficeSettings}
              className="lg:col-span-7 rounded-2xl bg-white border border-slate-200 p-4 sm:p-6 space-y-4"
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                <div className="flex items-center gap-2 text-[#0F2942]">
                  <MapPin className="w-5 h-5 shrink-0" />
                  <h2 className="text-base font-bold text-slate-900">
                    Pengaturan Kantor
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={handleUseCurrentGpsForOffice}
                  className="w-full sm:w-auto rounded-xl border border-[#0F2942] px-3.5 py-2 text-xs font-semibold text-[#0F2942] hover:bg-slate-50 min-h-[44px] whitespace-nowrap"
                >
                  Titik GPS Saat Ini
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 text-xs">
                <div className="sm:col-span-2">
                  <label className="font-semibold text-slate-700 block mb-1">
                    Nama Kantor
                  </label>
                  <input
                    type="text"
                    required
                    value={settingsForm.officeName}
                    onChange={(e) =>
                      setSettingsForm({
                        ...settingsForm,
                        officeName: e.target.value,
                      })
                    }
                    className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 py-2 text-base sm:text-sm"
                  />
                </div>
                <div>
                  <label className="font-semibold text-slate-700 block mb-1">
                    Latitude
                  </label>
                  <input
                    type="number"
                    step="any"
                    required
                    value={settingsForm.latitude}
                    onChange={(e) =>
                      setSettingsForm({
                        ...settingsForm,
                        latitude: Number(e.target.value),
                      })
                    }
                    className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 py-2 font-mono text-base sm:text-sm"
                  />
                </div>
                <div>
                  <label className="font-semibold text-slate-700 block mb-1">
                    Longitude
                  </label>
                  <input
                    type="number"
                    step="any"
                    required
                    value={settingsForm.longitude}
                    onChange={(e) =>
                      setSettingsForm({
                        ...settingsForm,
                        longitude: Number(e.target.value),
                      })
                    }
                    className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 py-2 font-mono text-base sm:text-sm"
                  />
                </div>
                <div>
                  <label className="font-semibold text-slate-700 block mb-1">
                    Radius (m)
                  </label>
                  <input
                    type="number"
                    min={10}
                    max={5000}
                    required
                    value={settingsForm.radiusMeters}
                    onChange={(e) =>
                      setSettingsForm({
                        ...settingsForm,
                        radiusMeters: Number(e.target.value),
                      })
                    }
                    className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 py-2 font-mono text-base sm:text-sm"
                  />
                </div>
                <div>
                  <label className="font-semibold text-slate-700 block mb-1">
                    Maks Akurasi GPS (m)
                  </label>
                  <input
                    type="number"
                    min={5}
                    max={500}
                    required
                    value={settingsForm.maxGpsAccuracyMeters}
                    onChange={(e) =>
                      setSettingsForm({
                        ...settingsForm,
                        maxGpsAccuracyMeters: Number(e.target.value),
                      })
                    }
                    className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 py-2 font-mono text-base sm:text-sm"
                  />
                </div>
                <div>
                  <label className="font-semibold text-slate-700 block mb-1">
                    Jam Masuk
                  </label>
                  <input
                    type="time"
                    required
                    value={settingsForm.workStartTime}
                    onChange={(e) =>
                      setSettingsForm({
                        ...settingsForm,
                        workStartTime: e.target.value,
                      })
                    }
                    className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 py-2 font-mono text-base sm:text-sm"
                  />
                </div>
                <div>
                  <label className="font-semibold text-slate-700 block mb-1">
                    Jam Pulang
                  </label>
                  <input
                    type="time"
                    required
                    value={settingsForm.workEndTime}
                    onChange={(e) =>
                      setSettingsForm({
                        ...settingsForm,
                        workEndTime: e.target.value,
                      })
                    }
                    className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 py-2 font-mono text-base sm:text-sm"
                  />
                </div>
                <div>
                  <label className="font-semibold text-slate-700 block mb-1">
                    Toleransi Telat (menit)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={240}
                    required
                    value={settingsForm.lateToleranceMinutes}
                    onChange={(e) =>
                      setSettingsForm({
                        ...settingsForm,
                        lateToleranceMinutes: Number(e.target.value),
                      })
                    }
                    className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 py-2 font-mono text-base sm:text-sm"
                  />
                </div>
                <div>
                  <label className="font-semibold text-slate-700 block mb-1">
                    Ambang Wajah (0.70–0.95)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min={0.7}
                    max={0.95}
                    required
                    value={settingsForm.faceMatchThreshold}
                    onChange={(e) =>
                      setSettingsForm({
                        ...settingsForm,
                        faceMatchThreshold: Number(e.target.value),
                      })
                    }
                    className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 py-2 font-mono text-base sm:text-sm"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="font-semibold text-slate-700 block mb-1">
                    Email Laporan Admin
                  </label>
                  <input
                    type="email"
                    required
                    value={settingsForm.adminReportEmail}
                    onChange={(e) =>
                      setSettingsForm({
                        ...settingsForm,
                        adminReportEmail: e.target.value,
                      })
                    }
                    className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 py-2 text-base sm:text-sm"
                  />
                </div>
                <div className="sm:col-span-2 flex flex-wrap gap-5 pt-1">
                  <label className="inline-flex items-center gap-2 cursor-pointer min-h-[36px]">
                    <input
                      type="checkbox"
                      checked={settingsForm.enableNightShift}
                      onChange={(e) =>
                        setSettingsForm({
                          ...settingsForm,
                          enableNightShift: e.target.checked,
                        })
                      }
                      className="w-4 h-4 rounded border-slate-300"
                    />
                    <span className="font-medium text-slate-800">
                      Shift Malam
                    </span>
                  </label>
                  <label className="inline-flex items-center gap-2 cursor-pointer min-h-[36px]">
                    <input
                      type="checkbox"
                      checked={settingsForm.autoMonthlyReportEnabled}
                      onChange={(e) =>
                        setSettingsForm({
                          ...settingsForm,
                          autoMonthlyReportEnabled: e.target.checked,
                        })
                      }
                      className="w-4 h-4 rounded border-slate-300"
                    />
                    <span className="font-medium text-slate-800">
                      Email Excel Otomatis Akhir Bulan
                    </span>
                  </label>
                </div>
              </div>

              <button
                type="submit"
                disabled={savingSettings}
                className="w-full min-h-[48px] rounded-xl bg-[#0F2942] px-4 py-2.5 text-xs font-bold text-white hover:bg-[#163A5C] active:scale-[0.98] transition-all"
              >
                {savingSettings ? 'Menyimpan...' : 'Simpan Pengaturan'}
              </button>
            </form>

            <div className="lg:col-span-5 space-y-4 sm:space-y-6">
              <div className="rounded-2xl bg-white border border-slate-200 p-4 sm:p-6 space-y-3">
                <div className="flex items-center gap-2 text-[#0F2942]">
                  <ShieldCheck className="w-5 h-5 shrink-0" />
                  <h2 className="text-base font-bold text-slate-900">
                    Backup &amp; Aplikasi Android
                  </h2>
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={handleDownloadCloudBackup}
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-[#0F2942] px-3 py-2.5 text-xs font-semibold text-white hover:bg-[#163A5C] min-h-[44px]"
                  >
                    <Download className="w-4 h-4 shrink-0" />
                    <span className="truncate">Backup JSON</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => restoreInputRef.current?.click()}
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-300 px-3 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 min-h-[44px]"
                  >
                    <Upload className="w-4 h-4 shrink-0" />
                    <span className="truncate">Pulihkan</span>
                  </button>
                  <input
                    ref={restoreInputRef}
                    type="file"
                    accept="application/json"
                    onChange={handleRestoreCloudBackup}
                    className="hidden"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => downloadAndroidSourceZip(window.location.origin)}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 px-3 py-2.5 text-xs font-semibold text-[#0F2942] hover:bg-slate-50 min-h-[44px]"
                >
                  <Smartphone className="w-4 h-4 shrink-0" />
                  <span>Unduh Source Android (.zip)</span>
                </button>
              </div>

              <form
                onSubmit={handleChangeAdminPassword}
                className="rounded-2xl bg-white border border-slate-200 p-4 sm:p-6 space-y-3"
              >
                <div className="flex items-center gap-2 text-[#0F2942]">
                  <KeyRound className="w-4 h-4 shrink-0" />
                  <h3 className="text-sm font-bold text-slate-900">
                    Ubah Password Admin
                  </h3>
                </div>
                <input
                  type="password"
                  required
                  value={curAdminPass}
                  onChange={(e) => setCurAdminPass(e.target.value)}
                  placeholder="Password saat ini"
                  className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 py-2 text-base sm:text-xs"
                />
                <input
                  type="password"
                  required
                  minLength={8}
                  value={newAdminPass}
                  onChange={(e) => setNewAdminPass(e.target.value)}
                  placeholder="Password baru (min. 8 karakter)"
                  className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 py-2 text-base sm:text-xs"
                />
                <button
                  type="submit"
                  className="w-full min-h-[44px] rounded-xl border border-[#0F2942] text-xs font-bold text-[#0F2942] hover:bg-slate-50"
                >
                  Simpan Password
                </button>
              </form>
            </div>
          </div>

          {auditLogs.length > 0 && (
            <div className="rounded-2xl bg-white border border-slate-200 p-4 sm:p-6 space-y-3">
              <h2 className="text-base font-bold text-slate-900">
                Log Aktivitas
              </h2>
              <div className="divide-y divide-slate-100 max-h-80 overflow-y-auto">
                {auditLogs.slice(0, 30).map((log) => (
                  <div key={log.logId} className="py-2.5 text-xs space-y-0.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-bold text-[#0F2942] truncate">
                        {log.action}
                      </span>
                      <span className="font-mono text-[11px] text-slate-500 shrink-0 tabular-nums">
                        {formatWibDateTime(log.timestampIso)}
                      </span>
                    </div>
                    <p className="text-slate-600 break-words">
                      <strong>{log.actorUsername}</strong> · {log.reason}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* MODAL 1: Face Enrollment */}
      {enrollingEmployee && (
        <FaceCameraModal
          mode="ENROLL"
          employeeName={`${enrollingEmployee.fullName} (${enrollingEmployee.employeeId})`}
          onSuccess={handleFaceEnrollmentSuccess}
          onCancel={() => setEnrollingEmployee(null)}
        />
      )}

      {/* MODAL 2: Appeal Approve/Reject */}
      {appealReviewModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/70 p-0 sm:p-4">
          <form
            onSubmit={handleConfirmAppealReview}
            className="w-full max-w-md rounded-t-3xl sm:rounded-2xl bg-white border border-slate-200 p-5 sm:p-6 pb-safe space-y-4"
          >
            <h3 className="text-base font-bold text-slate-900">
              {appealReviewModal.decision === 'APPROVE'
                ? 'Setujui Sanggah Absen'
                : 'Tolak Sanggah Absen'}
            </h3>
            <div className="text-xs text-slate-700 space-y-1 bg-slate-50 p-3 rounded-xl border border-slate-200">
              <p className="font-bold text-slate-900">
                {appealReviewModal.appeal.employeeName} ·{' '}
                {formatWibDateLong(appealReviewModal.appeal.workDateWib)} (
                {formatScopeLabel(appealReviewModal.appeal.scope)})
              </p>
              <p>
                <strong>{appealReviewModal.appeal.category}:</strong>{' '}
                {appealReviewModal.appeal.reason}
              </p>
              {appealReviewModal.decision === 'APPROVE' && (
                <p className="text-[11px] text-emerald-800 pt-1">
                  Menyetujui sanggah akan otomatis mencatat/mengubah absensi karyawan menjadi Valid pada Rekap Harian &amp; Excel.
                </p>
              )}
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-700 block mb-1">
                Catatan Admin (Opsional)
              </label>
              <input
                type="text"
                value={appealReviewModal.note}
                onChange={(e) =>
                  setAppealReviewModal({
                    ...appealReviewModal,
                    note: e.target.value,
                  })
                }
                placeholder="Catatan singkat..."
                className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 py-2 text-base sm:text-xs"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={processingAppeal}
                onClick={() => setAppealReviewModal(null)}
                className="rounded-xl border border-slate-300 px-4 py-2.5 text-xs font-semibold text-slate-700 min-h-[44px]"
              >
                Batal
              </button>
              <button
                type="submit"
                disabled={processingAppeal}
                className={`rounded-xl px-4 py-2.5 text-xs font-bold text-white min-h-[44px] ${
                  appealReviewModal.decision === 'APPROVE'
                    ? 'bg-emerald-700 hover:bg-emerald-800'
                    : 'bg-red-700 hover:bg-red-800'
                }`}
              >
                {processingAppeal
                  ? 'Memproses...'
                  : appealReviewModal.decision === 'APPROVE'
                  ? 'Setujui & Sinkron'
                  : 'Tolak'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL 3: Evidence Viewer */}
      {evidenceModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/70 p-0 sm:p-4">
          <div className="w-full max-w-md max-h-[92dvh] overflow-y-auto rounded-t-3xl sm:rounded-2xl bg-white border border-slate-200 p-5 sm:p-6 pb-safe space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900">
                Detail Transaksi Absensi
              </h3>
              <button
                type="button"
                onClick={() => setEvidenceModal(null)}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl hover:bg-slate-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {evidenceModal.loading ? (
              <p className="text-xs text-slate-500 py-6 text-center">
                Memuat bukti...
              </p>
            ) : evidenceModal.thumbnailDataUrl ? (
              <img
                src={evidenceModal.thumbnailDataUrl}
                alt={evidenceModal.record.employeeName}
                referrerPolicy="no-referrer"
                className="w-full rounded-xl border border-slate-200 object-cover max-h-56"
              />
            ) : null}

            <div className="space-y-1.5 text-xs text-slate-700 font-mono tabular-nums break-words bg-slate-50 rounded-xl border border-slate-200 p-3.5">
              <p className="font-sans font-bold text-sm text-slate-900">
                {evidenceModal.record.employeeName} (
                {evidenceModal.record.employeeId})
              </p>
              <p className="font-sans font-semibold text-slate-700">
                {evidenceModal.record.type === 'CHECK_IN'
                  ? 'Absen Masuk'
                  : 'Absen Pulang'}{' '}
                · {formatWibDateLong(evidenceModal.record.workDateWib)} ·{' '}
                {formatWibHourMinute(
                  evidenceModal.record.serverTimestampIso ||
                    evidenceModal.record.deviceTimestampIso
                )}
              </p>
              <p>
                GPS: {evidenceModal.record.latitude},{' '}
                {evidenceModal.record.longitude} (
                {evidenceModal.record.distanceToOfficeMeters}m dari kantor)
              </p>
              <p className="font-sans">{evidenceModal.record.livenessDetail}</p>
              {evidenceModal.record.reviewedBy && (
                <p className="font-sans text-emerald-800 font-medium pt-1">
                  Keputusan Admin ({evidenceModal.record.reviewedBy}):{' '}
                  {evidenceModal.record.reviewNote}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* MODAL 4: Offline Pending Review */}
      {reviewModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/70 p-0 sm:p-4">
          <form
            onSubmit={handleSubmitReviewDecision}
            className="w-full max-w-md rounded-t-3xl sm:rounded-2xl bg-white border border-slate-200 p-5 sm:p-6 pb-safe space-y-4"
          >
            <h3 className="text-base font-bold text-slate-900">
              {reviewModal.decision === 'REJECT'
                ? 'Tolak Absensi'
                : 'Setujui Absensi'}
            </h3>
            <p className="text-xs text-slate-600">
              <strong>{reviewModal.record.employeeName}</strong> ·{' '}
              {formatWibDateLong(reviewModal.record.workDateWib)}
            </p>
            {reviewModal.decision !== 'REJECT' && (
              <div className="grid grid-cols-2 gap-2 text-xs">
                <button
                  type="button"
                  onClick={() =>
                    setReviewModal({ ...reviewModal, decision: 'APPROVE_VALID' })
                  }
                  className={`min-h-[44px] py-2 rounded-xl border font-semibold ${
                    reviewModal.decision === 'APPROVE_VALID'
                      ? 'bg-[#0F2942] text-white border-[#0F2942]'
                      : 'border-slate-300 text-slate-700'
                  }`}
                >
                  Tepat Waktu
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setReviewModal({ ...reviewModal, decision: 'APPROVE_LATE' })
                  }
                  className={`min-h-[44px] py-2 rounded-xl border font-semibold ${
                    reviewModal.decision === 'APPROVE_LATE'
                      ? 'bg-[#0F2942] text-white border-[#0F2942]'
                      : 'border-slate-300 text-slate-700'
                  }`}
                >
                  Terlambat
                </button>
              </div>
            )}
            <input
              type="text"
              value={reviewModal.reason}
              onChange={(e) =>
                setReviewModal({ ...reviewModal, reason: e.target.value })
              }
              placeholder="Catatan (opsional)..."
              className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 py-2 text-base sm:text-xs"
            />
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setReviewModal(null)}
                className="rounded-xl border border-slate-300 px-4 py-2.5 text-xs font-semibold text-slate-700 min-h-[44px]"
              >
                Batal
              </button>
              <button
                type="submit"
                className="rounded-xl bg-[#0F2942] px-4 py-2.5 text-xs font-semibold text-white min-h-[44px]"
              >
                Simpan
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL 5: Reset Employee Password */}
      {resetTargetEmp && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/70 p-0 sm:p-4">
          <form
            onSubmit={handleConfirmResetPassword}
            className="w-full max-w-sm rounded-t-3xl sm:rounded-2xl bg-white border border-slate-200 p-5 sm:p-6 pb-safe space-y-4"
          >
            <h3 className="text-base font-bold text-slate-900">
              Reset Password
            </h3>
            <p className="text-xs text-slate-600">
              <strong>{resetTargetEmp.fullName}</strong> (@
              {resetTargetEmp.username})
            </p>
            <input
              type="password"
              required
              minLength={6}
              value={resetNewPass}
              onChange={(e) => setResetNewPass(e.target.value)}
              placeholder="Password baru min. 6 karakter"
              className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 py-2.5 text-base sm:text-sm"
            />
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setResetTargetEmp(null)}
                className="rounded-xl border border-slate-300 px-4 py-2.5 text-xs font-semibold text-slate-700 min-h-[44px]"
              >
                Batal
              </button>
              <button
                type="submit"
                className="rounded-xl bg-[#0F2942] px-4 py-2.5 text-xs font-semibold text-white min-h-[44px]"
              >
                Simpan
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL 6: Delete Biometric */}
      {deleteBioTarget && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/70 p-0 sm:p-4">
          <div className="w-full max-w-sm rounded-t-3xl sm:rounded-2xl bg-white border border-slate-200 p-5 sm:p-6 pb-safe space-y-4">
            <h3 className="text-base font-bold text-slate-900">
              Hapus Data Wajah?
            </h3>
            <p className="text-xs text-slate-600">
              Data wajah <strong>{deleteBioTarget.fullName}</strong> akan dihapus. Karyawan dapat merekam ulang wajah dari akunnya atau melalui Admin.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setDeleteBioTarget(null)}
                className="rounded-xl border border-slate-300 px-4 py-2.5 text-xs font-semibold text-slate-700 min-h-[44px]"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleConfirmDeleteBiometrics}
                className="rounded-xl bg-red-700 px-4 py-2.5 text-xs font-semibold text-white min-h-[44px]"
              >
                Hapus
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 7: Delete Employee Account */}
      {deleteEmpTarget && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/70 p-0 sm:p-4">
          <div className="w-full max-w-sm rounded-t-3xl sm:rounded-2xl bg-white border border-slate-200 p-5 sm:p-6 pb-safe space-y-4">
            <h3 className="text-base font-bold text-slate-900">
              Hapus Akun Karyawan?
            </h3>
            <p className="text-xs text-slate-600">
              Akun <strong>{deleteEmpTarget.fullName}</strong> (@
              {deleteEmpTarget.username}) akan dihapus permanen.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setDeleteEmpTarget(null)}
                className="rounded-xl border border-slate-300 px-4 py-2.5 text-xs font-semibold text-slate-700 min-h-[44px]"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleConfirmDeleteEmployee}
                className="rounded-xl bg-red-700 px-4 py-2.5 text-xs font-semibold text-white min-h-[44px]"
              >
                Hapus
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 8: Send Monthly Email (.xlsx) */}
      {confirmEmailModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/70 p-0 sm:p-4">
          <div className="w-full max-w-md rounded-t-3xl sm:rounded-2xl bg-white border border-slate-200 p-5 sm:p-6 pb-safe space-y-4">
            <h3 className="text-base font-bold text-slate-900">
              Kirim Rekap Excel ({confirmEmailModal.period})
            </h3>
            <p className="text-xs text-slate-600">
              Lampiran <strong>Rekap-Absensi-{confirmEmailModal.period}.xlsx</strong> (4 lembar: Rekap Harian, Ringkasan Karyawan, Data Sanggah, Log Detail) akan dikirim ke alamat berikut:
            </p>
            <input
              type="email"
              value={confirmEmailModal.recipientEmail}
              onChange={(e) =>
                setConfirmEmailModal({
                  ...confirmEmailModal,
                  recipientEmail: e.target.value,
                })
              }
              className="w-full min-h-[44px] rounded-xl border border-slate-300 px-3 py-2 text-base sm:text-sm font-mono"
            />
            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                type="button"
                disabled={sendingEmail}
                onClick={() => setConfirmEmailModal(null)}
                className="rounded-xl border border-slate-300 px-4 py-2.5 text-xs font-semibold text-slate-700 min-h-[44px]"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={sendingEmail}
                onClick={handleConfirmSendMonthlyEmail}
                className="rounded-xl bg-[#0F2942] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#163A5C] min-h-[44px]"
              >
                {sendingEmail ? 'Mengirim...' : 'Kirim Excel'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
