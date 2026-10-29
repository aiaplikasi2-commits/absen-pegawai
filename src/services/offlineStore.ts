import { openDB, DBSchema, IDBPDatabase } from 'idb';
import type {
  AttendanceRecord,
  LocalPendingRecord,
  OfficeSettings,
  SyncEventRecord,
} from '../types/attendance';

interface AbsensiLocalDb extends DBSchema {
  pending_attendance: {
    key: string; // transactionId
    value: LocalPendingRecord;
    indexes: {
      'by-employee': string;
      'by-sync-status': string;
    };
  };
  cached_face_profiles: {
    key: string; // employeeId
    value: {
      employeeId: string;
      descriptorVector: number[];
      threshold: number;
      cachedAtIso: string;
    };
  };
  cached_office_settings: {
    key: string; // 'main'
    value: OfficeSettings;
  };
  cached_attendance_history: {
    key: string; // transactionId
    value: AttendanceRecord;
    indexes: {
      'by-employee': string;
    };
  };
  local_sync_events: {
    key: string; // eventId
    value: SyncEventRecord;
  };
}

let dbPromise: Promise<IDBPDatabase<AbsensiLocalDb>> | null = null;

function getLocalDb() {
  if (!dbPromise) {
    dbPromise = openDB<AbsensiLocalDb>('absensi-wajah-gps-db', 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('pending_attendance')) {
          const store = db.createObjectStore('pending_attendance', {
            keyPath: 'transactionId',
          });
          store.createIndex('by-employee', 'employeeId');
          store.createIndex('by-sync-status', 'syncStatus');
        }
        if (!db.objectStoreNames.contains('cached_face_profiles')) {
          db.createObjectStore('cached_face_profiles', {
            keyPath: 'employeeId',
          });
        }
        if (!db.objectStoreNames.contains('cached_office_settings')) {
          db.createObjectStore('cached_office_settings');
        }
        if (!db.objectStoreNames.contains('cached_attendance_history')) {
          const hist = db.createObjectStore('cached_attendance_history', {
            keyPath: 'transactionId',
          });
          hist.createIndex('by-employee', 'employeeId');
        }
        if (!db.objectStoreNames.contains('local_sync_events')) {
          db.createObjectStore('local_sync_events', {
            keyPath: 'eventId',
          });
        }
      },
    });
  }
  return dbPromise;
}

export async function saveLocalPendingAttendance(record: LocalPendingRecord) {
  const db = await getLocalDb();
  await db.put('pending_attendance', record);
}

export async function getAllLocalPendingAttendance(
  employeeId?: string
): Promise<LocalPendingRecord[]> {
  const db = await getLocalDb();
  const all = await db.getAll('pending_attendance');
  const filtered = employeeId
    ? all.filter((r) => r.employeeId === employeeId)
    : all;
  return filtered.sort((a, b) =>
    b.deviceTimestampIso.localeCompare(a.deviceTimestampIso)
  );
}

export async function updateLocalPendingStatus(
  transactionId: string,
  updates: Partial<LocalPendingRecord>
) {
  const db = await getLocalDb();
  const existing = await db.get('pending_attendance', transactionId);
  if (!existing) return;
  await db.put('pending_attendance', { ...existing, ...updates });
}

export async function cacheFaceProfileLocally(
  employeeId: string,
  descriptorVector: number[],
  threshold: number
) {
  const db = await getLocalDb();
  await db.put('cached_face_profiles', {
    employeeId,
    descriptorVector,
    threshold,
    cachedAtIso: new Date().toISOString(),
  });
}

export async function getCachedFaceProfile(employeeId: string) {
  const db = await getLocalDb();
  return db.get('cached_face_profiles', employeeId);
}

export async function cacheOfficeSettingsLocally(settings: OfficeSettings) {
  const db = await getLocalDb();
  await db.put('cached_office_settings', settings, 'main');
}

export async function getCachedOfficeSettings(): Promise<OfficeSettings | undefined> {
  const db = await getLocalDb();
  return db.get('cached_office_settings', 'main');
}

export async function cacheAttendanceHistoryLocally(records: AttendanceRecord[]) {
  const db = await getLocalDb();
  const tx = db.transaction('cached_attendance_history', 'readwrite');
  for (const r of records) {
    await tx.store.put(r);
  }
  await tx.done;
}

export async function getCachedAttendanceHistory(
  employeeId: string
): Promise<AttendanceRecord[]> {
  const db = await getLocalDb();
  const list = await db.getAllFromIndex(
    'cached_attendance_history',
    'by-employee',
    employeeId
  );
  return list.sort((a, b) =>
    b.deviceTimestampIso.localeCompare(a.deviceTimestampIso)
  );
}

export async function appendLocalSyncEvent(event: SyncEventRecord) {
  const db = await getLocalDb();
  await db.put('local_sync_events', event);
}

export async function getAllLocalSyncEvents(): Promise<SyncEventRecord[]> {
  const db = await getLocalDb();
  const all = await db.getAll('local_sync_events');
  return all.sort((a, b) =>
    b.attemptTimestampIso.localeCompare(a.attemptTimestampIso)
  );
}

export async function exportPendingRecordsJson(): Promise<string> {
  const pending = await getAllLocalPendingAttendance();
  const events = await getAllLocalSyncEvents();
  return JSON.stringify(
    {
      exportedAtIso: new Date().toISOString(),
      appVersion: '1.0.0',
      pendingCount: pending.length,
      pendingRecords: pending,
      syncEvents: events,
    },
    null,
    2
  );
}

export async function importPendingRecordsJson(rawJson: string): Promise<number> {
  const parsed = JSON.parse(rawJson);
  if (!parsed || !Array.isArray(parsed.pendingRecords)) {
    throw new Error('Format file pemulihan catatan pending tidak valid.');
  }
  const db = await getLocalDb();
  let imported = 0;
  for (const item of parsed.pendingRecords) {
    if (item && typeof item.transactionId === 'string') {
      const existing = await db.get('pending_attendance', item.transactionId);
      if (!existing) {
        await db.put('pending_attendance', item);
        imported++;
      }
    }
  }
  return imported;
}
