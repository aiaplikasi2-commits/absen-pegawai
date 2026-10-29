import React, { useState } from 'react';
import { Download, Smartphone, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, isAndroid, install } =
    usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  if (isInstalled) return null;

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-[#0F2942] px-3 sm:px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#163A5C] active:scale-[0.98] transition-all whitespace-nowrap shrink-0 min-h-[44px]"
      >
        <Download className="w-4 h-4 shrink-0" />
        <span className="hidden sm:inline">Instal Aplikasi</span>
        <span className="sm:hidden">Instal</span>
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setShowGuide(true)}
        className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 sm:px-3.5 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 active:scale-[0.98] transition-all whitespace-nowrap shrink-0 min-h-[44px]"
      >
        <Smartphone className="w-4 h-4 shrink-0" />
        <span className="hidden sm:inline">Instal di HP</span>
        <span className="sm:hidden">Instal</span>
      </button>

      {showGuide && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/60 p-0 sm:p-4">
          <div className="w-full max-w-md rounded-t-3xl sm:rounded-2xl bg-white p-5 sm:p-6 pb-safe border border-slate-200 shadow-xl max-h-[90dvh] overflow-y-auto">
            <div className="w-10 h-1.5 bg-slate-300 rounded-full mx-auto mb-3 sm:hidden" />
            <div className="flex items-center justify-between gap-4">
              <h3 className="text-base font-bold text-slate-900">
                Instal di Layar Utama
              </h3>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100"
                aria-label="Tutup"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {isIOS ? (
              <div className="mt-3 space-y-2 text-sm text-slate-700">
                <p>1. Ketuk tombol <strong>Bagikan (Share)</strong> di Safari.</p>
                <p>2. Pilih <strong>Tambahkan ke Layar Utama</strong>.</p>
              </div>
            ) : (
              <div className="mt-3 space-y-2 text-sm text-slate-700">
                {!isAndroid && (
                  <p>Buka halaman ini di Google Chrome Android:</p>
                )}
                <p>1. Ketuk ikon menu tiga titik di kanan atas Chrome.</p>
                <p>2. Pilih <strong>Instal aplikasi</strong> atau <strong>Tambahkan ke layar utama</strong>.</p>
              </div>
            )}

            <button
              type="button"
              onClick={() => setShowGuide(false)}
              className="mt-5 w-full min-h-[48px] rounded-xl bg-[#0F2942] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#163A5C] active:scale-[0.98] transition-all"
            >
              Tutup
            </button>
          </div>
        </div>
      )}
    </>
  );
};
