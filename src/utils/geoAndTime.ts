/**
 * Geodesic distance calculation (WGS-84 Haversine / Vincenty spherical approximation)
 * and Asia/Jakarta (WIB, UTC+7) timezone formatting & work-date utilities.
 */

export function calculateGeodesicDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371008.8; // Mean Earth radius in meters (IUGG WGS-84)
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const rLat1 = toRad(lat1);
  const rLat2 = toRad(lat2);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);

  const a =
    sinDLat * sinDLat +
    Math.cos(rLat1) * Math.cos(rLat2) * sinDLon * sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));

  return Math.round(R * c * 10) / 10;
}

export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (!vecA.length || vecA.length !== vecB.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function formatWibDateTime(isoOrDate: string | Date): string {
  const d = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  if (Number.isNaN(d.getTime())) return '-';
  const datePart = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(d);
  const timePart = formatWibHourMinute(d, true);
  return `${datePart}, ${timePart}`;
}

export function formatWibTimeOnly(isoOrDate: string | Date): string {
  return formatWibHourMinute(isoOrDate, false);
}

export function formatWibHourMinute(
  isoOrDate?: string | Date,
  withSeconds: boolean = false
): string {
  if (!isoOrDate) return '--:--';
  const d = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  if (Number.isNaN(d.getTime())) return '--:--';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    second: withSeconds ? '2-digit' : undefined,
    hour12: false,
  }).formatToParts(d);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const hh = map.hour === '24' ? '00' : map.hour || '00';
  const mm = map.minute || '00';
  if (withSeconds) {
    const ss = map.second || '00';
    return `${hh}:${mm}:${ss} WIB`;
  }
  return `${hh}:${mm} WIB`;
}

export function formatWibDateLong(yyyyMmDd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(yyyyMmDd)) return yyyyMmDd || '-';
  const d = new Date(`${yyyyMmDd}T12:00:00+07:00`);
  if (Number.isNaN(d.getTime())) return yyyyMmDd;
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    weekday: 'long',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

export function buildScheduledWibIso(workDateWib: string, hhmm: string): string {
  const cleanDate = /^\d{4}-\d{2}-\d{2}$/.test(workDateWib)
    ? workDateWib
    : getWibParts(new Date()).dateStr;
  const cleanTime = /^\d{2}:\d{2}$/.test(hhmm) ? hhmm : '08:00';
  const d = new Date(`${cleanDate}T${cleanTime}:00+07:00`);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

export function formatDurationBetween(
  checkInIso?: string,
  checkOutIso?: string
): string {
  if (!checkInIso || !checkOutIso) return '-';
  const t1 = new Date(checkInIso).getTime();
  const t2 = new Date(checkOutIso).getTime();
  if (Number.isNaN(t1) || Number.isNaN(t2) || t2 <= t1) return '-';
  const diffMins = Math.round((t2 - t1) / 60000);
  if (diffMins <= 0 || diffMins > 24 * 60) return '-';
  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  if (hours === 0) return `${mins}m`;
  return `${hours}j ${String(mins).padStart(2, '0')}m`;
}

export function getWibParts(date: Date = new Date()): {
  year: string;
  month: string;
  day: string;
  hour: number;
  minute: number;
  dateStr: string;
  monthPeriod: string;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const hour = Number(map.hour === '24' ? '0' : map.hour || '0');
  const minute = Number(map.minute || '0');
  const dateStr = `${map.year}-${map.month}-${map.day}`;
  const monthPeriod = `${map.year}-${map.month}`;
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour,
    minute,
    dateStr,
    monthPeriod,
  };
}

/**
 * Computes effective workDate in WIB. If night shift is enabled by Admin and
 * current time is before 05:00 WIB during CHECK_OUT, attributes to previous calendar day.
 */
export function resolveWorkDateWib(
  timestamp: Date,
  enableNightShift: boolean,
  type: 'CHECK_IN' | 'CHECK_OUT'
): string {
  const wib = getWibParts(timestamp);
  if (enableNightShift && type === 'CHECK_OUT' && wib.hour < 6) {
    const prev = new Date(timestamp.getTime() - 12 * 3600 * 1000);
    return getWibParts(prev).dateStr;
  }
  return wib.dateStr;
}

export function parseHhMmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return 8 * 60;
  return h * 60 + m;
}
