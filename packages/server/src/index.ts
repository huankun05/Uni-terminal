import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import net from 'node:net';
import { resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

import { loadPty, ptyDiagnostics } from './agents/driver.ts';
import { augmentSearchDirs } from './agents/detect.ts';
import { readDeviceToken } from './auth/cookies.ts';
import { DeviceService } from './auth/devices.ts';
import { ServerIdentity } from './auth/identity.ts';
import { PairingService } from './auth/pairing.ts';
import { loadConfig, type ConfigIssue, type UniConfig } from './config.ts';
import { Store } from './db.ts';
import { createApp } from './http/app.ts';
import { isLocalConnection, peerAddress } from './http/local.ts';
import { createLogger } from './logger.ts';
import { SessionHub, type SessionEvent } from './session/hub.ts';
import { createTransportRegistry } from './transport/lan.ts';

const log = createLogger('main');

const HEARTBEAT_MS = 30_000;
const SWEEP_MS = 60_000;
/** Port occupancy fallback range: 8787 → 8788 … (实施文档 01 §2.4). */
const PORT_FALLBACK_TRIES = 10;

interface ClientState {
  ws: WebSocket;
  deviceId: string | null;
  local: boolean;
  alive: boolean;
  /** sessionId -> unsubscribe handle */
  subscriptions: Map<string, () => void>;
}

/** Mutable runtime facts the API surface reports (actual port, config state). */
export interface RuntimeInfo {
  port: number;
  issues: ConfigIssue[];
  configPath?: string;
}

// --------------------------------------------------------------------- main

async function main(): Promise<void> {
  const loaded = loadConfig();
  const config = loaded.config;

  // The registry PATH read is async and one-shot; do it before the survey /
  // banner so discovery sees the same directories the user's shell does.
  await augmentSearchDirs();

  let port = config.server.port;
  let portFallback = false;
  if (!(await isPortFree(config.server.host, config.server.port))) {
    const preferred = config.server.port;
    const alt = await findAvailablePort(config.server.host, preferred, PORT_FALLBACK_TRIES);
    if (alt === undefined) {
      throw new Error(`端口 ${preferred} 及其后 ${PORT_FALLBACK_TRIES - 1} 个端口均被占用`);
    }
    port = alt;
    config.server.port = alt;
    portFallback = true;
    loaded.issues.push({
      code: 'port_in_use',
      message: `预设端口 ${preferred} 被占用，已顺延使用 ${alt}。`,
    });
  }

  const runtime: RuntimeInfo = { port, issues: loaded.issues, configPath: loaded.path };

  let store: Store;
  let identity: ServerIdentity;
  try {
    store = new Store(resolve(config.server.dataDir, 'uni-terminal.db'));
    identity = ServerIdentity.loadOrCreate(config.server.dataDir);
  } catch (err) {
    // Hard constraint: a broken data directory must still leave the user a
    // reachable page that explains how to recover — never a silent exit.
    runRecoveryMode(runtime, err as Error);
    return;
  }
  const pairing = new PairingService(store, config);
  const devices = new DeviceService(store, config);
  const hub = new SessionHub(store, config);
  const transport = createTransportRegistry(config);

  // 配置为 cloudflare 模式时，启动即自动拉起隧道（非阻塞：就绪前横幅先
  // 展示局域网地址，之后 /api/local/transport 会反映出隧道地址）。
  if (config.transport.mode === 'cloudflare') {
    void transport.cloudflare.start().catch((err: Error) => {
      log.warn('隧道自动启动失败', { reason: err.message });
    });
  }

  // Probe node-pty once at boot so the startup banner can state plainly
  // whether interactive terminals will work, instead of failing later.
  await loadPty();

  const startedAt = Date.now();
  const webDistDir = resolve(import.meta.dirname, '../../web/dist');

  let wsHandle: ReturnType<typeof attachWebSocket> | undefined;

  const app = createApp({
    config,
    store,
    identity,
    pairing,
    devices,
    hub,
    transport,
    webDistDir,
    startedAt,
    runtime,
    onDeviceRevoked: (deviceId) => wsHandle?.kickDevice(deviceId) ?? 0,
  });

  const httpServer = serve(
    { fetch: app.fetch, hostname: config.server.host, port },
    (info) => printBanner(config, info.port, transport, identity, runtime, portFallback),
  ) as unknown as HttpServer;

  wsHandle = attachWebSocket(httpServer, { config, hub, devices });

  const sweepTimer = setInterval(() => {
    pairing.sweep();
    devices.sweep();
  }, SWEEP_MS);
  sweepTimer.unref();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`收到 ${signal}，正在关闭服务`);
    clearInterval(sweepTimer);
    wsHandle?.closeAll();
    hub.shutdown();
    httpServer.close(() => {
      store.close();
      process.exit(0);
    });
    // Do not hang forever on a stuck socket.
    setTimeout(() => process.exit(0), 3_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.error('未处理的 Promise 异常', { reason: String(reason) });
  });
}

// ----------------------------------------------------------------- port pick

function isPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const probe = net.createServer();
    probe.once('error', () => resolvePromise(false));
    probe.once('listening', () => probe.close(() => resolvePromise(true)));
    // Probe on exactly the address the server will bind: on Windows, an
    // unspecified host binds the IPv6 dual-stack socket, which can succeed
    // even while 0.0.0.0:port is taken — the real bind would then crash.
    probe.listen(port, host);
  });
}

async function findAvailablePort(host: string, preferred: number, tries: number): Promise<number | undefined> {
  for (let candidate = preferred; candidate < preferred + tries; candidate += 1) {
    if (await isPortFree(host, candidate)) return candidate;
  }
  return undefined;
}

// ----------------------------------------------------------- recovery mode

/**
 * Minimal HTTP surface for "the data directory is unusable". It deliberately
 * serves nothing but diagnostics: no sessions, no pairing, no credentials.
 */
function runRecoveryMode(runtime: RuntimeInfo, reason: Error): void {
  const app = new Hono();
  app.get('/api/local/recover', (c) =>
    c.json({ degraded: true, reason: reason.message, issues: runtime.issues, configPath: runtime.configPath }),
  );
  app.get('*', (c) =>
    c.html(
      [
        '<!doctype html><meta charset="utf-8"><title>Uni-terminal 降级运行</title>',
        '<body style="font-family:system-ui;max-width:44rem;margin:3rem auto;padding:0 1rem;line-height:1.7">',
        '<h1>Uni-terminal 处于只读诊断模式</h1>',
        `<p>数据目录不可写，无法启动完整服务。原因：<code>${reason.message}</code></p>`,
        '<p>请检查数据目录的权限或磁盘空间后重启服务。</p>',
        `<p>诊断接口：<code>/api/local/recover</code></p>`,
        '</body>',
      ].join(''),
    ),
  );

  const port = runtime.port;
  serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => {
    log.warn('以只读诊断模式启动', { port, reason: reason.message });
    console.log(`\n  ⚠ Uni-terminal 降级运行（只读诊断模式）: http://127.0.0.1:${port}/local/recover`);
    console.log(`  原因：${reason.message}\n`);
  });
  // Recovery mode still wants to die politely on Ctrl+C.
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

// ------------------------------------------------------------------ startup

function printBanner(
  config: UniConfig,
  port: number,
  transport: ReturnType<typeof createTransportRegistry>,
  identity: ServerIdentity,
  runtime: RuntimeInfo,
  portFallback: boolean,
): void {
  const endpoints = transport.active.status().endpoints;
  const lines: string[] = [];
  lines.push('');
  lines.push('  Uni-terminal 已启动');
  lines.push('');
  lines.push(`  本机控制台    http://127.0.0.1:${port}`);
  if (endpoints.length > 0) {
    lines.push(`  手机访问       ${endpoints[0]?.url}   （同一 WiFi 下）`);
    for (const extra of endpoints.slice(1, 4)) {
      lines.push(`                 ${extra.url}   （备选：${extra.label}）`);
    }
  } else {
    lines.push('  手机访问       未找到局域网地址，请确认已连接网络');
  }
  lines.push(`  服务指纹       ${identity.fingerprint}`);
  lines.push(`  可用 Agent     ${Object.keys(config.agents).join(', ') || '（未配置）'}`);
  if (runtime.configPath) lines.push(`  配置文件       ${runtime.configPath}`);

  for (const issue of runtime.issues) {
    if (issue.code === 'survey_note' || issue.code === 'fresh') continue;
    lines.push(`  ⚠ ${issue.message}`);
  }
  if (portFallback) {
    lines.push('  ⚠ 预设端口被占用，已自动顺延；管理台与横幅展示的均为实际端口');
  }

  const pty = ptyDiagnostics();
  if (pty.available === false) {
    lines.push('');
    lines.push('  ⚠ 未加载 @lydell/node-pty，将以管道模式运行（无法交互式输入）');
    if (pty.error) lines.push(`    原因：${pty.error}`);
  }
  if (!config.security.forceSecureCookie) {
    lines.push('');
    lines.push('  ⚠ 当前为明文 HTTP（局域网）。同网段的设备可观察到流量，');
    lines.push('    建议仅在可信任的网络中使用，后续版本将提供 HTTPS 隧道。');
  }
  lines.push('');

  for (const line of lines) console.log(line);
}

// ---------------------------------------------------------------- websocket

interface WsDeps {
  config: UniConfig;
  hub: SessionHub;
  devices: DeviceService;
}

/**
 * Real-time channel.
 *
 * Two details are load-bearing on a phone:
 *  - a 30s heartbeat, because idle TCP is reclaimed by carriers, routers and
 *    edge proxies, and our traffic pattern is "silent for minutes, then a
 *    burst" — without it the symptom is a mysterious "works, then stops";
 *  - replay by `seq`, because a mobile client loses its socket every time the
 *    user switches apps or networks, and re-rendering a whole transcript each
 *    time is both slow and visibly jarring.
 */
function attachWebSocket(server: HttpServer, deps: WsDeps) {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<ClientState>();

  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      socket.destroy();
      return;
    }

    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const local = isLocalConnection(req);
    const device = deps.devices.authenticate(
      readDeviceToken(normaliseHeader(req.headers.cookie), deps.config.security.cookieName),
    );

    if (!local && !device) {
      log.warn('拒绝了 WebSocket 连接（未认证）', { ip: peerAddress(req) });
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const state: ClientState = {
        ws,
        deviceId: device?.id ?? null,
        local,
        alive: true,
        subscriptions: new Map(),
      };
      clients.add(state);
      bindClient(state, deps);
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        dropClient(client, 'heartbeat timeout');
        continue;
      }
      client.alive = false;
      try {
        client.ws.ping();
      } catch {
        dropClient(client, 'ping failed');
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  function dropClient(client: ClientState, reason: string): void {
    for (const unsub of client.subscriptions.values()) unsub();
    client.subscriptions.clear();
    clients.delete(client);
    try {
      client.ws.terminate();
    } catch {
      // Already closed.
    }
    log.debug('客户端断开', { reason });
  }

  function bindClient(state: ClientState, deps2: WsDeps): void {
    const { ws } = state;

    ws.on('pong', () => {
      state.alive = true;
    });

    send(ws, {
      t: 'hello',
      local: state.local,
      deviceId: state.deviceId,
      heartbeatMs: HEARTBEAT_MS,
      agents: Object.keys(deps2.config.agents),
    });

    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        send(ws, { t: 'error', message: '消息不是合法 JSON' });
        return;
      }
      handleMessage(state, msg, deps2);
    });

    ws.on('close', () => dropClient(state, 'closed by peer'));
    ws.on('error', () => dropClient(state, 'socket error'));
  }

  function handleMessage(state: ClientState, msg: Record<string, unknown>, deps2: WsDeps): void {
    const type = msg.t;
    const sessionId = typeof msg.session === 'string' ? msg.session : undefined;

    switch (type) {
      case 'ping':
        send(state.ws, { t: 'pong', at: Date.now() });
        return;

      case 'sub': {
        if (!sessionId) return;
        if (state.subscriptions.has(sessionId)) return;
        subscribeSession(state, sessionId, toSeq(msg.from), deps2);
        return;
      }

      case 'unsub': {
        if (!sessionId) return;
        const unsub = state.subscriptions.get(sessionId);
        if (unsub) {
          unsub();
          state.subscriptions.delete(sessionId);
        }
        return;
      }

      case 'input': {
        if (!sessionId || typeof msg.data !== 'string') return;
        try {
          deps2.hub.input(sessionId, msg.data);
        } catch (err) {
          send(state.ws, { t: 'error', session: sessionId, message: (err as Error).message });
        }
        return;
      }

      case 'interrupt': {
        if (!sessionId) return;
        try {
          deps2.hub.interrupt(sessionId);
        } catch (err) {
          send(state.ws, { t: 'error', session: sessionId, message: (err as Error).message });
        }
        return;
      }

      case 'resize': {
        if (!sessionId) return;
        const cols = typeof msg.cols === 'number' ? msg.cols : 100;
        const rows = typeof msg.rows === 'number' ? msg.rows : 30;
        deps2.hub.resize(sessionId, cols, rows);
        return;
      }

      case 'sessions': {
        send(state.ws, {
          t: 'sessions',
          sessions: deps2.hub.list().map((s) => ({
            id: s.id,
            agent: s.agent,
            title: s.title,
            status: deps2.hub.statusOf(s.id) ?? s.status,
            live: deps2.hub.isLive(s.id),
            createdAt: s.created_at,
          })),
        });
        return;
      }

      default:
        send(state.ws, { t: 'error', message: `未知消息类型 ${String(type)}` });
    }
  }

  /**
   * Subscribe first, buffer, then backfill history.
   *
   * The naive orderings both have a hole: reading history before subscribing
   * drops any event that lands in between, and subscribing before reading
   * history can interleave a live event ahead of older ones. Buffering closes
   * both — history is sent in order, then anything that arrived meanwhile is
   * replayed on top, with `lastSent` suppressing duplicates.
   */
  function subscribeSession(
    state: ClientState,
    sessionId: string,
    fromSeq: number,
    deps2: WsDeps,
  ): void {
    let lastSent = fromSeq;
    let flushed = false;
    const buffered: SessionEvent[] = [];

    const deliver = (event: SessionEvent): void => {
      if (event.seq <= lastSent) return;
      lastSent = event.seq;
      send(state.ws, {
        t: 'event',
        session: sessionId,
        seq: event.seq,
        type: event.type,
        payload: event.payload,
        at: event.at,
      });
    };

    const unsub = deps2.hub.subscribe(sessionId, (event) => {
      if (!flushed) {
        buffered.push(event);
        return;
      }
      deliver(event);
    });
    state.subscriptions.set(sessionId, unsub);

    for (const event of deps2.hub.history(sessionId, fromSeq)) {
      deliver(event);
    }

    flushed = true;
    for (const event of buffered) deliver(event);

    send(state.ws, { t: 'subscribed', session: sessionId, from: lastSent });
  }

  return {
    /** Closes every socket authenticated with a revoked credential. */
    kickDevice(deviceId: string): number {
      let closed = 0;
      for (const client of [...clients]) {
        if (client.deviceId === deviceId) {
          send(client.ws, { t: 'revoked' });
          try {
            client.ws.close(4001, 'credential revoked');
          } catch {
            // Ignore: we are terminating it anyway.
          }
          dropClient(client, 'credential revoked');
          closed += 1;
        }
      }
      if (closed > 0) log.warn('已断开被吊销设备的在线连接', { deviceId, closed });
      return closed;
    },

    closeAll(): void {
      clearInterval(heartbeat);
      for (const client of [...clients]) {
        try {
          client.ws.close(1001, 'server shutting down');
        } catch {
          // Ignore.
        }
        dropClient(client, 'server shutdown');
      }
    },
  };
}

function send(ws: WebSocket, message: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function toSeq(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
  return 0;
}

function normaliseHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

void (async () => {
  try {
    await main();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('启动失败', { message });
    console.error(`\n启动失败：${message}\n`);
    process.exit(1);
  }
})();

export type { IncomingMessage };
