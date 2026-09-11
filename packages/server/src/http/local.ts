import type { IncomingMessage } from 'node:http';

/**
 * "Is this request from the machine's own browser?"
 *
 * This decides whether the admin API (approve pairings, revoke devices, list
 * credentials) is reachable without a credential, so it is the most
 * security-sensitive predicate in the codebase and it fails closed.
 *
 * Loopback alone is NOT sufficient. Any tunnel or reverse proxy — cloudflared,
 * frp, nginx, a corporate gateway — terminates the connection locally and makes
 * a remote request appear to originate from 127.0.0.1. Three independent
 * conditions must therefore hold at once:
 *
 *   1. the socket peer is a loopback address;
 *   2. no forwarding header is present (its presence proves a proxy is in play);
 *   3. the Host header is a loopback name, not a public hostname.
 *
 * A request arriving through a tunnel fails all three simultaneously, which is
 * exactly the intent.
 */

export const PROXY_HEADERS = [
  'x-forwarded-for',
  'x-real-ip',
  'cf-connecting-ip',
  'forwarded',
  'x-forwarded-host',
] as const;

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.');
}

export function hostOnly(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.lastIndexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

function isLoopbackHostname(host: string): boolean {
  const bare = hostOnly(host).toLowerCase();
  return (
    bare === '127.0.0.1' ||
    bare === 'localhost' ||
    bare === '[::1]' ||
    bare === '::1' ||
    bare === 'localhost.'
  );
}

export function isLocalOrigin(opts: {
  remoteAddress: string | undefined;
  hostHeader: string | undefined;
  hasProxyHeaders: boolean;
}): boolean {
  if (!isLoopbackAddress(opts.remoteAddress)) return false;
  if (opts.hasProxyHeaders) return false;
  return isLoopbackHostname(opts.hostHeader ?? '');
}

/** Node-level variant, used before the request enters the Hono app. */
export function isLocalConnection(req: IncomingMessage): boolean {
  const raw = req.headers.host;
  const hostHeader = Array.isArray(raw) ? raw[0] : raw;
  return isLocalOrigin({
    remoteAddress: req.socket?.remoteAddress,
    hostHeader,
    hasProxyHeaders: PROXY_HEADERS.some((h) => req.headers[h] !== undefined),
  });
}

/** Best-effort peer address for logging and rate-limit keys. */
export function peerAddress(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (value) {
    const first = value.split(',')[0];
    if (first) return first.trim();
  }
  return req.socket?.remoteAddress ?? '0.0.0.0';
}
