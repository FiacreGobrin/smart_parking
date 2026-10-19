import axios from 'axios';

const baseURL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api/v1';

export const http = axios.create({ baseURL, withCredentials: true, timeout: 20000 });

// The access token lives in memory only. A page reload restores the session from the httpOnly refresh cookie.
let accessToken = null;
let onAuthLost = () => {};
export const setAccessToken = (t) => { accessToken = t; };
export const getAccessToken = () => accessToken;
export const setAuthLostHandler = (fn) => { onAuthLost = fn; };

http.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  return config;
});

let refreshing = null;
export function refreshSession() {
  // One refresh at a time: refresh tokens rotate, so parallel calls would invalidate each other.
  refreshing ||= axios
    .post(`${baseURL}/auth/refresh`, null, { withCredentials: true })
    .then((res) => {
      accessToken = res.data.data.accessToken;
      return res.data.data;
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

http.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;
    const isAuthCall = original?.url?.startsWith('/auth/');
    if (error.response?.status === 401 && original && !original._retried && !isAuthCall) {
      original._retried = true;
      try {
        await refreshSession();
        return http(original);
      } catch {
        accessToken = null;
        onAuthLost();
      }
    }
    return Promise.reject(error);
  },
);

/** Normalizes any failure into { message, code, status, fields } for toasts and forms. */
export function parseError(err) {
  const body = err?.response?.data?.error;
  const fields = {};
  for (const d of body?.details || []) if (d.field) fields[d.field] = d.message;
  return {
    message: body?.message || (err?.code === 'ERR_NETWORK' ? 'Cannot reach the server. Check your connection.' : err?.message || 'Something went wrong'),
    code: body?.code,
    status: err?.response?.status,
    details: body?.details,
    fields,
    requestId: body?.requestId,
  };
}

// Convenience wrappers returning { data, meta }.
const unwrap = (res) => ({ data: res.data.data, meta: res.data.meta });
export const get = (url, params) => http.get(url, { params }).then(unwrap);
export const post = (url, body, config) => http.post(url, body, config).then(unwrap);
export const patch = (url, body) => http.patch(url, body).then(unwrap);
export const put = (url, body) => http.put(url, body).then(unwrap);
export const del = (url) => http.delete(url).then(unwrap);

/** Downloads a CSV (or any file) through the authenticated client. */
export async function download(url, params, filename) {
  const res = await http.get(url, { params, responseType: 'blob' });
  const href = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

/** Fetches an authenticated image and returns an object URL for <img src>. */
export async function fetchImageUrl(name) {
  const res = await http.get(`/files/${encodeURIComponent(name)}`, { responseType: 'blob' });
  return URL.createObjectURL(res.data);
}
