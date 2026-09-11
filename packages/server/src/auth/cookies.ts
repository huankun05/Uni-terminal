/**
 * Cookie helpers.
 *
 * Why cookies at all, rather than a token in localStorage?
 *
 * iOS WebKit's ITP caps *script-writable* storage (document.cookie,
 * localStorage, IndexedDB, Service Worker registration) at 7 days without
 * interaction. A server-set `Set-Cookie` is not script-writable and is not
 * subject to that cap. Put the long-lived credential in localStorage and the
 * symptom is "iOS makes me log in every week" — a bug that is easy to
 * misdiagnose as a logic error.
 *
 * The `Secure` attribute is applied only when the request actually arrived over
 * TLS. Browsers reject `Secure` cookies on plain http (other than localhost),
 * and a LAN deployment over http is the default during bring-up. When that
 * happens the server logs a prominent warning: it is a deliberate, visible
 * compromise for same-network use, not an oversight.
 */

export interface CookieOptions {
  maxAgeSec: number;
  secure: boolean;
  path?: string;
}

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key.length > 0) out[key] = decodeURIComponent(value);
  }
  return out;
}

export function buildDeviceCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path ?? '/'}`,
    'HttpOnly',
    // Lax rather than Strict: it still blocks cross-site POST, but unlike
    // Strict it survives the user arriving from an external link (a chat
    // message, a bookmark), which would otherwise look like "not logged in".
    'SameSite=Lax',
    `Max-Age=${Math.floor(options.maxAgeSec)}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearDeviceCookie(name: string, secure: boolean, path = '/'): string {
  const parts = [`${name}=`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Requests that carry a browser navigation are cross-site-cookie candidates;
 * we only trust a token from the cookie header, never from a query string,
 * because query strings leak into logs, history and Referer headers.
 */
export function readDeviceToken(
  cookieHeader: string | null | undefined,
  cookieName: string,
): string | undefined {
  return parseCookies(cookieHeader)[cookieName];
}
