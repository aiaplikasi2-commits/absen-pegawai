# Security Specification — ABSENSI WAJAH & GPS

## 1. Data Invariants
1. **Zero Client Write on Sensitive Collections**: All credential checks (`/users`), biometric templates (`/face_profiles`), attendance validations (`/attendance_records`), evidence (`/attendance_evidence`), sync logs (`/sync_events`), and audit trails (`/audit_logs`) are strictly mutated ONLY via the trusted backend (`firebase-admin` in `server.ts`), never directly by untrusted client SDKs.
2. **No Self-Assigned Admin Roles**: No client can write to `/users` or `/admins` to escalate privileges.
3. **PII & Biometric Isolation**: `/users` (password hashes) and `/face_profiles` (biometric vectors) cannot be listed or read by non-admin clients.
4. **Strict Query Enforcement**: Employees reading `/attendance_records` via client SDK (if authenticated via Firebase Auth) can only access documents where `resource.data.firebaseUid == request.auth.uid`, or if verified as Admin (`isAdmin()`).
5. **Bootstrapped Verified Admin**: Only `mull.jhamur@gmail.com` with `email_verified == true` or UIDs explicitly recorded in `/admins/{uid}` satisfy `isAdmin()`.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Payload 1 (Privilege Escalation)**: Unauthenticated/Employee client attempts `create` on `/users/hacker` with `role: "ADMIN"`. -> `PERMISSION_DENIED`
2. **Payload 2 (Admin Spoofing Unverified Email)**: Attacker with `email: "mull.jhamur@gmail.com"` and `email_verified: false` attempts `get` on `/office_settings/main`. -> `PERMISSION_DENIED`
3. **Payload 3 (Direct Client Attendance Forgery)**: Employee attempts `create` directly on `/attendance_records/tx_fake` with `attendanceStatus: "VALID"` bypassing server geofence check. -> `PERMISSION_DENIED`
4. **Payload 4 (Retroactive Attendance Tampering)**: Employee attempts `update` on `/attendance_records/tx_1` changing `deviceTimestampIso` or `attendanceStatus`. -> `PERMISSION_DENIED`
5. **Payload 5 (Biometric Harvesting)**: Employee attempts `get` or `list` on `/face_profiles/EMP002` belonging to another employee. -> `PERMISSION_DENIED`
6. **Payload 6 (Password Hash Scraping)**: Authenticated user attempts `get` on `/users/admin`. -> `PERMISSION_DENIED`
7. **Payload 7 (Audit Trail Erasure)**: Admin attempts `delete` or `update` on `/audit_logs/log_001` via client SDK. -> `PERMISSION_DENIED`
8. **Payload 8 (ID Poisoning / DoW)**: Attacker sends 2KB junk document ID to `/employees/{hugeId}`. -> `PERMISSION_DENIED`
9. **Payload 9 (Shadow Field Injection)**: Client attempts `update` on `/office_settings/main` with extra field `bypassGps: true`. -> `PERMISSION_DENIED`
10. **Payload 10 (Cross-Employee Attendance List)**: Authenticated user attempts `list` on `/attendance_records` without `firebaseUid == request.auth.uid` filter. -> `PERMISSION_DENIED`
11. **Payload 11 (Evidence Theft)**: Non-admin user attempts `get` on `/attendance_evidence/tx_002`. -> `PERMISSION_DENIED`
12. **Payload 12 (Value Poisoning on Office Radius)**: Admin attempts client `update` on `/office_settings/main` setting `radiusMeters: "unlimited"` (string instead of number). -> `PERMISSION_DENIED`
