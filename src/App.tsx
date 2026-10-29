import React, { useEffect, useState, useCallback } from 'react';
import {
  Lock,
  User,
  LogOut,
  AlertCircle,
  ClipboardList,
  Users,
  FileText,
  FileSpreadsheet,
  Settings,
} from 'lucide-react';
import type { AuthSessionUser, OfficeSettings } from './types/attendance';
import {
  connectGoogleForGmail,
  clearGoogleSession,
  validateFirestoreConnection,
} from './lib/firebase';
import {
  cacheFaceProfileLocally,
  cacheOfficeSettingsLocally,
} from './services/offlineStore';
import { PWAInstallButton } from './components/PWAInstallButton';
import { EmployeeDashboard } from './components/EmployeeDashboard';
import { AdminDashboard, AdminSection } from './components/AdminDashboard';
import { apiFetch } from './utils/apiFetchBridge';

const SESSION_TOKEN_KEY = 'absensi_session_jwt';
const SESSION_USER_CACHE_KEY = 'absensi_session_user_cache';

export default function App() {
  const [token, setToken] = useState<string | null>(() =>
    localStorage.getItem(SESSION_TOKEN_KEY)
  );
  const [user, setUser] = useState<AuthSessionUser | null>(() => {
    try {
      const raw = localStorage.getItem(SESSION_USER_CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });
  const [officeSettings, setOfficeSettings] = useState<OfficeSettings | null>(
    null
  );
  const [adminSection, setAdminSection] = useState<AdminSection>('OVERVIEW');

  const [usernameInput, setUsernameInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const onUp = () => setIsOnline(true);
    const onDown = () => setIsOnline(false);
    window.addEventListener('online', onUp);
    window.addEventListener('offline', onDown);
    return () => {
      window.removeEventListener('online', onUp);
      window.removeEventListener('offline', onDown);
    };
  }, []);

  useEffect(() => {
    validateFirestoreConnection();
  }, []);

  const hydrateSessionFromServer = useCallback(async (activeToken: string) => {
    if (!navigator.onLine) return;
    try {
      const resp = await apiFetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${activeToken}` },
      });
      if (!resp.ok) {
        if (resp.status === 401 || resp.status === 403) {
          localStorage.removeItem(SESSION_TOKEN_KEY);
          localStorage.removeItem(SESSION_USER_CACHE_KEY);
          setToken(null);
          setUser(null);
        }
        return;
      }
      const data = await resp.json();
      setUser(data.user);
      localStorage.setItem(SESSION_USER_CACHE_KEY, JSON.stringify(data.user));

      if (data.officeSettings) {
        setOfficeSettings(data.officeSettings);
        await cacheOfficeSettingsLocally(data.officeSettings);
      }
      if (
        data.ownFaceProfile?.descriptorVector?.length === 128 &&
        data.user?.employeeId
      ) {
        await cacheFaceProfileLocally(
          data.user.employeeId,
          data.ownFaceProfile.descriptorVector,
          data.ownFaceProfile.threshold || 0.84
        );
      }
    } catch {
      // Retain cached offline session user if network temporarily unreachable
    }
  }, []);

  useEffect(() => {
    if (token) {
      hydrateSessionFromServer(token);
    }
  }, [token, isOnline, hydrateSessionFromServer]);

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginLoading(true);
    setLoginError(null);
    try {
      const resp = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: usernameInput.trim(),
          password: passwordInput,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setLoginError(data.error || 'Login gagal.');
        return;
      }

      localStorage.setItem(SESSION_TOKEN_KEY, data.token);
      localStorage.setItem(SESSION_USER_CACHE_KEY, JSON.stringify(data.user));
      setToken(data.token);
      setUser(data.user);
      setPasswordInput('');
      await hydrateSessionFromServer(data.token);
    } catch {
      setLoginError('Gagal menghubungi server.');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleGoogleAdminSignIn = async () => {
    setLoginLoading(true);
    setLoginError(null);
    try {
      const googleRes = await connectGoogleForGmail();
      const resp = await apiFetch('/api/auth/google-admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: googleRes.idToken }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setLoginError(data.error || 'Akun Google bukan Admin.');
        return;
      }
      localStorage.setItem(SESSION_TOKEN_KEY, data.token);
      localStorage.setItem(SESSION_USER_CACHE_KEY, JSON.stringify(data.user));
      setToken(data.token);
      setUser(data.user);
      await hydrateSessionFromServer(data.token);
    } catch (err: any) {
      setLoginError(err?.message || 'Login Google gagal.');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = async () => {
    localStorage.removeItem(SESSION_TOKEN_KEY);
    localStorage.removeItem(SESSION_USER_CACHE_KEY);
    setToken(null);
    setUser(null);
    try {
      await clearGoogleSession();
    } catch {
      // ignore
    }
  };

  if (!token || !user) {
    return (
      <div className="min-h-[100dvh] flex flex-col bg-slate-50 pt-safe">
        <header className="flex items-center justify-between gap-2 md:gap-8 px-4 sm:px-6 py-3 bg-white border-b border-slate-200">
          <a
            href="/"
            className="text-sm sm:text-lg font-bold tracking-tight text-[#0F2942] truncate min-w-0"
          >
            ABSENSI WAJAH &amp; GPS
          </a>
          <div className="hidden md:block" />
          <div className="flex items-center gap-2 shrink-0">
            <PWAInstallButton />
          </div>
        </header>

        <main className="flex-1 flex items-center justify-center p-4 sm:p-6 pb-safe">
          <div className="w-full max-w-md rounded-2xl bg-white border border-slate-200 p-5 sm:p-8 space-y-5">
            <h1 className="text-lg sm:text-xl font-bold text-slate-900">
              Masuk
            </h1>

            {loginError && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3.5 flex items-start gap-2.5 text-xs sm:text-sm text-red-800">
                <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                <span className="break-words min-w-0">{loginError}</span>
              </div>
            )}

            <form onSubmit={handleLoginSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Username
                </label>
                <div className="relative">
                  <User className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    required
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    value={usernameInput}
                    onChange={(e) => setUsernameInput(e.target.value)}
                    placeholder="Username"
                    className="w-full min-h-[48px] rounded-xl border border-slate-300 pl-10 pr-4 py-3 text-base sm:text-sm focus:outline-none focus:border-[#0F2942]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Password
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="password"
                    required
                    autoComplete="current-password"
                    value={passwordInput}
                    onChange={(e) => setPasswordInput(e.target.value)}
                    placeholder="Password"
                    className="w-full min-h-[48px] rounded-xl border border-slate-300 pl-10 pr-4 py-3 text-base sm:text-sm focus:outline-none focus:border-[#0F2942]"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loginLoading}
                className="w-full min-h-[50px] rounded-xl bg-[#0F2942] px-5 py-3 text-sm font-bold text-white hover:bg-[#163A5C] active:scale-[0.98] disabled:opacity-50 transition-all"
              >
                {loginLoading ? 'Memproses...' : 'Masuk'}
              </button>
            </form>

            <div className="relative py-0.5">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-slate-200" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-white px-3 text-slate-400">Admin</span>
              </div>
            </div>

            <button
              type="button"
              disabled={loginLoading}
              onClick={handleGoogleAdminSignIn}
              className="w-full min-h-[48px] rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs sm:text-sm font-semibold text-slate-800 hover:bg-slate-50 active:scale-[0.98] flex items-center justify-center gap-2.5 transition-all"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 48 48"
                className="w-5 h-5 shrink-0"
              >
                <path
                  fill="#EA4335"
                  d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                />
                <path
                  fill="#4285F4"
                  d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                />
                <path
                  fill="#FBBC05"
                  d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                />
                <path
                  fill="#34A853"
                  d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                />
              </svg>
              <span className="truncate">Masuk dengan Google</span>
            </button>
          </div>
        </main>
      </div>
    );
  }

  const adminNavItems: {
    id: AdminSection;
    label: string;
    icon: React.FC<{ className?: string }>;
  }[] = [
    { id: 'OVERVIEW', label: 'Absensi', icon: ClipboardList },
    { id: 'APPEALS', label: 'Sanggah', icon: FileText },
    { id: 'EMPLOYEES', label: 'Karyawan', icon: Users },
    { id: 'MONTHLY_REPORT', label: 'Rekap', icon: FileSpreadsheet },
    { id: 'SETTINGS_AUDIT', label: 'Kantor', icon: Settings },
  ];

  return (
    <div className="min-h-[100dvh] flex flex-col bg-slate-50 pt-safe">
      <header className="md:sticky md:top-0 z-30 flex items-center justify-between gap-2 md:gap-8 px-3.5 sm:px-6 py-2.5 sm:py-3.5 bg-white border-b border-slate-200">
        <a
          href="/"
          className="text-sm sm:text-lg font-bold tracking-tight text-[#0F2942] truncate min-w-0"
        >
          ABSENSI WAJAH &amp; GPS
        </a>

        {user.role === 'ADMIN' ? (
          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
            {adminNavItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setAdminSection(item.id)}
                className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 ${
                  adminSection === item.id
                    ? 'text-[#0F2942] font-bold underline underline-offset-8'
                    : ''
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>
        ) : (
          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
            <span className="text-[#0F2942] font-semibold whitespace-nowrap shrink-0">
              {user.fullName}
            </span>
          </nav>
        )}

        <div className="flex items-center gap-2 shrink-0">
          <PWAInstallButton />
          <button
            type="button"
            onClick={handleLogout}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 sm:px-3.5 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 active:scale-[0.98] transition-all whitespace-nowrap shrink-0 min-h-[44px]"
          >
            <LogOut className="w-4 h-4 shrink-0" />
            <span>Keluar</span>
          </button>
        </div>
      </header>

      <main
        className={`flex-1 w-full ${
          user.role === 'ADMIN' ? 'pb-20 md:pb-6' : 'pb-safe'
        }`}
      >
        {user.role === 'ADMIN' ? (
          <AdminDashboard
            user={user}
            token={token}
            activeSection={adminSection}
            onChangeSection={setAdminSection}
            onSettingsUpdated={(s) => setOfficeSettings(s)}
          />
        ) : (
          <EmployeeDashboard
            user={user}
            token={token}
            officeSettings={officeSettings}
            isOnline={isOnline}
            onConsentAccepted={() => {
              const updated = { ...user, consentAccepted: true };
              setUser(updated);
              localStorage.setItem(
                SESSION_USER_CACHE_KEY,
                JSON.stringify(updated)
              );
            }}
            onFaceRegistered={() => {
              const updated = { ...user, hasFaceProfile: true };
              setUser(updated);
              localStorage.setItem(
                SESSION_USER_CACHE_KEY,
                JSON.stringify(updated)
              );
            }}
          />
        )}
      </main>

      {user.role === 'ADMIN' && (
        <nav
          aria-label="Navigasi Admin"
          className="fixed bottom-0 inset-x-0 z-40 md:hidden bg-white/95 backdrop-blur-md border-t border-slate-200 pb-[env(safe-area-inset-bottom)]"
        >
          <div className="grid grid-cols-5 items-center h-14 px-1">
            {adminNavItems.map((item) => {
              const Icon = item.icon;
              const active = adminSection === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setAdminSection(item.id)}
                  className={`flex flex-col items-center justify-center min-h-[48px] rounded-lg transition-colors ${
                    active
                      ? 'text-[#0F2942] font-bold'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="text-[10px] leading-tight mt-1 truncate max-w-full px-0.5">
                    {item.label}
                  </span>
                </button>
              );
            })}
          </div>
        </nav>
      )}
    </div>
  );
}
