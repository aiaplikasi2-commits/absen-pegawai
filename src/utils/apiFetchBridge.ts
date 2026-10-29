const CONFIGURED_API_BASE_URL = String(import.meta.env.VITE_API_BASE_URL || '')
  .trim()
  .replace(/\/+$/, '');

/**
 * Wrapper around standard `fetch` for `/api/*` requests without mutating `window.fetch`
 * (which is a getter-only property in certain iframe/runtime environments).
 *
 * Supports:
 * 1. Full-stack Node/Express (AI Studio / Cloud Run)
 * 2. Netlify Serverless Functions (`netlify.toml` -> `/.netlify/functions/api/*`)
 * 3. External API base URL via `VITE_API_BASE_URL` if frontend is hosted statically
 */
export async function apiFetch(
  input: string,
  init?: RequestInit
): Promise<Response> {
  const isApiCall = input === '/api' || input.startsWith('/api/');
  const resolvedUrl =
    isApiCall && CONFIGURED_API_BASE_URL
      ? `${CONFIGURED_API_BASE_URL}${input}`
      : input;

  const resp = await fetch(resolvedUrl, init);

  if (isApiCall && !resp.ok) {
    const contentType = (resp.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html')) {
      return new Response(
        JSON.stringify({
          error:
            'Backend API (/api) belum aktif di domain ini. Untuk Netlify, deploy melalui Git/GitHub agar Netlify Functions (netlify.toml) ikut terpasang, atau atur VITE_API_BASE_URL ke URL server.',
        }),
        {
          status: resp.status || 503,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  }

  return resp;
}
