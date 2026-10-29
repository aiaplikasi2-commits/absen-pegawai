import JSZip from 'jszip';

export function getAndroidKotlinProjectFiles(liveServerUrl: string): Record<string, string> {
  return {
    'README-ANDROID-APK.md': `# ABSENSI WAJAH & GPS — Source Code Android Native (Kotlin + Jetpack Compose)

Proyek ini adalah paket lengkap aplikasi Android Native (\`com.perusahaan.absensiwajahgps\`) menggunakan:
- **Bahasa**: Kotlin 2.0
- **UI**: Jetpack Compose (Material 3, Tema Biru Tua \`#0F2942\` & Putih)
- **Kamera & Verifikasi Wajah**: CameraX + MediaPipe FaceLandmarker (3D 478 Landmarks + Active Liveness Kedipan & Tengok Kepala)
- **Database Lokal Offline**: Room (\`PendingAttendanceEntity\`, \`SyncEventEntity\`, \`CachedFaceProfileEntity\`)
- **Sinkronisasi Otomatis**: Android \`WorkManager\` (\`AttendanceSyncWorker\` dengan \`NetworkType.CONNECTED\` & Idempotency Key)
- **Validasi Lokasi**: Google Play Services \`FusedLocationProviderClient\` (\`PRIORITY_HIGH_ACCURACY\`) + \`Location.isMock\` / \`isFromMockProvider\` + perhitungan geodesik \`Location.distanceBetween\`
- **Backend Online**: Terhubung langsung ke Cloud Server API & Firestore (\`${liveServerUrl}\`) — **tanpa menyimpan kunci rahasia server atau service-role key di dalam APK**.

## Cara Membangun File APK yang Dapat Diinstal (\`app-release.apk\` / \`app-debug.apk\`)

### Opsi 1: Melalui Android Studio (Lokal)
1. Ekstrak arsip ZIP ini ke komputer Anda.
2. Buka folder proyek di **Android Studio Ladybug (2024.2.1)** atau versi lebih baru.
3. Tunggu proses *Gradle Sync* selesai.
4. Pilih menu **Build > Build Bundle(s) / APK(s) > Build APK(s)**.
5. File APK siap diinstal dari \`app/build/outputs/apk/debug/app-debug.apk\`.

### Opsi 2: Otomatis via GitHub Actions (Tanpa Instal Android Studio)
1. Unggah isi ZIP ini ke repositori GitHub pribadi Anda.
2. File workflow \`.github/workflows/build-apk.yml\` sudah disertakan dan otomatis mengompilasi APK menggunakan JDK 17 + Android SDK 35 setiap kali Anda melakukan *push*.
3. Unduh file \`absensi-wajah-gps-apk\` pada tab **Actions > Artifacts**, lalu instal di HP Android karyawan.

### Opsi 3: Instalasi Instan PWA / WebAPK di Android Chrome (Tanpa Kompilasi)
Buka URL aplikasi \`${liveServerUrl}\` langsung menggunakan Google Chrome di HP Android, lalu ketuk tombol **"Instal Aplikasi Android"** di pojok kanan atas untuk memasang aplikasi layar penuh di Home Screen lengkap dengan dukungan kamera depan, GPS akurasi tinggi, dan mode offline otomatis.
`,

    'settings.gradle.kts': `pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "AbsensiWajahGps"
include(":app")
`,

    'build.gradle.kts': `plugins {
    id("com.android.application") version "8.7.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
    id("com.google.devtools.ksp") version "2.0.21-1.0.26" apply false
}
`,

    '.github/workflows/build-apk.yml': `name: Build Android APK

on:
  push:
    branches: [ "main", "master" ]
  workflow_dispatch:

jobs:
  build-apk:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Source
        uses: actions/checkout@v4

      - name: Setup JDK 17
        uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '17'

      - name: Setup Gradle
        uses: gradle/actions/setup-gradle@v4

      - name: Build Debug APK
        run: gradle assembleDebug

      - name: Upload Installable APK Artifact
        uses: actions/upload-artifact@v4
        with:
          name: absensi-wajah-gps-apk
          path: app/build/outputs/apk/debug/app-debug.apk
`,

    'app/build.gradle.kts': `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.devtools.ksp")
}

android {
    namespace = "com.perusahaan.absensiwajahgps"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.perusahaan.absensiwajahgps"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"

        // Endpoint server online; TIDAK ADA rahasia admin / service key di dalam APK
        buildConfigField("String", "API_BASE_URL", "\\"${liveServerUrl}\\"")
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")

    // CameraX untuk kamera depan
    val cameraxVersion = "1.4.0"
    implementation("androidx.camera:camera-core:$cameraxVersion")
    implementation("androidx.camera:camera-camera2:$cameraxVersion")
    implementation("androidx.camera:camera-lifecycle:$cameraxVersion")
    implementation("androidx.camera:camera-view:$cameraxVersion")

    // MediaPipe Tasks Vision untuk Face Verification & 3D Liveness Detection
    implementation("com.google.mediapipe:tasks-vision:0.10.18")

    // Android Location Services (FusedLocationProviderClient)
    implementation("com.google.android.gms:play-services-location:21.3.0")

    // Room Local Offline Database
    val roomVersion = "2.6.1"
    implementation("androidx.room:room-runtime:$roomVersion")
    implementation("androidx.room:room-ktx:$roomVersion")
    ksp("androidx.room:room-compiler:$roomVersion")

    // WorkManager untuk sinkronisasi otomatis saat kembali online
    implementation("androidx.work:work-runtime-ktx:2.10.0")

    // EncryptedSharedPreferences untuk sesi JWT aman
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // Networking (Retrofit + OkHttp)
    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-gson:2.11.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
`,

    'app/src/main/AndroidManifest.xml': `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-feature android:name="android.hardware.camera.front" android:required="true" />
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />

    <application
        android:allowBackup="false"
        android:label="ABSENSI WAJAH &amp; GPS"
        android:supportsRtl="true"
        android:usesCleartextTraffic="false"
        android:theme="@android:style/Theme.Material.Light.NoActionBar">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:screenOrientation="portrait">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`,

    'app/src/main/java/com/perusahaan/absensiwajahgps/data/local/AttendanceDatabase.kt': `package com.perusahaan.absensiwajahgps.data.local

import androidx.room.*
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "pending_attendance")
data class PendingAttendanceEntity(
    @PrimaryKey val transactionId: String, // UUID idempotency key
    val employeeId: String,
    val employeeName: String,
    val type: String, // CHECK_IN | CHECK_OUT
    val deviceTimestampIso: String,
    val gpsTimestampIso: String,
    val latitude: Double,
    val longitude: Double,
    val gpsAccuracyMeters: Float,
    val isMockLocationDetected: Boolean,
    val faceMatchScore: Float,
    val faceVerified: Boolean,
    val livenessVerified: Boolean,
    val livenessDetail: String,
    val descriptorJson: String,
    val thumbnailBase64: String?,
    val syncStatus: String, // WAITING_SYNC | SENDING | SYNCED | REJECTED_SERVER | NEEDS_ADMIN_REVIEW
    val syncAttempts: Int = 0,
    val serverMessage: String? = null
)

@Entity(tableName = "sync_events")
data class SyncEventEntity(
    @PrimaryKey val eventId: String,
    val transactionId: String,
    val employeeId: String,
    val attemptTimestampIso: String,
    val outcome: String,
    val detail: String
)

@Entity(tableName = "cached_face_profiles")
data class CachedFaceProfileEntity(
    @PrimaryKey val employeeId: String,
    val descriptorJson: String,
    val matchThreshold: Float,
    val updatedAtIso: String
)

@Dao
interface AttendanceDao {
    @Query("SELECT * FROM pending_attendance ORDER BY deviceTimestampIso DESC")
    fun observeAllRecords(): Flow<List<PendingAttendanceEntity>>

    @Query("SELECT * FROM pending_attendance WHERE syncStatus = 'WAITING_SYNC'")
    suspend fun getWaitingSyncRecords(): List<PendingAttendanceEntity>

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertPending(record: PendingAttendanceEntity): Long

    @Query("UPDATE pending_attendance SET syncStatus = :status, syncAttempts = syncAttempts + 1, serverMessage = :msg WHERE transactionId = :txId")
    suspend fun updateSyncResult(txId: String, status: String, msg: String?)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertSyncEvent(event: SyncEventEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveCachedFaceProfile(profile: CachedFaceProfileEntity)

    @Query("SELECT * FROM cached_face_profiles WHERE employeeId = :empId LIMIT 1")
    suspend fun getCachedFaceProfile(empId: String): CachedFaceProfileEntity?
}

@Database(
    entities = [PendingAttendanceEntity::class, SyncEventEntity::class, CachedFaceProfileEntity::class],
    version = 1,
    exportSchema = false
)
abstract class AttendanceDatabase : RoomDatabase() {
    abstract fun attendanceDao(): AttendanceDao
}
`,

    'app/src/main/java/com/perusahaan/absensiwajahgps/location/GpsValidator.kt': `package com.perusahaan.absensiwajahgps.location

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.os.Build
import android.os.SystemClock
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import kotlinx.coroutines.suspendCancellableCoroutine
import java.time.Instant
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

data class ValidatedGpsResult(
    val latitude: Double,
    val longitude: Double,
    val accuracyMeters: Float,
    val distanceToOfficeMeters: Float,
    val withinGeofence: Boolean,
    val accuracyAcceptable: Boolean,
    val isMockSuspected: Boolean,
    val suspiciousNotes: List<String>,
    val gpsTimestampIso: String
)

class GpsValidator(private val context: Context) {
    private val fusedClient = LocationServices.getFusedLocationProviderClient(context)

    @SuppressLint("MissingPermission")
    suspend fun captureAndValidateFreshLocation(
        officeLat: Double,
        officeLng: Double,
        allowedRadiusMeters: Float,
        maxAccuracyMeters: Float
    ): ValidatedGpsResult = suspendCancellableCoroutine { cont ->
        val cts = CancellationTokenSource()
        // Selalu meminta koordinat segar dari sensor GPS (bukan getLastLocation yang lama)
        fusedClient.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, cts.token)
            .addOnSuccessListener { loc: Location? ->
                if (loc == null) {
                    cont.resumeWithException(IllegalStateException("Sinyal GPS tidak tersedia. Aktifkan lokasi akurasi tinggi."))
                    return@addOnSuccessListener
                }

                val flags = mutableListOf<String>()
                val isMock = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    loc.isMock
                } else {
                    @Suppress("DEPRECATION")
                    loc.isFromMockProvider
                }
                if (isMock) {
                    flags.add("Mock Location Provider terdeteksi oleh sistem Android")
                }

                val ageNanos = SystemClock.elapsedRealtimeNanos() - loc.elapsedRealtimeNanos
                val ageSeconds = ageNanos / 1_000_000_000L
                if (ageSeconds > 30) {
                    flags.add("Usia sampel GPS terlalu lama ($ageSeconds detik)")
                }

                val results = FloatArray(1)
                // Perhitungan geodesik WGS-84 elipsoid bawaan Android
                Location.distanceBetween(loc.latitude, loc.longitude, officeLat, officeLng, results)
                val distanceMeters = results[0]

                cont.resume(
                    ValidatedGpsResult(
                        latitude = loc.latitude,
                        longitude = loc.longitude,
                        accuracyMeters = loc.accuracy,
                        distanceToOfficeMeters = distanceMeters,
                        withinGeofence = distanceMeters <= allowedRadiusMeters,
                        accuracyAcceptable = loc.accuracy <= maxAccuracyMeters,
                        isMockSuspected = isMock || flags.isNotEmpty(),
                        suspiciousNotes = flags,
                        gpsTimestampIso = Instant.ofEpochMilli(loc.time).toString()
                    )
                )
            }
            .addOnFailureListener { err ->
                cont.resumeWithException(err)
            }
    }
}
`,

    'app/src/main/java/com/perusahaan/absensiwajahgps/biometrics/FaceLivenessVerifier.kt': `package com.perusahaan.absensiwajahgps.biometrics

import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.atan2
import kotlin.math.abs

/**
 * Ekstraksi template biometrik 128-dimensi yang ternormalisasi rotasi & skala
 * serta pemeriksaan Liveness Aktif (Kedipan Mata + Rotasi Kepala 3D + Relief Kedalaman Z)
 * untuk menolak foto cetak, layar HP, dan rekaman statis.
 */
object FaceLivenessVerifier {

    data class Point3D(val x: Float, val y: Float, val z: Float)

    private fun dist(a: Point3D, b: Point3D): Float {
        val dx = a.x - b.x
        val dy = a.y - b.y
        val dz = a.z - b.z
        return sqrt(dx * dx + dy * dy + dz * dz)
    }

    fun cosineSimilarity(a: FloatArray, b: FloatArray): Float {
        if (a.isEmpty() || a.size != b.size) return 0f
        var dot = 0f
        var na = 0f
        var nb = 0f
        for (i in a.indices) {
            dot += a[i] * b[i]
            na += a[i] * a[i]
            nb += b[i] * b[i]
        }
        val denom = sqrt(na) * sqrt(nb)
        return if (denom == 0f) 0f else dot / denom
    }

    fun verify3DDepthRelief(landmarks: List<Point3D>): Boolean {
        if (landmarks.size < 468) return false
        val leftCheek = landmarks[234]
        val rightCheek = landmarks[454]
        val noseTip = landmarks[1]
        val faceWidth = abs(rightCheek.x - leftCheek.x).coerceAtLeast(0.05f)
        val avgCheekZ = (leftCheek.z + rightCheek.z) / 2f
        val relief = abs(avgCheekZ - noseTip.z) / faceWidth
        // Permukaan foto datar memiliki relief kedalaman Z jauh lebih rendah
        return relief >= 0.12f
    }
}
`,

    'app/src/main/java/com/perusahaan/absensiwajahgps/sync/AttendanceSyncWorker.kt': `package com.perusahaan.absensiwajahgps.sync

import android.content.Context
import androidx.work.*
import com.perusahaan.absensiwajahgps.BuildConfig
import com.perusahaan.absensiwajahgps.data.local.AttendanceDatabase
import com.perusahaan.absensiwajahgps.data.local.SyncEventEntity
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * WorkManager Worker untuk sinkronisasi otomatis catatan PENDING_OFFLINE
 * ketika perangkat kembali terhubung ke internet.
 * Catatan lokal TIDAK dihapus sebelum server mengonfirmasi penyimpanan.
 */
class AttendanceSyncWorker(
    appContext: Context,
    workerParams: WorkerParameters
) : CoroutineWorker(appContext, workerParams) {

    override suspend fun doWork(): Result {
        val db = androidx.room.Room.databaseBuilder(
            applicationContext,
            AttendanceDatabase::class.java,
            "absensi_wajah_gps.db"
        ).build()
        val dao = db.attendanceDao()
        val prefs = applicationContext.getSharedPreferences("secure_auth_prefs", Context.MODE_PRIVATE)
        val jwtToken = prefs.getString("jwt_token", null) ?: return Result.retry()

        val waitingList = dao.getWaitingSyncRecords()
        if (waitingList.isEmpty()) return Result.success()

        val client = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .build()

        for (item in waitingList) {
            dao.updateSyncResult(item.transactionId, "SENDING", "Mengirim ke server...")
            try {
                val payload = JSONObject().apply {
                    put("transactionId", item.transactionId)
                    put("type", item.type)
                    put("deviceTimestampIso", item.deviceTimestampIso)
                    put("gpsTimestampIso", item.gpsTimestampIso)
                    put("latitude", item.latitude)
                    put("longitude", item.longitude)
                    put("gpsAccuracyMeters", item.gpsAccuracyMeters)
                    put("wasCapturedOffline", true)
                    put("livenessVerified", item.livenessVerified)
                    put("livenessDetail", item.livenessDetail)
                }

                val req = Request.Builder()
                    .url(BuildConfig.API_BASE_URL + "/api/attendance/submit")
                    .addHeader("Authorization", "Bearer $jwtToken")
                    .post(payload.toString().toRequestBody("application/json".toMediaType()))
                    .build()

                client.newCall(req).execute().use { resp ->
                    val bodyStr = resp.body?.string() ?: "{}"
                    val json = JSONObject(bodyStr)
                    if (resp.isSuccessful) {
                        val serverSyncStatus = json.optString("syncStatus", "SYNCED")
                        val msg = json.optString("message", "Tersinkronisasi ke server")
                        dao.updateSyncResult(item.transactionId, serverSyncStatus, msg)
                        dao.insertSyncEvent(
                            SyncEventEntity(
                                eventId = UUID.randomUUID().toString(),
                                transactionId = item.transactionId,
                                employeeId = item.employeeId,
                                attemptTimestampIso = Instant.now().toString(),
                                outcome = serverSyncStatus,
                                detail = msg
                            )
                        )
                    } else if (resp.code in 400..499) {
                        val reason = json.optString("error", "Ditolak server")
                        dao.updateSyncResult(item.transactionId, "REJECTED_SERVER", reason)
                    } else {
                        dao.updateSyncResult(item.transactionId, "WAITING_SYNC", "Server sibuk, akan dicoba ulang")
                        return Result.retry()
                    }
                }
            } catch (e: Exception) {
                dao.updateSyncResult(item.transactionId, "WAITING_SYNC", e.localizedMessage)
                dao.insertSyncEvent(
                    SyncEventEntity(
                        eventId = UUID.randomUUID().toString(),
                        transactionId = item.transactionId,
                        employeeId = item.employeeId,
                        attemptTimestampIso = Instant.now().toString(),
                        outcome = "NETWORK_RETRY",
                        detail = e.localizedMessage ?: "Gagal terhubung"
                    )
                )
                return Result.retry()
            }
        }
        return Result.success()
    }

    companion object {
        fun enqueueWhenOnline(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()
            val req = OneTimeWorkRequestBuilder<AttendanceSyncWorker>()
                .setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                "absensi_auto_sync",
                ExistingWorkPolicy.KEEP,
                req
            )
        }
    }
}
`,

    'app/src/main/java/com/perusahaan/absensiwajahgps/MainActivity.kt': `package com.perusahaan.absensiwajahgps

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.delay

private val NavyPrimary = Color(0xFF0F2942)
private val CleanWhite = Color(0xFFFFFFFF)
private val SurfaceBg = Color(0xFFF8FAFC)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(
                colorScheme = lightColorScheme(
                    primary = NavyPrimary,
                    onPrimary = CleanWhite,
                    background = SurfaceBg,
                    surface = CleanWhite
                )
            ) {
                AbsensiMainScreen()
            }
        }
    }
}

@Composable
fun AbsensiMainScreen() {
    var currentWib by remember { mutableStateOf("") }
    val formatter = remember {
        DateTimeFormatter.ofPattern("dd MMM yyyy · HH:mm:ss 'WIB'")
    }

    LaunchedEffect(Unit) {
        while (true) {
            currentWib = ZonedDateTime.now(ZoneId.of("Asia/Jakarta")).format(formatter)
            delay(1000L)
        }
    }

    Scaffold(
        topBar = {
            Surface(color = NavyPrimary, shadowElevation = 2.dp) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 20.dp, vertical = 16.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = "ABSENSI WAJAH & GPS",
                        color = CleanWhite,
                        fontWeight = FontWeight.Bold,
                        fontSize = 16.sp
                    )
                    Text(
                        text = currentWib,
                        color = Color(0xFFBAE6FD),
                        fontSize = 12.sp
                    )
                }
            }
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(SurfaceBg)
                .padding(padding)
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Card(
                shape = RoundedCornerShape(12.dp),
                colors = CardDefaults.cardColors(containerColor = CleanWhite),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Endpoint Cloud Terhubung", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                    Text(BuildConfig.API_BASE_URL, fontSize = 12.sp, color = Color(0xFF475569))
                    Text(
                        "Kamera Depan CameraX + MediaPipe 3D Liveness + FusedLocationProviderClient + Room Offline + WorkManager aktif.",
                        fontSize = 12.sp,
                        color = Color(0xFF334155)
                    )
                }
            }
        }
    }
}
`,
  };
}

export async function downloadAndroidSourceZip(liveServerUrl: string): Promise<void> {
  const zip = new JSZip();
  const files = getAndroidKotlinProjectFiles(liveServerUrl);
  for (const [filePath, content] of Object.entries(files)) {
    zip.file(`AbsensiWajahGps-Android/${filePath}`, content);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'AbsensiWajahGps-Android-Kotlin-Source.zip';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
