import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import QRCode from 'qrcode';

import { AGENT_CATALOG, lookupAgent } from '../agents/catalog.ts';
import { detectAgent, type AgentAvailability } from '../agents/detect.ts';
import { ptyDiagnostics } from '../agents/driver.ts';
import { surveyEnvironment } from '../agents/survey.ts';
import { buildDeviceCookie, clearDeviceCookie, readDeviceToken } from '../auth/cookies.ts';
import { DeviceError, DeviceService } from '../auth/devices.ts';
import type { ServerIdentity } from '../auth/identity.ts';
import { PairingError, PairingService, type PairingStatus } from '../auth/pairing.ts';
import { clientIp } from '../auth/rateLimit.ts';
import { latestConfigBackup, loadConfig, mergeConfig, tryWrite, defaultConfig, type UniConfig } from '../config.ts';
import type { DeviceRow, Store } from '../db.ts';
import { createLogger } from '../logger.ts';
import { SessionError, SessionHub } from '../session/hub.ts';
import { autostartStatus, registerAutostart, unregisterAutostart } from '../service/autostart.ts';
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
   * Mutable runtime facts: the port actually bound (may differ from the config
   * value after a fallback), the resolved config file path and any degraded
   * startup issues the admin UI must surface (E6: degradation is visible).
   */
  runtime?: {
    port: number;
    issues: Array<{ code: string; message: string; path?: string; backupPath?: string }>;
    configPath?: string;
  };
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
      log.warn('拒绝了非本机的管理接口请求', { path: c.req.path, ip: remoteAddress(c) });
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

  /** 手动配对：8 位配对码换 pairingId + challenge（限流在 service 内）。 */
  app.post('/api/pair/by-code', async (c) => {
    try {
      const body = (await readJson(c)) as { code?: unknown };
      const code = requireString(body.code, 'code', 8);
      return c.json(pairing.byUserCode(code, clientIp(c.req.raw.headers, remoteAddress(c))));
    } catch (err) {
      return handleError(c, err);
    }
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
  app.get('/api/pair/:id/status', async (c) => {
    try {
      const pollToken = c.req.header('x-poll-token');
      if (!pollToken) {
        return c.json({ error: 'unauthorized', message: '缺少轮询凭据' }, 401);
      }

      const id = c.req.param('id');
      // wait=1 走长轮询：批准后手机几乎立即拿到凭据（≤300ms），
      // 而不是等下一轮节拍。不带 wait 的旧路径保持 RFC 8628 节奏。
      const waitMs = Number(c.req.query('wait') ?? 0);
      const result = waitMs > 0
        ? await pairing.pollLong(id, pollToken, waitMs)
        : pairing.poll(id, pollToken);

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
          log.info('设备凭据已下发', { deviceId: result.deviceId });
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

  app.get('/api/workspaces', requireDevice, (c) => c.json({ workspaces: config.workspaces }));

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
        cwd?: unknown;
        cols?: unknown;
        rows?: unknown;
      };

      const agent = requireString(body.agent, 'agent', 64);
      const started = await hub.start({
        agent,
        title: optionalString(body.title, MAX_TITLE_LENGTH),
        workspaceId: optionalString(body.workspaceId, 64),
        cwd: optionalString(body.cwd, 500),
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
      server: { name: config.server.name, port: deps.runtime?.port ?? config.server.port, fingerprint: identity.fingerprint },
      startedAt: deps.startedAt,
      secureCookies: config.security.forceSecureCookie === true,
      runtime: {
        port: deps.runtime?.port ?? config.server.port,
        configPath: deps.runtime?.configPath,
        issues: deps.runtime?.issues ?? [],
      },
      /** Pairing page drives its countdown ring off this. */
      rotateMs: config.security.pairingRotateMs,
      transport: { active: t, all: transport.all() },
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

      log.info('配对已从本机管理台批准', { pairingId: id, deviceId: issued.device.id });
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

  app.get('/api/local/transport', (c) => c.json({ active: transport.active.status(), all: transport.all() }));


  /**
   * Tailscale 管理：detect（安装/登录/serve 状态）+ serve 启停。
   * serve 配置持久化在 tailscaled 中；启用后翻转 transport.mode 并落盘，
   * 重启后横幅与二维码直接使用 ts.net 固定 HTTPS 地址。
   */
  app.post('/api/local/transport/tailscale', async (c) => {
    try {
      const body = (await readJson(c)) as { action?: unknown };
      const action = requireString(body.action, 'action', 16);

      let status;
      if (action === 'detect') {
        status = await transport.tailscale.detect();
      } else if (action === 'serve') {
        status = await transport.tailscale.enableServe();
        config.transport.mode = 'tailscale';
      } else if (action === 'off') {
        status = await transport.tailscale.disableServe();
        config.transport.mode = 'lan';
      } else {
        throw new SessionError('bad_request', `未知操作 ${action}`);
      }

      const path = deps.runtime?.configPath;
      if (path) {
        try {
          const disk = JSON.parse(readFileSync(path, 'utf8')) as Partial<UniConfig>;
          disk.transport = { ...disk.transport, mode: config.transport.mode };
          tryWrite(mergeConfig(defaultConfig(), disk), path);
        } catch {
          // 落盘失败不影响运行；下次保存配置时再写。
        }
      }

      return c.json({ ok: true, mode: config.transport.mode, tailscale: status });
    } catch (err) {
      return handleError(c, err);
    }
  });

  /**
   * Cloudflare 隧道管理：start / stop / download。
   * 启停同时翻转 transport.mode 并持久化——重启后按配置自动拉起。
   */
  app.post('/api/local/transport/cloudflare', async (c) => {
    try {
      const body = (await readJson(c)) as { action?: unknown; binaryPath?: unknown };
      const action = requireString(body.action, 'action', 16);

      if (action === 'download') {
        await transport.cloudflare.downloadBinary();
      } else if (action === 'start') {
        const binaryPath = optionalString(body.binaryPath, 500);
        if (binaryPath) config.transport.binaryPath = binaryPath;
        await transport.cloudflare.start();
        config.transport.mode = 'cloudflare';
      } else if (action === 'stop') {
        await transport.cloudflare.stop();
        config.transport.mode = 'lan';
      } else {
        throw new SessionError('bad_request', `未知操作 ${action}`);
      }

      // 持久化 transport 变更（与 PATCH /config 同一条写盘路径）。
      const path = deps.runtime?.configPath;
      if (path) {
        try {
          const disk = JSON.parse(readFileSync(path, 'utf8')) as Partial<UniConfig>;
          disk.transport = {
            ...disk.transport,
            mode: config.transport.mode,
            binaryPath: config.transport.binaryPath,
          };
          tryWrite(mergeConfig(defaultConfig(), disk), path);
        } catch {
          // 盘上写不进去不影响运行中的隧道；下次保存配置时再落盘。
        }
      }

      return c.json({
        ok: true,
        mode: config.transport.mode,
        cloudflare: transport.cloudflare.status(),
      });
    } catch (err) {
      return handleError(c, err);
    }
  });

  // ------------------------------------------- configuration surface (§2.3)

  /** Everything the settings screen needs: live config + file path + issues. */
  app.get('/api/local/config', (c) =>
    c.json({
      path: deps.runtime?.configPath,
      config,
      issues: deps.runtime?.issues ?? [],
    }),
  );

  /**
   * Partial config update. Sections that can hot-apply (agents, workspaces,
   * transport, server name, security) take effect immediately on the shared
   * in-memory config object; binding-related fields can only change on
   * restart and are reported as such rather than silently ignored.
   */
  app.patch('/api/local/config', async (c) => {
    try {
      const path = deps.runtime?.configPath;
      if (!path) {
        return c.json({ error: 'no_config_file', message: '当前没有可写的配置文件' }, 409);
      }

      const patch = (await readJson(c)) as Partial<UniConfig>;
      if (patch.agents !== undefined && (typeof patch.agents !== 'object' || Array.isArray(patch.agents))) {
        throw new SessionError('bad_request', '字段 agents 必须是对象');
      }
      if (patch.workspaces !== undefined && !Array.isArray(patch.workspaces)) {
        throw new SessionError('bad_request', '字段 workspaces 必须是数组');
      }

      // Base = what is on disk (falling back to defaults if it still fails to
      // parse — that is exactly how the UI repairs a broken file), then the
      // requested patch, then normalisation/clamping.
      let disk: Partial<UniConfig> = {};
      try {
        disk = JSON.parse(readFileSync(path, 'utf8')) as Partial<UniConfig>;
      } catch {
        disk = {};
      }
      const next = mergeConfig(defaultConfig(), mergeSections(disk, patch));

      if (!tryWrite(next, path)) {
        return c.json({ error: 'config_unwritable', message: '配置文件不可写，修改未保存' }, 500);
      }

      // Hot-apply in place: hub/driver/etc. hold a reference to this object.
      const restartKeys: string[] = [];
      if (patch.server) {
        for (const key of ['port', 'host', 'dataDir'] as const) {
          if (patch.server[key] !== undefined && patch.server[key] !== config.server[key]) {
            restartKeys.push(`server.${key}`);
          }
        }
        config.server.name = next.server.name;
      }
      config.agents = next.agents;
      config.workspaces = next.workspaces;
      config.transport = next.transport;
      config.security = next.security;

      log.info('配置已通过界面更新', { path, requiresRestart: restartKeys });
      return c.json({ ok: true, requiresRestart: restartKeys.length > 0, restartKeys });
    } catch (err) {
      return handleError(c, err);
    }
  });

  /** One-click recovery for "config broke": restore the newest backup. */
  app.post('/api/local/config/restore-backup', async (c) => {
    try {
      const path = deps.runtime?.configPath;
      if (!path) return c.json({ error: 'no_config_file', message: '当前没有配置文件可恢复' }, 409);
      const backup = latestConfigBackup(path);
      if (!backup) return c.json({ error: 'no_backup', message: '没有可用的配置备份' }, 404);

      // The backup of a *broken* file is itself broken — say so instead of 500.
      let parsed: Partial<UniConfig>;
      try {
        parsed = JSON.parse(readFileSync(backup, 'utf8')) as Partial<UniConfig>;
      } catch {
        return c.json(
          { error: 'backup_invalid', message: `备份文件 ${backup} 同样无法解析，请直接在设置中重写配置` },
          422,
        );
      }
      const restored = mergeConfig(defaultConfig(), parsed);
      if (!tryWrite(restored, path)) {
        return c.json({ error: 'config_unwritable', message: '配置文件不可写，恢复未保存' }, 500);
      }

      // Reload through the same path a restart would take.
      const reloaded = loadConfig();
      config.server = reloaded.config.server;
      config.agents = reloaded.config.agents;
      config.workspaces = reloaded.config.workspaces;
      config.transport = reloaded.config.transport;
      config.security = reloaded.config.security;
      if (deps.runtime) deps.runtime.issues = reloaded.issues;

      return c.json({ ok: true, restoredFrom: backup, issues: reloaded.issues });
    } catch (err) {
      return handleError(c, err);
    }
  });

  /** Re-runs the environment survey without touching the config file. */
  app.post('/api/local/agents/rescan', (c) => {
    const survey = surveyEnvironment();
    return c.json({
      agents: survey.agents,
      workspaceCandidates: survey.workspaceCandidates,
    });
  });

  /**
   * Really runs the agent binary once (`--version`). This is the difference
   * between "the settings page thinks it works" and "it works".
   */
  app.post('/api/local/agents/:id/test', async (c) => {
    try {
      const id = c.req.param('id');
      const setting = config.agents[id];
      const entry = lookupAgent(id);
      if (!setting && !entry) {
        return c.json({ error: 'not_found', message: `未知 Agent ${id}` }, 404);
      }

      const binary =
        setting?.command ??
        (entry ? detectAgent(entry).binary : undefined) ??
        entry?.probe[0];
      if (!binary) {
        return c.json({ ok: false, note: '未找到可执行文件，请先扫描或手动指定路径' });
      }

      const started = Date.now();
      const result = await runWithTimeout(binary, ['--version'], 15_000);
      return c.json({
        ok: result.exitCode === 0,
        binary,
        exitCode: result.exitCode,
        durationMs: Date.now() - started,
        output: result.output.slice(-4000),
      });
    } catch (err) {
      return handleError(c, err);
    }
  });

  /**
   * Loopback-only directory listing for the in-app path picker. The server has
   * filesystem access the browser does not; this exposes exactly one level per
   * call and nothing more.
   */
  app.post('/api/local/fs/list', async (c) => {
    try {
      const body = (await readJson(c)) as { path?: unknown };
      // 空路径原样透传：listDirectory 把它解释为「此电脑」层级。
      const requested = typeof body.path === 'string' ? body.path : '';
      return c.json(listDirectory(requested));
    } catch (err) {
      return handleError(c, err);
    }
  });

  /**
   * Directory listing for *paired devices* — the phone's new-task dir picker.
   *
   * This hands a credential holder a read-only view of the filesystem, which
   * is a real capability. It stays: a paired device can already launch an
   * arbitrary agent in any directory, which is strictly more powerful than
   * listing one, and revocation remains the control. If multi-trust-levels
   * ever arrive, this is the first endpoint to gate.
   */
  app.post('/api/fs/list', requireDevice, async (c) => {
    try {
      const body = (await readJson(c)) as { path?: unknown };
      // 空路径原样透传：listDirectory 把它解释为「此电脑」层级。
      const requested = typeof body.path === 'string' ? body.path : '';
      return c.json(listDirectory(requested));
    } catch (err) {
      return handleError(c, err);
    }
  });

  const autostart = new AutostartProbe();
  app.get('/api/local/service', async (c) =>
    c.json({
      port: deps.runtime?.port ?? config.server.port,
      configuredPort: config.server.port,
      pid: process.pid,
      platform: process.platform,
      node: process.version,
      startedAt: deps.startedAt,
      uptimeMs: Date.now() - deps.startedAt,
      configPath: deps.runtime?.configPath,
      autostart: await autostart.status(),
    }),
  );

  /** One-click autostart (dis)registration from the settings UI. */
  app.post('/api/local/service/autostart', async (c) => {
    try {
      const body = (await readJson(c)) as { enable?: unknown };
      const result = body.enable === false ? await unregisterAutostart() : await registerAutostart();
      // The probe caches for a minute; bust it so the UI reflects reality.
      return c.json({ ok: result.ok, message: result.ok ? undefined : result.output, autostart: await autostart.refresh() });
    } catch (err) {
      return handleError(c, err);
    }
  });

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
  log.error('未处理的请求错误', { path: c.req.path, message });
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
    // sw.js / manifest 必须可及时更新：浏览器缓存住旧 SW，整个 PWA 就锁死在旧版本上。
    const immutable = !/^(sw\.js|manifest\.webmanifest)$/.test(candidate.split(/[\\/]/).pop() ?? '');
    return new Response(readFileSync(candidate), {
      headers: {
        'content-type': MIME[extname(candidate)] ?? 'application/octet-stream',
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
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

/** One level of directory listing, shared by the loopback and device endpoints. */
function listDirectory(requested: string): {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; type: 'dir' | 'file'; size?: number }>;
  /** 空路径 = 「此电脑」虚拟层级：只显示盘符（Windows），不混入某块盘的内容。 */
  drives?: string[];
  home: string;
} {
  const home = homedir();

  // 层级语义：空路径 → 「此电脑」（只列盘）；点了某块盘才进入那块盘。
  if (requested.trim().length === 0 && process.platform === 'win32') {
    return { path: '', parent: null, entries: [], drives: windowsDrives(), home };
  }

  const target = resolve(requested.trim().length > 0 ? requested : home);
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new SessionError('bad_request', '路径不存在或不是目录');
  }

  const entries: Array<{ name: string; type: 'dir' | 'file'; size?: number }> = [];
  let raw: import('node:fs').Dirent[];
  try {
    raw = readdirSync(target, { withFileTypes: true });
  } catch {
    throw new SessionError('bad_request', '目录不可读');
  }
  for (const item of raw) {
    if (item.name.startsWith('$')) continue;
    if (item.isDirectory()) {
      entries.push({ name: item.name, type: 'dir' });
    } else if (item.isFile()) {
      let size: number | undefined;
      try {
        size = statSync(join(target, item.name)).size;
      } catch {
        // Size is informational only.
      }
      entries.push({ name: item.name, type: 'file', size });
    }
  }
  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
  );

  const parent = dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    entries,
    home,
  };
}

let drivesCache: { at: number; drives: string[] } | undefined;

/** Probing A:\..Z:\ with existsSync is cheap and cached — drives rarely change. */
function windowsDrives(): string[] {
  if (drivesCache && Date.now() - drivesCache.at < 30_000) return drivesCache.drives;
  const found: string[] = [];
  for (let code = 65; code <= 90; code += 1) {
    const letter = String.fromCharCode(code);
    const root = `${letter}:\\`;
    try {
      if (existsSync(root)) found.push(root);
    } catch {
      // Unreadable drive — skip.
    }
  }
  drivesCache = { at: Date.now(), drives: found };
  return found;
}

/** Per-section merge of an API patch onto the on-disk config document. */
function mergeSections(
  disk: Partial<UniConfig>,
  patch: Partial<UniConfig>,
): Partial<UniConfig> {
  const out: Partial<UniConfig> = {};
  // The spreads are partial at this point; mergeConfig(defaultConfig(), …)
  // re-completes and clamps every field before anything is persisted.
  // Sections absent from the patch must still be carried over from disk, or a
  // narrow PATCH ("rename the server") would silently wipe agents/workspaces.
  if (disk.server || patch.server) out.server = { ...disk.server, ...patch.server } as UniConfig['server'];
  if (disk.transport || patch.transport) out.transport = { ...disk.transport, ...patch.transport } as UniConfig['transport'];
  if (disk.security || patch.security) out.security = { ...disk.security, ...patch.security } as UniConfig['security'];
  if (disk.agents || patch.agents) out.agents = { ...disk.agents, ...patch.agents };
  if (disk.workspaces || patch.workspaces) out.workspaces = patch.workspaces ?? disk.workspaces;
  return out;
}

/**
 * Runs a short-lived child process (`--version`) with a hard timeout. Shell
 * resolution on Windows is required for npm `.cmd`/`.ps1` shims — the same
 * rule the pipe driver follows.
 */
function runWithTimeout(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolvePromise) => {
    const isWindows = process.platform === 'win32';
    // Through the shell on Windows so npm `.cmd`/`.ps1` shims resolve; the
    // command itself must be quoted, or `C:\Program Files\...` breaks at the
    // first space.
    const quoted = isWindows && /\s/.test(command) ? `"${command}"` : command;
    const child = spawn(quoted, args, {
      shell: isWindows,
      windowsHide: true,
      env: { ...process.env },
    });

    let output = '';
    let done = false;
    const finish = (exitCode: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolvePromise({ exitCode, output });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      finish(null);
    }, timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('error', (err) => {
      output += `\n${err.message}`;
      finish(-1);
    });
    child.on('exit', (code) => finish(code));
  });
}

/**
 * Windows Task Scheduler probe for "is autostart registered?", cached for a
 * minute. Non-Windows platforms report null — there is nothing to probe yet.
 */
class AutostartProbe {
  private cached: { at: number; value: { registered: boolean; task: string } | null } | undefined;

  async status(): Promise<{ registered: boolean; task: string } | null> {
    if (process.platform !== 'win32') return null;
    if (this.cached && Date.now() - this.cached.at < 60_000) return this.cached.value;

    const task = 'Uni-terminal';
    let value: { registered: boolean; task: string } = { registered: false, task };
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      await promisify(execFile)('schtasks', ['/query', '/tn', task], { windowsHide: true });
      value = { registered: true, task };
    } catch {
      // Task not registered (or schtasks unavailable) — report unregistered.
    }

    this.cached = { at: Date.now(), value };
    return value;
  }

  /** Used after a (dis)registration so the UI never shows stale state. */
  async refresh(): Promise<{ registered: boolean; task: string } | null> {
    this.cached = undefined;
    return this.status();
  }
}

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
