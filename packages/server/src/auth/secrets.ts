import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Credential primitives.
 *
 * Discipline #1 of this project: never invent cryptography. Everything here
 * delegates to `node:crypto`. If you ever find yourself writing a loop that
 * touches key material byte by byte, stop — you have almost certainly made a
 * mistake that a review will not catch.
 */

/** Opaque bearer credential: 256 bits of CSPRNG, URL-safe. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Public identifier — safe to put in a URL or a QR code. */
export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Constant-time comparison.
 *
 * Both sides are hashed first so the inputs are always the same length;
 * `timingSafeEqual` throws on length mismatch, and comparing raw lengths would
 * itself leak information.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/**
 * Human-transcribable code, per RFC 8628 §6.1: the 20-letter alphabet drops
 * every vowel (so codes cannot spell words) and the ambiguous glyphs
 * (0/O, 1/l/I).
 */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

export function generateUserCode(length = 8): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    // 20 does not divide 256 evenly, so use rejection sampling to stay uniform.
    let byte = bytes[i] as number;
    while (byte >= 240) {
      byte = randomBytes(1)[0] as number;
    }
    out += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length] as string;
  }
  return out;
}

/**
 * Device fingerprint: a stable per-device identifier for humans to compare.
 *
 * Same phone + same network → same fingerprint, so a re-pairing resolves to
 * the same device entry instead of an ever-growing list of identical ones.
 * The anti-QR-theft binding does NOT live here — it is the single-use
 * challenge, enforced at claim time regardless of this value.
 *
 * Deliberately coarse on IP (a /24 or /48 prefix) so DHCP changes and roams
 * don't churn the identity.
 */
export function deviceFingerprint(params: { ua: string; ip: string }): string {
  return sha256(`${params.ua}\u0000${ipPrefix(params.ip)}`);
}

/** Collapses an address to its /24 (v4) or /48 (v6) prefix. */
function ipPrefix(ip: string): string {
  if (ip.includes(':')) {
    return ip.split(':').slice(0, 3).join(':');
  }
  return ip.split('.').slice(0, 3).join('.');
}

/** Truncated hash for display: `a3f9-1c02-...`. */
export function shortFingerprint(value: string): string {
  const hex = sha256(value);
  return (hex.slice(0, 4) + '-' + hex.slice(4, 8) + '-' + hex.slice(8, 12)).toUpperCase();
}

export function nowMs(): number {
  return Date.now();
}
