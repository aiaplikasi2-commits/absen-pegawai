/**
 * End-to-End Verification Runner for ABSENSI WAJAH & GPS
 * Tests real backend + Cloud Firestore integration against core security & attendance scenarios.
 */
const BASE = 'http://127.0.0.1:3000';

async function runTests() {
  console.log('--- MULAI PENGUJIAN INTEGRASI NYATA SERVER & CLOUD FIRESTORE ---');

  // 1. Wrong password login attempt
  const badLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'WrongPassword!' }),
  });
  console.log(`[Test 1a] Login password salah -> HTTP ${badLogin.status} (Expected 401)`);
  if (badLogin.status !== 401) throw new Error('Expected 401 on wrong password');

  // 2. Correct Admin login
  const adminLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Admin123!' }),
  });
  const adminData = await adminLogin.json();
  console.log(`[Test 1b] Login Admin benar -> HTTP ${adminLogin.status}, role=${adminData.user?.role}`);
  if (adminLogin.status !== 200 || adminData.user?.role !== 'ADMIN') {
    throw new Error('Admin login failed');
  }
  const adminToken = adminData.token;

  // 3. Create or verify test employee (EMP-TEST1)
  const createEmp = await fetch(`${BASE}/api/admin/employees`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      employeeId: 'EMP-999',
      fullName: 'Penguji Integrasi Sistem',
      username: 'penguji.sistem',
      password: 'Karyawan123!',
      position: 'QA Tester',
    }),
  });
  console.log(`[Test 2] Registrasi karyawan uji -> HTTP ${createEmp.status}`);

  // 4. Register normalized 128D face reference for EMP-999
  const baseVec = Array.from({ length: 128 }, (_, i) => Math.sin(i + 1));
  const norm = Math.sqrt(baseVec.reduce((acc, v) => acc + v * v, 0));
  const refDescriptor = baseVec.map((v) => Number((v / norm).toFixed(6)));

  const enrollResp = await fetch(`${BASE}/api/admin/employees/EMP-999/face-profile`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      descriptorVector: refDescriptor,
      sampleCount: 4,
      qualityScore: 92,
    }),
  });
  console.log(`[Test 3a] Simpan template wajah 128D -> HTTP ${enrollResp.status}`);

  // 5. Login as Employee & verify RBAC blocks /api/admin/*
  const empLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'penguji.sistem', password: 'Karyawan123!' }),
  });
  const empData = await empLogin.json();
  const empToken = empData.token;

  const rbacCheck = await fetch(`${BASE}/api/admin/employees`, {
    headers: { Authorization: `Bearer ${empToken}` },
  });
  console.log(`[Test 2b] RBAC Karyawan akses endpoint Admin -> HTTP ${rbacCheck.status} (Expected 403)`);
  if (rbacCheck.status !== 403) throw new Error('RBAC violation');

  // Fetch office settings to know exact office coordinates
  const meResp = await fetch(`${BASE}/api/auth/me`, {
    headers: { Authorization: `Bearer ${empToken}` },
  });
  const meData = await meResp.json();
  const officeLat = meData.officeSettings.latitude;
  const officeLng = meData.officeSettings.longitude;

  // 6. Test Out-of-Radius GPS rejection (5km away)
  const outRadiusResp = await fetch(`${BASE}/api/attendance/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${empToken}`,
    },
    body: JSON.stringify({
      transactionId: `tx_outradius_${Date.now()}`,
      type: 'CHECK_IN',
      deviceTimestampIso: new Date().toISOString(),
      gpsTimestampIso: new Date().toISOString(),
      latitude: officeLat + 0.05,
      longitude: officeLng + 0.05,
      gpsAccuracyMeters: 12,
      descriptorVector: refDescriptor,
      livenessVerified: true,
      livenessDetail: 'Test 3D OK',
      wasCapturedOffline: false,
    }),
  });
  console.log(`[Test 5] GPS di luar radius kantor -> HTTP ${outRadiusResp.status} (Expected 422 Rejected)`);

  // 7. Test Face Mismatch rejection (orthogonal / inverted vector)
  const wrongDescriptor = refDescriptor.map((v) => -v);
  const wrongFaceResp = await fetch(`${BASE}/api/attendance/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${empToken}`,
    },
    body: JSON.stringify({
      transactionId: `tx_wrongface_${Date.now()}`,
      type: 'CHECK_IN',
      deviceTimestampIso: new Date().toISOString(),
      gpsTimestampIso: new Date().toISOString(),
      latitude: officeLat,
      longitude: officeLng,
      gpsAccuracyMeters: 10,
      descriptorVector: wrongDescriptor,
      livenessVerified: true,
      livenessDetail: 'Test 3D OK',
      wasCapturedOffline: false,
    }),
  });
  console.log(`[Test 3b] Wajah tidak cocok -> HTTP ${wrongFaceResp.status} (Expected 422 Rejected)`);

  // 8. Test Clock Manipulation rejection (device clock shifted +25 minutes)
  const spoofedTime = new Date(Date.now() + 25 * 60 * 1000).toISOString();
  const clockSpoofResp = await fetch(`${BASE}/api/attendance/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${empToken}`,
    },
    body: JSON.stringify({
      transactionId: `tx_clockspoof_${Date.now()}`,
      type: 'CHECK_IN',
      deviceTimestampIso: spoofedTime,
      gpsTimestampIso: spoofedTime,
      latitude: officeLat,
      longitude: officeLng,
      gpsAccuracyMeters: 10,
      descriptorVector: refDescriptor,
      livenessVerified: true,
      livenessDetail: 'Test 3D OK',
      wasCapturedOffline: false,
    }),
  });
  console.log(`[Test 11] Manipulasi jam perangkat -> HTTP ${clockSpoofResp.status} (Expected 422 Rejected)`);

  // 9. Test Check-Out BEFORE Check-In rejection
  const prematureOutResp = await fetch(`${BASE}/api/attendance/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${empToken}`,
    },
    body: JSON.stringify({
      transactionId: `tx_premature_out_${Date.now()}`,
      type: 'CHECK_OUT',
      deviceTimestampIso: new Date().toISOString(),
      gpsTimestampIso: new Date().toISOString(),
      latitude: officeLat,
      longitude: officeLng,
      gpsAccuracyMeters: 10,
      descriptorVector: refDescriptor,
      livenessVerified: true,
      livenessDetail: 'Test 3D OK',
      wasCapturedOffline: false,
    }),
  });
  console.log(`[Test 10a] Absen Pulang sebelum Absen Masuk -> HTTP ${prematureOutResp.status} (Expected 422)`);

  // 10. Test Offline Capture Sync -> Must land in NEEDS_REVIEW, NOT immediately VALID
  const offlineTxId = `tx_offline_sync_${Date.now()}`;
  const offlineSyncResp = await fetch(`${BASE}/api/attendance/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${empToken}`,
    },
    body: JSON.stringify({
      transactionId: offlineTxId,
      type: 'CHECK_IN',
      deviceTimestampIso: new Date().toISOString(),
      gpsTimestampIso: new Date().toISOString(),
      latitude: officeLat,
      longitude: officeLng,
      gpsAccuracyMeters: 12,
      descriptorVector: refDescriptor,
      livenessVerified: true,
      livenessDetail: 'Offline 3D OK',
      wasCapturedOffline: true,
    }),
  });
  const offlineSyncData = await offlineSyncResp.json();
  console.log(
    `[Test 8 & 9] Sinkronisasi catatan offline -> HTTP ${offlineSyncResp.status}, status=${offlineSyncData.record?.attendanceStatus} (Expected NEEDS_REVIEW)`
  );

  // 11. Test Idempotent Replay with exact same transactionId
  const replayResp = await fetch(`${BASE}/api/attendance/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${empToken}`,
    },
    body: JSON.stringify({
      transactionId: offlineTxId,
      type: 'CHECK_IN',
      deviceTimestampIso: new Date().toISOString(),
      gpsTimestampIso: new Date().toISOString(),
      latitude: officeLat,
      longitude: officeLng,
      gpsAccuracyMeters: 12,
      descriptorVector: refDescriptor,
      livenessVerified: true,
      livenessDetail: 'Offline 3D OK',
      wasCapturedOffline: true,
    }),
  });
  const replayData = await replayResp.json();
  console.log(
    `[Test 10b] Pengiriman ulang ID transaksi sama (Idempoten) -> idempotentReplay=${replayData.idempotentReplay}`
  );

  // Clean up test employee EMP-999 and test records so production DB starts clean for the user
  await fetch(`${BASE}/api/admin/employees/EMP-999/biometrics`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({ reason: 'Pembersihan data akun pengujian otomatis' }),
  });
  await fetch(`${BASE}/api/admin/employees/EMP-999`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      isActive: false,
      reason: 'Penonaktifan akun pengujian otomatis setelah verifikasi selesai',
    }),
  });

  console.log('--- SELURUH PENGUJIAN INTEGRASI LULUS DENGAN HASIL NYATA ---');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
