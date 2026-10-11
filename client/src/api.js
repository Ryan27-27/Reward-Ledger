// Access token lives in memory only (never localStorage → not stealable by XSS).
// The refresh token is an HttpOnly SameSite=Strict cookie the JS can't read.
let accessToken = null;
let refreshing = null;
const expiredListeners = new Set();

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code || 'ERROR';
    this.fields = body?.error?.details?.fields || null;
    this.details = body?.error?.details || null;
    this.requestId = body?.error?.requestId;
  }
}

export const newKey = () => crypto.randomUUID();
export const getToken = () => accessToken;
export const setToken = (t) => { accessToken = t; };
export const onSessionExpired = (fn) => { expiredListeners.add(fn); return () => expiredListeners.delete(fn); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Single-flight refresh: concurrent 401s share one request (avoids tripping rotation theft-detection). */
export function refreshSession() {
  if (!refreshing) {
    refreshing = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' }).catch(() => null);
        if (!res) return null;
        if (res.ok) { const data = await res.json(); accessToken = data.accessToken; return data; }
        const body = await res.json().catch(() => null);
        if (body?.error?.code === 'REFRESH_RACE') { await sleep(300 * (attempt + 1)); continue; } // another tab just rotated
        return null;
      }
      return null;
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function send(path, { method = 'GET', body, headers = {}, signal } = {}) {
  return fetch(`/api${path}`, {
    method, credentials: 'include', signal,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function api(path, opts = {}) {
  let res = await send(path, opts);
  if (res.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/auth/refresh')) {
    const s = await refreshSession();
    if (s) res = await send(path, opts);
    else { accessToken = null; expiredListeners.forEach((f) => f()); }
  }
  if (res.status === 204) return null;
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const post = (path, body, key) => api(path, { method: 'POST', body: body ?? {}, headers: key ? { 'Idempotency-Key': key } : {} });

export async function downloadCsv() {
  const res = await send('/wallet/statement.csv');
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: 'pointwise-statement.csv' });
  a.click();
  URL.revokeObjectURL(url);
}

/** Live notifications over Server-Sent Events, via fetch so we can send the Authorization header. */
export function openNotificationStream(onEvent) {
  let stop = false, controller;
  (async function loop(backoff = 1000) {
    while (!stop) {
      controller = new AbortController();
      try {
        let res = await send('/notifications/stream', { signal: controller.signal });
        if (res.status === 401) { await refreshSession(); res = await send('/notifications/stream', { signal: controller.signal }); }
        if (!res.ok || !res.body) throw new Error('stream failed');
        backoff = 1000;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const data = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (chunk.includes('event: notification') && data) { try { onEvent(JSON.parse(data.slice(6))); } catch { /* ignore */ } }
          }
        }
      } catch { /* fall through to reconnect */ }
      if (!stop) { await sleep(backoff); backoff = Math.min(backoff * 2, 30000); }
    }
  })();
  return () => { stop = true; controller?.abort(); };
}
