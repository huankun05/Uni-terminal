import type { PairingRow, Store } from '../db.ts';
import type { UniConfig } from '../config.ts';
import { createLogger } from '../logger.ts';
import { SlidingWindow } from './rateLimit.ts';
import {
  deviceFingerprint,
  generateUserCode,
  randomId,
  randomToken,
  safeEqual,
  sha256,
} from './secrets.ts';

const log = createLogger('pairing');

export type PairingStatus = 'pending' | 'claimed' | 'approved' | 'denied' | 'consumed' | 'expired';

export interface PairingCreated {
  id: string;
  userCode: string;
  challenge: string;
  expiresAt: number;
  rotateEveryMs: number;
}

/** What the desktop (trusted, localhost) sees for a pending request. */
export interface PairingRequestView {
  id: string;
  userCode: string;
  status: PairingStatus;
  createdAt: number;
  expiresAt: number;
  /** Present once the phone has claimed the pairing. */
  requester?: {
    userAgent: string;
    ip: string;
    fingerprint: string;
    publicKey: string;
  };
}

/** What the phone sees. Never includes anything that could be replayed. */
export interface PairingPhoneView {
  status: PairingStatus;
  expiresAt: number;
  rotateEveryMs: number;
}

export interface PollResult {
  status: PairingStatus;
  /** Set only in the single response that carries the credential. */
  deviceToken?: string;
  deviceId?: string;
  slowDown?: { retryAfterMs: number };
}

export class PairingError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = 'PairingError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

interface PollState {
  intervalMs: number;
  lastPollAt: number;
}

/**
 * Pairing state machine.
 *
 * Two credentials, deliberately separate (this is the part most home-grown
 * implementations get wrong by merging them):
 *   - `id`        public, rides in the QR code. Knowing it grants nothing.
 *   - `pollToken` secret, handed to the phone after it claims the pairing.
 *                 Only its SHA-256 is stored.
 *
 * The QR payload also carries a `challenge` that rotates every 30s. A
 * screenshot of the code is therefore useless a few seconds later, which is
 * what stops "photograph the QR, claim it first, let the user approve *your*
 * key" attacks. The desktop additionally shows the requester's UA/IP so the
 * human can reject anything unfamiliar.
 *
 * Note there is no `device_code` field here in the RFC 8628 sense: in that
 * flow the *human* transcribes a code, whereas our human scans. We keep the
 * parts that carry security weight (rotating challenge, rate limits, single
 * consumption) and drop the parts that do not.
 */
export class PairingService {
  private readonly store: Store;
  private readonly config: UniConfig;
  private readonly createGlobal: SlidingWindow;
  private readonly createPerIp: SlidingWindow;
  private readonly claimPerIp: SlidingWindow;
  private readonly pollState = new Map<string, PollState>();
  private readonly pendingTokens = new Map<string, { token: string; at: number }>();

  constructor(store: Store, config: UniConfig) {
    this.store = store;
    this.config = config;
    this.createGlobal = new SlidingWindow(config.security.maxPendingPairingsGlobal, 60_000);
    this.createPerIp = new SlidingWindow(config.security.maxPendingPairingsPerIp, 60_000);
    this.claimPerIp = new SlidingWindow(10, 60_000);
  }

  create(ip: string): PairingCreated {
    const now = Date.now();
    this.store.expirePairings(now);

    const globalVerdict = this.createGlobal.consume('__global__', now);
    if (!globalVerdict.allowed) {
      throw new PairingError('rate_limited', '配对请求过于频繁，请稍后再试', 429);
    }
    const ipVerdict = this.createPerIp.consume(ip, now);
    if (!ipVerdict.allowed) {
      throw new PairingError('rate_limited', '同一网络发起的配对过多，请稍后再试', 429);
    }

    const id = randomId(16);
    const challenge = randomToken(24);
    const expiresAt = now + this.config.security.pairingTtlMs;

    this.store.insertPairing({
      id,
      user_code: generateUserCode(8),
      challenge,
      status: 'pending',
      phone_public_key: null,
      phone_ua: null,
      phone_ip: null,
      poll_token_hash: null,
      fingerprint: null,
      attempts: 0,
      approved_device_id: null,
      created_at: now,
      expires_at: expiresAt,
      consumed_at: null,
    });

    log.info('配对已创建，等待手机扫码', { ip, expiresInMs: this.config.security.pairingTtlMs });

    return {
      id,
      userCode: this.store.getPairing(id)?.user_code ?? '',
      challenge,
      expiresAt,
      rotateEveryMs: this.config.security.pairingRotateMs,
    };
  }

  /** Desktop-side: issue a fresh challenge so a screenshot goes stale. */
  rotate(id: string): string {
    const challenge = randomToken(24);
    const ok = this.store.rotateChallenge(id, challenge);
    if (!ok) {
      throw new PairingError('not_rotatable', '该配对已不在等待状态', 409);
    }
    return challenge;
  }

  /** Desktop-side: everything needed to render the approval prompt. */
  view(id: string): PairingRequestView {
    const row = this.requirePairing(id);
    const view: PairingRequestView = {
      id: row.id,
      userCode: row.user_code,
      status: row.status as PairingStatus,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
    if (row.phone_ua && row.phone_ip && row.fingerprint && row.phone_public_key) {
      view.requester = {
        userAgent: row.phone_ua,
        ip: row.phone_ip,
        fingerprint: row.fingerprint,
        publicKey: row.phone_public_key,
      };
    }
    return view;
  }

  listOutstanding(): PairingRequestView[] {
    this.store.expirePairings(Date.now());
    return this.store
      .listPairings(['pending', 'claimed'])
      .map((row) => this.view(row.id));
  }

  /**
   * Phone-side step 1. Binds the request to this specific client and returns
   * the polling credential.
   *
   * `publicKey` is the phone's X25519 public key. We store it now, at pairing
   * time, purely so that adding end-to-end payload encryption later does not
   * require every already-paired device to pair again. The phone's private half
   * never leaves the device.
   */
  claim(
    id: string,
    params: { challenge: string; publicKey: string; ua: string; ip: string; clientNonce: string },
  ): { pollToken: string; pollIntervalMs: number } {
    const now = Date.now();
    const ipVerdict = this.claimPerIp.consume(params.ip, now);
    if (!ipVerdict.allowed) {
      throw new PairingError('rate_limited', '尝试过于频繁，请稍后再试', 429);
    }

    const row = this.requirePairing(id);
    if (row.status !== 'pending') {
      throw new PairingError('not_pending', '该配对码已被使用或已失效', 409);
    }
    if (row.expires_at <= now) {
      this.store.setPairingStatus(id, 'expired');
      throw new PairingError('expired', '配对码已过期，请在电脑上重新生成', 410);
    }

    // The rotating challenge is the anti-screenshot defence.
    if (!safeEqual(row.challenge, params.challenge)) {
      const attempts = this.store.bumpPairingAttempts(id);
      if (attempts >= this.config.security.maxPairingAttempts) {
        // Invalidate rather than merely reject: a persistent attacker then
        // forces the legitimate user to regenerate, which costs the attacker
        // far more than it costs us.
        this.store.setPairingStatus(id, 'expired');
        log.warn('连续错误挑战，配对码已作废', { attempts });
        throw new PairingError('invalidated', '校验连续失败，本次配对已作废', 410);
      }
      throw new PairingError('bad_challenge', '二维码已刷新，请重新扫描', 409);
    }

    const pollToken = randomToken(32);
    const fingerprint = deviceFingerprint({
      ua: params.ua,
      ip: params.ip,
      clientNonce: params.clientNonce,
    });

    const ok = this.store.claimPairing(id, {
      challenge: params.challenge,
      publicKey: params.publicKey,
      ua: params.ua,
      ip: params.ip,
      fingerprint,
      pollTokenHash: sha256(pollToken),
    });

    if (!ok) {
      throw new PairingError('claim_race', '该配对码刚被使用，请重新扫描', 409);
    }

    this.pollState.set(id, { intervalMs: 5_000, lastPollAt: 0 });
    log.info('手机已认领配对', { ip: params.ip, fingerprint });
    return { pollToken, pollIntervalMs: 5_000 };
  }

  /**
   * Desktop-side approval, part 1 of 2.
   *
   * Approval is the actual authorisation event, and it must always be an
   * explicit human action on a device the user already trusts. It is split in
   * two so the caller can mint the device row in between; the pairing only
   * becomes `approved` once a credential actually exists for it.
   */
  requireClaimed(id: string): PairingRow {
    const row = this.requirePairing(id);
    if (row.status !== 'claimed') {
      throw new PairingError('not_claimed', '还没有设备请求接入', 409);
    }
    if (row.expires_at <= Date.now()) {
      this.store.setPairingStatus(id, 'expired');
      throw new PairingError('expired', '配对请求已过期', 410);
    }
    return row;
  }

  /** Desktop-side approval, part 2 of 2. */
  markApproved(id: string, deviceId: string): void {
    const ok = this.store.approvePairing(id, deviceId);
    if (!ok) {
      throw new PairingError('not_claimed', '配对状态已变化，请刷新后重试', 409);
    }
    log.info('配对已批准', { id, deviceId });
  }

  /**
   * Holds the plaintext credential between approval and collection.
   *
   * The window is seconds in practice: the phone is polling every 5s while the
   * user taps "allow". Holding it in memory rather than the database means a
   * stolen database file never contains a usable credential, at the cost of
   * "if the server restarts in that exact window, re-scan" — a trade worth
   * making, and a debuggable failure rather than a silent one.
   */
  stashToken(id: string, token: string): void {
    this.pendingTokens.set(id, { token, at: Date.now() });
  }

  /** Single-use: the second caller gets nothing. */
  takeToken(id: string): string | undefined {
    const held = this.pendingTokens.get(id);
    if (!held) return undefined;
    this.pendingTokens.delete(id);
    return held.token;
  }

  deny(id: string): void {
    const row = this.requirePairing(id);
    if (row.status === 'consumed') {
      throw new PairingError('already_consumed', '该配对已完成', 409);
    }
    this.store.setPairingStatus(id, 'denied');
    this.pollState.delete(id);
    log.warn('配对已拒绝', { id });
  }

  /**
   * Phone-side polling.
   *
   * Cadence is enforced per RFC 8628 §3.5: polling faster than the advertised
   * interval earns a `slow_down`, and the interval is then extended for that
   * session, so a misbehaving client cannot simply ignore the hint.
   */
  poll(id: string, pollToken: string): PollResult {
    const now = Date.now();
    const row = this.requirePairing(id);

    if (!row.poll_token_hash || !safeEqual(row.poll_token_hash, sha256(pollToken))) {
      throw new PairingError('unauthorized', '轮询凭据无效', 401);
    }

    const state = this.pollState.get(id) ?? { intervalMs: 5_000, lastPollAt: 0 };
    const elapsed = now - state.lastPollAt;
    if (state.lastPollAt !== 0 && elapsed < state.intervalMs) {
      state.intervalMs += 5_000;
      this.pollState.set(id, state);
      // Carry the full status even while throttling. A partial reply is what
      // makes a client retry forever instead of backing off, and it hides the
      // approval the user just granted.
      return {
        status: row.status as PairingStatus,
        deviceId: row.approved_device_id ?? undefined,
        slowDown: { retryAfterMs: state.intervalMs },
      };
    }
    state.lastPollAt = now;
    this.pollState.set(id, state);

    if (row.status === 'expired' || row.expires_at <= now) {
      if (row.status !== 'expired') this.store.setPairingStatus(id, 'expired');
      return { status: 'expired' };
    }

    if (row.status !== 'approved') {
      return { status: row.status as PairingStatus };
    }

    return { status: 'approved', deviceId: row.approved_device_id ?? undefined };
  }

  /**
   * Marks the credential as handed over. Called after the device row and
   * cookie are minted so the pairing cannot be replayed for a second token.
   */
  complete(id: string): boolean {
    const ok = this.store.consumePairing(id);
    if (ok) this.pollState.delete(id);
    return ok;
  }

  sweep(): void {
    const expired = this.store.expirePairings(Date.now());
    if (expired > 0) log.debug('清理过期配对', { count: expired });
    this.createGlobal.prune();
    this.createPerIp.prune();
    this.claimPerIp.prune();
  }

  private requirePairing(id: string): PairingRow {
    const row = this.store.getPairing(id);
    if (!row) {
      throw new PairingError('not_found', '配对码不存在，请重新扫描', 404);
    }
    return row;
  }
}
