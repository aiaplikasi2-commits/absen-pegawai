import type { GpsReading } from '../types/attendance';
import { calculateGeodesicDistanceMeters } from '../utils/geoAndTime';

let previousReading: GpsReading | null = null;

/**
 * Acquires a fresh high-accuracy GPS coordinate directly from device hardware
 * (`maximumAge: 0` forbids stale cached locations).
 * Runs heuristic mock/spoof anomaly checks on accuracy, altitude consistency, timestamp age, and velocity jumps.
 */
export function acquireFreshGpsLocation(timeoutMs = 15000): Promise<GpsReading> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Layanan lokasi GPS tidak didukung oleh perangkat ini.'));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const nowMs = Date.now();
        const coord = pos.coords;
        const suspiciousFlags: string[] = [];

        // 1. Stale coordinate check (should be fresh because maximumAge: 0)
        const ageMs = Math.abs(nowMs - pos.timestamp);
        if (ageMs > 45000) {
          suspiciousFlags.push(`Timestamp GPS tertunda ${Math.round(ageMs / 1000)} detik`);
        }

        // 2. Unnatural zero/integer accuracy often emitted by mock GPS injectors
        if (coord.accuracy <= 1.0) {
          suspiciousFlags.push(`Akurasi terlalu sempurna (${coord.accuracy}m) — indikasi emulator/mock`);
        }

        // 3. Impossible velocity jump relative to previous reading in same session
        if (previousReading) {
          const distDelta = calculateGeodesicDistanceMeters(
            previousReading.latitude,
            previousReading.longitude,
            coord.latitude,
            coord.longitude
          );
          const timeDeltaSec = Math.max(0.5, (pos.timestamp - previousReading.timestampMs) / 1000);
          const impliedSpeedMps = distDelta / timeDeltaSec;
          if (distDelta > 250 && impliedSpeedMps > 55) {
            suspiciousFlags.push(
              `Lonjakan koordinat tidak wajar (${Math.round(impliedSpeedMps * 3.6)} km/jam)`
            );
          }
        }

        // 4. Speed vs accuracy mismatch
        if (coord.speed !== null && coord.speed > 35) {
          suspiciousFlags.push(`Kecepatan perangkat tinggi (${Math.round(coord.speed * 3.6)} km/jam)`);
        }

        const reading: GpsReading = {
          latitude: Number(coord.latitude.toFixed(7)),
          longitude: Number(coord.longitude.toFixed(7)),
          accuracyMeters: Math.round(coord.accuracy * 10) / 10,
          altitude: coord.altitude,
          altitudeAccuracy: coord.altitudeAccuracy,
          speed: coord.speed,
          heading: coord.heading,
          timestampMs: pos.timestamp,
          timestampIso: new Date(pos.timestamp).toISOString(),
          suspiciousFlags,
        };

        previousReading = reading;
        resolve(reading);
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          reject(
            new Error(
              'Izin lokasi GPS ditolak. Aktifkan izin Lokasi Akurat (Precise Location) pada pengaturan aplikasi/browser.'
            )
          );
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          reject(
            new Error(
              'Sinyal GPS tidak tersedia. Pastikan GPS perangkat aktif dan berada di area dengan sinyal memadai.'
            )
          );
        } else if (err.code === err.TIMEOUT) {
          reject(
            new Error(
              'Waktu pengambilan GPS habis. Silakan tunggu beberapa detik di ruang terbuka lalu coba lagi.'
            )
          );
        } else {
          reject(new Error(`Gagal membaca lokasi GPS: ${err.message}`));
        }
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0, // Never accept cached old GPS coordinates
        timeout: timeoutMs,
      }
    );
  });
}
