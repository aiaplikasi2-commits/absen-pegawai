import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { cosineSimilarity } from '../utils/geoAndTime';
import { installWasmConsoleFilter } from '../utils/wasmConsoleFilter';

installWasmConsoleFilter();

let landmarkerInstance: FaceLandmarker | null = null;
let loadingPromise: Promise<FaceLandmarker> | null = null;

/**
 * Loads MediaPipe FaceLandmarker with 478 3D landmarks + 52 facial blendshapes.
 * Assets are cached by Workbox Service Worker after initial load for offline verification.
 */
export async function getFaceLandmarker(): Promise<FaceLandmarker> {
  installWasmConsoleFilter();
  if (landmarkerInstance) return landmarkerInstance;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      installWasmConsoleFilter();
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
      );
      installWasmConsoleFilter();
      try {
        const landmarker = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
            delegate: 'GPU',
          },
          outputFaceBlendshapes: true,
          runningMode: 'VIDEO',
          numFaces: 2, // Detect >1 face to reject multiple people in frame
        });
        landmarkerInstance = landmarker;
        return landmarker;
      } catch {
        installWasmConsoleFilter();
        // Fallback to CPU delegate if WebGL/GPU delegate is unavailable on device
        const landmarker = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
            delegate: 'CPU',
          },
          outputFaceBlendshapes: true,
          runningMode: 'VIDEO',
          numFaces: 2,
        });
        landmarkerInstance = landmarker;
        return landmarker;
      }
    } finally {
      loadingPromise = null;
    }
  })();

  return loadingPromise;
}

// Key structural craniofacial anchor indices on the 478-point canonical mesh
// Chosen to be rigid / expression-invariant (eye corners, nasal bridge, philtrum, chin, zygomatic arches, glabella)
const STRUCTURAL_PAIRS: [number, number][] = [
  [33, 133],   // Left eye width
  [362, 263],  // Right eye width
  [133, 362],  // Intercanthal distance (inner eye corners)
  [33, 263],   // Biocular width (outer eye corners)
  [168, 6],    // Glabella to nasal bridge
  [168, 1],    // Glabella to nose tip
  [6, 1],      // Nasal bridge length
  [98, 327],   // Nasal alar width (nostrils)
  [1, 2],      // Nose tip to subnasale
  [2, 152],    // Subnasale to menton (lower face height)
  [10, 152],   // Forehead trichion to chin (total face height)
  [234, 454],  // Bizygomatic breadth (cheekbone to cheekbone)
  [172, 397],  // Bigonial width (jawline width)
  [61, 291],   // Mouth corner width
  [33, 1],     // Left outer eye to nose tip
  [263, 1],    // Right outer eye to nose tip
  [133, 2],    // Left inner eye to subnasale
  [362, 2],    // Right inner eye to subnasale
  [33, 61],    // Left eye to left mouth corner
  [263, 291],  // Right eye to right mouth corner
  [234, 1],    // Left cheekbone to nose tip
  [454, 1],    // Right cheekbone to nose tip
  [10, 168],   // Upper forehead height
  [152, 172],  // Chin to left jaw angle
  [152, 397],  // Chin to right jaw angle
  [70, 300],   // Outer eyebrow span
  [105, 334],  // Eyebrow arch peak span
  [197, 5],    // Mid-nasal dorsum segment
  [4, 152],    // Pronasale to chin
  [127, 356],  // Temple to temple width
  [93, 323],   // Mid-cheek width
  [58, 288],   // Lower cheek/mandible width
];

// Additional 3D angle & depth ratio triplets [p1, vertex, p2]
const STRUCTURAL_TRIPLETS: [number, number, number][] = [
  [33, 168, 263],  // Eye-glabella-eye angle
  [234, 1, 454],   // Cheek-nosetip-cheek 3D protrusion angle
  [10, 1, 152],    // Forehead-nosetip-chin profile angle
  [133, 1, 362],   // Inner eye-nosetip-inner eye angle
  [172, 152, 397], // Jaw-chin-jaw angle
  [33, 61, 291],   // Left eye-mouth geometry
  [263, 291, 61],  // Right eye-mouth geometry
  [70, 168, 300],  // Brow-glabella-brow angle
  [98, 1, 327],    // Alar-nosetip-alar angle
  [127, 10, 356],  // Temple-forehead-temple curvature
  [234, 152, 454], // Cheek-chin-cheek triangle
  [168, 2, 152],   // Glabella-subnasale-chin collinearity
];

function dist3D(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number }
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function angle3D(
  a: { x: number; y: number; z: number },
  v: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number }
): number {
  const ux = a.x - v.x;
  const uy = a.y - v.y;
  const uz = a.z - v.z;
  const vx = b.x - v.x;
  const vy = b.y - v.y;
  const vz = b.z - v.z;
  const dot = ux * vx + uy * vy + uz * vz;
  const mag = Math.sqrt(ux * ux + uy * uy + uz * uz) * Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (mag === 0) return 0;
  return dot / mag;
}

/**
 * Extracts a rotation-normalized, scale-invariant 128-dimensional biometric descriptor vector
 * from 478 3D canonical landmarks.
 */
export function extractBiometricDescriptor(
  landmarks: { x: number; y: number; z: number }[]
): number[] {
  if (!landmarks || landmarks.length < 468) return [];

  // Base scale: 3D biocular + bizygomatic composite norm so distance to camera doesn't skew features
  const biocular = dist3D(landmarks[33], landmarks[263]);
  const bizygomatic = dist3D(landmarks[234], landmarks[454]);
  const faceHeight = dist3D(landmarks[10], landmarks[152]);
  const baseScale = (biocular + bizygomatic + faceHeight) / 3;
  if (baseScale <= 0.0001) return [];

  const features: number[] = [];

  // 1. 32 scale-invariant pairwise structural ratios
  for (const [i, j] of STRUCTURAL_PAIRS) {
    features.push(dist3D(landmarks[i], landmarks[j]) / baseScale);
  }

  // 2. 12 3D cosine angles (capturing 3D depth relief vs flat surface)
  for (const [i, v, j] of STRUCTURAL_TRIPLETS) {
    features.push(angle3D(landmarks[i], landmarks[v], landmarks[j]));
  }

  // 3. 84 aligned canonical coordinate offsets centered at nasal root (168) and rotated by eye-line
  const origin = landmarks[168];
  const leftEye = landmarks[33];
  const rightEye = landmarks[263];
  const rollAngle = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x);
  const cosR = Math.cos(-rollAngle);
  const sinR = Math.sin(-rollAngle);

  const keyIndices = [
    1, 2, 4, 6, 10, 33, 58, 61, 70, 93, 98, 105, 127, 133,
    152, 172, 197, 234, 263, 288, 291, 300, 323, 327, 334, 356, 362, 397,
  ]; // 28 landmarks * 3 axes = 84 dimensions (32 + 12 + 84 = 128 dimensions total)

  for (const idx of keyIndices) {
    const pt = landmarks[idx];
    const rx = (pt.x - origin.x) / baseScale;
    const ry = (pt.y - origin.y) / baseScale;
    const rz = (pt.z - origin.z) / baseScale;
    const alignedX = rx * cosR - ry * sinR;
    const alignedY = rx * sinR + ry * cosR;
    features.push(alignedX, alignedY, rz);
  }

  // L2 normalize final 128-dim descriptor
  let sqSum = 0;
  for (const f of features) sqSum += f * f;
  const norm = Math.sqrt(sqSum) || 1;
  return features.map((f) => Number((f / norm).toFixed(6)));
}

export function averageDescriptors(samples: number[][]): number[] {
  if (!samples.length) return [];
  const dim = samples[0].length;
  const avg = new Array(dim).fill(0);
  for (const s of samples) {
    for (let i = 0; i < dim; i++) {
      avg[i] += s[i];
    }
  }
  let sqSum = 0;
  for (let i = 0; i < dim; i++) {
    avg[i] /= samples.length;
    sqSum += avg[i] * avg[i];
  }
  const norm = Math.sqrt(sqSum) || 1;
  return avg.map((v) => Number((v / norm).toFixed(6)));
}

export interface FrameQualityAnalysis {
  faceCount: number;
  brightness: number; // 0 - 255
  sharpnessVariance: number;
  faceSizeRatio: number; // face width relative to frame
  isCentered: boolean;
  yawDegrees: number;
  blinkScore: number;
  smileScore: number;
  depthReliefRatio: number; // z-depth ratio (nose tip vs ears/cheeks) for anti-flat-photo check
  isGoodQuality: boolean;
  qualityScore: number; // 0 - 100
  qualityIssue?: string;
}

export function analyzeVideoLightingAndTexture(
  video: HTMLVideoElement,
  scratchCanvas: HTMLCanvasElement
): { brightness: number; sharpnessVariance: number } {
  const w = 160;
  const h = 120;
  scratchCanvas.width = w;
  scratchCanvas.height = h;
  const ctx = scratchCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || video.videoWidth === 0) {
    return { brightness: 120, sharpnessVariance: 100 };
  }
  ctx.drawImage(video, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  let sumLum = 0;
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    gray[p] = lum;
    sumLum += lum;
  }
  const brightness = sumLum / (w * h);

  // Laplacian variance to detect blur / low-detail screen moire
  let lapSum = 0;
  let lapSqSum = 0;
  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const lap =
        gray[idx - w] +
        gray[idx + w] +
        gray[idx - 1] +
        gray[idx + 1] -
        4 * gray[idx];
      lapSum += lap;
      lapSqSum += lap * lap;
      count++;
    }
  }
  const mean = lapSum / (count || 1);
  const variance = lapSqSum / (count || 1) - mean * mean;

  return {
    brightness: Math.round(brightness),
    sharpnessVariance: Math.round(variance * 10) / 10,
  };
}

export function evaluateFaceFrame(
  landmarksList: { x: number; y: number; z: number }[][],
  blendshapesList: { categories: { categoryName: string; score: number }[] }[] | undefined,
  lighting: { brightness: number; sharpnessVariance: number }
): FrameQualityAnalysis {
  const faceCount = landmarksList.length;
  if (faceCount === 0) {
    return {
      faceCount: 0,
      brightness: lighting.brightness,
      sharpnessVariance: lighting.sharpnessVariance,
      faceSizeRatio: 0,
      isCentered: false,
      yawDegrees: 0,
      blinkScore: 0,
      smileScore: 0,
      depthReliefRatio: 0,
      isGoodQuality: false,
      qualityScore: 0,
      qualityIssue: 'Wajah belum terlihat',
    };
  }

  if (faceCount > 1) {
    return {
      faceCount,
      brightness: lighting.brightness,
      sharpnessVariance: lighting.sharpnessVariance,
      faceSizeRatio: 0,
      isCentered: false,
      yawDegrees: 0,
      blinkScore: 0,
      smileScore: 0,
      depthReliefRatio: 0,
      isGoodQuality: false,
      qualityScore: 10,
      qualityIssue: 'Terdeteksi lebih dari 1 wajah',
    };
  }

  const lm = landmarksList[0];
  const leftCheek = lm[234];
  const rightCheek = lm[454];
  const noseTip = lm[1];
  const forehead = lm[10];
  const chin = lm[152];

  const faceWidth = Math.abs(rightCheek.x - leftCheek.x);
  const faceCenterX = (leftCheek.x + rightCheek.x) / 2;
  const faceCenterY = (forehead.y + chin.y) / 2;

  const isCentered =
    faceCenterX > 0.24 &&
    faceCenterX < 0.76 &&
    faceCenterY > 0.2 &&
    faceCenterY < 0.8;

  // Estimate head yaw (-45 to +45 deg) from nose horizontal offset between cheeks
  const midCheekX = (leftCheek.x + rightCheek.x) / 2;
  const halfSpan = Math.max(0.05, faceWidth / 2);
  const yawDegrees = Math.round(((noseTip.x - midCheekX) / halfSpan) * 45);

  // 3D depth relief (nose tip z relative to cheek plane z)
  const avgCheekZ = (leftCheek.z + rightCheek.z) / 2;
  const depthReliefRatio = Math.abs(avgCheekZ - noseTip.z) / Math.max(0.05, faceWidth);

  let blinkScore = 0;
  let smileScore = 0;
  if (blendshapesList && blendshapesList[0]?.categories) {
    const map: Record<string, number> = {};
    for (const c of blendshapesList[0].categories) {
      map[c.categoryName] = c.score;
    }
    blinkScore = ((map['eyeBlinkLeft'] || 0) + (map['eyeBlinkRight'] || 0)) / 2;
    smileScore = ((map['mouthSmileLeft'] || 0) + (map['mouthSmileRight'] || 0)) / 2;
  }

  let issue: string | undefined;
  if (lighting.brightness < 45) {
    issue = 'Cahaya terlalu gelap';
  } else if (lighting.brightness > 242) {
    issue = 'Cahaya terlalu silau';
  } else if (lighting.sharpnessVariance < 18) {
    issue = 'Kamera buram';
  } else if (faceWidth < 0.22) {
    issue = 'Dekatkan wajah';
  } else if (faceWidth > 0.78) {
    issue = 'Jauhkan sedikit wajah';
  } else if (!isCentered) {
    issue = 'Posisikan wajah di tengah';
  } else if (depthReliefRatio < 0.12) {
    issue = 'Gunakan wajah asli';
  }

  const qualityScore = Math.min(
    100,
    Math.max(
      0,
      Math.round(
        (lighting.brightness >= 55 && lighting.brightness <= 220 ? 35 : 15) +
          Math.min(30, lighting.sharpnessVariance / 3) +
          (faceWidth >= 0.25 && faceWidth <= 0.68 ? 20 : 5) +
          (depthReliefRatio >= 0.15 ? 15 : 0)
      )
    )
  );

  return {
    faceCount: 1,
    brightness: lighting.brightness,
    sharpnessVariance: lighting.sharpnessVariance,
    faceSizeRatio: Math.round(faceWidth * 100) / 100,
    isCentered,
    yawDegrees,
    blinkScore: Math.round(blinkScore * 100) / 100,
    smileScore: Math.round(smileScore * 100) / 100,
    depthReliefRatio: Math.round(depthReliefRatio * 1000) / 1000,
    isGoodQuality: !issue,
    qualityScore,
    qualityIssue: issue,
  };
}

export function captureCompactAuditThumbnail(video: HTMLVideoElement): string {
  const canvas = document.createElement('canvas');
  const targetWidth = 180;
  const ratio = video.videoHeight / (video.videoWidth || 1);
  canvas.width = targetWidth;
  canvas.height = Math.round(targetWidth * ratio) || 135;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.55);
}

export { cosineSimilarity };
