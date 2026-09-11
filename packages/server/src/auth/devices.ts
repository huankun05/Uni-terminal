import type { DeviceRow, Store } from '../db.ts';
import type { UniConfig } from '../config.ts';
import { createLogger } from '../logger.ts';
import { randomId, randomToken, sha256 } from './secrets.ts';

const log = createLogger('devices');

export interface IssuedDevice {
  device: DeviceRow;
  /** Plaintext credential. This is the only moment it exists outside a hash. */
  token: string;
}

export class DeviceError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = 'DeviceError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * Layer 2 of the credential model: the long-lived, revocable, per-device
 * credential.
 *
 * Design contract (see docs): long life is granted to the *identity*
 * credential and never to the *session* credential. This is what makes a
 * 180-day cookie safe rather than a standing back door.
 *
 * Revocation is immediate and enforcement belongs to the caller: after
 * `revoke()`, the transport layer must close that device's live sockets.
 * Keeping a revoked device connected is the single easiest mistake to make
 * here, so it is asserted in the test suite.
 */
export class DeviceService {
  private readonly store: Store;
  private readonly config: UniConfig;

  constructor(store: Store, config: UniConfig) {
    this.store = store;
    this.config = config;
  }

  issue(params: {
    name: string;
    ua: string;
    ip: string;
    publicKey: string | null;
    fingerprint: string;
  }): IssuedDevice {
    const now = Date.now();
    const token = randomToken(32);
    const device: DeviceRow = {
      id: randomId(12),
      name: params.name || '未命名设备',
      ua: params.ua,
      first_ip: params.ip,
      public_key: params.publicKey,
      fingerprint: params.fingerprint,
      token_hash: sha256(token),
      created_at: now,
      last_seen_at: now,
      expires_at: now + this.config.security.deviceTtlMs,
      revoked_at: null,
    };
    this.store.insertDevice(device);
    log.info('device issued', { id: device.id, name: device.name });
    return { device, token };
  }

  /**
   * Resolves a presented credential to a live device.
   *
   * Refresh is sliding: every successful use pushes the expiry out, so a phone
   * that is used regularly never needs to re-pair, while an abandoned device
   * ages out on its own.
   */
  authenticate(token: string | undefined, now = Date.now()): DeviceRow | undefined {
    if (!token) return undefined;
    const row = this.store.findDeviceByTokenHash(sha256(token));
    if (!row) return undefined;
    if (row.revoked_at !== null) return undefined;
    if (row.expires_at <= now) return undefined;

    // Only extend when we are past the halfway mark, to avoid a write per request.
    const remaining = row.expires_at - now;
    if (remaining < this.config.security.deviceTtlMs / 2) {
      this.store.touchDevice(row.id, now, now + this.config.security.deviceTtlMs);
    } else {
      this.store.touchDevice(row.id, now, row.expires_at);
    }
    return row;
  }

  list(): DeviceRow[] {
    return this.store.listDevices();
  }

  rename(id: string, name: string): void {
    if (name.trim().length === 0) {
      throw new DeviceError('bad_name', '设备名不能为空');
    }
    if (name.length > 64) {
      throw new DeviceError('bad_name', '设备名过长');
    }
    this.store.renameDevice(id, name.trim());
  }

  revoke(id: string): void {
    const row = this.store.listDevices().find((d) => d.id === id);
    if (!row) {
      throw new DeviceError('not_found', '设备不存在', 404);
    }
    this.store.revokeDevice(id, Date.now());
    log.warn('device revoked', { id, name: row.name });
  }

  /** Removes devices whose credential lapsed; keeps the table tidy. */
  sweep(now = Date.now()): number {
    let removed = 0;
    for (const device of this.store.listDevices()) {
      if (device.revoked_at !== null || device.expires_at <= now) {
        this.store.revokeDevice(device.id, device.revoked_at ?? now);
        removed += 1;
      }
    }
    return removed;
  }
}
