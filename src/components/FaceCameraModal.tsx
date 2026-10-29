import React, { useEffect, useRef, useState } from 'react';
import { Camera, CheckCircle2, RefreshCw, AlertTriangle, X } from 'lucide-react';
import {
  analyzeVideoLightingAndTexture,
  averageDescriptors,
  captureCompactAuditThumbnail,
  cosineSimilarity,
  evaluateFaceFrame,
  extractBiometricDescriptor,
  FrameQualityAnalysis,
  getFaceLandmarker,
} from '../services/faceBiometrics';

export interface BiometricCaptureResult {
  descriptorVector: number[];
  sampleCount: number;
  qualityScore: number;
  livenessVerified: boolean;
  livenessDetail: string;
  faceMatchScore?: number;
  thumbnailDataUrl: string;
}

interface FaceCameraModalProps {
  mode: 'ENROLL' | 'VERIFY';
  employeeName: string;
  referenceDescriptor?: number[];
  matchThreshold?: number;
  onSuccess: (result: BiometricCaptureResult) => void;
  onCancel: () => void;
}

type LivenessStage = 'INIT_MODEL' | 'ALIGN_FACE' | 'CHALLENGE_BLINK' | 'COMPLETED';

export const FaceCameraModal: React.FC<FaceCameraModalProps> = ({
  mode,
  employeeName,
  referenceDescriptor,
  matchThreshold = 0.84,
  onSuccess,
  onCancel,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scratchCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  const [stage, setStage] = useState<LivenessStage>('INIT_MODEL');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [quality, setQuality] = useState<FrameQualityAnalysis | null>(null);
  const [enrollStep, setEnrollStep] = useState<number>(0);
  const [liveSimilarity, setLiveSimilarity] = useState<number | null>(null);

  const stageRef = useRef<LivenessStage>('INIT_MODEL');
  const enrollSamplesRef = useRef<number[][]>([]);
  const qualityScoresRef = useRef<number[]>([]);
  const sawEyesOpenRef = useRef<boolean>(false);
  const blinkConfirmedRef = useRef<boolean>(false);
  const stableCenteredFramesRef = useRef<number>(0);
  const lastCaptureMsRef = useRef<number>(0);

  const updateStage = (next: LivenessStage) => {
    stageRef.current = next;
    setStage(next);
  };

  const stopCamera = () => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  };

  const startScanner = async () => {
    setErrorMsg(null);
    updateStage('INIT_MODEL');
    enrollSamplesRef.current = [];
    qualityScoresRef.current = [];
    setEnrollStep(0);
    sawEyesOpenRef.current = false;
    blinkConfirmedRef.current = false;
    stableCenteredFramesRef.current = 0;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'user' },
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
        audio: false,
      });
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      const landmarker = await getFaceLandmarker();
      if (!scratchCanvasRef.current) {
        scratchCanvasRef.current = document.createElement('canvas');
      }

      updateStage('ALIGN_FACE');

      let lastVideoTime = -1;
      let lastTimestampMs = 0;
      const processFrame = () => {
        const video = videoRef.current;
        const canvas = scratchCanvasRef.current;
        if (!video || !canvas || stageRef.current === 'COMPLETED') return;

        if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
          lastVideoTime = video.currentTime;
          const rawNowMs = Math.floor(performance.now());
          const nowMs = rawNowMs > lastTimestampMs ? rawNowMs : lastTimestampMs + 1;
          lastTimestampMs = nowMs;
          const lighting = analyzeVideoLightingAndTexture(video, canvas);
          const detection = landmarker.detectForVideo(video, nowMs);
          const q = evaluateFaceFrame(
            detection.faceLandmarks || [],
            detection.faceBlendshapes,
            lighting
          );
          setQuality(q);

          if (q.faceCount === 1 && detection.faceLandmarks?.[0]) {
            const lm = detection.faceLandmarks[0];
            const desc = extractBiometricDescriptor(lm);

            if (
              mode === 'VERIFY' &&
              referenceDescriptor &&
              referenceDescriptor.length === 128 &&
              desc.length === 128
            ) {
              const sim = cosineSimilarity(desc, referenceDescriptor);
              setLiveSimilarity(Math.round(sim * 1000) / 10);
            }

            if (mode === 'ENROLL') {
              const cooldownPassed = nowMs - lastCaptureMsRef.current > 550;
              if (
                q.isGoodQuality &&
                Math.abs(q.yawDegrees) <= 14 &&
                desc.length === 128 &&
                cooldownPassed
              ) {
                enrollSamplesRef.current.push(desc);
                qualityScoresRef.current.push(q.qualityScore);
                lastCaptureMsRef.current = nowMs;
                const nextCount = enrollSamplesRef.current.length;
                setEnrollStep(nextCount);

                if (nextCount >= 3) {
                  updateStage('COMPLETED');
                  const avgVec = averageDescriptors(enrollSamplesRef.current);
                  const avgQuality = Math.round(
                    qualityScoresRef.current.reduce((a, b) => a + b, 0) /
                      qualityScoresRef.current.length
                  );
                  const thumb = captureCompactAuditThumbnail(video);
                  stopCamera();
                  onSuccess({
                    descriptorVector: avgVec,
                    sampleCount: 3,
                    qualityScore: avgQuality,
                    livenessVerified: true,
                    livenessDetail: '3 sampel wajah',
                    thumbnailDataUrl: thumb,
                  });
                  return;
                }
              }
            } else {
              if (stageRef.current === 'ALIGN_FACE') {
                if (q.isGoodQuality && Math.abs(q.yawDegrees) <= 15) {
                  stableCenteredFramesRef.current += 1;
                  if (q.blinkScore < 0.22) {
                    sawEyesOpenRef.current = true;
                  }
                  if (stableCenteredFramesRef.current >= 5) {
                    updateStage('CHALLENGE_BLINK');
                  }
                } else {
                  stableCenteredFramesRef.current = 0;
                }
              } else if (stageRef.current === 'CHALLENGE_BLINK') {
                if (q.blinkScore < 0.22) {
                  if (
                    blinkConfirmedRef.current &&
                    q.isGoodQuality &&
                    desc.length === 128
                  ) {
                    updateStage('COMPLETED');
                    const thumb = captureCompactAuditThumbnail(video);
                    const matchScore =
                      referenceDescriptor && referenceDescriptor.length === 128
                        ? cosineSimilarity(desc, referenceDescriptor)
                        : 0;
                    stopCamera();
                    onSuccess({
                      descriptorVector: desc,
                      sampleCount: 1,
                      qualityScore: q.qualityScore,
                      livenessVerified: true,
                      livenessDetail: `Kedip 1x (Z=${q.depthReliefRatio})`,
                      faceMatchScore: matchScore,
                      thumbnailDataUrl: thumb,
                    });
                    return;
                  }
                  sawEyesOpenRef.current = true;
                } else if (sawEyesOpenRef.current && q.blinkScore >= 0.35) {
                  blinkConfirmedRef.current = true;
                }
              }
            }
          }
        }

        rafRef.current = requestAnimationFrame(processFrame);
      };

      rafRef.current = requestAnimationFrame(processFrame);
    } catch (err: any) {
      stopCamera();
      if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') {
        setErrorMsg('Izin kamera ditolak.');
      } else if (err?.name === 'NotFoundError') {
        setErrorMsg('Kamera depan tidak ditemukan.');
      } else {
        setErrorMsg(err?.message || 'Gagal membuka kamera.');
      }
    }
  };

  useEffect(() => {
    startScanner();
    return () => {
      stopCamera();
    };
  }, []);

  const getInstructionBanner = () => {
    if (stage === 'INIT_MODEL') return 'Memuat kamera...';
    if (mode === 'ENROLL') {
      return enrollStep < 3 ? `Hadap lurus ke kamera (${enrollStep}/3)` : 'Selesai';
    }
    if (stage === 'ALIGN_FACE') return 'Posisikan wajah di bingkai';
    if (stage === 'CHALLENGE_BLINK') return 'Kedipkan mata 1 kali';
    return 'Selesai';
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/80 p-0 sm:p-4">
      <div className="w-full max-w-lg max-h-[96dvh] flex flex-col rounded-t-3xl sm:rounded-2xl bg-white border border-slate-200 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3.5 bg-[#0F2942] text-white shrink-0">
          <div className="min-w-0">
            <h3 className="text-sm sm:text-base font-bold truncate">
              {mode === 'ENROLL' ? 'Daftar Wajah' : 'Scan Wajah'}
            </h3>
            <p className="text-xs text-sky-200 truncate">{employeeName}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              stopCamera();
              onCancel();
            }}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-white/90 hover:bg-white/10 shrink-0"
            aria-label="Batal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-5 pb-safe space-y-3.5 overflow-y-auto">
          {errorMsg ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 space-y-3">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                <p className="break-words min-w-0">{errorMsg}</p>
              </div>
              <button
                type="button"
                onClick={startScanner}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-[#0F2942] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#163A5C] min-h-[44px]"
              >
                <RefreshCw className="w-4 h-4" />
                <span>Coba Lagi</span>
              </button>
            </div>
          ) : (
            <>
              <div className="relative aspect-[3/4] max-h-[50dvh] sm:aspect-[4/3] sm:max-h-none w-full mx-auto overflow-hidden rounded-2xl bg-slate-900 border border-slate-300">
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  className="h-full w-full object-cover scale-x-[-1]"
                />

                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div
                    className={`w-40 h-52 sm:w-48 sm:h-60 rounded-[50%] border-2 transition-colors ${
                      quality?.isGoodQuality
                        ? 'border-emerald-400 shadow-[0_0_0_9999px_rgba(15,23,42,0.45)]'
                        : 'border-amber-400 shadow-[0_0_0_9999px_rgba(15,23,42,0.52)]'
                    }`}
                  />
                </div>

                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3 py-2.5 text-[11px] sm:text-xs text-white flex flex-wrap items-center justify-between gap-2 font-mono tabular-nums">
                  <span>Cahaya: {quality ? quality.brightness : '--'}</span>
                  {mode === 'VERIFY' && liveSimilarity !== null && (
                    <span>
                      Skor: {liveSimilarity.toFixed(1)}% / {(matchThreshold * 100).toFixed(0)}%
                    </span>
                  )}
                </div>
              </div>

              <div className="rounded-xl bg-slate-100 border border-slate-200 p-3.5">
                <div className="flex items-center gap-2.5 text-xs sm:text-sm font-bold text-[#0F2942]">
                  {stage === 'COMPLETED' ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                  ) : (
                    <Camera className="w-5 h-5 text-[#0F2942] shrink-0" />
                  )}
                  <span className="min-w-0 break-words">{getInstructionBanner()}</span>
                </div>
                {quality?.qualityIssue && stage !== 'INIT_MODEL' && (
                  <p className="mt-1 text-xs font-medium text-amber-700">
                    {quality.qualityIssue}
                  </p>
                )}
              </div>

              {mode === 'ENROLL' ? (
                <div className="grid grid-cols-3 gap-2 text-center text-[11px] font-medium text-slate-600">
                  <div
                    className={`py-2 rounded-lg border ${
                      enrollStep >= 1
                        ? 'bg-emerald-50 border-emerald-300 text-emerald-800 font-semibold'
                        : 'border-slate-200'
                    }`}
                  >
                    Sampel 1
                  </div>
                  <div
                    className={`py-2 rounded-lg border ${
                      enrollStep >= 2
                        ? 'bg-emerald-50 border-emerald-300 text-emerald-800 font-semibold'
                        : 'border-slate-200'
                    }`}
                  >
                    Sampel 2
                  </div>
                  <div
                    className={`py-2 rounded-lg border ${
                      enrollStep >= 3
                        ? 'bg-emerald-50 border-emerald-300 text-emerald-800 font-semibold'
                        : 'border-slate-200'
                    }`}
                  >
                    Sampel 3
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2 text-center text-xs font-medium text-slate-600">
                  <div
                    className={`py-2 rounded-lg border ${
                      stage !== 'INIT_MODEL' && stage !== 'ALIGN_FACE'
                        ? 'bg-emerald-50 border-emerald-300 text-emerald-800 font-semibold'
                        : 'border-slate-200'
                    }`}
                  >
                    1. Posisi Wajah
                  </div>
                  <div
                    className={`py-2 rounded-lg border ${
                      stage === 'COMPLETED'
                        ? 'bg-emerald-50 border-emerald-300 text-emerald-800 font-semibold'
                        : stage === 'CHALLENGE_BLINK'
                        ? 'bg-sky-50 border-sky-300 text-[#0F2942] font-semibold'
                        : 'border-slate-200'
                    }`}
                  >
                    2. Kedip 1 Kali
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
