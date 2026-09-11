import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { extname, join, normalize } from 'node:path';
import QRCode from 'qrcode';

import { AGENT_CATALOG } from '../agents/catalog.ts';
import { detectAgent, type AgentAvailability } from '../agents/detect.ts';
import { ptyDiagnostics } from '../agents/driver.ts';
import { buildDeviceCookie, clearDeviceCookie, readDeviceToken } from '../auth/cookies.ts';
import { DeviceError, DeviceService } from '../auth/devices.ts';
import type { ServerIdentity } from '../auth/identity.ts';
import { PairingError, PairingService, type PairingStatus } from '../auth/pairing.ts';
import { clientIp } from '../auth/rateLimit.ts';
import type { UniConfig } from '../config.ts';
import type { DeviceRow, Store } from '../db.ts';
import { createLogger } from '../logger.ts';
import { SessionError, SessionHub } from '../session/hub.ts';
import type { TransportRegistry } from '../transport/lan.ts';
import { PROXY_HEADERS, hostOnly, isLocalOrigin } from './local.ts';

const log = createLogger('http');

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_TITLE_LENGTH = 200;

export interface AppDeps {
  config: UniConfig;
  store: Store;
  identity: ServerIdentity;
  pairing: PairingService;
  devices: DeviceService;
  hub: SessionHub;
  transport: TransportRegistry;
  webDistDir: string;
  startedAt: number;
  /**
   * Wired by the entry point to the WebSocket layer. Revoking a credential is
   * only half the job — live sockets authenticated with it must drop too, or
   * the revoked device keeps working until it happens to reconnect.
   */
  onDeviceRevoked?: (deviceId: string) => number;
}

type Env = {
  Variables: {
    device: DeviceRow;
  };
};

export function createApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();
  const { config, store, identity, pairing, devices, hub, transport } = deps;

  // ---------------------------------------------------------------- helpers

  const isTls = (c: Context): boolean => {
    const proto = c.req.header('x-forwarded-proto');
    if (proto) return proto.split(',')[0]?.trim() === 'https';
    const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
    return Boolean((incoming?.socket as { encrypted?: boolean } | undefined)?.encrypted);
  };

  const remoteAddress = (c: Context): string => {
    const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
    return incoming?.socket?.remoteAddress ?? '0.0.0.0';
  };

  /**
   * Is this request coming from the machine's own browser?
   *
   * This gate is what keeps `/api/local/*` (which manages devices and can
   * approve pairings) reachable without a credential, so it has to be strict.
   * Loopback alone is not enough: any tunnel or reverse proxy makes a remote
   * request look local. So we require loopback *and* the absence of forwarding
   * headers *and* a loopback Host header. A request arriving through
   * cloudflared fails all three at once, which is the intent.
   */
  const isLocalRequest = (c: Context): boolean => {
    const addr = remoteAddress(c);
    const isLoopback =
      addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.');
    if (!isLoopback) return false;

    const proxyHeaders = ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'forwarded', 'x-forwarded-host'];
    if (proxyHeaders.some((h) => c.req.header(h))) return false;

    const host = hostOnly(c.req.header('host') ?? '');
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  };

  const localOnly: MiddlewareHandler<Env> = async (c, next) => {
    if (!isLocalRequest(c)) {
      log.warn('rejected non-local admin request', { path: c.req.path, ip: remoteAddress(c) });
      return c.json({ error: 'forbidden', message: '本机管理接口仅允许从本机访问' }, 403);
    }
    await next();
  };

  /** Layer 3 gate: the caller must present a live L2 device credential. */
  const requireDevice: MiddlewareHandler<Env> = async (c, next) => {
    const token = readDeviceToken(c.req.header('cookie'), config.security.cookieName);
    const device = devices.authenticate(token);
    if (!device) {
      return c.json({ error: 'unauthorized', message: '设备凭据无效或已失效，请重新配对' }, 401);
    }
    c.set('device', device);
    await next();
  };

  const devicePayload = (device: DeviceRow) => ({
    id: device.id,
    name: device.name,
    createdAt: device.created_at,
    lastSeenAt: device.last_seen_at,
    expiresAt: device.expires_at,
    fingerprint: device.fingerprint.slice(0, 12),
    userAgent: device.ua,
  });

  const agentAvailability = (): AgentAvailability[] =>
    AGENT_CATALOG.filter((entry) => entry.id in config.agents).map((entry) => {
      const detected = detectAgent(entry);
      const setting = config.agents[entry.id];
      return {
        ...detected,
        label: setting?.label ?? detected.label,
        mode: setting?.mode,
      } as AgentAvailability;
    });

  // ------------------------------------------------------------ public API

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      name: config.server.name,
      version: '0.0.1',
      uptimeMs: Date.now() - deps.startedAt,
    }),
  );

  /** Published so a phone can compare fingerprints before trusting anything. */
  app.get('/api/identity', (c) => c.json(identity.toPublic()));

  /** Everything the phone needs to know about this server before pairing. */
  app.get('/api/server-info', (c) => {
    const endpoints = transport.active.status().endpoints;
    return c.json({
      name: config.server.name,
      fingerprint: identity.fingerprint,
      transport: {
        mode: transport.active.mode,
        endpoints: endpoints.map((e) => ({ url: e.url, label: e.label, mode: e.mode })),
      },
    });
  });

  // ---- pairing: phone side ------------------------------------------------

  app.get('/api/pair/:id', (c) => {
    try {
      const view = pairing.view(c.req.param('id'));
      return c.json({
        status: view.status,
        expiresAt: view.expiresAt,
        rotateEveryMs: config.security.pairingRotateMs,
        serverName: config.server.name,
        serverFingerprint: identity.fingerprint,
      });
    } catch (err) {
      return handleError(c, err);
    }
  });

  /**
   * The phone claims the pairing: it presents the rotating challenge from the
   * QR code plus the public half of an ephemeral ECDH key.
   *
   * P-256 rather than X25519 because WebCrypto's X25519 support is still
   * uneven across mobile Safari builds, and the only thing this key is for
   * today is being on file so payload encryption can be added later without
   * re-pairing every device. Nothing is encrypted with it yet.
   */
  app.post('/api/pair/:id/claim', async (c) => {
    try {
      const body = (await readJson(c)) as {
        challenge?: unknown;
        publicKey?: unknown;
        clientNonce?: unknown;
      };

      const challenge = requireString(body.challenge, 'challenge', 512);
      const publicKey = requirePublicKey(body.publicKey);
      const clientNonce = requireString(body.clientNonce, 'clientNonce', 128);

      const result = pairing.claim(c.req.param('id'), {
        challenge,
        publicKey,
        ua: c.req.header('user-agent') ?? 'unknown',
        ip: clientIp(c.req.raw.headers, remoteAddress(c)),
        clientNonce,
      });

      return c.json(result);
    } catch (err) {
      return handleError(c, err);
    }
  });

  /**
   * Polling. The credential is handed over exactly once, in the response that
   * observes an approval, so replaying this endpoint yields nothing.
   */
  app.get('/api/pair/:id/status', (c) => {
    try {
      const pollToken = c.req.header('x-poll-token');
      if (!pollToken) {
        return c.json({ error: 'unauthorized', message: '缺少轮询凭据' }, 401);
      }

      const id = c.req.param('id');
      const result = pairing.poll(id, pollToken);

      // Handing over the credential is a one-shot event, so it must never be
      // spent on a throttled poll: the client would receive a success response
      // without the cookie and conclude it had already collected it.
      if (result.status === 'approved' && !result.slowDown) {
        const token = pairing.takeToken(id);
        if (token) {
          pairing.complete(id);
          const device = store.listDevices().find((d) => d.id === result.deviceId);
          const maxAgeSec = Math.floor(config.security.deviceTtlMs / 1000);
          c.header(
            'Set-Cookie',
            buildDeviceCookie(config.security.cookieName, token, {
              maxAgeSec,
              secure: isTls(c) || config.security.forceSecureCookie === true,
            }),
          );
          log.info('device credential delivered', { deviceId: result.deviceId });
          return c.json({
            status: 'approved',
            deviceId: result.deviceId,
            device: device ? devicePayload(device) : undefined,
          });
        }
        // Already collected (or the server restarted inside the window).
        return c.json({ status: 'approved', deviceId: result.deviceId, delivered: false });
      }

      if (result.slowDown) {
        c.header('Retry-After', String(Math.ceil(result.slowDown.retryAfterMs / 1000)));
        return c.json({ status: result.status, slowDown: result.slowDown });
      }

      return c.json({ status: result.status });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ---- authenticated (phone) ---------------------------------------------

  app.get('/api/me', requireDevice, (c) => {
    const device = c.get('device');
    return c.json({
      device: devicePayload(device),
      server: { name: config.server.name, fingerprint: identity.fingerprint },
    });
  });

  app.post('/api/auth/logout', async (c) => {
    c.header('Set-Cookie', clearDeviceCookie(config.security.cookieName, isTls(c)));
    return c.json({ ok: true });
  });

  app.get('/api/agents', requireDevice, (c) => c.json({ agents: agentAvailability() }));

  app.get('/api/sessions', requireDevice, (c) =>
    c.json({
      sessions: hub.list().map((s) => ({
        id: s.id,
        agent: s.agent,
        title: s.title,
        status: hub.statusOf(s.id) ?? s.status,
        cwd: s.cwd,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        live: hub.isLive(s.id),
      })),
    }),
  );

  app.post('/api/sessions', requireDevice, async (c) => {
    try {
      const body = (await readJson(c)) as {
        agent?: unknown;
        title?: unknown;
        workspaceId?: unknown;
        cols?: unknown;
        rows?: unknown;
      };

      const agent = requireString(body.agent, 'agent', 64);
      const started = await hub.start({
        agent,
        title: optionalString(body.title, MAX_TITLE_LENGTH),
        workspaceId: optionalString(body.workspaceId, 64),
        cols: optionalNumber(body.cols, 20, 500),
        rows: optionalNumber(body.rows, 5, 200),
      });

      return c.json(
        {
          session: {
            id: started.session.id,
            agent: started.session.agent,
            title: started.session.title,
            cwd: started.session.cwd,
            status: 'running',
          },
          backend: started.info,
        },
        201,
      );
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.delete('/api/sessions/:id', requireDevice, (c) => {
    const id = c.req.param('id');
    hub.kill(id);
    store.deleteSession(id);
    return c.json({ ok: true });
  });

  /**
   * Replay endpoint. A phone that lost signal reconnects and asks for
   * everything after the last seq it rendered, rather than for the whole
   * transcript.
   */
  app.get('/api/sessions/:id/events', requireDevice, (c) => {
    const id = c.req.param('id');
    const session = store.getSession(id);
    if (!session) return c.json({ error: 'not_found', message: '会话不存在' }, 404);
    const from = Number.parseInt(c.req.query('from') ?? '0', 10) || 0;
    return c.json({
      session: { id: session.id, agent: session.agent, title: session.title, status: hub.statusOf(id) },
      events: hub.history(id, from),
    });
  });

  app.post('/api/sessions/:id/input', requireDevice, async (c) => {
    try {
      const body = (await readJson(c)) as { data?: unknown };
      const data = requireString(body.data, 'data', MAX_INPUT_BYTES);
      hub.input(c.req.param('id'), data);
      return c.json({ ok: true });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.post('/api/sessions/:id/interrupt', requireDevice, (c) => {
    try {
      hub.interrupt(c.req.param('id'));
      return c.json({ ok: true });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.post('/api/sessions/:id/resize', requireDevice, async (c) => {
    try {
      const body = (await readJson(c)) as { cols?: unknown; rows?: unknown };
      const cols = requireNumber(body.cols, 'cols', 20, 500);
      const rows = requireNumber(body.rows, 'rows', 5, 200);
      hub.resize(c.req.param('id'), cols, rows);
      return c.json({ ok: true });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // --------------------------------------------------- local admin console

  app.use('/api/local/*', localOnly);

  app.get('/api/local/bootstrap', (c) => {
    const t = transport.active.status();
    return c.json({
      server: { name: config.server.name, port: config.server.port, fingerprint: identity.fingerprint },
      startedAt: deps.startedAt,
      secureCookies: config.security.forceSecureCookie === true,
      transport: { active: t, all: transport.all },
      agents: agentAvailability(),
      catalog: AGENT_CATALOG.map((a) => ({ id: a.id, label: a.label, upstream: a.upstream })),
      devices: devices.list().map(devicePayload),
      sessions: hub.list().map((s) => ({
        id: s.id,
        agent: s.agent,
        title: s.title,
        status: hub.statusOf(s.id) ?? s.status,
        createdAt: s.created_at,
        live: hub.isLive(s.id),
      })),
      pairings: pairing.listOutstanding(),
      pty: ptyDiagnostics(),
      workspaces: config.workspaces,
    });
  });

  /** Creates a pairing and returns the URL that goes into the QR code. */
  app.get('/api/local/pairings', (c) => c.json({ pairings: pairing.listOutstanding() }));

  app.post('/api/local/pairings', (c) => {
    try {
      const created = pairing.create(clientIp(c.req.raw.headers, remoteAddress(c)));
      const base = pickAdvertiseBase(deps, c);
      const payload = `${base}/pair?id=${encodeURIComponent(created.id)}&c=${encodeURIComponent(created.challenge)}`;

      return c.json({ ...created, qrPayload: payload, advertiseBase: base }, 201);
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.post('/api/local/pairings/:id/rotate', (c) => {
    try {
      const challenge = pairing.rotate(c.req.param('id'));
      const base = pickAdvertiseBase(deps, c);
      const id = c.req.param('id');
      return c.json({
        challenge,
        qrPayload: `${base}/pair?id=${encodeURIComponent(id)}&c=${encodeURIComponent(challenge)}`,
      });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.post('/api/local/pairings/:id/approve', async (c) => {
    try {
      const id = c.req.param('id');
      const body = (await readJson(c)) as { name?: unknown };
      const row = pairing.requireClaimed(id);

      const issued = devices.issue({
        name: optionalString(body.name, 64) ?? guessDeviceName(row.phone_ua),
        ua: row.phone_ua ?? 'unknown',
        ip: row.phone_ip ?? '0.0.0.0',
        publicKey: row.phone_public_key,
        fingerprint: row.fingerprint ?? 'unknown',
      });

      pairing.markApproved(id, issued.device.id);
      pairing.stashToken(id, issued.token);

      log.info('pairing approved from local console', { pairingId: id, deviceId: issued.device.id });
      return c.json({ ok: true, device: devicePayload(issued.device) });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.post('/api/local/pairings/:id/deny', (c) => {
    try {
      pairing.deny(c.req.param('id'));
      return c.json({ ok: true });
    } catch (err) {
      return handleError(c, err);
    }
  });

  /**
   * Renders the pairing QR as an SVG.
   *
   * Generated server-side so the phone never needs a QR library, and so the
   * payload is produced from the same source of truth that validates it —
   * a client-generated code could drift from what the server expects.
   */
  app.get('/api/local/pairings/:id/qr.svg', async (c) => {
    const id = c.req.param('id');
    const row = store.getPairing(id);
    if (!row) return c.json({ error: 'not_found', message: '配对不存在' }, 404);

    const base = pickAdvertiseBase(deps, c);
    const target = `${base}/pair?id=${encodeURIComponent(id)}&c=${encodeURIComponent(row.challenge)}`;
    const svg = await QRCode.toString(target, {
      type: 'svg',
      margin: 1,
      width: 320,
      errorCorrectionLevel: 'M',
      color: { dark: '#0f172a', light: '#ffffff' },
    });
    return c.body(svg, 200, {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'no-store',
    });
  });

  app.get('/api/local/devices', (c) => c.json({ devices: devices.list().map(devicePayload) }));

  app.patch('/api/local/devices/:id', async (c) => {
    try {
      const body = (await readJson(c)) as { name?: unknown };
      devices.rename(c.req.param('id'), requireString(body.name, 'name', 64));
      return c.json({ ok: true });
    } catch (err) {
      return handleError(c, err);
    }
  });

  /**
   * Revocation has to do two things: invalidate the credential, and drop the
   * sockets already open with it. Forgetting the second half is the single
   * easiest mistake here — the device keeps working until it happens to
   * reconnect, which looks exactly like "revocation does not work".
   */
  app.post('/api/local/devices/:id/revoke', (c) => {
    try {
      const id = c.req.param('id');
      devices.revoke(id);
      const dropped = deps.onDeviceRevoked?.(id) ?? 0;
      return c.json({ ok: true, connectionsClosed: dropped });
    } catch (err) {
      return handleError(c, err);
    }
  });

  app.get('/api/local/agents', (c) => c.json({ agents: agentAvailability(), pty: ptyDiagnostics() }));

  app.get('/api/local/transport', (c) => c.json({ active: transport.active.status(), all: transport.all }));

  // --------------------------------------------------------- static assets

  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'not_found', message: '接口不存在' }, 404);
    }
    return serveWebAsset(deps.webDistDir, c.req.path);
  });

  app.onError((err, c) => handleError(c, err));

  return app;
}

/**
 * Fails closed and loudly. Anything that is not one of our typed, expected
 * errors becomes a generic 500 with the detail in the log — never in the body,
 * because error bodies are a classic way to leak internals.
 */
function handleError(c: Context, err: unknown): Response {
  if (err instanceof PairingError || err instanceof DeviceError || err instanceof SessionError) {
    return c.json(
      { error: err.code, message: err.message },
      err.httpStatus as ContentfulStatusCode,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  log.error('unhandled error', { path: c.req.path, message });
  return c.json({ error: 'internal', message: '服务器内部错误' }, 500);
}

// ------------------------------------------------------------------ parsing

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    const parsed = await c.req.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SessionError('bad_request', `字段 ${field} 缺失或类型错误`);
  }
  if (value.length > maxLength) {
    throw new SessionError('bad_request', `字段 ${field} 过长`);
  }
  return value;
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, maxLength);
}

function requireNumber(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SessionError('bad_request', `字段 ${field} 必须是数字`);
  }
  if (value < min || value > max) {
    throw new SessionError('bad_request', `字段 ${field} 超出允许范围`);
  }
  return Math.round(value);
}

function optionalNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.round(Math.min(max, Math.max(min, value)));
}

/**
 * ECDH public keys arrive as base64url SPKI. We validate shape only — the key
 * is stored, not used, until payload encryption ships.
 */
function requirePublicKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{40,400}$/.test(value)) {
    throw new PairingError('bad_public_key', '公钥格式不正确');
  }
  return value;
}

function guessDeviceName(ua: string | null): string {
  if (!ua) return '未知设备';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android 设备';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows 设备';
  return '浏览器设备';
}

// ------------------------------------------------------------------- static

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Serves the built PWA. Unknown non-asset paths fall back to index.html so the
 * client-side router owns deep links (`/pair`, `/console/...`), which matters
 * because a QR code links straight to `/pair?id=...`.
 */
function serveWebAsset(distDir: string, requestPath: string): Response {
  if (!existsSync(distDir)) {
    return new Response(
      [
        '<!doctype html><meta charset="utf-8">',
        '<title>Uni-terminal</title>',
        '<body style="font-family:system-ui;padding:2rem;line-height:1.7">',
        '<h1>Uni-terminal 服务已启动</h1>',
        '<p>前端尚未构建。开发时请运行 <code>npm run web:dev</code>，',
        '或执行 <code>npm run web:build</code> 生成静态资源。</p>',
        '</body>',
      ].join(''),
      { headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  }

  const safePath = normalize(decodeURIComponent(requestPath)).replace(/^([/\\])+/, '');
  const candidate = join(distDir, safePath);
  const isAsset = extname(candidate).length > 0;

  if (isAsset && existsSync(candidate) && statSync(candidate).isFile()) {
    return new Response(readFileSync(candidate), {
      headers: {
        'content-type': MIME[extname(candidate)] ?? 'application/octet-stream',
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  }

  const indexPath = join(distDir, 'index.html');
  if (existsSync(indexPath)) {
    return new Response(readFileSync(indexPath), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
    });
  }

  return new Response('Not found', { status: 404 });
}

// -------------------------------------------------------------------- misc

/**
 * Picks the base URL for a QR code.
 *
 * Preference order is highest-signal first: an explicit manual URL, then the
 * best LAN address. A tunnel address would slot in here as a third source once
 * a tunnel adapter is configured — no other code has to change.
 */
export function pickAdvertiseBase(deps: AppDeps, c: Context): string {
  const endpoints = deps.transport.active.status().endpoints;
  const manual = endpoints.find((e) => e.mode === 'manual' || e.mode !== 'lan');
  if (manual) return manual.url.replace(/\/$/, '');
  const lan = endpoints[0];
  if (lan) return lan.url.replace(/\/$/, '');

  // Last resort: derive from the incoming Host header. Reachable when the user
  // fronts the server with their own reverse proxy.
  const proto = c.req.header('x-forwarded-proto') ?? 'http';
  const host = c.req.header('host');
  if (host) return `${proto}://${host}`;

  return `http://127.0.0.1:${deps.config.server.port}`;
}

export type { PairingStatus };
