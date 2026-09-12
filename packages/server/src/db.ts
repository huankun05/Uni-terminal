import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from './logger.ts';

const log = createLogger('db');

/**
 * Storage layer.
 *
 * `node:sqlite` is built into Node 22, so persistence costs us zero native
 * compilation — important because the target audience installs this by hand on
 * Windows. Requires `--experimental-sqlite` (baked into the npm scripts).
 *
 * Schema notes:
 *  - `devices.token_hash`: we only ever store the SHA-256 of the L2 credential.
 *    A leaked database therefore does not hand out live sessions.
 *  - `pairings.device_code_hash`: same reasoning for the polling credential.
 *  - `events` keeps a per-session monotonic `seq` so a phone that dropped off
 *    the network can resume with `?from=<seq>` instead of replaying everything.
 */

export interface DeviceRow {
  id: string;
  name: string;
  ua: string | null;
  first_ip: string | null;
  public_key: string | null;
  fingerprint: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
}

export interface PairingRow {
  id: string;
  user_code: string;
  challenge: string;
  status: string;
  phone_public_key: string | null;
  phone_ua: string | null;
  phone_ip: string | null;
  poll_token_hash: string | null;
  fingerprint: string | null;
  attempts: number;
  approved_device_id: string | null;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

export interface SessionRow {
  id: string;
  agent: string;
  workspace: string | null;
  cwd: string | null;
  title: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  last_seq: number;
}

export interface EventRow {
  session_id: string;
  seq: number;
  type: string;
  payload: string;
  created_at: number;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') {
      mkdirSync(dirname(file), { recursive: true });
    }
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
    log.info('存储就绪', { file });
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        ua            TEXT,
        first_ip      TEXT,
        public_key    TEXT,
        fingerprint   TEXT NOT NULL,
        token_hash    TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL,
        revoked_at    INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_devices_token ON devices(token_hash);
      CREATE INDEX IF NOT EXISTS idx_devices_fp ON devices(fingerprint);

      CREATE TABLE IF NOT EXISTS pairings (
        id                 TEXT PRIMARY KEY,
        user_code          TEXT NOT NULL,
        challenge          TEXT NOT NULL,
        status             TEXT NOT NULL,
        phone_public_key   TEXT,
        phone_ua           TEXT,
        phone_ip           TEXT,
        poll_token_hash    TEXT,
        fingerprint        TEXT,
        attempts           INTEGER NOT NULL DEFAULT 0,
        approved_device_id TEXT,
        created_at         INTEGER NOT NULL,
        expires_at         INTEGER NOT NULL,
        consumed_at        INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_pairings_status ON pairings(status);

      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        agent      TEXT NOT NULL,
        workspace  TEXT,
        cwd        TEXT,
        title      TEXT,
        status     TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_seq   INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        type       TEXT NOT NULL,
        payload    TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  // ---- meta -------------------------------------------------------------

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  // ---- devices ----------------------------------------------------------

  insertDevice(row: DeviceRow): void {
    this.db
      .prepare(
        `INSERT INTO devices
           (id, name, ua, first_ip, public_key, fingerprint, token_hash,
            created_at, last_seen_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        row.id,
        row.name,
        row.ua,
        row.first_ip,
        row.public_key,
        row.fingerprint,
        row.token_hash,
        row.created_at,
        row.last_seen_at,
        row.expires_at,
      );
  }

  findDeviceByTokenHash(hash: string): DeviceRow | undefined {
    return this.db.prepare('SELECT * FROM devices WHERE token_hash = ?').get(hash) as
      | DeviceRow
      | undefined;
  }

  /** Live (non-revoked) device with this fingerprint, for re-pairing upserts. */
  findLiveDeviceByFingerprint(fingerprint: string): DeviceRow | undefined {
    return this.db
      .prepare('SELECT * FROM devices WHERE fingerprint = ? AND revoked_at IS NULL ORDER BY created_at DESC')
      .get(fingerprint) as DeviceRow | undefined;
  }

  /** Re-pairing: rotate the credential in place, keep the device identity. */
  updateDeviceCredential(
    id: string,
    fields: { tokenHash: string; ua: string; ip: string; publicKey: string | null; lastSeenAt: number; expiresAt: number },
  ): void {
    this.db
      .prepare(
        `UPDATE devices
           SET token_hash = ?, ua = ?, first_ip = ?, public_key = ?, last_seen_at = ?, expires_at = ?
         WHERE id = ?`,
      )
      .run(fields.tokenHash, fields.ua, fields.ip, fields.publicKey, fields.lastSeenAt, fields.expiresAt, id);
  }

  listDevices(): DeviceRow[] {
    return this.db
      .prepare('SELECT * FROM devices ORDER BY created_at DESC')
      .all() as unknown as DeviceRow[];
  }

  touchDevice(id: string, lastSeen: number, expiresAt: number): void {
    this.db
      .prepare('UPDATE devices SET last_seen_at = ?, expires_at = ? WHERE id = ?')
      .run(lastSeen, expiresAt, id);
  }

  renameDevice(id: string, name: string): void {
    this.db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(name, id);
  }

  revokeDevice(id: string, at: number): void {
    this.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(at, id);
  }

  // ---- pairings ---------------------------------------------------------

  insertPairing(row: PairingRow): void {
    this.db
      .prepare(
        `INSERT INTO pairings
           (id, user_code, challenge, status, phone_public_key, phone_ua, phone_ip,
            poll_token_hash, fingerprint, attempts, approved_device_id,
            created_at, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 0, NULL, ?, ?, NULL)`,
      )
      .run(row.id, row.user_code, row.challenge, row.status, row.created_at, row.expires_at);
  }

  getPairing(id: string): PairingRow | undefined {
    return this.db.prepare('SELECT * FROM pairings WHERE id = ?').get(id) as
      | PairingRow
      | undefined;
  }

  claimPairing(
    id: string,
    fields: { challenge: string; publicKey: string; ua: string; ip: string; fingerprint: string; pollTokenHash: string },
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE pairings
            SET status = 'claimed',
                phone_public_key = ?, phone_ua = ?, phone_ip = ?,
                poll_token_hash = ?, fingerprint = ?
          WHERE id = ? AND status = 'pending' AND challenge = ?`,
      )
      .run(
        fields.publicKey,
        fields.ua,
        fields.ip,
        fields.pollTokenHash,
        fields.fingerprint,
        id,
        fields.challenge,
      );
    return Number(result.changes) === 1;
  }

  approvePairing(id: string, deviceId: string): boolean {
    const result = this.db
      .prepare("UPDATE pairings SET status = 'approved', approved_device_id = ? WHERE id = ? AND status = 'claimed'")
      .run(deviceId, id);
    return Number(result.changes) === 1;
  }

  setPairingStatus(id: string, status: string): void {
    this.db.prepare('UPDATE pairings SET status = ? WHERE id = ?').run(status, id);
  }

  consumePairing(id: string): boolean {
    const result = this.db
      .prepare("UPDATE pairings SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'approved'")
      .run(Date.now(), id);
    return Number(result.changes) === 1;
  }

  rotateChallenge(id: string, challenge: string): boolean {
    const result = this.db
      .prepare("UPDATE pairings SET challenge = ? WHERE id = ? AND status = 'pending'")
      .run(challenge, id);
    return Number(result.changes) === 1;
  }

  bumpPairingAttempts(id: string): number {
    this.db.prepare('UPDATE pairings SET attempts = attempts + 1 WHERE id = ?').run(id);
    const row = this.db.prepare('SELECT attempts FROM pairings WHERE id = ?').get(id) as
      | { attempts: number }
      | undefined;
    return row?.attempts ?? 0;
  }

  listPairings(statuses: string[]): PairingRow[] {
    const placeholders = statuses.map(() => '?').join(',');
    return this.db
      .prepare(`SELECT * FROM pairings WHERE status IN (${placeholders}) ORDER BY created_at DESC`)
      .all(...statuses) as unknown as PairingRow[];
  }

  countPendingPairings(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM pairings WHERE status IN ('pending','claimed') AND expires_at > ?")
      .get(Date.now()) as { n: number };
    return Number(row.n);
  }

  countPendingPairingsByIp(ip: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM pairings WHERE status IN ('pending','claimed') AND phone_ip = ? AND expires_at > ?")
      .get(ip, Date.now()) as { n: number };
    return Number(row.n);
  }

  /** Marks lapsed pairings so the UI stops offering them. */
  expirePairings(now: number): number {
    const result = this.db
      .prepare("UPDATE pairings SET status = 'expired' WHERE status IN ('pending','claimed') AND expires_at <= ?")
      .run(now);
    return Number(result.changes);
  }

  // ---- sessions ---------------------------------------------------------

  insertSession(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, agent, workspace, cwd, title, status, created_at, updated_at, last_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(row.id, row.agent, row.workspace, row.cwd, row.title, row.status, row.created_at, row.updated_at);
  }

  listSessions(limit = 100): SessionRow[] {
    return this.db
      .prepare('SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?')
      .all(limit) as unknown as SessionRow[];
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined;
  }

  setSessionStatus(id: string, status: string, when: number): void {
    this.db.prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?').run(status, when, id);
  }

  setSessionTitle(id: string, title: string): void {
    this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id);
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM events WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  // ---- events -----------------------------------------------------------

  appendEvent(row: EventRow): void {
    this.db
      .prepare('INSERT INTO events (session_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.session_id, row.seq, row.type, row.payload, row.created_at);
    this.db
      .prepare('UPDATE sessions SET last_seq = ?, updated_at = ? WHERE id = ?')
      .run(row.seq, row.created_at, row.session_id);
  }

  eventsSince(sessionId: string, fromSeqExclusive: number, limit = 2000): EventRow[] {
    return this.db
      .prepare('SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(sessionId, fromSeqExclusive, limit) as unknown as EventRow[];
  }

  /**
   * Keeps a session's transcript bounded.
   *
   * A long agent run produces a great many small output events; without this
   * the database grows without limit for no benefit, since nobody scrolls back
   * more than a few thousand lines on a phone.
   */
  pruneEvents(sessionId: string, keepLast: number): number {
    const row = this.db
      .prepare('SELECT MAX(seq) AS maxSeq FROM events WHERE session_id = ?')
      .get(sessionId) as { maxSeq: number | null } | undefined;
    const maxSeq = row?.maxSeq ?? 0;
    const cutoff = maxSeq - keepLast;
    if (cutoff <= 0) return 0;
    const result = this.db
      .prepare('DELETE FROM events WHERE session_id = ? AND seq <= ?')
      .run(sessionId, cutoff);
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }
}
