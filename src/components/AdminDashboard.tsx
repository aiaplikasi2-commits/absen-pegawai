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
} from 'lucide-react';
import type {
  AppealScope,
  AttendanceAppeal,
  AttendanceRecord,
  AuditLogRecord,
  AuthSessionUser,
  EmployeeProfile,
  OfficeSettings,
} from '../types/attendance';
import { formatWibDateTime, getWibParts } from '../utils/geoAndTime';
import { acquireFreshGpsLocation } from '../services/gpsValidator';
import {
  connectGoogleForGmail,
  getGmailAccessToken,
} from '../lib/firebase';
import { downloadAndroidSourceZip } from '../utils/androidProjectBundle';
import { FaceCameraModal, BiometricCaptureResult } from './FaceCameraModal';

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
    absentCount: 0,
    pendingReviewCount: 0,
    pendingAppealCount: 0,
  });

  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [appeals, setAppeals] = useState<AttendanceAppeal[]>([]);
  const [appealFilter, setAppealFilter] = useState<'PENDING' | 'ALL'>('PENDING');
  const [employees, setEmployees] = useState<EmployeeProfile[]>([]);
  const [settings, setSettings] = useState<OfficeSettings | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLogRecord[]>([]);

  const [dateFilter, setDateFilter] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
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
      const resp = await fetch(`/api/admin/attendance?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) {
        const data = await resp.json();
        setSummary(data.summary);
        setRecords(data.records || []);
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
    const resp = await fetch('/api/admin/appeals', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.ok) {
      const data = await resp.json();
      setAppeals(data.appeals || []);
    }
  }, [token]);

  const fetchEmployees = useCallback(async () => {
    const resp = await fetch('/api/admin/employees', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.ok) {
      const data = await resp.json();
      const list: EmployeeProfile[] = data.employees || [];
      setEmployees(list);
      const usedNums = list
        .map((e) => Number(e.employeeId.replace(/\D/g, '')))
        .filter((n) => Number.isFinite(n));
      const nextNum = String((usedNums.length ? Math.max(...usedNums) : 0) + 1).padStart(
        3,
        '0'
      );
      setNewEmpId(`EMP-${nextNum}`);
    }
  }, [token]);

  const fetchAuditLogs = useCallback(async () => {
    const resp = await fetch('/api/admin/audit-logs', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.ok) {
      const data = await resp.json();
      setAuditLogs(data.auditLogs || []);
    }
  }, [token]);

  const fetchMonthlyReport = useCallback(async () => {
    const resp = await fetch(
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

  const handleCreateEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreatingEmp(true);
    setBanner(null);
    try {
      const resp = await fetch('/api/admin/employees', {
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

    const resp = await fetch(
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
    const resp = await fetch(
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
    const resp = await fetch(
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
    const resp = await fetch(
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
    const resp = await fetch(
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
      const resp = await fetch(
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
        await Promise.all([fetchAppeals(), fetchAttendanceAndSummary()]);
        setBanner({
          kind: 'success',
          text: `Sanggah ${empName} ${approved ? 'disetujui' : 'ditolak'}.`,
        });
      }
    } finally {
      setProcessingAppeal(false);
    }
  };

  const openEvidenceModal = async (rec: AttendanceRecord) => {
    setEvidenceModal({ record: rec, loading: true });
    try {
      const resp = await fetch(
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
    const resp = await fetch(
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
      setReviewModal(null);
      await fetchAttendanceAndSummary();
      setBanner({
        kind: 'success',
        text: `Status absensi ${reviewModal.record.employeeName} diperbarui.`,
      });
    }
  };

  const handleExportCsv = () => {
    const headers = [
      'ID Transaksi',
      'Tanggal WIB',
      'ID Karyawan',
      'Nama',
      'Jenis',
      'Waktu WIB',
      'Latitude',
      'Longitude',
      'Jarak (m)',
      'Status',
      'Keterangan',
    ];
    const lines = [headers.join(',')];
    for (const r of records) {
      lines.push(
        [
          `"${r.transactionId}"`,
          `"${r.workDateWib}"`,
          `"${r.employeeId}"`,
          `"${r.employeeName}"`,
          `"${r.type}"`,
          `"${formatWibDateTime(r.serverTimestampIso || r.deviceTimestampIso)}"`,
          r.latitude,
          r.longitude,
          r.distanceToOfficeMeters,
          `"${r.attendanceStatus}"`,
          `"${(r.reviewNote || r.rejectionReason || r.livenessDetail || '').replace(
            /"/g,
            '""'
          )}"`,
        ].join(',')
      );
    }
    const blob = new Blob([lines.join('\n')], {
      type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Absensi-${dateFilter || getWibParts().dateStr}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
        text: `Koordinat (${gps.latitude}, ${gps.longitude}) diambil. Klik Simpan.`,
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
      const resp = await fetch('/api/admin/office-settings', {
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
    const resp = await fetch('/api/admin/backup/export', {
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
      const resp = await fetch('/api/admin/backup/restore', {
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
    const resp = await fetch('/api/auth/change-password', {
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

      const resp = await fetch('/api/admin/monthly-report/send-email', {
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
          text: `Laporan ${data.period} terkirim ke ${data.sentTo}.`,
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
    (r) => r.attendanceStatus === 'NEEDS_REVIEW'
  );
  const pendingAppeals = appeals.filter((a) => a.status === 'PENDING');
  const displayedAppeals =
    appealFilter === 'PENDING' ? pendingAppeals : appeals;
  const totalNeedsAction =
    (summary.pendingAppealCount || pendingAppeals.length) +
    summary.pendingReviewCount;

  const formatScopeLabel = (scope: AppealScope) => {
    if (scope === 'CHECK_IN') return 'Masuk';
    if (scope === 'CHECK_OUT') return 'Pulang';
    return 'Masuk & Pulang';
  };

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
          <span className="min-w-0 break-words">{banner.text}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="min-h-[36px] px-2 text-xs font-semibold underline shrink-0"
          >
            Tutup
          </button>
        </div>
      )}

      {/* SECTION 1: OVERVIEW */}
      {activeSection === 'OVERVIEW' && (
        <div className="space-y-4 sm:space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <div className="rounded-xl bg-white border border-slate-200 p-4">
              <span className="text-xs text-slate-500 block">Karyawan</span>
              <span className="text-2xl sm:text-3xl font-bold font-mono text-slate-900 tabular-nums mt-1 block">
                {summary.totalEmployees}
              </span>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-4">
              <span className="text-xs text-slate-500 block truncate">
                Hadir ({summary.dateWib})
              </span>
              <span className="text-2xl sm:text-3xl font-bold font-mono text-emerald-700 tabular-nums mt-1 block">
                {summary.presentCount}
              </span>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-4">
              <span className="text-xs text-slate-500 block">Terlambat</span>
              <span className="text-2xl sm:text-3xl font-bold font-mono text-amber-700 tabular-nums mt-1 block">
                {summary.lateCount}
              </span>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-4">
              <span className="text-xs text-slate-500 block">Belum Hadir</span>
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
                  <strong>{totalNeedsAction} pengajuan</strong> menunggu persetujuan Admin.
                </span>
              </div>
              <button
                type="button"
                onClick={() => onChangeSection('APPEALS')}
                className="w-full sm:w-auto rounded-xl bg-[#0F2942] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#163A5C] min-h-[44px]"
              >
                Buka Menu Sanggah
              </button>
            </div>
          )}

          <div className="rounded-2xl bg-white border border-slate-200 p-4 sm:p-6 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <h2 className="text-base font-bold text-slate-900">
                Data Absensi
              </h2>
              <div className="grid grid-cols-1 sm:flex sm:flex-wrap items-center gap-2.5">
                <div className="relative w-full sm:w-auto">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Cari nama / ID..."
                    className="w-full sm:w-48 pl-9 pr-3 py-2 text-base sm:text-xs rounded-xl border border-slate-300 focus:outline-none focus:border-[#0F2942] min-h-[44px]"
                  />
                </div>
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <input
                    type="date"
                    value={dateFilter}
                    onChange={(e) => setDateFilter(e.target.value)}
                    className="flex-1 sm:w-auto px-3 py-2 text-base sm:text-xs rounded-xl border border-slate-300 focus:outline-none focus:border-[#0F2942] min-h-[44px]"
                  />
                  {dateFilter && (
                    <button
                      type="button"
                      onClick={() => setDateFilter('')}
                      className="text-xs font-semibold text-slate-600 underline px-2 min-h-[44px] shrink-0"
                    >
                      Semua
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  onClick={handleExportCsv}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 rounded-xl bg-[#0F2942] px-3.5 py-2.5 text-xs font-semibold text-white hover:bg-[#163A5C] min-h-[44px]"
                >
                  <FileSpreadsheet className="w-4 h-4 shrink-0" />
                  <span>CSV</span>
                </button>
              </div>
            </div>

            {loading ? (
              <p className="text-xs text-slate-500 py-8 text-center">
                Memuat...
              </p>
            ) : records.length === 0 ? (
              <p className="text-sm text-slate-500 py-8 text-center border border-dashed border-slate-200 rounded-xl">
                Belum ada data absensi.
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
                            {rec.type === 'CHECK_IN' ? 'Masuk' : 'Pulang'} ·{' '}
                            {rec.workDateWib}
                          </span>
                        </div>
                        <span className="font-semibold shrink-0">
                          {rec.attendanceStatus === 'VALID' && (
                            <span className="text-emerald-700">Valid</span>
                          )}
                          {rec.attendanceStatus === 'LATE' && (
                            <span className="text-amber-700">Terlambat</span>
                          )}
                          {rec.attendanceStatus === 'NEEDS_REVIEW' && (
                            <span className="text-amber-700">Pending</span>
                          )}
                          {rec.attendanceStatus === 'REJECTED' && (
                            <span className="text-red-700">Ditolak</span>
                          )}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-slate-600 tabular-nums">
                        <span>
                          {formatWibDateTime(
                            rec.serverTimestampIso || rec.deviceTimestampIso
                          )}
                        </span>
                        <span className="font-sans">
                          {rec.livenessDetail.startsWith('Sanggah')
                            ? rec.livenessDetail
                            : `${rec.distanceToOfficeMeters}m · ${(
                                rec.faceMatchScore * 100
                              ).toFixed(0)}%`}
                        </span>
                      </div>

                      {rec.hasEvidence && (
                        <div className="flex justify-end pt-0.5">
                          <button
                            type="button"
                            onClick={() => openEvidenceModal(rec)}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 min-h-[38px]"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            <span>Foto</span>
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500">
                        <th className="py-2.5 pr-3 font-semibold">Tanggal</th>
                        <th className="py-2.5 pr-3 font-semibold">Karyawan</th>
                        <th className="py-2.5 pr-3 font-semibold">Jenis</th>
                        <th className="py-2.5 pr-3 font-semibold">Waktu WIB</th>
                        <th className="py-2.5 pr-3 font-semibold">Keterangan</th>
                        <th className="py-2.5 pr-3 font-semibold">Status</th>
                        <th className="py-2.5 font-semibold text-right">Bukti</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {records.map((rec) => (
                        <tr key={rec.transactionId} className="hover:bg-slate-50/70">
                          <td className="py-3 pr-3 font-mono text-slate-800 tabular-nums">
                            {rec.workDateWib}
                          </td>
                          <td className="py-3 pr-3">
                            <span className="font-semibold text-slate-900 block">
                              {rec.employeeName}
                            </span>
                            <span className="text-[11px] font-mono text-slate-500">
                              {rec.employeeId}
                            </span>
                          </td>
                          <td className="py-3 pr-3 font-semibold text-slate-800">
                            {rec.type === 'CHECK_IN' ? 'Masuk' : 'Pulang'}
                          </td>
                          <td className="py-3 pr-3 font-mono text-slate-700 tabular-nums">
                            {formatWibDateTime(
                              rec.serverTimestampIso || rec.deviceTimestampIso
                            )}
                          </td>
                          <td className="py-3 pr-3 text-slate-700">
                            {rec.livenessDetail.startsWith('Sanggah')
                              ? rec.livenessDetail
                              : `${rec.distanceToOfficeMeters}m · ±${
                                  rec.gpsAccuracyMeters
                                }m · ${(rec.faceMatchScore * 100).toFixed(0)}%`}
                          </td>
                          <td className="py-3 pr-3 font-semibold">
                            {rec.attendanceStatus === 'VALID' && (
                              <span className="text-emerald-700">Valid</span>
                            )}
                            {rec.attendanceStatus === 'LATE' && (
                              <span className="text-amber-700">Terlambat</span>
                            )}
                            {rec.attendanceStatus === 'NEEDS_REVIEW' && (
                              <span className="text-amber-700">Pending</span>
                            )}
                            {rec.attendanceStatus === 'REJECTED' && (
                              <span className="text-red-700">Ditolak</span>
                            )}
                          </td>
                          <td className="py-3 text-right">
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
              <h2 className="text-base font-bold text-slate-900">
                Sanggah Absen ({pendingAppeals.length} Menunggu)
              </h2>
              <div className="grid grid-cols-2 gap-1.5 rounded-xl bg-slate-100 p-1 w-full sm:w-56">
                <button
                  type="button"
                  onClick={() => setAppealFilter('PENDING')}
                  className={`min-h-[38px] rounded-lg text-xs font-bold ${
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
                  className={`min-h-[38px] rounded-lg text-xs font-bold ${
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
                Tidak ada pengajuan sanggah.
              </p>
            ) : (
              <div className="divide-y divide-slate-100">
                {displayedAppeals.map((apl) => (
                  <div
                    key={apl.appealId}
                    className="py-4 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-sm text-slate-900">
                          {apl.employeeName}
                        </span>
                        <span className="font-mono text-[11px] text-slate-500">
                          ({apl.employeeId})
                        </span>
                        <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-800 font-semibold">
                          {apl.workDateWib} · {formatScopeLabel(apl.scope)}
                        </span>
                        <span className="font-semibold text-[#0F2942]">
                          {apl.category}
                        </span>
                      </div>
                      <p className="text-slate-700 break-words">{apl.reason}</p>
                      {typeof apl.latitude === 'number' &&
                        typeof apl.longitude === 'number' && (
                          <p className="font-mono text-[11px] text-slate-500">
                            GPS Lapangan: {apl.latitude}, {apl.longitude}
                          </p>
                        )}
                      {apl.status !== 'PENDING' && (
                        <p className="text-[11px] text-slate-500">
                          {apl.status === 'APPROVED' ? 'Disetujui' : 'Ditolak'}{' '}
                          oleh {apl.reviewedBy || 'Admin'}
                          {apl.reviewNote ? ` · ${apl.reviewNote}` : ''}
                        </p>
                      )}
                    </div>

                    {apl.status === 'PENDING' ? (
                      <div className="grid grid-cols-2 gap-2 shrink-0 md:w-52">
                        <button
                          type="button"
                          onClick={() =>
                            setAppealReviewModal({
                              appeal: apl,
                              decision: 'APPROVE',
                              note: '',
                            })
                          }
                          className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-700 px-3 py-2.5 text-xs font-bold text-white hover:bg-emerald-800 min-h-[44px]"
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
                          className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-red-700 px-3 py-2.5 text-xs font-bold text-white hover:bg-red-800 min-h-[44px]"
                        >
                          <XCircle className="w-4 h-4 shrink-0" />
                          <span>Tolak</span>
                        </button>
                      </div>
                    ) : (
                      <span
                        className={`font-bold shrink-0 ${
                          apl.status === 'APPROVED'
                            ? 'text-emerald-700'
                            : 'text-red-700'
                        }`}
                      >
                        {apl.status === 'APPROVED' ? 'Disetujui' : 'Ditolak'}
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
                Absensi Offline Menunggu ({pendingRecords.length})
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
                        {rec.type === 'CHECK_IN' ? 'Masuk' : 'Pulang'}{' '}
                        {rec.workDateWib}
                      </p>
                      <p className="font-mono text-[11px] text-slate-600">
                        {formatWibDateTime(rec.deviceTimestampIso)} ·{' '}
                        {rec.distanceToOfficeMeters}m ·{' '}
                        {(rec.faceMatchScore * 100).toFixed(0)}%
                      </p>
                      {rec.rejectionReason && (
                        <p className="text-amber-800">{rec.rejectionReason}</p>
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
            <h2 className="text-base font-bold text-slate-900">
              Karyawan ({employees.length}/10)
            </h2>

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
                          className={`text-[11px] font-semibold ${
                            emp.isActive ? 'text-emerald-700' : 'text-slate-400'
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
                        Wajah:{' '}
                        <strong
                          className={
                            emp.hasFaceProfile
                              ? 'text-emerald-700'
                              : 'text-amber-700'
                          }
                        >
                          {emp.hasFaceProfile ? 'Terdaftar' : 'Belum Terdaftar'}
                        </strong>
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => setEnrollingEmployee(emp)}
                        className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-[#0F2942] px-3 py-2 text-xs font-semibold text-white hover:bg-[#163A5C] min-h-[40px]"
                      >
                        <ScanFace className="w-4 h-4 shrink-0" />
                        <span>
                          {emp.hasFaceProfile ? 'Ubah Wajah' : 'Daftar Wajah'}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setResetTargetEmp(emp);
                          setResetNewPass('');
                        }}
                        className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 min-h-[40px]"
                      >
                        Password
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleEmployeeActive(emp)}
                        className="rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 min-h-[40px]"
                      >
                        {emp.isActive ? 'Nonaktifkan' : 'Aktifkan'}
                      </button>
                      {emp.hasFaceProfile && (
                        <button
                          type="button"
                          onClick={() => setDeleteBioTarget(emp)}
                          className="rounded-xl border border-amber-300 px-3 py-2 text-xs font-semibold text-amber-800 hover:bg-amber-50 min-h-[40px]"
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

      {/* SECTION 4: MONTHLY REPORT & GMAIL */}
      {activeSection === 'MONTHLY_REPORT' && (
        <div className="rounded-2xl bg-white border border-slate-200 p-4 sm:p-6 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[#0F2942]">
              <Mail className="w-5 h-5 shrink-0" />
              <h2 className="text-base font-bold text-slate-900">
                Rekap Bulanan
              </h2>
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
                onClick={handleConnectGmail}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 min-h-[44px]"
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
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-[#0F2942] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#163A5C] min-h-[44px]"
              >
                <Mail className="w-4 h-4 shrink-0" />
                <span>Kirim Email</span>
              </button>
            </div>
          </div>

          {monthlyReportData && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600 border-y border-slate-100 py-2.5">
                <span className="break-all">
                  Tujuan:{' '}
                  <strong className="text-slate-900">
                    {monthlyReportData.adminReportEmail}
                  </strong>
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  Status:{' '}
                  <strong
                    className={
                      monthlyReportData.alreadySentForPeriod
                        ? 'text-emerald-700'
                        : 'text-slate-700'
                    }
                  >
                    {monthlyReportData.alreadySentForPeriod
                      ? 'Terkirim'
                      : 'Belum Dikirim'}
                  </strong>
                </span>
              </div>

              <div className="md:hidden divide-y divide-slate-100">
                {(monthlyReportData.rows || []).map((row: any) => (
                  <div key={row.employeeId} className="py-3 space-y-1.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-slate-900 truncate">
                        {row.fullName}
                      </span>
                      <span className="font-mono text-slate-500 shrink-0">
                        {row.employeeId}
                      </span>
                    </div>
                    <div className="grid grid-cols-4 gap-2 text-center font-mono tabular-nums pt-1">
                      <div className="rounded-lg bg-slate-50 p-2">
                        <span className="block font-sans text-[10px] text-slate-500">
                          Hadir
                        </span>
                        <strong className="text-slate-900">
                          {row.totalPresentDays}
                        </strong>
                      </div>
                      <div className="rounded-lg bg-slate-50 p-2">
                        <span className="block font-sans text-[10px] text-slate-500">
                          Tepat
                        </span>
                        <strong className="text-emerald-700">
                          {row.onTimeDays}
                        </strong>
                      </div>
                      <div className="rounded-lg bg-slate-50 p-2">
                        <span className="block font-sans text-[10px] text-slate-500">
                          Telat
                        </span>
                        <strong className="text-amber-700">
                          {row.lateDays}
                        </strong>
                      </div>
                      <div className="rounded-lg bg-slate-50 p-2">
                        <span className="block font-sans text-[10px] text-slate-500">
                          Pulang
                        </span>
                        <strong className="text-slate-700">
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
                    <tr className="border-b border-slate-200 text-slate-500">
                      <th className="py-2.5 pr-3 font-semibold">ID</th>
                      <th className="py-2.5 pr-3 font-semibold">Nama</th>
                      <th className="py-2.5 pr-3 font-semibold">Jabatan</th>
                      <th className="py-2.5 pr-3 font-semibold text-right">
                        Hadir
                      </th>
                      <th className="py-2.5 pr-3 font-semibold text-right">
                        Tepat
                      </th>
                      <th className="py-2.5 pr-3 font-semibold text-right">
                        Telat
                      </th>
                      <th className="py-2.5 font-semibold text-right">
                        Pulang
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono tabular-nums">
                    {(monthlyReportData.rows || []).map((row: any) => (
                      <tr key={row.employeeId}>
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
                        <td className="py-2.5 pr-3 text-right text-emerald-700">
                          {row.onTimeDays}
                        </td>
                        <td className="py-2.5 pr-3 text-right text-amber-700">
                          {row.lateDays}
                        </td>
                        <td className="py-2.5 text-right text-slate-700">
                          {row.completedCheckOuts}
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
                  className="w-full sm:w-auto rounded-xl border border-[#0F2942] px-3.5 py-2 text-xs font-semibold text-[#0F2942] hover:bg-slate-50 min-h-[44px]"
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
                      Email Otomatis Akhir Bulan
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
              <h2 className="text-base font-bold text-slate-900">Log Aktivitas</h2>
              <div className="divide-y divide-slate-100 max-h-80 overflow-y-auto">
                {auditLogs.slice(0, 30).map((log) => (
                  <div key={log.logId} className="py-2.5 text-xs space-y-0.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-bold text-[#0F2942] truncate">
                        {log.action}
                      </span>
                      <span className="font-mono text-[11px] text-slate-500 shrink-0">
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
                {appealReviewModal.appeal.workDateWib} (
                {formatScopeLabel(appealReviewModal.appeal.scope)})
              </p>
              <p>
                {appealReviewModal.appeal.category}:{' '}
                {appealReviewModal.appeal.reason}
              </p>
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
                  ? 'Setujui'
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
                Detail Absensi
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
                Memuat...
              </p>
            ) : evidenceModal.thumbnailDataUrl ? (
              <img
                src={evidenceModal.thumbnailDataUrl}
                alt={evidenceModal.record.employeeName}
                referrerPolicy="no-referrer"
                className="w-full rounded-xl border border-slate-200 object-cover max-h-56"
              />
            ) : null}

            <div className="space-y-1.5 text-xs text-slate-700 font-mono tabular-nums break-words">
              <p className="font-sans font-bold text-slate-900">
                {evidenceModal.record.employeeName} (
                {evidenceModal.record.employeeId})
              </p>
              <p>
                GPS: {evidenceModal.record.latitude},{' '}
                {evidenceModal.record.longitude}
              </p>
              <p className="font-sans">{evidenceModal.record.livenessDetail}</p>
              {evidenceModal.record.reviewedBy && (
                <p className="font-sans text-emerald-800 pt-1">
                  Admin ({evidenceModal.record.reviewedBy}):{' '}
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
              {reviewModal.record.workDateWib}
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
              Data wajah <strong>{deleteBioTarget.fullName}</strong> akan dihapus.
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

      {/* MODAL 8: Send Monthly Email */}
      {confirmEmailModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/70 p-0 sm:p-4">
          <div className="w-full max-w-md rounded-t-3xl sm:rounded-2xl bg-white border border-slate-200 p-5 sm:p-6 pb-safe space-y-4">
            <h3 className="text-base font-bold text-slate-900">
              Kirim Laporan {confirmEmailModal.period}
            </h3>
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
                {sendingEmail ? 'Mengirim...' : 'Kirim'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
