import type {
  AttendanceAppeal,
  AttendanceRecord,
  DailyAttendanceEntry,
  DailyOverallStatus,
  EmployeeProfile,
  OfficeSettings,
} from '../types/attendance.ts';
import {
  formatDurationBetween,
  formatWibHourMinute,
} from './geoAndTime.ts';

function statusPriority(rec: AttendanceRecord): number {
  switch (rec.attendanceStatus) {
    case 'VALID':
      return 6;
    case 'LATE':
    case 'EARLY_LEAVE':
      return 5;
    case 'NEEDS_REVIEW':
      return 4;
    case 'PENDING_OFFLINE':
      return 3;
    case 'REJECTED':
      return 1;
    default:
      return 0;
  }
}

function appealPriority(apl: AttendanceAppeal): number {
  if (apl.status === 'APPROVED') return 3;
  if (apl.status === 'PENDING') return 2;
  return 1;
}

function isAppealRecord(rec?: AttendanceRecord): boolean {
  if (!rec) return false;
  return Boolean(
    rec.appealId ||
      rec.transactionId.startsWith('att_apl_') ||
      rec.livenessDetail.startsWith('Sanggah')
  );
}

export interface BuildDailyEntriesParams {
  records: AttendanceRecord[];
  appeals: AttendanceAppeal[];
  employees?: EmployeeProfile[];
  officeSettings?: OfficeSettings | null;
  includeAbsentEmployeesForDate?: string; // YYYY-MM-DD
}

/**
 * Synchronizes AttendanceRecord[] and AttendanceAppeal[] into clear 1-row-per-employee-per-day
 * DailyAttendanceEntry items so Admin, Employee, Monthly Recap, and Excel exports always show
 * identical, legible Masuk + Pulang + Sanggah information.
 */
export function buildDailyAttendanceEntries({
  records,
  appeals,
  employees = [],
  officeSettings,
  includeAbsentEmployeesForDate,
}: BuildDailyEntriesParams): DailyAttendanceEntry[] {
  const empMap = new Map<string, EmployeeProfile>();
  for (const e of employees) {
    empMap.set(e.employeeId, e);
  }

  type Bucket = {
    workDateWib: string;
    employeeId: string;
    employeeName: string;
    position: string;
    checkIn?: AttendanceRecord;
    checkOut?: AttendanceRecord;
    appeals: AttendanceAppeal[];
  };

  const buckets = new Map<string, Bucket>();

  const getOrCreateBucket = (
    workDateWib: string,
    employeeId: string,
    fallbackName: string
  ): Bucket => {
    const key = `${workDateWib}__${employeeId}`;
    let b = buckets.get(key);
    if (!b) {
      const emp = empMap.get(employeeId);
      b = {
        workDateWib,
        employeeId,
        employeeName: emp?.fullName || fallbackName || employeeId,
        position: emp?.position || 'Karyawan',
        appeals: [],
      };
      buckets.set(key, b);
    }
    return b;
  };

  for (const rec of records) {
    if (!rec.workDateWib || !rec.employeeId) continue;
    const b = getOrCreateBucket(rec.workDateWib, rec.employeeId, rec.employeeName);
    if (rec.type === 'CHECK_IN') {
      if (
        !b.checkIn ||
        statusPriority(rec) > statusPriority(b.checkIn) ||
        (statusPriority(rec) === statusPriority(b.checkIn) &&
          (rec.serverTimestampIso || rec.deviceTimestampIso) >
            (b.checkIn.serverTimestampIso || b.checkIn.deviceTimestampIso))
      ) {
        b.checkIn = rec;
      }
    } else if (rec.type === 'CHECK_OUT') {
      if (
        !b.checkOut ||
        statusPriority(rec) > statusPriority(b.checkOut) ||
        (statusPriority(rec) === statusPriority(b.checkOut) &&
          (rec.serverTimestampIso || rec.deviceTimestampIso) >
            (b.checkOut.serverTimestampIso || b.checkOut.deviceTimestampIso))
      ) {
        b.checkOut = rec;
      }
    }
  }

  for (const apl of appeals) {
    if (!apl.workDateWib || !apl.employeeId) continue;
    const b = getOrCreateBucket(apl.workDateWib, apl.employeeId, apl.employeeName);
    b.appeals.push(apl);
  }

  if (includeAbsentEmployeesForDate && /^\d{4}-\d{2}-\d{2}$/.test(includeAbsentEmployeesForDate)) {
    for (const emp of employees) {
      if (emp.isActive !== false) {
        getOrCreateBucket(includeAbsentEmployeesForDate, emp.employeeId, emp.fullName);
      }
    }
  }

  const startSched = officeSettings?.workStartTime || '08:00';
  const endSched = officeSettings?.workEndTime || '17:00';

  const entries: DailyAttendanceEntry[] = [];

  for (const b of buckets.values()) {
    b.appeals.sort((x, y) => {
      const diff = appealPriority(y) - appealPriority(x);
      if (diff !== 0) return diff;
      return y.createdAtIso.localeCompare(x.createdAtIso);
    });

    const primaryAppeal = b.appeals[0];
    const inAppeal = b.appeals.find(
      (a) => a.scope === 'CHECK_IN' || a.scope === 'FULL_DAY'
    );
    const outAppeal = b.appeals.find(
      (a) => a.scope === 'CHECK_OUT' || a.scope === 'FULL_DAY'
    );

    const ci = b.checkIn;
    const co = b.checkOut;

    // Evaluate Masuk
    let checkInTimeWib = '-';
    let checkInStatusLabel = 'Belum Masuk';
    let inValid = false;
    let inLate = false;
    let inFromAppeal = false;
    let inPendingAppeal = false;
    let inPendingReview = false;
    let inRejected = false;

    if (inAppeal?.status === 'APPROVED') {
      inValid = true;
      inFromAppeal = true;
      checkInTimeWib =
        ci && !isAppealRecord(ci)
          ? formatWibHourMinute(ci.serverTimestampIso || ci.deviceTimestampIso)
          : `${startSched} WIB`;
      checkInStatusLabel = 'Sanggah Disetujui';
    } else if (ci && (ci.attendanceStatus === 'VALID' || ci.attendanceStatus === 'LATE')) {
      inValid = true;
      inFromAppeal = isAppealRecord(ci);
      inLate = ci.attendanceStatus === 'LATE' && !inFromAppeal;
      checkInTimeWib = formatWibHourMinute(ci.serverTimestampIso || ci.deviceTimestampIso);
      if (inAppeal?.status === 'PENDING') {
        inPendingAppeal = true;
        checkInStatusLabel = inLate ? 'Terlambat · Sanggah Menunggu' : 'Sanggah Menunggu';
      } else if (inFromAppeal) {
        checkInStatusLabel = 'Sanggah Disetujui';
      } else if (inLate) {
        checkInStatusLabel = 'Terlambat';
      } else {
        checkInStatusLabel = 'Tepat Waktu';
      }
    } else if (inAppeal?.status === 'PENDING' || ci?.appealStatus === 'PENDING') {
      inPendingAppeal = true;
      checkInTimeWib = `Jadwal ${startSched}`;
      checkInStatusLabel = 'Menunggu Sanggah';
    } else if (ci && (ci.attendanceStatus === 'NEEDS_REVIEW' || ci.attendanceStatus === 'PENDING_OFFLINE')) {
      inPendingReview = true;
      checkInTimeWib = formatWibHourMinute(ci.deviceTimestampIso);
      checkInStatusLabel =
        ci.attendanceStatus === 'PENDING_OFFLINE' ? 'Antrean Offline' : 'Menunggu Review';
    } else if (inAppeal?.status === 'REJECTED' || ci?.attendanceStatus === 'REJECTED') {
      inRejected = true;
      checkInTimeWib = ci ? formatWibHourMinute(ci.deviceTimestampIso) : '-';
      checkInStatusLabel = inAppeal?.status === 'REJECTED' ? 'Sanggah Ditolak' : 'Ditolak';
    }

    // Evaluate Pulang
    let checkOutTimeWib = '-';
    let checkOutStatusLabel = 'Belum Pulang';
    let outValid = false;
    let outEarly = false;
    let outFromAppeal = false;
    let outPendingAppeal = false;
    let outPendingReview = false;
    let outRejected = false;

    if (outAppeal?.status === 'APPROVED') {
      outValid = true;
      outFromAppeal = true;
      checkOutTimeWib =
        co && !isAppealRecord(co)
          ? formatWibHourMinute(co.serverTimestampIso || co.deviceTimestampIso)
          : `${endSched} WIB`;
      checkOutStatusLabel = 'Sanggah Disetujui';
    } else if (
      co &&
      (co.attendanceStatus === 'VALID' || co.attendanceStatus === 'EARLY_LEAVE')
    ) {
      outValid = true;
      outFromAppeal = isAppealRecord(co);
      outEarly = co.attendanceStatus === 'EARLY_LEAVE' && !outFromAppeal;
      checkOutTimeWib = formatWibHourMinute(co.serverTimestampIso || co.deviceTimestampIso);
      if (outAppeal?.status === 'PENDING') {
        outPendingAppeal = true;
        checkOutStatusLabel = outEarly
          ? 'Pulang Cepat · Sanggah Menunggu'
          : 'Sanggah Menunggu';
      } else if (outFromAppeal) {
        checkOutStatusLabel = 'Sanggah Disetujui';
      } else if (outEarly) {
        checkOutStatusLabel = 'Pulang Cepat';
      } else {
        checkOutStatusLabel = 'Sudah Pulang';
      }
    } else if (outAppeal?.status === 'PENDING' || co?.appealStatus === 'PENDING') {
      outPendingAppeal = true;
      checkOutTimeWib = `Jadwal ${endSched}`;
      checkOutStatusLabel = 'Menunggu Sanggah';
    } else if (
      co &&
      (co.attendanceStatus === 'NEEDS_REVIEW' || co.attendanceStatus === 'PENDING_OFFLINE')
    ) {
      outPendingReview = true;
      checkOutTimeWib = formatWibHourMinute(co.deviceTimestampIso);
      checkOutStatusLabel =
        co.attendanceStatus === 'PENDING_OFFLINE' ? 'Antrean Offline' : 'Menunggu Review';
    } else if (outAppeal?.status === 'REJECTED' || co?.attendanceStatus === 'REJECTED') {
      outRejected = true;
      checkOutTimeWib = co ? formatWibHourMinute(co.deviceTimestampIso) : '-';
      checkOutStatusLabel = outAppeal?.status === 'REJECTED' ? 'Sanggah Ditolak' : 'Ditolak';
    }

    // Source label
    let sourceLabel: DailyAttendanceEntry['sourceLabel'] = '-';
    const anyAppealUsed =
      inFromAppeal ||
      outFromAppeal ||
      Boolean(inAppeal) ||
      Boolean(outAppeal);
    const anyBiometricUsed =
      (ci && !isAppealRecord(ci)) || (co && !isAppealRecord(co));

    if (anyBiometricUsed && anyAppealUsed) {
      sourceLabel = 'Kamera & Sanggah';
    } else if (anyAppealUsed) {
      sourceLabel = 'Sanggah Absen';
    } else if (anyBiometricUsed) {
      sourceLabel = 'Kamera & GPS';
    }

    // Overall status
    let overallStatus: DailyOverallStatus = 'BELUM_HADIR';
    let overallLabel = 'Belum Hadir';

    if (inPendingAppeal || outPendingAppeal) {
      overallStatus = 'MENUNGGU_SANGGAH';
      overallLabel = 'Menunggu Sanggah';
    } else if (inPendingReview || outPendingReview) {
      overallStatus = 'MENUNGGU_REVIEW';
      overallLabel = 'Menunggu Review';
    } else if (inValid && outValid) {
      if (inLate) {
        overallStatus = 'TERLAMBAT';
        overallLabel = 'Hadir · Terlambat';
      } else if (outEarly) {
        overallStatus = 'PULANG_CEPAT';
        overallLabel = 'Hadir · Pulang Cepat';
      } else if (inFromAppeal && outFromAppeal) {
        overallStatus = 'HADIR_SANGGAH';
        overallLabel = 'Hadir (Sanggah)';
      } else if (inFromAppeal || outFromAppeal) {
        overallStatus = 'HADIR_LENGKAP';
        overallLabel = 'Hadir Lengkap (Sanggah)';
      } else {
        overallStatus = 'HADIR_LENGKAP';
        overallLabel = 'Hadir Lengkap';
      }
    } else if (inValid && !outValid) {
      if (inLate) {
        overallStatus = 'TERLAMBAT';
        overallLabel = 'Masuk Terlambat · Belum Pulang';
      } else if (inFromAppeal) {
        overallStatus = 'HADIR_SANGGAH';
        overallLabel = 'Masuk (Sanggah) · Belum Pulang';
      } else {
        overallStatus = 'SUDAH_MASUK';
        overallLabel = 'Sudah Masuk · Belum Pulang';
      }
    } else if (!inValid && outValid) {
      overallStatus = outEarly ? 'PULANG_CEPAT' : 'HADIR_SANGGAH';
      overallLabel = outEarly ? 'Pulang Cepat' : 'Tercatat Pulang';
    } else if (inRejected || outRejected) {
      overallStatus = 'DITOLAK';
      overallLabel =
        primaryAppeal?.status === 'REJECTED' ? 'Sanggah Ditolak' : 'Absen Ditolak';
    }

    // Duration
    let durationLabel = '-';
    if (inValid && outValid) {
      const startIso =
        ci?.serverTimestampIso ||
        ci?.deviceTimestampIso ||
        `${b.workDateWib}T${startSched}:00+07:00`;
      const endIso =
        co?.serverTimestampIso ||
        co?.deviceTimestampIso ||
        `${b.workDateWib}T${endSched}:00+07:00`;
      durationLabel = formatDurationBetween(startIso, endIso);
      if (durationLabel === '-' && (inFromAppeal || outFromAppeal)) {
        durationLabel = 'Sesuai Jadwal';
      }
    }

    // Location / biometric summary
    const bioRec = (ci && !isAppealRecord(ci) ? ci : null) || (co && !isAppealRecord(co) ? co : null);
    let locationOrFaceSummary = '-';
    if (bioRec) {
      locationOrFaceSummary = `${bioRec.distanceToOfficeMeters}m dari kantor · Wajah ${(
        bioRec.faceMatchScore * 100
      ).toFixed(0)}%`;
    } else if (primaryAppeal) {
      if (
        typeof primaryAppeal.latitude === 'number' &&
        typeof primaryAppeal.longitude === 'number'
      ) {
        locationOrFaceSummary = `${primaryAppeal.category} (${primaryAppeal.latitude.toFixed(
          4
        )}, ${primaryAppeal.longitude.toFixed(4)})`;
      } else {
        locationOrFaceSummary = primaryAppeal.category;
      }
    }

    // Combined notes
    const noteParts: string[] = [];
    for (const apl of b.appeals) {
      const scopeText =
        apl.scope === 'CHECK_IN'
          ? 'Masuk'
          : apl.scope === 'CHECK_OUT'
          ? 'Pulang'
          : 'Sehari Penuh';
      const stText =
        apl.status === 'APPROVED'
          ? 'Disetujui'
          : apl.status === 'REJECTED'
          ? 'Ditolak'
          : 'Menunggu';
      let line = `Sanggah ${scopeText} [${stText}] - ${apl.category}: ${apl.reason}`;
      if (apl.reviewNote && apl.status !== 'PENDING') {
        line += ` (Catatan Admin: ${apl.reviewNote})`;
      }
      noteParts.push(line);
    }

    if (noteParts.length === 0) {
      if (ci?.rejectionReason) noteParts.push(`Masuk: ${ci.rejectionReason}`);
      else if (ci?.reviewNote) noteParts.push(`Masuk: ${ci.reviewNote}`);
      if (co?.rejectionReason) noteParts.push(`Pulang: ${co.rejectionReason}`);
      else if (co?.reviewNote) noteParts.push(`Pulang: ${co.reviewNote}`);
    }

    entries.push({
      key: `${b.workDateWib}_${b.employeeId}`,
      workDateWib: b.workDateWib,
      employeeId: b.employeeId,
      employeeName: b.employeeName,
      position: b.position,
      overallStatus,
      overallLabel,
      sourceLabel,
      checkInTimeWib,
      checkInStatusLabel,
      checkInRecord: ci,
      checkOutTimeWib,
      checkOutStatusLabel,
      checkOutRecord: co,
      durationLabel,
      locationOrFaceSummary,
      notes: noteParts.join(' | ') || '-',
      linkedAppeal: primaryAppeal,
    });
  }

  entries.sort((a, b) => {
    const dateCmp = b.workDateWib.localeCompare(a.workDateWib);
    if (dateCmp !== 0) return dateCmp;
    return a.employeeName.localeCompare(b.employeeName, 'id');
  });

  return entries;
}
