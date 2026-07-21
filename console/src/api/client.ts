const TOKEN_KEY = "copal_token";

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; idempotent?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${getToken() ?? ""}`,
  };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.idempotent) headers["Idempotency-Key"] = crypto.randomUUID();
  const res = await fetch(`/api/v1${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new Event("copal:unauthorized"));
    throw new ApiError(401, "unauthorized");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** Upload a file as raw bytes (filename + MIME in headers); avoids multipart. */
export async function uploadAttachment(itemId: string, file: File) {
  const res = await fetch(`/api/v1/items/${itemId}/attachments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getToken() ?? ""}`,
      "content-type": "application/octet-stream",
      "x-filename": encodeURIComponent(file.name),
      "x-file-type": file.type || "application/octet-stream",
    },
    body: file,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? (res.status === 413 ? "File too large (10 MB max)" : `HTTP ${res.status}`));
  }
  return res.json();
}

/** Fetch a public share view: no bearer token, no 401 → unlock-screen dance
 *  (this runs for visitors who have no Copal auth at all). Null on 404 (unknown
 *  or revoked token) or any network failure — the caller renders the quiet
 *  "no longer active" state, uniformly, without knowing which. */
export async function fetchPublicShare<T>(token: string): Promise<T | null> {
  const res = await fetch(`/api/public/share/${encodeURIComponent(token)}`).catch(() => null);
  if (!res || !res.ok) return null;
  return res.json() as Promise<T>;
}

/** Fetch an attachment with auth and open it in a new tab (inline preview). */
export async function openAttachment(contentId: string) {
  const res = await fetch(`/api/v1/attachments/${contentId}/download`, {
    headers: { Authorization: `Bearer ${getToken() ?? ""}` },
  });
  if (!res.ok) throw new ApiError(res.status, "download failed");
  const url = URL.createObjectURL(await res.blob());
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
