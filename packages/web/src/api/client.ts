/**
 * Thin HTTP wrapper around `fetch`.
 *
 * The one behaviour worth centralising is 401: a device credential that has
 * expired or been revoked should send the user back into the pairing flow, not
 * leave every screen silently failing. Pairing endpoints themselves are
 * exempt — 401 there means "no poll token", which the Pair screen handles.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function isPairingPath(path: string): boolean {
  return path.startsWith('/api/pair/');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (res.status === 401 && !isPairingPath(path)) {
    // 重新配对引导：当前地址带回来了吗？还没有，先进配对页。
    if (!window.location.pathname.startsWith('/pair')) {
      window.location.assign('/pair');
    }
    throw new ApiError(401, 'unauthorized', '设备凭据无效，请重新配对');
  }

  if (!res.ok) {
    let code: string | undefined;
    let message = `请求失败（${res.status}）`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      code = body.error;
      if (body.message) message = body.message;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    throw new ApiError(res.status, code, message);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? '{}' : JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
