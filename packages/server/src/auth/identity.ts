import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLogger } from '../logger.ts';
import { randomToken, shortFingerprint } from './secrets.ts';

const log = createLogger('identity');

/**
 * Long-lived server identity (Ed25519), modelled on RustDesk's approach.
 *
 * Why it exists: the phone has no PKI to lean on — it is dialling a bare IP on
 * a LAN. That makes server impersonation (ARP spoofing on a café network,
 * a hijacked resolver, an attacker on the same WiFi) a real concern. So the
 * server publishes a key once, the phone records its fingerprint on first
 * pairing, and every later connection is challenged and verified.
 *
 * TOFU (trust on first use) is the honest description of this: it protects
 * subsequent connections, not the very first one. That is the same trade-off
 * SSH makes, and it is the correct one here.
 */
export interface IdentityPublic {
  algorithm: 'ed25519';
  publicKeyPem: string;
  fingerprint: string;
}

export class ServerIdentity {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  readonly fingerprint: string;

  private constructor(privateKey: KeyObject, publicKey: KeyObject, fingerprint: string) {
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.fingerprint = fingerprint;
  }

  static loadOrCreate(dataDir: string): ServerIdentity {
    const keyPath = join(dataDir, 'identity.key');

    if (existsSync(keyPath)) {
      try {
        const pem = readFileSync(keyPath, 'utf8');
        const privateKey = createPrivateKey(pem);
        const publicKey = createPublicKey(privateKey);
        const fingerprint = shortFingerprint(publicKey.export({ type: 'spki', format: 'pem' }).toString());
        log.info('identity loaded', { fingerprint });
        return new ServerIdentity(privateKey, publicKey, fingerprint);
      } catch (err) {
        throw new Error(
          `identity key at ${keyPath} is unreadable (${(err as Error).message}); ` +
            'delete it to regenerate (paired devices will need to re-verify the new fingerprint)',
        );
      }
    }

    mkdirSync(dirname(keyPath), { recursive: true });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    writeFileSync(keyPath, pem, { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(keyPath, 0o600);
    } catch {
      // Best effort: Windows ACLs are not POSIX modes.
    }

    const fingerprint = shortFingerprint(publicKey.export({ type: 'spki', format: 'pem' }).toString());
    log.info('identity generated', { fingerprint, path: keyPath });
    return new ServerIdentity(privateKey, publicKey, fingerprint);
  }

  /**
   * Fills in all members except `fingerprint`, which is derived in the
   * constructor. Kept as a static helper so call sites cannot forget it.
   */
  static fromKeys(privateKey: KeyObject, publicKey: KeyObject): ServerIdentity {
    const fingerprint = shortFingerprint(publicKey.export({ type: 'spki', format: 'pem' }).toString());
    return new ServerIdentity(privateKey, publicKey, fingerprint);
  }

  toPublic(): IdentityPublic {
    return {
      algorithm: 'ed25519',
      publicKeyPem: this.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      fingerprint: this.fingerprint,
    };
  }

  /** Issues a fresh challenge for a client to verify. */
  issueChallenge(): string {
    return randomToken(32);
  }

  sign(payload: string): string {
    // Ed25519 signs the message directly; no pre-hash is involved.
    return cryptoSign(null, Buffer.from(payload, 'utf8'), this.privateKey).toString('base64url');
  }

  verify(payload: string, signature: string): boolean {
    try {
      return cryptoVerify(
        null,
        Buffer.from(payload, 'utf8'),
        this.publicKey,
        Buffer.from(signature, 'base64url'),
      );
    } catch {
      return false;
    }
  }
}
