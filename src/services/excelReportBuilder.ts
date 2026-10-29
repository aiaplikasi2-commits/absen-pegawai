import ExcelJS from 'exceljs';
import type {
  AttendanceAppeal,
  AttendanceRecord,
  DailyAttendanceEntry,
  EmployeeProfile,
  OfficeSettings,
} from '../types/attendance.ts';
import {
  formatWibDateLong,
  formatWibDateTime,
} from '../utils/geoAndTime.ts';

export interface MonthlySummaryRow {
  employeeId: string;
  fullName: string;
  position: string;
  totalPresentDays: number;
  onTimeDays: number;
  lateDays: number;
  earlyLeaveDays: number;
  approvedAppealDays: number;
  completedCheckOuts: number;
  pendingCount: number;
  rejectedCount: number;
}

export interface BuildExcelParams {
  reportTitle: string;
  periodLabel: string;
  officeSettings: OfficeSettings;
  employees: EmployeeProfile[];
  summaryRows: MonthlySummaryRow[];
  dailyEntries: DailyAttendanceEntry[];
  appeals: AttendanceAppeal[];
  records: AttendanceRecord[];
}

const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
  left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
  bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
  right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
};

function styleHeaderRow(row: ExcelJS.Row) {
  row.height = 26;
  row.eachCell((cell) => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF0F2942' },
    };
    cell.font = {
      name: 'Calibri',
      size: 11,
      bold: true,
      color: { argb: 'FFFFFFFF' },
    };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = THIN_BORDER;
  });
}

function getStatusColors(status: DailyAttendanceEntry['overallStatus']): {
  bg: string;
  fg: string;
} {
  switch (status) {
    case 'HADIR_LENGKAP':
    case 'SUDAH_MASUK':
      return { bg: 'FFDCFCE7', fg: 'FF166534' };
    case 'HADIR_SANGGAH':
      return { bg: 'FFE0F2FE', fg: 'FF075985' };
    case 'TERLAMBAT':
    case 'PULANG_CEPAT':
    case 'MENUNGGU_SANGGAH':
    case 'MENUNGGU_REVIEW':
      return { bg: 'FFFEF3C7', fg: 'FF92400E' };
    case 'DITOLAK':
      return { bg: 'FFFEE2E2', fg: 'FF991B1B' };
    default:
      return { bg: 'FFF1F5F9', fg: 'FF475569' };
  }
}

export function computeSummaryRows(
  employees: EmployeeProfile[],
  dailyEntries: DailyAttendanceEntry[]
): MonthlySummaryRow[] {
  return employees.map((emp) => {
    const empDays = dailyEntries.filter((d) => d.employeeId === emp.employeeId);
    let totalPresentDays = 0;
    let onTimeDays = 0;
    let lateDays = 0;
    let earlyLeaveDays = 0;
    let approvedAppealDays = 0;
    let completedCheckOuts = 0;
    let pendingCount = 0;
    let rejectedCount = 0;

    for (const d of empDays) {
      const isPresent =
        d.overallStatus === 'HADIR_LENGKAP' ||
        d.overallStatus === 'SUDAH_MASUK' ||
        d.overallStatus === 'HADIR_SANGGAH' ||
        d.overallStatus === 'TERLAMBAT' ||
        d.overallStatus === 'PULANG_CEPAT';

      if (isPresent) {
        totalPresentDays += 1;
        if (d.linkedAppeal?.status === 'APPROVED' || d.overallStatus === 'HADIR_SANGGAH') {
          approvedAppealDays += 1;
        }
        if (d.overallStatus === 'TERLAMBAT') {
          lateDays += 1;
        } else {
          onTimeDays += 1;
        }
        if (d.overallStatus === 'PULANG_CEPAT') {
          earlyLeaveDays += 1;
        }
      }

      if (
        d.checkOutStatusLabel === 'Sudah Pulang' ||
        d.checkOutStatusLabel === 'Sanggah Disetujui' ||
        d.checkOutStatusLabel === 'Pulang Cepat'
      ) {
        completedCheckOuts += 1;
      }

      if (
        d.overallStatus === 'MENUNGGU_SANGGAH' ||
        d.overallStatus === 'MENUNGGU_REVIEW'
      ) {
        pendingCount += 1;
      }

      if (d.overallStatus === 'DITOLAK') {
        rejectedCount += 1;
      }
    }

    return {
      employeeId: emp.employeeId,
      fullName: emp.fullName,
      position: emp.position,
      totalPresentDays,
      onTimeDays,
      lateDays,
      earlyLeaveDays,
      approvedAppealDays,
      completedCheckOuts,
      pendingCount,
      rejectedCount,
    };
  });
}

export async function buildAttendanceExcelBuffer(
  params: BuildExcelParams
): Promise<Buffer> {
  const {
    reportTitle,
    periodLabel,
    officeSettings,
    summaryRows,
    dailyEntries,
    appeals,
    records,
  } = params;

  const wb = new ExcelJS.Workbook();
  wb.creator = officeSettings.officeName;
  wb.created = new Date();
  const printedAt = formatWibDateTime(new Date());

  // =========================================================================
  // SHEET 1: REKAP HARIAN ABSENSI (Primary clear daily Masuk + Pulang + Sanggah sheet)
  // =========================================================================
  const wsDaily = wb.addWorksheet('Rekap Harian Absensi', {
    views: [{ state: 'frozen', ySplit: 4 }],
  });

  wsDaily.mergeCells('A1:M1');
  const titleCell1 = wsDaily.getCell('A1');
  titleCell1.value = `${reportTitle.toUpperCase()} — ${officeSettings.officeName.toUpperCase()}`;
  titleCell1.font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FF0F2942' } };
  titleCell1.alignment = { vertical: 'middle', horizontal: 'left' };
  wsDaily.getRow(1).height = 24;

  wsDaily.mergeCells('A2:M2');
  const subCell1 = wsDaily.getCell('A2');
  subCell1.value = `Periode: ${periodLabel}  |  Jam Kerja: ${officeSettings.workStartTime}–${officeSettings.workEndTime} WIB (Toleransi ${officeSettings.lateToleranceMinutes} mnt)  |  Dicetak: ${printedAt}`;
  subCell1.font = { name: 'Calibri', size: 10, color: { argb: 'FF475569' } };
  wsDaily.getRow(2).height = 18;

  const dailyHeaders = [
    'No',
    'Tanggal (YYYY-MM-DD)',
    'Hari & Tanggal (WIB)',
    'ID Karyawan',
    'Nama Karyawan',
    'Jabatan',
    'Jam Masuk (WIB)',
    'Status Masuk',
    'Jam Pulang (WIB)',
    'Status Pulang',
    'Durasi',
    'Sumber Data',
    'Status Harian',
    'Keterangan / Sanggah Absen',
  ];
  wsDaily.unMergeCells('A1:M1');
  wsDaily.unMergeCells('A2:M2');
  wsDaily.mergeCells('A1:N1');
  wsDaily.mergeCells('A2:N2');

  const headerRowDaily = wsDaily.getRow(4);
  headerRowDaily.values = dailyHeaders;
  styleHeaderRow(headerRowDaily);

  wsDaily.columns = [
    { key: 'no', width: 6 },
    { key: 'dateIso', width: 16 },
    { key: 'dateLong', width: 24 },
    { key: 'empId', width: 14 },
    { key: 'empName', width: 24 },
    { key: 'position', width: 18 },
    { key: 'inTime', width: 16 },
    { key: 'inStatus', width: 22 },
    { key: 'outTime', width: 16 },
    { key: 'outStatus', width: 22 },
    { key: 'duration', width: 14 },
    { key: 'source', width: 18 },
    { key: 'overall', width: 24 },
    { key: 'notes', width: 46 },
  ];

  // Chronological order in Excel for easy reading
  const sortedDaily = [...dailyEntries].sort((a, b) => {
    const d = a.workDateWib.localeCompare(b.workDateWib);
    if (d !== 0) return d;
    return a.employeeName.localeCompare(b.employeeName, 'id');
  });

  sortedDaily.forEach((entry, idx) => {
    const r = wsDaily.addRow([
      idx + 1,
      entry.workDateWib,
      formatWibDateLong(entry.workDateWib),
      entry.employeeId,
      entry.employeeName,
      entry.position,
      entry.checkInTimeWib,
      entry.checkInStatusLabel,
      entry.checkOutTimeWib,
      entry.checkOutStatusLabel,
      entry.durationLabel,
      entry.sourceLabel,
      entry.overallLabel,
      entry.notes === '-' ? entry.locationOrFaceSummary : `${entry.notes} (${entry.locationOrFaceSummary})`,
    ]);
    r.height = 22;
    const isEven = idx % 2 === 1;
    r.eachCell((cell, colNumber) => {
      cell.font = { name: 'Calibri', size: 10.5, color: { argb: 'FF0F172A' } };
      cell.border = THIN_BORDER;
      cell.alignment = {
        vertical: 'middle',
        horizontal:
          colNumber === 1 || colNumber === 2 || colNumber === 7 || colNumber === 9 || colNumber === 11
            ? 'center'
            : 'left',
        wrapText: colNumber === 14,
      };
      if (isEven) {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF8FAFC' },
        };
      }
    });

    const statusCell = r.getCell(13);
    const colors = getStatusColors(entry.overallStatus);
    statusCell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: colors.bg },
    };
    statusCell.font = {
      name: 'Calibri',
      size: 10.5,
      bold: true,
      color: { argb: colors.fg },
    };
  });

  wsDaily.autoFilter = {
    from: { row: 4, column: 1 },
    to: { row: Math.max(4, sortedDaily.length + 4), column: 14 },
  };

  // =========================================================================
  // SHEET 2: RINGKASAN PER KARYAWAN
  // =========================================================================
  const wsSummary = wb.addWorksheet('Ringkasan Karyawan', {
    views: [{ state: 'frozen', ySplit: 4 }],
  });

  wsSummary.mergeCells('A1:K1');
  wsSummary.getCell('A1').value = `RINGKASAN KEHADIRAN KARYAWAN — ${officeSettings.officeName.toUpperCase()}`;
  wsSummary.getCell('A1').font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FF0F2942' } };
  wsSummary.getRow(1).height = 24;

  wsSummary.mergeCells('A2:K2');
  wsSummary.getCell('A2').value = `Periode: ${periodLabel}  |  Dicetak: ${printedAt}`;
  wsSummary.getCell('A2').font = { name: 'Calibri', size: 10, color: { argb: 'FF475569' } };
  wsSummary.getRow(2).height = 18;

  const summaryHeaders = [
    'No',
    'ID Karyawan',
    'Nama Lengkap',
    'Jabatan',
    'Total Hari Hadir',
    'Tepat Waktu',
    'Terlambat',
    'Pulang Cepat',
    'Hadir via Sanggah',
    'Pulang Tercatat',
    'Menunggu Persetujuan',
  ];

  const headerRowSum = wsSummary.getRow(4);
  headerRowSum.values = summaryHeaders;
  styleHeaderRow(headerRowSum);

  wsSummary.columns = [
    { width: 6 },
    { width: 15 },
    { width: 26 },
    { width: 20 },
    { width: 16 },
    { width: 15 },
    { width: 14 },
    { width: 15 },
    { width: 18 },
    { width: 16 },
    { width: 20 },
  ];

  let totPresent = 0;
  let totOnTime = 0;
  let totLate = 0;
  let totEarly = 0;
  let totAppeal = 0;
  let totOut = 0;
  let totPending = 0;

  summaryRows.forEach((row, idx) => {
    totPresent += row.totalPresentDays;
    totOnTime += row.onTimeDays;
    totLate += row.lateDays;
    totEarly += row.earlyLeaveDays;
    totAppeal += row.approvedAppealDays;
    totOut += row.completedCheckOuts;
    totPending += row.pendingCount;

    const r = wsSummary.addRow([
      idx + 1,
      row.employeeId,
      row.fullName,
      row.position,
      row.totalPresentDays,
      row.onTimeDays,
      row.lateDays,
      row.earlyLeaveDays,
      row.approvedAppealDays,
      row.completedCheckOuts,
      row.pendingCount,
    ]);
    r.height = 22;
    r.eachCell((cell, colNumber) => {
      cell.font = {
        name: 'Calibri',
        size: 10.5,
        bold: colNumber === 5,
        color: { argb: 'FF0F172A' },
      };
      cell.border = THIN_BORDER;
      cell.alignment = {
        vertical: 'middle',
        horizontal: colNumber === 1 ? 'center' : colNumber >= 5 ? 'right' : 'left',
      };
      if (idx % 2 === 1) {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF8FAFC' },
        };
      }
    });
  });

  if (summaryRows.length > 0) {
    const totalRow = wsSummary.addRow([
      '',
      '',
      'TOTAL KESELURUHAN',
      '',
      totPresent,
      totOnTime,
      totLate,
      totEarly,
      totAppeal,
      totOut,
      totPending,
    ]);
    totalRow.height = 24;
    totalRow.eachCell((cell, colNumber) => {
      cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF0F2942' } };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE2E8F0' },
      };
      cell.border = THIN_BORDER;
      cell.alignment = {
        vertical: 'middle',
        horizontal: colNumber >= 5 ? 'right' : 'left',
      };
    });
  }

  // =========================================================================
  // SHEET 3: DATA SANGGAH ABSEN (Synchronized Appeal Audit Sheet)
  // =========================================================================
  const wsAppeals = wb.addWorksheet('Data Sanggah Absen', {
    views: [{ state: 'frozen', ySplit: 4 }],
  });

  wsAppeals.mergeCells('A1:K1');
  wsAppeals.getCell('A1').value = `DAFTAR SANGGAH ABSENSI (TUGAS LUAR / KOREKSI JAM) — ${officeSettings.officeName.toUpperCase()}`;
  wsAppeals.getCell('A1').font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FF0F2942' } };
  wsAppeals.getRow(1).height = 24;

  wsAppeals.mergeCells('A2:K2');
  wsAppeals.getCell('A2').value = `Periode: ${periodLabel}  |  Seluruh sanggah yang disetujui otomatis tersinkron ke Rekap Harian Absensi`;
  wsAppeals.getCell('A2').font = { name: 'Calibri', size: 10, color: { argb: 'FF475569' } };
  wsAppeals.getRow(2).height = 18;

  const appealHeaders = [
    'No',
    'Tanggal Kerja (WIB)',
    'ID Karyawan',
    'Nama Karyawan',
    'Cakupan Absen',
    'Kategori Sanggah',
    'Alasan / Keterangan Kegiatan',
    'Koordinat GPS',
    'Status Sanggah',
    'Diproses Oleh',
    'Catatan Admin',
  ];

  const headerRowApl = wsAppeals.getRow(4);
  headerRowApl.values = appealHeaders;
  styleHeaderRow(headerRowApl);

  wsAppeals.columns = [
    { width: 6 },
    { width: 20 },
    { width: 15 },
    { width: 24 },
    { width: 18 },
    { width: 20 },
    { width: 40 },
    { width: 22 },
    { width: 20 },
    { width: 16 },
    { width: 30 },
  ];

  const sortedAppeals = [...appeals].sort((a, b) =>
    a.workDateWib.localeCompare(b.workDateWib)
  );

  sortedAppeals.forEach((apl, idx) => {
    const scopeLabel =
      apl.scope === 'CHECK_IN'
        ? 'Absen Masuk'
        : apl.scope === 'CHECK_OUT'
        ? 'Absen Pulang'
        : 'Masuk & Pulang';
    const statusLabel =
      apl.status === 'APPROVED'
        ? 'Disetujui (Sinkron Hadir)'
        : apl.status === 'REJECTED'
        ? 'Ditolak'
        : 'Menunggu Persetujuan';
    const coords =
      typeof apl.latitude === 'number' && typeof apl.longitude === 'number'
        ? `${apl.latitude}, ${apl.longitude}`
        : '-';

    const r = wsAppeals.addRow([
      idx + 1,
      apl.workDateWib,
      apl.employeeId,
      apl.employeeName,
      scopeLabel,
      apl.category,
      apl.reason,
      coords,
      statusLabel,
      apl.reviewedBy || '-',
      apl.reviewNote || '-',
    ]);
    r.height = 22;
    r.eachCell((cell, colNumber) => {
      cell.font = { name: 'Calibri', size: 10.5, color: { argb: 'FF0F172A' } };
      cell.border = THIN_BORDER;
      cell.alignment = {
        vertical: 'middle',
        horizontal: colNumber === 1 || colNumber === 2 ? 'center' : 'left',
        wrapText: colNumber === 7 || colNumber === 11,
      };
    });
  });

  // =========================================================================
  // SHEET 4: LOG TRANSAKSI DETAIL
  // =========================================================================
  const wsRaw = wb.addWorksheet('Log Transaksi Detail', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  const rawHeaders = [
    'ID Transaksi',
    'Tanggal Kerja (WIB)',
    'ID Karyawan',
    'Nama Karyawan',
    'Jenis',
    'Waktu Tercatat (WIB)',
    'Sumber',
    'Status',
    'Jarak Kantor (m)',
    'Akurasi GPS (m)',
    'Skor Wajah (%)',
    'Keterangan',
  ];
  const rawHeaderRow = wsRaw.getRow(1);
  rawHeaderRow.values = rawHeaders;
  styleHeaderRow(rawHeaderRow);

  wsRaw.columns = [
    { width: 26 },
    { width: 18 },
    { width: 15 },
    { width: 24 },
    { width: 14 },
    { width: 24 },
    { width: 18 },
    { width: 18 },
    { width: 16 },
    { width: 16 },
    { width: 16 },
    { width: 42 },
  ];

  records.forEach((rec) => {
    const fromAppeal = Boolean(
      rec.appealId ||
        rec.transactionId.startsWith('att_apl_') ||
        rec.livenessDetail.startsWith('Sanggah')
    );
    const r = wsRaw.addRow([
      rec.transactionId,
      rec.workDateWib,
      rec.employeeId,
      rec.employeeName,
      rec.type === 'CHECK_IN' ? 'Masuk' : 'Pulang',
      formatWibDateTime(rec.serverTimestampIso || rec.deviceTimestampIso),
      fromAppeal ? 'Sanggah Absen' : 'Kamera & GPS',
      rec.attendanceStatus === 'VALID'
        ? 'Valid'
        : rec.attendanceStatus === 'LATE'
        ? 'Terlambat'
        : rec.attendanceStatus === 'EARLY_LEAVE'
        ? 'Pulang Cepat'
        : rec.attendanceStatus === 'NEEDS_REVIEW'
        ? 'Menunggu'
        : 'Ditolak',
      rec.distanceToOfficeMeters,
      rec.gpsAccuracyMeters,
      Math.round(rec.faceMatchScore * 100),
      rec.reviewNote || rec.rejectionReason || rec.livenessDetail || '-',
    ]);
    r.height = 20;
    r.eachCell((cell) => {
      cell.font = { name: 'Calibri', size: 10, color: { argb: 'FF0F172A' } };
      cell.border = THIN_BORDER;
      cell.alignment = { vertical: 'middle' };
    });
  });

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
